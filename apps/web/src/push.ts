// Web Push on this device: the notifications that arrive while MoonAgentic is closed. The
// browser subscribes with the server's public key; the server then sends each notice through
// the browser's push service, encrypted for this browser alone.
import { connection, newId } from "./connection.ts";
import { notificationsOn, registration } from "./notifications.ts";
import { readPref, writePref } from "./prefs.ts";
import { keyBytes, mutedProjects, pushSupport } from "./push-device.ts";

export { pushSupport } from "./push-device.ts";

/** True once the user asked for them on this device. */
export const pushOn = () => readPref("notifications.push") === "true";

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((byte, i) => byte === b[i]);

async function pushManager(): Promise<PushManager> {
  const sw = await registration();
  if (!sw) throw new Error("Ce navigateur n'a pas pu lancer son service worker.");
  return sw.pushManager;
}

/** Subscribes this browser, or again with the same address, and tells the server. */
async function subscribe(): Promise<void> {
  const manager = await pushManager();
  const { publicKey } = await connection.ask({ type: "push.state", requestId: newId() });
  const key = keyBytes(publicKey);
  let sub = await manager.getSubscription();
  // Made with another server's key: of no use here.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error("Abonnement push incomplet.");
  await connection.ask({
    type: "push.subscribe",
    requestId: newId(),
    endpoint: json.endpoint,
    p256dh,
    auth,
    muted: mutedProjects(),
  });
}

/** Turns them on: asks the browser, then the server. Rejects with why it could not. */
export async function enablePush(): Promise<void> {
  if (pushSupport() !== "ok") throw new Error("Ce navigateur ne reçoit pas de notifications push.");
  await subscribe();
  writePref("notifications.push", "true");
}

export async function disablePush(): Promise<void> {
  writePref("notifications.push", "false");
  const sub = await (await pushManager()).getSubscription();
  if (!sub) return;
  await connection.ask({ type: "push.unsubscribe", requestId: newId(), endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/** Whether the server reaches this browser now. */
export async function pushReached(): Promise<boolean> {
  if (pushSupport() !== "ok") return false;
  const sub = await (await pushManager()).getSubscription();
  if (!sub) return false;
  const state = await connection.ask({
    type: "push.state",
    requestId: newId(),
    endpoint: sub.endpoint,
  });
  return state.subscribed;
}

/**
 * Says again where this browser is reached and what it mutes: after a project is muted, and
 * once connected, as the browser may have changed its address meanwhile.
 */
export function syncPush(): void {
  if (!pushOn() || !notificationsOn() || pushSupport() !== "ok") return;
  subscribe().catch(() => undefined);
}

let started = false;
/** Says it once the server answers, at each start of the app. */
export function startPush(): void {
  if (started) return;
  started = true;
  const stop = connection.subscribe(() => {
    if (!connection.getState().ready) return;
    stop();
    syncPush();
  });
}
