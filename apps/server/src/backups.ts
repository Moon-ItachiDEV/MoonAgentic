import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";

/** Copies kept, one a day: a week to notice that something went missing. */
export const BACKUPS_KEPT = 7;
/** How often the day is looked at, so a copy is made soon after a sleep or midnight. */
const CHECK_MS = 60 * 60_000;
const BACKUP_FILE = /^state-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/** The local day, as the copy of the database made that day is named. */
const dayOf = (time: number) => {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Makes one copy of the database a day in `dir`, the first as the server starts, and keeps
 * the last `keep`. A copy holds what the database holds, MCP secrets included: only its
 * owner reads it.
 */
export function backupNow(
  store: Pick<Store, "backup">,
  dir: string,
  now = Date.now(),
  keep = BACKUPS_KEPT,
): string | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `state-${dayOf(now)}.sqlite`);
  if (existsSync(file)) return undefined;
  store.backup(file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  const copies = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort()
    .reverse();
  for (const old of copies.slice(keep)) rmSync(path.join(dir, old), { force: true });
  return file;
}

/** Copies the database now if today has no copy yet, then once a day while it runs. */
export function dailyBackups(store: Pick<Store, "backup">, dir: string): { stop(): void } {
  const run = () => {
    try {
      const file = backupNow(store, dir);
      if (file) console.log(`Sauvegarde de la base : ${file}`);
    } catch (error) {
      console.error("Sauvegarde de la base impossible :", error);
    }
  };
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
