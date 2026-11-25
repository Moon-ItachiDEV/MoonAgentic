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
  return {
    hub,
    store,
    client,
    projectA,
    projectB,
    post,
    lastReply,
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

  it("shares project memory across worktrees on fresh sessions only, enforces size limit, respects locks, and cleans up on project removal", async () => {
    const { hub, store, client, projectA, projectB, post, lastReply, latestToken } = await setup();

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
    const overflow = await post(holderToken, {
      tool: "save_memory",
      args: { mode: "append", content: "x".repeat(MAX_PROJECT_MEMORY) },
    });
    expect(overflow.status).toBe(400);
    expect(((await overflow.json()) as { error: string }).error).toContain("condense-la");
    expect(
      (
        await post(holderToken, {
          tool: "save_memory",
          args: { mode: "replace", content: "- Résumé condensé" },
        })
      ).status,
    ).toBe(200);
    expect(store.getProjectMemory(projectA).text).toBe("- Résumé condensé");
    expect(
      (
        await post(holderToken, {
          tool: "save_memory",
          args: { mode: "replace", content: "" },
        })
      ).status,
    ).toBe(200);
    expect(store.getProjectMemory(projectA).text).toBe("");
    await hub.cancel(supervisedHolder);
    await hub.whenIdle(supervisedHolder);

    // Locking the project immediately revokes bridge access (401).
    expect((await post(tokenA, { tool: "read_memory" })).status).toBe(200);
    await hub.handle(client, { type: "lock.setPin", requestId: "p1", pin: "123456" });
    await hub.handle(client, { type: "lock.project", requestId: "p2", projectId: projectA });
    expect((await post(tokenA, { tool: "read_memory" })).status).toBe(401);
    expect((await post(tokenA, { tool: "list_threads" })).status).toBe(401);
    await hub.handle(client, {
      type: "lock.unlock",
      requestId: "p3",
      projectId: projectA,
      pin: "123456",
    });
    expect((await post(tokenA, { tool: "read_memory" })).status).toBe(200);

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
});
