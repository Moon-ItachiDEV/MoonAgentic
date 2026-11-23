// What Web Push needs to know of this device, with nothing else loaded: pure, to test.

/**
 * `insecure`: not over HTTPS nor on this machine. `unsupported`: this browser has no push, as
 * on an iPhone outside the app added to the home screen.
 */
export type PushSupport = "ok" | "insecure" | "unsupported";

export function pushSupport(): PushSupport {
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

/** A base64url key as the browser takes it. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  const text = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
