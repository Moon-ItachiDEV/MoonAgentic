// Some agents ask the user a question with a tool of their own rather than with a permission
// request: the tool call carries the question and its choices, stays unfinished, and the turn
// ends there; the answer is the user's next message. Antigravity's `ask_question` is one.
import type { ToolQuestion } from "@moonagentic/protocol";

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const MAX_TEXT = 500;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";

/**
 * The questions a tool call asks, read from its raw input: `questions`, each with its
 * `question` and its `options`, given as texts or as `{ label }`. Nothing else is a question.
 */
export function toolQuestions(rawInput: unknown): ToolQuestion[] | undefined {
  const list = (rawInput as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(list)) return undefined;
  const questions = list.slice(0, MAX_QUESTIONS).flatMap((entry): ToolQuestion[] => {
    const raw = entry as Record<string, unknown> | null;
    const question = text(raw?.question);
    if (!question || !Array.isArray(raw?.options)) return [];
    // Each option once: the same text twice could not be told apart when picked.
    const options = [
      ...new Set(
        raw.options
          .map((o) => text(typeof o === "string" ? o : (o as { label?: unknown } | null)?.label))
          .filter(Boolean),
      ),
    ].slice(0, MAX_OPTIONS);
    if (options.length < 2) return [];
    const multi = raw.is_multi_select === true || raw.multiSelect === true;
    return [{ question, options, ...(multi ? { multi } : {}) }];
  });
  return questions.length ? questions : undefined;
}
