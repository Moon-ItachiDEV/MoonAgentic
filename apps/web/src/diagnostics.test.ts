import { describe, expect, it } from "vitest";
import { createUiErrorReporter, normalizeUiError, type UiErrorReport } from "./diagnostics.ts";

describe("web diagnostics error reporter", () => {
  it("normalizes Errors, strings, and unserializable values cleanly", () => {
    const err = new Error("boom");
    const fromErr = normalizeUiError(err, "\n  in Settings");
    expect(fromErr.message).toBe("boom");
    expect(fromErr.stack).toContain("in Settings");

    expect(normalizeUiError("simple")).toEqual({ message: "simple" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeUiError(circular).message).toBe("[object Object]");
  });

  it("deduplicates, throttles, and ignores ResizeObserver loop noise", () => {
    let now = 1_000;
    const sent: UiErrorReport[] = [];
    const report = createUiErrorReporter((r) => sent.push(r), {
      now: () => now,
      route: () => "/settings",
    });

    expect(report("window", new Error("ResizeObserver loop limit exceeded"))).toBe(false);
    expect(report("react", new Error("crash A"))).toBe(true);
    // Duplicate within 15s is ignored.
    now += 5_000;
    expect(report("react", new Error("crash A"))).toBe(false);
    // Different errors go through up to 5 per minute.
    expect(report("window", new Error("crash B"))).toBe(true);
    expect(report("window", new Error("crash C"))).toBe(true);
    expect(report("window", new Error("crash D"))).toBe(true);
    expect(report("promise", "crash E")).toBe(true);
    expect(report("window", new Error("crash F"))).toBe(false);

    expect(sent).toHaveLength(5);
    expect(sent[0]).toMatchObject({ source: "react", message: "crash A", route: "/settings" });

    // After the 60s window passes, reporting resumes.
    now += 61_000;
    expect(report("window", new Error("crash G"))).toBe(true);
  });

  it("never throws when the underlying transport throws", () => {
    const report = createUiErrorReporter(() => {
      throw new Error("network down");
    });
    expect(report("window", new Error("oops"))).toBe(false);
  });
});
