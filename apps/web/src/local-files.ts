// The files an agent names in its answer as paths of the computer it runs on: an image it
// generated (`![…](C:\Users\…\image.png)`, `file:///…`), a file it links to. No browser reads
// such a path, and a phone or a tablet has no such file: the server gives a short-lived
// address of its own for each, if the file is one it may show.
import type { ServerMessage } from "@moonagentic/protocol";
import type { MarkedExtension, Tokens } from "marked";
import { connection, newId } from "./connection.ts";

/** What an answer's local link or image is rewritten to, before it is cleaned. */
export const LOCAL_MARK = "#moon-file:";

/**
 * Whether an address written in an answer names a file of the computer: a path, absolute or
 * not, or a `file:` address. Web addresses, anchors and inline images are not.
 */
export function isLocalRef(ref: string): boolean {
  const raw = ref.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith("\\\\")) return false;
  if (/^file:/i.test(raw)) return true;
  // `C:\…` or `C:/…`: a Windows drive, not a scheme.
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return true;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

/**
 * The address as the agent wrote it. Markdown takes a backslash before some characters as an
 * escape, which a Windows path is full of (`\.gemini`): its own text keeps them.
 */
export function writtenRef(token: { raw: string; href: string }): string {
  const written =
    /\]\(\s*(?:<([^>\n]*)>|([^\s<>]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/.exec(token.raw);
  const ref = written?.[1] ?? written?.[2];
  return ref && ref.includes("\\") ? ref : token.href;
}

/** Marks the links and images of an answer that name local files, to be shown from the server. */
export const localFiles: MarkedExtension = {
  walkTokens(token) {
    if (token.type !== "image" && token.type !== "link") return;
    const link = token as Tokens.Image | Tokens.Link;
    const ref = writtenRef(link);
    if (isLocalRef(ref)) link.href = LOCAL_MARK + encodeURIComponent(ref);
  },
};

/** The local file a marked address names, or nothing for any other address. */
export function markedRef(href: string | null): string | undefined {
  if (!href?.startsWith(LOCAL_MARK)) return undefined;
  try {
    return decodeURIComponent(href.slice(LOCAL_MARK.length));
  } catch {
    return undefined;
  }
}

/** The file's own name, as the agent wrote it, for what shows before the server answers. */
export const refName = (ref: string) =>
  ref
    .replace(/[?#].*$/, "")
    .split(/[\\/]/)
    .pop() || ref;

export type FileLink = Extract<ServerMessage, { type: "fileLink" }>;

/** An address is asked again this long before it stops working. */
const MARGIN_MS = 60_000;
/** A file that could not be had is asked for again after this, not at each redraw. */
const RETRY_MS = 15_000;
const MAX_KEPT = 300;

interface Kept {
  read: Promise<FileLink>;
  link?: FileLink;
  failedAt?: number;
}
const kept = new Map<string, Kept>();

const keyOf = (threadId: string, ref: string) => `${threadId}\n${ref}`;

function fresh(entry: Kept | undefined, now: number): boolean {
  if (!entry) return false;
  if (entry.failedAt !== undefined) return now - entry.failedAt < RETRY_MS;
  return !entry.link || entry.link.expiresAt - MARGIN_MS > now;
}

/** The address of a file an answer of this thread names, once the server has given it. */
export function knownLink(threadId: string, ref: string, now = Date.now()): FileLink | undefined {
  const entry = kept.get(keyOf(threadId, ref));
  return entry && fresh(entry, now) ? entry.link : undefined;
}

/** Asks the server for an address to see this file; rejects with what to tell the user. */
export function fileLink(threadId: string, ref: string, now = Date.now()): Promise<FileLink> {
  const key = keyOf(threadId, ref);
  const entry = kept.get(key);
  if (entry && fresh(entry, now)) return entry.read;
  const next: Kept = {
    read: connection.ask({ type: "file.open", requestId: newId(), threadId, ref }),
  };
  next.read.then(
    (link) => void (next.link = link),
    () => void (next.failedAt = Date.now()),
  );
  kept.delete(key);
  kept.set(key, next);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  return next.read;
}

/** Forgets every address: another token, or a project locked. */
export function forgetFileLinks(): void {
  kept.clear();
}

connection.subscribe(() => {
  if (connection.getState().status === "unauthorized") forgetFileLinks();
});
