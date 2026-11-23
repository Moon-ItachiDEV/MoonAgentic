import type { ReviewFile, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useState } from "react";
import { connection, newId } from "../connection.ts";
import { baseName, changesUnder, type FileDir, fileTree, filterFiles } from "../file-tree.ts";
import { IconArrowLeft, IconChevron, IconFile, IconFolder } from "./icons.tsx";

/** Past this many lines, the rest of a file is only counted. */
const SHOWN_LINES = 5000;

type Read = { path: string; text?: string; binary?: boolean; size?: number; error?: string };

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString("fr-FR")} Ko`;

function FileView({
  read,
  change,
  onBack,
  onShowChange,
}: {
  read: Read | null;
  change: ReviewFile | undefined;
  onBack: () => void;
  onShowChange: () => void;
}) {
  const lines = useMemo(() => read?.text?.split("\n") ?? [], [read?.text]);
  if (read?.text !== undefined && lines.at(-1) === "") lines.pop();
  return (
    <div className="wf-view">
      <div className="wf-vh">
        <button className="ib" aria-label="Retour aux fichiers" onClick={onBack}>
          <IconArrowLeft size={14} />
        </button>
        <code className="wf-vp" title={read?.path}>
          {read?.path}
        </code>
        {change && (
          <button className="btn quiet sm" onClick={onShowChange}>
            Voir les changements
          </button>
        )}
      </div>
      {!read || (read.text === undefined && !read.error && !read.binary && !read.size) ? (
        <p className="rv-msg">J'ouvre le fichier…</p>
      ) : read.error ? (
        <p className="rv-msg error">Impossible de lire ce fichier : {read.error}</p>
      ) : read.binary ? (
        <p className="rv-msg">
          Fichier binaire{read.size ? ` (${kb(read.size)})` : ""}, pas affiché.
        </p>
      ) : read.text === undefined ? (
        <p className="rv-msg">Fichier trop gros pour l'afficher ici ({kb(read.size ?? 0)}).</p>
      ) : (
        <div className="wf-code" role="table" aria-label={`Contenu de ${read.path}`}>
          {lines.slice(0, SHOWN_LINES).map((line, i) => (
            <div key={i} className="wf-l" role="row">
              <span className="wf-no">{i + 1}</span>
              <span className="wf-t">{line || " "}</span>
            </div>
          ))}
          {lines.length > SHOWN_LINES && (
            <p className="rv-msg">… {lines.length - SHOWN_LINES} lignes de plus, non affichées.</p>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  label,
  change,
  depth,
  onOpen,
}: {
  file: string;
  label: string;
  change: ReviewFile | undefined;
  depth: number;
  onOpen: (file: string) => void;
}) {
  return (
    <button
      className="wf-row"
      style={{ paddingLeft: 12 + depth * 14 }}
      title={file}
      onClick={() => onOpen(file)}
    >
      <IconFile size={13} />
      <span className="wf-name">{label}</span>
      {change && (
        <span className={`rvf-st st-${change.status}`} title="Changé sur cette branche">
          {change.status === "added" ? "A" : change.status === "renamed" ? "R" : "M"}
        </span>
      )}
    </button>
  );
}

function DirRows({
  dir,
  depth,
  open,
  changes,
  onToggle,
  onOpen,
}: {
  dir: FileDir;
  depth: number;
  open: Record<string, boolean>;
  changes: Map<string, ReviewFile>;
  onToggle: (path: string) => void;
  onOpen: (file: string) => void;
}) {
  return (
    <>
      {dir.dirs.map((sub) => {
        const isOpen = !!open[sub.path];
        const changed = changesUnder(sub.path, changes.keys());
        return (
          <div key={sub.path} role="group">
            <button
              className="wf-row dir"
              style={{ paddingLeft: 12 + depth * 14 }}
              aria-expanded={isOpen}
              onClick={() => onToggle(sub.path)}
            >
              <span className={`wf-chev${isOpen ? " open" : ""}`}>
                <IconChevron size={11} />
              </span>
              <IconFolder size={13} />
              <span className="wf-name">{sub.name}</span>
              {changed > 0 && (
                <span className="wf-count" title="Fichiers changés sur cette branche">
                  {changed}
                </span>
              )}
            </button>
            {isOpen && (
              <DirRows
                dir={sub}
                depth={depth + 1}
                open={open}
                changes={changes}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
      {dir.files.map((file) => (
        <FileRow
          key={file}
          file={file}
          label={baseName(file)}
          change={changes.get(file)}
          depth={depth}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/**
 * The « Fichiers » tab: every file of the thread's own folder as it is now, as a tree or
 * found by name, and each one open to read. Changed files carry their letter from the review.
 */
export function WorktreeFiles({
  thread,
  files: changedFiles,
  onShowChange,
}: {
  thread: Thread;
  files: ReviewFile[] | undefined;
  onShowChange: (path: string) => void;
}) {
  const running = thread.status === "running" || thread.status === "waiting";
  const [list, setList] = useState<{ files: string[]; capped: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reading, setReading] = useState<Read | null>(null);
  const changes = useMemo(
    () => new Map((changedFiles ?? []).map((f) => [f.path, f] as const)),
    [changedFiles],
  );
  const tree = useMemo(() => (list ? fileTree(list.files) : null), [list]);
  const found = useMemo(() => (list ? filterFiles(list.files, query) : []), [list, query]);

  // Asked on opening the tab, and again once a turn ends: the agent may have made files.
  useEffect(() => {
    let live = true;
    connection.ask({ type: "workspace.files", requestId: newId(), threadId: thread.id }).then(
      (reply) => {
        if (!live) return;
        setList({ files: reply.files, capped: reply.capped });
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [thread.id, running, thread.workspace?.base]);

  const openFile = (path: string) => {
    setReading({ path });
    connection
      .ask({ type: "workspace.readFile", requestId: newId(), threadId: thread.id, path })
      .then(
        ({ text, binary, size }) =>
          setReading((r) =>
            r?.path === path
              ? {
                  path,
                  ...(text !== undefined ? { text } : {}),
                  ...(binary ? { binary } : {}),
                  ...(size !== undefined ? { size } : {}),
                }
              : r,
          ),
        (e: unknown) =>
          setReading((r) =>
            r?.path === path ? { path, error: e instanceof Error ? e.message : String(e) } : r,
          ),
      );
  };

  if (reading) {
    return (
      <FileView
        read={reading}
        change={changes.get(reading.path)}
        onBack={() => setReading(null)}
        onShowChange={() => onShowChange(reading.path)}
      />
    );
  }
  if (error) return <p className="rv-msg error">Impossible de lister les fichiers : {error}</p>;
  if (!list || !tree) return <p className="rv-msg">Je liste les fichiers…</p>;
  return (
    <div className="wf">
      <input
        className="wf-find"
        type="search"
        aria-label="Chercher un fichier"
        placeholder={`Chercher parmi ${list.files.length.toLocaleString("fr-FR")} fichiers`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {list.capped && (
        <p className="rv-msg">Seuls les {list.files.length} premiers fichiers sont listés.</p>
      )}
      <div className="wf-list">
        {query.trim() ? (
          found.length ? (
            found.map((file) => (
              <FileRow
                key={file}
                file={file}
                label={file}
                change={changes.get(file)}
                depth={0}
                onOpen={openFile}
              />
            ))
          ) : (
            <p className="rv-msg">Aucun fichier ne correspond.</p>
          )
        ) : (
          <DirRows
            dir={tree}
            depth={0}
            open={open}
            changes={changes}
            onToggle={(path) => setOpen((o) => ({ ...o, [path]: !o[path] }))}
            onOpen={openFile}
          />
        )}
      </div>
    </div>
  );
}
