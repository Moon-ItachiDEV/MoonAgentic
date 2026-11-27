// A new thread starts from what GitHub has of the project's branch, not from the copy the
// project's folder was last pulled at; the folder itself catches up when nothing is lost.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { freshStart } from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

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
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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

// Many git commands each: Windows runners are slow at them.
describe("where a new thread starts", { timeout: 40_000 }, () => {
  it("starts from GitHub's copy and brings the project's folder up to it", async () => {
    const { root, repo, merged } = mergedElsewhere();
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(async () => {
      await hub.close();
      store.close();
    });
    const projectId = hub.createProject("demo", repo);
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
});
