/** One line of a unified diff, with its numbers in the old and the new file. */
export type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "same"; text: string; old?: number; new?: number }
  | { kind: "note"; text: string };

/** Reads a file's hunks (`@@ -a,b +c,d @@` and the lines under it) into numbered lines. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), new: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), old: oldNo++ });
    } else if (raw.startsWith("\\")) {
      // « \ No newline at end of file »
      lines.push({ kind: "note", text: raw.slice(2) });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "same", text: raw.slice(1), old: oldNo++, new: newNo++ });
    }
  }
  return lines;
}

/** A remark on one line of the review, sent to the agent with the others. */
export interface LineComment {
  id: string;
  path: string;
  /** The line in the new file, or in the old one for a removed line. */
  line: number;
  removed: boolean;
  /** The line's code when the remark was written: what finds it again in a fresh diff. */
  code: string;
  text: string;
  /** Set when its line is no longer in the diff: the agent changed or removed it since. */
  lost?: boolean;
}

/** Where a row sits: in the old file for a removed line, in the new one otherwise. */
export function rowPlace(line: DiffLine): { removed: boolean; line: number } | undefined {
  if (line.kind === "del") return { removed: true, line: line.old ?? 0 };
  if (line.kind === "add" || line.kind === "same") return { removed: false, line: line.new ?? 0 };
  return undefined;
}

/**
 * The row of a file's current diff that a remark belongs to: the same line with the same
 * code, or else the only row on the same side with that code (lines above it moved).
 * -1 when its line is gone.
 */
export function findRow(
  lines: DiffLine[],
  anchor: Pick<LineComment, "line" | "removed" | "code">,
): number {
  let moved = -1;
  let matches = 0;
  for (const [i, line] of lines.entries()) {
    const place = rowPlace(line);
    if (!place || place.removed !== anchor.removed || line.text !== anchor.code) continue;
    if (place.line === anchor.line) return i;
    moved = i;
    matches += 1;
  }
  return matches === 1 ? moved : -1;
}

/** Where each remark sits in the review as it is now. */
export interface PlacedComments {
  /** By path, then by row of that file's diff. */
  rows: Map<string, Map<number, LineComment>>;
  /** Every remark, with its line as it is now; `lost` when that line is gone. */
  all: LineComment[];
}

/**
 * Finds each remark again in a fresh review, by file and line rather than by row, so a
 * remark stays on its line when the agent changes the file, and is flagged when it cannot.
 * Without files yet (the review is loading), every remark stays as it was.
 */
export function placeComments(
  files: { path: string; patch: string }[] | undefined,
  comments: LineComment[],
): PlacedComments {
  const rows = new Map<string, Map<number, LineComment>>();
  if (!files) return { rows, all: comments };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const parsed = new Map<string, DiffLine[]>();
  const all = comments.map((comment): LineComment => {
    const file = byPath.get(comment.path);
    if (!file) return { ...comment, lost: true };
    let lines = parsed.get(file.path);
    if (!lines) {
      lines = parsePatch(file.patch);
      parsed.set(file.path, lines);
    }
    const row = findRow(lines, comment);
    const fileRows = rows.get(file.path) ?? new Map<number, LineComment>();
    const line = row >= 0 ? rowPlace(lines[row]!)?.line : undefined;
    // Two remarks can land on one row once lines move: the first keeps it.
    if (line === undefined || fileRows.has(row)) return { ...comment, lost: true };
    const placed = { ...comment, line, lost: false };
    fileRows.set(row, placed);
    rows.set(file.path, fileRows);
    return placed;
  });
  return { rows, all };
}

/** The message that sends every remark of a review to the agent, in one turn. */
export function reviewMessage(comments: LineComment[]): string {
  const parts = comments.map((c) => {
    const where = `${c.path}, ligne ${c.line}${c.removed ? " (supprimée)" : ""}${
      c.lost ? ", qui a changé depuis" : ""
    }`;
    const code = c.code.trim() ? `\n  \`${c.code.trim().replaceAll("`", "'")}\`` : "";
    return `- ${where} :${code}\n  ${c.text.trim().replaceAll("\n", "\n  ")}`;
  });
  return `Relecture de tes modifications. Corrige ces points :\n\n${parts.join("\n")}`;
}

/**
 * The remarks left once a file's changes were dropped: those on it, under its name now or
 * before a rename, have no line left to be about.
 */
export function withoutFile<C extends Pick<LineComment, "path">>(
  comments: C[],
  file: { path: string; from?: string },
): C[] {
  return comments.filter((c) => c.path !== file.path && c.path !== file.from);
}
