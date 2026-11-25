import type { RemoteAccess as Access, PairedDevice } from "@moonagentic/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import { connection } from "../connection.ts";
import {
  addressText,
  installHint,
  pairLink,
  remoteAdvice,
  runsInstalled,
  seenAgo,
  shownCode,
} from "../remote.ts";
import { ChoiceRow } from "../v2/ChoiceRow.tsx";
import { Glyph, I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
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
    const code = encode(text, { ecc: "M", border: 0 });
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
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code d'appairage"
    >
      <path d={path} fill="currentColor" />
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
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Unknown until the server says: nothing of the computer's own part is shown before.
    connection
      .devices()
      .then(setDevices, (e: unknown) =>
        setDevicesError(e instanceof Error ? e.message : String(e)),
      );
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
  const install = installHint(navigator.userAgent, runsInstalled());

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

  const copy = (text: string) => void copyText(text).then((ok) => setCopied(ok ? "ok" : "failed"));
  const canShare = typeof navigator.share === "function";

  return (
    <>
      <div className="ins">
        {!access ? (
          <div className="it ro">
            <span className="tx">Adresse</span>
            <span className="rt">{error ?? "Recherche…"}</span>
          </div>
        ) : address && about ? (
          access.addresses.length > 1 ? (
            <ChoiceRow
              title="Adresse"
              label="Adresse distante"
              value={address.url}
              shown={address.url.replace(/^https?:\/\//, "")}
              choices={access.addresses.map((a) => ({
                value: a.url,
                label: `${addressText(a).label} · ${a.url.replace(/^https?:\/\//, "")}`,
              }))}
              onPick={setPicked}
            />
          ) : (
            <div className="it ro">
              <span className="tx">
                Adresse
                <small>{about.label}</small>
              </span>
              <span className="rt">
                <span className="mono">{address.url.replace(/^https?:\/\//, "")}</span>
              </span>
            </div>
          )
        ) : (
          <div className="it ro">
            <span className="tx">Adresse</span>
            <span className="rt">Aucune</span>
          </div>
        )}
        {address && about && (
          <div className="it ro">
            <span className="tx">{address.public ? "Ouvert à tout Internet" : about.label}</span>
            <span className={about.tone === "ok" ? "okp" : "rt mer"}>
              {about.tone === "ok" ? "Chiffré" : address.public ? "Funnel" : "Sans chiffrement"}
            </span>
          </div>
        )}
        {address && (
          <button className="it acc" onClick={() => copy(address.url)}>
            <span className="tx">
              {copied === "ok" && !pairing
                ? "Copié"
                : copied === "failed" && !pairing
                  ? "Copie impossible"
                  : "Copier l'adresse"}
            </span>
          </button>
        )}
        <button className="it acc" disabled={loading} onClick={load}>
          <span className="tx">{loading ? "Recherche…" : "Actualiser"}</span>
        </button>
        {access && error && (
          <div className="it ro">
            <span className="tx">
              <small className="mer">{error}</small>
            </span>
          </div>
        )}
      </div>
      {advice && (
        <>
          <div className="gl2">{address ? "Aller plus loin" : "Pour l'activer"}</div>
          <div className="ins">
            <div className="it ro">
              <span className="tx">
                <small>{advice.text}</small>
              </span>
            </div>
            {advice.command && (
              <button
                className="it"
                aria-label={`Copier la commande ${advice.command}`}
                onClick={() => copy(advice.command!)}
              >
                <span className="tx mono">{advice.command}</span>
                <I n="copies" s={16} />
              </button>
            )}
          </div>
        </>
      )}
      {devicesError && devices === undefined && (
        <div className="ins">
          <div className="it ro">
            <span className="tx">
              Appareils
              <small className="mer">{devicesError}</small>
            </span>
          </div>
        </div>
      )}
      {devices === null && (
        <div className="ins">
          <div className="it ro">
            <span className="tx">
              Cet appareil
              {install && <small>{install}</small>}
            </span>
            <span className="okp">Appairé</span>
          </div>
        </div>
      )}
      {owner && (
        <>
          <div className="gl2">Appareils appairés</div>
          <div className="ins">
            {devices.length === 0 && !address && (
              <div className="it ro">
                <span className="tx">Aucun</span>
              </div>
            )}
            {devices.map((d) => (
              <div key={d.id} className="it ro">
                <span className="tx">
                  {d.name}
                  <small>
                    {new Date(d.createdAt).toLocaleDateString("fr-FR", {
                      day: "numeric",
                      month: "long",
                    })}
                    {d.lastSeen ? ` · vu ${seenAgo(d.lastSeen, Date.now())}` : ""}
                  </small>
                </span>
                <button
                  className="mini"
                  aria-label={`Révoquer ${d.name}`}
                  onClick={() =>
                    setConfirm({
                      title: `Révoquer « ${d.name} » ?`,
                      text: "Il devra être appairé à nouveau",
                      action: "Révoquer",
                      run: async () => setDevices(await connection.revokeDevice(d.id)),
                    })
                  }
                >
                  Révoquer
                </button>
              </div>
            ))}
            {address && (
              <button className="it acc" onClick={startPairing}>
                <I n="plus" s={18} />
                <span className="tx">Appairer un appareil</span>
              </button>
            )}
            {pairError && (
              <div className="it ro">
                <span className="tx">
                  <small className="mer">{pairError}</small>
                </span>
              </div>
            )}
          </div>
          <div className="ins">
            <button
              className="it dng"
              onClick={() =>
                setConfirm({
                  title: "Renouveler le jeton ?",
                  text: "Les autres fenêtres ouvertes avec l'ancien lien sont déconnectées. Les appareils appairés gardent leur accès.",
                  action: "Renouveler",
                  run: async () => void (await connection.renewToken()),
                })
              }
            >
              <span className="tx">Renouveler le jeton de cet ordinateur</span>
            </button>
          </div>
        </>
      )}
      <Sheet
        open={!!(pairing && link) || !!justPaired}
        onClose={() => {
          setPairing(null);
          setJustPaired(null);
        }}
        title="Appairer un appareil"
      >
        <div className="sbody">
          {pairing && link ? (
            <>
              <div className="qrw">
                <div className="qrc">
                  <QrCode text={link} />
                </div>
                <code className="pcode" aria-label="Code d'appairage">
                  {shownCode(pairing.code)}
                </code>
                <span className="ppill">
                  <Glyph />
                  En attente · {Math.max(0, Math.ceil((pairing.expiresAt - now) / 60_000))} min
                </span>
              </div>
              <div className="rva">
                <button className="b2 soft press" onClick={() => copy(link)}>
                  <I n="copies" s={16} />
                  {copied === "ok"
                    ? "Copié"
                    : copied === "failed"
                      ? "Copie impossible"
                      : "Copier le lien"}
                </button>
                {canShare && (
                  <button
                    className="b2 soft press"
                    onClick={() => void navigator.share({ url: link }).catch(() => undefined)}
                  >
                    <I n="share" s={16} />
                    Partager
                  </button>
                )}
              </div>
            </>
          ) : (
            justPaired && (
              <div className="pok" role="status">
                <span className="pokc">
                  <I n="check" s={30} />
                </span>
                <b>{justPaired} appairé</b>
              </div>
            )
          )}
        </div>
      </Sheet>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
