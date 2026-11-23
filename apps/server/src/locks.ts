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

export class ProjectLocks {
  private readonly storage: LockStorage;
  private readonly now: () => number;
  private locked: Set<string>;
  /** When each recent wrong code was given. */
  private failures: number[] = [];

  constructor(storage: LockStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    this.locked = new Set(storage.getSetting<string[]>(LOCKED_SETTING, []));
    this.failures = storage.getSetting<number[]>(FAILURES_SETTING, []);
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
  setPin(pin: string, current?: string): void {
    if (!validPin(pin)) throw new Error("Le code doit faire 6 chiffres.");
    if (this.hasPin() && !this.check(current ?? "")) throw new Error("Code actuel incorrect.");
    const salt = randomBytes(16);
    this.storage.setSetting(PIN_SETTING, {
      salt: salt.toString("base64"),
      hash: hashPin(pin, salt).toString("base64"),
    });
  }

  /** Locks a project; a code must be set first, to open it again. */
  lock(projectId: string): void {
    if (!this.hasPin()) throw new Error("Choisis d'abord un code de verrouillage.");
    this.locked.add(projectId);
    this.save();
  }

  /** Opens a project again, for every device, with the code. */
  unlock(projectId: string, pin: string): void {
    if (!this.check(pin)) throw new Error("Code incorrect.");
    this.locked.delete(projectId);
    this.save();
  }

  /** Forgets a project removed meanwhile. */
  forget(projectId: string): void {
    if (this.locked.delete(projectId)) this.save();
  }

  /**
   * Whether the code is right. After too many wrong ones in a short while, every code is
   * refused for a time, the right one too: guessing a million codes takes years then.
   */
  private check(pin: string): boolean {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < TRIES_WINDOW_MS);
    if (this.failures.length >= MAX_TRIES) {
      const wait = Math.ceil((this.failures[0]! + TRIES_WINDOW_MS - now) / 60_000);
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
    const before = this.failures.length;
    if (right) this.failures = [];
    else this.failures.push(now);
    if (before || this.failures.length) this.storage.setSetting(FAILURES_SETTING, this.failures);
    return right;
  }

  private save(): void {
    this.storage.setSetting(LOCKED_SETTING, this.lockedProjects());
  }
}
