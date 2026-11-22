import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneGithubRepo, cloneInto, expandHome, parseGithubRepo } from "../src/github.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-gh-"));
  dirs.push(dir);
  return dir;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repoWithCommit(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "salut\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
}

describe("parseGithubRepo", () => {
  it("reads every way of naming a repository", () => {
    const want = { owner: "Moon-ItachiDEV", name: "MoonAgentic" };
    for (const input of [
      "Moon-ItachiDEV/MoonAgentic",
      "github.com/Moon-ItachiDEV/MoonAgentic",
      "https://github.com/Moon-ItachiDEV/MoonAgentic",
      "https://github.com/Moon-ItachiDEV/MoonAgentic.git",
      "https://github.com/Moon-ItachiDEV/MoonAgentic/",
      "https://github.com/Moon-ItachiDEV/MoonAgentic/tree/main/apps",
      "git@github.com:Moon-ItachiDEV/MoonAgentic.git",
      "ssh://git@github.com/Moon-ItachiDEV/MoonAgentic.git",
      "  Moon-ItachiDEV/MoonAgentic  ",
    ]) {
      expect(parseGithubRepo(input), input).toEqual(want);
    }
    expect(parseGithubRepo("me/my.lib")).toEqual({ owner: "me", name: "my.lib" });
  });

  it("refuses anything that is not a GitHub repository", () => {
    for (const input of [
      "",
      "MoonAgentic",
      "-uconfig/x",
      "--upload-pack=touch/x",
      "file:///etc/passwd",
      "ext::sh -c touch% /tmp/pwned",
      "/home/me/code/app",
      "C:\\code\\app",
      "../secret/repo",
      "https://gitlab.com/a/b",
      "https://github.com.evil.com/a/b",
      "https://evil.com/github.com/a/b",
      "a/..",
      "a/.",
      "a/b c",
      "a/b;rm -rf",
    ]) {
      expect(parseGithubRepo(input), input).toBeUndefined();
    }
  });
});

describe("expandHome", () => {
  it("reads ~ as the home folder", () => {
    expect(expandHome("~/code", "/home/me")).toBe(path.resolve("/home/me/code"));
    expect(expandHome("~", "/home/me")).toBe(path.resolve("/home/me"));
    expect(expandHome("/srv/x", "/home/me")).toBe(path.resolve("/srv/x"));
  });
});

describe("cloneInto", () => {
  it("clones into a new folder and creates the folders above it", async () => {
    const dir = tmp();
    repoWithCommit(path.join(dir, "src"));
    const dest = path.join(dir, "deep", "er", "copy");
    await cloneInto(path.join(dir, "src"), dest);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  it("never clones over a folder that has files", async () => {
    const dir = tmp();
    repoWithCommit(path.join(dir, "src"));
    const dest = path.join(dir, "busy");
    mkdirSync(dest);
    writeFileSync(path.join(dest, "notes.txt"), "à moi");
    await expect(cloneInto(path.join(dir, "src"), dest)).rejects.toThrow(/existe déjà/);
  });

  it("explains a failed clone", async () => {
    const dir = tmp();
    await expect(cloneInto(path.join(dir, "missing"), path.join(dir, "x"))).rejects.toThrow(
      /Le clonage a échoué/,
    );
  });
});

describe("cloneGithubRepo", () => {
  it("refuses a bad repository or folder name before running git", async () => {
    const dir = tmp();
    await expect(cloneGithubRepo({ repo: "file:///etc", parent: dir })).rejects.toThrow(
      /dépôt GitHub/,
    );
    await expect(cloneGithubRepo({ repo: "a/b", parent: dir, name: "../escape" })).rejects.toThrow(
      /nom du dossier/,
    );
  });

  it("takes a folder that already holds this repository as it is", async () => {
    const dir = tmp();
    const dest = path.join(dir, "MoonAgentic");
    repoWithCommit(dest);
    git(dest, "remote", "add", "origin", "https://github.com/Moon-ItachiDEV/MoonAgentic.git");
    const result = await cloneGithubRepo({
      repo: "https://github.com/moon-itachidev/MoonAgentic",
      parent: dir,
    });
    expect(result).toEqual({ dest, name: "MoonAgentic", existing: true });
  });

  it("refuses a folder of that name holding another repository", async () => {
    const dir = tmp();
    const dest = path.join(dir, "app");
    repoWithCommit(dest);
    git(dest, "remote", "add", "origin", "https://github.com/someone/else.git");
    await expect(cloneGithubRepo({ repo: "me/app", parent: dir })).rejects.toThrow(/existe déjà/);
  });
});
