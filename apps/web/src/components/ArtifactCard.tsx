// An artifact the agent published, in its thread: HTML pages show a lazy sandboxed inline
// preview right in the conversation, and every card opens the full sheet on demand.
import type { Artifact, ArtifactKind, Item, Thread } from "@moonagentic/protocol";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KIND_LABEL } from "../artifacts.ts";
import { connection } from "../connection.ts";
import { I } from "../v2/I.tsx";
import { ImageThumb, useArtifactUrl } from "./ArtifactThumb.tsx";

const ArtifactSheet = lazy(() =>
  import("./Artifacts.tsx").then((m) => ({ default: m.ArtifactSheet })),
);

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
function InlineHtmlCard({
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

/**
 * What the agent published, where it published it in the thread: HTML pages preview inline
 * inside the same sandbox as the sheet, and every card opens the version it made.
 */
export function ArtifactCard({
  item,
  thread,
}: {
  item: Extract<Item, { kind: "artifact" }>;
  thread: Thread;
}) {
  // Only whether it is online: the whole state changes with every chunk of an answer.
  const online = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().status === "open",
  );
  const [open, setOpen] = useState(false);
  // Loaded the first time it is opened, then kept: it closes with its own motion.
  const [loaded, setLoaded] = useState(false);
  const artifact: Artifact = {
    threadId: thread.id,
    threadTitle: thread.title,
    projectId: thread.projectId,
    path: "",
    kind: item.artifactKind,
    size: 0,
    mtime: item.at,
    id: item.artifactId,
    title: item.title,
  };
  const openSheet = () => {
    setLoaded(true);
    setOpen(true);
  };
  return (
    <>
      {item.artifactKind === "html" ? (
        <InlineHtmlCard artifact={artifact} item={item} online={online} onOpen={openSheet} />
      ) : (
        <button
          className="artc press"
          aria-label={`Ouvrir l'artefact ${item.title}`}
          onClick={openSheet}
        >
          {item.artifactKind === "image" ? (
            <ImageThumb artifact={artifact} online={online} version={item.version} />
          ) : (
            <span className="thumb ic">
              <I n="file" s={20} />
            </span>
          )}
          <span className="tx">
            <b>{item.title}</b>
            <small>
              {KIND_LABEL[item.artifactKind]}
              {item.version > 1 ? ` · version ${item.version}` : ""}
            </small>
          </span>
          <I n="right" s={15} className="go" />
        </button>
      )}
      {loaded && (
        <Suspense fallback={null}>
          <ArtifactSheet
            artifact={open ? artifact : null}
            online={online}
            version={item.version}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
