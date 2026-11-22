import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSetting } from "@moonagentic/protocol";
import type { AgentLaunch } from "./agents.ts";
import { acpMcpServers, type McpServerRecord } from "./mcp.ts";

export interface SessionHandlers {
  onUpdate(update: acp.SessionUpdate): void;
  requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  /** The agent process ended; `reason` carries its last stderr lines when it failed. */
  onExit(reason: string | undefined): void;
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
const AUTH_REQUIRED = -32000;

/** One agent process and its ACP session, owned by one thread. */
export class AgentSession {
  readonly sessionId: string;
  /** True when the agent opened a new session rather than continuing an earlier one. */
  readonly fresh: boolean;
  private readonly connection: acp.ClientConnection;
  private readonly kill: () => Promise<void>;
  private readonly state: SessionState;

  private constructor(
    sessionId: string,
    connection: acp.ClientConnection,
    kill: () => Promise<void>,
    state: SessionState,
    fresh: boolean,
  ) {
    this.sessionId = sessionId;
    this.fresh = fresh;
    this.connection = connection;
    this.kill = kill;
    this.state = state;
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
  }): Promise<AgentSession> {
    const { launch, cwd, handlers, signal } = options;
    signal?.throwIfAborted();
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Writes racing the agent's exit fail with EPIPE; the exit handler reports the real cause.
    child.stdin.on("error", () => undefined);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
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
    const dispatch = (params: acp.SessionNotification) => {
      if (params.sessionId !== sessionId) return;
      const update = params.update;
      if (update.sessionUpdate === "config_option_update") {
        state.options = update.configOptions;
      } else if (update.sessionUpdate === "current_mode_update") {
        if (state.modes) state.modes = { ...state.modes, currentModeId: update.currentModeId };
      } else {
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
      .onRequest("session/request_permission", ({ params, signal }) =>
        handlers.requestPermission(params, signal),
      );

    await spawned;
    const connection = app.connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    let exited = false;
    let stopping = false;
    const exit = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        connection.close();
        const failed = code !== 0 && !stopping;
        handlers.onExit(
          failed ? stderr.trim() || `L'agent s'est arrêté (code ${code}).` : undefined,
        );
        resolve();
      });
    });
    /** Stops the agent and resolves once its process is gone, forcing it after a grace period. */
    const kill = () => {
      stopping = true;
      connection.close();
      if (!exited) {
        child.kill("SIGTERM");
        setTimeout(() => exited || child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }
      return exit;
    };

    const aborted = new Promise<never>((_, reject) => {
      const stop = () => reject(new Error("Démarrage de l'agent arrêté."));
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
      if (launch.authMethodId && init.authMethods?.some((m) => m.id === launch.authMethodId)) {
        await connection.agent.request("authenticate", { methodId: launch.authMethodId });
      }
      const caps = init.agentCapabilities;
      const mcpServers = acpMcpServers(options.mcpServers ?? [], caps?.mcpCapabilities);
      const previous = options.previousSessionId;
      if (previous && caps?.sessionCapabilities?.resume) {
        await connection.agent
          .request("session/resume", { sessionId: previous, cwd, mcpServers })
          .then((r) => {
            sessionId = previous;
            absorb(state, r);
          })
          .catch(() => undefined);
      } else if (previous && caps?.loadSession) {
        replaying = true;
        sessionId = previous;
        await connection.agent
          .request("session/load", { sessionId: previous, cwd, mcpServers })
          .then((r) => absorb(state, r))
          .catch(() => (sessionId = null));
        replaying = false;
      }
      const fresh = !sessionId;
      if (!sessionId) {
        const created = await connection.agent.request("session/new", { cwd, mcpServers });
        sessionId = created.sessionId;
        absorb(state, created);
      }
      for (const params of early.splice(0)) dispatch(params);
      started = true;
      return new AgentSession(sessionId, connection, kill, state, fresh);
    };

    try {
      return await Promise.race([handshake(), aborted]);
    } catch (error) {
      void kill();
      if ((error as { code?: unknown } | null)?.code === AUTH_REQUIRED && launch.login) {
        throw new Error(`Connecte-toi d'abord avec ton compte : ${launch.login}.`, {
          cause: error,
        });
      }
      throw new Error(describe(error, stderr), { cause: error });
    }
  }

  /** Sends the user's message, after the earlier conversation when the agent lacks it. */
  async prompt(text: string, history?: string): Promise<acp.StopReason> {
    const response = await this.connection.agent.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [
        ...(history ? [{ type: "text" as const, text: history }] : []),
        { type: "text", text },
      ],
    });
    return response.stopReason;
  }

  cancel(): Promise<void> {
    return this.connection.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Stops the agent; resolves once its process has exited and released its folder. */
  close(): Promise<void> {
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
