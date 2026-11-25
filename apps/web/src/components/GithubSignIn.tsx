import type { GithubDeviceCode } from "@moonagentic/protocol";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { Glyph, I } from "../v2/I.tsx";

const useGithubLogin = () =>
  useSyncExternalStore(connection.subscribe, () => connection.getState().githubLogin);

/**
 * « Se connecter »: asks the server for a code, shows it, and opens github.com where the user
 * types it. The server waits for GitHub's answer, so this only shows what it says.
 */
export function GithubSignIn({ onSignedIn }: { onSignedIn: (login: string) => void }) {
  const [device, setDevice] = useState<GithubDeviceCode | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const result = useGithubLogin();
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

  // Left while GitHub was still waited for: the server stops waiting too.
  useEffect(
    () => () => {
      if (startedAt.current === null) return;
      startedAt.current = null;
      void connection.ask({ type: "github.loginCancel", requestId: newId() }).catch(() => {});
    },
    [],
  );

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

  // Missing on a page served over plain http (a phone through the local network).
  const copy = () => {
    if (!device) return;
    void navigator.clipboard?.writeText(device.userCode).then(
      () => setCopied(true),
      () => {},
    );
  };

  /** Copies the code and opens GitHub in the same click, so no browser blocks the new tab. */
  const openGithub = () => {
    if (!device) return;
    copy();
    window.open(device.verificationUri, "_blank", "noopener");
  };

  if (!device) {
    return (
      <>
        {error && (
          <p className="pcw t-err" role="alert">
            {error}
          </p>
        )}
        <div className="mga">
          <button type="button" className="b2 ink press" disabled={asking} onClick={start}>
            {asking ? <span className="t2-spin" /> : <I n="gh" s={17} />}
            Se connecter
          </button>
        </div>
      </>
    );
  }
  return (
    <div aria-live="polite">
      <div className="ghw">
        <output className="ghc" aria-label="Code à taper sur GitHub">
          {device.userCode.split("-").map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <span>-</span>}
              {part}
            </Fragment>
          ))}
        </output>
        <span className="ppill">
          <Glyph />
          En attente
        </span>
      </div>
      <div className="rva">
        <button type="button" className="b2 soft press" onClick={copy}>
          <I n={copied ? "check" : "copies"} s={16} />
          {copied ? "Copié" : "Copier"}
        </button>
        <button type="button" className="b2 ink press" onClick={openGithub}>
          <I n="ext" s={16} />
          Ouvrir GitHub
        </button>
      </div>
    </div>
  );
}
