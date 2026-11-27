import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Dropdown } from "./Dropdown.tsx";
import { I } from "./I.tsx";
import type { IconName } from "./sprite.ts";
import { scrRoot } from "./scr.ts";

/** How long a popover or a menu takes to leave. */
const OUT_MS = 140;
/** Under this width, a popover takes the screen's width, as on a phone. */
const PHONE = 600;

/**
 * Closes what floats over the page on a press outside it or on Escape. A press on the
 * button that opened it closes it too, without the click that follows opening it again.
 */
function useDismiss(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  anchor: HTMLElement | null,
  onClose: () => void,
  /** What a press may land on without closing it: a menu opened from inside it. */
  inside = ".ddm",
  locked = false,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || locked) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Element;
      if (box.current?.contains(target) || target.closest?.(inside)) return;
      if (anchor?.contains(target)) {
        const swallow = (click: MouseEvent) => {
          click.stopPropagation();
          click.preventDefault();
        };
        document.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 600);
      }
      close.current();
    };
    // Before the settings and the sheets, which close on Escape too; a menu opened from a
    // window closes alone.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const menu = document.querySelector(".ddm");
      if (menu && menu !== box.current) return;
      event.preventDefault();
      close.current();
    };
    // After the press that opened it.
    const timer = setTimeout(() => document.addEventListener("pointerdown", away, true));
    document.addEventListener("keydown", escape, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, box, anchor, inside, locked]);
}

/** Kept on the page while it leaves, so it can fade out. */
function useLeaving(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setMounted(false);
    const timer = setTimeout(() => setMounted(false), OUT_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

type Place = { x: number; y: number; w: number; up: boolean; ox: number };

/**
 * A window hung from the button that opened it, below it or above it when there is no room:
 * the width of the screen on a phone, `width` wide elsewhere. Its buttons stay at its foot.
 */
export function Pop(props: {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  title: string;
  /** Wider, for a command's output. */
  wide?: boolean;
  /** A press outside and Escape leave it open (a command running). */
  locked?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const shown = useLeaving(props.open);
  const last = useRef<ReactNode>(null);
  if (props.open) last.current = props.children;
  const [place, setPlace] = useState<Place | null>(null);
  useDismiss(props.open, box, props.anchor, props.onClose, ".ddm, .cfm", props.locked);

  useLayoutEffect(() => {
    if (!shown) return;
    const paint = () => {
      const el = box.current;
      if (!el) return;
      const W = innerWidth;
      const H = innerHeight;
      const phone = W < PHONE;
      const w = phone ? W - 24 : props.wide ? 420 : 360;
      const h = el.offsetHeight;
      const a = props.anchor?.isConnected ? props.anchor.getBoundingClientRect() : null;
      if (!a || !a.width) {
        setPlace({ x: (W - w) / 2, y: Math.max(12, (H - h) / 2), w, up: false, ox: w / 2 });
        return;
      }
      const top = phone ? 54 : 12;
      let x = phone ? 12 : a.width > w ? a.left : a.right - w;
      x = Math.max(12, Math.min(x, W - w - 12));
      let y = a.bottom + 6;
      let up = false;
      if (y + h > H - 12) {
        if (a.top - 6 - h >= top) {
          y = a.top - 6 - h;
          up = true;
        } else y = Math.max(top, H - 12 - h);
      }
      const ox = Math.max(16, Math.min(w - 16, (a.left + a.right) / 2 - x));
      setPlace((p) =>
        p && p.x === x && p.y === y && p.w === w && p.up === up && p.ox === ox
          ? p
          : { x, y, w, up, ox },
      );
    };
    paint();
    const seen = new ResizeObserver(paint);
    if (box.current) seen.observe(box.current);
    const scrolled = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) paint();
    };
    addEventListener("resize", paint);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      seen.disconnect();
      removeEventListener("resize", paint);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [shown, props.anchor, props.wide]);

  if (!shown) return null;
  const style = place
    ? ({
        left: place.x,
        top: place.y,
        width: place.w,
        "--ox": `${place.ox}px`,
      } as CSSProperties)
    : ({ visibility: "hidden", width: props.wide ? 420 : 360 } as CSSProperties);
  return createPortal(
    <div
      ref={box}
      className={`skpop${props.open && place ? " on" : ""}${props.open ? "" : " out"}${place?.up ? " up" : ""}`}
      role="dialog"
      aria-label={props.title}
      style={style}
    >
      <div className="skh">
        <h3>{props.title}</h3>
      </div>
      <div className="skb">{props.open ? props.children : last.current}</div>
    </div>,
    scrRoot(),
  );
}

export type DropItem =
  | { value: string; label: string; icon?: IconName; color?: string }
  | { sep: true }
  | { heading: string };

/**
 * A short list of choices hung from its button, drawn by the app's one {@link Dropdown}: under
 * its value when the button shows one on its right, under its start otherwise. A tick marks
 * `value` when it is given.
 */
export function DropMenu(props: {
  open: boolean;
  anchor: HTMLElement | null;
  label: string;
  items: DropItem[];
  value?: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const anchor = useMemo(() => ({ current: props.anchor }), [props.anchor]);
  if (!props.open || !props.anchor) return null;
  const radio = props.value !== undefined;
  const start = !props.anchor.querySelector(".rt");
  return (
    <Dropdown
      anchor={anchor}
      start={start}
      label={props.label}
      className="skm"
      onClose={props.onClose}
    >
      {props.items.map((item, i) =>
        "sep" in item ? (
          <hr key={i} />
        ) : "heading" in item ? (
          <div key={i} className="ddh">
            {item.heading}
          </div>
        ) : (
          <button
            key={item.value}
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? item.value === props.value : undefined}
            onClick={() => {
              props.onClose();
              props.onPick(item.value);
            }}
          >
            {item.icon && (
              <span className="ddi" style={item.color ? { color: item.color } : undefined}>
                <I n={item.icon} s={16} />
              </span>
            )}
            <span className="ddt">{item.label}</span>
            {radio && item.value === props.value && (
              <span className="ddk">
                <I n="check" s={15} />
              </span>
            )}
          </button>
        ),
      )}
    </Dropdown>
  );
}
