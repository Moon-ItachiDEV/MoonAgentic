import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubRepo, GithubStatus } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";

/** No one can answer a password prompt from here, so git and gh fail instead of waiting. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };
const ASK_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;

function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...NO_PROMPT },
        timeout: options.timeout,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error?.killed) reject(new Error(`${path.basename(command)} n'a pas répondu à temps.`));
        else if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

/**
 * The user's own `gh`, when it is installed. A `.cmd` could only run through cmd.exe, which
 * would read its arguments as a script, so it does not count.
 */
export function findGh(): string | undefined {
  const gh = findOnPath("gh");
  return gh && !/\.(cmd|bat)$/i.test(gh) ? gh : undefined;
}

/** True when git already has a credential helper for github.com, such as Git Credential Manager. */
async function gitHasHelper(): Promise<boolean> {
  try {
    const out = await run(
      "git",
      ["config", "--get-urlmatch", "credential.helper", "https://github.com"],
      { timeout: ASK_TIMEOUT_MS },
    );
    return out.trim().length > 0;
  } catch {
    // exits with 1 when none is set
    return false;
  }
}

async function ghLogin(gh: string): Promise<{ login?: string; error?: string }> {
  try {
    const login = (await run(gh, ["api", "user", "--jq", ".login"], { timeout: ASK_TIMEOUT_MS }))
      .trim()
      .split("\n")[0];
    return login ? { login } : { error: "gh ne connaît pas de compte connecté." };
  } catch (error) {
    return { error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

export async function githubStatus(): Promise<GithubStatus> {
  const git = !!findOnPath("git");
  const gh = findGh();
  const [account, helper] = await Promise.all([
    gh ? ghLogin(gh) : Promise.resolve({} as { login?: string; error?: string }),
    git ? gitHasHelper() : Promise.resolve(false),
  ]);
  return {
    git,
    gh: !!gh,
    ...account,
    gitAuth: helper ? "helper" : account.login ? "gh" : "none",
  };
}

/**
 * Options that let one git command sign in to github.com through the user's `gh`, the way
 * `gh auth setup-git` would, without changing their git settings. Empty when git has its own
 * credential helper, when `gh` is missing, or when its path could not be quoted safely.
 */
export async function ghCredentialArgs(): Promise<string[]> {
  if (await gitHasHelper()) return [];
  const gh = findGh();
  if (!gh || gh.includes("'")) return [];
  // git runs a `!` helper through a shell, which wants forward slashes, even on Windows.
  const quoted = `'${gh.replaceAll("\\", "/")}'`;
  return ["-c", `credential.https://github.com.helper=!${quoted} auth git-credential`];
}

/**
 * Reads `owner/name`, `github.com/owner/name`, its https address or its ssh address.
 * Returns undefined for anything else, so nothing but a GitHub repository is ever cloned.
 */
export function parseGithubRepo(input: string): { owner: string; name: string } | undefined {
  const text = input.trim();
  const match =
    /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*|\/(?:tree|blob|pulls?|issues|commits?|compare|actions|releases|wiki|branches|tags|settings|security|discussions|projects|raw|blame)(?:[/?#].*)?)?$/i.exec(
      text,
    );
  if (!match) return undefined;
  const [, owner, name] = match as unknown as [string, string, string];
  if (name === "." || name === "..") return undefined;
  return { owner, name };
}

/** Where `~` means the home folder, like in a terminal. */
export function expandHome(raw: string, home = os.homedir()): string {
  return path.resolve(raw.trim().replace(/^~(?=$|[\\/])/, home));
}

/**
 * Clones `source` into `dest`, a folder that must not exist yet or be empty, creating the
 * folders above it. `gitArgs` go before `clone`, such as the ones that lend `gh`'s sign-in.
 */
export async function cloneInto(source: string, dest: string, gitArgs: string[] = []) {
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory() || readdirSync(dest).length > 0) {
      throw new Error(`Le dossier ${dest} existe déjà et n'est pas vide. Choisis un autre nom.`);
    }
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await run("git", [...gitArgs, "clone", "--quiet", "--", source, dest], {
      timeout: CLONE_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /could not read Username|Authentication failed|Repository not found|403/i.test(
      message,
    )
      ? " Si le dépôt est privé, connecte gh (`gh auth login`) puis réessaie."
      : "";
    throw new Error(`Le clonage a échoué : ${message.split("\n").at(-1)}${hint}`, {
      cause: error,
    });
  }
}

/** True when `dir` is a clone of that GitHub repository, by its `origin` remote. */
async function isCloneOf(dir: string, repo: { owner: string; name: string }): Promise<boolean> {
  if (!existsSync(path.join(dir, ".git"))) return false;
  try {
    const url = (
      await run("git", ["remote", "get-url", "origin"], { cwd: dir, timeout: ASK_TIMEOUT_MS })
    ).trim();
    const found = parseGithubRepo(url);
    return (
      !!found &&
      found.owner.toLowerCase() === repo.owner.toLowerCase() &&
      found.name.toLowerCase() === repo.name.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Clones a GitHub repository into `parent/name` and returns the new folder. */
export async function cloneGithubRepo(input: {
  repo: string;
  parent: string;
  name?: string;
}): Promise<{ dest: string; name: string; existing?: boolean }> {
  const repo = parseGithubRepo(input.repo);
  if (!repo) {
    throw new Error("Indique un dépôt GitHub : propriétaire/nom ou son adresse github.com.");
  }
  const name = input.name?.trim() || repo.name;
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error("Le nom du dossier ne peut pas contenir de / ni de \\.");
  }
  const dest = path.join(expandHome(input.parent), name);
  // Already cloned there: it simply becomes the project.
  if (await isCloneOf(dest, repo)) return { dest, name, existing: true };
  await cloneInto(
    `https://github.com/${repo.owner}/${repo.name}.git`,
    dest,
    await ghCredentialArgs(),
  );
  return { dest, name };
}

/** The repositories the signed-in `gh` account can reach, last pushed first. */
export async function githubRepos(): Promise<GithubRepo[]> {
  const gh = findGh();
  if (!gh) throw new Error("GitHub CLI (gh) n'est pas installé sur cette machine.");
  const out = await run(
    gh,
    [
      "api",
      "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
      "--jq",
      ".[] | {f: .full_name, p: .private, d: .description, t: .pushed_at}",
    ],
    { timeout: ASK_TIMEOUT_MS * 2 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { f: string; p: boolean; d: string | null; t: string | null },
    )
    .map((r) => ({
      fullName: r.f,
      private: r.p,
      ...(r.d ? { description: r.d } : {}),
      ...(r.t ? { pushedAt: Date.parse(r.t) } : {}),
    }));
}
