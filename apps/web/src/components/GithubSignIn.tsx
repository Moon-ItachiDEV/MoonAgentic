import type { GithubDeviceCode } from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";

/** The GitHub mark, drawn here rather than loaded, so it follows the theme. */
export const GithubMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const useGithubLogin = () =>
  useSyncExternalStore(connection.subscribe, () => connection.getState().githubLogin);

/**
 * « Se connecter à GitHub »: asks the server for a code, shows it, and opens github.com where the
 * user types it. The server waits for GitHub's answer, so this only shows what it says.
 */
export function GithubSignIn({ onSignedIn }: { onSignedIn: (login: string) => void }) {
  const [device, setDevice] = useState<GithubDeviceCode | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const result = useGithubLogin();
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard;
  // Only an ending that comes after this sign-in started counts.
  const startedAt = useRef<number | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  useEffect(() => {
    if (!result || startedAt.current === null || result.seq <= startedAt.current) return;
    startedAt.current = null;
    setDevice(null);
    if (result.state === "done") signedIn.current(result.login ?? "");
    else if (result.state === "failed") setError(result.error ?? "La connexion a échoué.");
  }, [result]);

  const start = async () => {
    setAsking(true);
    setError(null);
    setCopied(false);
    startedAt.current = connection.getState().githubLogin?.seq ?? 0;
    try {
      const reply = await connection.ask({ type: "github.login", requestId: newId() });
      setDevice(reply.device);
    } catch (e) {
      startedAt.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  const cancel = () => {
    setDevice(null);
    startedAt.current = null;
    void connection.ask({ type: "github.loginCancel", requestId: newId() }).catch(() => {});
  };

  /** Copies the code and opens GitHub in the same click, so no browser blocks the new tab. */
  const openGithub = () => {
    if (!device) return;
    // Missing on a page served over plain http (a phone through the local network).
    void navigator.clipboard?.writeText(device.userCode).then(
      () => setCopied(true),
      () => {},
    );
    window.open(device.verificationUri, "_blank", "noopener");
  };

  if (!device) {
    return (
      <div className="gh-signin">
        <button type="button" className="btn pri gh-btn" disabled={asking} onClick={start}>
          <GithubMark size={16} />
          {asking ? "Connexion…" : "Se connecter à GitHub"}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  return (
    <div className="gh-code" aria-live="polite">
      <span className="gh-step">Ton code de connexion</span>
      <output className="gh-user-code" aria-label="Code à taper sur GitHub">
        {device.userCode}
      </output>
      <button type="button" className="btn pri gh-btn" onClick={openGithub}>
        <GithubMark size={16} />
        {copied
          ? "Code copié, ouvrir GitHub"
          : canCopy
            ? "Copier le code et ouvrir GitHub"
            : "Ouvrir GitHub"}
      </button>
      <p className="gh-wait">
        <span className="gh-dot" aria-hidden />
        Colle ce code sur{" "}
        <a href={device.verificationUri} target="_blank" rel="noreferrer">
          {device.verificationUri.replace(/^https:\/\//, "")}
        </a>{" "}
        puis autorise MoonAgentic. Cette fenêtre continue toute seule.
      </p>
      <button type="button" className="btn quiet sm" onClick={cancel}>
        Annuler
      </button>
    </div>
  );
}
