import { PROJECT_SPRITE } from "../project-icons.ts";
import { type IconName, SPRITE } from "./sprite.ts";

/** The sprite itself, drawn once at the top of the app. */
export function Sprite() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: "absolute" }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: `<defs>${SPRITE}${PROJECT_SPRITE}</defs>` }}
    />
  );
}

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
