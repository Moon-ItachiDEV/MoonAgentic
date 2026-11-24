// The files an agent names in its answer as paths of the computer it runs on: an image it
// generated (`![…](C:\Users\…\image.png)`, `file:///…`), a file it links to. No browser reads
// such a path, and a phone or a tablet has no such file: the server gives a short-lived
// address of its own for each, if the file is one it may show.
import type { ServerMessage } from "@moonagentic/protocol";
import type { MarkedExtension, Token, Tokens } from "marked";
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
 * The address exactly as the agent wrote it, which the server finds again in its answer.
 * Markdown would change it: a backslash before some characters is an escape, which a Windows
 * path is full of (`\.gemini`), and accents and spaces are encoded.
 */
export function writtenRef(token: { raw: string; href: string }): string {
  // The last address of its text: a link around an image has the image's before its own.
  const written =
    /\]\(\s*(?:<([^>\n]*)>|([^\s<>()[\]]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/.exec(
      token.raw,
    );
  return written?.[1] ?? written?.[2] ?? token.href;
}

/** Whether a file's name says it is an image the thread shows. */
export const isImageRef = (ref: string) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(refName(ref));

/** Every token of a parsed answer, those inside others included. */
function allTokens(tokens: Token[], into: Token[] = []): Token[] {
  for (const token of tokens) {
    into.push(token);
    const inner = token as { tokens?: Token[]; items?: Token[] };
    if (inner.tokens) allTokens(inner.tokens, into);
    if (inner.items) allTokens(inner.items, into);
  }
  return into;
}

const sameFile = (a: string, b: string) => refName(a).toLowerCase() === refName(b).toLowerCase();

/** The text of a line that is only words, or nothing when it holds more than that. */
function plainText(tokens: Token[]): string | undefined {
  let text = "";
  for (const t of tokens) {
    if (t.type === "text" && !(t as Tokens.Text).tokens) text += (t as Tokens.Text).text;
    else if (t.type === "br") text += " ";
    else return undefined;
  }
  return text.trim();
}

/**
 * An agent that shows its image often adds « Fichier enregistré : » and a link to the same
 * file under it. The image is there already, so that line is only noise: a paragraph that
 * holds nothing but a short label and a link to an image the answer shows is left out.
 */
function dropLinksToShownImages(all: Token[], images: Tokens.Image[]): void {
  const shown = images.map(writtenRef);
  for (const token of all) {
    if (token.type !== "paragraph") continue;
    const inline = (token as Tokens.Paragraph).tokens;
    const links = inline.filter((t): t is Tokens.Link => t.type === "link");
    if (links.length !== 1) continue;
    const link = links[0]!;
    const ref = writtenRef(link);
    // Its text names the file, as the agent wrote it: not a sentence the link is part of.
    const named = link.text.trim() === ref || sameFile(link.text, ref);
    if (!isLocalRef(ref) || !isImageRef(ref) || !named) continue;
    if (!shown.some((image) => sameFile(image, ref))) continue;
    const rest = plainText(inline.filter((t) => t !== link));
    if (rest === undefined || (rest !== "" && !/^.{1,40}:$/.test(rest))) continue;
    const gone = token as unknown as Record<string, unknown>;
    for (const key of Object.keys(gone)) delete gone[key];
    Object.assign(gone, { type: "space", raw: "" });
  }
}

/** Marks the links and images of an answer that name local files, to be shown from the server. */
export const localFiles: MarkedExtension = {
  hooks: {
    // An agent that generated an image often only links to it (« [naruto.jpg](naruto.jpg) »):
    // the image is shown in its place, as it would be had it written `![…](…)`. When the
    // answer shows an image already, its links stay links, but a line that only repeats the
    // image's file under it is left out.
    processAllTokens(tokens) {
      const all = allTokens(tokens);
      const images = all.filter((t): t is Tokens.Image => t.type === "image");
      if (images.length) {
        dropLinksToShownImages(all, images);
        return tokens;
      }
      for (const token of all) {
        if (token.type !== "link") continue;
        const link = token as Tokens.Link;
        const ref = writtenRef(link);
        if (!isLocalRef(ref) || !isImageRef(ref)) continue;
        const image: Tokens.Image = {
          type: "image",
          raw: link.raw,
          href: link.href,
          title: link.title ?? null,
          text: link.text,
          tokens: link.tokens,
        };
        for (const key of Object.keys(link))
          delete (link as unknown as Record<string, unknown>)[key];
        Object.assign(link, image);
      }
      return tokens;
    },
  },
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
    // Asked once the app is connected: a thread shown while it connects again waits for it.
    read: whenOpen().then(() =>
      connection.ask({ type: "file.open", requestId: newId(), threadId, ref }),
    ),
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

/** Forgets the address of one file, which no longer served it. */
export function forgetFileLink(threadId: string, ref: string): void {
  kept.delete(keyOf(threadId, ref));
}

/**
 * Forgets every address. The server gives them for as long as it runs: once the connection is
 * lost, it may have started again without them, or with another token.
 */
export function forgetFileLinks(): void {
  kept.clear();
}

/** Resolves once the app is connected to the server. */
function whenOpen(): Promise<void> {
  if (connection.getState().status === "open") return Promise.resolve();
  return new Promise((resolve) => {
    const stop = connection.subscribe(() => {
      if (connection.getState().status !== "open") return;
      stop();
      resolve();
    });
  });
}

let wasOpen = false;
connection.subscribe(() => {
  const open = connection.getState().status === "open";
  if (wasOpen && !open) forgetFileLinks();
  wasOpen = open;
});
