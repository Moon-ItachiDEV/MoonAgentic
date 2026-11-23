import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineComment } from "./diff.ts";
import {
  MAX_DRAFT_THREADS,
  MAX_DRAFTS,
  readReviewDrafts,
  writeReviewDrafts,
} from "./review-drafts.ts";

const remark = (id: string, text = "À revoir"): LineComment => ({
  id,
  path: "src/app.ts",
  line: 3,
  removed: false,
  code: "export const answer = 42;",
  text,
});

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("review remarks not sent yet", () => {
  it("are found again for their thread, after the panel closed or the page loaded again", () => {
    expect(readReviewDrafts("t1")).toEqual([]);
    writeReviewDrafts("t1", [remark("a"), remark("b", "Un test manque")]);
    writeReviewDrafts("t2", [remark("c")]);
    expect(readReviewDrafts("t1").map((c) => c.text)).toEqual(["À revoir", "Un test manque"]);
    expect(readReviewDrafts("t2").map((c) => c.id)).toEqual(["c"]);
    // Whether its line is still there is worked out again from the diff of the moment.
    writeReviewDrafts("t1", [{ ...remark("a"), lost: true }]);
    expect(readReviewDrafts("t1")).toEqual([remark("a")]);
  });

  it("leave with the last one: sent or removed, nothing stays behind", () => {
    writeReviewDrafts("t1", [remark("a")]);
    writeReviewDrafts("t1", []);
    expect(readReviewDrafts("t1")).toEqual([]);
    expect(JSON.parse(stored.get("moonagentic.reviewDrafts")!)).toEqual({});
    // A thread with nothing kept writes nothing at all.
    stored.clear();
    writeReviewDrafts("t9", []);
    expect(stored.size).toBe(0);
  });

  it("stay bounded: the threads touched longest ago leave first", () => {
    for (let i = 0; i < MAX_DRAFT_THREADS + 3; i++) writeReviewDrafts(`t${i}`, [remark("a")], i);
    expect(readReviewDrafts("t0")).toEqual([]);
    expect(readReviewDrafts("t2")).toEqual([]);
    expect(readReviewDrafts("t3")).toHaveLength(1);
    expect(readReviewDrafts(`t${MAX_DRAFT_THREADS + 2}`)).toHaveLength(1);
    const many = Array.from({ length: MAX_DRAFTS + 5 }, (_, i) => remark(`r${i}`));
    writeReviewDrafts("big", many, 1_000);
    expect(readReviewDrafts("big")).toHaveLength(MAX_DRAFTS);
    expect(readReviewDrafts("big").at(-1)?.id).toBe(`r${MAX_DRAFTS + 4}`);
  });

  it("read nothing from what this code did not write", () => {
    stored.set("moonagentic.reviewDrafts", "pas du JSON");
    expect(readReviewDrafts("t1")).toEqual([]);
    stored.set(
      "moonagentic.reviewDrafts",
      JSON.stringify({ t1: { at: 1, comments: [{ id: "x" }, remark("ok"), null] }, t2: [] }),
    );
    expect(readReviewDrafts("t1")).toEqual([remark("ok")]);
    expect(readReviewDrafts("t2")).toEqual([]);
    // No storage on this device: the remarks last for the panel only, without an error.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("refusé");
      },
      setItem: () => {
        throw new Error("refusé");
      },
    });
    expect(readReviewDrafts("t1")).toEqual([]);
    expect(() => writeReviewDrafts("t1", [remark("a")])).not.toThrow();
  });
});
