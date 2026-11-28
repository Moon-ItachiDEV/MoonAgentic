import type {
  Artifact,
  ArtifactKind,
  ArtifactVersion,
  Item,
  Project,
  Thread,
} from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ArtifactFilter,
  artifactKey,
  artifactLine,
  artifactName,
  counts,
  FILTERS,
  filtered,
  KIND_LABEL,
  workingKey,
} from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import { shortAgo } from "../project-threads.ts";
import { seenAgo } from "../remote.ts";
import { Dropdown } from "../v2/Dropdown.tsx";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { useExit } from "../v2/use-exit.ts";
import { ImageThumb, useArtifactUrl } from "./ArtifactThumb.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The versions of a published artifact, the latest first: one picked is shown. */
function VersionMenu(props: {
  shown: number;
  versions: ArtifactVersion[];
  onPick: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const drop = useExit(open);
  const now = Date.now();
  const last = props.versions[props.versions.length - 1]?.n;
  return (
    <>
      <button
        ref={chip}
        type="button"
        className="ppch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Version"
        onClick={() => setOpen((on) => !on)}
      >
        v{props.shown}
        <span className="pcv">
          <I n="down" s={13} />
        </span>
      </button>
      {drop.mounted && (
        <Dropdown
          anchor={chip}
          label="Version"
          start
          className={`mcm${drop.leaving ? " out" : ""}`}
          onClose={() => setOpen(false)}
        >
          {[...props.versions].reverse().map((v) => (
            <button
              key={v.n}
              type="button"
              role="menuitemradio"
              aria-checked={v.n === props.shown}
              onClick={() => {
                setOpen(false);
                props.onPick(v.n);
              }}
            >
              <span className="ddt">
                Version {v.n}
                {v.n === last ? " · actuelle" : ""}
                <small>{seenAgo(v.at, now)}</small>
              </span>
              {v.n === props.shown && (
                <span className="ddk">
                  <I n="check" s={15} />
                </span>
              )}
            </button>
          ))}
        </Dropdown>
      )}
    </>
  );
}

/**
 * One artifact shown as it is, from an address that works for some minutes. A page runs its
 * scripts in a sandbox of its own: nothing of the app's is in its reach, and nothing it does
 * leaves the page.
 */
function Preview({
  artifact,
  online,
  onOpenThread,
  version: first,
}: {
  artifact: Artifact;
  online: boolean;
  /** Not given in the thread itself, which is already open. */
  onOpenThread?: ((id: string) => void) | undefined;
  /** The version shown first; the latest when none. */
  version?: number | undefined;
}) {
  const [version, setVersion] = useState<number | undefined>(first);
  const { url, error, load, versions } = useArtifactUrl(artifact, true, online, version);
  const name = artifactName(artifact);
  return (
    <div className="sbody artv">
      <div className="pcm">
        {versions && versions.all.length > 1 ? (
          <VersionMenu shown={versions.shown} versions={versions.all} onPick={setVersion} />
        ) : (
          artifact.path && <span className="mono">{artifact.path}</span>
        )}
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
          <iframe
            key={url}
            src={url}
            title={name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
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
        {onOpenThread && (
          <button className="b2 ink press" onClick={() => onOpenThread(artifact.threadId)}>
            Ouvrir le fil
          </button>
        )}
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
                key={artifactKey(a)}
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
                <b>{artifactName(a)}</b>
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
      <ArtifactSheet
        artifact={open}
        online={online}
        onClose={() => setOpen(null)}
        onOpenThread={onOpenThread}
      />
    </div>
  );
}

/** One artifact in a tall sheet: from the list, or from its card in a thread. */
export function ArtifactSheet(props: {
  artifact: Artifact | null;
  online: boolean;
  onClose: () => void;
  onOpenThread?: (id: string) => void;
  version?: number;
}) {
  const { artifact } = props;
  return (
    <Sheet
      open={!!artifact}
      onClose={props.onClose}
      title={artifact ? artifactName(artifact) : "Artefact"}
      tall
      className="artsh"
    >
      {artifact && (
        <Preview
          key={artifactKey(artifact)}
          artifact={artifact}
          online={props.online}
          onOpenThread={props.onOpenThread}
          version={props.version}
        />
      )}
    </Sheet>
  );
}

/** True when an artifact card fetches and mounts its inline sandboxed preview. */
export function inlinePreviewActive(
  kind: ArtifactKind,
  seen: boolean,
  collapsed: boolean,
): boolean {
  return kind === "html" && seen && !collapsed;
}

/**
 * Lazy sandboxed inline preview of an HTML artifact: waits until the card enters the viewport
 * (or nears it) before asking the server for a short-lived ticket, and unmounts the iframe when
 * folded so long threads stay light on phones.
 */
export function InlineHtmlCard({
  artifact,
  item,
  online,
  onOpen,
}: {
  artifact: Artifact;
  item: Extract<Item, { kind: "artifact" }>;
  online: boolean;
  onOpen: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const watch = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSeen(true),
      { rootMargin: "200px" },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen]);

  const active = inlinePreviewActive(item.artifactKind, seen, collapsed);
  const { url, error, load } = useArtifactUrl(artifact, active, online, item.version);

  return (
    <div ref={box} className={`artbox${collapsed ? " folded" : ""}`}>
      <div className="artbar">
        <button
          type="button"
          className="artc-open press"
          aria-label={`Ouvrir l'artefact ${item.title}`}
          onClick={onOpen}
        >
          <span className="thumb ic">
            <I n="code" s={18} />
          </span>
          <span className="tx">
            <b>{item.title}</b>
            <small>
              {KIND_LABEL[item.artifactKind]}
              {item.version > 1 ? ` · version ${item.version}` : ""}
            </small>
          </span>
        </button>
        <div className="artact">
          <button
            type="button"
            className="artbtn press"
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? `Afficher l'aperçu de ${item.title}` : `Réduire l'aperçu de ${item.title}`
            }
            title={collapsed ? "Afficher l'aperçu" : "Réduire l'aperçu"}
            onClick={() => setCollapsed((c) => !c)}
          >
            <I n={collapsed ? "down" : "up"} s={15} />
          </button>
          <button
            type="button"
            className="artbtn press"
            aria-label={`Agrandir ${item.title}`}
            title="Ouvrir en grand"
            onClick={onOpen}
          >
            <I n="ext" s={15} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="artin">
          {error ? (
            <div className="artin-st" role="alert">
              <span>{error}</span>
              <button type="button" className="mini press" disabled={!online} onClick={load}>
                Réessayer
              </button>
            </div>
          ) : !url ? (
            <div className="artin-st">
              {online ? (
                <span className="t2-spin" role="status" aria-label="Chargement de l'aperçu" />
              ) : (
                <span>Hors ligne</span>
              )}
            </div>
          ) : (
            // Same strict sandbox as the full sheet: opaque origin, scripts only, no network.
            <iframe
              key={url}
              src={url}
              title={`Aperçu de ${item.title}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          )}
        </div>
      )}
    </div>
  );
}
