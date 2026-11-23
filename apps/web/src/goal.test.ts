import type { ThreadGoal } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { goalState } from "./goal.ts";

const goal = (over: Partial<ThreadGoal>): ThreadGoal => ({
  text: "Les tests passent",
  state: "active",
  turns: 2,
  maxTurns: 10,
  startedAt: 1,
  ...over,
});

describe("what the composer says of a goal", () => {
  it("follows the goal at work, turn by turn, and offers a pause", () => {
    expect(goalState(goal({}))).toEqual({
      label: "Objectif · tour 2 sur 10",
      action: { kind: "pause", label: "Pause" },
      progress: 0.2,
      over: false,
    });
    // Set while a turn runs: it starts when that turn ends.
    expect(goalState(goal({ turns: 0 })).label).toBe("Objectif · part à la fin du tour");
  });

  it("says why it waits, and how to take it up again", () => {
    expect(goalState(goal({ state: "paused", reason: "Tour arrêté." }))).toMatchObject({
      label: "En pause · tour 2 sur 10",
      note: "Tour arrêté.",
      action: { kind: "resume", label: "Reprendre" },
    });
    expect(goalState(goal({ state: "blocked", reason: "il me faut la clé" }))).toMatchObject({
      label: "Bloqué au tour 2 sur 10",
      note: "il me faut la clé",
    });
    expect(goalState(goal({ state: "exhausted", turns: 10 }))).toMatchObject({
      label: "10 tours sans l'atteindre",
      action: { kind: "resume", label: "Continuer (5 tours de plus)" },
      progress: 1,
    });
  });

  it("ends once reached, with nothing more to start", () => {
    expect(goalState(goal({ state: "reached", turns: 1 }))).toEqual({
      label: "Objectif atteint en 1 tour",
      progress: 1,
      over: true,
    });
  });
});
