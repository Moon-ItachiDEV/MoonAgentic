/** A fenced block holding the lead's plan or rewritten brief, as the server reads it. */
const FENCED = /\n?```(?:json)?[ \t]*\r?\n\s*\{\s*"(?:tasks|brief)"\s*:[\s\S]*?```[ \t]*/gi;
/** One still being written, its fence not closed yet. */
const OPEN = /\n?```(?:json)?[ \t]*\r?\n\s*\{\s*"(?:tasks|brief)"[\s\S]*$/i;
/** The same, left without its fence, at the very end of the reply. */
const BARE = /\n\s*\{\s*"(?:tasks|brief)"\s*:[\s\S]*\}\s*$/;

/**
 * A lead's reply without the JSON block written for the server: the team card already shows
 * the pieces, so the raw block only gets in the way.
 */
export function withoutTeamJson(text: string): string {
  const out = text.replace(FENCED, "").replace(OPEN, "").replace(BARE, "");
  return out === text ? text : out.trimEnd();
}
