import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";

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

/**
 * One menu to pick an agent and its model at once, as the coordinator's settings do: the
 * user's favorite models straight away, grouped by agent, or every model when there is no
 * favorite or once « Afficher tous les modèles » is pressed. Never a list of agents first.
 */
export function ModelSelect(props: {
  agents: AgentInfo[];
  /** The user's favorite models; read from the connection when not given. */
  favorites?: Favorites;
  value: ModelPick | undefined;
  onChange: (pick: ModelPick | undefined) => void;
  label: string;
  /** A first line that picks nobody, for a role the work can do without. */
  none?: string;
  /** The project the agents are asked about, to list their models. */
  projectId?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const known = useSyncExternalStore(connection.subscribe, connection.getState).favorites;
  const favorites = props.favorites ?? known;
  const { groups, favoritesOnly } = routeChoices(props.agents, favorites, props.value, showAll);
  const hasFavorites = routeChoices(props.agents, favorites, undefined, false).favoritesOnly;

  // Every model is listed: the agents that never said which they have are asked, once.
  const { agents, projectId } = props;
  useEffect(() => {
    if (favoritesOnly || !projectId) return;
    for (const a of agents) {
      if (a.available && !a.models && !a.modelsError)
        connection.send({ type: "agent.discover", agentId: a.id, projectId });
    }
  }, [favoritesOnly, agents, projectId]);

  return (
    <span className="model-select">
      <select
        aria-label={props.label}
        value={props.value ? routeValue(props.value.agentId, props.value.model) : ""}
        onChange={(e) => props.onChange(parseRouteValue(e.target.value))}
      >
        {props.none !== undefined && <option value="">{props.none}</option>}
        {/* Each line names its agent: the closed menu then says who, not only which model. */}
        {groups.flatMap((g) =>
          g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {g.agent.name} · {o.label}
            </option>
          )),
        )}
      </select>
      {hasFavorites && (
        <button
          type="button"
          className="btn quiet sm model-all"
          aria-pressed={showAll}
          onClick={() => setShowAll((on) => !on)}
        >
          {showAll ? "Seulement mes favoris" : "Afficher tous les modèles"}
        </button>
      )}
    </span>
  );
}
