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
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub, leadOf, summaryOf } from "../src/hub.ts";
import { openPullRequestWith } from "../src/git.ts";
import {
  apiPullRequests,
  type GhRun,
  ghPullRequests,
  localPullRequests,
  parsePullRequest,
  parsePullRequestUrl,
  type PullRequests,
} from "../src/pull-request.ts";
import { Store } from "../src/store.ts";
import { fakeGithubApi, graphqlPull, signedInAccount } from "./fake-github-api.ts";

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

    github.pr = {
      ...OPEN,
      checks: [{ name: "ci", state: "failed" }],
      additions: 120,
      deletions: 8,
    };
    await hub.watchPullRequests();
    expect(github.asked).toHaveLength(2);
    expect(store.getThread(threadId)!.pr!.checks).toBe("failed");
    // Its lines added and removed are kept for the project's usage.
    expect(store.getThread(threadId)!.pr).toMatchObject({ additions: 120, deletions: 8 });
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

  it("deletes the branch of a merged thread the user resolves by hand, merged on GitHub only", async () => {
    const { hub, store, github, client, threadId } = await threadOnGithub();
    const thread = store.getThread(threadId)!;
    const repo = store.getProject(thread.projectId)!.path;
    const branch = thread.workspace!.branch;
    writeFileSync(path.join(thread.workspace!.path, "fait.md"), "fait\n");
    const head = settle(thread.workspace!.path);
    github.pr = { ...OPEN, head };
    await hub.pullRequest(threadId);
    // Merged while the agent was at work: the thread is not resolved by itself.
    const busy = (hub as unknown as { busy: Map<string, string> }).busy;
    busy.set(threadId, "travail");
    github.pr = { ...OPEN, head, state: "merged" };
    await hub.watchPullRequests();
    busy.delete(threadId);
    expect(store.getThread(threadId)!.archived).toBeUndefined();
    await hub.handle(client, { type: "thread.setArchived", threadId, archived: true });
    expect(store.getThread(threadId)!.archived).toBe(true);
    expect(git(repo, "branch", "--list", branch).includes(branch)).toBe(false);
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

describe("batched PR polling, remote cache and idle cadence", () => {
  it("parses gh pr list output keyed by branch and leaves out the pull requests of forks", async () => {
    const { parsePullRequestList } = await import("../src/pull-request.ts");
    const list = parsePullRequestList(
      JSON.stringify([
        { ...JSON.parse(view({ number: 10 })), headRefName: "feat/a", isCrossRepository: true },
        { ...JSON.parse(view({ number: 11 })), headRefName: "feat/a", isCrossRepository: false },
        { ...JSON.parse(view({ number: 12 })), headRefName: "feat/b", isDraft: true },
        // A fork's branch of the same name is not the thread's: the thread is asked about by
        // itself (`gh pr view`), which says its own pull request was merged, or that it has none.
        { ...JSON.parse(view({ number: 13 })), headRefName: "feat/c", isCrossRepository: true },
      ]),
      "moon/demo",
    );
    expect(list.get("feat/a")?.number).toBe(11);
    expect(list.get("feat/b")?.state).toBe("draft");
    expect(list.has("feat/c")).toBe(false);

    const calls: string[][] = [];
    const gh = ghPullRequests(async (args) => {
      calls.push(args);
      return JSON.stringify([{ ...JSON.parse(view({ number: 12 })), headRefName: "feat/b" }]);
    });
    const open = await gh.listOpen!("moon/demo");
    expect(open.get("feat/b")?.number).toBe(12);
    expect(calls[0]).toContain("list");
    expect(calls[0]).toContain("--state");
    expect(calls[0]).toContain("open");
  });

  it("batches multiple open PRs in one repo into one listOpen call and falls back to find when one merges", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-prbatch-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "README.md"), "# Demo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", "https://github.com/moon/demo.git");

    let remoteCalls = 0;
    const listedRepos: string[] = [];
    const foundRefs: string[] = [];
    const openByBranch = new Map<string, PullRequestInfo>();
    const byBranch = new Map<string, PullRequestInfo>();
    const pullRequests: PullRequests = {
      find: async (_repoName, ref) => {
        foundRefs.push(ref);
        return byBranch.get(ref);
      },
      listOpen: async (repoName) => {
        listedRepos.push(repoName);
        return new Map(openByBranch);
      },
      merge: async () => undefined,
    };

    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
      pullRequests: () => pullRequests,
      resolveGithubRemote: async () => {
        remoteCalls += 1;
        return "moon/demo";
      },
      prWatchMs: 0,
      prIdleWatchMs: 60_000,
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const projectId = hub.createProject("demo", repo);
    const openThread = async (text: string) => {
      const id = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
      });
      await hub.whenIdle(id);
      return id;
    };
    const t1 = await openThread("Première PR");
    const t2 = await openThread("Deuxième PR");
    const b1 = store.getThread(t1)!.workspace!.branch;
    const b2 = store.getThread(t2)!.workspace!.branch;
    const head1 = git(store.getThread(t1)!.workspace!.path, "rev-parse", "HEAD");
    const head2 = git(store.getThread(t2)!.workspace!.path, "rev-parse", "HEAD");

    const pr1: PullRequestInfo = {
      ...OPEN,
      number: 1,
      url: "https://github.com/moon/demo/pull/1",
      head: head1,
      checks: [{ name: "ci", state: "passed" }],
    };
    const pr2: PullRequestInfo = {
      ...OPEN,
      number: 2,
      url: "https://github.com/moon/demo/pull/2",
      head: head2,
      checks: [{ name: "ci", state: "passed" }],
    };
    byBranch.set(b1, pr1);
    byBranch.set(b2, pr2);
    openByBranch.set(b1, pr1);
    openByBranch.set(b2, pr2);

    await hub.pullRequest(t1);
    await hub.pullRequest(t2);
    // Remote was resolved once for the project and reused across both worktrees.
    expect(remoteCalls).toBe(1);
    expect(
      store
        .listWatchedPrThreads()
        .map((t) => t.id)
        .sort(),
    ).toEqual([t1, t2].sort());

    foundRefs.length = 0;
    listedRepos.length = 0;
    // Update checks via batched listOpen: 1 listOpen call, 0 find calls, still 1 remote resolution.
    openByBranch.set(b1, { ...pr1, checks: [{ name: "ci", state: "failed" }] });
    await hub.watchPullRequests();
    expect(listedRepos).toEqual(["moon/demo"]);
    expect(foundRefs).toEqual([]);
    expect(remoteCalls).toBe(1);
    expect(store.getThread(t1)!.pr!.checks).toBe("failed");

    // When PR #1 merges and disappears from listOpen, fallback find detects the merge & archives it.
    openByBranch.delete(b1);
    byBranch.set(b1, { ...pr1, state: "merged" });
    listedRepos.length = 0;
    foundRefs.length = 0;
    await hub.watchPullRequests();
    expect(listedRepos).toEqual(["moon/demo"]);
    expect(foundRefs).toEqual([b1]);
    expect(store.getThread(t1)!.pr!.state).toBe("merged");
    expect(store.getThread(t1)!.archived).toBe(true);
    // Archived/merged thread is no longer returned by listWatchedPrThreads.
    expect(store.listWatchedPrThreads().map((t) => t.id)).toEqual([t2]);
  });

  /** A repository, a hub that asks a stand-in GitHub, and threads each on its own branch. */
  async function polled(pullRequests: PullRequests, origin?: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-prpoll-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "README.md"), "# Demo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    if (origin) git(repo, "remote", "add", "origin", origin);
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
      pullRequests: () => pullRequests,
      prWatchMs: 0,
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const projectId = hub.createProject("demo", repo);
    const thread = async (text: string) => {
      const id = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
      });
      await hub.whenIdle(id);
      const workspace = store.getThread(id)!.workspace!;
      return { id, branch: workspace.branch, head: git(workspace.path, "rev-parse", "HEAD") };
    };
    return { hub, store, repo, thread };
  }

  it("keeps a merge noted while a round's list was on its way", async () => {
    const now = new Map<string, PullRequestInfo>();
    let listed: (() => void) | undefined;
    let held: Promise<void> | undefined;
    const pullRequests: PullRequests = {
      find: async (_repo, ref) => now.get(ref),
      // The list says what GitHub held when it was asked, and may arrive late.
      listOpen: async () => {
        const open = new Map([...now].filter(([, pr]) => pr.state === "open"));
        listed?.();
        await held;
        return open;
      },
      merge: async () => undefined,
    };
    const { hub, store, thread } = await polled(pullRequests, "https://github.com/moon/demo.git");
    const a = await thread("Première PR");
    const b = await thread("Deuxième PR");
    for (const [n, t] of [a, b].entries()) {
      now.set(t.branch, {
        ...OPEN,
        number: n + 1,
        url: `https://github.com/moon/demo/pull/${n + 1}`,
        head: t.head,
        checks: [{ name: "ci", state: "passed" }],
      });
      await hub.pullRequest(t.id);
    }
    expect(store.getThread(b.id)!.pr!.state).toBe("open");

    let release = () => {};
    held = new Promise<void>((resolve) => (release = resolve));
    const asked = new Promise<void>((resolve) => (listed = resolve));
    const round = hub.watchPullRequests();
    await asked;
    // Merged meanwhile, and seen by the thread's own question: its thread is resolved, and
    // no later round looks at it again.
    now.set(b.branch, { ...now.get(b.branch)!, state: "merged" });
    await hub.pullRequest(b.id);
    expect(store.getThread(b.id)!.pr!.state).toBe("merged");
    expect(store.getThread(b.id)!.archived).toBe(true);
    release();
    await round;
    expect(store.getThread(b.id)!.pr!.state).toBe("merged");
    // The other thread of the list is still told what the list said.
    expect(store.getThread(a.id)!.pr!.state).toBe("open");
  });

  it("asks git again as soon as the repository's remotes change", async () => {
    const asked: string[] = [];
    const pullRequests: PullRequests = {
      find: async (repo) => {
        asked.push(repo);
        return undefined;
      },
      merge: async () => undefined,
    };
    const { hub, repo, thread } = await polled(pullRequests);
    const t = await thread("Sans dépôt GitHub");
    await hub.pullRequest(t.id);
    expect(asked).toEqual([]);

    // Pushed to GitHub since: the thread's pull request shows at once, not a minute later.
    git(repo, "remote", "add", "origin", "https://github.com/moon/demo.git");
    await hub.pullRequest(t.id);
    expect(asked).toEqual(["moon/demo"]);

    // Moved to another repository: the old one is not asked for ten more minutes.
    git(repo, "remote", "set-url", "origin", "https://github.com/other/place.git");
    await hub.pullRequest(t.id);
    expect(asked).toEqual(["moon/demo", "other/place"]);
  });

  it("slows quiet open PRs when no client is connected, while keeping urgent PRs on fast cadence", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pridle-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "README.md"), "# Demo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", "https://github.com/moon/demo.git");

    const foundRefs: string[] = [];
    const byBranch = new Map<string, PullRequestInfo>();
    const pullRequests: PullRequests = {
      find: async (_repoName, ref) => {
        foundRefs.push(ref);
        return byBranch.get(ref);
      },
      merge: async () => undefined,
    };
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
      pullRequests: () => pullRequests,
      resolveGithubRemote: async () => "moon/demo",
      prWatchMs: 0,
      prIdleWatchMs: 60_000,
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const projectId = hub.createProject("demo", repo);
    const makeThread = async (text: string) => {
      const id = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
      });
      await hub.whenIdle(id);
      return id;
    };
    const quietId = await makeThread("PR calme");
    const pendingId = await makeThread("PR CI en cours");
    const quietBranch = store.getThread(quietId)!.workspace!.branch;
    const pendingBranch = store.getThread(pendingId)!.workspace!.branch;

    byBranch.set(quietBranch, {
      ...OPEN,
      number: 10,
      url: "https://github.com/moon/demo/pull/10",
      checks: [{ name: "ci", state: "passed" }],
    });
    byBranch.set(pendingBranch, {
      ...OPEN,
      number: 11,
      url: "https://github.com/moon/demo/pull/11",
      checks: [{ name: "ci", state: "pending" }],
    });
    await hub.pullRequest(quietId);
    await hub.pullRequest(pendingId);
    foundRefs.length = 0;

    // First scheduled idle tick polls both (since lastIdlePrWatchAt was 0).
    await hub.watchPullRequests({ scheduled: true });
    expect(foundRefs.sort()).toEqual([pendingBranch, quietBranch].sort());
    foundRefs.length = 0;

    // Immediate next scheduled tick with 0 clients skips the quiet PR, but still polls the pending one.
    await hub.watchPullRequests({ scheduled: true });
    expect(foundRefs).toEqual([pendingBranch]);
    foundRefs.length = 0;

    // Once a client connects, both are polled again on the fast schedule.
    const client: Client = { send: () => undefined };
    const disconnect = hub.connect(client);
    await hub.watchPullRequests({ scheduled: true });
    expect(foundRefs.sort()).toEqual([pendingBranch, quietBranch].sort());
    disconnect();
  });

  it("scales streamed text flush delay with draft size", async () => {
    const { textFlushDelayMs } = await import("../src/hub.ts");
    expect(textFlushDelayMs(0)).toBe(250);
    expect(textFlushDelayMs(2_000)).toBe(250);
    expect(textFlushDelayMs(4_096)).toBe(500);
    expect(textFlushDelayMs(16_384)).toBe(1_000);
  });

  it("listWatchedPrThreads selects only active PR candidates and tolerates damaged JSON", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pr-sql-"));
    const store = new Store(path.join(dir, "test.db"));
    cleanups.push(async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const now = Date.now();
    store.addProject({ id: "p1", name: "p", path: dir, createdAt: now });
    const ws = (branch: string, prOpened?: boolean) => ({
      path: path.join(dir, branch),
      branch,
      base: "abc123",
      ...(prOpened ? { prOpened: true } : {}),
    });
    const prOf = (number: number, state: PullRequestInfo["state"] = "open") =>
      threadPullRequest({
        ...OPEN,
        number,
        state,
        url: `https://github.com/moon/demo/pull/${number}`,
      });
    const add = (id: string, extra: Partial<Parameters<Store["addThread"]>[0]> = {}) =>
      store.addThread({
        id,
        projectId: "p1",
        title: id,
        agentId: "demo",
        status: "idle",
        permissionMode: "full",
        createdAt: now,
        updatedAt: now,
        ...extra,
      });

    add("t-open", { workspace: ws("b-open"), pr: prOf(1, "open") });
    add("t-draft", { workspace: ws("b-draft"), pr: prOf(2, "draft") });
    add("t-opened", { workspace: ws("b-opened", true) });
    add("t-merged", { workspace: ws("b-merged", true), pr: prOf(3, "merged") });
    add("t-closed", { workspace: ws("b-closed"), pr: prOf(4, "closed") });
    add("t-archived", { workspace: ws("b-arch"), pr: prOf(5, "open"), archived: true });
    add("t-no-ws", { pr: prOf(6, "open") });
    add("t-plain", { workspace: ws("b-plain") });

    // Simulate damaged JSON rows in `extra` and `workspace`: query must not throw.
    const rawDb = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    rawDb.exec(
      `INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, created_at, updated_at, workspace, extra)
       VALUES ('t-corrupt-extra', 'p1', 'c1', 'demo', 'idle', 'full', ${now}, ${now}, '${JSON.stringify(ws("b-c1", true))}', '{broken')`,
    );
    rawDb.exec(
      `INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, created_at, updated_at, workspace, extra)
       VALUES ('t-corrupt-ws', 'p1', 'c2', 'demo', 'idle', 'full', ${now}, ${now}, '{broken', '{"pr":{"state":"open"}}')`,
    );

    const ids = store
      .listWatchedPrThreads()
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["t-draft", "t-open", "t-opened"]);
  });
});

describe("pull requests through MoonAgentic's own GitHub sign-in", () => {
  const checks = {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  startedAt: "2026-11-27T10:00:00Z",
                  detailsUrl: "https://github.com/moon/demo/actions/runs/1/job/1",
                  checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                },
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  startedAt: "2026-11-27T11:00:00Z",
                  detailsUrl: "https://github.com/moon/demo/actions/runs/2/job/1",
                  checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "PENDING",
                  targetUrl: "https://example.com/deploy",
                  createdAt: "2026-11-27T11:00:00Z",
                },
              ],
            },
          },
        },
      },
    ],
  };

  async function api(answer: Parameters<typeof fakeGithubApi>[0]) {
    const fake = await fakeGithubApi(answer);
    cleanups.push(fake.close);
    return { ...fake, github: apiPullRequests(signedInAccount(fake.url, "gho_moon")) };
  }

  it("reads one by its number, its checks as gh gives them, with the account's token", async () => {
    const { github, calls } = await api(() => ({
      data: { repository: { pullRequest: graphqlPull({ commits: checks }) } },
    }));
    expect(await github.find("moon/demo", "42")).toEqual({
      repo: "moon/demo",
      number: 42,
      url: "https://github.com/moon/demo/pull/42",
      title: "Donne la réponse",
      state: "open",
      head: "a".repeat(40),
      base: "main",
      conflicts: false,
      blocked: false,
      // The run again counts once, as its last run.
      checks: [
        { name: "test", state: "passed", url: "https://github.com/moon/demo/actions/runs/2/job/1" },
        { name: "deploy", state: "pending", url: "https://example.com/deploy" },
      ],
      author: "moon",
      createdAt: Date.parse("2026-11-27T10:00:00Z"),
      additions: 3,
      deletions: 1,
      files: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/graphql", auth: "Bearer gho_moon" });
  });

  it("finds none for a number with no pull request, but says when the repository is out of reach", async () => {
    let missing = "Could not resolve to a PullRequest with the number of 999.";
    const { github } = await api(() => ({
      data: { repository: { pullRequest: null } },
      errors: [{ type: "NOT_FOUND", message: missing }],
    }));
    expect(await github.find("moon/demo", "999")).toBeUndefined();
    missing = "Could not resolve to a Repository with the name 'moon/secret'.";
    await expect(github.find("moon/secret", "1")).rejects.toThrow(
      "Could not resolve to a Repository",
    );
  });

  it("finds a branch's pull request: an open one first, never a fork's", async () => {
    const { github, calls } = await api(() => ({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              graphqlPull({ number: 50, isCrossRepository: true }),
              graphqlPull({ number: 45, state: "MERGED" }),
              graphqlPull({ number: 44 }),
              graphqlPull({ number: 40, state: "CLOSED" }),
            ],
          },
        },
      },
    }));
    expect((await github.find("moon/demo", "feature"))?.number).toBe(44);
    expect(calls[0]?.variables).toEqual({ owner: "moon", name: "demo", branch: "feature" });
  });

  it("lists the open ones by branch, in one question", async () => {
    const { github, calls } = await api(() => ({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              graphqlPull({ number: 44, headRefName: "a" }),
              graphqlPull({ number: 45, headRefName: "b", isDraft: true }),
              graphqlPull({ number: 46, headRefName: "a", isCrossRepository: true }),
            ],
          },
        },
      },
    }));
    const open = await github.listOpen!("moon/demo");
    expect([...open].map(([branch, pr]) => [branch, pr.number, pr.state])).toEqual([
      ["a", 44, "open"],
      ["b", 45, "draft"],
    ]);
    expect(calls).toHaveLength(1);
  });

  it("merges the way the repository allows, only if its last commit is still the one seen", async () => {
    const { github, calls } = await api((call) =>
      call.query?.includes("mergeCommitAllowed")
        ? {
            data: {
              repository: {
                mergeCommitAllowed: false,
                squashMergeAllowed: true,
                rebaseMergeAllowed: true,
                pullRequest: { id: "PR_node" },
              },
            },
          }
        : { data: { mergePullRequest: { pullRequest: { state: "MERGED" } } } },
    );
    await github.merge("moon/demo", 42, "b".repeat(40));
    expect(calls[1]?.query).toContain("mergePullRequest");
    expect(calls[1]?.variables).toEqual({ id: "PR_node", head: "b".repeat(40), method: "SQUASH" });
  });

  it("says why GitHub refused a merge", async () => {
    const { github } = await api((call) =>
      call.query?.includes("mergeCommitAllowed")
        ? { data: { repository: { pullRequest: { id: "PR_node" } } } }
        : { errors: [{ type: "UNPROCESSABLE", message: "Head branch was modified." }] },
    );
    await expect(github.merge("moon/demo", 42, "b".repeat(40))).rejects.toThrow(
      "Head branch was modified.",
    );
  });

  it("reads the review remarks and resolves a conversation", async () => {
    const { github, calls } = await api((call) =>
      call.query?.includes("resolveReviewThread")
        ? { data: { resolveReviewThread: { thread: { isResolved: true } } } }
        : {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "T1",
                        isResolved: false,
                        path: "a.ts",
                        line: 3,
                        comments: {
                          nodes: [{ author: { login: "neon" }, body: "Ça casse ici.", url: "" }],
                        },
                      },
                    ],
                  },
                  reviews: { nodes: [] },
                },
              },
            },
          },
    );
    expect(await github.remarks!("moon/demo", 42)).toEqual([
      { id: "T1", kind: "thread", author: "neon", path: "a.ts", line: 3, body: "Ça casse ici." },
    ]);
    await github.resolveRemark!("T1");
    expect(calls[1]?.variables).toEqual({ id: "T1" });
  });

  it("is what reads pull requests when MoonAgentic is signed in, gh or not", async () => {
    const fake = await fakeGithubApi(() => ({ data: {} }));
    cleanups.push(fake.close);
    const account = signedInAccount(fake.url);
    const gh = vi.fn(() => "/usr/bin/gh");
    await localPullRequests({ account: () => account, gh });
    expect(gh).not.toHaveBeenCalled();
    await account.logout();
    expect(
      await localPullRequests({ account: () => account, gh: () => undefined }),
    ).toBeUndefined();
    expect(await localPullRequests({ account: () => account, gh })).toBeDefined();
  });

  it("opens the pull request of a branch, or gives back the one already open", async () => {
    let open: unknown[] = [];
    const fake = await fakeGithubApi((call) =>
      call.method === "GET"
        ? open
        : call.body?.base === "nope"
          ? {
              status: 422,
              body: {
                message: "Validation Failed",
                errors: [{ message: "base nope does not exist" }],
              },
            }
          : { html_url: "https://github.com/moon/demo/pull/43" },
    );
    cleanups.push(fake.close);
    const account = signedInAccount(fake.url);
    expect(
      await openPullRequestWith(account, "moon/demo", "feat/x", "main", "Titre", "Corps"),
    ).toEqual({
      url: "https://github.com/moon/demo/pull/43",
    });
    expect(fake.calls[0]?.path).toBe("/repos/moon/demo/pulls?state=open&head=moon%3Afeat%2Fx");
    expect(fake.calls[1]).toMatchObject({
      method: "POST",
      path: "/repos/moon/demo/pulls",
      body: { title: "Titre", head: "feat/x", base: "main", body: "Corps" },
    });
    expect(
      await openPullRequestWith(account, "moon/demo", "feat/x", "nope", "Titre", "Corps"),
    ).toEqual({ error: "GitHub a répondu 422 : Validation Failed ; base nope does not exist." });
    open = [{ html_url: "https://github.com/moon/demo/pull/41" }];
    expect(
      await openPullRequestWith(account, "moon/demo", "feat/x", "main", "Titre", "Corps"),
    ).toEqual({
      url: "https://github.com/moon/demo/pull/41",
    });
  });
});
