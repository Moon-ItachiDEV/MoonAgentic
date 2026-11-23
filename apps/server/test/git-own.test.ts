// A project's folder brings its own git settings, and some of them name a command for git
// to run. The server reads the folder without running any of them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFiles } from "../src/files.ts";
import { commitAll, isGitRepo, reviewChanges, saveCheckpoint } from "../src/git.ts";
import { gitQuietEnv } from "../src/git-own.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();

/**
 * A repository whose settings name a command for git to run when it looks at the files
 * (`core.fsmonitor`) and another when it shows a text file (`textconv`). Each leaves a
 * file behind when it runs.
 */
function trapped() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-git-own-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(root, "repo");
  mkdirSync(dir);
  const trap = (name: string) => {
    const script = path.join(root, `${name}.cjs`);
    const left = path.join(root, `${name}.ran`);
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(left)}, "");\n`);
    // Run through a shell by git, on Windows too: `/` in both paths, each in quotes.
    const command = [process.execPath, script].map((p) => `"${p.replaceAll("\\", "/")}"`).join(" ");
    return { command, ran: () => existsSync(left), reset: () => rmSync(left, { force: true }) };
  };
  const fsmonitor = trap("fsmonitor");
  const textconv = trap("textconv");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(dir, "notes.txt"), "avant\n");
  writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=piege\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "départ"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["config", "core.fsmonitor", fsmonitor.command]);
  git(dir, ["config", "diff.piege.textconv", textconv.command]);
  writeFileSync(path.join(dir, "notes.txt"), "après\n");
  writeFileSync(path.join(dir, "nouveau.txt"), "nouveau\n");
  return { dir, base, fsmonitor, textconv };
}

describe("a project's own git settings", () => {
  it("do not make the server run a command when it reads the folder", async () => {
    const { dir, base, fsmonitor, textconv } = trapped();
    // The traps are set: git on its own runs both.
    git(dir, ["status", "--porcelain"]);
    expect(fsmonitor.ran()).toBe(true);
    git(dir, ["diff", "HEAD"]);
    expect(textconv.ran()).toBe(true);
    fsmonitor.reset();
    textconv.reset();

    expect(isGitRepo(dir)).toBe(true);
    expect((await listFiles(dir)).sort()).toEqual([".gitattributes", "notes.txt", "nouveau.txt"]);
    const { files } = await reviewChanges(dir, base);
    expect(files.map((f) => f.path).sort()).toEqual(["notes.txt", "nouveau.txt"]);
    // The review shows the file's own lines, not what a converter would say of them.
    expect(files.find((f) => f.path === "notes.txt")?.patch).toContain("+après");
    await saveCheckpoint(dir, "refs/moonagentic/test");
    expect(await commitAll(dir, "suite")).toBe(true);
    expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("après\n");

    expect(fsmonitor.ran()).toBe(false);
    expect(textconv.ran()).toBe(false);
  });

  it("stay quiet for a program that runs git itself, such as gh", () => {
    const { dir, fsmonitor } = trapped();
    git(dir, ["status", "--porcelain"], { ...process.env, ...gitQuietEnv() });
    expect(fsmonitor.ran()).toBe(false);
    // Settings already given through the environment are kept, ours comes after them.
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "A" };
    expect(gitQuietEnv(env)).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
    git(dir, ["status", "--porcelain"], { ...process.env, ...env, ...gitQuietEnv(env) });
    expect(fsmonitor.ran()).toBe(false);
  });
});
