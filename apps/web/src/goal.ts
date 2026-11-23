// What the composer says of a thread's goal: pure, so it is easy to test.
import { GOAL_MORE_TURNS, type ThreadGoal } from "@moonagentic/protocol";

const turns = (n: number) => `${n} tour${n > 1 ? "s" : ""}`;

/**
 * Where the goal stands, in words, and what can be done with it now: each follows the
 * goal's real state on the server.
 */
export function goalState(goal: ThreadGoal): {
  label: string;
  /** Why it waits, when it does. */
  note?: string;
  /** What its main button does, if it has one. */
  action?: { kind: "pause" | "resume"; label: string };
  /** The share of its turns used, from 0 to 1. */
  progress: number;
  /** It ended: its × closes it rather than drops a goal at work. */
  over: boolean;
} {
  const progress = Math.min(1, goal.turns / Math.max(1, goal.maxTurns));
  const of = `tour ${goal.turns} sur ${goal.maxTurns}`;
  switch (goal.state) {
    case "active":
      return {
        label: goal.turns ? `Objectif · ${of}` : "Objectif · part à la fin du tour",
        action: { kind: "pause", label: "Pause" },
        progress,
        over: false,
      };
    case "paused":
      return {
        label: `En pause · ${of}`,
        ...(goal.reason ? { note: goal.reason } : {}),
        action: { kind: "resume", label: "Reprendre" },
        progress,
        over: false,
      };
    case "blocked":
      return {
        label: `Bloqué au ${of}`,
        note: goal.reason ?? "L'agent ne peut pas avancer sans toi.",
        action: { kind: "resume", label: "Reprendre" },
        progress,
        over: false,
      };
    case "exhausted":
      return {
        label: `${turns(goal.turns)} sans l'atteindre`,
        action: { kind: "resume", label: `Continuer (${turns(GOAL_MORE_TURNS)} de plus)` },
        progress: 1,
        over: false,
      };
    case "reached":
      return { label: `Objectif atteint en ${turns(goal.turns)}`, progress: 1, over: true };
  }
}
