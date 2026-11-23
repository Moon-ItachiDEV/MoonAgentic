import { describe, expect, it } from "vitest";
import { duration, planDuration, planProgress } from "./plan-progress.ts";

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

describe("planDuration", () => {
  it("runs from the first step started to the last finished, or to now", () => {
    const entries = [
      { content: "A", status: "completed" as const, startedAt: 1000, endedAt: 2300 },
      { content: "B", status: "in_progress" as const, startedAt: 2300 },
    ];
    expect(planDuration(entries)).toBe(1300);
    expect(planDuration(entries, 5000)).toBe(4000);
    expect(planDuration([{ content: "A", status: "pending" }], 5000)).toBeUndefined();
  });

  it("reads as a short French duration", () => {
    expect(duration(20)).toBe("< 0,1 s");
    expect(duration(1300)).toBe("1,3 s");
    expect(duration(42_000)).toBe("42 s");
    expect(duration(185_000)).toBe("3 min 05 s");
    expect(duration(3_720_000)).toBe("1 h 02 min");
  });
});
