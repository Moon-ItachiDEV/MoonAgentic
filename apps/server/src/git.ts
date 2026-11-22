import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewFile } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";

const MAX_PATCH_LINES = 2000;

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

/** Creates a worktree on a new branch from the repository's current commit. */
export async function addWorktree(
  repoDir: string,
  worktree: string,
  branch: string,
): Promise<{ base: string; baseBranch?: string }> {
  const base = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
  const head = (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  await git(repoDir, ["worktree", "add", "-b", branch, worktree, base]);
  return { base, ...(head && head !== "HEAD" ? { baseBranch: head } : {}) };
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

/** Everything that changed since `base`, committed or not, new files included. */
export function reviewChanges(dir: string, base: string): Promise<ReviewFile[]> {
  return withScratchIndex(dir, async (env) => {
    await git(dir, ["add", "-A"], env);
    const numstat = await git(dir, ["diff", "--cached", "--numstat", "-z", "-M", base], env);
    // An external diff tool from the user's config would replace the unified diff.
    const patch = await git(
      dir,
      ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", base],
      env,
    );
    return parseDiff(numstat, patch);
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
  const counts: { path: string; added: number | null; removed: number | null }[] = [];
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length - 1;) {
    const [added = "-", removed = "-", file = ""] = (fields[i] ?? "").split("\t");
    i += 1;
    // A rename lists an empty path followed by the old and the new path.
    const name = file || (fields[(i += 2) - 1] ?? "");
    counts.push({
      path: name,
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  return counts.map((count, i) => {
    const section = sections[i] ?? "";
    const status: ReviewFile["status"] = /^new file mode/m.test(section)
      ? "added"
      : /^deleted file mode/m.test(section)
        ? "deleted"
        : /^rename from /m.test(section)
          ? "renamed"
          : "modified";
    const lines = section.split("\n");
    const start = lines.findIndex((l) => l.startsWith("@@"));
    const body = start === -1 ? [] : lines.slice(start);
    if (body.at(-1) === "") body.pop();
    return {
      path: count.path,
      status,
      added: count.added,
      removed: count.removed,
      patch: body.slice(0, MAX_PATCH_LINES).join("\n"),
      ...(body.length > MAX_PATCH_LINES ? { truncated: true } : {}),
    };
  });
}

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

/** Commits what changed, pushes the branch, and opens a pull request when asked. */
export async function ship(
  dir: string,
  options: { branch: string; baseBranch?: string; message: string; pr: boolean; title: string },
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
  if ((await git(dir, ["status", "--porcelain"])).trim()) {
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
