// Skills installed for the agents: found in the folders each agent reads, installed from a
// GitHub repository (MoonAgentic clones it and copies the skills itself), or by a command
// the user typed and saw before it ran. One skill is one folder holding a `SKILL.md`, copied
// into the folder of each agent it is given to, in the home folder (every project) or in a
// project's folder.
import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type FoundSkill,
  type InstalledSkill,
  MAX_SETUP_FILE,
  SKILL_AGENTS,
  type SkillAgent,
  type SkillCommandPlan,
  type SkillRunEnd,
  type SkillSource,
  SKILL_REF,
} from "@moonagentic/protocol";
import { frontMatter, hermesSkillsDir } from "./files.ts";
import { shallowClone } from "./github.ts";
import { agentEnv } from "./session.ts";
import { killTree } from "./spawn.ts";

/** A refusal worth showing as it is. */
export class SkillError extends Error {}

export type SkillScope = "user" | "project";

/** A skill's folder name, the same on every system. */
const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;

/**
 * The folders each agent reads skills from, relative to the base (the home folder, or the
 * project's), absolute for Hermes. MoonAgentic installs into the first one.
 */
export function agentRoots(
  scope: SkillScope,
  agent: SkillAgent,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  switch (agent) {
    case "claude":
      return [".claude/skills"];
    case "codex":
      return [".agents/skills", ".codex/skills"];
    case "antigravity":
      return scope === "project"
        ? [".agent/skills", ".gemini/skills"]
        : [".gemini/antigravity-cli/skills", ".gemini/skills", ".gemini/config/skills"];
    case "hermes":
      // Hermes reads its own folder only: it has no skills of a project.
      return scope === "user" ? [hermesSkillsDir(env, home)] : [];
  }
}

/** Where things are, for one scope: the base folder, plus what tests change. */
export interface SkillPlace {
  scope: SkillScope;
  /** The home folder, or the project's folder. */
  base: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const rootPath = (place: SkillPlace, root: string) =>
  path.isAbsolute(root) ? root : path.join(place.base, root);

/** Whether `inner` is `outer` or inside it. */
const within = (outer: string, inner: string) => {
  const rel = path.relative(outer, inner);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

interface Copy {
  agent: SkillAgent;
  /** The folder as listed, maybe a link. */
  dir: string;
  /** Relative to the base, absolute for Hermes. */
  shown: string;
}
interface Found {
  name: string;
  description: string;
  copies: Copy[];
}

const MAX_SCAN = 500;

/** The skill a folder holds, with its `SKILL.md` read; undefined when it holds none. */
function readSkillDir(
  dir: string,
  /** A folder the `SKILL.md` must stay in, its links followed (a repository read). */
  inside?: string,
): { name?: string; description: string } | undefined {
  const file = path.join(dir, "SKILL.md");
  try {
    if (inside) {
      const real = safeReal(file);
      if (!real || !within(inside, real)) return undefined;
    }
    if (statSync(file).size > MAX_SETUP_FILE) return undefined;
    const { fields, body } = frontMatter(readFileSync(file, "utf8"));
    const first = (body.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
    const name = fields.name?.trim();
    return {
      ...(name && NAME.test(name) ? { name } : {}),
      description: (fields.description || first).slice(0, 300),
    };
  } catch {
    return undefined;
  }
}

/**
 * The skills of one scope, by name, with the agents whose folder holds a copy. A project's
 * folders may hold links: those leading out of the project are left out.
 */
export function scanSkills(place: SkillPlace): Found[] {
  const byName = new Map<string, Found>();
  const projectRoot = place.scope === "project" ? safeReal(place.base) : undefined;
  for (const agent of SKILL_AGENTS) {
    for (const root of agentRoots(place.scope, agent, place.env, place.home)) {
      const abs = rootPath(place, root);
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true }).slice(0, MAX_SCAN);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || !NAME.test(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const dir = path.join(abs, entry.name);
        if (projectRoot) {
          const real = safeReal(dir);
          if (!real || !within(projectRoot, real)) continue;
        }
        const skill = readSkillDir(dir);
        if (!skill) continue;
        const key = entry.name.toLowerCase();
        const found = byName.get(key) ?? { name: entry.name, description: "", copies: [] };
        if (!found.description) found.description = skill.description;
        const shown = path.isAbsolute(root) ? dir : `${root}/${entry.name}`;
        found.copies.push({ agent, dir, shown });
        byName.set(key, found);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function safeReal(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** How many files a folder holds, links not followed, up to a limit. */
function countFiles(dir: string, limit = 2000): number {
  let count = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8 || count >= limit) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else count += 1;
      if (count >= limit) return;
    }
  };
  walk(dir, 0);
  return count;
}

/** What MoonAgentic knows of the skills it installed: where they came from, and when. */
export interface SkillRecord {
  name: string;
  projectId?: string;
  source: SkillSource;
  installedAt: number;
}

/** The records, kept in one JSON file of MoonAgentic's data folder (in memory without one). */
export class SkillRecords {
  private records: SkillRecord[] = [];
  private readonly file: string | undefined;
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) this.records = parsed as SkillRecord[];
    } catch {
      // none yet
    }
  }
  private key = (name: string, projectId?: string) => `${projectId ?? ""}\0${name.toLowerCase()}`;
  get(name: string, projectId?: string): SkillRecord | undefined {
    const k = this.key(name, projectId);
    return this.records.find((r) => this.key(r.name, r.projectId) === k);
  }
  set(record: SkillRecord): void {
    this.drop(record.name, record.projectId);
    this.records.push(record);
    this.save();
  }
  drop(name: string, projectId?: string): void {
    const k = this.key(name, projectId);
    const before = this.records.length;
    this.records = this.records.filter((r) => this.key(r.name, r.projectId) !== k);
    if (this.records.length !== before) this.save();
  }
  private save(): void {
    if (!this.file) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.records, null, 1));
    renameSync(temp, this.file);
  }
}

/** The installed skills of one scope, as the page shows them. */
export function listSkills(
  place: SkillPlace,
  records: SkillRecords,
  projectId?: string,
): InstalledSkill[] {
  return scanSkills(place).map((s) => {
    const record = records.get(s.name, projectId);
    return {
      name: s.name,
      description: s.description,
      ...(projectId ? { projectId } : {}),
      agents: SKILL_AGENTS.filter((a) => s.copies.some((c) => c.agent === a)),
      paths: s.copies.map((c) => c.shown),
      files: countFiles(s.copies[0]!.dir),
      ...(record ? { source: record.source, installedAt: record.installedAt } : {}),
    };
  });
}

/** Removes one copy: a link is removed itself, never what it points at. */
function removeCopy(dir: string): void {
  if (lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
  else rmSync(dir, { recursive: true, force: true });
}

/**
 * Copies a skill's folder, without what git keeps, into `dest`, which must not exist yet.
 * A link in it is followed only while it stays in the skill's folder: one leading out of it
 * (a repository's link to `~/.ssh`…) stops the copy, and nothing is left of it.
 */
function copySkill(from: string, dest: string): void {
  const top = safeReal(from);
  if (!top) throw new SkillError(`La skill ${path.basename(from)} n'est plus là.`);
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    cpSync(top, dest, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      filter: (src) => {
        if (path.basename(src) === ".git") return false;
        if (!lstatSync(src).isSymbolicLink()) return true;
        const real = safeReal(src);
        if (real && within(top, real)) return true;
        throw new SkillError(
          `La skill ${path.basename(from)} contient un lien qui sort de son dossier (${path.relative(top, src)}) : elle n'est pas copiée.`,
        );
      },
    });
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

/** Where a new copy for this agent goes. */
function installDir(place: SkillPlace, agent: SkillAgent, name: string): string {
  const root = agentRoots(place.scope, agent, place.env, place.home)[0];
  if (!root) throw new SkillError("Hermes ne lit que ses propres skills, pas celles d'un projet.");
  return path.join(rootPath(place, root), name);
}

const usable = (place: SkillPlace, agents: readonly SkillAgent[]) =>
  agents.filter((a) => agentRoots(place.scope, a, place.env, place.home).length > 0);

function findOne(place: SkillPlace, name: string): Found {
  const found = scanSkills(place).find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new SkillError(`La skill ${name} n'est plus là.`);
  return found;
}

/** Gives a skill to these agents only: copies it into the folders it lacks, out of the others. */
export function setSkillAgents(place: SkillPlace, name: string, wanted: SkillAgent[]): void {
  const want = new Set(usable(place, wanted));
  if (want.size === 0) throw new SkillError("Garde au moins un agent.");
  const found = findOne(place, name);
  const source = found.copies[0]!.dir;
  for (const agent of want) {
    if (found.copies.some((c) => c.agent === agent)) continue;
    const dest = installDir(place, agent, found.name);
    if (existsSync(dest)) continue;
    copySkill(source, dest);
  }
  for (const copy of found.copies) {
    if (!want.has(copy.agent)) removeCopy(copy.dir);
  }
}

/** Removes a skill from every agent's folder. */
export function removeSkillEverywhere(place: SkillPlace, name: string): void {
  for (const copy of findOne(place, name).copies) removeCopy(copy.dir);
}

/** Moves a skill to another scope, for the same agents (Hermes stays out of a project). */
export function moveSkill(from: SkillPlace, to: SkillPlace, name: string): void {
  const found = findOne(from, name);
  if (scanSkills(to).some((s) => s.name.toLowerCase() === found.name.toLowerCase())) {
    throw new SkillError(`Une skill ${found.name} y est déjà.`);
  }
  const agents = usable(to, [...new Set(found.copies.map((c) => c.agent))]);
  const target = agents.length > 0 ? agents : (["claude", "codex"] as SkillAgent[]);
  for (const agent of target) copySkill(found.copies[0]!.dir, installDir(to, agent, found.name));
  for (const copy of found.copies) removeCopy(copy.dir);
}

/**
 * Reads what the user typed for a repository: `owner/name`, a github.com address (with a
 * branch and a folder: `/tree/<ref>/<path>`), a skills.sh page (`skills.sh/owner/name/skill`)
 * or an `npx skills add owner/name [--skill name]` line.
 */
export function parseSkillSource(
  input: string,
): { owner: string; name: string; ref?: string; path?: string; skill?: string } | undefined {
  let text = input.trim();
  let skill: string | undefined;
  const add = /^(?:npx|pnpm dlx|bunx)\s+(?:-y\s+)?skills(?:@\S+)?\s+add\s+(\S+)(.*)$/i.exec(text);
  if (add) {
    text = add[1]!;
    skill = /(?:--skill|-s)\s+(\S+)/.exec(add[2] ?? "")?.[1];
  }
  const sh =
    /^(?:https?:\/\/)?(?:www\.)?skills\.sh\/([^/\s]+)\/([^/\s?#]+)(?:\/([^/\s?#]+))?/i.exec(text);
  if (sh) return valid({ owner: sh[1]!, name: sh[2]!, skill: sh[3] ?? skill });
  const tree =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/([^\s?#]*))?)?\/?(?:[?#].*)?$/i.exec(
      text,
    );
  if (tree) {
    const folder = tree[4]?.replace(/\/SKILL\.md$/i, "").replace(/\/+$/, "");
    return valid({
      owner: tree[1]!,
      name: tree[2]!,
      ...(tree[3] ? { ref: tree[3] } : {}),
      ...(folder ? { path: folder } : {}),
      ...(skill ? { skill } : {}),
    });
  }
  const short = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  if (short) return valid({ owner: short[1]!, name: short[2]!, ...(skill ? { skill } : {}) });
  return undefined;
}

function valid<T extends { owner: string; name: string; ref?: string; path?: string }>(
  r: T,
): T | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(r.owner)) return undefined;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(r.name) || r.name === "." || r.name === "..")
    return undefined;
  if (r.ref !== undefined && !SKILL_REF.test(r.ref)) return undefined;
  if (r.path !== undefined && r.path.split("/").some((p) => p === ".." || p === "."))
    return undefined;
  return r;
}

/**
 * The skills a cloned repository holds (under one of its folders when given), its root
 * included. A skill is named by its `SKILL.md`, else by its folder, else after the repository.
 */
export function skillsIn(dir: string, repoName: string, under = ""): FoundSkill[] {
  const out: FoundSkill[] = [];
  const start = under ? path.join(dir, ...under.split("/")) : dir;
  const root = safeReal(dir);
  if (!root) return out;
  const walk = (d: string, rel: string, depth: number) => {
    if (out.length >= 200) return;
    const here = readSkillDir(d, root);
    if (here) {
      const folder = rel ? rel.split("/").at(-1)! : repoName;
      const name = here.name ?? (NAME.test(folder) ? folder : "skill");
      out.push({ name, description: here.description, path: rel });
      return;
    }
    if (depth >= 6) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(start, under, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Clones a repository once for a while: reading its skills, then installing them. */
export class RepoCache {
  private readonly clones = new Map<string, { dir: string; at: number }>();
  private readonly clone: (url: string, dest: string, ref?: string) => Promise<void>;
  private readonly keepMs: number;
  constructor(
    clone: (url: string, dest: string, ref?: string) => Promise<void> = shallowClone,
    keepMs = 10 * 60_000,
  ) {
    this.clone = clone;
    this.keepMs = keepMs;
  }

  async get(repo: string, ref?: string): Promise<string> {
    this.sweep();
    const key = `${repo.toLowerCase()}@${ref ?? ""}`;
    const kept = this.clones.get(key);
    if (kept && existsSync(kept.dir)) return kept.dir;
    const parent = mkdtempSync(path.join(os.tmpdir(), "moonagentic-skills-"));
    const dir = path.join(parent, "repo");
    try {
      await this.clone(`https://github.com/${repo}.git`, dir, ref);
    } catch (error) {
      rmSync(parent, { recursive: true, force: true });
      throw error;
    }
    this.clones.set(key, { dir, at: Date.now() });
    return dir;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, c] of this.clones) {
      if (now - c.at < this.keepMs) continue;
      rmSync(path.dirname(c.dir), { recursive: true, force: true });
      this.clones.delete(key);
    }
  }

  /** Drops the clone kept for a repository, so the next read clones it anew. */
  forget(repo: string, ref?: string): void {
    const key = `${repo.toLowerCase()}@${ref ?? ""}`;
    const kept = this.clones.get(key);
    if (kept) rmSync(path.dirname(kept.dir), { recursive: true, force: true });
    this.clones.delete(key);
  }

  clear(): void {
    for (const c of this.clones.values())
      rmSync(path.dirname(c.dir), { recursive: true, force: true });
    this.clones.clear();
  }
}

/** Installs skills read from a cloned repository into these agents' folders. */
export function installFromRepo(
  place: SkillPlace,
  repoDir: string,
  repoName: string,
  paths: string[],
  agents: SkillAgent[],
  options: {
    replace?: boolean;
    /** The name it is installed under, whatever its `SKILL.md` now says (an update). */
    name?: string;
  } = {},
): string[] {
  const target = usable(place, agents);
  if (target.length === 0) throw new SkillError("Choisis au moins un agent.");
  const found = skillsIn(repoDir, repoName);
  const existing = new Map(scanSkills(place).map((s) => [s.name.toLowerCase(), s]));
  const installed: string[] = [];
  for (const rel of paths) {
    const skill = found.find((f) => f.path === rel);
    if (!skill) throw new SkillError(`Pas de skill dans ${rel || "la racine du dépôt"}.`);
    const name = options.name ?? skill.name;
    const from = rel ? path.join(repoDir, ...rel.split("/")) : repoDir;
    const already = existing.get(name.toLowerCase());
    if (already && !options.replace) throw new SkillError(`La skill ${name} est déjà installée.`);
    const agentsHere = already
      ? usable(place, [...new Set(already.copies.map((c) => c.agent))])
      : target;
    const dests = (agentsHere.length > 0 ? agentsHere : target).map((agent) =>
      installDir(place, agent, name),
    );
    // Every new copy is made beside where it goes first: the copies in place are replaced
    // only once all of them are there, so a failed copy leaves the skill as it was.
    const fresh: { tmp: string; dest: string }[] = [];
    try {
      for (const dest of dests) {
        // Named with a dot first: no scan takes it for a skill while it is there.
        const tmp = path.join(
          path.dirname(dest),
          `.${path.basename(dest)}.new-${process.pid}-${Date.now()}`,
        );
        fresh.push({ tmp, dest });
        copySkill(from, tmp);
      }
    } catch (error) {
      for (const f of fresh) rmSync(f.tmp, { recursive: true, force: true });
      throw error;
    }
    if (already) for (const copy of already.copies) removeCopy(copy.dir);
    for (const f of fresh) renameSync(f.tmp, f.dest);
    installed.push(name);
  }
  return installed;
}

/** Files agents read beside their skills, watched while a command runs, relative to the base. */
const WATCHED = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude.json",
  ".mcp.json",
  ".codex/config.toml",
  ".gemini/settings.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

function stamp(file: string): string | undefined {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return undefined;
  }
}

/** What a command could change, read before it runs and again after. */
function snapshot(place: SkillPlace): {
  skills: Set<string>;
  files: Map<string, string | undefined>;
} {
  return {
    skills: new Set(scanSkills(place).map((s) => s.name)),
    files: new Map(WATCHED.map((f) => [f, stamp(path.join(place.base, f))])),
  };
}

/** The package an `npx` line starts, when it starts one. */
export function npxPackage(command: string): { name: string; version?: string } | undefined {
  const m =
    /^\s*(?:npx|pnpm\s+dlx|bunx)\s+(?:(?:-y|--yes|-p\s+\S+|--package(?:=|\s+)\S+)\s+)*(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@([\w.^~<>=*-]+))?(?:\s|$)/.exec(
      command,
    );
  if (!m) return undefined;
  return { name: m[1]!, ...(m[2] ? { version: m[2] } : {}) };
}

/** Reads the version npm would start, for a package given without one. */
export async function npmLatest(name: string, timeoutMs = 5000): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** What a command will run, before it runs. */
export async function planCommand(
  command: string,
  dir: string,
  latest: (name: string) => Promise<string | undefined> = npmLatest,
): Promise<SkillCommandPlan> {
  const pkg = npxPackage(command);
  const npm = pkg && { name: pkg.name, version: pkg.version ?? (await latest(pkg.name)) };
  return { command, dir, ...(npm ? { npm: npm.version ? npm : { name: npm.name } } : {}) };
}

// Colours, cursor moves and the like, which a terminal reads and a page does not.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const MAX_LOG = 256 * 1024;
const RUN_TIMEOUT_MS = 15 * 60_000;

interface Run {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Commands that install skills, one at a time per id: what they print is passed on as it
 * comes, a line can be typed in for a question, and they can be stopped.
 */
export class SkillRuns {
  private readonly runs = new Map<string, Run>();

  private readonly emit: (runId: string, part: { output?: string; ended?: SkillRunEnd }) => void;
  private readonly shell: (command: string) => { file: string; args: string[]; verbatim?: boolean };
  constructor(
    emit: (runId: string, part: { output?: string; ended?: SkillRunEnd }) => void,
    shell: (command: string) => { file: string; args: string[]; verbatim?: boolean } = shellFor,
  ) {
    this.emit = emit;
    this.shell = shell;
  }

  /** Starts the command in the place's folder; resolves once it started. */
  start(
    runId: string,
    command: string,
    place: SkillPlace,
    onAdded: (names: string[]) => void,
  ): void {
    if (this.runs.has(runId)) throw new SkillError("Cette commande tourne déjà.");
    if (!existsSync(place.base)) throw new SkillError(`Le dossier ${place.base} n'existe plus.`);
    const before = snapshot(place);
    const { file, args, verbatim } = this.shell(command);
    const child = spawn(file, args, {
      cwd: place.base,
      env: { ...agentEnv(), NO_COLOR: "1", FORCE_COLOR: "0", npm_config_color: "false" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: process.platform !== "win32",
    });
    let size = 0;
    const out = (chunk: Buffer) => {
      if (size >= MAX_LOG) return;
      const text = chunk
        .toString("utf8")
        .replace(ANSI, "")
        .replace(/\r(?!\n)/g, "\n");
      size += text.length;
      if (text) this.emit(runId, { output: text });
    };
    child.stdout?.on("data", out);
    child.stderr?.on("data", out);
    child.stdin?.on("error", () => {});
    let error: string | undefined;
    child.on("error", (e) => {
      error = e.message;
    });
    const timer = setTimeout(() => {
      error = "Arrêtée au bout de 15 minutes.";
      void killTree(child, "SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      this.runs.delete(runId);
      const after = snapshot(place);
      const added = [...after.skills].filter((s) => !before.skills.has(s));
      const changed = WATCHED.filter((f) => before.files.get(f) !== after.files.get(f));
      if (added.length) onAdded(added);
      this.emit(runId, { ended: { code, added, changed, ...(error ? { error } : {}) } });
    });
    this.runs.set(runId, { child, timer });
  }

  input(runId: string, text: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new SkillError("La commande est déjà terminée.");
    run.child.stdin?.write(`${text}\n`);
  }

  stop(runId: string): void {
    const run = this.runs.get(runId);
    if (run) void killTree(run.child, "SIGTERM");
  }

  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id);
  }
}

/** The shell a typed line runs in: cmd.exe on Windows, sh elsewhere. */
export function shellFor(
  command: string,
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? "cmd.exe",
): { file: string; args: string[]; verbatim?: boolean } {
  if (platform === "win32") {
    // With /s, cmd.exe drops the outer quotes and runs what is between them as typed.
    return { file: comspec, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}
