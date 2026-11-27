import { type RefObject, useEffect } from "react";

/** How far the list is pulled before letting go opens the search. */
const ARM_PX = 130;

/**
 * Pulling the menu's list down from its top opens the search, as in the mockup (and the Claude
 * app): the ring around the search button fills as the finger goes down, the button widens into
 * a blue « Rechercher » once it is far enough, and letting go there opens the search. Touch
 * only (phone and iPad); a mouse keeps the button and Ctrl K.
 */
export function usePullToSearch(
  top: RefObject<HTMLElement | null>,
  button: RefObject<HTMLButtonElement | null>,
  open: () => void,
  on: boolean,
): void {
  useEffect(() => {
    const root = top.current?.parentElement;
    if (!on || !root) return;
    let y0: number | null = null;
    let x0 = 0;
    /** Until the finger has gone a little way, whether it goes down or sideways is not known. */
    let down = false;
    let armed = false;
    let list: HTMLElement | null = null;
    let opening: ReturnType<typeof setTimeout> | undefined;
    const ring = () => button.current?.querySelector<SVGCircleElement>(".pr circle") ?? null;
    const fill = (p: number) => {
      const circle = ring();
      if (circle) circle.style.strokeDashoffset = String(1 - p);
    };
    const arm = (next: boolean) => {
      if (next === armed) return;
      armed = next;
      button.current?.classList.toggle("armed", next);
      if (next && navigator.vibrate) navigator.vibrate(8);
    };
    /** The list springs back, the ring empties; the search opens only if `go`. */
    const settle = (go: boolean) => {
      if (y0 === null || !list) return;
      y0 = null;
      const el = list;
      el.style.transition = "transform 420ms var(--spring)";
      el.style.transform = "";
      el.classList.remove("dpull");
      fill(0);
      if (go && armed) {
        opening = setTimeout(() => {
          opening = undefined;
          arm(false);
          open();
        }, 140);
      } else arm(false);
    };
    const start = (event: TouchEvent) => {
      clearTimeout(opening);
      opening = undefined;
      arm(false);
      const target = event.target as Element;
      list = root.querySelector<HTMLElement>(".dscroll");
      if (!list || list.scrollTop > 0 || !target.closest(".dscroll, .dtop")) return;
      if (target.closest("input, textarea")) return;
      if (event.touches.length !== 1) return;
      y0 = event.touches[0]!.clientY;
      x0 = event.touches[0]!.clientX;
      down = false;
      list.classList.add("dpull");
      list.style.transition = "none";
    };
    const move = (event: TouchEvent) => {
      if (y0 === null || !list) return;
      const touch = event.touches[0]!;
      const dy = touch.clientY - y0;
      const dx = touch.clientX - x0;
      if (!down) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Sideways, or scrolling the list up, or the list scrolled meanwhile: not a pull.
        if (Math.abs(dx) > Math.abs(dy) || dy < 0 || list.scrollTop > 0) {
          settle(false);
          return;
        }
        down = true;
      }
      if (dy <= 0) {
        list.style.transform = "";
        fill(0);
        arm(false);
        return;
      }
      if (event.cancelable) event.preventDefault();
      const pull = Math.min(140, dy) * 0.5 + Math.max(0, dy - 140) * 0.15;
      list.style.transform = `translateY(${pull}px)`;
      const p = Math.min(1, dy / ARM_PX);
      fill(p);
      arm(p >= 1);
    };
    const end = () => settle(true);
    const cancel = () => settle(false);
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", cancel);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", cancel);
      clearTimeout(opening);
      settle(false);
    };
  }, [top, button, open, on]);
}
