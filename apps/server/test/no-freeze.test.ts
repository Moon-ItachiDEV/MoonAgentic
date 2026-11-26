// Audit of 2026-11-25, N5, N6, N16, N23: what the server does on a big database or a big
// file, while its one thread also answers every screen. Nothing may hold it for long.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage, Thread } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { reviewChanges } from "../src/git.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Longer than this, a screen waits on the server for something it can see. */
const STALL_MS = 200;

/** The longest time a 5 ms timer could not run while `work` went on. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ result: T; stall: number }> {
  let last = performance.now();
  let stall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 5);
  try {
    const result = await work();
    // Once more after the last step, or a stall at the very end goes unseen.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { result, stall: Math.round(stall) };
  } finally {
    clearInterval(timer);
  }
}

/**
 * The stall of `work` on a fresh `setup`, tried again up to twice when over the limit. A
 * server that holds itself does so on every try; one only kept waiting by the other test
 * files running on the same machine (216 ms once on a CI runner) does not.
 */
async function leastStall<S>(
  setup: () => S | Promise<S>,
  work: (state: S) => Promise<unknown>,
): Promise<S & { stall: number }> {
  let best: (S & { stall: number }) | undefined;
  for (let tries = 0; tries < 3 && !(best && best.stall < STALL_MS); tries++) {
    const state = await setup();
    const { stall } = await longestStall(() => work(state));
    if (!best || stall < best.stall) best = { ...state, stall };
  }
  return best!;
}

/** The slash commands an agent announces, kept on each of its threads. */
const COMMANDS = Array.from({ length: 25 }, (_, i) => ({
  name: `commande-${i}`,
  description: `Ce que fait la commande ${i} : une description d'une ligne comme en donnent les agents`,
}));

/** A database of `threads` threads of `items` messages each, the first `inP0` in project p0. */
function seeded(threads: number, inP0: number, items = 5) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-freeze-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  store.addProject({ id: "p0", name: "p0", path: dir, createdAt: 1 });
  store.addProject({ id: "p1", name: "p1", path: dir, createdAt: 2 });
  const now = Date.now();
  store.transaction(() => {
    for (let t = 0; t < threads; t++) {
      const thread: Thread = {
        id: `fil-${t}`,
        projectId: t < inP0 ? "p0" : "p1",
        title: `Fil numéro ${t} sur un sujet ou un autre`,
        agentId: "demo",
        status: "idle",
        permissionMode: "full",
        commands: COMMANDS,
        summary: "Le début de ce que l'agent a dit en dernier, pour les listes de fils.",
        createdAt: now - (threads - t) * 60_000,
        updatedAt: now - (threads - t) * 60_000,
      };
      store.addThread(thread);
      for (let i = 0; i < items; i++) {
        const item: Item =
          i % 10 === 0
            ? { id: `m${i}`, kind: "user", text: `Question ${i} du fil ${t}`, at: now + i }
            : { id: `m${i}`, kind: "agent", text: `réponse ${i} `.repeat(60), at: now + i };
        store.putItem(thread.id, item);
      }
    }
  });
  store.indexSearch();
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, "worktrees"),
    homeDir: dir,
    prWatchMs: 0,
  });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    // Windows may hold a file just closed a moment longer.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { hub, store };
}

class Screen implements Client {
  readonly messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
}

describe("removing a project or a long thread (N5)", { timeout: 120_000 }, () => {
  it("removes 100 threads among 2 000 without holding the server", async () => {
    const { store, stall } = await leastStall(
      async () => {
        const made = seeded(2000, 100);
        await made.hub.recovered;
        return made;
      },
      ({ hub }) => hub.removeProject("p0"),
    );
    expect(stall).toBeLessThan(STALL_MS);
    expect(store.getProject("p0")).toBeUndefined();
    expect(store.listThreads().filter((t) => t.projectId === "p0")).toEqual([]);
    expect(store.listThreads()).toHaveLength(1900);
  });

  it("deletes a thread of 20 000 messages without holding the server", async () => {
    const { store, stall } = await leastStall(
      async () => {
        const made = seeded(2, 0, 20_000);
        await made.hub.recovered;
        return made;
      },
      ({ hub }) => hub.deleteThread("fil-0"),
    );
    expect(stall).toBeLessThan(STALL_MS);
    expect(store.getThread("fil-0")).toBeUndefined();
    expect(store.listItems("fil-0")).toEqual([]);
    // Its messages are no longer found; the other thread's still are.
    expect(store.searchItems("du fil 0", 30)).toEqual([]);
    expect(store.searchItems("du fil 1", 30).length).toBeGreaterThan(0);
  });
});

describe("searching a big database (N23)", { timeout: 120_000 }, () => {
  it("answers two letters with nothing, without reading every message", async () => {
    const { hub } = seeded(300, 0, 50);
    const screen = new Screen();
    const { stall } = await longestStall(() =>
      hub.handle(screen, { type: "search", requestId: "r", query: "ré" }),
    );
    expect(screen.messages.at(-1)).toMatchObject({ type: "searched", hits: [] });
    expect(stall).toBeLessThan(50);
  });

  it("finds what was just said while the index is still being filled, without waiting for it", async () => {
    const { hub, store } = seeded(300, 0, 60);
    // As the first time after the update that brought the index: nothing in it yet.
    store.db.exec("DELETE FROM search_fts; UPDATE search_docs SET stale = 1");
    store.putItem("fil-299", {
      id: "dernier",
      kind: "user",
      text: "Un mot rarissime : zygomatique",
      at: Date.now(),
    });
    const screen = new Screen();
    const { stall } = await longestStall(() =>
      hub.handle(screen, { type: "search", requestId: "r", query: "zygomatique" }),
    );
    expect(stall).toBeLessThan(STALL_MS);
    const reply = screen.messages.at(-1);
    expect(reply).toMatchObject({ type: "searched" });
    expect(reply?.type === "searched" && reply.hits.map((h) => h.itemId)).toEqual(["dernier"]);
  });

  it("uses the trigram index even for GLOB metacharacters like ???", async () => {
    const { hub } = seeded(300, 0, 50);
    const screen = new Screen();
    const { stall } = await longestStall(() =>
      hub.handle(screen, { type: "search", requestId: "r", query: "???" }),
    );
    expect(screen.messages.at(-1)).toMatchObject({ type: "searched", hits: [] });
    expect(stall).toBeLessThan(50);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

/** A worktree whose tracked `data.csv` became `mb` megabytes of 80-character lines. */
function worktreeWithBigFile(mb: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-bigfile-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "data.csv"), "entete\n");
  writeFileSync(path.join(repo, "petit.txt"), "un\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const base = git(repo, "rev-parse", "HEAD");
  const dir = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "moon/x", dir);
  const chunk = Buffer.from(`${"x".repeat(70)},12345678\n`.repeat(13_107)); // ~1 MB
  const fd = openSync(path.join(dir, "data.csv"), "w");
  for (let i = 0; i < mb; i++) writeSync(fd, chunk);
  closeSync(fd);
  writeFileSync(path.join(dir, "petit.txt"), "deux\n");
  return { dir, base };
}

describe("reviewing a very big text file (N6)", { timeout: 120_000 }, () => {
  it("shows the start of a 50 MB file, marked cut, without holding the server", async () => {
    const { dir, base } = worktreeWithBigFile(50);
    const { result, stall } = await longestStall(() => reviewChanges(dir, base));
    expect(stall).toBeLessThan(STALL_MS);
    const [big, small] = result.files;
    expect(big).toMatchObject({ path: "data.csv", truncated: true, added: 655_350, removed: 1 });
    expect(big!.patch.split("\n").length).toBeLessThanOrEqual(2000);
    expect(big!.patch).toMatch(/^@@ /);
    // The file after it is whole.
    expect(small).toMatchObject({ path: "petit.txt", patch: "@@ -1 +1 @@\n-un\n+deux" });
  });

  it("shows a 300 MB file cut, instead of failing on git's output", async () => {
    const { dir, base } = worktreeWithBigFile(300);
    const result = await reviewChanges(dir, base);
    expect(result.files.map((f) => [f.path, !!f.truncated])).toEqual([
      ["data.csv", true],
      ["petit.txt", false],
    ]);
  });

  it("marks single-line minified files as truncated and bounds wide multi-line patches in bytes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-widefile-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "bundle.min.js"), "a\n");
    writeFileSync(path.join(repo, "wide.jsonl"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const base = git(repo, "rev-parse", "HEAD");
    // Place an astral emoji across the 100 000 code-unit clip boundary (+prefix is 1 char).
    writeFileSync(path.join(repo, "bundle.min.js"), `${"a".repeat(99_998)}🚀${"b".repeat(50_000)}`);
    // 40 lines of 80 KB (~3.2 MB) followed by a short trailing line: must stop cleanly at 2 MiB.
    const wideLines = Array.from(
      { length: 40 },
      (_, i) => `{"i":${i},"v":"${"z".repeat(80_000)}"}`,
    );
    wideLines.push('{"tail":"must-not-jump-gap"}');
    writeFileSync(path.join(repo, "wide.jsonl"), `${wideLines.join("\n")}\n`);

    const result = await reviewChanges(repo, base);
    const minified = result.files.find((f) => f.path === "bundle.min.js")!;
    expect(minified.truncated).toBe(true);
    const addedLine = minified.patch.split("\n").find((l) => l.startsWith("+"))!;
    expect(addedLine.length).toBeLessThanOrEqual(100_000);
    // Must not end with an unpaired UTF-16 high surrogate.
    const lastCode = addedLine.charCodeAt(addedLine.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);

    const wide = result.files.find((f) => f.path === "wide.jsonl")!;
    expect(wide.truncated).toBe(true);
    expect(wide.patch.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(wide.patch).not.toContain("must-not-jump-gap");
  });
});
