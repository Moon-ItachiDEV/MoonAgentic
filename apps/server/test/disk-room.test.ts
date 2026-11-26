// What MoonAgentic keeps, on disk and in memory, on a server left on for weeks: copies made
// before each update of the schema, the room of what was removed, folder listings, the log
// of a thread put away, orphan folders' files, ignored files kept with a folder.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { Checkpoints, SHRINK_PAGES } from "../src/checkpoints.ts";
import { Listings, LISTINGS_KEPT, listFiles, listings } from "../src/files.ts";
import { MAX_KEPT_IGNORED_TOTAL, saveCheckpoint } from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { freePages, MIGRATIONS, migrate, Store } from "../src/store.ts";
import { TimelineLog } from "../src/timeline.ts";
import { dropOldOrphans, ORPHAN_KEEP_MS, orphanRef } from "../src/worktree-sweep.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-room-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true },
  ).trim();

function thread(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: "t",
    agentId: "demo",
    status: "idle" as const,
    permissionMode: "full" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** `threads` threads of 20 large tool results each, in the project. */
function fill(store: Store, projectId: string, threads: number, from = 0): void {
  const big = "y".repeat(100_000);
  for (let t = from; t < from + threads; t++) {
    store.addThread(thread(`t${t}`, projectId));
    store.transaction(() => {
      for (let i = 0; i < 20; i++)
        store.putItem(`t${t}`, {
          id: `tool:${i}`,
          kind: "tool",
          title: "lecture",
          toolKind: "read",
          status: "completed",
          content: [{ type: "text", text: `${t}:${i}:${big}` }],
          at: 1,
        });
    });
  }
}

describe("copies faites avant une mise à jour du schéma", () => {
  it("seule la dernière reste à côté de la base", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(file);
    migrate(db, ":memory:", MIGRATIONS.slice(0, 3));
    db.prepare(
      "INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'p', '/p', 1)",
    ).run();
    let now = 1_790_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    for (const upTo of [4, 5, 6]) migrate(db, file, MIGRATIONS.slice(0, upTo));
    db.close();
    // Another database's copy, and a file named alike, are not this one's.
    writeFileSync(path.join(dir, "autre.sqlite.v3-1.bak"), "x");
    writeFileSync(path.join(dir, "state.sqlite.v5-notes.bak"), "x");
    new Store(file).close();
    const copies = readdirSync(dir)
      .filter((n) => n.endsWith(".bak"))
      .sort();
    expect(copies).toEqual([
      "autre.sqlite.v3-1.bak",
      "state.sqlite.v5-notes.bak",
      expect.stringMatching(/^state\.sqlite\.v6-\d+\.bak$/),
    ]);
  });
});

describe("la place de ce qui est retiré", () => {
  it("retirer un gros projet rend sa place au disque, et à la copie du jour", async () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    cleanups.unshift(() => store.close());
    store.addProject({ id: "gros", name: "gros", path: dir, createdAt: 1 });
    store.addProject({ id: "petit", name: "petit", path: dir, createdAt: 2 });
    fill(store, "gros", 40);
    fill(store, "petit", 5, 40);
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(file).size;
    store.deleteProject("gros");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(freePages(store.db)).toBe(0);
    expect(statSync(file).size).toBeLessThan(before / 3);
    const copy = path.join(dir, "copie.sqlite");
    await store.backup(copy);
    expect(statSync(copy).size).toBeLessThan(before / 3);
    expect(store.listThreads().map((t) => t.id)).toHaveLength(5);
  });

  it("supprimer un fil rend sa place aussi", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    cleanups.unshift(() => store.close());
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    fill(store, "p", 3);
    const pages = () =>
      (store.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const before = pages();
    store.deleteThread("t0");
    expect(freePages(store.db)).toBe(0);
    expect(pages()).toBeLessThan(before * 0.8);
  });

  it("une base d'avant est compactée une fois à l'ouverture, ses données intactes", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    // As an earlier MoonAgentic made it and wrote to it: the room of a removal stayed.
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA journal_mode = WAL");
    migrate(legacy, ":memory:");
    expect(legacy.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    legacy.exec(
      `INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'p', '/p', 1);
       INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, created_at, updated_at)
         VALUES ('a', 'p', 'a', 'demo', 'idle', 'full', 1, 1), ('b', 'p', 'b', 'demo', 'idle', 'full', 1, 1);`,
    );
    const item = legacy.prepare("INSERT INTO items (thread_id, id, seq, data) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 200; i++)
      item.run(
        i % 2 ? "a" : "b",
        `agent:${i}`,
        i + 1,
        JSON.stringify({ id: `agent:${i}`, kind: "agent", text: "z".repeat(20_000), at: 1 }),
      );
    legacy.exec("DELETE FROM threads WHERE id = 'b'; PRAGMA wal_checkpoint(TRUNCATE)");
    expect(freePages(legacy)).toBeGreaterThan(400);
    legacy.close();
    const store = new Store(file);
    cleanups.unshift(() => store.close());
    expect(store.db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(freePages(store.db)).toBe(0);
    expect(store.listItems("a")).toHaveLength(100);
  });

  it("une base toute neuve rend sa place sans compactage", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    cleanups.unshift(() => store.close());
    expect(store.db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  });

  it("la place laissée par d'autres retraits revient au disque par petits bouts", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    cleanups.unshift(() => store.close());
    // Its looks are made here, one at a time.
    const checkpoints = (store as unknown as { checkpoints: Checkpoints }).checkpoints;
    clearInterval((checkpoints as unknown as { timer: NodeJS.Timeout }).timer);
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    fill(store, "p", 4);
    // A step back removes items without giving their room back at once.
    for (const t of ["t1", "t2", "t3"]) store.removeItemsFrom(t, "tool:0");
    const free = freePages(store.db);
    expect(free).toBeGreaterThan(SHRINK_PAGES);
    checkpoints.look();
    expect(freePages(store.db)).toBe(free - SHRINK_PAGES);
    for (let i = 0; i < 20 && freePages(store.db) >= SHRINK_PAGES; i++) checkpoints.look();
    expect(freePages(store.db)).toBeLessThan(SHRINK_PAGES);
  });
});

describe("listes de fichiers gardées par dossier", () => {
  it("quelques dossiers seulement, et quelques secondes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const kept = new Listings(10_000);
    let made = 0;
    const list = () => Promise.resolve([`f${made++}`]);
    for (let i = 0; i < 100; i++) await kept.get(`/d${i}`, 10_000, list);
    expect(kept.size).toBe(LISTINGS_KEPT);
    // The latest are those kept, and still served.
    expect(await kept.get("/d99", 10_000, list)).toEqual(["f99"]);
    expect(await kept.get("/d0", 10_000, list)).toEqual(["f100"]);
    vi.advanceTimersByTime(10_001);
    expect(kept.size).toBe(0);
  });

  it("une liste qui échoue n'est pas gardée", async () => {
    const kept = new Listings(10_000);
    await expect(kept.get("/d", 10_000, () => Promise.reject(new Error("non")))).rejects.toThrow();
    expect(kept.size).toBe(0);
  });

  it("lister des centaines de dossiers ne garde que les derniers", async () => {
    const root = tempDir();
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    for (let i = 0; i < LISTINGS_KEPT * 3; i++) {
      const link = path.join(root, `wt-${i}`);
      symlinkSync(repo, link, "junction");
      expect(await listFiles(link)).toEqual(["a.txt"]);
    }
    expect(listings.size).toBeLessThanOrEqual(LISTINGS_KEPT);
  });
});

describe("journal des changements d'un fil rangé", () => {
  it("un journal qui repart après un autre ne prend pas un ancien numéro pour à jour", () => {
    const old = new TimelineLog();
    old.touch("a");
    old.touch("b");
    const next = new TimelineLog(old.rev + 1);
    next.touch("c");
    next.touch("d");
    next.touch("e");
    // A screen that saw the old log's last change is sent the timeline again.
    expect(next.since(old.rev)).toBeUndefined();
    expect(next.since(next.rev - 1)).toEqual(["e"]);
  });

  it("est libéré au rangement, et un écran resté sur l'ancien reçoit tout le fil", async () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, "wt"),
      homeDir: dir,
      prWatchMs: 0,
    });
    cleanups.unshift(async () => {
      await hub.close();
      store.close();
    });
    const sent: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void sent.push(m) };
    hub.connect(client);
    const projectId = hub.createProject("demo", dir);
    const id = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Bonjour",
    });
    await hub.whenIdle(id);
    const logs = (hub as unknown as { logs: Map<string, TimelineLog> }).logs;
    const held = logs.get(id)!.rev;
    expect(held).toBeGreaterThan(0);
    await hub.setArchived(id, true);
    expect(logs.has(id)).toBe(false);
    await hub.setArchived(id, false);
    const epoch = (hub as unknown as { epoch: string }).epoch;
    sent.length = 0;
    await hub.handle(client, {
      type: "thread.open",
      threadId: id,
      since: { epoch, rev: held, first: 0 },
    });
    expect(sent.some((m) => m.type === "items" && m.threadId === id)).toBe(true);
    expect(sent.some((m) => m.type === "changes")).toBe(false);
  });
});

describe("fichiers des copies orphelines gardés dans le dépôt", () => {
  it("ceux gardés depuis plus de 30 jours sont oubliés, les autres restent", async () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "début");
    const now = 1_800_000_000_000;
    const old = orphanRef("fil-12", now - ORPHAN_KEEP_MS - 1);
    const recent = orphanRef("fil-13", now - ORPHAN_KEEP_MS + 60_000);
    for (const ref of [old, recent, "refs/moonagentic/t1/cp-1"])
      git(repo, "update-ref", ref, "HEAD");
    expect(await dropOldOrphans(repo, now)).toEqual([old]);
    const refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/moonagentic/").split("\n");
    expect(refs.sort()).toEqual(["refs/moonagentic/t1/cp-1", recent].sort());
  });
});

describe("fichiers ignorés gardés avec un dossier qui s'en va", () => {
  it(
    "pèsent ensemble au plus le plafond, les plus légers d'abord",
    { timeout: 60_000 },
    async () => {
      const repo = tempDir();
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(path.join(repo, ".gitignore"), ".env.local\n*.dump\n");
      writeFileSync(path.join(repo, ".env.local"), "CLE=secret\n");
      // Three heavy ignored files: all three would pass the cap together.
      const each = Math.floor(MAX_KEPT_IGNORED_TOTAL / 2.5);
      for (const name of ["a.dump", "b.dump", "c.dump"]) {
        const fd = openSync(path.join(repo, name), "w");
        ftruncateSync(fd, each);
        closeSync(fd);
      }
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "début");
      const tree = await saveCheckpoint(repo, "refs/moonagentic/t/archive", true);
      const kept = git(repo, "ls-tree", "--name-only", tree).split("\n");
      expect(kept).toEqual([".env.local", ".gitignore", "a.dump", "b.dump"]);
    },
  );
});
