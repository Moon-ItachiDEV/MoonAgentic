// What the review does to a thread's own branch, beyond reading it: put a file back, look
// ahead at a merge of the branch it started from, and make that merge. The hub keeps each
// thread to one of these at a time and writes down the new start of the branch.
import { existsSync } from "node:fs";
import type { Workspace } from "@moonagentic/protocol";
import {
  currentBranch,
  type MergeForecast,
  mergeForecast,
  mergedBase,
  rejectFile,
  reviewChanges,
  syncTarget,
  syncWithBranch,
} from "./git.ts";

type Started = Workspace & { base: string };

function started(workspace: Workspace | undefined): Started {
  if (!workspace?.base)
    throw new Error("Ce fil travaille dans le dossier du projet, sans branche à lui.");
  if (!existsSync(workspace.path)) throw new Error("La copie de travail de ce fil n'est plus là.");
  return workspace as Started;
}

async function onItsBranch(workspace: Started) {
  const current = await currentBranch(workspace.path);
  if (current !== workspace.branch) {
    throw new Error(
      `La copie de travail n'est plus sur la branche ${workspace.branch}` +
        (current ? ` mais sur ${current}.` : " (HEAD détachée).") +
        " Reviens sur la branche du fil d'abord.",
    );
  }
}

/**
 * Drops the changes to one file of the review. Only a file the review lists now: a path the
 * page sends is never trusted to stay inside the folder on its own.
 */
export async function rejectReviewFile(
  workspace: Workspace | undefined,
  file: string,
  from?: string,
): Promise<void> {
  const ws = started(workspace);
  await onItsBranch(ws);
  const { files } = await reviewChanges(ws.path, ws.base);
  const listed = files.find((f) => f.path === file);
  if (!listed) throw new Error("Ce fichier n'a plus de changement à annuler.");
  if (from !== undefined && listed.from !== from) {
    throw new Error("Ce fichier a changé depuis : rouvre la revue.");
  }
  await rejectFile(ws.path, ws.base, listed.path, listed.from);
}

/**
 * What merging the branch the thread started from would do now, with where the branch starts:
 * further along than `base` once that branch was merged in some other way, by the agent asked
 * to resolve conflicts for one, so the review keeps showing the thread's work alone.
 */
export async function forecastFor(
  workspace: Workspace | undefined,
): Promise<MergeForecast & { base: string }> {
  const ws = started(workspace);
  if (!ws.baseBranch) throw new Error("Ce fil ne sait pas de quelle branche il est parti.");
  const target = await syncTarget(ws.path, ws.baseBranch);
  const [forecast, base] = await Promise.all([
    mergeForecast(ws.path, target),
    mergedBase(ws.path, ws.base, target),
  ]);
  return { ...forecast, base };
}

/**
 * Merges the branch the thread started from into its own, when nothing conflicts. Returns
 * the new start of the branch, so the review keeps showing the thread's work alone; the
 * same start when there was nothing to merge.
 */
export async function syncWorkspace(
  workspace: Workspace | undefined,
): Promise<{ base: string; target: string; merged: number }> {
  const ws = started(workspace);
  await onItsBranch(ws);
  const forecast = await forecastFor(ws);
  if (!forecast.behind) return { base: forecast.base, target: forecast.target, merged: 0 };
  if (forecast.conflicts.length) {
    const n = forecast.conflicts.length;
    throw new Error(
      `La fusion de ${forecast.target} bloquerait sur ${n} ${n > 1 ? "fichiers" : "fichier"} : ` +
        "demande à l'agent de la faire.",
    );
  }
  const base = await syncWithBranch(ws.path, forecast.target, `Fusion de ${forecast.target}`);
  return { base, target: forecast.target, merged: forecast.behind };
}
