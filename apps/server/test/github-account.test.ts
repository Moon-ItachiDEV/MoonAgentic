import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubAccount, type LoginResult } from "../src/github-account.ts";
import { fileVault, systemVault, type TokenVault } from "../src/github-vault.ts";
import { defaultParent, findClones, originUrl } from "../src/local-clones.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-gha-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryVault(start?: string): TokenVault & { value?: string } {
  const vault = {
    kind: "file" as const,
    value: start,
    read: async () => vault.value,
    write: async (t: string) => {
      vault.value = t;
    },
    clear: async () => {
      vault.value = undefined;
    },
  };
  return vault;
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, string>) : {};
}

/** A stand-in for github.com and api.github.com: answers `pending` until told to say yes. */
async function fakeGithub(options: { answers?: Record<string, unknown>[] } = {}) {
  const answers = [...(options.answers ?? [])];
  const seen: { path: string; auth?: string; body: Record<string, string> }[] = [];
  const server: Server = createServer(async (req, res) => {
    const b = await body(req);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: b });
    res.setHeader("content-type", "application/json");
    if (req.url === "/login/device/code") {
      res.end(
        JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0.01,
        }),
      );
    } else if (req.url === "/login/oauth/access_token") {
      res.end(JSON.stringify(answers.shift() ?? { error: "authorization_pending" }));
    } else if (req.url === "/user") {
      if (req.headers.authorization !== "Bearer gho_good") {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "Bad credentials" }));
      } else res.end(JSON.stringify({ login: "moon" }));
    } else if (req.url?.startsWith("/user/repos")) {
      res.end(
        JSON.stringify([
          { full_name: "moon/app", private: true, description: "Appli", pushed_at: null },
          { full_name: "moon/site", private: false, description: null, pushed_at: null },
        ]),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen };
}

function account(url: string, vault: TokenVault, onLogin?: (r: LoginResult) => void) {
  return new GithubAccount({ vault, webUrl: url, apiUrl: url, onLogin });
}

describe("GithubAccount", () => {
  it("signs in with a code, keeps the token in the vault and reads the account", async () => {
    const gh = await fakeGithub({
      answers: [{ error: "authorization_pending" }, { access_token: "gho_good" }],
    });
    const vault = memoryVault();
    const ended = new Promise<LoginResult>((resolve) => {
      void account(gh.url, vault, resolve)
        .startLogin()
        .then((code) => {
          expect(code.userCode).toBe("ABCD-1234");
          expect(code.verificationUri).toBe("https://github.com/login/device");
        });
    });
    expect(await ended).toEqual({ state: "done", login: "moon" });
    expect(vault.value).toBe("gho_good");
    const start = gh.seen.find((s) => s.path === "/login/device/code");
    expect(start?.body.scope).toMatch(/repo/);
  });

  it("gives the same code to a second device asking while it waits", async () => {
    const gh = await fakeGithub();
    const a = account(gh.url, memoryVault());
    const first = await a.startLogin();
    expect(await a.startLogin()).toEqual(first);
    expect(gh.seen.filter((s) => s.path === "/login/device/code")).toHaveLength(1);
    a.cancelLogin();
  });

  it("says when the user refuses on GitHub, and keeps nothing", async () => {
    const gh = await fakeGithub({ answers: [{ error: "access_denied" }] });
    const vault = memoryVault();
    const result = await new Promise<LoginResult>((resolve) => {
      void account(gh.url, vault, resolve).startLogin();
    });
    expect(result).toEqual({ state: "failed", error: "Connexion refusée sur GitHub." });
    expect(vault.value).toBeUndefined();
  });

  it("stops asking GitHub once cancelled", async () => {
    const gh = await fakeGithub();
    const results: LoginResult[] = [];
    const a = account(gh.url, memoryVault(), (r) => results.push(r));
    await a.startLogin();
    a.cancelLogin();
    const asked = gh.seen.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(results).toEqual([{ state: "cancelled" }]);
    expect(gh.seen.length).toBeLessThanOrEqual(asked + 1);
  });

  it("lists the repositories with the token, never anything else", async () => {
    const gh = await fakeGithub();
    const repos = await account(gh.url, memoryVault("gho_good")).repos();
    expect(repos).toEqual([
      { fullName: "moon/app", private: true, description: "Appli" },
      { fullName: "moon/site", private: false },
    ]);
    expect(gh.seen.every((s) => s.auth === "Bearer gho_good")).toBe(true);
  });

  it("forgets a token GitHub no longer accepts", async () => {
    const gh = await fakeGithub();
    const vault = memoryVault("gho_revoked");
    await expect(account(gh.url, vault).account()).rejects.toThrow(/plus valable/);
    expect(vault.value).toBeUndefined();
  });

  it("lends the token to git through the environment, never its command line", async () => {
    const a = account("http://x", memoryVault("gho_good"));
    expect(a.gitEnv()).toEqual({});
    await a.currentToken();
    const env = a.gitEnv({ GIT_CONFIG_COUNT: "2" });
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(
      JSON.stringify(Object.entries(env).filter(([k]) => k !== "MOONAGENTIC_GITHUB_TOKEN")),
    ).not.toContain("gho_good");
    expect(a.ghEnv()).toEqual({ GH_TOKEN: "gho_good" });
    // git really asks MoonAgentic's helper for github.com, and the user's own for other hosts.
    const home = tmp();
    const gitEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    };
    execFileSync(
      "git",
      [
        "config",
        "--global",
        "credential.helper",
        "!f() { echo username=own; echo password=ownpass; }; f",
      ],
      { env: gitEnv },
    );
    const fill = (host: string) =>
      execFileSync("git", ["credential", "fill"], {
        env: { ...gitEnv, ...a.gitEnv({}) },
        input: `protocol=https\nhost=${host}\n\n`,
      }).toString();
    expect(fill("github.com")).toContain("password=gho_good");
    expect(fill("gitlab.com")).toContain("password=ownpass");
  });
});

describe("vaults", () => {
  it("keeps the token in a file only its owner reads", async () => {
    const file = path.join(tmp(), "github-token");
    const vault = fileVault(file);
    expect(await vault.read()).toBeUndefined();
    await vault.write("gho_x");
    expect(await vault.read()).toBe("gho_x");
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    await vault.clear();
    expect(await vault.read()).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("seals the token with the Windows account", async () => {
    const dir = tmp();
    const vault = systemVault(dir);
    expect(vault.kind).toBe("windows");
    await vault.write("gho_windows_123");
    const sealed = readFileSync(path.join(dir, "github-token.dpapi"), "utf8");
    expect(sealed).not.toContain("gho_windows_123");
    expect(await vault.read()).toBe("gho_windows_123");
    await vault.clear();
    expect(await vault.read()).toBeUndefined();
  });
});

describe("local clones", () => {
  it("reads the origin remote of a git config", () => {
    const config = [
      "[core]",
      "\tbare = false",
      '[remote "upstream"]',
      "\turl = https://github.com/else/app.git",
      '[remote "origin"]',
      "\turl = git@github.com:moon/app.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\r\n");
    expect(originUrl(config)).toBe("git@github.com:moon/app.git");
    expect(originUrl("[core]\n")).toBeUndefined();
  });

  it("finds clones under the home folder and the projects' folders", async () => {
    const home = tmp();
    const clone = (dir: string, url?: string) => {
      mkdirSync(path.join(dir, ".git"), { recursive: true });
      writeFileSync(
        path.join(dir, ".git", "config"),
        url ? `[remote "origin"]\n\turl = ${url}\n` : "[core]\n",
      );
    };
    clone(
      path.join(home, "Downloads", "ADE", "MoonAgentic"),
      "https://github.com/Moon/MoonAgentic",
    );
    clone(path.join(home, "Projets", "site"), "https://github.com/moon/site.git");
    clone(path.join(home, "Projets", "notes"));
    clone(path.join(home, "node_modules", "hidden"), "https://github.com/x/y");
    clone(path.join(home, "Projets", "site", "vendor", "inner"), "https://github.com/x/inner");
    const project = { id: "p1", path: path.join(home, "Downloads", "ADE", "MoonAgentic") };
    const found = await findClones(
      [
        { dir: path.dirname(project.path), depth: 1 },
        { dir: home, depth: 2 },
      ],
      [project],
    );
    const byName = Object.fromEntries(found.map((c) => [c.name, c]));
    expect(byName.MoonAgentic).toMatchObject({ repo: "Moon/MoonAgentic", projectId: "p1" });
    expect(byName.site).toMatchObject({ repo: "moon/site" });
    expect(byName.notes?.repo).toBeUndefined();
    expect(byName.hidden).toBeUndefined();
    expect(byName.inner).toBeUndefined();
    expect(found.filter((c) => c.name === "MoonAgentic")).toHaveLength(1);
  });

  it("puts new projects next to the last one, or in a Projets folder", () => {
    const home = path.resolve("/home/moon");
    expect(defaultParent([], home)).toBe(path.join(home, "Projets"));
    expect(
      defaultParent(
        [
          { path: path.join(home, "a", "old"), createdAt: 1 },
          { path: path.join(home, "b", "new"), createdAt: 2 },
        ],
        home,
      ),
    ).toBe(path.join(home, "b"));
  });
});
