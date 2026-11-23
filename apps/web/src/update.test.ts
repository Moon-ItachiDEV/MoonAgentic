import { describe, expect, it } from "vitest";
import { isStale } from "./update.ts";

describe("a tab left open across an update", () => {
  it("offers to reload only when the server serves another build", () => {
    expect(isStale("a1", "a1")).toBe(false);
    expect(isStale("a1", "b2")).toBe(true);
  });

  it("stays quiet when either side has no id", () => {
    expect(isStale(undefined, "b2")).toBe(false);
    expect(isStale("", "b2")).toBe(false);
    expect(isStale("a1", null)).toBe(false);
    expect(isStale("a1", undefined)).toBe(false);
  });
});
