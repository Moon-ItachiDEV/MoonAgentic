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
      const page = pages[0];
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
      // Safari stops the push of a site that receives one and shows nothing: it always shows.
      const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(
        self.navigator.userAgent,
      );
      if (inFront && !safari) return;
      await self.registration.showNotification(notice.title || "MoonAgentic", {
        body: notice.body || "",
        tag: notice.tag || undefined,
        icon: "/icon.svg",
        data: { threadId: typeof notice.threadId === "string" ? notice.threadId : "" },
      });
    })(),
  );
});
