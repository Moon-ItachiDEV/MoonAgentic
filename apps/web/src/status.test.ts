import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { agentStatus, money } from "./status.ts";

const agent = (extra: Partial<AgentInfo>): AgentInfo => ({
  id: "a",
  name: "Agent",
  short: "Ag",
  available: true,
  ...extra,
});

describe("agentStatus", () => {
  it("tells apart missing, unchecked, ready, sign-in and failing agents", () => {
    expect(agentStatus(agent({ available: false })).label).toBe("Pas installé");
    expect(agentStatus(agent({})).label).toBe("Pas encore vérifié");
    expect(agentStatus(agent({ check: { at: 1, ok: true } }))).toEqual({
      tone: "ok",
      label: "Prêt",
    });
    expect(agentStatus(agent({ check: { at: 1, ok: false, signInNeeded: true } })).tone).toBe(
      "warn",
    );
    expect(agentStatus(agent({ check: { at: 1, ok: false, error: "x" } })).tone).toBe("err");
  });
});

describe("money", () => {
  it("shows small amounts with one more digit, and unknown currencies as they come", () => {
    expect(money({ amount: 0.243, currency: "USD" })).toMatch(/0,243\s\$US/);
    expect(money({ amount: 12.5, currency: "EUR" })).toMatch(/12,50\s€/);
    expect(money({ amount: 2, currency: "crédits" })).toBe("2 crédits");
  });
});
