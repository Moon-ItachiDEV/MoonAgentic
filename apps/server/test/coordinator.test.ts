import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { threadGroup, WORK_KINDS } from "@moonagentic/protocol";
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
      text: "Corrige : Export Safari\n\n---\nMessage d'origine de l'utilisateur, transmis tel quel par MoonAgentic :\n\n> /ouvre Export Safari",
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

  it("sends each kind of work where the settings say, and starts the team the user set up", async () => {
    const { hub, store, projectId, coordinatorId, tokens, post, say, hold } = await coordinated();
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
    // A kind with no route keeps the coordinator's own agent.
    const other = await call("open_thread", {
      task_key: "t",
      title: "T",
      brief: "B",
      kind: "tests",
    });
    expect(store.getThread(other.result!.opened.id)).toMatchObject({ agentId: "demo" });

    // No team was ever set up: it says so rather than making one up.
    expect((await call("start_team", { task_key: "gros", task: "Refais tout" })).error).toContain(
      "Aucune équipe",
    );
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
    const team = await call("start_team", { task_key: "gros", task: "Refais tout" });
    const lead = store.getThread(team.result!.opened.id)!;
    expect(lead).toMatchObject({ role: "lead", openedBy: coordinatorId, taskKey: "gros" });
    expect(lead.team).toMatchObject({ coders: 2, permissionMode: "full" });
    expect(lead.team!.task).toContain("Refais tout");
    expect(
      (await call("start_team", { task_key: "gros", task: "Refais tout" })).result,
    ).toMatchObject({ already_open: true });
    for (const t of store.listThreads().filter((t) => t.role === "lead")) {
      await hub.handle(client, { type: "team.stop", threadId: t.id });
    }
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
      permissionMode: "full",
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
