// Service worker minimal GameNime (rend le site installable, pas de cache offline)
self.addEventListener("install", function(e) { self.skipWaiting(); });
self.addEventListener("activate", function(e) { self.clients.claim(); });
self.addEventListener("fetch", function(e) { /* passthrough reseau : donnees toujours a jour */ });
