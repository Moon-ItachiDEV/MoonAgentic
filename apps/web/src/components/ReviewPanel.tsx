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
import { conflictRequest, type Forecast, forecastLine } from "../forecast.ts";
import { readReviewDrafts, writeReviewDrafts } from "../review-drafts.ts";
import { IconBranch, IconCheck, IconChevron, IconUndo, IconX } from "./icons.tsx";
import { PullRequestStatus, usePullRequest } from "./PullRequestStatus.tsx";
import { WorktreeFiles } from "./WorktreeFiles.tsx";

const STATUS: Record<ReviewFile["status"], { letter: string; label: string }> = {
  added: { letter: "A", label: "nouveau" },
  modified: { letter: "M", label: "modifié" },
  deleted: { letter: "D", label: "supprimé" },
  renamed: { letter: "R", label: "renommé" },
};

/** Past this many diff lines in all, files open one by one instead of all at once. */
const OPEN_ALL_LINES = 400;

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

/** The remark being written: the line it goes on, found again by its code if lines move. */
type Editing = { id?: string; line: number; removed: boolean; code: string; text: string };

/** One changed file: its header with the tick, then its numbered diff, each line open to a remark. */
function FileCard(props: {
  file: ReviewFile;
  open: boolean;
  ticked: boolean;
  canComment: boolean;
  /** Its changes can be dropped now: the agent is not at work. */
  canReject: boolean;
  /** This file's remarks, by row of its diff as it is now. */
  comments: Map<number, LineComment> | undefined;
  onToggle: () => void;
  onTick: (ticked: boolean) => void;
  onComment: (comment: LineComment) => void;
  onRemove: (id: string) => void;
  onReject: () => Promise<void>;
}) {
  const { file } = props;
  const lines = useMemo(() => (props.open ? parsePatch(file.patch) : []), [props.open, file.patch]);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Found again on each render: a fresh diff moves the box with its line.
  const editRow = editing ? findRow(lines, editing) : -1;
  const status = STATUS[file.status];
  const secret = looksSecret(file.path);
  /** Asking before the changes go, then while they go. */
  const [rejecting, setRejecting] = useState<"ask" | "busy" | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const reject = async () => {
    setRejecting("busy");
    setRejectError(null);
    try {
      await props.onReject();
    } catch (e) {
      setRejectError(e instanceof Error ? e.message : String(e));
    } finally {
      setRejecting(null);
    }
  };

  const edit = (line: DiffLine, comment: LineComment | undefined) => {
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

  return (
    <section className={`rvf${props.open ? " open" : ""}`}>
      <header className="rvf-h">
        <button
          className="rvf-tg"
          aria-expanded={props.open}
          aria-label={props.open ? `Replier ${file.path}` : `Déplier ${file.path}`}
          onClick={props.onToggle}
        >
          <IconChevron />
        </button>
        <span className={`rvf-st st-${file.status}`} title={status.label}>
          {status.letter}
        </span>
        <span className="rvf-path" title={file.from ? `${file.from} → ${file.path}` : file.path}>
          {file.path}
        </span>
        {file.added === null ? (
          <span className="rvf-n">binaire</span>
        ) : (
          <span className="rvf-n">
            <span className="n-add">+{file.added}</span>{" "}
            <span className="n-del">−{file.removed}</span>
          </span>
        )}
        {props.canReject && (
          <button
            className="ib rvf-rj"
            aria-label={`Annuler les changements de ${file.path}`}
            title="Annuler les changements de ce fichier"
            disabled={rejecting !== null}
            onClick={() => setRejecting("ask")}
          >
            <IconUndo />
          </button>
        )}
        <input
          type="checkbox"
          checked={props.ticked}
          aria-label={`Envoyer ${file.path}`}
          title={props.ticked ? "Part avec le commit" : "Reste en dehors du commit"}
          onChange={(e) => props.onTick(e.target.checked)}
        />
      </header>
      {rejecting && (
        <div className="rvf-ask" role="alert">
          <span>
            {file.status === "added"
              ? "Supprimer ce nouveau fichier ? "
              : "Remettre ce fichier comme au départ de la branche ? "}
            Ses changements seront perdus, même ceux déjà commités.
          </span>
          <span className="grow" />
          <button
            className="btn quiet sm"
            disabled={rejecting === "busy"}
            onClick={() => setRejecting(null)}
          >
            Garder
          </button>
          <button
            className="btn danger sm"
            disabled={rejecting === "busy"}
            onClick={() => void reject()}
          >
            {rejecting === "busy" ? "Annulation…" : "Annuler les changements"}
          </button>
        </div>
      )}
      {rejectError && <p className="rvf-secret">{rejectError}</p>}
      {secret && (
        <p className="rvf-secret">Peut contenir un secret : coche-le seulement si tu en es sûr.</p>
      )}
      {props.open && file.patch && (
        <div className="rvd" role="table" aria-label={`Changements de ${file.path}`}>
          {lines.map((line, i) => {
            const key = `${i}:${line.kind}:${line.text}`;
            if (line.kind === "hunk" || line.kind === "note")
              return (
                <div key={key} className={`rvd-l ${line.kind}`} role="row">
                  <span className="rvd-t">{line.text}</span>
                </div>
              );
            const comment = props.comments?.get(i);
            const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
            return (
              <div key={key} className="rvd-g">
                <div
                  className={`rvd-l ${line.kind}${props.canComment ? " can" : ""}`}
                  role="row"
                  tabIndex={props.canComment ? 0 : undefined}
                  title={props.canComment ? "Commenter cette ligne" : undefined}
                  onClick={() => props.canComment && edit(line, comment)}
                  onKeyDown={(e) => {
                    if (props.canComment && e.key === "Enter") {
                      e.preventDefault();
                      edit(line, comment);
                    }
                  }}
                >
                  <span className="rvd-no">{line.old ?? ""}</span>
                  <span className="rvd-no">{line.new ?? ""}</span>
                  <span className="rvd-s">{sign}</span>
                  <span className="rvd-t">{line.text || " "}</span>
                </div>
                {editing && editRow === i ? (
                  <div className="rvc-edit">
                    <textarea
                      autoFocus
                      rows={2}
                      placeholder="Ce que l'agent doit changer ici"
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          save();
                        }
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setEditing(null);
                        }
                      }}
                    />
                    <div className="rvc-act">
                      {comment && (
                        <button
                          className="btn quiet sm"
                          onClick={() => {
                            props.onRemove(comment.id);
                            setEditing(null);
                          }}
                        >
                          Retirer
                        </button>
                      )}
                      <span className="grow" />
                      <button className="btn quiet sm" onClick={() => setEditing(null)}>
                        Annuler
                      </button>
                      <button className="btn pri sm" disabled={!editing.text.trim()} onClick={save}>
                        {comment ? "Modifier" : "Ajouter"}
                      </button>
                    </div>
                  </div>
                ) : (
                  comment && (
                    <button className="rvc" onClick={() => edit(line, comment)}>
                      {comment.text}
                    </button>
                  )
                )}
              </div>
            );
          })}
          {file.truncated && (
            <div className="rvd-l note">
              <span className="rvd-t">… diff coupé, trop long pour l'afficher</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What the thread's agent changed on its branch, docked beside the conversation: each file's
 * numbered diff, remarks on any line sent to the agent in one turn, then commit, push and PR.
 */
export function ReviewPanel({
  thread,
  review,
  onClose,
}: {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  /** Counts the pushes made from here: each one may have opened or moved the pull request. */
  const [pushes, setPushes] = useState(0);
  const pull = usePullRequest(thread, `${running}:${pushes}`);
  /** Ticks the user changed, by path; the others follow `looksSecret`. */
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  /** Files the user folded or unfolded, by path; the others follow the size of the change. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // Kept on this device until they are sent: closing the panel does not lose them.
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
  const totalLines = files?.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0) ?? 0;
  const isOpen = (f: ReviewFile, i: number) =>
    opened[f.path] ?? (totalLines <= OPEN_ALL_LINES || i === 0);
  // Each remark found again on its file and line in the review as it is now.
  const placed = useMemo(() => placeComments(files, comments), [files, comments]);
  const remarks = placed.all;
  const lost = remarks.filter((c) => c.lost);

  // The server holds the files; ask on opening, once the branch exists, whenever a
  // turn starts or ends, and on each change of tab: files written meanwhile show up.
  useEffect(() => {
    connection.send({ type: "workspace.review", threadId: thread.id });
  }, [thread.id, running, workspace?.base, tab]);

  const canForecast = !!workspace?.base && !!workspace.baseBranch && !thread.archived;
  useEffect(() => {
    if (!canForecast || running) return;
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
  }, [thread.id, canForecast, running, workspace?.base, asks]);

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
      setSyncError("Pas de connexion au serveur.");
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
    } finally {
      refresh();
    }
  };

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

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
      setPushed(true);
      setPushes((n) => n + 1);
      connection.send({ type: "workspace.review", threadId: thread.id });
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
      setSendError("Pas de connexion au serveur : tes commentaires sont gardés.");
      return;
    }
    setSending(remarks.map((c) => c.id));
    // Refused by the server (the agent busy, the thread closed): nothing starts, and the
    // remarks stay here to send again.
    sendTimer.current = setTimeout(() => {
      setSending(null);
      setSendError("L'agent n'a pas démarré : tes commentaires sont gardés, renvoie-les.");
    }, SEND_WAIT);
  };

  const added = files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0;
  const removed = files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;
  // One change to the branch at a time: no push while it merges, and the other way round.
  const canShip = !busy && !syncing && !running && !!message.trim() && picked.length > 0;

  return (
    <>
      <div className="rv-scrim" onClick={onClose} />
      <aside className="rv-panel" aria-label="À revoir">
        <div className="rv-top">
          <div className="rv-tabs" role="tablist">
            <button
              className={`rv-tab${tab === "changes" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "changes"}
              onClick={() => setTab("changes")}
            >
              Modifications {!!files?.length && <b>{files.length}</b>}
            </button>
            {!!workspace?.base && !thread.archived && (
              <button
                className={`rv-tab${tab === "files" ? " on" : ""}`}
                role="tab"
                aria-selected={tab === "files"}
                onClick={() => setTab("files")}
              >
                Fichiers
              </button>
            )}
          </div>
          <span className="grow" />
          <button className="ib" aria-label="Fermer la revue" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        {workspace && (
          <p className="rv-branch">
            <IconBranch size={13} />
            <code>{workspace.branch}</code>
            {workspace.baseBranch && <span className="rv-chip">depuis {workspace.baseBranch}</span>}
          </p>
        )}
        {canForecast && (forecast || forecastError) && (
          <div
            className={`rv-sync${forecast?.conflicts.length ? " conflict" : forecast?.behind ? " behind" : ""}`}
            role="status"
          >
            {forecastError ? (
              <span className="rv-sync-t">{forecastError}</span>
            ) : (
              forecast && (
                <>
                  {!forecast.behind && <IconCheck size={12} />}
                  <span
                    className="rv-sync-t"
                    title={forecast.conflicts.length ? forecast.conflicts.join("\n") : undefined}
                  >
                    {forecastLine(forecast)}
                  </span>
                  <span className="grow" />
                  {forecast.behind > 0 &&
                    (forecast.conflicts.length ? (
                      <button
                        className="btn quiet sm"
                        disabled={running || syncing || busy}
                        title={running ? "L'agent travaille encore" : undefined}
                        onClick={askMerge}
                      >
                        Demander à l'agent
                      </button>
                    ) : (
                      <button
                        className="btn quiet sm"
                        disabled={running || syncing || busy}
                        title={running ? "L'agent travaille encore" : undefined}
                        onClick={() => void sync()}
                      >
                        {syncing ? "Synchronisation…" : "Synchroniser"}
                      </button>
                    ))}
                </>
              )
            )}
          </div>
        )}
        {syncError && <p className="rv-msg error rv-sync-e">{syncError}</p>}
        <div className="rv-scroll">
          {tab === "files" && workspace?.base && !thread.archived ? (
            <WorktreeFiles
              thread={thread}
              files={files}
              onShowChange={(path) => {
                setTab("changes");
                setOpened((o) => ({ ...o, [path]: true }));
              }}
            />
          ) : !workspace?.base ? (
            <p className="rv-msg">La branche sera créée quand l'agent démarrera.</p>
          ) : review?.error ? (
            <p className="rv-msg error">Impossible de lire les changements : {review.error}</p>
          ) : !files ? (
            <p className="rv-msg">Je regarde ce qui a changé…</p>
          ) : files.length === 0 ? (
            <p className="rv-msg">Rien n'a changé sur cette branche pour l'instant.</p>
          ) : (
            <>
              <p className="rv-hint">
                Clique une ligne pour la commenter. Tes commentaires partent ensemble, en une seule
                relecture.
              </p>
              <div className="rv-sum">
                <span>
                  {picked.length < files.length
                    ? `${picked.length} sur ${files.length} à envoyer`
                    : `${files.length} ${files.length > 1 ? "fichiers" : "fichier"}`}{" "}
                  · <span className="n-add">+{added}</span>{" "}
                  <span className="n-del">−{removed}</span>
                </span>
                <span className="grow" />
                <button
                  className="btn quiet sm"
                  onClick={() => {
                    const all = picked.length < files.length;
                    setTicks(Object.fromEntries(files.map((f) => [f.path, all])));
                  }}
                >
                  {picked.length < files.length ? "Tout cocher" : "Tout décocher"}
                </button>
              </div>
              {files.map((f, i) => (
                <FileCard
                  key={f.path}
                  file={f}
                  open={isOpen(f, i)}
                  ticked={ticked(f)}
                  canComment={!thread.archived}
                  canReject={!thread.archived && !running && !syncing && !busy}
                  comments={placed.rows.get(f.path)}
                  onToggle={() => setOpened((o) => ({ ...o, [f.path]: !isOpen(f, i) }))}
                  onTick={(on) => setTicks((t) => ({ ...t, [f.path]: on }))}
                  onComment={(comment) =>
                    setComments((c) =>
                      c.some((x) => x.id === comment.id)
                        ? c.map((x) => (x.id === comment.id ? comment : x))
                        : [...c, comment],
                    )
                  }
                  onRemove={(id) => setComments((c) => c.filter((x) => x.id !== id))}
                  onReject={() => rejectFile(f)}
                />
              ))}
              {!!review?.omitted && (
                <p className="rv-msg">
                  {review.omitted} autres fichiers ne sont pas listés, trop nombreux : ils restent
                  sur ta machine.
                </p>
              )}
            </>
          )}
        </div>
        <div className="rv-foot">
          {lost.length > 0 && (
            <div className="rv-lost" role="status">
              <p>
                {lost.length > 1
                  ? `${lost.length} commentaires portent sur une ligne qui a changé depuis.`
                  : "Un commentaire porte sur une ligne qui a changé depuis."}{" "}
                {lost.length > 1
                  ? "L'agent les recevra avec leur ancienne place."
                  : "L'agent le recevra avec son ancienne place."}
              </p>
              {lost.map((c) => (
                <div key={c.id} className="rv-lost-c">
                  <span className="rv-lost-w">
                    {c.path}:{c.line}
                    {c.code.trim() && <code>{c.code.trim()}</code>}
                  </span>
                  <span className="rv-lost-t">{c.text}</span>
                  <button
                    className="btn quiet sm"
                    disabled={!!sending}
                    onClick={() => setComments((all) => all.filter((x) => x.id !== c.id))}
                  >
                    Retirer
                  </button>
                </div>
              ))}
            </div>
          )}
          {remarks.length > 0 && (
            <div className="rv-remarks">
              <span>
                {sending
                  ? "Envoi à l'agent…"
                  : `${remarks.length} ${remarks.length > 1 ? "commentaires" : "commentaire"}`}
              </span>
              <span className="grow" />
              <button
                className="btn quiet sm"
                disabled={!!sending}
                onClick={() => {
                  setComments([]);
                  setSendError(null);
                }}
              >
                Effacer
              </button>
              <button
                className="btn pri sm"
                disabled={running || !!sending}
                title={running ? "L'agent travaille encore" : undefined}
                onClick={sendRemarks}
              >
                Envoyer à l'agent
              </button>
            </div>
          )}
          {sendError && <p className="rv-msg error">{sendError}</p>}
          {pull.pr ? (
            <PullRequestStatus
              pr={pull.pr}
              loading={pull.loading}
              onRefresh={() => void pull.refresh()}
              onMerge={pull.merge}
            />
          ) : (
            workspace?.prUrl && (
              <p className="rv-pr">
                <a href={workspace.prUrl} target="_blank" rel="noreferrer">
                  {workspace.prOpened
                    ? "Voir la pull request"
                    : "Ouvrir la pull request sur GitHub"}
                </a>
              </p>
            )
          )}
          {pull.error && !pull.pr && (
            <p className="rv-msg">État de la pull request indisponible : {pull.error}</p>
          )}
          {pushed && !workspace?.prUrl && !pull.pr && <p className="rv-pr">Branche poussée.</p>}
          {running && (
            <p className="rv-msg">
              L'agent travaille encore. Tu pourras envoyer quand il aura fini.
            </p>
          )}
          {error && <p className="rv-msg error">{error}</p>}
          {!!files?.length && (
            <div className="rv-ship">
              <input
                className="rv-commit"
                aria-label="Message de commit"
                placeholder="Message de commit"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button className="btn" disabled={!canShip} onClick={() => void shipWith(false)}>
                Commit et push
              </button>
              <button className="btn pri" disabled={!canShip} onClick={() => void shipWith(true)}>
                Commit et PR
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
