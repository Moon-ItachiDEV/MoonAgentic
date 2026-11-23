import {
  PR_WATCH_TRIES,
  type PrWatch,
  type PullRequestInfo,
  type Thread,
} from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { prStates } from "../pr-states.ts";
import {
  checksSummary,
  mergeBlocker,
  mergeWarning,
  STATE_LABEL,
  watchLabel,
} from "../pull-request.ts";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";

/** How often GitHub is asked again while an open pull request is on screen. */
const REFRESH_MS = 20_000;

/** A link to a pull request, drawn as GitHub draws it and colored by its real state. */
export function PrChip({ pr }: { pr: Pick<PullRequestInfo, "url" | "number" | "state"> }) {
  return (
    <a
      className="prchip"
      data-state={pr.state}
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Pull request ${STATE_LABEL[pr.state]}`}
    >
      #{pr.number}
    </a>
  );
}

/**
 * The pull request of the thread's branch, as GitHub describes it: asked on opening, after
 * each push (`stamp` changes), then again every few seconds while it is open.
 */
export function usePullRequest(thread: Thread, stamp: unknown) {
  const [pr, setPr] = useState<PullRequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asking = useRef(false);
  const branch = thread.workspace?.base ? thread.workspace.branch : undefined;

  const take = useCallback((reply: { pr?: PullRequestInfo; error?: string }) => {
    setPr(reply.pr ?? null);
    setError(reply.error ?? null);
    if (reply.pr) prStates.learn(reply.pr.url, reply.pr.state);
  }, []);

  /** Set when asked again while an answer is on its way: that answer may already be stale. */
  const again = useRef(false);
  const refresh = useCallback(async () => {
    if (!branch) return;
    if (asking.current) {
      again.current = true;
      return;
    }
    asking.current = true;
    setLoading(true);
    try {
      do {
        again.current = false;
        const reply = await connection.ask({
          type: "workspace.pr",
          requestId: newId(),
          threadId: thread.id,
        });
        take(reply);
      } while (again.current);
    } catch {
      // no connection right now: what was last known stays, the next round asks again
    } finally {
      asking.current = false;
      setLoading(false);
    }
  }, [branch, thread.id, take]);

  useEffect(() => {
    setPr(null);
    setError(null);
  }, [thread.id]);
  useEffect(() => {
    void refresh();
  }, [refresh, stamp]);

  const live = pr?.state === "open" || pr?.state === "draft";
  useEffect(() => {
    if (!live) return;
    const again = () => document.visibilityState === "visible" && void refresh();
    const timer = setInterval(again, REFRESH_MS);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
    };
  }, [live, refresh]);

  const merge = useCallback(async () => {
    if (!pr) return;
    const reply = await connection.ask({
      type: "workspace.mergePr",
      requestId: newId(),
      threadId: thread.id,
      number: pr.number,
      head: pr.head,
    });
    if (reply.error) {
      // What GitHub refused is shown in the box; the state behind it is read again.
      void refresh();
      throw new Error(reply.error);
    }
    take(reply);
  }, [pr, thread.id, refresh, take]);

  return { pr, error, loading, refresh, merge };
}

function WatchRow(props: { watch: PrWatch | undefined; onWatch: (on: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = !!props.watch;
  return (
    <div className="rv-prs-w">
      <div className="rv-prs-wt">
        <b>Corriger tout seul</b>
        <span>{watchLabel(props.watch, PR_WATCH_TRIES)}</span>
        {(error ?? props.watch?.error) && (
          <span className="err">{error ?? `Envoi impossible : ${props.watch?.error}`}</span>
        )}
      </div>
      <button
        className={`set-sw${on ? " on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label="Corriger tout seul"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          props.onWatch(!on).then(
            () => setBusy(false),
            (e: unknown) => {
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      />
    </div>
  );
}

/** The state of the thread's pull request in the review panel: CI, conflicts, and the merge. */
export function PullRequestStatus(props: {
  pr: PullRequestInfo;
  loading: boolean;
  onRefresh: () => void;
  onMerge: () => Promise<void>;
  /** « Corriger tout seul » as it is now; left out while it is off. */
  watch?: PrWatch | undefined;
  /** Turns it on or off; left out where the thread cannot (a team's, one in the project folder). */
  onWatch?: ((on: boolean) => Promise<void>) | undefined;
}) {
  const { pr } = props;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const ci = checksSummary(pr.checks);
  const blocker = mergeBlocker(pr);
  const live = pr.state === "open" || pr.state === "draft";

  return (
    <div className="rv-prs" aria-label="Pull request">
      <div className="rv-prs-h">
        <PrChip pr={pr} />
        <span className="rv-prs-t" title={pr.title}>
          {pr.title}
        </span>
        <button className="btn quiet sm" disabled={props.loading} onClick={props.onRefresh}>
          {props.loading ? "…" : "Actualiser"}
        </button>
      </div>
      {live ? (
        <>
          <p className={`rv-prs-l ${ci.tone}`} role="status">
            <span className="rv-prs-dot" aria-hidden />
            {ci.label}
          </p>
          {ci.failed.length > 0 && (
            <ul className="rv-prs-f">
              {ci.failed.map((check, i) => (
                // Two workflows may each have a job of the same name.
                <li key={`${i}:${check.name}`}>
                  {check.url ? (
                    <a href={check.url} target="_blank" rel="noopener noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </li>
              ))}
            </ul>
          )}
          {pr.conflicts === false && pr.state === "open" && (
            <p className="rv-prs-l ok">
              <span className="rv-prs-dot" aria-hidden />
              Pas de conflit avec {pr.base}
            </p>
          )}
          {blocker && (
            <p className="rv-prs-l err">
              <span className="rv-prs-dot" aria-hidden />
              {blocker}
            </p>
          )}
          {props.onWatch && <WatchRow watch={props.watch} onWatch={props.onWatch} />}
          {pr.state === "open" && (
            <button
              className="btn sm rv-prs-m"
              disabled={!!blocker}
              onClick={() =>
                setConfirm({
                  title: `Merger la pull request #${pr.number} ?`,
                  text: mergeWarning(pr),
                  action: "Merger",
                  run: props.onMerge,
                })
              }
            >
              Merger la pull request
            </button>
          )}
        </>
      ) : (
        <p className="rv-prs-l none">
          {pr.state === "merged" ? `Mergée dans ${pr.base}.` : "Fermée sans être mergée."}
        </p>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
