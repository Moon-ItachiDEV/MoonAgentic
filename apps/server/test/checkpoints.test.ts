// The write-ahead log is copied into the database away from the server's thread: SQLite
// waits for the disk there, two seconds on a Windows disk in the middle of a removal.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-wal-"));
  dirs.push(dir);
  const file = path.join(dir, "state.sqlite");
  return { store: new Store(file), file };
}

/** Writes about `mb` megabytes in one go. */
function write(store: Store, mb: number) {
  store.addProject({ id: "p", name: "p", path: "/tmp", createdAt: 1 });
  store.addThread({
    id: "t",
    projectId: "p",
    title: "t",
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    createdAt: 1,
    updatedAt: 1,
  });
  store.transaction(() => {
    for (let i = 0; i < mb * 1000; i++)
      store.putItem("t", { id: `m${i}`, kind: "agent", text: `x${i} `.repeat(200), at: i });
  });
}

describe("copying the write-ahead log", () => {
  it("never makes a write wait for the copy, and copies it soon after on its own thread", async () => {
    const { store: s, file } = store();
    write(s, 6);
    // The write did not copy: the database file is as small as before it.
    expect(statSync(file).size).toBeLessThan(1024 * 1024);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(4 * 1024 * 1024);
    const until = Date.now() + 10_000;
    while (statSync(file).size < 4 * 1024 * 1024 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(s.listItems("t")).toHaveLength(6000);
    s.close();
  });

  it("closes its own connection before the store says it is closed", async () => {
    const { store: s, file } = store();
    write(s, 6);
    const until = Date.now() + 10_000;
    while (statSync(file).size < 4 * 1024 * 1024 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    s.close();
    // The last connection gone, SQLite puts the log away: none was left open.
    expect(() => statSync(`${file}-wal`)).toThrow();
    const again = new Store(file);
    expect(again.listItems("t")).toHaveLength(6000);
    again.close();
  });

  it("shrinks an overgrown write-ahead log back down once copied", async () => {
    const { store: s, file } = store();
    write(s, 10);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(8 * 1024 * 1024);
    const until = Date.now() + 10_000;
    while (statSync(`${file}-wal`).size > 8 * 1024 * 1024 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statSync(`${file}-wal`).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(s.listItems("t")).toHaveLength(10_000);
    s.close();
  });
});
