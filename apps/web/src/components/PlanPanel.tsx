// The whole plan of a thread, opened from its pill: loaded the first time it opens.
import type { PlanEntry, Thread } from "@moonagentic/protocol";
import { useEffect, useRef } from "react";
import { I } from "../v2/I.tsx";
import { useScrFlag } from "../v2/scr.ts";
import { useExit } from "../v2/use-exit.ts";
import { atWork, PlanHead, planCount } from "./ThreadPlan.tsx";

/** A step's mark: a check once done, a turning mark while the agent is on it, else a ring. */
function StepMark({ entry, live }: { entry: PlanEntry; live: boolean }) {
  if (entry.status === "completed") {
    return (
      <i className="plm d">
        <I n="check" s={13} />
      </i>
    );
  }
  if (entry.status === "in_progress" && live) {
    return (
      <i className="plm c">
        <span className="plspin">
          {Array.from({ length: 8 }, (_, k) => (
            <b key={k} style={{ transform: `rotate(${-k * 45}deg)`, opacity: 1 - k * 0.1 }} />
          ))}
        </span>
      </i>
    );
  }
  return <i className={`plm${entry.status === "in_progress" ? " h" : ""}`} />;
}

/**
 * The thread's whole plan, over the top of the page: its steps joined by a line, the one at
 * work turning while its agent works. Closed with the cross, a touch beside it, or Escape.
 */
export function PlanPanel({
  thread,
  entries,
  open,
  onClose,
}: {
  thread: Thread;
  entries: PlanEntry[];
  open: boolean;
  onClose: () => void;
}) {
  const { mounted, leaving } = useExit(open, 200);
  useScrFlag("pl", open);
  const close = useRef<HTMLButtonElement>(null);
  const shut = useRef(onClose);
  shut.current = onClose;
  useEffect(() => {
    if (!open) return;
    close.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      shut.current();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  if (!mounted) return null;
  const live = atWork(thread);
  const { done, total } = planCount(entries);
  return (
    <>
      <div className={`plscrim${leaving ? " out" : ""}`} onClick={onClose} />
      <div
        className={`plpan${leaving ? " out" : ""}`}
        role="dialog"
        aria-label={`Plan : ${thread.title}`}
      >
        <div className="plhd">
          <PlanHead thread={thread} entries={entries} />
          <button
            ref={close}
            type="button"
            className="plx press"
            aria-label="Fermer le plan"
            onClick={onClose}
          >
            <I n="x" s={20} />
          </button>
        </div>
        <ol className="plst" aria-label={`${done} étapes faites sur ${total}`}>
          {entries.map((entry, i) => {
            const now = entry.status === "in_progress";
            return (
              <li
                key={i}
                className={entry.status === "completed" ? "d" : now ? "c" : undefined}
                style={{ "--i": i } as React.CSSProperties}
                aria-current={now ? "step" : undefined}
              >
                <StepMark entry={entry} live={live} />
                <span>{entry.content}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
