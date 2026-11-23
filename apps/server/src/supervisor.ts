import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, fstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Days of log files kept. */
export const LOG_DAYS = 14;
const LOG_FILE = /^moonagentic-(\d{4}-\d{2}-\d{2})\.log$/;
/** Crashes closer together than this count as a run of them, each waiting longer. */
const CRASH_WINDOW_MS = 10 * 60_000;
/** The longest wait before starting again, so a server that keeps failing still comes back. */
export const MAX_RESTART_DELAY_MS = 60_000;
/** How long the server may take to stop when asked, before it is ended. */
const STOP_LIMIT_MS = 20_000;
/** Caps an unterminated line held in memory so a broken stream cannot grow forever. */
const MAX_LINE_BUFFER = 64 * 1024;

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Strips access tokens, WebSocket tickets, Bearer credentials, GitHub tokens and common API keys
 * before anything reaches a log file or a service manager's journal.
 */
export const redact = (line: string) =>
  line
    .replace(/(token|ticket)=[\w-]+/gi, "$1=…")
    .replace(/\b(Bearer)\s+(?:(?=\S*[0-9._~+/=-])\S{6,}|[A-Za-z0-9._~+/=-]{16,})/gi, "$1 …")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}\b/g, "$1…")
    .replace(/\b(sk-(?:ant-|proj-|live-|test-)?)[A-Za-z0-9_-]{12,}\b/g, "$1…");

const currentStdStreams = (): string[] => {
  const streams: string[] = [];
  for (const fd of [1, 2]) {
    try {
      const stat = fstatSync(fd);
      streams.push(`${stat.dev}:${stat.ino}`);
    } catch {
      // closed or unavailable descriptor
    }
  }
  return streams;
};

/**
 * True when stdout/stderr goes directly into a service manager's persistent journal (per
 * `systemd.exec(5)`: fd 1 or 2 matches `JOURNAL_STREAM=<dev>:<ino>`, or NSSM) or the operator
 * explicitly set `MOONAGENTIC_REDACT_STDOUT=1`. Checking the actual stream avoids false positives
 * in terminals and CI runners that inherit systemd variables while piping child output.
 */
export function shouldRedactOutput(
  env: NodeJS.ProcessEnv = process.env,
  stdStreams: () => string[] = currentStdStreams,
): boolean {
  if (env.MOONAGENTIC_REDACT_STDOUT === "1" || env.MOONAGENTIC_REDACT_STDOUT === "true") {
    return true;
  }
  if (env.MOONAGENTIC_REDACT_STDOUT === "0" || env.MOONAGENTIC_REDACT_STDOUT === "false") {
    return false;
  }
  if (env.NSSM_SERVICE_NAME) return true;
  const journal = env.JOURNAL_STREAM?.trim();
  return Boolean(journal && stdStreams().includes(journal));
}

/**
 * Reassembles pipe chunks into complete lines before redacting or logging, so a secret split
 * across two reads never escapes in clear text.
 */
export function createLineBuffer(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (text: string) => {
    if (!text) return;
    pending += text;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) onLine(line);
    if (pending.length >= MAX_LINE_BUFFER) {
      onLine(pending);
      pending = "";
    }
  };
  return {
    push: (chunk) => emit(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    flush: () => {
      emit(decoder.end());
      if (pending) {
        onLine(pending);
        pending = "";
      }
    },
  };
}

/** Wait before the next start, given how many crashes came close together. */
export const restartDelay = (crashes: number) =>
  Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** Math.max(0, crashes - 1));

/** One file a day in `dir`, the oldest deleted past `days`; a line that cannot be written is lost. */
export class DailyLog {
  private readonly dir: string;
  private readonly days: number;
  private day = "";
  private pruneDue = false;

  constructor(dir: string, days = LOG_DAYS) {
    this.dir = dir;
    this.days = days;
  }

  /** The file today's lines go to. */
  file(now = new Date()): string {
    return path.join(this.dir, `moonagentic-${dayOf(now)}.log`);
  }

  write(text: string, now = new Date()): void {
    try {
      if (dayOf(now) !== this.day) this.rotate(now);
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      if (!lines.length) return;
      const stamp = timeOf(now);
      appendFileSync(this.file(now), lines.map((l) => `${stamp} ${redact(l)}\n`).join(""), {
        mode: 0o600,
      });
      // Once today's file exists, so that it counts among the days kept.
      if (this.pruneDue) this.prune();
    } catch {
      // A full disk or a locked file must not stop the server that is logging.
    }
  }

  private rotate(now: Date): void {
    this.day = dayOf(now);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.pruneDue = true;
  }

  private prune(): void {
    this.pruneDue = false;
    const files = readdirSync(this.dir)
      .filter((name) => LOG_FILE.test(name))
      .sort()
      .reverse();
    for (const old of files.slice(this.days)) rmSync(path.join(this.dir, old), { force: true });
  }
}

export interface SuperviseOptions {
  /** The server's script, run with this Node. */
  script: string;
  args: string[];
  logDir: string;
  /** Called once the supervisor is done, with the exit code to end with. */
  exit?: (code: number) => void;
  /** Redact secrets before forwarding child output to stdout/stderr (e.g. under systemd). */
  redactOutput?: boolean;
  stdout?: { write(chunk: string | Buffer): unknown };
  stderr?: { write(chunk: string | Buffer): unknown };
}

/**
 * Runs the server and starts it again whenever it ends on a failure, sooner the first time,
 * later when failures follow each other. Everything it prints also goes to a log file. Stops
 * with it when asked to (Ctrl+C), or when it ends on its own without a failure.
 */
export function supervise(options: SuperviseOptions): { stop(): void } {
  const log = new DailyLog(options.logDir);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const redactOut = options.redactOutput ?? shouldRedactOutput();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const say = (line: string, error = false) => {
    const out = redactOut ? redact(line) : line;
    (error ? stderr : stdout).write(`${out}\n`);
    log.write(line);
  };
  let child: ChildProcess | undefined;
  let stopping = false;
  let crashes: number[] = [];
  let restartTimer: NodeJS.Timeout | undefined;

  const start = () => {
    restartTimer = undefined;
    const started = spawn(
      process.execPath,
      [...process.execArgv, options.script, ...options.args],
      {
        // The channel carries no message: its closing tells the server its supervisor is gone,
        // however that happened, so it never lives on alone holding the port.
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    child = started;
    const pipeLines = (stream: { write(chunk: string | Buffer): unknown }) =>
      createLineBuffer((line) => {
        if (redactOut) stream.write(`${redact(line)}\n`);
        log.write(line);
      });
    const outBuf = pipeLines(stdout);
    const errBuf = pipeLines(stderr);
    started.stdout?.on("data", (chunk: Buffer) => {
      if (!redactOut) stdout.write(chunk);
      outBuf.push(chunk);
    });
    started.stdout?.on("end", () => outBuf.flush());
    started.stderr?.on("data", (chunk: Buffer) => {
      if (!redactOut) stderr.write(chunk);
      errBuf.push(chunk);
    });
    started.stderr?.on("end", () => errBuf.flush());
    started.once("error", (error) =>
      say(`Impossible de lancer le serveur : ${error.message}`, true),
    );
    started.once("exit", (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      child = undefined;
      if (stopping) return exit(0);
      if (code === 0) return exit(0);
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      const delay = restartDelay(crashes.length);
      say(
        `Le serveur s'est arrêté sur une erreur (${signal ?? `code ${code}`}) : il redémarre dans ${Math.round(delay / 1000)} s. Journal : ${log.file()}`,
        true,
      );
      restartTimer = setTimeout(start, delay);
    });
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    if (!child) return exit(0);
    // Windows has no signal that lets the server stop its agents first: closing the channel
    // asks it to, there as elsewhere.
    if (child.connected) child.disconnect();
    if (process.platform !== "win32") child.kill("SIGTERM");
    setTimeout(() => {
      child?.kill("SIGKILL");
      exit(0);
    }, STOP_LIMIT_MS).unref();
  };

  log.write("—— MoonAgentic démarre ——");
  start();
  return { stop };
}
