import type { AgentInfo, Item, Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { memberThreadIds, teamRelays, teamTree, threadDigest } from "./team-tree.ts";

const agents = [
  { id: "claude", name: "Claude Code", models: [{ id: "opus", name: "Opus 5.5" }] },
  { id: "agy", name: "Antigravity", models: [{ id: "neon", name: "Gemini 4 Neon" }] },
] as unknown as AgentInfo[];
const lead = { id: "lead", agentId: "claude", model: "opus", status: "idle" } as Thread;
const team = (extra: Partial<Team> = {}): Team =>
  ({
    phase: "coding",
    task: "Refaire l'accueil",
    coder: { agentId: "claude", model: "opus" },
    reviewer: { agentId: "agy", model: "neon" },
    merger: { agentId: "claude" },
    coders: 2,
    permissionMode: "full",
    tasks: [],
    timeline: [],
    ...extra,
  }) as Team;
const tasks = (...list: Partial<Team["tasks"][number]>[]) =>
  list.map((t, i) => ({ title: `P${i + 1}`, brief: "", status: "waiting", ...t })) as Team["tasks"];
const tool = (toolKind: string, title: string, at: number) =>
  ({ kind: "tool", toolKind, title, status: "completed", content: [], at }) as unknown as Item;

describe("teamRelays", () => {
  it("reads each relay from a lane that changed phase, and nothing else", () => {
    const t = team({
      tasks: tasks({}, {}),
      timeline: [
        { at: 0, lane: -1, phase: "planning" },
        { at: 1, lane: 0, phase: "running" },
        { at: 2, lane: 1, phase: "waiting" },
        { at: 3, lane: 0, phase: "reviewing" },
        { at: 4, lane: 0, phase: "running" },
        { at: 5, lane: 0, phase: "reviewing" },
        { at: 6, lane: 0, phase: "done" },
        { at: 7, lane: 1, phase: "running" },
        { at: 8, lane: -2, phase: "merging" },
        { at: 9, lane: -2, phase: "done" },
      ],
    });
    expect(teamRelays(t).map((r) => [r.at, r.from, r.to, r.tone])).toEqual([
      [1, "lead", "c0", "work"],
      [3, "c0", "r0", "work"],
      [4, "r0", "c0", "warn"],
      [5, "c0", "r0", "work"],
      [6, "r0", "merge", "ok"],
      [7, "lead", "c1", "work"],
      [9, "merge", "pr", "ok"],
    ]);
  });

  it("hands a single piece straight to the pull request, or to nobody without one", () => {
    const timeline: Team["timeline"] = [
      { at: 1, lane: 0, phase: "running" },
      { at: 2, lane: 0, phase: "done" },
    ];
    const one = team({ tasks: tasks({}), timeline, reviewer: undefined });
    expect(teamRelays(one).at(-1)).toMatchObject({ from: "c0", to: "pr" });
    expect(teamRelays({ ...one, autoShip: false })).toHaveLength(1);
  });

  it("goes back up to the lead when a brief has to be written again", () => {
    const t = team({
      tasks: tasks({}),
      timeline: [
        { at: 1, lane: 0, phase: "running" },
        { at: 2, lane: 0, phase: "reviewing" },
        { at: 3, lane: 0, phase: "lead" },
        { at: 4, lane: 0, phase: "running" },
      ],
    });
    expect(teamRelays(t).slice(2)).toMatchObject([
      { from: "r0", to: "lead", tone: "warn" },
      { from: "lead", to: "c0", text: "Consigne revue" },
    ]);
  });
});

describe("threadDigest", () => {
  it("counts the tools by kind and keeps the last steps, newest first", () => {
    const digest = threadDigest([
      tool("read", "a.ts", 1),
      tool("read", "b.ts", 2),
      tool("edit", "a.ts", 3),
      tool("execute", "pnpm test", 4),
    ]);
    expect(digest.tools).toEqual([
      ["read", 2],
      ["edit", 1],
      ["run", 1],
    ]);
    expect(digest.steps[0]).toEqual({ at: 4, text: "pnpm test" });
    expect(threadDigest(undefined)).toEqual({ tools: [], steps: [] });
  });
});

describe("teamTree", () => {
  const threads = [
    lead,
    { id: "c1", agentId: "claude", model: "opus", status: "idle" },
    { id: "r1", agentId: "agy", model: "neon", status: "running" },
  ] as Thread[];
  const t = team({
    tasks: tasks(
      {
        title: "Bandeau",
        brief: "Fais le bandeau",
        status: "reviewing",
        threadId: "c1",
        reviewThreadId: "r1",
      },
      { title: "Pied" },
    ),
    timeline: [
      { at: 1, lane: 0, phase: "running" },
      { at: 2, lane: 0, phase: "reviewing" },
    ],
  });

  it("gives each piece its coder and its reviewer, then the merge and the pull request", () => {
    const tree = teamTree({ lead, team: t, threads, agents, items: {} });
    expect(
      tree.pieces.map((p) => [p.coder.name, p.coder.sub, p.reviewer?.sub, !!p.tester]),
    ).toEqual([
      ["Bandeau", "Codeur · Opus 5.5", "Gemini 4 Neon", false],
      ["Pied", "Codeur · Opus 5.5", "Gemini 4 Neon", false],
    ]);
    expect(tree.lead.mission).toBe("Refaire l'accueil");
    expect(tree.merger?.pending).toBe(true);
    expect(tree.pr?.label).toBe("La PR s'ouvrira à la fin");
  });

  it("shows work only for a thread that really runs, and says what it does", () => {
    const tree = teamTree({
      lead,
      team: t,
      threads,
      agents,
      items: { r1: [tool("read", "bandeau.tsx", 5)] },
    });
    const { coder, reviewer } = tree.pieces[0]!;
    expect([coder.tone, coder.label, coder.glyph]).toEqual(["idle", "En relecture", undefined]);
    expect([reviewer?.tone, reviewer?.glyph]).toEqual(["work", "lit"]);
    expect(reviewer?.tools).toEqual([["read", 1]]);
    expect(reviewer?.relay).toMatchObject({ from: "c0", text: "Changements à relire" });
    expect(coder.sent).toBe(reviewer?.relay);
    // Not started: no thread, nothing drawn as moving.
    expect(tree.pieces[1]!.coder).toMatchObject({ pending: true, tone: "idle" });
  });

  it("a thread that asks the user, waits in line or broke says so before anything else", () => {
    const at = (thread: Partial<Thread>) =>
      teamTree({
        lead,
        team: t,
        threads: [lead, threads[1]!, { ...threads[2]!, ...thread } as Thread],
        agents,
        items: {},
      }).pieces[0]!.reviewer!;
    expect(at({ status: "waiting" })).toMatchObject({ tone: "warn", glyph: "attend" });
    expect(at({ inLine: true } as Partial<Thread>)).toMatchObject({ tone: "idle", glyph: "file" });
    expect(at({ status: "error", error: "Quota atteint" })).toMatchObject({
      tone: "err",
      action: "Quota atteint",
    });
  });

  it("puts the reviewer's remarks on the relay that sent the piece back", () => {
    const back = team({
      tasks: tasks({
        status: "running",
        threadId: "c1",
        reviewThreadId: "r1",
        tries: 1,
        note: "VERDICT: À CORRIGER\nLe bouton n'a pas de nom",
      }),
      timeline: [
        { at: 1, lane: 0, phase: "running" },
        { at: 2, lane: 0, phase: "reviewing" },
        { at: 3, lane: 0, phase: "running" },
      ],
    });
    const idle = threads.map((x) => ({ ...x, status: "idle" }) as Thread);
    const { coder, reviewer } = teamTree({ lead, team: back, threads: idle, agents, items: {} })
      .pieces[0]!;
    expect(coder.relay).toMatchObject({
      tone: "warn",
      text: "À corriger : Le bouton n'a pas de nom",
    });
    expect(coder.action).toBe("Correction 1 sur 3");
    expect(reviewer).toMatchObject({ tone: "warn", label: "À corriger" });
  });

  it("ends on the pull request once it is open", () => {
    const done = team({
      phase: "done",
      tasks: tasks({ status: "done", threadId: "c1" }),
      reviewer: undefined,
      shipped: { url: "https://github.com/o/r/pull/1", opened: true },
      timeline: [
        { at: 1, lane: 0, phase: "running" },
        { at: 2, lane: 0, phase: "done" },
      ],
    } as Partial<Team>);
    const tree = teamTree({ lead, team: done, threads, agents, items: {} });
    expect(tree.merger).toBeUndefined();
    expect(tree.pr).toEqual({
      tone: "ok",
      label: "PR ouverte",
      url: "https://github.com/o/r/pull/1",
    });
    expect(tree.relays.at(-1)).toMatchObject({ from: "c0", to: "pr", tone: "ok" });
  });
});

describe("memberThreadIds", () => {
  it("lists every member's thread that exists", () => {
    const t = team({
      mergeThreadId: "m",
      tasks: tasks(
        { threadId: "c1", reviewThreadId: "r1" },
        { threadId: "c2", testThreadId: "t2" },
        {},
      ),
    });
    expect(memberThreadIds(t)).toEqual(["c1", "r1", "c2", "t2", "m"]);
  });
});
