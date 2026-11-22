import { useEffect, useRef, useState } from "react";
import { IconMore } from "./icons.tsx";

export interface MenuAction {
  label: string;
  run: () => void;
  danger?: boolean;
}

/** The thread's own actions, behind one button in the header. */
export function ThreadMenu({ actions }: { actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="thread-menu-wrap" ref={root}>
      <button
        className="ib"
        aria-label="Actions du fil"
        title="Actions du fil"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconMore />
      </button>
      {open && (
        <div className="menu thread-menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className={a.danger ? "danger" : undefined}
              onClick={() => {
                setOpen(false);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
