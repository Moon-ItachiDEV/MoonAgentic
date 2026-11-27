import type { Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
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
