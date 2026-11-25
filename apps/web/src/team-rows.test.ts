import type { AgentInfo, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { clock, teamRows } from "./team-rows.ts";
import { teamTree } from "./team-tree.ts";

const agents = [
  { id: "claude", name: "Claude Code", models: [{ id: "opus", name: "Opus 5.5" }] },
  { id: "agy", name: "Antigravity", models: [{ id: "neon", name: "Gemini 4 Neon" }] },
] as unknown as AgentInfo[];
const lead = { id: "lead", agentId: "claude", model: "opus", status: "idle" } as Thread;
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
const thread = (id: string, status: Thread["status"], agentId = "claude") =>
  ({ id, agentId, model: agentId === "agy" ? "neon" : "opus", status }) as Thread;
const rows = (t: Team, threads: Thread[] = [], end = 0) =>
  teamRows(
    t,
    teamTree({ lead, team: t, threads: [lead, ...threads], agents, items: {} }),
    agents,
    end,
  );
const short = (t: Team, threads: Thread[] = []) =>
  rows(t, threads).map((r) => [r.name, r.model, r.state, r.text]);

describe("teamRows", () => {
  it("lists every role from the start, with what each waits on", () => {
    expect(short(team())).toEqual([
      ["Chef", "Opus 5.5", "run", "Prépare le plan"],
      ["Codeurs", "Opus 5.5", "idle", "Après le plan"],
      ["Relecture", "Gemini 4 Neon", "idle", "Après les codeurs"],
      ["Fusion", "Claude Code", "idle", "À la fin"],
    ]);
  });

  it("gives each piece its coder and one line to the reviewer of them all", () => {
    const t = team({
      phase: "coding",
      tasks: [
        { title: "A", brief: "", status: "reviewing", threadId: "c1", reviewThreadId: "r1" },
        { title: "B", brief: "", status: "running", threadId: "c2" },
      ] as Team["tasks"],
      timeline: [
        { at: 0, lane: -1, phase: "planning" },
        { at: 70_000, lane: -1, phase: "idle" },
        { at: 70_000, lane: 0, phase: "running" },
        { at: 70_000, lane: 1, phase: "running" },
        { at: 200_000, lane: 0, phase: "reviewing" },
      ],
    });
    const threads = [thread("c1", "idle"), thread("c2", "running"), thread("r1", "running", "agy")];
    const got = rows(t, threads, 260_000);
    expect(got.map((r) => [r.name, r.state, r.face])).toEqual([
      ["Chef", "ok", "termine"],
      ["Codeur 1", "idle", "file"],
      ["Codeur 2", "run", "travaille"],
      ["Relecture", "run", "travaille"],
      ["Fusion", "idle", "file"],
    ]);
    // The lead's time is its plan's, and a coder at work is named by its piece.
    expect(got[0]).toMatchObject({ text: "Plan en 2 parties", time: "1 min 10" });
    expect(got[1]?.text).toBe("A");
    expect(got[2]).toMatchObject({ text: "B", live: true, threadId: "c2" });
    expect(got[3]?.threadId).toBe("r1");
  });

  it("turns the eyes red on what was found, and says it", () => {
    const t = team({
      phase: "blocked",
      tasks: [
        {
          title: "A",
          brief: "",
          status: "blocked",
          threadId: "c1",
          reviewThreadId: "r1",
          note: "Le bouton manque sur une page",
        },
      ] as Team["tasks"],
      timeline: [
        { at: 0, lane: -1, phase: "planning" },
        { at: 1, lane: 0, phase: "running" },
        { at: 2, lane: 0, phase: "reviewing" },
        { at: 3, lane: 0, phase: "blocked" },
      ],
    });
    const got = rows(t, [thread("c1", "idle"), thread("r1", "idle", "agy")]);
    expect(got.find((r) => r.name === "Codeur")).toMatchObject({
      state: "run",
      face: "attend",
      text: "Le bouton manque sur une page",
    });
    // Nobody waits for a turn in a team that is not running.
    expect(got.every((r) => r.state !== "idle")).toBe(true);
  });

  it("shows a finished team as done, each lane with the time it took", () => {
    const t = team({
      phase: "done",
      mergeThreadId: "m",
      tasks: [
        { title: "A", brief: "", status: "done", threadId: "c1", reviewThreadId: "r1" },
        { title: "B", brief: "", status: "done", threadId: "c2", reviewThreadId: "r2" },
      ] as Team["tasks"],
      timeline: [
        { at: 0, lane: -1, phase: "planning" },
        { at: 10_000, lane: -1, phase: "idle" },
        { at: 10_000, lane: 0, phase: "running" },
        { at: 70_000, lane: 0, phase: "done" },
        { at: 80_000, lane: -2, phase: "merging" },
        { at: 102_000, lane: -2, phase: "done" },
      ],
    });
    const threads = ["c1", "c2", "m"].map((id) => thread(id, "idle"));
    const got = rows(t, [...threads, thread("r1", "idle", "agy"), thread("r2", "idle", "agy")]);
    expect(got.map((r) => [r.name, r.state, r.time])).toEqual([
      ["Chef", "ok", "10 s"],
      ["Codeur 1", "ok", "1 min 00"],
      ["Codeur 2", "ok", "0 s"],
      ["Relecture", "ok", undefined],
      ["Fusion", "ok", "22 s"],
    ]);
  });
});

describe("clock", () => {
  it("reads as a clock does", () => {
    expect(clock(58_400)).toBe("58 s");
    expect(clock(373_000)).toBe("6 min 13");
    expect(clock(3_840_000)).toBe("1 h 04");
  });
});
