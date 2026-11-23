import { useEffect, useRef } from "react";
import { drawGlyph, STILL_TIME, type GlyphKind } from "../glyphs.ts";
import { subscribeTheme } from "../theme.ts";

/** Every glyph on screen, drawn by one animation loop. */
const live = new Set<() => void>();
let frame = 0;
const start = performance.now();

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function loop() {
  for (const draw of live) draw();
  frame = live.size > 0 ? requestAnimationFrame(loop) : 0;
}

/**
 * What the agent is doing, as a small picture in dots. It takes the text colour of where it
 * sits, so it follows the theme; with reduced motion it stays a still picture.
 */
export function StateGlyph({
  kind,
  size = 16,
  label,
}: {
  kind: GlyphKind;
  size?: number;
  /** Read out instead of the picture; without it the glyph is decoration. */
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let color = getComputedStyle(canvas).color;
    const still = () => drawGlyph(ctx, kind, STILL_TIME, size, color);
    const draw = () => drawGlyph(ctx, kind, (performance.now() - start) / 1000, size, color);

    const motion =
      typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const scheme =
      typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    let gone = false;
    const sync = () => {
      if (gone) return;
      color = getComputedStyle(canvas).color;
      if (reducedMotion()) {
        live.delete(draw);
        still();
      } else {
        live.add(draw);
        if (!frame) frame = requestAnimationFrame(loop);
      }
    };
    // The theme's tokens change after the attribute does: read the colour on the next frame.
    const later = () => requestAnimationFrame(sync);
    sync();
    const offTheme = subscribeTheme(later);
    motion?.addEventListener("change", sync);
    scheme?.addEventListener("change", later);
    return () => {
      gone = true;
      live.delete(draw);
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
      aria-hidden={label ? undefined : true}
    />
  );
}
