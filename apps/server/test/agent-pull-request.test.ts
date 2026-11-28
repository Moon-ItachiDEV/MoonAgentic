import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { toolsForBridgeMode } from "../src/coordinator-tools.ts";
import { setGithubAccount } from "../src/github-account.ts";
import { createHttpServer } from "../src/http.ts";
import { ARTIFACT_HINT, type Client, Hub, PULL_REQUEST_HINT } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { type ApiAnswer, type ApiCall, fakeGithubApi, signedInAccount } from "./fake-github-api.ts";
import { removeTempDir } from "./temp-dir.ts";

// Each test runs git a dozen times and several turns of an agent: slow on a Windows runner.
vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SLOW = { timeout: 30_000, interval: 50 };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

const PULL = "https://github.com/moon/demo/pull/7";

/**
 * A project whose remote reads as GitHub's but is pushed to a folder, a stand-in GitHub that
 * MoonAgentic is signed in to, and the server its agents' bridges call.
 */
async function setup(
  answer: (call: ApiCall, open: boolean) => ApiAnswer = (call, open) =>
    call.method === "GET" ? (open ? [{ html_url: PULL }] : []) : { html_url: PULL },
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-agent-pr-"));
  const repo = path.join(root, "repo");
  const bare = path.join(root, "remote.git");
  mkdirSync(repo);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", "https://github.com/moon/demo.git");
  // Read as GitHub's, pushed to the folder.
  git(repo, "config", "remote.origin.pushurl", bare);

  // GitHub knows the pull request once it was asked to open it.
  let open = false;
  const api = await fakeGithubApi((call) => {
    const said = answer(call, open);
    if (call.method === "POST" && call.path === "/repos/moon/demo/pulls") {
      const refused = typeof said === "object" && said !== null && "status" in said;
      if (!refused) open = true;
    }
    return said;
  });
  setGithubAccount(signedInAccount(api.url, "gho_moon"));

  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    pullRequests: () => ({ find: async () => undefined, merge: async () => undefined }),
    homeDir: root,
  });
  const server = createHttpServer({ hub, token: "app-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    setGithubAccount(undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
    await api.close();
    removeTempDir(root);
  });
  const projectId = hub.createProject("demo", repo);
  const client: Client = { send: () => undefined };
  /** A thread whose agent has started: `/consignes` makes it say what it was told. */
  const thread = async (over: Partial<Parameters<Hub["createThread"]>[0]> = {}) => {
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "/consignes",
      ...over,
    });
    await hub.whenIdle(threadId);
    return threadId;
  };
  const say = async (threadId: string, text: string) => {
    await hub.handle(client, { type: "thread.send", threadId, text });
    await hub.whenIdle(threadId);
  };
  const lastReply = (threadId: string) => {
    const items = store.listItems(threadId);
    return items
      .slice(items.findLastIndex((i) => i.kind === "user") + 1)
      .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
      .join("\n");
  };
  const workspace = (threadId: string) => store.getThread(threadId)!.workspace!;
  /** The commit GitHub has for the thread's branch, if it was pushed. */
  const pushed = (threadId: string) => {
    try {
      return git(bare, "rev-parse", `refs/heads/${workspace(threadId).branch}`);
    } catch {
      return undefined;
    }
  };
  /** The request to send the branch that waits on the thread, once it is there. */
  const sendAsk = async (threadId: string) => {
    const waiting = () =>
      store
        .listItems(threadId)
        .findLast(
          (i) =>
            i.kind === "permission" &&
            i.outcome === null &&
            i.title.startsWith("Pousser la branche"),
        );
    await expect.poll(waiting, SLOW).toBeTruthy();
    return waiting() as Extract<Item, { kind: "permission" }>;
  };
  const opened = () =>
    api.calls.filter((c) => c.method === "POST" && c.path === "/repos/moon/demo/pulls");
  return {
    hub,
    store,
    bare,
    client,
    projectId,
    thread,
    say,
    lastReply,
    workspace,
    pushed,
    sendAsk,
    opened,
  };
}

describe("a pull request opened by the thread's own agent", () => {
  it("is offered to threads that work, and to no other", () => {
    const has = (mode: Parameters<typeof toolsForBridgeMode>[0]) =>
      toolsForBridgeMode(mode).some((t) => t.name === "open_pull_request");
    expect(has("thread")).toBe(true);
    // A coordinator changes no file, a reviewer or a tester neither, and a conversation
    // outside any project has no branch.
    expect(has("coordinator")).toBe(false);
    expect(has("readonly")).toBe(false);
    expect(has("discussion")).toBe(false);
  });

  it("tells the agent of a thread with a branch of its own how to send it", async () => {
    const { hub, thread, lastReply, say } = await setup();
    const own = await thread();
    expect(lastReply(own)).toBe(`${ARTIFACT_HINT}\n\n${PULL_REQUEST_HINT}`);
    // Told once, as its agent starts.
    await say(own, "/consignes");
    expect(lastReply(own)).toBe("Aucune consigne.");
    // In the project's folder there is no branch to send: nothing is promised.
    const direct = await thread({ isolated: false });
    expect(lastReply(direct)).toBe(ARTIFACT_HINT);
    // Nor outside any project.
    const outside = await thread({ projectId: hub.discussionsProject(), isolated: false });
    expect(lastReply(outside)).toBe(ARTIFACT_HINT);
  });

  it("commits, pushes and opens it with MoonAgentic's own GitHub sign-in, while the agent answers", async () => {
    const { hub, store, bare, thread, say, lastReply, workspace, pushed, opened } = await setup();
    const threadId = await thread();
    const { path: tree, branch } = workspace(threadId);
    writeFileSync(path.join(tree, "README.md"), "# Demo\nune ligne de plus\n");
    writeFileSync(path.join(tree, "nouveau.txt"), "a\n");
    expect(pushed(threadId)).toBeUndefined();

    // The demo agent calls the tool in the middle of its turn, as a real agent does.
    await say(threadId, "/pr Corrige le README");
    const said = JSON.parse(lastReply(threadId)) as Record<string, string>;
    expect(said).toMatchObject({ branch, pushed: true, pull_request: PULL });
    expect(said.commit).toMatch(/^[0-9a-f]{40}$/);
    // Everything the agent changed is in one commit, on GitHub.
    expect(pushed(threadId)).toBe(said.commit);
    expect(git(bare, "log", "-1", "--format=%s", branch)).toBe("Corrige le README");
    expect(git(bare, "show", "--format=", "--name-only", branch).split("\n").sort()).toEqual([
      "README.md",
      "nouveau.txt",
    ]);
    expect(git(tree, "status", "--porcelain")).toBe("");
    // Asked of GitHub's API with the account's own token: no `gh` is involved.
    expect(opened()).toHaveLength(1);
    expect(opened()[0]).toMatchObject({
      auth: "Bearer gho_moon",
      body: {
        title: "Corrige le README",
        head: branch,
        base: "main",
        body: "Ouverte par l'agent de démonstration.",
      },
    });
    // The thread knows its pull request, as after « Envoyer » in the Code panel.
    expect(store.getThread(threadId)?.workspace).toMatchObject({ prUrl: PULL, prOpened: true });
    expect(store.getThread(threadId)?.status).toBe("idle");

    // Asked again after more work: the new commit goes to the same pull request.
    writeFileSync(path.join(tree, "nouveau.txt"), "a\nb\n");
    await say(threadId, "/pr Ajoute une ligne");
    const again = JSON.parse(lastReply(threadId)) as Record<string, string>;
    expect(again).toMatchObject({ pushed: true, pull_request: PULL });
    expect(pushed(threadId)).toBe(again.commit);
    expect(git(bare, "log", "-1", "--format=%s", branch)).toBe("Ajoute une ligne");
    expect(opened()).toHaveLength(1);
    // Nothing is left that keeps the thread from its next step.
    await expect(hub.ship(threadId, "x", false)).resolves.toMatchObject({ prOpened: false });
  });

  it("asks the user first outside full access", async () => {
    const { hub, client, thread, lastReply, workspace, pushed, sendAsk, opened } = await setup();
    const threadId = await thread({ permissionMode: "supervised" });
    const { path: tree, branch } = workspace(threadId);
    writeFileSync(path.join(tree, "nouveau.txt"), "a\n");

    // Refused, nothing leaves the computer and nothing is committed.
    await hub.handle(client, { type: "thread.send", threadId, text: "/pr Ajoute un fichier" });
    const first = await sendAsk(threadId);
    expect(first.title).toBe(
      `Pousser la branche ${branch} et ouvrir la pull request « Ajoute un fichier »`,
    );
    expect(pushed(threadId)).toBeUndefined();
    hub.respondToPermission(threadId, first.id, "reject");
    await hub.whenIdle(threadId);
    expect(lastReply(threadId)).toContain("refusé");
    expect(pushed(threadId)).toBeUndefined();
    expect(git(tree, "status", "--porcelain")).toBe("?? nouveau.txt");
    expect(opened()).toHaveLength(0);

    // Agreed to, it goes.
    await hub.handle(client, { type: "thread.send", threadId, text: "/pr Ajoute un fichier" });
    hub.respondToPermission(threadId, (await sendAsk(threadId)).id, "allow");
    await hub.whenIdle(threadId);
    expect(JSON.parse(lastReply(threadId))).toMatchObject({ pushed: true, pull_request: PULL });
    expect(pushed(threadId)).toBe(git(tree, "rev-parse", "HEAD"));
    expect(opened()).toHaveLength(1);

    // With its pull request open, the question says so; stopping the turn answers it.
    writeFileSync(path.join(tree, "nouveau.txt"), "a\nb\n");
    const before = pushed(threadId);
    await hub.handle(client, { type: "thread.send", threadId, text: "/pr Encore" });
    expect((await sendAsk(threadId)).title).toBe(
      `Pousser la branche ${branch} sur sa pull request`,
    );
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);
    expect(pushed(threadId)).toBe(before);
  });

  it("says what really happened when GitHub refuses the pull request", async () => {
    const { thread, say, lastReply, workspace, pushed, store } = await setup((call) =>
      call.method === "GET"
        ? []
        : {
            status: 422,
            body: { message: "Validation Failed", errors: [{ message: "base main is protected" }] },
          },
    );
    const threadId = await thread();
    const { path: tree, branch } = workspace(threadId);
    writeFileSync(path.join(tree, "nouveau.txt"), "a\n");
    await say(threadId, "/pr Ajoute un fichier");
    const said = JSON.parse(lastReply(threadId)) as Record<string, string>;
    // The branch is on GitHub, the pull request is not: the agent is told, with the page
    // where the user opens it.
    expect(pushed(threadId)).toBe(said.commit);
    expect(said.pull_request).toBeUndefined();
    expect(said.open_here).toBe(
      `https://github.com/moon/demo/compare/main...${encodeURIComponent(branch)}?expand=1`,
    );
    expect(said.next).toContain("GitHub a refusé d'ouvrir la pull request");
    expect(said.next).toContain("base main is protected");
    expect(store.getThread(threadId)?.workspace).toMatchObject({ prOpened: false });
  });

  it("is refused where there is no branch of the thread's own to send", async () => {
    const { thread, say, lastReply, opened, bare } = await setup();
    const direct = await thread({ isolated: false });
    await say(direct, "/pr Depuis le dossier du projet");
    expect(lastReply(direct)).toContain("sans branche à lui");
    // A team's member leaves the pull request to its team.
    const lead = await thread();
    const member = await thread({ parentId: lead, role: "coder" });
    await say(member, "/pr Ma partie");
    expect(lastReply(member)).toContain("L'équipe envoie elle-même sa pull request");
    expect(opened()).toHaveLength(0);
    expect(git(bare, "branch", "--list")).toBe("");
  });
});
