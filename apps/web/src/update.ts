// A tab left open across an update (`git pull; pnpm build; pnpm start`) still runs the old
// app: its next chunk no longer exists and the page would go blank. The build writes its id
// in the page, the server tells which build it serves now; when they differ, the tab offers
// to reload instead.

/** How often an open tab asks, on top of each return to it. */
const EVERY = 60_000;

/** True when the server serves another build than the one this page came from. */
export function isStale(page: string | undefined, served: unknown): boolean {
  return typeof page === "string" && page !== "" && typeof served === "string" && served !== page;
}

const listeners = new Set<() => void>();
let stale = false;

/** Set once MoonAgentic was seen replacing itself: the new build loads without a tap. */
let reloadWhenStale = false;

function markStale() {
  if (reloadWhenStale) {
    location.reload();
    return;
  }
  if (stale) return;
  stale = true;
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore: whether a newer version waits for a reload. */
export const readStale = () => stale;
export function subscribeStale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const pageBuild = () =>
  document.querySelector<HTMLMetaElement>('meta[name="moonagentic-build"]')?.content;

let asking = false;
async function check(page: string): Promise<void> {
  if (stale || asking) return;
  asking = true;
  try {
    const res = await fetch("/api/build", { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { id?: unknown };
    if (isStale(page, body.id)) markStale();
  } catch {
    // The server is restarting or out of reach: the next check asks again.
  } finally {
    asking = false;
  }
}

/**
 * After an update this screen watched being installed: asks now, and loads the new build as
 * soon as the server serves it.
 */
export function expectNewBuild(): void {
  if (stale) return location.reload();
  reloadWhenStale = true;
  const page = pageBuild();
  if (page) void check(page);
}

/**
 * Starts watching for a newer build. False with the dev server, which has no id and
 * reloads by itself.
 */
export function startUpdateCheck(): boolean {
  const page = pageBuild();
  if (!page) return false;
  setInterval(() => void check(page), EVERY);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check(page);
  });
  window.addEventListener("online", () => void check(page));
  // A chunk that fails to load is the surest sign: ask at once rather than in a minute.
  window.addEventListener("vite:preloadError", () => void check(page));
  return true;
}
