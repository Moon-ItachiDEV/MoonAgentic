import type { Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { recentAlwaysShown } from "./recent.ts";

const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, title: id, status: "idle", ...extra }) as Thread;
const seven = Array.from({ length: 7 }, (_, i) => thread(`t${i}`));
const ids = (list: Thread[]) => list.map((t) => t.id);

describe("recentAlwaysShown", () => {
  it("keeps the first five and folds the rest", () => {
    const { always, foldable } = recentAlwaysShown(seven, new Map(), undefined);
    expect(ids(always)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(foldable).toBe(2);
  });

  it("keeps an older thread that is open, at work or waiting", () => {
    const list = [...seven, thread("open"), thread("busy", { status: "running" })];
    const { always, foldable } = recentAlwaysShown(list, new Map(), "open");
    expect(ids(always).slice(5)).toEqual(["open", "busy"]);
    expect(foldable).toBe(2);
  });

  it("keeps an idle lead whose team is open, at work, waiting or pinned", () => {
    for (const child of [
      thread("c", { status: "running" }),
      thread("c", { status: "waiting" }),
      thread("c", { pinned: true }),
      thread("c"),
    ]) {
      const lead = thread("lead");
      const active = child.status === "idle" && !child.pinned ? "c" : undefined;
      const { always } = recentAlwaysShown([...seven, lead], new Map([["lead", [child]]]), active);
      expect(ids(always)).toContain("lead");
    }
  });

  it("has nothing to fold when every older thread must stay", () => {
    const list = [...seven.slice(0, 5), thread("a", { status: "running" })];
    expect(recentAlwaysShown(list, new Map(), undefined).foldable).toBe(0);
  });
});
