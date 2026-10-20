"use strict";

// No dashboard data is cached. Push can wake this worker with every page closed.
self.addEventListener("push", (event) => {
  const value = event.data?.json();
  if (!value?.title || !value?.body) return;
  event.waitUntil(self.registration.showNotification(String(value.title).slice(0, 100), {
    body: String(value.body).slice(0, 600), tag: String(value.tag || "quota").slice(0, 80), data: { url: "/" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL("/", self.location.origin).href;
    const existing = windows.find((client) => client.url === target);
    if (existing) await existing.focus();
    else await self.clients.openWindow(target);
  })());
});
