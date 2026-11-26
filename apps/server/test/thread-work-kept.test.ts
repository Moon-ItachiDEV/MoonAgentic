// A thread's folder can hold work that is nowhere else: files not committed yet, files put
// there by hand, files git ignores. Here git fails, forgets the folder or is cut short, two
// threads get ids that start alike, the data folder is reached by another path, a thread is
// resolved or steps back: the work stays, or the step is refused.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { ensureWorktree, rejectFile, saveCheckpoint } from "../src/git.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { sweepWorktrees } from "../src/worktree-sweep.ts";

const rigged = vi.hoisted(() => ({
  /** The next git command whose arguments hold `match` fails, once; every other is real. */
  failing: undefined as { match: string; how: "error" | "no answer"; done: boolean } | undefined,
  /** What the next thread ids start with, in place of their first eight characters. */
  idStart: undefined as string | undefined,
  /** The arguments of every git command run, when set. */
  gitCalls: undefined as string[][] | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (...call: unknown[]) => {
    const [file, args] = call;
    const failing = rigged.failing;
    const done = call.at(-1);
    if (file === "git" && Array.isArray(args)) rigged.gitCalls?.push(args.map(String));
    if (
      file === "git" &&
      Array.isArray(args) &&
      typeof done === "function" &&
      failing &&
      !failing.done &&
      args.join(" ").includes(failing.match)
    ) {
      failing.done = true;
      // As Node gives them: a command that ended badly, or one it killed for taking too long.
      const error = Object.assign(
        new Error("Command failed"),
        failing.how === "error" ? { code: 128 } : { killed: true, signal: "SIGTERM", code: null },
      );
      const said = failing.how === "error" ? "fatal: panne passagère\n" : "";
      queueMicrotask(() => done(error, "", said));
      return undefined;
    }
    return (actual.execFile as (...call: unknown[]) => unknown)(...call);
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = () => {
    const id = actual.randomUUID();
    return rigged.idStart ? `${rigged.idStart}${id.slice(8)}` : id;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  rigged.failing = undefined;
  rigged.idStart = undefined;
  rigged.gitCalls = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const failOnce = (match: string, how: "error" | "no answer" = "error") =>
  (rigged.failing = { match, how, done: false });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** A file as written, whatever line endings git gave it back with (CRLF on Windows). */
const read = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").replaceAll("\r\n", "\n") : undefined;

/** A repository with one commit, which ignores a settings file, logs and a whole folder. */
function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-kept-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\nune ligne\n");
  writeFileSync(path.join(repo, ".gitignore"), ".env.local\n*.log\nnode_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, base: git(repo, "rev-parse", "HEAD") };
}

const WORK = { readme: "# Demo\ntravail pas encore commité\n", notes: "fichier nouveau\n" };

/** What an agent leaves in its folder between two commits: a changed file and a new one. */
function leaveWork(dir: string) {
  writeFileSync(path.join(dir, "README.md"), WORK.readme);
  writeFileSync(path.join(dir, "notes.txt"), WORK.notes);
}

const workIn = (dir: string) => ({
  readme: read(path.join(dir, "README.md")),
  notes: read(path.join(dir, "notes.txt")),
});

/** A thread's worktree as git makes it, with work in it. */
async function worktreeWithWork() {
  const made = repository();
  const dir = path.join(made.root, "worktrees", "abcd1234");
  await ensureWorktree(made.repo, dir, "moon/fil-abcd12", made.base);
  leaveWork(dir);
  return { ...made, dir };
}

/** A server on the repository, restarted at will on the same data. */
function server(worktrees = "worktrees", before?: (root: string) => void) {
  const made = repository();
  before?.(made.root);
  const store = new Store(path.join(made.root, "state.sqlite"));
  const hubs: Hub[] = [];
  const open = (dir = worktrees) => {
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(made.root, dir),
    });
    hubs.push(hub);
    return hub;
  };
  cleanups.unshift(async () => {
    for (const hub of hubs) await hub.close();
    store.close();
  });
  const hub = open();
  const projectId = hub.createProject("demo", made.repo);
  const thread = async (text = "Un", on = hub) => {
    const id = on.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text,
    });
    await on.whenIdle(id);
    return { id, ...store.getThread(id)!.workspace! };
  };
  return { ...made, store, hub, open, thread };
}

const refs = (repo: string, under: string) =>
  git(repo, "for-each-ref", "--format=%(refname)", under).split("\n").filter(Boolean);

describe("a thread's folder when git fails", () => {
  it("keeps the folder and goes on when git fails once on it", async () => {
    const { repo, base, dir } = await worktreeWithWork();
    const failed = failOnce("rev-parse --show-toplevel");
    await ensureWorktree(repo, dir, "moon/fil-abcd12", base);
    expect(failed.done).toBe(true);
    expect(workIn(dir)).toEqual(WORK);
  });

  it("fails and leaves the folder as it is when git gives no answer in time", async () => {
    const { repo, base, dir } = await worktreeWithWork();
    failOnce("rev-parse --show-toplevel", "no answer");
    await expect(ensureWorktree(repo, dir, "moon/fil-abcd12", base)).rejects.toThrow(
      /n'a pas répondu à temps\. Rien n'a été effacé/,
    );
    expect(workIn(dir)).toEqual(WORK);
    // Asked again, git answers: the thread goes on in the same folder.
    await ensureWorktree(repo, dir, "moon/fil-abcd12", base);
    expect(workIn(dir)).toEqual(WORK);
  });

  it("writes again a `.git` file a power cut emptied, without touching the work", async () => {
    const { repo, base, dir } = await worktreeWithWork();
    // Emptied in place: git hides this file on Windows, where a hidden file cannot be
    // written over as a new one.
    truncateSync(path.join(dir, ".git"));
    await ensureWorktree(repo, dir, "moon/fil-abcd12", base);
    expect(workIn(dir)).toEqual(WORK);
    expect(git(dir, "status", "--porcelain")).toContain("notes.txt");
  });

  it("refuses a folder its repository forgot, until it is moved out of the way", async () => {
    const { root, repo, base, dir } = await worktreeWithWork();
    // The repository was cloned again, or put back from a copy: it knows no such worktree.
    rmSync(path.join(repo, ".git", "worktrees", "abcd1234"), { recursive: true, force: true });
    const refused = ensureWorktree(repo, dir, "moon/fil-abcd12", base);
    await expect(refused).rejects.toThrow("Rien n'a été effacé");
    await expect(refused).rejects.toThrow(dir);
    expect(workIn(dir)).toEqual(WORK);

    // What the message says to do: the work is kept where it was put, the thread starts
    // again from its branch.
    const aside = path.join(root, "mis-de-côté");
    renameSync(dir, aside);
    await ensureWorktree(repo, dir, "moon/fil-abcd12", base);
    expect(workIn(dir)).toEqual({ readme: "# Demo\nune ligne\n", notes: undefined });
    expect(workIn(aside)).toEqual(WORK);
  });

  it("removes an empty folder in its way, and no other", async () => {
    const { root, repo, base } = repository();
    const empty = path.join(root, "worktrees", "vide0000");
    mkdirSync(empty, { recursive: true });
    await ensureWorktree(repo, empty, "moon/vide", base);
    expect(read(path.join(empty, "README.md"))).toBe("# Demo\nune ligne\n");

    // Files that are not a worktree at all: a folder cut short while it was removed.
    const plain = path.join(root, "worktrees", "reste000");
    mkdirSync(plain);
    writeFileSync(path.join(plain, "seul.txt"), "ce qui reste\n");
    await expect(ensureWorktree(repo, plain, "moon/reste", base)).rejects.toThrow(
      "Rien n'a été effacé",
    );
    expect(read(path.join(plain, "seul.txt"))).toBe("ce qui reste\n");
  });

  it("says in the thread why its agent cannot start, with its files as they were", async () => {
    const { repo, store, hub, thread } = server();
    const { id, path: dir } = await thread();
    leaveWork(dir);
    // The next message starts a new agent, which asks for the folder again.
    await hub.switchAgent(id, "demo-2");
    rmSync(path.join(repo, ".git", "worktrees", path.basename(dir)), {
      recursive: true,
      force: true,
    });
    hub.send(id, "Deux");
    await hub.whenIdle(id);
    expect(store.getThread(id)).toMatchObject({ status: "error" });
    expect(store.getThread(id)?.error).toContain("Rien n'a été effacé");
    expect(workIn(dir)).toEqual(WORK);
  });

  it("goes on with the thread's work when git fails once as its agent starts", async () => {
    const { store, hub, thread } = server();
    const { id, path: dir } = await thread();
    leaveWork(dir);
    await hub.switchAgent(id, "demo-2");
    const failed = failOnce("rev-parse --show-toplevel");
    hub.send(id, "Deux");
    await hub.whenIdle(id);
    expect(failed.done).toBe(true);
    expect(store.getThread(id)).toMatchObject({ status: "idle" });
    expect(workIn(dir)).toEqual(WORK);
  });

  it("puts a file of the review back, not away, when git fails on what the branch had", async () => {
    const { dir, base } = await worktreeWithWork();
    const failed = failOnce("cat-file -e");
    expect(await rejectFile(dir, base, "README.md")).toBeUndefined();
    expect(failed.done).toBe(true);
    expect(read(path.join(dir, "README.md"))).toBe("# Demo\nune ligne\n");
    // A file the branch never had still goes.
    await rejectFile(dir, base, "notes.txt");
    expect(existsSync(path.join(dir, "notes.txt"))).toBe(false);
  });

  it("rejects no file when git cannot say what the branch had", async () => {
    const { dir } = await worktreeWithWork();
    await expect(
      rejectFile(dir, "0000000000000000000000000000000000000000", "README.md"),
    ).rejects.toThrow();
    expect(workIn(dir)).toEqual(WORK);
  });
});

describe("a folder for each thread", () => {
  it("gives two threads whose ids start alike a folder and a branch each", async () => {
    const { store, hub, thread } = server();
    rigged.idStart = "deadbeef";
    const a = await thread("Même tâche");
    leaveWork(a.path);
    const b = await thread("Même tâche");
    rigged.idStart = undefined;
    expect([a.id.slice(0, 8), b.id.slice(0, 8)]).toEqual(["deadbeef", "deadbeef"]);

    expect(b.path).not.toBe(a.path);
    expect(b.branch).not.toBe(a.branch);
    expect(git(b.path, "branch", "--show-current")).toBe(b.branch);
    expect((await hub.review(b.id)).files).toEqual([]);

    await hub.deleteThread(b.id);
    expect(existsSync(b.path)).toBe(false);
    expect(workIn(a.path)).toEqual(WORK);
    expect(store.getThread(a.id)?.workspace?.path).toBe(a.path);
  });

  it("leaves to the first thread a folder two were given, whatever is done with the second", async () => {
    const { store, hub, thread } = server();
    const a = await thread("Premier");
    leaveWork(a.path);
    const b = await thread("Second");
    // As two ids that started alike left them, before each thread had a folder of its own.
    const { path: _own, ...rest } = store.getThread(b.id)!.workspace!;
    store.updateThread(b.id, { workspace: { ...rest, path: a.path } });
    await hub.switchAgent(b.id, "demo-2");

    hub.send(b.id, "Deux");
    await hub.whenIdle(b.id);
    expect(store.getThread(b.id)).toMatchObject({ status: "error" });
    expect(store.getThread(b.id)?.error).toContain("« Premier »");

    await hub.setArchived(b.id, true);
    expect(workIn(a.path)).toEqual(WORK);
    await hub.deleteThread(b.id);
    expect(workIn(a.path)).toEqual(WORK);

    // The first one works in it as before.
    hub.send(a.id, "Deux");
    await hub.whenIdle(a.id);
    expect(store.getThread(a.id)).toMatchObject({ status: "idle" });
  });

  it("holds the threads' folders when the data folder is reached by another path", async () => {
    // Started through a link one day (a junction, a folder moved then linked), by the
    // folder's own path the next: the same place on disk.
    const { root, store, hub, open, thread } = server(path.join("lien", "worktrees"), (root) => {
      mkdirSync(path.join(root, "réel"));
      symlinkSync(path.join(root, "réel"), path.join(root, "lien"), "junction");
    });
    const { id, path: dir } = await thread();
    leaveWork(dir);
    await hub.close();

    const real = path.join(root, "réel", "worktrees");
    const again = open(path.join("réel", "worktrees"));
    const held = () => (again as unknown as { heldWorktrees(): string[] }).heldWorktrees();
    expect(held()).toEqual([path.basename(dir)]);
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(dir, longAgo, longAgo);
    expect(await sweepWorktrees(real, held)).toEqual([]);
    expect(workIn(dir)).toEqual(WORK);

    // Still the thread's own to put away: resolved, its folder goes and comes back.
    await again.setArchived(id, true);
    expect(existsSync(dir)).toBe(false);
    await again.setArchived(id, false);
    expect(workIn(dir)).toEqual(WORK);
    expect(store.getThread(id)?.workspace?.path).toBe(dir);
  });
});

describe("resolving a thread and stepping back", () => {
  it("brings back with a resolved thread the files git ignores one by one", async () => {
    const { hub, thread } = server();
    const { id, path: dir } = await thread();
    leaveWork(dir);
    writeFileSync(path.join(dir, ".env.local"), "API_KEY=clé-du-propriétaire\n");
    writeFileSync(path.join(dir, "essai.log"), "journal\n");
    mkdirSync(path.join(dir, "node_modules", "paquet"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "paquet", "index.js"), "module.exports = 1;\n");

    await hub.setArchived(id, true);
    expect(existsSync(dir)).toBe(false);
    await hub.setArchived(id, false);

    expect(workIn(dir)).toEqual(WORK);
    expect(read(path.join(dir, ".env.local"))).toBe("API_KEY=clé-du-propriétaire\n");
    expect(read(path.join(dir, "essai.log"))).toBe("journal\n");
    // A folder ignored whole is what an install makes again: it is not kept in git.
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
    // Back as they were: ignored, and in no commit to come.
    const status = git(dir, "status", "--porcelain").split("\n");
    expect(status.map((line) => line.trim()).sort()).toEqual(["?? notes.txt", "M README.md"]);
  });

  it("keeps an orphan folder's ignored files with the rest before it goes", async () => {
    const { root, repo, base } = repository();
    const worktrees = path.join(root, "worktrees");
    const orphan = path.join(worktrees, "0rphan00");
    await ensureWorktree(repo, orphan, "moon/coupé", base);
    writeFileSync(path.join(orphan, ".env.local"), "API_KEY=1\n");
    const now = Date.now() + 2 * 60 * 60_000;
    expect(await sweepWorktrees(worktrees, () => [], now)).toEqual(["0rphan00"]);
    const [kept] = refs(repo, "refs/moonagentic/orphans/");
    expect(git(repo, "show", `${kept}:.env.local`)).toBe("API_KEY=1");
  });

  it("keeps what a step back takes away under a ref that goes with the thread", async () => {
    const { repo, store, hub, thread } = server();
    const { id, path: dir } = await thread();
    hub.send(id, "Deux");
    await hub.whenIdle(id);
    const second = store.listItems(id).filter((i) => i.kind === "user")[1]!;
    // Since that message: a file put there by hand, and one git ignores.
    writeFileSync(path.join(dir, "notes-perso.md"), "mes notes\n");
    writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n");

    await hub.restore(id, second.id);
    expect(existsSync(path.join(dir, "notes-perso.md"))).toBe(false);
    expect(read(path.join(dir, ".env.local"))).toBe("SECRET=1\n");
    const undone = refs(repo, `refs/moonagentic/${id}/`).filter((ref) => ref.includes("/undone-"));
    expect(undone).toHaveLength(1);
    expect(git(repo, "show", `${undone[0]}:notes-perso.md`)).toBe("mes notes");

    await hub.deleteThread(id);
    expect(refs(repo, "refs/moonagentic/")).toEqual([]);
  });

  it("steps back to the files of the move from a message sent before it", async () => {
    const { root, repo, store, hub } = server();
    const projectId = store.listProjects().find((p) => p.name === "demo")!.id;
    mkdirSync(path.join(root, "Discussions"));
    const discussions = hub.createProject("Discussions", path.join(root, "Discussions"));
    const id = hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "Avant",
    });
    await hub.whenIdle(id);
    await hub.moveThread(id, projectId);
    // A branch of its own in the project, made from where the project was.
    const { path: dir, base } = store.getThread(id)!.workspace!;
    expect(base).toBe(git(repo, "rev-parse", "HEAD"));
    expect(workIn(dir)).toEqual({ readme: "# Demo\nune ligne\n", notes: undefined });
    const before = store.listItems(id).find((i) => i.kind === "user")!;
    expect(before).toMatchObject({ beforeMove: true, checkpoint: expect.any(String) });
    expect(store.listItems(id).at(-1)).toMatchObject({ kind: "moved", projectId, name: "demo" });

    hub.send(id, "Après");
    await hub.whenIdle(id);
    leaveWork(dir);
    rigged.gitCalls = [];
    await hub.restore(id, before.id);
    // Neon's review of PR #176: a message from before the move has no ref of its own to drop.
    expect(
      rigged.gitCalls.filter((a) => a.join(" ").includes(`/${before.id.replace(/^user:/, "")}`)),
    ).toEqual([]);
    // The project's files as at the move, the thread still in the project, the move told.
    expect(workIn(dir)).toEqual({ readme: "# Demo\nune ligne\n", notes: undefined });
    expect(store.listItems(id).map((i) => i.kind)).toEqual(["moved"]);
    expect(store.getThread(id)).toMatchObject({ projectId, workspace: { path: dir } });
    // It goes on from there, and its ref goes with it.
    hub.send(id, "Encore");
    await hub.whenIdle(id);
    expect(
      store
        .listItems(id)
        .map((i) => i.kind)
        .slice(0, 2),
    ).toEqual(["moved", "user"]);
    await hub.deleteThread(id);
    expect(refs(repo, "refs/moonagentic/")).toEqual([]);
  });

  it("does not step back when the files there now cannot be kept first", async () => {
    const { store, hub, thread } = server();
    const { id, path: dir } = await thread();
    hub.send(id, "Deux");
    await hub.whenIdle(id);
    const second = store.listItems(id).filter((i) => i.kind === "user")[1]!;
    writeFileSync(path.join(dir, "notes-perso.md"), "mes notes\n");

    failOnce("/undone-");
    await expect(hub.restore(id, second.id)).rejects.toThrow("Retour en arrière annulé");
    expect(read(path.join(dir, "notes-perso.md"))).toBe("mes notes\n");
    expect(store.listItems(id).filter((i) => i.kind === "user")).toHaveLength(2);
    expect(store.getSetting("pendingRestores", {})).toEqual({});
  });

  it("finishes a removal cut short, then gives the thread its files back", async () => {
    const { repo, store, hub, thread } = server();
    const { id, path: dir } = await thread();
    leaveWork(dir);
    writeFileSync(path.join(dir, ".env.local"), "API_KEY=1\n");
    // Resolving the thread saved its files, then could remove only part of its folder (a
    // file held open on Windows): git forgot the folder, some files went, others stayed.
    const archivedTree = await saveCheckpoint(dir, `refs/moonagentic/${id}/archive`, true);
    store.updateThread(id, { workspace: { ...store.getThread(id)!.workspace!, archivedTree } });
    await hub.switchAgent(id, "demo-2");
    rmSync(path.join(repo, ".git", "worktrees", path.basename(dir)), {
      recursive: true,
      force: true,
    });
    unlinkSync(path.join(dir, ".git"));
    unlinkSync(path.join(dir, "notes.txt"));

    hub.send(id, "Deux");
    await hub.whenIdle(id);
    expect(store.getThread(id)).toMatchObject({ status: "idle" });
    expect(workIn(dir)).toEqual(WORK);
    expect(read(path.join(dir, ".env.local"))).toBe("API_KEY=1\n");
    expect(store.getThread(id)?.workspace?.archivedTree).toBeUndefined();
  });

  // Only a user who is not root is refused the removal of a file by its folder's rights.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the checkpoint written down when a folder could only be removed in part",
    async () => {
      const { store, hub, thread } = server();
      const { id, path: dir } = await thread();
      leaveWork(dir);
      const held = path.join(dir, "tenu");
      mkdirSync(held);
      writeFileSync(path.join(held, "ouvert.txt"), "tenu ouvert\n");
      chmodSync(held, 0o555);
      cleanups.unshift(() => {
        if (existsSync(held)) chmodSync(held, 0o755);
      });

      await expect(hub.setArchived(id, true)).rejects.toThrow("Impossible de supprimer");
      expect(store.getThread(id)?.archived).toBeUndefined();
      expect(store.getThread(id)?.workspace?.archivedTree).toBeDefined();

      // What held the file lets go: the thread goes on with everything it had.
      chmodSync(held, 0o755);
      hub.send(id, "Deux");
      await hub.whenIdle(id);
      expect(store.getThread(id)).toMatchObject({ status: "idle" });
      expect(workIn(dir)).toEqual(WORK);
      expect(read(path.join(held, "ouvert.txt"))).toBe("tenu ouvert\n");
      expect(store.getThread(id)?.workspace?.archivedTree).toBeUndefined();
    },
  );
});
