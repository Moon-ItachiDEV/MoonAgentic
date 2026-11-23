// How « Nettoyer les branches » words what it found and what it did.
import type { MoonBranch } from "@moonagentic/protocol";

export const branches = (n: number) => `${n} ${n > 1 ? "branches" : "branche"}`;
const commits = (n: number) => `${n} ${n > 1 ? "commits" : "commit"}`;

/** What the branches were compared with: `main`, or `main ou origin/main`. */
export const targetsLabel = (targets: string[]) => targets.join(" ou ");

/** Why a branch that is listed cannot go, or what it was made for. */
export function branchNote(branch: MoonBranch): string {
  const thread = branch.thread
    ? `« ${branch.thread.title} »${branch.thread.archived ? ", archivé" : ""}`
    : undefined;
  if (branch.state === "inUse") {
    return thread ? `Le fil ${thread} travaille dessus` : "Ouverte dans un dossier de travail";
  }
  if (branch.state === "unmerged") {
    const ahead = branch.ahead
      ? `${commits(branch.ahead)} pas fusionné${branch.ahead > 1 ? "s" : ""}`
      : "Pas fusionnée";
    return thread ? `${ahead} · fil ${thread}` : ahead;
  }
  return thread ? `Fil ${thread}` : "Aucun fil ne s'en sert";
}

/** The line after a deletion: how many went, and how many stayed. */
export function deletedLine(deleted: number, kept: number): string {
  if (!kept) return `${branches(deleted)} ${deleted > 1 ? "supprimées" : "supprimée"}.`;
  const stayed = `${branches(kept)} ${kept > 1 ? "gardées" : "gardée"}`;
  return deleted
    ? `${branches(deleted)} ${deleted > 1 ? "supprimées" : "supprimée"}, ${stayed} :`
    : `Rien n'a été supprimé, ${stayed} :`;
}
