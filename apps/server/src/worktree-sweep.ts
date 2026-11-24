// Folders left in the worktrees folder that no thread holds any more: a review cut short by a
// stop, a thread whose deletion was interrupted. Nothing in the app reaches them, yet each
// is a whole copy of its project, so they would fill the disk of a server left on for months.
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeWorktree, saveCheckpoint, worktreeRepo } from "./git.ts";

/**
 * A folder this recent is left alone: a thread may be making it right now, before it is
 * written down as the thread's.
 */
export const SWEEP_MIN_AGE_MS = 60 * 60_000;

/** The ref an orphan folder's files are kept under before it goes, in its repository. */
export const orphanRef = (name: string, now: number) => `refs/moonagentic/orphans/${name}-${now}`;

/** True when the folder's `.git` file points at a repository still on disk. */
function repositoryLeft(folder: string): boolean {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(folder, ".git"), "utf8"))?.[1];
    return !!gitdir && existsSync(path.resolve(folder, gitdir.trim()));
  } catch {
    // No `.git` file at all, or a `.git` folder: a folder made by hand, not by git worktree.
    return existsSync(path.join(folder, ".git"));
  }
}

/** How a name compares on this system: Windows does not tell `A` from `a`. */
const key = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);

/**
 * Removes the folders of `dir` that `held` does not give (names of the folders threads hold,
 * asked again for each folder) and that have not changed for `minAge`. A worktree's files, uncommitted ones included, are kept
 * first in its repository under `orphanRef`, so nothing is lost; one that cannot be kept
 * stays where it is. Gives the names removed.
 */
export async function sweepWorktrees(
  dir: string,
  held: () => Iterable<string>,
  now = Date.now(),
  minAge = SWEEP_MIN_AGE_MS,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ([...held()].some((name) => key(name) === key(entry.name))) continue;
    const folder = path.join(dir, entry.name);
    try {
      if (now - (await stat(folder)).mtimeMs < minAge) continue;
      const repo = await worktreeRepo(folder);
      if (repo) {
        await saveCheckpoint(folder, orphanRef(entry.name, now));
        await removeWorktree(repo, folder);
      } else if (repositoryLeft(folder)) {
        // Its repository is there but git did not answer for it: it is kept for next time.
        continue;
      } else {
        // No repository holds it (a folder cut short while being made, or a project
        // deleted from disk): there is nothing git could keep.
        // Without blocking: an old project's copy can hold a whole node_modules.
        await rm(folder, { recursive: true, force: true, maxRetries: 3 });
      }
      removed.push(entry.name);
    } catch (error) {
      console.error(`Copie de travail orpheline laissée en place : ${folder}`, error);
    }
  }
  return removed;
}
