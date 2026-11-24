// What the server takes from a window for the settings kept for every device.
import { ClientMessage } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";

const ok = (message: unknown) => ClientMessage.safeParse(message).success;

describe("settings kept by the server", () => {
  it("takes the defaults of a new thread, nothing else", () => {
    expect(ok({ type: "defaults.set", permissionMode: "full" })).toBe(true);
    expect(ok({ type: "defaults.set", isolated: false })).toBe(true);
    expect(ok({ type: "defaults.set", permissionMode: "root" })).toBe(false);
  });

  it("takes teams with known roles, unique ids, and not too many", () => {
    const team = (id: string) => ({
      id,
      label: "Équipe",
      roles: { lead: { agentId: "claude", model: "opus" }, reviewer: null },
    });
    expect(ok({ type: "teamPresets.set", presets: [team("a"), team("b")] })).toBe(true);
    expect(ok({ type: "teamPresets.set", presets: null })).toBe(true);
    expect(ok({ type: "teamPresets.set", presets: [team("a"), team("a")] })).toBe(false);
    expect(ok({ type: "teamPresets.set", presets: [team("a b")] })).toBe(false);
    expect(
      ok({
        type: "teamPresets.set",
        presets: [{ ...team("a"), roles: { boss: { agentId: "claude" } } }],
      }),
    ).toBe(false);
    expect(
      ok({
        type: "teamPresets.set",
        presets: Array.from({ length: 13 }, (_, i) => team(`t${i}`)),
      }),
    ).toBe(false);
  });
});

describe("teams that always have a lead and coders", () => {
  const team = { id: "a", label: "Équipe", roles: { lead: { agentId: "claude" } } };
  it("refuses an empty list, and a lead or coders set to nobody", () => {
    expect(ok({ type: "teamPresets.set", presets: [] })).toBe(false);
    expect(ok({ type: "teamPresets.set", presets: [{ ...team, roles: { lead: null } }] })).toBe(
      false,
    );
    expect(ok({ type: "teamPresets.set", presets: [{ ...team, roles: { coder: null } }] })).toBe(
      false,
    );
    expect(ok({ type: "teamPresets.set", presets: [{ ...team, roles: { tester: null } }] })).toBe(
      true,
    );
  });
});
