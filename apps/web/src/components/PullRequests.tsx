import type { Thread } from "@moonagentic/protocol";
import { useState } from "react";
import { connection } from "../connection.ts";
import {
  canMerge,
  conflictFixRequest,
  fixCiRequest,
  prBoard,
  type PrRow,
  prSteps,
} from "../pr-board.ts";
import { mergeWarning } from "../pull-request.ts";
import { Glyph, I } from "../v2/I.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { usePullRequest } from "./PullRequestStatus.tsx";

const STEP_CLASS = { done: "ok", failed: "err", running: "run", yours: "cur", next: "" } as const;

/** One open pull request: where it stands on GitHub, read live, and what can be done from here. */
function Card(props: { row: PrRow; onOpenThread: (id: string) => void }) {
  const { row } = props;
  const { thread } = row;
  const { pr, error, merge } = usePullRequest(thread, thread.pr);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = thread.status === "running";
  const failed = pr?.checks.some((c) => c.state === "failed");

  const ask = (text: string) => {
    setSendError(null);
    if (!connection.send({ type: "thread.send", threadId: thread.id, text })) {
      setSendError("Pas de connexion au serveur");
      return;
    }
    props.onOpenThread(thread.id);
  };

  return (
    <div className="prc2" data-kind={row.kind}>
      <div className="prh">
        <a className="prn" href={row.pr.url} target="_blank" rel="noopener noreferrer">
          #{row.pr.number}
        </a>
        {busy ? (
          <span className="wkp">
            <Glyph />
            Un agent y travaille
          </span>
        ) : row.kind === "ready" ? (
          <span className="okp">Prête à fusionner</span>
        ) : row.kind === "failed" ? (
          <span className="errp">Checks en échec</span>
        ) : row.kind === "conflict" ? (
          <span className="errp">Conflit</span>
        ) : row.kind === "blocked" ? (
          <span className="errp">Bloquée</span>
        ) : row.kind === "pending" ? (
          <span className="wkp">
            <i className="t2-spin" />
            Vérifications en cours
          </span>
        ) : (
          <span className="ppill">Brouillon</span>
        )}
      </div>
      <b className="sct">{pr?.title ?? thread.title}</b>
      {thread.workspace?.branch && (
        <span className="mono prb">
          <I n="branch" s={12} />
          {thread.workspace.branch}
        </span>
      )}
      {pr ? (
        <div className="steps">
          {prSteps(pr).map((s) =>
            s.url ? (
              <a
                key={s.key}
                className={`stp2 ${STEP_CLASS[s.state]}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <i />
                {s.label}
              </a>
            ) : (
              <span key={s.key} className={`stp2 ${STEP_CLASS[s.state]}`}>
                <i />
                {s.label}
              </span>
            ),
          )}
        </div>
      ) : (
        <p className="pcw">{error ?? "Lecture sur GitHub…"}</p>
      )}
      {(row.kind === "ready" || sendError) && <p className="pcw">{sendError ?? row.note}</p>}
      <div className="rqa">
        <button className="b2 soft press" onClick={() => props.onOpenThread(thread.id)}>
          Ouvrir le fil
        </button>
        {pr && failed && !busy && (
          <button className="b2 ink press" onClick={() => ask(fixCiRequest(pr))}>
            Demander de corriger
          </button>
        )}
        {pr && !failed && pr.conflicts && !busy && (
          <button className="b2 ink press" onClick={() => ask(conflictFixRequest(pr))}>
            Résoudre le conflit
          </button>
        )}
        {pr && canMerge(pr) && (
          <button
            className="b2 ink press"
            onClick={() =>
              setConfirm({
                title: `Fusionner la pull request #${pr.number} ?`,
                text: mergeWarning(pr),
                action: "Fusionner",
                run: merge,
              })
            }
          >
            Fusionner
          </button>
        )}
      </div>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/**
 * « Pull requests »: the open pull requests of the threads, those that need the user first,
 * each with its steps as GitHub gives them; then the ones merged today.
 */
export function PullRequests(props: { threads: Thread[]; onOpenThread: (id: string) => void }) {
  const board = prBoard(props.threads);
  const [tab, setTab] = useState<"open" | "merged">("open");
  return (
    <div className="view" id="view">
      <div className="ovtabs" role="tablist" aria-label="Pull requests">
        <button role="tab" aria-selected={tab === "open"} onClick={() => setTab("open")}>
          Ouvertes · {board.rows.length}
        </button>
        <button role="tab" aria-selected={tab === "merged"} onClick={() => setTab("merged")}>
          Fusionnées
        </button>
      </div>
      {tab === "open" ? (
        board.rows.length ? (
          board.rows.map((r) => (
            <Card key={r.thread.id} row={r} onOpenThread={props.onOpenThread} />
          ))
        ) : (
          <div className="empty2">
            <span className="eic">
              <I n="check" s={24} />
            </span>
            <b>Aucune pull request ouverte</b>
          </div>
        )
      ) : board.merged.length ? (
        <div className="ins prm">
          {board.merged.map((t) => (
            <a key={t.id} className="it" href={t.pr!.url} target="_blank" rel="noopener noreferrer">
              <span className="ic mg">
                <I n="merge" s={17} />
              </span>
              <span className="tx">
                {t.title}
                <small>#{t.pr!.number} · fusionnée aujourd'hui</small>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="empty">
          <span className="ei">
            <I n="merge" s={24} />
          </span>
          <b>Aucune fusion aujourd'hui</b>
        </div>
      )}
      <div className="end" />
    </div>
  );
}
