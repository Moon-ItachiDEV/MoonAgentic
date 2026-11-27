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
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import {
  branchName,
  ensureWorktree,
  githubRepo,
  parseDiff,
  prTitle,
  removeWorktree,
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
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const before = hub.attachments.add(png, "avant.png");
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Un",
      attachments: [before.id],
    });
    await hub.whenIdle(threadId);
    const dir = store.getThread(threadId)!.workspace!.path;
    writeFileSync(path.join(dir, "README.md"), "# Demo\npremier tour\n");
    writeFileSync(path.join(dir, ".gitignore"), "cache/\n");
    mkdirSync(path.join(dir, "cache"));
    writeFileSync(path.join(dir, "cache", "garde.txt"), "ignoré\n");
    const after = hub.attachments.add(png, "après.png");
    hub.send(threadId, "Deux", undefined, undefined, undefined, undefined, [after.id]);
    await hub.whenIdle(threadId);
    expect(hub.attachments.find(threadId, after.id)).toBeDefined();
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
    // The image of the message taken out goes with it; an earlier message keeps its own.
    expect(hub.attachments.find(threadId, after.id)).toBeUndefined();
    expect(hub.attachments.find(threadId, before.id)).toBeDefined();
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
      "J'ai reçu l'historique, qui commence par « Un [image jointe : ",
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
  it("makes and removes worktrees of one repository one at a time, all of them kept", async () => {
    const { root, repo } = repository();
    const base = git(repo, "rev-parse", "HEAD");
    const dirs = [0, 1, 2, 3].map((i) => path.join(root, "worktrees", `w${i}`));
    await Promise.all(dirs.map((dir, i) => ensureWorktree(repo, dir, `piece-${i}`, base)));
    for (const dir of dirs) expect(existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(5);
    // A removal running beside new worktrees takes none of them with it.
    const more = [4, 5].map((i) => path.join(root, "worktrees", `w${i}`));
    await Promise.all([
      removeWorktree(repo, dirs[0]!),
      ...more.map((dir, i) => ensureWorktree(repo, dir, `piece-${i + 4}`, base)),
    ]);
    expect(existsSync(dirs[0]!)).toBe(false);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(6);
  });

  it("leaves a worktree it already made as it is, merge under way included", async () => {
    // On Windows the temp folder is often given by its short name (RUNNER~1), and git by
    // the long one: the worktree must still be recognised, not made again from scratch.
    const { root, repo } = repository();
    const base = git(repo, "rev-parse", "HEAD");
    const dir = path.join(root, "worktrees", "kept");
    await ensureWorktree(repo, dir, "kept", base);
    writeFileSync(path.join(dir, "brouillon.txt"), "pas encore commité\n");
    // A merge under way, as git leaves it (newer git refuses update-ref on MERGE_HEAD).
    writeFileSync(
      path.resolve(dir, git(dir, "rev-parse", "--git-path", "MERGE_HEAD")),
      `${base}\n`,
    );
    await ensureWorktree(repo, dir, "kept", base);
    expect(existsSync(path.join(dir, "brouillon.txt"))).toBe(true);
    expect(git(dir, "rev-parse", "MERGE_HEAD")).toBe(base);
  });

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
    for (const bad of [
      "https://github.com/-evil/app.git",
      "https://github.com/moon/..",
      "https://github.com/moon/.",
      "https://github.com/moon/...git",
      "https://github.com/moon/app?x=1",
      "https://github.com/a b/c d",
    ])
      expect(githubRepo(bad)).toBeUndefined();
  });

  it("makes a one-line pull request title GitHub takes, from a long task over several lines", () => {
    expect(prTitle("Corrige  le bug\n\net ajoute un test")).toBe(
      "Corrige le bug et ajoute un test",
    );
    const long = prTitle("mot ".repeat(100));
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
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

  it("removes on start the worktrees no thread holds, and keeps those that one does", async () => {
    const { root, hub, store, repo, projectId } = repository();
    const threadId = await isolatedThread(hub, projectId);
    const held = store.getThread(threadId)!.workspace!.path;
    // A review cut short by a stop leaves a folder no thread ever recorded.
    const orphan = path.join(root, "worktrees", "0rphan00");
    git(repo, "worktree", "add", "-q", "-b", "revue-coupee", orphan);
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    for (const dir of [orphan, held]) utimesSync(dir, longAgo, longAgo);
    await hub.close();

    const again = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(() => again.close());
    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false), { timeout: 20_000 });
    expect(existsSync(held)).toBe(true);
    // When git could not remove it, the folder goes first and git forgets it a moment after.
    await vi.waitFor(() => expect(git(repo, "worktree", "list")).not.toContain("0rphan00"), {
      timeout: 10_000,
    });
  }, 40_000);

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
    expect(() => hub.send(threadId, "Deux")).toThrow("résolu");

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

    await expect(hub.review(threadId)).rejects.toThrow("résolu");
    await expect(hub.ship(threadId, "msg", false)).rejects.toThrow("résolu");
    await expect(hub.restore(threadId, first.id)).rejects.toThrow("résolu");
    await expect(hub.setModel(threadId, "x")).rejects.toThrow("résolu");
    await expect(hub.setSetting(threadId, "mode", "x")).rejects.toThrow("résolu");
    await expect(hub.switchAgent(threadId, "other")).rejects.toThrow("résolu");

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

describe("teams", () => {
  const team = (
    hub: Hub,
    projectId: string,
    task: string,
    permissionMode: "full" | "supervised" = "full",
    checks: { reviewer?: boolean; tester?: boolean; merger?: boolean } = {},
  ) =>
    hub.startTeam({
      projectId,
      task,
      lead: { agentId: "demo" },
      coder: { agentId: "demo" },
      ...(checks.reviewer ? { reviewer: { agentId: "demo" } } : {}),
      ...(checks.tester ? { tester: { agentId: "demo" } } : {}),
      ...(checks.merger ? { merger: { agentId: "demo" } } : {}),
      coders: 2,
      permissionMode,
    });
  const asked = (store: Store, threadId: string) =>
    store.listItems(threadId).flatMap((i) => (i.kind === "user" ? [i.text] : []));

  it("has the lead split the task, then coders do the pieces at once, each on its own branch", async () => {
    const { hub, store, projectId } = repository();
    const seen: ServerMessage[] = [];
    hub.connect({ send: (m) => seen.push(m) });
    const leadId = team(hub, projectId, "Corrige answer et documente-la");
    expect(store.getThread(leadId)).toMatchObject({
      role: "lead",
      title: expect.stringContaining("Équipe"),
    });
    // The lead's thread is never seen without its team.
    const first = seen.find((m) => m.type === "thread" && m.thread.id === leadId);
    expect(first?.type === "thread" && first.thread.team?.phase).toBe("planning");

    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    const { tasks } = store.getThread(leadId)!.team!;
    expect(tasks.map((t) => [t.title, t.status])).toEqual([
      ["Corriger answer", "done"],
      ["Documenter answer", "done"],
    ]);
    // The lead's plan fed the planner, and each card followed its piece to the end.
    expect(hub.snapshot().plan).toMatchObject([
      { title: "Corriger answer", status: "live", source: "lead", team: { leadId, index: 0 } },
      { title: "Documenter answer", status: "live", source: "lead", team: { leadId, index: 1 } },
    ]);
    const moves = seen.flatMap((m) =>
      m.type === "planTask" && m.task.team?.index === 0 ? [m.task.status] : [],
    );
    expect(moves[0]).toMatch(/^(todo|doing)$/);
    expect(moves.at(-1)).toBe("live");
    const coders = tasks.map((t) => store.getThread(t.threadId!)!);
    for (const coder of coders) {
      expect(coder).toMatchObject({ role: "coder", parentId: leadId, status: "idle" });
      expect(coder.workspace?.base).toBeDefined();
    }
    expect(new Set(coders.map((c) => c.workspace!.branch)).size).toBe(2);
    // The coder got its own piece of work, not the whole plan.
    const asked = store.listItems(coders[1]!.id).find((i) => i.kind === "user");
    expect(asked?.kind === "user" && asked.text).toContain("Ajoute une ligne sur answer");
  });

  it("tells the lead the team's real state when the user writes to it, unseen in the thread", async () => {
    const { hub, store, projectId } = repository();
    const client = { send: () => {} };
    hub.connect(client);
    const leadId = team(hub, projectId, "Corrige answer et documente-la");
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    await hub.handle(client, { type: "thread.send", threadId: leadId, text: "ETA" });
    // The demo agent repeats what it was asked: the lead got the state before the message.
    const reply = () =>
      store
        .listItems(leadId)
        .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
        .at(-1) ?? "";
    await expect.poll(reply, { timeout: 10_000 }).toContain("ETA");
    expect(reply()).toContain("Phase : terminée");
    expect(reply()).toContain("« Corriger answer » : terminée, fusionnée.");
    // The user's bubble holds only what they wrote.
    expect(asked(store, leadId).at(-1)).toBe("ETA");
    await hub.cancel(leadId);
  }, 40_000);

  it("merges every piece's branch onto one, in a thread the user can review and ship", async () => {
    const { hub, store, repo, projectId } = repository();
    const leadId = team(hub, projectId, "Corrige answer et documente-la");
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    const done = store.getThread(leadId)!.team!;
    expect(done.tasks.every((t) => t.merged)).toBe(true);
    const merge = store.getThread(done.mergeThreadId!)!;
    expect(merge).toMatchObject({
      role: "merger",
      parentId: leadId,
      title: expect.stringContaining("Fusion"),
    });
    // Each coder's work was committed on its branch, then merged as a commit of its own.
    const branch = merge.workspace!.branch;
    expect(git(repo, "show", `${branch}:equipe/corriger-answer.md`)).toBe("# Corriger answer");
    expect(git(repo, "show", `${branch}:equipe/documenter-answer.md`)).toBe("# Documenter answer");
    expect(git(repo, "log", "--format=%s", branch).split("\n")).toEqual(
      expect.arrayContaining([
        "Fusion : Corriger answer",
        "Fusion : Documenter answer",
        "Corriger answer",
      ]),
    );
    // The merge thread starts without a message; the user ships it like any other.
    expect(asked(store, merge.id)).toEqual([]);
    const { files } = await hub.review(merge.id);
    expect(files.map((f) => f.path).sort()).toEqual([
      "equipe/corriger-answer.md",
      "equipe/documenter-answer.md",
    ]);
  });

  it("pushes its branch by itself once done, as a cloud agent would, or says why it could not", async () => {
    const { hub, store, repo, remote, projectId } = repository();
    const leadId = team(hub, projectId, "Corrige answer et documente-la");
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    // The remote is no GitHub repository: the branch is pushed, with no pull request to open.
    await expect
      .poll(() => store.getThread(leadId)?.team?.shipped, { timeout: 10_000 })
      .toEqual({ opened: false });
    const branch = store.getThread(store.getThread(leadId)!.team!.mergeThreadId!)!.workspace!
      .branch;
    expect(git(remote, "show", `${branch}:equipe/corriger-answer.md`)).toBe("# Corriger answer");

    // Without a remote, the team stays done and says why; asked again, it tries again.
    git(repo, "remote", "remove", "origin");
    const client = { send: () => {} };
    hub.connect(client);
    await expect(
      hub.handle(client, { type: "team.ship", requestId: "s", threadId: leadId }),
    ).resolves.toBeUndefined();
    expect(store.getThread(leadId)?.team).toMatchObject({
      phase: "done",
      shipError: expect.stringContaining("remote"),
    });
  }, 40_000);

  it("waits for the user when asked to, pushes once for two asks at once, and says a cut push", async () => {
    const { hub, store, remote, projectId } = repository();
    const leadId = hub.startTeam({
      projectId,
      task: "Corrige answer et documente-la",
      lead: { agentId: "demo" },
      coder: { agentId: "demo" },
      coders: 2,
      permissionMode: "full",
      autoShip: false,
    });
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    // Asked not to, the team pushes nothing by itself.
    await new Promise((r) => setTimeout(r, 300));
    const branch = store.getThread(store.getThread(leadId)!.team!.mergeThreadId!)!.workspace!
      .branch;
    expect(store.getThread(leadId)?.team).not.toHaveProperty("shipping");
    expect(() => git(remote, "rev-parse", "--verify", branch)).toThrow();

    // Two asks at once make one push, and neither leaves an error behind.
    const client = { send: () => {} };
    hub.connect(client);
    const ask = (requestId: string) =>
      hub.handle(client, { type: "team.ship", requestId, threadId: leadId });
    const both = Promise.all([ask("a"), ask("b")]);
    expect(store.getThread(leadId)?.team?.shipping).toBe(true);
    await both;
    const team = store.getThread(leadId)!.team!;
    expect(team.shipped).toEqual({ opened: false });
    expect(team).not.toHaveProperty("shipError");
    expect(team).not.toHaveProperty("shipping");
    expect(git(remote, "rev-parse", "--verify", branch)).toBeTruthy();

    // A push cut off by a stop is said so after the restart, to be tried again.
    store.updateThread(leadId, { team: { ...team, shipping: true } });
    hub.teams.recover();
    expect(store.getThread(leadId)?.team).toMatchObject({
      shipError: expect.stringContaining("réessaie"),
    });
    expect(store.getThread(leadId)?.team).not.toHaveProperty("shipping");
  }, 40_000);

  it("leaves a conflict to the user without a merger, and merges on once it is settled", async () => {
    const { hub, store, repo, projectId } = repository();
    const leadId = team(hub, projectId, "Écris en conflit");
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 })
      .toBe("blocked");
    const blocked = store.getThread(leadId)!.team!;
    expect(blocked.error).toContain("conflit.txt");
    expect(blocked.tasks.map((t) => t.merged)).toEqual([true, undefined]);

    // A merge thread deleted takes its branch with it: a new one merges every piece again.
    await hub.deleteThread(blocked.mergeThreadId!);
    await hub.handle(
      { send: () => undefined },
      { type: "team.retry", requestId: "r", threadId: leadId },
    );
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 })
      .toBe("blocked");
    const again = store.getThread(leadId)!.team!;
    expect(again.mergeThreadId).not.toBe(blocked.mergeThreadId);
    expect(again.tasks.map((t) => t.merged)).toEqual([true, undefined]);
    expect(again.error).toContain("conflit.txt");
    await expect(
      hub.handle(
        { send: () => undefined },
        { type: "team.retry", requestId: "r", threadId: leadId },
      ),
    ).rejects.toThrow("conflits dans conflit.txt");

    // The user settles it in the merge thread's folder.
    const dir = store.getThread(again.mergeThreadId!)!.workspace!.path;
    writeFileSync(path.join(dir, "conflit.txt"), "A\nB\n");
    git(dir, "add", "conflit.txt");
    await expect(
      hub.handle(
        { send: () => undefined },
        { type: "team.retry", requestId: "r", threadId: leadId },
      ),
    ).rejects.toThrow("commit");
    git(dir, "commit", "-q", "--no-edit");
    await hub.handle(
      { send: () => undefined },
      { type: "team.retry", requestId: "r", threadId: leadId },
    );
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    expect(store.getThread(leadId)!.team!.tasks.every((t) => t.merged)).toBe(true);
    expect(
      git(repo, "show", `${store.getThread(again.mergeThreadId!)!.workspace!.branch}:conflit.txt`),
    ).toBe("A\nB");
  });

  it("has the merger settle conflicts and check the pieces together", async () => {
    const { hub, store, projectId } = repository();
    const clean = team(hub, projectId, "Corrige answer", "full", { merger: true });
    await expect.poll(() => store.getThread(clean)?.team?.phase, { timeout: 30_000 }).toBe("done");
    const merger = store.getThread(clean)!.team!.mergeThreadId!;
    expect(asked(store, merger)).toEqual([expect.stringContaining("Lance les tests du projet")]);

    // The demo merger gives up on a conflict and aborts the merge: the piece is not counted
    // as merged, and the merge waits on the user.
    const clash = team(hub, projectId, "Écris en conflit", "full", { merger: true });
    await expect
      .poll(() => store.getThread(clash)?.team?.phase, { timeout: 30_000 })
      .toBe("blocked");
    const team2 = store.getThread(clash)!.team!;
    expect(team2.error).toContain("« Écrire B » n'a pas été fusionnée");
    expect(team2.tasks.map((t) => t.merged)).toEqual([true, undefined]);
    expect(team2.mergeStep).toBeUndefined();
    expect(asked(store, team2.mergeThreadId!)[0]).toContain("- conflit.txt");
    // Two teams and their merges: more than the usual time on a slow Windows machine.
  }, 40_000);

  it("asks the lead again for a plan it cannot read, then gives up", async () => {
    const { hub, store, projectId } = repository();
    const leadId = team(hub, projectId, "Fais-le sans plan");
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 })
      .toBe("failed");
    expect(store.getThread(leadId)?.team).toMatchObject({ planTries: 3, tasks: [] });
    expect(store.listItems(leadId).filter((i) => i.kind === "user")).toHaveLength(3);
  });

  it("stops the team with every coder at work, and refuses to put it away meanwhile", async () => {
    const { hub, store, projectId } = repository();
    // Supervised coders wait on their first permission request.
    const leadId = team(hub, projectId, "Corrige answer", "supervised");
    await expect
      .poll(() => store.getThread(leadId)?.team?.tasks.filter((t) => t.threadId).length, {
        timeout: 30_000,
      })
      .toBe(2);
    await expect(hub.deleteThread(leadId)).rejects.toThrow("équipe");
    await expect(hub.setArchived(leadId, true)).rejects.toThrow("équipe");
    // Nor its coders' threads, whose folder a reviewer or a tester may be working in.
    const coderId = store.getThread(leadId)!.team!.tasks[0]!.threadId!;
    expect(hub.teams.isActive(coderId)).toBe(true);
    // Nor does the project go, not even in part.
    const before = store.listThreads().length;
    await expect(hub.removeProject(projectId)).rejects.toThrow("travaille encore");
    expect(store.listThreads()).toHaveLength(before);

    await hub.teams.stop(leadId);
    const stopped = store.getThread(leadId)!.team!;
    expect(stopped.phase).toBe("stopped");
    for (const t of stopped.tasks) {
      await hub.whenIdle(t.threadId!);
      expect(store.getThread(t.threadId!)?.status).toBe("idle");
    }
    expect(store.getThread(leadId)!.team!.tasks.map((t) => t.status)).toEqual([
      "stopped",
      "stopped",
    ]);

    // Once stopped, the team is put away, brought back and deleted whole: no thread is left
    // without its lead.
    const memberIds = store
      .listThreads()
      .filter((t) => t.parentId === leadId)
      .map((t) => t.id);
    expect(memberIds.length).toBeGreaterThanOrEqual(2);
    await hub.setArchived(leadId, true);
    for (const id of [leadId, ...memberIds]) expect(store.getThread(id)?.archived).toBe(true);
    await hub.setArchived(leadId, false);
    for (const id of [leadId, ...memberIds]) expect(store.getThread(id)?.archived).toBeUndefined();
    await hub.deleteThread(leadId);
    for (const id of [leadId, ...memberIds]) expect(store.getThread(id)).toBeUndefined();
  });

  it("gives the lead's access to the whole team, and to the agents it starts later", async () => {
    const { hub, store, projectId } = repository();
    const leadId = team(hub, projectId, "Corrige answer", "supervised");
    await expect
      .poll(() => store.getThread(leadId)?.team?.tasks.filter((t) => t.threadId).length, {
        timeout: 30_000,
      })
      .toBe(2);
    hub.setPermissionMode(leadId, "full");
    const lead = store.getThread(leadId)!;
    expect(lead.permissionMode).toBe("full");
    expect(lead.team!.permissionMode).toBe("full");
    for (const t of lead.team!.tasks)
      expect(store.getThread(t.threadId!)?.permissionMode).toBe("full");
    await hub.teams.stop(leadId);
    for (const t of store.getThread(leadId)!.team!.tasks) await hub.whenIdle(t.threadId!);
  });

  it("has each piece reviewed then tested in its coder's folder before it counts as done", async () => {
    const { hub, store, projectId } = repository();
    // The demo reviewer leaves its verdict out the first time.
    const leadId = team(hub, projectId, "Corrige answer sans verdict", "full", {
      reviewer: true,
      tester: true,
    });
    await expect.poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 }).toBe("done");
    // The timeline holds each step as it happened, in order.
    const timeline = store.getThread(leadId)!.team!.timeline!;
    expect(timeline.filter((e) => e.lane === 0).map((e) => e.phase)).toEqual([
      "running",
      "reviewing",
      "testing",
      "done",
    ]);
    expect(timeline.filter((e) => e.lane === -1).map((e) => e.phase)).toEqual(["planning", "idle"]);
    expect(timeline.filter((e) => e.lane === -2).map((e) => e.phase)).toEqual(["merging", "done"]);
    expect(timeline.map((e) => e.at)).toEqual(timeline.map((e) => e.at).sort((a, b) => a - b));
    for (const task of store.getThread(leadId)!.team!.tasks) {
      expect(task).toMatchObject({ status: "done", reviewThreadId: expect.any(String) });
      const coder = store.getThread(task.threadId!)!;
      const reviewer = store.getThread(task.reviewThreadId!)!;
      const tester = store.getThread(task.testThreadId!)!;
      expect(reviewer).toMatchObject({
        role: "reviewer",
        parentId: leadId,
        worksIn: coder.id,
        // The team's access; the hub still asks before a reviewer changes a file.
        permissionMode: "full",
      });
      expect(reviewer.workspace).toBeUndefined();
      expect(tester).toMatchObject({ role: "tester", worksIn: coder.id, permissionMode: "full" });
      const [review, again] = asked(store, reviewer.id);
      expect(review).toContain("Ses changements");
      expect(review).toContain(task.brief);
      expect(again).toContain("verdict");
      expect(asked(store, tester.id)[0]).toContain("Lance les tests");
      // Nothing went back to the coder.
      expect(asked(store, coder.id)).toHaveLength(1);
      // The reviewer and the tester work in the coder's worktree.
      writeFileSync(path.join(coder.workspace!.path, `seulement-${coder.id}.txt`), "");
      const seen: ServerMessage[] = [];
      await hub.handle(
        { send: (m) => seen.push(m) },
        {
          type: "files.search",
          requestId: "r",
          projectId,
          threadId: tester.id,
          query: "seulement",
        },
      );
      expect(JSON.stringify(seen)).toContain(`seulement-${coder.id}.txt`);
    }
  }, 40_000);

  it("sends fixes back three times, then to the lead once, then leaves the piece to the user", async () => {
    const { hub, store, projectId } = repository();
    const leadId = team(hub, projectId, "Corrige answer, à toujours refuser", "full", {
      reviewer: true,
    });
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 60_000 })
      .toBe("blocked");
    const blocked = store.getThread(leadId)!.team!;
    for (const task of blocked.tasks) {
      expect(task).toMatchObject({
        status: "blocked",
        tries: 3,
        leadHelped: true,
        brief: "Passe answer à 42, et rien d'autre.",
        note: expect.stringContaining("Il manque"),
      });
      const coder = asked(store, task.threadId!);
      expect(coder).toHaveLength(5);
      expect(coder[1]).toContain("correction 1 sur 3");
      expect(coder[4]).toContain("Le chef a revu ta consigne");
    }
    expect(blocked.leadTask).toBeUndefined();
    // The plan, then one rewritten brief for each piece, one after the other.
    expect(asked(store, leadId).filter((t) => t.includes("bloque après"))).toHaveLength(2);
    // Nothing runs: the lead can be put away, and the user can start a piece again.
    expect(hub.teams.isActive(leadId)).toBe(false);

    // A piece whose coder's thread was deleted starts over with a new coder.
    const gone = blocked.tasks[1]!;
    // Its reviewer's agent, working in its folder, stops first (Windows holds the folder).
    const live = hub.liveAgents;
    await hub.deleteThread(gone.threadId!);
    expect(hub.liveAgents).toBe(live - 2);
    expect(store.getThread(gone.reviewThreadId!)).toBeDefined();
    await hub.handle(
      { send: () => undefined },
      { type: "team.retry", requestId: "r", threadId: leadId, index: 1 },
    );
    const again = store.getThread(leadId)!.team!.tasks[1]!;
    expect(again.threadId).toBeDefined();
    expect(again.threadId).not.toBe(gone.threadId);
    expect(again.reviewThreadId).toBeUndefined();
    expect(asked(store, again.threadId!)[0]).toContain("Tu fais partie d'une équipe");

    await hub.handle(
      { send: () => undefined },
      { type: "team.retry", requestId: "r", threadId: leadId, index: 0 },
    );
    expect(store.getThread(leadId)!.team).toMatchObject({ phase: "coding" });
    expect(store.getThread(leadId)!.team!.tasks[0]).toMatchObject({ status: "running", tries: 0 });
    expect(asked(store, blocked.tasks[0]!.threadId!).at(-1)).toContain("Reprends ta sous-tâche");
    await expect(
      hub.handle(
        { send: () => undefined },
        { type: "team.retry", requestId: "r", threadId: leadId, index: 0 },
      ),
    ).rejects.toThrow("déjà en cours");
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 60_000 })
      .toBe("blocked");
    // The project goes whole, reviewers first, though they work in their coders' folders.
    await hub.removeProject(projectId);
    expect(store.listThreads()).toEqual([]);
    // Its waits allow a minute: Windows runners take about 15 s for the whole round.
  }, 90_000);

  it("marks a team cut short by a stop of the server, keeping what was done", async () => {
    const { hub, store, root, projectId } = repository();
    const leadId = team(hub, projectId, "Corrige answer", "supervised");
    await expect
      .poll(() => store.getThread(leadId)?.team?.phase, { timeout: 30_000 })
      .toBe("coding");
    await hub.close();
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    expect(store.getThread(leadId)?.team).toMatchObject({
      phase: "stopped",
      error: expect.stringContaining("arrêt"),
    });
  });
});
