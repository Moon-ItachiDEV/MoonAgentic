// A newer version in the capsule at the top right of every page, kept in the main chunk: a
// small moon beside what the capsule already holds, which stretches once to announce a version
// ready, then folds back. It opens the card (AppUpdate.tsx), loaded on demand.
import type { AppInfo } from "@moonagentic/protocol";
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  announceDelay,
  announceDue,
  capsuleOf,
  openUpdateCard,
  RISE_MS,
  readUpdateCard,
  subscribeUpdateCard,
  updateShown,
} from "../app-update.ts";
import { connection } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import { MoonPhase } from "../v2/MoonPhase.tsx";

// The app's own line of the state, nothing else: the capsule is on every page, a thread being
// written included, and must not be drawn again for each word.
const useApp = () => useSyncExternalStore(connection.subscribe, () => connection.getState().app);

/** How long the capsule stays stretched, then how long it takes to fold back. */
const ANNOUNCE_MS = 4800;
const FOLD_MS = 900;
/** The version this device announced, kept across reloads: once per version and device. */
const ANNOUNCED = "update.announced";

/** Where the announcement stands: stretched (`ann`), folding back (`fold`), or at rest. */
type Beat = "" | "ann" | "fold";
let beat: Beat = "";
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const readBeat = () => beat;
const subscribeBeat = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setBeat(next: Beat, then?: () => void, after = 0) {
  clearTimeout(timer);
  timer = then ? setTimeout(then, after) : undefined;
  if (next === beat) return;
  beat = next;
  for (const l of listeners) l();
}
/** Folds the capsule back, at the end of an announcement or as soon as it is pressed. */
export function foldCapsule(): void {
  if (beat === "ann") setBeat("fold", () => setBeat(""), FOLD_MS);
}
function announce(version: string): void {
  writePref(ANNOUNCED, version);
  setBeat("ann", foldCapsule, ANNOUNCE_MS);
}

/** True once the small moon showed on this page: it rises only the first time. */
let risen = false;

/** For tests: as on a page just loaded. */
export function resetCapsule(): void {
  setBeat("");
  risen = false;
}

/** True while the capsule has something to show: not during the install, which covers the page. */
export const capsuleShown = (app: AppInfo | null | undefined): app is AppInfo =>
  updateShown(app) && !app.update.phase;

/**
 * The small moon and, while it announces, its two lines. Drawn again only when what the server
 * says of the app changes: the bar that holds it is drawn again far more often.
 */
const Segment = memo(function Segment({ app }: { app: AppInfo }) {
  const now = useSyncExternalStore(subscribeBeat, readBeat);
  const button = useRef<HTMLButtonElement>(null);
  // The small moon rises the first time it shows on this page. Read here, written once it
  // is on the page: drawing twice (React's strict mode) must give the same answer.
  const [shown] = useState(() => ({ rose: !risen, at: performance.now() }));
  const [rising, setRising] = useState(shown.rose);
  useEffect(() => {
    risen = true;
  }, []);
  useEffect(() => {
    if (!rising) return;
    const done = setTimeout(() => setRising(false), RISE_MS);
    return () => clearTimeout(done);
  }, [rising]);

  // A version newly ready is announced once, when the page is looked at. With its card open,
  // it is already read: nothing stretches behind it.
  const due = announceDue(app, readPref(ANNOUNCED));
  const reading = !!useSyncExternalStore(subscribeUpdateCard, readUpdateCard);
  useEffect(() => {
    if (!due) return;
    if (reading) {
      writePref(ANNOUNCED, due);
      return;
    }
    let wait: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(wait);
      // After the rise, counted from when the capsule showed: the end of the rise draws the
      // capsule again, and must not set this wait back.
      wait = setTimeout(
        () => announce(due),
        announceDelay(shown.rose, performance.now() - shown.at),
      );
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      clearTimeout(wait);
      document.removeEventListener("visibilitychange", start);
    };
  }, [due, reading, shown]);

  const says = capsuleOf(app);
  // Stretched to what it says exactly: a width in pixels is what lets it spring.
  useLayoutEffect(() => {
    const el = button.current;
    if (!el) return;
    const lines = el.querySelector<HTMLElement>(".ul");
    el.style.width = now === "ann" && lines ? `${10 + 24 + 10 + lines.scrollWidth + 18}px` : "";
  }, [now, says.title, says.sub]);

  const loading = app.update.state === "downloading" && !app.update.install;
  return (
    <button
      ref={button}
      className={`useg ${says.tone}${rising ? " rise" : ""}`}
      aria-label={`Mise à jour : ${says.title}, ${says.sub}`}
      aria-haspopup="dialog"
      onClick={() => {
        foldCapsule();
        openUpdateCard("capsule");
      }}
    >
      <span className="um2">
        <MoonPhase lit={loading ? (app.update.progress ?? 0) : 1} live={loading} />
        <i className="tw" />
        <i className="tw" />
        <i className="tw" />
      </span>
      <span className="ul" aria-hidden="true">
        <b>
          {says.title.split(" ").map((word, i) => (
            <span key={i} style={{ "--i": i } as React.CSSProperties}>
              {word}{" "}
            </span>
          ))}
        </b>
        <small>{says.sub}</small>
      </span>
      <span className="nd" />
    </button>
  );
});

/**
 * A capsule of the top bar. With a newer version to speak of, the small moon comes first and
 * the rest steps aside while it announces. `solo`: nothing else in it, so nothing shows
 * without a version.
 */
export function UpdCap(props: { children?: ReactNode; solo?: boolean }) {
  const app = useApp();
  const now = useSyncExternalStore(subscribeBeat, readBeat);
  // Drawn while already stretched (another page was opened): it is, at once, without playing.
  const [still, setStill] = useState(() => readBeat() === "ann");
  useEffect(() => {
    if (!still) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setStill(false)));
    return () => cancelAnimationFrame(frame);
  }, [still]);
  if (!capsuleShown(app)) {
    return props.solo ? null : <div className="gcap glass">{props.children}</div>;
  }
  return (
    <div
      className={`gcap glass upc${props.solo ? " solo" : ""}${now ? ` ${now}` : ""}${still ? " still" : ""}`}
    >
      <Segment app={app} />
      {props.children}
    </div>
  );
}

/** The right of a top bar that has no capsule of its own: the update's, then what it holds. */
export function TopRight(props: { children?: ReactNode }) {
  return (
    <div className="tru">
      <UpdCap solo />
      {props.children}
    </div>
  );
}
