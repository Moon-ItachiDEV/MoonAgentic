import type { AgentInfo, Favorites } from "@moonagentic/protocol";

/** One line of the model wheel: a favorite model of an agent, or the agent's default. */
export type WheelEntry = { agent: AgentInfo; model: string | undefined; name: string };

/**
 * The lines of the wheel: every favorite of every agent that can run now, in the agents'
 * order, plus the current pick when it is not a favorite, so the wheel always shows it.
 */
export function wheelEntries(
  agents: AgentInfo[],
  favorites: Favorites,
  current: { agent: AgentInfo | undefined; model: string | undefined },
): WheelEntry[] {
  const entries: WheelEntry[] = [];
  for (const agent of agents) {
    if (!agent.available) continue;
    for (const model of favorites[agent.id] ?? []) {
      const known = agent.models?.find((m) => m.id === model);
      // A favorite the agent no longer offers is left out once the list is known.
      if (agent.models && !known) continue;
      entries.push({ agent, model, name: known?.name ?? model });
    }
  }
  const { agent, model } = current;
  if (agent && !entries.some((e) => e.agent.id === agent.id && e.model === model)) {
    const name = agent.models?.find((m) => m.id === model)?.name ?? model ?? "Modèle par défaut";
    entries.unshift({ agent, model, name });
  }
  return entries;
}

/** What tells two lines of the wheel apart. */
export const entryKey = (e: WheelEntry) => `${e.agent.id}/${e.model ?? ""}`;

/**
 * The lines the open wheel shows, from the ones it shows now and the live list. As in the
 * mockup they stay put while it is open: landing on a favorite drops the non-favorite pick
 * from the live list, and removing that line would shift every other one under the finger.
 * They change only when a new line appears (a favorite added, models learned); the next
 * opening starts from the live list.
 */
export function keepLines(kept: WheelEntry[], live: WheelEntry[]): WheelEntry[] {
  const keys = new Set(kept.map(entryKey));
  if (live.some((e) => !keys.has(entryKey(e)))) return live;
  // Same lines: take the fresh ones, so names stay current.
  const fresh = new Map(live.map((e) => [entryKey(e), e]));
  return kept.map((e) => fresh.get(entryKey(e)) ?? e);
}
