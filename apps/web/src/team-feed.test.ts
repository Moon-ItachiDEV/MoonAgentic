import type { Item, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { isTeamThread, teamFeed } from "./team-feed.ts";

const thread = (extra: Partial<Thread> = {}): Thread =>
  ({ id: "t", title: "t", projectId: "p", status: "idle", ...extra }) as Thread;
const user = (id: string, byTeam = false): Item => ({
  id,
  kind: "user",
  text: id,
  ...(byTeam ? { byTeam: true as const } : {}),
  at: 0,
});
const agent = (id: string): Item => ({ id, kind: "agent", text: id, at: 0 });
const tool = (id: string, questions = false): Item => ({
  id,
  kind: "tool",
  title: id,
  toolKind: "read",
  status: "completed",
  content: [],
  ...(questions ? { questions: [{ question: "?", options: ["a"] }] } : {}),
  at: 0,
});
const permission = (id: string): Item => ({
  id,
  kind: "permission",
  title: id,
  options: [],
  outcome: null,
  at: 0,
});

describe("teamFeed", () => {
  it("folds a member's brief and steps, and keeps its last word cut short", () => {
    const items = [user("brief", true), agent("a1"), tool("read"), permission("ok?"), agent("a2")];
    expect(teamFeed(thread({ role: "coder", parentId: "lead" }), items)).toEqual([
      { kind: "detail", key: "brief", indices: [0, 1, 2] },
      { kind: "item", index: 3 },
      { kind: "item", index: 4, clamp: true },
    ]);
  });

  it("keeps the user's own message and every answer to it, folding only the tools", () => {
    const items = [
      user("brief", true),
      agent("done"),
      user("why?"),
      tool("grep"),
      agent("because"),
    ];
    expect(teamFeed(thread({ role: "coder", parentId: "lead" }), items)).toEqual([
      { kind: "detail", key: "brief", indices: [0] },
      { kind: "item", index: 1, clamp: true },
      { kind: "item", index: 2 },
      { kind: "detail", key: "grep", indices: [3] },
      { kind: "item", index: 4 },
    ]);
  });

  it("folds the lead's whole plan turn, which the team card shows", () => {
    const items = [user("plan prompt", true), tool("ls"), agent("plan + json")];
    expect(teamFeed(thread({ role: "lead" }), items)).toEqual([
      { kind: "detail", key: "plan prompt", indices: [0, 1, 2] },
    ]);
  });

  it("takes a team thread's first message for the engine's, from before the mark", () => {
    const items = [user("old brief"), agent("ok")];
    expect(teamFeed(thread({ role: "reviewer", parentId: "lead" }), items)[0]).toEqual({
      kind: "detail",
      key: "old brief",
      indices: [0],
    });
    // The end of a longer thread does not start with the thread's first message.
    expect(teamFeed(thread({ role: "reviewer", parentId: "lead" }), items, true)[0]).toEqual({
      kind: "item",
      index: 0,
    });
  });

  it("keeps a question the agent asks in sight", () => {
    const items = [user("brief", true), tool("ask", true)];
    expect(teamFeed(thread({ role: "coder", parentId: "lead" }), items)).toEqual([
      { kind: "detail", key: "brief", indices: [0] },
      { kind: "item", index: 1 },
    ]);
  });

  it("is only for a team's threads", () => {
    expect(isTeamThread(thread())).toBe(false);
    expect(isTeamThread(thread({ role: "merger", parentId: "lead" }))).toBe(true);
  });
});

describe("teamFeed, turn after turn", () => {
  it("folds the engine's turns that follow each other into one detail", () => {
    const items = [user("plan", true), agent("p"), user("help", true), agent("h")];
    expect(teamFeed(thread({ role: "lead" }), items)).toEqual([
      { kind: "detail", key: "plan", indices: [0, 1, 2, 3] },
    ]);
  });
});

describe("teamFeed keeps the order things happened in", () => {
  it("puts the detail between the answers it came between", () => {
    const items = [
      user("brief", true),
      user("why?"),
      agent("I check"),
      tool("read"),
      agent("here"),
    ];
    expect(teamFeed(thread({ role: "coder", parentId: "lead" }), items)).toEqual([
      { kind: "detail", key: "brief", indices: [0] },
      { kind: "item", index: 1 },
      { kind: "item", index: 2 },
      { kind: "detail", key: "read", indices: [3] },
      { kind: "item", index: 4 },
    ]);
  });

  it("puts the steps after a permission below it, where the work goes on", () => {
    const items = [user("brief", true), tool("a"), permission("ok?"), tool("b"), tool("c")];
    expect(teamFeed(thread({ role: "coder", parentId: "lead" }), items)).toEqual([
      { kind: "detail", key: "brief", indices: [0, 1] },
      { kind: "item", index: 2 },
      { kind: "detail", key: "b", indices: [3, 4] },
    ]);
  });
});
