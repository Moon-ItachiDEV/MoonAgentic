// What the server reads back from its own settings, checked before it is relied on. The app
// writes none of the shapes refused here: they come from a damaged file or an edit by hand,
// and stopped the start, or every screen that connected, until they were left out.
import type {
  AgentSetting,
  CoordinatorSettings,
  ModelChoice,
  TeamMember,
  TeamPreset,
  TeamSetup,
} from "@moonagentic/protocol";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalText = (value: unknown): boolean => value === undefined || isText(value);

export const isModelChoice = (value: unknown): value is ModelChoice =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  (value.description === undefined || value.description === null || isText(value.description));

export const isAgentSetting = (value: unknown): value is AgentSetting =>
  isRecord(value) &&
  isText(value.id) &&
  (value.kind === "mode" || value.kind === "effort") &&
  isText(value.current) &&
  Array.isArray(value.choices) &&
  value.choices.every(isModelChoice);

export const isTeamMember = (value: unknown): value is TeamMember =>
  isRecord(value) && isText(value.agentId) && isOptionalText(value.model);

const isMemberOrNone = (value: unknown): boolean =>
  value === undefined || value === null || isTeamMember(value);

export const isTeamPreset = (value: unknown): value is TeamPreset =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.label) &&
  isRecord(value.roles) &&
  (value.roles.lead === undefined || isTeamMember(value.roles.lead)) &&
  (value.roles.coder === undefined || isTeamMember(value.roles.coder)) &&
  isMemberOrNone(value.roles.reviewer) &&
  isMemberOrNone(value.roles.tester) &&
  isMemberOrNone(value.roles.merger);

const isTeamSetup = (value: unknown): value is TeamSetup =>
  isRecord(value) &&
  isTeamMember(value.lead) &&
  isTeamMember(value.coder) &&
  (value.reviewer === undefined || isTeamMember(value.reviewer)) &&
  (value.tester === undefined || isTeamMember(value.tester)) &&
  (value.merger === undefined || isTeamMember(value.merger)) &&
  typeof value.coders === "number" &&
  Number.isFinite(value.coders) &&
  isText(value.permissionMode) &&
  (value.autoShip === undefined || typeof value.autoShip === "boolean");

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** How coordinators route work, without what does not read as it should. */
export function coordinatorSettingsOf(saved: unknown): CoordinatorSettings {
  if (!isRecord(saved)) return { routes: {} };
  const routes = isRecord(saved.routes)
    ? Object.fromEntries(Object.entries(saved.routes).filter(([, member]) => isTeamMember(member)))
    : {};
  return {
    routes,
    ...(isTeamSetup(saved.team) ? { team: saved.team } : {}),
    ...(Array.isArray(saved.review) && saved.review.every(isMemberOrNone)
      ? { review: saved.review as (TeamMember | null)[] }
      : {}),
    ...(saved.reviewJudge === null || isTeamMember(saved.reviewJudge)
      ? { reviewJudge: saved.reviewJudge }
      : {}),
    ...(isCount(saved.parallel) ? { parallel: saved.parallel } : {}),
    ...(isCount(saved.maxTurns) ? { maxTurns: saved.maxTurns } : {}),
  };
}
