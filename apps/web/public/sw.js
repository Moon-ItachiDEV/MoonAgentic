// MoonAgentic's service worker has one job: phones only show a notification through one,
// and a touch on it must bring the app back on the right thread. It caches nothing.
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
