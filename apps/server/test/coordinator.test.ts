import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { COORDINATOR_PATH, COORDINATOR_TOOLS } from "../src/coordinator-tools.ts";
import { createHttpServer } from "../src/http.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const APP_TOKEN = "jeton-de-l-app";

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

/** The real server, a project with its coordinator on the demo agent, and a second project. */
async function coordinated() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-coord-"));
  repoAt(path.join(root, "a"));
  repoAt(path.join(root, "b"));
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
  });
  // The tokens the bridge really came in with, to try them by hand afterwards.
  const tokens: string[] = [];
  const call = hub.coordinatorCall.bind(hub);
  hub.coordinatorCall = (token, tool, args) => {
    tokens.push(token);
    return call(token, tool, args);
  };
  const server = createHttpServer({ hub, token: APP_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const projectId = hub.createProject("a", path.join(root, "a"));
  const otherId = hub.createProject("b", path.join(root, "b"));
  const coordinatorId = hub.openCoordinator(projectId, "demo");
  const client: Client = { send: () => undefined };
  const say = async (text: string) => {
    await hub.handle(client, { type: "thread.send", threadId: coordinatorId, text });
    await hub.whenIdle(coordinatorId);
    return store.getThread(coordinatorId)!.summary;
  };
  const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${COORDINATOR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  return { hub, store, projectId, otherId, coordinatorId, say, post, tokens };
}

describe("a project's coordinator", () => {
  it("is one per project, kept apart from the project's threads", async () => {
    const { hub, store, projectId, otherId, coordinatorId } = await coordinated();
    expect(hub.openCoordinator(projectId, "demo")).toBe(coordinatorId);
    expect(hub.openCoordinator(otherId, "demo")).not.toBe(coordinatorId);
    const thread = store.getThread(coordinatorId)!;
    expect(thread).toMatchObject({ kind: "coordinator", permissionMode: "supervised" });
    // It works in the project's folder: no branch of its own.
    expect(thread.workspace).toBeUndefined();
  });

  it("opens a thread on its own branch through MoonAgentic's tools, as its agent asks", async () => {
    const { store, projectId, coordinatorId, say } = await coordinated();
    expect(await say("/ouvre Export Safari")).toBe("J'ai ouvert le fil « Export Safari ».");
    const opened = store.listThreads().find((t) => t.openedBy === coordinatorId)!;
    expect(opened).toMatchObject({ projectId, title: "Export Safari", agentId: "demo" });
    expect(opened.workspace?.branch).toBeTruthy();
    // The thread got the brief, and the coordinator's conversation links to it.
    expect(store.listItems(opened.id)[0]).toMatchObject({
      kind: "user",
      text: "Corrige : Export Safari",
    });
    expect(store.listItems(coordinatorId)).toContainEqual(
      expect.objectContaining({ kind: "opened", threadId: opened.id, title: "Export Safari" }),
    );
    // It sees the project's threads, itself left out.
    expect(await say("/fils")).toBe("Ce projet a 1 fil.");
  });

  it("stops opening threads past a few for one message", async () => {
    const { tokens, post, say } = await coordinated();
    await say("/fils");
    const open = () => post(tokens[0]!, { tool: "open_thread", args: { title: "T", brief: "B" } });
    for (let i = 0; i < 4; i += 1) expect((await open()).status).toBe(200);
    const refused = await open();
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("déjà ouvert 4 fils");
    // The next message of the user starts the count again.
    await say("/fils");
    expect((await open()).status).toBe(200);
  });

  it("reaches its own project only, with its own token only", async () => {
    const { hub, otherId, tokens, post, say } = await coordinated();
    const elsewhere = hub.createThread({
      projectId: otherId,
      agentId: "demo",
      permissionMode: "full",
      text: "",
    });
    await say("/fils");
    const token = tokens[0]!;
    expect((await post(token, { tool: "list_threads" })).status).toBe(200);

    // Neither the app's token nor a made-up one opens the tools.
    expect((await post(APP_TOKEN, { tool: "list_threads" })).status).toBe(401);
    expect((await post("x".repeat(43), { tool: "list_threads" })).status).toBe(401);
    // A call that came through a proxy, or from a web page, is not the bridge's.
    expect(
      (await post(token, { tool: "list_threads" }, { "x-forwarded-for": "100.64.0.2" })).status,
    ).toBe(403);
    expect(
      (await post(token, { tool: "list_threads" }, { origin: "https://x.example" })).status,
    ).toBe(403);

    // Another project's thread does not exist for it, to read or to change.
    for (const tool of ["read_thread", "resolve_thread", "message_thread"]) {
      const reply = await post(token, { tool, args: { thread_id: elsewhere, text: "x" } });
      expect(reply.status).toBe(400);
      expect(((await reply.json()) as { error: string }).error).toContain("n'existe pas");
    }
    // Nothing but the tools it was given.
    expect((await post(token, { tool: "project.remove" })).status).toBe(400);
    expect(COORDINATOR_TOOLS.map((t) => t.name)).toEqual([
      "list_threads",
      "read_thread",
      "open_thread",
      "message_thread",
      "resolve_thread",
    ]);
  });

  it("reads a thread's real state, follows it up, and resolves it", async () => {
    const { hub, store, projectId, tokens, post, say } = await coordinated();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Corrige la réponse",
    });
    await hub.whenIdle(threadId);
    await say("/fils");
    const token = tokens[0]!;
    const read = (await (
      await post(token, { tool: "read_thread", args: { thread_id: threadId } })
    ).json()) as { result: { state: string; last_messages: { from: string; text: string }[] } };
    expect(read.result.state).toBe("inactif");
    expect(read.result.last_messages[0]).toEqual({
      from: "utilisateur",
      text: "Corrige la réponse",
    });
    expect(read.result.last_messages.at(-1)!.from).toBe("agent");

    expect(
      (await post(token, { tool: "message_thread", args: { thread_id: threadId, text: "Encore" } }))
        .status,
    ).toBe(200);
    await hub.whenIdle(threadId);
    expect(store.listItems(threadId).filter((i) => i.kind === "user")).toHaveLength(2);

    expect(
      (await post(token, { tool: "resolve_thread", args: { thread_id: threadId } })).status,
    ).toBe(200);
    expect(store.getThread(threadId)!.archived).toBe(true);
  });
});
