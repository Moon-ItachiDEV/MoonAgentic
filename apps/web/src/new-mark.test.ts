import { describe, expect, it } from "vitest";
import { newMarkLabel } from "./new-mark.ts";

const at = new Date(2026, 10, 26, 0, 35).getTime();
const later = (minutes: number) => at + minutes * 60_000;

describe("the line above what arrived", () => {
  it("says « Nouveau » for an hour", () => {
    expect(newMarkLabel(at, later(59))).toBe("Nouveau");
  });
  it("then says when it came", () => {
    expect(newMarkLabel(at, later(61))).toBe("Aujourd'hui à 0h35");
    expect(newMarkLabel(at, later(24 * 60))).toBe("Hier à 0h35");
    expect(newMarkLabel(at, later(4 * 24 * 60))).toMatch(/^Jeudi 26 nov\.? à 0h35$/);
  });
});
