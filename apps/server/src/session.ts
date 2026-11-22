import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentLaunch } from "./agents.ts";

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

const STDERR_TAIL = 4000;

/** One agent process and its ACP session, owned by one thread. */
export class AgentSession {
  readonly sessionId: string;
  /** True when the agent opened a new session rather than continuing an earlier one. */
  readonly fresh: boolean;
  private readonly connection: acp.ClientConnection;
  private readonly kill: () => void;
  private readonly state: { options: acp.SessionConfigOption[] };

  private constructor(
    sessionId: string,
    connection: acp.ClientConnection,
    kill: () => void,
    state: { options: acp.SessionConfigOption[] },
    fresh: boolean,
  ) {
    this.sessionId = sessionId;
    this.fresh = fresh;
    this.connection = connection;
    this.kill = kill;
    this.state = state;
  }

  get model(): ModelOption | undefined {
    return modelOption(this.state.options);
  }

  async setConfig(configId: string, value: string): Promise<void> {
    const response = await this.connection.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    });
    this.state.options = response.configOptions;
  }

  static async start(options: {
    launch: AgentLaunch;
    cwd: string;
    /** A session to continue, from an earlier run of this thread. */
    previousSessionId: string | null;
    handlers: SessionHandlers;
  }): Promise<AgentSession> {
    const { launch, cwd, handlers } = options;
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
    const state: { options: acp.SessionConfigOption[] } = { options: [] };
    // session/load replays the history as updates; the timeline already holds it.
    let replaying = false;
    const app = acp
      .client({ name: "MoonAgentic" })
      .onNotification("session/update", ({ params }) => {
        if (params.sessionId !== sessionId) return;
        if (params.update.sessionUpdate === "config_option_update") {
          state.options = params.update.configOptions;
          handlers.onConfig?.(state.options);
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

    try {
      const init = await connection.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "MoonAgentic", version: "0.1.0" },
      });
      if (launch.authMethodId && init.authMethods?.some((m) => m.id === launch.authMethodId)) {
        await connection.agent.request("authenticate", { methodId: launch.authMethodId });
      }
      const caps = init.agentCapabilities;
      const previous = options.previousSessionId;
      if (previous && caps?.sessionCapabilities?.resume) {
        await connection.agent
          .request("session/resume", { sessionId: previous, cwd, mcpServers: [] })
          .then((r) => {
            sessionId = previous;
            state.options = r.configOptions ?? [];
          })
          .catch(() => undefined);
      } else if (previous && caps?.loadSession) {
        replaying = true;
        sessionId = previous;
        await connection.agent
          .request("session/load", { sessionId: previous, cwd, mcpServers: [] })
          .then((r) => {
            state.options = r?.configOptions ?? [];
          })
          .catch(() => (sessionId = null));
        replaying = false;
      }
      const fresh = !sessionId;
      if (!sessionId) {
        const created = await connection.agent.request("session/new", { cwd, mcpServers: [] });
        sessionId = created.sessionId;
        state.options = created.configOptions ?? [];
      }
      return new AgentSession(sessionId, connection, kill, state, fresh);
    } catch (error) {
      kill();
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
