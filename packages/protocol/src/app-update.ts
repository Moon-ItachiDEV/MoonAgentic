// MoonAgentic's own version, and what it knows of a newer one. The desktop app looks for
// versions published on GitHub and downloads one in the background; nothing installs until
// the user says so, from the computer or from a paired device.

/** One line of what a version brings: a pull request's title, with its number when known. */
export interface UpdateNote {
  title: string;
  number?: number;
}

/**
 * How this MoonAgentic runs, which says how it updates. `windows`: the desktop app, which
 * downloads and installs a version itself. `mac`: the desktop app, which cannot replace itself
 * unsigned: it points at the download. `git`: a clone started with `pnpm start`, which pulls.
 * `other`: nothing to update from here (a development run).
 */
export type AppKind = "windows" | "mac" | "git" | "other";

/** What the last look for a newer version found, and where installing it stands. */
export interface AppUpdate {
  /**
   * `none`: nothing newer. `checking`: asking now. `downloading`: a newer version is on its
   * way to this computer. `ready`: downloaded and checked, waiting for the user. `available`:
   * newer, but installed by hand (`mac`, `git`). `failed`: looking or downloading failed.
   */
  state: "none" | "checking" | "downloading" | "ready" | "available" | "failed";
  /** When a look last ended. */
  checkedAt?: number;
  /** The newer version, such as `0.1.5`; for `git`, the newest commit of `main`. */
  version?: string;
  /** The installer's size, in bytes. */
  size?: number;
  /** While downloading, from 0 to 1. */
  progress?: number;
  notes?: UpdateNote[];
  /** Where to get it by hand: the release's page. */
  url?: string;
  /** For `git`: how many commits `main` has that this clone does not. */
  behind?: number;
  error?: string;
  /** The user asked to install: once nothing runs (`idle`), or at once. */
  install?: { when: "idle" | "now"; at: number; by: string };
  /** While an install waits: how many threads are at work, named nowhere (/lock). */
  working?: number;
  /** Once installing began: the database is being copied, then the app replaced. */
  phase?: "backup" | "installing";
}

export interface AppInfo {
  kind: AppKind;
  /** This MoonAgentic's version, or its commit for `git`. */
  version: string;
  /** Look for newer versions at start, then every few hours. */
  checks: boolean;
  /** Tell every device when a newer version is ready. */
  notify: boolean;
  /** Desktop app only: starts with the session. */
  openAtLogin?: boolean;
  /** Desktop app only: keeps the computer awake while it runs. */
  preventSleep?: boolean;
  update: AppUpdate;
}

/** At most this many notes are kept for a version. */
export const MAX_UPDATE_NOTES = 20;
/** How often to look for a newer version. */
export const UPDATE_EVERY_MS = 6 * 60 * 60_000;
