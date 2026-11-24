import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub } from "../src/hub.ts";
import {
  COMPUTER_ACTOR,
  type LockStorage,
  MAX_TRIES,
  ProjectLocks,
  TRIES_WINDOW_MS,
} from "../src/locks.ts";
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

  it("keeps counting the wrong codes when the server starts again", () => {
    const storage = memory();
    const now = () => 1_000_000;
    const first = new ProjectLocks(storage, now);
    first.setPin("123456");
    first.lock("p1");
    for (let i = 0; i < MAX_TRIES; i++) expect(() => first.unlock("p1", "000000")).toThrow();
    const again = new ProjectLocks(storage, now);
    expect(() => again.unlock("p1", "123456")).toThrow(/Réessaie/);
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

  it("isolates failed PIN attempts per device and supports legacy failure arrays", () => {
    const storage = memory();
    const now = () => 1_000_000;
    const locks = new ProjectLocks(storage, now);
    locks.setPin("123456");
    locks.lock("p1");
    for (let i = 0; i < MAX_TRIES; i++) {
      expect(() => locks.unlock("p1", "000000", "phone-1")).toThrow(/incorrect/);
    }
    // phone-1 is rate-limited, but another phone and the computer are unaffected.
    expect(() => locks.unlock("p1", "123456", "phone-1")).toThrow(/Réessaie/);
    locks.unlock("p1", "123456", "phone-2");
    expect(locks.isLocked("p1")).toBe(false);
    locks.lock("p1");
    locks.unlock("p1", "123456", COMPUTER_ACTOR);
    expect(locks.isLocked("p1")).toBe(false);

    // Legacy array persisted by an older server version migrates into the computer bucket.
    const legacy = memory();
    legacy.setSetting("lock.failures", [1_000_000, 1_000_001, 1_000_002, 1_000_003, 1_000_004]);
    const migrated = new ProjectLocks(legacy, () => 1_000_010);
    migrated.setPin("123456");
    migrated.lock("p1");
    expect(() => migrated.unlock("p1", "123456", COMPUTER_ACTOR)).toThrow(/Réessaie/);
    migrated.unlock("p1", "123456", "phone-2");
    expect(migrated.isLocked("p1")).toBe(false);
  });

  it("resets the PIN, unlocks all projects, and clears failure buckets", () => {
    const storage = memory();
    const locks = new ProjectLocks(storage, () => 1_000_000);
    locks.setPin("123456");
    locks.lock("p1");
    locks.lock("p2");
    for (let i = 0; i < MAX_TRIES; i++) {
      expect(() => locks.unlock("p1", "000000", "phone-1")).toThrow();
    }
    locks.reset();
    expect(locks.hasPin()).toBe(false);
    expect(locks.any()).toBe(false);
    expect(locks.lockedProjects()).toEqual([]);
    const reloaded = new ProjectLocks(storage, () => 1_000_000);
    expect(reloaded.hasPin()).toBe(false);
    expect(reloaded.any()).toBe(false);
  });
});

class TestClient implements Client {
  readonly deviceId?: string;
  openThreadIds?: Set<string>;
  readonly messages: ServerMessage[] = [];
  constructor(deviceId?: string) {
    if (deviceId) this.deviceId = deviceId;
  }
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

  it("leaves its messages out of the activity map", async () => {
    const { hub, client, secret, open, thread } = setup();
    const hidden = thread(secret, "secret");
    const shown = thread(open, "public");
    await hub.whenIdle(hidden);
    await hub.whenIdle(shown);
    const total = async (requestId: string) => {
      await hub.handle(client, { type: "activity", requestId, tzOffset: 0, days: 2 });
      return client.last("activity").days.reduce((n, d) => n + d.count, 0);
    };
    const all = await total("a1");
    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    const left = await total("a2");
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(all);
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

  it("reserves lock PIN/reset to the computer while letting paired devices manage custom agents and MCP", async () => {
    const { hub, client, secret, open, thread } = setup();
    const phone = new TestClient("phone-1");
    hub.connect(phone);
    expect(client.last("snapshot").snapshot.pairedDevice).toBeUndefined();
    expect(phone.last("snapshot").snapshot.pairedDevice).toBe(true);

    // Paired devices cannot set the initial PIN, change it, or reset it.
    await expect(
      hub.handle(phone, { type: "lock.setPin", requestId: "p1", pin: "123456" }),
    ).rejects.toThrow(/Seul l'ordinateur/);
    await expect(hub.handle(phone, { type: "lock.reset", requestId: "p2" })).rejects.toThrow(
      /Seul l'ordinateur/,
    );

    // Paired devices can still manage custom agents and MCP servers as before.
    await hub.handle(phone, {
      type: "agent.addCustom",
      requestId: "p3",
      agent: { name: "custom-phone", command: "node", args: ["-e", "1"] },
    });
    const customId = phone.last("created").id;
    await hub.handle(phone, { type: "agent.removeCustom", agentId: customId });
    await hub.handle(phone, {
      type: "mcp.add",
      requestId: "p4",
      server: {
        name: "phone-mcp",
        transport: { type: "stdio", command: "node", args: ["-e", "1"], env: [] },
      },
    });
    const mcpId = phone.last("created").id;
    await hub.handle(phone, { type: "mcp.setEnabled", id: mcpId, enabled: false });
    await hub.handle(phone, {
      type: "mcp.setScope",
      id: mcpId,
      projectIds: [open],
      allRoles: false,
    });
    await hub.handle(phone, { type: "mcp.remove", id: mcpId });

    // The computer sets the PIN, locks a project; failed phone tries do not block the computer.
    const hidden = thread(secret, "secret-fil");
    await hub.handle(client, { type: "lock.setPin", requestId: "c1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "c2", projectId: secret });
    for (let i = 0; i < MAX_TRIES; i++) {
      await expect(
        hub.handle(phone, {
          type: "lock.unlock",
          requestId: `bad-${i}`,
          projectId: secret,
          pin: "000000",
        }),
      ).rejects.toThrow(/incorrect/);
    }
    await expect(
      hub.handle(phone, {
        type: "lock.unlock",
        requestId: "blocked",
        projectId: secret,
        pin: "123456",
      }),
    ).rejects.toThrow(/Réessaie/);

    // The computer can reset the PIN and unlock all projects cleanly.
    await hub.handle(client, { type: "lock.reset", requestId: "c3" });
    expect(client.last("snapshot").snapshot.lockPin).toBeUndefined();
    expect(client.last("snapshot").snapshot.pairedDevice).toBeUndefined();
    expect(phone.last("snapshot").snapshot.pairedDevice).toBe(true);
    expect(client.last("snapshot").snapshot.threads.map((t) => t.id)).toContain(hidden);
    expect(phone.last("snapshot").snapshot.threads.map((t) => t.id)).toContain(hidden);

    // Locking open still works only after computer sets a new PIN.
    await expect(
      hub.handle(client, { type: "lock.project", requestId: "c4", projectId: open }),
    ).rejects.toThrow(/code/);
  });

  it("blocks /lock bypasses via overlapping paths, symlinks, shared git repos, and dataDir", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lock-paths-"));
    const dataDir = path.join(dir, "moon-data");
    const projectsRoot = path.join(dir, "projects");
    const repoDir = path.join(projectsRoot, "secret-repo");
    const subDir = path.join(repoDir, "packages", "app");
    const wtDir = path.join(projectsRoot, "secret-wt");
    const safeDir = path.join(projectsRoot, "safe");
    mkdirSync(path.join(dataDir, "worktrees"), { recursive: true });
    mkdirSync(subDir, { recursive: true });
    mkdirSync(safeDir, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Test");
    git(repoDir, "config", "user.email", "test@example.com");
    writeFileSync(path.join(repoDir, "README.md"), "secret\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "worktree", "add", "-b", "side", wtDir);

    const store = new Store(path.join(dataDir, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      dataDir,
      worktreesDir: path.join(dataDir, "worktrees"),
      homeDir: path.join(dir, ".home"),
    });
    const client = new TestClient();
    hub.connect(client);
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    // MoonAgentic's own dataDir, its parent, and its subdirectories can never be added as projects.
    expect(() => hub.createProject("data", dataDir)).toThrow(/données internes/);
    expect(() => hub.createProject("parent", dir)).toThrow(/données internes/);
    expect(() => hub.createProject("wt", path.join(dataDir, "worktrees"))).toThrow(
      /données internes|appartient à MoonAgentic/,
    );

    const secretId = hub.createProject("secret-repo", repoDir);
    await hub.handle(client, { type: "lock.setPin", requestId: "l1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "l2", projectId: secretId });

    // Re-adding the locked folder, its parent, a subfolder, a symlink, or another git worktree fails.
    expect(() => hub.createProject("same", repoDir)).toThrow(/verrouillé/);
    expect(() => hub.createProject("sub", subDir)).toThrow(/verrouillé/);
    expect(() => hub.createProject("parent", projectsRoot)).toThrow(/verrouillé/);
    expect(() => hub.createProject("other-wt", wtDir)).toThrow(/dépôt git.*verrouillé/);
    if (process.platform !== "win32") {
      const link = path.join(projectsRoot, "alias");
      symlinkSync(repoDir, link);
      expect(() => hub.createProject("alias", link)).toThrow(/verrouillé/);
    }

    // Unrelated sibling folders remain allowed.
    expect(hub.createProject("safe", safeDir)).toBeTruthy();

    // After unlocking, subfolder can be opened normally.
    await hub.handle(client, {
      type: "lock.unlock",
      requestId: "l3",
      projectId: secretId,
      pin: "123456",
    });
    expect(hub.createProject("sub", subDir)).toBeTruthy();
  });

  it("allows unrelated projects and discussionsProject() inside a git-versioned home directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lock-home-git-"));
    const homeDir = path.join(dir, "home");
    const dataDir = path.join(dir, "moon-data");
    const notesDir = path.join(homeDir, "notes");
    const otherDir = path.join(homeDir, "other");
    mkdirSync(path.join(dataDir, "worktrees"), { recursive: true });
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
    // Home directory itself is a git repo (e.g. dotfiles), while projects inside it are plain folders.
    git(homeDir, "init", "-b", "main");
    git(homeDir, "config", "user.name", "Test");
    git(homeDir, "config", "user.email", "test@example.com");
    writeFileSync(path.join(homeDir, ".profile"), "export FOO=1\n");
    git(homeDir, "add", ".profile");
    git(homeDir, "commit", "-m", "dotfiles");

    const store = new Store(path.join(dataDir, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      dataDir,
      worktreesDir: path.join(dataDir, "worktrees"),
      homeDir,
    });
    const client = new TestClient();
    hub.connect(client);
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const notesId = hub.createProject("notes", notesDir);
    await hub.handle(client, { type: "lock.setPin", requestId: "h1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "h2", projectId: notesId });

    // Locking `notes` must still block its parent (`homeDir`) and subfolders, but allow siblings and Discussions.
    expect(() => hub.createProject("home", homeDir)).toThrow(/verrouillé/);
    expect(hub.createProject("other", otherDir)).toBeTruthy();
    expect(hub.discussionsProject()).toBeTruthy();
  });

  it("blocks MCP mutations that explicitly target a locked project while allowing global and open-only MCP servers", async () => {
    const { hub, client, secret, open } = setup();
    const stdio = { type: "stdio" as const, command: "node", args: [], env: [] };
    // Register one global server, one scoped to `open`, and one scoped to `secret` before locking.
    await hub.handle(client, {
      type: "mcp.add",
      requestId: "m1",
      server: { name: "global-srv", transport: stdio },
    });
    const globalId = client.last("created").id;
    await hub.handle(client, {
      type: "mcp.add",
      requestId: "m2",
      server: { name: "open-srv", transport: stdio, projectIds: [open] },
    });
    const openId = client.last("created").id;
    await hub.handle(client, {
      type: "mcp.add",
      requestId: "m2s",
      server: { name: "secret-srv", transport: stdio, projectIds: [secret] },
    });
    const secretSrvId = client.last("created").id;

    await hub.handle(client, { type: "lock.setPin", requestId: "l1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "l2", projectId: secret });

    // Explicitly targeting a locked project in projectIds is refused.
    await expect(
      hub.handle(client, {
        type: "mcp.add",
        requestId: "m4",
        server: { name: "s2", transport: stdio, projectIds: [secret] },
      }),
    ).rejects.toThrow(/verrouillé/);
    await expect(
      hub.handle(client, {
        type: "mcp.setScope",
        id: openId,
        projectIds: [open, secret],
        allRoles: false,
      }),
    ).rejects.toThrow(/verrouillé/);
    await expect(
      hub.handle(client, { type: "mcp.setEnabled", id: secretSrvId, enabled: false }),
    ).rejects.toThrow(/verrouillé/);
    await expect(
      hub.handle(client, {
        type: "mcp.setScope",
        id: secretSrvId,
        projectIds: [open],
        allRoles: false,
      }),
    ).rejects.toThrow(/verrouillé/);
    await expect(hub.handle(client, { type: "mcp.remove", id: secretSrvId })).rejects.toThrow(
      /verrouillé/,
    );

    // Global and open-project MCP operations remain allowed while another project is locked.
    await hub.handle(client, {
      type: "mcp.add",
      requestId: "m3",
      server: { name: "g2", transport: stdio },
    });
    await hub.handle(client, { type: "mcp.setEnabled", id: globalId, enabled: false });
    await hub.handle(client, {
      type: "mcp.setScope",
      id: openId,
      projectIds: null,
      allRoles: false,
    });
    await hub.handle(client, { type: "mcp.setEnabled", id: openId, enabled: false });
    await hub.handle(client, { type: "mcp.remove", id: globalId });
    await hub.handle(client, { type: "mcp.remove", id: openId });
  });

  it("excludes locked projects in SQL search before LIMIT so visible hits are never crowded out", async () => {
    const { hub, store, client, secret, open } = setup();
    const now = Date.now();
    store.addThread({
      id: "t-open",
      projectId: open,
      title: "Public",
      agentId: "demo",
      status: "idle",
      permissionMode: "full",
      createdAt: now,
      updatedAt: now,
    });
    store.addThread({
      id: "t-secret",
      projectId: secret,
      title: "Secret",
      agentId: "demo",
      status: "idle",
      permissionMode: "full",
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    store.putItem("t-open", {
      id: "u-open",
      kind: "user",
      text: "motclef commun visible",
      at: now,
    });
    // Write 35 newer matching messages in the secret project (> default LIMIT 30).
    for (let i = 0; i < 35; i++) {
      store.putItem("t-secret", {
        id: `u-sec-${i}`,
        kind: "user",
        text: `motclef commun cache ${i}`,
        at: now + 10 + i,
      });
    }
    await hub.handle(client, { type: "lock.setPin", requestId: "l1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "l2", projectId: secret });
    await hub.handle(client, { type: "search", requestId: "s1", query: "motclef" });
    expect(client.last("searched").hits.map((h) => h.threadId)).toEqual(["t-open"]);
  });

  it("hides and protects locked project branches on a shared git repository", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lock-branches-"));
    const repo = path.join(dir, "repo");
    const secretSub = path.join(repo, "secret");
    const openSub = path.join(repo, "open");
    mkdirSync(secretSub, { recursive: true });
    mkdirSync(openSub, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore", windowsHide: true });
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(path.join(repo, "README.md"), "shared\n");
    git("add", ".");
    git("commit", "-m", "init");

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
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    // Both projects exist in the same repo before locking.
    const secretId = hub.createProject("secret", secretSub);
    const openId = hub.createProject("open", openSub);
    const secretThread = hub.createThread({
      projectId: secretId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      title: "Titre Top Secret",
      text: "x",
    });
    await hub.whenIdle(secretThread);
    const secretBranch = store.getThread(secretThread)!.workspace!.branch;
    await hub.setArchived(secretThread, true);

    await hub.handle(client, { type: "lock.setPin", requestId: "l1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "l2", projectId: secretId });

    // Listing branches on `open` leaks neither the locked branch name nor its thread title.
    await hub.handle(client, { type: "project.branches", requestId: "b1", projectId: openId });
    const listed = client.last("projectBranches");
    expect(listed.branches.map((b) => b.name)).not.toContain(secretBranch);
    expect(JSON.stringify(listed)).not.toContain("Titre Top Secret");

    // Trying to delete the locked project's branch via `open` is refused and leaves git untouched.
    await hub.handle(client, {
      type: "project.deleteBranches",
      requestId: "b2",
      projectId: openId,
      branches: [secretBranch],
    });
    expect(client.last("branchesDeleted").deleted).toEqual([]);
    const refs = execFileSync("git", ["branch", "--list", secretBranch], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(refs).toContain(secretBranch);
  });
});

describe("a project's settings", () => {
  it("keeps its icon and tint for every window, and puts the folder back", async () => {
    const { hub, client, open } = setup();
    const other = new TestClient();
    hub.connect(other);
    await hub.handle(client, {
      type: "project.setLook",
      projectId: open,
      icon: "🚀",
      color: "mint",
    });
    expect(other.last("project").project).toMatchObject({ id: open, icon: "🚀", color: "mint" });
    other.messages.length = 0;
    hub.connect(other);
    expect(other.last("snapshot").snapshot.projects.find((p) => p.id === open)).toMatchObject({
      icon: "🚀",
      color: "mint",
    });
    await hub.handle(client, { type: "project.setLook", projectId: open, icon: null, color: null });
    const plain = other.last("project").project;
    expect(plain.icon).toBeUndefined();
    expect(plain.color).toBeUndefined();
  });

  it("writes its AGENTS.md from the app, but nothing of a locked project", async () => {
    const { dir, hub, client, secret, open } = setup();
    await hub.handle(client, {
      type: "project.saveRules",
      requestId: "w1",
      projectId: open,
      text: "Règles partagées",
    });
    expect(client.last("projectSetup")).toMatchObject({
      requestId: "w1",
      projectId: open,
      setup: { rules: { text: "Règles partagées", exists: true }, claude: "missing" },
    });
    await hub.handle(client, { type: "lock.setPin", requestId: "r1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "r2", projectId: secret });
    await expect(
      hub.handle(client, { type: "project.setup", requestId: "s1", projectId: secret }),
    ).rejects.toThrow(/verrouillé/);
    await expect(
      hub.handle(client, {
        type: "project.saveRules",
        requestId: "w2",
        projectId: secret,
        text: "Non",
      }),
    ).rejects.toThrow(/verrouillé/);
    expect(existsSync(path.join(dir, "secret", "AGENTS.md"))).toBe(false);
  });
});
