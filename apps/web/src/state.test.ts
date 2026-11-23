import type { Item, PlanTask, Schedule, ServerMessage, Thread } from "@moonagentic/protocol";
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
/** A timeline as it comes on opening: from its item numbered `first`, `earlier` ones before. */
const opened = (threadId: string, items: Item[], first = 1, earlier = 0) =>
  ({ type: "items", threadId, items, first, earlier, epoch: "e1", rev: 0 }) satisfies ServerMessage;

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
        questions: [],
        mcpServers: [],
        agents: [],
        projects: [],
        threads: [thread("a")],
        plan: [],
        schedules: [],
        quotas: [],
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
        questions: [],
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
        quotas: [],
      },
    });
    state = reduce(state, opened("a", [user("u1", "Un")]));
    state = reduce(state, opened("b", [user("u2", "Deux")]));
    state = reduce(state, { type: "threadRemoved", threadId: "a" });
    expect(state.threads.map((t) => t.id)).toEqual(["b", "c"]);
    expect(state.items.a).toBeUndefined();
    expect(Object.keys(state.held)).toEqual(["b"]);
    state = reduce(state, { type: "projectRemoved", projectId: "p" });
    expect(state.projects.map((p) => p.id)).toEqual(["q"]);
    expect(state.threads.map((t) => t.id)).toEqual(["c"]);
    expect(state.plan.map((c) => c.id)).toEqual(["c2"]);
    expect(state.held).toEqual({});
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
    let state = reduce(initialState, opened("t", [user("u1", "Un")]));
    state = reduce(state, {
      type: "item",
      threadId: "t",
      item: { id: "a1", kind: "agent", text: "Bon", at: 2 },
      seq: 2,
      rev: 1,
    });
    state = reduce(state, { type: "append", threadId: "t", itemId: "a1", text: "jour", rev: 2 });
    expect(state.items.t?.map((i) => ("text" in i ? i.text : ""))).toEqual(["Un", "Bonjour"]);
    // The mark to come back with follows what was taken in.
    expect(state.held.t).toEqual({ first: 1, earlier: 0, epoch: "e1", rev: 2 });
    // A thread not open here is not tracked item by item.
    expect(
      reduce(state, { type: "item", threadId: "x", item: user("u", "x"), seq: 1, rev: 1 }),
    ).toBe(state);
  });

  it("holds the end of a long timeline, and takes the pages before it", () => {
    const texts = (s: typeof initialState) => s.items.t?.map((i) => ("text" in i ? i.text : ""));
    // Items 1 to 40 stay on the server.
    let state = reduce(initialState, opened("t", [user("u41", "41"), user("u42", "42")], 41, 40));
    // An old item that changes is not the timeline's next one: it stays where it is.
    state = reduce(state, { type: "item", threadId: "t", item: user("u7", "7"), seq: 7, rev: 1 });
    expect(texts(state)).toEqual(["41", "42"]);
    expect(state.held.t?.rev).toBe(1);
    // One held changes in place, a new one comes at the end.
    state = reduce(state, {
      type: "changes",
      threadId: "t",
      items: [
        { item: user("u3", "3 bis"), seq: 3 },
        { item: user("u42", "42 bis"), seq: 42 },
        { item: user("u43", "43"), seq: 43 },
      ],
      rev: 5,
    });
    expect(texts(state)).toEqual(["41", "42 bis", "43"]);
    expect(state.held.t).toMatchObject({ first: 41, earlier: 40, rev: 5 });

    // The page just before what is held goes before it.
    const page: ServerMessage = {
      type: "page",
      requestId: "r",
      threadId: "t",
      items: [user("u39", "39"), user("u40", "40")],
      before: 41,
      first: 39,
      earlier: 38,
    };
    state = reduce(state, page);
    expect(texts(state)).toEqual(["39", "40", "41", "42 bis", "43"]);
    expect(state.held.t).toMatchObject({ first: 39, earlier: 38, rev: 5 });
    // The same page again, or one for another place, changes nothing.
    expect(reduce(state, page)).toBe(state);
    // Now that it is held, item 39 changes in place.
    state = reduce(state, {
      type: "item",
      threadId: "t",
      item: user("u39", "39 bis"),
      seq: 39,
      rev: 6,
    });
    expect(texts(state)?.[0]).toBe("39 bis");
    // The timeline sent again replaces what was held.
    state = reduce(state, { ...opened("t", [user("u43", "43")], 43, 42), rev: 9 });
    expect(texts(state)).toEqual(["43"]);
    expect(state.held.t).toEqual({ first: 43, earlier: 42, epoch: "e1", rev: 9 });
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

describe("githubLogin", () => {
  it("numbers each sign-in ending, and other replies leave it alone", () => {
    let state = reduce(initialState, { type: "githubLogin", state: "done", login: "moon" });
    expect(state.githubLogin).toEqual({ seq: 1, state: "done", login: "moon" });
    state = reduce(state, { type: "done", requestId: "r" });
    state = reduce(state, { type: "files", requestId: "r", files: [] });
    expect(state.githubLogin?.seq).toBe(1);
    state = reduce(state, { type: "githubLogin", state: "cancelled" });
    expect(state.githubLogin).toEqual({ seq: 2, state: "cancelled" });
  });
});
