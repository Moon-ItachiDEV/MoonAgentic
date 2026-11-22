import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** A long text cut to its first lines, opened on demand. */
export function Clamp({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 4);
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
