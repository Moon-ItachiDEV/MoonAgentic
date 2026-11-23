import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_LOGOS, agentLogo } from "./agent-logos.ts";

describe("agent logos", () => {
  it("every built-in agent has a logo, demo and custom agents keep their letters", () => {
    expect(agentLogo("claude")).toBe("/agents/claude.svg");
    expect(agentLogo("codex")).toBe("/agents/codex.svg");
    expect(agentLogo("antigravity")).toBe("/agents/antigravity.svg");
    expect(agentLogo("cursor")).toBe("/agents/cursor.svg");
    expect(agentLogo("hermes")).toBe("/agents/hermes.png");
    for (const id of ["demo", "custom-1234", undefined]) {
      expect(agentLogo(id)).toBeUndefined();
    }
  });

  it("every listed logo is shipped in public/", () => {
    for (const src of Object.values(AGENT_LOGOS)) {
      expect(existsSync(fileURLToPath(new URL(`../public${src}`, import.meta.url)))).toBe(true);
    }
  });
});
