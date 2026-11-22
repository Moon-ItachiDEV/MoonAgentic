// What the composer can point at in a thread's folder: files for `@`, skills for `$`,
// and the project's own `/` commands. Every path a client names is checked to stay inside
// the folder, symbolic links included.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectCommand, Skill } from "@moonagentic/protocol";

/** Beyond this many files, the listing stops: `@` then finds only what it saw. */
export const MAX_FILES = 20_000;
const LISTING_TTL_MS = 10_000;
/** Folders a walk skips when the folder is not a git repository. */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
]);
const MAX_DEPTH = 12;

const listings = new Map<string, { at: number; files: Promise<string[]> }>();

/** The folder's files, relative and with `/` separators, ignored ones left out. */
export function listFiles(dir: string): Promise<string[]> {
  const cached = listings.get(dir);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files;
  const files = gitFiles(dir).catch(() => walk(dir));
  listings.set(dir, { at: Date.now(), files });
  files.catch(() => listings.delete(dir));
  return files;
}

function gitFiles(dir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        const files = stdout.split("\0").filter(Boolean);
        resolve(files.slice(0, MAX_FILES));
      },
    );
  });
}

function walk(dir: string): string[] {
  const files: string[] = [];
  const visit = (rel: string, depth: number) => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) visit(child, depth + 1);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit("", 0);
  return files;
}

/** Ranks files for what was typed after `@`: the file's own name first, then its path. */
export function searchFiles(files: string[], query: string, limit = 30): string[] {
  const q = query.trim().toLowerCase().replaceAll("\\", "/");
  if (!q) {
    // Nothing typed yet: the shallowest files, which are the project's main ones.
    return files
      .slice()
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, limit);
  }
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else if (subsequence(q, lower)) score = 4;
    else continue;
    scored.push({ file, score: score * 10_000 + file.length });
  }
  scored.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

const subsequence = (needle: string, hay: string) => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
};

/**
 * The absolute path of a file named relative to `dir`, or undefined when it is not a file
 * inside `dir`: no absolute path, no `..`, and no symbolic link leading outside.
 */
export function resolveInside(dir: string, rel: string): string | undefined {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return undefined;
  }
  if (rel.split(/[\\/]/).some((part) => part === "..")) return undefined;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(path.resolve(dir, rel));
    const inside = path.relative(root, real);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** `@path` written in a message: after a space or at the start, up to the next space. */
const MENTION = /(?<=^|[\s(])@([^\s@]+)/g;
/** `$name` written in a message, in the same way. */
const SKILL_CALL = /(?<=^|[\s(])\$([A-Za-z0-9][\w.:-]*)/g;
const MAX_MENTIONS = 20;

/** The files a message mentions with `@`, as found in `dir`. */
export function mentionedFiles(text: string, dir: string): { rel: string; abs: string }[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(MENTION)) {
    if (found.size >= MAX_MENTIONS) break;
    const raw = match[1] ?? "";
    // A sentence may end right after the path.
    for (const rel of [raw, raw.replace(/[.,;:!?)\]'"»]+$/, "")]) {
      const abs = rel && resolveInside(dir, rel);
      if (abs) {
        found.set(rel.replaceAll("\\", "/"), abs);
        break;
      }
    }
  }
  return [...found].map(([rel, abs]) => ({ rel, abs }));
}

/** The skills a message calls with `$`, among those offered. */
export function calledSkills<T extends { name: string }>(text: string, skills: T[]): T[] {
  // A sentence may end right after the name.
  const names = new Set(
    [...text.matchAll(SKILL_CALL)].map((m) => (m[1] ?? "").replace(/[.:-]+$/, "").toLowerCase()),
  );
  return skills.filter((s) => names.has(s.name.toLowerCase())).slice(0, MAX_MENTIONS);
}

/** Reads the `key: value` lines between the `---` fences at the top of a Markdown file. */
export function frontMatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field?.[1]) continue;
    fields[field[1].toLowerCase()] = (field[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: source.slice(match[0].length) };
}

export interface SkillRecord extends Skill {
  /** Absolute path of its `SKILL.md`. */
  file: string;
}

/** Where agents keep skills, inside a project or a home folder. */
const SKILL_ROOTS = [".claude/skills", ".agents/skills", ".codex/skills"];
const MAX_SKILL_FILE = 256 * 1024;

/** Skills found in the project and in the user's home folder; the project's win on a name. */
export function findSkills(dir: string, home: string): SkillRecord[] {
  const byName = new Map<string, SkillRecord>();
  const scan = (base: string, scope: Skill["scope"]) => {
    for (const root of SKILL_ROOTS) {
      let entries;
      try {
        entries = readdirSync(path.join(base, root), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const file = path.join(base, root, entry.name, "SKILL.md");
        let source: string;
        try {
          if (statSync(file).size > MAX_SKILL_FILE) continue;
          source = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const { fields, body } = frontMatter(source);
        const name = (fields.name || entry.name).trim();
        if (!/^[A-Za-z0-9][\w.:-]*$/.test(name) || byName.has(name.toLowerCase())) continue;
        byName.set(name.toLowerCase(), {
          name,
          description: fields.description || firstLine(body),
          scope,
          path: path.relative(base, file).replaceAll("\\", "/"),
          file,
        });
      }
    }
  };
  scan(dir, "project");
  if (path.resolve(home) !== path.resolve(dir)) scan(home, "user");
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const firstLine = (body: string) =>
  (body.split(/\r?\n/).find((l) => l.trim()) ?? "")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 200);

const COMMANDS_DIR = ".moonagentic/commands";

/** The project's own commands: one Markdown file each, named after the command. */
export function findProjectCommands(dir: string): ProjectCommand[] {
  let entries;
  try {
    entries = readdirSync(path.join(dir, COMMANDS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry): ProjectCommand[] => {
      const name = entry.name.replace(/\.md$/i, "").toLowerCase();
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return [];
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return [];
      try {
        const source = readFileSync(path.join(dir, COMMANDS_DIR, entry.name), "utf8");
        if (source.length > MAX_SKILL_FILE) return [];
        const { fields, body } = frontMatter(source);
        const template = body.trim();
        if (!template) return [];
        return [{ name, description: fields.description || firstLine(template), template }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Content blocks sent along with a message, for the files and skills it points at. */
export type PromptLink =
  | { type: "resource_link"; uri: string; name: string; description?: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };

const MAX_EMBED = 100 * 1024;

/**
 * What the agent receives for each file or skill: the file's text itself when the agent
 * accepts embedded context and the file is small text, a link to it otherwise.
 */
export function promptLinks(
  targets: { abs: string; name: string; description?: string }[],
  embed: boolean,
): PromptLink[] {
  return targets.map(({ abs, name, description }) => {
    const uri = pathToFileURL(abs).href;
    if (embed) {
      try {
        if (statSync(abs).size <= MAX_EMBED) {
          const buffer = readFileSync(abs);
          if (!buffer.includes(0)) {
            return { type: "resource", resource: { uri, text: buffer.toString("utf8") } };
          }
        }
      } catch {
        // sent as a link below
      }
    }
    return { type: "resource_link", uri, name, ...(description ? { description } : {}) };
  });
}
