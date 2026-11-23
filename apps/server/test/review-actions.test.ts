// What the review can do to a thread's branch beyond reading it: drop one file's changes,
// say where the branch stands against the one it started from, and merge that one in.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { forecastFor } from "../src/workspace.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

const identity = (dir: string) => {
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
};

/** A thread with its own branch on a repository pushed to a local bare remote. */
async function threadOnBranch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-revue-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  mkdirSync(repo);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  identity(repo);
  writeFileSync(path.join(repo, "README.md"), "# Demo\nune ligne\n");
  writeFileSync(path.join(repo, "notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
  });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const projectId = hub.createProject("demo", repo);
  const threadId = hub.createThread({
    projectId,
    agentId: "demo",
    permissionMode: "full",
    isolated: true,
    text: "Corrige le README",
  });
  await hub.whenIdle(threadId);
  const workspace = () => store.getThread(threadId)!.workspace!;
  return { root, repo, remote, hub, threadId, workspace, dir: workspace().path };
}

describe("dropping one file's changes", () => {
  it("puts a changed file back, removes a new one, and undoes a rename", async () => {
    const { hub, threadId, dir } = await threadOnBranch();
    writeFileSync(path.join(dir, "README.md"), "# Demo\nautre chose\n");
    writeFileSync(path.join(dir, "nouveau.txt"), "a\n");
    git(dir, "mv", "notes.md", "carnet.md");
    const paths = async () => (await hub.review(threadId)).files.map((f) => f.path).sort();
    expect(await paths()).toEqual(["README.md", "carnet.md", "nouveau.txt"]);

    await hub.rejectFile(threadId, "README.md");
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Demo\nune ligne\n");
    await hub.rejectFile(threadId, "nouveau.txt");
    expect(existsSync(path.join(dir, "nouveau.txt"))).toBe(false);
    await hub.rejectFile(threadId, "carnet.md", "notes.md");
    expect(existsSync(path.join(dir, "notes.md"))).toBe(true);
    expect(existsSync(path.join(dir, "carnet.md"))).toBe(false);
    expect(await paths()).toEqual([]);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("drops committed changes too, and only for a file the review lists", async () => {
    const { hub, threadId, dir, root } = await threadOnBranch();
    writeFileSync(path.join(dir, "README.md"), "# Demo\ncommité\n");
    git(dir, "commit", "-q", "-am", "change");
    expect((await hub.review(threadId)).files.map((f) => f.path)).toEqual(["README.md"]);
    await hub.rejectFile(threadId, "README.md");
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Demo\nune ligne\n");
    expect((await hub.review(threadId)).files).toEqual([]);

    // Nothing outside the review, and never outside the folder.
    writeFileSync(path.join(root, "dehors.txt"), "garde-moi\n");
    await expect(hub.rejectFile(threadId, "../dehors.txt")).rejects.toThrow(/plus de changement/);
    await expect(hub.rejectFile(threadId, "notes.md")).rejects.toThrow(/plus de changement/);
    expect(existsSync(path.join(root, "dehors.txt"))).toBe(true);
  });
});

describe("keeping up with the branch it started from", () => {
  it("says it is up to date, then behind, and merges main in with the work kept", async () => {
    const { repo, hub, threadId, dir, workspace } = await threadOnBranch();
    writeFileSync(path.join(dir, "README.md"), "# Demo\nle travail du fil\n");
    expect(await forecastFor(workspace())).toEqual({ target: "main", behind: 0, conflicts: [] });

    // main moves on locally, in another file.
    writeFileSync(path.join(repo, "notes.md"), "notes\nde main\n");
    git(repo, "commit", "-q", "-am", "main avance");
    expect(await forecastFor(workspace())).toEqual({ target: "main", behind: 1, conflicts: [] });
    // Looking ahead changes nothing in the folder.
    expect(git(dir, "status", "--porcelain")).toBe("M README.md");

    const before = workspace().base;
    await hub.syncWithBase(threadId);
    expect(workspace().base).toBe(git(repo, "rev-parse", "main"));
    expect(workspace().base).not.toBe(before);
    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("notes\nde main\n");
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Demo\nle travail du fil\n");
    // The review shows the thread's own work only, not what came from main.
    expect((await hub.review(threadId)).files.map((f) => f.path)).toEqual(["README.md"]);
    expect(await forecastFor(workspace())).toMatchObject({ behind: 0 });
  });

  it("names the files that would conflict, and merges nothing then", async () => {
    const { repo, hub, threadId, dir, workspace } = await threadOnBranch();
    writeFileSync(path.join(dir, "README.md"), "# Demo\ncôté fil\n");
    writeFileSync(path.join(repo, "README.md"), "# Demo\ncôté main\n");
    git(repo, "commit", "-q", "-am", "main avance");
    expect(await forecastFor(workspace())).toEqual({
      target: "main",
      behind: 1,
      conflicts: ["README.md"],
    });
    const head = git(dir, "rev-parse", "HEAD");
    await expect(hub.syncWithBase(threadId)).rejects.toThrow(/bloquerait sur 1 fichier/);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Demo\ncôté fil\n");
  });

  it("compares with the remote's main when a merge landed there first", async () => {
    const { root, remote, hub, threadId, dir, workspace } = await threadOnBranch();
    // A pull request merged on GitHub: the remote's main moves, the local one does not.
    const other = path.join(root, "autre");
    git(root, "clone", "-q", remote, other);
    identity(other);
    writeFileSync(path.join(other, "notes.md"), "notes\nfusionnées ailleurs\n");
    git(other, "commit", "-q", "-am", "fusion sur le remote");
    git(other, "push", "-q", "origin", "main");

    expect(await forecastFor(workspace())).toEqual({
      target: "origin/main",
      behind: 1,
      conflicts: [],
    });
    await hub.syncWithBase(threadId);
    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("notes\nfusionnées ailleurs\n");
    expect(workspace().base).toBe(git(dir, "rev-parse", "origin/main"));
  });
});
