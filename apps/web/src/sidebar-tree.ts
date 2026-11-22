// How the sidebar groups threads: by project, a team on one line. Pure, so it is easy to test.
import type { Thread } from "@moonagentic/protocol";

/** What a sidebar line shows: at work, waiting on the user, failed, or nothing. */
export type LineStatus = "running" | "waiting" | "error" | undefined;

const own = (t: Thread): LineStatus =>
  t.status === "running" || t.status === "waiting" || t.status === "error" ? t.status : undefined;
const working = (t: Thread) =>
  t.team?.phase === "planning" || t.team?.phase === "coding" || t.team?.phase === "merging";

/**
 * A line's status, a folded team's taken from all its members: waiting on the user first,
 * then at work (the team counts while it runs, between two of its agents too), then failed.
 */
export function lineStatus(thread: Thread, children: Thread[] = []): LineStatus {
  const all = [thread, ...children].map(own);
  if (all.includes("waiting")) return "waiting";
  if (all.includes("running") || working(thread)) return "running";
  return all.includes("error") ? "error" : undefined;
}

/** The threads listed under their own line: a team's members, under its lead. */
export function childrenOf(threads: Thread[]): Map<string, Thread[]> {
  const listed = new Set(threads.map((t) => t.id));
  const children = new Map<string, Thread[]>();
  for (const t of threads) {
    if (t.parentId && listed.has(t.parentId))
      children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  return children;
}

/** The conversations of each project: a team counts once, as its lead. */
export function conversationsByProject(threads: Thread[]): Map<string, Thread[]> {
  const listed = new Set(threads.map((t) => t.id));
  const byProject = new Map<string, Thread[]>();
  for (const t of threads) {
    if (t.parentId && listed.has(t.parentId)) continue;
    byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);
  }
  return byProject;
}

/**
 * Whether a project is unfolded: as the user left it, else when it is the only one (the
 * sidebar would look empty otherwise). Opening a thread unfolds its project once.
 */
export function projectOpen(saved: boolean | undefined, onlyProject: boolean): boolean {
  return saved ?? onlyProject;
}

/**
 * Whether a team's members are shown under its lead: true when the user unfolded it, or
 * when one of its threads is open and the user has not folded it during this visit.
 */
export function teamOpen(
  key: string,
  active: boolean,
  unfolded: ReadonlySet<string>,
  foldedActive: ReadonlySet<string>,
): boolean {
  return active ? !foldedActive.has(key) : unfolded.has(key);
}
