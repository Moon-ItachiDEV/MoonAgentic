import type { PlanEntry } from "@moonagentic/protocol";

type Incoming = Pick<PlanEntry, "content" | "status">;

/**
 * The agent's new plan, keeping what the server saw of the old one: when each step started
 * and ended, and what the agent used on it. A step is the same when its words are, or else
 * when it sits at the same place; times are the server's own, taken as updates come.
 */
export function mergePlan(
  before: PlanEntry[] | undefined,
  next: Incoming[],
  now: number,
): PlanEntry[] {
  // Words first, for the whole plan: a step put in front of the others must not take the
  // place, and so the times and tools, of one that is only further down now.
  const used = new Set<number>();
  const same = next.map((entry) => {
    const at = before?.findIndex((b, j) => !used.has(j) && b.content === entry.content) ?? -1;
    if (at >= 0) used.add(at);
    return at;
  });
  return next.map((entry, i) => {
    let at = same[i]!;
    // Reworded where it stood: the step nobody claimed at the same place.
    if (at < 0 && before?.[i] && !used.has(i)) {
      at = i;
      used.add(i);
    }
    const old = at >= 0 ? before?.[at] : undefined;
    const startedAt = old?.startedAt ?? (entry.status === "in_progress" ? now : undefined);
    const endedAt =
      entry.status === "completed"
        ? (old?.endedAt ?? (startedAt !== undefined ? now : undefined))
        : undefined;
    return {
      content: entry.content,
      status: entry.status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(old?.tools?.length ? { tools: old.tools } : {}),
    };
  });
}

/** A tool's title in a few characters: the file it touches, or the start of its command. */
export function toolLabel(title: string): string {
  const clean = title.replace(/`/g, "").trim();
  const files = clean.match(/[^\s/\\"']+\.[A-Za-z0-9]{1,8}(?=$|[\s"':,)])/g);
  const label = files?.at(-1) ?? clean;
  return label.length > 28 ? `${label.slice(0, 27).trimEnd()}…` : label;
}

/** The plan with a tool noted on the step at work, or undefined when nothing changes. */
export function noteTool(entries: PlanEntry[], title: string): PlanEntry[] | undefined {
  const at = entries.findIndex((e) => e.status === "in_progress");
  const step = entries[at];
  if (!step) return undefined;
  const label = toolLabel(title);
  const tools = step.tools ?? [];
  if (!label || tools.includes(label) || tools.length >= 3) return undefined;
  return entries.map((e, i) => (i === at ? { ...e, tools: [...tools, label] } : e));
}
