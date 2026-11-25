import { useState } from "react";
import { Sheet } from "../v2/Sheet.tsx";

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
  const [open, setOpen] = useState(true);
  // While it runs, the sheet stays: closing it would hide whether it worked.
  const close = () => {
    if (busy) return;
    setOpen(false);
    onClose();
  };

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirm.run();
      setOpen(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={close} label={confirm.title} modal={busy}>
      <div className="cfw" role="alertdialog" aria-labelledby="cf-title">
        <div className="grab" />
        <h3 id="cf-title">{confirm.title}</h3>
        {confirm.text &&
          (confirm.text.length <= 56 ? (
            <span className="ppill">{confirm.text}</span>
          ) : (
            <p className="cft">{confirm.text}</p>
          ))}
        {error && <p className="cft err">{error}</p>}
        <div className="cfa">
          <button className="b2 red press" autoFocus disabled={busy} onClick={() => void go()}>
            {confirm.action}
          </button>
          <button className="b2 soft press" disabled={busy} onClick={close}>
            Annuler
          </button>
        </div>
      </div>
    </Sheet>
  );
}
