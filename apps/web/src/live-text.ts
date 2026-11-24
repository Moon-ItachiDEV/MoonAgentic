import { useEffect, useRef, useState } from "react";

/** A text being written is drawn again this often at most: ten times a second reads as live. */
export const LIVE_TEXT_MS = 100;

/**
 * A text that grows many times a second, seen at a calmer pace: while `live`, it follows
 * the real one every `ms` at most, and always ends on its last value. Once no longer
 * live, it is the real text at once.
 */
/**
 * A text being written, without the link or image still open at its end: until its address
 * is closed, Markdown shows it raw (« [Ouvrir l'image](<C:/Users/…/.codex/generated_ima »),
 * a long path of the computer flashing by before the image takes its place.
 */
export const withoutOpenLink = (text: string): string =>
  text.replace(/!?\[[^\]\n]*(?:\](?:\((?:<[^>\n]*|[^)\s<]*)?)?)?$/, "");

export function useLiveText(text: string, live: boolean, ms: number = LIVE_TEXT_MS): string {
  const [shown, setShown] = useState(text);
  const drawnAt = useRef(0);
  // Not live: nothing to wait for, and nothing stale left for the next time it is.
  if (!live && shown !== text) setShown(text);
  useEffect(() => {
    if (!live) return;
    const draw = () => {
      drawnAt.current = performance.now();
      setShown(text);
    };
    const wait = drawnAt.current + ms - performance.now();
    if (wait <= 0) return draw();
    const timer = setTimeout(draw, wait);
    return () => clearTimeout(timer);
  }, [text, live, ms]);
  return live ? withoutOpenLink(shown) : text;
}
