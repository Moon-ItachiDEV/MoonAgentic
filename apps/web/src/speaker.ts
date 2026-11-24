import type { AgentInfo, Thread } from "@moonagentic/protocol";
import { modelLabel } from "./model-label.ts";

/**
 * The name shown above an agent's answer and on its working line: the model that answers
 * (« Gemini 3 Pro »), not the program that runs it (« Antigravity »). The agent's icon
 * stays beside it. An answer from before a handoff was written by another agent, whose
 * model is not on record: that one keeps its agent's name, as does an agent whose model is
 * not known yet.
 */
export function speakerName(
  agent: Pick<AgentInfo, "id" | "name" | "models" | "defaultModel"> | undefined,
  thread: Pick<Thread, "agentId" | "model">,
): string {
  if (!agent) return "Agent retiré";
  const model = agent.id === thread.agentId ? (thread.model ?? agent.defaultModel) : undefined;
  if (!model) return agent.name;
  const choice = agent.models?.find((m) => m.id === model);
  if (!choice) return model;
  const label = modelLabel(choice);
  return label === "Par défaut" ? agent.name : label.replace(/\s*\(par défaut\)$/, "");
}
