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
