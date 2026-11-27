// MoonAgentic's own updates, as the mockup draws them: the card a version is read and installed
// from, opened from the capsule at the top right (UpdateCapsule.tsx), the steps of an install
// over every screen, what the version brought once it is in, and the rows of Réglages › Général.
// Every movement follows what the server says: the moon fills with what is downloaded, a step
// is ticked when it is done, the moon goes dark while the app is away.
import type { AppInfo, UpdateNote } from "@moonagentic/protocol";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  cardState,
  closeUpdateCard,
  downloadPace,
  etaLabel,
  formatSize,
  type InstallMemo,
  type InstallWatch,
  installMemo,
  installSteps,
  kindName,
  loadMemo,
  lookFailure,
  memoFate,
  openUpdateCard,
  PULL_COMMAND,
  readUpdateCard,
  saveMemo,
  stopwatch,
  subscribeUpdateCard,
  updateShown,
  versionRoll,
  watchInstall,
  workingLine,
} from "../app-update.ts";
import { connection } from "../connection.ts";
import { seenAgo } from "../remote.ts";
import { expectNewBuild } from "../update.ts";
import { Glyph, I } from "../v2/I.tsx";
import { DrawnCheck, MoonPhase } from "../v2/MoonPhase.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { useScrFlag } from "../v2/scr.ts";
// The card's own sheet of styles comes with it; the capsule's is in the page's (maj.css).
import "../v2/maj-carte.css";

/** The app's own lines of the state: nothing here is drawn again for each word an agent writes. */
export function useApp() {
  const app = useSyncExternalStore(connection.subscribe, () => connection.getState().app);
  const status = useSyncExternalStore(connection.subscribe, () => connection.getState().status);
  return { app, status };
}

/** How many threads are at work: a number, the same until one starts or ends. */
const runningThreads = () =>
  connection.getState().threads.filter((t) => t.status === "running").length;

/** How many notes show before « n de plus ». */
const NOTES_SHOWN = 6;
/** How long the card's entrance plays: after it, only what changes moves. */
const ENTRANCE_MS = 1700;

type Look = ReturnType<typeof cardState> | "done";

/** Where the five stars of the corner sit, and their size. */
const STARS: [number, number, number][] = [
  [46, 9, 1.5],
  [74, 58, 1.1],
  [94, 11, 1.8],
  [66, 84, 1],
  [92, 70, 1.3],
];

/** What the version brings, ticked line by line. */
function Notes(props: { notes: UpdateNote[]; all: boolean; onAll: () => void }) {
  const { notes, all } = props;
  if (!notes.length) return null;
  const more = notes.length - NOTES_SHOWN;
  const shown = all || more <= 0 ? notes : notes.slice(0, NOTES_SHOWN);
  return (
    <>
      <div className="usec">
        Nouveautés<span className="n">{notes.length}</span>
      </div>
      <div className={`ulist${all && more > 0 ? " fade" : ""}`} role="list">
        {shown.map((n, i) => (
          <div
            key={i}
            role="listitem"
            className={`urow${i >= NOTES_SHOWN ? " new" : ""}`}
            style={{ "--i": i >= NOTES_SHOWN ? i - NOTES_SHOWN : i } as React.CSSProperties}
          >
            <DrawnCheck />
            <span className="tx">{n.title}</span>
            {n.number !== undefined && <span className="num">#{n.number}</span>}
          </div>
        ))}
        {!all && more > 0 && (
          <button
            className="umore"
            style={{ "--i": NOTES_SHOWN } as React.CSSProperties}
            onClick={props.onAll}
          >
            {more} de plus
            <I n="down" s={14} />
          </button>
        )}
      </div>
    </>
  );
}

/** A stopwatch since `since`, read each second. */
function Since({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const every = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(every);
  }, []);
  return <span className="tm">{stopwatch(Date.now() - since)}</span>;
}

/** The steps of an install: done, under way since when, to come. */
function Steps(props: { app: AppInfo; connected: boolean }) {
  const steps = installSteps(props.app.update, props.connected);
  const now = steps.find((s) => s.state === "now")?.key;
  // What was already done when the list was first drawn stays still; what gets done under
  // the eyes is ticked with a stroke.
  const before = useRef(new Set(steps.filter((s) => s.state === "done").map((s) => s.key)));
  const since = useRef<{ key?: string; at: number }>({ at: Date.now() });
  if (since.current.key !== now) since.current = { key: now, at: Date.now() };
  return (
    <>
      <div className="usec">Installation</div>
      <div className="ulist" role="list">
        {steps.map((s, i) => (
          <div
            key={s.key}
            role="listitem"
            className={`ust ${s.state === "done" ? "d" : s.state === "now" ? "c" : "p"}${
              s.state === "done" && !before.current.has(s.key) ? " new" : ""
            }`}
            style={{ "--i": i } as React.CSSProperties}
          >
            <i>{s.state === "done" && <DrawnCheck />}</i>
            <span className="tx">{s.label}</span>
            {s.state === "now" && props.app.update.phase && <Since since={since.current.at} />}
          </div>
        ))}
      </div>
    </>
  );
}

/** One segment per step of the install: filled once done, alive while under way. */
function StepBar(props: { app: AppInfo; connected: boolean }) {
  const steps = installSteps(props.app.update, props.connected);
  const at = Math.max(
    0,
    steps.findIndex((s) => s.state === "now"),
  );
  const before = useRef(new Set(steps.filter((s) => s.state === "done").map((s) => s.key)));
  const doing = ["", "Sauvegarde de la base", "Remplacement de l'app", "Reconnexion"][at] ?? "";
  return (
    <div className="usegs" role="status">
      <div className="l">
        <b>{doing}</b>
        <span className="sp" />
        <span className="mono">
          {at + 1} / {steps.length}
        </span>
      </div>
      <div className="bars" aria-hidden="true">
        {steps.map((s) => (
          <i
            key={s.key}
            className={
              s.state === "done"
                ? `d${before.current.has(s.key) ? "" : " new"}`
                : s.state === "now"
                  ? "c"
                  : ""
            }
          />
        ))}
      </div>
    </div>
  );
}

/** What is downloaded, as measured: the share, the size, and what is left at this pace. */
function Download({ app }: { app: AppInfo }) {
  const progress = app.update.progress ?? 0;
  const size = app.update.size;
  const last = useRef({ at: Date.now(), progress, pace: 0 });
  last.current = downloadPace(last.current, progress, Date.now());
  const percent = Math.round(progress * 100);
  return (
    <div className="uprog">
      <div className="l">
        <b>{percent} %</b>
        {size !== undefined && (
          <span className="mono">
            {formatSize(progress * size)} / {formatSize(size)}
          </span>
        )}
        <span className="sp" />
        <span>{etaLabel(progress, last.current.pace)}</span>
      </div>
      <div
        className="ubar"
        role="progressbar"
        aria-label="Téléchargement"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ "--p": progress } as React.CSSProperties}
      >
        <i />
      </div>
    </div>
  );
}

function Copy(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="b2 ink press"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(props.text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      <I n={done ? "check" : "copies"} s={16} />
      {done ? "Copiée" : "Copier la commande"}
    </button>
  );
}

/** The newer version in large, its changed number rolling up from the old one. */
function Version(props: { from: string; to: string }) {
  const roll = versionRoll(props.from, props.to);
  if (!roll) return <b>{props.to}</b>;
  return (
    <b aria-label={props.to}>
      {roll.head}
      <span className="uroll" aria-hidden="true">
        <i>{roll.was}</i>
        <i>{roll.now}</i>
      </span>
      {roll.tail}
    </b>
  );
}

/**
 * The card. `memo` once the version it tells of is in: the card then says what it brought.
 * `connected`: the screen still hears the server.
 */
function Card(props: {
  app: AppInfo;
  memo?: InstallMemo;
  connected: boolean;
  running: number;
  /** Opened by a press on the capsule: the window is born from it and goes back to it. */
  fromCapsule: boolean;
  onClose: () => void;
}) {
  const { app, memo } = props;
  const u = app.update;
  const look: Look = memo ? "done" : cardState(app);
  const send = (message: Parameters<typeof connection.send>[0]) => connection.send(message);
  const root = useRef<HTMLDivElement>(null);

  // The entrance plays once; after it only what changes moves.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const done = setTimeout(() => setEntering(false), ENTRANCE_MS);
    return () => clearTimeout(done);
  }, []);

  // On a wide screen the window is born from the capsule and goes back to it, while there is
  // one on the page to go back to: not once the version is in or being installed, nor when
  // the card was opened from elsewhere (the settings, which cover the capsule).
  const toCapsule = props.fromCapsule && look !== "done" && look !== "installing";
  useLayoutEffect(() => {
    const sheet = root.current?.closest<HTMLElement>(".sheet");
    if (!sheet) return;
    const capsule = toCapsule ? document.querySelector(".mtop .gcap.upc") : null;
    const parent = sheet.offsetParent;
    if (!capsule || !parent || !sheet.closest(".scr.roomy")) {
      delete sheet.dataset.from;
      return;
    }
    const from = capsule.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    sheet.style.setProperty(
      "--ux",
      `${from.left + from.width / 2 - (box.left + sheet.offsetLeft)}px`,
    );
    sheet.style.setProperty(
      "--uy",
      `${from.top + from.height / 2 - (box.top + sheet.offsetTop)}px`,
    );
    sheet.dataset.from = "cap";
  }, [toCapsule]);

  // The card changes height between two looks: it glides there.
  const height = useRef(0);
  const [allNotes, setAllNotes] = useState(false);
  useLayoutEffect(() => {
    const sheet = root.current?.closest<HTMLElement>(".sheet");
    if (!sheet) return;
    sheet.style.height = "";
    const next = sheet.offsetHeight;
    const was = height.current;
    height.current = next;
    if (!was || Math.abs(next - was) < 3 || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    sheet.style.height = `${was}px`;
    void sheet.offsetHeight;
    sheet.classList.add("hgt");
    sheet.style.height = `${next}px`;
    const done = setTimeout(() => {
      sheet.classList.remove("hgt");
      sheet.style.height = "";
    }, 640);
    return () => {
      clearTimeout(done);
      sheet.classList.remove("hgt");
      // Left before the glide ended: the sheet keeps no height of the card's.
      sheet.style.height = "";
    };
  }, [look, allNotes]);

  // A full moon when the download ends under the eyes; star dust once the version is in.
  const was = useRef(look);
  const [bloom, setBloom] = useState(false);
  const [dust, setDust] = useState(look === "done");
  useEffect(() => {
    const before = was.current;
    was.current = look;
    if (before === "downloading" && look === "ready") setBloom(true);
    if (before !== "done" && look === "done") setDust(true);
  }, [look]);
  useEffect(() => {
    if (!bloom) return;
    const done = setTimeout(() => setBloom(false), 1000);
    return () => clearTimeout(done);
  }, [bloom]);
  useEffect(() => {
    if (!dust) return;
    const done = setTimeout(() => setDust(false), 2200);
    return () => clearTimeout(done);
  }, [dust]);

  const steps = installSteps(u, props.connected);
  const away = look === "installing" && steps.some((s) => s.key === "restart" && s.state === "now");
  const progress = u.progress ?? 0;
  const lit = look === "downloading" ? progress : away ? 0 : 1;
  const stars =
    look === "downloading" ? Math.floor(progress * 5 + 0.02) : look === "failed" ? 0 : away ? 1 : 5;
  const glow =
    look === "downloading"
      ? 0.3 + 0.7 * progress
      : away
        ? 0.25
        : look === "ready" || look === "git" || look === "mac"
          ? 0.6
          : look === "failed"
            ? 0.2
            : 0.85;

  const version = memo?.version ?? u.version ?? "";
  const notes = memo?.notes ?? u.notes ?? [];
  const title =
    look === "installing"
      ? "Installation"
      : look === "done"
        ? "Mise à jour installée"
        : look === "git"
          ? "Nouvelle version sur main"
          : "Mise à jour";
  const working = look === "waiting" ? (u.working ?? 0) : props.running;
  const pill =
    look === "downloading" ? (
      <span className="upill live">Téléchargement</span>
    ) : look === "installing" ? (
      <span className="upill live">
        <Glyph />
        En cours
      </span>
    ) : look === "done" ? (
      <span className="upill ok">Installée</span>
    ) : look === "failed" ? (
      <span className="upill err">Échec</span>
    ) : look === "git" ? (
      <span className="upill">main</span>
    ) : look === "mac" ? (
      <span className="upill">Sortie</span>
    ) : working > 0 ? (
      <span className="upill">
        <Glyph />
        {workingLine(working)}
      </span>
    ) : (
      <span className="upill">{look === "waiting" ? "En attente" : "Prête"}</span>
    );
  const dot = <span className="dot" />;
  const meta =
    look === "installing" && u.install ? (
      <>
        Demandée {u.install.by}
        {dot}
        {seenAgo(u.install.at, Date.now())}
      </>
    ) : look === "git" ? (
      <>
        <span className="mono">{version.slice(0, 7)}</span>
        {notes.length > 0 && (
          <>
            {dot}
            {notes.length} PR fusionnée{notes.length > 1 ? "s" : ""}
          </>
        )}
      </>
    ) : (
      <>
        {kindName(app.kind)}
        {u.size !== undefined && (
          <>
            {dot}
            {formatSize(u.size)}
          </>
        )}
      </>
    );
  const big =
    look === "git" ? (
      <>
        <b>{u.behind ?? 0}</b>
        <small>commit{(u.behind ?? 0) > 1 ? "s" : ""} à récupérer</small>
      </>
    ) : look === "done" ? (
      <>
        <b>{version}</b>
        <small>était {memo!.from}</small>
      </>
    ) : (
      <>
        <Version from={app.version} to={version} />
        <small>actuelle {app.version}</small>
      </>
    );
  const later = (
    <button className="ulink" onClick={props.onClose}>
      Plus tard
    </button>
  );
  const foot =
    look === "downloading" ? (
      <Download app={app} />
    ) : look === "installing" ? (
      <StepBar app={app} connected={props.connected} />
    ) : look === "waiting" ? (
      <>
        <button className="ulink" onClick={() => send({ type: "app.cancel" })}>
          Annuler
        </button>
        <span className="sp" />
        <button className="b2 ink press" onClick={() => send({ type: "app.install", when: "now" })}>
          Installer maintenant
        </button>
      </>
    ) : look === "done" ? (
      <>
        <span className="sp" />
        <button className="b2 ink press" onClick={props.onClose}>
          Continuer
        </button>
      </>
    ) : look === "failed" ? (
      <>
        {later}
        <span className="sp" />
        <button className="b2 ink press" onClick={() => send({ type: "app.check" })}>
          <I n="refresh" s={16} />
          Réessayer
        </button>
      </>
    ) : look === "git" ? (
      <>
        {later}
        <span className="sp" />
        <Copy text={PULL_COMMAND} />
      </>
    ) : look === "mac" ? (
      <>
        {later}
        <span className="sp" />
        {u.url && (
          <a className="b2 ink press" href={u.url} target="_blank" rel="noopener noreferrer">
            <I n="ext" s={16} />
            Télécharger le .dmg
          </a>
        )}
      </>
    ) : working > 0 ? (
      <>
        <button className="ulink" onClick={() => send({ type: "app.install", when: "now" })}>
          <I n="bolt" s={15} />
          Maintenant
        </button>
        <span className="sp" />
        <button
          className="b2 ink press"
          onClick={() => send({ type: "app.install", when: "idle" })}
        >
          Quand rien ne tourne
        </button>
      </>
    ) : (
      <>
        {later}
        <span className="sp" />
        <button
          className="b2 ink press"
          onClick={() => send({ type: "app.install", when: "idle" })}
        >
          Installer
        </button>
      </>
    );
  const stepped = look === "waiting" || look === "installing";
  return (
    <>
      <div
        className="uglow"
        style={{ "--gl": glow.toFixed(3) } as React.CSSProperties}
        aria-hidden="true"
      >
        <svg className="uwm" viewBox="0 0 48 48">
          <path
            d="M36.03 27.03A12.4 12.4 0 1 1 23.28 11.62A10 10 0 0 0 36.03 27.03Z"
            fill="none"
            stroke="currentColor"
            strokeWidth=".7"
          />
          <path
            d="M-22 0A22 7.4 0 0 0 22 0A22 7.4 0 0 0 -22 0"
            transform="translate(24 24) rotate(-20)"
            fill="none"
            stroke="currentColor"
            strokeWidth=".5"
          />
        </svg>
        <div className="ustars">
          {STARS.map(([x, y, size], i) => (
            <i
              key={i}
              className={i < stars ? "on" : undefined}
              style={{ left: `${x}%`, top: `${y}%`, "--s": size, "--i": i } as React.CSSProperties}
            />
          ))}
        </div>
      </div>
      <div
        ref={root}
        className={`ucard${entering ? " ent" : ""}${look === "installing" ? " inst" : ""}`}
        data-look={look}
        role={look === "installing" ? "status" : undefined}
        aria-live={look === "installing" ? "polite" : undefined}
      >
        <div className="uhd">
          <span className={`umw${bloom ? " bloom" : ""}`}>
            <MoonPhase
              lit={lit}
              live={look === "downloading"}
              spin={look === "installing"}
              away={away}
              done={look === "done"}
            />
            {dust && (
              <span className="udust">
                {Array.from({ length: 8 }, (_, i) => (
                  <i
                    key={i}
                    style={
                      {
                        "--a": `${i * 45 + 12}deg`,
                        "--d": `${26 + ((i * 7) % 3) * 7}px`,
                        "--i": i,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </span>
            )}
          </span>
          <span className="sp" />
          <span className="uswap" key={`p-${look}-${working > 0}`}>
            {pill}
          </span>
          {look !== "installing" && (
            <button className="ux press" aria-label="Fermer" onClick={props.onClose}>
              <I n="x" s={17} />
            </button>
          )}
        </div>
        <div className="uswap" key={`t-${title}`}>
          <h3 className="utt">{title}</h3>
          <div className="umeta">{meta}</div>
          <div className="uver">{big}</div>
          {look === "failed" && u.error && <div className="uerr">{u.error}</div>}
        </div>
        <div className="uhr" />
        <div className="ubody uswap" key={stepped ? "steps" : "notes"}>
          {stepped ? (
            <Steps app={app} connected={props.connected} />
          ) : (
            <Notes notes={notes} all={allNotes} onAll={() => setAllNotes(true)} />
          )}
          {look === "git" && (
            <div className="ucmd">
              <code>{PULL_COMMAND}</code>
            </div>
          )}
        </div>
        <div className="uhr" />
        <div className="uft uswap" key={`f-${look}-${look === "ready" && working > 0}`}>
          {foot}
        </div>
      </div>
    </>
  );
}

/** What this screen saw of an install, kept while the host is drawn again. */
let watch: InstallWatch = { saw: false, lost: false };

/**
 * Mounted once: the card when opened, the steps of an install over every screen, from the copy
 * of the database until the app is back, then what the version brought.
 */
export function AppUpdateHost() {
  const { app, status } = useApp();
  const running = useSyncExternalStore(connection.subscribe, runningThreads);
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

  // An install that begins leaves a memo on the device; once the server runs that version
  // (after a reload or not), the card says what it brought, until it is closed.
  const [memo, setMemo] = useState(loadMemo);
  useEffect(() => {
    const begun = app && installMemo(app);
    if (begun && begun.version !== memo?.version) {
      saveMemo(begun);
      setMemo(begun);
    }
  }, [app, memo]);
  const fate = memoFate(memo, app, connected);
  useEffect(() => {
    if (fate !== "drop") return;
    saveMemo(undefined);
    setMemo(undefined);
  }, [fate]);

  // What the card last showed, kept while it closes: the server says nothing of a version
  // that is in, and the card must not empty itself on its way out.
  const last = useRef<AppInfo | null>(null);
  if (app) last.current = app;
  const overlay = !!app && (installing || waitingBack);
  const done = fate === "show";
  const open = overlay || done || (!!at && updateShown(app));
  // The page's own « Reconnexion » stays out while the card says it.
  useScrFlag("upi", overlay);
  const close = () => {
    if (done) {
      saveMemo(undefined);
      setMemo(undefined);
    }
    closeUpdateCard();
  };
  const shown = app ?? last.current;
  if (!shown) return null;
  return (
    <Sheet
      open={open}
      onClose={close}
      label={
        overlay
          ? `Installation de MoonAgentic ${shown.update.version ?? ""}`
          : done
            ? `MoonAgentic ${memo?.version ?? ""} installée`
            : `Mise à jour ${shown.update.version ?? ""}`
      }
      className="upw"
      // The install itself is not left: it shows on every screen until the app is back, with
      // no handle to pull it down by.
      modal={overlay}
      grab={!overlay}
    >
      <Card
        app={shown}
        memo={done ? memo : undefined}
        connected={connected}
        running={running}
        fromCapsule={at?.from === "capsule"}
        onClose={close}
      />
    </Sheet>
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
