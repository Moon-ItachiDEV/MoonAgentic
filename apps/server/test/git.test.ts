import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { branchName, githubRepo, parseDiff } from "../src/git.ts";
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

/** A repository with one commit on main, pushed to a local bare remote. */
function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-git-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  mkdirSync(repo);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\nune ligne\n");
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
  return { root, repo, remote, store, hub, projectId: hub.createProject("demo", repo) };
}

describe("thread workspaces", () => {
  it("gives a thread its own branch, reviews its changes, then commits and pushes them", async () => {
    const { repo, remote, store, hub, projectId } = repository();
    // A diff tool from the user's own config must not replace the unified diff.
    git(repo, "config", "diff.external", "echo external");
    expect(hub.snapshot().projects[0]?.git).toBe(true);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Corrige le README",
    });
    await hub.whenIdle(threadId);

    const workspace = store.getThread(threadId)?.workspace;
    expect(workspace?.branch).toMatch(/^moon\/corrige-le-readme-/);
    expect(workspace?.baseBranch).toBe("main");
    expect(git(workspace!.path, "branch", "--show-current")).toBe(workspace?.branch);

    // What an agent would do in its worktree, while the project folder stays untouched.
    writeFileSync(path.join(workspace!.path, "README.md"), "# Demo\nune autre ligne\n");
    writeFileSync(path.join(workspace!.path, "nouveau.txt"), "a\nb\n");
    expect(await hub.review(threadId)).toMatchObject([
      { path: "README.md", status: "modified", added: 1, removed: 1 },
      {
        path: "nouveau.txt",
        status: "added",
        added: 2,
        removed: 0,
        patch: "@@ -0,0 +1,2 @@\n+a\n+b",
      },
    ]);
    expect(git(repo, "status", "--porcelain")).toBe("");

    const shipped = await hub.ship(threadId, "Corrige le README", true);
    expect(shipped.commit).toMatch(/^[0-9a-f]{40}$/);
    // A remote that is not on GitHub gets the push but no pull request link.
    expect(shipped).toMatchObject({ prOpened: false });
    expect(shipped.url).toBeUndefined();
    expect(git(remote, "log", "-1", "--format=%s", workspace!.branch)).toBe("Corrige le README");
  });

  it("ships one branch at a time, never during a turn, and only from the thread's branch", async () => {
    const { hub, store, projectId } = repository();
    const client = {
      messages: [] as ServerMessage[],
      send(m: ServerMessage) {
        this.messages.push(m);
      },
    };
    hub.connect(client);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      isolated: true,
      text: "Un",
    });
    // The demo agent waits for this answer, so its turn is still running.
    await vi.waitUntil(() => store.getThread(threadId)?.status === "waiting");
    await expect(hub.ship(threadId, "x", false)).rejects.toThrow("Attends la fin");
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    const workspace = store.getThread(threadId)!.workspace!;
    writeFileSync(path.join(workspace.path, "a.txt"), "a\n");
    const first = hub.ship(threadId, "Ajoute a", false);
    expect(() => hub.send(threadId, "Deux")).toThrow("envoi de la branche");
    await expect(hub.ship(threadId, "x", false)).rejects.toThrow("envoi de la branche");
    await first;

    git(workspace.path, "checkout", "-q", "-b", "autre");
    await expect(hub.ship(threadId, "x", false)).rejects.toThrow("plus sur la branche");

    // A review that cannot be read still answers the panel waiting for it. Windows keeps
    // a folder that a live process works in, so the agent stops first.
    await hub.close();
    rmSync(workspace.path, { recursive: true, force: true });
    await hub.handle(client, { type: "workspace.review", threadId });
    expect(client.messages.at(-1)).toMatchObject({
      type: "review",
      files: [],
      error: expect.any(String),
    });
  });

  it("goes back to the files before a message, and the agent starts over from what is left", async () => {
    const { hub, store, projectId } = repository();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const dir = store.getThread(threadId)!.workspace!.path;
    writeFileSync(path.join(dir, "README.md"), "# Demo\npremier tour\n");
    writeFileSync(path.join(dir, ".gitignore"), "cache/\n");
    mkdirSync(path.join(dir, "cache"));
    writeFileSync(path.join(dir, "cache", "garde.txt"), "ignoré\n");
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    const second = store.listItems(threadId).filter((i) => i.kind === "user")[1]!;
    expect(second).toMatchObject({
      text: "Deux",
      checkpoint: expect.stringMatching(/^[0-9a-f]{40}$/),
    });

    // What the second turn did, which going back must undo.
    writeFileSync(path.join(dir, "README.md"), "# Demo\nsecond tour\n");
    mkdirSync(path.join(dir, "src", "neuf"), { recursive: true });
    writeFileSync(path.join(dir, "src", "neuf", "a.ts"), "export {};\n");
    // Without its rule, the ignored file would pass for one the turn made.
    rmSync(path.join(dir, ".gitignore"));
    await hub.restore(threadId, second.id);

    // Git writes restored files with the line endings its config asks for (CRLF on Windows).
    expect(readFileSync(path.join(dir, "README.md"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "# Demo\npremier tour\n",
    );
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(dir, "src"))).toBe(false);
    expect(readFileSync(path.join(dir, "cache", "garde.txt"), "utf8")).toBe("ignoré\n");
    expect(
      store
        .listItems(threadId)
        .filter((i) => i.kind === "user")
        .map((i) => i.text),
    ).toEqual(["Un"]);
    expect(store.getSessionId(threadId)).toBeNull();
    expect(git(dir, "for-each-ref", "--format=%(refname)", "refs/moonagentic")).not.toContain(
      second.id.replace("user:", ""),
    );

    hub.send(threadId, "Trois");
    await hub.whenIdle(threadId);
    expect(store.listItems(threadId).findLast((i) => i.kind === "agent")).toMatchObject({
      text: expect.stringContaining("J'ai reçu l'historique, qui commence par « Un »."),
    });
    // A message without its own branch has nothing to go back to.
    const direct = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "x",
    });
    await hub.whenIdle(direct);
    const first = store.listItems(direct)[0]!;
    await expect(hub.restore(direct, first.id)).rejects.toThrow("pas de point de retour");
  });

  it("works in the project folder when asked, or when the folder is not in git", async () => {
    const { root, hub, store, projectId } = repository();
    const direct = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    const plainProject = hub.createProject("plain", plain);
    const notGit = hub.createThread({
      projectId: plainProject,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Deux",
    });
    await hub.whenIdle(direct);
    await hub.whenIdle(notGit);

    expect(store.getThread(direct)?.workspace).toBeUndefined();
    expect(store.getThread(notGit)?.workspace).toBeUndefined();
    // A repository without a commit has nothing for a branch to start from.
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    hub.createProject("empty", empty);
    expect(hub.snapshot().projects.find((p) => p.name === "empty")?.git).toBeUndefined();
    await expect(hub.ship(direct, "x", false)).rejects.toThrow("sans branche");
    expect(existsSync(path.join(root, "worktrees"))).toBe(false);
  });
});

describe("git helpers", () => {
  it("reads GitHub remotes in their https and ssh forms only", () => {
    for (const url of [
      "https://github.com/moon/app.git",
      "https://github.com/moon/app",
      "https://x-access-token:abc@github.com/moon/app.git",
      "git@github.com:moon/app.git",
      "ssh://git@github.com/moon/app.git",
    ])
      expect(githubRepo(url)).toBe("moon/app");
    expect(githubRepo("https://gitlab.com/moon/app.git")).toBeUndefined();
    expect(githubRepo("/tmp/remote.git")).toBeUndefined();
  });

  it("names branches after the thread, readable and safe for git", () => {
    expect(branchName("Corrige l'écran « Réglages » !", "abcdef123")).toBe(
      "moon/corrige-l-ecran-reglages-abcdef",
    );
    expect(branchName("???", "abcdef123")).toBe("moon/abcdef");
  });

  it("pairs renames and binary files with their counts", () => {
    const numstat = "1\t1\t\0old.txt\0new.txt\0-\t-\timg.png\0";
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 80%",
      "rename from old.txt",
      "rename to new.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "Binary files /dev/null and b/img.png differ",
      "",
    ].join("\n");
    expect(parseDiff(numstat, patch)).toEqual([
      { path: "new.txt", status: "renamed", added: 1, removed: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "img.png", status: "added", added: null, removed: null, patch: "" },
    ]);
  });
});
