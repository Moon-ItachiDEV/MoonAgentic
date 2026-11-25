import type { Thread } from "@moonagentic/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connection } from "../connection.ts";
import { I } from "./I.tsx";
import { scrRoot } from "./scr.ts";

/** Held this long without moving, a finger opens a line's menu. */
const HOLD_MS = 480;

/**
 * The menu of a conversation's line (pin, read, resolve, delete), opened by a right click or
 * a long press. `bind(thread)` gives the line what it needs; `menu` is drawn once, anywhere.
 */
export function useThreadRowMenu(
  threads: Thread[],
  actions: {
    onTogglePin: (id: string, pinned: boolean) => void;
    onSetArchived: (id: string, archived: boolean) => void;
    onDeleteThread: (thread: Thread) => void;
  },
) {
  const [at, setAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  /** A long press opened the menu: the click that ends it must not open the line. */
  const held = useRef(false);
  const thread = threads.find((t) => t.id === at?.id);
  const open = !!at && !!thread;

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Element)) setAt(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAt(null);
    };
    const moved = () => setAt(null);
    // After this press ends: the press that opened the menu must not close it.
    const timer = setTimeout(() => document.addEventListener("pointerdown", away));
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", moved);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  const drop = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const bind = (t: Thread) => ({
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      setAt({ id: t.id, x: event.clientX, y: event.clientY });
    },
    onPointerDown: (event: React.PointerEvent) => {
      held.current = false;
      if (event.pointerType === "mouse") return;
      const { clientX: x, clientY: y } = event;
      drop();
      hold.current = {
        x,
        y,
        timer: setTimeout(() => {
          held.current = true;
          setAt({ id: t.id, x, y });
          navigator.vibrate?.(8);
        }, HOLD_MS),
      };
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = hold.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) drop();
    },
    onPointerUp: drop,
    onPointerCancel: drop,
    onClickCapture: (event: React.MouseEvent) => {
      if (!held.current) return;
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });
  const act = (run: () => void) => () => {
    setAt(null);
    run();
  };

  const menu =
    open &&
    createPortal(
      <div
        ref={ref}
        className="pmenu still rowm"
        role="menu"
        aria-label={`Actions de ${thread.title}`}
        style={{ "--x": `${at.x}px`, "--y": `${at.y}px` } as CSSProperties}
      >
        {!thread.archived && (
          <button
            className="pi2"
            role="menuitem"
            onClick={act(() => actions.onTogglePin(thread.id, !thread.pinned))}
          >
            <I n="star" s={20} />
            <span className="nm">{thread.pinned ? "Désépingler" : "Épingler"}</span>
          </button>
        )}
        {!thread.archived && (
          <button
            className="pi2"
            role="menuitem"
            onClick={act(() =>
              connection.send({
                type: "thread.setUnread",
                threadId: thread.id,
                unread: !thread.unread,
              }),
            )}
          >
            <I n="dot" s={20} />
            <span className="nm">
              {thread.unread ? "Marquer comme lu" : "Marquer comme non lu"}
            </span>
          </button>
        )}
        <button
          className="pi2"
          role="menuitem"
          onClick={act(() => actions.onSetArchived(thread.id, !thread.archived))}
        >
          <I n="check" s={20} />
          <span className="nm">{thread.archived ? "Rouvrir" : "Marquer résolu"}</span>
        </button>
        <div className="psep" />
        <button
          className="pi2 dng"
          role="menuitem"
          onClick={act(() => actions.onDeleteThread(thread))}
        >
          <I n="x" s={20} />
          <span className="nm">Supprimer…</span>
        </button>
      </div>,
      scrRoot(),
    );

  return { bind, menu };
}
