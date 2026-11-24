// MoonAgentic's own updates, as every device sees them. The desktop app does the looking and
// the downloading (it knows its version and replaces itself); a clone started with
// `pnpm start` is looked at here, with git. Nothing installs until the user asks, from any
// device, and then once no thread is at work unless they said « now ».
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type AppInfo,
  type AppKind,
  type AppUpdate,
  MAX_UPDATE_NOTES,
  type ServerMessage,
  UPDATE_EVERY_MS,
  type UpdateNote,
} from "@moonagentic/protocol";
import { git } from "./git.ts";

/** What the desktop app says of itself, through its channel with the server. */
export interface DesktopReport {
  platform: string;
  version: string;
  /** Installed from an installer: only then can it replace itself. */
  packaged: boolean;
  openAtLogin?: boolean;
  preventSleep?: boolean;
  update: Omit<AppUpdate, "install" | "working" | "phase" | "behind">;
}

/** What the server asks of the desktop app. */
export type ToShell =
  | { moon: "hello" }
  | { moon: "check" }
  | { moon: "install" }
  | { moon: "settings"; openAtLogin?: boolean; preventSleep?: boolean };

/** The desktop app's channel: the IPC one, through the supervisor. */
export interface ShellChannel {
  send(message: ToShell): void;
  onMessage(listener: (message: unknown) => void): void;
}

/** A clone of MoonAgentic's repository, looked at with git. */
export interface GitSource {
  version(): Promise<string>;
  check(): Promise<{ version: string; behind: number; notes: UpdateNote[] }>;
}

interface Settings {
  checks: boolean;
  notify: boolean;
}

export interface SettingsStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
}

const SETTINGS = "app.settings";
/** The version every device was told of: told once. */
const NOTIFIED = "app.notified";
/** How often an install that waits looks at the threads again, and a look is found due. */
const TICK_MS = 5_000;
/** A look asked of the desktop app that never came back is asked again after this. */
const ASK_AGAIN_MS = 10 * 60_000;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const STATES = new Set(["none", "checking", "downloading", "ready", "available", "failed"]);

/** The notes as kept: titles of one line, numbers that are numbers, not too many. */
export function readNotes(value: unknown): UpdateNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes: UpdateNote[] = [];
  for (const note of value.slice(0, MAX_UPDATE_NOTES)) {
    const title = text((note as { title?: unknown })?.title, 300)
      ?.split(/\r?\n/)[0]
      ?.trim();
    if (!title) continue;
    const n = (note as { number?: unknown }).number;
    notes.push({
      title,
      ...(Number.isInteger(n) && (n as number) > 0 ? { number: n as number } : {}),
    });
  }
  return notes;
}

/** The desktop app's report, checked; undefined when the message is not one. */
export function readReport(message: unknown): DesktopReport | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { moon?: unknown; desktop?: Record<string, unknown> };
  if (m.moon !== "desktop" || !m.desktop || typeof m.desktop !== "object") return undefined;
  const d = m.desktop;
  const u = (d.update ?? {}) as Record<string, unknown>;
  const platform = text(d.platform, 20);
  const version = text(d.version, 40);
  if (!platform || !version || typeof d.packaged !== "boolean") return undefined;
  if (typeof u.state !== "string" || !STATES.has(u.state)) return undefined;
  const url = text(u.url, 500);
  const notes = readNotes(u.notes);
  const update: DesktopReport["update"] = { state: u.state as AppUpdate["state"] };
  const checkedAt = num(u.checkedAt);
  const size = num(u.size);
  const progress = num(u.progress);
  const newer = text(u.version, 40);
  const error = text(u.error, 500);
  if (checkedAt !== undefined) update.checkedAt = checkedAt;
  if (newer) update.version = newer;
  if (size !== undefined) update.size = size;
  if (progress !== undefined) update.progress = Math.min(1, progress);
  if (notes?.length) update.notes = notes;
  // Only a page on GitHub: it is shown as a link to follow.
  if (url && url.startsWith("https://github.com/")) update.url = url;
  if (error) update.error = error;
  const openAtLogin = bool(d.openAtLogin);
  const preventSleep = bool(d.preventSleep);
  return {
    platform,
    version,
    packaged: d.packaged,
    ...(openAtLogin !== undefined ? { openAtLogin } : {}),
    ...(preventSleep !== undefined ? { preventSleep } : {}),
    update,
  };
}

/** The pull requests merged into `main` since this clone's commit, from `git log`. */
export function gitNotes(log: string): UpdateNote[] {
  const notes: UpdateNote[] = [];
  for (const record of log.split("\x1e")) {
    const [subject = "", body = ""] = record.replace(/^\s+/, "").split("\x1f");
    if (!subject.trim()) continue;
    const merge = /^Merge pull request #(\d+)\b/.exec(subject);
    const title = merge
      ? body
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim()
      : subject.trim();
    notes.push({
      title: title || subject.trim(),
      ...(merge ? { number: Number(merge[1]) } : {}),
    });
    if (notes.length >= MAX_UPDATE_NOTES) break;
  }
  return notes;
}

/** The clone MoonAgentic runs from, when it runs from one. */
export function gitSource(root: string): GitSource | undefined {
  if (!existsSync(path.join(root, ".git"))) return undefined;
  const run = (args: string[], timeout?: number) =>
    git(root, args, undefined, timeout).then((out) => out.trim());
  return {
    version: () => run(["rev-parse", "--short", "HEAD"]),
    async check() {
      await run(["fetch", "--quiet", "origin", "main"], 2 * 60_000);
      const behind = Number(await run(["rev-list", "--count", "HEAD..origin/main"])) || 0;
      const version = await run(["rev-parse", "--short", "origin/main"]);
      const log = await run([
        "log",
        "--first-parent",
        "-n",
        String(MAX_UPDATE_NOTES),
        "--format=%s%x1f%b%x1e",
        "HEAD..origin/main",
      ]);
      return { version, behind, notes: gitNotes(log) };
    },
  };
}

export interface AppUpdatesOptions {
  settings: SettingsStore;
  broadcast: (message: ServerMessage) => void;
  /** How many threads are at work now. */
  working: () => number;
  /** Copies the database before the app is replaced with that version. */
  backup: (version: string) => Promise<void>;
  /** Tells every device something: a newer version is ready. */
  notify: (title: string, body: string) => void;
  /** Stops what would start new work while the app is being replaced. */
  pause?: () => void;
  /** Starts it again when the app is not replaced after all. */
  resume?: () => void;
  shell?: ShellChannel;
  git?: GitSource;
  /** The server's own version, when nothing else says one. */
  version?: string;
  everyMs?: number;
  tickMs?: number;
  now?: () => number;
}

/** Errors the user can read, never a stack. */
const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

export class AppUpdates {
  private readonly options: AppUpdatesOptions;
  private readonly now: () => number;
  private desktop: DesktopReport | undefined;
  private gitVersion: string | undefined;
  private gitUpdate: AppUpdate = { state: "none" };
  private gitChecking: Promise<void> | undefined;
  /** When the desktop app was last asked to look, while it has not answered. */
  private askedAt: number | undefined;
  private install: AppUpdate["install"];
  private working: number | undefined;
  private phase: AppUpdate["phase"];
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(options: AppUpdatesOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    options.shell?.onMessage((message) => this.fromShell(message));
    // Asked at each start: a server started again after a crash knows nothing yet.
    options.shell?.send({ moon: "hello" });
    if (options.git) {
      options.git
        .version()
        .then((v) => {
          this.gitVersion = v;
          this.changed();
        })
        .catch(() => undefined);
    }
    this.timer = setInterval(() => this.tick(), options.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  private settings(): Settings {
    const saved = this.options.settings.getSetting<Partial<Settings>>(SETTINGS, {});
    return { checks: saved.checks ?? true, notify: saved.notify ?? true };
  }

  kind(): AppKind {
    const d = this.desktop;
    if (d?.packaged && d.platform === "win32") return "windows";
    if (d?.packaged && d.platform === "darwin") return "mac";
    return this.options.git ? "git" : "other";
  }

  /** True from the copy of the database until the app is gone: no new work starts. */
  get switching(): boolean {
    return this.phase !== undefined;
  }

  update(): AppUpdate {
    const kind = this.kind();
    const base: AppUpdate =
      kind === "git"
        ? this.gitUpdate
        : kind === "other"
          ? { state: "none" }
          : { ...this.desktop!.update };
    return {
      ...base,
      ...(this.install ? { install: this.install } : {}),
      ...(this.install && this.working !== undefined ? { working: this.working } : {}),
      ...(this.phase ? { phase: this.phase } : {}),
    };
  }

  info(): AppInfo {
    const { checks, notify } = this.settings();
    const d = this.desktop;
    return {
      kind: this.kind(),
      version: d?.version ?? this.gitVersion ?? this.options.version ?? "",
      checks,
      notify,
      ...(d?.openAtLogin !== undefined ? { openAtLogin: d.openAtLogin } : {}),
      ...(d?.preventSleep !== undefined ? { preventSleep: d.preventSleep } : {}),
      update: this.update(),
    };
  }

  /** Looks for a newer version now, whatever the last look said. */
  check(): void {
    const kind = this.kind();
    if (kind === "windows" || kind === "mac") {
      this.askedAt = this.now();
      this.options.shell?.send({ moon: "check" });
    } else if (kind === "git") {
      void this.checkGit();
    }
  }

  /** Installs the version downloaded, once no thread is at work or at once. */
  requestInstall(when: "idle" | "now", by: string): void {
    if (this.kind() !== "windows" || this.desktop?.update.state !== "ready") {
      throw new Error("Aucune version n'est prête à installer.");
    }
    if (this.phase) throw new Error("L'installation a déjà commencé.");
    this.install = { when, at: this.now(), by };
    this.working = this.options.working();
    this.changed();
    void this.evaluate();
  }

  cancel(): void {
    if (this.phase) throw new Error("L'installation a déjà commencé.");
    if (!this.install) return;
    this.install = undefined;
    this.working = undefined;
    this.changed();
  }

  setSettings(patch: {
    checks?: boolean;
    notify?: boolean;
    openAtLogin?: boolean;
    preventSleep?: boolean;
  }): void {
    const current = this.settings();
    const next = {
      checks: patch.checks ?? current.checks,
      notify: patch.notify ?? current.notify,
    };
    this.options.settings.setSetting(SETTINGS, next);
    if (patch.openAtLogin !== undefined || patch.preventSleep !== undefined) {
      if (!this.desktop) throw new Error("Ce réglage n'existe que dans l'app de bureau.");
      this.options.shell?.send({
        moon: "settings",
        ...(patch.openAtLogin !== undefined ? { openAtLogin: patch.openAtLogin } : {}),
        ...(patch.preventSleep !== undefined ? { preventSleep: patch.preventSleep } : {}),
      });
    }
    this.changed();
    if (next.checks && !current.checks) this.check();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private fromShell(message: unknown): void {
    const report = readReport(message);
    if (!report || this.closed) return;
    const first = !this.desktop;
    this.desktop = report;
    if (report.update.state !== "checking") this.askedAt = undefined;
    // The desktop app could not install after all: it says why, and the server goes on.
    if (this.phase === "installing" && report.update.state !== "ready") this.abort();
    this.changed();
    if (first) this.tick();
  }

  private async checkGit(): Promise<void> {
    const source = this.options.git;
    if (!source || this.gitChecking) return this.gitChecking;
    this.gitUpdate = { ...this.gitUpdate, state: "checking" };
    this.changed();
    this.gitChecking = source
      .check()
      .then(({ version, behind, notes }) => {
        this.gitUpdate =
          behind > 0
            ? { state: "available", checkedAt: this.now(), version, behind, notes }
            : { state: "none", checkedAt: this.now() };
      })
      .catch((error: unknown) => {
        this.gitUpdate = { state: "failed", checkedAt: this.now(), error: describe(error) };
      })
      .finally(() => {
        this.gitChecking = undefined;
        this.changed();
      });
    return this.gitChecking;
  }

  /** A look found due, and an install that waits looked at again. */
  private tick(): void {
    if (this.closed) return;
    void this.evaluate();
    if (!this.settings().checks || this.phase) return;
    const kind = this.kind();
    const every = this.options.everyMs ?? UPDATE_EVERY_MS;
    const now = this.now();
    if (kind === "windows" || kind === "mac") {
      const u = this.desktop!.update;
      if (u.state === "checking" || u.state === "downloading") return;
      if (this.askedAt !== undefined && now - this.askedAt < ASK_AGAIN_MS) return;
      if (u.checkedAt === undefined || now - u.checkedAt >= every) this.check();
    } else if (kind === "git") {
      const at = this.gitUpdate.checkedAt;
      if (!this.gitChecking && (at === undefined || now - at >= every)) void this.checkGit();
    }
  }

  private async evaluate(): Promise<void> {
    const install = this.install;
    if (!install || this.phase || this.closed) return;
    const working = this.options.working();
    if (install.when === "idle" && working > 0) {
      if (working !== this.working) {
        this.working = working;
        this.changed();
      }
      return;
    }
    const version = this.desktop?.update.version ?? "";
    this.working = 0;
    this.phase = "backup";
    this.options.pause?.();
    this.changed();
    try {
      await this.options.backup(version);
    } catch (error) {
      // Without a fresh copy of the database, nothing is replaced.
      console.error("Copie de la base avant la mise à jour :", error);
      this.abort();
      if (this.desktop) {
        this.desktop = {
          ...this.desktop,
          update: {
            ...this.desktop.update,
            error: `La copie de la base a échoué : ${describe(error)}`,
          },
        };
      }
      this.changed();
      return;
    }
    if (this.closed) return;
    this.phase = "installing";
    this.changed();
    this.options.shell?.send({ moon: "install" });
  }

  /** The app is not replaced after all: work starts again as before. */
  private abort(): void {
    this.phase = undefined;
    this.install = undefined;
    this.working = undefined;
    this.options.resume?.();
  }

  /** Every device learns of it; a version newly ready is told once, if wished. */
  private changed(): void {
    if (this.closed) return;
    const info = this.info();
    this.options.broadcast({ type: "app", app: info });
    const u = info.update;
    if (!info.notify || !u.version || (u.state !== "ready" && u.state !== "available")) return;
    if (this.options.settings.getSetting<string>(NOTIFIED, "") === u.version) return;
    this.options.settings.setSetting(NOTIFIED, u.version);
    this.options.notify(
      info.kind === "git" ? "Nouvelle version sur main" : `Mise à jour ${u.version} prête`,
      info.kind === "windows"
        ? "Touche pour choisir quand l'installer."
        : info.kind === "mac"
          ? "Télécharge-la pour remplacer l'app."
          : `${u.behind ?? 0} commit${(u.behind ?? 0) > 1 ? "s" : ""} à récupérer avec git pull.`,
    );
  }
}
