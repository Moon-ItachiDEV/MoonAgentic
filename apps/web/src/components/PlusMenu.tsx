import { useEffect, useRef } from "react";
import { arrowKeys } from "./ComposerTray.tsx";
import { IconCamera, IconFile, IconImage, IconPlus, IconTerminal } from "./icons.tsx";
import { Presence } from "./Presence.tsx";

const ITEMS = [
  { insert: "@", label: "Joindre un fichier du projet", key: "@", icon: <IconFile size={13} /> },
  { insert: "$", label: "Utiliser un skill", key: "$", icon: <span className="sk">$</span> },
  { insert: "/", label: "Lancer une commande", key: "/", icon: <IconTerminal size={14} /> },
] as const;

/** A screen that is touched, so most likely a phone or a tablet with a camera. */
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * The composer's « + »: joins an image, or starts the word the composer already completes,
 * for whoever does not type it.
 */
export function PlusMenu(props: {
  open: boolean;
  disabled: boolean;
  inThread: boolean;
  onToggle: (open: boolean) => void;
  onPick: (insert: string) => void;
  /** Opens the choice of images, or the camera for a photo taken now. */
  onImage: (from: "files" | "camera") => void;
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
        className="plus-btn ib"
        aria-label="Ajouter"
        aria-haspopup="menu"
        aria-expanded={props.open}
        disabled={props.disabled}
        title={props.disabled ? "Crée d'abord un projet" : "Image, fichier, skill ou commande"}
        onClick={() => props.onToggle(!props.open)}
      >
        <IconPlus />
      </button>
      <Presence show={props.open}>
        <div className="menu anchored left plus-menu" role="menu" onKeyDown={arrowKeys}>
          <button role="menuitem" onClick={() => props.onImage("files")}>
            <span className="plus-k">
              <IconImage />
            </span>
            <span className="tx">Joindre une image</span>
          </button>
          {touch && (
            <button role="menuitem" onClick={() => props.onImage("camera")}>
              <span className="plus-k">
                <IconCamera />
              </span>
              <span className="tx">Prendre une photo</span>
            </button>
          )}
          <div className="menu-sep" role="separator" />
          {ITEMS.map((item) => (
            <button key={item.key} role="menuitem" onClick={() => props.onPick(item.insert)}>
              <span className="plus-k">{item.icon}</span>
              <span className="tx">{item.label}</span>
              <kbd>{item.key}</kbd>
            </button>
          ))}
        </div>
      </Presence>
    </div>
  );
}
