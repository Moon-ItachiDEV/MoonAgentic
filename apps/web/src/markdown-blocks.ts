// Splits a Markdown answer being streamed into frozen top-level blocks and a single open tail.
// Only the tail is parsed and redrawn as tokens arrive; once streaming ends, Markdown runs one
// full pass over the whole answer so document-wide constructs (such as reference links) resolve.

export interface StreamingBlocks {
  /** Top-level Markdown blocks that will not change while more text arrives after them. */
  readonly committed: readonly string[];
  /** Character offset in the source text where the open tail begins. */
  readonly offset: number;
  /** Exact prefix `text.slice(0, offset)` from which `committed` was split. */
  readonly prefix: string;
}

export const EMPTY_BLOCKS: StreamingBlocks = { committed: [], offset: 0, prefix: "" };

/** Even a very long loose list splits past this size so tail re-parsing stays bounded. */
const MAX_LOOSE_LIST_CHARS = 4_000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INDENTED = /^(?: {2,}|\t)/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s/;
const AMBIGUOUS_START = /^ {0,3}(?:[-+*>]|\d{1,9}[.)]?)$/;
const HTML_OPEN = /<(details|pre|table|div|section|article|aside|figure|blockquote)(?=[\s>])/gi;
const HTML_CLOSE = /<\/(details|pre|table|div|section|article|aside|figure|blockquote)\s*>/gi;

function fenceClosing(line: string, fence: { char: string; len: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === fence.char && m[1]!.length >= fence.len;
}

function htmlBalanceDelta(line: string, inComment: boolean): { delta: number; inComment: boolean } {
  let comment = inComment;
  let delta = 0;
  let rest = line;
  while (rest.length > 0) {
    if (comment) {
      const end = rest.indexOf("-->");
      if (end < 0) return { delta, inComment: true };
      comment = false;
      rest = rest.slice(end + 3);
      continue;
    }
    const start = rest.indexOf("<!--");
    const segment = start < 0 ? rest : rest.slice(0, start);
    for (const _ of segment.matchAll(HTML_OPEN)) delta += 1;
    for (const _ of segment.matchAll(HTML_CLOSE)) delta -= 1;
    if (start < 0) break;
    comment = true;
    rest = rest.slice(start + 4);
  }
  return { delta, inComment: comment };
}

/**
 * Advances `prev` to cover `text`, scanning only from `prev.offset` when `text` still begins
 * with `prev.prefix` (true even when `withoutOpenLink` trims an incomplete link in the tail).
 */
export function advanceMarkdownBlocks(prev: StreamingBlocks, text: string): StreamingBlocks {
  const reuse = prev.offset > 0 && text.startsWith(prev.prefix);
  const start = reuse ? prev.offset : 0;
  let committed: string[] | null = null;
  let blockStart = start;
  let blockFirstLine = "";
  let blankEnd = -1;
  let fence: { char: string; len: number } | null = null;
  let htmlDepth = 0;
  let inComment = false;

  let pos = start;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const raw = text.slice(pos, lineEnd);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const nextPos = nl < 0 ? text.length : nl + 1;
    const incomplete = nl < 0;

    if (fence) {
      if (!incomplete && fenceClosing(line, fence)) fence = null;
      pos = nextPos;
      continue;
    }

    const blank = line.trim().length === 0;
    if (blank) {
      if (blockFirstLine && htmlDepth === 0 && !inComment && blankEnd < 0) {
        blankEnd = pos;
      }
      pos = nextPos;
      continue;
    }

    if (blankEnd >= 0 && htmlDepth === 0 && !inComment) {
      const keepTogether =
        INDENTED.test(line) ||
        (incomplete && AMBIGUOUS_START.test(line)) ||
        (QUOTE.test(blockFirstLine) && QUOTE.test(line)) ||
        (LIST_ITEM.test(blockFirstLine) &&
          (LIST_ITEM.test(line) || (incomplete && AMBIGUOUS_START.test(line))) &&
          blankEnd - blockStart < MAX_LOOSE_LIST_CHARS);

      if (!keepTogether) {
        committed ??= reuse ? [...prev.committed] : [];
        committed.push(text.slice(blockStart, blankEnd).trimEnd());
        blockStart = pos;
        blockFirstLine = "";
        blankEnd = -1;
      } else {
        blankEnd = -1;
      }
    }

    if (!blockFirstLine) blockFirstLine = line;

    const opened = FENCE_OPEN.exec(line);
    if (opened) {
      const mark = opened[1]!;
      if (!(mark[0] === "`" && opened[2]!.includes("`"))) {
        fence = { char: mark[0]!, len: mark.length };
        pos = nextPos;
        continue;
      }
    }

    const html = htmlBalanceDelta(line, inComment);
    htmlDepth = Math.max(0, htmlDepth + html.delta);
    inComment = html.inComment;

    pos = nextPos;
  }

  if (!committed) {
    return reuse ? prev : EMPTY_BLOCKS;
  }
  return {
    committed,
    offset: blockStart,
    prefix: text.slice(0, blockStart),
  };
}
