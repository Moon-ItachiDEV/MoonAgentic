import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileSize } from "../file-tree.ts";
import { type FileLink, fileLink, refName } from "../local-files.ts";
import { IconClose, IconDownload, IconExternal, IconFile } from "./icons.tsx";

/**
 * A file an answer names, over the page: an image at its full size, any other file by its
 * name; both to open in a tab of its own or to keep on the device, from a phone as well.
 */
export function FileViewer(props: { threadId: string; fileRef: string; onClose: () => void }) {
  const [link, setLink] = useState<FileLink>();
  const [error, setError] = useState<string>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let current = true;
    fileLink(props.threadId, props.fileRef).then(
      (found) => current && setLink(found),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [props.threadId, props.fileRef]);
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
  const name = link?.name ?? refName(props.fileRef);
  const image = link?.mime.startsWith("image/");
  // On the page itself, so no message's own layout clips it.
  return createPortal(
    <div
      className="scrim img-view file-view"
      role="dialog"
      aria-modal
      aria-label={name}
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      {error ? (
        <div className="file-view-card" role="alert">
          <IconFile size={18} />
          <strong>{name}</strong>
          <p>{error}</p>
        </div>
      ) : !link ? (
        <p className="file-view-wait">Chargement…</p>
      ) : image ? (
        <img src={link.url} alt={name} />
      ) : (
        <div className="file-view-card">
          <IconFile size={18} />
          <strong>{name}</strong>
          <small>{fileSize(link.size)}</small>
        </div>
      )}
      {link && (
        <div className="file-view-bar">
          <a className="btn sm" href={link.url} target="_blank" rel="noopener noreferrer">
            <IconExternal size={14} />
            Ouvrir
          </a>
          <a className="btn sm" href={link.url} download={name}>
            <IconDownload size={14} />
            Télécharger
          </a>
        </div>
      )}
      <button ref={close} className="img-view-x" aria-label="Fermer" onClick={props.onClose}>
        <IconClose size={16} />
      </button>
    </div>,
    document.body,
  );
}
