import type { Thread, ThreadGoal } from "@moonagentic/protocol";
import { connection, newId } from "../connection.ts";
import { goalState } from "../goal.ts";
import { IconClose, IconPause, IconPlay } from "./icons.tsx";

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
  return (
    <section className={`cgoal st-${goal.state}`} aria-label="Objectif">
      <div className="cg-top">
        <span className="cg-l" role="status">
          {state.label}
        </span>
        {state.action && (
          <button onClick={() => void control(thread.id, state.action!.kind)}>
            {state.action.kind === "pause" ? <IconPause size={12} /> : <IconPlay size={12} />}
            {state.action.label}
          </button>
        )}
        <button
          aria-label={state.over ? "Fermer l'objectif" : "Retirer l'objectif"}
          title={state.over ? "Fermer" : "Retirer l'objectif : l'agent ne sera plus relancé"}
          onClick={() => void control(thread.id, "stop")}
        >
          <IconClose />
        </button>
      </div>
      <p className="cg-t" title={goal.text}>
        {goal.text}
      </p>
      {state.note && <p className="cg-n">{state.note}</p>}
      <div className="cg-bar" aria-hidden>
        <i style={{ width: `${Math.round(state.progress * 100)}%` }} />
      </div>
    </section>
  );
}
