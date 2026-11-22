import { describe, expect, it } from "vitest";
import { withoutTeamJson } from "./team-json.ts";

describe("withoutTeamJson", () => {
  it("drops the fenced plan the lead ends with", () => {
    const text = 'Deux parts.\n\n```json\n{"tasks": [{"title": "a", "brief": "b"}]}\n```\n';
    expect(withoutTeamJson(text)).toBe("Deux parts.");
  });

  it("drops a rewritten brief, and a bare plan left without its fence", () => {
    expect(withoutTeamJson('Nouvelle consigne.\n```json\n{"brief": "x"}\n```')).toBe(
      "Nouvelle consigne.",
    );
    expect(withoutTeamJson('Plan prêt.\n{"tasks": [{"title": "a", "brief": "b"}]}')).toBe(
      "Plan prêt.",
    );
  });

  it("hides a plan still being written", () => {
    expect(withoutTeamJson('Deux parts.\n```json\n{"tasks": [{"title": "a"')).toBe("Deux parts.");
  });

  it("keeps other code blocks and plain text as they are", () => {
    const text = 'Exemple :\n```json\n{"name": "x"}\n```\nFin.';
    expect(withoutTeamJson(text)).toBe(text);
    expect(withoutTeamJson("Rien à cacher.")).toBe("Rien à cacher.");
  });
});
