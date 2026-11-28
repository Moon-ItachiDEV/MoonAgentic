import {
  type AgentInfo,
  agentSettingsFor,
  type TeamMember,
  type TeamPreset,
  type TeamRole,
} from "./index.ts";

export type { TeamPreset, TeamRole } from "./index.ts";

export const TEAM_ROLES: TeamRole[] = [
  "lead",
  "coder",
  "reviewer",
  "reviewer2",
  "judge",
  "tester",
  "merger",
];

/**
 * A first team to start from, until the user sets their own up in the settings: the models
 * each role would like, best first. Only a suggestion: what the user saves takes its place,
 * and a model that is not there falls back to the first agent ready.
 */
interface PresetSuggestion {
  id: string;
  label: string;
  /** A role left out is not in the team (a second review, a judge). */
  prefer: Partial<Record<TeamRole, RegExp[]>>;
  /** How hard each role thinks, when its model lets it choose; left out, the agent's own. */
  effort?: Partial<Record<TeamRole, Level>>;
}

/** A reasoning level, whatever an agent calls it: `max` is its highest (« UltraMoon »). */
type Level = "low" | "medium" | "high" | "max";
const LEVEL_NAMES: Record<Exclude<Level, "max">, RegExp> = {
  low: /^(low|bas|faible)$/i,
  medium: /^(medium|moyen)$/i,
  high: /^(high|haut|élevé|eleve)$/i,
};

/**
 * The settings that put `member` on `level`: the agent's effort choice of that name, or its
 * highest for `max`. None while the agent has not said what it offers, or has no such level.
 */
export function effortSettings(
  agents: AgentInfo[],
  member: TeamMember,
  level: Level,
): Record<string, string> | undefined {
  const agent = agents.find((a) => a.id === member.agentId);
  const setting = agentSettingsFor(agent, member.model).find((s) => s.kind === "effort");
  if (!setting || setting.choices.length < 2) return undefined;
  const choice =
    level === "max"
      ? setting.choices.at(-1)
      : setting.choices.find(
          (c) => LEVEL_NAMES[level].test(c.id) || LEVEL_NAMES[level].test(c.name),
        );
  return choice ? { [setting.id]: choice.id } : undefined;
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
    effort: { lead: "high", coder: "high", reviewer: "high", tester: "medium", merger: "low" },
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
    effort: { lead: "medium", coder: "medium", reviewer: "medium", tester: "low", merger: "low" },
  },
  {
    id: "qualite",
    label: "Qualité max",
    prefer: {
      lead: [/fable/i],
      coder: [/fable/i, /opus/i],
      reviewer: [/neon/i, /gemini/i],
      reviewer2: [/astra/i, /\bsol\b/i, /gpt/i],
      judge: [/fable/i],
      tester: [/sonnet/i],
      merger: [/haiku/i],
    },
    effort: {
      lead: "max",
      coder: "high",
      reviewer: "high",
      reviewer2: "high",
      judge: "max",
      tester: "high",
      merger: "medium",
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
        const prefer = s.prefer[role];
        const member = prefer && pickMember(agents, prefer);
        if (!member) return [];
        const level = s.effort?.[role];
        const settings = level && effortSettings(agents, member, level);
        return [[role, settings ? { ...member, settings } : member]];
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
      const model = chosen.model && known ? chosen.model : agent.defaultModel;
      const settings = keptSettings(agent, model, chosen.settings);
      members[role] = {
        agentId: agent.id,
        ...(model ? { model } : {}),
        ...(settings ? { settings } : {}),
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
 * The settings saved for a role that its agent still offers for `model`: all of them while
 * the agent has not said yet what it offers.
 */
function keptSettings(
  agent: AgentInfo,
  model: string | undefined,
  settings: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!settings) return undefined;
  if (!agent.settings && !agent.modelSettings) return settings;
  const offered = agentSettingsFor(agent, model);
  const kept = Object.entries(settings).filter(([id, value]) =>
    offered.some((s) => s.id === id && s.choices.some((c) => c.id === value)),
  );
  return kept.length ? Object.fromEntries(kept) : undefined;
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
