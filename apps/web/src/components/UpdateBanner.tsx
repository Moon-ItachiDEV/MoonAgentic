import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { readStale, startUpdateCheck, subscribeStale } from "../update.ts";

/** Shown once the server serves a newer build than this tab's: one tap reloads it. */
export function UpdateBanner() {
  const stale = useSyncExternalStore(subscribeStale, readStale);
  if (!stale) return null;
  return (
    <div className="update-banner" role="status">
      <span>Une nouvelle version de MoonAgentic est prête.</span>
      <button type="button" className="btn pri sm" onClick={() => location.reload()}>
        Recharger
      </button>
    </div>
  );
}

/** Watches for a newer build and mounts the banner in its own root, so it still shows if the app has failed. */
export function startUpdateBanner(): void {
  if (!startUpdateCheck()) return;
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(<UpdateBanner />);
}
