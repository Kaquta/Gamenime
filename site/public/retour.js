/* RETOUR — la pastille qui confirme une action, ou dit pourquoi elle n'a pas marché (patch du 4 novembre 2026, copie de la
   maquette validée par Rey). window.gnRetour(texte, { type: "ko", detail, action, surAction, duree }).
   Un retour peut aussi être annoncé par la page d'avant (window.gnRetourPlusTard, gardé dans sessionStorage « gn-retour »),
   ou par l'API au retour de Google ou de Discord (?gn=<code>-<fournisseur>, retiré de l'adresse dès la lecture ; le code reste
   dans window.__gnCode pour le menu du compte, qui rouvre Mon compte après une liaison). */
(function () {
  if (window.gnRetour) return;
  var el = null, minuteur = 0;
  var COCHE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fermer() { if (el) el.classList.remove("est-la"); }
  window.gnRetour = function (texte, o) {
    o = o || {};
    if (!document.body) return;
    if (!el) {
      el = document.createElement("div");
      el.className = "gn-retour";
      document.body.appendChild(el);
      void el.offsetWidth;   // l'état de départ (cachée) est posé avant la première apparition : pas de glissement de côté
    }
    // un tiroir ouvert sur un grand écran : la pastille se pose au bas du tiroir, là où l'action a eu lieu
    // (sa place sans l'animation d'ouverture : offsetLeft et offsetWidth ne tiennent pas compte du transform)
    var t = document.querySelector(".drawer-panel.is-open, .notif-drawer.is-open");
    var r = t && window.innerWidth > 640 ? { left: t.offsetLeft, width: t.offsetWidth } : null;
    el.style.left = r ? Math.round(r.left + r.width / 2) + "px" : "";
    el.style.maxWidth = r ? Math.round(r.width - 32) + "px" : "";
    var ko = o.type === "ko";
    el.className = "gn-retour" + (ko ? " gn-retour--ko" : "");
    el.setAttribute("role", ko ? "alert" : "status");
    el.innerHTML = '<span class="gn-retour__ic">' + (ko ? "!" : COCHE) + '</span><span class="gn-retour__tx">' + esc(texte) +
      (o.detail ? "<small>" + esc(o.detail) + "</small>" : "") + "</span>" +
      (o.action ? '<button type="button" class="gn-retour__act">' + esc(o.action) + "</button>" : "");
    var b = el.querySelector(".gn-retour__act");
    if (b) b.addEventListener("click", function () { fermer(); if (o.surAction) o.surAction(); });
    void el.offsetWidth;
    el.classList.add("est-la");
    clearTimeout(minuteur);
    minuteur = setTimeout(fermer, o.duree || (ko ? 7000 : 3500));
  };
  window.gnRetourPlusTard = function (texte, o) {
    try { sessionStorage.setItem("gn-retour", JSON.stringify({ t: texte, o: o || {} })); } catch (e) {}
  };

  // ce que l'API annonce au retour de Google ou de Discord (les erreurs d'une connexion vont, elles, sur la page
  // Connexion ou Inscription : ?erreur=..., lu par la page)
  var NOMS = { google: "Google", discord: "Discord" };
  var CODES = {
    "connecte": function (f, nom) { return ["Connecté avec " + f, nom ? { detail: "Content de te revoir, " + nom } : {}]; },
    "relie": function (f) { return ["Connecté avec " + f, { detail: f + " est maintenant lié à ton compte" }]; },
    "bienvenue": function (f) { return ["Bienvenue sur GameNime", { detail: "Ton compte est créé avec " + f }]; },
    "lie": function (f) { return [f + " est lié à ton compte", { detail: "Tu peux maintenant te connecter avec " + f }]; },
    "deja-lie": function (f) { return ["Ce compte " + f + " est déjà lié à un autre compte GameNime", { type: "ko" }]; },
    "annule": function (f) { return ["Liaison avec " + f + " annulée", { type: "ko", detail: "Rien n'a été changé" }]; },
    "echec": function (f) { return ["La liaison avec " + f + " n'a pas abouti", { type: "ko", detail: "Rien n'a été changé : réessaie dans un instant" }]; },
    "email": function (f) {
      return f === "Discord" ? ["Ton compte Discord n'a pas d'e-mail vérifié", { type: "ko", detail: "Vérifie-le dans Discord, puis réessaie" }]
                             : ["Ton adresse Google n'est pas vérifiée", { type: "ko", detail: "Vérifie-la chez Google, puis réessaie" }];
    },
    "indisponible": function (f) { return ["La liaison avec " + f + " n'est pas encore disponible", { type: "ko" }]; },
    "confirmer": function (f) { return ["Confirme d'abord ton adresse e-mail", { type: "ko", detail: "Ensuite, tu pourras lier " + f }]; },
    "trop": function () { return ["Trop d'essais : réessaie dans 15 minutes", { type: "ko" }]; }
  };
  // lu tout de suite, avant les scripts de la page : le menu du compte sait ainsi d'où l'on revient
  var code = null;
  try {
    var u = new URL(location.href), g = u.searchParams.get("gn");
    if (g !== null) {
      var m = /^(connecte|relie|bienvenue|lie|deja-lie|annule|echec|email|indisponible|confirmer|trop)-(google|discord)$/.exec(g);
      if (m) code = { code: m[1], f: m[2] };
      u.searchParams.delete("gn");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    }
  } catch (e) {}
  window.__gnCode = code;
  function montrer(x) { window.gnRetour(x[0], x[1]); }
  function annonces() {
    var garde = null;
    try { garde = sessionStorage.getItem("gn-retour"); if (garde) sessionStorage.removeItem("gn-retour"); } catch (e) {}
    if (code) {
      var f = NOMS[code.f], fait = CODES[code.code];
      var moi = window.__gnMoi;
      if (moi && typeof moi.then === "function") {
        // le menu lit le compte : d'abord le pseudo (« Content de te revoir, Rey »), et Mon compte rouvert après une
        // liaison, pour que la pastille se pose dans le tiroir ; au plus 2,5 s d'attente
        var parti = false;
        var t = setTimeout(function () { if (!parti) { parti = true; montrer(fait(f, "")); } }, 2500);
        var finir = function (u) {
          if (parti) return;
          parti = true; clearTimeout(t);
          montrer(fait(f, u ? String(u.displayName || "").trim() || String(u.email || "").split("@")[0] : ""));
        };
        moi.then(finir, function () { finir(null); });
      } else {
        montrer(fait(f, ""));
      }
      return;
    }
    if (garde) {
      try { var r = JSON.parse(garde); if (r && r.t) window.gnRetour(String(r.t), r.o || {}); } catch (e) {}
    }
  }
  // après tous les scripts de la page (le menu du compte pose window.__gnMoi) : DOMContentLoaded vient après eux ;
  // load au cas où ce script arriverait plus tard
  var lance = false;
  function une() { if (lance) return; lance = true; annonces(); }
  if (document.readyState === "complete") setTimeout(une, 0);
  else { document.addEventListener("DOMContentLoaded", une); window.addEventListener("load", une); }
})();
