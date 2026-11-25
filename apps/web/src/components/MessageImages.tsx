import type { ImageRef } from "@moonagentic/protocol";
import { useState } from "react";
import { useAttachedImage } from "../attachments.ts";
import { I } from "../v2/I.tsx";
import { Viewer } from "../v2/Viewer.tsx";

/** The images sent with a message: small in the thread, whole when one is pressed. */
export function MessageImages(props: { threadId: string; images: ImageRef[] }) {
  const [shown, setShown] = useState<ImageRef>();
  return (
    <div className={`u-imgs${props.images.length === 1 ? " one" : ""}`}>
      {props.images.map((image) => (
        <Thumbnail
          key={image.id}
          threadId={props.threadId}
          image={image}
          onOpen={() => setShown(image)}
        />
      ))}
      {shown && (
        <Shown threadId={props.threadId} image={shown} onClose={() => setShown(undefined)} />
      )}
    </div>
  );
}

function Thumbnail(props: { threadId: string; image: ImageRef; onOpen: () => void }) {
  const { url, failed } = useAttachedImage(props.threadId, props.image.id);
  if (failed) {
    return (
      <span className="u-img gone" title={props.image.name}>
        <I n="image" s={15} />
        Image indisponible
      </span>
    );
  }
  return (
    <button
      className="u-img"
      aria-label={`Agrandir ${props.image.name}`}
      title={props.image.name}
      disabled={!url}
      onClick={props.onOpen}
    >
      {url && <img src={url} alt={props.image.name} />}
    </button>
  );
}

/** One image at its full size, over the app. */
function Shown(props: { threadId: string; image: ImageRef; onClose: () => void }) {
  const { url } = useAttachedImage(props.threadId, props.image.id);
  return (
    <Viewer
      label={props.image.name}
      onClose={props.onClose}
      actions={
        url && (
          <a className="ivs press" href={url} download={props.image.name}>
            <I n="dl" s={18} />
            Télécharger
          </a>
        )
      }
    >
      {url ? (
        <img src={url} alt={props.image.name} />
      ) : (
        <span className="t2-spin" role="status" aria-label="Chargement" />
      )}
    </Viewer>
  );
}
