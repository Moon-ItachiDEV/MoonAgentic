// The update pills, kept in the main chunk: they are small and show at once. The card and
// the steps of an install (AppUpdate.tsx) are loaded once there is something to say, while
// the server still answers: a page that waits for it to come back already has them.
import { lazy, Suspense, useSyncExternalStore } from "react";
import {
  closeUpdateCard,
  openUpdateCard,
  pillOf,
  readUpdateCard,
  subscribeUpdateCard,
  updateShown,
} from "../app-update.ts";
import { connection } from "../connection.ts";
import { IconArrowUp, IconClock } from "./icons.tsx";

const useApp = () => useSyncExternalStore(connection.subscribe, connection.getState);

const Host = lazy(() => import("./AppUpdate.tsx").then((m) => ({ default: m.AppUpdateHost })));

/** The pill at the foot of the side bar: there only while there is something to say. */
export function AppUpdatePill() {
  const { app } = useApp();
  const open = useSyncExternalStore(subscribeUpdateCard, readUpdateCard);
  if (!updateShown(app)) return null;
  const pill = pillOf(app);
  return (
    <button
      className={`apu-pill ${pill.tone}${open ? " on" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={!!open}
      onClick={(e) => {
        if (open) return closeUpdateCard();
        const side = e.currentTarget.closest(".side")?.getBoundingClientRect();
        openUpdateCard({
          top: e.currentTarget.getBoundingClientRect().bottom,
          left: (side?.right ?? 0) + 12,
        });
      }}
    >
      {pill.tone === "run" ? (
        <i className="t2-spin" aria-hidden />
      ) : pill.tone === "wait" ? (
        <IconClock size={15} />
      ) : (
        <IconArrowUp size={15} />
      )}
      <span className="apu-pill-t">{pill.text}</span>
      {pill.tail && <span className="apu-pill-k">{pill.tail}</span>}
    </button>
  );
}

/** The same, among the home page's pills: on a phone, the side bar is folded away. */
export function AppUpdateHomePill() {
  const { app } = useApp();
  if (!updateShown(app)) return null;
  const pill = pillOf(app);
  return (
    <button className="ov-pill apu-ov" onClick={() => openUpdateCard()}>
      <i />
      <b>{pill.text}</b>
      {pill.tail && <span>· {pill.tail}</span>}
    </button>
  );
}

let hostWanted = false;

/** The card and the steps of an install, loaded only once there is a version to speak of. */
export function AppUpdateHostOnDemand() {
  const { app } = useApp();
  // Once loaded it stays: back from an install, the server says there is nothing newer, and
  // the host must still see it come back to load the new build.
  if (updateShown(app)) hostWanted = true;
  if (!hostWanted) return null;
  return (
    <Suspense fallback={null}>
      <Host />
    </Suspense>
  );
}
