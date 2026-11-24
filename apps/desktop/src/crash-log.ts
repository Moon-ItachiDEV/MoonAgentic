// Daily crash & process-failure log for the Electron desktop shell, written alongside the
// server's own daily logs (`~/.moonagentic/logs/desktop-YYYY-MM-DD.log`). Redacted, capped
// per day, pruned after 14 days, and never throws.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** Days of desktop log files kept. */
export const DESKTOP_LOG_DAYS = 14;
/** Maximum bytes written in a single day, preventing a crash loop from filling the disk. */
export const MAX_DESKTOP_LOG_DAY_BYTES = 5 * 1024 * 1024;
const DESKTOP_LOG_FILE = /^desktop-(\d{4}-\d{2}-\d{2})\.log$/;

const pad2 = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** Strips tokens, tickets, Bearer headers, GitHub tokens and API keys before logging. */
export const redactDesktopLine = (line: string): string =>
  line
    .replace(/(token|ticket)=[\w-]+/gi, "$1=…")
    .replace(/\b(Bearer)\s+(?:(?=\S*[0-9._~+/=-])\S{6,}|[A-Za-z0-9._~+/=-]{16,})/gi, "$1 …")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}\b/g, "$1…")
    .replace(/\b(sk-(?:ant-|proj-|live-|test-)?)[A-Za-z0-9_-]{12,}\b/g, "$1…");

/** Formats an unknown thrown value into a concise redacted message + stack. */
export function formatDesktopError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : String(error);
}

export class DesktopCrashLog {
  private readonly dir: string;
  private readonly days: number;
  private readonly maxBytes: number;
  private day = "";
  private bytes = 0;
  private full = false;
  private pruneDue = false;

  constructor(dir: string, days = DESKTOP_LOG_DAYS, maxBytes = MAX_DESKTOP_LOG_DAY_BYTES) {
    this.dir = dir;
    this.days = days;
    this.maxBytes = maxBytes;
  }

  file(now = new Date()): string {
    return path.join(this.dir, `desktop-${dayOf(now)}.log`);
  }

  write(text: string, now = new Date()): void {
    try {
      if (dayOf(now) !== this.day) this.rotate(now);
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
      if (!lines.length) return;
      if (this.full) {
        if (this.pruneDue) this.prune();
        return;
      }
      const stamp = timeOf(now);
      let chunk = lines.map((l) => `${stamp} ${redactDesktopLine(l)}\n`).join("");
      if (this.bytes + Buffer.byteLength(chunk) > this.maxBytes) {
        this.full = true;
        chunk = `${stamp} Journal bureau plein pour aujourd'hui : la suite reprend demain.\n`;
      }
      appendFileSync(this.file(now), chunk, { mode: 0o600 });
      this.bytes += Buffer.byteLength(chunk);
      if (this.pruneDue) this.prune();
    } catch {
      // Never crash the desktop shell while logging a crash.
    }
  }

  private rotate(now: Date): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.day = dayOf(now);
    try {
      this.bytes = statSync(this.file(now)).size;
    } catch {
      this.bytes = 0;
    }
    this.full = this.bytes >= this.maxBytes;
    this.pruneDue = true;
  }

  private prune(): void {
    this.pruneDue = false;
    const files = readdirSync(this.dir)
      .filter((name) => DESKTOP_LOG_FILE.test(name))
      .sort()
      .reverse();
    for (const old of files.slice(this.days)) {
      rmSync(path.join(this.dir, old), { force: true });
    }
  }
}
