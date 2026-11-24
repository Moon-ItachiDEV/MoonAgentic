import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";

/** Copies kept, one a day: a week to notice that something went missing. */
export const BACKUPS_KEPT = 7;
/** How often the day is looked at, so a copy is made soon after a sleep or midnight. */
const CHECK_MS = 60 * 60_000;
const BACKUP_FILE = /^state-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const PARTIAL_FILE = /^state-\d{4}-\d{2}-\d{2}\.sqlite\.tmp$/;

/** The local day, as the copy of the database made that day is named. */
const dayOf = (time: number) => {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Makes one copy of the database a day in `dir`, the first as the server starts, and keeps
 * the last `keep`. Only its owner reads it; MCP secrets live apart from the database.
 */
export async function backupNow(
  store: Pick<Store, "backup">,
  dir: string,
  now = Date.now(),
  keep = BACKUPS_KEPT,
): Promise<string | undefined> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Copies cut short by a power cut, on this day or an earlier one, go first.
  for (const name of readdirSync(dir).filter((n) => PARTIAL_FILE.test(n)))
    rmSync(path.join(dir, name), { force: true });
  const file = path.join(dir, `state-${dayOf(now)}.sqlite`);
  if (existsSync(file)) return undefined;
  // Written beside, then renamed: a power cut in the middle never leaves half a copy under
  // the day's name.
  const partial = `${file}.tmp`;
  try {
    await store.backup(partial);
    if (process.platform !== "win32") chmodSync(partial, 0o600);
    renameSync(partial, file);
  } catch (error) {
    // A full disk: what was written of the copy goes, not to fill it further.
    rmSync(partial, { force: true });
    throw error;
  }
  const copies = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort()
    .reverse();
  for (const old of copies.slice(keep)) rmSync(path.join(dir, old), { force: true });
  return file;
}

/**
 * Copies the database now if today has no copy yet, then once a day while it runs. `stop`
 * waits for a copy under way, so the database is never closed in the middle of one.
 */
export function dailyBackups(store: Pick<Store, "backup">, dir: string): { stop(): Promise<void> } {
  let running: Promise<void> | undefined;
  const run = () => {
    // A copy still going (a slow disk) is not started a second time.
    running ??= backupNow(store, dir)
      .then((file) => {
        if (file) console.log(`Sauvegarde de la base : ${file}`);
      })
      .catch((error: unknown) => console.error("Sauvegarde de la base impossible :", error))
      .finally(() => {
        running = undefined;
      });
  };
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
