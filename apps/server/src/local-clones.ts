import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalClone } from "@moonagentic/protocol";
import { parseGithubRepo } from "./github.ts";

/** Folders never worth looking into for a project: system, caches, dependencies. */
const SKIP = new Set([
  "node_modules",
  "AppData",
  "Library",
  "Applications",
  "Application Data",
  "OneDrive",
  "Pictures",
  "Music",
  "Videos",
  "Movies",
  "snap",
  "go",
  "venv",
  ".venv",
]);
/**
 * Hidden folders, heavy ones, and OneDrive's (« OneDrive - Société » too): reading there can
 * make Windows download files the user left in the cloud.
 */
function skipped(name: string): boolean {
  return name.startsWith(".") || SKIP.has(name) || /^OneDrive\b/i.test(name);
}

/** Enough to cover a home folder two levels down without walking a whole disk. */
const MAX_FOLDERS = 4000;

/** The `origin` remote written in a repository's `.git/config`, read without running git. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const match = inOrigin && /^url\s*=\s*(.+)$/.exec(line);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The clone in `dir`, when `dir` holds a repository of its own (not a worktree). */
async function cloneAt(dir: string): Promise<LocalClone | undefined> {
  if (!(await isDir(path.join(dir, ".git")))) return undefined;
  let config = "";
  try {
    config = await readFile(path.join(dir, ".git", "config"), "utf8");
  } catch {
    // a repository being made: its folder is still worth showing
  }
  const url = originUrl(config);
  const repo = url ? parseGithubRepo(url) : undefined;
  return {
    path: dir,
    name: path.basename(dir),
    ...(repo ? { repo: `${repo.owner}/${repo.name}` } : {}),
  };
}

const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * The git folders found in and just under each root (two levels for the first), and the
 * projects' own folders, each once. Hidden folders and the usual heavy ones are skipped, and
 * the walk stops after a few thousand folders, so it stays quick on a big disk.
 */
export async function findClones(
  roots: { dir: string; depth: number }[],
  projects: { id: string; path: string }[],
): Promise<LocalClone[]> {
  const found = new Map<string, LocalClone>();
  for (const p of projects) {
    const clone = await cloneAt(p.path);
    found.set(key(path.resolve(p.path)), {
      ...(clone ?? { path: p.path, name: path.basename(p.path) }),
      projectId: p.id,
    });
  }
  let visited = 0;
  const walk = async (dir: string, depth: number) => {
    if (visited++ > MAX_FOLDERS) return;
    const k = key(path.resolve(dir));
    if (!found.has(k)) {
      const clone = await cloneAt(dir);
      if (clone) {
        found.set(k, clone);
        return; // a repository's own folders are its business
      }
    } else return;
    if (depth <= 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipped(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth - 1);
    }
  };
  const seen = new Set<string>();
  for (const root of roots) {
    const k = key(path.resolve(root.dir));
    if (seen.has(k)) continue;
    seen.add(k);
    if (!(await isDir(root.dir))) continue;
    // The root itself is a container, never a project to offer.
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipped(entry.name)) continue;
      await walk(path.join(root.dir, entry.name), root.depth - 1);
    }
  }
  return [...found.values()];
}

/**
 * Where a new project goes: next to the last project added, or a `Projets` folder in the
 * home folder for the very first one.
 */
export function defaultParent(
  projects: { path: string; createdAt: number }[],
  home: string,
): string {
  const last = [...projects].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last) {
    const parent = path.dirname(path.resolve(last.path));
    // A project right in the home folder, or at a drive's root, says nothing of where to put more.
    if (parent !== path.resolve(last.path) && parent !== path.resolve(home)) return parent;
  }
  return path.join(home, "Projets");
}

/**
 * Where people usually keep their clones, besides the home folder itself: GitHub Desktop's and
 * Visual Studio's folders on Windows, and the usual names elsewhere.
 */
export function usualRoots(home: string): { dir: string; depth: number }[] {
  return [
    { dir: path.join(home, "Documents", "GitHub"), depth: 1 },
    { dir: path.join(home, "source", "repos"), depth: 1 },
    { dir: home, depth: 2 },
  ];
}
