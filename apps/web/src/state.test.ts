import type { Item, Thread } from "@moonagentic/protocol";
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
const user = (id: string, text: string): Item => ({ id, kind: "user", text, at: 1 });

describe("client state", () => {
  it("takes the snapshot, then keeps the newest thread first", () => {
    let state = reduce(initialState, {
      type: "snapshot",
      snapshot: {
        favorites: {},
        requests: [],
        mcpServers: [],
        agents: [],
        projects: [],
        threads: [thread("a")],
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
