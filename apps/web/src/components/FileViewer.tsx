import { useEffect, useState } from "react";
import { fileSize } from "../file-tree.ts";
import { type FileLink, fileLink, refName } from "../local-files.ts";
import { I } from "../v2/I.tsx";
import { Viewer } from "../v2/Viewer.tsx";

/**
 * A file an answer names, over the page: an image at its full size, any other file by its
 * name; both to open in a tab of its own or to keep on the device, from a phone as well.
 */
export function FileViewer(props: { threadId: string; fileRef: string; onClose: () => void }) {
  const [link, setLink] = useState<FileLink>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setLink(undefined);
    setError(undefined);
    fileLink(props.threadId, props.fileRef).then(
      (found) => current && setLink(found),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [props.threadId, props.fileRef]);
  const name = link?.name ?? refName(props.fileRef);
  const image = link?.mime.startsWith("image/");
  return (
    <Viewer
      label={name}
      onClose={props.onClose}
      actions={
        link && (
          <>
            <a className="ivs press" href={link.url} target="_blank" rel="noopener noreferrer">
              <I n="ext" s={18} />
              Ouvrir
            </a>
            <a className="ivs press" href={link.url} download={name}>
              <I n="dl" s={18} />
              Télécharger
            </a>
          </>
        )
      }
    >
      {error ? (
        <div className="ivc" role="alert">
          <I n="file" s={22} />
          <b>{name}</b>
          <small>{error}</small>
        </div>
      ) : !link ? (
        <span className="t2-spin" role="status" aria-label="Chargement" />
      ) : image ? (
        <img src={link.url} alt={name} />
      ) : (
        <div className="ivc">
          <I n="file" s={22} />
          <b>{name}</b>
          <small>{fileSize(link.size)}</small>
        </div>
      )}
    </Viewer>
  );
}
