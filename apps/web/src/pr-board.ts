// The side bar's « Pull requests » block: what GitHub last said of each thread's pull
// request, put in the order the user deals with them. Pure, so it is easy to test.
import type {
  PullRequestCheck,
  PullRequestInfo,
  Thread,
  ThreadPullRequest,
} from "@moonagentic/protocol";

/** What a pull request waits for, most pressing first. */
export type PrKind = "failed" | "conflict" | "blocked" | "pending" | "ready" | "draft";

export interface PrRow {
  thread: Thread;
  pr: ThreadPullRequest;
  kind: PrKind;
  /** Its place in the merge order, from 1, for a pull request that is ready. */
  order?: number;
  /** One line under its title: what it waits for, in words. */
  note: string;
  tone: "err" | "warn" | "ok" | "";
}

const RANK: Record<PrKind, number> = {
  failed: 0,
  conflict: 1,
  blocked: 2,
  pending: 3,
  ready: 4,
  draft: 5,
};

const ORDINAL = (n: number) => (n === 1 ? "En 1ʳᵉ" : `En ${n}ᵉ`);

export function prKind(pr: ThreadPullRequest): PrKind {
  if (pr.state === "draft") return "draft";
  if (pr.checks === "failed") return "failed";
  if (pr.conflicts) return "conflict";
  if (pr.blocked) return "blocked";
  if (pr.checks === "pending") return "pending";
  return "ready";
}

/** The branch a thread's pull request goes into, as its workspace knows it. */
const baseOf = (t: Thread) => t.workspace?.baseBranch ?? "main";

function note(kind: PrKind, t: Thread, order?: number): Pick<PrRow, "note" | "tone"> {
  switch (kind) {
    case "failed":
      return { note: "Échec de la CI", tone: "err" };
    case "conflict":
      return { note: `Conflits avec ${baseOf(t)}`, tone: "warn" };
    case "blocked":
      return { note: "Bloquée par les règles du dépôt", tone: "warn" };
    case "pending":
      return { note: "CI en cours", tone: "" };
    case "draft":
      return { note: "Brouillon", tone: "" };
    case "ready":
      return { note: `${ORDINAL(order ?? 1)} · prête à fusionner`, tone: "ok" };
  }
}

/**
 * The open pull requests of the threads still in the list, those that need the user first.
 * Ready ones are numbered in the order to merge them: the oldest first, since GitHub does
 * not say which one another depends on. Merged ones are only counted, those of today.
 */
export function prBoard(
  threads: Thread[],
  now = Date.now(),
): { rows: PrRow[]; merged: Thread[]; red: number; green: number } {
  const open = threads.filter(
    (t) => t.pr && (t.pr.state === "open" || t.pr.state === "draft") && t.kind !== "coordinator",
  );
  // A team's pull request is shown on its lead: the member that opened it is not listed twice.
  const seen = new Set<string>();
  const unique = open.filter((t) => {
    if (seen.has(t.pr!.url)) return false;
    seen.add(t.pr!.url);
    return true;
  });
  const ready = unique
    .filter((t) => prKind(t.pr!) === "ready")
    .sort((a, b) => a.pr!.number - b.pr!.number);
  const rows = unique
    .map((thread): PrRow => {
      const pr = thread.pr!;
      const kind = prKind(pr);
      const order = kind === "ready" ? ready.indexOf(thread) + 1 : undefined;
      return { thread, pr, kind, ...(order ? { order } : {}), ...note(kind, thread, order) };
    })
    .sort(
      (a, b) =>
        RANK[a.kind] - RANK[b.kind] ||
        (a.order ?? 0) - (b.order ?? 0) ||
        b.thread.updatedAt - a.thread.updatedAt,
    );
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const mergedUrls = new Set<string>();
  const merged = threads
    .filter((t) => t.pr?.state === "merged" && t.updatedAt >= midnight.getTime())
    .filter((t) => !mergedUrls.has(t.pr!.url) && !!mergedUrls.add(t.pr!.url));
  return {
    rows,
    merged,
    red: rows.filter((r) => r.kind === "failed" || r.kind === "conflict").length,
    green: ready.length,
  };
}

/** One step of a pull request's timeline, from what GitHub said of it. */
export interface PrStep {
  key: string;
  label: string;
  state: "done" | "failed" | "running" | "next" | "yours";
  /** A short word in a pill beside it. */
  tag?: { text: string; tone: "err" | "warn" | "ok" | "" };
  /** The check's page on GitHub, when it has one. */
  url?: string;
}

/**
 * The timeline of a pull request: its checks, its conflicts with the base, then the merge,
 * which waits for the user. Skipped checks are left out.
 */
export function prSteps(pr: PullRequestInfo): PrStep[] {
  const checks = pr.checks.filter((c: PullRequestCheck) => c.state !== "skipped");
  const steps: PrStep[] = checks.map((c, i) => ({
    key: `c${i}:${c.name}`,
    label: c.name,
    state: c.state === "passed" ? "done" : c.state === "failed" ? "failed" : "running",
    ...(c.state === "failed" ? { tag: { text: "Échec", tone: "err" as const } } : {}),
    ...(c.url ? { url: c.url } : {}),
  }));
  if (pr.state === "merged") {
    steps.push({ key: "merge", label: `Fusionnée dans ${pr.base}`, state: "done" });
    return steps;
  }
  if (pr.state === "closed") {
    steps.push({ key: "merge", label: "Fermée sans être fusionnée", state: "next" });
    return steps;
  }
  if (pr.conflicts) {
    steps.push({
      key: "conflicts",
      label: `Conflits avec ${pr.base}`,
      state: "failed",
      tag: { text: "À résoudre", tone: "warn" },
    });
  } else if (pr.conflicts === false) {
    steps.push({ key: "conflicts", label: `Pas de conflit avec ${pr.base}`, state: "done" });
  }
  if (pr.blocked) {
    steps.push({
      key: "rules",
      label: "Règles du dépôt",
      state: "failed",
      tag: { text: "Bloquée", tone: "warn" },
    });
  }
  steps.push({
    key: "merge",
    label: `Fusion dans ${pr.base}`,
    state: "yours",
    tag: { text: pr.state === "draft" ? "Brouillon" : "Par toi", tone: "" },
  });
  return steps;
}

/** True when nothing GitHub said keeps the pull request from being merged from here. */
export function canMerge(pr: PullRequestInfo): boolean {
  if (pr.state !== "open" || pr.conflicts || pr.blocked) return false;
  return !pr.checks.some((c) => c.state === "failed" || c.state === "pending");
}

/** What the thread's agent is asked when the CI of its pull request is red. */
export function fixCiRequest(pr: PullRequestInfo): string {
  const failed = pr.checks.filter((c) => c.state === "failed").map((c) => c.name);
  return [
    `La CI de la pull request #${pr.number} est rouge${failed.length ? ` : ${failed.join(", ")}` : ""}.`,
    "Lis les journaux des checks en échec, corrige la cause, vérifie en local puis pousse sur la même branche.",
  ].join(" ");
}

/** What the thread's agent is asked when its pull request conflicts with its base. */
export function conflictFixRequest(pr: PullRequestInfo): string {
  return `La pull request #${pr.number} a des conflits avec ${pr.base}. Intègre ${pr.base} dans ta branche, résous les conflits sans perdre de travail, vérifie que tout passe, puis pousse.`;
}
