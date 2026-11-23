import { describe, expect, it } from "vitest";
import { conflictRequest, forecastLine } from "./forecast.ts";

describe("where the branch stands", () => {
  it("says up to date, behind and clean, or behind with conflicts", () => {
    expect(forecastLine({ target: "main", behind: 0, conflicts: [] })).toBe("À jour avec main");
    expect(forecastLine({ target: "main", behind: 1, conflicts: [] })).toBe(
      "main a avancé de 1 commit · fusion sans conflit",
    );
    expect(forecastLine({ target: "origin/main", behind: 3, conflicts: ["a", "b"] })).toBe(
      "origin/main a avancé de 3 commits · conflit sur 2 fichiers",
    );
  });

  it("asks the agent to merge, naming the files, a long list cut short", () => {
    const conflicts = Array.from({ length: 23 }, (_, i) => `src/f${i}.ts`);
    const text = conflictRequest({ target: "main", behind: 2, conflicts });
    expect(text).toContain("- src/f0.ts");
    expect(text).toContain("- src/f19.ts");
    expect(text).not.toContain("src/f20.ts");
    expect(text).toContain("- et 3 fichiers de plus");
    expect(text).toContain("git merge main");
  });
});
