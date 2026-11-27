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
import { Worker } from "node:worker_threads";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { Checkpoints, SHRINK_PAGES } from "../src/checkpoints.ts";
import { Listings, LISTINGS_KEPT, listFiles, listings } from "../src/files.ts";
import { MAX_KEPT_IGNORED_TOTAL, saveCheckpoint } from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { freePages, MIGRATIONS, migrate, Store } from "../src/store.ts";
import { TimelineLog } from "../src/timeline.ts";
import * as sweep from "../src/worktree-sweep.ts";
import { dropOldOrphans, ORPHAN_KEEP_MS, orphanRef } from "../src/worktree-sweep.ts";

// The hub's calls are seen, the real work still done.
vi.mock("../src/worktree-sweep.ts", async (original) => {
  const real = await original<typeof import("../src/worktree-sweep.ts")>();
  return { ...real, dropOldOrphans: vi.fn(real.dropOldOrphans) };
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

/** A hub on a database of its own, in `dir`. */
function hubIn(dir: string) {
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
  return { store, hub, sent, client };
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

describe("copies laissées par une version d'avant", () => {
  it("s'en vont à l'ouverture d'une base déjà à jour, la dernière gardée", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    new Store(file).close();
    for (const name of ["v3-1000", "v5-3000", "v4-2000"])
      writeFileSync(path.join(dir, `state.sqlite.${name}.bak`), "x");
    new Store(file).close();
    expect(readdirSync(dir).filter((n) => n.endsWith(".bak"))).toEqual([
      "state.sqlite.v5-3000.bak",
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
    // Tens of megabytes written, deleted and copied: a Windows runner busy with the other test
    // files once took more than 15 s for it.
  }, 60_000);

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

describe("la place rendue et la copie du journal", () => {
  it("ne se font pas en même temps, et rendre des pages n'est pas un temps calme", async () => {
    const dir = tempDir();
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    cleanups.unshift(() => store.close());
    const checkpoints = (store as unknown as { checkpoints: Checkpoints }).checkpoints;
    const inside = checkpoints as unknown as { timer: NodeJS.Timeout; busy: boolean };
    clearInterval(inside.timer);
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    fill(store, "p", 6);
    for (const t of ["t1", "t2", "t3", "t4", "t5"]) store.removeItemsFrom(t, "tool:0");
    expect(freePages(store.db)).toBeGreaterThan(SHRINK_PAGES * 2);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(8 * 1024 * 1024);
    // While the thread copies the log, nothing else writes to it.
    inside.busy = true;
    const free = freePages(store.db);
    checkpoints.look();
    expect(freePages(store.db)).toBe(free);
    inside.busy = false;
    const asked = vi.spyOn(Worker.prototype, "postMessage");
    const look = async () => {
      checkpoints.look();
      while (inside.busy) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    // No row written between two looks, but pages given back: the log is not cut back.
    await look();
    await look();
    expect(freePages(store.db)).toBeLessThan(free - SHRINK_PAGES);
    expect(asked.mock.calls.map(([message]) => message)).not.toContain("truncate");
  }, 60_000);

  it("supprimer un fil rend sa place par bouts bornés", async () => {
    const dir = tempDir();
    const { store, hub } = hubIn(dir);
    const projectId = hub.createProject("demo", dir);
    const id = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Bonjour",
    });
    await hub.whenIdle(id);
    // Fewer items than a batch of deletion, but tens of megabytes.
    const big = "y".repeat(400_000);
    store.transaction(() => {
      for (let i = 0; i < 100; i++)
        store.putItem(id, {
          id: `tool:big${i}`,
          kind: "tool",
          title: "lecture",
          toolKind: "read",
          status: "completed",
          content: [{ type: "text", text: `${i}:${big}` }],
          at: 1,
        });
    });
    const real = store.shrink.bind(store);
    const calls: { pages?: number; free: number }[] = [];
    vi.spyOn(store, "shrink").mockImplementation((pages?: number) => {
      calls.push({ pages, free: freePages(store.db) });
      return real(pages);
    });
    await hub.deleteThread(id);
    expect(calls.length).toBeGreaterThan(5);
    // Each stretch at most SHRINK_PAGES; the last, unbounded, finds nearly nothing left.
    for (const call of calls)
      expect(call.pages ?? (call.free < SHRINK_PAGES ? 0 : Infinity)).toBeLessThanOrEqual(
        SHRINK_PAGES,
      );
    expect(freePages(store.db)).toBe(0);
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
    // Read while put away: no log is made for it.
    await hub.handle(client, { type: "thread.open", threadId: id });
    expect(sent.some((m) => m.type === "items" && m.threadId === id)).toBe(true);
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

describe("le ménage des copies orphelines", () => {
  it("ne lance git que pour les projets qui sont des dépôts", async () => {
    const dir = tempDir();
    const repo = path.join(dir, "repo");
    const plain = path.join(dir, "notes");
    mkdirSync(repo);
    mkdirSync(plain);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "début");
    const { hub } = hubIn(dir);
    hub.createProject("repo", repo);
    hub.createProject("notes", plain);
    const calls = vi.mocked(sweep.dropOldOrphans);
    calls.mockClear();
    await (hub as unknown as { dropOldOrphans(): Promise<void> }).dropOldOrphans();
    // The daily sweep, started with the hub, may ask too: for the repository only.
    const asked = calls.mock.calls.map(([where]) => where);
    expect(asked).toContain(repo);
    expect(asked).not.toContain(plain);
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
