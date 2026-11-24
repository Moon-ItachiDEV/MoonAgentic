import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { findModel, isNeonOrchestrator } from "./default-models.ts";

/** A model to start the favorites from, with what the app already uses it for. */
export interface FavoriteSuggestion {
  agentId: string;
  model: string;
  /** What the app picks it for by default, in the user's words. */
  roles: string[];
}

/**
 * Who the app picks by default, in the order the wheel would show them: the project
 * coordinator (`coordinatorDefault`), the « Équilibrée » team (`team-presets.ts`), then the
 * conversations started outside any project (`looseDefault`).
 */
const PICKS: { role: string; test: (text: string) => boolean }[] = [
  { role: "Coordinateur des projets", test: isNeonOrchestrator },
  { role: "Chef de l'équipe", test: (t) => /fable/i.test(t) },
  { role: "Codeur de l'équipe", test: (t) => /opus/i.test(t) },
  // Gemini 4 Neon itself, not the orchestrator named after it.
  { role: "Relecteur de l'équipe", test: (t) => /neon/i.test(t) && !/orchestrat/i.test(t) },
  { role: "Tests de l'équipe", test: (t) => /sonnet/i.test(t) },
  { role: "Fusion de l'équipe", test: (t) => /haiku/i.test(t) },
  { role: "Discussions hors projet", test: (t) => /hydrogen/i.test(t) },
];

/**
 * The models the app already picks by default, among the ones the agents said they offer:
 * nothing is suggested before an agent gave its list. Favorites already starred are left out.
 */
export function favoriteSuggestions(
  agents: AgentInfo[],
  favorites: Favorites,
): FavoriteSuggestion[] {
  const out: FavoriteSuggestion[] = [];
  for (const { role, test } of PICKS) {
    const pick = findModel(agents, test);
    if (!pick?.model || (favorites[pick.agentId] ?? []).includes(pick.model)) continue;
    const same = out.find((s) => s.agentId === pick.agentId && s.model === pick.model);
    if (same) same.roles.push(role);
    else out.push({ agentId: pick.agentId, model: pick.model, roles: [role] });
  }
  return out;
}
