import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AGENT_QUIET_MS, AGENT_SILENCE_STOP_MS, type AgentSetting } from "@moonagentic/protocol";
import type { AgentLaunch } from "./agents.ts";
import type { ImageBlock } from "./attachments.ts";
import type { PromptLink } from "./files.ts";
import { acpMcpServers, type McpServerRecord } from "./mcp.ts";
import { killTree, spawnPlan } from "./spawn.ts";

export interface SessionHandlers {
  onUpdate(update: acp.SessionUpdate): void;
  requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  /** The agent process ended; `reason` carries its last stderr lines when it failed. */
  onExit(reason: string | undefined): void;
  /**
   * The running prompt has made no real progress since `since` (a time in ms), or makes
   * some again (`undefined`).
   */
  onQuiet?(since: number | undefined): void;
  /** The agent changed its settings (model, mode, effort…) on its own. */
  onConfig?(config: { model: ModelOption | undefined; settings: AgentSetting[] }): void;
}

export interface ModelOption {
  /** The config option to set, or LEGACY_MODEL for agents still on `session/set_model`. */
  configId: string;
  current: string;
  choices: { id: string; name: string; description?: string }[];
}

/** Reads the model selector out of an agent's session settings, if it has one. */
export function modelOption(options: acp.SessionConfigOption[]): ModelOption | undefined {
  const option =
    options.find((o) => o.category === "model" && o.type === "select") ??
    options.find((o) => o.id === "model" && o.type === "select");
  if (!option || option.type !== "select") return undefined;
  const flat = option.options.flatMap((o) => ("group" in o ? o.options : [o]));
  return {
    configId: option.id,
    current: option.currentValue,
    choices: flat.map((o) => ({
      id: o.value,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
    })),
  };
}

const SETTING_KINDS = { mode: "mode", thought_level: "effort" } as const;

/** Reads the agent's mode and reasoning effort selectors, if it has them. */
export function settingOptions(options: acp.SessionConfigOption[]): AgentSetting[] {
  return options.flatMap((o): AgentSetting[] => {
    // Older adapters may leave the category out and only name the option.
    const key = o.category ?? o.id;
    const kind = Object.hasOwn(SETTING_KINDS, key)
      ? SETTING_KINDS[key as keyof typeof SETTING_KINDS]
      : undefined;
    if (!kind || o.type !== "select") return [];
    const flat = o.options.flatMap((c) => ("group" in c ? c.options : [c]));
    return [
      {
        id: o.id,
        kind,
        current: o.currentValue,
        choices: flat.map((c) => ({
          id: c.value,
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
        })),
      },
    ];
  });
}

/** Older ACP agents (Hermes among them) list models in a `models` field instead of a config option. */
interface LegacyModels {
  availableModels: { modelId: string; name: string; description?: string | null }[];
  currentModelId: string;
}

export const LEGACY_MODEL = "session/set_model";

function legacyModels(response: unknown): LegacyModels | undefined {
  const models = (response as { models?: LegacyModels } | null | undefined)?.models;
  return Array.isArray(models?.availableModels) ? models : undefined;
}

/** Agents without config options may list their modes in a `modes` field instead. */
export const LEGACY_MODE = "session/set_mode";

function legacyModes(response: unknown): acp.SessionModeState | undefined {
  const modes = (response as { modes?: acp.SessionModeState | null } | null | undefined)?.modes;
  return Array.isArray(modes?.availableModes) ? modes : undefined;
}

interface SessionState {
  options: acp.SessionConfigOption[];
  legacy: LegacyModels | undefined;
  modes: acp.SessionModeState | undefined;
}

/** Keeps what the agent already sent when a response leaves a field out. */
function absorb(state: SessionState, response: unknown): void {
  const options = (response as { configOptions?: acp.SessionConfigOption[] | null } | null)
    ?.configOptions;
  if (options) state.options = options;
  state.legacy = legacyModels(response) ?? state.legacy;
  state.modes = legacyModes(response) ?? state.modes;
}

function modelOf(state: SessionState): ModelOption | undefined {
  const fromOptions = modelOption(state.options);
  const legacy = state.legacy;
  if (fromOptions || !legacy) return fromOptions;
  return {
    configId: LEGACY_MODEL,
    current: legacy.currentModelId,
    choices: legacy.availableModels.map((m) => ({
      id: m.modelId,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    })),
  };
}

function settingsOf(state: SessionState): AgentSetting[] {
  const settings = settingOptions(state.options);
  const modes = state.modes;
  if (settings.some((s) => s.kind === "mode") || !modes) return settings;
  return [
    {
      id: LEGACY_MODE,
      kind: "mode",
      current: modes.currentModeId,
      choices: modes.availableModes.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
      })),
    },
    ...settings,
  ];
}

const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 3000;
/** ACP's "Authentication required" error code. */
export const AUTH_REQUIRED = -32000;

/** True when starting the agent failed because the user must sign in first. */
export const needsSignIn = (error: unknown): boolean =>
  (error as { cause?: { code?: unknown } } | null)?.cause?.code === AUTH_REQUIRED ||
  (error as { code?: unknown } | null)?.code === AUTH_REQUIRED;

/**
 * What an agent prints on its standard output, among its messages, when the user must sign
 * in with the agent's own tool first. Antigravity writes "Open the following link to
 * authenticate the ACP server: https://…".
 */
const SIGN_IN_LINE = /open the following link to authenticate|\bauthenticate\b.*https?:\/\//i;
const OTHER_LINE_MAX = 2000;

/**
 * Lets an agent's messages through, one JSON object per line, and hands every other line to
 * `onOther` instead: plain text there would be answered with a protocol error and leave the
 * start waiting for nothing. Messages pass untouched, without being held back.
 */
export function jsonLines(onOther: (line: string) => void): TransformStream<Uint8Array> {
  let inside: "message" | "other" | undefined;
  let kept: Uint8Array[] = [];
  let size = 0;
  const flush = () => {
    const line = Buffer.concat(kept).toString("utf8").trim();
    kept = [];
    size = 0;
    if (line) onOther(line);
  };
  return new TransformStream({
    transform(chunk, controller) {
      let i = 0;
      while (i < chunk.length) {
        if (!inside) {
          const byte = chunk[i];
          // Spaces and empty lines between two messages.
          if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
            i += 1;
            continue;
          }
          inside = byte === 0x7b ? "message" : "other";
        }
        const newline = chunk.indexOf(0x0a, i);
        const end = newline === -1 ? chunk.length : newline + 1;
        const piece = chunk.subarray(i, end);
        if (inside === "message") {
          controller.enqueue(piece);
        } else if (size < OTHER_LINE_MAX) {
          kept.push(piece.subarray(0, OTHER_LINE_MAX - size));
          size += piece.length;
        }
        if (newline !== -1) {
          if (inside === "other") flush();
          inside = undefined;
        }
        i = end;
      }
    },
    flush() {
      if (inside === "other") flush();
    },
  });
}

/** Fails a prompt that makes no real progress for this long. */
export const PROMPT_INACTIVITY_MS = AGENT_SILENCE_STOP_MS;
/** Warns that a prompt has made no real progress for this long, well before it fails. */
export const PROMPT_QUIET_MS = AGENT_QUIET_MS;

const PROGRESS_UPDATES = new Set<acp.SessionUpdate["sessionUpdate"]>([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/**
 * Watches a prompt for real progress: says when it has gone quiet, and gives up on it after
 * a longer silence. Paused while the agent waits for the user, who is not the one silent.
 */
class InactivityWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private quietTimer: NodeJS.Timeout | undefined;
  private active: { ms: number; quietMs: number; onTimeout: () => void } | null = null;
  private pauses = 0;
  /** Since when the prompt has been quiet, once it was said to be. */
  private quietSince: number | undefined;
  private lastProgress = 0;
  private readonly onQuiet: ((since: number | undefined) => void) | undefined;

  constructor(onQuiet?: (since: number | undefined) => void) {
    this.onQuiet = onQuiet;
  }

  start(ms: number, quietMs: number, onTimeout: () => void): void {
    this.stop();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.active = { ms, quietMs, onTimeout };
    if (this.pauses === 0) this.arm();
  }

  progress(): void {
    if (!this.active || this.pauses > 0) return;
    this.arm();
  }

  pause(): void {
    this.pauses += 1;
    this.clearTimers();
    // Waiting for the user is not silence.
    this.loud();
  }

  resume(): void {
    if (this.pauses === 0) return;
    this.pauses -= 1;
    if (this.pauses === 0 && this.active) this.arm();
  }

  stop(): void {
    this.active = null;
    this.clearTimers();
    this.loud();
  }

  private clearTimers(): void {
    clearTimeout(this.timer);
    clearTimeout(this.quietTimer);
    this.timer = undefined;
    this.quietTimer = undefined;
  }

  /** The prompt is not quiet any more, if it was said to be. */
  private loud(): void {
    if (this.quietSince === undefined) return;
    this.quietSince = undefined;
    this.onQuiet?.(undefined);
  }

  private arm(): void {
    this.clearTimers();
    this.loud();
    const active = this.active;
    if (!active) return;
    this.lastProgress = Date.now();
    if (active.quietMs > 0 && active.quietMs < active.ms) {
      this.quietTimer = setTimeout(() => {
        this.quietTimer = undefined;
        this.quietSince = this.lastProgress;
        this.onQuiet?.(this.quietSince);
      }, active.quietMs);
    }
    this.timer = setTimeout(() => {
      // Disarm before firing so late updates arriving during cancel/close cannot re-arm.
      this.timer = undefined;
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
      this.active = null;
      active.onTimeout();
    }, active.ms);
  }
}

/**
 * Strips MoonAgentic's own internals, GitHub/Git credentials, and service-manager variables from
 * the environment handed to an ACP agent process. `MOONAGENTIC_DEMO_*` stays for the demo agent
 * used in development and tests.
 */
const STRIPPED_AGENT_ENV =
  /^(?:MOONAGENTIC_(?!DEMO_)|(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$|GIT_(?:ASKPASS|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_(?:KEY|VALUE)_\d+)$|(?:TAILSCALE_AUTHKEY|TS_AUTHKEY|NPM_TOKEN|NODE_AUTH_TOKEN|NOTIFY_SOCKET|LISTEN_PID|LISTEN_FDS|LISTEN_FDNAMES)$)/i;

/** The environment handed to a spawned ACP agent, with MoonAgentic and host token variables removed. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !STRIPPED_AGENT_ENV.test(key)) env[key] = value;
  }
  return env;
}

/** One agent process and its ACP session, owned by one thread. */
export class AgentSession {
  readonly sessionId: string;
  /** True when the agent opened a new session rather than continuing an earlier one. */
  readonly fresh: boolean;
  /** The folder the agent works in. */
  readonly cwd: string;
  /** What a message may carry besides text, as the agent told when it started. */
  readonly promptCapabilities: acp.PromptCapabilities;
  /** The agent's name and version, as it gave them when it started. */
  readonly agentVersion: string | undefined;
  private readonly connection: acp.ClientConnection;
  private readonly kill: () => Promise<void>;
  private readonly state: SessionState;
  private readonly watchdog: InactivityWatchdog;
  private readonly inactivityMs: number;
  private readonly quietMs: number;

  private constructor(options: {
    sessionId: string;
    connection: acp.ClientConnection;
    kill: () => Promise<void>;
    state: SessionState;
    watchdog: InactivityWatchdog;
    inactivityMs: number;
    quietMs: number;
    fresh: boolean;
    cwd: string;
    promptCapabilities: acp.PromptCapabilities;
    agentVersion: string | undefined;
  }) {
    this.sessionId = options.sessionId;
    this.fresh = options.fresh;
    this.cwd = options.cwd;
    this.promptCapabilities = options.promptCapabilities;
    this.agentVersion = options.agentVersion;
    this.connection = options.connection;
    this.kill = options.kill;
    this.state = options.state;
    this.watchdog = options.watchdog;
    this.inactivityMs = options.inactivityMs;
    this.quietMs = options.quietMs;
  }

  get model(): ModelOption | undefined {
    return modelOf(this.state);
  }

  async setModel(value: string): Promise<void> {
    const model = this.model;
    if (!model) throw new Error("Cet agent ne propose pas de choix de modèle.");
    if (model.configId === LEGACY_MODEL && this.state.legacy) {
      await this.connection.agent.request(LEGACY_MODEL, {
        sessionId: this.sessionId,
        modelId: value,
      });
      this.state.legacy = { ...this.state.legacy, currentModelId: value };
      return;
    }
    const response = await this.connection.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: model.configId,
      value,
    });
    absorb(this.state, response);
  }

  /** The agent's mode and reasoning effort settings, with their current values. */
  get settings(): AgentSetting[] {
    return settingsOf(this.state);
  }

  async setSetting(id: string, value: string): Promise<void> {
    if (id === LEGACY_MODE && this.state.modes) {
      await this.connection.agent.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: value,
      });
      this.state.modes = { ...this.state.modes, currentModeId: value };
      return;
    }
    const response = await this.connection.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: id,
      value,
    });
    absorb(this.state, response);
  }

  static async start(options: {
    launch: AgentLaunch;
    cwd: string;
    /** A session to continue, from an earlier run of this thread. */
    previousSessionId: string | null;
    handlers: SessionHandlers;
    /** Stops the agent if it has not opened its session yet. */
    signal?: AbortSignal;
    /** MCP servers handed to the agent's session. */
    mcpServers?: McpServerRecord[];
    /** Fails a prompt that makes no real progress within this duration. */
    inactivityMs?: number;
    /** Says a prompt is quiet once it has made no real progress for this long. */
    quietMs?: number;
  }): Promise<AgentSession> {
    const { launch, cwd, handlers, signal } = options;
    signal?.throwIfAborted();
    const plan = spawnPlan(launch.command, launch.args);
    const child = spawn(plan.command, plan.args, {
      cwd,
      env: agentEnv(process.env),
      // Overlapped only where asked (see AgentLaunch); it is a plain pipe off Windows anyway.
      stdio: [launch.overlappedStdin ? "overlapped" : "pipe", "pipe", "pipe"],
      // Its own process group on Unix, so stopping it also stops what it started.
      detached: process.platform !== "win32",
      windowsHide: true,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    // Writes racing the agent's exit fail with EPIPE; the exit handler reports the real cause.
    child.stdin.on("error", () => undefined);
    let askSignIn = () => undefined as void;
    const signInAsked = new Promise<never>((_, reject) => {
      askSignIn = () =>
        reject(
          Object.assign(new Error("L'agent demande d'abord une connexion avec son propre outil."), {
            code: AUTH_REQUIRED,
          }),
        );
    });
    signInAsked.catch(() => undefined);
    let stderr = "";
    let signInSeen = false;
    /** A line of plain text from the agent, on either output: kept for its error report. */
    const textLine = (line: string) => {
      // The sign-in link is neither kept nor shown, wherever the agent writes it and even
      // on a line of its own after the sentence: the user signs in with the agent's own tool.
      if (signInSeen) return;
      if (SIGN_IN_LINE.test(line)) {
        signInSeen = true;
        askSignIn();
      } else {
        stderr = `${stderr}${line}\n`.slice(-STDERR_TAIL);
      }
    };
    // Whole lines only, so a link cut in two by a read is never kept by halves.
    let stderrRest = "";
    const flushStderr = () => {
      if (stderrRest.trim()) textLine(stderrRest);
      stderrRest = "";
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = (stderrRest + chunk).split("\n");
      // The start of a very long line is what tells a sign-in line from another.
      stderrRest = (lines.pop() ?? "").slice(0, OTHER_LINE_MAX);
      for (const line of lines) textLine(line);
    });
    child.stderr.on("end", flushStderr);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    let sessionId: string | null = null;
    const state: SessionState = { options: [], legacy: undefined, modes: undefined };
    // session/load replays the history as updates; the timeline already holds it.
    let replaying = false;
    // Updates can arrive in the same read as the reply that names the session, before
    // `sessionId` is set; they wait here until it is.
    const early: acp.SessionNotification[] = [];
    // Settings seen while starting are the agent's own; the caller then applies the thread's.
    let started = false;
    const watchdog = new InactivityWatchdog(
      handlers.onQuiet && ((since) => handlers.onQuiet?.(since)),
    );
    const dispatch = (params: acp.SessionNotification) => {
      if (params.sessionId !== sessionId) return;
      const update = params.update;
      if (update.sessionUpdate === "config_option_update") {
        state.options = update.configOptions;
      } else if (update.sessionUpdate === "current_mode_update") {
        if (state.modes) state.modes = { ...state.modes, currentModeId: update.currentModeId };
      } else {
        if (!replaying && PROGRESS_UPDATES.has(update.sessionUpdate)) watchdog.progress();
        // A replay repeats old messages, which the timeline already holds, but its commands
        // and context use are the session's current state.
        const current =
          update.sessionUpdate === "available_commands_update" ||
          update.sessionUpdate === "usage_update";
        if (!replaying || current) handlers.onUpdate(update);
        return;
      }
      if (started) handlers.onConfig?.({ model: modelOf(state), settings: settingsOf(state) });
    };
    const app = acp
      .client({ name: "MoonAgentic" })
      .onNotification("session/update", ({ params }) => {
        if (sessionId === null) early.push(params);
        else dispatch(params);
      })
      .onRequest("session/request_permission", async ({ params, signal }) => {
        watchdog.pause();
        try {
          return await handlers.requestPermission(params, signal);
        } finally {
          watchdog.resume();
        }
      });

    await spawned;
    const messages = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
      jsonLines(textLine),
    );
    const connection = app.connect(
      acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, messages),
    );
    let exited = false;
    let stopping = false;
    const exit = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        flushStderr();
        connection.close();
        const failed = code !== 0 && !stopping;
        handlers.onExit(
          failed ? stderr.trim() || `L'agent s'est arrêté (code ${code}).` : undefined,
        );
        resolve();
      });
    });
    /** Stops the agent and resolves once its process is gone, forcing it after a grace period. */
    let killed: Promise<void> | undefined;
    const kill = () => {
      // Asked twice, it is still stopped once.
      killed ??= (async () => {
        stopping = true;
        connection.close();
        if (!exited) {
          setTimeout(() => exited || void killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
          await killTree(child, "SIGTERM");
        }
        await exit;
      })();
      return killed;
    };

    const aborted = new Promise<never>((_, reject) => {
      const stop = () =>
        reject(
          new Error(
            (signal?.reason as { name?: string } | undefined)?.name === "TimeoutError"
              ? "L'agent n'a pas répondu à temps au démarrage."
              : "Démarrage de l'agent arrêté.",
          ),
        );
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
    });
    aborted.catch(() => undefined);

    const handshake = async (): Promise<AgentSession> => {
      const init = await connection.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "MoonAgentic", version: "0.1.0" },
      });
      // The agent answers with the protocol version it speaks; any other is not understood here.
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `Cet agent parle la version ${String(init.protocolVersion)} du protocole ACP, ` +
            `MoonAgentic la version ${acp.PROTOCOL_VERSION}. Mets à jour l'agent ou MoonAgentic.`,
        );
      }
      const authMethodId = init.authMethods?.some((m) => m.id === launch.authMethodId)
        ? launch.authMethodId
        : undefined;
      if (authMethodId && !launch.authWhenAsked) {
        await connection.agent.request("authenticate", { methodId: authMethodId });
      }
      const caps = init.agentCapabilities;
      const mcpServers = acpMcpServers(options.mcpServers ?? [], caps?.mcpCapabilities);
      const previous = options.previousSessionId;
      const askedToSignIn = (error: unknown) =>
        (error as { code?: unknown } | null)?.code === AUTH_REQUIRED;
      /** Continues the earlier session when the agent can, opens a new one otherwise. */
      const open = async () => {
        // A refusal for lack of sign-in is not "this session is gone": it is passed on.
        const unlessSignIn = (error: unknown) => {
          if (askedToSignIn(error)) throw error;
        };
        if (previous && caps?.sessionCapabilities?.resume) {
          await connection.agent
            .request("session/resume", { sessionId: previous, cwd, mcpServers })
            .then((r) => {
              sessionId = previous;
              absorb(state, r);
            })
            .catch(unlessSignIn);
        }
        // An agent that could not resume the session may still be able to reload it.
        if (!sessionId && previous && caps?.loadSession) {
          replaying = true;
          sessionId = previous;
          try {
            absorb(
              state,
              await connection.agent.request("session/load", {
                sessionId: previous,
                cwd,
                mcpServers,
              }),
            );
          } catch (error) {
            sessionId = null;
            unlessSignIn(error);
          } finally {
            replaying = false;
          }
        }
        if (!sessionId) {
          const created = await connection.agent.request("session/new", { cwd, mcpServers });
          sessionId = created.sessionId;
          absorb(state, created);
          return true;
        }
        return false;
      };
      const fresh = await open().catch(async (error: unknown) => {
        if (!askedToSignIn(error) || !authMethodId || !launch.authWhenAsked) throw error;
        await connection.agent.request("authenticate", { methodId: authMethodId });
        return open();
      });
      // Set by `open`, which the compiler does not follow.
      const opened = sessionId as string | null;
      if (!opened) throw new Error("L'agent n'a pas ouvert de session.");
      for (const params of early.splice(0)) dispatch(params);
      started = true;
      return new AgentSession({
        sessionId: opened,
        connection,
        kill,
        state,
        watchdog,
        inactivityMs: options.inactivityMs ?? PROMPT_INACTIVITY_MS,
        quietMs: options.quietMs ?? PROMPT_QUIET_MS,
        fresh,
        cwd,
        promptCapabilities: caps?.promptCapabilities ?? {},
        agentVersion: init.agentInfo
          ? `${init.agentInfo.title ?? init.agentInfo.name} ${init.agentInfo.version}`.trim()
          : undefined,
      });
    };

    try {
      return await Promise.race([handshake(), aborted, signInAsked]);
    } catch (error) {
      // Its process is gone before the failure is reported, so nothing is left running.
      await kill();
      if ((error as { code?: unknown } | null)?.code === AUTH_REQUIRED && launch.login) {
        throw new Error(`Connecte-toi d'abord avec ton compte : ${launch.login}.`, {
          cause: error,
        });
      }
      throw new Error(describe(error, stderr), { cause: error });
    }
  }

  /**
   * Sends the user's message, after the earlier conversation when the agent lacks it, and
   * followed by the files and skills it points at.
   */
  async prompt(
    text: string,
    history?: string,
    links: (PromptLink | ImageBlock)[] = [],
    inactivityMs: number = this.inactivityMs,
  ): Promise<acp.StopReason> {
    const prompt: acp.ContentBlock[] = [
      ...(history ? [{ type: "text" as const, text: history }] : []),
      { type: "text", text },
      ...links,
    ];
    let timedOut = false;
    let onTimeout!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      onTimeout = () => {
        timedOut = true;
        reject(new Error("L'agent ne répond plus : session interrompue après inactivité."));
      };
    });
    timeout.catch(() => undefined);

    const request = this.connection.agent.request("session/prompt", {
      sessionId: this.sessionId,
      prompt,
    });
    // Avoid an unhandled rejection if the watchdog closes the connection after timing out.
    request.catch(() => undefined);

    this.watchdog.start(inactivityMs, this.quietMs, onTimeout);
    try {
      const response = await Promise.race([request, timeout]);
      return response.stopReason;
    } catch (error) {
      if (timedOut) {
        await this.cancel().catch(() => undefined);
        await this.close().catch(() => undefined);
      }
      throw error;
    } finally {
      this.watchdog.stop();
    }
  }

  cancel(): Promise<void> {
    return this.connection.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Stops the agent; resolves once its process has exited and released its folder. */
  close(): Promise<void> {
    this.watchdog.stop();
    return this.kill();
  }
}

export function describe(error: unknown, stderr = ""): string {
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as { data?: unknown } | null)?.data;
  const detail = typeof data === "string" ? data : data ? JSON.stringify(data) : "";
  return [message, detail, stderr.trim().split("\n").slice(-3).join("\n")]
    .filter(Boolean)
    .join("\n");
}
