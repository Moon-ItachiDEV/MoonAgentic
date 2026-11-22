import type { ReviewFile, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useState } from "react";
import { connection, newId, type Review } from "../connection.ts";
import { type DiffLine, type LineComment, parsePatch, reviewMessage } from "../diff.ts";
import { IconBranch, IconChevron, IconX } from "./icons.tsx";
import { PullRequestStatus, usePullRequest } from "./PullRequestStatus.tsx";

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

const lineKey = (path: string, i: number) => `${path}#${i}`;

/** One changed file: its header with the tick, then its numbered diff, each line open to a remark. */
function FileCard(props: {
  file: ReviewFile;
  open: boolean;
  ticked: boolean;
  canComment: boolean;
  comments: Record<string, LineComment>;
  onToggle: () => void;
  onTick: (ticked: boolean) => void;
  onComment: (key: string, comment: LineComment | null) => void;
}) {
  const { file } = props;
  const lines = useMemo(() => (props.open ? parsePatch(file.patch) : []), [props.open, file.patch]);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const status = STATUS[file.status];
  const secret = looksSecret(file.path);

  const save = (key: string, line: DiffLine) => {
    if (!editing?.text.trim() || line.kind === "hunk" || line.kind === "note") return;
    props.onComment(key, {
      path: file.path,
      line: (line.kind === "del" ? line.old : line.new) ?? 0,
      removed: line.kind === "del",
      code: line.text,
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
        <input
          type="checkbox"
          checked={props.ticked}
          aria-label={`Envoyer ${file.path}`}
          title={props.ticked ? "Part avec le commit" : "Reste en dehors du commit"}
          onChange={(e) => props.onTick(e.target.checked)}
        />
      </header>
      {secret && (
        <p className="rvf-secret">Peut contenir un secret : coche-le seulement si tu en es sûr.</p>
      )}
      {props.open && file.patch && (
        <div className="rvd" role="table" aria-label={`Changements de ${file.path}`}>
          {lines.map((line, i) => {
            const key = lineKey(file.path, i);
            if (line.kind === "hunk" || line.kind === "note")
              return (
                <div key={key} className={`rvd-l ${line.kind}`} role="row">
                  <span className="rvd-t">{line.text}</span>
                </div>
              );
            const comment = props.comments[key];
            const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
            return (
              <div key={key} className="rvd-g">
                <div
                  className={`rvd-l ${line.kind}${props.canComment ? " can" : ""}`}
                  role="row"
                  tabIndex={props.canComment ? 0 : undefined}
                  title={props.canComment ? "Commenter cette ligne" : undefined}
                  onClick={() => props.canComment && setEditing({ key, text: comment?.text ?? "" })}
                  onKeyDown={(e) => {
                    if (props.canComment && e.key === "Enter") {
                      e.preventDefault();
                      setEditing({ key, text: comment?.text ?? "" });
                    }
                  }}
                >
                  <span className="rvd-no">{line.old ?? ""}</span>
                  <span className="rvd-no">{line.new ?? ""}</span>
                  <span className="rvd-s">{sign}</span>
                  <span className="rvd-t">{line.text || " "}</span>
                </div>
                {editing?.key === key ? (
                  <div className="rvc-edit">
                    <textarea
                      autoFocus
                      rows={2}
                      placeholder="Ce que l'agent doit changer ici"
                      value={editing.text}
                      onChange={(e) => setEditing({ key, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          save(key, line);
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
                            props.onComment(key, null);
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
                      <button
                        className="btn pri sm"
                        disabled={!editing.text.trim()}
                        onClick={() => save(key, line)}
                      >
                        {comment ? "Modifier" : "Ajouter"}
                      </button>
                    </div>
                  </div>
                ) : (
                  comment && (
                    <button className="rvc" onClick={() => setEditing({ key, text: comment.text })}>
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
  const [comments, setComments] = useState<Record<string, LineComment>>({});
  const ticked = (f: ReviewFile) => ticks[f.path] ?? !looksSecret(f.path);
  const picked = files?.filter(ticked) ?? [];
  const totalLines = files?.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0) ?? 0;
  const isOpen = (f: ReviewFile, i: number) =>
    opened[f.path] ?? (totalLines <= OPEN_ALL_LINES || i === 0);
  const remarks = Object.values(comments);

  // The server holds the files; ask on opening, once the branch exists, and whenever a
  // turn starts or ends.
  useEffect(() => {
    connection.send({ type: "workspace.review", threadId: thread.id });
  }, [thread.id, running, workspace?.base]);

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

  const sendRemarks = () => {
    if (!remarks.length || running) return;
    connection.send({ type: "thread.send", threadId: thread.id, text: reviewMessage(remarks) });
    setComments({});
  };

  const added = files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0;
  const removed = files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;
  const canShip = !busy && !running && !!message.trim() && picked.length > 0;

  return (
    <>
      <div className="rv-scrim" onClick={onClose} />
      <aside className="rv-panel" aria-label="À revoir">
        <div className="rv-top">
          <div className="rv-tabs" role="tablist">
            <span className="rv-tab on" role="tab" aria-selected>
              Modifications {!!files?.length && <b>{files.length}</b>}
            </span>
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
        <div className="rv-scroll">
          {!workspace?.base ? (
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
                  comments={comments}
                  onToggle={() => setOpened((o) => ({ ...o, [f.path]: !isOpen(f, i) }))}
                  onTick={(on) => setTicks((t) => ({ ...t, [f.path]: on }))}
                  onComment={(key, comment) =>
                    setComments((c) => {
                      const next = { ...c };
                      if (comment) next[key] = comment;
                      else delete next[key];
                      return next;
                    })
                  }
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
          {remarks.length > 0 && (
            <div className="rv-remarks">
              <span>
                {remarks.length} {remarks.length > 1 ? "commentaires" : "commentaire"}
              </span>
              <span className="grow" />
              <button className="btn quiet sm" onClick={() => setComments({})}>
                Effacer
              </button>
              <button
                className="btn pri sm"
                disabled={running}
                title={running ? "L'agent travaille encore" : undefined}
                onClick={sendRemarks}
              >
                Envoyer à l'agent
              </button>
            </div>
          )}
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
