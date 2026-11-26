import type { HermesAllow, HermesNotify, HermesStatus, ModelChoice } from "@moonagentic/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { HERMES_AVATAR, useHermesState } from "../hermes.ts";
import { modelLabel } from "../model-label.ts";
import { seenAgo } from "../remote.ts";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
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
  // The check Hermes's agent had when « Lire ses modèles » was pressed: over once it has another.
  const [asked, setAsked] = useState<number | null | undefined>(undefined);

  useHermesState();
  const agent = useSyncExternalStore(connection.subscribe, () =>
    connection.getState().agents.find((a) => a.id === "hermes"),
  );
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

  const connecting = hermes.setup?.state === "running";
  const changing = hermes.modelSetup?.state === "running";
  // One change to Hermes's setup at a time.
  const running = connecting || changing;
  const reading = asked !== undefined && asked === (agent?.check?.at ?? null);
  const discover = () => {
    if (!connection.send({ type: "agent.discover", agentId: "hermes" })) {
      connection.notify("Pas de connexion au serveur MoonAgentic.");
      return;
    }
    setAsked(agent?.check?.at ?? null);
  };
  const modelsError = agent?.modelsError ?? agent?.check?.error;
  const request = (message: Parameters<typeof connection.request>[0]) =>
    run(() => connection.request(message));
  // Hermes lists its models as « fournisseur:modèle »: grouped by provider in the sheet.
  const choices: Choice[] = (agent?.models ?? []).map((m) => ({
    value: m.id,
    label: modelLabel(m),
    ...(m.id.includes(":") ? { group: m.id.slice(0, m.id.lastIndexOf(":")) } : {}),
  }));
  const current = agent?.models?.find((m) => isCurrent(hermes, m.id));

  return (
    <>
      <div className="ins">
        <div className="it ro">
          <img className="hav" src={HERMES_AVATAR} alt="" width={32} height={32} />
          <span className="tx">
            Hermes
            {hermes.connected && (
              <small>
                {hermes.lastSeen
                  ? `Dernier appel ${seenAgo(hermes.lastSeen, now)}`
                  : "Pas encore appelé"}
              </small>
            )}
          </span>
          <span className="rt">
            {hermes.connected ? <span className="dvon">Connecté</span> : "Non connecté"}
          </span>
        </div>
        {hermes.connected && hermes.gateway && (
          <Row
            title="Passerelle Discord"
            text={hermes.gateway.running ? undefined : hermes.gateway.reason}
          >
            <span className="rt">
              {hermes.gateway.running ? <span className="dvon">En marche</span> : "Arrêtée"}
            </span>
          </Row>
        )}
        {hermes.connected && hermes.setup && (
          <Row title="Réglage de Hermes" text={setupText(hermes)} />
        )}
        {!hermes.connected ? (
          <button
            className="it acc"
            disabled={busy}
            onClick={() => void request({ type: "hermes.connect", requestId: newId() })}
          >
            <span className="tx">Connecter</span>
          </button>
        ) : (
          <>
            {hermes.gateway && !hermes.gateway.running && (
              <button
                className="it acc"
                disabled={busy || running}
                onClick={() => void request({ type: "hermes.gateway", requestId: newId() })}
              >
                <span className="tx">Démarrer la passerelle</span>
              </button>
            )}
            {hermes.setup && (
              <button
                className="it acc"
                disabled={busy || running}
                onClick={() => void request({ type: "hermes.install", requestId: newId() })}
              >
                <span className="tx">
                  {connecting
                    ? "Réglage en cours…"
                    : hermes.setup.state === "failed"
                      ? "Réessayer"
                      : "Réappliquer le réglage"}
                </span>
              </button>
            )}
            {(!hermes.setup || hermes.setup.state === "failed") && (
              <button className="it acc" onClick={() => void copy()}>
                <span className="tx">
                  {copied === "ok"
                    ? "Copié"
                    : copied === "failed"
                      ? "Copie impossible"
                      : "Copier le réglage pour config.yaml"}
                </span>
              </button>
            )}
          </>
        )}
      </div>
      {error && <p className="erx">{error}</p>}

      <div className="gl2">Modèle</div>
      <div className="ins">
        {changing ? (
          <Row title="Modèle par défaut" text="Changement et relance de Hermes en cours">
            <span className="rt">{shownModel(hermes, current)}</span>
          </Row>
        ) : choices.length && !running ? (
          <ChoiceRow
            title="Modèle par défaut"
            value={current?.id ?? ""}
            shown={shownModel(hermes, current)}
            choices={choices}
            onPick={(model) => void request({ type: "hermes.setModel", requestId: newId(), model })}
          />
        ) : (
          <>
            <Row title="Modèle par défaut" text={hermes.model ? undefined : hermes.modelError}>
              <span className="rt">{shownModel(hermes, current)}</span>
            </Row>
            {!choices.length && (
              <button className="it acc" disabled={!agent?.available || reading} onClick={discover}>
                <span className="tx">
                  {reading
                    ? "Lecture des modèles…"
                    : modelsError
                      ? "Réessayer de lire ses modèles"
                      : "Lire ses modèles"}
                  {!reading && modelsError && <small className="erx">{modelsError}</small>}
                </span>
              </button>
            )}
          </>
        )}
        {hermes.modelSetup?.state === "failed" && (
          <div className="it ro">
            <span className="tx">
              Changement de modèle
              <small className="erx">{hermes.modelSetup.error ?? "Échec"}</small>
            </span>
          </div>
        )}
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
          <>
            <Row title="Webhook du salon">
              <span className="rt">{tested ? "Test envoyé" : "Réglé"}</span>
            </Row>
            <button
              className="it acc"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await connection.request({ type: "hermes.test", requestId: newId() });
                  setTested(true);
                })
              }
            >
              <span className="tx">Envoyer un message de test</span>
            </button>
          </>
        ) : (
          <>
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
            </label>
            {webhook.trim() && (
              <button
                className="it acc"
                disabled={busy}
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
                <span className="tx">Enregistrer le webhook</span>
              </button>
            )}
          </>
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

      {(hermes.connected || hermes.webhook) && (
        <div className="ins" style={{ marginTop: 22 }}>
          {hermes.webhook && (
            <button
              className="it red"
              disabled={busy}
              onClick={() => void set({ webhook: null }).then((ok) => ok && setTested(false))}
            >
              <span className="tx">Retirer le webhook</span>
            </button>
          )}
          {hermes.connected && (
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
              <span className="tx">Couper l'accès de Hermes</span>
            </button>
          )}
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
  return "config.yaml écrit · Hermes relancé";
}

const shownModel = (hermes: HermesStatus, current: ModelChoice | undefined) =>
  current ? modelLabel(current) : (hermes.model?.model ?? "Inconnu");

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
