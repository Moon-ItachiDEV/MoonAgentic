import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { I } from "./I.tsx";
import { scrRoot } from "./scr.ts";

/**
 * An image or a file at its full size, over the whole app on black: a way out at the top,
 * what can be done with it at the bottom.
 */
export function Viewer(props: {
  label: string;
  onClose: () => void;
  /** At the bottom: to open it elsewhere, to keep it. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  // One frame at rest, then it fades in.
  const [on, setOn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true));
    const before = document.activeElement;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose.current();
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  // On the app itself, so no message's own layout clips it.
  return createPortal(
    <div className={`imgv${on ? " on" : ""}`} role="dialog" aria-modal aria-label={props.label}>
      <div className="ivt">
        <button ref={close} className="ivb press" aria-label="Fermer" onClick={props.onClose}>
          <I n="x" s={20} />
        </button>
      </div>
      <div className="ivi" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        {props.children}
      </div>
      {props.actions && <div className="ivf">{props.actions}</div>}
    </div>,
    scrRoot(),
  );
}
