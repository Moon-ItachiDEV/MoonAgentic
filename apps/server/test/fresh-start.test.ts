// A new thread starts from what GitHub has of the project's branch, not from the copy the
// project's folder was last pulled at; the folder itself catches up when nothing is lost.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { freshStart } from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import type { Client } from "../src/hub.ts";
import { removeTempDir } from "./temp-dir.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

const identity = (dir: string) => {
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
};

/** A project's folder pushed to a bare remote, then a pull request merged on the remote. */
function mergedElsewhere() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-fresh-"));
  cleanups.push(() => removeTempDir(root));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  mkdirSync(repo);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  identity(repo);
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  writeFileSync(path.join(repo, "notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  const old = git(repo, "rev-parse", "HEAD");
  const other = path.join(root, "autre");
  git(root, "clone", "-q", remote, other);
  identity(other);
  writeFileSync(path.join(other, "fusion.md"), "fusionnée sur GitHub\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "Merge pull request #1");
  git(other, "push", "-q", "origin", "main");
  return { root, repo, old, merged: git(other, "rev-parse", "HEAD") };
}

/** A hub on that folder, closed after the test. */
function hubOn(root: string, repo: string) {
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
  });
  cleanups.unshift(async () => {
    await hub.close();
    store.close();
  });
  return { hub, store, projectId: hub.createProject("demo", repo) };
}

const client: Client = { send: () => undefined };

// Many git commands each: Windows runners are slow at them.
describe("where a new thread starts", { timeout: 40_000 }, () => {
  it("starts from GitHub's copy and brings the project's folder up to it", async () => {
    const { root, repo, merged } = mergedElsewhere();
    const { hub, store, projectId } = hubOn(root, repo);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Bonjour",
    });
    await hub.whenIdle(threadId);
    const workspace = store.getThread(threadId)!.workspace!;
    expect(workspace.base).toBe(merged);
    expect(workspace.baseBranch).toBe("main");
    expect(read(path.join(workspace.path, "fusion.md"))).toBe("fusionnée sur GitHub\n");
    // The folder was only behind: it moved forward, as a `git pull --ff-only` would.
    expect(git(repo, "rev-parse", "HEAD")).toBe(merged);
    expect(existsSync(path.join(repo, "fusion.md"))).toBe(true);
  });

  it("leaves a folder with changes as it is, and still starts from GitHub's copy", async () => {
    const { repo, old, merged } = mergedElsewhere();
    writeFileSync(path.join(repo, "notes.md"), "notes\nen cours\n");
    expect(await freshStart(repo, true)).toMatchObject({ base: merged, baseBranch: "main" });
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
    expect(read(path.join(repo, "notes.md"))).toBe("notes\nen cours\n");
  });

  it("does not move the folder when asked not to", async () => {
    const { repo, old, merged } = mergedElsewhere();
    expect(await freshStart(repo, false)).toMatchObject({ base: merged });
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  });

  it("keeps the folder's own commits: it starts from them, nothing moves", async () => {
    const { repo } = mergedElsewhere();
    writeFileSync(path.join(repo, "local.md"), "à moi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "local");
    const mine = git(repo, "rev-parse", "HEAD");
    expect(await freshStart(repo, true)).toMatchObject({ base: mine, baseBranch: "main" });
    expect(git(repo, "rev-parse", "HEAD")).toBe(mine);
  });

  it("starts from the folder when its branch has no remote", async () => {
    const { repo } = mergedElsewhere();
    git(repo, "checkout", "-q", "-b", "seule");
    const here = git(repo, "rev-parse", "HEAD");
    expect(await freshStart(repo, true)).toEqual({ base: here, baseBranch: "seule" });
  });

  it("leaves a folder with an untracked file as it is", async () => {
    const { repo, old, merged } = mergedElsewhere();
    writeFileSync(path.join(repo, "brouillon.md"), "pas encore ajouté\n");
    expect(await freshStart(repo, true)).toMatchObject({ base: merged });
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  });

  it("only moves the default branch, never another one", async () => {
    const { root, repo } = mergedElsewhere();
    git(repo, "checkout", "-q", "-b", "travail");
    git(repo, "push", "-q", "-u", "origin", "travail");
    const mine = git(repo, "rev-parse", "HEAD");
    const other = path.join(root, "autre");
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-q", "-b", "travail", "origin/travail");
    writeFileSync(path.join(other, "travail.md"), "poussé ailleurs\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "ailleurs");
    git(other, "push", "-q", "origin", "travail");
    const ahead = git(other, "rev-parse", "HEAD");
    // The thread still starts from the remote's copy of the branch it was on.
    expect(await freshStart(repo, true)).toMatchObject({ base: ahead, baseBranch: "travail" });
    expect(git(repo, "rev-parse", "HEAD")).toBe(mine);
  });

  it("gives up on a remote that does not answer within a few seconds", async () => {
    const { repo, old } = mergedElsewhere();
    // A remote that hangs: the fetch is cut short and the folder's own copy is used.
    git(repo, "config", "remote.origin.uploadpack", "sleep 12; git-upload-pack");
    const startedAt = Date.now();
    expect(await freshStart(repo, true)).toMatchObject({ base: old });
    // Cut at the start's own limit: neither the remote's 12 s nor a failure at once.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_500);
    expect(Date.now() - startedAt).toBeLessThan(11_000);
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
    // The remote's side sleeps on after the cut: its folder is removed once it is done.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 13_000 - (Date.now() - startedAt))),
    );
  });

  it("does not move the folder under a turn that works in it", async () => {
    const { root, repo, old, merged } = mergedElsewhere();
    const { hub, store, projectId } = hubOn(root, repo);
    // Its own turn would bring the folder up first: off while it starts.
    await hub.handle(client, { type: "project.setAutoPull", projectId, on: false });
    // A thread right in the folder, its turn held on a permission.
    const inFolder = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      isolated: false,
      text: "Modifie le README",
    });
    await vi.waitFor(() => expect(store.getThread(inFolder)?.status).toBe("waiting"), {
      timeout: 15_000,
    });
    await hub.handle(client, { type: "project.setAutoPull", projectId, on: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Bonjour",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)!.workspace!.base).toBe(merged);
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
    await hub.cancel(inFolder);
  });

  it("gives two threads started at once the same fresh copy", async () => {
    const { repo, merged } = mergedElsewhere();
    const [a, b] = await Promise.all([freshStart(repo, false), freshStart(repo, false)]);
    expect(a.base).toBe(merged);
    expect(b.base).toBe(merged);
  });

  it("brings the folder up before a turn of a thread that works right in it", async () => {
    const { root, repo, merged } = mergedElsewhere();
    const { hub, projectId } = hubOn(root, repo);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: false,
      text: "Bonjour",
    });
    await hub.whenIdle(threadId);
    expect(git(repo, "rev-parse", "HEAD")).toBe(merged);
  });

  it("leaves the folder alone when the project says so, threads still start fresh", async () => {
    const { root, repo, old, merged } = mergedElsewhere();
    const { hub, store, projectId } = hubOn(root, repo);
    await hub.handle(client, { type: "project.setAutoPull", projectId, on: false });
    expect(hub.snapshot().projects.find((p) => p.id === projectId)?.autoPull).toBe(false);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Bonjour",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)!.workspace!.base).toBe(merged);
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
    await hub.handle(client, { type: "project.setAutoPull", projectId, on: true });
    expect(hub.snapshot().projects.find((p) => p.id === projectId)?.autoPull).toBeUndefined();
  });

  it("never moves another branch that follows the remote's default one", async () => {
    const { repo, old } = mergedElsewhere();
    git(repo, "checkout", "-q", "-b", "ma-branche", "--track", "origin/main");
    await freshStart(repo, true);
    expect(git(repo, "branch", "--show-current")).toBe("ma-branche");
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  });

  it("asks whether the folder may move only once the remote answered", async () => {
    const { repo, old, merged } = mergedElsewhere();
    let seen = "";
    await freshStart(repo, () => {
      seen = git(repo, "rev-parse", "origin/main");
      return false;
    });
    expect(seen).toBe(merged);
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  });

  it("stops a turn at once while the remote does not answer", async () => {
    const { root, repo } = mergedElsewhere();
    git(repo, "config", "remote.origin.uploadpack", "sleep 12; git-upload-pack");
    const { hub, store, projectId } = hubOn(root, repo);
    const startedAt = Date.now();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: false,
      text: "Bonjour",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 13_000 - (Date.now() - startedAt))),
    );
  });
});
