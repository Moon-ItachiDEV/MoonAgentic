import type { ReviewFile, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { IconBranch } from "./icons.tsx";

const STATUS: Record<ReviewFile["status"], string> = {
  added: "nouveau",
  modified: "modifié",
  deleted: "supprimé",
  renamed: "renommé",
};

function FileDiff({ file }: { file: ReviewFile }) {
  return (
    <details className="rv-file">
      <summary>
        <span className="rv-path">{file.path}</span>
        <span className="rv-st">{STATUS[file.status]}</span>
        {file.added === null ? (
          <span className="rv-n">binaire</span>
        ) : (
          <span className="rv-n">
            <span className="n-add">+{file.added}</span>{" "}
            <span className="n-del">−{file.removed}</span>
          </span>
        )}
      </summary>
      {file.patch && (
        <div className="diff-b">
          {file.patch.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("@@")
                  ? "hunk"
                  : line.startsWith("+")
                    ? "add"
                    : line.startsWith("-")
                      ? "del"
                      : undefined
              }
            >
              {line || " "}
            </div>
          ))}
          {file.truncated && <div className="hunk">… diff coupé, trop long pour l'afficher</div>}
        </div>
      )}
    </details>
  );
}

/** What the thread's agent changed on its branch, and the way to commit, push and open a PR. */
export function ReviewPanel({
  thread,
  files,
  onClose,
}: {
  thread: Thread;
  files: ReviewFile[] | undefined;
  onClose: () => void;
}) {
  const workspace = thread.workspace;
  const running = thread.status === "running" || thread.status === "waiting";
  const [message, setMessage] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);

  // The server holds the files; ask again whenever the agent finishes a turn.
  useEffect(() => {
    if (!running) connection.send({ type: "workspace.review", threadId: thread.id });
  }, [thread.id, running]);

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
        requestId: crypto.randomUUID(),
        threadId: thread.id,
        message: message.trim(),
        pr,
      });
      setPushed(true);
      connection.send({ type: "workspace.review", threadId: thread.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const added = files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0;
  const removed = files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog review" role="dialog" aria-modal aria-labelledby="rv-title">
        <h2 id="rv-title">À revoir</h2>
        {workspace && (
          <p className="rv-branch">
            <IconBranch />
            <code>{workspace.branch}</code>
            {workspace.baseBranch && <span>depuis {workspace.baseBranch}</span>}
          </p>
        )}
        {!workspace?.base ? (
          <p>La branche sera créée quand l'agent démarrera.</p>
        ) : !files ? (
          <p>Je regarde ce qui a changé…</p>
        ) : files.length === 0 ? (
          <p>Rien n'a changé sur cette branche pour l'instant.</p>
        ) : (
          <>
            <p>
              {files.length} {files.length > 1 ? "fichiers" : "fichier"} ·{" "}
              <span className="n-add">+{added}</span> <span className="n-del">−{removed}</span>
            </p>
            <div className="rv-files">
              {files.map((f) => (
                <FileDiff key={f.path} file={f} />
              ))}
            </div>
            <label className="field">
              Message de commit
              <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
          </>
        )}
        {workspace?.prUrl && (
          <p className="rv-pr">
            <a href={workspace.prUrl} target="_blank" rel="noreferrer">
              {workspace.prOpened ? "Voir la pull request" : "Ouvrir la pull request sur GitHub"}
            </a>
          </p>
        )}
        {pushed && !workspace?.prUrl && <p className="rv-pr">Branche poussée.</p>}
        {running && <p>L'agent travaille encore. Tu pourras envoyer quand il aura fini.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn quiet" onClick={onClose}>
            Fermer
          </button>
          {!!files?.length && (
            <>
              <button
                className="btn"
                disabled={busy || running || !message.trim()}
                onClick={() => void shipWith(false)}
              >
                Commit et push
              </button>
              <button
                className="btn pri"
                disabled={busy || running || !message.trim()}
                onClick={() => void shipWith(true)}
              >
                Commit, push et PR
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
