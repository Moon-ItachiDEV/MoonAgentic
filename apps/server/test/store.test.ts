import { readdirSync, mkdtempSync, rmSync } from "node:fs";
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
