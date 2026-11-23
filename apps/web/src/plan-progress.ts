import type { PlanEntry } from "@moonagentic/protocol";

/** How far the agent is in its own plan: steps done out of all, and whether all are. */
export function planProgress(entries: PlanEntry[]): { done: number; total: number; over: boolean } {
  const done = entries.filter((e) => e.status === "completed").length;
  return { done, total: entries.length, over: entries.length > 0 && done === entries.length };
}

/**
 * How long the agent has spent on its plan: from the first step it started to the last it
 * finished, or to `now` while it works. Undefined when the server saw no step start.
 */
export function planDuration(entries: PlanEntry[], now?: number): number | undefined {
  const starts = entries.flatMap((e) => (e.startedAt === undefined ? [] : [e.startedAt]));
  if (!starts.length) return undefined;
  const ends = entries.flatMap((e) => (e.endedAt === undefined ? [] : [e.endedAt]));
  const end = now ?? (ends.length ? Math.max(...ends) : undefined);
  return end === undefined ? undefined : end - Math.min(...starts);
}

/** < 0,1 s, 0,8 s, 12 s, 3 min 05 s, 1 h 02 min. */
export function duration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 0.1) return "< 0,1 s";
  if (s < 10) return `${s.toFixed(1).replace(".", ",")} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
