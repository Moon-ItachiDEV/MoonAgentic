import { useEffect, useRef } from "react";
import { drawGlyph, STILL_TIME, type GlyphKind } from "../glyphs.ts";
import { subscribeTheme } from "../theme.ts";

/** The glyphs on screen and in view, drawn by one animation loop. */
const live = new Set<(t: number) => void>();
let frame = 0;
let last = 0;
/** At most 60 pictures a second, even on a 120 Hz screen: the dots need no more. */
const MIN_FRAME_MS = 1000 / 60 - 1;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function loop(now: number) {
  frame = 0;
  if (live.size === 0) return;
  if (now - last >= MIN_FRAME_MS) {
    last = now;
    for (const draw of live) draw(now / 1000);
  }
  frame = requestAnimationFrame(loop);
}

function join(draw: (t: number) => void) {
  live.add(draw);
  if (!frame) frame = requestAnimationFrame(loop);
}

function leave(draw: (t: number) => void) {
  live.delete(draw);
  if (live.size === 0 && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/**
 * What the agent is doing, as a small picture in dots. It takes the text colour of where it
 * sits, so it follows the theme; with reduced motion it stays a still picture, and out of
 * sight (a closed drawer, a scrolled-away line) it is not drawn at all.
 */
export function StateGlyph({
  kind,
  size = 16,
  label,
}: {
  kind: GlyphKind;
  size?: number;
  /** Read out and shown on hover; without it the glyph is decoration. */
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);

    let color = getComputedStyle(canvas).color;
    let visible = true;
    let gone = false;
    const draw = (t: number) => drawGlyph(ctx, kind, t, size, color);

    const motion =
      typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const scheme =
      typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    const sync = () => {
      if (gone) return;
      color = getComputedStyle(canvas).color;
      if (reducedMotion()) {
        leave(draw);
        draw(STILL_TIME);
      } else if (visible) {
        // Drawn at once, so it never shows blank until the next frame.
        draw(performance.now() / 1000);
        join(draw);
      } else leave(draw);
    };
    // The theme's tokens change after the attribute does: read the colour on the next frame.
    const later = () => requestAnimationFrame(sync);
    sync();
    const offTheme = subscribeTheme(later);
    motion?.addEventListener("change", sync);
    scheme?.addEventListener("change", later);
    const seen =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            sync();
          })
        : null;
    seen?.observe(canvas);
    return () => {
      gone = true;
      leave(draw);
      seen?.disconnect();
      offTheme();
      motion?.removeEventListener("change", sync);
      scheme?.removeEventListener("change", later);
    };
  }, [kind, size]);

  return (
    <canvas
      ref={ref}
      className={`glyph g-${kind}`}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
