// Pairing a phone: a one-time code from the computer, a token of its own, revocable.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Devices,
  MAX_DEVICES,
  normalizeCode,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_MS,
} from "../src/devices.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("paired devices", () => {
  it("pairs once with a code, as typed, and knows the device by its token", () => {
    const devices = new Devices();
    const { code, expiresAt } = devices.startPairing();
    expect(code).toMatch(new RegExp(`^[A-HJKMNP-TV-Z2-9]{${PAIR_CODE_LENGTH}}$`));
    expect(expiresAt).toBeGreaterThan(Date.now());
    const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`;
    expect(normalizeCode(typed)).toBe(code);

    const paired = devices.pair(typed, "  iPhone · Safari  ")!;
    expect(paired.device.name).toBe("iPhone · Safari");
    expect(paired.token.length).toBeGreaterThanOrEqual(40);
    expect(devices.authenticate(paired.token)).toBe(paired.device.id);
    // A code works once.
    expect(devices.pair(code, "Autre")).toBeUndefined();
    expect(devices.authenticate("pas-un-jeton")).toBeUndefined();
    expect(devices.authenticate(null)).toBeUndefined();
    expect(devices.list().map((d) => d.name)).toEqual(["iPhone · Safari"]);
  });

  it("refuses a code past its time, and keeps only the last few codes", () => {
    let now = 1_000_000;
    const devices = new Devices(undefined, () => now);
    const late = devices.startPairing().code;
    now += PAIR_CODE_TTL_MS;
    expect(devices.pair(late, "Tard")).toBeUndefined();

    const codes = Array.from({ length: 6 }, () => devices.startPairing().code);
    // The first of six no longer works: five are shown at most.
    expect(devices.pair(codes[0]!, "Vieux")).toBeUndefined();
    expect(devices.pair(codes[5]!, "Neuf")).toBeDefined();
  });

  it("revokes a device: its token stops working at once", () => {
    const devices = new Devices();
    const a = devices.pair(devices.startPairing().code, "A")!;
    const b = devices.pair(devices.startPairing().code, "B")!;
    expect(devices.revoke(a.device.id)).toBe(true);
    expect(devices.revoke(a.device.id)).toBe(false);
    expect(devices.authenticate(a.token)).toBeUndefined();
    expect(devices.authenticate(b.token)).toBe(b.device.id);
  });

  it("keeps devices in the database, never their tokens", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-devices-"));
    const file = path.join(dir, "state.sqlite");
    let store = new Store(file);
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const paired = new Devices(store).pair(new Devices(store).startPairing().code, "x");
    // A code belongs to the Devices that showed it.
    expect(paired).toBeUndefined();
    const devices = new Devices(store);
    const { token, device } = devices.pair(devices.startPairing().code, "Tablette")!;
    const rows = store.db.prepare(`SELECT * FROM devices`).all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(token);
    store.close();

    store = new Store(file);
    const again = new Devices(store);
    expect(again.authenticate(token)).toBe(device.id);
    expect(again.list()).toMatchObject([{ id: device.id, name: "Tablette" }]);
    again.revoke(device.id);
    expect(new Devices(store).authenticate(token)).toBeUndefined();
  });

  it("refuses more devices than it keeps", () => {
    const devices = new Devices();
    for (let i = 0; i < MAX_DEVICES; i++) devices.pair(devices.startPairing().code, `n${i}`);
    expect(() => devices.pair(devices.startPairing().code, "de trop")).toThrow(/Déjà/);
  });
});
