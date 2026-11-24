import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeRepo } from "../src/git.ts";
import { orphanRef, sweepWorktrees } from "../src/worktree-sweep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();

/** A repository with one commit, and the worktrees folder of a MoonAgentic data folder. */
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-sweep-"));
  dirs.push(root);
  const repo = path.join(root, "projet");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "projet\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "début");
  const worktrees = path.join(root, "data", "worktrees");
  mkdirSync(worktrees, { recursive: true });
  const add = (name: string) => {
    git(repo, "worktree", "add", "-q", "-b", `fil-${name}`, path.join(worktrees, name));
    return path.join(worktrees, name);
  };
  return { root, repo, worktrees, add };
}

describe("worktree sweep", () => {
  it("removes the worktrees no thread holds, keeping their files in the repository", async () => {
    const { repo, worktrees, add } = setup();
    const orphan = add("aaaa1111");
    writeFileSync(path.join(orphan, "pas-commité.txt"), "travail en cours\n");
    const held = add("bbbb2222");
    const now = Date.now() + 2 * 60 * 60_000;

    const removed = await sweepWorktrees(worktrees, () => ["bbbb2222"], now);

    expect(removed).toEqual(["aaaa1111"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(held)).toBe(true);
    // Git forgot the folder, but its uncommitted file is still there to take back.
    expect(git(repo, "worktree", "list")).not.toContain("aaaa1111");
    const tree = git(repo, "rev-parse", orphanRef("aaaa1111", now));
    expect(git(repo, "show", `${tree}:pas-commité.txt`)).toBe("travail en cours");
    // Its branch stays too, with its commits.
    expect(git(repo, "branch", "--list", "fil-aaaa1111")).toContain("fil-aaaa1111");
  });

  it("leaves alone a folder made in the last hour, as a thread may be making it", async () => {
    const { worktrees, add } = setup();
    const fresh = add("cccc3333");
    expect(await sweepWorktrees(worktrees, () => [])).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("removes a folder no repository holds, and asks again which ones are held", async () => {
    const { worktrees, add } = setup();
    const halfMade = path.join(worktrees, "dddd4444");
    mkdirSync(path.join(halfMade, "src"), { recursive: true });
    add("eeee5555");
    let asked = 0;
    const removed = await sweepWorktrees(
      worktrees,
      () => {
        asked++;
        // A thread takes the second folder while the first goes.
        return asked > 1 ? ["eeee5555"] : [];
      },
      Date.now() + 2 * 60 * 60_000,
    );
    expect(removed).toEqual(["dddd4444"]);
    expect(existsSync(halfMade)).toBe(false);
    expect(existsSync(path.join(worktrees, "eeee5555"))).toBe(true);
  });

  it("never takes a plain folder inside another repository for one of its worktrees", async () => {
    const { repo, add } = setup();
    const plain = path.join(repo, "data", "worktrees", "ffff6666");
    mkdirSync(plain, { recursive: true });
    expect(await worktreeRepo(plain)).toBeUndefined();
    expect(await worktreeRepo(add("abcd0000"))).toBe(realpathSync.native(repo));
  });
});
