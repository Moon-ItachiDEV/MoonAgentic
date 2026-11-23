import type { AgentInfo, TeamMember, TeamRole } from "./index.ts";

export type { TeamRole } from "./index.ts";

/** A ready-made team: the models each role prefers, best first. */
export interface TeamPreset {
  id: string;
  label: string;
  /** Who does what, in a line. */
  hint: string;
  prefer: Record<TeamRole, RegExp[]>;
}

export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: "equilibree",
    label: "Équilibrée",
    hint: "Fable planifie, Opus code, Neon relit, Sonnet teste, Haiku fusionne.",
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
    hint: "Opus planifie, Sonnet code, GPT Sol relit, Hydrogen teste, Haiku fusionne.",
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
    hint: "Fable planifie et code, Neon relit, Sonnet teste, Haiku fusionne.",
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
    hint: "Fable planifie, Opus code, Neon relit et teste, Haiku fusionne.",
    prefer: {
      lead: [/fable/i],
      coder: [/opus/i],
      reviewer: [/neon/i, /gemini/i],
      tester: [/neon/i, /gemini/i],
      merger: [/haiku/i],
    },
  },
];

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
 * The team a coordinator starts when the user never set one up by hand: the first preset,
 * on the agents at hand. None when no agent is ready to lead.
 */
export function defaultTeam(agents: AgentInfo[]):
  | {
      lead: TeamMember;
      coder: TeamMember;
      reviewer?: TeamMember;
      tester?: TeamMember;
      merger?: TeamMember;
    }
  | undefined {
  const preset = TEAM_PRESETS[0]!;
  const lead = pickMember(agents, preset.prefer.lead);
  const coder = pickMember(agents, preset.prefer.coder);
  if (!lead || !coder) return undefined;
  const reviewer = pickMember(agents, preset.prefer.reviewer);
  const tester = pickMember(agents, preset.prefer.tester);
  const merger = pickMember(agents, preset.prefer.merger);
  return {
    lead,
    coder,
    ...(reviewer ? { reviewer } : {}),
    ...(tester ? { tester } : {}),
    ...(merger ? { merger } : {}),
  };
}
