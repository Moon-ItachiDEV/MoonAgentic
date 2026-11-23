// The server's side of the images joined to messages: sent before the message, read back
// with the token, which an <img> address cannot carry.
import type { ImageRef } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "./connection.ts";

const PATH = "/api/attachments";
/** How many images no message shows any more are kept ready, in case one comes back. */
const IDLE_KEPT = 24;

const authorization = () => ({ authorization: `Bearer ${connection.getToken()}` });

/** Sends an image ahead of its message. Rejects with what to tell the user. */
export async function uploadImage(
  blob: Blob,
  name: string,
  signal?: AbortSignal,
): Promise<ImageRef> {
  let response: Response;
  try {
    response = await fetch(PATH, {
      method: "POST",
      headers: {
        ...authorization(),
        "content-type": blob.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
      },
      body: blob,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Pas de connexion : l'image n'est pas partie.");
  }
  const body = (await response.json().catch(() => null)) as
    (Partial<ImageRef> & { message?: string }) | null;
  if (!response.ok || !body?.id) {
    throw new Error(body?.message ?? `L'image n'a pas pu être envoyée (${response.status}).`);
  }
  return body as ImageRef;
}

/** Takes back an image sent ahead of a message that will not carry it. */
export function discardImage(id: string): void {
  void fetch(`${PATH}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authorization(),
    keepalive: true,
  }).catch(() => undefined);
}

interface Read {
  /** An address of this page's own for the image. */
  url: string;
  blob: Blob;
}
interface Held {
  threadId?: string;
  read: Promise<Read>;
  users: number;
  used: number;
}

/** The images read so far, by id. */
const held = new Map<string, Held>();
let clock = 0;

/** Drops cached attachment blobs and revokes their object URLs (optionally for hidden threads only). */
export function clearAttachmentCache(keepThreadIds?: ReadonlySet<string>): void {
  for (const [id, entry] of held) {
    if (keepThreadIds && (!entry.threadId || keepThreadIds.has(entry.threadId))) continue;
    held.delete(id);
    void entry.read.then(({ url }) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
}

let lastThreads: Set<string> | null = null;
connection.subscribe(() => {
  const state = connection.getState();
  if (state.status === "unauthorized") {
    lastThreads = null;
    clearAttachmentCache();
    return;
  }
  if (!state.ready) return;
  const current = new Set(state.threads.map((t) => t.id));
  if (lastThreads) {
    for (const id of lastThreads) {
      if (!current.has(id)) {
        clearAttachmentCache(current);
        break;
      }
    }
  }
  lastThreads = current;
});

function trim(): void {
  const idle = [...held].filter(([, h]) => h.users === 0).sort((a, b) => a[1].used - b[1].used);
  for (const [id, h] of idle.slice(0, Math.max(0, idle.length - IDLE_KEPT))) {
    held.delete(id);
    void h.read.then(({ url }) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
}

/** Keeps the image just sent, so its message shows it without reading it back. */
export function rememberImage(id: string, blob: Blob): void {
  if (held.has(id)) return;
  const read = Promise.resolve({ url: URL.createObjectURL(blob), blob });
  held.set(id, { read, users: 0, used: ++clock });
  trim();
}

async function fetchImage(threadId: string, id: string): Promise<Read> {
  const response = await fetch(
    `${PATH}/${encodeURIComponent(threadId)}/${encodeURIComponent(id)}`,
    {
      headers: authorization(),
    },
  );
  if (!response.ok) throw new Error(`Image introuvable (${response.status}).`);
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), blob };
}

function acquire(threadId: string, id: string): Promise<Read> {
  let entry = held.get(id);
  if (!entry) {
    const fresh: Held = { threadId, read: fetchImage(threadId, id), users: 0, used: 0 };
    held.set(id, fresh);
    // One that could not be read is asked for again the next time it shows.
    fresh.read.catch(() => held.get(id) === fresh && held.delete(id));
    entry = fresh;
  } else if (!entry.threadId) {
    entry.threadId = threadId;
  }
  entry.users += 1;
  entry.used = ++clock;
  return entry.read;
}

function release(id: string): void {
  const entry = held.get(id);
  if (!entry) return;
  entry.users = Math.max(0, entry.users - 1);
  trim();
}

/** The bytes of an image of a thread, to send it again with another message. */
export async function imageBlob(threadId: string, id: string): Promise<Blob> {
  try {
    return (await acquire(threadId, id)).blob;
  } finally {
    release(id);
  }
}

/** An address for an image of a thread, once it is read; `failed` when it cannot be. */
export function useAttachedImage(
  threadId: string,
  id: string,
): { url: string | undefined; failed: boolean } {
  const [state, setState] = useState<{ id: string; url?: string; failed?: true }>({ id });
  useEffect(() => {
    let current = true;
    acquire(threadId, id).then(
      ({ url }) => current && setState({ id, url }),
      () => current && setState({ id, failed: true }),
    );
    return () => {
      current = false;
      release(id);
    };
  }, [threadId, id]);
  return state.id === id
    ? { url: state.url, failed: !!state.failed }
    : { url: undefined, failed: false };
}
