import type { QueuedMessage } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { queueState, turnUnderWay } from "./queue.ts";

const queue = (n: number): QueuedMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `Message ${i}`, at: i }));

describe("messages that wait", () => {
  it("wait while the agent works or asks, not once the turn is over", () => {
    expect(turnUnderWay({ status: "running" })).toBe(true);
    expect(turnUnderWay({ status: "waiting" })).toBe(true);
    expect(turnUnderWay({ status: "idle" })).toBe(false);
    expect(turnUnderWay({ status: "error" })).toBe(false);
  });

  it("go by themselves at the end of the turn under way", () => {
    expect(queueState({ status: "running" })).toMatchObject({ count: 0, paused: false });
    expect(queueState({ status: "running", queue: queue(1) })).toEqual({
      count: 1,
      label: "En file · 1",
      paused: false,
    });
    expect(queueState({ status: "waiting", queue: queue(3) }).label).toBe("En file · 3");
  });

  it("stay until the user sends them after a stop or an error", () => {
    expect(queueState({ status: "idle", queue: queue(2) })).toEqual({
      count: 2,
      label: "En attente · 2",
      paused: true,
    });
    expect(queueState({ status: "error", queue: queue(1) })).toEqual({
      count: 1,
      label: "En attente · 1 · tour échoué",
      paused: true,
    });
  });
});
