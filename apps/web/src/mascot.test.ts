import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { mascotExpression } from "./mascot.ts";

const tool = (toolKind: string, title: string, status: "in_progress" | "completed" | "failed") =>
  ({ id: "t", kind: "tool", title, toolKind, status, content: [], at: 0 }) as Item;

describe("the moon's face", () => {
  it("shows what the agent really does", () => {
    expect(mascotExpression(tool("read", "Read src/a.ts", "in_progress"))).toBe("reading");
    expect(mascotExpression(tool("search", "grep foo", "in_progress"))).toBe("reading");
    expect(mascotExpression(tool("edit", "Edit src/a.ts", "in_progress"))).toBe("coding");
    expect(mascotExpression({ id: "a", kind: "agent", text: "…", at: 0 })).toBe("coding");
    expect(mascotExpression({ id: "b", kind: "thought", text: "…", at: 0 })).toBe("review");
    expect(mascotExpression(tool("execute", "pnpm test", "in_progress"))).toBe("testing");
  });

  it("smiles when the tests pass and worries when a step fails", () => {
    expect(mascotExpression(tool("execute", "pnpm test", "completed"))).toBe("success");
    expect(mascotExpression(tool("execute", "pnpm test", "failed"))).toBe("error");
    expect(mascotExpression(tool("edit", "Edit src/a.ts", "failed"))).toBe("error");
    // A command that is not a test run does not earn a smile.
    expect(mascotExpression(tool("execute", "git status", "completed"))).toBe("coding");
  });

  it("rests while starting or waiting on the user", () => {
    expect(mascotExpression(undefined)).toBe("idle");
    expect(
      mascotExpression({
        id: "p",
        kind: "permission",
        title: "Modifier a.ts ?",
        outcome: null,
        at: 0,
      } as unknown as Item),
    ).toBe("idle");
  });
});
