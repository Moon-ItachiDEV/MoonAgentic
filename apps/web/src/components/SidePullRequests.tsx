import type { Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connection } from "../connection.ts";
import { canMerge, conflictFixRequest, fixCiRequest, prBoard, type PrRow } from "../pr-board.ts";
import { mergeWarning } from "../pull-request.ts";
import { readPref, writePref } from "../prefs.ts";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  IconChevron,
  IconErrCircle,
  IconMerge,
  IconPullRequest,
  IconWarnTri,
  IconWrench,
} from "./icons.tsx";
import { PrBadge, PrTimeline } from "./PrTimeline.tsx";
import { usePullRequest } from "./PullRequestStatus.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

/** At most this many lines; the rest behind « Voir plus ». */
const SHOWN = 5;

function RowMark({ row }: { row: PrRow }) {
  // The thread's agent at work on it: its glyph, live.
  if (row.thread.status === "running")
    return <StateGlyph kind="travaille" size={16} label="Un agent y travaille" />;
  switch (row.kind) {
    case "failed":
      return (
        <span className="spr-ic err">
          <IconErrCircle size={16} />
        </span>
      );
    case "conflict":
    case "blocked":
      return (
        <span className="spr-ic warn">
          <IconWarnTri size={16} />
        </span>
      );
    case "pending":
      return (
        <span className="spr-ic">
          <i className="t2-spin" />
        </span>
      );
    case "ready":
      return (
        <span className="spr-ic num" aria-label={`À fusionner en ${row.order}`}>
          {row.order}
        </span>
      );
    case "draft":
      return (
        <span className="spr-ic faint">
          <IconPullRequest size={15} />
        </span>
      );
  }
}

/**
 * The open pull requests of the threads, between the projects and the subscriptions: those
 * that need the user first, ready ones numbered in the order to merge them. A line opens its
 * card beside the side bar, with its steps and what can be done from here.
 */
export function SidePullRequests(props: { threads: Thread[]; onOpenThread: (id: string) => void }) {
  const board = prBoard(props.threads);
  const [open, setOpen] = useState(() => readPref("prsOpen") !== "false");
  const [all, setAll] = useState(false);
  const [mergedOpen, setMergedOpen] = useState(false);
  const [picked, setPicked] = useState<{ id: string; top: number; left: number } | null>(null);
  const pickedRow = board.rows.find((r) => r.thread.id === picked?.id);
  if (!board.rows.length && !board.merged.length) return null;
  const rows = all ? board.rows : board.rows.slice(0, SHOWN);

  return (
    <div className="spr">
      <div className="sec-h spr-h">
        <button
          className={`spr-fold${open ? "" : " shut"}`}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            writePref("prsOpen", String(!open));
          }}
        >
          <span>Pull requests</span>
          <span className="spr-live" title="Lu sur GitHub, mis à jour en continu" />
        </button>
        <span className="spr-cts">
          {board.red > 0 && (
            <span className="r" title={`${board.red} à corriger`}>
              {board.red}
            </span>
          )}
          {board.green > 0 && (
            <span
              className="g"
              title={`${board.green} prête${board.green > 1 ? "s" : ""} à fusionner`}
            >
              {board.green}
            </span>
          )}
        </span>
        <button
          className={`spr-chev${open ? "" : " shut"}`}
          aria-label={open ? "Replier les pull requests" : "Déplier les pull requests"}
          onClick={() => {
            setOpen(!open);
            writePref("prsOpen", String(!open));
          }}
        >
          <IconChevron size={13} />
        </button>
      </div>
      {open && (
        <>
          {rows.map((r) => (
            <button
              key={r.thread.id}
              className={`spr-row${picked?.id === r.thread.id ? " on" : ""}`}
              aria-haspopup="dialog"
              aria-expanded={picked?.id === r.thread.id}
              onClick={(e) => {
                if (picked?.id === r.thread.id) return setPicked(null);
                const side = e.currentTarget.closest(".side")?.getBoundingClientRect();
                setPicked({
                  id: r.thread.id,
                  top: e.currentTarget.getBoundingClientRect().top,
                  left: (side?.right ?? 0) + 12,
                });
              }}
            >
              <RowMark row={r} />
              <span className="spr-b">
                <span className="spr-t">
                  <span>{r.thread.title}</span>
                  <i>#{r.pr.number}</i>
                </span>
                <small className={r.tone}>
                  {r.thread.status === "running" ? "Un agent y travaille" : r.note}
                </small>
              </span>
            </button>
          ))}
          {board.rows.length > SHOWN && (
            <button className="more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Voir moins" : `Voir plus (${board.rows.length - SHOWN})`}
            </button>
          )}
          {board.merged.length > 0 && (
            <>
              <button
                className={`spr-merged${mergedOpen ? " open" : ""}`}
                aria-expanded={mergedOpen}
                onClick={() => setMergedOpen(!mergedOpen)}
              >
                <span className="mg">
                  <IconMerge size={15} />
                </span>
                Fusionnées aujourd'hui · {board.merged.length}
                <IconChevron size={13} />
              </button>
              {mergedOpen &&
                board.merged.map((t) => (
                  <a
                    key={t.id}
                    className="spr-row merged"
                    href={t.pr!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="spr-ic mg">
                      <IconMerge size={15} />
                    </span>
                    <span className="spr-b">
                      <span className="spr-t">
                        <span>{t.title}</span>
                        <i>#{t.pr!.number}</i>
                      </span>
                    </span>
                  </a>
                ))}
            </>
          )}
        </>
      )}
      {pickedRow &&
        picked &&
        createPortal(
          <PrCard
            row={pickedRow}
            top={picked.top}
            left={picked.left}
            onClose={() => setPicked(null)}
            onOpenThread={(id) => {
              setPicked(null);
              props.onOpenThread(id);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/** A pull request's card beside the side bar; a sheet from the bottom on a phone. */
function PrCard(props: {
  row: PrRow;
  top: number;
  left: number;
  onClose: () => void;
  onOpenThread: (id: string) => void;
}) {
  const { thread } = props.row;
  const { pr, error, merge } = usePullRequest(thread, thread.pr);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Element;
      if (ref.current?.contains(target) || target.closest(".spr-row, .dialog, .scrim")) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !confirm && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose, confirm]);

  // As high as its line, kept inside the window and, when there is room, above the composer.
  const [top, setTop] = useState(props.top);
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const floor =
      dock && dock.top - 12 - 16 >= box.height ? dock.top - 12 : window.innerHeight - 16;
    setTop(Math.max(16, Math.min(props.top - 12, floor - box.height)));
  }, [props.top, pr]);

  const ask = (text: string) => {
    setSendError(null);
    if (!connection.send({ type: "thread.send", threadId: thread.id, text })) {
      setSendError("Pas de connexion au serveur.");
      return;
    }
    props.onOpenThread(thread.id);
  };
  const busy = thread.status === "running";
  const failed = pr?.checks.some((c) => c.state === "failed");

  return (
    <>
      <div
        ref={ref}
        className="prc"
        role="dialog"
        aria-label={`Pull request #${props.row.pr.number}`}
        style={{ "--top": `${top}px`, "--left": `${props.left}px` } as React.CSSProperties}
      >
        <PrBadge pr={props.row.pr} branch={thread.workspace?.branch} />
        <h3>{pr?.title ?? thread.title}</h3>
        {pr ? <PrTimeline pr={pr} /> : <p className="prc-wait">{error ?? "Lecture sur GitHub…"}</p>}
        {sendError && <p className="prc-err">{sendError}</p>}
        {pr && (
          <div className="prc-acts">
            {failed && !busy && (
              <button className="btn acc" onClick={() => ask(fixCiRequest(pr))}>
                <IconWrench size={15} />
                Corriger la CI
              </button>
            )}
            {!failed && pr.conflicts && !busy && (
              <button className="btn acc" onClick={() => ask(conflictFixRequest(pr))}>
                <IconWrench size={15} />
                Résoudre le conflit
              </button>
            )}
            {canMerge(pr) && (
              <button
                className="btn pri"
                onClick={() =>
                  setConfirm({
                    title: `Fusionner la pull request #${pr.number} ?`,
                    text: mergeWarning(pr),
                    action: "Fusionner",
                    run: merge,
                  })
                }
              >
                <IconMerge size={15} />
                Fusionner
              </button>
            )}
            <button className="btn" onClick={() => props.onOpenThread(thread.id)}>
              Ouvrir le fil
            </button>
          </div>
        )}
      </div>
      {/* Beside the card, not in it: the dialog stacks above the side bar on its own. */}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
