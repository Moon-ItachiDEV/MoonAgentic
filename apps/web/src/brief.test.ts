import { briefOf, ORIGIN_MARK, REPLY_MARK } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";

describe("a coordinator's message in a thread", () => {
  it("shows only the brief, the user's quoted words stay for the agent", () => {
    expect(briefOf(`Corrige l'export Safari.${ORIGIN_MARK}> exporte ne marche pas`)).toBe(
      "Corrige l'export Safari.",
    );
  });

  it("hides how the agent is asked to answer", () => {
    expect(briefOf(`Relis la PR 155.${REPLY_MARK}Réponds en français.${ORIGIN_MARK}> relis`)).toBe(
      "Relis la PR 155.",
    );
  });

  it("leaves a message without quoted words as it is", () => {
    expect(briefOf("Relis la PR 155.")).toBe("Relis la PR 155.");
  });
});
