import type { Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "./connection.ts";
import type { Route } from "./v2/ModelChip.tsx";

/**
 * Changes a thread's model and its reflection from the settings: another agent takes the
 * thread over first, and the model is set once it has it (the server takes one change at a
 * time). Undefined while the thread is gone.
 */
export function useThreadModel(thread: Thread | undefined): (route: Route | undefined) => void {
  const [handoff, setHandoff] = useState<{ threadId: string } & Route>();
  const running = thread?.status === "running" || thread?.status === "waiting";
  useEffect(() => {
    if (!handoff) return;
    if (thread?.id !== handoff.threadId) return setHandoff(undefined);
    if (thread.agentId !== handoff.agentId || running) return;
    setHandoff(undefined);
    if (handoff.model && thread.model !== handoff.model)
      connection.send({ type: "thread.setModel", threadId: thread.id, model: handoff.model });
  }, [handoff, thread?.id, thread?.agentId, thread?.model, running]);
  return (route) => {
    if (!thread || !route) return;
    if (route.agentId !== thread.agentId) {
      setHandoff({ threadId: thread.id, ...route });
      connection.send({ type: "thread.switchAgent", threadId: thread.id, agentId: route.agentId });
      return;
    }
    if (route.model && route.model !== thread.model) {
      connection.send({ type: "thread.setModel", threadId: thread.id, model: route.model });
      return;
    }
    for (const [settingId, value] of Object.entries(route.settings ?? {})) {
      if (thread.settings?.[settingId] !== value)
        connection.send({ type: "thread.setSetting", threadId: thread.id, settingId, value });
    }
  };
}
