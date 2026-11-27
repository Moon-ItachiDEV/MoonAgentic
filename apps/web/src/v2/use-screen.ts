import { useSyncExternalStore } from "react";

/**
 * The layout follows the window's real width, as in the mockup: `roomy` centres the content
 * and turns the bottom sheets into windows, `wide` pins the menu as a side bar and drops the
 * bottom tabs, `sp` splits a project's page in two (iPad across, computer), `xl` gives the
 * second panel more room.
 */
export interface Screen {
  roomy: boolean;
  wide: boolean;
  sp: boolean;
  xl: boolean;
}

const ROOMY = 600;
const WIDE = 900;
const SPLIT = 1100;
const XL = 1240;

const measure = (): string => {
  const width = typeof innerWidth === "number" ? innerWidth : 1280;
  return width >= XL
    ? "xl"
    : width >= SPLIT
      ? "sp"
      : width >= WIDE
        ? "wide"
        : width >= ROOMY
          ? "roomy"
          : "phone";
};

let size = measure();
const listeners = new Set<() => void>();
if (typeof addEventListener === "function") {
  addEventListener("resize", () => {
    const next = measure();
    if (next === size) return;
    size = next;
    for (const l of listeners) l();
  });
}

const SCREENS: Record<string, Screen> = {
  phone: { roomy: false, wide: false, sp: false, xl: false },
  roomy: { roomy: true, wide: false, sp: false, xl: false },
  wide: { roomy: true, wide: true, sp: false, xl: false },
  sp: { roomy: true, wide: true, sp: true, xl: false },
  xl: { roomy: true, wide: true, sp: true, xl: true },
};

export function useScreen(): Screen {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => size,
  );
  return SCREENS[now]!;
}

/** The classes the screen's root carries for its width. */
export const screenClasses = (s: Screen): string =>
  `${s.roomy ? " roomy" : ""}${s.wide ? " wide" : ""}${s.sp ? " sp" : ""}${s.xl ? " xl" : ""}`;

/**
 * Says on the page whether a mouse drives it: the side bar and the lists are then denser, and
 * the empty home page keeps its composer under the greeting.
 */
export function watchDevice(): void {
  if (typeof matchMedia !== "function") return;
  const mouse = matchMedia("(hover: hover) and (pointer: fine)");
  const apply = () => {
    document.documentElement.dataset.dev = mouse.matches ? "desk" : "touch";
  };
  apply();
  mouse.addEventListener("change", apply);
}

/** Whether a mouse drives the page (`data-dev="desk"`, set by `watchDevice`). */
export function useMouse(): boolean {
  return useSyncExternalStore(
    (l) => {
      if (typeof matchMedia !== "function") return () => {};
      const q = matchMedia("(hover: hover) and (pointer: fine)");
      q.addEventListener("change", l);
      return () => q.removeEventListener("change", l);
    },
    () =>
      typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
}
