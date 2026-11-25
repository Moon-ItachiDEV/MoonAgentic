// Browser notifications, on this device only: asked for in the settings, then shown when a
// thread starts waiting for the user or a team ends, while MoonAgentic stays open in a tab.
import { type Notice, noticesFor, settledTags, type Thread } from "@moonagentic/protocol";
import { updateNotice } from "./app-update.ts";
import { connection } from "./connection.ts";
import { desktopShell } from "./desktop.ts";
import { readPref, writePref } from "./prefs.ts";
import { navigate } from "./router.ts";

/**
 * `insecure`: the page is not served over HTTPS or from this machine, where browsers refuse
 * notifications. `unsupported`: this browser has none (an iPhone outside the home screen app).
 */
export type NotificationSupport = "ok" | "insecure" | "unsupported";

export function notificationSupport(): NotificationSupport {
  if (desktopShell()) return "ok";
  if (!window.isSecureContext) return "insecure";
  return "Notification" in window ? "ok" : "unsupported";
}

/** What the browser says of this site: `granted`, `denied`, or `default` while not asked. */
export const notificationPermission = (): NotificationPermission =>
  desktopShell() ? "granted" : notificationSupport() === "ok" ? Notification.permission : "denied";

/** True when the user turned them on here and the browser still allows them. */
export const notificationsOn = () =>
  readPref("notifications") === "true" && notificationPermission() === "granted";

let worker: Promise<ServiceWorkerRegistration | undefined> | undefined;
/** Whether this device stays quiet about one project, while it notifies of the others. */
export const projectMuted = (projectId: string) =>
  readPref(`notifications.muted.${projectId}`) === "true";

export function setProjectMuted(projectId: string, muted: boolean): void {
  writePref(`notifications.muted.${projectId}`, String(muted));
}

/** Phones show a notification only through a service worker; a computer does without. */
export function registration(): Promise<ServiceWorkerRegistration | undefined> {
  worker ??=
    "serviceWorker" in navigator
      ? navigator.serviceWorker
          .register("/sw.js")
          .then(() => navigator.serviceWorker.ready)
          .catch(() => undefined)
      : Promise.resolve(undefined);
  return worker;
}

/** Turns them on, if the browser allows it. Resolves with its answer. */
export async function enableNotifications(): Promise<NotificationPermission> {
  if (notificationSupport() !== "ok") return "denied";
  // The desktop app shows them through the system, which asks nothing of the page.
  if (desktopShell()) {
    writePref("notifications", "true");
    return "granted";
  }
  // Asked each time: a browser that already answered gives that answer back without a prompt.
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    writePref("notifications", "true");
    void registration();
  }
  return permission;
}

export function disableNotifications(): void {
  writePref("notifications", "false");
}

/** Brings the app back on that thread; the settings' trial notice names none. */
const openThread = (threadId: string) => {
  window.focus();
  if (threadId) navigate({ name: "thread", threadId });
};

/** Shows one notification; a touch on it opens its thread. False when the browser refused. */
export async function showNotice(notice: Notice): Promise<boolean> {
  const options = {
    body: notice.body,
    tag: notice.tag,
    icon: "/icon-192.png",
    data: { threadId: notice.threadId },
  };
  const desktop = desktopShell();
  if (desktop) {
    desktop.notify({
      title: notice.title,
      body: notice.body,
      tag: notice.tag,
      threadId: notice.threadId,
    });
    return true;
  }
  try {
    const sw = await registration();
    if (sw) {
      await sw.showNotification(notice.title, options);
      return true;
    }
    const shown = new Notification(notice.title, options);
    plain.get(notice.tag)?.close();
    plain.set(notice.tag, shown);
    shown.onclick = () => {
      shown.close();
      openThread(notice.threadId);
    };
    return true;
  } catch {
    return false;
  }
}

/** Notifications shown without a service worker, kept so they can be closed. */
const plain = new Map<string, Notification>();

/** Takes back a notification that has nothing left to say, wherever it is shown. */
async function closeNotice(tag: string): Promise<void> {
  const desktop = desktopShell();
  if (desktop) {
    desktop.close(tag);
    return;
  }
  plain.get(tag)?.close();
  plain.delete(tag);
  try {
    const sw = await registration();
    for (const shown of (await sw?.getNotifications({ tag })) ?? []) shown.close();
  } catch {
    // nothing to close
  }
}

/** True while the user has MoonAgentic in front of them in this tab. */
const inFront = () => document.visibilityState === "visible" && document.hasFocus();

const ASK_MS = 250;
const HOLD_MS = 3000;
/** How the tabs of this browser tell each other that one of them is in front of the user. */
const tabs = (() => {
  // A browser that has none, or refuses one here, only loses the check between tabs.
  try {
    return typeof BroadcastChannel === "function"
      ? new BroadcastChannel("moonagentic.notifications")
      : null;
  } catch {
    return null;
  }
})();

/** Resolves true when another MoonAgentic tab is in front of the user right now. */
function anotherTabInFront(): Promise<boolean> {
  if (!tabs) return Promise.resolve(false);
  const ask = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      tabs.removeEventListener("message", heard);
      clearTimeout(timer);
      resolve(answer);
    };
    const heard = (event: MessageEvent) => {
      const data = event.data as { type?: string; ask?: string } | null;
      if (data?.type === "in-front" && data.ask === ask) done(true);
    };
    const timer = setTimeout(() => done(false), ASK_MS);
    tabs.addEventListener("message", heard);
    tabs.postMessage({ type: "anyone-in-front", ask });
  });
}

/**
 * Shows a notice unless the user already sees MoonAgentic, in this tab or another: the
 * sidebar and « À traiter » tell them there. Of several tabs in the background, one shows it.
 */
async function notify(notice: Notice): Promise<void> {
  // The server sends it through Web Push, which shows it even with the app closed.
  // The desktop app has no Web Push: its window, closed or not, shows them itself.
  if (!desktopShell() && readPref("notifications.push") === "true") return;
  if (inFront() || (await anotherTabInFront())) return;
  if (!("locks" in navigator)) {
    await showNotice(notice);
    return;
  }
  await navigator.locks.request(
    `moonagentic.notice.${notice.tag}`,
    { ifAvailable: true },
    async (lock) => {
      // Another tab took it: the notice is its to show.
      if (!lock) return;
      await showNotice(notice);
      // Held a moment, so a tab that was slower to hear of the change finds it taken.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    },
  );
}

let started = false;
/** Watches the threads from now on, and notifies of what changes while this is turned on. */
export function startNotifications(): void {
  if (started) return;
  started = true;
  // A click on a notification of the desktop app brings its window back on that thread; the
  // service worker serves only browsers.
  const desktop = desktopShell();
  if (desktop) desktop.onOpen(openThread);
  else if (notificationsOn()) void registration();
  // A touch on a notification shown by the service worker comes back as a message.
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; threadId?: unknown } | null;
    if (data?.type === "moonagentic.open" && typeof data.threadId === "string") {
      openThread(data.threadId);
    }
  });
  tabs?.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; ask?: string } | null;
    if (data?.type === "anyone-in-front" && inFront()) {
      tabs.postMessage({ type: "in-front", ask: data.ask });
    }
  });
  let before: Thread[] | undefined;
  connection.subscribe(() => {
    const state = connection.getState();
    // A newer version of MoonAgentic, once per version on this device.
    const update = state.ready ? updateNotice(state.app, readPref("update.told")) : undefined;
    if (update && notificationsOn()) {
      writePref("update.told", state.app!.update.version!);
      void notify(update);
    }
    if (!state.ready || state.threads === before) return;
    const notices = before ? noticesFor(before, state.threads) : [];
    const settled = before ? settledTags(before, state.threads) : [];
    before = state.threads;
    if (!notificationsOn()) return;
    // An answer given in the app takes the notification about it away.
    for (const tag of settled) void closeNotice(tag);
    for (const notice of notices) {
      const projectId = state.threads.find((t) => t.id === notice.threadId)?.projectId;
      if (!projectId || !projectMuted(projectId)) void notify(notice);
    }
  });
}
