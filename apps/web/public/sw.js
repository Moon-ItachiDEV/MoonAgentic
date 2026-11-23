// MoonAgentic's service worker shows notifications: phones only show one through it, and
// Web Push brings them while the app is closed. A touch on one brings the app back on the
// right thread. It caches nothing.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadId = event.notification.data && event.notification.data.threadId;
  const path = threadId ? `/t/${encodeURIComponent(threadId)}` : "/";
  event.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A tab showing an artifact's PDF is not the app: it would not hear the message.
      const page = pages.find((p) => !new URL(p.url).pathname.startsWith("/api/"));
      if (!page) return self.clients.openWindow(path);
      page.postMessage({ type: "moonagentic.open", threadId });
      return page.focus();
    })(),
  );
});

// A notice the server sent through Web Push, encrypted for this browser alone.
self.addEventListener("push", (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    // shown with what is known
  }
  event.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const inFront = pages.some((p) => p.visibilityState === "visible" && p.focused);
      // Apple's WebKit stops the push of a site that receives one and shows nothing: there it
      // always shows. An app on an iPhone's home screen, the only place it has push, does not
      // say « Safari », and an iPad says it is a Mac.
      const ua = self.navigator.userAgent;
      const apple =
        /iphone|ipad|ipod/i.test(ua) ||
        (/applewebkit/i.test(ua) && !/chrome|chromium|android|crios|fxios|edg/i.test(ua));
      if (inFront && !apple) return;
      await self.registration.showNotification(notice.title || "MoonAgentic", {
        body: notice.body || "",
        tag: notice.tag || undefined,
        icon: "/icon-192.png",
        data: { threadId: typeof notice.threadId === "string" ? notice.threadId : "" },
      });
    })(),
  );
});
