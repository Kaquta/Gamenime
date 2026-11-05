/* PUSH — notifications sur l'appareil (patch du 31 octobre 2026, copie de la maquette validee par Rey le 30 octobre).
   Le balisage et les textes sont ceux de la maquette ; l'etat vient du navigateur (Notification.permission,
   PushManager, mode ecran d'accueil sur iPhone) et de l'abonnement enregistre par l'API (/api/push/...).
   Trois endroits, comme la maquette : l'invitation juste apres un coeur (jamais a la premiere visite ; « Plus tard » :
   pas avant 30 jours), une carte en haut de la cloche, une ligne dans Mon compte et dans Mes preferences. */
(function () {
  if (window.__gnPush) return;
  window.__gnPush = true;
  var API = "/api";
  var UA = navigator.userAgent || "";
  var IPAD = /iPad/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var IOS = IPAD || /iPhone|iPod/.test(UA);
  var SUPPORT = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  // un telephone d'apres le navigateur (un ordinateur tactile ou une fenetre etroite reste « cet ordinateur »)
  var TEL = /Android|iPhone|iPod|Mobile|Windows Phone/i.test(UA);
  var APPAREIL = IOS ? (IPAD ? "cet iPad" : "cet iPhone") : TEL ? "ce téléphone" : "cet ordinateur";
  var COURT = IOS ? (IPAD ? "Sur cet iPad" : "Sur cet iPhone") : TEL ? "Sur ce téléphone" : "Sur cet ordinateur";
  var NOM_IOS = IPAD ? "iPad" : "iPhone";
  var PLUS_TARD = "gn-push-plus-tard";
  // etat : "ios" (iPhone, site pas installe), "bloque", "actif", "propose", "aucun" (navigateur sans notifications)
  var ETAT = IOS && !SUPPORT ? "ios" : !SUPPORT ? "aucun" : Notification.permission === "denied" ? "bloque" : "propose";
  var ABO = null;

  function svg(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  }
  // icones du site : cloche (NotificationDrawer), episode et date (ntType de la cloche) ; une seule nouvelle : l'appareil
  var CLOCHE = '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>';
  var EPISODE = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M7 4v5M17 4v5"/>';
  var DATE = '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>';
  var APP = '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>';
  var ORDI = '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>';
  var IC_APP = TEL || IOS ? APP : ORDI;
  var PARTAGER = '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/>';
  var PIED = "Tu peux couper quand tu veux dans <a href=\"/account/preferences/\">Mes préférences</a>.";

  function esc(s) { return String(s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function poster(chemin, corps) {
    return fetch(API + chemin, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(corps || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d.__code = r.status; return d; }); });
  }
  function cle(b64) {
    var s = (b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    var b = atob(s), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function plusTard() { try { var t = Number(localStorage.getItem(PLUS_TARD) || 0); return t && Date.now() - t < 30 * 864e5; } catch (e) { return false; } }
  function noterPlusTard() { try { localStorage.setItem(PLUS_TARD, String(Date.now())); } catch (e) {} }

  // ── l'abonnement de cet appareil ──
  function inscription() { return SUPPORT ? navigator.serviceWorker.ready : Promise.reject(new Error("non")); }
  function relire() {
    if (!SUPPORT) return Promise.resolve(ETAT);
    if (Notification.permission === "denied") { ETAT = "bloque"; return Promise.resolve(ETAT); }
    return inscription().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) {
      ABO = s;
      if (!s) { ETAT = "propose"; return ETAT; }
      return poster("/push/etat", { endpoint: s.endpoint }).then(function (d) { ETAT = d && d.actif ? "actif" : "propose"; return ETAT; });
    }).catch(function () { return ETAT; });
  }
  function activer() {
    if (!SUPPORT) return Promise.reject(new Error("non"));
    return Notification.requestPermission().then(function (p) {
      if (p !== "granted") { ETAT = p === "denied" ? "bloque" : "propose"; throw new Error(p); }
      return Promise.all([inscription(), fetch(API + "/push/cle", { credentials: "include" }).then(function (r) { return r.json(); })]);
    }).then(function (x) {
      var reg = x[0], k = x[1] && x[1].cle;
      if (!k) throw new Error("cle");
      var opts = { userVisibleOnly: true, applicationServerKey: cle(k) };
      // un ancien abonnement fait avec une autre cle : refait
      return reg.pushManager.subscribe(opts).catch(function () {
        return reg.pushManager.getSubscription().then(function (s) { return s ? s.unsubscribe() : null; }).then(function () { return reg.pushManager.subscribe(opts); });
      });
    }).then(function (s) {
      ABO = s;
      var j = s.toJSON();
      return poster("/push/abonnement", { endpoint: j.endpoint, keys: j.keys });
    }).then(function (d) {
      if (!d || !d.ok) throw new Error("api");
      ETAT = "actif";
      majLignes();
      return ETAT;
    });
  }
  function desactiver() {
    var s = ABO;
    var fin = function () { ETAT = SUPPORT && Notification.permission === "denied" ? "bloque" : "propose"; ABO = null; majLignes(); return ETAT; };
    if (!s) return relire().then(fin);
    return poster("/push/desabonnement", { endpoint: s.endpoint }).catch(function () {}).then(function () { return s.unsubscribe().catch(function () {}); }).then(fin);
  }

  // ── 1. l'invitation, juste apres un coeur ──
  var invite = null;
  function fermer() { if (invite) { invite.classList.add("gn-cache"); var i = invite; invite = null; setTimeout(function () { i.remove(); }, 300); } }
  function panneau(html) {
    var el = document.createElement("div");
    el.className = "gn-push gn-cache";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-labelledby", "gnPushT");
    el.innerHTML = html;
    document.body.appendChild(el);
    invite = el;
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove("gn-cache"); }); });
    return el;
  }
  function etapesIos(intro) {
    if (invite) return;
    var el = panneau(
      '<div class="gn-push__tete"><span class="gn-push__ic">' + svg(CLOCHE) + '</span><h2 class="gn-push__t" id="gnPushT">Sur ' + NOM_IOS + ', une étape avant</h2></div>' +
      '<button class="gn-push__x" type="button" aria-label="Fermer">✕</button>' +
      '<p class="gn-push__txt">' + intro + 'Pour être prévenu sur ' + APPAREIL + ', même site fermé, ajoute GameNime à ton écran d’accueil :</p>' +
      '<ol class="gn-push__etapes">' +
      '<li><span>Touche <strong>Partager</strong>' + '<span class="gn-ios-partager">' + svg(PARTAGER) + '</span> dans Safari</span></li>' +
      '<li><span>Choisis <strong>Sur l’écran d’accueil</strong></span></li>' +
      '<li><span>Ouvre GameNime depuis l’icône : on te proposera d’activer</span></li></ol>' +
      '<div class="gn-push__acts"><button class="gn-push__non gn-push__non--seul" type="button">Compris</button></div>');
    // apres un coeur, fermer vaut « Plus tard » (comme l'autre panneau) ; ouvert depuis « Comment ? », non
    el.querySelector(".gn-push__x").addEventListener("click", function () { if (intro) noterPlusTard(); fermer(); });
    el.querySelector(".gn-push__non").addEventListener("click", function () { noterPlusTard(); fermer(); });
  }
  function inviter(titre) {
    if (invite || plusTard() || (ETAT !== "propose" && ETAT !== "ios")) return;
    if (ETAT === "ios") return etapesIos("Tu suis maintenant <strong>" + esc(titre) + "</strong>. ");
    var el = panneau(
      '<div class="gn-push__tete"><span class="gn-push__ic">' + svg(CLOCHE) + '</span><h2 class="gn-push__t" id="gnPushT">Être prévenu sur ' + APPAREIL + ' ?</h2></div>' +
      '<button class="gn-push__x" type="button" aria-label="Fermer">✕</button>' +
      '<p class="gn-push__txt">Tu suis maintenant <strong>' + esc(titre) + '</strong>. Reçois ses alertes sur ' + APPAREIL + ', même site fermé :</p>' +
      '<ul class="gn-push__quoi"><li>' + svg(EPISODE) + 'Chaque épisode</li><li>' + svg(CLOCHE) + 'Le jour de la sortie</li><li>' + svg(DATE) + 'Si la date change</li></ul>' +
      '<div class="gn-push__acts"><button class="gn-push__oui" type="button">Activer</button><button class="gn-push__non" type="button">Plus tard</button></div>' +
      '<p class="gn-push__pied">' + PIED + "</p>");
    el.querySelector(".gn-push__x").addEventListener("click", function () { noterPlusTard(); fermer(); });
    el.querySelector(".gn-push__non").addEventListener("click", function () { noterPlusTard(); fermer(); });
    var oui = el.querySelector(".gn-push__oui");
    oui.addEventListener("click", function () {
      oui.disabled = true;
      // la demande du navigateur fermee sans reponse : comme « Plus tard » (sinon elle reviendrait a chaque coeur)
      activer().then(function () { fait(el); }, function () { if (SUPPORT && Notification.permission === "default") noterPlusTard(); majLignes(); fermer(); });
    });
  }
  // apres « Activer » (et l'accord du navigateur) : la confirmation, puis le panneau se ferme seul
  function fait(el) {
    el.innerHTML =
      '<div class="gn-push__tete"><span class="gn-push__ic">' + svg('<path d="M20 6 9 17l-5-5"/>') + '</span><h2 class="gn-push__t" id="gnPushT">C’est activé sur ' + APPAREIL + '</h2></div>' +
      '<p class="gn-push__txt">La prochaine alerte arrivera ici, même site fermé. Un appui ouvre la fiche.</p>' +
      '<p class="gn-push__pied">' + PIED + "</p>";
    setTimeout(fermer, 4000);
  }

  // la deconnexion : cet appareil ne recoit plus rien de ce compte (desabonne pendant que la session existe encore,
  // keepalive : la demande va au bout meme si la page se recharge) ; le navigateur n'est desabonne que si l'API a bien
  // retire l'abonnement de CE compte (un autre compte qui a active cet appareil le garde) ; 5 s au plus
  function avantDeconnexion() {
    if (!SUPPORT) return Promise.resolve();
    var fait = navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(function (s) {
      if (!s) return;
      return fetch0(API + "/push/desabonnement", { method: "POST", credentials: "include", keepalive: true, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ endpoint: s.endpoint }) })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) { if (d && d.retire > 0) return s.unsubscribe().catch(function () {}); });
    }).catch(function () {});
    return Promise.race([fait, new Promise(function (r) { setTimeout(r, 5000); })]);
  }
  // le coeur : l'invitation suit la reponse de l'API (POST /favorites reussi)
  var fetch0 = window.fetch;
  window.fetch = function (url, opts) {
    var self = this, args = arguments;
    try {
      if (opts && String(opts.method || "").toUpperCase() === "POST" && /\/auth\/logout\/?$/.test(String(url))) {
        return avantDeconnexion().then(function () { return fetch0.apply(self, args); });
      }
    } catch (e) {}
    var p = fetch0.apply(this, arguments);
    try {
      if (opts && String(opts.method || "").toUpperCase() === "POST" && /\/favorites\/?$/.test(String(url))) {
        var corps = JSON.parse(opts.body || "{}");
        p.then(function (r) {
          if (!r.ok) return;
          // le coeur de ce titre-la (un anime et un jeu peuvent avoir le meme numero)
          var sel = '.fav-heart[data-fav-id="' + Number(corps.itemId) + '"]' + (corps.itemType === "anime" ? '[data-fav-type="anime"]' : ':not([data-fav-type="anime"])');
          var coeur = document.querySelector(sel);
          var t = coeur && coeur.closest(".item-card");
          var titre = t ? (t.querySelector(".item-link") || t.querySelector("h3") || {}).textContent : "";
          relire().then(function () { setTimeout(function () { inviter((titre || "ce titre").trim()); }, 350); });
        });
      }
    } catch (e) {}
    return p;
  };

  // ── 2. la cloche : une carte en haut du tiroir, tant que rien n'est active sur cet appareil ──
  function carteCloche() {
    var dr = document.getElementById("notifDrawer");
    if (!dr) return;
    var vieille = dr.querySelector(".gn-push-carte");
    if (ETAT !== "propose" && ETAT !== "ios") { if (vieille) vieille.remove(); return; }
    if (vieille) return;
    var acts = dr.querySelector(".nt-acts");
    if (!acts) return;
    var c = document.createElement("div");
    c.className = "gn-push-carte";
    c.innerHTML = ETAT === "ios"
      ? '<span class="gn-push-carte__ic">' + svg(APP) + '</span><span class="gn-push-carte__b"><strong>Aussi sur ' + APPAREIL + '</strong><small>Ajoute d’abord GameNime à l’écran d’accueil</small></span><button class="gn-push-carte__oui" type="button">Comment ?</button>'
      : '<span class="gn-push-carte__ic">' + svg(IC_APP) + '</span><span class="gn-push-carte__b"><strong>Aussi sur ' + APPAREIL + '</strong><small>Les mêmes alertes, même site fermé</small></span><button class="gn-push-carte__oui" type="button">Activer</button>';
    acts.parentNode.insertBefore(c, acts);
    var b = c.querySelector(".gn-push-carte__oui");
    b.addEventListener("click", function () {
      if (ETAT === "ios") return etapesIos("");
      b.disabled = true;
      activer().then(function () { c.remove(); }, function () { b.disabled = false; majLignes(); });
    });
  }
  document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("#notifBell")) relire().then(function () { setTimeout(carteCloche, 30); }); });

  // ── 3. Mes preferences : la ligne de l'appareil, sous « Notifications par email » ──
  function etat() {
    if (ETAT === "actif") return { on: true, off: false, txt: "Activé sur " + APPAREIL + ". Épisodes, jour de sortie et dates qui changent, même site fermé. <a href=\"#\" class=\"gn-push-essai\">Envoyer une notification d’essai</a>" };
    if (ETAT === "bloque") return { on: false, off: true, ko: true, txt: "Bloqué par le navigateur. Pour réactiver : réglages du navigateur › Notifications › " + esc(location.hostname) };
    if (ETAT === "ios") return { on: false, off: true, txt: "Sur " + NOM_IOS + ", ajoute d’abord GameNime à l’écran d’accueil. <a href=\"#\" class=\"gn-push-comment\">Comment ?</a>" };
    return { on: false, off: false, txt: "Épisodes, jour de sortie et dates qui changent, même site fermé." };
  }
  function lignePrefs() {
    var mail = document.getElementById("emailChannelRow");
    if (!mail || ETAT === "aucun") return;
    var e = etat();
    var l = document.getElementById("pushChannelRow");
    if (!l) {
      l = document.createElement("label");
      l.id = "pushChannelRow";
      mail.parentNode.insertBefore(l, mail.nextSibling);
    }
    l.className = "prefs-channel-row" + (e.off ? " gn-push-off" : "");
    l.innerHTML =
      '<div class="prefs-channel-info"><span class="prefs-channel-icon"><svg class="pg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + IC_APP + '</svg></span>' +
      '<div><strong>Notifications sur ' + APPAREIL + '</strong><small class="gn-push-etat' + (e.ko ? " gn-push-etat--ko" : "") + '">' + e.txt + "</small></div></div>" +
      '<label class="prefs-switch"><input type="checkbox" id="togglePush"' + (e.on ? " checked" : "") + (e.off ? " disabled" : "") + ' /><span class="prefs-switch-slider"></span></label>';
  }
  // ── 4. Mon compte (menu du profil) : la meme ligne, sous « Par email » ──
  function ligneCompte() {
    var mail = document.querySelector(".acc-tog #toggleEmail");
    if (!mail || ETAT === "aucun") return;
    var e = etat();
    var l = document.getElementById("gnPushAcc");
    if (!l) {
      l = document.createElement("label");
      l.id = "gnPushAcc";
      var t = mail.closest(".acc-tog");
      t.parentNode.insertBefore(l, t.nextSibling);
    }
    l.className = "acc-tog" + (e.off ? " gn-push-off" : "");
    var sous = ETAT === "actif" ? "Activé · même site fermé" : ETAT === "bloque" ? "Bloqué par le navigateur" : ETAT === "ios" ? "Ajoute d’abord GameNime à l’écran d’accueil" : "Même site fermé";
    l.innerHTML = '<span class="acc-tb">' + COURT + '<small' + (e.ko ? ' class="gn-push-etat--ko"' : "") + ">" + sous + '</small></span><input type="checkbox" id="togglePushAcc"' + (e.on ? " checked" : "") + (e.off ? " disabled" : "") + ' /><span class="acc-sw"></span>';
  }
  var MAJ = false;
  function majLignes() {
    MAJ = true;
    try { if (document.getElementById("pushChannelRow")) lignePrefs(); if (document.getElementById("gnPushAcc")) ligneCompte(); carteCloche(); } finally { MAJ = false; }
  }
  // les bascules et les liens des deux lignes
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || (t.id !== "togglePush" && t.id !== "togglePushAcc")) return;
    t.disabled = true;
    (t.checked ? activer() : desactiver()).then(majLignes, majLignes);
  });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest(".gn-push-essai, .gn-push-comment");
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains("gn-push-comment")) return etapesIos("");
    if (!ABO) return;
    a.textContent = "Envoi…";
    poster("/push/essai", { endpoint: ABO.endpoint }).then(function (d) {
      a.textContent = d && d.ok ? "Envoyée : regarde tes notifications" : d && d.__code === 429 ? "Attends quelques secondes" : "Pas envoyée : réessaie plus tard";
    }, function () { a.textContent = "Pas envoyée : réessaie plus tard"; });
  });
  new MutationObserver(function () {
    if (MAJ) return;
    if (!document.getElementById("pushChannelRow") && document.getElementById("emailChannelRow")) lignePrefs();
    if (!document.getElementById("gnPushAcc") && document.querySelector(".acc-tog #toggleEmail")) ligneCompte();
  }).observe(document.documentElement, { childList: true, subtree: true });
  relire().then(majLignes);
  lignePrefs();
  ligneCompte();
})();
