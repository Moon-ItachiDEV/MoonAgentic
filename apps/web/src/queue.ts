// What the composer and the queue above it say of the messages that wait: pure, so it
// is easy to test.
import type { Thread } from "@moonagentic/protocol";

/** True while the thread's turn is under way: what is written then waits for its end. */
export const turnUnderWay = (thread: Pick<Thread, "status">): boolean =>
  thread.status === "running" || thread.status === "waiting";

/**
 * How many messages wait, and whether they will go by themselves. While a turn is under way
 * they go at its end; after a stop or an error nothing does, until the user says so.
 */
export function queueState(thread: Pick<Thread, "status" | "queue">): {
  /** None waits: nothing is shown. */
  count: number;
  label: string;
  /** Nothing will send them: « Envoyer » is offered. */
  paused: boolean;
} {
  const count = thread.queue?.length ?? 0;
  if (turnUnderWay(thread)) return { count, label: `En file · ${count}`, paused: false };
  return {
    count,
    label:
      thread.status === "error" ? `En attente · ${count} · tour échoué` : `En attente · ${count}`,
    paused: true,
  };
}
