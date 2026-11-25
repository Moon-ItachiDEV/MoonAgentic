// The short texts the user decides by or finds a thing by: a thread's title, a tool call's,
// what a permission request asks and offers. They come from an agent, which may repeat what a
// file or a page told it to write, and are shown as they are.

/**
 * Characters that are not seen and change how a text reads. Those that reorder it: with one
 * (U+202E), a title written « Facture [U+202E]fdp.exe » reads « Facture exe.pdf », and a
 * command reads as another. Those that take no room, and control characters. The two joiners
 * that emoji and some scripts are written with (U+200C, U+200D) are not among them.
 */
const UNSEEN =
  /(?![\t\n\v\f\r])\p{Cc}|[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/gu;

/** Line breaks and runs of spaces: a label is one line. */
const BREAKS = /[\t\n\v\f\r \u2028\u2029]+/g;

/**
 * A text as a label: one line, read as it is written. Nothing else is changed, and nothing
 * is cut: what a permission asks is shown whole.
 */
export function plainLabel(text: string): string {
  return text.replace(UNSEEN, "").replace(BREAKS, " ").trim();
}
