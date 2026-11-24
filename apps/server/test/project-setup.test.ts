import { execFileSync } from "node:child_process";
import {
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
import { MAX_SETUP_FILE } from "@moonagentic/protocol";
import { findProjectCommands, findSkills, frontMatter } from "../src/files.ts";
import {
  linkClaude,
  readSetup,
  removeCommand,
  removeSkill,
  saveCommand,
  saveRules,
  saveSkill,
  withFrontMatter,
  yamlValue,
} from "../src/project-setup.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-setup-"));
  cleanups.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), "utf8");

describe("the project's instructions", () => {
  it("writes AGENTS.md and reads it back", async () => {
    const dir = folder();
    expect((await readSetup(dir, false)).rules).toEqual({ text: "", exists: false });
    saveRules(dir, "## Projet\n- TypeScript strict.\n");
    expect(read(dir, "AGENTS.md")).toBe("## Projet\n- TypeScript strict.\n");
    expect((await readSetup(dir, false)).rules).toEqual({
      text: "## Projet\n- TypeScript strict.\n",
      exists: true,
    });
  });

  it("shows nothing of an AGENTS.md too big, and never writes over it", async () => {
    const dir = folder({ "AGENTS.md": "x".repeat(MAX_SETUP_FILE + 1) });
    expect((await readSetup(dir, false)).rules).toEqual({ text: "", exists: true, tooBig: true });
    expect(() => saveRules(dir, "")).toThrow(/trop gros/);
    expect(read(dir, "AGENTS.md")).toHaveLength(MAX_SETUP_FILE + 1);
  });

  it("has CLAUDE.md import AGENTS.md: made when missing, the import put first otherwise", async () => {
    const dir = folder();
    expect(() => linkClaude(dir)).toThrow(/AGENTS.md/);
    saveRules(dir, "Règles");
    expect((await readSetup(dir, false)).claude).toBe("missing");
    linkClaude(dir);
    expect(read(dir, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect((await readSetup(dir, false)).claude).toBe("imports");

    const other = folder({ "AGENTS.md": "Règles", "CLAUDE.md": "# Mes notes\n" });
    expect((await readSetup(other, false)).claude).toBe("separate");
    linkClaude(other);
    expect(read(other, "CLAUDE.md")).toBe("@AGENTS.md\n\n# Mes notes\n");
    // Once linked, linking again changes nothing.
    linkClaude(other);
    expect(read(other, "CLAUDE.md")).toBe("@AGENTS.md\n\n# Mes notes\n");
  });

  it.skipIf(process.platform === "win32")(
    "takes a CLAUDE.md linked to AGENTS.md as read",
    async () => {
      const dir = folder({ "AGENTS.md": "Règles" });
      symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
      expect((await readSetup(dir, false)).claude).toBe("imports");
    },
  );

  it.skipIf(process.platform === "win32")("never writes through a link leading outside", () => {
    const outside = folder({ "secret.md": "clé" });
    const dir = folder();
    symlinkSync(path.join(outside, "secret.md"), path.join(dir, "AGENTS.md"));
    expect(() => saveRules(dir, "écrasé")).toThrow(/hors du projet/);
    expect(read(outside, "secret.md")).toBe("clé");

    // Nor into a folder that leads outside, nor makes any folder there.
    symlinkSync(outside, path.join(dir, ".moonagentic"));
    expect(() =>
      saveCommand(dir, { name: "deploy", description: "", template: "Déploie" }),
    ).toThrow(/hors du projet/);
    expect(existsSync(path.join(outside, "commands"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes through a link that stays inside", () => {
    const dir = folder({ "docs/AGENTS.md": "ancien" });
    symlinkSync("docs/AGENTS.md", path.join(dir, "AGENTS.md"));
    saveRules(dir, "nouveau");
    expect(read(dir, "docs/AGENTS.md")).toBe("nouveau");
  });
});

describe("the project's commands", () => {
  it("adds, renames and removes a command, which the composer then offers", () => {
    const dir = folder();
    saveCommand(dir, {
      name: "deploy",
      description: "Déployer : en préproduction",
      template: "Déploie $ARGUMENTS",
    });
    expect(findProjectCommands(dir)).toEqual([
      {
        name: "deploy",
        description: "Déployer : en préproduction",
        template: "Déploie $ARGUMENTS",
      },
    ]);
    expect(() => saveCommand(dir, { name: "deploy", description: "", template: "Autre" })).toThrow(
      /existe déjà/,
    );

    saveCommand(dir, { name: "ship", previous: "deploy", description: "", template: "Livre" });
    expect(findProjectCommands(dir)).toEqual([
      { name: "ship", description: "Livre", template: "Livre" },
    ]);
    expect(existsSync(path.join(dir, ".moonagentic/commands/deploy.md"))).toBe(false);

    removeCommand(dir, "ship");
    expect(findProjectCommands(dir)).toEqual([]);
    expect(() => removeCommand(dir, "ship")).toThrow(/n'existe plus/);
  });

  it("keeps the other fields of a command's front matter", () => {
    const dir = folder({
      ".moonagentic/commands/Review.md": "---\nmodel: x\ndescription: Ancienne\n---\nRelis\n",
    });
    saveCommand(dir, {
      name: "review",
      previous: "review",
      description: "Nouvelle",
      template: "Relis tout",
    });
    expect(read(dir, ".moonagentic/commands/Review.md")).toBe(
      "---\nmodel: x\ndescription: Nouvelle\n---\n\nRelis tout\n",
    );
  });
});

describe("the project's skills", () => {
  it("makes a skill in .agents/skills, edits it in place, then removes it", async () => {
    const dir = folder();
    const rel = saveSkill(dir, {
      name: "tests-vitest",
      description: "Écrire des tests: avec Vitest",
      body: "# Tests\n\nLance `pnpm test`.",
    });
    expect(rel).toBe(".agents/skills/tests-vitest/SKILL.md");
    const [skill] = findSkills(dir, dir);
    expect(skill).toMatchObject({
      name: "tests-vitest",
      description: "Écrire des tests: avec Vitest",
      scope: "project",
      path: rel,
    });
    expect((await readSetup(dir, false)).skills).toEqual([
      {
        name: "tests-vitest",
        description: "Écrire des tests: avec Vitest",
        scope: "project",
        path: rel,
        body: "# Tests\n\nLance `pnpm test`.",
      },
    ]);
    expect(() => saveSkill(dir, { name: "tests-vitest", description: "x", body: "" })).toThrow(
      /existe déjà/,
    );

    saveSkill(dir, { path: rel, name: "tests-vitest", description: "Tests", body: "Nouveau" });
    expect(read(dir, rel)).toBe("---\nname: tests-vitest\ndescription: Tests\n---\n\nNouveau\n");

    removeSkill(dir, rel);
    expect(existsSync(path.join(dir, ".agents/skills/tests-vitest"))).toBe(false);
  });

  it("edits a skill another agent keeps, and leaves what sits beside it", () => {
    const dir = folder({
      ".claude/skills/revue/SKILL.md": "---\nname: revue\nallowed-tools: Read\n---\nRelis\n",
      ".claude/skills/revue/script.sh": "echo",
    });
    saveSkill(dir, {
      path: ".claude/skills/revue/SKILL.md",
      name: "revue",
      description: "Relire un diff",
      body: "Relis le diff",
    });
    expect(read(dir, ".claude/skills/revue/SKILL.md")).toBe(
      "---\nname: revue\nallowed-tools: Read\ndescription: Relire un diff\n---\n\nRelis le diff\n",
    );
    removeSkill(dir, ".claude/skills/revue/SKILL.md");
    expect(existsSync(path.join(dir, ".claude/skills/revue/SKILL.md"))).toBe(false);
    expect(read(dir, ".claude/skills/revue/script.sh")).toBe("echo");
  });

  it("refuses a path that is not one of the project's skills", () => {
    const dir = folder({ "notes.md": "x" });
    expect(() =>
      saveSkill(dir, { path: "notes.md", name: "notes", description: "x", body: "écrasé" }),
    ).toThrow(/n'existe plus/);
    expect(() => removeSkill(dir, "notes.md")).toThrow(/n'existe plus/);
    expect(read(dir, "notes.md")).toBe("x");
    // A new skill's name is its folder's: nothing that could leave the skills folder.
    expect(() => saveSkill(dir, { name: "A..", description: "x", body: "" })).toThrow(/minuscules/);
  });
});

describe("front matter", () => {
  it("quotes what YAML would read otherwise, and reads it back the same", () => {
    expect(yamlValue("Relire un diff")).toBe("Relire un diff");
    for (const value of ['Déployer : en "préprod"', "- liste", "#titre", "a: b", "fin "]) {
      expect(yamlValue(value)).toBe(JSON.stringify(value));
      const source = withFrontMatter("", { description: value }, "Corps");
      expect(frontMatter(source).fields.description).toBe(value);
    }
  });

  it("never takes a field named like an object's own property for one it sets", () => {
    expect(withFrontMatter("---\nconstructor: x\n---\nA", { description: "d" }, "B")).toBe(
      "---\nconstructor: x\ndescription: d\n---\n\nB\n",
    );
  });
});

describe("what is not committed yet", () => {
  it("lists the setup files git sees as changed, relative to the project", async () => {
    const repo = folder({ "app/README.md": "x" });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const dir = path.join(repo, "app");
    saveRules(dir, "Règles");
    saveCommand(dir, { name: "deploy", description: "", template: "Déploie" });
    writeFileSync(path.join(dir, "autre.txt"), "pas un réglage");
    expect((await readSetup(dir, true)).uncommitted).toEqual([
      ".moonagentic/commands/deploy.md",
      "AGENTS.md",
    ]);
  });
});
