import { briefOf, ORIGIN_MARK } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";

describe("a coordinator's message in a thread", () => {
  it("shows only the brief, the user's quoted words stay for the agent", () => {
    expect(briefOf(`Corrige l'export Safari.${ORIGIN_MARK}> exporte ne marche pas`)).toBe(
      "Corrige l'export Safari.",
    );
  });

  it("leaves a message without quoted words as it is", () => {
    expect(briefOf("Relis la PR 155.")).toBe("Relis la PR 155.");
  });
});
