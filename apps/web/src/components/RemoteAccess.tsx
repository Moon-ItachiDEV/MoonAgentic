import type { RemoteAccess as Access } from "@moonagentic/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { connection } from "../connection.ts";
import { addressText, remoteAdvice, remoteLink } from "../remote.ts";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";

/** Copies text, also on a page opened over plain HTTP, where the clipboard API is missing. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      // nothing copied: the link stays on screen to be copied by hand
    }
    area.remove();
    return copied;
  }
}

/** A QR code drawn from the link itself, on white so that any camera reads it. */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const code = encode(text, { ecc: "M", border: 3 });
    let d = "";
    code.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: code.size, path: d };
  }, [text]);
  return (
    <svg
      className="ra-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code du lien de connexion"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * How to open this MoonAgentic from another device. Everything shown is what the server
 * finds when asked: an address is listed only if it answers.
 */
export function RemoteAccess() {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [token, setToken] = useState(connection.getToken);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    connection.remoteAccess().then(
      (found) => {
        setAccess(found);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const address = access?.addresses.find((a) => a.url === picked) ?? access?.addresses[0];
  const link = address ? remoteLink(address, token) : null;
  const about = address ? addressText(address) : null;
  const advice = access ? remoteAdvice(access) : null;

  return (
    <>
      <div className="set-card">
        <div className="set-row top">
          <div className="set-tx">
            <b>Adresse distante</b>
            {!access ? (
              <p>{error ?? "Recherche des adresses de cette machine…"}</p>
            ) : address && about ? (
              <>
                {access.addresses.length > 1 ? (
                  <label className="set-select ra-pick">
                    <select
                      aria-label="Adresse distante"
                      value={address.url}
                      onChange={(e) => setPicked(e.target.value)}
                    >
                      {access.addresses.map((a) => (
                        <option key={a.url} value={a.url}>
                          {addressText(a).label} · {a.url}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="ra-url">
                    <span className={`set-dot ${about.tone}`} aria-hidden />
                    {about.label} · <code>{address.url}</code>
                  </p>
                )}
                <p>{about.detail}</p>
              </>
            ) : (
              <p>Aucune adresse ne permet encore d'ouvrir MoonAgentic depuis un autre appareil.</p>
            )}
            {access && error && <p className="ra-err">{error}</p>}
          </div>
          <div className="set-ctl">
            <button className="btn sm" disabled={loading} onClick={load}>
              {loading ? "Recherche…" : "Actualiser"}
            </button>
          </div>
        </div>
        {link && (
          <div className="set-row top ra-link">
            <div className="set-tx">
              <b>Lien de connexion</b>
              <p>
                Scanne le QR code avec ton téléphone, ou copie le lien. Il contient le jeton : qui
                l'a pilote tes agents, alors ne le partage pas.
              </p>
              <code className="ra-code" aria-label="Lien de connexion">
                {link}
              </code>
              <div className="ra-actions">
                <button
                  className="btn sm"
                  onClick={() => void copyText(link).then((ok) => setCopied(ok ? "ok" : "failed"))}
                >
                  Copier le lien
                </button>
                <span className="set-note" role="status">
                  {copied === "ok"
                    ? "Lien copié."
                    : copied === "failed"
                      ? "Copie impossible ici : sélectionne le lien à la main."
                      : ""}
                </span>
              </div>
            </div>
            <QrCode text={link} />
          </div>
        )}
        {advice && (
          <div className="set-row">
            <div className="set-tx">
              <b>{address ? "Aller plus loin" : "Pour l'activer"}</b>
              <p>{advice.text}</p>
              {advice.command && <code className="ra-code">{advice.command}</code>}
            </div>
          </div>
        )}
      </div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-tx">
            <b>Renouveler le jeton</b>
            <p>
              À faire si le lien a pu fuiter. L'ancien lien cesse de marcher tout de suite : cet
              appareil reste connecté, les autres devront ouvrir le nouveau lien.
            </p>
          </div>
          <div className="set-ctl">
            <button
              className="btn sm"
              onClick={() =>
                setConfirm({
                  title: "Renouveler le jeton ?",
                  text: "Tous les autres appareils seront déconnectés et devront ouvrir le nouveau lien. Le lien affiché au démarrage du serveur change aussi.",
                  action: "Renouveler",
                  run: async () => setToken(await connection.renewToken()),
                })
              }
            >
              Renouveler
            </button>
          </div>
        </div>
      </div>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
