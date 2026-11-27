import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { scrRoot } from "./scr.ts";

/**
 * A menu that drops from the button that opened it, as the menus of the Claude app do: on an
 * iPad or a computer, a choice in a list is made here rather than in a window in the middle.
 * It opens under its button (above when there is no room), or beside the menu it was opened
 * from (`side`). Escape, a click elsewhere, a scroll or a resize close it.
 */
export function Dropdown(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  /** Opens beside this menu rather than under its button. */
  side?: boolean;
  /** Lines up with the left edge of its button rather than the right one. */
  start?: boolean;
  className?: string;
  role?: "menu" | "dialog";
  children: ReactNode;
}) {
  const { anchor } = props;
  const box = useRef<HTMLDivElement>(null);
  // The latest `onClose`, for the listeners set once while it is open.
  const close = useRef(props.onClose);
  close.current = props.onClose;
  /** Places it against its button again, after a scroll under it. */
  const replace = useRef<() => void>(() => {});
  const [at, setAt] = useState<{ x: number; y: number; up: boolean; ox: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current;
      const el = box.current;
      if (!a || !el) return;
      const r = a.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const menu = props.side ? a.closest(".pmenu") : null;
      // Placed again at the same spot, it keeps its state: nothing re-renders.
      const put = (next: { x: number; y: number; up: boolean; ox: number }) =>
        setAt((was) =>
          was && was.x === next.x && was.y === next.y && was.up === next.up && was.ox === next.ox
            ? was
            : next,
        );
      if (menu) {
        const m = menu.getBoundingClientRect();
        let x = m.right + 6;
        if (x + w > innerWidth - 8) x = m.left - w - 6;
        put({ x, y: Math.max(8, Math.min(r.top - 5, innerHeight - h - 8)), up: false, ox: 0 });
        return;
      }
      const edge = props.start ? r.left : r.right - w;
      const x = Math.max(8, Math.min(edge, innerWidth - w - 8));
      const below = r.bottom + 4;
      const fits = below + h <= innerHeight - 8;
      const up = !fits && r.top - h - 4 >= 8;
      // Room neither under nor over its button: it keeps inside the window.
      const y = fits ? below : up ? r.top - h - 4 : Math.max(8, innerHeight - h - 8);
      put({ x, y, up, ox: props.start ? 14 : r.right - x - 14 });
    };
    replace.current = place;
    place();
    // What it shows can change while open (« Tous »): it is placed again.
    const watch = new ResizeObserver(place);
    if (box.current) watch.observe(box.current);
    return () => watch.disconnect();
  }, [anchor, props.side, props.start]);

  useEffect(() => {
    const a = anchor.current;
    a?.setAttribute("aria-expanded", "true");
    /** The click that follows a press closing the menu, kept from reaching what was under it. */
    const swallow = (el: Element) => {
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      el.addEventListener("click", stop, { capture: true, once: true });
      const drop = () => el.removeEventListener("click", stop, { capture: true });
      // Let go elsewhere, no click reaches it: the next one must not be swallowed.
      const later = () => setTimeout(drop, 0);
      document.addEventListener("pointerup", later, { capture: true, once: true });
      document.addEventListener("pointercancel", later, { capture: true, once: true });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (box.current?.contains(target)) return;
      // A press on its own button closes it there; the button's click must not reopen it.
      if (a?.contains(target)) swallow(a);
      // A press on the veil of the window under it closes the menu, not the window too.
      else if (target.closest?.(".sscrim")) swallow(target);
      close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        a?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [
        ...(box.current?.querySelectorAll<HTMLElement>(
          "[role^=menuitem]:not([disabled]), [role=radio]:not([disabled])",
        ) ?? []),
      ];
      if (!items.length) return;
      event.preventDefault();
      const now = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "ArrowDown"
          ? items[(now + 1) % items.length]
          : items[(now - 1 + items.length) % items.length];
      next?.focus();
    };
    // A scroll under it carries its button along: it follows, and closes once the button is gone.
    const away = (event: Event) => {
      if (box.current?.contains(event.target as Node)) return;
      const r = a?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > innerHeight) close.current();
      else replace.current();
    };
    const resize = () => close.current();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    addEventListener("resize", resize);
    document.addEventListener("scroll", away, true);
    return () => {
      a?.removeAttribute("aria-expanded");
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      removeEventListener("resize", resize);
      document.removeEventListener("scroll", away, true);
    };
  }, [anchor]);

  // The keyboard starts on the chosen line, or the first one, once: placed again later (a
  // search narrowing the list, « Tous »), it stays where it is typed in.
  const focused = useRef(false);
  useEffect(() => {
    if (!at || focused.current) return;
    focused.current = true;
    const el = box.current;
    const first =
      el?.querySelector<HTMLElement>("[aria-checked=true]") ??
      el?.querySelector<HTMLElement>("input, [role^=menuitem], [role=radio]");
    first?.focus({ preventScroll: true });
  }, [at]);

  return createPortal(
    <div
      ref={box}
      className={`ddm${at?.up ? " up" : ""}${props.className ? ` ${props.className}` : ""}`}
      role={props.role ?? "menu"}
      aria-label={props.label}
      style={
        {
          left: at?.x ?? 0,
          top: at?.y ?? 0,
          visibility: at ? "visible" : "hidden",
          "--ox": `${at?.ox ?? 0}px`,
        } as React.CSSProperties
      }
    >
      {props.children}
    </div>,
    scrRoot(),
  );
}
