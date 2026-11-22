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
  path: string;
  /** The line in the new file, or in the old one for a removed line. */
  line: number;
  removed: boolean;
  code: string;
  text: string;
}

/** The message that sends every remark of a review to the agent, in one turn. */
export function reviewMessage(comments: LineComment[]): string {
  const parts = comments.map((c) => {
    const where = `${c.path}, ligne ${c.line}${c.removed ? " (supprimée)" : ""}`;
    const code = c.code.trim() ? `\n  \`${c.code.trim().replaceAll("`", "'")}\`` : "";
    return `- ${where} :${code}\n  ${c.text.trim().replaceAll("\n", "\n  ")}`;
  });
  return `Relecture de tes modifications. Corrige ces points :\n\n${parts.join("\n")}`;
}
