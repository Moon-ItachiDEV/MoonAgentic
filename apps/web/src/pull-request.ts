// How a pull request is described to the user: pure, so it is easy to test.
import type { PrWatch, PullRequestCheck, PullRequestInfo } from "@moonagentic/protocol";

/** The address of a pull request on github.com, without what may follow its number. */
export function pullRequestUrl(href: string): { url: string; number: number } | undefined {
  const match =
    /^(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/(\d{1,9}))(?:[/?#].*)?$/.exec(
      href,
    );
  return match ? { url: match[1]!, number: Number(match[2]) } : undefined;
}

export const STATE_LABEL: Record<PullRequestInfo["state"], string> = {
  open: "ouverte",
  draft: "brouillon",
  merged: "mergée",
  closed: "fermée",
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** The CI of a pull request in one line, and the checks to show by name: those that failed. */
export function checksSummary(checks: PullRequestCheck[]): {
  tone: "ok" | "warn" | "err" | "none";
  label: string;
  failed: PullRequestCheck[];
} {
  const counted = checks.filter((c) => c.state !== "skipped");
  const failed = counted.filter((c) => c.state === "failed");
  const pending = counted.filter((c) => c.state === "pending");
  if (!counted.length) return { tone: "none", label: "Aucun check CI sur cette PR", failed };
  if (failed.length) {
    return {
      tone: "err",
      label:
        `CI rouge · ${plural(failed.length, "check en échec", "checks en échec")}` +
        (pending.length ? `, ${pending.length} en cours` : ""),
      failed,
    };
  }
  if (pending.length) {
    return {
      tone: "warn",
      label: `CI en cours · ${counted.length - pending.length} sur ${counted.length} terminés`,
      failed,
    };
  }
  return {
    tone: "ok",
    label: `CI verte · ${plural(counted.length, "check passé", "checks passés")}`,
    failed,
  };
}

/** Why this pull request cannot be merged from here right now, when it cannot. */
export function mergeBlocker(pr: PullRequestInfo): string | null {
  if (pr.state === "draft") return "Brouillon : marque-la prête sur GitHub pour pouvoir la merger.";
  if (pr.state !== "open") return null;
  if (pr.conflicts) return `Conflits avec ${pr.base} : à résoudre avant de merger.`;
  return null;
}

/** What the user is told before merging while something is not green. */
export function mergeWarning(pr: PullRequestInfo): string {
  const ci = checksSummary(pr.checks);
  const notes = [
    ci.tone === "err" ? "La CI est rouge." : ci.tone === "warn" ? "La CI tourne encore." : "",
    pr.blocked ? "Les règles du dépôt bloquent ce merge : GitHub le refusera sans doute." : "",
    pr.conflicts === null ? "GitHub n'a pas fini de vérifier les conflits." : "",
  ].filter(Boolean);
  return [`« ${pr.title} » sera mergée dans ${pr.base}.`, ...notes].join(" ");
}

/** What « Corriger tout seul » says of itself: what it does, or where it stands. */
export function watchLabel(watch: PrWatch | undefined, max: number): string {
  if (!watch) {
    return `CI en échec ou conflit : l'agent corrige et MoonAgentic pousse la correction, ${max} fois au plus.`;
  }
  if (watch.exhausted) {
    return `${watch.max} corrections envoyées sans que ça passe : la suite est à toi.`;
  }
  if (!watch.tries)
    return `Surveillée : l'agent corrigera la CI ou les conflits, ${watch.max} fois au plus.`;
  const what = watch.last === "conflict" ? "conflits" : "CI";
  return `${watch.tries} correction${watch.tries > 1 ? "s" : ""} sur ${watch.max} (dernière : ${what}).`;
}
