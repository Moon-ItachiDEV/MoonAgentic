import { type ChildProcess, spawn } from "node:child_process";

/** Where the server stands, as the window and the tray icon show it. */
export type ServerState =
  | { kind: "starting" }
  | { kind: "ready"; url: string }
  | { kind: "restarting"; reason: string }
  | { kind: "stopping" }
  | { kind: "stopped" };

/** What one line the server prints says about it, if anything. */
export type LineEvent = { ready: string } | { failed: string } | undefined;

const READY = /MoonAgentic est prêt : (https?:\/\/\S+)/;
const CRASHED = /Le serveur s'est arrêté sur une erreur/;
const PORT_TAKEN = /EADDRINUSE/;
/** Printed by a server that found another MoonAgentic on its data folder (instance.ts). */
const ALREADY_RUNNING = /MoonAgentic tourne déjà sur ce dossier de données/;

export function readLine(line: string): LineEvent {
  const ready = READY.exec(line);
  if (ready?.[1]) return { ready: ready[1] };
  if (ALREADY_RUNNING.test(line)) {
    return {
      failed:
        "MoonAgentic tourne déjà, sans doute lancé dans un terminal. Ferme-le : l'app prend " +
        "le relais d'elle-même.",
    };
  }
  if (PORT_TAKEN.test(line)) {
    return {
      failed:
        "Le port est déjà pris, sans doute par MoonAgentic lancé dans un terminal. Ferme-le : " +
        "le serveur d'ici réessaie de lui-même.",
    };
  }
  if (CRASHED.test(line)) return { failed: "Le serveur s'est arrêté sur une erreur et redémarre." };
  return undefined;
}

/** The longest wait before starting the supervisor again, after it ended by itself. */
export const MAX_RESTART_DELAY_MS = 60_000;
/** How long the server may take to stop its agents when asked, before it is ended. */
export const STOP_LIMIT_MS = 25_000;
/** A supervisor that ran this long before ending does not count as failing again. */
const STEADY_MS = 10 * 60_000;

export const restartDelay = (failures: number) =>
  Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** Math.max(0, failures - 1));

export interface ServerProcessOptions {
  /** The program to run the script with: Electron itself, made to act as Node. */
  command: string;
  /** The server's own launcher (`apps/server/src/bin.ts`), which restarts it after a crash. */
  script: string;
  args: string[];
  /** Read at each start, so that a PATH found later (see shell-path.ts) reaches the server. */
  env: () => NodeJS.ProcessEnv;
  onState: (state: ServerState) => void;
  platform?: NodeJS.Platform;
}

/**
 * Keeps MoonAgentic's server running. The launcher it starts already brings the server back
 * after a crash; this starts the launcher itself again, should it end while it is still wanted.
 */
export class ServerProcess {
  private readonly options: ServerProcessOptions;
  private child: ChildProcess | undefined;
  private wanted = false;
  private failures = 0;
  private timer: NodeJS.Timeout | undefined;
  private current: ServerState = { kind: "stopped" };
  /** Counts stops: a restart started before the latest one does not start again. */
  private stops = 0;
  /** Why the current run failed, as one of its lines said. */
  private failed: string | undefined;

  constructor(options: ServerProcessOptions) {
    this.options = options;
  }

  get state(): ServerState {
    return this.current;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.launch();
  }

  /** Stops the server and its agents; resolves once it is gone. */
  async stop(): Promise<void> {
    this.stops += 1;
    this.wanted = false;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return this.set({ kind: "stopped" });
    this.set({ kind: "stopping" });
    await new Promise<void>((resolve) => {
      const limit = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_LIMIT_MS);
      child.once("exit", () => {
        clearTimeout(limit);
        resolve();
      });
      // Closing the channel asks the launcher to stop the server, which stops its agents,
      // then the launcher ends: the one way to ask that works on Windows too. On Unix the
      // signal says the same.
      if (child.connected) child.disconnect();
      if ((this.options.platform ?? process.platform) !== "win32") child.kill("SIGTERM");
    });
    this.set({ kind: "stopped" });
  }

  async restart(): Promise<void> {
    const stopped = this.stop();
    const stops = this.stops;
    await stopped;
    // Quitting while this restart waited stops for good.
    if (stops !== this.stops) return;
    this.failures = 0;
    this.start();
  }

  private set(state: ServerState): void {
    this.current = state;
    this.options.onState(state);
  }

  private launch(): void {
    this.timer = undefined;
    this.set({ kind: "starting" });
    const startedAt = Date.now();
    const child = spawn(this.options.command, [this.options.script, ...this.options.args], {
      env: this.options.env(),
      // The channel carries no message: closing it asks the launcher to stop.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    const lines = (stream: NodeJS.ReadableStream | null) => {
      let rest = "";
      stream?.on("data", (chunk: Buffer) => {
        const parts = (rest + chunk.toString()).split(/\r?\n/);
        rest = parts.pop() ?? "";
        for (const line of parts) this.line(line);
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    // What this run said went wrong, kept for when it ends: "already running" says more than
    // "the server stopped".
    this.failed = undefined;
    child.once("error", (error) => {
      this.set({
        kind: "restarting",
        reason: `Impossible de lancer le serveur : ${error.message}`,
      });
    });
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      if (!this.wanted) return;
      this.failures = Date.now() - startedAt > STEADY_MS ? 1 : this.failures + 1;
      const delay = restartDelay(this.failures);
      const retry = `il repart dans ${Math.round(delay / 1000)} s.`;
      this.set({
        kind: "restarting",
        reason: this.failed
          ? `${this.failed} Nouvel essai : ${retry}`
          : `Le serveur s'est arrêté : ${retry}`,
      });
      this.timer = setTimeout(() => this.launch(), delay);
    });
  }

  private line(line: string): void {
    const event = readLine(line);
    if (!event) return;
    if ("ready" in event) {
      this.failed = undefined;
      this.set({ kind: "ready", url: event.ready });
    } else {
      this.failed = event.failed;
      this.set({ kind: "restarting", reason: event.failed });
    }
  }
}
