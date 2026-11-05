// Service worker minimal GameNime (rend le site installable, pas de cache offline)
self.addEventListener("install", function(e) { self.skipWaiting(); });
self.addEventListener("activate", function(e) { self.clients.claim(); });
self.addEventListener("fetch", function(e) { /* passthrough reseau : donnees toujours a jour */ });

// Notifications sur l'appareil (patch du 31 octobre 2026) : l'API envoie le titre de l'oeuvre, le texte, la fiche a
// ouvrir et une etiquette (une notification d'une meme famille remplace la precedente du meme titre).
self.addEventListener("push", function(e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  var titre = d.title || "GameNime";
  var opts = { body: d.body || "", icon: d.icon || "/favicon-192.png?v=4", data: { url: d.url || "/" }, lang: "fr" };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(titre, opts));
});

// un appui ouvre la fiche : l'onglet du site deja ouvert sur cette page (catalogue anime ou jeux, accueil) y va et
// passe devant (l'adresse est propre a chaque notification : la fiche se rouvre meme si l'onglet y etait deja) ; sinon
// un nouvel onglet
self.addEventListener("notificationclick", function(e) {
  e.notification.close();
  var cible = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  if (cible.origin !== self.location.origin) cible = new URL("/", self.location.origin);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(liste) {
    for (var i = 0; i < liste.length; i++) {
      var c = liste[i], u = new URL(c.url);
      if (u.origin === self.location.origin && u.pathname === cible.pathname && "navigate" in c && "focus" in c) {
        // au premier plan d'abord (l'appui ne l'autorise qu'un court instant), puis vers la fiche
        return c.focus().then(function(w) { return (w || c).navigate(cible.href); }).catch(function() { return self.clients.openWindow(cible.href); });
      }
    }
    return self.clients.openWindow(cible.href);
  }));
});

// le navigateur change l'abonnement de lui-meme (cle renouvelee) : le nouveau est donne a l'API, avec la session
self.addEventListener("pushsubscriptionchange", function(e) {
  var ancien = e.oldSubscription && e.oldSubscription.options;
  e.waitUntil(
    (e.newSubscription ? Promise.resolve(e.newSubscription) : (ancien ? self.registration.pushManager.subscribe(ancien) : Promise.reject(new Error("sans cle"))))
      .then(function(s) {
        var j = s.toJSON();
        return fetch("/api/push/abonnement", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
      })
      .catch(function() {})
  );
});
