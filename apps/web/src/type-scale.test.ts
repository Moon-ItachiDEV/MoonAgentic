// Audit M4: the type was spread over 19 sizes, then 26, from 8 to 44 px, in 6 weights.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./v2/", import.meta.url);
const css = readdirSync(dir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** The sizes of the scale written down in tokens.css. */
const SCALE = [11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 30, 40];
const WEIGHTS = [400, 500, 600];

describe("the type scale", () => {
  it("uses its sizes only", () => {
    const sizes = new Set<number>();
    for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) sizes.add(Number(m[1]));
    for (const m of css.matchAll(/(?<![-\w])font:\s*(?:normal\s+)?(?:\d{3}\s+)?([\d.]+)px/g)) {
      sizes.add(Number(m[1]));
    }
    expect([...sizes].filter((size) => !SCALE.includes(size)).sort()).toEqual([]);
    expect(sizes.size).toBeLessThanOrEqual(SCALE.length);
  });

  it("uses three weights", () => {
    const weights = new Set<number>();
    for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) weights.add(Number(m[1]));
    for (const m of css.matchAll(/(?<![-\w])font:\s*(?:normal\s+)?(\d{3})\s/g)) {
      weights.add(Number(m[1]));
    }
    expect([...weights].filter((weight) => !WEIGHTS.includes(weight))).toEqual([]);
  });
});
