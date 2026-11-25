import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { routeChoices } from "./route-choices.ts";

export type ModelPick = { agentId: string; model?: string };

/**
 * The first line of the menu: the first favorite of an agent ready now, else the first
 * ready agent with its default model. What a menu starts on when nothing was picked yet.
 */
export function firstPick(agents: AgentInfo[], favorites: Favorites): ModelPick | undefined {
  const first = routeChoices(agents, favorites, undefined, false).groups[0]?.options[0];
  return first
    ? { agentId: first.agentId, ...(first.model ? { model: first.model } : {}) }
    : undefined;
}
