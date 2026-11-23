import type { ImageRef } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAttachedImage } from "../attachments.ts";
import { IconClose, IconImage } from "./icons.tsx";

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
        <Viewer threadId={props.threadId} image={shown} onClose={() => setShown(undefined)} />
      )}
    </div>
  );
}

function Thumbnail(props: { threadId: string; image: ImageRef; onOpen: () => void }) {
  const { url, failed } = useAttachedImage(props.threadId, props.image.id);
  if (failed) {
    return (
      <span className="u-img gone" title={props.image.name}>
        <IconImage />
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

/** One image at its full size, over the page. */
function Viewer(props: { threadId: string; image: ImageRef; onClose: () => void }) {
  const { url } = useAttachedImage(props.threadId, props.image.id);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      props.onClose();
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  // On the page itself, so no message's own layout clips it.
  return createPortal(
    <div
      className="scrim img-view"
      role="dialog"
      aria-modal
      aria-label={props.image.name}
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      {url && <img src={url} alt={props.image.name} />}
      <button
        ref={close}
        className="img-view-x"
        aria-label="Fermer l'image"
        onClick={props.onClose}
      >
        <IconClose size={16} />
      </button>
    </div>,
    document.body,
  );
}
