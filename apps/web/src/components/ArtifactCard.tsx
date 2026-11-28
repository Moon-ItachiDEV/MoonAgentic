// An artifact the agent published, in its thread: HTML pages show a lazy sandboxed inline
// preview loaded on demand with the rest of « Artefacts », and every card opens the full sheet.
import type { Artifact, Item, Thread } from "@moonagentic/protocol";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { KIND_LABEL } from "../artifacts.ts";
import { connection } from "../connection.ts";
import { I } from "../v2/I.tsx";
import { ImageThumb } from "./ArtifactThumb.tsx";

const ArtifactSheet = lazy(() =>
  import("./Artifacts.tsx").then((m) => ({ default: m.ArtifactSheet })),
);
const InlineHtmlCard = lazy(() =>
  import("./Artifacts.tsx").then((m) => ({ default: m.InlineHtmlCard })),
);

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
  const compact = (
    <button
      className="artc press"
      aria-label={`Ouvrir l'artefact ${item.title}`}
      onClick={openSheet}
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
  );
  return (
    <>
      {item.artifactKind === "html" ? (
        <Suspense fallback={compact}>
          <InlineHtmlCard artifact={artifact} item={item} online={online} onOpen={openSheet} />
        </Suspense>
      ) : (
        compact
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
