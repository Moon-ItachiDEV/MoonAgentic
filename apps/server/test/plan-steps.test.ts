import { describe, expect, it } from "vitest";
import { mergePlan, noteTool, toolLabel } from "../src/plan-steps.ts";

describe("plan steps", () => {
  it("dates each step when the agent starts and finishes it", () => {
    const one = mergePlan(
      undefined,
      [
        { content: "Lire", status: "in_progress" },
        { content: "Modifier", status: "pending" },
      ],
      100,
    );
    expect(one[0]).toMatchObject({ startedAt: 100 });
    expect(one[1]?.startedAt).toBeUndefined();
    const two = mergePlan(
      one,
      [
        { content: "Lire", status: "completed" },
        { content: "Modifier", status: "in_progress" },
      ],
      250,
    );
    expect(two[0]).toMatchObject({ startedAt: 100, endedAt: 250 });
    expect(two[1]).toMatchObject({ startedAt: 250 });
  });

  it("gives no time to a step it never saw at work", () => {
    const plan = mergePlan(undefined, [{ content: "Lire", status: "completed" }], 100);
    expect(plan[0]?.startedAt).toBeUndefined();
    expect(plan[0]?.endedAt).toBeUndefined();
  });

  it("keeps a step's tools when the agent reorders its plan", () => {
    const before = [
      { content: "A", status: "in_progress" as const, startedAt: 1, tools: ["app.ts"] },
      { content: "B", status: "pending" as const },
    ];
    const after = mergePlan(
      before,
      [
        { content: "B", status: "pending" },
        { content: "A", status: "in_progress" },
      ],
      5,
    );
    expect(after[1]).toMatchObject({ content: "A", startedAt: 1, tools: ["app.ts"] });
  });

  it("leaves each step its own past when one is added before them", () => {
    const before = [
      { content: "A", status: "completed" as const, startedAt: 1, endedAt: 4, tools: ["a.ts"] },
      { content: "B", status: "in_progress" as const, startedAt: 4, tools: ["b.ts"] },
    ];
    const after = mergePlan(
      before,
      [
        { content: "X", status: "pending" },
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
      ],
      9,
    );
    // The new step has no past: it does not take the one of the step it pushed down.
    expect(after[0]).toEqual({ content: "X", status: "pending" });
    expect(after[1]).toMatchObject({ content: "A", startedAt: 1, endedAt: 4, tools: ["a.ts"] });
    expect(after[2]).toMatchObject({ content: "B", startedAt: 4, tools: ["b.ts"] });
  });

  it("keeps the past of a step reworded where it stood", () => {
    const before = [
      { content: "Lire", status: "in_progress" as const, startedAt: 2, tools: ["app.ts"] },
      { content: "Modifier", status: "pending" as const },
    ];
    const after = mergePlan(
      before,
      [
        { content: "Lire le code", status: "completed" },
        { content: "Modifier", status: "in_progress" },
      ],
      7,
    );
    expect(after[0]).toMatchObject({ startedAt: 2, endedAt: 7, tools: ["app.ts"] });
    expect(after[1]).toEqual({ content: "Modifier", status: "in_progress", startedAt: 7 });
  });

  it("notes up to three distinct tools on the step at work", () => {
    let plan = mergePlan(undefined, [{ content: "Lire", status: "in_progress" }], 1);
    plan = noteTool(plan, "Read /repo/src/app.ts") ?? plan;
    expect(noteTool(plan, "Lire src/app.ts")).toBeUndefined();
    plan = noteTool(plan, "`pnpm test`") ?? plan;
    plan = noteTool(plan, "Grep answer") ?? plan;
    expect(noteTool(plan, "Write notes.md")).toBeUndefined();
    expect(plan[0]?.tools).toEqual(["app.ts", "pnpm test", "Grep answer"]);
    expect(noteTool([{ content: "x", status: "pending" }], "Read a.ts")).toBeUndefined();
  });

  it("shortens long commands", () => {
    expect(toolLabel("`pnpm --filter @moonagentic/web run build:all --verbose`").length).toBe(28);
  });
});
