import { useEffect, useRef } from "react";
import { IconPlus } from "./icons.tsx";

const ITEMS = [
  { insert: "@", label: "Joindre un fichier du projet", key: "@" },
  { insert: "$", label: "Utiliser un skill", key: "$" },
  { insert: "/", label: "Lancer une commande", key: "/" },
] as const;

/** The composer's « + »: starts the word it already completes, for whoever does not type it. */
export function PlusMenu(props: {
  open: boolean;
  disabled: boolean;
  inThread: boolean;
  onToggle: (open: boolean) => void;
  onPick: (insert: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) props.onToggle(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && props.onToggle(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [props.open]);

  return (
    <div className="plus" ref={root}>
      <button
        className="plus-btn"
        aria-label="Ajouter"
        aria-haspopup="menu"
        aria-expanded={props.open}
        disabled={props.disabled}
        title={props.disabled ? "Crée d'abord un projet" : "Fichier, skill ou commande"}
        onClick={() => props.onToggle(!props.open)}
      >
        <IconPlus />
      </button>
      {props.open && (
        <div className="menu plus-menu" role="menu">
          {ITEMS.map((item) => (
            <button key={item.key} role="menuitem" onClick={() => props.onPick(item.insert)}>
              <span className="plus-k">{item.key}</span>
              <span className="tx">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
