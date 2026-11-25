import type { PlanEntry } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { fillComposer } from "../composer-fill.ts";
import { duration, planDuration, planProgress } from "../plan-progress.ts";
import { I } from "../v2/I.tsx";

/** The time now, read again each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** A finished plan longer than this folds to one line. */
const FOLD_ABOVE = 6;

/**
 * The agent's own plan (Claude Code's todo list, Codex's plan…), as a dotted line of steps it
 * keeps up to date. A finished step turns green, the step at work is ringed while the turn
 * runs. Times and tools are what the server saw: when the agent moved a step, and what it ran
 * while on it. Nothing is guessed. A long plan that is over folds to its last line. A turn
 * that ends before the plan does says where it stopped, with a way to pick it up from there.
 */
export function AgentPlan({
  entries,
  live,
  ask,
  threadId,
}: {
  entries: PlanEntry[];
  live: boolean;
  /** What the user asked in this turn, the plan's title. */
  ask: string | undefined;
  threadId: string;
}) {
  const { done, total, over } = planProgress(entries);
  const now = useNow(live);
  // A long plan that is over keeps its last line; the rest opens on demand.
  const folded = over && !live && total > FOLD_ABOVE;
  const [open, setOpen] = useState(!folded);
  useEffect(() => setOpen(!folded), [folded]);
  const stopAt = !live && !over ? entries.findIndex((e) => e.status !== "completed") : -1;
  const spent = planDuration(entries, live ? now : undefined);
  const title = ask
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();

  // An agent may clear its list with an empty plan: then there is nothing to show.
  if (!total) return null;

  return (
    <div className="plan ap" role="group" aria-label={title ? `Plan : ${title}` : "Plan"}>
      <span className="vh" role="status">
        {live
          ? `En cours · ${Math.min(done + 1, total)} sur ${total}`
          : over
            ? `Terminé · ${total} sur ${total}`
            : `Arrêté · étape ${stopAt + 1} sur ${total}`}
      </span>
      {!open && (
        <button
          type="button"
          className="stp d fold"
          aria-expanded={false}
          title="Voir le plan"
          onClick={() => setOpen(true)}
        >
          <i>
            <I n="check" s={15} />
          </i>
          <span>
            Terminé · {total} sur {total}
          </span>
          {spent !== undefined && <span className="tm">{duration(spent)}</span>}
        </button>
      )}
      {open &&
        entries.map((entry, i) => {
          const state =
            entry.status === "completed"
              ? "done"
              : entry.status === "in_progress"
                ? live
                  ? "now"
                  : "held"
                : "todo";
          const took =
            entry.startedAt === undefined
              ? undefined
              : state === "done"
                ? entry.endedAt !== undefined
                  ? entry.endedAt - entry.startedAt
                  : undefined
                : state === "now"
                  ? now - entry.startedAt
                  : undefined;
          const stopped = i === stopAt;
          return (
            <div
              key={i}
              className={`stp ${stopped ? "x" : state === "done" ? "d" : state === "now" ? "c" : "p"}`}
              data-state={stopped ? "stop" : state}
              aria-current={state === "now" ? "step" : undefined}
            >
              <i aria-hidden="true">
                {state === "done" ? (
                  <I n="check" s={15} />
                ) : stopped ? (
                  <I n="warn" s={15} />
                ) : (
                  <span className="ring" />
                )}
              </i>
              <span>
                {entry.content}
                {!!entry.tools?.length && <small className="mono">{entry.tools.join(" · ")}</small>}
              </span>
              {stopped ? (
                <button
                  type="button"
                  className="tg"
                  onClick={() =>
                    fillComposer(threadId, `Reprends le plan à l'étape ${i + 1} : ${entry.content}`)
                  }
                >
                  Reprendre ici
                </button>
              ) : took !== undefined ? (
                <span className="tm">{duration(took)}</span>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      {open && folded && (
        <button type="button" className="apf" onClick={() => setOpen(false)}>
          Replier
        </button>
      )}
    </div>
  );
}
