import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { ORIGIN_MARK, REPLY_MARK, threadGroup, WORK_KINDS } from "@moonagentic/protocol";
import { replyGuide } from "../src/coordinator.ts";
import { COORDINATOR_PATH, COORDINATOR_TOOLS, THREAD_KINDS } from "../src/coordinator-tools.ts";
import { createHttpServer } from "../src/http.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const APP_TOKEN = "jeton-de-l-app";

// A thread on its own branch takes seconds to start on a slow machine (Windows makes its
// worktree first): what is waited for gets that time.
const soon = <T>(read: () => T) => expect.poll(read, { timeout: 20_000 });

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
  // A turn of the coordinator kept under way: its agent waits for a permission. Its tools
  // that change something only work meanwhile.
  const hold = async () => {
    await hub.handle(client, { type: "thread.send", threadId: coordinatorId, text: "Regarde" });
    await soon(() => store.getThread(coordinatorId)!.status).toBe("waiting");
  };
  const release = async () => {
    await hub.cancel(coordinatorId);
    await hub.whenIdle(coordinatorId);
  };
  cleanups.unshift(release);
  const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${COORDINATOR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  return { hub, store, projectId, otherId, coordinatorId, say, post, tokens, hold, release };
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
      // Marked as the coordinator's words, not the user's.
      from: "coordinator",
      text: `Corrige : Export Safari${REPLY_MARK}${replyGuide(undefined)}${ORIGIN_MARK}> /ouvre Export Safari`,
    });
    // Asked again for the same subject, it gets that thread back rather than a second one.
    expect(await say("/ouvre Export Safari")).toBe("J'ai ouvert le fil « Export Safari ».");
    expect(store.listThreads().filter((t) => t.openedBy === coordinatorId)).toHaveLength(1);
    expect(store.listItems(coordinatorId)).toContainEqual(
      expect.objectContaining({ kind: "opened", threadId: opened.id, title: "Export Safari" }),
    );
    // It runs on the agent's low effort, where a thread starts on the agent's own.
    expect(store.getThread(coordinatorId)!.settings).toMatchObject({ effort: "bas" });
    // It sees the project's threads, itself left out.
    expect(await say("/fils")).toBe("Ce projet a 1 fil.");
  });

  it("lays down the plan of a thread it opens, and changes it later", async () => {
    const { store, tokens, post, say, hold } = await coordinated();
    await say("/fils");
    await hold();
    const call = async (tool: string, args: unknown) =>
      (await (await post(tokens[0]!, { tool, args })).json()) as {
        result?: { opened: { id: string; plan?: unknown } };
        error?: string;
      };
    const opened = await call("open_thread", {
      task_key: "menu",
      title: "Menu",
      brief: "B",
      steps: ["Trouver la cause", "  Corriger   le menu ", "Ouvrir la PR"],
    });
    const id = opened.result!.opened.id;
    expect(store.getThread(id)!.plan).toMatchObject({
      from: "tool",
      entries: [
        { content: "Trouver la cause", status: "pending" },
        { content: "Corriger le menu", status: "pending" },
        { content: "Ouvrir la PR", status: "pending" },
      ],
    });
    // list_threads tells it how far each thread is.
    expect(opened.result!.opened.plan).toHaveLength(3);
    // It changes a thread's plan by its id; a step done keeps its place.
    expect(
      await call("update_plan", {
        thread_id: id,
        steps: [
          { title: "Trouver la cause", status: "completed" },
          { title: "Corriger le menu", status: "in_progress" },
        ],
      }),
    ).toMatchObject({ result: { saved: true, done: 1, steps: 2 } });
    expect(store.getThread(id)!.plan!.entries.map((e) => e.status)).toEqual([
      "completed",
      "in_progress",
    ]);
    // What is not a plan is refused, the plan left as it was.
    for (const steps of [
      "Corriger",
      [{ title: "", status: "pending" }],
      [{ title: "A", status: "fini" }],
      [
        { title: "A", status: "in_progress" },
        { title: "B", status: "in_progress" },
      ],
      Array.from({ length: 13 }, () => ({ title: "A", status: "pending" })),
    ]) {
      expect((await call("update_plan", { thread_id: id, steps })).error).toBeTruthy();
    }
    expect((await call("update_plan", { thread_id: "autre", steps: [] })).error).toBe(
      "Ce fil n'existe pas dans ce projet.",
    );
    expect(store.getThread(id)!.plan!.entries).toHaveLength(2);
    // An empty list takes the plan away.
    await call("update_plan", { thread_id: id, steps: [] });
    expect(store.getThread(id)!.plan).toBeUndefined();
  });

  it("stops opening threads past a few for one message", async () => {
    const { tokens, post, say, hold, release } = await coordinated();
    await say("/fils");
    await hold();
    const open = (key: string) =>
      post(tokens[0]!, { tool: "open_thread", args: { task_key: key, title: "T", brief: "B" } });
    for (let i = 0; i < 4; i += 1) expect((await open(`sujet-${i}`)).status).toBe(200);
    // A retry of one of them opens nothing and counts for nothing.
    const again = (await (await open("sujet-0")).json()) as { result: { already_open?: boolean } };
    expect(again.result.already_open).toBe(true);
    const refused = await open("sujet-4");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("déjà ouvert 4 fils");
    // The next message of the user starts the count again.
    await release();
    await hold();
    expect((await open("sujet-4")).status).toBe(200);
    // Once it has answered, a bridge left behind opens nothing more.
    await release();
    const late = await open("sujet-5");
    expect(late.status).toBe(400);
    expect(((await late.json()) as { error: string }).error).toContain("pendant qu'il répond");
  });

  it("joins every message of the user since the last thread it opened, not only the last", async () => {
    const { store, tokens, post, say, hold, release } = await coordinated();
    await say("/fils");
    await say("/fils");
    await hold();
    const open = async (key: string) => {
      const res = (await (
        await post(tokens[0]!, {
          tool: "open_thread",
          args: { task_key: key, title: "T", brief: "B" },
        })
      ).json()) as { result: { opened: { id: string } } };
      return store.listItems(res.result.opened.id)[0];
    };
    const first = await open("un");
    expect(first).toMatchObject({ kind: "user" });
    expect(first?.kind === "user" && first.text).toContain("> /fils\n> \n> /fils\n> \n> Regarde");
    // A second thread for the same message gets that message too.
    const second = await open("deux");
    expect(second?.kind === "user" && second.text).toContain("> /fils\n> \n> /fils\n> \n> Regarde");
    // The next message starts after the threads already opened.
    await release();
    await hold();
    const third = await open("trois");
    expect(third?.kind === "user" && third.text).toMatch(/d'origine[^]*:\n\n> Regarde$/);
    expect(third?.kind === "user" && third.text).not.toContain("/fils");
  });

  it("lets its own tools through when its agent names them only in the title", async () => {
    const { store, coordinatorId, say } = await coordinated();
    // As Antigravity asks: "Run mcp_moonagentic_list_threads", with no tool name besides.
    expect(await say("/fils-agy")).toBe("Liste lue.");
    expect(store.listItems(coordinatorId).some((i) => i.kind === "permission")).toBe(false);
  });

  it("still asks the user for a command that only takes the title of its own tools", async () => {
    const { hub, store, coordinatorId } = await coordinated();
    const client: Client = { send: () => undefined };
    await hub.handle(client, {
      type: "thread.send",
      threadId: coordinatorId,
      text: "/fils-agy commande",
    });
    await soon(() => store.getThread(coordinatorId)!.status).toBe("waiting");
    expect(store.listItems(coordinatorId).some((i) => i.kind === "permission")).toBe(true);
  });

  it("reaches its own project only, with its own token only", async () => {
    const { hub, otherId, tokens, post, say, hold } = await coordinated();
    const elsewhere = hub.createThread({
      projectId: otherId,
      agentId: "demo",
      permissionMode: "full",
      text: "",
    });
    await say("/fils");
    await hold();
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
    for (const tool of ["read_thread", "resolve_thread", "message_thread", "update_plan"]) {
      const reply = await post(token, {
        tool,
        args: { thread_id: elsewhere, text: "x", steps: [] },
      });
      expect(reply.status).toBe(400);
      expect(((await reply.json()) as { error: string }).error).toContain("n'existe pas");
    }
    // Nothing but the tools it was given.
    expect((await post(token, { tool: "project.remove" })).status).toBe(400);
    expect(COORDINATOR_TOOLS.map((t) => t.name)).toEqual([
      "list_threads",
      "search_threads",
      "read_thread",
      "read_memory",
      "list_agents",
      "save_memory",
      "publish_artifact",
      "update_plan",
      "open_thread",
      "start_team",
      "message_thread",
      "resolve_thread",
    ]);
  });

  it("reads a thread's real state, follows it up, and resolves it", async () => {
    const { hub, store, projectId, tokens, post, say, hold } = await coordinated();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Corrige la réponse",
    });
    await hub.whenIdle(threadId);
    await say("/fils");
    await hold();
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

  it("gives its bridge a token of its own for what it was started with, once", async () => {
    const { hub, post, say, tokens, coordinatorId } = await coordinated();
    const started: string[] = [];
    const exchange = hub.coordinatorExchange.bind(hub);
    hub.coordinatorExchange = (bootstrap) => {
      started.push(bootstrap);
      return exchange(bootstrap);
    };
    await say("/fils");
    expect(started).toHaveLength(1);
    // What was in the bridge's environment opens no tool, and trades for nothing twice.
    expect(started[0]).not.toBe(tokens[0]);
    expect((await post(started[0]!, { tool: "list_threads" })).status).toBe(401);
    expect((await post(started[0]!, { exchange: true })).status).toBe(401);
    expect((await post(tokens[0]!, { tool: "list_threads" })).status).toBe(200);
    // A coordinator that is deleted takes its bridge's access with it.
    await hub.deleteThread(coordinatorId);
    expect((await post(tokens[0]!, { tool: "list_threads" })).status).toBe(401);
  });

  it("sees what a team's member waits for, on the team's own line", async () => {
    const { hub, store, projectId, tokens, post, say } = await coordinated();
    const lead = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "",
    });
    const member = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Corrige la réponse",
      parentId: lead,
    });
    await soon(() => store.getThread(member)!.status).toBe("waiting");
    await say("/fils");
    type Line = { id: string; state: string; waits_on?: string; asks_permission_for?: string[] };
    const listed = (await (await post(tokens[0]!, { tool: "list_threads" })).json()) as {
      result: Line[];
    };
    // The member is no line of its own: its wait shows on its lead.
    expect(listed.result.map((t) => t.id)).toEqual([lead]);
    expect(listed.result[0]).toMatchObject({ state: "en attente", waits_on: expect.any(String) });
    const read = (await (
      await post(tokens[0]!, { tool: "read_thread", args: { thread_id: lead } })
    ).json()) as { result: Line };
    expect(read.result.asks_permission_for).toHaveLength(1);
    await hub.cancel(member);
    await hub.whenIdle(member);
  }, 90_000);

  it("leaves a message for a thread at work, or cuts in when asked to", async () => {
    const { hub, store, projectId, tokens, post, say, hold } = await coordinated();
    await say("/fils");
    await hold();
    const token = tokens[0]!;
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Corrige la réponse",
    });
    const users = () =>
      store.listItems(threadId).flatMap((i) => (i.kind === "user" ? [i.text] : []));
    const message = async (text: string, mode?: string) =>
      (await (
        await post(token, { tool: "message_thread", args: { thread_id: threadId, text, mode } })
      ).json()) as { result: Record<string, unknown> };

    // Its agent is at work: the message waits, and is given when the turn ends.
    expect((await message("Et les tests")).result.queued_for).toBeTruthy();
    expect(users()).toEqual(["Corrige la réponse"]);
    await hub.whenIdle(threadId);
    await soon(users).toEqual(["Corrige la réponse", "Et les tests"]);

    // An urgent correction stops the turn under way and takes its place. This thread's
    // agent waits for a permission, so its turn is still under way for sure.
    await hub.whenIdle(threadId);
    const held = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Corrige la réponse",
    });
    await soon(() => store.getThread(held)!.status).toBe("waiting");
    const steer = (mode: string) =>
      post(token, { tool: "message_thread", args: { thread_id: held, text: "Stop", mode } });
    expect((await steer("vite")).status).toBe(400);
    const cut = (await (await steer("steer")).json()) as { result: { interrupted?: boolean } };
    expect(cut.result.interrupted).toBe(true);
    expect(store.listItems(held).findLast((i) => i.kind === "user")).toMatchObject({
      text: "Stop",
    });
    await soon(() => store.getThread(held)!.status).toBe("waiting");
    await hub.cancel(held);
    await hub.whenIdle(held);
  }, 90_000);

  it("sends a project's work where its own routes say, with their effort, before the general ones", async () => {
    const { hub, store, projectId, otherId, tokens, post, say, hold } = await coordinated();
    const client: Client = { send: () => undefined };
    await hub.handle(client, {
      type: "coordinator.setRoute",
      kind: "bug",
      agentId: "demo",
      model: "rapide",
    });
    await hub.handle(client, {
      type: "coordinator.setRoute",
      kind: "default",
      agentId: "demo",
      model: "precis",
      settings: { effort: "max" },
      projectId,
    });
    // Another project's routes do not reach this one.
    await hub.handle(client, {
      type: "coordinator.setRoute",
      kind: "tests",
      agentId: "demo",
      model: "rapide",
      projectId: otherId,
    });
    await say("/fils");
    await hold();
    const call = async (args: unknown) =>
      (await (await post(tokens[0]!, { tool: "open_thread", args })).json()) as {
        result: { opened: { id: string } };
      };
    // The project's default goes before the general route for bugs.
    const bug = await call({ task_key: "b", title: "Bug", brief: "B", kind: "bug" });
    expect(store.getThread(bug.result.opened.id)).toMatchObject({
      model: "precis",
      settings: { effort: "max" },
    });
    const tests = await call({ task_key: "t", title: "T", brief: "B", kind: "tests" });
    expect(store.getThread(tests.result.opened.id)).toMatchObject({ model: "precis" });
  });

  it("restarts its agent from the project's settings, its conversation kept", async () => {
    const { hub, store, projectId, otherId, coordinatorId, say, hold } = await coordinated();
    const client: Client = { send: () => undefined };
    await say("/fils");
    expect(hub.liveAgents).toBe(1);
    await hold();
    let done = false;
    await hub.handle(
      { send: (m) => void (m.type === "done" && m.requestId === "r" && (done = true)) },
      { type: "coordinator.restart", requestId: "r", projectId },
    );
    expect(done).toBe(true);
    expect(store.getThread(coordinatorId)!.status).not.toBe("running");
    expect(hub.liveAgents).toBe(0);
    expect(await say("/fils")).toBe("Ce projet a 0 fil.");
    await expect(
      hub.handle(client, { type: "coordinator.restart", requestId: "s", projectId: otherId }),
    ).rejects.toThrow("pas encore de coordinateur");
  });

  it("opens a thread on the effort the user asked for, never another, and says it runs on it", async () => {
    const { hub, store, tokens, post, say, hold } = await coordinated();
    const client: Client = { send: () => undefined };
    await say("/fils");
    await hold();
    const call = async (tool: string, args: unknown = {}) =>
      (await (await post(tokens[0]!, { tool, args })).json()) as {
        result?: unknown;
        error?: string;
      };
    type Shown = { id: string; model?: string; effort?: string; effort_applied?: boolean };
    // It reads which agents, models and levels there are.
    const agents = (await call("list_agents")).result as {
      id: string;
      models: { id: string; name: string; efforts?: string[] }[];
    }[];
    const demo = agents.find((a) => a.id === "demo")!;
    expect(demo.models.find((m) => m.id === "rapide")?.efforts).toEqual([
      "Bas",
      "Moyen",
      "Haut (UltraMoon)",
    ]);

    // A level the model does not have: refused, with the ones it has, and no thread.
    const before = store.listThreads().length;
    const refused = await call("open_thread", {
      task_key: "xhigh",
      title: "Relecture",
      brief: "B",
      agent: "demo",
      model: "rapide",
      effort: "xhigh",
    });
    expect(refused.error).toContain("ne propose pas l'effort « xhigh »");
    expect(refused.error).toContain("Bas, Moyen, Haut (UltraMoon)");
    // So is a model the agent does not offer, rather than starting on its default.
    const noModel = await call("open_thread", {
      task_key: "neon",
      title: "Relecture",
      brief: "B",
      agent: "demo",
      model: "Neon",
    });
    expect(noModel.error).toContain("ne propose pas le modèle « Neon »");
    expect(store.listThreads()).toHaveLength(before);

    // The model by its name, the level by the English word for the agent's « Haut ».
    const opened = (
      (await call("open_thread", {
        task_key: "revue",
        title: "Relecture",
        brief: "B",
        agent: "demo",
        model: "Démo précis",
        effort: "high",
      })) as { result: { opened: Shown } }
    ).result.opened;
    expect(store.getThread(opened.id)).toMatchObject({
      model: "precis",
      settings: { effort: "haut" },
    });
    expect(opened.effort).toMatch(/^Haut/);
    // Once its agent started, what it says is what the agent itself reports. (Supervised, it
    // then waits for a permission: its turn is not waited for.)
    await soon(() => store.getSessionId(opened.id)).not.toBeNull();
    expect(store.getThread(opened.id)!.settings).toMatchObject({ effort: "haut" });
    const listed = (await call("list_threads")).result as Shown[];
    expect(listed.find((t) => t.id === opened.id)).toMatchObject({
      model: "precis",
      // The precise model offers a level above: « Haut » is no longer its highest.
      effort: "Haut",
      effort_applied: true,
    });
    // « UltraMoon » is the model's highest level, which this one has learnt is « Max ».
    const ultra = (
      (await call("open_thread", {
        task_key: "ultra",
        title: "Ultra",
        brief: "B",
        agent: "demo",
        model: "precis",
        effort: "UltraMoon",
      })) as { result: { opened: Shown } }
    ).result.opened;
    expect(store.getThread(ultra.id)!.settings).toEqual({ effort: "max" });

    // The route's effort comes with its agent and model, even when they are asked by name.
    await hub.handle(client, {
      type: "coordinator.setRoute",
      kind: "relecture",
      agentId: "demo",
      model: "rapide",
      settings: { effort: "bas" },
    });
    const routed = (
      (await call("open_thread", {
        task_key: "route",
        title: "Route",
        brief: "B",
        kind: "relecture",
        agent: "demo",
        model: "rapide",
      })) as { result: { opened: Shown } }
    ).result.opened;
    expect(store.getThread(routed.id)!.settings).toEqual({ effort: "bas" });
  }, 90_000);

  it("sends each kind of work where the settings say, and starts the team the user set up", async () => {
    const { hub, store, projectId, coordinatorId, tokens, post, say, hold, release } =
      await coordinated();
    const client: Client = { send: () => undefined };
    expect(THREAD_KINDS).toEqual(WORK_KINDS);
    await hub.handle(client, {
      type: "coordinator.setRoute",
      kind: "bug",
      agentId: "demo",
      model: "precis",
    });
    expect(hub.snapshot().coordinator.routes).toEqual({
      bug: { agentId: "demo", model: "precis" },
    });
    await say("/fils");
    await hold();
    const call = async (tool: string, args: unknown) =>
      (await (await post(tokens[0]!, { tool, args })).json()) as {
        result?: { opened: { id: string }; already_open?: boolean };
        error?: string;
      };
    const bug = await call("open_thread", { task_key: "b", title: "Bug", brief: "B", kind: "bug" });
    expect(store.getThread(bug.result!.opened.id)).toMatchObject({ model: "precis" });
    // The coordinator is told who got the work, by the name its answers are signed with.
    expect(bug.result!.opened).toMatchObject({ agent_name: "Démo précis" });
    // A kind with no route keeps the coordinator's own agent.
    const other = await call("open_thread", {
      task_key: "t",
      title: "T",
      brief: "B",
      kind: "tests",
    });
    expect(store.getThread(other.result!.opened.id)).toMatchObject({ agentId: "demo" });

    // No team was ever set up: the first preset, on the agents at hand, inheriting the
    // coordinator's supervised mode rather than escalating to full.
    const auto = (await call("start_team", { task_key: "auto", task: "Fais tout" })) as {
      result?: { opened: { id: string }; team?: string };
    };
    expect(auto.result?.team).toContain("Équipe par défaut");
    expect(store.getThread(auto.result!.opened.id)).toMatchObject({ role: "lead" });
    expect(store.getThread(auto.result!.opened.id)!.team).toMatchObject({
      coders: 2,
      permissionMode: "supervised",
    });
    // It is not kept as the user's own team.
    expect(hub.snapshot().coordinator.team).toBeUndefined();
    const member = { agentId: "demo" };
    await hub.handle(client, {
      type: "team.start",
      requestId: "r",
      projectId,
      task: "À la main",
      lead: member,
      coder: member,
      coders: 2,
      permissionMode: "full",
    });
    expect(hub.snapshot().coordinator.team).toMatchObject({ coders: 2, permissionMode: "full" });
    // While the coordinator stays supervised, replaying a saved full team asks the user ONCE:
    // 1. Refusing cancels start_team without opening any team.
    const refusedReq = post(tokens[0]!, {
      tool: "start_team",
      // Written with a character that turns the end of the task around on screen.
      args: { task_key: "refuse", task: "Tâche \u202Eeésufer\u202C" },
    });
    const askRefuse = () =>
      store
        .listItems(coordinatorId)
        .find(
          (i) => i.kind === "permission" && i.title.includes("accès complet") && i.outcome === null,
        );
    await soon(askRefuse).toBeTruthy();
    // The request reads as the task is written: nothing in it reorders or hides.
    expect(askRefuse()).toMatchObject({
      title: "Lancer l'équipe en accès complet : Tâche eésufer",
    });
    hub.respondToPermission(coordinatorId, askRefuse()!.id, "reject");
    expect((await refusedReq).status).toBe(400);
    expect(store.listThreads().some((t) => t.taskKey === "refuse")).toBe(false);

    // 2. Picking « Lancer en supervisé » launches the team in supervised mode.
    // The request shows the start of the task as it is written, code included, and is cut
    // between two characters: here an emoji sits where the cut falls.
    const start = "Lance `pnpm test` puis ```git push --force``` et range".padEnd(78, ".");
    const supReq = post(tokens[0]!, {
      tool: "start_team",
      args: { task_key: "sup", task: `${start}😀 puis le reste` },
    });
    await soon(askRefuse).toBeTruthy();
    expect(askRefuse()).toMatchObject({
      title: `Lancer l'équipe en accès complet : ${start}…`,
    });
    hub.respondToPermission(coordinatorId, askRefuse()!.id, "supervised");
    const supRes = (await (await supReq).json()) as { result: { opened: { id: string } } };
    expect(store.getThread(supRes.result.opened.id)!.team).toMatchObject({
      coders: 2,
      permissionMode: "supervised",
    });

    // 3. Picking « Autoriser en accès complet » launches the team in full mode with that single click.
    await release();
    await hold();
    const approvedReq = post(tokens[0]!, {
      tool: "start_team",
      args: { task_key: "gros", task: "Refais tout" },
    });
    await soon(askRefuse).toBeTruthy();
    hub.respondToPermission(coordinatorId, askRefuse()!.id, "full");
    const team = (await (await approvedReq).json()) as {
      result?: { opened: { id: string }; already_open?: boolean };
    };
    const lead = store.getThread(team.result!.opened.id)!;
    expect(lead).toMatchObject({ role: "lead", openedBy: coordinatorId, taskKey: "gros" });
    expect(lead.team).toMatchObject({ coders: 2, permissionMode: "full" });
    expect(lead.team!.task).toContain("Refais tout");
    expect(
      (await call("start_team", { task_key: "gros", task: "Refais tout" })).result,
    ).toMatchObject({ already_open: true });

    // Once the user explicitly puts the coordinator in full mode, start_team runs autonomously 24/7
    // without asking for confirmation.
    hub.setPermissionMode(coordinatorId, "full");
    const fullTeam = await call("start_team", { task_key: "complet", task: "Mode complet" });
    expect(store.getThread(fullTeam.result!.opened.id)!.team).toMatchObject({
      coders: 2,
      permissionMode: "full",
    });
    for (const t of store.listThreads().filter((t) => t.role === "lead")) {
      await hub.handle(client, { type: "team.stop", threadId: t.id });
    }
  }, 40_000);

  it("ignores any legacy user MCP server named moonagentic on coordinator threads", async () => {
    const { store, say } = await coordinated();
    // Simulate a pre-hardening database that already saved a user MCP server called "moonagentic".
    store.setSetting("mcpServers", [
      {
        id: "legacy-collision",
        name: "MoonAgentic",
        enabled: true,
        transport: { type: "stdio", command: "false", args: [], env: [] },
      },
    ]);
    // The real internal bridge still wins with no duplicate shadowing.
    expect(await say("/fils")).toBe("Ce projet a 0 fil.");
  });

  it("keeps the threads past what it may run at once in line, and starts them as places free", async () => {
    const { hub, store, tokens, post, say, hold } = await coordinated();
    const client: Client = { send: () => undefined };
    await hub.handle(client, { type: "coordinator.setParallel", parallel: 1 });
    await say("/fils");
    await hold();
    const open = async (key: string) =>
      (
        (await (
          await post(tokens[0]!, {
            tool: "open_thread",
            args: { task_key: key, title: key, brief: `Fais ${key}` },
          })
        ).json()) as { result: { opened: { id: string; state: string }; in_line?: string } }
      ).result;
    // Opened in the coordinator's mode, the first one waits for a permission: at work.
    const first = await open("un");
    expect(first.in_line).toBeUndefined();
    const second = await open("deux");
    expect(second.in_line).toBeTruthy();
    expect(second.opened.state).toBe("en file");
    // In line: it exists, with its brief kept, and nothing was sent to its agent.
    expect(store.getThread(second.opened.id)!.held).toContain("Fais deux");
    expect(store.listItems(second.opened.id)).toHaveLength(0);

    // In sight with the threads at work, not folded away with the idle ones.
    expect(threadGroup(store.getThread(second.opened.id)!)).toBe("running");
    // A message for it joins its brief: it neither starts early nor plays its brief twice.
    const added = (await (
      await post(tokens[0]!, {
        tool: "message_thread",
        args: { thread_id: second.opened.id, text: "Et pense aux tests" },
      })
    ).json()) as { result: { queued_for?: string } };
    expect(added.result.queued_for).toBeTruthy();
    expect(store.listItems(second.opened.id)).toHaveLength(0);
    expect(store.getThread(second.opened.id)!.held).toContain("Et pense aux tests");
    // A third waits behind it. One more place in the settings: the oldest in line takes it,
    // with its brief and the message that joined it, played once.
    const third = await open("trois");
    expect(third.in_line).toBeTruthy();
    await hub.handle(client, { type: "coordinator.setParallel", parallel: 2 });
    await soon(() => store.getThread(second.opened.id)!.held).toBeUndefined();
    expect(store.listItems(second.opened.id)[0]).toMatchObject({
      kind: "user",
      text: expect.stringContaining("Et pense aux tests"),
    });
    expect(store.getThread(third.opened.id)!.held).toBeTruthy();

    // The first one ends: the third starts by itself.
    await soon(() => store.getThread(first.opened.id)!.status).toBe("waiting");
    await hub.cancel(first.opened.id);
    await hub.whenIdle(first.opened.id);
    await soon(() => store.getThread(third.opened.id)!.held).toBeUndefined();
    await soon(() => store.getThread(second.opened.id)!.status).toBe("waiting");
    await hub.cancel(second.opened.id);
    await hub.whenIdle(second.opened.id);
    // Its brief was played once: nothing is left to play when its own turn ends.
    expect(store.listItems(second.opened.id).filter((i) => i.kind === "user")).toHaveLength(1);
    await soon(() => store.getThread(third.opened.id)!.status).toBe("waiting");
    await hub.cancel(third.opened.id);
    await hub.whenIdle(third.opened.id);
  }, 90_000);

  it("gives the place of a team that stops to the next thread in line", async () => {
    const { hub, store, projectId, tokens, post, say, hold } = await coordinated();
    const client: Client = { send: () => undefined };
    const member = { agentId: "demo" };
    // A team started by hand, to be the one a coordinator starts; then out of the way.
    await hub.handle(client, {
      type: "team.start",
      requestId: "r",
      projectId,
      task: "À la main",
      lead: member,
      coder: member,
      coders: 1,
      permissionMode: "supervised",
    });
    for (const t of store.listThreads().filter((t) => t.role === "lead")) {
      await hub.handle(client, { type: "team.stop", threadId: t.id });
    }
    await hub.handle(client, { type: "coordinator.setParallel", parallel: 1 });
    await say("/fils");
    await hold();
    const call = async (tool: string, args: unknown) =>
      (
        (await (await post(tokens[0]!, { tool, args })).json()) as {
          result: { opened: { id: string } };
        }
      ).result.opened.id;
    const lead = await call("start_team", { task_key: "gros", task: "Refais tout" });
    const next = await call("open_thread", { task_key: "petit", title: "Petit", brief: "Fais" });
    expect(store.getThread(next)!.held).toBeTruthy();
    // The team's last turn is a member's, or none: the line still moves when it stops.
    await hub.handle(client, { type: "team.stop", threadId: lead });
    await soon(() => store.getThread(next)!.held).toBeUndefined();
    await soon(() => store.getThread(next)!.status).toBe("waiting");
    await hub.cancel(next);
    await hub.whenIdle(next);
  }, 90_000);
});

describe("a project", () => {
  it("is pinned for every window, and forgotten once removed", async () => {
    const { hub, projectId, otherId } = await coordinated();
    const sent: unknown[] = [];
    const client: Client = { send: (m) => sent.push(m) };
    await hub.handle(client, { type: "project.setPinned", projectId: otherId, pinned: true });
    const pinned = () =>
      hub
        .snapshot()
        .projects.filter((p) => p.pinned)
        .map((p) => p.id);
    expect(pinned()).toEqual([otherId]);
    await hub.handle(client, { type: "project.setPinned", projectId, pinned: true });
    await hub.handle(client, { type: "project.setPinned", projectId: otherId, pinned: false });
    expect(pinned()).toEqual([projectId]);
  });

  it("marks a thread unread when its agent answers with no window on it", async () => {
    const { hub, store, projectId } = await coordinated();
    const client: Client = { send: () => undefined };
    hub.connect(client);
    const start = (text: string) =>
      hub.createThread({ projectId, agentId: "demo", permissionMode: "full", text });
    const away = start("Dis bonjour");
    await hub.whenIdle(away);
    expect(store.getThread(away)!.unread).toBe(true);
    // Opened, it is read; answered while a window shows it, it stays read.
    await hub.handle(client, { type: "thread.open", threadId: away });
    expect(store.getThread(away)!.unread).toBeFalsy();
    await hub.handle(client, { type: "thread.send", threadId: away, text: "Encore" });
    await hub.whenIdle(away);
    expect(store.getThread(away)!.unread).toBeFalsy();
    // Left, then answered again: unread once more.
    await hub.handle(client, { type: "thread.leave", threadId: away });
    await hub.handle(client, { type: "thread.send", threadId: away, text: "Et encore" });
    await hub.whenIdle(away);
    expect(store.getThread(away)!.unread).toBe(true);

    // By hand, one thread or the whole project.
    const other = start("Dis au revoir");
    await hub.whenIdle(other);
    await hub.handle(client, { type: "project.markRead", projectId });
    expect(store.listThreads().some((t) => t.unread)).toBe(false);
    await hub.handle(client, { type: "thread.setUnread", threadId: other, unread: true });
    expect(store.getThread(other)!.unread).toBe(true);
  });

  it("tells in its conversation what a thread it opened has finished, in the thread's own words", async () => {
    const { hub, store, coordinatorId, say } = await coordinated();
    await say("/ouvre Export Safari");
    const opened = store.listThreads().find((t) => t.openedBy === coordinatorId)!;
    const results = () => store.listItems(coordinatorId).filter((i) => i.kind === "result");
    // It waits on the user: nothing is finished, nothing is told.
    await soon(() => store.getThread(opened.id)!.status).toBe("waiting");
    expect(results()).toHaveLength(0);
    const asked = store.listItems(opened.id).findLast((i) => i.kind === "permission")!;
    hub.respondToPermission(opened.id, asked.id, "allow");
    await soon(() => results().length).toBe(1);
    const told = results()[0]!;
    if (told.kind !== "result") throw new Error("unreachable");
    expect(told).toMatchObject({ threadId: opened.id, title: "Export Safari" });
    const answers = store.listItems(opened.id).filter((i) => i.kind === "agent");
    const last = answers.at(-1)!;
    if (last.kind !== "agent") throw new Error("unreachable");
    expect(last.text.replace(/\s+/g, " ")).toContain(told.summary.replace(/…$/, "").slice(0, 40));
    expect(told.files).toEqual((await hub.review(opened.id)).files.map((f) => f.path));

    // What the user asks the thread themselves is answered there: it is not told again.
    await hub.whenIdle(opened.id);
    hub.send(opened.id, "Dis bonjour");
    await soon(() => store.getThread(opened.id)!.status).not.toBe("running");
    await hub.cancel(opened.id);
    await hub.whenIdle(opened.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(results()).toHaveLength(1);
  }, 90_000);

  it("opens its next threads with the agent and model the user last gave one by hand", async () => {
    const { hub, store, coordinatorId, say } = await coordinated();
    const client: Client = { send: () => undefined };
    await say("/ouvre Export Safari");
    const first = store.listThreads().find((t) => t.openedBy === coordinatorId)!;
    await soon(() => store.getThread(first.id)!.status).toBe("waiting");
    await hub.cancel(first.id);
    await hub.whenIdle(first.id);
    const back = store.getThread(first.id)!.model ?? "";
    const other = hub
      .snapshot()
      .agents.find((a) => a.id === "demo")!
      .models!.find((m) => m.id !== store.getThread(first.id)!.model)!;
    await hub.handle(client, { type: "thread.setModel", threadId: first.id, model: other.id });
    expect(hub.snapshot().coordinator.routes.default).toEqual({ agentId: "demo", model: other.id });

    await say("/ouvre Import CSV");
    const second = store
      .listThreads()
      .find((t) => t.openedBy === coordinatorId && t.id !== first.id)!;
    expect(second.model).toBe(other.id);
    // A thread the user opened themselves is no word on what coordinators should use.
    const own = hub.createThread({
      projectId: second.projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Dis bonjour",
    });
    await hub.whenIdle(own);
    await hub.handle(client, { type: "thread.setModel", threadId: own, model: back || other.id });
    expect(hub.snapshot().coordinator.routes.default?.model).toBe(other.id);
  }, 90_000);
});
