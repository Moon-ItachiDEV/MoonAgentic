import { describe, expect, it } from "vitest";
import { remarkPlace } from "./components/PrRemarks.tsx";

describe("where a review remark is", () => {
  it("names its file and line, or the review it belongs to", () => {
    const base = { id: "1", author: "neon", body: "?" };
    expect(remarkPlace({ ...base, kind: "thread", path: "src/a.ts", line: 4 })).toBe("src/a.ts:4");
    expect(remarkPlace({ ...base, kind: "thread", path: "src/a.ts" })).toBe("src/a.ts");
    expect(remarkPlace({ ...base, kind: "review", changes: true })).toBe(
      "Relecture · changements demandés",
    );
    expect(remarkPlace({ ...base, kind: "review" })).toBe("Relecture");
  });
});
