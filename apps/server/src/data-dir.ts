import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

const PRIVATE_FILES = ["token", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm"];

/**
 * The data folder holds the access token and MCP secrets, so only its owner may read it,
 * including folders made by an earlier version. SQLite gives its -wal and -shm files the
 * database file's mode, so the database is created private before it is opened.
 */
export function preparePrivateDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  closeSync(openSync(path.join(dir, "state.sqlite"), "a", 0o600));
  // Windows keeps access in ACLs, which a user folder already limits to its owner.
  if (process.platform === "win32") return;
  chmodSync(dir, 0o700);
  for (const name of PRIVATE_FILES) {
    const file = path.join(dir, name);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}
