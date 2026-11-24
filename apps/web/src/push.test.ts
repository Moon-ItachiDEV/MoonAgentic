import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyBytes, mutedProjects, pushError, pushSupport } from "./push-device.ts";

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return stored.size;
    },
    key: (i: number) => [...stored.keys()][i] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("web push on this device", () => {
  it("reads the server's key as the browser takes it", () => {
    const bytes = keyBytes(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect([...keyBytes("_-8")]).toEqual([0xff, 0xef]);
  });

  it("tells the server the projects this device mutes, and only those", () => {
    stored.set("moonagentic.notifications.muted.p2", "true");
    stored.set("moonagentic.notifications.muted.p1", "true");
    stored.set("moonagentic.notifications.muted.p3", "false");
    stored.set("moonagentic.notifications", "true");
    expect(mutedProjects()).toEqual(["p1", "p2"]);
  });

  it("says why it cannot, before asking anything", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(pushSupport()).toBe("insecure");
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {});
    expect(pushSupport()).toBe("unsupported");
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { isSecureContext: true, PushManager: class {} });
    expect(pushSupport()).toBe("ok");
  });

  it("leaves the desktop app out: its window shows them itself, with no push service", () => {
    vi.stubGlobal("window", { isSecureContext: true, PushManager: class {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("moonDesktop", { notify() {}, close() {}, onOpen() {} });
    expect(pushSupport()).toBe("desktop");
  });

  it("says in French why the browser's push service refused", () => {
    const failed = new DOMException(
      "Registration failed - push service not available",
      "AbortError",
    );
    expect(pushError(failed).message).toContain("Le service push de ce navigateur ne répond pas");
    expect(pushError(new DOMException("x", "NotAllowedError")).message).toContain("refusées");
    const other = new Error("Abonnement push incomplet.");
    expect(pushError(other)).toBe(other);
  });
});
