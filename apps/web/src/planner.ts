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
  judging: "arbitrage",
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

/** The thread a card follows: its column is then that thread's real state, not the user's choice. */
export const followedThread = (card: PlanTask, threads: Thread[]): Thread | undefined =>
  card.team || !card.threadId ? undefined : threads.find((t) => t.id === card.threadId);

/** True for a card whose work can be started from the board: the user's own, with no thread yet. */
export const canRun = (card: PlanTask, threads: Thread[]): boolean =>
  !card.team && !followedThread(card, threads);

/**
 * The threads a card can be linked to: those of its project that are not resolved, a
 * team's members aside, as they are reached through their own cards. The one it is linked
 * to now is always among them, resolved or not: it is how the card is unlinked.
 */
export const linkableThreads = (card: PlanTask, threads: Thread[]): Thread[] =>
  threads.filter(
    (t) =>
      t.projectId === card.projectId && (t.id === card.threadId || (!t.archived && !t.parentId)),
  );

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

export const DAY = 86_400_000;
const dayStart = (at: number) => new Date(at).setHours(0, 0, 0, 0);
/**
 * Midnight `days` days after the day of `at`, counted on the calendar: a day is 23 or 25
 * hours long when the clocks change.
 */
const addDays = (at: number, days: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
};
/** The timeline never shows more than this many days before or after today. */
export const TIMELINE_REACH = 366;

/**
 * The days a card covers on the timeline. Real dates come first: from when its work began
 * to when it was delivered, or to today while it goes on. A card not started shows what is
 * planned, from its start day to its due day. `planned` is true for those.
 */
export function cardSpan(
  card: PlanTask,
  now: number,
): { from: number; to: number; planned: boolean } {
  const from = dayStart(card.startedAt ?? card.start ?? card.createdAt);
  const due = card.due ? addDays(card.due, 1) : undefined;
  const planned = card.status === "todo" || !card.startedAt;
  const end = card.doneAt
    ? card.doneAt
    : planned
      ? (due ?? addDays(from, 1))
      : // Work that goes on runs to today, past its due day when it is late.
        Math.max(due ?? 0, now);
  return { from, to: Math.max(addDays(end - 1, 1), addDays(from, 1)), planned };
}

export interface TimelineBar {
  card: PlanTask;
  work: CardWork;
  /** Days from the timeline's first day. */
  day: number;
  days: number;
  /** Its line in the lane: bars that overlap sit on different lines. */
  row: number;
  planned: boolean;
  /** Too short to hold its title, which is then written after it. */
  tight: boolean;
}

export interface TimelineLane {
  /** The agent at work on these cards, or "" for cards no agent has. */
  name: string;
  rows: number;
  bars: TimelineBar[];
}

export interface Timeline {
  /** Midnight of the first day shown. */
  from: number;
  days: number;
  /** Today, in days from the first. */
  today: number;
  lanes: TimelineLane[];
}

/** A bar under this width cannot hold its title. */
const TIGHT = 96;
/** The room a title written after its bar is given, so the next bar does not cover it. */
const TITLE = 170;

/**
 * Lays the cards out by who works on them: a lane per agent, cards no agent has last.
 * The days shown hold every card, with room around today, up to a year each way: a card
 * dated further (a year mistyped) is drawn at the edge. `px` is the width of a day.
 */
export function timeline(
  cards: PlanTask[],
  threads: Thread[],
  agents: AgentInfo[],
  now: number,
  px = 32,
): Timeline {
  const today = dayStart(now);
  const first = addDays(today, -TIMELINE_REACH);
  const last = addDays(today, TIMELINE_REACH);
  const spans = cards.map((card) => {
    const span = cardSpan(card, now);
    // Kept inside the days shown, a day long at least.
    const start = Math.min(Math.max(span.from, first), addDays(last, -1));
    return {
      card,
      work: cardWork(card, threads, agents),
      planned: span.planned,
      from: start,
      to: Math.min(Math.max(span.to, addDays(start, 1)), last),
    };
  });
  const before = Math.max(14, Math.ceil(300 / px));
  const after = Math.max(28, Math.ceil(1400 / px));
  const from = Math.max(
    first,
    Math.min(addDays(today, -before), ...spans.map((s) => addDays(s.from, -3))),
  );
  const to = Math.min(last, Math.max(addDays(today, after), ...spans.map((s) => addDays(s.to, 7))));
  // Rounded, as a day of 23 or 25 hours is still one day.
  const index = (at: number) => Math.round((at - from) / DAY);

  const byLane = new Map<string, typeof spans>();
  for (const span of spans) {
    const name = span.work.agent ?? "";
    byLane.set(name, [...(byLane.get(name) ?? []), span]);
  }
  const lanes = [...byLane.entries()]
    .sort(([a], [b]) => Number(!a) - Number(!b) || a.localeCompare(b, "fr"))
    .map(([name, list]): TimelineLane => {
      // Each bar takes the first line free at its first day.
      const ends: number[] = [];
      const bars = list
        .sort((a, b) => a.from - b.from || a.card.number - b.card.number)
        .map((s): TimelineBar => {
          const day = index(s.from);
          const days = Math.max(1, index(s.to) - day);
          const tight = days * px < TIGHT;
          let row = ends.findIndex((end) => end <= day);
          if (row === -1) row = ends.length;
          ends[row] = day + days + (tight ? Math.ceil(TITLE / px) : 0);
          return { card: s.card, work: s.work, day, days, row, planned: s.planned, tight };
        });
      return { name, rows: Math.max(1, ends.length), bars };
    });
  return { from, days: index(to), today: index(today), lanes };
}

/** The first of each month and each Monday among the days shown, for the header. */
export function timelineTicks(from: number, days: number) {
  const months: { day: number; label: string }[] = [];
  const weeks: { day: number; label: string }[] = [];
  for (let day = 0; day < days; day++) {
    const d = new Date(from + day * DAY + DAY / 2);
    if (d.getDate() === 1 || day === 0) {
      months.push({
        day,
        label: d.toLocaleDateString("fr-FR", {
          month: "long",
          ...(d.getMonth() === 0 || day === 0 ? { year: "numeric" } : {}),
        }),
      });
    }
    if (d.getDay() === 1) weeks.push({ day, label: String(d.getDate()) });
  }
  return { months, weeks };
}

/** What the « Planner » line of the side bar shows: nothing at all while nothing moves. */
export interface PlannerSignal {
  /** An agent works on one of the cards right now. */
  live: boolean;
  /** Cards that wait for the user: a question, an agreement, a piece held back. */
  waiting: number;
  /** Cards « En cours » or « En test ». */
  active: number;
}

export function plannerSignal(
  cards: PlanTask[],
  threads: Thread[],
  agents: AgentInfo[],
): PlannerSignal {
  let live = false;
  let waiting = 0;
  let active = 0;
  for (const card of cards) {
    const work = cardWork(card, threads, agents);
    if (work.tone === "live") live = true;
    if (work.tone === "wait") waiting++;
    if (card.status === "doing" || card.status === "test") active++;
  }
  return { live, waiting, active };
}

/** The signal in one line, for its tooltip and screen readers. */
export function plannerSignalText(s: PlannerSignal): string {
  return [
    s.waiting ? `${s.waiting} ${s.waiting > 1 ? "cartes t'attendent" : "carte t'attend"}` : "",
    s.live ? "un agent travaille" : "",
    s.active ? `${s.active} en cours` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
