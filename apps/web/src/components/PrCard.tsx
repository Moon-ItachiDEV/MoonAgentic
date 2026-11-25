import {
  PR_WATCH_TRIES,
  type PullRequestInfo,
  type PullRequestRemark,
  type Thread,
} from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { canMerge, conflictFixRequest, fixCiRequest, type PrStep, prSteps } from "../pr-board.ts";
import { remarkPlace, watchLabel, watchShort } from "../pull-request.ts";
import { usePullRequest } from "../use-pull-request.ts";
import { Glyph, I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";

const STEP_CLASS: Record<PrStep["state"], string> = {
  done: "d",
  failed: "x",
  running: "c",
  yours: "a",
  next: "p",
};

function Step({ step }: { step: PrStep }) {
  const label = step.url ? (
    <a href={step.url} target="_blank" rel="noopener noreferrer">
      {step.label}
    </a>
  ) : (
    <span>{step.label}</span>
  );
  return (
    <div className={`stp ${STEP_CLASS[step.state]}`}>
      <i>
        {step.state === "done" ? (
          <I n="okc" s={18} />
        ) : step.state === "failed" ? (
          <I n="errc" s={18} />
        ) : step.state === "running" ? (
          <b className="sp" />
        ) : (
          <b className="ring" />
        )}
      </i>
      {label}
      {step.state === "running" ? (
        <span className="tm">en cours</span>
      ) : step.tag ? (
        <span className={step.state === "failed" ? "errp" : "tg"}>{step.tag.text}</span>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Asks before the merge: what goes where, and what GitHub said of it. */
export function MergeSheet(props: {
  open: boolean;
  pr: PullRequestInfo;
  onMerge: () => Promise<void>;
  onClose: () => void;
}) {
  const { pr } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) setError(null);
  }, [props.open]);
  const passed = pr.checks.filter((c) => c.state === "passed").length;
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onMerge();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={props.open}
      onClose={() => !busy && props.onClose()}
      title={`Fusionner la PR #${pr.number}`}
      modal={busy}
    >
      <div className="sbody">
        <div className="mgs">
          <div className="mgl">
            <span className="mono">{pr.head}</span>
            <I n="right" s={14} />
            <span className="mono">{pr.base}</span>
          </div>
          <div className="mgk">
            {passed > 0 && (
              <span className="okp">
                {passed} {passed > 1 ? "checks verts" : "check vert"}
              </span>
            )}
            {pr.conflicts === false && <span className="okp">Sans conflit</span>}
          </div>
        </div>
        {error && <p className="pcw t-err">{error}</p>}
        <div className="mga">
          <button className="b2 ink press" disabled={busy} onClick={() => void merge()}>
            {busy ? <span className="t2-spin" /> : <I n="merge" s={17} />}
            {busy ? "Fusion…" : "Fusionner"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

type Remarks = { list: PullRequestRemark[]; sent: Set<string> };

/**
 * The pull request's open review remarks, as GitHub has them: each one can go to the agent,
 * which gets them as words of others to check, not as orders.
 */
function RemarksSheet(props: {
  open: boolean;
  pr: PullRequestInfo;
  loaded: Remarks | null;
  error: string | null;
  /** The agent is at work: nothing can be sent to it now. */
  busy: boolean;
  onSend: (ids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { loaded, error } = props;
  const [sending, setSending] = useState(false);
  const waiting = loaded?.list.filter((r) => !loaded.sent.has(r.id)) ?? [];
  const send = (ids: string[]) => {
    if (!ids.length || sending) return;
    setSending(true);
    void props.onSend(ids).finally(() => setSending(false));
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title={`Remarques · #${props.pr.number}`} tall>
      <div className="sbody">
        {error && <p className="pcw t-err">{error}</p>}
        {!loaded && !error && (
          <p className="pcw">
            <span className="shimmer">Lecture sur GitHub…</span>
          </p>
        )}
        {loaded && !loaded.list.length && !error && <p className="pcw">Aucune remarque ouverte</p>}
        {loaded?.list.map((remark) => {
          const sent = loaded.sent.has(remark.id);
          return (
            <div key={remark.id} className={`rmc ${sent ? "sent" : "open"}`}>
              <div className="rmh">
                <b>{remark.author}</b>
                {remark.url && (
                  <a
                    href={remark.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Voir sur GitHub"
                  >
                    <I n="ext" s={12} />
                  </a>
                )}
                <span className="mono">{remarkPlace(remark)}</span>
              </div>
              <p>{remark.body}</p>
              <div className="rma">
                {sent ? (
                  <span className="ppill">
                    <Glyph />
                    Chez l'agent
                  </span>
                ) : (
                  <button
                    className="b2 ink press"
                    disabled={props.busy || sending}
                    onClick={() => send([remark.id])}
                  >
                    <I n="up" s={15} />
                    Envoyer à l'agent
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {waiting.length > 1 && (
          <div className="mga">
            <button
              className="b2 ink press"
              disabled={props.busy || sending}
              onClick={() => send(waiting.map((r) => r.id))}
            >
              Tout envoyer à l'agent · {waiting.length}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/**
 * The pull request of the thread's branch, in the thread itself: its steps as GitHub tells
 * them, the remarks left on it, then what is the user's to do. Nothing is shown without one.
 */
export function PrCard({ thread }: { thread: Thread }) {
  const workspace = thread.workspace;
  const running = thread.status === "running" || thread.status === "waiting";
  // Asked again when a turn ends and after each push from here: both may open or move it.
  const pull = usePullRequest(
    thread,
    `${running}:${workspace?.prUrl ?? ""}:${workspace?.prOpened ?? ""}`,
  );
  const { pr } = pull;
  const [merging, setMerging] = useState(false);
  const [remarks, setRemarks] = useState(false);
  const [loaded, setLoaded] = useState<Remarks | null>(null);
  const [remarksError, setRemarksError] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The remarks left on it are read with it, again when a turn ends, and on opening their
  // sheet: the count on the card is GitHub's, never a guess.
  const threadId = thread.id;
  const open = (pr?.state === "open" || pr?.state === "draft") && !!workspace?.base;
  useEffect(() => {
    if (!open) return;
    let live = true;
    connection.ask({ type: "workspace.prRemarks", requestId: newId(), threadId }).then(
      (reply) => {
        if (!live) return;
        setRemarksError(reply.error ?? null);
        setLoaded((now) => ({ list: reply.remarks, sent: now?.sent ?? new Set() }));
      },
      (e: unknown) => live && setRemarksError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [open, threadId, running, remarks]);

  if (!pr) {
    // Pushed from here with a page to open the pull request, which GitHub does not know yet.
    if (!workspace?.prUrl || thread.archived) return null;
    return (
      <div className="prk" role="region" aria-label="Pull request">
        <div className="prh">
          <span className="prb mono">{workspace.branch}</span>
        </div>
        <div className="pra">
          <a className="b2 soft press" href={workspace.prUrl} target="_blank" rel="noreferrer">
            <I n="gh" s={16} />
            {workspace.prOpened ? "Voir la PR" : "Créer la PR sur GitHub"}
          </a>
        </div>
      </div>
    );
  }

  const live = pr.state === "open" || pr.state === "draft";
  const failed = pr.checks.some((c) => c.state === "failed");
  const canAsk = live && !running && !thread.archived;
  const canWatch = live && !!workspace?.base && !thread.team && !thread.role && !thread.parentId;
  const watching = !!thread.prWatch;
  const watchNote = thread.prWatch?.error
    ? `Envoi impossible : ${thread.prWatch.error}`
    : watchShort(thread.prWatch);

  const ask = (text: string) => {
    setError(null);
    if (!connection.send({ type: "thread.send", threadId: thread.id, text }))
      setError("Pas de connexion au serveur");
  };
  const sendRemarks = async (ids: string[]) => {
    setRemarksError(null);
    try {
      await connection.request({
        type: "workspace.sendRemarks",
        requestId: newId(),
        threadId,
        ids,
      });
      setLoaded((now) => now && { ...now, sent: new Set([...now.sent, ...ids]) });
    } catch (e) {
      setRemarksError(e instanceof Error ? e.message : String(e));
    }
  };
  const waiting = loaded?.list.filter((r) => !loaded.sent.has(r.id)).length ?? 0;
  const atAgent = loaded?.list.filter((r) => loaded.sent.has(r.id)).length ?? 0;
  const watch = () => {
    setWatchBusy(true);
    setError(null);
    connection
      .request({ type: "thread.watchPr", requestId: newId(), threadId: thread.id, on: !watching })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setWatchBusy(false));
  };

  return (
    <div className="prk" role="region" aria-label="Pull request">
      <div className="prh">
        <a className="prn mono" href={pr.url} target="_blank" rel="noopener noreferrer">
          <I n="gh" s={14} />#{pr.number}
          <I n="ext" s={12} />
        </a>
        <span className="prb mono">{pr.head}</span>
      </div>
      <b className="prt">{pr.title}</b>
      <div className="plan">
        {prSteps(pr).map((step) => (
          <Step key={step.key} step={step} />
        ))}
      </div>
      {canWatch && (
        <div className="prm prw">
          <I n="wrench" s={17} />
          <span className="tx">Corriger tout seul</span>
          {watchNote && (
            <small className={thread.prWatch?.error || thread.prWatch?.exhausted ? "mer" : ""}>
              {watchNote}
            </small>
          )}
          <button
            className={`tog${watching ? " on" : ""}`}
            role="switch"
            aria-checked={watching}
            aria-label="Corriger tout seul"
            title={watchLabel(thread.prWatch, PR_WATCH_TRIES)}
            disabled={watchBusy}
            onClick={watch}
          />
        </div>
      )}
      {live && !!workspace?.base && (
        <button className="prm" onClick={() => setRemarks(true)}>
          <I n="bubble" s={17} />
          <span className="tx">Remarques</span>
          {atAgent > 0 && (
            <span className="ppill rmk">
              <Glyph />
              {atAgent} chez l'agent
            </span>
          )}
          {waiting > 0 && <span className="cnt w">{waiting}</span>}
          <I n="right" s={15} />
        </button>
      )}
      {error && <p className="pcw t-err">{error}</p>}
      {(canMerge(pr) || (canAsk && (failed || pr.conflicts))) && (
        <div className="pra">
          {canAsk && failed && (
            <button className="b2 soft press" onClick={() => ask(fixCiRequest(pr))}>
              <I n="wrench" s={17} />
              Demander une correction
            </button>
          )}
          {canAsk && !failed && pr.conflicts && (
            <button className="b2 soft press" onClick={() => ask(conflictFixRequest(pr))}>
              <I n="wrench" s={17} />
              Résoudre le conflit
            </button>
          )}
          {canMerge(pr) && (
            <button className="b2 ink press" onClick={() => setMerging(true)}>
              <I n="merge" s={17} />
              Fusionner
            </button>
          )}
        </div>
      )}
      <MergeSheet open={merging} pr={pr} onMerge={pull.merge} onClose={() => setMerging(false)} />
      <RemarksSheet
        open={remarks}
        pr={pr}
        loaded={loaded}
        error={remarksError}
        busy={running}
        onSend={sendRemarks}
        onClose={() => setRemarks(false)}
      />
    </div>
  );
}
