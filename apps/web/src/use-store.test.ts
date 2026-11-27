import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./state.ts";
import { nextShellState } from "./use-store.ts";

describe("nextShellState", () => {
  const loaded = reduce(
    reduce(initialState, {
      type: "snapshot",
      snapshot: {
        coordinator: { routes: {} },
        favorites: {},
        favoriteOrder: [],
        requests: [],
        questions: [],
        mcpServers: [],
        agents: [],
        projects: [{ id: "p1", name: "Demo", path: "/demo", createdAt: 1 }],
        threads: [
          {
            id: "t1",
            projectId: "p1",
            title: "Fil 1",
            agentId: "claude",
            status: "running",
            permissionMode: "full",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        quotas: [],
        plan: [],
        schedules: [],
      },
    }),
    {
      type: "items",
      threadId: "t1",
      items: [{ id: "a1", kind: "agent", text: "Bonjour", at: 1 }],
      epoch: "e1",
      rev: 1,
      first: 1,
      earlier: 0,
    },
  );

  it("keeps the exact same shell reference across streamed append and item updates", () => {
    const s0 = nextShellState(undefined, loaded);

    const afterAppend = reduce(loaded, {
      type: "append",
      threadId: "t1",
      itemId: "a1",
      text: " le monde",
      rev: 2,
    });
    expect(afterAppend).not.toBe(loaded);
    expect(nextShellState(s0, afterAppend)).toBe(s0);

    const afterItem = reduce(afterAppend, {
      type: "item",
      threadId: "t1",
      item: { id: "a2", kind: "agent", text: "Suite", at: 2 },
      seq: 2,
      rev: 3,
    });
    expect(nextShellState(s0, afterItem)).toBe(s0);
  });

  it("returns a new shell reference when a shell field such as threads or requests changes", () => {
    const s0 = nextShellState(undefined, loaded);
    const afterThread = reduce(loaded, {
      type: "thread",
      thread: { ...loaded.threads[0]!, status: "idle" },
    });
    const s1 = nextShellState(s0, afterThread);
    expect(s1).not.toBe(s0);
    expect(s1.threads[0]!.status).toBe("idle");
  });
});
