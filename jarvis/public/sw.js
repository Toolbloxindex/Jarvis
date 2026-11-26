/* Housewatch service worker: web push for new homes matching your search.
 * Payload (from core/notify.mjs): { title, body, url, tag }.
 * No offline caching on purpose: listings change every 15 minutes. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "New homes on Housewatch";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "housewatch-new",
      renotify: true,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: data.url || "/listings" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/listings", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) return client.navigate(target.href);
          return;
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
