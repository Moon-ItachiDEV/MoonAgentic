import { describe, expect, it } from "vitest";
import { MAX_SETUP_FILE, type ProjectSkill } from "@moonagentic/protocol";
import {
  claudeAction,
  commandProblem,
  fits,
  oneLine,
  setupSkillOf,
  skillProblem,
} from "./project-setup.ts";

describe("project settings checks", () => {
  it("names a command as a file, once", () => {
    const commands = [{ name: "deploy", description: "", template: "x" }];
    expect(commandProblem("", commands, undefined)).toMatch(/nom/);
    expect(commandProblem("Deploy", commands, undefined)).toMatch(/minuscules/);
    expect(commandProblem("deploy", commands, undefined)).toMatch(/existe déjà/);
    expect(commandProblem("deploy", commands, "deploy")).toBeUndefined();
    expect(commandProblem("ship", commands, "deploy")).toBeUndefined();
  });

  it("names a new skill as its folder, and lets one found keep its own name", () => {
    const found: ProjectSkill = {
      name: "Revue.Code",
      description: "x",
      path: ".claude/skills/revue/SKILL.md",
      body: "",
    };
    expect(skillProblem("revue.code", [found], undefined)).toMatch(/minuscules/);
    expect(skillProblem("revue-code", [found], undefined)).toBeUndefined();
    expect(skillProblem("Revue.Code", [found], found)).toBeUndefined();
    // One found with a « : » keeps it; a new one cannot have one.
    expect(skillProblem("design:review", [found], found)).toBeUndefined();
    expect(skillProblem("design:review", [found], undefined)).toMatch(/minuscules/);
    expect(skillProblem("revue.code", [found], undefined)).not.toBeUndefined();
    const other = { ...found, name: "tests", path: ".agents/skills/tests/SKILL.md" };
    expect(skillProblem("TESTS", [found, other], found)).toMatch(/existe déjà/);
  });

  it("counts bytes, keeps descriptions on one line, and says what linking does", () => {
    expect(fits("é".repeat(MAX_SETUP_FILE / 2))).toBe(true);
    expect(fits("é".repeat(MAX_SETUP_FILE / 2 + 1))).toBe(false);
    expect(oneLine("a\nb\r\nc")).toBe("a b c");
    expect(claudeAction("missing")).toMatch(/Crée CLAUDE.md/);
    expect(claudeAction("separate")).toMatch(/en tête/);
    expect(claudeAction("imports")).toBeUndefined();
  });

  it("finds the project's skill a listed one is by its folder, renamed or not", () => {
    const listed = {
      name: "pdf",
      description: "",
      projectId: "p",
      agents: ["claude" as const, "codex" as const],
      paths: [".claude/skills/pdf", ".agents/skills/pdf"],
      files: 1,
    };
    // Its SKILL.md now calls it pdf-tools: still the same skill.
    const own: ProjectSkill = {
      name: "pdf-tools",
      description: "",
      path: ".claude/skills/pdf/SKILL.md",
      body: "",
    };
    expect(setupSkillOf(listed, "p", [own])).toBe(own);
    // Every project's skills are not written from a project's settings.
    expect(setupSkillOf({ ...listed, projectId: undefined }, "p", [own])).toBeUndefined();
    expect(setupSkillOf(listed, "p", [])).toBeUndefined();
  });
});
