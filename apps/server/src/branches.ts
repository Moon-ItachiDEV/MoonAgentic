// « Nettoyer les branches »: the `moon/*` branches MoonAgentic made for threads pile up in the
// project's repository once their work is merged. This lists them, and deletes the merged
// ones the user picked, each looked at again just before it goes.
import type { MoonBranch } from "@moonagentic/protocol";
import {
  checkedOutBranches,
  commitsAhead,
  currentBranch,
  deleteBranch,
  mergedInto,
  moonBranchRefs,
  syncTarget,
} from "./git.ts";

/** A thread that has a branch of its own, as the listing needs it. */
export interface BranchOwner {
  id: string;
  title: string;
  archived?: boolean;
  locked?: boolean;
  branch: string;
}

/** How many branches are looked at together: each one costs a few git commands. */
const AT_ONCE = 8;

async function eachAtMost<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * What the branches are compared with: the branch the project's folder is on, and its copy on
 * the remote when that one is ahead (a pull request merged on GitHub).
 */
async function targetsOf(dir: string): Promise<string[]> {
  const branch = await currentBranch(dir);
  if (!branch) return ["HEAD"];
  return [...new Set([branch, await syncTarget(dir, branch)])];
}

const ORDER: Record<MoonBranch["state"], number> = { merged: 0, unmerged: 1, inUse: 2 };

/**
 * Every `moon/*` branch of the repository, merged ones first. A branch is in use while a
 * worktree has it, or a thread not in the archive works on it: it would come back without
 * its commits otherwise. An archived thread's files come back from its archive.
 */
export async function projectBranches(
  dir: string,
  owners: BranchOwner[],
): Promise<{ targets: string[]; branches: MoonBranch[] }> {
  const [targets, refs, checkedOut] = await Promise.all([
    targetsOf(dir),
    moonBranchRefs(dir),
    checkedOutBranches(dir),
  ]);
  const lockedBranches = new Set(owners.filter((o) => o.locked).map((o) => o.branch));
  const visibleRefs = refs.filter((ref) => !lockedBranches.has(ref.name));
  const branches = await eachAtMost(visibleRefs, AT_ONCE, async (ref): Promise<MoonBranch> => {
    const owner = owners.find((o) => o.branch === ref.name);
    const thread = owner && {
      id: owner.id,
      title: owner.title,
      ...(owner.archived ? { archived: true } : {}),
    };
    const base = { name: ref.name, at: ref.at, ...(thread ? { thread } : {}) };
    let merged = false;
    for (const target of targets) {
      if (await mergedInto(dir, ref.name, target)) {
        merged = true;
        break;
      }
    }
    const ahead = merged ? 0 : await commitsAhead(dir, ref.name, targets.at(-1)!);
    const inUse = checkedOut.has(ref.name) || (!!owner && !owner.archived);
    return { ...base, state: inUse ? "inUse" : merged ? "merged" : "unmerged", ahead };
  });
  branches.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.at - a.at);
  return { targets, branches };
}

/**
 * Deletes the branches named, each only when the listing made now still has it merged and
 * unused: the page's list may be minutes old, and a name it sends is never trusted alone.
 */
export async function deleteMergedBranches(
  dir: string,
  owners: BranchOwner[],
  names: string[],
  /**
   * The last commit of each branch whose pull request GitHub merged: a branch still on it is
   * merged even when the project's folder has not fetched that merge yet.
   */
  mergedHeads: Record<string, string> = {},
): Promise<{ deleted: string[]; kept: { name: string; reason: string }[] }> {
  const [{ branches }, refs] = await Promise.all([
    projectBranches(dir, owners),
    Object.keys(mergedHeads).length ? moonBranchRefs(dir) : Promise.resolve([]),
  ]);
  const mergedOnGithub = (name: string) =>
    !!mergedHeads[name] && refs.some((r) => r.name === name && r.commit === mergedHeads[name]);
  const deleted: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const name of new Set(names)) {
    const branch = branches.find((b) => b.name === name);
    if (!branch) {
      kept.push({ name, reason: "Cette branche n'existe plus." });
    } else if (branch.state === "inUse") {
      kept.push({
        name,
        reason:
          branch.thread && !branch.thread.archived
            ? "Un fil travaille encore dessus."
            : "Elle est ouverte dans un dossier de travail.",
      });
    } else if (branch.state === "unmerged" && !mergedOnGithub(name)) {
      kept.push({ name, reason: "Elle a du travail qui n'est pas fusionné." });
    } else {
      try {
        await deleteBranch(dir, name);
        deleted.push(name);
      } catch (error) {
        kept.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { deleted, kept };
}
