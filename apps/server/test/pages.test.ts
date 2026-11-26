// A long thread comes to a screen by its end, a page at a time, and a screen that was away
// gets what changed only.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub } from "../src/hub.ts";
import { PAGE_ITEMS, Store } from "../src/store.ts";
import { TimelineLog, TOOL_INLINE_CHARS } from "../src/timeline.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

class TestClient implements Client {
  openThreadIds?: Set<string>;
  readonly messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  /** The last message of that type. */
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> {
    const found = this.messages.findLast((m) => m.type === type);
    if (!found) throw new Error(`no ${type} message`);
    return found as Extract<ServerMessage, { type: T }>;
  }
}

const said = (n: number, kind: "user" | "agent" = "agent"): Item => ({
  id: `m${n}`,
  kind,
  text: `Message ${n}`,
  at: n,
});

/**
 * A store with one thread of `count` messages, numbered from 1: the user speaks every
 * `turn` messages, and the agent the rest of the time.
 */
function longThread(count: number, turn = 10) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pages-"));
  mkdirSync(path.join(dir, ".home"));
  const store = new Store(path.join(dir, "state.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.addProject({ id: "p", name: "Projet", path: dir, createdAt: 1 });
  store.addThread({
    id: "t",
    projectId: "p",
    title: "Long fil",
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    createdAt: 1,
    updatedAt: 1,
  });
  // In one write: one by one, each would wait for the disk, which is slow on Windows.
  store.db.exec("BEGIN");
  for (let n = 1; n <= count; n++) store.putItem("t", said(n, n % turn === 1 ? "user" : "agent"));
  store.db.exec("COMMIT");
  return { dir, store };
}

const ids = (items: Item[]) => items.map((i) => i.id);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);

describe("a timeline read by pages", () => {
  it("numbers items as they come, and keeps an item's number when it changes", () => {
    const { store } = longThread(3);
    expect(store.putItem("t", said(4))).toBe(4);
    const changed: Item = { id: "m2", kind: "agent", text: "Changé", at: 2 };
    expect(store.putItem("t", changed)).toBe(2);
    expect(store.getItemAt("t", "m2")).toEqual({ item: changed, seq: 2 });
    expect(store.getItemAt("t", "absent")).toBeUndefined();
  });

  it("gives a short timeline whole", () => {
    const { store } = longThread(PAGE_ITEMS);
    const page = store.pageItems("t");
    expect(ids(page.items)).toEqual(range(1, PAGE_ITEMS));
    expect(page).toMatchObject({ first: 1, earlier: 0 });
    // Nothing yet: the first item to come will be the timeline's first.
    expect(longThread(0).store.pageItems("t")).toEqual({ items: [], first: 0, earlier: 0 });
  });

  it("gives the end of a long one, from where a turn starts, then the pages before it", () => {
    const { store } = longThread(500);
    // A page back from the end is item 381: its turn starts at 381, with the user's message.
    const end = store.pageItems("t");
    expect(ids(end.items)).toEqual(range(381, 500));
    expect(end).toMatchObject({ first: 381, earlier: 380 });
    expect(end.items[0]?.kind).toBe("user");

    const before = store.pageItems("t", end.first);
    expect(ids(before.items)).toEqual(range(261, 380));
    expect(before).toMatchObject({ first: 261, earlier: 260 });
    // The last page is what is left, and says so.
    const start = store.pageItems("t", 101);
    expect(ids(start.items)).toEqual(range(1, 100));
    expect(start).toMatchObject({ first: 1, earlier: 0 });
    expect(store.pageItems("t", 1)).toEqual({ items: [], first: 1, earlier: 0 });
  });

  it("starts a page a little further back to start with its turn, or cuts a very long turn", () => {
    // Turns of 50: a page of 120 back from 500 would start at 381, inside the turn of 351.
    const turns = longThread(500, 50).store.pageItems("t");
    expect(turns).toMatchObject({ first: 351, earlier: 350 });
    // One turn of a thousand items: no start of a turn near, the page is cut where it is.
    const one = longThread(1000, 5000).store.pageItems("t");
    expect(one).toMatchObject({ first: 881, earlier: 880 });
    expect(one.items).toHaveLength(PAGE_ITEMS);
  });

  it("goes back as far as an item asked for, with a little of what came before it", () => {
    const { store } = longThread(500);
    // Item 207 is in the turn of 201; ten items before it is 197, in the turn of 191.
    const page = store.pageItems("t", 381, "m207");
    expect(ids(page.items)).toEqual(range(191, 380));
    expect(page).toMatchObject({ first: 191, earlier: 190 });
    // One already in an ordinary page, or that is no longer there, changes nothing.
    expect(store.pageItems("t", 381, "m300").first).toBe(261);
    expect(store.pageItems("t", 381, "absent").first).toBe(261);
  });
});

describe("what changed in a timeline", () => {
  it("names the items changed since a change, each once, and nothing from too far back", () => {
    const log = new TimelineLog();
    expect(log.since(0)).toEqual([]);
    expect(log.touch("a")).toBe(1);
    expect(log.touch("b")).toBe(2);
    expect(log.touch("a")).toBe(3);
    expect(log.since(0)).toEqual(["b", "a"]);
    expect(log.since(2)).toEqual(["a"]);
    expect(log.since(3)).toEqual([]);
    // A change the server never made: the screen's mark is not from this timeline.
    expect(log.since(4)).toBeUndefined();

    // Items removed: a screen from before is told nothing item by item.
    expect(log.reset()).toBe(4);
    expect(log.since(3)).toBeUndefined();
    expect(log.since(4)).toEqual([]);
    log.touch("c");
    expect(log.since(4)).toEqual(["c"]);
  });

  it("forgets the oldest changes of a timeline that changed a lot", () => {
    const log = new TimelineLog();
    for (let n = 1; n <= 301; n++) log.touch(`i${n}`);
    // The change to i1 is forgotten: only a screen that saw it can be brought up to date.
    expect(log.since(0)).toBeUndefined();
    expect(log.since(1)).toHaveLength(300);
    // The same item changed again and again takes one place.
    for (let n = 0; n < 1000; n++) log.touch("i301");
    expect(log.since(1)).toHaveLength(300);
  });
});

describe("a long thread on a screen", () => {
  function setup(count: number) {
    const { dir, store } = longThread(count);
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
    });
    cleanups.push(() => hub.close());
    const client = new TestClient();
    hub.connect(client);
    return { store, hub, client };
  }

  it("opens on the end of the thread, and hands out the pages before it and the whole", async () => {
    const { store, hub, client } = setup(500);
    // An old tool's large result stays on the server in a page too.
    store.putItem("t", {
      id: "m300",
      kind: "tool",
      title: "Lire",
      toolKind: "read",
      status: "completed",
      content: [{ type: "text", text: "x".repeat(TOOL_INLINE_CHARS + 1) }],
      at: 300,
    });
    await hub.handle(client, { type: "thread.open", threadId: "t" });
    const opened = client.last("items");
    expect(ids(opened.items)).toEqual(range(381, 500));
    expect(opened).toMatchObject({ first: 381, earlier: 380, rev: 0 });

    await hub.handle(client, { type: "thread.page", requestId: "r1", threadId: "t", before: 381 });
    const page = client.last("page");
    expect(page).toMatchObject({ requestId: "r1", before: 381, first: 261, earlier: 260 });
    expect(ids(page.items)).toEqual(range(261, 380));
    expect(page.items[39]).toMatchObject({ id: "m300", content: [], omitted: 2001 });

    await hub.handle(client, {
      type: "thread.page",
      requestId: "r2",
      threadId: "t",
      before: 261,
      reach: "m42",
    });
    expect(client.last("page")).toMatchObject({ requestId: "r2", first: 31, earlier: 30 });

    // An export reads it by bigger pages, which the screen does not show.
    await hub.handle(client, {
      type: "thread.page",
      requestId: "r3",
      threadId: "t",
      before: 501,
      size: 1000,
      apart: true,
    });
    const whole = client.last("page");
    expect(whole).toMatchObject({ requestId: "r3", first: 1, earlier: 0, apart: true });
    expect(ids(whole.items)).toEqual(range(1, 500));
    expect(whole.items[299]).toMatchObject({ omitted: 2001 });
    await expect(
      hub.handle(client, { type: "thread.page", requestId: "r4", threadId: "x", before: 1 }),
    ).rejects.toThrow("Fil introuvable");
  });

  it("numbers what comes live, and sends a screen that was away what changed only", async () => {
    const { store, hub, client } = setup(500);
    await hub.handle(client, { type: "thread.open", threadId: "t" });
    const { epoch, first } = client.last("items");
    // The screen goes away with what it holds, at change 0.
    await hub.handle(client, { type: "thread.leave", threadId: "t" });

    hub.send("t", "Encore une question");
    await hub.whenIdle("t");
    const stored = store.listItems("t");
    expect(stored.length).toBeGreaterThan(502);

    // Back, it says where it was: it gets the turn's items, each once and whole, in order.
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch, rev: 0, first },
    });
    const changes = client.last("changes");
    expect(changes.items.map((c) => c.item.id)).toEqual(ids(stored.slice(500)));
    expect(changes.items.map((c) => c.seq)).toEqual(stored.slice(500).map((_, n) => 501 + n));
    expect(changes.items.at(-1)?.item).toEqual(stored.at(-1));
    expect(changes.rev).toBeGreaterThan(stored.length - 500);
    expect(client.messages.filter((m) => m.type === "items")).toHaveLength(1);

    // Now watching: each new item comes with its number and the change's.
    hub.send("t", "Et une autre");
    await hub.whenIdle("t");
    const live = client.messages.filter((m) => m.type === "item" || m.type === "append");
    expect(live.length).toBeGreaterThan(2);
    expect(live[0]).toMatchObject({ type: "item", seq: stored.length + 1, rev: changes.rev + 1 });
    expect(live.map((m) => m.rev)).toEqual(live.map((_, n) => changes.rev + 1 + n));
    const now = live.at(-1)!.rev;

    // Nothing missed: nothing to send.
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch, rev: now, first },
    });
    expect(client.last("changes")).toMatchObject({ items: [], rev: now });

    // An item from before what a screen holds is not sent to it.
    await hub.switchAgent("t", "demo-2");
    const handoff = store.lastItem("t")!;
    expect(handoff.kind).toBe("handoff");
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch, rev: now, first: store.getItemAt("t", handoff.id)!.seq + 1 },
    });
    expect(client.last("changes").items).toEqual([]);

    // The hand-off taken back removes an item: every screen gets the end of the thread again,
    // and a mark from before that is answered the same way.
    const before = client.messages.filter((m) => m.type === "items").length;
    await hub.switchAgent("t", "demo");
    expect(client.messages.filter((m) => m.type === "items")).toHaveLength(before + 1);
    const cut = client.last("items");
    expect(cut.items.some((i) => i.kind === "handoff")).toBe(false);
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch, rev: now, first },
    });
    expect(client.messages.filter((m) => m.type === "items")).toHaveLength(before + 2);
    // A mark from another run of the server, too.
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch: "autre", rev: cut.rev, first },
    });
    expect(client.messages.filter((m) => m.type === "items")).toHaveLength(before + 3);
    await hub.handle(client, {
      type: "thread.open",
      threadId: "t",
      since: { epoch, rev: cut.rev, first: cut.first },
    });
    expect(client.last("changes")).toMatchObject({ items: [], rev: cut.rev });
  });

  it("rejects thread.page while the thread is being deleted in batches", async () => {
    const { hub, client } = setup(2500);
    const deleting = hub.deleteThread("t");
    // Delete runs synchronously up to the first `await nextTurn()` after batch 1.
    await expect(
      hub.handle(client, {
        type: "thread.page",
        requestId: "r-del",
        threadId: "t",
        before: 2501,
        size: 1000,
        apart: true,
      }),
    ).rejects.toThrow("en cours de suppression");
    await deleting;
  });
});
