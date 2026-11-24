// What Web Push needs to know of this device, with nothing else loaded: pure, to test.
import { desktopShell } from "./desktop.ts";

/**
 * `insecure`: not over HTTPS nor on this machine. `unsupported`: this browser has no push, as
 * on an iPhone outside the app added to the home screen. `desktop`: MoonAgentic's desktop app,
 * where Chromium has no push service, and none is needed: closing its window only hides it.
 */
export type PushSupport = "ok" | "insecure" | "unsupported" | "desktop";

export function pushSupport(): PushSupport {
  if (desktopShell()) return "desktop";
  if (!window.isSecureContext) return "insecure";
  return "serviceWorker" in navigator && "PushManager" in window ? "ok" : "unsupported";
}

const MUTED_PREFIX = "moonagentic.notifications.muted.";

/** The projects this device stays quiet about, as the server must know to skip them. */
export function mutedProjects(): string[] {
  const muted: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(MUTED_PREFIX) && localStorage.getItem(key) === "true") {
        muted.push(key.slice(MUTED_PREFIX.length));
      }
    }
  } catch {
    // storage unavailable: nothing muted
  }
  return muted.sort();
}

/**
 * Why a subscription failed, said plainly: Chromium's own words name no browser. It fails so
 * where no push service answers, as in Brave or a Chromium without Google's services.
 */
export function pushError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (/push service/i.test(message)) {
    return new Error(
      "Le service push de ce navigateur ne répond pas : il n'en a pas (Brave, Chromium sans services Google) ou il est bloqué. Essaie Chrome, Edge, Firefox ou Safari.",
    );
  }
  if (e instanceof Error && e.name === "NotAllowedError") {
    return new Error(
      "Notifications refusées par le navigateur pour ce site : autorise-les dans ses réglages.",
    );
  }
  return e instanceof Error ? e : new Error(message);
}

/** A base64url key as the browser takes it. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  const text = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
