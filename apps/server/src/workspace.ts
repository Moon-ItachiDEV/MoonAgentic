// What the review does to a thread's own branch, beyond reading it: put a file back, look
// ahead at a merge of the branch it started from, and make that merge. The hub keeps each
// thread to one of these at a time and writes down the new start of the branch.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
import { gitFiles, MAX_FILES, resolveInside } from "./files.ts";

/** Past this size, a file of the « Fichiers » tab is not shown, only its size. */
export const MAX_READ_BYTES = 512 * 1024;

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

const LISTING_TTL_MS = 10_000;
const listings = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * The files of a thread's folder as git sees them, younger than `maxAge` if one was made.
 * Only git's: a walk of the folder would not know what `.gitignore` leaves out, such as a
 * `.env`, so a failure of git is said rather than replaced.
 */
function worktreeListing(dir: string, maxAge: number): Promise<string[]> {
  const cached = listings.get(dir);
  if (cached && Date.now() - cached.at < maxAge) return cached.files;
  const files = gitFiles(dir);
  listings.set(dir, { at: Date.now(), files });
  files.catch(() => listings.delete(dir));
  return files;
}

/**
 * Where one file of the thread's folder really is, when its listing holds it and it stays
 * inside the folder once symbolic links are followed; nothing otherwise, nor for a thread
 * without a folder of its own.
 */
export async function listedWorktreeFile(
  workspace: Workspace | undefined,
  file: string,
): Promise<string | undefined> {
  if (!workspace?.base || !existsSync(workspace.path)) return undefined;
  const files = await worktreeListing(workspace.path, LISTING_TTL_MS).catch((): string[] => []);
  return files.includes(file) ? resolveInside(workspace.path, file) : undefined;
}

/** The files of the thread's folder, listed anew: what the agent just made is in it. */
export async function worktreeFiles(
  workspace: Workspace | undefined,
): Promise<{ files: string[]; capped: boolean }> {
  const ws = started(workspace);
  const files = await worktreeListing(ws.path, 0);
  return { files, capped: files.length >= MAX_FILES };
}

/**
 * One file of the thread's folder, to read. Only a file the listing holds, and that stays
 * inside the folder once symbolic links are followed; a binary or very large one is not sent.
 */
export async function readWorktreeFile(
  workspace: Workspace | undefined,
  file: string,
): Promise<{ text?: string; binary?: boolean; size?: number }> {
  const ws = started(workspace);
  const listed = (await worktreeListing(ws.path, LISTING_TTL_MS)).includes(file);
  const real = listed ? resolveInside(ws.path, file) : undefined;
  if (!real) throw new Error("Ce fichier n'est pas dans la copie de travail.");
  const { size } = await stat(real);
  if (size > MAX_READ_BYTES) return { size };
  const bytes = await readFile(real);
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true, size };
  return { text: bytes.toString("utf8") };
}
