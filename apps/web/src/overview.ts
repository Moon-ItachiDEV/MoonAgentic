// What the home page's overview shows, worked out from the server's state alone. Kept apart
// from the views, so it is easy to test. Nothing here is estimated or made up: a tile with no
// data says so.
import type {
  ActivityDay,
  AgentQuota,
  PlanTask,
  Schedule,
  ScheduleRepeat,
  Thread,
} from "@moonagentic/protocol";
import type { HomeCard } from "./components/HomeCards.tsx";
import { quotaLevel, tightest } from "./quotas.ts";

const DAY_MS = 86_400_000;

/** Waiting for you first, then at work, then to review; newest first within each. */
export function byUrgency(cards: HomeCard[]): HomeCard[] {
  const rank = { wait: 0, work: 1, review: 2 } as const;
  return [...cards].sort((a, b) => rank[a.tone] - rank[b.tone]);
}

export interface Brief {
  waiting: number;
  working: number;
  review: number;
  /** The agent whose subscription is nearest its limit, from 80 % used. */
  quota?: { agentId: string; usedPercent: number; label: string };
}

/** The pills under the greeting: what needs the user, counted from the cards and quotas. */
export function brief(cards: HomeCard[], quotas: AgentQuota[]): Brief {
  const out: Brief = {
    waiting: cards.filter((c) => c.tone === "wait").length,
    working: cards.filter((c) => c.tone === "work").length,
    review: cards.filter((c) => c.tone === "review").length,
  };
  for (const quota of quotas) {
    const worst = tightest(quota);
    if (!worst || quotaLevel(worst.usedPercent) === "ok") continue;
    if (!out.quota || worst.usedPercent > out.quota.usedPercent)
      out.quota = { agentId: quota.agentId, usedPercent: worst.usedPercent, label: worst.short };
  }
  return out;
}

export interface PullRequestRow {
  thread: Thread;
  number: number;
  url: string;
  tone: "run" | "ok" | "bad" | "merged" | "closed" | "open";
  label: string;
}

/** A pull request's state in a few words, as the tile shows it. */
export function pullRequestStatus(
  pr: NonNullable<Thread["pr"]>,
): Pick<PullRequestRow, "tone" | "label"> {
  if (pr.state === "merged") return { tone: "merged", label: "Fusionnée" };
  if (pr.state === "closed") return { tone: "closed", label: "Fermée" };
  if (pr.conflicts) return { tone: "bad", label: "Conflits" };
  if (pr.checks === "failed") return { tone: "bad", label: "Vérifs en échec" };
  if (pr.checks === "pending") return { tone: "run", label: "Vérifs en cours" };
  if (pr.state === "draft") return { tone: "open", label: "Brouillon" };
  if (pr.blocked) return { tone: "open", label: "En attente de relecture" };
  if (pr.checks === "passed") return { tone: "ok", label: "Prête" };
  return { tone: "open", label: "Ouverte" };
}

/** Pull requests opened from MoonAgentic: open ones first, then the latest closed. */
export function pullRequests(threads: Thread[], max = 3): { rows: PullRequestRow[]; open: number } {
  const withPr = threads.filter((t) => t.pr && !t.parentId);
  const isOpen = (t: Thread) => t.pr!.state === "open" || t.pr!.state === "draft";
  const sorted = [...withPr].sort(
    (a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt - a.updatedAt,
  );
  return {
    open: withPr.filter(isOpen).length,
    rows: sorted.slice(0, max).map((thread) => ({
      thread,
      number: thread.pr!.number,
      url: thread.pr!.url,
      ...pullRequestStatus(thread.pr!),
    })),
  };
}

const REPEAT: Record<ScheduleRepeat, string> = {
  once: "une fois",
  hourly: "toutes les heures",
  daily: "tous les jours",
  weekdays: "en semaine",
  weekly: "chaque semaine",
};
const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];

const dayStart = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const hour = (d: Date) =>
  d.getMinutes()
    ? `${d.getHours()} h ${String(d.getMinutes()).padStart(2, "0")}`
    : `${d.getHours()} h`;

/** When something is due, said the way a person would: « Demain, 2 h », « Jeudi 27 ». */
export function formatWhen(at: number, now = Date.now(), withTime = true): string {
  const d = new Date(at);
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS);
  const time = withTime ? `, ${hour(d)}` : "";
  if (days < 0) return `En retard, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (days === 0) return `Aujourd'hui${time}`;
  if (days === 1) return `Demain${time}`;
  const day = WEEKDAYS[d.getDay()]!;
  const name = day[0]!.toUpperCase() + day.slice(1);
  if (days < 7) return `${name}${time}`;
  return `${name} ${d.getDate()} ${MONTHS[d.getMonth()]}${time}`;
}

export interface Upcoming {
  id: string;
  kind: "schedule" | "plan";
  at: number;
  title: string;
  when: string;
  detail: string;
  agentId?: string;
  threadId?: string;
}

/** The next scheduled tasks and the planner cards falling due, soonest first. */
export function upcoming(
  schedules: Schedule[],
  plan: PlanTask[],
  now = Date.now(),
  max = 3,
): Upcoming[] {
  const items: Upcoming[] = [];
  for (const s of schedules) {
    if (!s.enabled || s.nextAt < now) continue;
    items.push({
      id: s.id,
      kind: "schedule",
      at: s.nextAt,
      title: s.title,
      when: formatWhen(s.nextAt, now),
      detail: REPEAT[s.repeat],
      agentId: s.agentId,
    });
  }
  for (const t of plan) {
    if (!t.due || t.status === "live") continue;
    items.push({
      id: t.id,
      kind: "plan",
      at: t.due,
      title: `#${t.number} ${t.title}`,
      when: formatWhen(t.due, now, false),
      detail: "échéance du planner",
      threadId: t.threadId,
    });
  }
  return items.sort((a, b) => a.at - b.at).slice(0, max);
}

export interface HeatCell {
  /** Days since 1970 in the device's time zone. */
  day: number;
  count: number;
  /** 0 for none, 1 to 4 for a quarter of the busiest day's count or more. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Before the first thread, or after today: drawn empty, never as a day without work. */
  state: "past" | "today" | "before" | "after";
}

export interface Heatmap {
  /** Columns of 7 cells, Monday first, oldest week first. */
  weeks: HeatCell[][];
  /** Where each month starts: its column and its short name. */
  months: { column: number; label: string }[];
  total: number;
  /** Days in a row with at least one message, up to today (or yesterday, if none yet today). */
  streak: number;
  /** The weekday with the most messages, when there is any. */
  busiest?: string;
  /** True when no day before the first thread is shown: the map covers all of it. */
  sinceStart: boolean;
}

/** Local day number (days since 1970 at the device's midnight) of a timestamp. */
export const localDay = (t: number, tzOffsetMin = new Date(t).getTimezoneOffset()) =>
  Math.floor((t - tzOffsetMin * 60_000) / DAY_MS);

/** The activity map: `weeks` full weeks ending with the current one. */
export function heatmap(
  days: ActivityDay[],
  weeks: number,
  firstAt: number | undefined,
  now = Date.now(),
  tzOffsetMin = new Date(now).getTimezoneOffset(),
): Heatmap {
  const today = localDay(now, tzOffsetMin);
  const first = firstAt === undefined ? today : localDay(firstAt, tzOffsetMin);
  // 1 January 1970 was a Thursday: Monday is weekday 0 here.
  const weekday = (day: number) => (day + 3) % 7;
  const end = today + (6 - weekday(today));
  const start = end - weeks * 7 + 1;
  const counts = new Map(days.map((d) => [d.day, d.count]));
  const max = Math.max(1, ...days.filter((d) => d.day >= start).map((d) => d.count));
  const level = (n: number): HeatCell["level"] =>
    n <= 0 ? 0 : n < max * 0.25 ? 1 : n < max * 0.5 ? 2 : n < max * 0.75 ? 3 : 4;

  const out: HeatCell[][] = [];
  const months: Heatmap["months"] = [];
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const column: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const day = start + w * 7 + i;
      const count = counts.get(day) ?? 0;
      const state =
        day > today ? "after" : day < first ? "before" : day === today ? "today" : "past";
      if (state === "past" || state === "today") {
        total += count;
        byWeekday[i]! += count;
      }
      column.push({
        day,
        count,
        level: state === "after" || state === "before" ? 0 : level(count),
        state,
      });
    }
    const month = new Date((start + w * 7) * DAY_MS).getUTCMonth();
    if (month !== lastMonth) {
      months.push({ column: w, label: MONTHS[month]!.replace(".", "") });
      lastMonth = month;
    }
    out.push(column);
  }

  let streak = 0;
  for (
    let day = (counts.get(today) ?? 0) > 0 ? today : today - 1;
    (counts.get(day) ?? 0) > 0;
    day--
  )
    streak++;
  const best = Math.max(...byWeekday);
  const names = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  return {
    weeks: out,
    months,
    total,
    streak,
    busiest: best > 0 ? names[byWeekday.indexOf(best)] : undefined,
    sinceStart: first >= start,
  };
}

/** A local day number as a date the user reads: « mar. 18 nov. ». */
export function dayLabel(day: number): string {
  const d = new Date(day * DAY_MS);
  const wd = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."][d.getUTCDay()];
  return `${wd} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
