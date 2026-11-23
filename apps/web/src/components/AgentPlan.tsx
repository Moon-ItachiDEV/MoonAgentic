import type { PlanEntry } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { fillComposer } from "../composer-fill.ts";
import { duration, planDuration, planProgress } from "../plan-progress.ts";
import { IconAlert, IconCheck, IconChevron, IconList, IconUndo } from "./icons.tsx";

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

/**
 * The agent's own plan (Claude Code's todo list, Codex's plan…), as one card it keeps up to
 * date. A finished step turns green, the step at work turns while the turn runs, and the
 * line between steps fills as they end. Times and tools are what the server saw: when the
 * agent moved a step, and what it ran while on it. Nothing is guessed. A turn that ends
 * before the plan does says where it stopped, with a way to pick it up from there.
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
  const folded = over && !live;
  const [open, setOpen] = useState(!folded);
  // Folds by itself once every step is done, opens again if the agent adds one.
  useEffect(() => setOpen(!folded), [folded]);
  const stopAt = !live && !over ? entries.findIndex((e) => e.status !== "completed") : -1;
  const spent = planDuration(entries, live ? now : undefined);
  const title = ask
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();

  return (
    <div className={`card agent-plan${open ? " open" : ""}`}>
      <button
        className="agent-plan-h"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Replier le plan" : "Voir le plan"}
      >
        <span className="agent-plan-k">
          <IconList size={14} />
          Plan · {total} {total > 1 ? "étapes" : "étape"}
        </span>
        <IconChevron />
      </button>
      {title && <div className="agent-plan-tt">{title}</div>}
      {open && (
        <ol className="agent-plan-l">
          {entries.map((entry, i) => {
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
            return (
              <li
                key={i}
                className={i === stopAt ? `${state} stop` : state}
                aria-current={state === "now" ? "step" : undefined}
              >
                <span className="agent-plan-ic" aria-hidden="true">
                  {state === "done" ? (
                    <IconCheck size={10} />
                  ) : state === "held" || i === stopAt ? (
                    <IconAlert size={11} />
                  ) : state === "now" ? null : (
                    i + 1
                  )}
                </span>
                <div className="agent-plan-b">
                  <div className="agent-plan-r">
                    <span className="agent-plan-t">{entry.content}</span>
                    {took !== undefined && <span className="agent-plan-d">{duration(took)}</span>}
                  </div>
                  {!!entry.tools?.length && (
                    <div className="agent-plan-tools">
                      {entry.tools.map((tool) => (
                        <code key={tool}>{tool}</code>
                      ))}
                    </div>
                  )}
                  {i === stopAt && (
                    <button
                      className="agent-plan-retry"
                      onClick={() =>
                        fillComposer(
                          threadId,
                          `Reprends le plan à l'étape ${i + 1} : ${entry.content}`,
                        )
                      }
                    >
                      <IconUndo size={13} />
                      Reprendre ici
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className={`agent-plan-f${stopAt >= 0 ? " stopped" : over ? " over" : ""}`}>
        {live ? (
          <span className="agent-plan-spin" aria-hidden="true" />
        ) : over ? (
          <IconCheck size={13} />
        ) : (
          <IconAlert size={13} />
        )}
        <span className="agent-plan-fs">
          {live
            ? `En cours · ${Math.min(done + 1, total)} sur ${total}`
            : over
              ? `Terminé · ${total} sur ${total}`
              : `Arrêté · étape ${stopAt + 1} sur ${total}`}
        </span>
        {spent !== undefined && <span className="agent-plan-d">{duration(spent)}</span>}
      </div>
    </div>
  );
}
