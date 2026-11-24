import { describe, expect, it } from "vitest";
import { readNotice } from "../src/notices.ts";

describe("readNotice", () => {
  it("takes a notice the interface sends", () => {
    const notice = { title: "Un fil t'attend", body: "Choisis", tag: "t1:wait", threadId: "t1" };
    expect(readNotice(notice)).toEqual(notice);
    expect(readNotice({ ...notice, threadId: "" })).toEqual({ ...notice, threadId: "" });
  });

  it("refuses what is not one, and cuts what is too long", () => {
    expect(readNotice(null)).toBeUndefined();
    expect(readNotice("x")).toBeUndefined();
    expect(readNotice({ title: "", body: "", tag: "a", threadId: "" })).toBeUndefined();
    expect(readNotice({ title: "a", body: 3, tag: "a", threadId: "" })).toBeUndefined();
    expect(
      readNotice({ title: "a".repeat(500), body: "", tag: "a", threadId: "" })?.title,
    ).toHaveLength(200);
  });
});
