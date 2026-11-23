import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub } from "../src/hub.ts";
import { type LockStorage, MAX_TRIES, ProjectLocks, TRIES_WINDOW_MS } from "../src/locks.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function memory(): LockStorage & { settings: Map<string, unknown> } {
  const settings = new Map<string, unknown>();
  return {
    settings,
    getSetting: <T>(key: string, fallback: T) =>
      settings.has(key) ? (settings.get(key) as T) : fallback,
    setSetting: (key, value) => void settings.set(key, value),
  };
}

describe("project locks", () => {
  it("needs a code of 6 digits, set before any project is locked", () => {
    const locks = new ProjectLocks(memory());
    expect(() => locks.lock("p1")).toThrow(/code/);
    expect(() => locks.setPin("12345")).toThrow(/6 chiffres/);
    expect(() => locks.setPin("12345a")).toThrow(/6 chiffres/);
    locks.setPin("123456");
    expect(locks.hasPin()).toBe(true);
    locks.lock("p1");
    expect(locks.isLocked("p1")).toBe(true);
    expect(locks.any()).toBe(true);
  });

  it("keeps a hash of the code, never the code itself", () => {
    const storage = memory();
    new ProjectLocks(storage).setPin("482913");
    expect(JSON.stringify([...storage.settings])).not.toContain("482913");
  });

  it("changes the code only with the current one", () => {
    const locks = new ProjectLocks(memory());
    locks.setPin("111111");
    expect(() => locks.setPin("222222")).toThrow(/actuel/);
    expect(() => locks.setPin("222222", "333333")).toThrow(/actuel/);
    locks.setPin("222222", "111111");
    locks.lock("p1");
    expect(() => locks.unlock("p1", "111111")).toThrow(/incorrect/);
    locks.unlock("p1", "222222");
    expect(locks.isLocked("p1")).toBe(false);
  });

  it("remembers what is locked when the server starts again", () => {
    const storage = memory();
    const first = new ProjectLocks(storage);
    first.setPin("123456");
    first.lock("p2");
    first.lock("p1");
    const again = new ProjectLocks(storage);
    expect(again.lockedProjects()).toEqual(["p1", "p2"]);
    again.forget("p1");
    expect(new ProjectLocks(storage).lockedProjects()).toEqual(["p2"]);
  });

  it("refuses every code for a while after too many wrong ones", () => {
    let now = 1_000_000;
    const locks = new ProjectLocks(memory(), () => now);
    locks.setPin("123456");
    locks.lock("p1");
    for (let i = 0; i < MAX_TRIES; i++) {
      expect(() => locks.unlock("p1", "000000")).toThrow(/incorrect/);
    }
    // The right code too, so that guessing gets nowhere.
    expect(() => locks.unlock("p1", "123456")).toThrow(/Réessaie dans 5 min/);
    now += TRIES_WINDOW_MS - 60_000;
    expect(() => locks.unlock("p1", "123456")).toThrow(/Réessaie dans 1 min/);
    now += 60_000;
    locks.unlock("p1", "123456");
    expect(locks.isLocked("p1")).toBe(false);
  });

  it("counts again from zero after the right code", () => {
    const locks = new ProjectLocks(memory());
    locks.setPin("123456");
    locks.lock("p1");
    for (let i = 0; i < MAX_TRIES - 1; i++) expect(() => locks.unlock("p1", "000000")).toThrow();
    locks.unlock("p1", "123456");
    locks.lock("p1");
    for (let i = 0; i < MAX_TRIES - 1; i++) expect(() => locks.unlock("p1", "000000")).toThrow();
    locks.unlock("p1", "123456");
  });
});

class TestClient implements Client {
  openThreadIds?: Set<string>;
  readonly messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> {
    const found = this.messages.findLast((m) => m.type === type);
    if (!found) throw new Error(`no ${type}`);
    return found as Extract<ServerMessage, { type: T }>;
  }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lock-"));
  mkdirSync(path.join(dir, ".home"));
  mkdirSync(path.join(dir, "secret"));
  mkdirSync(path.join(dir, "open"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, ".worktrees"),
    homeDir: path.join(dir, ".home"),
  });
  const client = new TestClient();
  hub.connect(client);
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const secret = hub.createProject("secret", path.join(dir, "secret"));
  const open = hub.createProject("open", path.join(dir, "open"));
  const thread = (projectId: string, text: string) =>
    hub.createThread({ projectId, agentId: "demo", permissionMode: "full", text });
  return { dir, store, hub, client, secret, open, thread };
}

describe("a locked project on the wire", () => {
  it("leaves its threads, cards and timelines out of everything sent", async () => {
    const { hub, client, secret, open, thread } = setup();
    const hidden = thread(secret, "plan secret");
    const shown = thread(open, "plan public");
    await hub.handle(client, {
      type: "plan.add",
      requestId: "c1",
      projectId: secret,
      title: "Carte secrète",
    });
    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    expect(client.last("snapshot").snapshot.lockPin).toBe(true);
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    expect(client.last("done")).toEqual({ type: "done", requestId: "r2" });

    const { snapshot } = client.last("snapshot");
    expect(snapshot.threads.map((t) => t.id)).toEqual([shown]);
    expect(snapshot.plan).toEqual([]);
    expect(snapshot.projects.find((p) => p.id === secret)).toMatchObject({ locked: true });
    expect(snapshot.projects.find((p) => p.id === open)?.locked).toBeUndefined();

    // News of the locked thread does not get out, even when its agent keeps working.
    const from = client.messages.length;
    await hub.whenIdle(shown);
    await hub.handle(client, { type: "thread.send", threadId: shown, text: "encore" });
    hub.createThread({ projectId: secret, agentId: "demo", permissionMode: "full", text: "x" });
    await new Promise((r) => setTimeout(r, 300));
    const leaked = client.messages
      .slice(from)
      .filter(
        (m) =>
          ("threadId" in m && m.threadId === hidden) ||
          (m.type === "thread" && m.thread.projectId === secret),
      );
    expect(leaked).toEqual([]);

    // Neither do the answers asked for it.
    const before = client.messages.length;
    await hub.handle(client, { type: "thread.open", threadId: hidden });
    expect(client.messages.slice(before)).toEqual([]);
    await expect(
      hub.handle(client, { type: "thread.page", requestId: "p1", threadId: hidden, before: 1 }),
    ).rejects.toThrow(/verrouillé/);
    await expect(
      hub.handle(client, { type: "plan.add", requestId: "c2", projectId: secret, title: "Non" }),
    ).rejects.toThrow(/verrouillé/);
  });

  it("filters search hits", async () => {
    const { hub, client, secret, thread } = setup();
    const hidden = thread(secret, "mot introuvable ailleurs");
    await new Promise((r) => setTimeout(r, 300));
    await hub.handle(client, { type: "search", requestId: "s1", query: "introuvable" });
    expect(client.last("searched").hits.some((h) => h.threadId === hidden)).toBe(true);

    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    await hub.handle(client, { type: "search", requestId: "s2", query: "introuvable" });
    expect(client.last("searched").hits).toEqual([]);
  });

  it("shows it all again once the code is given, to every window", async () => {
    const { hub, client, secret, thread } = setup();
    const hidden = thread(secret, "bonjour");
    const other = new TestClient();
    hub.connect(other);
    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    expect(other.last("snapshot").snapshot.threads).toEqual([]);

    await expect(
      hub.handle(client, {
        type: "lock.unlock",
        requestId: "r3",
        projectId: secret,
        pin: "999999",
      }),
    ).rejects.toThrow(/incorrect/);
    expect(other.last("snapshot").snapshot.threads).toEqual([]);
    await hub.handle(client, {
      type: "lock.unlock",
      requestId: "r4",
      projectId: secret,
      pin: "123456",
    });
    expect(other.last("snapshot").snapshot.threads.map((t) => t.id)).toEqual([hidden]);
    await hub.handle(client, { type: "thread.open", threadId: hidden });
  });

  it("forgets the lock of a project removed", async () => {
    const { hub, client, secret } = setup();
    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    await hub.handle(client, {
      type: "lock.unlock",
      requestId: "r3",
      projectId: secret,
      pin: "123456",
    });
    await hub.handle(client, { type: "lock.project", requestId: "r4", projectId: secret });
    expect(hub.locks.isLocked(secret)).toBe(true);
    // Removing it needs the code first, like anything else done to it.
    await expect(
      hub.handle(client, { type: "project.remove", requestId: "r5", projectId: secret }),
    ).rejects.toThrow(/verrouillé/);
  });
});
