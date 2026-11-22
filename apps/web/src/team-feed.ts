import type { Item, Thread } from "@moonagentic/protocol";

/** What a team's thread shows: some items as they are, the rest folded into a detail. */
export type FeedBlock =
  | { kind: "item"; index: number; clamp?: true }
  | { kind: "detail"; key: string; indices: number[] };

/** A thread of a team: its lead, or one of its members. */
export const isTeamThread = (thread: Thread) => !!thread.team || !!thread.role;

/**
 * Folds what the team's engine runs out of sight: its own messages (a brief, a fix, a
 * check), the tools and thoughts of every turn, and what an agent said before its last
 * word. What is left is what the user reads: their own messages and the answers to them,
 * each turn's last word for the team (cut short), and what waits on the user.
 * The lead's answers to the engine are its plan and its calls, which the team card shows.
 */
export function teamFeed(thread: Thread, items: Item[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  let start = 0;
  while (start < items.length) {
    let end = start + 1;
    while (end < items.length && items[end]?.kind !== "user") end++;
    const first = items[start];
    // Threads from before the mark: a team thread's first message was always the engine's.
    const byTeam = first?.kind === "user" && (!!first.byTeam || (start === 0 && !!thread.role));
    const turn = Array.from({ length: end - start }, (_, i) => start + i);
    const lastAgent = turn.findLast((i) => items[i]?.kind === "agent");
    // In order, so the thread reads as it ran: a hidden item joins the detail just before
    // it, or opens one. Turns with nothing to show thus fold into one detail.
    for (const i of turn) {
      const item = items[i]!;
      const keep =
        (item.kind === "user" && !byTeam) ||
        item.kind === "permission" ||
        item.kind === "handoff" ||
        (item.kind === "tool" && !!item.questions) ||
        (item.kind === "agent" && (!byTeam || (i === lastAgent && thread.role !== "lead")));
      const before = blocks.at(-1);
      if (keep) {
        blocks.push({
          kind: "item",
          index: i,
          ...(byTeam && item.kind === "agent" ? { clamp: true as const } : {}),
        });
      } else if (before?.kind === "detail") before.indices.push(i);
      else blocks.push({ kind: "detail", key: item.id, indices: [i] });
    }
    start = end;
  }
  return blocks;
}
