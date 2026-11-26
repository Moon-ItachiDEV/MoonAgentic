import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { wholeThread } from "./whole-thread.ts";

const said = (n: number, text = `Message ${n}`): Item => ({
  id: `m${n}`,
  kind: "agent",
  text,
  at: n,
});

describe("a long thread read whole, for an export", () => {
  it("asks for what is before the end a page at a time, the latest first", async () => {
    // 2 500 messages numbered 1 to 2 500; the screen holds the last 120.
    const all = Array.from({ length: 2500 }, (_, i) => said(i + 1));
    const asked: number[] = [];
    const page = async (before: number) => {
      asked.push(before);
      const from = Math.max(1, before - 1000);
      return { items: all.slice(from - 1, before - 1), first: from, earlier: from - 1 };
    };
    const end = all.slice(2380).map((i) => (i.id === "m2500" ? said(2500, "En cours…") : i));
    const whole = await wholeThread(page, end, 2381, 2380);
    expect(asked).toEqual([2381, 1381, 381]);
    expect(whole.map((i) => i.id)).toEqual(all.map((i) => i.id));
    // What is being written comes from the screen.
    expect(whole.at(-1)).toMatchObject({ text: "En cours…" });
  });

  it("stops when the server has nothing before after all", async () => {
    const end = [said(5)];
    const whole = await wholeThread(async () => ({ items: [], first: 5, earlier: 0 }), end, 5, 4);
    expect(whole).toEqual(end);
  });
});
