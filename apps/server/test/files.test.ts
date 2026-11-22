import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  calledSkills,
  findProjectCommands,
  findSkills,
  frontMatter,
  listFiles,
  mentionedFiles,
  promptLinks,
  resolveInside,
  searchFiles,
} from "../src/files.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A folder holding these files, with their parent folders made on the way. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-files-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("project files for @", () => {
  it("lists a folder without git, skipping dependencies", async () => {
    const dir = folder({
      "src/app.ts": "",
      "README.md": "",
      "node_modules/x/index.js": "",
    });
    expect((await listFiles(dir)).sort()).toEqual(["README.md", "src/app.ts"]);
  });

  it("ranks the file's own name before the rest of its path", () => {
    const files = ["src/app.ts", "apps/web/src/App.tsx", "docs/application.md", "a/p/p.txt"];
    expect(searchFiles(files, "app")).toEqual([
      "src/app.ts",
      "docs/application.md",
      "apps/web/src/App.tsx",
      "a/p/p.txt",
    ]);
    expect(searchFiles(files, "web/src")).toEqual(["apps/web/src/App.tsx"]);
    // Nothing typed: the shallowest files first.
    expect(searchFiles(files, "")).toEqual([
      "docs/application.md",
      "src/app.ts",
      "a/p/p.txt",
      "apps/web/src/App.tsx",
    ]);
  });

  it("only resolves files inside the folder", () => {
    const outside = folder({ "secret.txt": "x" });
    const dir = folder({ "src/app.ts": "", "src/sub/b.ts": "" });
    expect(resolveInside(dir, "src/app.ts")).toBeDefined();
    expect(resolveInside(dir, "src")).toBeUndefined();
    expect(resolveInside(dir, "../secret.txt")).toBeUndefined();
    expect(resolveInside(dir, "src/../../secret.txt")).toBeUndefined();
    expect(resolveInside(dir, path.join(outside, "secret.txt"))).toBeUndefined();
    expect(resolveInside(dir, "C:/Windows/win.ini")).toBeUndefined();
    expect(resolveInside(dir, "missing.ts")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("refuses a link that leads outside", () => {
    const outside = folder({ "secret.txt": "x" });
    const dir = folder({ "a.txt": "" });
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "lien.txt"));
    expect(resolveInside(dir, "lien.txt")).toBeUndefined();
  });

  it("finds the files a message mentions, even before punctuation", () => {
    const dir = folder({ "src/app.ts": "", "README.md": "" });
    const found = mentionedFiles(
      "Regarde @src/app.ts, puis (@README.md). Pas toi@README.md ni @absent.ts",
      dir,
    );
    expect(found.map((f) => f.rel)).toEqual(["src/app.ts", "README.md"]);
  });
});

describe("skills for $ and project commands", () => {
  it("reads skills from the project first, then from the home folder", () => {
    const dir = folder({
      ".claude/skills/revue/SKILL.md":
        '---\nname: revue\ndescription: "Relit le diff"\n---\n# Revue\n',
      ".agents/skills/tests/SKILL.md": "# Écrit des tests\n\nDétails.",
      ".claude/skills/vide/notes.md": "pas un skill",
    });
    const home = folder({
      ".claude/skills/revue/SKILL.md": "---\nname: revue\ndescription: autre\n---\n",
      ".codex/skills/changelog/SKILL.md": "---\nname: changelog\ndescription: Notes\n---\n",
    });
    const skills = findSkills(dir, home);
    expect(skills.map(({ file: _file, ...s }) => s)).toEqual([
      {
        name: "changelog",
        description: "Notes",
        scope: "user",
        path: ".codex/skills/changelog/SKILL.md",
      },
      {
        name: "revue",
        description: "Relit le diff",
        scope: "project",
        path: ".claude/skills/revue/SKILL.md",
      },
      {
        name: "tests",
        description: "Écrit des tests",
        scope: "project",
        path: ".agents/skills/tests/SKILL.md",
      },
    ]);
    expect(calledSkills("Fais $revue puis $inconnu et $Tests.", skills).map((s) => s.name)).toEqual(
      ["revue", "tests"],
    );
  });

  it("reads the project's commands and skips what is not one", () => {
    const dir = folder({
      ".moonagentic/commands/deploy-preview.md":
        "---\ndescription: Déploie la branche\n---\nDéploie $ARGUMENTS en préproduction.\n",
      ".moonagentic/commands/notes.md": "Résume la journée",
      ".moonagentic/commands/Bad Name.md": "x",
      ".moonagentic/commands/vide.md": "---\ndescription: rien\n---\n",
    });
    expect(findProjectCommands(dir)).toEqual([
      {
        name: "deploy-preview",
        description: "Déploie la branche",
        template: "Déploie $ARGUMENTS en préproduction.",
      },
      { name: "notes", description: "Résume la journée", template: "Résume la journée" },
    ]);
    expect(frontMatter("pas de bloc").fields).toEqual({});
  });

  it("embeds small text files when the agent accepts it, and links the others", () => {
    const dir = folder({ "a.txt": "bonjour", "b.bin": "\0\0" });
    const targets = [
      { abs: path.join(dir, "a.txt"), name: "a.txt" },
      { abs: path.join(dir, "b.bin"), name: "b.bin" },
    ];
    const [text, binary] = promptLinks(targets, true);
    expect(text).toMatchObject({ type: "resource", resource: { text: "bonjour" } });
    expect(binary).toMatchObject({ type: "resource_link", name: "b.bin" });
    expect(promptLinks(targets, false).map((l) => l.type)).toEqual([
      "resource_link",
      "resource_link",
    ]);
    expect(text?.type === "resource" && text.resource.uri.startsWith("file://")).toBe(true);
  });
});
