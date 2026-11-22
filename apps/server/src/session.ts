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
}

const STDERR_TAIL = 4000;

/** One agent process and its ACP session, owned by one thread. */
export class AgentSession {
  readonly sessionId: string;
  private readonly connection: acp.ClientConnection;
  private readonly kill: () => void;

  private constructor(sessionId: string, connection: acp.ClientConnection, kill: () => void) {
    this.sessionId = sessionId;
    this.connection = connection;
    this.kill = kill;
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
    // session/load replays the history as updates; the timeline already holds it.
    let replaying = false;
    const app = acp
      .client({ name: "MoonAgentic" })
      .onNotification("session/update", ({ params }) => {
        if (params.sessionId === sessionId && !replaying) handlers.onUpdate(params.update);
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
      const caps = init.agentCapabilities;
      const previous = options.previousSessionId;
      if (previous && caps?.sessionCapabilities?.resume) {
        await connection.agent
          .request("session/resume", { sessionId: previous, cwd, mcpServers: [] })
          .then(() => (sessionId = previous))
          .catch(() => undefined);
      } else if (previous && caps?.loadSession) {
        replaying = true;
        sessionId = previous;
        await connection.agent
          .request("session/load", { sessionId: previous, cwd, mcpServers: [] })
          .catch(() => (sessionId = null));
        replaying = false;
      }
      if (!sessionId) {
        const created = await connection.agent.request("session/new", { cwd, mcpServers: [] });
        sessionId = created.sessionId;
      }
      return new AgentSession(sessionId, connection, kill);
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
