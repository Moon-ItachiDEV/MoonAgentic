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
    <div className="gate2">
      <MoonMark width={44} height={44} />
      <h1>Appairer cet appareil</h1>
      <span className="ppill">Réglages · Accès distant · Appairer un appareil</span>
      <form
        className="gform"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy) void submit();
        }}
      >
        <input
          className="rni mono"
          aria-label="Code d'appairage"
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="b2 ink press" disabled={busy || !code.trim()}>
          {busy && <span className="t2-spin" />}
          Appairer
        </button>
      </form>
      {error && (
        <p className="pcw t-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
