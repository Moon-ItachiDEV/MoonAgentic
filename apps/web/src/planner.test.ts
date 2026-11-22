import type { AgentInfo, PlanTask, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  DAY,
  cardSpan,
  cardWork,
  dayToDue,
  dueDay,
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
