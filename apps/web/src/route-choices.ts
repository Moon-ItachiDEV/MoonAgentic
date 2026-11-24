import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { modelNameOf } from "./model-label.ts";

/** One line of a route menu: an agent with one of its models, or its default model. */
export type RouteOption = { value: string; agentId: string; model?: string; label: string };
/** The lines of one agent, shown under its name. */
export type RouteGroup = { agent: AgentInfo; options: RouteOption[] };

/** The value a menu line carries; a line break cannot appear in an agent or model id. */
export const routeValue = (agentId: string, model?: string) => `${agentId}\n${model ?? ""}`;

export function parseRouteValue(value: string): { agentId: string; model?: string } | undefined {
  const cut = value.indexOf("\n");
  if (cut <= 0) return undefined;
  const model = value.slice(cut + 1);
  return { agentId: value.slice(0, cut), ...(model ? { model } : {}) };
}

/**
 * The lines of the single agent + model menu of a coordinator route. With favorites, only
 * the favorites of the agents that can run now (one pick instead of an agent then a model);
 * without any, or once « Tous les modèles » is asked for, every model of those agents. The
 * current route is always kept, even when it is not a favorite or its agent is gone, so the
 * menu shows it and it can be changed.
 */
export function routeChoices(
  agents: AgentInfo[],
  favorites: Favorites,
  route: { agentId: string; model?: string } | undefined,
  showAll: boolean,
): { groups: RouteGroup[]; favoritesOnly: boolean } {
  const ready = agents.filter((a) => a.available);
  const favoriteLines = (agent: AgentInfo) =>
    (favorites[agent.id] ?? [])
      // A favorite the agent no longer offers is left out once its list is known.
      .filter((m) => !agent.models || agent.models.some((x) => x.id === m))
      .map((m) => line(agent, m));
  const favoritesOnly = !showAll && ready.some((a) => favoriteLines(a).length > 0);

  const groups: RouteGroup[] = ready
    .map((agent) => ({
      agent,
      options: favoritesOnly
        ? favoriteLines(agent)
        : agent.models?.length
          ? [line(agent), ...agent.models.map((m) => line(agent, m.id))]
          : [line(agent)],
    }))
    .filter((g) => g.options.length > 0);

  if (route) {
    const value = routeValue(route.agentId, route.model);
    const shown = groups.some((g) => g.options.some((o) => o.value === value));
    if (!shown) {
      const agent = agents.find((a) => a.id === route.agentId);
      const option = agent
        ? line(agent, route.model)
        : {
            value,
            agentId: route.agentId,
            model: route.model,
            label: route.model ?? "Modèle par défaut",
          };
      if (!agent?.available) option.label += " (indisponible)";
      const group = groups.find((g) => g.agent.id === route.agentId);
      if (group) group.options.unshift(option);
      else
        groups.unshift({
          agent: agent ?? ({ id: route.agentId, name: route.agentId } as AgentInfo),
          options: [option],
        });
    }
  }
  return { groups, favoritesOnly };
}

function line(agent: AgentInfo, model?: string): RouteOption {
  const name = modelNameOf(agent.models, model);
  return {
    value: routeValue(agent.id, model),
    agentId: agent.id,
    ...(model ? { model } : {}),
    label: name ?? "Modèle par défaut",
  };
}
