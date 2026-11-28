import type { PrReview } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { reviewerState } from "./ReviewCard.tsx";

const review = (phase: PrReview["phase"]): PrReview => ({
  phase,
  repo: "moon/demo",
  number: 221,
  reviewers: [{ agentId: "codex", status: "waiting" }],
  startedAt: 0,
});

describe("a reviewer of a review", () => {
  it("starts while the review is being prepared", () => {
    expect(
      reviewerState({ agentId: "codex", status: "waiting" }, undefined, review("preparing")),
    ).toEqual({ text: "Démarre", tone: "work" });
  });

  it("was never started when the review failed before it", () => {
    for (const phase of ["failed", "stopped"] as const) {
      expect(
        reviewerState({ agentId: "codex", status: "waiting" }, undefined, review(phase)),
      ).toEqual({ text: "Pas lancé", tone: "muted" });
    }
  });
});
