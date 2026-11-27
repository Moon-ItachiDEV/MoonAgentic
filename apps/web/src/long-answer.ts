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
  // A block of code still open at the cut: cut before it instead, unless it is the first.
  const fences = [...text.slice(0, cut).matchAll(/^ {0,3}(```|~~~)/gm)];
  if (fences.length % 2 === 1) {
    const open = fences.at(-1)!.index;
    if (open > 0) cut = open;
    else {
      // One block from the start, longer than what is drawn: the whole block is drawn.
      const close = /^ {0,3}(```|~~~)\s*$/gm;
      close.lastIndex = text.indexOf("\n") + 1;
      const end = close.exec(text);
      cut = end ? end.index + end[0].length : text.length;
    }
  }
  const head = text.slice(0, cut).trimEnd();
  return { head, left: text.length - head.length };
}
