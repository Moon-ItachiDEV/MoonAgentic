import type { PendingRequest, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";

const ago = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.floor(hours / 24)} j`;
};

/** Every agent waiting for the user's go-ahead, across all threads, answerable from here. */
export function RequestsDialog(props: {
  requests: PendingRequest[];
  threads: Thread[];
  onOpenThread: (threadId: string, itemId: string) => void;
  onClose: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  // One answer per request, even when a slow phone takes a double tap.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const title = (id: string) => props.threads.find((t) => t.id === id)?.title ?? "Fil";
  const now = Date.now();

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog requests" role="dialog" aria-modal aria-labelledby="rq-title">
        <h2 id="rq-title">À traiter</h2>
        <p>
          {props.requests.length === 0
            ? "Aucun agent n'attend ta réponse."
            : "Les agents attendent ton accord pour continuer."}
        </p>
        {props.requests.length > 0 && (
          <ul className="rq-list">
            {props.requests.map((r) => (
              <li key={r.itemId} className="rq-row">
                <button
                  className="rq-thread"
                  onClick={() => props.onOpenThread(r.threadId, r.itemId)}
                >
                  {title(r.threadId)}
                  <small>{ago(r.at, now)}</small>
                </button>
                <div className="rq-q">{r.title}</div>
                <div className="row">
                  {r.options.map((o) => (
                    <button
                      key={o.optionId}
                      className={`btn sm${o.kind === "allow_once" ? " pri" : o.kind.startsWith("allow") ? "" : " quiet"}`}
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
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button className="btn pri" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
