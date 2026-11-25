// A project's threads as its page lists them: grouped by what is really going on. Pure,
// so it is easy to test.
import {
  prReady,
  THREAD_GROUPS,
  threadGroup,
  type Thread,
  type ThreadGroup,
  type RouteKind,
} from "@moonagentic/protocol";

export const GROUP_LABEL: Record<ThreadGroup, string> = {
  waiting: "En attente",
  running: "En cours",
  idle: "Inactif",
  resolved: "Résolu",
};

/**
 * The project's conversations by group, in the order the page shows them, each with the
 * latest first. A team counts once, as its lead: its members stay behind it.
 */
export function groupThreads(
  threads: Thread[],
  projectId: string,
): { group: ThreadGroup; threads: Thread[] }[] {
  const mine = threads
    .filter((t) => t.projectId === projectId && !t.parentId && t.kind !== "coordinator")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const members = membersByLead(threads);
  return THREAD_GROUPS.map((group) => ({
    group,
    threads: mine.filter((t) => threadGroup(t, members.get(t.id)) === group),
  }));
}

/** Each team's threads, by its lead. */
export function membersByLead(threads: Thread[]): Map<string, Thread[]> {
  const members = new Map<string, Thread[]>();
  for (const t of threads) {
    if (!t.parentId) continue;
    const team = members.get(t.parentId);
    if (team) team.push(t);
    else members.set(t.parentId, [t]);
  }
  return members;
}

/** How many of the project's conversations wait on the user. */
export const waitingCount = (threads: Thread[], projectId: string): number =>
  groupThreads(threads, projectId).find((g) => g.group === "waiting")?.threads.length ?? 0;

/**
 * The line under a thread's title: why it waits on the user when it does (itself, or a
 * member of the team it leads), else where its team is, else the start of what its agent last said. Nothing when nothing is known.
 */
export function threadLine(thread: Thread, members: readonly Thread[] = []): string {
  const team = thread.team;
  const pr = thread.pr;
  if (thread.archived) {
    return pr?.state === "merged" ? `PR #${pr.number} mergée.` : (thread.summary ?? "");
  }
  if (thread.held) return "En file : démarre dès qu'un autre fil du coordinateur se termine.";
  if (thread.inLine) return "En file : démarre dès qu'une place se libère sur le serveur.";
  if (thread.status === "waiting") return "Attend ta réponse.";
  const asking = members.find((m) => m.status === "waiting" && !m.archived);
  if (asking) return `« ${asking.title} » attend ta réponse.`;
  if (team?.phase === "blocked") {
    const blocked = team.tasks.find((t) => t.status === "blocked");
    return `Équipe bloquée${blocked ? ` sur « ${blocked.title} »` : ""} : à toi de décider.`;
  }
  if (team && (team.phase === "planning" || team.phase === "coding" || team.phase === "merging")) {
    if (team.phase === "planning") return "Le chef découpe la tâche.";
    const done = team.tasks.filter((t) => t.status === "done").length;
    const pieces = `${done}/${team.tasks.length} morceau${team.tasks.length > 1 ? "x" : ""} terminé${done > 1 ? "s" : ""}`;
    return team.phase === "merging"
      ? `Fusion des morceaux (${pieces}).`
      : `Équipe au travail : ${pieces}.`;
  }
  if (thread.status === "running") return thread.summary ?? "";
  if (thread.status === "error") return `Erreur : ${thread.error ?? "l'agent s'est arrêté."}`;
  if (team?.phase === "failed") return `Équipe en échec${team.error ? ` : ${team.error}` : "."}`;
  if (team?.phase === "stopped") return "Équipe arrêtée.";
  if (pr?.state === "open") {
    if (pr.conflicts) return `PR #${pr.number} : conflit avec sa branche de base.`;
    if (pr.checks === "failed") return `PR #${pr.number} : des vérifications ont échoué.`;
    if (prReady(pr)) return `PR #${pr.number} prête : il ne manque que ton merge.`;
  }
  if (team?.phase === "done") {
    const n = team.tasks.length;
    return `Équipe terminée : ${n} morceau${n > 1 ? "x" : ""} fusionné${n > 1 ? "s" : ""}.`;
  }
  return thread.summary ?? "";
}

/** What a pull request's checks say, next to its number; nothing once it is closed. */
export function checksLabel(pr: NonNullable<Thread["pr"]>): string {
  if (pr.state !== "open" && pr.state !== "draft") return "";
  return pr.checks === "pending"
    ? "vérifications en cours"
    : pr.checks === "passed"
      ? "vérifications réussies"
      : pr.checks === "failed"
        ? "vérifications en échec"
        : "";
}

/** How long ago, short enough for the end of a line. */
export function shortAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "maintenant";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} j`;
}

/** The project's coordinator, once it has one. */
export const coordinatorOf = (threads: Thread[], projectId: string): Thread | undefined =>
  threads.find((t) => t.projectId === projectId && t.kind === "coordinator");

/** The threads lists show: every one but the coordinators, which live on their project's page. */
export const listedThreads = (threads: Thread[]): Thread[] =>
  threads.some((t) => t.kind === "coordinator")
    ? threads.filter((t) => t.kind !== "coordinator")
    : threads;

/** Pinned projects first, each group in the order the server keeps. */
export const pinnedFirst = <P extends { pinned?: boolean }>(projects: readonly P[]): P[] => [
  ...projects.filter((p) => p.pinned),
  ...projects.filter((p) => !p.pinned),
];

/** The kinds of work a coordinator sends to an agent, as the user reads them. */
export const KIND_LABEL: Record<RouteKind, string> = {
  default: "Par défaut",
  question: "Question",
  bug: "Bug",
  fonctionnalite: "Fonctionnalité",
  relecture: "Relecture",
  tests: "Tests",
};
