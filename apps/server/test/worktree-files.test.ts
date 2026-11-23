// The review's « Fichiers » tab: what of a thread's folder it lists and lets the page read.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { MAX_READ_BYTES, readWorktreeFile, worktreeFiles } from "../src/workspace.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

async function threadFolder() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-fichiers-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  writeFileSync(path.join(repo, "src/app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, ".gitignore"), "secret.txt\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
  });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const threadId = hub.createThread({
    projectId: hub.createProject("demo", repo),
    agentId: "demo",
    permissionMode: "full",
    isolated: true,
    text: "Corrige le README",
  });
  await hub.whenIdle(threadId);
  const workspace = store.getThread(threadId)!.workspace!;
  return { root, workspace, dir: workspace.path };
}

describe("the files of a thread's folder", { timeout: 40_000 }, () => {
  it("lists tracked and new files, leaves ignored ones out, and reads text", async () => {
    const { workspace, dir } = await threadFolder();
    writeFileSync(path.join(dir, "src/new.ts"), "export const b = 2;\n");
    writeFileSync(path.join(dir, "secret.txt"), "chut\n");
    const { files, capped } = await worktreeFiles(workspace);
    expect([...files].sort()).toEqual([".gitignore", "README.md", "src/app.ts", "src/new.ts"]);
    expect(capped).toBe(false);
    expect(await readWorktreeFile(workspace, "src/new.ts")).toEqual({
      text: "export const b = 2;\n",
    });
  });

  it("leaves out a file removed from the folder, not committed yet", async () => {
    const { workspace, dir } = await threadFolder();
    rmSync(path.join(dir, "src/app.ts"));
    expect((await worktreeFiles(workspace)).files).not.toContain("src/app.ts");
    await expect(readWorktreeFile(workspace, "src/app.ts")).rejects.toThrow(/pas dans la copie/);
  });

  it("says so when git cannot list the folder, rather than list ignored files", async () => {
    const { workspace, dir } = await threadFolder();
    writeFileSync(path.join(dir, "secret.txt"), "chut\n");
    // The folder's link to its repository broken: git no longer knows it.
    writeFileSync(path.join(dir, ".git"), "gitdir: /nulle/part\n");
    await expect(worktreeFiles(workspace)).rejects.toThrow();
    await expect(readWorktreeFile(workspace, "secret.txt")).rejects.toThrow();
  });

  it("gives only the size of a binary or very large file", async () => {
    const { workspace, dir } = await threadFolder();
    writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    writeFileSync(path.join(dir, "big.log"), "x".repeat(MAX_READ_BYTES + 1));
    await worktreeFiles(workspace);
    expect(await readWorktreeFile(workspace, "logo.png")).toEqual({ binary: true, size: 7 });
    expect(await readWorktreeFile(workspace, "big.log")).toEqual({ size: MAX_READ_BYTES + 1 });
  });

  it("reads nothing the list does not hold, nor anything outside the folder", async () => {
    const { workspace, dir, root } = await threadFolder();
    writeFileSync(path.join(root, "dehors.txt"), "hors du dossier\n");
    writeFileSync(path.join(dir, "secret.txt"), "chut\n");
    await worktreeFiles(workspace);
    for (const file of [
      "../dehors.txt",
      "secret.txt",
      ".git/config",
      path.join(root, "dehors.txt"),
    ]) {
      await expect(readWorktreeFile(workspace, file)).rejects.toThrow(/pas dans la copie/);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symbolic link out of the folder",
    async () => {
      const { workspace, dir, root } = await threadFolder();
      writeFileSync(path.join(root, "dehors.txt"), "hors du dossier\n");
      symlinkSync(path.join(root, "dehors.txt"), path.join(dir, "lien.txt"));
      expect((await worktreeFiles(workspace)).files).toContain("lien.txt");
      await expect(readWorktreeFile(workspace, "lien.txt")).rejects.toThrow(/pas dans la copie/);
    },
  );
});
