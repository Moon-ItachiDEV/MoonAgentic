import type { PlanEntry, Thread } from "@moonagentic/protocol";
import { I } from "../v2/I.tsx";

/** The steps done, and all of them. */
export function planCount(entries: PlanEntry[]): { done: number; total: number } {
  return { done: entries.filter((e) => e.status === "completed").length, total: entries.length };
}

/** Whether the thread's agent is at work now: its step under way turns. */
export const atWork = (thread: Thread) =>
  thread.status === "running" || thread.status === "waiting";

/**
 * How far the plan is: a thin ring that fills with the steps done, a check once all are. Only
 * what the agent said is shown: an empty ring for a plan not started.
 */
function PlanRing({ entries }: { entries: PlanEntry[] }) {
  const { done, total } = planCount(entries);
  if (total && done === total) {
    return (
      <span className="plr all" aria-hidden="true">
        <I n="check" s={12} />
      </span>
    );
  }
  const r = 8;
  const around = 2 * Math.PI * r;
  return (
    <svg className="plr" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" className="trk" strokeWidth="1.6" />
      {done > 0 && (
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          className="arc"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray={`${((around * done) / total).toFixed(1)} ${around.toFixed(1)}`}
          transform="rotate(-90 10 10)"
        />
      )}
    </svg>
  );
}

/** The line the pill and the panel share: how far, the thread's name, the count. */
export function PlanHead({ thread, entries }: { thread: Thread; entries: PlanEntry[] }) {
  const { done, total } = planCount(entries);
  return (
    <>
      <PlanRing entries={entries} />
      <b>{thread.title}</b>
      <span className="pln">
        {done}/{total}
      </span>
    </>
  );
}

/**
 * At the top of a thread on the phone, in place of its name: its plan in one line. A touch
 * opens the whole list.
 */
export function PlanPill({
  thread,
  entries,
  open,
  onOpen,
}: {
  thread: Thread;
  entries: PlanEntry[];
  open: boolean;
  onOpen: () => void;
}) {
  const { done, total } = planCount(entries);
  return (
    <button
      type="button"
      className="ttl glass plp press"
      aria-label={`${thread.title}, plan : ${done} étapes faites sur ${total}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <PlanHead thread={thread} entries={entries} />
    </button>
  );
}
