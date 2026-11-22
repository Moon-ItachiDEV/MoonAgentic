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

const MAX_PATCH_LINES = 2000;
/** The review lists at most this many files; the rest are only counted. */
export const MAX_REVIEW_FILES = 1000;
/** Past this many diff lines in all, the next files are listed without their diff. */
const MAX_REVIEW_LINES = 20_000;

/** No one can answer a password prompt from here, so git and gh fail instead of waiting. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };

/** A push or a call to GitHub that hangs on the network gives up, so its thread is freed. */
const NETWORK_TIMEOUT_MS = 5 * 60_000;

function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, ...NO_PROMPT, ...env },
        maxBuffer: 256 * 1024 * 1024,
        ...(timeout ? { timeout } : {}),
      },
      (error, stdout, stderr) => {
        if (error?.killed) reject(new Error("git n'a pas répondu à temps.", { cause: error }));
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
      ["rev-parse", "--is-inside-work-tree", "--verify", "--quiet", "HEAD"],
      { cwd: dir, stdio: ["ignore", "pipe", "ignore"] },
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
    return path.relative(realpathSync(top), realpathSync(dir)) === "";
  } catch {
    return false;
  }
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
    // An external diff tool from the user's config would replace the unified diff.
    const patch = await git(dir, ["diff", "--no-color", "--no-ext-diff", "-M", base], env);
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
      /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    );
  return match?.[1];
}

export interface ShipResult {
  commit?: string;
  /** The pull request, or the page to open one when it could not be created here. */
  url?: string;
  /** True when `url` is an open pull request rather than the page to open one. */
  prOpened: boolean;
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
  await git(dir, ["push", "-u", remote, options.branch], undefined, NETWORK_TIMEOUT_MS);
  const repo = githubRepo(await git(dir, ["remote", "get-url", remote]));
  const result: ShipResult = { ...(commit ? { commit } : {}), prOpened: false };
  if (!options.pr || !repo) return result;

  const base = options.baseBranch ?? "main";
  const gh = findOnPath("gh");
  // A `.cmd` could only run through cmd.exe, which would read the thread's title as a script.
  if (gh && !/\.(cmd|bat)$/i.test(gh)) {
    const url = await openPullRequest(gh, dir, repo, options.branch, base, options.title);
    if (url) return { ...result, url, prOpened: true };
  }
  const compare = `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(options.branch)}?expand=1`;
  return { ...result, url: compare };
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
): Promise<string | undefined> {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        gh,
        args,
        { cwd: dir, env: { ...process.env, ...NO_PROMPT }, timeout: NETWORK_TIMEOUT_MS },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
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
    if (lastUrl(existing)) return lastUrl(existing);
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
      "Ouverte depuis MoonAgentic.",
    ]);
    return lastUrl(out);
  } catch {
    // gh missing a sign-in or access: fall back to the page that opens one
    return undefined;
  }
}
