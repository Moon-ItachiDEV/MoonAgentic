import type { AgentInfo, PlanTask, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  DAY,
  TIMELINE_REACH,
  canRun,
  cardSpan,
  cardWork,
  dayToDue,
  dueDay,
  followedThread,
  isLate,
  timeline,
  timelineTicks,
} from "./planner.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p",
  title: id,
  agentId: "demo",
  status: "idle",
  permissionMode: "supervised",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});
const card = (patch: Partial<PlanTask> = {}): PlanTask => ({
  id: "c",
  projectId: "p",
  number: 1,
  title: "Carte",
  status: "todo",
  source: "user",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});
const agents = [{ id: "demo", name: "Agent de démo" }] as AgentInfo[];

describe("cardWork", () => {
  it("says nothing of a card no thread works on", () => {
    expect(cardWork(card(), [], agents)).toEqual({ tone: "" });
    expect(cardWork(card({ threadId: "gone" }), [], agents)).toEqual({ tone: "" });
  });

  it("moves only while the linked thread really runs", () => {
    const linked = card({ threadId: "t" });
    expect(cardWork(linked, [thread("t")], agents)).toEqual({
      threadId: "t",
      agent: "Agent de démo",
      tone: "",
    });
    expect(cardWork(linked, [thread("t", { status: "running" })], agents)).toMatchObject({
      label: "en cours",
      tone: "live",
    });
    expect(cardWork(linked, [thread("t", { status: "waiting" })], agents)).toMatchObject({
      label: "attend ton accord",
      tone: "wait",
    });
  });

  it("follows a team's piece to whoever works on it now", () => {
    const team = {
      phase: "coding",
      tasks: [
        { title: "A", brief: "", status: "reviewing", threadId: "coder", reviewThreadId: "rev" },
        { title: "B", brief: "", status: "waiting" },
        { title: "C", brief: "", status: "done", threadId: "coder", merged: true },
      ],
    } as unknown as Team;
    const threads = [
      thread("lead", { team }),
      thread("coder"),
      thread("rev", { status: "running" }),
    ];
    const of = (index: number) =>
      cardWork(card({ source: "lead", team: { leadId: "lead", index } }), threads, agents);
    expect(of(0)).toEqual({
      threadId: "rev",
      agent: "Agent de démo",
      label: "relecture",
      tone: "live",
    });
    // Not started: the card opens the lead's thread, and nothing moves.
    expect(of(1)).toEqual({ threadId: "lead", label: "attend un codeur", tone: "" });
    expect(of(2)).toMatchObject({ threadId: "coder", label: "fusionnée", tone: "" });
  });
});

describe("a card and its thread", () => {
  const team = { leadId: "lead", index: 0 };

  it("can be started while no thread works on it", () => {
    expect(canRun(card(), [])).toBe(true);
    // A thread deleted since leaves the card free to start again.
    expect(canRun(card({ threadId: "gone" }), [thread("t")])).toBe(true);
    expect(canRun(card({ threadId: "t" }), [thread("t")])).toBe(false);
    // A team's card is the team's work, never started by hand.
    expect(canRun(card({ team }), [thread("lead")])).toBe(false);
  });

  it("follows the thread it is linked to, not a team's", () => {
    expect(followedThread(card({ threadId: "t" }), [thread("t")])?.id).toBe("t");
    expect(followedThread(card(), [thread("t")])).toBeUndefined();
    expect(followedThread(card({ threadId: "gone" }), [thread("t")])).toBeUndefined();
    expect(followedThread(card({ threadId: "t", team }), [thread("t")])).toBeUndefined();
  });
});

describe("due days", () => {
  it("reads back the day it was given", () => {
    expect(dueDay(dayToDue("2026-11-30")!)).toBe("2026-11-30");
    expect(dayToDue("demain")).toBeNull();
    // The year as it is being typed in a date field.
    expect(dayToDue("0002-12-01")).toBeNull();
    expect(dueDay(undefined)).toBe("");
  });

  it("is late once its day is over, unless delivered", () => {
    const due = dayToDue("2026-11-20")!;
    const now = new Date(2026, 10, 21, 8).getTime();
    expect(isLate(card({ due }), now)).toBe(true);
    expect(isLate(card({ due }), new Date(2026, 10, 20, 23).getTime())).toBe(false);
    expect(isLate(card({ due, status: "live" }), now)).toBe(false);
    expect(isLate(card(), now)).toBe(false);
  });
});

describe("timeline", () => {
  const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
  const now = at(22, 20);
  const days = (span: { from: number; to: number }) => [
    new Date(span.from).getDate(),
    Math.round((span.to - span.from) / DAY),
  ];

  it("draws what is planned for a card not started", () => {
    expect(cardSpan(card({ createdAt: at(20) }), now)).toMatchObject({ planned: true });
    expect(days(cardSpan(card({ createdAt: at(20) }), now))).toEqual([20, 1]);
    expect(days(cardSpan(card({ createdAt: at(20), start: at(24), due: at(26) }), now))).toEqual([
      24, 3,
    ]);
  });

  it("counts days on the calendar when the clocks change", () => {
    const zone = process.env.TZ;
    // Where the zone can be set, Sunday 29 March 2026 is 23 hours long in Paris.
    process.env.TZ = "Europe/Paris";
    try {
      const sunday = new Date(2026, 2, 29, 12).getTime();
      const span = cardSpan(card({ createdAt: sunday, start: sunday, due: sunday }), sunday);
      expect([new Date(span.from).getDate(), new Date(span.to).getDate()]).toEqual([29, 30]);
      expect(new Date(span.to).getHours()).toBe(0);
      const cards = [card({ id: "a", createdAt: sunday, start: sunday, due: sunday })];
      expect(timeline(cards, [], agents, sunday).lanes[0]!.bars[0]).toMatchObject({ days: 1 });
      // The week after, seen from before the change.
      const friday = new Date(2026, 2, 27, 12).getTime();
      const monday = new Date(2026, 2, 30, 12).getTime();
      const next = [card({ id: "b", createdAt: friday, start: monday, due: monday })];
      const t = timeline(next, [], agents, friday);
      expect(t.lanes[0]!.bars[0]).toMatchObject({ day: t.today + 3, days: 1 });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("stays within a year of today, whatever year a card was given", () => {
    const far = [
      card({
        id: "a",
        number: 1,
        createdAt: at(1),
        start: at(24),
        due: new Date(9999, 0, 1).getTime(),
      }),
      card({ id: "b", number: 2, createdAt: at(1), start: new Date(2099, 5, 1).getTime() }),
      card({ id: "c", number: 3, createdAt: new Date(1971, 0, 1).getTime() }),
    ];
    const t = timeline(far, [], agents, now);
    expect(t.days).toBeLessThanOrEqual(2 * TIMELINE_REACH);
    expect(timelineTicks(t.from, t.days).weeks.length).toBeLessThan(110);
    const bars = Object.fromEntries(t.lanes[0]!.bars.map((b) => [b.card.id, b]));
    // Each is drawn inside the days shown, cut at the edge it goes past.
    expect(bars.a!.day).toBe(t.today + 2);
    expect(bars.a!.day + bars.a!.days).toBe(t.days);
    expect(bars.b).toMatchObject({ day: t.days - 1, days: 1 });
    expect(bars.c).toMatchObject({ day: 0, days: 1 });
  });

  it("draws what really happened once the work began", () => {
    const doing = card({ status: "doing", createdAt: at(10), startedAt: at(18, 9) });
    expect(cardSpan(doing, now)).toMatchObject({ planned: false });
    // It runs to today, to its due day when that is later, and past it when late.
    expect(days(cardSpan(doing, now))).toEqual([18, 5]);
    expect(days(cardSpan({ ...doing, due: at(25) }, now))).toEqual([18, 8]);
    expect(days(cardSpan({ ...doing, due: at(19) }, now))).toEqual([18, 5]);
    // Delivered: it ends the day it was, whatever was planned.
    const live = { ...doing, status: "live" as const, doneAt: at(20, 15), due: at(30) };
    expect(days(cardSpan(live, now))).toEqual([18, 3]);
  });

  it("gives each agent a lane, and overlapping cards a line each", () => {
    const threads = [thread("t")];
    const cards = [
      card({ id: "a", number: 1, threadId: "t", start: at(20), due: at(23), createdAt: at(1) }),
      card({ id: "b", number: 2, threadId: "t", start: at(22), due: at(24), createdAt: at(1) }),
      card({ id: "c", number: 3, threadId: "t", start: at(24), due: at(25), createdAt: at(1) }),
      card({ id: "d", number: 4, createdAt: at(21) }),
    ];
    const t = timeline(cards, threads, agents, now);
    expect(t.lanes.map((l) => [l.name, l.rows])).toEqual([
      ["Agent de démo", 2],
      ["", 1],
    ]);
    expect(t.lanes[0]!.bars.map((b) => [b.card.id, b.row, b.days])).toEqual([
      ["a", 0, 4],
      ["b", 1, 3],
      ["c", 0, 2],
    ]);
    // A bar too short for its title writes it after, and keeps that room on its line.
    expect(t.lanes[0]!.bars.map((b) => b.tight)).toEqual([false, false, true]);
    const month = timeline(cards, threads, agents, now, 16);
    expect(month.lanes[0]!.bars.map((b) => [b.card.id, b.row, b.tight])).toEqual([
      ["a", 0, true],
      ["b", 1, true],
      ["c", 2, true],
    ]);
    // Two weeks before today at least, four after, and every card inside.
    expect(t.today).toBe(14);
    expect(t.days).toBeGreaterThanOrEqual(42);
    expect(new Date(t.from).getDate()).toBe(8);
    expect(t.lanes[1]!.bars[0]).toMatchObject({ day: 13, days: 1, planned: true });
  });

  it("marks months and Mondays", () => {
    const ticks = timelineTicks(new Date(2026, 10, 28).getTime(), 10);
    expect(ticks.months).toEqual([
      { day: 0, label: "novembre 2026" },
      { day: 3, label: "décembre" },
    ]);
    expect(ticks.weeks).toEqual([
      { day: 2, label: "30" },
      { day: 9, label: "7" },
    ]);
  });
});
