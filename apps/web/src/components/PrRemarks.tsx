import type { PullRequestRemark } from "@moonagentic/protocol";
import { useState } from "react";
import { connection, newId } from "../connection.ts";

/** Where a remark is: its file and line, or the review it belongs to. */
export function remarkPlace(remark: PullRequestRemark): string {
  if (remark.path) return remark.line ? `${remark.path}:${remark.line}` : remark.path;
  return remark.changes ? "Relecture · changements demandés" : "Relecture";
}

type Loaded = { remarks: PullRequestRemark[]; picked: Set<string> };

/**
 * The pull request's open review remarks, read from GitHub when asked: the user picks those
 * worth sending, and the agent gets them as words of others to check, not as orders.
 */
export function PrRemarks(props: { threadId: string; busy: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const read = async () => {
    setReading(true);
    setError(null);
    setSent(null);
    try {
      const reply = await connection.ask({
        type: "workspace.prRemarks",
        requestId: newId(),
        threadId: props.threadId,
      });
      if (reply.error) setError(reply.error);
      setLoaded({ remarks: reply.remarks, picked: new Set(reply.remarks.map((r) => r.id)) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const send = async () => {
    if (!loaded?.picked.size) return;
    setSending(true);
    setError(null);
    try {
      await connection.request({
        type: "workspace.sendRemarks",
        requestId: newId(),
        threadId: props.threadId,
        ids: [...loaded.picked],
      });
      setSent(loaded.picked.size);
      setLoaded(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const pick = (id: string, on: boolean) =>
    setLoaded((now) => {
      if (!now) return now;
      const picked = new Set(now.picked);
      if (on) picked.add(id);
      else picked.delete(id);
      return { ...now, picked };
    });

  if (!loaded) {
    return (
      <div className="prrm">
        <button className="btn sm" disabled={reading} onClick={() => void read()}>
          {reading ? "Lecture sur GitHub…" : "Remarques de relecture"}
        </button>
        {sent !== null && (
          <span className="prrm-note" role="status">
            {sent > 1 ? `${sent} remarques envoyées à l'agent.` : "Remarque envoyée à l'agent."}
          </span>
        )}
        {error && <span className="prrm-err">{error}</span>}
      </div>
    );
  }

  const count = loaded.picked.size;
  return (
    <div className="prrm prrm-open" aria-label="Remarques de relecture">
      <div className="prrm-h">
        <b>Remarques de relecture</b>
        <button className="btn quiet sm" disabled={reading} onClick={() => void read()}>
          {reading ? "…" : "Actualiser"}
        </button>
        <button className="btn quiet sm" onClick={() => setLoaded(null)}>
          Fermer
        </button>
      </div>
      {error && <p className="prrm-err">{error}</p>}
      {!loaded.remarks.length && !error && (
        <p className="prrm-note">Aucune remarque ouverte sur GitHub.</p>
      )}
      {loaded.remarks.length > 0 && (
        <ul className="prrm-list">
          {loaded.remarks.map((remark) => (
            <li key={remark.id}>
              <label>
                <input
                  type="checkbox"
                  checked={loaded.picked.has(remark.id)}
                  onChange={(e) => pick(remark.id, e.target.checked)}
                />
                <span className="prrm-t">
                  <span className="prrm-w">
                    <b>@{remark.author}</b>
                    <span>{remarkPlace(remark)}</span>
                  </span>
                  <span className="prrm-b">{remark.body}</span>
                </span>
              </label>
              {remark.url && (
                <a href={remark.url} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {loaded.remarks.length > 0 && (
        <div className="prrm-f">
          <span className="prrm-note">
            {props.busy
              ? "L'agent travaille : tu pourras envoyer quand il aura fini."
              : "L'agent les vérifie dans le code et corrige ce qui est fondé."}
          </span>
          <button
            className="btn pri sm"
            disabled={!count || props.busy || sending}
            onClick={() => void send()}
          >
            {sending ? "Envoi…" : `Envoyer à l'agent (${count})`}
          </button>
        </div>
      )}
    </div>
  );
}
