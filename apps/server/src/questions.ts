// Some agents ask the user a question with a tool of their own rather than with a permission
// request: the tool call carries the question and its choices, stays unfinished, and the turn
// ends there; the answer is the user's next message. Antigravity's `ask_question` is one.
import type { ToolQuestion } from "@moonagentic/protocol";

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const MAX_TEXT = 500;

const MAX_PREVIEW = 2000;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";

interface Option {
  label: string;
  description: string;
  preview: string;
}

/** A question with what its options say about themselves, kept only when one says something. */
function question(question: string, given: Option[], multi: boolean): ToolQuestion[] {
  // Each option once: the same text twice could not be told apart when picked.
  const seen = new Set<string>();
  const options = given
    .filter((o) => o.label && !seen.has(o.label) && !!seen.add(o.label))
    .slice(0, MAX_OPTIONS);
  if (!question || options.length < 2) return [];
  return [
    {
      question,
      options: options.map((o) => o.label),
      ...(multi ? { multi } : {}),
      ...(options.some((o) => o.description)
        ? { descriptions: options.map((o) => o.description) }
        : {}),
      ...(options.some((o) => o.preview) ? { previews: options.map((o) => o.preview) } : {}),
    },
  ];
}

/**
 * The questions a tool call asks, read from its raw input: `questions`, each with its
 * `question` and its `options`, given as texts or as `{ label }`. Nothing else is a question.
 */
export function toolQuestions(rawInput: unknown): ToolQuestion[] | undefined {
  const list = (rawInput as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(list)) return undefined;
  const questions = list.slice(0, MAX_QUESTIONS).flatMap((entry): ToolQuestion[] => {
    const raw = entry as Record<string, unknown> | null;
    if (!Array.isArray(raw?.options)) return [];
    const options = raw.options.map((o): Option => {
      const given = (typeof o === "string" ? { label: o } : o) as Record<string, unknown> | null;
      return {
        label: text(given?.label),
        description: text(given?.description),
        preview: typeof given?.preview === "string" ? given.preview.slice(0, MAX_PREVIEW) : "",
      };
    });
    const multi = raw.is_multi_select === true || raw.multiSelect === true;
    return question(text(raw?.question), options, multi);
  });
  return questions.length ? questions : undefined;
}

/** A form's questions, and the field each one's answer goes back in. */
export interface FormQuestions {
  questions: ToolQuestion[];
  fields: { key: string; multi: boolean; custom?: string }[];
}

const PREVIEW_META = "_claude/askUserQuestionOption";

/**
 * The questions of a form an agent asks the user to fill (ACP form elicitation), when the
 * form is made of choices only: each field a pick among options, alone or several, with at
 * most a free-text companion (`<field>_custom`) for the user's own words. Claude Code asks
 * its questions this way. A form with any other kind of field is not read: nothing here
 * could show it.
 */
export function formQuestions(message: unknown, schema: unknown): FormQuestions | undefined {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const entries = Object.entries(properties as Record<string, Record<string, unknown> | null>);
  const companion = (key: string) => key.endsWith("_custom") && key.slice(0, -7) in properties;
  const asked = entries.filter(([key]) => !companion(key)).slice(0, MAX_QUESTIONS);
  const form: FormQuestions = { questions: [], fields: [] };
  for (const [key, field] of asked) {
    const multi = field?.type === "array";
    const list = multi ? (field.items as { anyOf?: unknown } | null)?.anyOf : field?.oneOf;
    if (!Array.isArray(list)) return undefined;
    const options = list.map((o): Option => {
      const given = o as Record<string, unknown> | null;
      const meta = (given?._meta as Record<string, { preview?: unknown }> | null)?.[PREVIEW_META];
      return {
        // The value sent back is the option's `const`: only options named by it can be picked.
        label: typeof given?.const === "string" ? text(given.const) : "",
        description: text(given?.description),
        preview: typeof meta?.preview === "string" ? meta.preview.slice(0, MAX_PREVIEW) : "",
      };
    });
    // A lone question is carried by the form's message; several each carry their own.
    const asks = text(field?.description) || (asked.length === 1 ? text(message) : "");
    const [read] = question(asks || text(field?.title), options, multi);
    if (!read) return undefined;
    const custom = `${key}_custom`;
    const free = (properties as Record<string, { type?: unknown } | null>)[custom];
    form.questions.push(read);
    form.fields.push({ key, multi, ...(free?.type === "string" ? { custom } : {}) });
  }
  return form.questions.length ? form : undefined;
}

/** A form's content from the user's answers: each field its pick or picks, and their own words. */
export function formContent(
  form: FormQuestions,
  answers: { picks: string[]; text?: string }[],
): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {};
  form.fields.forEach((field, i) => {
    const allowed = new Set(form.questions[i]?.options);
    const picks = (answers[i]?.picks ?? []).filter((p) => allowed.has(p));
    const own = answers[i]?.text?.trim() ?? "";
    if (field.multi) {
      if (picks.length) content[field.key] = picks;
    } else if (picks[0] !== undefined) content[field.key] = picks[0];
    if (!own) return;
    // No field for the user's own words: they go where a pick would, alone.
    if (field.custom) content[field.custom] = own;
    else if (!picks.length) content[field.key] = field.multi ? [own] : own;
  });
  return content;
}
