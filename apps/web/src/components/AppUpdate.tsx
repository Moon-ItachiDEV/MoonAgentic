// MoonAgentic's own updates, drawn from the reference mockup (ade/maquette, « Mise à jour »):
// a pill at the foot of the side bar, a 360 px card beside it (a sheet on a phone), the steps
// of an install on every screen, and the rows of Réglages › Général.
import type { AppInfo } from "@moonagentic/protocol";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  closeUpdateCard,
  formatSize,
  installSteps,
  openUpdateCard,
  PULL_COMMAND,
  readUpdateCard,
  subscribeUpdateCard,
  updateShown,
  workingLine,
} from "../app-update.ts";
import { connection } from "../connection.ts";
import { seenAgo } from "../remote.ts";
import { expectNewBuild } from "../update.ts";
import { IconBranch, IconExternal, IconOkCircle, IconRefresh } from "./icons.tsx";
import { MoonMark } from "./MoonMark.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

const useApp = () => useSyncExternalStore(connection.subscribe, connection.getState);

/** What the install has done and does now. */
function Steps(props: { app: AppInfo; connected: boolean }) {
  return (
    <ol className="tl2">
      {installSteps(props.app.update, props.connected).map((s) => (
        <li
          key={s.key}
          className={`t2 t2-${s.state === "done" ? "done" : s.state === "now" ? "now" : "next"}`}
        >
          <span className={`t2-m${s.state === "done" ? " ok" : ""}`}>
            {s.state === "done" ? (
              <IconOkCircle size={18} />
            ) : s.state === "now" ? (
              <i className="t2-spin" />
            ) : (
              <i className="t2-ring" />
            )}
          </span>
          <span className="t2-l">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Notes(props: { app: AppInfo }) {
  const notes = props.app.update.notes ?? [];
  if (!notes.length) return null;
  return (
    <>
      <div className="apu-sub">Nouveautés</div>
      <ul className="apu-list">
        {notes.map((n, i) => (
          <li key={i}>
            <span>{n.title}</span>
            {n.number !== undefined && <span className="apu-m">#{n.number}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Badge(props: { app: AppInfo }) {
  const { app } = props;
  const u = app.update;
  if (app.kind === "git") {
    return (
      <div className="prc-id">
        <span className="prc-n">
          <IconBranch size={14} />
          main
        </span>
        <span className="prc-br">
          {u.behind ?? 0} commit{(u.behind ?? 0) > 1 ? "s" : ""} de plus
        </span>
      </div>
    );
  }
  return (
    <div className="prc-id">
      <span className="prc-n">
        <MoonMark width={14} height={14} />
        MoonAgentic {u.version}
      </span>
      <span className="prc-br">
        {app.version} → {u.version}
      </span>
    </div>
  );
}

function Copy(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(props.text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      {done ? "Copié" : "Copier"}
    </button>
  );
}

/** What the card says and offers, for where the update stands. */
function CardBody(props: { app: AppInfo; running: number; connected: boolean }) {
  const { app, running } = props;
  const u = app.update;
  const send = (message: Parameters<typeof connection.send>[0]) => connection.send(message);
  if (u.phase) {
    return (
      <>
        <Badge app={app} />
        <h3>Installation en cours</h3>
        <Steps app={app} connected={props.connected} />
      </>
    );
  }
  if (u.install) {
    const n = u.working ?? 0;
    return (
      <>
        <Badge app={app} />
        <h3>S'installe dès que rien ne tourne</h3>
        {n > 0 && (
          <div className="apu-run">
            <StateGlyph kind="travaille" size={16} />
            <span>{workingLine(n)}</span>
          </div>
        )}
        <div className="prc-acts apu-acts">
          <button className="btn" onClick={() => send({ type: "app.install", when: "now" })}>
            Installer maintenant
          </button>
          <button className="btn quiet" onClick={() => send({ type: "app.cancel" })}>
            Annuler l'attente
          </button>
        </div>
      </>
    );
  }
  if (u.state === "downloading") {
    return (
      <>
        <Badge app={app} />
        <h3>Téléchargement en arrière-plan</h3>
        <div
          className="apu-bar"
          role="progressbar"
          aria-valuenow={Math.round((u.progress ?? 0) * 100)}
        >
          <i style={{ width: `${Math.round((u.progress ?? 0) * 100)}%` }} />
        </div>
        <p className="apu-note">
          {Math.round((u.progress ?? 0) * 100)} %{u.size ? ` de ${formatSize(u.size)}` : ""}. Rien
          ne s'installe sans ton accord.
        </p>
        <Notes app={app} />
      </>
    );
  }
  if (u.state === "failed") {
    return (
      <>
        <Badge app={app} />
        <h3>La version {u.version} n'a pas pu être téléchargée</h3>
        {u.error && (
          <div className="apu-tags">
            <span className="tag err">{u.error}</span>
          </div>
        )}
        {app.checks && <p className="apu-note">Nouvel essai tout seul dans 6 h.</p>}
        <div className="prc-acts apu-acts">
          <button className="btn acc" onClick={() => send({ type: "app.check" })}>
            <IconRefresh size={15} />
            Réessayer
          </button>
        </div>
      </>
    );
  }
  if (app.kind === "git") {
    return (
      <>
        <Badge app={app} />
        <h3>Nouvelle version sur main</h3>
        <Notes app={app} />
        <p className="apu-note apu-lead">Arrête l'app avec Ctrl C, puis lance :</p>
        <div className="apu-cmd">
          <code>{PULL_COMMAND}</code>
          <Copy text={PULL_COMMAND} />
        </div>
      </>
    );
  }
  if (app.kind === "mac") {
    return (
      <>
        <Badge app={app} />
        <h3>MoonAgentic {u.version} est sortie</h3>
        <p className="apu-note apu-lead">
          Sur Mac, une app non signée ne peut pas se remplacer seule. Télécharge le fichier et
          remplace l'app.
        </p>
        <Notes app={app} />
        {u.url && (
          <div className="prc-acts apu-acts">
            <a className="btn pri" href={u.url} target="_blank" rel="noopener noreferrer">
              Télécharger le .dmg
              <IconExternal size={13} />
            </a>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Badge app={app} />
      <h3>Mise à jour prête</h3>
      <div className="apu-tags">
        <span className="tag ok">Téléchargée</span>
        {u.size !== undefined && <span className="tag">{formatSize(u.size)}</span>}
        <span className="tag">Windows</span>
      </div>
      <Notes app={app} />
      {running > 0 && (
        <div className="apu-run">
          <StateGlyph kind="travaille" size={16} />
          <span>{workingLine(running)} · installation après eux</span>
        </div>
      )}
      <div className="prc-acts apu-acts">
        <button className="btn pri" onClick={() => send({ type: "app.install", when: "idle" })}>
          Installer quand rien ne tourne
        </button>
        <button className="btn" onClick={() => send({ type: "app.install", when: "now" })}>
          Installer maintenant
        </button>
      </div>
      {running > 0 && (
        <p className="apu-note">
          « Maintenant » coupe {running > 1 ? `les ${running} fils` : "le fil"} au travail. Tu
          pourras {running > 1 ? "les" : "le"} reprendre après le redémarrage.
        </p>
      )}
    </>
  );
}

/** The card beside the side bar, a sheet on a phone. */
function UpdateCard(props: { app: AppInfo; at: { top?: number; left?: number } }) {
  const state = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(props.at.top);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Element;
      if (ref.current?.contains(target) || target.closest(".apu-pill, .apu-ov")) return;
      closeUpdateCard();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && closeUpdateCard();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  // Its foot level with the pill's, kept inside the window.
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || props.at.top === undefined) return;
    setTop(Math.max(16, Math.min(props.at.top - box.height, window.innerHeight - 16 - box.height)));
  }, [props.at.top, props.app]);
  const running = state.threads.filter((t) => t.status === "running").length;
  const style = {
    ...(top !== undefined ? { "--top": `${top}px` } : { "--top": "80px" }),
    ...(props.at.left !== undefined ? { "--left": `${props.at.left}px` } : {}),
  } as React.CSSProperties;
  return (
    <div
      ref={ref}
      className="prc apu-card"
      role="dialog"
      aria-label="Mise à jour de MoonAgentic"
      style={style}
    >
      <CardBody app={props.app} running={running} connected={state.status === "open"} />
    </div>
  );
}

/** Seen installing on this screen: once the server is back, the new build is loaded. */
let sawInstalling = false;

/**
 * Mounted once: the card when opened, and the steps of an install over every screen, from
 * the copy of the database until the app is back.
 */
export function AppUpdateHost() {
  const state = useApp();
  const at = useSyncExternalStore(subscribeUpdateCard, readUpdateCard);
  const app = state.app;
  const connected = state.status === "open";
  const installing = !!app?.update.phase;
  if (app?.update.phase === "installing") sawInstalling = true;
  const back = connected && !installing && sawInstalling;
  useEffect(() => {
    if (!back) return;
    sawInstalling = false;
    // The server answers again: the page loads the version it now serves.
    expectNewBuild();
  }, [back]);
  const overlay = app && (installing || (sawInstalling && !connected));
  let card: ReactNode = null;
  if (overlay) {
    card = (
      <>
        <div className="scrim apu-scrim" />
        <div className="apu-inst" role="status" aria-live="polite">
          <div className="apu-ih">
            <MoonMark width={28} height={28} />
            <div>
              <h2>Installation de MoonAgentic {app.update.version}</h2>
              {app.update.install && (
                <small>
                  Demandée {app.update.install.by} · {seenAgo(app.update.install.at, Date.now())}
                </small>
              )}
            </div>
          </div>
          <Steps app={app} connected={connected} />
          <p className="apu-note">
            Les fenêtres et les appareils jumelés se reconnectent tout seuls.
          </p>
        </div>
      </>
    );
  } else if (at && updateShown(app)) {
    card = <UpdateCard app={app} at={at} />;
  }
  return card ? createPortal(card, document.body) : null;
}

/** Réglages › Général: the version, a look by hand, and how the app runs on this computer. */
export function AppUpdateSettings(props: {
  row: (props: { title: string; text?: ReactNode; children?: ReactNode }) => ReactNode;
  toggle: (props: { label: string; on: boolean; onChange: (on: boolean) => void }) => ReactNode;
}) {
  const { app } = useApp();
  if (!app) return null;
  const Row = props.row;
  const Toggle = props.toggle;
  const u = app.update;
  const set = (patch: {
    checks?: boolean;
    notify?: boolean;
    openAtLogin?: boolean;
    preventSleep?: boolean;
  }) => connection.send({ type: "app.settings", ...patch });
  const where =
    app.kind === "windows"
      ? "App de bureau Windows"
      : app.kind === "mac"
        ? "App de bureau Mac"
        : app.kind === "git"
          ? "Clone lancé avec pnpm start"
          : "Lancée pour le développement : elle ne se met pas à jour d'ici";
  const checked = u.checkedAt ? ` · vérifiée ${seenAgo(u.checkedAt, Date.now())}` : "";
  return (
    <>
      <h3 className="lk-h">Mise à jour</h3>
      <div className="set-card">
        <Row
          title={app.kind === "git" ? `Version ${app.version}` : `Version ${app.version}`}
          text={`${where}${app.kind === "other" ? "" : checked}`}
        >
          {app.kind !== "other" && (
            <button
              className="btn sm"
              disabled={u.state === "checking" || !!u.phase}
              onClick={() => connection.send({ type: "app.check" })}
            >
              <IconRefresh size={14} />
              {u.state === "checking" ? "Recherche…" : "Vérifier maintenant"}
            </button>
          )}
        </Row>
        {updateShown(app) && (
          <Row
            title={app.kind === "git" ? "Nouvelle version sur main" : `MoonAgentic ${u.version}`}
            text={
              u.state === "failed"
                ? (u.error ?? "Le téléchargement a échoué.")
                : app.kind === "windows"
                  ? "Téléchargée en arrière-plan · s'installe seulement quand tu le demandes"
                  : app.kind === "mac"
                    ? "À télécharger et installer à la main"
                    : `${u.behind ?? 0} commit${(u.behind ?? 0) > 1 ? "s" : ""} à récupérer`
            }
          >
            <button className="btn sm pri" onClick={() => openUpdateCard()}>
              {app.kind === "windows" && u.state === "ready" && !u.install ? "Installer…" : "Voir"}
            </button>
          </Row>
        )}
        {app.kind !== "other" && (
          <>
            <Row
              title="Chercher les nouvelles versions"
              text={
                app.kind === "git"
                  ? "Au démarrage puis toutes les 6 h, sur la branche main du dépôt"
                  : "Au démarrage puis toutes les 6 h, dans les versions publiées du dépôt"
              }
            >
              <Toggle
                label="Chercher les nouvelles versions"
                on={app.checks}
                onChange={(on) => set({ checks: on })}
              />
            </Row>
            <Row
              title="Prévenir sur mes appareils"
              text="Une notification quand une version est prête, là où les notifications sont activées"
            >
              <Toggle
                label="Prévenir sur mes appareils"
                on={app.notify}
                onChange={(on) => set({ notify: on })}
              />
            </Row>
          </>
        )}
      </div>
      {(app.openAtLogin !== undefined || app.preventSleep !== undefined) && (
        <>
          <h3 className="lk-h">Démarrage</h3>
          <div className="set-card">
            {app.openAtLogin !== undefined && (
              <Row
                title={app.kind === "mac" ? "Ouvrir à la connexion" : "Lancer avec Windows"}
                text="MoonAgentic démarre à l'ouverture de la session, fenêtre cachée"
              >
                <Toggle
                  label="Lancer à l'ouverture de la session"
                  on={app.openAtLogin}
                  onChange={(on) => set({ openAtLogin: on })}
                />
              </Row>
            )}
            {app.preventSleep !== undefined && (
              <Row
                title="Empêcher la veille"
                text="Tant que l'app tourne, l'ordinateur reste joignable"
              >
                <Toggle
                  label="Empêcher la veille"
                  on={app.preventSleep}
                  onChange={(on) => set({ preventSleep: on })}
                />
              </Row>
            )}
          </div>
        </>
      )}
    </>
  );
}
