import { useSyncExternalStore } from "react";

/**
 * The layout follows the window's real width, as in the mockup: `roomy` centres the content
 * and turns the bottom sheets into windows, `wide` pins the menu as a side bar and drops the
 * bottom tabs, `xl` leaves room for a second panel.
 */
export interface Screen {
  roomy: boolean;
  wide: boolean;
  xl: boolean;
}

const ROOMY = 600;
const WIDE = 900;
const XL = 1240;

const measure = (): string => {
  const width = typeof innerWidth === "number" ? innerWidth : 1280;
  return width >= XL ? "xl" : width >= WIDE ? "wide" : width >= ROOMY ? "roomy" : "phone";
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
  phone: { roomy: false, wide: false, xl: false },
  roomy: { roomy: true, wide: false, xl: false },
  wide: { roomy: true, wide: true, xl: false },
  xl: { roomy: true, wide: true, xl: true },
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
  `${s.roomy ? " roomy" : ""}${s.wide ? " wide" : ""}${s.xl ? " xl" : ""}`;

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
