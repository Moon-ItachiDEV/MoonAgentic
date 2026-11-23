import { readdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { Item } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  // The last opened first: a database is closed before its folder is removed (Windows).
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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

/** A store with one project and two threads, the second one the latest to move. */
function withThreads(file = ":memory:"): Store {
  const store = new Store(file);
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // Closed by the test itself.
    }
  });
  if (!store.getProject("p")) {
    store.addProject({ id: "p", name: "Projet", path: "/tmp/projet", createdAt: 1 });
    for (const [n, id] of ["t1", "t2"].entries()) {
      store.addThread({
        id,
        projectId: "p",
        title: id,
        agentId: "demo",
        status: "idle",
        permissionMode: "full",
        createdAt: n,
        updatedAt: n,
      });
    }
  }
  return store;
}

const user = (id: string, text: string, more: object = {}): Item => ({
  id,
  kind: "user",
  text,
  at: 1,
  ...more,
});
const agent = (id: string, text: string): Item => ({ id, kind: "agent", text, at: 1 });
const found = (store: Store, query: string, limit?: number) =>
  store.searchItems(query, limit).map((hit) => hit.itemId);
const stale = (store: Store) =>
  (store.db.prepare(`SELECT count(*) AS n FROM search_docs WHERE stale = 1`).get() as { n: number })
    .n;

describe("searching messages", () => {
  it("finds any part of a word, whatever the case or the accents, the latest first", () => {
    const store = withThreads();
    store.putItem("t1", user("u1", "Où est l'État du système ?"));
    store.putItem("t2", agent("a1", "L'etat du systeme est dans src/state.ts."));
    store.putItem("t1", agent("a2", "Rien à voir."));
    expect(found(store, "ETAT DU SYST")).toEqual(["a1", "u1"]);
    expect(found(store, "ystèm")).toEqual(["a1", "u1"]);
    expect(store.searchItems("état")[1]).toEqual({
      threadId: "t1",
      itemId: "u1",
      kind: "user",
      snippet: "Où est l'État du système ?",
    });
    // Two letters are found too, without the index.
    expect(found(store, "où")).toEqual(["u1"]);
    expect(found(store, "ts")).toEqual(["a1"]);
    expect(found(store, "introuvable")).toEqual([]);
    // No more than asked for, the latest written first.
    expect(found(store, "syst", 1)).toEqual(["a1"]);
  });

  it("takes every character as itself", () => {
    const store = withThreads();
    store.putItem("t1", user("u1", 'Fiable à 100% : tab[0] vaut a_b, x*y?z et « "oui" ».'));
    store.putItem("t1", user("u2", "Fiable à 1000 : tabX0] vaut aXb, xAAy.z"));
    for (const query of ["100%", "a_b", "tab[0]", "b[0", "x*y", "y?z", '"oui"', "[0]", "*y?"]) {
      expect(found(store, query), query).toEqual(["u1"]);
    }
    expect(found(store, "1_0")).toEqual([]);
    expect(found(store, "x*z")).toEqual([]);
  });

  it("leaves out what is not the user's or an agent's words", () => {
    const store = withThreads();
    store.putItem("t1", user("u1", "Consigne zorglub", { byTeam: true }));
    store.putItem("t1", { id: "th", kind: "thought", text: "Je pense à zorglub", at: 1 });
    store.putItem("t1", user("u2", "", { images: [] }));
    store.putItem("t1", agent("a1", "Réponse sur zorglub"));
    expect(found(store, "zorglub")).toEqual(["a1"]);
  });

  it("follows a message that is written again, and forgets one that is removed", () => {
    const store = withThreads();
    // An answer that grows is written many times: its latest text is the one found.
    store.putItem("t1", agent("a1", "Je regarde le fichier"));
    expect(found(store, "regarde")).toEqual(["a1"]);
    store.putItem("t1", agent("a1", "Je regarde le fichier, puis je corrige la fonction"));
    store.putItem("t1", agent("a1", "J'ai corrigé la fonction"));
    expect(stale(store)).toBe(1);
    expect(found(store, "corrige la fonction")).toEqual(["a1"]);
    expect(found(store, "regarde")).toEqual([]);
    expect(stale(store)).toBe(0);

    store.putItem("t1", user("u2", "Et la fonction suivante ?"));
    store.putItem("t1", agent("a2", "La fonction suivante est bonne."));
    store.putItem("t2", user("u3", "Autre fil, même fonction"));
    expect(found(store, "fonction")).toEqual(["u3", "a2", "u2", "a1"]);
    // A step back takes its messages out of the search, a deleted thread all of its own.
    store.removeItemsFrom("t1", "u2");
    expect(found(store, "fonction")).toEqual(["u3", "a1"]);
    store.deleteThread("t2");
    expect(found(store, "fonction")).toEqual(["a1"]);
    store.deleteProject("p");
    expect(found(store, "fonction")).toEqual([]);
    const left = (table: string) =>
      (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([left("search_docs"), left("search_fts")]).toEqual([0, 0]);
  });

  it("takes in the messages of a database from before the index, a stretch at a time", () => {
    const dir = folder();
    const file = path.join(dir, "state.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`PRAGMA foreign_keys = ON`);
    migrate(old, file, MIGRATIONS.slice(0, 3));
    old.exec(`
      INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'Projet', '/tmp/projet', 1);
      INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, created_at, updated_at)
        VALUES ('t1', 'p', 't1', 'demo', 'idle', 'full', 1, 1);
    `);
    const put = old.prepare(`INSERT INTO items (thread_id, id, seq, data) VALUES ('t1', ?, ?, ?)`);
    // Written out of order: the search goes by when each message was said. In one write:
    // one by one, each would wait for the disk, which is slow on Windows.
    old.exec("BEGIN");
    for (const n of [250, ...Array.from({ length: 249 }, (_, i) => i + 1)]) {
      const item: Item = { id: `m${n}`, kind: "user", text: `Ancien message numéro ${n}`, at: n };
      put.run(item.id, n, JSON.stringify(item));
    }
    old.exec("COMMIT");
    old.close();

    const store = withThreads(file);
    expect(version(store.db)).toBe(MIGRATIONS.length);
    expect(stale(store)).toBe(250);
    // With no time to spare it still moves forward, and says there is more.
    expect(store.indexSearch(0)).toBe(true);
    expect(stale(store)).toBe(150);
    // A search does not wait for the rest: it takes in what is missing, then answers.
    expect(found(store, "ancien message", 3)).toEqual(["m250", "m249", "m248"]);
    expect(stale(store)).toBe(0);
    expect(store.indexSearch(0)).toBe(false);
    expect(found(store, "numero 17")).toEqual([
      "m179",
      "m178",
      "m177",
      "m176",
      "m175",
      "m174",
      "m173",
      "m172",
      "m171",
      "m170",
      "m17",
    ]);
  });
});
