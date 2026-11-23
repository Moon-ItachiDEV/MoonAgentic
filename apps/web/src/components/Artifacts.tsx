import type { Artifact, Project, Thread } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ArtifactFilter,
  artifactLine,
  counts,
  FILTERS,
  fileName,
  filtered,
  folderOf,
  KIND_LABEL,
  workingKey,
} from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import {
  IconArrowLeft,
  IconChat,
  IconChevron,
  IconFile,
  IconImage,
  IconRefresh,
} from "./icons.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One artifact shown as it is, from an address that works for some minutes. */
function Preview({
  artifact,
  onBack,
  onOpenThread,
}: {
  artifact: Artifact;
  onBack: () => void;
  onOpenThread: (id: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const load = useCallback(() => {
    const seq = ++asked.current;
    setError(null);
    connection
      .ask({
        type: "artifacts.open",
        requestId: newId(),
        threadId: artifact.threadId,
        path: artifact.path,
      })
      .then(
        (reply) => seq === asked.current && setUrl(reply.url),
        (e: unknown) => seq === asked.current && setError(message(e)),
      );
  }, [artifact.threadId, artifact.path]);
  useEffect(() => {
    load();
    return () => {
      asked.current += 1;
    };
  }, [load]);
  const name = fileName(artifact.path);
  return (
    <section className="art-preview" aria-label={`Aperçu de ${name}`}>
      <div className="art-bar">
        <button className="ib" aria-label="Retour aux artefacts" title="Retour" onClick={onBack}>
          <IconArrowLeft size={16} />
        </button>
        <div className="art-bar-tx">
          <strong title={artifact.path}>{name}</strong>
          <small>{artifact.threadTitle}</small>
        </div>
        <button
          className="ib"
          aria-label="Recharger l'aperçu"
          title="Recharger : l'agent a pu le changer"
          onClick={load}
        >
          <IconRefresh size={15} />
        </button>
        <button className="btn sm" onClick={() => onOpenThread(artifact.threadId)}>
          <IconChat size={14} />
          Ouvrir le fil
        </button>
      </div>
      {artifact.kind === "html" && (
        <p className="art-note">
          Aperçu protégé : les scripts de la page et ce qu'elle chargerait d'Internet ne sont pas
          lancés.
        </p>
      )}
      <div className={`art-stage art-${artifact.kind}`}>
        {error ? (
          <div className="empty-note" role="alert">
            <p>{error}</p>
            <button className="btn sm" onClick={load}>
              Réessayer
            </button>
          </div>
        ) : !url ? (
          <p className="art-wait">Chargement…</p>
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
      {url && (
        <a className="art-tab" href={url} target="_blank" rel="noopener noreferrer">
          Ouvrir dans un nouvel onglet
        </a>
      )}
    </section>
  );
}

/**
 * « Artefacts »: the pages, images and PDFs the agents made in their threads' own branches,
 * found again each time a turn ends, to look at as they are.
 */
export function Artifacts({
  threads,
  projects,
  onOpenThread,
}: {
  threads: Thread[];
  projects: Project[];
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
    load();
  }, [load, working]);
  useEffect(
    () => () => {
      asked.current += 1;
    },
    [],
  );

  if (open) {
    return (
      <div className="view art-view">
        <Preview artifact={open} onBack={() => setOpen(null)} onOpenThread={onOpenThread} />
      </div>
    );
  }
  const all = list?.artifacts ?? [];
  const n = counts(all);
  // A kind none is left of since the last look: back to all of them.
  const active: ArtifactFilter = filter !== "all" && n[filter] === 0 ? "all" : filter;
  const shown = filtered(all, active);
  return (
    <div className="view art-view">
      <div className="art-head">
        <div>
          <h2>Artefacts</h2>
          <p>Les pages, images et PDF que tes agents ont créés dans les branches de leurs fils.</p>
        </div>
        <button
          className="ib"
          aria-label="Actualiser la liste"
          title="Actualiser"
          disabled={loading}
          onClick={load}
        >
          <IconRefresh size={15} />
        </button>
      </div>
      {all.length > 0 && (
        <div className="art-filters" role="group" aria-label="Filtrer par type">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={active === f.id ? "on" : ""}
              aria-pressed={active === f.id}
              disabled={f.id !== "all" && n[f.id] === 0}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="aux">{n[f.id]}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="empty-note" role="alert">
          <p>{error}</p>
          <button className="btn sm" onClick={load}>
            Réessayer
          </button>
        </div>
      )}
      {!list && !error && <p className="art-wait">Recherche des artefacts…</p>}
      {list && all.length === 0 && !error && (
        <div className="empty-note">
          <p>
            Rien pour l'instant. Quand un agent crée ou change une page HTML, une image ou un PDF
            dans la branche de son fil, il apparaît ici.
          </p>
        </div>
      )}
      {shown.length > 0 && (
        <ul className="art-list">
          {shown.map((a) => (
            <li key={`${a.threadId}:${a.path}`}>
              <button className="art-row" onClick={() => setOpen(a)}>
                <span className={`art-ico art-${a.kind}`} aria-hidden="true">
                  {a.kind === "image" ? <IconImage size={16} /> : <IconFile size={16} />}
                </span>
                <span className="art-tx">
                  <span className="art-name">
                    {fileName(a.path)}
                    <span className="art-kind">{KIND_LABEL[a.kind]}</span>
                  </span>
                  {folderOf(a.path) && <code>{folderOf(a.path)}</code>}
                  <small>{artifactLine(a, projects, now)}</small>
                </span>
                <IconChevron size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list?.capped && <p className="art-note">Seuls les {all.length} plus récents sont listés.</p>}
    </div>
  );
}
