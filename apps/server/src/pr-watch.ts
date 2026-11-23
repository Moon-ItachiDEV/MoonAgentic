// « Corriger tout seul »: what in a pull request calls for a fix, and what the agent is told.
// Pure, so it is easy to test.
import type { PrWatch, PullRequestInfo } from "@moonagentic/protocol";

/** Something about the pull request the agent is sent to fix. */
export interface PrFix {
  /** Never acted on twice: the kind and the commit it was seen on. */
  key: string;
  kind: "ci" | "conflict";
  /** The line the thread shows. */
  text: string;
  /** What the agent is told with it, unseen. */
  context: string;
}

const MAX_LISTED = 8;

/**
 * What calls for a fix now, if anything: a conflict with its base first, as no check means
 * much before it is settled, then checks that failed once none still runs.
 */
export function prFix(pr: PullRequestInfo): PrFix | undefined {
  if (pr.state !== "open" && pr.state !== "draft") return undefined;
  if (pr.conflicts) {
    return {
      key: `conflict:${pr.head}`,
      kind: "conflict",
      text: `La pull request #${pr.number} a des conflits avec ${pr.base} : corrige-les.`,
      context: [
        `La pull request #${pr.number} (${pr.url}) de ta branche a des conflits avec ${pr.base}.`,
        `Récupère ${pr.base} (git fetch), fusionne-la dans ta branche avec git merge, résous les conflits, lance les tests du projet, puis committe.`,
        "Ne réécris pas l'historique : ni rebase, ni amend, ni push forcé. Ne pousse pas : MoonAgentic pousse ta branche à la fin de ton tour.",
      ].join("\n"),
    };
  }
  const counted = pr.checks.filter((c) => c.state !== "skipped");
  if (counted.some((c) => c.state === "pending")) return undefined;
  const failed = counted.filter((c) => c.state === "failed");
  if (!failed.length) return undefined;
  const listed = failed.slice(0, MAX_LISTED).map((c) => `- ${c.name}${c.url ? ` : ${c.url}` : ""}`);
  if (failed.length > MAX_LISTED) listed.push(`- et ${failed.length - MAX_LISTED} autres`);
  const names = failed.map((c) => c.name);
  return {
    key: `ci:${pr.head}`,
    kind: "ci",
    text:
      `La CI de la pull request #${pr.number} a échoué (${names.slice(0, 3).join(", ")}` +
      `${names.length > 3 ? "…" : ""}) : corrige-la.`,
    context: [
      `La CI de la pull request #${pr.number} (${pr.url}) a échoué sur le dernier commit de ta branche. Vérifications en échec :`,
      ...listed,
      "",
      "Lis ce qui a échoué (par exemple avec gh run view --log-failed, ou en relançant la même commande en local), trouve la vraie cause et corrige-la, puis committe.",
      "Ne désactive, ne saute ni n'affaiblis aucun test pour que ça passe. Si l'échec ne vient pas de cette branche, dis-le sans rien changer.",
      "Ne pousse pas : MoonAgentic pousse ta branche à la fin de ton tour.",
    ].join("\n"),
  };
}

/** What happens with a fix the watch would ask for: sent, held back for good, or nothing. */
export function nextFix(
  watch: PrWatch,
  pr: PullRequestInfo,
): { send: PrFix } | { exhausted: PrFix } | undefined {
  if (watch.exhausted) return undefined;
  const fix = prFix(pr);
  if (!fix || fix.key === watch.handled) return undefined;
  return watch.tries >= watch.max ? { exhausted: fix } : { send: fix };
}
