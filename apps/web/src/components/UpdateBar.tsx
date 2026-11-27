// The card of MoonAgentic's own updates and the steps of an install (AppUpdate.tsx), loaded
// once there is something to say, while the server still answers: a page that waits for it to
// come back already has them. What announces a version is the capsule (UpdateCapsule.tsx).
import { lazy, Suspense, useSyncExternalStore } from "react";
import { loadMemo, updateShown } from "../app-update.ts";
import { connection } from "../connection.ts";

// The app's own line of the state: a page is not drawn again for each word an agent writes.
const useApp = () => useSyncExternalStore(connection.subscribe, () => connection.getState().app);

const Host = lazy(() => import("./AppUpdate.tsx").then((m) => ({ default: m.AppUpdateHost })));

// A device that watched an install begin still owes what the version brought.
let hostWanted = !!loadMemo();

/** The card and the steps of an install, loaded only once there is a version to speak of. */
export function AppUpdateHostOnDemand() {
  const app = useApp();
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
