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

  it.skipIf(process.platform === "win32")(
    "runs a command in the folder, takes an answer, and says which skills it added",
    async () => {
      const place = home();
      const parts: { output?: string; ended?: SkillRunEnd }[] = [];
      let added: string[] = [];
      const ended = new Promise<SkillRunEnd>((resolve) => {
        const runs = new SkillRuns((_id, part) => {
          parts.push(part);
          if (part.output?.includes("Ok to proceed?")) runs.input("r1", "y");
          if (part.ended) resolve(part.ended);
        });
        runs.start(
          "r1",
          [
            "printf '\\033[1mOk to proceed? (y) \\033[0m'",
            "read answer",
            'mkdir -p .claude/skills/impeccable && printf -- "---\\ndescription: d\\n---\\n" > .claude/skills/impeccable/SKILL.md',
            "echo '{}' > .claude/settings.json",
            'echo "got $answer"',
          ].join("; "),
          place,
          (names) => {
            added = names;
          },
        );
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
    },
  );

  it.skipIf(process.platform === "win32")("stops a command", async () => {
    const place = home();
    const ended = new Promise<SkillRunEnd>((resolve) => {
      const runs = new SkillRuns((_id, part) => part.ended && resolve(part.ended));
      runs.start("r2", "sleep 30", place, () => {});
      setTimeout(() => runs.stop("r2"), 100);
    });
    expect((await ended).added).toEqual([]);
  });
});
