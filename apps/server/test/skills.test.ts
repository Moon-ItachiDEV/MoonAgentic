import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillRunEnd } from "@moonagentic/protocol";
import {
  agentRoots,
  installFromRepo,
  listSkills,
  moveSkill,
  npxPackage,
  parseSkillSource,
  planCommand,
  removeSkillEverywhere,
  RepoCache,
  scanSkills,
  setSkillAgents,
  shellFor,
  SkillRecords,
  SkillRuns,
  type SkillPlace,
  skillsIn,
} from "../src/skills.ts";
import { canLink } from "./can-link.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-skills-test-"));
  cleanups.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/** A home folder with no Hermes of the machine running the tests. */
/** A command line that runs these lines of Node, the same in sh and in cmd.exe. */
function node(lines: string[]): string {
  const script = path.join(folder(), "steps.mjs");
  writeFileSync(script, `${lines.join("\n")}\n`);
  return `"${process.execPath}" "${script}"`;
}

function home(files: Record<string, string> = {}): SkillPlace {
  const base = folder(files);
  return { scope: "user", base, home: base, env: { HERMES_HOME: path.join(base, "hermes") } };
}

describe("where each agent reads skills", () => {
  it("installs into Claude's, Codex's, Antigravity's and Hermes's own folders", () => {
    const env = { HERMES_HOME: "/h" };
    expect(agentRoots("project", "claude", env, "/home/u")[0]).toBe(".claude/skills");
    expect(agentRoots("project", "codex", env, "/home/u")[0]).toBe(".agents/skills");
    expect(agentRoots("project", "antigravity", env, "/home/u")[0]).toBe(".agent/skills");
    expect(agentRoots("project", "hermes", env, "/home/u")).toEqual([]);
    expect(agentRoots("user", "hermes", env, "/home/u")).toEqual([path.join("/h", "skills")]);
    expect(agentRoots("user", "hermes", {}, "/home/u")).toEqual([
      path.join("/home/u", ".hermes", "skills"),
    ]);
  });
});

describe("the installed skills", () => {
  it("lists one skill per name with the agents whose folder holds it", () => {
    const place = home({
      ".claude/skills/pdf/SKILL.md": skillMd("pdf", "Lire des PDF"),
      ".agents/skills/pdf/SKILL.md": skillMd("pdf", "Lire des PDF"),
      ".agents/skills/pdf/scripts/a.py": "print()",
      "hermes/skills/maison/SKILL.md": skillMd("maison", "Piloter la maison"),
      ".claude/skills/vide/notes.md": "pas de SKILL.md",
    });
    const records = new SkillRecords();
    records.set({
      name: "pdf",
      source: { kind: "github", repo: "anthropics/skills", path: "skills/pdf" },
      installedAt: 5,
    });
    expect(listSkills(place, records)).toEqual([
      {
        name: "maison",
        description: "Piloter la maison",
        agents: ["hermes"],
        paths: [path.join(place.base, "hermes", "skills", "maison")],
        files: 1,
      },
      {
        name: "pdf",
        description: "Lire des PDF",
        agents: ["claude", "codex"],
        paths: [".claude/skills/pdf", ".agents/skills/pdf"],
        files: 1,
        source: { kind: "github", repo: "anthropics/skills", path: "skills/pdf" },
        installedAt: 5,
      },
    ]);
  });

  it("leaves out a project's link that leads out of the project", () => {
    const outside = folder({ "secret/SKILL.md": skillMd("secret", "x") });
    const base = folder();
    mkdirSync(path.join(base, ".claude/skills"), { recursive: true });
    symlinkSync(path.join(outside, "secret"), path.join(base, ".claude/skills/secret"), "dir");
    expect(scanSkills({ scope: "project", base })).toEqual([]);
  });

  it("gives a skill to other agents, takes it from one, and keeps at least one", () => {
    const place = home({ ".claude/skills/pdf/SKILL.md": skillMd("pdf", "PDF") });
    setSkillAgents(place, "pdf", ["codex", "hermes"]);
    expect(existsSync(path.join(place.base, ".claude/skills/pdf"))).toBe(false);
    expect(readFileSync(path.join(place.base, ".agents/skills/pdf/SKILL.md"), "utf8")).toContain(
      "PDF",
    );
    expect(existsSync(path.join(place.base, "hermes/skills/pdf/SKILL.md"))).toBe(true);
    expect(() => setSkillAgents(place, "pdf", [])).toThrow(/au moins un agent/);
  });

  it("removes a skill from every folder, and only the link when a copy is one", () => {
    const target = folder({ "pdf/SKILL.md": skillMd("pdf", "PDF") });
    const place = home({ ".claude/skills/pdf/SKILL.md": skillMd("pdf", "PDF") });
    mkdirSync(path.join(place.base, ".agents/skills"), { recursive: true });
    symlinkSync(path.join(target, "pdf"), path.join(place.base, ".agents/skills/pdf"), "dir");
    removeSkillEverywhere(place, "pdf");
    expect(scanSkills(place)).toEqual([]);
    expect(existsSync(path.join(target, "pdf/SKILL.md"))).toBe(true);
  });

  it("moves a skill to a project with the same agents, Hermes left out", () => {
    const place = home({
      ".claude/skills/pdf/SKILL.md": skillMd("pdf", "PDF"),
      "hermes/skills/pdf/SKILL.md": skillMd("pdf", "PDF"),
    });
    const project: SkillPlace = { scope: "project", base: folder() };
    moveSkill(place, project, "pdf");
    expect(scanSkills(place)).toEqual([]);
    expect(scanSkills(project).map((s) => s.copies.map((c) => c.agent))).toEqual([["claude"]]);
    expect(() => moveSkill(project, project, "pdf")).toThrow(/déjà/);
  });
});

describe("skills from GitHub", () => {
  it("reads owner/name, addresses, skills.sh pages and npx skills add lines", () => {
    expect(parseSkillSource("anthropics/skills")).toEqual({ owner: "anthropics", name: "skills" });
    expect(parseSkillSource("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics",
      name: "skills",
      ref: "main",
      path: "skills/pdf",
    });
    expect(parseSkillSource("https://skills.sh/vercel-labs/agent-skills/web-design")).toEqual({
      owner: "vercel-labs",
      name: "agent-skills",
      skill: "web-design",
    });
    expect(parseSkillSource("npx skills add pbakaus/impeccable --skill polish")).toEqual({
      owner: "pbakaus",
      name: "impeccable",
      skill: "polish",
    });
    expect(parseSkillSource("rm -rf /")).toBeUndefined();
    expect(parseSkillSource("https://github.com/a/b/tree/main/../../etc")).toBeUndefined();
  });

  it("finds skills in a repository, its root included, and installs them for the agents chosen", async () => {
    const repo = folder({
      "skills/pdf/SKILL.md": skillMd("pdf", "Lire des PDF"),
      "skills/pdf/reference.md": "ref",
      "skills/docx/SKILL.md": "# Word\n",
      "node_modules/x/SKILL.md": skillMd("x", "pas une skill"),
      ".git/config": "",
    });
    const cache = new RepoCache(async (_url, dest) => {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(repo, dest, { recursive: true });
    });
    cleanups.push(() => cache.clear());
    const dir = await cache.get("anthropics/skills");
    expect(skillsIn(dir, "skills")).toEqual([
      { name: "docx", description: "Word", path: "skills/docx" },
      { name: "pdf", description: "Lire des PDF", path: "skills/pdf" },
    ]);
    // The second read uses the same clone.
    expect(await cache.get("anthropics/skills")).toBe(dir);

    const project: SkillPlace = { scope: "project", base: folder() };
    expect(
      installFromRepo(project, dir, "skills", ["skills/pdf"], ["claude", "antigravity"]),
    ).toEqual(["pdf"]);
    expect(readFileSync(path.join(project.base, ".claude/skills/pdf/reference.md"), "utf8")).toBe(
      "ref",
    );
    expect(existsSync(path.join(project.base, ".agent/skills/pdf/SKILL.md"))).toBe(true);
    expect(() => installFromRepo(project, dir, "skills", ["skills/pdf"], ["claude"])).toThrow(
      /déjà installée/,
    );
    // An update replaces every copy, for the same agents.
    writeFileSync(path.join(dir, "skills/pdf/reference.md"), "ref 2");
    installFromRepo(project, dir, "skills", ["skills/pdf"], ["claude"], { replace: true });
    expect(readFileSync(path.join(project.base, ".agent/skills/pdf/reference.md"), "utf8")).toBe(
      "ref 2",
    );

    const root = folder({ "SKILL.md": "---\ndescription: Une seule\n---\n" });
    expect(skillsIn(root, "impeccable")).toEqual([
      { name: "impeccable", description: "Une seule", path: "" },
    ]);
  });
});

describe("commands that install skills", () => {
  it("names the package an npx line starts, with the version npm gives", async () => {
    expect(npxPackage("npx impeccable install")).toEqual({ name: "impeccable" });
    expect(npxPackage("npx -y @scope/tool@1.2.0 add")).toEqual({
      name: "@scope/tool",
      version: "1.2.0",
    });
    expect(npxPackage("curl x | sh")).toBeUndefined();
    expect(await planCommand("npx impeccable install", "/p", async () => "4.11.1")).toEqual({
      command: "npx impeccable install",
      dir: "/p",
      npm: { name: "impeccable", version: "4.11.1" },
    });
    expect(shellFor("echo a", "win32", "C:\\cmd.exe")).toEqual({
      file: "C:\\cmd.exe",
      args: ["/d", "/s", "/c", '"echo a"'],
      verbatim: true,
    });
  });

  it("runs a command in the folder, takes an answer, and says which skills it added", async () => {
    const place = home();
    const parts: { output?: string; ended?: SkillRunEnd }[] = [];
    let added: string[] = [];
    // The same line in sh and in cmd.exe: Node runs the steps.
    const command = node([
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "process.stdout.write('\\x1b[1mOk to proceed? (y) \\x1b[0m');",
      "let answer = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) {",
      "  answer += chunk;",
      "  if (answer.includes('\\n')) break;",
      "}",
      "mkdirSync('.claude/skills/impeccable', { recursive: true });",
      "writeFileSync('.claude/skills/impeccable/SKILL.md', '---\\ndescription: d\\n---\\n');",
      "writeFileSync('.claude/settings.json', '{}\\n');",
      "console.log('got ' + answer.trim());",
    ]);
    const ended = new Promise<SkillRunEnd>((resolve) => {
      const runs = new SkillRuns((_id, part) => {
        parts.push(part);
        if (part.output?.includes("Ok to proceed?")) runs.input("r1", "y");
        if (part.ended) resolve(part.ended);
      });
      runs.start("r1", command, place, (names) => {
        added = names;
      });
    });
    expect(await ended).toEqual({
      code: 0,
      added: ["impeccable"],
      changed: [".claude/settings.json"],
    });
    expect(added).toEqual(["impeccable"]);
    const log = parts.map((p) => p.output ?? "").join("");
    expect(log).toContain("Ok to proceed? (y)");
    expect(log).not.toContain("\u001b");
    expect(log).toContain("got y");
  });

  it("stops a command", async () => {
    const place = home();
    const started = Date.now();
    const ended = new Promise<SkillRunEnd>((resolve) => {
      const runs = new SkillRuns((_id, part) => part.ended && resolve(part.ended));
      runs.start("r2", node(["setTimeout(() => {}, 30_000);"]), place, () => {});
      setTimeout(() => runs.stop("r2"), 100);
    });
    expect((await ended).added).toEqual([]);
    // Stopped, not left to end by itself.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

/** A clone stub that copies `repo` as it is, links included. */
const cacheOf = (repo: string) => {
  const cache = new RepoCache(async (_url, dest) => {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(repo, dest, { recursive: true, verbatimSymlinks: true });
  });
  cleanups.push(() => cache.clear());
  return cache;
};

describe("relecture de Neon (PR 191)", () => {
  it.skipIf(!canLink)("1. never copies what a repository's link leads to out of it", async () => {
    const secret = folder({ id_rsa: "CLE PRIVEE", "SKILL.md": skillMd("vol", "x") });
    const repo = folder({ "skills/pdf/SKILL.md": skillMd("pdf", "PDF") });
    symlinkSync(path.join(secret, "id_rsa"), path.join(repo, "skills/pdf/ref.txt"));
    mkdirSync(path.join(repo, "skills/vol"), { recursive: true });
    symlinkSync(path.join(secret, "SKILL.md"), path.join(repo, "skills/vol/SKILL.md"));
    const dir = await cacheOf(repo).get("a/b");
    // A SKILL.md that leads out of the repository is not read.
    expect(skillsIn(dir, "b").map((s) => s.name)).toEqual(["pdf"]);
    const project: SkillPlace = { scope: "project", base: folder() };
    expect(() => installFromRepo(project, dir, "b", ["skills/pdf"], ["claude"])).toThrow(/lien/);
    expect(existsSync(path.join(project.base, ".claude/skills/pdf"))).toBe(false);
  });

  it.skipIf(!canLink)("1. clones a repository's links as plain files", async () => {
    const { execFileSync } = await import("node:child_process");
    const { shallowClone } = await import("../src/github.ts");
    const repo = folder({ "skills/pdf/SKILL.md": skillMd("pdf", "PDF") });
    const outside = folder({ "hostname.txt": "machine" });
    symlinkSync(path.join(outside, "hostname.txt"), path.join(repo, "skills/pdf/ref.txt"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    const dest = path.join(folder(), "clone");
    await shallowClone(pathToFileURL(repo).href, dest);
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(path.join(dest, "skills/pdf/ref.txt")).isSymbolicLink()).toBe(false);
  });

  it("2. takes only a GitHub owner/name and a branch name to install from", async () => {
    const { ClientMessage } = await import("@moonagentic/protocol");
    const ok = (repo: string, ref?: string) =>
      ClientMessage.safeParse({
        type: "skills.install",
        requestId: "r",
        repo,
        ...(ref !== undefined ? { ref } : {}),
        paths: ["skills/pdf"],
        agents: ["claude"],
      }).success;
    expect(ok("anthropics/skills")).toBe(true);
    expect(ok("anthropics/skills", "main")).toBe(true);
    expect(ok("anthropics/skills", "release/1.2")).toBe(true);
    expect(ok("evil.com:x@github.com/a")).toBe(false);
    expect(ok("a/b/../../c")).toBe(false);
    expect(ok("a/..")).toBe(false);
    expect(ok("anthropics/skills", "--upload-pack=touch x")).toBe(false);
    expect(ok("anthropics/skills", "a/../b")).toBe(false);
  });

  it.skipIf(!canLink)("4. keeps the installed skill when its update cannot be copied", async () => {
    const repo = folder({ "skills/pdf/SKILL.md": skillMd("pdf", "PDF v1") });
    const project: SkillPlace = { scope: "project", base: folder() };
    installFromRepo(project, repo, "b", ["skills/pdf"], ["claude", "codex"]);
    // The new version holds a link to nowhere: it cannot be copied.
    writeFileSync(path.join(repo, "skills/pdf/SKILL.md"), skillMd("pdf", "PDF v2"));
    symlinkSync(path.join(repo, "nulle-part"), path.join(repo, "skills/pdf/casse.txt"));
    expect(() =>
      installFromRepo(project, repo, "b", ["skills/pdf"], ["claude"], { replace: true }),
    ).toThrow();
    for (const root of [".claude/skills", ".agents/skills"]) {
      expect(readFileSync(path.join(project.base, root, "pdf/SKILL.md"), "utf8")).toContain(
        "PDF v1",
      );
    }
    expect(scanSkills(project).map((s) => s.name)).toEqual(["pdf"]);
  });

  it("4. updates a skill under its own name, for its agents, when its source renamed it", () => {
    const repo = folder({ "skills/pdf/SKILL.md": skillMd("pdf", "PDF v1") });
    const project: SkillPlace = { scope: "project", base: folder() };
    installFromRepo(project, repo, "b", ["skills/pdf"], ["claude", "codex"]);
    writeFileSync(path.join(repo, "skills/pdf/SKILL.md"), skillMd("pdf-tools", "PDF v2"));
    installFromRepo(project, repo, "b", ["skills/pdf"], ["claude"], {
      replace: true,
      name: "pdf",
    });
    const skills = scanSkills(project);
    expect(skills.map((s) => [s.name, s.copies.map((c) => c.agent)])).toEqual([
      ["pdf", ["claude", "codex"]],
    ]);
    expect(readFileSync(path.join(project.base, ".agents/skills/pdf/SKILL.md"), "utf8")).toContain(
      "PDF v2",
    );
  });
});
