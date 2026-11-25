import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { firstPick, type ModelPick } from "./model-pick.ts";

/**
 * The first model of an agent that can run now whose id or name passes the test. Models are
 * only known once their agent has given its list: before that, nothing is found.
 */
export function findModel(
  agents: AgentInfo[],
  test: (text: string) => boolean,
): ModelPick | undefined {
  for (const agent of agents) {
    if (!agent.available || agent.modelsError) continue;
    const model = agent.models?.find((m) => test(m.id) || test(m.name));
    if (model) return { agentId: agent.id, model: model.id };
  }
  return undefined;
}

/** Antigravity's « Orchestrator (Neon) », by its id or its name. */
export const isNeonOrchestrator = (text: string) => /orchestrat/i.test(text) && /neon/i.test(text);

/**
 * A project's coordinator by default: Antigravity's « Orchestrator (Neon) », made to split the
 * work and hand it out; else the first favorite, as before.
 */
export const coordinatorDefault = (
  agents: AgentInfo[],
  favorites: Favorites,
): ModelPick | undefined => findModel(agents, isNeonOrchestrator) ?? firstPick(agents, favorites);

/**
 * A conversation started outside any project is mostly a question or a web search: Gemini 4
 * Hydrogen by default, which searches with Google and costs little. Undefined when no agent
 * offers it: the composer then keeps the model last picked.
 */
export const looseDefault = (agents: AgentInfo[]): ModelPick | undefined =>
  findModel(agents, (t) => /hydrogen/i.test(t));

/**
 * True for the built-in « Discussions » folder that holds conversations outside any project:
 * named so, in a folder named so (as the server makes it), so a project of the user's that is
 * only called « Discussions » stays a project.
 */
export const isDiscussionsProject = (
  project: { name: string; path?: string } | undefined,
): boolean =>
  project?.name === "Discussions" &&
  (project.path === undefined ||
    project.path.split(/[\\/]/).filter(Boolean).pop() === "Discussions");

/**
 * True when the home composer is writing outside a code project (explicit « Nouvelle discussion »,
 * no project yet, or inside « Discussions ») and should start on Hydrogen by default.
 */
export const isLooseHome = (options: {
  routeName: string;
  loose: boolean;
  project: { name: string } | undefined;
}): boolean =>
  options.routeName === "home" &&
  (options.loose || !options.project || isDiscussionsProject(options.project));
