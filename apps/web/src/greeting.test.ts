import { describe, expect, it } from "vitest";
import { greeting } from "./components/Home.tsx";

describe("greeting", () => {
  it("says « Bonsoir » from 18 h to the small hours, « Bonjour » otherwise", () => {
    expect([4, 5, 12, 17, 18, 23, 0].map(greeting)).toEqual([
      "Bonsoir",
      "Bonjour",
      "Bonjour",
      "Bonjour",
      "Bonsoir",
      "Bonsoir",
      "Bonsoir",
    ]);
  });
});
