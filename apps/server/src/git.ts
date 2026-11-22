import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewFile } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";

const MAX_PATCH_LINES = 2000;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

/** True when the folder sits inside a git work tree (and git is installed). */
export function isGitRepo(dir: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim() === "true";
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

/**
 * Everything that changed since `base`, committed or not, new files included. Runs on a
 * throwaway copy of the index so the folder's own staging area is left alone.
 */
export async function reviewChanges(dir: string, base: string): Promise<ReviewFile[]> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "moonagentic-index-"));
  try {
    const index = path.join(scratch, "index");
    const real = path.resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).trim());
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["add", "-A"], env);
    const numstat = await git(dir, ["diff", "--cached", "--numstat", "-z", "-M", base], env);
    const patch = await git(dir, ["diff", "--cached", "--no-color", "-M", base], env);
    return parseDiff(numstat, patch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  let commit: string | undefined;
  if ((await git(dir, ["status", "--porcelain"])).trim()) {
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", options.message]);
    commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
  }
  const remotes = (await git(dir, ["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("Ce dépôt n'a pas de remote où pousser la branche.");
  await git(dir, ["push", "-u", remote, options.branch]);
  const repo = githubRepo(await git(dir, ["remote", "get-url", remote]));
  const result: ShipResult = { ...(commit ? { commit } : {}), prOpened: false };
  if (!options.pr || !repo) return result;

  const base = options.baseBranch ?? "main";
  const gh = findOnPath("gh");
  if (gh) {
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
      execFile(gh, args, { cwd: dir }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
  const lastUrl = (out: string) => out.match(/https:\/\/\S+/g)?.at(-1);
  try {
    const existing = await run([
      "pr",
      "view",
      branch,
      "--repo",
      repo,
      "--json",
      "url",
      "-q",
      ".url",
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
