import type { AgentInfo } from "@moonagentic/protocol";

/** A mode made to split work and hand it out (« Orchestrator (Neon) »), by its id or its name. */
export const isOrchestrator = (text: string): boolean => /orchestrat/i.test(text);

/**
 * The model a thread works on when it would take its coordinator's. An orchestrator only
 * splits the work and hands it out: the thread gets the model it is named after (« Gemini 4
 * Neon » for « Orchestrator (Neon) »), else the agent's default, else its first other model.
 * Any other model is kept. When the agent's models are not known yet, the agent picks.
 */
export function workerModel(
  agent: Pick<AgentInfo, "models" | "defaultModel"> | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return model;
  const models = agent?.models;
  const own = models?.find((m) => m.id === model);
  if (!isOrchestrator(model) && !(own && isOrchestrator(own.name))) return model;
  if (!models) return undefined;
  const workers = models.filter((m) => !isOrchestrator(m.id) && !isOrchestrator(m.name));
  if (!workers.length) return model;
  const words = (name: string) =>
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}.]+/u)
      .filter(Boolean);
  const named = words(/\(([^)]+)\)/.exec(own?.name ?? "")?.[1] ?? "");
  return (
    (named.length ? workers.find((m) => named.every((w) => words(m.name).includes(w))) : undefined)
      ?.id ??
    workers.find((m) => m.id === agent?.defaultModel)?.id ??
    workers[0]!.id
  );
}
