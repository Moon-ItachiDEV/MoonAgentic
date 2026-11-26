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
    let armed = false;
    let list: HTMLElement | null = null;
    const ring = () => button.current?.querySelector<SVGCircleElement>(".pr circle") ?? null;
    const arm = (next: boolean) => {
      if (next === armed) return;
      armed = next;
      button.current?.classList.toggle("armed", next);
      if (next && navigator.vibrate) navigator.vibrate(8);
    };
    const start = (event: TouchEvent) => {
      const target = event.target as Element;
      list = root.querySelector<HTMLElement>(".dscroll");
      if (!list || list.scrollTop > 0 || !target.closest(".dscroll, .dtop")) return;
      if (target.closest("input, textarea")) return;
      y0 = event.touches[0]!.clientY;
      armed = false;
      list.classList.add("dpull");
      list.style.transition = "none";
    };
    const move = (event: TouchEvent) => {
      if (y0 === null || !list) return;
      const dy = event.touches[0]!.clientY - y0;
      if (dy <= 0) {
        list.style.transform = "";
        return;
      }
      if (event.cancelable) event.preventDefault();
      const pull = Math.min(140, dy) * 0.5 + Math.max(0, dy - 140) * 0.15;
      list.style.transform = `translateY(${pull}px)`;
      const p = Math.min(1, dy / ARM_PX);
      const circle = ring();
      if (circle) circle.style.strokeDashoffset = String(1 - p);
      arm(p >= 1);
    };
    const end = () => {
      if (y0 === null || !list) return;
      y0 = null;
      list.style.transition = "transform 420ms var(--spring)";
      list.style.transform = "";
      const circle = ring();
      if (circle) circle.style.strokeDashoffset = "1";
      if (armed) {
        setTimeout(() => {
          arm(false);
          open();
        }, 140);
      }
    };
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", end);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", end);
    };
  }, [top, button, open, on]);
}
