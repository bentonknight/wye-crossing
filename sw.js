// Minimal service worker.
//
// This exists only to satisfy Chrome's installability criteria so the native
// "Add to Home Screen" prompt (beforeinstallprompt) fires reliably — it does
// NOT provide offline support. Every request just passes straight through to
// the network, unchanged.
//
// If offline caching is added later, this is the file to extend — but that's
// a deliberate future step, not something to grow accidentally here.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
