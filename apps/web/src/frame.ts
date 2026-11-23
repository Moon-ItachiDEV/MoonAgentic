// The screen is drawn once per frame: what arrives faster than that waits for the next one.

/** How long a tab nobody looks at waits: the browser gives it no frame at all. */
export const HIDDEN_FRAME_MS = 200;

/** Runs once at the next frame the screen draws; the function returned calls it off. */
export function nextFrame(run: () => void): () => void {
  const visible = typeof document === "undefined" || !document.hidden;
  if (typeof requestAnimationFrame === "function" && visible) {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, HIDDEN_FRAME_MS);
  return () => clearTimeout(id);
}
