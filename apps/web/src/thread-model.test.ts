import type { Thread } from "@moonagentic/protocol";
import { describe, expect, it, vi } from "vitest";
import { nextModelStep } from "./thread-model.ts";

const thread = (more: Partial<Thread> = {}): Thread =>
  ({
    id: "t",
    projectId: "p",
    title: "Fil",
    agentId: "claude",
    model: "sonnet",
    settings: { effort: "medium" },
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    ...more,
  }) as Thread;

/** Plays the steps against a server that does each change asked, as it would. */
function play(start: Thread, route: Parameters<typeof nextModelStep>[1]) {
  let now = start;
  const sent: string[] = [];
  const types: string[] = [];
  for (let i = 0; i < 10; i++) {
    const step = nextModelStep(now, route, sent);
    if (step === "done") return { now, types };
    if (step === "wait") throw new Error("waits with nothing on the way");
    sent.push(step.key);
    types.push(step.send.type);
    const m = step.send;
    if (m.type === "thread.switchAgent")
      now = { ...now, agentId: m.agentId, model: undefined, settings: undefined };
    if (m.type === "thread.setModel") now = { ...now, model: m.model };
    if (m.type === "thread.setSetting")
      now = { ...now, settings: { ...now.settings, [m.settingId]: m.value } };
  }
  throw new Error("never done");
}

describe("a thread's model changed from its settings", () => {
  // Neon's review of PR #192: the model was set but the reflection chosen with it was lost.
  it("sets the reflection after a new model of the same agent", () => {
    const { now, types } = play(thread(), {
      agentId: "claude",
      model: "opus",
      settings: { effort: "max" },
    });
    expect(types).toEqual(["thread.setModel", "thread.setSetting"]);
    expect(now.model).toBe("opus");
    expect(now.settings).toEqual({ effort: "max" });
  });

  it("sets the model then the reflection once another agent has the thread", () => {
    const { now, types } = play(thread(), {
      agentId: "codex",
      model: "gpt",
      settings: { effort: "high" },
    });
    expect(types).toEqual(["thread.switchAgent", "thread.setModel", "thread.setSetting"]);
    expect(now).toMatchObject({ agentId: "codex", model: "gpt", settings: { effort: "high" } });
  });

  it("changes only the reflection when the model stays", () => {
    expect(
      play(thread(), { agentId: "claude", model: "sonnet", settings: { effort: "low" } }).types,
    ).toEqual(["thread.setSetting"]);
  });

  it("waits while the thread is at work, and for a change sent to come back", () => {
    const route = { agentId: "claude", model: "opus" };
    expect(nextModelStep(thread({ status: "running" }), route, [])).toBe("wait");
    expect(nextModelStep(thread(), route, ["model:opus"])).toBe("wait");
    expect(nextModelStep(thread({ model: "opus" }), route, ["model:opus"])).toBe("done");
  });
});

// Neon's review of PR #193.
describe("a thread's model on its way, once something else happens", () => {
  it("lets the composer's own model stand once the reflection was sent", () => {
    // The reflection was asked and sent, the model needed no change; the composer then sets
    // another model straight away: that is not taken back.
    const route = { agentId: "claude", model: "sonnet", settings: { effort: "max" } };
    expect(nextModelStep(thread({ model: "haiku" }), route, ["setting:effort:max"])).toBe("done");
  });

  it("still sets the model after another agent took the thread over", () => {
    const route = { agentId: "codex", model: "gpt", settings: { effort: "max" } };
    const step = nextModelStep(thread({ agentId: "codex", model: "x" }), route, ["agent:codex"]);
    expect(step).toMatchObject({ key: "model:gpt" });
  });
});

describe("setThreadModel", () => {
  it("lets go of what it could not send, offline", async () => {
    vi.resetModules();
    const listeners: (() => void)[] = [];
    const sent: unknown[] = [];
    vi.doMock("./connection.ts", () => ({
      connection: {
        getState: () => ({ threads: [thread()] }),
        send: (m: unknown) => {
          sent.push(m);
          return false;
        },
        subscribe: (l: () => void) => {
          listeners.push(l);
          return () => listeners.splice(listeners.indexOf(l), 1);
        },
      },
    }));
    const { setThreadModel } = await import("./thread-model.ts");
    setThreadModel("t", { agentId: "claude", model: "opus" });
    expect(sent).toHaveLength(1);
    expect(listeners).toHaveLength(0);
    vi.doUnmock("./connection.ts");
  });
});
