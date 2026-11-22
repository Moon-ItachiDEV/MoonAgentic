import { useEffect, useState } from "react";

export interface Confirmation {
  title: string;
  text: string;
  /** The button that does it, which says what it does. */
  action: string;
  run: () => Promise<void> | void;
}

/** Asks before a step that cannot be undone; says why it failed, if it does. */
export function ConfirmDialog({
  confirm,
  onClose,
}: {
  confirm: Confirmation;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // While it runs, the box stays: closing it would hide whether it worked.
  const close = () => !busy && onClose();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirm.run();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="alertdialog" aria-modal aria-labelledby="cf-title">
        <h2 id="cf-title">{confirm.title}</h2>
        <p>{confirm.text}</p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn quiet" disabled={busy} onClick={close}>
            Annuler
          </button>
          <button className="btn danger" autoFocus disabled={busy} onClick={() => void go()}>
            {confirm.action}
          </button>
        </div>
      </div>
    </div>
  );
}
