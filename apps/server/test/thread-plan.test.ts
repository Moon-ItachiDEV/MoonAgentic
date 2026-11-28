import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { createHttpServer } from "../src/http.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function repoAt(dir: string) {
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

/** The real server, its bridge reachable, and a project on the demo agents. */
async function served() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-plan-"));
  repoAt(path.join(root, "a"));
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    homeDir: root,
  });
  const server = createHttpServer({ hub, token: "app-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const projectId = hub.createProject("a", path.join(root, "a"));
  const client: Client = { send: () => undefined };
  const ask = async (threadId: string, text: string) => {
    await hub.handle(client, { type: "thread.send", threadId, text });
    await hub.whenIdle(threadId);
  };
  return { hub, store, projectId, ask };
}

describe("a thread's plan", () => {
  it("is kept by the thread's agent with update_plan, each step's times kept", async () => {
    const { hub, store, projectId, ask } = await served();
    const id = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/etapes 0 Trouver la cause; Corriger le menu; Ouvrir la PR",
    });
    await hub.whenIdle(id);
    const first = store.getThread(id)!.plan!;
    expect(first.from).toBe("tool");
    expect(first.entries.map((e) => [e.content, e.status])).toEqual([
      ["Trouver la cause", "in_progress"],
      ["Corriger le menu", "pending"],
      ["Ouvrir la PR", "pending"],
    ]);
    const started = first.entries[0]!.startedAt;
    expect(started).toBeTypeOf("number");

    await ask(id, "/etapes 1 Trouver la cause; Corriger le menu; Ouvrir la PR");
    const next = store.getThread(id)!.plan!.entries;
    // The step it was on keeps when it started, and now has when it ended.
    expect(next[0]).toMatchObject({ status: "completed", startedAt: started });
    expect(next[0]!.endedAt).toBeTypeOf("number");
    expect(next[1]).toMatchObject({ status: "in_progress" });
    // Saved with the thread: read again from the database, it is still there.
    expect(store.listThreads().find((t) => t.id === id)!.plan!.entries).toHaveLength(3);
  });

  it("follows the agent's own plan, unless the agent keeps one with the tool", async () => {
    const { hub, store, projectId, ask } = await served();
    const id = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Corrige answer en 5 étapes",
    });
    await hub.whenIdle(id);
    const own = store.getThread(id)!.plan!;
    expect(own.from).toBe("agent");
    expect(own.entries).toHaveLength(5);
    expect(own.entries.every((e) => e.status === "completed")).toBe(true);
    // It names the timeline item it shows, so the phone draws it once, at the top.
    expect(store.listItems(id).some((i) => i.kind === "plan" && i.id === own.item)).toBe(true);

    await ask(id, "/etapes 0 Relire; Tester");
    expect(store.getThread(id)!.plan).toMatchObject({ from: "tool" });
    // The agent's own plan of a later turn no longer takes its place.
    await ask(id, "Encore en 5 étapes");
    expect(store.getThread(id)!.plan!.entries.map((e) => e.content)).toEqual(["Relire", "Tester"]);
    // Five steps of a second or so, twice.
  }, 45_000);
});
