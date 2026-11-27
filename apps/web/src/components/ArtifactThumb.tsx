// What shows an artifact from where it is kept: the short-lived address it is asked for, and
// an image's own picture as its thumbnail. Small, for the thread's cards in the main chunk.
import type { Artifact, ArtifactVersion } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { I } from "../v2/I.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * An address that shows the artifact for some minutes, asked for when `on` and the connection
 * is open, and again when it opens anew: one asked while it was closed failed at once. A
 * published one is shown at `version`, else at its latest, and says which versions it has.
 */
export function useArtifactUrl(
  artifact: Artifact | null,
  on: boolean,
  online: boolean,
  version?: number,
) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ shown: number; all: ArtifactVersion[] } | null>(null);
  const asked = useRef(0);
  const threadId = artifact?.threadId;
  const artifactId = artifact?.id;
  const path = artifact?.path || artifactId;
  const load = useCallback(() => {
    if (!threadId || !path) return;
    const seq = ++asked.current;
    setError(null);
    connection
      .ask({
        type: "artifacts.open",
        requestId: newId(),
        threadId,
        path,
        ...(artifactId ? { artifactId } : {}),
        ...(artifactId && version ? { version } : {}),
      })
      .then(
        (reply) => {
          if (seq !== asked.current) return;
          setUrl(reply.url);
          if (reply.version && reply.versions)
            setVersions({ shown: reply.version, all: reply.versions });
        },
        (e: unknown) => seq === asked.current && setError(message(e)),
      );
  }, [threadId, path, artifactId, version]);
  useEffect(() => {
    if (!on || !online) return;
    load();
    return () => {
      asked.current += 1;
    };
  }, [load, on, online]);
  return { url, error, load, versions };
}

/** An image's own picture as its thumbnail, asked for once it comes into sight. */
export function ImageThumb({
  artifact,
  online,
  version,
}: {
  artifact: Artifact;
  online: boolean;
  version?: number;
}) {
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
  const { url } = useArtifactUrl(artifact, seen, online, version);
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
