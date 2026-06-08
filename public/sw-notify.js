// JAPANESE BOT notification worker
// Handles persistent notifications + SCAN action button
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SHOW_NOTIFICATION") {
    const { title, body, tag } = data;
    self.registration.showNotification(title || "JAPANESE BOT", {
      body: body || "Tap SCAN to analyze the selected forex market",
      tag: tag || "jb-scan",
      icon: "/favicon.png",
      badge: "/favicon.png",
      requireInteraction: true,
      actions: [
        { action: "scan", title: "SCAN NOW" },
        { action: "dismiss", title: "Dismiss" },
      ],
      data: { url: "/?scan=1" },
    });
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const url = "/?scan=1";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.postMessage({ type: "TRIGGER_SCAN" });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
