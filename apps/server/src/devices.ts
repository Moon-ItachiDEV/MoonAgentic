// The devices paired with this MoonAgentic: a phone or a tablet gets a token of its own by
// typing or scanning a one-time code shown on the computer, and loses it when revoked. The
// computer's own token never leaves it.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PairedDevice } from "@moonagentic/protocol";
import type { DeviceRow } from "./store.ts";

/** Where devices are kept: the database, or memory alone in tests. */
export interface DeviceStorage {
  listDevices(): DeviceRow[];
  addDevice(device: DeviceRow): void;
  touchDevice(id: string, at: number): void;
  removeDevice(id: string): boolean;
}

/** How long a pairing code works, once shown. */
export const PAIR_CODE_TTL_MS = 5 * 60_000;
/** Codes shown at once: an older one stops working when more are asked for. */
const MAX_LIVE_CODES = 5;
/** A code people can read aloud and type: no 0/O, 1/I/L, nor U. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIR_CODE_LENGTH = 8;
/** More than this many devices is a sign something is wrong. */
export const MAX_DEVICES = 50;
/** A device's last use is written down at most this often. */
const TOUCH_EVERY_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The code as typed, whatever the case, spaces or dashes. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

function newCode(): string {
  // 256 is not a multiple of 30: bytes past the last whole round are drawn again.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < PAIR_CODE_LENGTH) {
    for (const byte of randomBytes(PAIR_CODE_LENGTH * 2)) {
      if (byte < limit && code.length < PAIR_CODE_LENGTH) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return code;
}

export function memoryDeviceStorage(): DeviceStorage {
  const rows = new Map<string, DeviceRow>();
  return {
    listDevices: () => [...rows.values()].map((r) => ({ ...r })),
    addDevice: (device) => void rows.set(device.id, { ...device }),
    touchDevice: (id, at) => {
      const row = rows.get(id);
      if (row) row.lastSeen = at;
    },
    removeDevice: (id) => rows.delete(id),
  };
}

export class Devices {
  private readonly storage: DeviceStorage;
  private readonly now: () => number;
  /** Live pairing codes, each with when it stops working. */
  private readonly codes = new Map<string, number>();
  /** The devices by their token's hash, read once from storage. */
  private readonly byHash = new Map<string, DeviceRow>();

  constructor(storage: DeviceStorage = memoryDeviceStorage(), now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    for (const row of storage.listDevices()) this.byHash.set(row.tokenHash, row);
  }

  /** A fresh one-time code, to show on the computer as text and in a QR code. */
  startPairing(): { code: string; expiresAt: number } {
    const now = this.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
    while (this.codes.size >= MAX_LIVE_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = newCode();
    const expiresAt = now + PAIR_CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /**
   * Pairs a device with a code shown on the computer. The code works once. Returns the
   * device's own token, shown to it alone, or nothing when the code is wrong or too old.
   */
  pair(code: string, name: string): { token: string; device: PairedDevice } | undefined {
    const typed = normalizeCode(code);
    const expiresAt = this.codes.get(typed);
    if (expiresAt === undefined) return undefined;
    this.codes.delete(typed);
    const now = this.now();
    if (expiresAt <= now) return undefined;
    if (this.byHash.size >= MAX_DEVICES) {
      throw new Error(
        `Déjà ${MAX_DEVICES} appareils appairés : révoque ceux dont tu ne te sers plus.`,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const row: DeviceRow = {
      id: randomUUID(),
      name: name.trim().slice(0, 60) || "Appareil",
      tokenHash: hash(token),
      createdAt: now,
      lastSeen: now,
    };
    this.storage.addDevice(row);
    this.byHash.set(row.tokenHash, row);
    return { token, device: this.shown(row) };
  }

  /**
   * The device a token belongs to, if any. Looked up by the token's hash: nothing compares
   * the token itself, so how long a lookup takes says nothing about it.
   */
  authenticate(token: string | null): string | undefined {
    if (!token) return undefined;
    const row = this.byHash.get(hash(token));
    if (!row) return undefined;
    const now = this.now();
    if (!row.lastSeen || now - row.lastSeen >= TOUCH_EVERY_MS) {
      row.lastSeen = now;
      // Only a note of when it was last seen: a database that refuses it must not refuse
      // the device its connection.
      try {
        this.storage.touchDevice(row.id, now);
      } catch {
        // Written again on a later connection.
      }
    }
    return row.id;
  }

  list(): PairedDevice[] {
    return [...this.byHash.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => this.shown(row));
  }

  /** Forgets a device: its token stops working at once. True when there was one. */
  revoke(id: string): boolean {
    for (const [key, row] of this.byHash) {
      if (row.id === id) {
        // Removed from the database first: a removal it refuses leaves the device as it was,
        // and the computer is told, instead of a device that comes back at the next start.
        this.storage.removeDevice(id);
        this.byHash.delete(key);
        return true;
      }
    }
    return false;
  }

  private shown(row: DeviceRow): PairedDevice {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      ...(row.lastSeen !== undefined ? { lastSeen: row.lastSeen } : {}),
    };
  }
}
