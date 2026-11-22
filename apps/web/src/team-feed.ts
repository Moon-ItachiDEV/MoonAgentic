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
    const hidden: number[] = [];
    const shown: FeedBlock[] = [];
    for (const i of turn) {
      const item = items[i]!;
      const keep =
        (item.kind === "user" && !byTeam) ||
        item.kind === "permission" ||
        item.kind === "handoff" ||
        (item.kind === "tool" && !!item.questions) ||
        (item.kind === "agent" && (!byTeam || (i === lastAgent && thread.role !== "lead")));
      if (keep)
        shown.push({
          kind: "item",
          index: i,
          ...(byTeam && item.kind === "agent" ? { clamp: true as const } : {}),
        });
      else hidden.push(i);
    }
    // The user's own message comes first, then what was done for it.
    const lead = shown[0]?.kind === "item" && shown[0].index === start ? [shown.shift()!] : [];
    blocks.push(...lead);
    // Turns with nothing to show fold into one detail, not a detail each.
    const before = blocks.at(-1);
    if (hidden.length && before?.kind === "detail" && !lead.length) before.indices.push(...hidden);
    else if (hidden.length)
      blocks.push({ kind: "detail", key: items[hidden[0]!]!.id, indices: hidden });
    blocks.push(...shown);
    start = end;
  }
  return blocks;
}
