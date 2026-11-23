import { describe, expect, it } from "vitest";
import { planProgress } from "./plan-progress.ts";

describe("planProgress", () => {
  it("counts the steps the agent finished", () => {
    expect(
      planProgress([
        { content: "Lire", status: "completed" },
        { content: "Modifier", status: "in_progress" },
        { content: "Tester", status: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3, over: false });
  });

  it("is over only when every step is done", () => {
    expect(planProgress([{ content: "Lire", status: "completed" }]).over).toBe(true);
    expect(planProgress([]).over).toBe(false);
  });
});
