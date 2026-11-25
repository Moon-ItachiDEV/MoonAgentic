import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { I } from "./I.tsx";
import { scrRoot, useScrFlag } from "./scr.ts";

/** How long a sheet takes to slide back down before it leaves the page. */
const CLOSE_MS = 460;
/** Pulled down this far, or flicked, a sheet closes when it is let go. */
const DISMISS_PX = 110;

/**
 * A sheet, as in the mockup: it rises from the bottom on a phone and can be pulled back down
 * by its header; on a wider screen it is a window in the middle. A veil behind it closes it.
 */
export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  /** Its title, in its header. Without one, the sheet draws its own content only. */
  title?: string;
  /** What names it for a screen reader, when it has no title. */
  label?: string;
  /** Takes the whole height (a list to read, a form), not only what it holds. */
  tall?: boolean;
  /** On the right of the header, facing the button that closes. */
  right?: ReactNode;
  className?: string;
  /** Escape and a click on the veil leave it open (a step that must be answered). */
  modal?: boolean;
  children: ReactNode;
}) {
  const { open, onClose } = props;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const last = useRef<ReactNode>(null);
  if (open) last.current = props.children;
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // One frame at rest below the screen, then it rises.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setMounted(false);
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);
  useScrFlag("sh", open);

  useEffect(() => {
    if (!open || props.modal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Sheets stack: only the one on top leaves.
      if ([...scrRoot().querySelectorAll(".sheet.on")].at(-1) !== sheet.current) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose, props.modal]);

  // Pulled down by its header, it follows the finger, then closes or springs back.
  const drag = useRef<{ y: number; t: number; id: number } | null>(null);
  const [pull, setPull] = useState(0);
  const down = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse" || (event.target as Element).closest("button, input")) return;
    drag.current = { y: event.clientY, t: event.timeStamp, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    setPull(Math.max(0, event.clientY - drag.current.y));
  };
  const up = (event: React.PointerEvent) => {
    const start = drag.current;
    if (start?.id !== event.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, event.clientY - start.y);
    const speed = dy / Math.max(1, event.timeStamp - start.t);
    setPull(0);
    if (dy > DISMISS_PX || (dy > 30 && speed > 0.6)) onClose();
  };

  if (!mounted) return null;
  const on = open && shown;
  return createPortal(
    <>
      <div
        className={`sscrim${on ? " on" : ""}`}
        onClick={() => !props.modal && onClose()}
        aria-hidden
      />
      <div
        ref={sheet}
        className={`sheet${on ? " on" : ""}${props.tall ? " tall" : ""}${pull ? " pulled" : ""}${props.className ? ` ${props.className}` : ""}`}
        role="dialog"
        aria-modal
        aria-label={props.title ?? props.label}
        inert={!open}
        style={pull ? ({ "--dy": `${pull}px` } as React.CSSProperties) : undefined}
      >
        {props.title !== undefined && (
          <div
            className="shd"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          >
            <div className="grab" />
            <h3>{props.title}</h3>
            <button className="gb glass x press" aria-label="Fermer" onClick={onClose}>
              <I n="x" s={18} />
            </button>
            {props.right}
          </div>
        )}
        {open ? props.children : last.current}
      </div>
    </>,
    scrRoot(),
  );
}
