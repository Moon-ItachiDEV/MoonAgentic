import type { AgentInfo, Favorites, TeamMember } from "@moonagentic/protocol";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { AgentBadge } from "./AgentBadge.tsx";

/**
 * One menu to choose who does the work: the favorite models, grouped by agent, or every
 * model when there are none (or when `showAll`). The chosen agent's badge sits beside it.
 */
export function ModelSelect(props: {
  label: string;
  agents: AgentInfo[];
  favorites: Favorites;
  value: TeamMember | undefined;
  showAll: boolean;
  /** The line for no choice; left out, there is none. */
  none?: string;
  onChange: (member: TeamMember | undefined) => void;
  className?: string;
}) {
  const { value } = props;
  const { groups } = routeChoices(props.agents, props.favorites, value, props.showAll);
  const agent = value && props.agents.find((a) => a.id === value.agentId);
  return (
    <label className={props.className ?? "set-select set-route"}>
      {value && <AgentBadge agent={agent ?? { id: value.agentId, short: "?" }} small />}
      <select
        aria-label={props.label}
        value={value ? routeValue(value.agentId, value.model) : ""}
        onChange={(e) => props.onChange(parseRouteValue(e.target.value))}
      >
        {(props.none !== undefined || !value) && (
          <option value="">{props.none ?? "Choisir un modèle"}</option>
        )}
        {groups.map((g) => (
          <optgroup key={g.agent.id} label={g.agent.name}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
