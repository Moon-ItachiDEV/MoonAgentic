import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { commitAll, commitIdentity, mergeBranch, WHO_SIGNS } from "../src/git.ts";
import { setGithubAccount } from "../src/github-account.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { fakeGithubApi, signedInAccount } from "./fake-github-api.ts";
import { removeTempDir } from "./temp-dir.ts";

// Each test runs git a dozen times, and some an agent's turn: slow on a Windows runner.
vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** The commits of the test's own making, signed apart: git knows no one here. */
const AS_TEST = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

/** Who wrote and who made the last commit, as git recorded them. */
const signedBy = (dir: string, ref = "HEAD") =>
  git(dir, "log", "-1", "--format=%an <%ae> | %cn <%ce>", ref);

const MOON = "Moon Itachi <280071101+moon-itachi@users.noreply.github.com>";

let root: string;
let globalConfig: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-identity-"));
  cleanups.push(() => removeTempDir(root));
  // As on a computer where git was never told who its user is: no setting of the user's or
  // the system's, and nothing said through the environment.
  globalConfig = path.join(root, "gitconfig");
  writeFileSync(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const name of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

/**
 * A repository with one commit where git refuses to sign: it knows no one, and may not make
 * an address up from the computer's name. The mini-PC's own name gave it none (« unable to
 * auto-detect email address »); a runner's might, so guessing is turned off here.
 */
function repository(name = "repo") {
  const repo = path.join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.useConfigOnly", "true");
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  git(repo, "add", "-A");
  git(repo, ...AS_TEST, "commit", "-q", "-m", "init");
  return repo;
}

/** MoonAgentic signed in to GitHub as this account, and what was asked of GitHub. */
async function signedIn(user: Record<string, unknown> = {}) {
  const api = await fakeGithubApi((call) =>
    call.path === "/user"
      ? { login: "moon-itachi", id: 280071101, name: "Moon Itachi", ...user }
      : { status: 404, body: { message: "Not Found" } },
  );
  cleanups.push(api.close);
  return { api, account: signedInAccount(api.url) };
}

describe("who signs a commit when git knows no one", () => {
  it("is the account MoonAgentic is signed in to GitHub with, for that commit alone", async () => {
    const repo = repository();
    // What the mini-PC showed: git refuses the commit.
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    expect(() => git(repo, "commit", "-q", "-m", "x")).toThrow(/auto-detection is disabled/);

    const { api, account } = await signedIn();
    expect(await commitIdentity(repo, account)).toEqual({
      GIT_AUTHOR_NAME: "Moon Itachi",
      GIT_AUTHOR_EMAIL: "280071101+moon-itachi@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Moon Itachi",
      GIT_COMMITTER_EMAIL: "280071101+moon-itachi@users.noreply.github.com",
    });
    expect(api.calls.map((c) => c.path)).toEqual(["/user"]);
    // Not signed in, there is no one to sign with.
    expect(await commitIdentity(repo, undefined)).toEqual({});
    expect(await commitIdentity(repo, signedInAccount(api.url, ""))).toEqual({});
  });

  it("takes the login when the profile has no name, and keeps what the user did set", async () => {
    const repo = repository();
    const { account } = await signedIn({ name: null });
    expect(await commitIdentity(repo, account)).toMatchObject({
      GIT_AUTHOR_NAME: "moon-itachi",
      GIT_AUTHOR_EMAIL: "280071101+moon-itachi@users.noreply.github.com",
    });
    // A name set without an address: the name stays, GitHub's address fills the gap.
    git(repo, "config", "user.name", "Alex");
    expect(await commitIdentity(repo, account)).toEqual({
      GIT_AUTHOR_NAME: "Alex",
      GIT_AUTHOR_EMAIL: "280071101+moon-itachi@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Alex",
      GIT_COMMITTER_EMAIL: "280071101+moon-itachi@users.noreply.github.com",
    });
  });

  it("changes nothing where git already knows its user, and asks GitHub nothing", async () => {
    const repo = repository();
    git(repo, "config", "user.name", "Alex");
    git(repo, "config", "user.email", "alex@example.com");
    const { api, account } = await signedIn();
    expect(await commitIdentity(repo, account)).toEqual({});
    expect(api.calls).toEqual([]);
    setGithubAccount(account);
    cleanups.push(() => setGithubAccount(undefined));
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    expect(await commitAll(repo, "Ajoute a")).toBe(true);
    expect(signedBy(repo)).toBe("Alex <alex@example.com> | Alex <alex@example.com>");
  });

  it("signs a team's commits and merges too", async () => {
    const repo = repository();
    const { account } = await signedIn();
    setGithubAccount(account);
    cleanups.push(() => setGithubAccount(undefined));
    git(repo, "checkout", "-q", "-b", "piece");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    expect(await commitAll(repo, "Ajoute a")).toBe(true);
    expect(signedBy(repo)).toBe(`${MOON} | ${MOON}`);
    git(repo, "checkout", "-q", "main");
    expect(await mergeBranch(repo, "piece", "Fusion : a")).toEqual([]);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Fusion : a");
    expect(signedBy(repo)).toBe(`${MOON} | ${MOON}`);
  });
});

describe("« Commit et PR » on a computer where git knows no one", () => {
  /** A thread on its own branch, pushed to a folder, in a repository git cannot sign in. */
  async function shipping() {
    const repo = repository();
    const bare = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", "origin", bare);
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(root, "worktrees"),
      prWatchMs: 0,
      homeDir: root,
    });
    cleanups.unshift(async () => {
      setGithubAccount(undefined);
      await hub.close();
      store.close();
    });
    const threadId = hub.createThread({
      projectId: hub.createProject("demo", repo),
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Retouche de la feuille GitHub",
    });
    await hub.whenIdle(threadId);
    const workspace = store.getThread(threadId)!.workspace!;
    return { hub, repo, bare, threadId, tree: workspace.path, branch: workspace.branch };
  }

  it("commits and pushes as the GitHub account, and writes no git setting", async () => {
    const { hub, repo, bare, threadId, tree, branch } = await shipping();
    setGithubAccount((await signedIn()).account);
    writeFileSync(path.join(tree, "a.txt"), "a\n");
    writeFileSync(path.join(tree, "b.txt"), "b\n");
    // All that changed, as « Commit et PR » sends it.
    const all = await hub.ship(threadId, "Retouche de la feuille GitHub", true);
    expect(all.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(signedBy(tree)).toBe(`${MOON} | ${MOON}`);
    expect(git(bare, "rev-parse", branch)).toBe(all.commit);
    // Only the files ticked in the panel.
    writeFileSync(path.join(tree, "a.txt"), "a\na\n");
    const some = await hub.ship(threadId, "Seulement a", false, ["a.txt"]);
    expect(signedBy(bare, branch)).toBe(`${MOON} | ${MOON}`);
    expect(git(bare, "rev-parse", branch)).toBe(some.commit);
    // « Synchroniser », with work not committed kept aside meanwhile.
    writeFileSync(path.join(repo, "main.txt"), "main\n");
    git(repo, "add", "-A");
    git(repo, ...AS_TEST, "commit", "-q", "-m", "main avance");
    writeFileSync(path.join(tree, "b.txt"), "b\nb\n");
    await hub.syncWithBase(threadId);
    expect(git(tree, "log", "-1", "--format=%s")).toBe("Fusion de main");
    expect(signedBy(tree)).toBe(`${MOON} | ${MOON}`);
    expect(readFileSync(path.join(tree, "b.txt"), "utf8")).toBe("b\nb\n");
    // The identity went with each command: git's settings are as they were.
    expect(readFileSync(globalConfig, "utf8")).toBe("");
    expect(git(repo, "config", "--get-regexp", "^user\\.")).toBe("user.useconfigonly true");
  });

  it("says what to do, in the user's words, when MoonAgentic is not signed in either", async () => {
    const { hub, threadId, tree, bare, branch } = await shipping();
    writeFileSync(path.join(tree, "a.txt"), "a\n");
    await expect(hub.ship(threadId, "Retouche", true)).rejects.toThrow(WHO_SIGNS);
    await expect(hub.ship(threadId, "Retouche", false, ["a.txt"])).rejects.toThrow(WHO_SIGNS);
    expect(() => git(bare, "rev-parse", branch)).toThrow();
    // Once signed in, the same button goes through.
    setGithubAccount((await signedIn()).account);
    await hub.ship(threadId, "Retouche", false);
    expect(signedBy(bare, branch)).toBe(`${MOON} | ${MOON}`);
  });
});
