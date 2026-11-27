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

  it("tells a window the shell already said hidden to the one that starts listening", async () => {
    // The preload says again, at subscription, what the main process last told it.
    const shell = globalThis as { moonDesktop?: unknown };
    shell.moonDesktop = {
      notify() {},
      close() {},
      onOpen() {},
      onVisible(listener: (visible: boolean) => void) {
        listener(false);
      },
    };
    vi.resetModules();
    try {
      const fresh = await import("./visibility.ts");
      const seen: boolean[] = [];
      fresh.onPageVisibility(() => seen.push(fresh.isPageHidden()));
      expect(seen).toEqual([true]);
      expect(fresh.isPageHidden()).toBe(true);
    } finally {
      delete shell.moonDesktop;
      vi.resetModules();
    }
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
