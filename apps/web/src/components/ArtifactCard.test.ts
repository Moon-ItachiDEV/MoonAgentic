import { describe, expect, it } from "vitest";
import { inlinePreviewActive } from "./ArtifactCard.tsx";

describe("inlinePreviewActive", () => {
  it("loads only visible, unfolded HTML artifacts", () => {
    expect(inlinePreviewActive("html", true, false)).toBe(true);
    expect(inlinePreviewActive("html", false, false)).toBe(false);
    expect(inlinePreviewActive("html", true, true)).toBe(false);
    expect(inlinePreviewActive("image", true, false)).toBe(false);
    expect(inlinePreviewActive("pdf", true, false)).toBe(false);
  });
});
