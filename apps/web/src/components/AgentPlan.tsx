import type { PlanEntry } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { planProgress } from "../plan-progress.ts";
import { IconCheck, IconChevron } from "./icons.tsx";

/**
 * The agent's own plan (Claude Code's todo list, Codex's plan…), as one card that the agent
 * keeps up to date: a step it finishes turns green and is struck through, the step it is
 * on turns while the turn runs. Nothing here is guessed: each line is what the agent sent.
 * Once every step is done and the turn is over, the card folds to its title.
 */
export function AgentPlan({ entries, live }: { entries: PlanEntry[]; live: boolean }) {
  const { done, total, over } = planProgress(entries);
  const folded = over && !live;
  const [open, setOpen] = useState(!folded);
  // Folds by itself when the last step is done, opens again if the agent adds one.
  useEffect(() => setOpen(!folded), [folded]);

  return (
    <div className={open ? "card agent-plan open" : "card agent-plan"}>
      <button
        className="agent-plan-h"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Replier les étapes" : "Voir les étapes"}
      >
        <IconChevron />
        <span className="tt">{over ? "Étapes terminées" : "Étapes"}</span>
        <span className="agent-plan-n" aria-label={`${done} étapes faites sur ${total}`}>
          {done}/{total}
        </span>
      </button>
      {open && (
        <ul className="agent-plan-l">
          {entries.map((entry, i) => {
            const state =
              entry.status === "completed"
                ? "done"
                : entry.status === "in_progress"
                  ? live
                    ? "now"
                    : "held"
                  : "todo";
            return (
              <li key={i} className={state} aria-current={state === "now" ? "step" : undefined}>
                <span className="agent-plan-ic" aria-hidden="true">
                  {state === "done" && <IconCheck size={9} />}
                </span>
                <span className="agent-plan-t">{entry.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
