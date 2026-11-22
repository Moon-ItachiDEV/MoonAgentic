import { type ReactNode, useEffect, useRef, useState } from "react";

/** Longest closing animation: a sheet sliding back down on a phone. */
const CLOSE_MS = 260;

/**
 * Keeps a popup on screen while it closes, as the mockup does: it fades and drops back (a
 * sheet slides down on a phone) instead of vanishing. While it closes it takes no input.
 * The wrapper has no box of its own, so the popup is placed exactly as before.
 */
export function Presence(props: { show: boolean; children: ReactNode }) {
  const last = useRef<ReactNode>(null);
  if (props.show) last.current = props.children;
  const [, rerender] = useState(0);
  // Opened again while it was closing: a fresh popup, not the closing one with its old page.
  const shown = useRef(false);
  const opening = useRef(0);
  if (props.show && !shown.current) opening.current++;
  shown.current = props.show;

  useEffect(() => {
    if (props.show || !last.current) return;
    const gone = () => {
      last.current = null;
      rerender((n) => n + 1);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return gone();
    const timer = setTimeout(gone, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [props.show]);

  if (!props.show && !last.current) return null;
  return (
    <div
      key={opening.current}
      className={props.show ? "presence" : "presence closing"}
      inert={!props.show}
    >
      {props.show ? props.children : last.current}
    </div>
  );
}
