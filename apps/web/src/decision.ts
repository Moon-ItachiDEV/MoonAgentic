// What waits on the user, as the decision card above the composer shows it: permission
// requests and questions, of the thread on screen first, then of every other thread.
import type {
  Item,
  PendingQuestion,
  PendingRequest,
  PermissionOption,
  QuestionAnswer,
  Thread,
  ToolQuestion,
} from "@moonagentic/protocol";

export type Wait =
  | {
      kind: "permission";
      id: string;
      threadId: string;
      title: string;
      options: PermissionOption[];
      at: number;
    }
  | {
      kind: "question";
      id: string;
      threadId: string;
      questions: ToolQuestion[];
      /** How the answer goes back: to the turn the agent holds, or as the next message. */
      via: "form" | "message";
      at: number;
    };

/**
 * The question the thread's agent ended its turn on with a tool of its own (Antigravity's
 * `ask_question`): it can be answered until the user writes again.
 */
export function openQuestion(
  items: Item[] | undefined,
  thread: Pick<Thread, "status" | "archived">,
): Extract<Item, { kind: "tool" }> | undefined {
  const last = items?.findLast((i) => i.kind === "user" || (i.kind === "tool" && i.questions));
  return last?.kind === "tool" && !last.form && thread.status === "idle" && !thread.archived
    ? last
    : undefined;
}

/**
 * Everything that waits on the user, the thread on screen first, then the oldest first.
 * `own` keeps to that thread: its page already lists what the others wait for.
 */
export function waits(input: {
  thread: Pick<Thread, "id" | "status" | "archived">;
  items: Item[] | undefined;
  requests: PendingRequest[];
  questions: PendingQuestion[];
  own?: boolean;
}): Wait[] {
  const { thread } = input;
  const asked = openQuestion(input.items, thread);
  const all: Wait[] = [
    ...input.requests.map((r): Wait => ({
      kind: "permission",
      id: r.itemId,
      threadId: r.threadId,
      title: r.title,
      options: r.options,
      at: r.at,
    })),
    ...input.questions.map((q): Wait => ({
      kind: "question",
      id: q.itemId,
      threadId: q.threadId,
      questions: q.questions,
      via: "form",
      at: q.at,
    })),
    ...(asked?.questions
      ? [
          {
            kind: "question",
            id: asked.id,
            threadId: thread.id,
            questions: asked.questions,
            via: "message",
            at: asked.at,
          } satisfies Wait,
        ]
      : []),
  ];
  const here = (w: Wait) => (w.threadId === thread.id ? 0 : 1);
  return all
    .filter((w) => !input.own || w.threadId === thread.id)
    .sort((a, b) => here(a) - here(b) || a.at - b.at);
}

const RECOMMENDED = /^\s*\((?:recommandé|recommended)\)\s*|\s*\((?:recommandé|recommended)\)\s*$/i;

/** An option's name, and whether the agent marked it as the one it recommends. */
export function optionLabel(option: string): { label: string; recommended: boolean } {
  const label = option.replace(RECOMMENDED, "");
  return label && label !== option
    ? { label, recommended: true }
    : { label: option, recommended: false };
}

export interface Choice {
  /** What is sent back when picked: the option's own text, or the permission option's id. */
  value: string;
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
}

const PERMISSION_NOTE: Record<PermissionOption["kind"], string> = {
  allow_once: "Cette fois seulement",
  allow_always: "Sans redemander pour ce genre d'action",
  reject_once: "L'agent ne le fait pas et continue autrement",
  reject_always: "Refusé à chaque fois, sans redemander",
};

/** A permission request's options, allowing first, each with what it does. */
export function permissionChoices(options: PermissionOption[]): Choice[] {
  const rank = (o: PermissionOption) =>
    ["allow_once", "allow_always", "reject_once", "reject_always"].indexOf(o.kind);
  return [...options]
    .sort((a, b) => rank(a) - rank(b))
    .map((o) => ({ value: o.optionId, label: o.name, description: PERMISSION_NOTE[o.kind] }));
}

/** A question's options, with what each says and shows when the agent gave it. */
export function questionChoices(question: ToolQuestion): Choice[] {
  return question.options.map((option, i) => {
    const { label, recommended } = optionLabel(option);
    const description = question.descriptions?.[i];
    const preview = question.previews?.[i];
    return {
      value: option,
      label,
      ...(description ? { description } : {}),
      ...(preview ? { preview } : {}),
      ...(recommended ? { recommended } : {}),
    };
  });
}

/** The answers as one message, for a question the agent reads from the user's next message. */
export function answerText(questions: ToolQuestion[], answers: QuestionAnswer[]): string {
  const said = (a: QuestionAnswer | undefined) =>
    [...(a?.picks ?? []), ...(a?.text?.trim() ? [a.text.trim()] : [])].join(", ");
  return questions
    .map((q, i) => (questions.length > 1 ? `${q.question} ${said(answers[i])}` : said(answers[i])))
    .join("\n");
}

/** The option that refuses a permission request once, for an answer in the user's own words. */
export const refusal = (options: PermissionOption[]) =>
  options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");

export type CardKey =
  | { do: "pick"; index: number }
  | { do: "move"; by: 1 | -1 }
  | { do: "page"; by: 1 | -1 }
  | { do: "confirm" }
  | { do: "fold" };

/**
 * What a key does on the card: 1–9 pick a row, the arrows move and turn the page, Enter
 * confirms, Escape folds. `rows` counts every row, the user's own answer included.
 */
export function cardKey(key: string, rows: number, pages: number): CardKey | undefined {
  const digit = /^[1-9]$/.test(key) ? Number(key) : 0;
  if (digit) return digit <= rows ? { do: "pick", index: digit - 1 } : undefined;
  if (key === "ArrowDown") return { do: "move", by: 1 };
  if (key === "ArrowUp") return { do: "move", by: -1 };
  if (key === "ArrowRight" && pages > 1) return { do: "page", by: 1 };
  if (key === "ArrowLeft" && pages > 1) return { do: "page", by: -1 };
  if (key === "Enter") return { do: "confirm" };
  if (key === "Escape") return { do: "fold" };
  return undefined;
}
