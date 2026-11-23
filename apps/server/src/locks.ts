// /lock: projects put out of sight behind a 6-digit code. The server keeps which projects are
// locked and a hash of the code, and leaves a locked project's threads, cards, plans, requests
// and notifications out of everything it sends, until the code is given again. Its agents keep
// working meanwhile.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface LockStorage {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
}

const LOCKED_SETTING = "lock.projects";
const PIN_SETTING = "lock.pin";
/** The recent wrong codes, kept so that restarting the server does not reset the count. */
const FAILURES_SETTING = "lock.failures";
/** Wrong codes allowed in a row before waiting. */
export const MAX_TRIES = 5;
/** How long the wrong codes are counted, and how long one waits after too many. */
export const TRIES_WINDOW_MS = 5 * 60_000;

export const validPin = (pin: string) => /^\d{6}$/.test(pin);

const hashPin = (pin: string, salt: Buffer) => scryptSync(pin, salt, 32);

/** Actor key for the computer itself (as opposed to paired devices). */
export const COMPUTER_ACTOR = "computer";

function loadFailures(raw: unknown): Record<string, number[]> {
  if (Array.isArray(raw)) {
    const list = raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    return list.length ? { [COMPUTER_ACTOR]: list } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const map: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const list = value.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (list.length) map[key] = list;
  }
  return map;
}

export class ProjectLocks {
  private readonly storage: LockStorage;
  private readonly now: () => number;
  private locked: Set<string>;
  /** When each recent wrong code was given, per device (`computer` or paired device id). */
  private failures: Record<string, number[]> = {};

  constructor(storage: LockStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    this.locked = new Set(storage.getSetting<string[]>(LOCKED_SETTING, []));
    this.failures = loadFailures(storage.getSetting<unknown>(FAILURES_SETTING, {}));
  }

  /** True when some project is locked: everything sent is then looked at. */
  any(): boolean {
    return this.locked.size > 0;
  }

  isLocked(projectId: string | undefined): boolean {
    return !!projectId && this.locked.has(projectId);
  }

  lockedProjects(): string[] {
    return [...this.locked].sort();
  }

  hasPin(): boolean {
    return !!this.storage.getSetting<{ salt: string; hash: string } | null>(PIN_SETTING, null);
  }

  /** Sets the code, or changes it with the current one. */
  setPin(pin: string, current?: string, actor = COMPUTER_ACTOR): void {
    if (!validPin(pin)) throw new Error("Le code doit faire 6 chiffres.");
    if (this.hasPin() && !this.check(current ?? "", actor)) {
      throw new Error("Code actuel incorrect.");
    }
    const salt = randomBytes(16);
    this.storage.setSetting(PIN_SETTING, {
      salt: salt.toString("base64"),
      hash: hashPin(pin, salt).toString("base64"),
    });
  }

  /** Clears the code, unlocks every project, and resets failed attempt counters. */
  reset(): void {
    this.storage.setSetting(PIN_SETTING, null);
    this.locked.clear();
    this.save();
    this.failures = {};
    this.storage.setSetting(FAILURES_SETTING, {});
  }

  /** Locks a project; a code must be set first, to open it again. */
  lock(projectId: string): void {
    if (!this.hasPin()) throw new Error("Choisis d'abord un code de verrouillage.");
    this.locked.add(projectId);
    this.save();
  }

  /** Opens a project again, for every device, with the code. */
  unlock(projectId: string, pin: string, actor = COMPUTER_ACTOR): void {
    if (!this.check(pin, actor)) throw new Error("Code incorrect.");
    this.locked.delete(projectId);
    this.save();
  }

  /** Forgets a project removed meanwhile. */
  forget(projectId: string): void {
    if (this.locked.delete(projectId)) this.save();
  }

  /**
   * Whether the code is right. After too many wrong ones in a short while from the same
   * device, every code from that device is refused for a time without blocking other devices
   * or the computer itself.
   */
  private check(pin: string, actor: string): boolean {
    const now = this.now();
    const list = (this.failures[actor] ?? []).filter((at) => now - at < TRIES_WINDOW_MS);
    if (list.length) this.failures[actor] = list;
    else delete this.failures[actor];
    if (list.length >= MAX_TRIES) {
      const wait = Math.ceil((list[0]! + TRIES_WINDOW_MS - now) / 60_000);
      throw new Error(`Trop de codes faux. Réessaie dans ${wait} min.`);
    }
    const kept = this.storage.getSetting<{ salt: string; hash: string } | null>(PIN_SETTING, null);
    const right =
      !!kept &&
      validPin(pin) &&
      timingSafeEqual(
        hashPin(pin, Buffer.from(kept.salt, "base64")),
        Buffer.from(kept.hash, "base64"),
      );
    const before = list.length;
    if (right) {
      delete this.failures[actor];
    } else {
      this.failures[actor] = [...list, now];
    }
    if (before || this.failures[actor]?.length) {
      // Prune expired buckets from other actors while persisting.
      for (const [key, times] of Object.entries(this.failures)) {
        const active = times.filter((at) => now - at < TRIES_WINDOW_MS);
        if (active.length) this.failures[key] = active;
        else delete this.failures[key];
      }
      this.storage.setSetting(FAILURES_SETTING, this.failures);
    }
    return right;
  }

  private save(): void {
    this.storage.setSetting(LOCKED_SETTING, this.lockedProjects());
  }
}
