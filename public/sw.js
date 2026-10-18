// Keeps the app shell available so the home-screen app opens quickly.
// Data and photos always come from the network.
const CACHE = "to-shell-v1";
const SHELL = ["/", "/app.js", "/shim.js", "/manifest.webmanifest", "/icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !SHELL.includes(u.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && !r.redirected) caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
