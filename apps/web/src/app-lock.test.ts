import { describe, expect, it } from "vitest";
import { shouldLock } from "./app-lock.ts";

const MIN = 60_000;

describe("when the app locks by itself", () => {
  it("never does unless asked to", () => {
    expect(shouldLock("never", 100 * MIN, 0, 0)).toBe(false);
  });

  it("locks as soon as it is out of sight when set to at once", () => {
    expect(shouldLock("0", 10, 0, undefined)).toBe(false);
    expect(shouldLock("0", 10, 0, 5)).toBe(true);
  });

  it("locks once nothing was done for the time chosen, in sight or not", () => {
    expect(shouldLock("5", 4 * MIN, 0, undefined)).toBe(false);
    expect(shouldLock("5", 5 * MIN, 0, undefined)).toBe(true);
    expect(shouldLock("5", 6 * MIN, 0, 1 * MIN)).toBe(true);
    expect(shouldLock("60", 59 * MIN, 0, 1)).toBe(false);
  });
});
