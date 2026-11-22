// What the planner shows of a card: pure, so it is easy to test.
import type { AgentInfo, PlanStatus, PlanTask, TeamTask, Thread } from "@moonagentic/protocol";

export const PLAN_COLUMNS: { status: PlanStatus; label: string; hint: string }[] = [
  { status: "todo", label: "À faire", hint: "Le chef y dépose son plan" },
  { status: "doing", label: "En cours", hint: "" },
  { status: "report", label: "Reporté", hint: "Bloqué ou remis à plus tard" },
  { status: "test", label: "En test", hint: "Relecture et tests" },
  { status: "live", label: "Livré", hint: "" },
];

export const planLabel = (status: PlanStatus) =>
  PLAN_COLUMNS.find((c) => c.status === status)?.label ?? status;

const PIECE: Record<TeamTask["status"], string> = {
  waiting: "attend un codeur",
  running: "code",
  reviewing: "relecture",
  testing: "tests",
  lead: "le chef revoit la consigne",
  blocked: "à toi de voir",
  done: "terminée",
  failed: "échouée",
  stopped: "arrêtée",
};

/** Who works on a card and what they are really doing, from the threads themselves. */
export interface CardWork {
  /** The thread to open from the card. */
  threadId?: string;
  /** The agent at work, by name. */
  agent?: string;
  /** What it is doing, in a word or two. */
  label?: string;
  /** `live` only while a thread runs, `wait` while one asks the user. */
  tone: "live" | "wait" | "err" | "";
}

export function cardWork(card: PlanTask, threads: Thread[], agents: AgentInfo[]): CardWork {
  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  const name = (t: Thread | undefined) =>
    t ? (agents.find((a) => a.id === t.agentId)?.name ?? t.agentId) : undefined;
  const tone = (t: Thread | undefined): CardWork["tone"] =>
    t?.status === "running"
      ? "live"
      : t?.status === "waiting"
        ? "wait"
        : t?.status === "error"
          ? "err"
          : "";
  const made = (thread: Thread | undefined, label: string | undefined): CardWork => ({
    ...(thread ? { threadId: thread.id } : {}),
    ...(name(thread) ? { agent: name(thread)! } : {}),
    ...(label ? { label } : {}),
    tone: tone(thread),
  });

  if (card.team) {
    const lead = byId(card.team.leadId);
    const piece = lead?.team?.tasks[card.team.index];
    if (!lead || !piece) return { tone: "" };
    const at =
      piece.status === "reviewing"
        ? byId(piece.reviewThreadId)
        : piece.status === "testing"
          ? byId(piece.testThreadId)
          : piece.status === "lead"
            ? lead
            : byId(piece.threadId);
    const label =
      at?.status === "waiting"
        ? "attend ton accord"
        : piece.status === "done" && piece.merged
          ? "fusionnée"
          : PIECE[piece.status];
    // A piece no coder has taken yet still opens its lead's thread.
    return { ...made(at, label), threadId: (at ?? lead).id };
  }
  const thread = byId(card.threadId);
  if (!thread) return { tone: "" };
  return made(
    thread,
    thread.status === "running"
      ? "en cours"
      : thread.status === "waiting"
        ? "attend ton accord"
        : thread.status === "error"
          ? "erreur"
          : undefined,
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The day of a due date, as a date field reads and writes it. */
export function dueDay(due: number | undefined): string {
  if (!due) return "";
  const d = new Date(due);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date field's day as a due date: noon, so that no time zone moves it to the day before.
 * Null for what is not a day, or not one yet.
 */
export function dayToDue(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  // A year being typed (« 0002 ») is not a day yet.
  if (!match || Number(match[1]) < 1970) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
}

/** Late once its day is over, unless delivered. */
export const isLate = (card: PlanTask, now: number) =>
  !!card.due && card.status !== "live" && dueDay(card.due) < dueDay(now);

export const dueLabel = (due: number) =>
  new Date(due).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }).replace(".", "");
