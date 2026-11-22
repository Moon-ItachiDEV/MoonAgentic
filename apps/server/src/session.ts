import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
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
  /** The agent's settings (model, effort…) changed. */
  onConfig?(options: acp.SessionConfigOption[]): void;
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

interface SessionState {
  options: acp.SessionConfigOption[];
  legacy: LegacyModels | undefined;
}

/** Keeps what the agent already sent when a response leaves a field out. */
function absorb(state: SessionState, response: unknown): void {
  const options = (response as { configOptions?: acp.SessionConfigOption[] | null } | null)
    ?.configOptions;
  if (options) state.options = options;
  state.legacy = legacyModels(response) ?? state.legacy;
}

const STDERR_TAIL = 4000;
/** ACP's "Authentication required" error code. */
const AUTH_REQUIRED = -32000;

/** One agent process and its ACP session, owned by one thread. */
export class AgentSession {
  readonly sessionId: string;
  /** True when the agent opened a new session rather than continuing an earlier one. */
  readonly fresh: boolean;
  private readonly connection: acp.ClientConnection;
  private readonly kill: () => void;
  private readonly state: SessionState;

  private constructor(
    sessionId: string,
    connection: acp.ClientConnection,
    kill: () => void,
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
    const fromOptions = modelOption(this.state.options);
    const legacy = this.state.legacy;
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
    const state: SessionState = { options: [], legacy: undefined };
    // session/load replays the history as updates; the timeline already holds it.
    let replaying = false;
    const app = acp
      .client({ name: "MoonAgentic" })
      .onNotification("session/update", ({ params }) => {
        if (params.sessionId !== sessionId) return;
        if (params.update.sessionUpdate === "config_option_update") {
          state.options = params.update.configOptions;
          // A replayed setting is the past; the thread's own model choice still wins.
          if (!replaying) handlers.onConfig?.(state.options);
        } else if (!replaying) handlers.onUpdate(params.update);
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
    child.once("exit", (code) => {
      exited = true;
      connection.close();
      const failed = code !== 0 && !stopping;
      handlers.onExit(failed ? stderr.trim() || `L'agent s'est arrêté (code ${code}).` : undefined);
    });
    const kill = () => {
      stopping = true;
      connection.close();
      if (!exited) child.kill("SIGTERM");
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
      return new AgentSession(sessionId, connection, kill, state, fresh);
    };

    try {
      return await Promise.race([handshake(), aborted]);
    } catch (error) {
      kill();
      if ((error as { code?: unknown } | null)?.code === AUTH_REQUIRED && launch.login) {
        throw new Error(`Connecte-toi d'abord avec ton compte : ${launch.login}.`, {
          cause: error,
        });
      }
      throw new Error(describe(error, stderr), { cause: error });
    }
  }

  async prompt(text: string): Promise<acp.StopReason> {
    const response = await this.connection.agent.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    return response.stopReason;
  }

  cancel(): Promise<void> {
    return this.connection.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  close(): void {
    this.kill();
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
