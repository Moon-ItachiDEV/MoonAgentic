// « Nettoyer les branches »: which `moon/*` branches can go, and that only those do.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { type BranchOwner, deleteMergedBranches, projectBranches } from "../src/branches.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function tempDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-branches-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function newRepo(dir: string) {
  git(path.dirname(dir), "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A branch off main with one commit writing `file`. */
function branchWith(repo: string, branch: string, file: string) {
  git(repo, "checkout", "-q", "-b", branch, "main");
  writeFileSync(path.join(repo, file), `${branch}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `work on ${branch}`);
  git(repo, "checkout", "-q", "main");
}

const branchList = (repo: string) =>
  git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();

describe("the moon/* branches of a project", { timeout: 40_000 }, () => {
  it("tells merged, squashed, unmerged and used branches apart", async () => {
    const root = tempDir();
    const repo = newRepo(path.join(root, "repo"));
    branchWith(repo, "moon/merged-aaaaaa", "a.txt");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge a", "moon/merged-aaaaaa");
    branchWith(repo, "moon/squashed-bbbbbb", "b.txt");
    git(repo, "merge", "-q", "--squash", "moon/squashed-bbbbbb");
    git(repo, "commit", "-q", "-m", "squash b");
    branchWith(repo, "moon/open-cccccc", "c.txt");
    branchWith(repo, "moon/worktree-dddddd", "d.txt");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge d", "moon/worktree-dddddd");
    git(repo, "worktree", "add", "-q", path.join(root, "wt"), "moon/worktree-dddddd");
    git(repo, "branch", "moon/live-eeeeee");
    git(repo, "branch", "moon/archived-ffffff");
    // Not one of MoonAgentic's: never listed.
    branchWith(repo, "feature", "f.txt");
    const owners: BranchOwner[] = [
      { id: "t-live", title: "Fil vivant", branch: "moon/live-eeeeee" },
      { id: "t-arch", title: "Fil rangé", branch: "moon/archived-ffffff", archived: true },
    ];

    const { targets, branches } = await projectBranches(repo, owners);
    expect(targets).toEqual(["main"]);
    const states = Object.fromEntries(branches.map((b) => [b.name, b.state]));
    expect(states).toEqual({
      "moon/merged-aaaaaa": "merged",
      "moon/squashed-bbbbbb": "merged",
      "moon/open-cccccc": "unmerged",
      "moon/worktree-dddddd": "inUse",
      "moon/live-eeeeee": "inUse",
      "moon/archived-ffffff": "merged",
    });
    expect(branches.find((b) => b.name === "moon/open-cccccc")?.ahead).toBe(1);
    expect(branches.find((b) => b.name === "moon/archived-ffffff")?.thread).toEqual({
      id: "t-arch",
      title: "Fil rangé",
      archived: true,
    });
    // Merged ones first, those that cannot go last.
    expect(branches.map((b) => b.state)).toEqual([
      "merged",
      "merged",
      "merged",
      "unmerged",
      "inUse",
      "inUse",
    ]);
  });

  it("deletes only the branches still merged and unused when it looks again", async () => {
    const root = tempDir();
    const repo = newRepo(path.join(root, "repo"));
    branchWith(repo, "moon/merged-aaaaaa", "a.txt");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge a", "moon/merged-aaaaaa");
    branchWith(repo, "moon/later-bbbbbb", "b.txt");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge b", "moon/later-bbbbbb");
    git(repo, "branch", "moon/live-cccccc");
    git(repo, "worktree", "add", "-q", "-b", "moon/wt-eeeeee", path.join(root, "wt"));
    // Listed merged, then given a new commit before the user confirmed.
    git(repo, "checkout", "-q", "moon/later-bbbbbb");
    writeFileSync(path.join(repo, "b2.txt"), "encore\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more on b");
    git(repo, "checkout", "-q", "main");
    const owners: BranchOwner[] = [{ id: "t", title: "Fil", branch: "moon/live-cccccc" }];

    const result = await deleteMergedBranches(repo, owners, [
      "moon/merged-aaaaaa",
      "moon/later-bbbbbb",
      "moon/live-cccccc",
      "moon/nope-dddddd",
      "moon/wt-eeeeee",
      "main",
    ]);
    expect(result.deleted).toEqual(["moon/merged-aaaaaa"]);
    expect(Object.fromEntries(result.kept.map((k) => [k.name, k.reason]))).toEqual({
      "moon/later-bbbbbb": expect.stringMatching(/pas fusionné/),
      "moon/live-cccccc": expect.stringMatching(/fil travaille/),
      "moon/nope-dddddd": expect.stringMatching(/n'existe plus/),
      "moon/wt-eeeeee": expect.stringMatching(/dossier de travail/),
      // Only moon/* branches are ever listed, so another name is never deleted.
      main: expect.stringMatching(/n'existe plus/),
    });
    expect(branchList(repo)).toEqual([
      "main",
      "moon/later-bbbbbb",
      "moon/live-cccccc",
      "moon/wt-eeeeee",
    ]);
  });

  it("counts a branch merged on the remote as merged, while main is behind", async () => {
    const root = tempDir();
    const origin = newRepo(path.join(root, "origin"));
    git(root, "clone", "-q", origin, "repo");
    const repo = path.join(root, "repo");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    branchWith(repo, "moon/pr-aaaaaa", "a.txt");
    git(repo, "push", "-q", "origin", "moon/pr-aaaaaa");
    // The pull request merged on the remote; the local main never pulled it.
    git(origin, "merge", "-q", "--no-ff", "-m", "Merge pull request #1", "moon/pr-aaaaaa");

    const { targets, branches } = await projectBranches(repo, []);
    expect(targets).toEqual(["main", "origin/main"]);
    expect(branches).toMatchObject([{ name: "moon/pr-aaaaaa", state: "merged", ahead: 0 }]);
  });
});

describe("cleaning a project's branches from the page", { timeout: 40_000 }, () => {
  it("keeps a live thread's branch, and an archived thread comes back after its branch goes", async () => {
    const root = tempDir();
    const repo = newRepo(path.join(root, "repo"));
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(async () => {
      await hub.close();
      store.close();
    });
    const projectId = hub.createProject("demo", repo);
    const start = (text: string) =>
      hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text,
      });
    const archivedId = start("Premier");
    const liveId = start("Second");
    await Promise.all([hub.whenIdle(archivedId), hub.whenIdle(liveId)]);
    const archived = store.getThread(archivedId)!.workspace!;
    const live = store.getThread(liveId)!.workspace!;
    writeFileSync(path.join(archived.path, "brouillon.txt"), "pas commité\n");
    await hub.setArchived(archivedId, true);

    const messages: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void messages.push(m) };
    await hub.handle(client as never, { type: "project.branches", requestId: "r1", projectId });
    const listed = messages.at(-1);
    expect(listed).toMatchObject({ type: "projectBranches", requestId: "r1", targets: ["main"] });
    const byName = Object.fromEntries(
      (listed as Extract<ServerMessage, { type: "projectBranches" }>).branches.map((b) => [
        b.name,
        b,
      ]),
    );
    expect(byName[archived.branch]).toMatchObject({
      state: "merged",
      thread: { id: archivedId, archived: true },
    });
    expect(byName[live.branch]).toMatchObject({ state: "inUse", thread: { id: liveId } });

    await hub.handle(client as never, {
      type: "project.deleteBranches",
      requestId: "r2",
      projectId,
      branches: [archived.branch, live.branch],
    });
    expect(messages.at(-1)).toMatchObject({
      type: "branchesDeleted",
      requestId: "r2",
      deleted: [archived.branch],
      kept: [{ name: live.branch }],
    });
    expect(branchList(repo)).not.toContain(archived.branch);

    // Out of the archive, the thread gets its branch again from where it started, with its files.
    await hub.setArchived(archivedId, false);
    expect(branchList(repo)).toContain(archived.branch);
    expect(existsSync(archived.path)).toBe(true);
    expect(readFileSync(path.join(archived.path, "brouillon.txt"), "utf8")).toMatch(/pas commité/);
  });

  it("refuses a project that is not a git repository", async () => {
    const root = tempDir();
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(async () => {
      await hub.close();
      store.close();
    });
    const projectId = hub.createProject("plain", root);
    await expect(
      hub.handle({ send: () => undefined } as never, {
        type: "project.branches",
        requestId: "r",
        projectId,
      }),
    ).rejects.toThrow(/pas un dépôt git/);
  });
});
