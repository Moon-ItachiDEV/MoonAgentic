import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import {
  branchName,
  githubRepo,
  parseDiff,
  restoreCheckpoint,
  saveCheckpoint,
} from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Everything the agent said in the thread's last turn. */
const lastTurnSaid = (items: Item[]) =>
  items
    .slice(items.findLastIndex((i) => i.kind === "user"))
    .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
    .join(" ");

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
    expect((await hub.review(threadId)).files).toMatchObject([
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
    // Reviewing a new file stores nothing in git: only a commit does.
    const blob = git(workspace!.path, "hash-object", "nouveau.txt");
    expect(() => git(workspace!.path, "cat-file", "-e", blob)).toThrow();

    const shipped = await hub.ship(threadId, "Corrige le README", true);
    expect(shipped.commit).toMatch(/^[0-9a-f]{40}$/);
    // A remote that is not on GitHub gets the push but no pull request link.
    expect(shipped).toMatchObject({ prOpened: false });
    expect(shipped.url).toBeUndefined();
    expect(git(remote, "log", "-1", "--format=%s", workspace!.branch)).toBe("Corrige le README");
  });

  it("ships one branch at a time, never during a turn, and only from the thread's branch", async () => {
    const { hub, store, projectId } = repository();
    let asked = () => {};
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    const client = {
      messages: [] as ServerMessage[],
      send(m: ServerMessage) {
        this.messages.push(m);
        if (m.type === "thread" && m.thread.status === "waiting") asked();
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
    await waiting;
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
    // Handed to another agent since: going back goes back to the agent of that time too.
    await hub.switchAgent(threadId, "demo-2");
    await hub.restore(threadId, second.id);
    expect(store.getThread(threadId)?.agentId).toBe("demo");
    expect(store.listItems(threadId).some((i) => i.kind === "handoff")).toBe(false);

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
    expect(lastTurnSaid(store.listItems(threadId))).toContain(
      "J'ai reçu l'historique, qui commence par « Un ».",
    );
  });

  it("leaves nothing of a turn behind: neither files its own ignore rules hid, nor staged ones", async () => {
    const { repo } = repository();
    const tree = await saveCheckpoint(repo, "refs/moonagentic/test/1");
    writeFileSync(path.join(repo, ".gitignore"), "gen.txt\n");
    writeFileSync(path.join(repo, "gen.txt"), "produit\n");
    writeFileSync(path.join(repo, "indexe.txt"), "ajouté\n");
    git(repo, "add", "indexe.txt");
    writeFileSync(path.join(repo, "README.md"), "# Demo\nchangé puis indexé\n");
    git(repo, "add", "README.md");

    await restoreCheckpoint(repo, tree);
    expect(git(repo, "status", "--porcelain", "--ignored")).toBe("");
    expect(existsSync(path.join(repo, "gen.txt"))).toBe(false);

    // The same for a file removed with git itself.
    git(repo, "rm", "-q", "README.md");
    await restoreCheckpoint(repo, tree);
    expect(git(repo, "status", "--porcelain", "--ignored")).toBe("");
    expect(existsSync(path.join(repo, "README.md"))).toBe(true);
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
    // Nor a way back to an earlier message.
    const first = store.listItems(direct)[0]!;
    await expect(hub.restore(direct, first.id)).rejects.toThrow("pas de point de retour");
    expect(existsSync(path.join(root, "worktrees"))).toBe(false);
  });
});

describe("choosing what to ship", () => {
  it("commits only the files picked in the review, renames and deletions included", async () => {
    const { remote, store, hub, projectId } = repository();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Range les fichiers",
    });
    await hub.whenIdle(threadId);
    const dir = store.getThread(threadId)!.workspace!.path;
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    writeFileSync(path.join(dir, "brouillon.txt"), "x\n");
    git(dir, "add", "brouillon.txt");
    renameSync(path.join(dir, "README.md"), path.join(dir, "LISEZMOI.md"));

    const { files } = await hub.review(threadId);
    const renamed = files.find((f) => f.status === "renamed");
    expect(renamed).toMatchObject({ path: "LISEZMOI.md", from: "README.md" });
    await hub.ship(threadId, "Range", false, ["a.txt", "LISEZMOI.md", "README.md"]);

    const branch = store.getThread(threadId)!.workspace!.branch;
    const shipped = git(remote, "ls-tree", "-r", "--name-only", branch).split("\n");
    expect(shipped.sort()).toEqual(["LISEZMOI.md", "a.txt"]);
    // What was left out stays in the folder, as it was.
    expect(git(dir, "status", "--porcelain").split("\n").sort()).toEqual([
      "?? .env",
      "A  brouillon.txt",
    ]);
    await expect(hub.ship(threadId, "x", false, ["inconnu.txt"])).rejects.toThrow(
      "Aucun des fichiers",
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps a file replaced by a symbolic link in step with the files after it",
    async () => {
      const { store, hub, projectId, repo } = repository();
      writeFileSync(path.join(repo, "z.txt"), "z\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "z");
      const threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        isolated: true,
        text: "Lien",
      });
      await hub.whenIdle(threadId);
      const dir = store.getThread(threadId)!.workspace!.path;
      unlinkSync(path.join(dir, "README.md"));
      symlinkSync("z.txt", path.join(dir, "README.md"));
      writeFileSync(path.join(dir, "z.txt"), "z\nzz\n");
      const { files } = await hub.review(threadId);
      expect(files.map((f) => [f.path, f.status])).toEqual([
        ["README.md", "modified"],
        ["z.txt", "modified"],
      ]);
      expect(files[1]?.patch).toContain("+zz");
    },
  );
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
      {
        path: "new.txt",
        from: "old.txt",
        status: "renamed",
        added: 1,
        removed: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
      { path: "img.png", status: "added", added: null, removed: null, patch: "" },
    ]);
  });
});

describe("archiving, deleting and recovering thread workspaces", () => {
  const isolatedThread = async (hub: Hub, projectId: string, text = "Un") => {
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text,
    });
    await hub.whenIdle(threadId);
    return threadId;
  };

  it("archives a thread with its uncommitted files, and brings them back", async () => {
    const { hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const { path: dir, branch } = store.getThread(threadId)!.workspace!;
    writeFileSync(path.join(dir, "brouillon.txt"), "pas encore commité\n");

    await hub.setArchived(threadId, true);
    expect(store.getThread(threadId)).toMatchObject({ archived: true, status: "idle" });
    expect(existsSync(dir)).toBe(false);
    // The branch stays, with nothing of the thread lost.
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(() => hub.send(threadId, "Deux")).toThrow("archivé");

    await hub.setArchived(threadId, false);
    expect(store.getThread(threadId)?.archived).toBeUndefined();
    // Git writes files back with the line endings its config asks for (CRLF on Windows).
    expect(readFileSync(path.join(dir, "brouillon.txt"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "pas encore commité\n",
    );
    expect(store.getThread(threadId)?.workspace?.archivedTree).toBeUndefined();
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.status).toBe("idle");
  });

  it("deletes a thread and its worktree, and keeps its branch", async () => {
    const { hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    const { path: dir, branch } = store.getThread(threadId)!.workspace!;
    expect(git(repo, "for-each-ref", "refs/moonagentic")).not.toBe("");

    await hub.deleteThread(threadId);
    expect(store.getThread(threadId)).toBeUndefined();
    expect(store.listItems(threadId)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, "for-each-ref", "refs/moonagentic")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain(dir);
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
  });

  it("removes a project with its threads, and leaves its folder alone", async () => {
    const { hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    await hub.removeProject(projectId);
    expect(store.getProject(projectId)).toBeUndefined();
    expect(store.getThread(threadId)).toBeUndefined();
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toContain("# Demo");
    expect(hub.snapshot().projects).toEqual([]);
  });

  it("works in the project's folder inside the worktree when the project is a subfolder", async () => {
    const { hub, store, repo } = repository();
    mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
    writeFileSync(path.join(repo, "apps", "web", "page.ts"), "export {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "web");
    const projectId = hub.createProject("web", path.join(repo, "apps", "web"));
    const threadId = await isolatedThread(hub, projectId);
    const workspace = store.getThread(threadId)!.workspace!;
    expect(workspace.subdir).toBe("apps/web");
    // The thread's files are those of its folder, as the agent sees them.
    const client = { send: (m: ServerMessage) => replies.push(m) };
    const replies: ServerMessage[] = [];
    await hub.handle(client, {
      type: "files.search",
      requestId: "f1",
      projectId,
      threadId,
      query: "page",
    });
    expect(replies.at(-1)).toMatchObject({ type: "files", files: ["page.ts"] });
  });

  it("finishes a worktree that a stop left unrecorded, or that went missing", async () => {
    const { hub, store, repo, root, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const workspace = store.getThread(threadId)!.workspace!;
    writeFileSync(path.join(workspace.path, "commité.txt"), "garde\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "commit", "-q", "-m", "travail");

    // Made by git, never recorded: as if the server stopped right after creating it.
    const { base: _base, ...unrecorded } = workspace;
    store.updateThread(threadId, { workspace: unrecorded });
    // And its folder deleted by hand since, once the agent no longer holds it (Windows).
    await hub.close();
    rmSync(workspace.path, { recursive: true, force: true });
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(() => restarted.close());

    restarted.send(threadId, "Deux");
    await restarted.whenIdle(threadId);
    const recovered = store.getThread(threadId)!.workspace!;
    expect(recovered.base).toBe(git(repo, "rev-parse", "main"));
    expect(
      readFileSync(path.join(recovered.path, "commité.txt"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("garde\n");
    expect((await restarted.review(threadId)).files.map((f) => f.path)).toEqual(["commité.txt"]);
  });

  it("finishes a step back that a stop cut in half", async () => {
    const { hub, store, root, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const dir = store.getThread(threadId)!.workspace!.path;
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    const second = store.listItems(threadId).filter((i) => i.kind === "user")[1]!;
    if (second.kind !== "user" || !second.checkpoint) throw new Error("no checkpoint");
    writeFileSync(path.join(dir, "après.txt"), "à défaire\n");

    // Written down, then the server stops before doing anything.
    store.setSetting("pendingRestores", {
      [threadId]: { itemId: second.id, tree: second.checkpoint },
    });
    await hub.close();
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    await restarted.recovered;
    expect(existsSync(path.join(dir, "après.txt"))).toBe(false);
    expect(
      store
        .listItems(threadId)
        .filter((i) => i.kind === "user")
        .map((i) => i.text),
    ).toEqual(["Un"]);
    expect(store.getSetting("pendingRestores", {})).toEqual({});
  });

  it("forgets a step back that failed, so a restart never replays it", async () => {
    const { hub, store, root, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    const second = store.listItems(threadId).filter((i) => i.kind === "user")[1]!;
    if (second.kind !== "user") throw new Error("no user item");
    // A point of return git no longer has: going back to it fails.
    store.putItem(threadId, { ...second, checkpoint: "0".repeat(40) });

    await expect(hub.restore(threadId, second.id)).rejects.toThrow();
    expect(store.getSetting("pendingRestores", {})).toEqual({});
    hub.send(threadId, "Trois");
    await hub.whenIdle(threadId);
    await hub.close();
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    await restarted.recovered;
    expect(
      store
        .listItems(threadId)
        .filter((i) => i.kind === "user")
        .map((i) => i.text),
    ).toEqual(["Un", "Deux", "Trois"]);
  });

  it("changes nothing on an archived thread, and keeps it archived if it cannot come back", async () => {
    const { hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const first = store.listItems(threadId).find((i) => i.kind === "user")!;
    await hub.setArchived(threadId, true);

    await expect(hub.review(threadId)).rejects.toThrow("archivé");
    await expect(hub.ship(threadId, "msg", false)).rejects.toThrow("archivé");
    await expect(hub.restore(threadId, first.id)).rejects.toThrow("archivé");
    await expect(hub.setModel(threadId, "x")).rejects.toThrow("archivé");
    await expect(hub.setSetting(threadId, "mode", "x")).rejects.toThrow("archivé");
    await expect(hub.switchAgent(threadId, "other")).rejects.toThrow("archivé");

    // The project's folder has moved: the worktree cannot be made again.
    renameSync(repo, `${repo}-ailleurs`);
    await expect(hub.setArchived(threadId, false)).rejects.toThrow();
    expect(store.getThread(threadId)).toMatchObject({ archived: true });
    expect(store.getThread(threadId)?.workspace?.archivedTree).toBeDefined();

    renameSync(`${repo}-ailleurs`, repo);
    await hub.setArchived(threadId, false);
    expect(store.getThread(threadId)?.archived).toBeUndefined();
  });

  it("removes a project's worktrees even when its folder is gone", async () => {
    const { hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const dir = store.getThread(threadId)!.workspace!.path;
    rmSync(repo, { recursive: true, force: true });

    await hub.removeProject(projectId);
    expect(existsSync(dir)).toBe(false);
    expect(store.getProject(projectId)).toBeUndefined();
  });

  it("takes no new thread or message in a project while it is being removed", async () => {
    const { hub, store, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const other = await isolatedThread(hub, projectId, "Autre");
    const removing = hub.removeProject(projectId);
    expect(() =>
      hub.createThread({ projectId, agentId: "demo", permissionMode: "full", text: "Non" }),
    ).toThrow("Projet introuvable");
    expect(() => hub.send(other, "Non")).toThrow();
    await removing;
    expect(store.getThread(threadId)).toBeUndefined();
    expect(store.getThread(other)).toBeUndefined();
  });
});
