// The images joined to the message being written: each is sent to the server as soon as it
// is picked, and taken back if the message leaves without it.
import type { ImageRef } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { discardImage, rememberImage, uploadImage } from "./attachments.ts";
import { connection, newId } from "./connection.ts";
import { prepareImage, roomFor, TOO_MANY } from "./images.ts";

export interface ImageDraft {
  key: string;
  name: string;
  /** An address of this page's own to show it, once the file is read. */
  preview?: string;
  /** Known to the server once it is sent: what the message names. */
  image?: ImageRef;
}

interface Entry extends ImageDraft {
  stop: AbortController;
}

export interface ImageDrafts {
  drafts: ImageDraft[];
  /** True while one is still on its way to the server. */
  sending: boolean;
  /** Those the server has, in the order they were joined. */
  ready: ImageRef[];
  add(files: File[]): void;
  remove(key: string): void;
  /** The message left with them: they are its own now. */
  sent(): void;
}

export function useImageDrafts(): ImageDrafts {
  const list = useRef<Entry[]>([]);
  const [, render] = useState(0);
  const put = (next: Entry[]) => {
    list.current = next;
    render((n) => n + 1);
  };
  const forget = (entry: Entry, keepOnServer = false) => {
    entry.stop.abort();
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    if (entry.image && !keepOnServer) discardImage(entry.image.id);
  };

  // Leaving the composer with images not sent: the server does not keep them waiting.
  useEffect(
    () => () => {
      for (const entry of list.current) forget(entry);
      list.current = [];
    },
    [],
  );

  const add = (files: File[]) => {
    const room = roomFor(list.current.length, files.length);
    if (room < files.length) connection.notify(TOO_MANY);
    for (const file of files.slice(0, room)) {
      const entry: Entry = {
        key: newId(),
        name: file.name || "image",
        stop: new AbortController(),
      };
      const { key, stop } = entry;
      const update = (change: Partial<ImageDraft>) =>
        put(list.current.map((e) => (e.key === key ? { ...e, ...change } : e)));
      put([...list.current, entry]);
      void (async () => {
        try {
          const prepared = await prepareImage(file);
          if (stop.signal.aborted) return;
          update({ preview: URL.createObjectURL(prepared.blob), name: prepared.name });
          const image = await uploadImage(prepared.blob, prepared.name, stop.signal);
          if (stop.signal.aborted) return discardImage(image.id);
          rememberImage(image.id, prepared.blob);
          update({ image });
        } catch (error) {
          if (stop.signal.aborted) return;
          const failed = list.current.find((e) => e.key === key);
          if (failed) forget(failed);
          put(list.current.filter((e) => e.key !== key));
          connection.notify(error instanceof Error ? error.message : String(error));
        }
      })();
    }
  };

  const remove = (key: string) => {
    const entry = list.current.find((e) => e.key === key);
    if (!entry) return;
    forget(entry);
    put(list.current.filter((e) => e.key !== key));
  };

  const sent = () => {
    for (const entry of list.current) forget(entry, true);
    put([]);
  };

  const drafts = list.current;
  return {
    drafts,
    sending: drafts.some((d) => !d.image),
    ready: drafts.flatMap((d) => (d.image ? [d.image] : [])),
    add,
    remove,
    sent,
  };
}
