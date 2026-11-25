import type { ReviewFile, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import {
  baseName,
  changesUnder,
  type FileDir,
  fileLines,
  fileSize,
  fileTree,
  filterFiles,
} from "../file-tree.ts";
import { I } from "../v2/I.tsx";

/** Past this many lines, the rest of a file is only counted. */
const SHOWN_LINES = 5000;

type Read = { path: string; text?: string; binary?: boolean; size?: number; error?: string };

function FileView({
  read,
  change,
  onShowChange,
}: {
  read: Read | null;
  change: ReviewFile | undefined;
  onShowChange: () => void;
}) {
  const lines = useMemo(() => (read?.text === undefined ? [] : fileLines(read.text)), [read?.text]);
  return (
    <>
      {change && (
        <button className="rvw" onClick={onShowChange}>
          Voir les changements
          <I n="right" s={14} />
        </button>
      )}
      {!read || (read.text === undefined && !read.error && !read.binary && !read.size) ? (
        <p className="pcw">
          <span className="shimmer">Ouverture du fichier…</span>
        </p>
      ) : read.error ? (
        <p className="pcw t-err">Impossible de lire ce fichier : {read.error}</p>
      ) : read.binary ? (
        <p className="pcw">Fichier binaire{read.size ? ` · ${fileSize(read.size)}` : ""}</p>
      ) : read.text === undefined ? (
        <p className="pcw">Trop gros pour être affiché · {fileSize(read.size ?? 0)}</p>
      ) : (
        <div className="dfc wfc" role="table" aria-label={`Contenu de ${read.path}`}>
          {lines.slice(0, SHOWN_LINES).map((line, i) => (
            <div key={i} className="dl" role="row">
              <span className="dn mono">{i + 1}</span>
              <span />
              <span className="dt mono">{line || " "}</span>
            </div>
          ))}
          {lines.length > SHOWN_LINES && (
            <p className="pcw">{lines.length - SHOWN_LINES} lignes de plus</p>
          )}
        </div>
      )}
    </>
  );
}

function FileRow({
  file,
  label,
  change,
  onOpen,
}: {
  file: string;
  label: string;
  change: ReviewFile | undefined;
  onOpen: (file: string) => void;
}) {
  return (
    <button className="tf" title={file} onClick={() => onOpen(file)}>
      <I n="file" s={17} />
      <span className="mono">{label}</span>
      {change && (
        <span className="dpl" title="Changé sur cette branche">
          {change.status === "added" ? "A" : change.status === "renamed" ? "R" : "M"}
        </span>
      )}
    </button>
  );
}

function DirRows({
  dir,
  open,
  changes,
  onToggle,
  onOpen,
}: {
  dir: FileDir;
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
          <div key={sub.path} role="group" className={isOpen ? "open" : ""}>
            <button aria-expanded={isOpen} onClick={() => onToggle(sub.path)}>
              <I n="right" s={14} className="cv" />
              <I n="folder" s={19} />
              <span>{sub.name}</span>
              {changed > 0 && (
                <span className="dpl" title="Fichiers changés sur cette branche">
                  {changed}
                </span>
              )}
            </button>
            {isOpen && (
              <div className="sub">
                <DirRows
                  dir={sub}
                  open={open}
                  changes={changes}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </div>
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
  path,
  onRead,
  onShowChange,
}: {
  thread: Thread;
  files: ReviewFile[] | undefined;
  /** The file being read, which the sheet names in its header; none shows the tree. */
  path: string | null;
  onRead: (path: string | null) => void;
  onShowChange: (path: string) => void;
}) {
  const running = thread.status === "running" || thread.status === "waiting";
  const [list, setList] = useState<{ files: string[]; capped: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reading, setReading] = useState<Read | null>(null);
  // Only files still on disk are listed: a removed one has its place in « Modifications ».
  const changes = useMemo(
    () =>
      new Map(
        (changedFiles ?? []).filter((f) => f.status !== "deleted").map((f) => [f.path, f] as const),
      ),
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

  /** Reads a file; `again` keeps what is shown until the new text comes. */
  const load = (path: string, again = false) => {
    if (!again) setReading({ path });
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

  // The file named by the sheet is read, and read again when a turn starts or ends: the
  // agent may have changed it. What is shown stays until the new text comes.
  const shownPath = useRef<string | undefined>(undefined);
  shownPath.current = reading?.path;
  useEffect(() => {
    if (!path) return setReading(null);
    load(path, shownPath.current === path);
    // `load` is the same each time.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [path, running, thread.workspace?.base]);

  if (path) {
    return (
      <FileView
        read={reading?.path === path ? reading : null}
        change={changes.get(path)}
        onShowChange={() => onShowChange(path)}
      />
    );
  }
  if (error) return <p className="pcw t-err">Impossible de lister les fichiers : {error}</p>;
  if (!list || !tree)
    return (
      <p className="pcw">
        <span className="shimmer">Lecture des fichiers…</span>
      </p>
    );
  return (
    <>
      <input
        className="rni wff"
        type="search"
        aria-label="Chercher un fichier"
        placeholder={`Chercher parmi ${list.files.length.toLocaleString("fr-FR")} fichiers`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {list.capped && (
        <p className="pcw">
          Les {list.files.length.toLocaleString("fr-FR")} premiers fichiers seulement
        </p>
      )}
      <div className="tree wft">
        {query.trim() ? (
          found.length ? (
            found.map((file) => (
              <FileRow
                key={file}
                file={file}
                label={file}
                change={changes.get(file)}
                onOpen={onRead}
              />
            ))
          ) : (
            <p className="pcw">Aucun fichier ne correspond</p>
          )
        ) : (
          <DirRows
            dir={tree}
            open={open}
            changes={changes}
            onToggle={(dir) => setOpen((o) => ({ ...o, [dir]: !o[dir] }))}
            onOpen={onRead}
          />
        )}
      </div>
    </>
  );
}
