import type { RemoteAccess as Access, PairedDevice } from "@moonagentic/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import { connection } from "../connection.ts";
import { addressText, pairLink, remoteAdvice, seenAgo, shownCode } from "../remote.ts";
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
      aria-label="QR code d'appairage"
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
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // The paired devices; `null` on a paired device, which cannot see or change them.
  const [devices, setDevices] = useState<PairedDevice[] | null | undefined>(undefined);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    connection.devices().then(setDevices, (e: unknown) => {
      setDevices([]);
      setPairError(e instanceof Error ? e.message : String(e));
    });
  }, []);
  // While a code is shown: the time left moves on, and the list is asked again, so the new
  // device shows up as soon as it pairs.
  const known = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= pairing.expiresAt) return setPairing(null);
      connection.devices().then(
        (list) => {
          if (!list) return;
          setDevices(list);
          const added = list.find((d) => !known.current.has(d.id));
          if (added) {
            setJustPaired(added.name);
            setPairing(null);
          }
        },
        () => undefined,
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [pairing]);
  const startPairing = () => {
    setPairError(null);
    setJustPaired(null);
    known.current = new Set((devices ?? []).map((d) => d.id));
    connection.startPairing().then(
      (started) => {
        setNow(Date.now());
        setPairing(started);
      },
      (e: unknown) => setPairError(e instanceof Error ? e.message : String(e)),
    );
  };
  const owner = devices !== null && devices !== undefined;

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
  const link = address && pairing ? pairLink(address, pairing.code) : null;
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
        {owner && address && (
          <div className="set-row top ra-link">
            <div className="set-tx">
              <b>Appairer un appareil</b>
              {pairing && link ? (
                <>
                  <p>
                    Scanne le QR code avec le téléphone, ou ouvre <code>{address.url}</code> dessus
                    et tape ce code. Il ne sert qu'une fois, jusqu'à{" "}
                    {new Date(pairing.expiresAt).toLocaleTimeString("fr-FR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    ({Math.max(0, Math.ceil((pairing.expiresAt - now) / 60_000))} min).
                  </p>
                  <code className="ra-pair-code" aria-label="Code d'appairage">
                    {shownCode(pairing.code)}
                  </code>
                  <div className="ra-actions">
                    <button
                      className="btn sm"
                      onClick={() =>
                        void copyText(link).then((ok) => setCopied(ok ? "ok" : "failed"))
                      }
                    >
                      Copier le lien
                    </button>
                    <button className="btn sm quiet" onClick={() => setPairing(null)}>
                      Masquer
                    </button>
                    <span className="set-note" role="status">
                      {copied === "ok"
                        ? "Lien copié."
                        : copied === "failed"
                          ? "Copie impossible ici : sélectionne le code à la main."
                          : ""}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    {justPaired ? `« ${justPaired} » est appairé. ` : ""}
                    Chaque appareil reçoit son propre accès, que tu peux révoquer ici. Le code
                    affiché ne sert qu'une fois, pendant 5 minutes.
                  </p>
                  <div className="ra-actions">
                    <button className="btn sm" onClick={startPairing}>
                      Appairer un appareil
                    </button>
                  </div>
                </>
              )}
              {pairError && <p className="ra-err">{pairError}</p>}
            </div>
            {link && <QrCode text={link} />}
          </div>
        )}
        {devices === null && (
          <div className="set-row">
            <div className="set-tx">
              <b>Cet appareil est appairé</b>
              <p>
                Pour appairer un autre appareil ou en révoquer un, va sur l'ordinateur où tourne
                MoonAgentic.
              </p>
            </div>
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
      {owner && (
        <div className="set-card">
          <div className="set-row top">
            <div className="set-tx">
              <b>Appareils appairés</b>
              {devices.length === 0 ? (
                <p>Aucun pour l'instant.</p>
              ) : (
                <ul className="ra-devices">
                  {devices.map((d) => (
                    <li key={d.id}>
                      <span>
                        <b>{d.name}</b>
                        <small>
                          Appairé le{" "}
                          {new Date(d.createdAt).toLocaleDateString("fr-FR", {
                            day: "numeric",
                            month: "long",
                          })}
                          {d.lastSeen ? ` · vu ${seenAgo(d.lastSeen, Date.now())}` : ""}
                        </small>
                      </span>
                      <button
                        className="btn sm quiet"
                        onClick={() =>
                          setConfirm({
                            title: `Révoquer « ${d.name} » ?`,
                            text: "Il est déconnecté tout de suite et devra être appairé à nouveau avec un nouveau code.",
                            action: "Révoquer",
                            run: async () => setDevices(await connection.revokeDevice(d.id)),
                          })
                        }
                      >
                        Révoquer
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
      {owner && (
        <div className="set-card">
          <div className="set-row">
            <div className="set-tx">
              <b>Renouveler le jeton de cet ordinateur</b>
              <p>
                À faire si le lien affiché au démarrage du serveur a pu fuiter, ou pour couper un
                appareil ouvert avec un ancien lien de connexion. Les autres fenêtres de cet
                ordinateur devront rouvrir le nouveau lien ; les appareils appairés gardent leur
                accès.
              </p>
            </div>
            <div className="set-ctl">
              <button
                className="btn sm"
                onClick={() =>
                  setConfirm({
                    title: "Renouveler le jeton ?",
                    text: "Les autres fenêtres ouvertes avec l'ancien lien seront déconnectées. Le lien affiché au démarrage du serveur change aussi.",
                    action: "Renouveler",
                    run: async () => void (await connection.renewToken()),
                  })
                }
              >
                Renouveler
              </button>
            </div>
          </div>
        </div>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
