import type { ModelChoice } from "@moonagentic/protocol";

const GENERIC_DEFAULT = /^default(?:\s*\(recommended\))?$/i;
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const CURRENTLY = /\(currently\s+([^)]+)\)/i;
const LEADING_MODEL =
  /^(?:claude\s+)?(?:opus|sonnet|haiku|fable|gemini|gpt|o\d|sol|neon|hydrogen|astra)\b[^·—\n]{0,36}$/i;
const CONTEXT_PAREN = /\s*\([^)]*context[^)]*\)/gi;

/** Pulls the concrete model name out of an English default description, when it names one. */
function concreteDefault(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const currently = CURRENTLY.exec(description)?.[1]?.replace(CONTEXT_PAREN, "").trim();
  if (currently && currently.length <= 40) return currently;
  const head = description
    .split(/\s*[·—]\s*|\s+-\s+/)[0]
    ?.replace(CONTEXT_PAREN, "")
    .trim();
  if (head && LEADING_MODEL.test(head)) return head;
  return undefined;
}

/**
 * How a model choice is shown in the interface: turns English CLI placeholders such as
 * « Default (recommended) » into French, naming the concrete model underneath when the
 * agent's description states it.
 */
export function modelLabel(choice: Pick<ModelChoice, "id" | "name" | "description">): string {
  const name = choice.name.trim();
  if (GENERIC_DEFAULT.test(name)) {
    const concrete = concreteDefault(choice.description);
    return concrete ? `${concrete} (par défaut)` : "Par défaut";
  }
  if (RECOMMENDED_SUFFIX.test(name)) {
    return name.replace(RECOMMENDED_SUFFIX, " (recommandé)");
  }
  return choice.name;
}

/** Looks up a model's display label in `models`, falling back to its raw id. */
export function modelNameOf(
  models: readonly ModelChoice[] | undefined,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  const choice = models?.find((m) => m.id === id);
  return choice ? modelLabel(choice) : id;
}
