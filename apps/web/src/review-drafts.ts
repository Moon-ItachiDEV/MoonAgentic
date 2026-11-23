// The remarks written in a review and not sent yet, kept on this device: closing the panel,
// opening another thread or loading the page again does not lose them.
import type { LineComment } from "./diff.ts";
import { readPref, writePref } from "./prefs.ts";

const KEY = "reviewDrafts";
/** Threads whose remarks are kept: beyond that, the ones touched longest ago leave. */
export const MAX_DRAFT_THREADS = 20;
/** Remarks kept for one thread. */
export const MAX_DRAFTS = 100;

interface Kept {
  /** When the thread's remarks last changed. */
  at: number;
  comments: LineComment[];
}

const isComment = (c: unknown): c is LineComment => {
  if (!c || typeof c !== "object") return false;
  const { id, path, line, removed, code, text } = c as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof path === "string" &&
    typeof line === "number" &&
    typeof removed === "boolean" &&
    typeof code === "string" &&
    typeof text === "string"
  );
};

/** What is kept, by thread. Anything not written by this code is left out. */
function all(): Record<string, Kept> {
  let raw: unknown;
  try {
    raw = JSON.parse(readPref(KEY) ?? "{}");
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const kept: Record<string, Kept> = {};
  for (const [threadId, value] of Object.entries(raw)) {
    const { at, comments } = (value ?? {}) as Partial<Kept>;
    if (typeof at !== "number" || !Array.isArray(comments)) continue;
    const valid = comments.filter(isComment);
    if (valid.length) kept[threadId] = { at, comments: valid };
  }
  return kept;
}

/** The remarks kept for a thread's review. */
export function readReviewDrafts(threadId: string): LineComment[] {
  // Whether a remark's line is still in the diff is found again against the diff of now.
  return (all()[threadId]?.comments ?? []).map(({ lost: _lost, ...comment }) => comment);
}

/** Keeps a thread's remarks as they are now; with none left, the thread is forgotten. */
export function writeReviewDrafts(threadId: string, comments: LineComment[], now = Date.now()) {
  const kept = all();
  const before = kept[threadId]?.comments ?? [];
  if (!comments.length && !before.length) return;
  if (comments.length) kept[threadId] = { at: now, comments: comments.slice(-MAX_DRAFTS) };
  else delete kept[threadId];
  const recent = Object.entries(kept)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_DRAFT_THREADS);
  writePref(KEY, JSON.stringify(Object.fromEntries(recent)));
}
