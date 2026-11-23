import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewFile } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";
import { GIT_QUIET, gitQuietEnv } from "./git-own.ts";
import { githubAccount } from "./github-account.ts";
import { githubGitAuth } from "./github.ts";

const MAX_PATCH_LINES = 2000;
/** The review lists at most this many files; the rest are only counted. */
export const MAX_REVIEW_FILES = 1000;
/** Past this many diff lines in all, the next files are listed without their diff. */
const MAX_REVIEW_LINES = 20_000;

/** No one can answer a password prompt from here, so git and gh fail instead of waiting. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };

/** A push or a call to GitHub that hangs on the network gives up, so its thread is freed. */
const NETWORK_TIMEOUT_MS = 5 * 60_000;
/**
 * A local git command waiting on a lock, a full disk or a stuck file system gives up too:
 * a thread or a team step waiting on it would otherwise wait for good. Generous, as a first
 * `git add -A` in a big repository can take a while.
 */
export const LOCAL_TIMEOUT_MS = 2 * 60_000;

function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout = LOCAL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...GIT_QUIET, ...args],
      {
        cwd,
        env: { ...process.env, ...NO_PROMPT, ...env },
        maxBuffer: 256 * 1024 * 1024,
        timeout,
        // No console window flashes up on Windows at each git command.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error?.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          reject(new Error("git n'a pas répondu à temps.", { cause: error }));
        else if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

/**
 * True when the folder sits inside a git work tree with at least one commit, which a
 * thread's branch starts from (and git is installed).
 */
export function isGitRepo(dir: string): boolean {
  try {
    const out = execFileSync(
      "git",
      [...GIT_QUIET, "rev-parse", "--is-inside-work-tree", "--verify", "--quiet", "HEAD"],
      { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, windowsHide: true },
    );
    return out.toString().startsWith("true");
  } catch {
    return false;
  }
}

/** A branch name a person can read: `moon/<title words>-<short id>`. */
export function branchName(title: string, id: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `moon/${slug ? `${slug}-` : ""}${id.slice(0, 6)}`;
}

/**
 * Where a thread's branch starts: the repository's current commit and branch, and where the
 * project folder sits in the repository when it is not its root.
 */
export async function worktreeStart(
  projectDir: string,
): Promise<{ base: string; baseBranch?: string; subdir?: string }> {
  const base = (await git(projectDir, ["rev-parse", "HEAD"])).trim();
  const head = (await git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const subdir = (await git(projectDir, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "");
  return {
    base,
    ...(head && head !== "HEAD" ? { baseBranch: head } : {}),
    ...(subdir ? { subdir } : {}),
  };
}

export const branchExists = (dir: string, branch: string): Promise<boolean> =>
  git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );

/** True when `dir` is the top of a git work tree, rather than a folder inside another one. */
async function isWorktreeRoot(dir: string): Promise<boolean> {
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return samePath(top, dir);
  } catch {
    return false;
  }
}

/**
 * Whether two paths name the same folder. Windows may give a folder by its short 8.3 name
 * (`C:\Users\RUNNER~1\…`, as the temp folder often is) where git gives the long one: only
 * the system's own `realpath` turns one into the other, and Windows paths ignore case.
 */
export function samePath(a: string, b: string): boolean {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The worktree change running on each repository, so the next one waits for it. */
const worktreeQueues = new Map<string, Promise<unknown>>();

/**
 * Runs worktree changes on one repository one at a time: coders starting together would
 * otherwise have git prune and add worktrees at once, under the same `.git/worktrees`.
 */
function oneAtATime<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoDir);
  const run = (worktreeQueues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  worktreeQueues.set(key, tail);
  void tail.then(() => {
    if (worktreeQueues.get(key) === tail) worktreeQueues.delete(key);
  });
  return run;
}

/**
 * Makes sure the thread's worktree is there, on its branch. Safe to run again after a stop
 * at any point: a half-made folder is made again, and a branch that exists is reused with
 * its commits rather than started over from `base`.
 */
export async function ensureWorktree(
  repoDir: string,
  worktree: string,
  branch: string,
  base: string,
): Promise<void> {
  return oneAtATime(repoDir, () => makeWorktree(repoDir, worktree, branch, base));
}

async function makeWorktree(
  repoDir: string,
  worktree: string,
  branch: string,
  base: string,
): Promise<void> {
  if (existsSync(worktree) && (await isWorktreeRoot(worktree))) return;
  // What git remembers of a folder that is gone, or was never finished, is dropped first.
  await git(repoDir, ["worktree", "prune"]);
  if (existsSync(worktree)) {
    await git(repoDir, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    rmSync(worktree, { recursive: true, force: true });
  }
  if (await branchExists(repoDir, branch)) {
    await git(repoDir, ["worktree", "add", worktree, branch]);
  } else {
    await git(repoDir, ["worktree", "add", "-b", branch, worktree, base]);
  }
}

/**
 * The commit a branch made before MoonAgentic remembered it started from, for a thread whose
 * worktree was made but not recorded: where it leaves the repository's current branch.
 */
export async function forkPoint(repoDir: string, branch: string): Promise<string> {
  return (await git(repoDir, ["merge-base", branch, "HEAD"])).trim();
}

/** Removes the worktree's folder; its branch and commits stay in the repository. */
export function removeWorktree(repoDir: string, worktree: string): Promise<void> {
  return oneAtATime(repoDir, () => dropWorktree(repoDir, worktree));
}

async function dropWorktree(repoDir: string, worktree: string): Promise<void> {
  if (existsSync(worktree)) {
    await git(repoDir, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
  }
  // Git can fail, or the project's folder be gone: the folder goes anyway, and if even that
  // fails (a file held open on Windows), the caller hears it rather than leaving it behind.
  if (existsSync(worktree)) {
    try {
      rmSync(worktree, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      throw new Error(
        `Impossible de supprimer la copie de travail ${worktree} : ${error instanceof Error ? error.message : String(error)}. Ferme ce qui l'utilise puis réessaie.`,
      );
    }
  }
  await git(repoDir, ["worktree", "prune"]).catch(() => undefined);
}

/** Deletes every ref under `prefix`, such as a thread's checkpoints. */
export async function dropRefs(dir: string, prefix: string): Promise<void> {
  const refs = (await git(dir, ["for-each-ref", "--format=%(refname)", prefix]))
    .split("\n")
    .filter(Boolean);
  for (const ref of refs) await git(dir, ["update-ref", "-d", ref]);
}

/** Runs `work` with a throwaway copy of the folder's index, so its staging area is left alone. */
async function withScratchIndex<T>(
  dir: string,
  work: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "moonagentic-index-"));
  try {
    const index = path.join(scratch, "index");
    const real = path.resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).trim());
    if (existsSync(real)) copyFileSync(real, index);
    return await work({ GIT_INDEX_FILE: index });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs `work` with a file listing `paths`, which git reads with `--pathspec-from-file`. */
async function withPathspecFile<T>(paths: string[], work: (file: string) => Promise<T>) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "moonagentic-paths-"));
  try {
    const file = path.join(scratch, "paths");
    writeFileSync(file, paths.join("\0"));
    return await work(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const pathspecArgs = (file: string) => [`--pathspec-from-file=${file}`, "--pathspec-file-nul"];

/**
 * Everything that changed since `base`, committed or not, new files included. New files
 * are only announced to a scratch index, so opening the review stores nothing in git.
 */
export function reviewChanges(
  dir: string,
  base: string,
): Promise<{ files: ReviewFile[]; omitted?: number }> {
  return withScratchIndex(dir, async (env) => {
    const untracked = (await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"], env))
      .split("\0")
      .filter(Boolean);
    if (untracked.length) {
      await withPathspecFile(untracked, (file) =>
        git(dir, ["--literal-pathspecs", "add", "--intent-to-add", ...pathspecArgs(file)], env),
      );
    }
    const numstat = await git(dir, ["diff", "--numstat", "-z", "-M", base], env);
    // An external diff tool from the user's config would replace the unified diff, and a
    // text converter named by the repository would be run on each file shown.
    const patch = await git(
      dir,
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", base],
      env,
    );
    const files = parseDiff(numstat, patch);
    let lines = 0;
    const shown = files.slice(0, MAX_REVIEW_FILES).map((file) => {
      if (lines >= MAX_REVIEW_LINES && file.patch) {
        return { ...file, patch: "", truncated: true };
      }
      lines += file.patch ? file.patch.split("\n").length : 0;
      return file;
    });
    const omitted = files.length - shown.length;
    return omitted > 0 ? { files: shown, omitted } : { files: shown };
  });
}

/**
 * Saves the folder's files, ignored ones aside, as a git tree kept alive by `ref`, which
 * no branch or commit shows. Returns the tree's hash.
 */
export function saveCheckpoint(dir: string, ref: string): Promise<string> {
  return withScratchIndex(dir, async (env) => {
    await git(dir, ["add", "-A"], env);
    const tree = (await git(dir, ["write-tree"], env)).trim();
    await git(dir, ["update-ref", ref, tree]);
    return tree;
  });
}

/**
 * Puts the folder's files back as a checkpoint saved them: changed files are rewritten and
 * files made since are removed. Ignored files, the branch and its commits stay as they are.
 */
export async function restoreCheckpoint(dir: string, tree: string): Promise<void> {
  // The ignore rules go back first, so a file they ignored then is not taken for a new one.
  const rules = (await git(dir, ["ls-tree", "-r", "-z", "--name-only", tree]))
    .split("\0")
    .filter((f) => f === ".gitignore" || f.endsWith("/.gitignore"));
  await withScratchIndex(dir, async (env) => {
    if (rules.length) {
      await git(dir, ["read-tree", tree], env);
      await git(dir, ["checkout-index", "-f", "--", ...rules], env);
    }
    // Rules written since go away too, or the files they hide would be left behind.
    const current = await git(
      dir,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ALL_GITIGNORES],
      env,
    );
    for (const file of current.split("\0")) {
      if (file && !rules.includes(file)) rmSync(path.join(dir, file), { force: true });
    }
  });
  await withScratchIndex(dir, async (env) => {
    await git(dir, ["add", "-A"], env);
    await git(dir, ["read-tree", "--reset", "-u", tree], env);
  });
  // The folder's own staging area goes back to the last commit: what the undone turns had
  // staged would otherwise be in the agent's next commit. No file is touched by this.
  await git(dir, ["reset", "--quiet", "--mixed"]);
}

const ALL_GITIGNORES = ":(glob)**/.gitignore";

export async function dropCheckpoints(dir: string, refs: string[]): Promise<void> {
  for (const ref of refs) await git(dir, ["update-ref", "-d", ref]);
}

/** Pairs `git diff --numstat -z` counts with each file's section of the patch. */
export function parseDiff(numstat: string, patch: string): ReviewFile[] {
  const counts: {
    path: string;
    from?: string;
    added: number | null;
    removed: number | null;
  }[] = [];
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length - 1;) {
    const [added = "-", removed = "-", file = ""] = (fields[i] ?? "").split("\t");
    i += 1;
    // A rename lists an empty path followed by the old and the new path.
    const from = file ? undefined : (fields[i] ?? "");
    const name = file || (fields[(i += 2) - 1] ?? "");
    counts.push({
      path: name,
      ...(from ? { from } : {}),
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  // A file whose type changed (a file replaced by a symbolic link, say) comes as two
  // sections under the same header, a deletion then a creation, but one count.
  const sections: string[][] = [];
  for (const section of patch.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    const header = section.slice(0, section.indexOf("\n"));
    const last = sections.at(-1);
    const first = last?.[0];
    if (last?.length === 1 && first?.startsWith(`${header}\n`) && isDeletion(first)) {
      last.push(section);
    } else {
      sections.push([section]);
    }
  }
  return counts.map((count, i) => {
    const parts = sections[i] ?? [];
    const section = parts[0] ?? "";
    const status: ReviewFile["status"] =
      parts.length > 1
        ? "modified"
        : /^new file mode/m.test(section)
          ? "added"
          : /^deleted file mode/m.test(section)
            ? "deleted"
            : /^rename from /m.test(section)
              ? "renamed"
              : "modified";
    // Each part's hunks, without the header lines before them.
    const body = parts.flatMap((part) => {
      const lines = part.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = lines.findIndex((l) => l.startsWith("@@"));
      return start === -1 ? [] : lines.slice(start);
    });
    return {
      path: count.path,
      ...(count.from ? { from: count.from } : {}),
      status,
      added: count.added,
      removed: count.removed,
      patch: body.slice(0, MAX_PATCH_LINES).join("\n"),
      ...(body.length > MAX_PATCH_LINES ? { truncated: true } : {}),
    };
  });
}

/** True for a diff section whose header block says the file was deleted. */
const isDeletion = (section: string) => {
  const hunk = section.indexOf("\n@@");
  return /^deleted file mode/m.test(hunk === -1 ? section : section.slice(0, hunk));
};

/** owner/name of a GitHub remote, from its https or ssh URL. */
export function githubRepo(remoteUrl: string): string | undefined {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i,
    );
  if (!match) return undefined;
  const [, owner, name] = match as unknown as [string, string, string];
  if (name === "." || name === "..") return undefined;
  return `${owner}/${name}`;
}

/** Commits everything that changed in the folder; false when nothing had. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  if (!(await git(dir, ["status", "--porcelain"])).trim()) return false;
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
  return true;
}

/**
 * Whether the folder holds nothing past `commit`: no changed or new file, and its last
 * commit is that one. Then removing it loses nothing that is not on GitHub already.
 */
export async function nothingPast(dir: string, commit: string): Promise<boolean> {
  try {
    if ((await git(dir, ["status", "--porcelain"])).trim()) return false;
    return (await git(dir, ["rev-parse", "HEAD"])).trim() === commit;
  } catch {
    return false;
  }
}

/** The files a merge left in conflict, while one is under way; undefined when none is. */
export async function unfinishedMerge(dir: string): Promise<string[] | undefined> {
  const merging = await git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
  if (!merging) return undefined;
  return (await git(dir, ["diff", "--name-only", "-z", "--diff-filter=U"]))
    .split("\0")
    .filter(Boolean);
}

/**
 * Merges `branch` into the folder's branch, always as a merge commit so each piece stays
 * visible. Returns the files left in conflict, the merge then still under way; empty when
 * it merged.
 */
export async function mergeBranch(dir: string, branch: string, message: string): Promise<string[]> {
  try {
    await git(dir, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
    return [];
  } catch (error) {
    const conflicts = await unfinishedMerge(dir);
    if (!conflicts?.length) throw error;
    return conflicts;
  }
}

/** Whether `branch` is already part of the folder's branch: merged, not just attempted. */
export function containsBranch(dir: string, branch: string): Promise<boolean> {
  return git(dir, ["merge-base", "--is-ancestor", branch, "HEAD"]).then(
    () => true,
    () => false,
  );
}

/** `owner/name` of the GitHub repository this folder pushes to, when it has one. */
export async function githubRemote(dir: string): Promise<string | undefined> {
  try {
    const remotes = (await git(dir, ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    return remote ? githubRepo(await git(dir, ["remote", "get-url", remote])) : undefined;
  } catch {
    return undefined;
  }
}

export interface ShipResult {
  commit?: string;
  /** The pull request, or the page to open one when it could not be created here. */
  url?: string;
  /** True when `url` is an open pull request rather than the page to open one. */
  prOpened: boolean;
  /** Why `gh` could not open the pull request, when it was asked to and failed. */
  prError?: string;
}

/** A pull request title GitHub takes: one line, not too long. */
export function prTitle(text: string, max = 100): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Commits what changed (only `files` when given, as the review names them), pushes the
 * branch, and opens a pull request when asked.
 */
export async function ship(
  dir: string,
  options: {
    branch: string;
    baseBranch?: string;
    message: string;
    pr: boolean;
    title: string;
    /** The pull request's description. */
    body?: string;
    files?: string[];
  },
): Promise<ShipResult> {
  const current = (await git(dir, ["branch", "--show-current"])).trim();
  if (current !== options.branch) {
    throw new Error(
      `La copie de travail n'est plus sur la branche ${options.branch}` +
        (current ? ` mais sur ${current}.` : " (HEAD détachée).") +
        " Reviens sur la branche du fil avant d'envoyer.",
    );
  }
  let commit: string | undefined;
  if (options.files) {
    commit = await commitOnly(dir, options.files, options.message);
  } else if ((await git(dir, ["status", "--porcelain"])).trim()) {
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", options.message]);
    commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
  }
  const remotes = (await git(dir, ["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("Ce dépôt n'a pas de remote où pousser la branche.");
  // With MoonAgentic's own GitHub sign-in, or else the user's `gh` after git's own helpers.
  const auth = await githubGitAuth();
  await git(
    dir,
    [...auth.args, "push", "-u", remote, options.branch],
    auth.env,
    NETWORK_TIMEOUT_MS,
  );
  const repo = githubRepo(await git(dir, ["remote", "get-url", remote]));
  const result: ShipResult = { ...(commit ? { commit } : {}), prOpened: false };
  if (!options.pr || !repo) return result;

  const base = options.baseBranch ?? "main";
  const compare = `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(options.branch)}?expand=1`;
  const gh = findOnPath("gh");
  // A `.cmd` could only run through cmd.exe, which would read the thread's title as a script.
  if (!gh || /\.(cmd|bat)$/i.test(gh)) return { ...result, url: compare };
  const opened = await openPullRequest(
    gh,
    dir,
    repo,
    options.branch,
    base,
    prTitle(options.title),
    options.body ?? "Ouverte depuis MoonAgentic.",
  );
  if (opened.url) return { ...result, url: opened.url, prOpened: true };
  return { ...result, url: compare, ...(opened.error ? { prError: opened.error } : {}) };
}

/**
 * Commits only these files, as they are in the folder, and nothing else that was staged.
 * Returns the new commit, or undefined when none of them has changes left to commit.
 */
async function commitOnly(
  dir: string,
  files: string[],
  message: string,
): Promise<string | undefined> {
  // A path the folder never had would make git fail on the whole list.
  const known = new Set(
    (await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .split("\0")
      .filter(Boolean),
  );
  const deleted = new Set(
    (await git(dir, ["ls-files", "-z", "--deleted"])).split("\0").filter(Boolean),
  );
  const head = new Set(
    (await git(dir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])).split("\0").filter(Boolean),
  );
  const paths = [...new Set(files)].filter((f) => known.has(f) || deleted.has(f) || head.has(f));
  if (!paths.length) throw new Error("Aucun des fichiers choisis n'a de modification.");
  return withPathspecFile(paths, async (list) => {
    await git(dir, ["--literal-pathspecs", "add", "-A", ...pathspecArgs(list)]);
    // Only these paths go in, whatever else the agent had staged.
    const staged = (
      await git(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"])
    )
      .split("\0")
      .filter((f) => paths.includes(f));
    if (!staged.length) return undefined;
    await git(dir, [
      "--literal-pathspecs",
      "commit",
      "-q",
      "-m",
      message,
      "--only",
      ...pathspecArgs(list),
    ]);
    return (await git(dir, ["rev-parse", "HEAD"])).trim();
  });
}

/** Opens the pull request with the user's own `gh` sign-in, or finds the one already open. */
async function openPullRequest(
  gh: string,
  dir: string,
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<{ url?: string; error?: string }> {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        gh,
        args,
        {
          cwd: dir,
          env: { ...process.env, ...NO_PROMPT, ...gitQuietEnv(), ...githubAccount()?.ghEnv() },
          timeout: NETWORK_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
      );
    });
  const lastUrl = (out: string) => out.match(/https:\/\/\S+/g)?.at(-1);
  try {
    // `gh pr view` also finds a branch's closed or merged pull requests.
    const existing = await run([
      "pr",
      "view",
      branch,
      "--repo",
      repo,
      "--json",
      "url,state",
      "-q",
      'select(.state == "OPEN") | .url',
    ]);
    const url = lastUrl(existing);
    if (url) return { url };
  } catch {
    // no pull request yet
  }
  try {
    const out = await run([
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      branch,
      "--base",
      base,
      "--title",
      title,
      "--body",
      body,
    ]);
    const url = lastUrl(out);
    return url ? { url } : { error: "gh n'a pas donné l'adresse de la pull request." };
  } catch (error) {
    // gh missing a sign-in or access: the page that opens one is given instead, with why.
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { error: why || "gh n'a pas pu ouvrir la pull request." };
  }
}

/** The branch checked out in the folder; empty on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["branch", "--show-current"])).trim();
}

/** Runs git and gives its exit code with what it wrote, for commands whose failure says something. */
function gitCode(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GIT_QUIET, ...args],
      {
        cwd,
        env: { ...process.env, ...NO_PROMPT, ...env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: LOCAL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** A path as git shows it in a review: inside the folder, with no way out of it. */
const safeRelative = (file: string): boolean =>
  !!file &&
  !file.includes("\0") &&
  !path.isAbsolute(file) &&
  !/^[a-zA-Z]:/.test(file) &&
  !file.split(/[\\/]/).some((part) => part === ".." || part === ".git");

/**
 * Puts one file of a review back as it was at `base`, the start of the branch: a changed or
 * removed file comes back, a new one goes. For a rename, `from` comes back and the new name
 * goes. Committed changes too: their undoing is committed then, on these paths alone, so the
 * branch pushed next no longer carries them. Returns that commit, if one was needed.
 */
export async function rejectFile(dir: string, base: string, file: string, from?: string) {
  const paths = from ? [file, from] : [file];
  if (!paths.every(safeRelative)) throw new Error("Ce chemin n'est pas dans la copie de travail.");
  for (const p of paths) {
    const existed = (await gitCode(dir, ["cat-file", "-e", `${base}:${p}`])).code === 0;
    if (existed) {
      await git(dir, ["--literal-pathspecs", "checkout", base, "--", p]);
    } else {
      await git(dir, [
        "--literal-pathspecs",
        "rm",
        "-q",
        "-f",
        "--cached",
        "--ignore-unmatch",
        "--",
        p,
      ]);
      rmSync(path.join(dir, p), { force: true });
    }
  }
  // What differs from the branch's last commit now was committed: it is undone in a commit.
  const committed = (
    await git(dir, [
      "--literal-pathspecs",
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "HEAD",
      "--",
      ...paths,
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (!committed.length) return undefined;
  return withPathspecFile(committed, async (list) => {
    await git(dir, [
      "--literal-pathspecs",
      "commit",
      "-q",
      "-m",
      `Annule les changements de ${file}`,
      "--only",
      ...pathspecArgs(list),
    ]);
    return (await git(dir, ["rev-parse", "HEAD"])).trim();
  });
}

/**
 * Where the branch starts now that `target` is merged in, whoever merged it (the agent, by
 * hand): the last commit both share, when it comes after `base`. Otherwise `base` stays.
 */
export async function mergedBase(dir: string, base: string, target: string): Promise<string> {
  const shared = await gitCode(dir, ["merge-base", "HEAD", target]);
  const next = shared.stdout.trim();
  if (shared.code !== 0 || !next || next === base) return base;
  const after = await gitCode(dir, ["merge-base", "--is-ancestor", base, next]);
  return after.code === 0 ? next : base;
}

/** Who a commit made only to look ahead is from: no one's name lands in the repository. */
const PREVIEW_AUTHOR = {
  GIT_AUTHOR_NAME: "MoonAgentic",
  GIT_AUTHOR_EMAIL: "moonagentic@localhost",
  GIT_COMMITTER_NAME: "MoonAgentic",
  GIT_COMMITTER_EMAIL: "moonagentic@localhost",
};

export interface MergeForecast {
  /** The branch it is compared with. */
  target: string;
  /** Commits on `target` the folder's branch does not have yet. */
  behind: number;
  /** Files that would conflict if `target` were merged in now, work not committed included. */
  conflicts: string[];
}

/**
 * What merging `target` into the folder's branch would do now, without doing it: how far
 * behind it is, and which files would conflict. The folder's uncommitted work counts, as a
 * commit no branch shows; nothing in the folder or its index changes.
 */
export async function mergeForecast(dir: string, target: string): Promise<MergeForecast> {
  const known = await gitCode(dir, ["rev-parse", "-q", "--verify", `${target}^{commit}`]);
  if (known.code !== 0) throw new Error(`La branche ${target} n'existe pas dans ce dépôt.`);
  const behind = Number((await git(dir, ["rev-list", "--count", `HEAD..${target}`])).trim()) || 0;
  if (!behind) return { target, behind: 0, conflicts: [] };
  const work = await withScratchIndex(dir, async (env) => {
    await git(dir, ["add", "-A"], env);
    const tree = (await git(dir, ["write-tree"], env)).trim();
    return (
      await git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", "Aperçu de fusion"], {
        ...env,
        ...PREVIEW_AUTHOR,
      })
    ).trim();
  });
  const merged = await gitCode(dir, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    target,
    work,
  ]);
  if (merged.code !== 0 && merged.code !== 1) {
    throw new Error(
      /unknown option|usage:/i.test(merged.stderr)
        ? "Prévoir une fusion demande git 2.38 ou plus récent."
        : merged.stderr.trim() || "git n'a pas pu prévoir la fusion.",
    );
  }
  // The merged tree first, then each file in conflict.
  const conflicts = merged.code === 1 ? merged.stdout.split("\n").slice(1).filter(Boolean) : [];
  return { target, behind, conflicts: [...new Set(conflicts)] };
}

/**
 * Merges `target` into the folder's branch, work not committed kept aside and put back
 * after. Only when the forecast says it merges cleanly; a merge that stops anyway is
 * undone, so the folder is never left half merged. Returns the new start of the branch.
 */
export async function syncWithBranch(dir: string, target: string, message: string) {
  const merged = await gitCode(dir, [
    "merge",
    "--no-ff",
    "--no-edit",
    "--autostash",
    "-m",
    message,
    target,
  ]);
  if (merged.code !== 0) {
    await gitCode(dir, ["merge", "--abort"]);
    throw new Error(merged.stderr.trim() || "La fusion n'a pas abouti : rien n'a changé.");
  }
  return (await git(dir, ["merge-base", "HEAD", target])).trim();
}

/** How long asking the remote for its branch may take, before the last known copy is used. */
const FETCH_TIMEOUT_MS = 30_000;
/** A remote asked less than this long ago is not asked again: the panel asks often. */
const FETCH_EVERY_MS = 60_000;
const fetchedAt = new Map<string, number>();

/**
 * The branch to compare a thread's branch with: `baseBranch` itself, or its copy on the
 * remote when that one is ahead (a pull request merged on GitHub), asked for again first.
 * When the remote cannot be reached, its last known copy is used.
 */
export async function syncTarget(dir: string, baseBranch: string): Promise<string> {
  const upstream = await gitCode(dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${baseBranch}@{upstream}`,
  ]);
  const remoteRef = upstream.code === 0 ? upstream.stdout.trim() : "";
  const slash = remoteRef.indexOf("/");
  if (slash <= 0) return baseBranch;
  const remote = remoteRef.slice(0, slash);
  const key = `${dir}\0${remoteRef}`;
  const last = fetchedAt.get(key) ?? 0;
  if (Date.now() - last > FETCH_EVERY_MS) {
    fetchedAt.set(key, Date.now());
    const auth = await githubGitAuth().catch(() => ({ args: [] as string[], env: {} }));
    await git(
      dir,
      [...auth.args, "fetch", "-q", "--no-tags", remote, remoteRef.slice(slash + 1)],
      auth.env,
      FETCH_TIMEOUT_MS,
    ).catch(() => undefined);
  }
  if ((await gitCode(dir, ["rev-parse", "-q", "--verify", `${remoteRef}^{commit}`])).code !== 0) {
    return baseBranch;
  }
  // The remote's copy when it is ahead, unless the local branch has commits it does not.
  const [local, remoteHead] = await Promise.all(
    [baseBranch, remoteRef].map(async (ref) =>
      (await gitCode(dir, ["rev-parse", ref])).stdout.trim(),
    ),
  );
  if (local === remoteHead) return baseBranch;
  const ahead = await gitCode(dir, ["merge-base", "--is-ancestor", baseBranch, remoteRef]);
  return ahead.code === 0 ? remoteRef : baseBranch;
}
