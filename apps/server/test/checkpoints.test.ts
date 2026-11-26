// Neon, on the PR 8: the log cut back while the server writes holds its writes, and on a Windows
// disk a thread's removal failed there with « database is locked ».
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../src/checkpoints.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe("the copy of the write-ahead log", () => {
  it("cuts an overgrown log back only once nothing writes to it any more", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-checkpoints-"));
    const file = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT)");
    const checkpoints = new Checkpoints(file, db);
    cleanups.push(() => {
      checkpoints.close();
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    // Only the looks this test makes.
    const inside = checkpoints as unknown as { timer: NodeJS.Timeout; busy: boolean };
    clearInterval(inside.timer);
    const asked = vi.spyOn(Worker.prototype, "postMessage");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    const megabyte = "x".repeat(1024 * 1024);
    const look = async () => {
      checkpoints.look();
      while (inside.busy) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    // Writes of 9 MB at a time: the log is over twice its limit at every look.
    const write = () => {
      db.exec("BEGIN");
      for (let i = 0; i < 9; i++) insert.run(megabyte);
      db.exec("COMMIT");
    };
    // The server keeps writing: the log is copied, never cut back under its writes.
    for (let i = 0; i < 2; i++) {
      write();
      expect(statSync(`${file}-wal`).size).toBeGreaterThan(8 * 1024 * 1024);
      await look();
    }
    expect(asked.mock.calls.map(([message]) => message)).not.toContain("truncate");
    expect(asked.mock.calls.map(([message]) => message)).toContain("checkpoint");
    // Nothing written since the last look: now it is cut back.
    await look();
    expect(asked.mock.calls.map(([message]) => message)).toContain("truncate");
    expect(statSync(`${file}-wal`).size).toBe(0);
    // Real copies on the disk: a Windows runner took more than 15 s for 40 MB of them.
  }, 60_000);
});
