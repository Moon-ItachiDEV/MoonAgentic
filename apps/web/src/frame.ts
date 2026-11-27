// The screen is drawn once per frame: what arrives faster than that waits for the next one.
import { isPageHidden } from "./visibility.ts";

/** How long a tab or tray-hidden window nobody looks at waits: no 60 FPS frame loop. */
export const HIDDEN_FRAME_MS = 200;

/** Runs once at the next frame the screen draws; the function returned calls it off. */
export function nextFrame(run: () => void): () => void {
  const visible = !isPageHidden();
  if (typeof requestAnimationFrame === "function" && visible) {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, HIDDEN_FRAME_MS);
  return () => clearTimeout(id);
}
