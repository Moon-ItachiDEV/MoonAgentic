import type { PendingRequest, Thread } from "@moonagentic/protocol";
import { useState } from "react";
import { connection } from "../connection.ts";

/** The requests of a project's threads, its teams' members included; never the coordinator's own. */
export function projectRequests(
  requests: PendingRequest[],
  threads: Thread[],
  projectId: string,
): PendingRequest[] {
  const asking = new Set(
    threads.filter((t) => t.projectId === projectId && t.kind !== "coordinator").map((t) => t.id),
  );
  return requests.filter((r) => asking.has(r.threadId));
}

/**
 * Above the coordinator's composer: what the project's threads wait for, answered by the
 * user in place. Only the user answers: a coordinator has no tool to allow anything.
 */
export function ProjectRequests(props: {
  requests: PendingRequest[];
  threads: Thread[];
  onOpenThread: (threadId: string, itemId: string) => void;
}) {
  // One answer per request, even when a slow phone takes a double tap.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  if (!props.requests.length) return null;
  const title = (id: string) => {
    const thread = props.threads.find((t) => t.id === id);
    // A team's member is known by its team.
    const lead = thread?.parentId && props.threads.find((t) => t.id === thread.parentId);
    return (lead || thread)?.title ?? "Fil";
  };
  return (
    <div className="dcw" role="list" aria-label="Autorisations demandées par les fils du projet">
      {props.requests.map((r) => (
        <div key={r.itemId} className="updb glass qw pra" role="listitem">
          <button className="tx" onClick={() => props.onOpenThread(r.threadId, r.itemId)}>
            {title(r.threadId)}
            <small>{r.title}</small>
          </button>
          {r.options.map((o) => (
            <button
              key={o.optionId}
              className={`b2 press ${o.kind === "allow_once" ? "ink" : "soft"}`}
              disabled={answered.has(r.itemId)}
              onClick={() => {
                const sent = connection.send({
                  type: "permission.respond",
                  threadId: r.threadId,
                  itemId: r.itemId,
                  optionId: o.optionId,
                });
                if (sent) setAnswered((a) => new Set(a).add(r.itemId));
              }}
            >
              {o.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
