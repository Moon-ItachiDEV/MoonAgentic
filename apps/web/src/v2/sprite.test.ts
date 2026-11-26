import { describe, expect, it } from "vitest";
import { PROJECT_SPRITE } from "../project-icons.ts";
import { SPRITE, thinnable } from "./sprite.ts";

// The menu and the popups draw finer lines by setting `--icon-k`. The icons are drawn through
// `<use>`, whose lines no CSS selector reaches: only a width read from a custom property follows.
describe("icon strokes", () => {
  const fixed = (sprite: string) =>
    (sprite.match(/<[a-z]+\b[^>]*stroke-width="[^"]*"[^>]*>/g) ?? []).filter(
      (tag) => !tag.includes('stroke="var(--surface)"'),
    );

  it("take their width from --icon-k in every icon of the app and of the projects", () => {
    expect(fixed(SPRITE)).toEqual([]);
    expect(fixed(PROJECT_SPRITE)).toEqual([]);
    expect(SPRITE).toContain("var(--icon-k, 1)");
    expect(PROJECT_SPRITE).toContain("calc(1.7px * var(--icon-k, 1))");
  });

  it("keep their own width where nothing sets --icon-k, and leave the cut-out rings alone", () => {
    expect(thinnable('<path d="M0 0" stroke="currentColor" stroke-width="1.8"/>')).toBe(
      '<path d="M0 0" stroke="currentColor" style="stroke-width:calc(1.8px * var(--icon-k, 1))"/>',
    );
    const ring = '<circle r="3" stroke="var(--surface)" stroke-width="2"/>';
    expect(thinnable(ring)).toBe(ring);
  });
});
