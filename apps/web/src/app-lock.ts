// The whole app locked on this device: its screen is covered until the code is typed, while
// the agents keep working. The server keeps the code and checks it; this device only
// remembers that it is locked, so that reloading the page does not open it.
import { readPref, writePref } from "./prefs.ts";

const LOCKED = "appLocked";
const AFTER = "lockAfter";

/** When the app locks by itself: never, as soon as it is out of sight, or after a while away. */
export const LOCK_AFTER = [
  { value: "never", label: "Jamais" },
  { value: "0", label: "Immédiatement" },
  { value: "1", label: "1 min" },
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
  { value: "60", label: "1 h" },
] as const;

export type LockAfter = (typeof LOCK_AFTER)[number]["value"];

export function readLockAfter(): LockAfter {
  const kept = readPref(AFTER);
  return LOCK_AFTER.some((o) => o.value === kept) ? (kept as LockAfter) : "never";
}

/**
 * Whether a device set to lock after `after` locks now: it was last used at `lastActive`, and
 * went out of sight at `hiddenAt` if it did. Pure, so the rule is easy to test.
 */
export function shouldLock(
  after: LockAfter,
  now: number,
  lastActive: number,
  hiddenAt: number | undefined,
): boolean {
  if (after === "never") return false;
  if (after === "0") return hiddenAt !== undefined;
  return now - lastActive >= Number(after) * 60_000;
}

let locked = readPref(LOCKED) === "1";
let after = readLockAfter();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export const appLock = {
  locked: (): boolean => locked,
  after: (): LockAfter => after,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  lock(): void {
    if (locked) return;
    locked = true;
    writePref(LOCKED, "1");
    changed();
  },
  unlock(): void {
    if (!locked) return;
    locked = false;
    writePref(LOCKED, "0");
    changed();
  },
  setAfter(value: LockAfter): void {
    after = value;
    writePref(AFTER, value);
    changed();
  },
};

/**
 * Locks the app by itself once it was left alone long enough. Returns what stops the watch.
 * Only while a code exists (`hasPin` says so now): without one, nothing could open it again.
 */
export function watchIdle(hasPin: () => boolean): () => void {
  let lastActive = Date.now();
  let hiddenAt: number | undefined;
  const check = () => {
    if (locked || !hasPin()) return;
    if (shouldLock(after, Date.now(), lastActive, hiddenAt)) appLock.lock();
  };
  const active = () => {
    lastActive = Date.now();
  };
  const seen = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      check();
      return;
    }
    // Back in sight: the time away counts, then being here is being active again.
    check();
    hiddenAt = undefined;
    active();
  };
  const timer = setInterval(check, 15_000);
  document.addEventListener("visibilitychange", seen);
  document.addEventListener("pointerdown", active, true);
  document.addEventListener("keydown", active, true);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", seen);
    document.removeEventListener("pointerdown", active, true);
    document.removeEventListener("keydown", active, true);
  };
}
