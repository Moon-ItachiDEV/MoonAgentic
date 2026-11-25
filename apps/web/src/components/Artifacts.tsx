import type { Artifact, Project, Thread } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ArtifactFilter,
  artifactLine,
  counts,
  FILTERS,
  fileName,
  filtered,
  KIND_LABEL,
  workingKey,
} from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import { shortAgo } from "../project-threads.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * An address that shows the artifact for some minutes, asked for when `on` and the connection
 * is open, and again when it opens anew: one asked while it was closed failed at once.
 */
function useArtifactUrl(artifact: Artifact | null, on: boolean, online: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const threadId = artifact?.threadId;
  const path = artifact?.path;
  const load = useCallback(() => {
    if (!threadId || !path) return;
    const seq = ++asked.current;
    setError(null);
    connection.ask({ type: "artifacts.open", requestId: newId(), threadId, path }).then(
      (reply) => seq === asked.current && setUrl(reply.url),
      (e: unknown) => seq === asked.current && setError(message(e)),
    );
  }, [threadId, path]);
  useEffect(() => {
    if (!on || !online) return;
    load();
    return () => {
      asked.current += 1;
    };
  }, [load, on, online]);
  return { url, error, load };
}

/** An image's own picture as its thumbnail, asked for once it comes into sight. */
function ImageThumb({ artifact, online }: { artifact: Artifact; online: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const watch = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSeen(true),
      { rootMargin: "200px" },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen]);
  const { url } = useArtifactUrl(artifact, seen, online);
  const [broken, setBroken] = useState(false);
  return (
    <span ref={box} className={`thumb ${url && !broken ? "img" : "ic"}`}>
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <I n="image" s={26} />
      )}
    </span>
  );
}

/** One artifact shown as it is, from an address that works for some minutes. */
function Preview({
  artifact,
  online,
  onOpenThread,
}: {
  artifact: Artifact;
  online: boolean;
  onOpenThread: (id: string) => void;
}) {
  const { url, error, load } = useArtifactUrl(artifact, true, online);
  const name = fileName(artifact.path);
  return (
    <div className="sbody artv">
      <div className="pcm">
        <span className="mono">{artifact.path}</span>
        {artifact.kind === "html" && <span className="ppill">Aperçu protégé, sans scripts</span>}
      </div>
      <div className={`artst k-${artifact.kind}`}>
        {error ? (
          <div className="empty2" role="alert">
            <span className="eic e">
              <I n="errc" s={24} />
            </span>
            <b>{error}</b>
            <button className="newth press" disabled={!online} onClick={load}>
              Réessayer
            </button>
          </div>
        ) : !url ? (
          <span className="t2-spin" role="status" aria-label="Chargement" />
        ) : artifact.kind === "image" ? (
          <img key={url} src={url} alt={name} />
        ) : artifact.kind === "html" ? (
          // No token on such an address, and nothing the page could run with the app's rights.
          <iframe key={url} src={url} title={name} sandbox="" referrerPolicy="no-referrer" />
        ) : (
          // The browser's own PDF reader, which a sandbox would turn away.
          <iframe key={url} src={url} title={name} referrerPolicy="no-referrer" />
        )}
      </div>
      <div className="rqa">
        <button
          className="b2 soft press"
          aria-label="Recharger l'aperçu"
          disabled={!online}
          onClick={load}
        >
          <I n="refresh" s={16} />
          Recharger
        </button>
        {url && (
          <a className="b2 soft press" href={url} target="_blank" rel="noopener noreferrer">
            <I n="ext" s={16} />
            Nouvel onglet
          </a>
        )}
        <button className="b2 ink press" onClick={() => onOpenThread(artifact.threadId)}>
          Ouvrir le fil
        </button>
      </div>
    </div>
  );
}

/**
 * « Artefacts »: the pages, images and PDFs the agents made in their threads' own branches,
 * found again each time a turn ends, to look at as they are.
 */
export function Artifacts({
  threads,
  projects,
  online,
  onOpenThread,
}: {
  threads: Thread[];
  projects: Project[];
  /** Asked only once the connection is open: an ask before then fails at once. */
  online: boolean;
  onOpenThread: (id: string) => void;
}) {
  const [list, setList] = useState<{ artifacts: Artifact[]; capped: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [open, setOpen] = useState<Artifact | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const asked = useRef(0);
  const load = useCallback(() => {
    const seq = ++asked.current;
    setError(null);
    setLoading(true);
    connection.ask({ type: "artifacts.list", requestId: newId() }).then(
      (reply) => {
        if (seq !== asked.current) return;
        setList({ artifacts: reply.artifacts, capped: reply.capped });
        setError(null);
        setLoading(false);
        setNow(Date.now());
      },
      (e: unknown) => {
        if (seq !== asked.current) return;
        setError(message(e));
        setLoading(false);
      },
    );
  }, []);
  // Asked again whenever a turn starts or ends: what the agent wrote is then on disk.
  const working = workingKey(threads);
  useEffect(() => {
    if (online) load();
  }, [load, working, online]);
  useEffect(
    () => () => {
      asked.current += 1;
    },
    [],
  );

  const all = list?.artifacts ?? [];
  const n = counts(all);
  // A kind none is left of since the last look: back to all of them.
  const active: ArtifactFilter = filter !== "all" && n[filter] === 0 ? "all" : filter;
  const shown = filtered(all, active);
  return (
    <div className="view" id="view" role="region" aria-label="Artefacts">
      {all.length > 0 && (
        <div className="chips" role="group" aria-label="Filtrer par type">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              aria-pressed={active === f.id}
              disabled={f.id !== "all" && n[f.id] === 0}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <i>{n[f.id]}</i>
            </button>
          ))}
          <span className="sp" />
          <button aria-label="Actualiser la liste" disabled={loading || !online} onClick={load}>
            <I n="refresh" s={15} />
          </button>
        </div>
      )}
      {error && (
        <div className="empty2" role="alert">
          <span className="eic e">
            <I n="errc" s={24} />
          </span>
          <b>{error}</b>
          <button className="newth press" disabled={loading || !online} onClick={load}>
            Réessayer
          </button>
        </div>
      )}
      {list && all.length === 0 && !error && (
        <div className="empty2">
          <span className="eic n">
            <I n="stack" s={24} />
          </span>
          <b>Aucun artefact</b>
        </div>
      )}
      {shown.length > 0 && (
        <div className="agrid">
          {shown.map((a) => {
            const project = projects.find((p) => p.id === a.projectId);
            return (
              <button
                key={`${a.threadId}:${a.path}`}
                className="acard press"
                title={artifactLine(a, projects, now)}
                onClick={() => setOpen(a)}
              >
                {a.kind === "image" ? (
                  <ImageThumb artifact={a} online={online} />
                ) : (
                  <span className="thumb ic">
                    <I n={a.kind === "html" ? "code" : "file"} s={26} />
                  </span>
                )}
                <b>{fileName(a.path)}</b>
                <small>
                  {project && (
                    <i className={`pdot${project.color ? ` pc-${project.color}` : ""}`} />
                  )}
                  {KIND_LABEL[a.kind]} · {shortAgo(a.mtime, now)}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {list?.capped && <span className="ppill">{all.length} plus récents</span>}
      <div className="end" style={{ height: 40 }} />
      <Sheet
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? fileName(open.path) : "Artefact"}
        tall
        className="artsh"
      >
        {open && (
          <Preview
            key={`${open.threadId}:${open.path}`}
            artifact={open}
            online={online}
            onOpenThread={onOpenThread}
          />
        )}
      </Sheet>
    </div>
  );
}
