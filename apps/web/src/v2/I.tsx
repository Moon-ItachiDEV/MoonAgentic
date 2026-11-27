import { memo } from "react";
import { PROJECT_SPRITE } from "../project-icons.ts";
import { type IconName, SPRITE } from "./sprite.ts";

const SPRITE_STYLE = { position: "absolute" } as const;
const SPRITE_HTML = { __html: `<defs>${SPRITE}${PROJECT_SPRITE}</defs>` };

/** The sprite itself, drawn once at the top of the app. */
export const Sprite = memo(function Sprite() {
  return (
    <svg
      width="0"
      height="0"
      style={SPRITE_STYLE}
      aria-hidden="true"
      dangerouslySetInnerHTML={SPRITE_HTML}
    />
  );
});

/** One icon of the sprite. */
export function I({ n, s = 22, className }: { n: IconName; s?: number; className?: string }) {
  return (
    <svg width={s} height={s} aria-hidden="true" className={className}>
      <use href={`#i-${n}`} />
    </svg>
  );
}

/** The nine dots that drift while an agent works. */
export function Glyph() {
  return (
    <span className="gl" aria-hidden="true">
      <b />
      <b />
      <b />
      <b />
      <b />
      <b />
      <b />
      <b />
      <b />
    </span>
  );
}
