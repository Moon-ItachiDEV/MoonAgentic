import { describe, expect, it } from "vitest";
import { sameFields } from "./steady.tsx";

describe("sameFields", () => {
  const threads = [{ id: "t1" }];

  it("tells two objects with the very same values apart from two that differ", () => {
    expect(sameFields({ threads, ready: true }, { threads, ready: true })).toBe(true);
    expect(sameFields({ threads, ready: true }, { threads, ready: false })).toBe(false);
    // The same content in another list is another value: lists are compared as they are.
    expect(sameFields({ threads }, { threads: [...threads] })).toBe(false);
  });

  it("sees a field that came or went", () => {
    expect(sameFields({ threads }, { threads, notice: undefined })).toBe(false);
    expect(sameFields({ threads, notice: undefined }, { threads })).toBe(false);
    expect(sameFields({ a: undefined }, { b: undefined })).toBe(false);
  });
});
