import type { HermesAllow, HermesNotify, HermesStatus, ModelChoice } from "@moonagentic/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { HERMES_AVATAR, useHermesState } from "../hermes.ts";
import { modelLabel } from "../model-label.ts";
import { seenAgo } from "../remote.ts";
import { I } from "../v2/I.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { copyText } from "./RemoteAccess.tsx";

const ALLOW: [keyof HermesAllow, string, string?][] = [
  ["coordinators", "Écrire aux coordinateurs"],
  ["threads", "Écrire dans un fil"],
  ["plan", "Planifier", "Planner et tâches planifiées"],
  ["requests", "Répondre aux demandes des agents"],
];
const NOTIFY: [keyof HermesNotify, string][] = [
  ["done", "Fil terminé"],
  ["waiting", "Fil qui t'attend"],
  ["prReady", "PR prête à fusionner"],
];

/** A line of the page: what it is, a word on its state, then its control. */
function Row(props: { title: string; text?: string | undefined; children?: React.ReactNode }) {
  return (
    <div className="it ro">
      <span className="tx">
        {props.title}
        {props.text && <small>{props.text}</small>}
      </span>
      {props.children}
    </div>
  );
}

function Toggle(props: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      className="tog"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/**
 * Réglages › Hermes · Discord: Hermes's access to this MoonAgentic, what it may do, and what
 * MoonAgentic tells the Discord channel by itself. Everything shown is what the server says.
 */
export function HermesSettings({ hermes }: { hermes: HermesStatus | null }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useHermesState();
  const agent = useSyncExternalStore(connection.subscribe, () =>
    connection.getState().agents.find((a) => a.id === "hermes"),
  );
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /** Runs `work`, showing its error; true when it went through. */
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const set = (change: {
    allow?: Partial<HermesAllow>;
    notify?: Partial<HermesNotify>;
    webhook?: string | null;
  }) => run(() => connection.request({ type: "hermes.set", requestId: newId(), ...change }));

  if (!hermes) return <div className="ins" aria-busy="true" />;

  const copy = async () => {
    const ok = await copyText(hermes.config);
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <>
      <div className="ins">
        <div className="it ro">
          <img className="hav" src={HERMES_AVATAR} alt="" width={32} height={32} />
          <span className="tx">
            Hermes
            <small>
              {!hermes.connected
                ? "Non connecté"
                : hermes.lastSeen
                  ? `Dernier appel ${seenAgo(hermes.lastSeen, now)}`
                  : "Pas encore appelé"}
            </small>
          </span>
          {hermes.connected ? (
            <span className="rt">
              <span className="dvon">Connecté</span>
            </span>
          ) : (
            <button
              className="b2 ink press"
              disabled={busy}
              onClick={() =>
                void run(() => connection.request({ type: "hermes.connect", requestId: newId() }))
              }
            >
              Connecter
            </button>
          )}
        </div>
        {hermes.connected && hermes.setup && (
          <Row title="Réglage de Hermes" text={setupText(hermes)}>
            <button
              className="b2 soft press"
              disabled={busy || hermes.setup?.state === "running"}
              onClick={() =>
                void run(() => connection.request({ type: "hermes.install", requestId: newId() }))
              }
            >
              {hermes.setup?.state === "failed" ? "Réessayer" : "Réappliquer"}
            </button>
          </Row>
        )}
        {hermes.connected && (!hermes.setup || hermes.setup.state === "failed") && (
          <Row title="Réglage à la main" text="config.yaml › mcp_servers">
            <button className="b2 soft press" onClick={() => void copy()}>
              {copied === "ok" ? "Copié" : copied === "failed" ? "Échec" : "Copier"}
            </button>
          </Row>
        )}
      </div>
      {error && <p className="erx">{error}</p>}

      <div className="gl2">Modèle</div>
      <div className="ins">
        <Row
          title={currentName(hermes, agent?.models)}
          text={hermes.model ? hermes.model.provider : hermes.modelError}
        >
          {agent?.models?.length ? (
            <button
              className="b2 soft press"
              aria-expanded={picking}
              disabled={busy || hermes.setup?.state === "running"}
              onClick={() => setPicking((p) => !p)}
            >
              {picking ? "Fermer" : "Changer"}
            </button>
          ) : (
            <button
              className="b2 soft press"
              disabled={!agent?.available}
              onClick={() => void connection.send({ type: "agent.discover", agentId: "hermes" })}
            >
              Lire ses modèles
            </button>
          )}
        </Row>
        {picking &&
          agent?.models?.map((m) => {
            const on = isCurrent(hermes, m.id);
            return (
              <button
                key={m.id}
                className="it ro"
                aria-pressed={on}
                disabled={busy || on}
                onClick={() =>
                  void run(() =>
                    connection.request({
                      type: "hermes.setModel",
                      requestId: newId(),
                      model: m.id,
                    }),
                  ).then((ok) => ok && setPicking(false))
                }
              >
                <span className="tx">{modelLabel(m)}</span>
                {on && <I n="check" s={20} className="ck" />}
              </button>
            );
          })}
      </div>

      <div className="gl2">Hermes peut</div>
      <div className="ins">
        {ALLOW.map(([key, label, text]) => (
          <Row key={key} title={label} text={text}>
            <Toggle
              label={label}
              on={hermes.allow[key]}
              disabled={busy}
              onChange={(on) => void set({ allow: { [key]: on } })}
            />
          </Row>
        ))}
      </div>

      <div className="gl2">Prévenir sur Discord</div>
      <div className="ins">
        {hermes.webhook ? (
          <Row title="Webhook du salon" text={tested ? "Message de test envoyé" : undefined}>
            <span className="rt">
              <button
                className="b2 soft press"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await connection.request({ type: "hermes.test", requestId: newId() });
                    setTested(true);
                  })
                }
              >
                Tester
              </button>
              <button
                className="b2 soft press"
                disabled={busy}
                onClick={() => void set({ webhook: null }).then((ok) => ok && setTested(false))}
              >
                Retirer
              </button>
            </span>
          </Row>
        ) : (
          <label className="it ro npf">
            <input
              className="mono"
              aria-label="Adresse du webhook Discord"
              placeholder="https://discord.com/api/webhooks/…"
              autoComplete="off"
              spellCheck={false}
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
            />
            <button
              className="b2 ink press"
              disabled={busy || !webhook.trim()}
              onClick={() =>
                void set({ webhook: webhook.trim() }).then((ok) => {
                  // A refused address stays in the field, to be corrected.
                  if (ok) {
                    setWebhook("");
                    setTested(false);
                  }
                })
              }
            >
              Enregistrer
            </button>
          </label>
        )}
        {NOTIFY.map(([key, label]) => (
          <Row key={key} title={label}>
            <Toggle
              label={label}
              on={hermes.notify[key]}
              disabled={busy || !hermes.webhook}
              onChange={(on) => void set({ notify: { [key]: on } })}
            />
          </Row>
        ))}
      </div>

      {hermes.log.length > 0 && (
        <>
          <div className="gl2">Dernières actions</div>
          <div className="ins">
            {hermes.log.slice(0, 8).map((a) => (
              <Row key={`${a.at}-${a.what}`} title={a.what} text={a.project}>
                <span className="rt">{seenAgo(a.at, now)}</span>
              </Row>
            ))}
          </div>
        </>
      )}

      {hermes.connected && (
        <div className="ins" style={{ marginTop: 22 }}>
          <button
            className="it red"
            onClick={() =>
              setConfirm({
                title: "Couper l'accès de Hermes ?",
                text: "Rétablissable ici",
                action: "Couper",
                run: async () =>
                  void (await connection.request({ type: "hermes.cut", requestId: newId() })),
              })
            }
          >
            <span className="ic" style={{ color: "var(--err-tx)" }}>
              <I n="x" s={17} />
            </span>
            <span className="tx">Couper l'accès</span>
          </button>
        </div>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

/** Where MoonAgentic is with Hermes's own setup, as the server says. */
function setupText(hermes: HermesStatus): string | undefined {
  const setup = hermes.setup;
  if (!setup) return undefined;
  if (setup.state === "running") return "Réglage et relance de Hermes en cours";
  if (setup.state === "failed") return setup.error ?? "Échec";
  return setup.what === "model"
    ? "Modèle changé · Hermes relancé"
    : "config.yaml écrit · Hermes relancé";
}

const choiceOf = (hermes: HermesStatus) =>
  hermes.model
    ? hermes.model.provider
      ? `${hermes.model.provider.toLowerCase()}:${hermes.model.model}`
      : hermes.model.model
    : undefined;

function isCurrent(hermes: HermesStatus, id: string): boolean {
  const current = choiceOf(hermes);
  if (!current || !hermes.model) return false;
  return id === current || (!hermes.model.provider && id.endsWith(`:${hermes.model.model}`));
}

/** The default model's name as Hermes lists it, else as its config says. */
function currentName(hermes: HermesStatus, models: ModelChoice[] | undefined): string {
  if (!hermes.model) return "Modèle par défaut";
  const listed = models?.find((m) => isCurrent(hermes, m.id));
  return listed ? modelLabel(listed) : hermes.model.model;
}
