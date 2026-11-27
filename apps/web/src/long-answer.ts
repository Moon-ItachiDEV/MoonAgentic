/**
 * How much of a long answer is drawn at first. Past it, the rest waits for « Afficher la
 * suite »: a reply of hundreds of kilobytes made a long thread slow to open on a phone
 * (audit N35).
 */
export const ANSWER_SHOWN_CHARS = 20_000;

/**
 * The start of a long Markdown text, cut between two paragraphs and never inside a block of
 * code, and how many characters are left after it. A short text is given whole.
 */
export function answerHead(
  text: string,
  most = ANSWER_SHOWN_CHARS,
): { head: string; left: number } {
  if (text.length <= most) return { head: text, left: 0 };
  let cut = text.lastIndexOf("\n\n", most);
  if (cut <= 0) cut = text.lastIndexOf("\n", most);
  if (cut <= 0) cut = most;
  // A block of code around the cut: cut before it, or after it when it opens the answer.
  const block = codeBlocks(text).find(([start, end]) => start < cut && cut < end);
  if (block) cut = text.slice(0, block[0]).trim() ? block[0] : block[1];
  const head = text.slice(0, cut).trimEnd();
  // Nothing but blank after it: the answer is whole.
  if (!text.slice(head.length).trim()) return { head: text, left: 0 };
  return { head, left: text.length - head.length };
}

/**
 * Where the blocks of code of a Markdown text start and end. A block closes on a fence of its
 * own kind, at least as long and alone on its line: a ``` shown inside a ~~~ block is text.
 */
function codeBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let open: { at: number; mark: string } | undefined;
  for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const mark = m[1]!;
    if (!open) {
      // A ``` fence's words hold no backtick; otherwise it is code in a line.
      if (mark[0] === "`" && m[2]!.includes("`")) continue;
      open = { at: m.index, mark };
    } else if (mark[0] === open.mark[0] && mark.length >= open.mark.length && !m[2]!.trim()) {
      blocks.push([open.at, m.index + m[0].length]);
      open = undefined;
    }
  }
  if (open) blocks.push([open.at, text.length]);
  return blocks;
}
