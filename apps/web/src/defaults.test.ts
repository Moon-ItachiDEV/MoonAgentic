import { describe, expect, it } from "vitest";
import { resolveDefaults, withChoice } from "./defaults.ts";

describe("defaults of a new thread", () => {
  it("takes the server's, else this device's, else supervised on its own branch", () => {
    expect(resolveDefaults({ permissionMode: "full", isolated: false }, {})).toEqual({
      permissionMode: "full",
      isolated: false,
    });
    expect(
      resolveDefaults({ permissionMode: "supervised", isolated: true }, { permissionMode: "full" }),
    ).toEqual({ permissionMode: "supervised", isolated: true });
    expect(resolveDefaults(null, { permissionMode: "full" })).toEqual({
      permissionMode: "full",
      isolated: true,
    });
    expect(resolveDefaults(null, {})).toEqual({ permissionMode: "supervised", isolated: true });
  });

  it("uses what was just chosen here until the server's answer, and not for long", () => {
    const server = { permissionMode: "full", isolated: true } as const;
    const choice = { change: { permissionMode: "supervised" } as const, at: 1000 };
    // The answer is on its way: a message sent now goes supervised, as asked.
    expect(withChoice(server, choice, 1200)).toEqual({
      permissionMode: "supervised",
      isolated: true,
    });
    // No choice, or one the server never took up: the server's word.
    expect(withChoice(server, null, 1200)).toEqual(server);
    expect(withChoice(server, choice, 7000)).toEqual(server);
  });
});
