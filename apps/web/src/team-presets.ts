// The teams live with the protocol: the server starts a coordinator's team from them too.
import {
  type AgentInfo,
  MAX_TEAM_PRESETS,
  presetMembers,
  suggestedPresets,
  TEAM_ROLES,
  type TeamMember,
  type TeamPreset,
  type TeamRole,
  teamPresets,
} from "@moonagentic/protocol";

export { pickMember, presetMembers, suggestedPresets, TEAM_ROLES, teamPresets };
export type { TeamPreset, TeamRole };
import { pickMember } from "@moonagentic/protocol";

export const ROLE_LABEL: Record<TeamRole, string> = {
  lead: "Chef",
  coder: "Codeurs",
  reviewer: "Relecteur",
  tester: "Testeur",
  merger: "Fusionneur",
};

/** The roles a team can do without. */
export const OPTIONAL_ROLES = new Set<TeamRole>(["reviewer", "tester", "merger"]);

/**
 * The teams with this one's roles as chosen: the user's list, or the suggested one taken as
 * a start the first time. A role set to nobody is kept as `null`.
 */
export function withRoles(
  presets: TeamPreset[],
  id: string,
  roles: Partial<Record<TeamRole, TeamMember | undefined>>,
): TeamPreset[] {
  return presets.map((p) =>
    p.id === id
      ? {
          ...p,
          roles: Object.fromEntries(TEAM_ROLES.map((role) => [role, roles[role] ?? null])),
        }
      : p,
  );
}

/** A new team at the end of the list, on these roles, under a name not taken yet. */
export function addPreset(
  presets: TeamPreset[],
  roles: TeamPreset["roles"],
  newId: string,
): TeamPreset[] {
  if (presets.length >= MAX_TEAM_PRESETS) return presets;
  const taken = new Set(presets.map((p) => p.label));
  let n = presets.length + 1;
  while (taken.has(`Équipe ${n}`)) n += 1;
  return [...presets, { id: newId, label: `Équipe ${n}`, roles }];
}

/** Who takes each role, in a line: « Chef : Fable 5.2 · Codeurs : Opus 5.5 ». */
export function presetLine(preset: TeamPreset, agents: AgentInfo[]): string {
  const members = presetMembers(preset, agents);
  return TEAM_ROLES.flatMap((role) => {
    const m = members[role];
    if (!m) return [];
    const agent = agents.find((a) => a.id === m.agentId);
    const model = m.model && (agent?.models?.find((x) => x.id === m.model)?.name ?? m.model);
    return [`${ROLE_LABEL[role]} : ${model ?? agent?.name ?? m.agentId}`];
  }).join(" · ");
}
