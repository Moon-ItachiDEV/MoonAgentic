import type { AgentInfo, TeamMember, TeamPreset, TeamRole } from "./index.ts";

export type { TeamPreset, TeamRole } from "./index.ts";

export const TEAM_ROLES: TeamRole[] = ["lead", "coder", "reviewer", "tester", "merger"];

/**
 * A first team to start from, until the user sets their own up in the settings: the models
 * each role would like, best first. Only a suggestion: what the user saves takes its place,
 * and a model that is not there falls back to the first agent ready.
 */
interface PresetSuggestion {
  id: string;
  label: string;
  prefer: Record<TeamRole, RegExp[]>;
}

const SUGGESTIONS: PresetSuggestion[] = [
  {
    id: "equilibree",
    label: "Équilibrée",
    prefer: {
      lead: [/fable/i],
      coder: [/opus/i],
      reviewer: [/neon/i, /gemini/i],
      tester: [/sonnet/i],
      merger: [/haiku/i],
    },
  },
  {
    id: "economique",
    label: "Économique",
    prefer: {
      lead: [/opus/i],
      coder: [/sonnet/i],
      reviewer: [/\bsol\b/i, /gpt/i],
      tester: [/hydrogen/i, /sonnet/i],
      merger: [/haiku/i],
    },
  },
  {
    id: "qualite",
    label: "Qualité max",
    prefer: {
      lead: [/fable/i],
      coder: [/fable/i, /opus/i],
      reviewer: [/neon/i, /astra/i, /gemini/i],
      tester: [/sonnet/i],
      merger: [/haiku/i],
    },
  },
  {
    id: "neon",
    label: "Neon relit et teste",
    prefer: {
      lead: [/fable/i],
      coder: [/opus/i],
      reviewer: [/neon/i, /gemini/i],
      tester: [/neon/i, /gemini/i],
      merger: [/haiku/i],
    },
  },
];

/** The suggested teams, on the agents at hand: what « Équipes » starts from. */
export function suggestedPresets(agents: AgentInfo[]): TeamPreset[] {
  return SUGGESTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    roles: Object.fromEntries(
      TEAM_ROLES.flatMap((role) => {
        const member = pickMember(agents, s.prefer[role]);
        return member ? [[role, member]] : [];
      }),
    ),
  }));
}

/** The user's teams once saved, else the suggested ones. */
export function teamPresets(saved: TeamPreset[] | undefined, agents: AgentInfo[]): TeamPreset[] {
  return saved?.length ? saved : suggestedPresets(agents);
}

/** An agent that can take a role: ready, and able to give its models. */
const usableAgents = (agents: AgentInfo[]) => agents.filter((a) => a.available && !a.modelsError);

/**
 * Who takes each role of a team on the agents at hand. A member whose agent is not ready is
 * replaced by the first agent ready for the lead and the coders, and left out otherwise; a
 * model the agent no longer offers gives way to its own default.
 */
export function presetMembers(
  preset: TeamPreset,
  agents: AgentInfo[],
): Partial<Record<TeamRole, TeamMember>> {
  const usable = usableAgents(agents);
  const members: Partial<Record<TeamRole, TeamMember>> = {};
  for (const role of TEAM_ROLES) {
    const chosen = preset.roles[role];
    const needed = role === "lead" || role === "coder";
    // Nobody, on purpose, only for a role the team can do without.
    if (chosen === null && !needed) continue;
    const agent = chosen && usable.find((a) => a.id === chosen.agentId);
    if (chosen && agent) {
      const known = !agent.models || agent.models.some((m) => m.id === chosen.model);
      members[role] = {
        agentId: agent.id,
        ...(chosen.model && known
          ? { model: chosen.model }
          : agent.defaultModel
            ? { model: agent.defaultModel }
            : {}),
      };
      continue;
    }
    if (needed) {
      const first = pickMember(agents, []);
      if (first) members[role] = first;
    }
  }
  return members;
}

/**
 * The agent and model to start a role on: the first model the role prefers that an agent
 * offers, or else the first agent ready, on its own default model.
 */
export function pickMember(agents: AgentInfo[], prefer: RegExp[]): TeamMember | undefined {
  // An agent that failed to give its models (not signed in, say) cannot take a role.
  const usable = agents.filter((a) => a.available && !a.modelsError);
  for (const pattern of prefer) {
    for (const agent of usable) {
      const model = agent.models?.find((m) => pattern.test(m.name) || pattern.test(m.id));
      if (model) return { agentId: agent.id, model: model.id };
    }
  }
  const first = usable[0];
  return (
    first && { agentId: first.id, ...(first.defaultModel ? { model: first.defaultModel } : {}) }
  );
}

/**
 * The team a coordinator starts when the user never set one up by hand: the user's first
 * team, or the first suggested one, on the agents at hand. None when no agent is ready to lead.
 */
export function defaultTeam(
  agents: AgentInfo[],
  saved?: TeamPreset[],
):
  | {
      lead: TeamMember;
      coder: TeamMember;
      reviewer?: TeamMember;
      tester?: TeamMember;
      merger?: TeamMember;
    }
  | undefined {
  const preset = teamPresets(saved, agents)[0];
  if (!preset) return undefined;
  const { lead, coder, reviewer, tester, merger } = presetMembers(preset, agents);
  if (!lead || !coder) return undefined;
  return {
    lead,
    coder,
    ...(reviewer ? { reviewer } : {}),
    ...(tester ? { tester } : {}),
    ...(merger ? { merger } : {}),
  };
}
