// An artifact the agent published, as a card in its thread: it opens the artifact in a sheet
// loaded on demand, with the rest of « Artefacts ».
import type { Artifact, Item, Thread } from "@moonagentic/protocol";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { KIND_LABEL } from "../artifacts.ts";
import { connection } from "../connection.ts";
import { I } from "../v2/I.tsx";
import { ImageThumb } from "./ArtifactThumb.tsx";

const ArtifactSheet = lazy(() =>
  import("./Artifacts.tsx").then((m) => ({ default: m.ArtifactSheet })),
);

/**
 * What the agent published, where it published it in the thread: a card that opens it at the
 * version this publication made, with the others a tap away.
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
  return (
    <>
      <button
        className="artc press"
        aria-label={`Ouvrir l'artefact ${item.title}`}
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        {item.artifactKind === "image" ? (
          <ImageThumb artifact={artifact} online={online} version={item.version} />
        ) : (
          <span className="thumb ic">
            <I n={item.artifactKind === "html" ? "code" : "file"} s={20} />
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
