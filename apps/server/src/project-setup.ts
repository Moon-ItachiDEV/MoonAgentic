// What a project gives its agents, edited from its settings: the shared instructions in
// `AGENTS.md`, `CLAUDE.md` importing them for Claude Code, its `/` commands and its skills.
// Everything is a file in the project's own folder, versioned with it, rather than a memory
// kept in the database. Every write stays inside the folder, symbolic links included.
import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_SETUP_FILE, type ProjectSetup, type ProjectSkill } from "@moonagentic/protocol";
import {
  COMMANDS_DIR,
  PROJECT_SKILL_ROOTS,
  findProjectCommands,
  findSkills,
  frontMatter,
  resolveInside,
} from "./files.ts";
import { GIT_QUIET } from "./git-own.ts";

export const RULES_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
/** Where a skill made from the app goes: the folder several agents read. */
export const NEW_SKILLS_DIR = ".agents/skills";
/** The line by which `CLAUDE.md` pulls in `AGENTS.md`. */
const IMPORT_LINE = "@AGENTS.md";
const IMPORTS = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m;

/** A refusal worth showing as it is. */
export class SetupError extends Error {}

/** Whether `inner` is `root` itself or inside it. */
const within = (root: string, inner: string) => {
  const rel = path.relative(root, inner);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * The real path a file named relative to `dir` is written at, its folders made on the way.
 * No absolute path and no `..`; a folder or the file itself may be a link only when it
 * leads back inside the project.
 */
function writable(dir: string, rel: string): string {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new SetupError("Chemin refusé.");
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === "..")) throw new SetupError("Chemin refusé.");
  const root = realpathSync(dir);
  let at = root;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(at, part);
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      mkdirSync(next);
      at = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const real = realpathSync(next);
      if (!within(root, real) || !statSync(real).isDirectory()) {
        throw new SetupError(`${part} mène hors du projet.`);
      }
      at = real;
    } else if (stat.isDirectory()) {
      at = next;
    } else {
      throw new SetupError(`${part} n'est pas un dossier.`);
    }
  }
  const file = path.join(at, parts.at(-1)!);
  try {
    if (lstatSync(file).isSymbolicLink()) {
      const real = realpathSync(file);
      if (!within(root, real) || !statSync(real).isFile()) {
        throw new SetupError(`${rel} mène hors du projet.`);
      }
      return real;
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    // Not there yet: made below.
  }
  return file;
}

/** Writes the whole file at once: a reader never sees half of it. */
function writeInside(dir: string, rel: string, text: string): void {
  if (Buffer.byteLength(text) > MAX_SETUP_FILE) throw new SetupError("Texte trop long.");
  const file = writable(dir, rel);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  writeFileSync(temp, text);
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
    throw error;
  }
}

/** A value as YAML reads it back the same: bare when plain, between double quotes otherwise. */
export function yamlValue(value: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} .,()'’/_-]*$/u.test(value) && !value.endsWith(" ")
    ? value
    : JSON.stringify(value);
}

/**
 * The Markdown of a skill or a command: its front matter with these fields set (others it
 * had kept as they were, those set to "" left out), then its body.
 */
export function withFrontMatter(
  source: string,
  fields: Record<string, string>,
  body: string,
): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  const lines = match ? (match[1] ?? "").split(/\r?\n/) : [];
  const set = new Set<string>();
  const kept = lines.flatMap((line) => {
    const key = /^([A-Za-z][\w-]*):/.exec(line)?.[1]?.toLowerCase();
    if (!key || !Object.hasOwn(fields, key)) return [line];
    if (set.has(key)) return [];
    set.add(key);
    const value = fields[key];
    return value ? [`${key}: ${yamlValue(value)}`] : [];
  });
  for (const [key, value] of Object.entries(fields)) {
    if (!set.has(key) && value) kept.push(`${key}: ${yamlValue(value)}`);
  }
  const text = body.replace(/^\s*\n/, "").trimEnd();
  return kept.length ? `---\n${kept.join("\n")}\n---\n\n${text}\n` : `${text}\n`;
}

const readText = (file: string) => {
  const size = statSync(file).size;
  return size > MAX_SETUP_FILE ? undefined : readFileSync(file, "utf8");
};

/** The project's skills, its own only, with their text. */
function projectSkills(dir: string): (ProjectSkill & { file: string })[] {
  return findSkills(dir, dir).flatMap((skill) => {
    if (skill.scope !== "project") return [];
    try {
      const source = readText(skill.file);
      if (source === undefined) return [];
      return [
        {
          ...skill,
          body: frontMatter(source)
            .body.replace(/^\s*\n/, "")
            .trimEnd(),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** How `CLAUDE.md` stands with `AGENTS.md`. */
function claudeState(dir: string): ProjectSetup["claude"] {
  const claude = resolveInside(dir, CLAUDE_FILE);
  if (!claude) return "missing";
  const rules = resolveInside(dir, RULES_FILE);
  if (rules && rules === claude) return "imports";
  try {
    return IMPORTS.test(readText(claude) ?? "") ? "imports" : "separate";
  } catch {
    return "separate";
  }
}

const git = (dir: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      [...GIT_QUIET, ...args],
      { cwd: dir, timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );

/** Which of the setup files git sees as changed and not committed, relative to `dir`. */
export async function uncommitted(dir: string): Promise<string[]> {
  const prefix = (await git(dir, ["rev-parse", "--show-prefix"])).trim();
  const out = await git(dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    RULES_FILE,
    CLAUDE_FILE,
    COMMANDS_DIR,
    ...PROJECT_SKILL_ROOTS,
  ]);
  const files = new Set<string>();
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    // A rename is followed by the name it had.
    if (entry[0] === "R" || entry[0] === "C") i += 1;
    const file = entry.slice(3);
    if (file.startsWith(prefix)) files.add(file.slice(prefix.length));
  }
  return [...files].sort();
}

/** What the project gives its agents, as its settings show it. */
export async function readSetup(dir: string, isGit: boolean): Promise<ProjectSetup> {
  let rules: ProjectSetup["rules"] = { text: "", exists: false };
  const file = resolveInside(dir, RULES_FILE);
  if (file) {
    const text = readText(file);
    rules = text === undefined ? { text: "", exists: true, tooBig: true } : { text, exists: true };
  }
  const pending = isGit ? await uncommitted(dir).catch(() => undefined) : undefined;
  return {
    rules,
    claude: claudeState(dir),
    commands: findProjectCommands(dir),
    skills: projectSkills(dir).map(({ file: _file, ...skill }) => skill),
    ...(pending?.length ? { uncommitted: pending } : {}),
  };
}

export function saveRules(dir: string, text: string): void {
  const file = resolveInside(dir, RULES_FILE);
  if (file && statSync(file).size > MAX_SETUP_FILE) {
    throw new SetupError(`${RULES_FILE} est trop gros pour être modifié ici.`);
  }
  writeInside(dir, RULES_FILE, text);
}

/** Has `CLAUDE.md` import `AGENTS.md`: made when missing, the import put first otherwise. */
export function linkClaude(dir: string): void {
  if (!resolveInside(dir, RULES_FILE)) {
    throw new SetupError(`Écris d'abord ${RULES_FILE}.`);
  }
  const state = claudeState(dir);
  if (state === "imports") return;
  if (state === "missing") {
    writeInside(dir, CLAUDE_FILE, `${IMPORT_LINE}\n`);
    return;
  }
  const current = readText(resolveInside(dir, CLAUDE_FILE)!);
  if (current === undefined) throw new SetupError(`${CLAUDE_FILE} est trop gros.`);
  writeInside(dir, CLAUDE_FILE, `${IMPORT_LINE}\n\n${current}`);
}

/** The file a command is kept in, whatever the case of its name. */
function commandFile(dir: string, name: string): string | undefined {
  try {
    return readdirSync(path.join(dir, COMMANDS_DIR)).find((f) => f.toLowerCase() === `${name}.md`);
  } catch {
    return undefined;
  }
}

export function saveCommand(
  dir: string,
  command: { name: string; previous?: string; description: string; template: string },
): void {
  const renamed = command.previous && command.previous !== command.name;
  const existing = commandFile(dir, command.name);
  if (existing && (renamed || !command.previous)) {
    throw new SetupError(`Une commande /${command.name} existe déjà.`);
  }
  const old = command.previous ? commandFile(dir, command.previous) : undefined;
  if (command.previous && !old) throw new SetupError("Cette commande n'existe plus.");
  const rel = `${COMMANDS_DIR}/${existing ?? `${command.name}.md`}`;
  const oldFile = old && resolveInside(dir, `${COMMANDS_DIR}/${old}`);
  const source = oldFile ? (readText(oldFile) ?? "") : "";
  writeInside(
    dir,
    rel,
    withFrontMatter(source, { description: command.description }, command.template),
  );
  if (renamed && old) removeInside(dir, `${COMMANDS_DIR}/${old}`);
}

export function removeCommand(dir: string, name: string): void {
  const file = commandFile(dir, name);
  if (!file) throw new SetupError("Cette commande n'existe plus.");
  removeInside(dir, `${COMMANDS_DIR}/${file}`);
}

/** Removes a file of the project, never through a link leading out of it. */
function removeInside(dir: string, rel: string): void {
  const root = realpathSync(dir);
  const file = path.resolve(root, rel);
  if (!within(root, path.dirname(file)) || !within(root, realpathSync(path.dirname(file)))) {
    throw new SetupError("Chemin refusé.");
  }
  // A link is removed itself, never what it points at.
  unlinkSync(file);
}

export function saveSkill(
  dir: string,
  skill: { path?: string; name: string; description: string; body: string },
): string {
  const skills = projectSkills(dir);
  const same = skills.find((s) => s.name.toLowerCase() === skill.name.toLowerCase());
  if (skill.path) {
    const current = skills.find((s) => s.path === skill.path);
    if (!current) throw new SetupError("Cette skill n'existe plus.");
    if (same && same.path !== current.path) {
      throw new SetupError(`Une skill ${skill.name} existe déjà.`);
    }
    const source = readText(current.file) ?? "";
    writeInside(
      dir,
      current.path,
      withFrontMatter(source, { name: skill.name, description: skill.description }, skill.body),
    );
    return current.path;
  }
  // A new one is named after its folder: one safe on every system.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill.name)) {
    throw new SetupError("Un nom en minuscules, chiffres, - ou _.");
  }
  const rel = `${NEW_SKILLS_DIR}/${skill.name}/SKILL.md`;
  if (same || resolveInside(dir, rel)) throw new SetupError(`Une skill ${skill.name} existe déjà.`);
  writeInside(
    dir,
    rel,
    withFrontMatter("", { name: skill.name, description: skill.description }, skill.body),
  );
  return rel;
}

/**
 * Removes a skill's `SKILL.md`, and its folder when nothing else is left in it: scripts or
 * notes kept beside it stay.
 */
export function removeSkill(dir: string, rel: string): void {
  const skill = projectSkills(dir).find((s) => s.path === rel);
  if (!skill) throw new SetupError("Cette skill n'existe plus.");
  removeInside(dir, skill.path);
  try {
    rmdirSync(path.dirname(path.resolve(realpathSync(dir), skill.path)));
  } catch {
    // Not empty: what else is in it stays.
  }
}
