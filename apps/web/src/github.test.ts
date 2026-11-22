import type { GithubRepo, GithubStatus } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  canClone,
  filterRepos,
  githubOwner,
  githubStatusText,
  parentFolder,
  repoFolderName,
} from "./github.ts";

const status = (extra: Partial<GithubStatus>): GithubStatus => ({
  git: true,
  gh: true,
  gitAuth: "none",
  ...extra,
});

describe("githubStatusText", () => {
  it("says who is signed in", () => {
    const text = githubStatusText(status({ login: "moon", gitAuth: "gh" }));
    expect(text).toMatchObject({ tone: "ok", label: "Connecté : @moon" });
  });
  it("tells what to do next", () => {
    expect(githubStatusText(status({ git: false })).tone).toBe("err");
    expect(githubStatusText(status({})).detail).toMatch(/gh auth login/);
    expect(githubStatusText(status({ gh: false })).detail).toMatch(/cli\.github\.com/);
    expect(githubStatusText(status({ gitAuth: "helper" })).label).toBe("gh pas connecté");
  });
});

describe("filterRepos", () => {
  const repos: GithubRepo[] = [
    { fullName: "moon/app", private: false, description: "Une appli" },
    { fullName: "moon/site", private: true },
  ];
  it("matches the name or the description", () => {
    expect(filterRepos(repos, "SITE").map((r) => r.fullName)).toEqual(["moon/site"]);
    expect(filterRepos(repos, "appli").map((r) => r.fullName)).toEqual(["moon/app"]);
    expect(filterRepos(repos, "")).toHaveLength(2);
    expect(filterRepos(repos, "https://github.com/x/y")).toHaveLength(2);
  });
});

describe("repoFolderName", () => {
  it("takes the repository's name", () => {
    expect(repoFolderName("moon/app")).toBe("app");
    expect(repoFolderName("https://github.com/moon/app.git")).toBe("app");
    expect(repoFolderName("https://github.com/moon/app/tree/main")).toBe("app");
    expect(repoFolderName("git@github.com:moon/app.git")).toBe("app");
    expect(repoFolderName("https://github.com/moon/app/pull/28")).toBe("app");
    expect(repoFolderName("github.com/moon/app.git/")).toBe("app");
    expect(repoFolderName("moon/..")).toBe("");
  });
});

describe("parentFolder", () => {
  it("keeps the project's separators", () => {
    expect(parentFolder("/home/me/code/app")).toBe("/home/me/code");
    expect(parentFolder("C:\\Users\\me\\code\\app")).toBe("C:\\Users\\me\\code");
    expect(parentFolder("C:\\app")).toBe("C:\\");
    expect(parentFolder("/app")).toBe("");
  });
});

describe("githubOwner", () => {
  it("reads a profile address, not a repository", () => {
    expect(githubOwner("https://github.com/Moon-ItachiDEV")).toBe("Moon-ItachiDEV");
    expect(githubOwner("github.com/moon/")).toBe("moon");
    expect(githubOwner("https://github.com/moon?tab=repositories")).toBe("moon");
    expect(githubOwner("https://github.com/moon/app")).toBeUndefined();
    expect(githubOwner("moon/app")).toBeUndefined();
    expect(githubOwner("moon")).toBeUndefined();
  });
  it("lists only that account's repositories and names no folder", () => {
    const repos: GithubRepo[] = [
      { fullName: "Moon/app", private: false },
      { fullName: "other/moon", private: false },
    ];
    expect(filterRepos(repos, "https://github.com/moon").map((r) => r.fullName)).toEqual([
      "Moon/app",
    ]);
    expect(repoFolderName("https://github.com/Moon-ItachiDEV")).toBe("");
  });
});

describe("canClone", () => {
  it("never clones a profile address, even with a name", () => {
    expect(canClone("https://github.com/moon", "/home/moon", "app")).toBe(false);
    expect(canClone("github.com/moon/", "/home/moon", "app")).toBe(false);
    expect(canClone("https://github.com/moon?tab=repositories", "/home/moon", "app")).toBe(false);
  });
  it("clones a repository into a parent folder", () => {
    expect(canClone("moon/app", "/home/moon", "")).toBe(true);
    expect(canClone("https://github.com/moon/app", "C:\\code", "")).toBe(true);
    expect(canClone("moon/app", "/home/moon", "autre")).toBe(true);
  });
  it("needs a repository and a parent folder", () => {
    expect(canClone("", "/home/moon", "app")).toBe(false);
    expect(canClone("  ", "/home/moon", "app")).toBe(false);
    expect(canClone("moon/app", "", "app")).toBe(false);
    expect(canClone("moon/app", "  ", "")).toBe(false);
  });
});
