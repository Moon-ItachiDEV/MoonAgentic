import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The exit code of a server that cannot start on its data folder whatever the number of
 * tries: its supervisor and the desktop app stop starting it again, and show why.
 */
export const CANNOT_START = 4;
/** The start of the line such a server prints, which the desktop app looks for. */
export const CANNOT_START_LINE = "MoonAgentic ne peut pas démarrer";

/** SQLite's codes for a file that is not, or no longer, a whole database. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const NEWER = /version plus récente de MoonAgentic/;

/** The latest copy of the database in `backupsDir`, if there is one. */
function latestBackup(backupsDir: string): string | undefined {
  try {
    return readdirSync(backupsDir)
      .filter((name) => /^state-.+\.sqlite$/.test(name))
      .map((name) => ({ name, at: statSync(path.join(backupsDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.name;
  } catch {
    return undefined;
  }
}

/**
 * What to tell, when `error` is one that starting again would meet again: the database is
 * of a newer MoonAgentic, or is damaged. Undefined for anything else.
 */
export function cannotStart(error: unknown, file: string, backupsDir: string): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (NEWER.test(error.message)) return `${CANNOT_START_LINE} : ${error.message}`;
  const code = (error as { errcode?: unknown }).errcode;
  // An extended code holds the primary one in its low byte.
  const primary = typeof code === "number" ? code & 0xff : undefined;
  if (primary !== SQLITE_CORRUPT && primary !== SQLITE_NOTADB) return undefined;
  const latest = latestBackup(backupsDir);
  // The log left beside the damaged file goes first: SQLite would take it for the backup's
  // own, and write it over the backup at the next start.
  const remedy = latest
    ? `Ferme MoonAgentic, supprime ${file}-wal et ${file}-shm s'ils existent, puis remplace ${file} par la sauvegarde ${path.join(backupsDir, latest)} (renommée state.sqlite).`
    : `Aucune sauvegarde dans ${backupsDir} : ferme MoonAgentic et déplace ${file} ailleurs pour repartir d'une base vide.`;
  return `${CANNOT_START_LINE} : sa base de données est abîmée (${error.message}). ${remedy}`;
}
