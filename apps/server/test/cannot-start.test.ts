// Audit of 2026-11-25, N4: a server that cannot open its database says why and what to do,
// and ends with a code that stops the relaunches; one that runs tells its supervisor so.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CANNOT_START, cannotStart } from "../src/cannot-start.ts";
import { Store } from "../src/store.ts";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function dataDir(fill?: (store: Store) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-start-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "state.sqlite"));
  store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
  fill?.(store);
  store.close();
  return dir;
}

interface Run {
  code: number | null;
  out: string;
  messages: unknown[];
}

/** Runs the real server on `dir`, as its supervisor does, until it ends or `until` is true. */
function run(dir: string, until?: (run: Run) => boolean): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, "--demo", "--port", "0", "--data-dir", dir], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, MOONAGENTIC_HOME: dir },
    });
    const result: Run = { code: null, out: "", messages: [] };
    // Ends it as its supervisor does on every system: by closing the channel (Windows
    // has no SIGTERM, which would end it there without its own stop).
    const look = () => {
      if (until?.(result) && child.connected) child.disconnect();
    };
    child.stdout?.on("data", (chunk: Buffer) => ((result.out += chunk.toString()), look()));
    child.stderr?.on("data", (chunk: Buffer) => ((result.out += chunk.toString()), look()));
    child.on("message", (message) => (result.messages.push(message), look()));
    const limit = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("exit", (code) => {
      clearTimeout(limit);
      resolve({ ...result, code });
    });
  });
}

describe("a database the server cannot open (N4)", { timeout: 40_000 }, () => {
  it("from a newer MoonAgentic: says to update, and ends for good", async () => {
    const dir = dataDir((store) => store.db.exec("PRAGMA user_version = 99"));
    const r = await run(dir);
    expect(r.code, r.out).toBe(CANNOT_START);
    expect(r.out).toMatch(
      /MoonAgentic ne peut pas démarrer : .*version plus récente de MoonAgentic.*Mets MoonAgentic à jour/,
    );
  });

  it("damaged: names the latest backup to put in its place, and ends for good", async () => {
    const dir = dataDir((store) => {
      for (let i = 0; i < 200; i++)
        store.addThread({
          id: `t${i}`,
          projectId: "p",
          title: "x".repeat(2000),
          agentId: "demo",
          status: "idle",
          permissionMode: "full",
          createdAt: 1,
          updatedAt: 1,
        });
    });
    const file = path.join(dir, "state.sqlite");
    truncateSync(file, Math.floor(statSync(file).size / 2));
    mkdirSync(path.join(dir, "backups"));
    writeFileSync(path.join(dir, "backups", "state-2026-11-24.sqlite"), "");
    const r = await run(dir);
    expect(r.code, r.out).toBe(CANNOT_START);
    expect(r.out).toContain("MoonAgentic ne peut pas démarrer : sa base de données est abîmée");
    expect(r.out).toContain(path.join(dir, "backups", "state-2026-11-24.sqlite"));
  });
});

describe("putting a backup in place of a damaged database (N4)", { timeout: 40_000 }, () => {
  /** A database of 300 rows and its backup, then rewritten by a server that died there. */
  function diedAfterBackup(): { file: string; backup: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-start-"));
    dirs.push(dir);
    const file = path.join(dir, "state.sqlite");
    const backup = path.join(dir, "state-2026-11-24.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 300; i++) insert.run(`avant-${i}-${"x".repeat(200)}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO '${backup}'`);
    db.close();
    // Ended without closing, as by a power cut: what it wrote stays in the log beside it.
    spawnSync(process.execPath, [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec("PRAGMA wal_autocheckpoint = 0; DELETE FROM t WHERE id % 2 = 0");
      const update = db.prepare("UPDATE t SET v = ? WHERE id = ?");
      for (let i = 1; i < 300; i += 2) update.run("après-" + i + "-" + "y".repeat(500), i);
      process.kill(process.pid, "SIGKILL");`,
    ]);
    return { file, backup };
  }
  const rows = (file: string) => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare("SELECT count(*) AS n, sum(v LIKE 'avant-%') AS before FROM t").get() as {
        n: number;
        before: number;
      };
    } finally {
      db.close();
    }
  };

  // SQLite does so on every system; shown where it was tried.
  it.skipIf(process.platform === "win32")(
    "the log left beside the old one is written over the backup, unless removed first",
    () => {
      const left = diedAfterBackup();
      expect(statSync(`${left.file}-wal`).size).toBeGreaterThan(0);
      copyFileSync(left.backup, left.file);
      // Not the backup any more: SQLite took the old log for this database's own.
      expect(rows(left.file)).not.toEqual({ n: 300, before: 300 });

      const removed = diedAfterBackup();
      rmSync(`${removed.file}-wal`, { force: true });
      rmSync(`${removed.file}-shm`, { force: true });
      copyFileSync(removed.backup, removed.file);
      expect(rows(removed.file)).toEqual({ n: 300, before: 300 });
    },
  );

  it("says to remove the log files left beside the damaged database", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-start-"));
    dirs.push(dir);
    const file = path.join(dir, "state.sqlite");
    const backups = path.join(dir, "backups");
    mkdirSync(backups);
    writeFileSync(path.join(backups, "state-2026-11-24.sqlite"), "");
    const damaged = Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
    const said = cannotStart(damaged, file, backups);
    expect(said).toContain(`${file}-wal`);
    expect(said).toContain(`${file}-shm`);
    expect(said).toContain(path.join(backups, "state-2026-11-24.sqlite"));
  });
});

describe("a server that runs (N4)", { timeout: 40_000 }, () => {
  it("tells its supervisor it answers, once ready", async () => {
    const dir = dataDir();
    const r = await run(dir, (now) =>
      now.messages.some((m) => typeof (m as { heartbeat?: unknown }).heartbeat === "number"),
    );
    expect(r.out).toContain("MoonAgentic est prêt");
    expect(r.code).toBe(0);
  });
});
