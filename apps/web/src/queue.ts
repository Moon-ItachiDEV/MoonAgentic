// What the composer and the queue above it say of the messages that wait: pure, so it
// is easy to test.
import type { Thread } from "@moonagentic/protocol";

/** True while the thread's turn is under way: what is written then waits for its end. */
export const turnUnderWay = (thread: Pick<Thread, "status">): boolean =>
  thread.status === "running" || thread.status === "waiting";

/**
 * Why the messages wait, in words for the user. While a turn is under way they go by
 * themselves at its end; after a stop or an error nothing does, until the user says so.
 */
export function queueState(thread: Pick<Thread, "status" | "queue">): {
  /** None waits: nothing is shown. */
  count: number;
  label: string;
  /** Nothing will send them: « Envoyer » is offered. */
  paused: boolean;
} {
  const count = thread.queue?.length ?? 0;
  const many = count > 1;
  if (turnUnderWay(thread)) {
    return {
      count,
      label: many
        ? `${count} messages en file · ils partent un par un, à la fin de chaque tour`
        : "1 message en file · il part à la fin du tour",
      paused: false,
    };
  }
  return {
    count,
    label:
      thread.status === "error"
        ? `${count} message${many ? "s" : ""} en attente · le dernier tour a échoué`
        : `${count} message${many ? "s" : ""} en attente · rien ne part tout seul après un arrêt`,
    paused: true,
  };
}
