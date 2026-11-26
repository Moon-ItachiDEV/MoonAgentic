import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  threadGroup,
  threadPullRequest,
  type PullRequestInfo,
  type ServerMessage,
} from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub, leadOf, summaryOf } from "../src/hub.ts";
import {
  type GhRun,
  ghPullRequests,
  parsePullRequest,
  parsePullRequestUrl,
  type PullRequests,
} from "../src/pull-request.ts";
import { Store } from "../src/store.ts";

const HEAD = "a".repeat(40);

const view = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 42,
    url: "https://github.com/moon/demo/pull/42",
    title: "Ajoute le suivi",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [],
    ...over,
  });

const run = (name: string, status: string, conclusion: string, startedAt = "") => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status,
  conclusion,
  startedAt,
  detailsUrl: `https://github.com/moon/demo/actions/runs/1/job/${name.length}`,
});

describe("reading a pull request from gh", () => {
  it("reads its state, its branch and whether it conflicts", () => {
    expect(parsePullRequest(view(), "moon/demo")).toEqual({
      repo: "moon/demo",
      number: 42,
      url: "https://github.com/moon/demo/pull/42",
      title: "Ajoute le suivi",
      state: "open",
      head: HEAD,
      base: "main",
      conflicts: false,
      blocked: false,
      checks: [],
    });
    const of = (over: Record<string, unknown>) => parsePullRequest(view(over), "moon/demo");
    expect(of({ isDraft: true })?.state).toBe("draft");
    expect(of({ state: "MERGED", isDraft: true })?.state).toBe("merged");
    expect(of({ state: "CLOSED" })?.state).toBe("closed");
    expect(of({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })?.conflicts).toBe(true);
    expect(of({ mergeable: "UNKNOWN" })?.conflicts).toBeNull();
    expect(of({ mergeStateStatus: "BLOCKED" })?.blocked).toBe(true);
    expect(
      of({
        author: { login: "moon" },
        createdAt: "2026-11-25T23:50:00Z",
        additions: 2456,
        deletions: 380,
        changedFiles: 35,
      }),
    ).toMatchObject({
      author: "moon",
      createdAt: Date.parse("2026-11-25T23:50:00Z"),
      additions: 2456,
      deletions: 380,
      files: 35,
    });
    expect(parsePullRequest("pas du JSON", "moon/demo")).toBeUndefined();
    expect(parsePullRequest("{}", "moon/demo")).toBeUndefined();
  });

  it("reads each check, a check run again counting as its last run", () => {
    const pr = parsePullRequest(
      view({
        statusCheckRollup: [
          run("Lint", "COMPLETED", "SUCCESS"),
          run("Tests", "COMPLETED", "FAILURE", "2026-11-22T10:00:00Z"),
          run("Tests", "IN_PROGRESS", "", "2026-11-22T11:00:00Z"),
          run("Windows", "COMPLETED", "CANCELLED"),
          run("Docs", "COMPLETED", "SKIPPED"),
          { __typename: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "" },
          { __typename: "StatusContext", context: "license", state: "ERROR" },
          { __typename: "CheckRun" },
        ],
      }),
      "moon/demo",
    );
    expect(pr?.checks.map((c) => [c.name, c.state])).toEqual([
      ["Lint", "passed"],
      ["Tests", "pending"],
      ["Windows", "failed"],
      ["Docs", "skipped"],
      ["deploy", "pending"],
      ["license", "failed"],
    ]);
    expect(pr?.checks[0]?.url).toBe("https://github.com/moon/demo/actions/runs/1/job/4");
    expect(pr?.checks[4]).not.toHaveProperty("url");
  });

  it("keeps the last of a commit status posted twice, dated by when it was posted", () => {
    const status = (state: string, createdAt: string) => ({
      __typename: "StatusContext",
      context: "deploy",
      state,
      createdAt,
    });
    const pr = parsePullRequest(
      view({
        statusCheckRollup: [
          status("SUCCESS", "2026-11-22T11:00:00Z"),
          status("FAILURE", "2026-11-22T10:00:00Z"),
        ],
      }),
      "moon/demo",
    );
    expect(pr?.checks).toEqual([{ name: "deploy", state: "passed" }]);
  });

  it("takes only the address of a pull request on github.com", () => {
    expect(parsePullRequestUrl("https://github.com/Moon-ItachiDEV/MoonAgentic/pull/43")).toEqual({
      repo: "Moon-ItachiDEV/MoonAgentic",
      number: 43,
    });
    expect(parsePullRequestUrl("https://github.com/moon/demo/pull/7/files#diff")).toEqual({
      repo: "moon/demo",
      number: 7,
    });
    for (const bad of [
      "https://github.com/moon/demo/issues/7",
      "https://github.com/moon/demo/pull/abc",
      "https://evil.example/github.com/moon/demo/pull/7",
      "https://github.com.evil.example/moon/demo/pull/7",
      "http://github.com/moon/demo/pull/7",
      "https://github.com/--repo/x/pull/7",
    ]) {
      expect(parsePullRequestUrl(bad)).toBeUndefined();
    }
  });
});

describe("pull requests through gh", () => {
  it("has none when gh finds none, and passes on any other failure", async () => {
    const none = ghPullRequests(async () => {
      throw new Error('no pull requests found for branch "moon/x"\nusage…');
    });
    expect(await none.find("moon/demo", "moon/x")).toBeUndefined();
    const signedOut = ghPullRequests(async () => {
      throw new Error("To get started with GitHub CLI, please run:  gh auth login\nplus");
    });
    await expect(signedOut.find("moon/demo", "moon/x")).rejects.toThrow(/^To get started.*login$/);
  });

  it("merges the commit that was seen, the way the repository allows", async () => {
    const calls: string[][] = [];
    const allowing = (allowed: Record<string, boolean>): GhRun => {
      return async (args) => {
        calls.push(args);
        return args[0] === "repo" ? JSON.stringify(allowed) : "";
      };
    };
    await ghPullRequests(allowing({ mergeCommitAllowed: true })).merge("moon/demo", 42, HEAD);
    expect(calls.at(-1)).toEqual([
      "pr",
      "merge",
      "42",
      "--repo",
      "moon/demo",
      "--merge",
      "--match-head-commit",
      HEAD,
    ]);
    await ghPullRequests(allowing({ mergeCommitAllowed: false, squashMergeAllowed: true })).merge(
      "moon/demo",
      42,
      HEAD,
    );
    expect(calls.at(-1)).toContain("--squash");
    await ghPullRequests(allowing({ mergeCommitAllowed: false, squashMergeAllowed: false })).merge(
      "moon/demo",
      42,
      HEAD,
    );
    expect(calls.at(-1)).toContain("--rebase");
    // The branch is never deleted from here: the thread still works on it.
    expect(calls.flat()).not.toContain("--delete-branch");
  });
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** A thread with its own branch in a repository whose remote is on GitHub, and a stand-in GitHub. */
async function threadOnGithub(remoteUrl = "https://github.com/moon/demo.git") {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pr-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remoteUrl);

  const github = {
    pr: undefined as PullRequestInfo | undefined,
    asked: [] as string[],
    merged: [] as string[],
  };
  const pullRequests: PullRequests = {
    find: async (repoName, ref) => {
      github.asked.push(`${repoName} ${ref}`);
      return github.pr;
    },
    merge: async (repoName, number, head) => {
      github.merged.push(`${repoName} #${number} ${head}`);
      if (github.pr) github.pr = { ...github.pr, state: "merged" };
    },
  };
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    pullRequests: () => pullRequests,
  });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const threadId = hub.createThread({
    projectId: hub.createProject("demo", repo),
    agentId: "demo",
    permissionMode: "full",
    isolated: true,
    text: "Ajoute le suivi",
  });
  await hub.whenIdle(threadId);
  const branch = store.getThread(threadId)!.workspace!.branch;
  const messages: ServerMessage[] = [];
  const client: Client = { send: (m) => messages.push(m) };
  const reply = () => messages.findLast((m) => m.type === "pullRequest");
  /** The server started again on the same database: what it only remembered is gone. */
  const restarted = async () => {
    await hub.close();
    const next = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
      pullRequests: () => pullRequests,
    });
    cleanups.unshift(() => next.close());
    await next.recovered;
    return next;
  };
  return { hub, store, github, threadId, branch, client, reply, restarted };
}

const OPEN = parsePullRequest(view(), "moon/demo")!;

describe("the pull request of a thread's branch", () => {
  it("is asked from GitHub by the thread's branch", async () => {
    const { hub, github, threadId, branch, client, reply } = await threadOnGithub();
    await hub.handle(client, { type: "workspace.pr", requestId: "r1", threadId });
    expect(github.asked).toEqual([`moon/demo ${branch}`]);
    expect(reply()).toEqual({ type: "pullRequest", requestId: "r1" });

    github.pr = OPEN;
    await hub.handle(client, { type: "workspace.pr", requestId: "r2", threadId });
    expect(reply()).toEqual({ type: "pullRequest", requestId: "r2", pr: OPEN });
  });

  it("asks nothing when the remote is not on GitHub", async () => {
    const { hub, github, threadId } = await threadOnGithub("https://gitlab.com/moon/demo.git");
    github.pr = OPEN;
    expect(await hub.pullRequest(threadId)).toBeUndefined();
    expect(github.asked).toEqual([]);
  });

  it("merges it only as the user saw it", async () => {
    const { hub, github, threadId, client, reply } = await threadOnGithub();
    github.pr = OPEN;
    await expect(hub.mergePullRequest(threadId, 41, HEAD)).rejects.toThrow("n'est plus celle");
    await expect(hub.mergePullRequest(threadId, 42, "b".repeat(40))).rejects.toThrow(
      "nouveaux commits",
    );
    github.pr = { ...OPEN, conflicts: true };
    await expect(hub.mergePullRequest(threadId, 42, HEAD)).rejects.toThrow("conflits");
    github.pr = { ...OPEN, state: "draft" };
    await expect(hub.mergePullRequest(threadId, 42, HEAD)).rejects.toThrow("brouillon");
    expect(github.merged).toEqual([]);

    // A refusal reaches whoever asked as an answer, not as a broken request.
    await hub.handle(client, {
      type: "workspace.mergePr",
      requestId: "m0",
      threadId,
      number: 42,
      head: HEAD,
    });
    expect(reply()).toMatchObject({ requestId: "m0", error: expect.stringContaining("brouillon") });

    github.pr = OPEN;
    await hub.handle(client, {
      type: "workspace.mergePr",
      requestId: "m1",
      threadId,
      number: 42,
      head: HEAD,
    });
    expect(github.merged).toEqual([`moon/demo #42 ${HEAD}`]);
    expect(reply()).toEqual({
      type: "pullRequest",
      requestId: "m1",
      pr: { ...OPEN, state: "merged" },
    });
    await expect(hub.mergePullRequest(threadId, 42, HEAD)).rejects.toThrow("plus ouverte");
  });

  it("tells the state of a pull request from its address, for a link", async () => {
    const { hub, github, client, reply } = await threadOnGithub();
    github.pr = OPEN;
    await hub.handle(client, {
      type: "github.pr",
      requestId: "u1",
      url: "https://github.com/other/repo/pull/7",
    });
    expect(github.asked).toEqual(["other/repo 7"]);
    expect(reply()).toMatchObject({ requestId: "u1", pr: { state: "open" } });
    await hub.handle(client, { type: "github.pr", requestId: "u2", url: "https://example.com/" });
    expect(reply()).toMatchObject({ requestId: "u2", error: expect.stringContaining("adresse") });
  });
});

describe("what lists of threads keep of a pull request", () => {
  /** The thread's folder with nothing left to commit, and its last commit. */
  const settle = (dir: string) => {
    git(dir, "add", "-A");
    if (git(dir, "status", "--porcelain")) git(dir, "commit", "-q", "-m", "travail");
    return git(dir, "rev-parse", "HEAD");
  };

  it("is kept on the thread, and asked again only once known", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    // No pull request known yet: a round of watching asks GitHub nothing.
    await hub.watchPullRequests();
    expect(github.asked).toEqual([]);

    github.pr = OPEN;
    await hub.pullRequest(threadId);
    expect(store.getThread(threadId)!.pr).toEqual({
      url: OPEN.url,
      number: 42,
      state: "open",
      checks: threadPullRequest(OPEN).checks,
    });
    expect(threadGroup(store.getThread(threadId)!)).toBe(
      threadPullRequest(OPEN).checks === "pending" ? "idle" : "waiting",
    );

    github.pr = { ...OPEN, checks: [{ name: "ci", state: "failed" }] };
    await hub.watchPullRequests();
    expect(github.asked).toHaveLength(2);
    expect(store.getThread(threadId)!.pr!.checks).toBe("failed");
    expect(threadGroup(store.getThread(threadId)!)).toBe("waiting");

    // Closed: nothing more to watch.
    github.pr = { ...OPEN, state: "closed" };
    await hub.watchPullRequests();
    await hub.watchPullRequests();
    expect(github.asked).toHaveLength(3);
    expect(threadGroup(store.getThread(threadId)!)).toBe("idle");
  });

  it("resolves the thread once merged, when its folder holds nothing more", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    const dir = store.getThread(threadId)!.workspace!.path;
    const head = settle(dir);
    github.pr = { ...OPEN, head };
    await hub.pullRequest(threadId);
    expect(store.getThread(threadId)!.archived).toBeUndefined();

    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    const thread = store.getThread(threadId)!;
    expect(thread.pr!.state).toBe("merged");
    expect(thread.archived).toBe(true);
    expect(threadGroup(thread)).toBe("resolved");
    expect(existsSync(dir)).toBe(false);
  });

  it("deletes the branch of a thread resolved after its merge, unless the project keeps it", async () => {
    for (const keep of [false, true]) {
      const { hub, store, github, client, threadId } = await threadOnGithub();
      const thread = store.getThread(threadId)!;
      const repo = store.getProject(thread.projectId)!.path;
      const branch = thread.workspace!.branch;
      if (keep) {
        await hub.handle(client, {
          type: "project.setDeleteMerged",
          projectId: thread.projectId,
          on: false,
        });
        expect(hub.snapshot().projects.find((p) => p.id === thread.projectId)?.deleteMerged).toBe(
          false,
        );
      }
      // Work the project's folder has not fetched: merged on GitHub only.
      writeFileSync(path.join(thread.workspace!.path, "fait.md"), "fait\n");
      const head = settle(thread.workspace!.path);
      github.pr = { ...OPEN, head };
      await hub.pullRequest(threadId);
      github.pr = { ...OPEN, head, state: "merged" };
      await hub.watchPullRequests();
      expect(store.getThread(threadId)!.archived).toBe(true);
      const left = git(repo, "branch", "--list", branch);
      expect(left.includes(branch)).toBe(keep);
    }
  });

  it("leaves a merged thread as it is when work was added past the merge", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    const dir = store.getThread(threadId)!.workspace!.path;
    const head = settle(dir);
    github.pr = { ...OPEN, head };
    await hub.pullRequest(threadId);

    // A file not committed: the folder stays.
    writeFileSync(path.join(dir, "notes.md"), "à garder\n");
    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    expect(store.getThread(threadId)!.pr!.state).toBe("merged");
    expect(store.getThread(threadId)!.archived).toBeUndefined();
    expect(existsSync(path.join(dir, "notes.md"))).toBe(true);
  });

  it("leaves a merged thread as it is when a commit came after the merged one", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    const dir = store.getThread(threadId)!.workspace!.path;
    const head = settle(dir);
    github.pr = { ...OPEN, head };
    await hub.pullRequest(threadId);
    writeFileSync(path.join(dir, "suite.md"), "après\n");
    settle(dir);
    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    expect(store.getThread(threadId)!.archived).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("a pull request merged, or a team's", () => {
  const settle = (dir: string) => {
    git(dir, "add", "-A");
    if (git(dir, "status", "--porcelain")) git(dir, "commit", "-q", "-m", "travail");
    return git(dir, "rev-parse", "HEAD");
  };

  it("resolves a thread whose pull request was merged before it was ever asked about", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    const workspace = store.getThread(threadId)!.workspace!;
    const head = settle(workspace.path);
    // As after a push that opened it: known to be open, not yet read from GitHub.
    store.updateThread(threadId, { workspace: { ...workspace, prUrl: OPEN.url, prOpened: true } });
    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    expect(store.getThread(threadId)!.archived).toBe(true);
  });

  it("leaves alone a merged pull request MoonAgentic never opened nor saw open", async () => {
    const { hub, store, github, threadId } = await threadOnGithub();
    const head = settle(store.getThread(threadId)!.workspace!.path);
    github.pr = { ...OPEN, head, state: "merged" };
    await hub.pullRequest(threadId);
    expect(store.getThread(threadId)!.pr!.state).toBe("merged");
    expect(store.getThread(threadId)!.archived).toBeUndefined();
  });

  it("shows a team's pull request on its lead, and resolves the whole team once merged", async () => {
    // The thread with the branch stands for the team's merge thread; its lead has no branch.
    const { hub, store, github, threadId: leadless } = await threadOnGithub();
    const projectId = store.getThread(leadless)!.projectId;
    const leadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "",
      title: "Équipe",
      role: "lead",
    });
    const mergeId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Fusionne",
      title: "Fusion",
      parentId: leadId,
      role: "merger",
    });
    await hub.whenIdle(mergeId);
    store.updateThread(leadId, {
      team: {
        phase: "done",
        task: "t",
        coder: { agentId: "demo" },
        coders: 2,
        permissionMode: "full",
        mergeThreadId: mergeId,
        tasks: [
          { title: "A", brief: "", status: "done" },
          { title: "B", brief: "", status: "done" },
        ],
      },
    });
    const head = settle(store.getThread(mergeId)!.workspace!.path);

    github.pr = { ...OPEN, head, checks: [{ name: "ci", state: "passed" }] };
    await hub.pullRequest(mergeId);
    const lead = store.getThread(leadId)!;
    expect(lead.pr).toMatchObject({ number: 42, state: "open", checks: "passed" });
    // Green and open: the team waits on the user's merge.
    expect(threadGroup(lead)).toBe("waiting");

    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    expect(store.getThread(leadId)!.pr!.state).toBe("merged");
    expect(store.getThread(leadId)!.archived).toBe(true);
    expect(store.getThread(mergeId)!.archived).toBe(true);
  });
});

describe("a thread's summary", () => {
  it("is the start of what its agent last said, on one line", async () => {
    const { store, threadId } = await threadOnGithub();
    const summary = store.getThread(threadId)!.summary;
    expect(summary).toBeTruthy();
    expect(summary).not.toContain("\n");
    expect(
      summaryOf("## Fait\n\nLe **bouton** marche, voir [la PR](https://x.y/1).\n```ts\ncode\n```"),
    ).toBe("Fait Le bouton marche, voir la PR.");
    expect(summaryOf("a".repeat(400))).toHaveLength(160);
  });

  it("tells a finished thread's result in its first two sentences", () => {
    expect(
      leadOf(
        "## Résultat\n\nLa PR 155 n'est pas prête. Deux secrets passent encore. Le reste est bon.\n\n```moon-revue\n{}\n```",
        2,
        400,
      ),
    ).toBe("La PR 155 n'est pas prête. Deux secrets passent encore.");
    expect(leadOf("Fait : v0.1.10 publiée. Rien d'autre.", 1)).toBe("Fait : v0.1.10 publiée.");
  });
});

describe("pull requests turned green", () => {
  const green = (n: number) => ({
    ...OPEN,
    number: n,
    url: `https://github.com/moon/demo/pull/${n}`,
    checks: [{ name: "ci", state: "passed" as const }],
  });

  it("are told to the coordinator once at least two wait only on a review", async () => {
    const { hub, store, github, threadId: coordinator } = await threadOnGithub();
    const projectId = store.getThread(coordinator)!.projectId;
    const open = async (text: string) => {
      const id = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
        openedBy: coordinator,
      });
      await hub.whenIdle(id);
      return id;
    };
    const first = await open("Ajoute le suivi");
    const second = await open("Corrige le menu");
    const told = () =>
      store.listItems(coordinator).filter((i) => i.kind === "agent" && i.id.startsWith("green:"));

    github.pr = green(1);
    await hub.pullRequest(first);
    expect(told()).toEqual([]);

    github.pr = green(2);
    await hub.pullRequest(second);
    expect(told()).toHaveLength(1);
    const text = (told()[0] as { text: string }).text;
    expect(text).toContain("Les 2 PR sont vertes");
    expect(text).toContain(`](fil:${first})`);
    expect(text).toContain("https://github.com/moon/demo/pull/2");

    // Asked again, the same green pull requests are not told twice.
    await hub.pullRequest(second);
    github.pr = green(1);
    await hub.pullRequest(first);
    expect(told()).toHaveLength(1);
  });

  it("are still counted and not told again after the server starts again", async () => {
    const { hub, store, github, threadId: coordinator, restarted } = await threadOnGithub();
    const projectId = store.getThread(coordinator)!.projectId;
    const open = async (on: Hub, text: string) => {
      const id = on.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
        openedBy: coordinator,
      });
      await on.whenIdle(id);
      return id;
    };
    const first = await open(hub, "Ajoute le suivi");
    const second = await open(hub, "Corrige le menu");
    const told = () =>
      store.listItems(coordinator).filter((i) => i.kind === "agent" && i.id.startsWith("green:"));
    github.pr = green(1);
    await hub.pullRequest(first);
    expect(told()).toEqual([]);

    // The first turned green before the restart, the second after: two wait on a review.
    const next = await restarted();
    github.pr = green(2);
    await next.pullRequest(second);
    expect(told()).toHaveLength(1);

    // Started once more, a pull request that changes while green is not told a second time.
    const last = await restarted();
    github.pr = { ...green(2), title: "Un autre titre", blocked: true };
    await last.pullRequest(second);
    github.pr = { ...green(1), blocked: true };
    await last.pullRequest(first);
    expect(told()).toHaveLength(1);
  });
});
