import { afterEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_FRAME_MS, nextFrame } from "./frame.ts";
import { isPageHidden, onPageVisibility, setDesktopVisible } from "./visibility.ts";

afterEach(() => {
  setDesktopVisible(true);
  vi.useRealTimers();
});

describe("page visibility with desktop tray bridge", () => {
  it("reports hidden when desktop hides the window even if document.hidden is false", () => {
    expect(isPageHidden()).toBe(false);
    const seen: boolean[] = [];
    const off = onPageVisibility(() => seen.push(isPageHidden()));
    setDesktopVisible(false);
    expect(isPageHidden()).toBe(true);
    setDesktopVisible(false);
    setDesktopVisible(true);
    expect(isPageHidden()).toBe(false);
    off();
    expect(seen).toEqual([true, false]);
  });

  it("throttles nextFrame to HIDDEN_FRAME_MS when hidden in the desktop tray", () => {
    vi.useFakeTimers();
    const raf = vi.fn(() => 1);
    const caf = vi.fn();
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
    try {
      setDesktopVisible(false);
      let ran = false;
      nextFrame(() => {
        ran = true;
      });
      expect(raf).not.toHaveBeenCalled();
      expect(ran).toBe(false);
      vi.advanceTimersByTime(HIDDEN_FRAME_MS);
      expect(ran).toBe(true);

      setDesktopVisible(true);
      nextFrame(() => undefined);
      expect(raf).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
    }
  });
});
