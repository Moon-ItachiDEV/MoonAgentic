import type { PendingRequest, Project, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { I } from "../v2/I.tsx";

/** Where an answer sits in its row: what refuses first, what allows once last. */
const rank = (kind: string) => (kind === "allow_once" ? 2 : kind.startsWith("allow") ? 1 : 0);

const ago = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.floor(hours / 24)} j`;
};

/** « À traiter »: every agent waiting for the user's go-ahead, across all threads, answerable from here. */
export function RequestsDialog(props: {
  requests: PendingRequest[];
  threads: Thread[];
  projects: Project[];
  onOpenThread: (threadId: string, itemId: string) => void;
}) {
  // One answer per request, even when a slow phone takes a double tap.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // The times move on by themselves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const threadOf = (id: string) => props.threads.find((t) => t.id === id);

  return (
    <div className="view" id="view" role="region" aria-label="À traiter">
      {props.requests.map((r) => {
        const thread = threadOf(r.threadId);
        // A team's member is known by its team.
        const lead = thread?.parentId ? threadOf(thread.parentId) : undefined;
        const project = props.projects.find((p) => p.id === thread?.projectId);
        return (
          <div key={r.itemId} className="rq">
            <div className="rqh">
              {project && (
                <>
                  <i className={`pdot${project.color ? ` pc-${project.color}` : ""}`} />
                  <span>{project.name}</span>
                </>
              )}
              <span className="sp" />
              <span className="tm">{ago(r.at, now)}</span>
            </div>
            <button className="rqt" onClick={() => props.onOpenThread(r.threadId, r.itemId)}>
              {(lead ?? thread)?.title ?? "Fil"} <I n="right" s={14} />
            </button>
            <div className="rqc">
              <span className="mono">{r.title}</span>
            </div>
            <div className="rqa">
              {[...r.options]
                // The refusals first, the go-ahead last, under the thumb.
                .sort((a, b) => rank(a.kind) - rank(b.kind))
                .map((o) => (
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
          </div>
        );
      })}
      {props.requests.length === 0 && (
        <div className="empty2">
          <span className="eic">
            <I n="check" s={24} />
          </span>
          <b>Rien ne t'attend</b>
        </div>
      )}
      <div className="end" />
    </div>
  );
}
