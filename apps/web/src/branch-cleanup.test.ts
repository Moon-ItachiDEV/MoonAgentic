import type { MoonBranch } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { branchNote, deletedLine, targetsLabel } from "./branch-cleanup.ts";

const branch = (b: Partial<MoonBranch>): MoonBranch => ({
  name: "moon/x-aaaaaa",
  at: 0,
  state: "merged",
  ahead: 0,
  ...b,
});

describe("branch cleanup wording", () => {
  it("says what each branch was made for, or why it stays", () => {
    expect(branchNote(branch({}))).toBe("Aucun fil ne s'en sert");
    expect(branchNote(branch({ thread: { id: "t", title: "Corrige", archived: true } }))).toBe(
      "Fil « Corrige », archivé",
    );
    expect(branchNote(branch({ state: "inUse", thread: { id: "t", title: "Corrige" } }))).toBe(
      "Le fil « Corrige » travaille dessus",
    );
    expect(branchNote(branch({ state: "inUse" }))).toBe("Ouverte dans un dossier de travail");
    expect(branchNote(branch({ state: "unmerged", ahead: 1 }))).toBe("1 commit pas fusionné");
    expect(
      branchNote(branch({ state: "unmerged", ahead: 3, thread: { id: "t", title: "A" } })),
    ).toBe("3 commits pas fusionnés · fil « A »");
  });

  it("counts what went and what stayed", () => {
    expect(deletedLine(1, 0)).toBe("1 branche supprimée.");
    expect(deletedLine(4, 0)).toBe("4 branches supprimées.");
    expect(deletedLine(2, 1)).toBe("2 branches supprimées, 1 branche gardée :");
    expect(deletedLine(0, 2)).toBe("Rien n'a été supprimé, 2 branches gardées :");
    expect(targetsLabel(["main", "origin/main"])).toBe("main ou origin/main");
  });
});
