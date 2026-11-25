import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_PROJECT_MEMORY } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { COORDINATOR_PATH, READONLY_THREAD_TOOLS, THREAD_TOOLS } from "../src/coordinator-tools.ts";
import { createHttpServer } from "../src/http.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-memory-"));
  repoAt(path.join(root, "a"));
  repoAt(path.join(root, "b"));
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    // « Discussions » is made beside the projects, not in the real home folder.
    homeDir: root,
  });
  const tokensByThread = new Map<string, string>();
  const origCall = hub.coordinatorCall.bind(hub);
  hub.coordinatorCall = (token, tool, args, signal) => origCall(token, tool, args, signal);
  const origExchange = hub.coordinatorExchange.bind(hub);
  hub.coordinatorExchange = (bootstrap) => {
    const token = origExchange(bootstrap);
    tokensByThread.set(bootstrap, token);
    return token;
  };
  const server = createHttpServer({ hub, token: "app-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const projectA = hub.createProject("a", path.join(root, "a"));
  const projectB = hub.createProject("b", path.join(root, "b"));
  const client: Client = { send: () => undefined };
  const post = (token: string, body: unknown) =>
    fetch(`${origin}${COORDINATOR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const lastReply = (threadId: string) => {
    const items = store.listItems(threadId);
    const start = items.findLastIndex((i) => i.kind === "user");
    return items
      .slice(start + 1)
      .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
      .join("\n");
  };
  /** The request to write the memory that waits on the thread, once it is there. */
  const memoryAsk = async (threadId: string) => {
    const waiting = () =>
      store
        .listItems(threadId)
        .findLast(
          (i) => i.kind === "permission" && i.outcome === null && /mémoire du projet/.test(i.title),
        );
    await soon(waiting).toBeTruthy();
    return waiting() as Extract<ReturnType<typeof waiting>, { kind: "permission" }>;
  };
  const lock = async (projectId: string) => {
    if (!hub.locks.hasPin()) {
      await hub.handle(client, { type: "lock.setPin", requestId: "pin", pin: "123456" });
    }
    await hub.handle(client, { type: "lock.project", requestId: "lock", projectId });
  };
  const unlock = (projectId: string) =>
    hub.handle(client, { type: "lock.unlock", requestId: "unlock", projectId, pin: "123456" });
  return {
    hub,
    store,
    client,
    projectA,
    projectB,
    post,
    lastReply,
    memoryAsk,
    lock,
    unlock,
    latestToken: () => [...tokensByThread.values()].at(-1)!,
  };
}

describe("project shared memory & cross-thread context", () => {
  it("gives regular threads read-only project context + memory tools, never coordinator write tools", async () => {
    const { hub, store, client, projectA, projectB, post, lastReply, latestToken } = await setup();

    // Seed past threads in project A and an unrelated thread in project B.
    const pastA = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      title: "Export Safari",
      text: "On corrige le bug d'export PDF sur Safari avec WebKit.",
    });
    await hub.whenIdle(pastA);

    const otherB = hub.createThread({
      projectId: projectB,
      agentId: "demo",
      permissionMode: "full",
      title: "Secret projet B",
      text: "Information secrète sur Safari dans un autre projet.",
    });
    await hub.whenIdle(otherB);

    // Open a regular thread in project A and inspect its bridge tools.
    const threadA = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      text: "/mcp-outils",
    });
    await hub.whenIdle(threadA);
    expect(lastReply(threadA)).toBe(THREAD_TOOLS.map((t) => t.name).join(", "));

    // It can search project A threads with multi-word queries and never sees project B.
    await hub.handle(client, {
      type: "thread.send",
      threadId: threadA,
      text: "/cherche webkit export",
    });
    await hub.whenIdle(threadA);
    const hits = JSON.parse(lastReply(threadA)) as {
      thread_id: string;
      title: string;
      matches: { snippet: string }[];
    }[];
    expect(hits.map((h) => h.thread_id)).toEqual([pastA]);
    expect(hits[0]!.matches[0]!.snippet).toMatch(/Safari|WebKit|export/i);
    expect(lastReply(threadA)).not.toContain(otherB);

    // Even using its real bridge token directly over HTTP:
    const tokenA = latestToken();
    // 1. list_threads marks its own thread with current: true and excludes project B.
    const listed = (await (await post(tokenA, { tool: "list_threads" })).json()) as {
      result: { id: string; current?: boolean }[];
    };
    expect(listed.result.map((t) => t.id).sort()).toEqual([pastA, threadA].sort());
    expect(listed.result.find((t) => t.id === threadA)?.current).toBe(true);
    expect(listed.result.find((t) => t.id === pastA)?.current).toBeUndefined();

    // search_threads with include_current: true finds the caller's own thread too.
    const withSelf = (await (
      await post(tokenA, {
        tool: "search_threads",
        args: { query: "webkit export", include_current: true },
      })
    ).json()) as { result: { thread_id: string; current?: boolean }[] };
    expect(withSelf.result.map((r) => r.thread_id).sort()).toEqual([pastA, threadA].sort());
    expect(withSelf.result.find((r) => r.thread_id === threadA)?.current).toBe(true);

    // 2. read_thread supports pagination (offset + limit) and rejects project B.
    store.putItem(pastA, {
      id: "u-extra-1",
      kind: "user",
      text: "Message numéro 3",
      at: Date.now() + 1,
    });
    store.putItem(pastA, {
      id: "a-extra-1",
      kind: "agent",
      text: "Réponse numéro 4",
      at: Date.now() + 2,
    });
    const firstPage = (await (
      await post(tokenA, {
        tool: "read_thread",
        args: { thread_id: pastA, offset: 0, limit: 2 },
      })
    ).json()) as {
      result: { total_messages: number; showing_from?: number; last_messages: { text: string }[] };
    };
    expect(firstPage.result.total_messages).toBe(5);
    expect(firstPage.result.showing_from).toBe(0);
    expect(firstPage.result.last_messages).toHaveLength(2);
    expect(firstPage.result.last_messages[0]!.text).toContain("bug d'export PDF");

    const secondPage = (await (
      await post(tokenA, {
        tool: "read_thread",
        args: { thread_id: pastA, offset: 3, limit: 2 },
      })
    ).json()) as {
      result: { total_messages: number; showing_from?: number; last_messages: { text: string }[] };
    };
    expect(secondPage.result.showing_from).toBe(3);
    expect(secondPage.result.last_messages.map((m) => m.text)).toEqual([
      "Message numéro 3",
      "Réponse numéro 4",
    ]);

    const crossProject = await post(tokenA, {
      tool: "read_thread",
      args: { thread_id: otherB },
    });
    expect(crossProject.status).toBe(400);
    expect(((await crossProject.json()) as { error: string }).error).toContain("n'existe pas");

    // 3. Coordinator-only write tools are strictly refused server-side.
    for (const tool of ["open_thread", "start_team", "message_thread", "resolve_thread"]) {
      const denied = await post(tokenA, {
        tool,
        args: { thread_id: pastA, task_key: "k", title: "T", brief: "B", task: "T", text: "x" },
      });
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toContain("coordinateur");
    }

    // 4. save_memory is refused once the turn has ended.
    const lateSave = await post(tokenA, {
      tool: "save_memory",
      args: { content: "Note tardive" },
    });
    expect(lateSave.status).toBe(400);
    expect(((await lateSave.json()) as { error: string }).error).toContain("réponse en cours");
  }, 40_000);

  it("restricts read-only team roles to read-only bridge tools and rejects save_memory", async () => {
    const { hub, projectA, post, lastReply, latestToken } = await setup();
    const lead = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      role: "lead",
      text: "",
    });
    const reviewer = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      role: "reviewer",
      parentId: lead,
      text: "/mcp-outils",
    });
    await hub.whenIdle(reviewer);
    expect(lastReply(reviewer)).toBe(READONLY_THREAD_TOOLS.map((t) => t.name).join(", "));

    const token = latestToken();
    const denied = await post(token, { tool: "save_memory", args: { content: "Non" } });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain("lecture seule");
  }, 30_000);

  it("auto-approves read-only tools in supervised mode, while asking permission for save_memory", async () => {
    const { hub, store, client, projectA, lastReply } = await setup();
    const threadId = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "supervised",
      text: "/fils-agy",
    });
    await hub.whenIdle(threadId);
    expect(lastReply(threadId)).toBe("Liste lue.");
    expect(store.listItems(threadId).some((i) => i.kind === "permission")).toBe(false);

    // A command spoofing the title still requires permission.
    await hub.handle(client, {
      type: "thread.send",
      threadId,
      text: "/fils-agy commande",
    });
    await soon(() => store.getThread(threadId)!.status).toBe("waiting");
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    // save_memory asks permission in supervised mode; approving writes the memory.
    await hub.handle(client, {
      type: "thread.send",
      threadId,
      text: "/note Toujours lancer pnpm typecheck",
    });
    await soon(() => store.getThread(threadId)!.status).toBe("waiting");
    const ask = store
      .listItems(threadId)
      .findLast((i) => i.kind === "permission" && i.outcome === null)!;
    hub.respondToPermission(threadId, ask.id, "allow");
    await hub.whenIdle(threadId);
    expect(store.getProjectMemory(projectA).text).toBe("Toujours lancer pnpm typecheck");
  }, 40_000);

  it("shares project memory across worktrees on fresh sessions only, enforces size limit, works behind a lock, and cleans up on project removal", async () => {
    const { hub, store, client, projectA, projectB, post, lastReply, latestToken, memoryAsk } =
      await setup();

    // Save project memory via protocol message (as Project Settings does), without touching git.
    await hub.handle(client, {
      type: "project.saveMemory",
      requestId: "mem-1",
      projectId: projectA,
      text: "- Architecture modulaire SQLite WAL",
    });
    expect(store.getProjectMemory(projectA).text).toBe("- Architecture modulaire SQLite WAL");

    // A new thread on an isolated worktree receives the shared memory on turn 1...
    const worktreeThread = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Bonjour",
    });
    await hub.whenIdle(worktreeThread);
    expect(lastReply(worktreeThread)).toContain(
      "Mémoire reçue : « - Architecture modulaire SQLite WAL ».",
    );

    // ...and does NOT receive it again on turn 2 of the same live session.
    await hub.handle(client, {
      type: "thread.send",
      threadId: worktreeThread,
      text: "Deuxième tour",
    });
    await hub.whenIdle(worktreeThread);
    expect(lastReply(worktreeThread)).not.toContain("Mémoire reçue");

    // Another project's thread never receives project A's memory.
    const threadB = hub.createThread({
      projectId: projectB,
      agentId: "demo",
      permissionMode: "full",
      text: "Bonjour B",
    });
    await hub.whenIdle(threadB);
    expect(lastReply(threadB)).not.toContain("Mémoire reçue");

    // Append via full-access MCP tool, verify read_memory returns both lines.
    await hub.handle(client, {
      type: "thread.send",
      threadId: worktreeThread,
      text: "/note - Tester Linux et Windows",
    });
    await hub.whenIdle(worktreeThread);
    await hub.handle(client, {
      type: "thread.send",
      threadId: worktreeThread,
      text: "/memoire",
    });
    await hub.whenIdle(worktreeThread);
    const read = JSON.parse(lastReply(worktreeThread)) as { memory: string; max_bytes: number };
    expect(read.memory).toBe("- Architecture modulaire SQLite WAL\n- Tester Linux et Windows");
    expect(read.max_bytes).toBe(MAX_PROJECT_MEMORY);

    // Hold a turn open to verify replace mode, overflow guidance, and clearing over HTTP.
    const tokenA = latestToken();
    const supervisedHolder = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "supervised",
      text: "/fils",
    });
    await hub.whenIdle(supervisedHolder);
    const holderToken = latestToken();
    await hub.handle(client, {
      type: "thread.send",
      threadId: supervisedHolder,
      text: "Modifie le fichier",
    });
    await soon(() => store.getThread(supervisedHolder)!.status).toBe("waiting");
    // What does not fit is refused at once, before the user is asked anything.
    const overflow = await post(holderToken, {
      tool: "save_memory",
      args: { mode: "append", content: "x".repeat(MAX_PROJECT_MEMORY) },
    });
    expect(overflow.status).toBe(400);
    expect(((await overflow.json()) as { error: string }).error).toContain("condense-la");
    // The thread is supervised: the user agrees to each write, which says what it does.
    const replacing = post(holderToken, {
      tool: "save_memory",
      args: { mode: "replace", content: "- Résumé condensé" },
    });
    const replaceAsk = await memoryAsk(supervisedHolder);
    expect(replaceAsk.title).toBe("Remplacer la mémoire du projet par : - Résumé condensé");
    hub.respondToPermission(supervisedHolder, replaceAsk.id, "allow");
    expect((await replacing).status).toBe(200);
    expect(store.getProjectMemory(projectA).text).toBe("- Résumé condensé");
    const clearing = post(holderToken, {
      tool: "save_memory",
      args: { mode: "replace", content: "" },
    });
    const clearAsk = await memoryAsk(supervisedHolder);
    expect(clearAsk.title).toBe("Vider la mémoire du projet");
    hub.respondToPermission(supervisedHolder, clearAsk.id, "allow");
    expect((await clearing).status).toBe(200);
    expect(store.getProjectMemory(projectA).text).toBe("");
    await hub.cancel(supervisedHolder);
    await hub.whenIdle(supervisedHolder);

    // A lock hides the project from the app, and stops nothing: its agents keep their tools.
    expect((await post(tokenA, { tool: "read_memory" })).status).toBe(200);
    await hub.handle(client, { type: "lock.setPin", requestId: "p1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "p2", projectId: projectA });
    expect((await post(tokenA, { tool: "read_memory" })).status).toBe(200);
    expect((await post(tokenA, { tool: "list_threads" })).status).toBe(200);
    // The app itself gets nothing of it meanwhile.
    await expect(
      hub.handle(client, { type: "project.setup", requestId: "p-setup", projectId: projectA }),
    ).rejects.toThrow(/verrouillé/);
    await hub.handle(client, {
      type: "lock.unlock",
      requestId: "p3",
      projectId: projectA,
      pin: "123456",
    });

    // Over-limit memory is rejected by Store.
    expect(() => store.setProjectMemory(projectA, "a".repeat(MAX_PROJECT_MEMORY + 1))).toThrow(
      /trop longue/,
    );

    // Removing the project cleans up its stored memory.
    store.setProjectMemory(projectA, "- À supprimer avec le projet");
    expect(store.getProjectMemory(projectA).text).toBe("- À supprimer avec le projet");
    await hub.removeProject(projectA);
    expect(store.getProjectMemory(projectA).text).toBe("");
  }, 60_000);

  it("leaves a coordinator its tools when its project is locked while it works", async () => {
    const { hub, store, client, projectA, post, lock } = await setup();
    const coordinatorId = hub.openCoordinator(projectA, "demo");
    const tokens: string[] = [];
    const call = hub.coordinatorCall.bind(hub);
    hub.coordinatorCall = (token, tool, args, signal) => {
      tokens.push(token);
      return call(token, tool, args, signal);
    };
    await hub.handle(client, { type: "thread.send", threadId: coordinatorId, text: "/fils" });
    await hub.whenIdle(coordinatorId);
    // Its turn is under way, its agent waiting for a permission, when the user locks the project.
    await hub.handle(client, { type: "thread.send", threadId: coordinatorId, text: "Regarde" });
    await soon(() => store.getThread(coordinatorId)!.status).toBe("waiting");
    cleanups.unshift(async () => {
      await hub.cancel(coordinatorId);
      await hub.whenIdle(coordinatorId);
    });
    await lock(projectA);
    const opened = await post(tokens[0]!, {
      tool: "open_thread",
      args: { task_key: "export", title: "Export Safari", brief: "Corrige l'export" },
    });
    expect(opened.status).toBe(200);
    expect(store.listThreads().some((t) => t.openedBy === coordinatorId)).toBe(true);
  }, 40_000);

  it("gives its tools to a session started behind a lock, and keeps them once it is opened", async () => {
    const { hub, store, client, projectA, lastReply, lock, unlock } = await setup();
    store.setProjectMemory(projectA, "- Toujours lancer pnpm test");
    await lock(projectA);
    // As a scheduled task, a team's member or a thread waiting in line starts: no window asks.
    const id = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      text: "/memoire",
      auto: true,
    });
    await hub.whenIdle(id);
    expect(lastReply(id)).toContain("Toujours lancer pnpm test");
    await unlock(projectA);
    await hub.handle(client, { type: "thread.send", threadId: id, text: "/memoire" });
    await hub.whenIdle(id);
    expect(lastReply(id)).toContain("Toujours lancer pnpm test");
  }, 40_000);

  it("does not count a locked project's calls against the other projects' bridges", async () => {
    const { hub, projectA, projectB, post, lock, latestToken } = await setup();
    const tokenOf = async (projectId: string) => {
      const id = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "/fils",
      });
      await hub.whenIdle(id);
      return latestToken();
    };
    const tokenA = await tokenOf(projectA);
    const tokenB = await tokenOf(projectB);
    expect(tokenB).not.toBe(tokenA);
    await lock(projectA);
    // More calls than the wrong tokens one address may send in a minute.
    for (let i = 0; i < 25; i += 1) {
      expect((await post(tokenA, { tool: "read_memory" })).status).toBe(200);
    }
    expect((await post(tokenB, { tool: "list_threads" })).status).toBe(200);
  }, 40_000);

  it("finds every thread that names the words, however often another names them", async () => {
    const { hub, store, client, projectA, post, latestToken } = await setup();
    // An older thread where the decision was taken, which then moved on to something else.
    const old = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      title: "Ancien sujet",
      text: "Décision : on garde zustand pour le store du panier.",
    });
    await hub.whenIdle(old);
    await hub.handle(client, { type: "thread.send", threadId: old, text: "Merci" });
    await hub.whenIdle(old);
    const named = store.getThread(old)!;
    expect(`${named.title} ${named.summary}`).not.toMatch(/zustand/i);
    // A recent, long thread that names the same word in every message.
    const chatty = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      title: "Sujet récent",
      text: "Bonjour",
    });
    await hub.whenIdle(chatty);
    for (let i = 0; i < 45; i += 1) {
      store.putItem(chatty, {
        id: `bavard-${i}`,
        kind: i % 2 ? "agent" : "user",
        text: `Étape ${i} : encore un point sur zustand.`,
        at: Date.now() + i,
      });
    }
    const caller = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "full",
      text: "/fils",
    });
    await hub.whenIdle(caller);
    const search = async (args: Record<string, unknown>) =>
      (
        (await (await post(latestToken(), { tool: "search_threads", args })).json()) as {
          result: { thread_id: string; matches: { snippet: string }[] }[];
        }
      ).result;
    const found = await search({ query: "zustand" });
    // The thread that named it last comes first, with its latest messages only.
    expect(found.map((r) => r.thread_id)).toEqual([chatty, old]);
    expect(found[0]!.matches.map((m) => m.snippet.match(/tape (\d+) :/)?.[1])).toEqual([
      "44",
      "43",
      "42",
    ]);
    expect(found[1]!.matches[0]!.snippet).toContain("on garde zustand");
    // Asked for one thread only, it is the one that named it last.
    expect((await search({ query: "zustand", limit: 1 })).map((r) => r.thread_id)).toEqual([
      chatty,
    ]);
    // Every word must be in the message, in any order.
    expect((await search({ query: "panier zustand" })).map((r) => r.thread_id)).toEqual([old]);
  }, 40_000);

  it("shares neither memory nor threads between conversations outside any project", async () => {
    const { hub, store, client, lastReply } = await setup();
    const discussions = hub.discussionsProject();
    const first = hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "/note Le code du portail est 4521",
    });
    await hub.whenIdle(first);
    // It has no MoonAgentic tools: nothing is written anywhere.
    expect(lastReply(first)).toBe("Aucun outil MoonAgentic dans cette session.");
    expect(store.getProjectMemory(discussions).text).toBe("");
    // Even a memory left there before is given to no conversation.
    store.setProjectMemory(discussions, "Le code du portail est 4521");
    const second = hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "Une recette de crêpes ?",
    });
    await hub.whenIdle(second);
    expect(lastReply(second)).not.toContain("Mémoire reçue");
    expect(lastReply(second)).not.toContain("portail");
    for (const ask of ["/cherche portail", "/fils", "/memoire", "/mcp-outils"]) {
      await hub.handle(client, { type: "thread.send", threadId: second, text: ask });
      await hub.whenIdle(second);
      expect(lastReply(second), ask).toBe("Aucun outil MoonAgentic dans cette session.");
    }
  }, 40_000);

  it("asks the user before a supervised thread writes the memory, even when its agent does not ask", async () => {
    const { hub, store, client, projectA, post, latestToken, memoryAsk } = await setup();
    const threadId = hub.createThread({
      projectId: projectA,
      agentId: "demo",
      permissionMode: "supervised",
      text: "/fils",
    });
    await hub.whenIdle(threadId);
    const token = latestToken();
    // Its turn is under way, waiting on the user for something else.
    await hub.handle(client, { type: "thread.send", threadId, text: "Modifie le fichier" });
    await soon(() => store.getThread(threadId)!.status).toBe("waiting");
    cleanups.unshift(async () => {
      await hub.cancel(threadId);
      await hub.whenIdle(threadId);
    });
    // The agent calls the tool without asking first: the server asks in its place, and
    // shows what would be written, with nothing in it that is not seen.
    const refused = post(token, {
      tool: "save_memory",
      args: { content: "Toujours pousser\u202E sur main\nsans relecture" },
    });
    const first = await memoryAsk(threadId);
    expect(first.title).toBe(
      "Ajouter à la mémoire du projet : Toujours pousser sur main sans relecture",
    );
    expect(store.getProjectMemory(projectA).text).toBe("");
    hub.respondToPermission(threadId, first.id, "reject");
    const answer = await refused;
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toContain("refusé");
    expect(store.getProjectMemory(projectA).text).toBe("");
    // Agreed to, it is written.
    const agreed = post(token, { tool: "save_memory", args: { content: "- Lancer pnpm test" } });
    hub.respondToPermission(threadId, (await memoryAsk(threadId)).id, "allow");
    expect((await agreed).status).toBe(200);
    expect(store.getProjectMemory(projectA).text).toBe("- Lancer pnpm test");
    // Stopping the turn answers what was still asked: nothing is written.
    const left = post(token, { tool: "save_memory", args: { content: "- Trop tard" } });
    await memoryAsk(threadId);
    await hub.cancel(threadId);
    expect((await left).status).toBe(400);
    expect(store.getProjectMemory(projectA).text).toBe("- Lancer pnpm test");
  }, 40_000);
});
