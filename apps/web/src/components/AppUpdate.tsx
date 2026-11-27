// MoonAgentic's own updates, as the mockup draws them: a bar above the home page's composer
// (UpdateBar.tsx), the sheet where an install is chosen, the steps of an install over every
// screen, and the rows of Réglages › Général.
import type { AppInfo } from "@moonagentic/protocol";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import {
  closeUpdateCard,
  formatSize,
  type InstallWatch,
  installSteps,
  lookFailure,
  openUpdateCard,
  PULL_COMMAND,
  readUpdateCard,
  subscribeUpdateCard,
  updateShown,
  watchInstall,
  workingLine,
} from "../app-update.ts";
import { connection } from "../connection.ts";
import { seenAgo } from "../remote.ts";
import { expectNewBuild } from "../update.ts";
import { Glyph, I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";

export function useApp() {
  const app = useSyncExternalStore(connection.subscribe, () => connection.getState().app);
  const status = useSyncExternalStore(connection.subscribe, () => connection.getState().status);
  return { app, status };
}

/** What the install has done and does now. */
function Steps(props: { app: AppInfo; connected: boolean }) {
  return (
    <div className="plan" role="list">
      {installSteps(props.app.update, props.connected).map((s) => (
        <div
          key={s.key}
          role="listitem"
          className={`stp ${s.state === "done" ? "d" : s.state === "now" ? "c" : "p"}`}
        >
          <i>
            {s.state === "done" ? (
              <I n="okc" s={18} />
            ) : s.state === "now" ? (
              <b className="sp" />
            ) : (
              <b className="ring" />
            )}
          </i>
          <span>{s.label}</span>
          <span />
        </div>
      ))}
    </div>
  );
}

function Notes(props: { app: AppInfo }) {
  const notes = props.app.update.notes ?? [];
  if (!notes.length) return null;
  return (
    <>
      <div className="gl2">Nouveautés</div>
      <div className="ins">
        {notes.map((n, i) => (
          <div key={i} className="it ro">
            <span className="tx">{n.title}</span>
            {n.number !== undefined && (
              <span className="rt">
                <span className="mono">#{n.number}</span>
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Copy(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="b2 soft press"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(props.text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      <I n={done ? "check" : "copies"} s={16} />
      {done ? "Copié" : "Copier"}
    </button>
  );
}

/** The sheet's title, for where the update stands. */
function titleOf(app: AppInfo): string {
  const u = app.update;
  if (app.kind === "git") return "Nouvelle version sur main";
  return `Version ${u.version ?? ""}`.trim();
}

/** What the sheet says and offers, for where the update stands. */
function Body(props: { app: AppInfo; running: number; connected: boolean }) {
  const { app, running } = props;
  const u = app.update;
  const [when, setWhen] = useState<"idle" | "now">("idle");
  const send = (message: Parameters<typeof connection.send>[0]) => connection.send(message);
  if (u.phase) return <Steps app={app} connected={props.connected} />;
  if (u.install) {
    const n = u.working ?? 0;
    return (
      <>
        <div className="gl2">
          S'installe dès que rien ne tourne
          {n > 0 && (
            <>
              <span className="sp" />
              <span className="ppill">
                <Glyph />
                {workingLine(n)}
              </span>
            </>
          )}
        </div>
        <div className="rva">
          <button className="b2 soft press" onClick={() => send({ type: "app.cancel" })}>
            Annuler l'attente
          </button>
          <button
            className="b2 ink press"
            onClick={() => send({ type: "app.install", when: "now" })}
          >
            Installer maintenant
          </button>
        </div>
      </>
    );
  }
  if (u.state === "downloading") {
    const percent = Math.round((u.progress ?? 0) * 100);
    return (
      <>
        <div className="ins qcard">
          <div className="qrow ok">
            <div className="qh">
              <span className="l">Téléchargement</span>
              <span className="p">
                {percent} %{u.size ? ` de ${formatSize(u.size)}` : ""}
              </span>
            </div>
            <div className="qb" role="progressbar" aria-valuenow={percent}>
              <i style={{ width: `${percent}%` }} />
            </div>
          </div>
        </div>
        <Notes app={app} />
      </>
    );
  }
  if (u.state === "failed") {
    return (
      <>
        {u.error && <p className="pcw t-err">{u.error}</p>}
        <div className="mga">
          <button className="b2 ink press" onClick={() => send({ type: "app.check" })}>
            <I n="refresh" s={17} />
            Réessayer
          </button>
        </div>
      </>
    );
  }
  if (app.kind === "git") {
    return (
      <>
        <Notes app={app} />
        <div className="gl2">Après Ctrl C dans le terminal</div>
        <div className="ins">
          <div className="it ro apcmd">
            <code className="mono">{PULL_COMMAND}</code>
          </div>
        </div>
        <div className="mga">
          <Copy text={PULL_COMMAND} />
        </div>
      </>
    );
  }
  if (app.kind === "mac") {
    return (
      <>
        <Notes app={app} />
        {u.url && (
          <div className="mga">
            <a className="b2 ink press" href={u.url} target="_blank" rel="noopener noreferrer">
              <I n="ext" s={16} />
              Télécharger le .dmg
            </a>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Notes app={app} />
      <div className="gl2">
        Installer
        {u.size !== undefined && <small> · {formatSize(u.size)}</small>}
        {running > 0 && (
          <>
            <span className="sp" />
            <span className="ppill">
              <Glyph />
              {workingLine(running)}
            </span>
          </>
        )}
      </div>
      <div className="seg" role="group" aria-label="Quand installer">
        <button aria-pressed={when === "idle"} onClick={() => setWhen("idle")}>
          Quand rien ne tourne
        </button>
        <button aria-pressed={when === "now"} onClick={() => setWhen("now")}>
          Maintenant
        </button>
      </div>
      <div className="mga apgo">
        <button
          className="b2 ink press"
          onClick={() => {
            send({ type: "app.install", when });
            closeUpdateCard();
          }}
        >
          Installer
        </button>
      </div>
    </>
  );
}

/** What this screen saw of an install, kept while the host is drawn again. */
let watch: InstallWatch = { saw: false, lost: false };

/**
 * Mounted once: the sheet when opened, and the steps of an install over every screen, from
 * the copy of the database until the app is back.
 */
export function AppUpdateHost() {
  const { app, status } = useApp();
  const threads = useSyncExternalStore(connection.subscribe, () => connection.getState().threads);
  const at = useSyncExternalStore(subscribeUpdateCard, readUpdateCard);
  const connected = status === "open";
  const installing = !!app?.update.phase;
  const phase = app?.update.phase;
  // Read during the drawing, kept after it: a drawing React throws away changes nothing.
  const waitingBack = watchInstall(watch, phase, connected).watch.saw && !connected;
  useEffect(() => {
    const next = watchInstall(watch, phase, connected);
    watch = next.watch;
    // The server answers again: the page loads the version it now serves.
    if (next.reload) expectNewBuild();
  }, [phase, connected]);
  const overlay = !!app && (installing || waitingBack);
  const shown = updateShown(app);
  const running = threads.filter((t) => t.status === "running").length;
  if (!app) return null;
  return (
    <>
      <Sheet open={!!at && shown && !overlay} onClose={closeUpdateCard} title={titleOf(app)}>
        <div className="sbody">
          <Body app={app} running={running} connected={connected} />
        </div>
      </Sheet>
      {/* The install itself is not left: it shows on every screen until the app is back. */}
      <Sheet
        open={overlay}
        onClose={() => undefined}
        label={`Installation de MoonAgentic ${app.update.version ?? ""}`}
        modal
      >
        <div className="cfw apins" role="status" aria-live="polite">
          <div className="grab" />
          <h3>Installation de MoonAgentic {app.update.version}</h3>
          {app.update.install && (
            <span className="ppill">
              Demandée {app.update.install.by} · {seenAgo(app.update.install.at, Date.now())}
            </span>
          )}
          <Steps app={app} connected={connected} />
        </div>
      </Sheet>
    </>
  );
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
  const failure = lookFailure(app);
  const checked = u.checkedAt ? ` · vérifiée ${seenAgo(u.checkedAt, Date.now())}` : "";
  return (
    <>
      <div className="gl2">Mises à jour</div>
      <div className="ins">
        <Row title="Version" text={failure ?? (app.kind === "other" ? where : undefined)}>
          <span className="rt">
            {app.kind !== "other" && u.state !== "checking" && !updateShown(app) && !failure && (
              <span className="okp">À jour</span>
            )}
            <span className="mono">{app.version}</span>
          </span>
          {app.kind !== "other" && (
            <button
              className="mini press"
              disabled={u.state === "checking" || !!u.phase}
              title={`${where}${checked}`}
              onClick={() => connection.send({ type: "app.check" })}
            >
              {u.state === "checking" ? "Recherche…" : "Vérifier"}
            </button>
          )}
        </Row>
        {updateShown(app) && (
          <Row
            title={app.kind === "git" ? "Nouvelle version sur main" : `MoonAgentic ${u.version}`}
            text={
              u.state === "failed"
                ? (u.error ?? "Le téléchargement a échoué")
                : app.kind === "git"
                  ? `${u.behind ?? 0} commit${(u.behind ?? 0) > 1 ? "s" : ""} à récupérer`
                  : undefined
            }
          >
            <button className="mini press" onClick={() => openUpdateCard()}>
              {app.kind === "windows" && u.state === "ready" && !u.install ? "Installer…" : "Voir"}
            </button>
          </Row>
        )}
        {app.kind !== "other" && (
          <>
            <Row title="Chercher les nouvelles versions">
              <Toggle
                label="Chercher les nouvelles versions"
                on={app.checks}
                onChange={(on) => set({ checks: on })}
              />
            </Row>
            <Row title="Prévenir sur mes appareils">
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
          <div className="gl2">Démarrage</div>
          <div className="ins">
            {app.openAtLogin !== undefined && (
              <Row title={app.kind === "mac" ? "Ouvrir à la connexion" : "Lancer avec Windows"}>
                <Toggle
                  label="Lancer à l'ouverture de la session"
                  on={app.openAtLogin}
                  onChange={(on) => set({ openAtLogin: on })}
                />
              </Row>
            )}
            {app.preventSleep !== undefined && (
              <Row title="Empêcher la veille">
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
