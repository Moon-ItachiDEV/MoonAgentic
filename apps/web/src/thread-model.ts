import type { ClientMessage, Thread } from "@moonagentic/protocol";
import { connection } from "./connection.ts";
import type { Route } from "./v2/ModelChip.tsx";

/** A model asked for a thread, and the changes already sent on the way to it. */
type Pending = Route & { sent: string[]; at: number };

/** A change asked for that never comes about (refused, the thread gone) is let go after this. */
const GIVE_UP_MS = 60_000;

/**
 * The next change on the way from the thread as it is to the model asked for: another agent
 * first, then the model, then each reflection or other setting, one at a time since the server
 * takes one change at a time. `wait` while the thread is at work or a change sent is not seen
 * yet, `done` once the thread is as asked. Each change is sent once.
 */
export function nextModelStep(
  thread: Thread,
  route: Route,
  sent: readonly string[],
): { send: ClientMessage; key: string } | "wait" | "done" {
  if (thread.status === "running" || thread.status === "waiting") return "wait";
  const threadId = thread.id;
  if (thread.agentId !== route.agentId) {
    const key = `agent:${route.agentId}`;
    return sent.includes(key)
      ? "wait"
      : { key, send: { type: "thread.switchAgent", threadId, agentId: route.agentId } };
  }
  if (route.model && thread.model !== route.model) {
    const key = `model:${route.model}`;
    return sent.includes(key)
      ? "wait"
      : { key, send: { type: "thread.setModel", threadId, model: route.model } };
  }
  for (const [settingId, value] of Object.entries(route.settings ?? {})) {
    if (thread.settings?.[settingId] === value) continue;
    const key = `setting:${settingId}:${value}`;
    return sent.includes(key)
      ? "wait"
      : { key, send: { type: "thread.setSetting", threadId, settingId, value } };
  }
  return "done";
}

/** What is still on its way, by thread: kept here, it goes on once the settings are closed. */
const pending = new Map<string, Pending>();
let unsubscribe: (() => void) | undefined;

function advance(): void {
  const now = Date.now();
  for (const [threadId, want] of pending) {
    const thread = connection.getState().threads.find((t) => t.id === threadId);
    const step =
      thread && now - want.at < GIVE_UP_MS ? nextModelStep(thread, want, want.sent) : "done";
    if (step === "done") pending.delete(threadId);
    else if (step !== "wait") {
      want.sent.push(step.key);
      connection.send(step.send);
    }
  }
  if (!pending.size) {
    unsubscribe?.();
    unsubscribe = undefined;
  }
}

/** Takes the thread to that model and reflection, step by step, as its changes come back. */
export function setThreadModel(threadId: string, route: Route): void {
  pending.set(threadId, { ...route, sent: [], at: Date.now() });
  unsubscribe ??= connection.subscribe(advance);
  advance();
}

/**
 * Changes a thread's model and its reflection from the settings: another agent takes the
 * thread over first, then the model is set, then its reflection, each once the one before is
 * done, even after the settings are closed.
 */
export function useThreadModel(thread: Thread | undefined): (route: Route | undefined) => void {
  return (route) => {
    if (thread && route) setThreadModel(thread.id, route);
  };
}
