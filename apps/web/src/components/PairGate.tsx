import { useState } from "react";
import { connection } from "../connection.ts";
import { MoonMark } from "./MoonMark.tsx";

/**
 * What a page without a working token shows: on a phone, the code shown on the computer
 * pairs it; on the computer, the link the server printed at start opens it.
 */
export function PairGate() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(connection.pairError);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await connection.pair(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="gate">
      <div>
        <MoonMark width={44} height={44} />
        <h1>Appairer cet appareil</h1>
        <p>
          Sur l'ordinateur où tourne MoonAgentic, ouvre Réglages, Accès distant, puis « Appairer un
          appareil ». Scanne le QR code, ou tape ici le code affiché.
        </p>
        <form
          className="pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim() && !busy) void submit();
          }}
        >
          <input
            aria-label="Code d'appairage"
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn pri" disabled={busy || !code.trim()}>
            {busy ? "Appairage…" : "Appairer"}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="pair-alt">
          Sur l'ordinateur lui-même, ouvre plutôt le lien affiché par le serveur au démarrage, celui
          qui finit par <code>#token=…</code>.
        </p>
      </div>
    </div>
  );
}
