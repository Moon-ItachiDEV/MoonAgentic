// The short texts the user decides by or finds a thing by: a thread's title, a tool call's,
// what a permission request asks and offers. They come from an agent, which may repeat what a
// file or a page told it to write, and are shown as they are.

/**
 * Characters that are not seen and change how a text reads. Those that reorder it: with one
 * (U+202E), a title written « Facture [U+202E]fdp.exe » reads « Facture exe.pdf », and a
 * command reads as another. Those that take no room or that no font draws, which hide in a
 * word or carry a whole text unseen. They are named by what Unicode says of them, not listed
 * one by one: a list always lacks some.
 */
const UNSEEN = new RegExp(
  [
    // Kept whole: the flags of England, Scotland and Wales, the one honest use of the tags.
    String.raw`(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})`,
    // Control characters, but those that end a line or a field: they become a space below.
    String.raw`(?![\t\n\v\f\r\u001C-\u001F\u0085])\p{Cc}`,
    // Format characters: what reorders a text, takes no room, or tags it. Not the two joiners
    // that emoji and some scripts are written with, nor the number signs that are drawn.
    String.raw`(?![\u200C\u200D\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u{110BD}\u{110CD}])\p{Cf}`,
    // What a font is told to draw nothing for: fillers, code points kept for later. Not the
    // joiners, nor the variation selectors, seen to below.
    String.raw`(?![\u200C\u200D]|\p{Variation_Selector})\p{Default_Ignorable_Code_Point}`,
  ].join("|"),
  "gu",
);

/**
 * Variation selectors and joiners, seen only through the characters beside them: a selector
 * says how the character before it is drawn, a joiner ties two characters. They come in runs
 * here, so that none stands for another: what a run keeps is decided once, below.
 */
const RIDERS = /[\u200C\u200D\p{Variation_Selector}]+/gu;
const JOINER = /^[\u200C\u200D]$/;
/** The selectors made for ideographs, and what they follow. */
const FOR_IDEOGRAPHS = /^[\u{E0100}-\u{E01EF}]$/u;
const IDEOGRAPH = /^\p{Ideographic}$/u;

/**
 * What a run of selectors and joiners keeps: at most a selector for the character before it,
 * then a joiner, as emoji are written, or a joiner alone that has a character on one side.
 * The rest does nothing but take no room, where a whole text could be carried unseen.
 */
function ridersKept(run: string, at: number, text: string): string {
  const [first = "", second = ""] = run;
  const before = text.slice(Math.max(0, at - 2), at).match(/[^]$/u)?.[0] ?? "";
  const after = text.slice(at + run.length, at + run.length + 1);
  const based = /^\S/u.test(before);
  if (JOINER.test(first)) return based || /\S/.test(after) ? first : "";
  if (!based || (FOR_IDEOGRAPHS.test(first) && !IDEOGRAPH.test(before))) return "";
  return JOINER.test(second) ? first + second : first;
}

/** Half of a character, left by a text cut in the wrong place: shown as the sign it draws as. */
const HALF = /\p{Cs}/gu;

/**
 * Line breaks, field separators and runs of spaces: a label is one line. The blank of
 * braille (U+2800) is a space to the eye, and no label is made of it alone.
 */
// oxlint-disable-next-line no-control-regex -- field separators are what is turned into a space
const BREAKS = /[\t\n\v\f\r\u001C-\u001F \u0085\u2028\u2029\u2800]+/g;

/**
 * A text as a label: one line, read as it is written. Nothing else is changed, and nothing
 * is cut: what a permission asks is shown whole.
 */
export function plainLabel(text: string): string {
  return (
    text
      .replace(UNSEEN, (_unseen, flag?: string) => flag ?? "")
      .replace(HALF, "\uFFFD")
      .replace(BREAKS, " ")
      .replace(RIDERS, ridersKept)
      // What was taken out between two spaces leaves one.
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

const CHARACTERS = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The start of a label, `length` long at most, cut between two characters as a reader counts
 * them: never inside an emoji, nor between a letter and its accent.
 */
export function labelStart(text: string, length: number): string {
  if (text.length <= length) return text;
  let end = 0;
  for (const { index, segment } of CHARACTERS.segment(text)) {
    if (index + segment.length > length) break;
    end = index + segment.length;
  }
  if (!end) {
    // One character longer than the whole label, a letter under a pile of accents: cut in
    // it then, but not in the middle of a code point.
    const last = text.charCodeAt(length - 1);
    end = last >= 0xd800 && last <= 0xdbff ? length - 1 : length;
  }
  return text.slice(0, end);
}
