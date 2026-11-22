import { useState } from "react";
import { connection } from "../connection.ts";

export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const derivedName = name.trim() || path.trim().split(/[\\/]/).filter(Boolean).pop() || "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await connection.request({
        type: "project.create",
        requestId: crypto.randomUUID(),
        name: derivedName,
        path: path.trim(),
      });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal
        aria-labelledby="np-title"
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 id="np-title">Nouveau projet</h2>
        <p>Un dossier de code sur la machine où tourne MoonAgentic.</p>
        <label className="field">
          Dossier
          <input
            className="mono"
            autoFocus
            required
            placeholder="~/code/mon-projet"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <label className="field">
          Nom
          <input
            placeholder={derivedName || "mon-projet"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn pri" disabled={busy || !path.trim() || !derivedName}>
            Créer
          </button>
        </div>
      </form>
    </div>
  );
}
