// What is worth a notification when threads change: pure, so the page and the server (for
// Web Push) say the same. Easy to test.
import type { Thread } from "./index.ts";

export interface Notice {
  /** One per thread and kind: a newer one replaces the one still on screen. */
  tag: string;
  threadId: string;
  title: string;
  body: string;
}

const TEAM_NOTICE: Partial<Record<NonNullable<Thread["team"]>["phase"], string>> = {
  done: "Équipe terminée",
  failed: "Équipe en échec",
  blocked: "Équipe bloquée : à toi de décider",
};

/**
 * The notices owed for what changed between two lists of threads: a thread that now waits
 * for the user's answer, a team that finished, failed or is stuck. Only a change counts, so
 * a thread seen for the first time says nothing, whatever its state.
 */
export function noticesFor(before: Thread[], after: Thread[]): Notice[] {
  const known = new Map(before.map((t) => [t.id, t]));
  const notices: Notice[] = [];
  for (const thread of after) {
    const was = known.get(thread.id);
    if (!was || thread.archived) continue;
    if (thread.status === "waiting" && was.status !== "waiting") {
      notices.push({
        tag: waitingTag(thread.id),
        threadId: thread.id,
        title: "Attend ta réponse",
        body: thread.title,
      });
    }
    const phase = thread.team?.phase;
    const title = phase && phase !== was.team?.phase ? TEAM_NOTICE[phase] : undefined;
    if (title) {
      notices.push({ tag: `${thread.id}:team`, threadId: thread.id, title, body: thread.title });
    }
  }
  return notices;
}

/** The tag of the notice that says a thread waits for an answer. */
export const waitingTag = (threadId: string) => `${threadId}:waiting`;

/**
 * The notices that no longer hold: a thread that was waiting has been answered, archived or
 * removed, so the notification about it has nothing left to say.
 */
export function settledTags(before: Thread[], after: Thread[]): string[] {
  const now = new Map(after.map((t) => [t.id, t]));
  return before
    .filter((was) => {
      if (was.status !== "waiting") return false;
      const thread = now.get(was.id);
      return !thread || thread.archived || thread.status !== "waiting";
    })
    .map((was) => waitingTag(was.id));
}
