import { readdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function folder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const version = (db: DatabaseSync) =>
  (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;

describe("database schema versions", () => {
  it("starts a new database at the latest version, without a backup", () => {
    const dir = folder();
    const store = new Store(path.join(dir, "state.sqlite"));
    expect(version(store.db)).toBe(MIGRATIONS.length);
    store.close();
    expect(readdirSync(dir).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  it("brings a database from before versions up to date, after a backup", () => {
    const dir = folder();
    const file = path.join(dir, "state.sqlite");
    // The first schema of all, without the later thread columns.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        agent_id TEXT NOT NULL, status TEXT NOT NULL, permission_mode TEXT NOT NULL,
        error TEXT, acp_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p1', 'ancien', '/tmp/ancien', 1);
    `);
    old.close();

    const store = new Store(file);
    expect(version(store.db)).toBe(MIGRATIONS.length);
    expect(store.listProjects().map((p) => p.name)).toEqual(["ancien"]);
    const columns = store.db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["model", "extra"]));
    store.close();

    const backups = readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    // It holds what the database holds, secrets included: its owner alone reads it.
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
    }
    const backup = new DatabaseSync(path.join(dir, backups[0]!));
    expect(version(backup)).toBe(0);
    expect(backup.prepare(`SELECT name FROM projects`).all()).toEqual([{ name: "ancien" }]);
    backup.close();
  });

  it("runs each step once, and undoes a step that fails", () => {
    const db = new DatabaseSync(":memory:");
    const ran: number[] = [];
    const steps = [
      () => ran.push(1),
      (d: DatabaseSync) => {
        ran.push(2);
        d.exec(`CREATE TABLE half (id TEXT)`);
        throw new Error("étape cassée");
      },
    ];
    expect(() => migrate(db, ":memory:", steps)).toThrow("étape cassée");
    expect(version(db)).toBe(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined();
    migrate(db, ":memory:", steps.slice(0, 1));
    expect(ran).toEqual([1, 2]);
  });

  it("refuses a database from a newer MoonAgentic", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db, ":memory:")).toThrow("version plus récente");
  });
});

describe("activity per day", () => {
  it("counts the user's and the agents' messages by the client's day, team briefs left out", () => {
    const store = new Store(path.join(folder(), "state.sqlite"));
    store.addProject({ id: "p", name: "p", path: "/tmp/p", createdAt: 1 });
    store.addThread({
      id: "t",
      projectId: "p",
      title: "t",
      agentId: "demo",
      status: "idle",
      permissionMode: "supervised",
      createdAt: Date.UTC(2026, 10, 21, 8),
      updatedAt: 0,
    });
    const at = (d: number, h: number) => Date.UTC(2026, 10, d, h);
    store.putItem("t", { id: "1", kind: "user", text: "a", at: at(21, 9) });
    store.putItem("t", { id: "2", kind: "agent", text: "b", at: at(21, 10) });
    store.putItem("t", { id: "3", kind: "user", text: "brief", byTeam: true, at: at(21, 11) });
    store.putItem("t", { id: "4", kind: "thought", text: "c", at: at(21, 12) });
    // 23:30 UTC on the 22nd is already the 23rd in Paris (UTC+1, offset -60 min).
    store.putItem("t", { id: "5", kind: "agent", text: "d", at: Date.UTC(2026, 10, 22, 23, 30) });
    const day = (d: number) => Math.floor(Date.UTC(2026, 10, d) / 86_400_000);
    expect(store.activityDays(0, 0)).toEqual([
      { day: day(21), count: 2 },
      { day: day(22), count: 1 },
    ]);
    expect(store.activityDays(0, -60 * 60_000)).toEqual([
      { day: day(21), count: 2 },
      { day: day(23), count: 1 },
    ]);
    expect(store.activityDays(at(22, 0), 0)).toEqual([{ day: day(22), count: 1 }]);
    expect(store.firstThreadAt()).toBe(Date.UTC(2026, 10, 21, 8));
    store.close();
  });
});
