import type { AgentInfo, PlanTask, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { cardWork, dayToDue, dueDay, isLate } from "./planner.ts";

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
