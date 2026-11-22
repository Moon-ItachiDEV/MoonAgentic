import type { Item, PlanTask, Schedule, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./state.ts";

const thread = (id: string, title = id): Thread => ({
  id,
  projectId: "p",
  title,
  agentId: "demo",
  status: "idle",
  permissionMode: "supervised",
  createdAt: 1,
  updatedAt: 1,
});
const card = (id: string, projectId: string): PlanTask => ({
  id,
  projectId,
  number: 1,
  title: id,
  status: "todo",
  source: "user",
  createdAt: 1,
  updatedAt: 1,
});
const user = (id: string, text: string): Item => ({ id, kind: "user", text, at: 1 });

const planned: Schedule = {
  id: "s",
  projectId: "p",
  title: "Tests",
  text: "Lance les tests",
  agentId: "demo",
  permissionMode: "supervised",
  repeat: "daily",
  nextAt: 10,
  enabled: true,
  runs: 0,
  createdAt: 1,
};

describe("client state", () => {
  it("takes the snapshot, then keeps the newest thread first", () => {
    let state = reduce(initialState, {
      type: "snapshot",
      snapshot: {
        coordinator: { routes: {} },
        favorites: {},
        requests: [],
        mcpServers: [],
        agents: [],
        projects: [],
        threads: [thread("a")],
        plan: [],
        schedules: [],
      },
    });
    expect(state.ready).toBe(true);
    state = reduce(state, { type: "thread", thread: thread("b") });
    state = reduce(state, { type: "thread", thread: { ...thread("a"), pinned: true } });
    expect(state.threads.map((t) => [t.id, !!t.pinned])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("forgets a deleted thread, and a removed project with its threads", () => {
    let state = reduce(initialState, {
      type: "snapshot",
      snapshot: {
        coordinator: { routes: {} },
        favorites: {},
        requests: [],
        mcpServers: [],
        agents: [],
        projects: [
          { id: "p", name: "p", path: "/p", createdAt: 1 },
          { id: "q", name: "q", path: "/q", createdAt: 1 },
        ],
        threads: [thread("a"), thread("b"), { ...thread("c"), projectId: "q" }],
        plan: [card("c1", "p"), card("c2", "q")],
        schedules: [
          { ...planned, id: "s1", projectId: "p" },
          { ...planned, id: "s2", projectId: "q" },
        ],
      },
    });
    state = reduce(state, { type: "items", threadId: "a", items: [user("u1", "Un")] });
    state = reduce(state, { type: "threadRemoved", threadId: "a" });
    expect(state.threads.map((t) => t.id)).toEqual(["b", "c"]);
    expect(state.items.a).toBeUndefined();
    state = reduce(state, { type: "projectRemoved", projectId: "p" });
    expect(state.projects.map((p) => p.id)).toEqual(["q"]);
    expect(state.threads.map((t) => t.id)).toEqual(["c"]);
    expect(state.plan.map((c) => c.id)).toEqual(["c2"]);
  });

  it("keeps the planner's cards in the order they were made", () => {
    let state = reduce(initialState, { type: "planTask", task: card("c1", "p") });
    state = reduce(state, { type: "planTask", task: card("c2", "p") });
    state = reduce(state, { type: "planTask", task: { ...card("c1", "p"), status: "doing" } });
    expect(state.plan.map((c) => [c.id, c.status])).toEqual([
      ["c1", "doing"],
      ["c2", "todo"],
    ]);
    state = reduce(state, { type: "planTaskRemoved", id: "c1" });
    expect(state.plan.map((c) => c.id)).toEqual(["c2"]);
  });

  it("adds items at the end and streams text into the right one", () => {
    let state = reduce(initialState, { type: "items", threadId: "t", items: [user("u1", "Un")] });
    state = reduce(state, {
      type: "item",
      threadId: "t",
      item: { id: "a1", kind: "agent", text: "Bon", at: 2 },
    });
    state = reduce(state, { type: "append", threadId: "t", itemId: "a1", text: "jour" });
    expect(state.items.t?.map((i) => ("text" in i ? i.text : ""))).toEqual(["Un", "Bonjour"]);
    // A thread not open here is not tracked item by item.
    expect(reduce(state, { type: "item", threadId: "x", item: user("u", "x") })).toBe(state);
  });

  it("keeps reviews, and shows errors only when no request waits for them", () => {
    let state = reduce(initialState, {
      type: "review",
      threadId: "t",
      files: [],
      omitted: 3,
    });
    expect(state.reviews.t).toEqual({ files: [], omitted: 3 });
    expect(reduce(state, { type: "error", requestId: "r", message: "x" }).notice).toBeNull();
    state = reduce(state, { type: "error", message: "Oups" });
    expect(state.notice).toBe("Oups");
    // Replies to requests change nothing by themselves.
    expect(reduce(state, { type: "files", requestId: "r", files: ["a"] })).toBe(state);
  });
});
