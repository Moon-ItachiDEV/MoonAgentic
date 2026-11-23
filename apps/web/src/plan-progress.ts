import type { PlanEntry } from "@moonagentic/protocol";

/** How far the agent is in its own plan: steps done out of all, and whether all are. */
export function planProgress(entries: PlanEntry[]): { done: number; total: number; over: boolean } {
  const done = entries.filter((e) => e.status === "completed").length;
  return { done, total: entries.length, over: entries.length > 0 && done === entries.length };
}
