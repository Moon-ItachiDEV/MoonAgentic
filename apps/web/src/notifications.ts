// Browser notifications, on this device only: asked for in the settings, then shown when a
// thread starts waiting for the user or a team ends, while MoonAgentic stays open in a tab.
import type { Thread } from "@moonagentic/protocol";
import { connection } from "./connection.ts";
import { type Notice, noticesFor } from "./notices.ts";
import { readPref, writePref } from "./prefs.ts";
import { navigate } from "./router.ts";

/**
 * `insecure`: the page is not served over HTTPS or from this machine, where browsers refuse
 * notifications. `unsupported`: this browser has none (an iPhone outside the home screen app).
 */
export type NotificationSupport = "ok" | "insecure" | "unsupported";

export function notificationSupport(): NotificationSupport {
  if (!window.isSecureContext) return "insecure";
  return "Notification" in window ? "ok" : "unsupported";
}

/** What the browser says of this site: `granted`, `denied`, or `default` while not asked. */
export const notificationPermission = (): NotificationPermission =>
  notificationSupport() === "ok" ? Notification.permission : "denied";

/** True when the user turned them on here and the browser still allows them. */
export const notificationsOn = () =>
  readPref("notifications") === "true" && notificationPermission() === "granted";

let worker: Promise<ServiceWorkerRegistration | undefined> | undefined;
/** Phones show a notification only through a service worker; a computer does without. */
function registration(): Promise<ServiceWorkerRegistration | undefined> {
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
    icon: "/icon.svg",
    data: { threadId: notice.threadId },
  };
  try {
    const sw = await registration();
    if (sw) {
      await sw.showNotification(notice.title, options);
      return true;
    }
    const shown = new Notification(notice.title, options);
    shown.onclick = () => {
      shown.close();
      openThread(notice.threadId);
    };
    return true;
  } catch {
    return false;
  }
}

/** The thread on screen, which needs no notification while the user looks at it. */
function watchedThreadId(): string | undefined {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return undefined;
  const match = /^\/t\/([^/]+)$/.exec(location.pathname);
  try {
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

let started = false;
/** Watches the threads from now on, and notifies of what changes while this is turned on. */
export function startNotifications(): void {
  if (started) return;
  started = true;
  if (notificationsOn()) void registration();
  // A touch on a notification shown by the service worker comes back as a message.
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; threadId?: unknown } | null;
    if (data?.type === "moonagentic.open" && typeof data.threadId === "string") {
      openThread(data.threadId);
    }
  });
  let before: Thread[] | undefined;
  connection.subscribe(() => {
    const state = connection.getState();
    if (!state.ready || state.threads === before) return;
    const notices = before ? noticesFor(before, state.threads) : [];
    before = state.threads;
    if (!notices.length || !notificationsOn()) return;
    const watched = watchedThreadId();
    for (const notice of notices) if (notice.threadId !== watched) void showNotice(notice);
  });
}
