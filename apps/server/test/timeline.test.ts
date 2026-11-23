import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { light, TOOL_INLINE_CHARS } from "../src/timeline.ts";

type Tool = Extract<Item, { kind: "tool" }>;
const tool = (content: Tool["content"]): Tool => ({
  id: "t1",
  kind: "tool",
  title: "Lire",
  toolKind: "read",
  status: "completed",
  content,
  at: 1,
});

describe("what the timeline carries", () => {
  it("keeps a small tool result with its line, and leaves a large one out, counted", () => {
    const small = tool([{ type: "text", text: "x".repeat(TOOL_INLINE_CHARS) }]);
    expect(light(small)).toBe(small);

    const large = tool([{ type: "text", text: "x".repeat(TOOL_INLINE_CHARS + 1) }]);
    expect(light(large)).toEqual({ ...large, content: [], omitted: TOOL_INLINE_CHARS + 1 });
    // The copy alone is lighter: what is stored keeps everything.
    expect(large.content).toHaveLength(1);

    // A change to a file counts both sides, and several small pieces add up.
    const diff = tool([
      { type: "diff", path: "a.ts", oldText: "a".repeat(1200), newText: "b".repeat(1200) },
    ]);
    expect(light(diff)).toMatchObject({ content: [], omitted: 2404 });
    const pieces = tool(
      Array.from({ length: 3 }, () => ({ type: "text" as const, text: "y".repeat(900) })),
    );
    expect(light(pieces)).toMatchObject({ content: [], omitted: 2700 });
    const created = tool([{ type: "diff", path: "neuf.ts", oldText: null, newText: "ok" }]);
    expect(light(created)).toBe(created);
  });

  it("leaves every other item as it is, however long", () => {
    const answer: Item = { id: "a1", kind: "agent", text: "z".repeat(50_000), at: 1 };
    expect(light(answer)).toBe(answer);
  });
});
