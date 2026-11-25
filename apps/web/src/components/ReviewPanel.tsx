import type { ReviewFile, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { connection, newId, type Review } from "../connection.ts";
import {
  type DiffLine,
  findRow,
  type LineComment,
  parsePatch,
  placeComments,
  reviewMessage,
  rowPlace,
  withoutFile,
} from "../diff.ts";
import { baseName } from "../file-tree.ts";
import { conflictRequest, type Forecast, forecastLine } from "../forecast.ts";
import { readReviewDrafts, writeReviewDrafts } from "../review-drafts.ts";
import { Glyph, I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { WorktreeFiles } from "./WorktreeFiles.tsx";

const STATUS: Record<ReviewFile["status"], string | undefined> = {
  added: "nouveau",
  modified: undefined,
  deleted: "supprimé",
  renamed: "renommé",
};

/** Files that often hold secrets start unticked, so they never leave by accident. */
export function looksSecret(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  return (
    /^\.env($|\.)/.test(name) ||
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(name) ||
    /^(credentials|secrets?)(\.|$)/.test(name) ||
    name === ".npmrc" ||
    name === ".netrc"
  );
}

/** How long a sent review may take to start the agent before its remarks come back. */
const SEND_WAIT = 10_000;

const dirName = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

/** The remark being written: the line it goes on, found again by its code if lines move. */
type Editing = { id?: string; line: number; removed: boolean; code: string; text: string };

/** One changed file's numbered diff: each line is open to a remark for the agent. */
function FileDiff(props: {
  file: ReviewFile;
  canComment: boolean;
  /** This file's remarks, by row of its diff as it is now. */
  comments: Map<number, LineComment> | undefined;
  onComment: (comment: LineComment) => void;
  onRemove: (id: string) => void;
}) {
  const { file } = props;
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Found again on each render: a fresh diff moves the box with its line.
  const editRow = editing ? findRow(lines, editing) : -1;

  const edit = (line: DiffLine, row: number, comment: LineComment | undefined) => {
    if (editRow === row) return setEditing(null);
    const place = rowPlace(line);
    if (!place) return;
    setEditing({ id: comment?.id, ...place, code: line.text, text: comment?.text ?? "" });
  };

  const save = () => {
    if (!editing?.text.trim()) return;
    props.onComment({
      id: editing.id ?? newId(),
      path: file.path,
      line: editing.line,
      removed: editing.removed,
      code: editing.code,
      text: editing.text,
    });
    setEditing(null);
  };

  if (!file.patch)
    return <p className="pcw">{file.added === null ? "Fichier binaire" : "Rien à afficher"}</p>;
  return (
    <div className="dfc" role="table" aria-label={`Changements de ${file.path}`}>
      {lines.map((line, i) => {
        const key = `${i}:${line.kind}:${line.text}`;
        if (line.kind === "hunk" || line.kind === "note")
          return (
            <div key={key} className="dl hk" role="row">
              <span />
              <span />
              <span className="dt mono">{line.text}</span>
            </div>
          );
        const comment = props.comments?.get(i);
        const kind = line.kind === "add" ? " add" : line.kind === "del" ? " del" : "";
        return (
          <div key={key} className="dlg">
            <button
              className={`dl${kind}${editRow === i ? " sel" : ""}`}
              role="row"
              disabled={!props.canComment}
              title={props.canComment ? "Commenter cette ligne" : undefined}
              onClick={() => edit(line, i, comment)}
            >
              <span className="dn mono">{line.new ?? line.old ?? ""}</span>
              <span className="dk mono">
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
              </span>
              <span className="dt mono">{line.text || " "}</span>
            </button>
            {editing && editRow === i ? (
              <div className="dce">
                <textarea
                  className="rni dct"
                  autoFocus
                  rows={2}
                  aria-label="Commentaire pour l'agent"
                  placeholder="Ce que l'agent doit changer ici"
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      save();
                    }
                    if (e.key === "Escape") {
                      // Only the box closes: the sheet stays.
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
                <div className="dbt">
                  {comment && (
                    <button
                      className="b2 soft press"
                      onClick={() => {
                        props.onRemove(comment.id);
                        setEditing(null);
                      }}
                    >
                      Retirer
                    </button>
                  )}
                  <button className="b2 ink press" disabled={!editing.text.trim()} onClick={save}>
                    {comment ? "Modifier" : "Ajouter"}
                  </button>
                </div>
              </div>
            ) : (
              comment && (
                <button className="dcm" onClick={() => edit(line, i, comment)}>
                  <span className="ppill">
                    <I n="bubble" s={13} />
                    Toi
                  </span>
                  {comment.text}
                </button>
              )
            )}
          </div>
        );
      })}
      {file.truncated && (
        <div className="dl hk">
          <span />
          <span />
          <span className="dt mono">… diff coupé, trop long pour l'afficher</span>
        </div>
      )}
    </div>
  );
}

/**
 * « Modifications »: what the thread's agent changed on its branch. The files first, each
 * ticked or not for the commit; a file opens on its numbered diff, where any line takes a
 * remark, sent to the agent in one turn; then commit, push and pull request.
 */
export function ReviewPanel({
  open,
  thread,
  review,
  onClose,
}: {
  open: boolean;
  thread: Thread;
  review: Review | undefined;
  onClose: () => void;
}) {
  const files = review?.files;
  const workspace = thread.workspace;
  const running = thread.status === "running" || thread.status === "waiting";
  const [message, setMessage] = useState(thread.title);
  /** The tab shown: the branch's changes, or every file of its folder. */
  const [tab, setTab] = useState<"changes" | "files">("changes");
  /** The changed file whose diff is open, by path. */
  const [shown, setShown] = useState<string | null>(null);
  /** The file of the folder being read, by path. */
  const [reading, setReading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  /** Ticks the user changed, by path; the others follow `looksSecret`. */
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  // Kept on this device until they are sent: closing the sheet does not lose them.
  const [comments, setComments] = useState<LineComment[]>(() => readReviewDrafts(thread.id));
  useEffect(() => writeReviewDrafts(thread.id, comments), [thread.id, comments]);
  /** The remarks just sent, until the agent's turn starts; they come back if it does not. */
  const [sending, setSending] = useState<string[] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Where the branch stands against the one it started from, asked again after each turn. */
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Why the last merge or request to the agent did not go. */
  const [syncError, setSyncError] = useState<string | null>(null);
  const [asks, setAsks] = useState(0);
  const ticked = (f: ReviewFile) => ticks[f.path] ?? !looksSecret(f.path);
  const picked = files?.filter(ticked) ?? [];
  // Each remark found again on its file and line in the review as it is now.
  const placed = useMemo(() => placeComments(files, comments), [files, comments]);
  const remarks = placed.all;
  const lost = remarks.filter((c) => c.lost);
  const file = shown ? files?.find((f) => f.path === shown) : undefined;
  const hasFiles = !!workspace?.base && !thread.archived;

  // Opened again, it starts from its list.
  useEffect(() => {
    if (!open) return;
    setShown(null);
    setReading(null);
    setError(null);
  }, [open]);

  // The server holds the files; ask on opening, once the branch exists, whenever a
  // turn starts or ends, and on each change of tab: files written meanwhile show up.
  useEffect(() => {
    if (open) connection.send({ type: "workspace.review", threadId: thread.id });
  }, [open, thread.id, running, workspace?.base, tab]);

  const canForecast = !!workspace?.base && !!workspace.baseBranch && !thread.archived;
  useEffect(() => {
    if (!open || !canForecast || running) return;
    let live = true;
    connection.ask({ type: "workspace.forecast", requestId: newId(), threadId: thread.id }).then(
      (reply) => {
        if (!live) return;
        setForecast({ target: reply.target, behind: reply.behind, conflicts: reply.conflicts });
        setForecastError(null);
      },
      (e: unknown) => live && setForecastError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [open, thread.id, canForecast, running, workspace?.base, asks]);

  const refresh = () => {
    connection.send({ type: "workspace.review", threadId: thread.id });
    setAsks((n) => n + 1);
  };

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      await connection.request({ type: "workspace.sync", requestId: newId(), threadId: thread.id });
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  const askMerge = () => {
    if (!forecast || running) return;
    setSyncError(null);
    if (
      !connection.send({
        type: "thread.send",
        threadId: thread.id,
        text: conflictRequest(forecast),
      })
    )
      setSyncError("Pas de connexion au serveur");
    else onClose();
  };

  const rejectFile = async (f: ReviewFile) => {
    try {
      await connection.request({
        type: "workspace.rejectFile",
        requestId: newId(),
        threadId: thread.id,
        path: f.path,
        ...(f.from ? { from: f.from } : {}),
      });
      // Its remarks have nothing left to be about: they would reach the agent as lost.
      setComments((c) => withoutFile(c, f));
      setShown(null);
    } finally {
      refresh();
    }
  };

  const shipWith = async (pr: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await connection.request({
        type: "workspace.ship",
        requestId: newId(),
        threadId: thread.id,
        message: message.trim(),
        pr,
        // A rename goes with the path it had, so the old file leaves with the new one.
        files: picked.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])),
      });
      connection.send({ type: "workspace.review", threadId: thread.id });
      // The pull request has its card in the thread: the sheet has nothing more to say.
      connection.notify(pr ? "Branche poussée, pull request demandée" : "Branche poussée");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The agent's turn started: the remarks reached it and leave the list.
  useEffect(() => {
    if (!sending || !running) return;
    clearTimeout(sendTimer.current);
    const sent = new Set(sending);
    setComments((c) => c.filter((comment) => !sent.has(comment.id)));
    setSending(null);
  }, [sending, running]);
  useEffect(() => () => clearTimeout(sendTimer.current), []);

  const sendRemarks = () => {
    if (!remarks.length || running || sending) return;
    setSendError(null);
    const sent = connection.send({
      type: "thread.send",
      threadId: thread.id,
      text: reviewMessage(remarks),
    });
    if (!sent) {
      setSendError("Pas de connexion au serveur : tes commentaires sont gardés");
      return;
    }
    setSending(remarks.map((c) => c.id));
    // Refused by the server (the agent busy, the thread closed): nothing starts, and the
    // remarks stay here to send again.
    sendTimer.current = setTimeout(() => {
      setSending(null);
      setSendError("L'agent n'a pas démarré : tes commentaires sont gardés");
    }, SEND_WAIT);
    onClose();
  };

  const added = files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0;
  const removed = files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;
  // One change to the branch at a time: no push while it merges, and the other way round.
  const canShip = !busy && !syncing && !running && !!message.trim() && picked.length > 0;
  const canReject = !thread.archived && !running && !syncing && !busy;
  const sendBar = remarks.length > 0 && (
    <>
      <button
        className="b2 soft press"
        disabled={!!sending}
        onClick={() => {
          setComments([]);
          setSendError(null);
        }}
      >
        Effacer
      </button>
      <button
        className="b2 ink press"
        disabled={running || !!sending}
        title={running ? "L'agent travaille encore" : undefined}
        onClick={sendRemarks}
      >
        {sending ? "Envoi…" : `Envoyer à l'agent · ${remarks.length}`}
      </button>
    </>
  );

  const head = file
    ? { title: baseName(file.path), sub: dirName(file.path) || STATUS[file.status] }
    : reading
      ? { title: baseName(reading), sub: dirName(reading) }
      : { title: "Modifications" };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={head.title}
      {...(head.sub ? { sub: head.sub } : {})}
      {...(file || reading
        ? {
            onBack: () => {
              setShown(null);
              setReading(null);
            },
          }
        : {})}
      tall
      className="dsh"
    >
      {file ? (
        <>
          <div className="sbody dfb">
            {looksSecret(file.path) && <p className="pcw t-err">Peut contenir un secret</p>}
            <FileDiff
              key={file.path}
              file={file}
              canComment={!thread.archived}
              comments={placed.rows.get(file.path)}
              onComment={(comment) =>
                setComments((c) =>
                  c.some((x) => x.id === comment.id)
                    ? c.map((x) => (x.id === comment.id ? comment : x))
                    : [...c, comment],
                )
              }
              onRemove={(id) => setComments((c) => c.filter((x) => x.id !== id))}
            />
            {canReject && (
              <div className="mga drj">
                <button
                  className="b2 soft press"
                  aria-label={`Annuler les changements de ${file.path}`}
                  onClick={() =>
                    setConfirm({
                      title:
                        file.status === "added"
                          ? "Supprimer ce nouveau fichier ?"
                          : "Remettre ce fichier comme au départ de la branche ?",
                      text: "Ses changements seront perdus, même ceux déjà commités.",
                      action: "Annuler les changements",
                      run: () => rejectFile(file),
                    })
                  }
                >
                  Annuler les changements
                </button>
              </div>
            )}
          </div>
          {sendBar && <div className="dbar">{sendBar}</div>}
        </>
      ) : (
        <div className="sbody">
          {workspace && !reading && (
            <div className="dsum">
              <span className="mono">{workspace.branch}</span>
              {!!files?.length && (
                <>
                  <span className="dpl">+{added}</span>
                  <span className="dmi">−{removed}</span>
                </>
              )}
            </div>
          )}
          {hasFiles && !reading && (
            <div className="ovtabs dtabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === "changes"}
                onClick={() => setTab("changes")}
              >
                Modifications
                {!!files?.length && <span className="cnt">{files.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
                Fichiers
              </button>
            </div>
          )}
          {canForecast && !reading && (forecastError || (forecast && forecast.behind > 0)) && (
            <div className="dsy" role="status">
              <span
                className="tx"
                title={forecast?.conflicts.length ? forecast.conflicts.join("\n") : undefined}
              >
                {forecastError ?? (forecast && forecastLine(forecast))}
              </span>
              {forecast &&
                forecast.behind > 0 &&
                (forecast.conflicts.length ? (
                  <button
                    className="b2 soft press"
                    disabled={running || syncing || busy}
                    title={running ? "L'agent travaille encore" : undefined}
                    onClick={askMerge}
                  >
                    Demander à l'agent
                  </button>
                ) : (
                  <button
                    className="b2 soft press"
                    disabled={running || syncing || busy}
                    title={running ? "L'agent travaille encore" : undefined}
                    onClick={() => void sync()}
                  >
                    {syncing ? "Synchronisation…" : "Synchroniser"}
                  </button>
                ))}
            </div>
          )}
          {syncError && <p className="pcw t-err">{syncError}</p>}
          {tab === "files" && hasFiles ? (
            <WorktreeFiles
              thread={thread}
              files={files}
              path={reading}
              onRead={setReading}
              onShowChange={(path) => {
                setTab("changes");
                setReading(null);
                setShown(path);
              }}
            />
          ) : !workspace?.base ? (
            <p className="pcw">La branche sera créée au démarrage de l'agent</p>
          ) : review?.error ? (
            <p className="pcw t-err">Impossible de lire les changements : {review.error}</p>
          ) : !files ? (
            <p className="pcw">
              <span className="shimmer">Lecture des changements…</span>
            </p>
          ) : files.length === 0 ? (
            <p className="pcw">Rien n'a changé sur cette branche</p>
          ) : (
            <>
              <div className="ins">
                {files.map((f) => {
                  const on = ticked(f);
                  const notes = placed.rows.get(f.path)?.size ?? 0;
                  const where = [dirName(f.path), STATUS[f.status]].filter(Boolean).join(" · ");
                  return (
                    <div key={f.path} className="it dfr">
                      <button
                        className={`tick${on ? " on" : ""}`}
                        role="checkbox"
                        aria-checked={on}
                        aria-label={`Envoyer ${f.path}`}
                        title={on ? "Part avec le commit" : "Reste en dehors du commit"}
                        onClick={() => setTicks((t) => ({ ...t, [f.path]: !on }))}
                      >
                        {on && <I n="check" s={13} />}
                      </button>
                      <button
                        className="dfo"
                        title={f.from ? `${f.from} → ${f.path}` : f.path}
                        onClick={() => setShown(f.path)}
                      >
                        <span className="tx">
                          {baseName(f.path)}
                          {looksSecret(f.path) ? (
                            <small className="mer">Peut contenir un secret</small>
                          ) : (
                            where && <small className="mono">{where}</small>
                          )}
                        </span>
                        {notes > 0 && <span className="cnt w">{notes}</span>}
                        {f.added === null ? (
                          <span className="dfd">binaire</span>
                        ) : (
                          <>
                            <span className="dpl">+{f.added}</span>
                            {!!f.removed && <span className="dmi">−{f.removed}</span>}
                          </>
                        )}
                        <I n="right" s={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
              {files.length > 1 && (
                <button
                  className="rvw"
                  onClick={() => {
                    const all = picked.length < files.length;
                    setTicks(Object.fromEntries(files.map((f) => [f.path, all])));
                  }}
                >
                  {picked.length < files.length
                    ? `Tout cocher · ${picked.length} sur ${files.length}`
                    : "Tout décocher"}
                </button>
              )}
              {!!review?.omitted && (
                <p className="pcw">{review.omitted} autres fichiers non listés</p>
              )}
              {lost.map((c) => (
                <div key={c.id} className="dcm lost" role="status">
                  <span className="ppill">
                    Ligne changée · {baseName(c.path)}:{c.line}
                  </span>
                  {c.text}
                  <button
                    className="b2 soft press"
                    disabled={!!sending}
                    onClick={() => setComments((all) => all.filter((x) => x.id !== c.id))}
                  >
                    Retirer
                  </button>
                </div>
              ))}
              {sendError && <p className="pcw t-err">{sendError}</p>}
              {error && <p className="pcw t-err">{error}</p>}
              {sendBar ? (
                <div className="dbar in">{sendBar}</div>
              ) : (
                <div className="dship">
                  {running && (
                    <span className="ppill">
                      <Glyph />
                      L'agent travaille
                    </span>
                  )}
                  <input
                    className="rni"
                    aria-label="Message de commit"
                    placeholder="Message de commit"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <div className="dbt">
                    <button
                      className="b2 soft press"
                      disabled={!canShip}
                      onClick={() => void shipWith(false)}
                    >
                      Commit et push
                    </button>
                    <button
                      className="b2 ink press"
                      disabled={!canShip}
                      onClick={() => void shipWith(true)}
                    >
                      Commit et PR
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </Sheet>
  );
}
