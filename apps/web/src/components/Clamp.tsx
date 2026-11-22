import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** A long text cut to its first lines, opened on demand. */
export function Clamp({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  // Measured again when the thread narrows, as when the review panel opens beside it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 4);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The text inside grows on its own too, as an answer streams in.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [children, open]);

  return (
    <>
      <div ref={box} className={`clamp${open ? " open" : long ? " long" : ""}`}>
        {children}
      </div>
      {(long || open) && (
        <button className="lnk sm clamp-more" onClick={() => setOpen((o) => !o)}>
          {open ? "Voir moins" : "Voir plus"}
        </button>
      )}
    </>
  );
}
