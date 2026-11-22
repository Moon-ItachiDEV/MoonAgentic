// Which recent threads the sidebar lists before « Voir plus ». Pure, so it is easy to test.
import type { Thread } from "@moonagentic/protocol";

/** Recent threads shown before « Voir plus ». */
export const RECENT = 5;

/**
 * The first few recent threads, and beyond them those that must stay in sight: open, at
 * work or waiting on the user, themselves or through one of their team (a pinned member
 * counts too). `foldable` is how many « Voir plus » would add.
 */
export function recentAlwaysShown(
  recent: Thread[],
  childrenOf: Map<string, Thread[]>,
  activeThreadId: string | undefined,
): { always: Thread[]; foldable: number } {
  const active = (t: Thread) =>
    t.id === activeThreadId || t.status === "running" || t.status === "waiting";
  const keep = (t: Thread) =>
    active(t) || (childrenOf.get(t.id) ?? []).some((c) => active(c) || !!c.pinned);
  const always = recent.filter((t, i) => i < RECENT || keep(t));
  return { always, foldable: recent.length - always.length };
}
