import {
  GOAL_MORE_TURNS,
  type GoalState,
  type Thread,
  type ThreadGoal,
} from "@moonagentic/protocol";
import { connection, newId } from "../connection.ts";
import { goalState } from "../goal.ts";
import { I } from "../v2/I.tsx";

/** The card's look for each state of the goal. */
const KIND: Record<GoalState, string> = {
  active: "run",
  paused: "pause",
  blocked: "pause",
  exhausted: "fin",
  reached: "ok",
};

/** Sends a change to the server; a refusal is shown rather than lost. */
const control = (threadId: string, action: "pause" | "resume" | "stop") =>
  connection
    .request({ type: "thread.goalControl", requestId: newId(), threadId, action })
    .catch((error: unknown) =>
      connection.notify(error instanceof Error ? error.message : String(error)),
    );

/**
 * The thread's goal, above the composer's field: where it stands turn by turn, as the
 * server keeps it, with pause, take up again and drop.
 */
export function GoalBar({ thread, goal }: { thread: Thread; goal: ThreadGoal }) {
  const state = goalState(goal);
  const reached = goal.state === "reached";
  return (
    <section className={`gcard ${KIND[goal.state]}`} aria-label="Objectif">
      <div className="gtop">
        <span className="gic">
          <I n={reached ? "check" : "target"} s={reached ? 14 : 15} />
        </span>
        <span className="glab" role="status">
          {state.label}
        </span>
        {state.action &&
          (goal.state === "exhausted" ? (
            <button
              className="gbt wide ink press"
              aria-label={state.action.label}
              onClick={() => void control(thread.id, state.action!.kind)}
            >
              +{GOAL_MORE_TURNS} tours
            </button>
          ) : (
            <button
              className="gbt press"
              aria-label={state.action.label}
              title={state.action.label}
              onClick={() => void control(thread.id, state.action!.kind)}
            >
              <I n={state.action.kind === "pause" ? "pause" : "play"} s={15} />
            </button>
          ))}
        <button
          className="gbt press"
          aria-label={state.over ? "Fermer l'objectif" : "Retirer l'objectif"}
          title={state.over ? "Fermer" : "Retirer l'objectif : l'agent ne sera plus relancé"}
          onClick={() => void control(thread.id, "stop")}
        >
          <I n="x" s={14} />
        </button>
      </div>
      <p className="gtx" title={goal.text}>
        {goal.text}
      </p>
      {state.note && <p className="gnote">{state.note}</p>}
      {!reached && (
        <div className="gbar" aria-hidden>
          <i style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
      )}
    </section>
  );
}
