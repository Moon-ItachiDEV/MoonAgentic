import type { AgentInfo, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { teamLanes } from "./components/TeamStrip.tsx";

const agents = [
  { id: "claude", name: "Claude Code", models: [{ id: "opus", name: "Opus 5.5" }] },
  { id: "agy", name: "Antigravity", models: [{ id: "neon", name: "Gemini 4 Neon" }] },
] as unknown as AgentInfo[];
const lead = { id: "lead", agentId: "claude", model: "opus", createdAt: 0 } as Thread;
const team = (extra: Partial<Team> = {}): Team =>
  ({
    phase: "planning",
    task: "t",
    coder: { agentId: "claude", model: "opus" },
    reviewer: { agentId: "agy", model: "neon" },
    merger: { agentId: "claude" },
    coders: 2,
    permissionMode: "full",
    tasks: [],
    timeline: [{ at: 0, lane: -1, phase: "planning" }],
    ...extra,
  }) as Team;
const rows = (t: Team, threads: Thread[] = []) =>
  teamLanes(lead, t, threads, agents).map((l) => [l.who, l.sub, l.after ?? ""]);

describe("teamLanes", () => {
  it("shows every role from the start, with what each waits on", () => {
    expect(rows(team())).toEqual([
      ["Chef", "Chef · Claude Code · Opus 5.5", ""],
      ["2 codeurs", "Codeur · Claude Code · Opus 5.5", "après le chef"],
      ["Relecture", "Relecteur · Antigravity · Gemini 4 Neon", "après les codeurs"],
      ["Fusion", "Fusionneur · Claude Code", "après les codeurs"],
    ]);
  });

  it("swaps the roles to come for the pieces once there is a plan, and names who works", () => {
    const threads = [
      { id: "c1", agentId: "claude", model: "opus" },
      { id: "r1", agentId: "agy", model: "neon" },
    ] as Thread[];
    const t = team({
      phase: "coding",
      tasks: [
        { title: "A", brief: "", status: "reviewing", threadId: "c1", reviewThreadId: "r1" },
        { title: "B", brief: "", status: "waiting" },
      ] as Team["tasks"],
      timeline: [
        { at: 0, lane: -1, phase: "planning" },
        { at: 1, lane: 0, phase: "reviewing" },
      ],
    });
    expect(rows(t, threads)).toEqual([
      ["Chef", "Chef · Claude Code · Opus 5.5", ""],
      ["A", "Relecteur · Antigravity · Gemini 4 Neon", ""],
      ["B", "Codeur · Claude Code · Opus 5.5", ""],
      ["Fusion", "Fusionneur · Claude Code", "après les sous-tâches"],
    ]);
  });

  it("leaves out the roles to come once the team has stopped", () => {
    expect(rows(team({ phase: "failed" })).map((r) => r[0])).toEqual(["Chef"]);
  });
});
