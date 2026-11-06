// Minimal service worker: Chrome wants one (with a fetch handler) before it offers
// "Install app", which is what makes the dashboard open full-screen.
// It doesn't cache anything; every request goes straight to the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
