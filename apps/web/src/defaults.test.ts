import { describe, expect, it } from "vitest";
import { resolveDefaults } from "./defaults.ts";

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
});
