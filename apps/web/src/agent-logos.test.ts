import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_LOGOS, agentLogo } from "./agent-logos.ts";

describe("agent logos", () => {
  it("Cursor and Hermes have an official logo, the others keep their letters", () => {
    expect(agentLogo("cursor")).toBe("/agents/cursor.svg");
    expect(agentLogo("hermes")).toBe("/agents/hermes.png");
    for (const id of ["claude", "codex", "antigravity", "demo", undefined]) {
      expect(agentLogo(id)).toBeUndefined();
    }
  });

  it("every listed logo is shipped in public/", () => {
    for (const src of Object.values(AGENT_LOGOS)) {
      expect(existsSync(fileURLToPath(new URL(`../public${src}`, import.meta.url)))).toBe(true);
    }
  });
});
