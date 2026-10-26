/* Bloc « Univers » en bas de la fiche (modal et page d'une fiche) : la variante C · Frise, retenue par Rey le
   16 octobre 2026 et validée le 23 octobre (maquette v3 : « en bas de Description j'aime beaucoup, que ce soit sur
   ordinateur ou téléphone »). Le code de la maquette (univers.js) tel quel, avec ce que le site fournit : la date du
   jour et la fenêtre du radar (année en cours et suivante) au moment du rendu, les jaquettes servies par l'API
   (champ « univers » des fiches, module des licences), simplifyPlatform de lib/fiche.ts. Styles : global.css, bloc
   UNIVERS-DEBUT … FIN. Le bouton « Suivre l'univers » viendra avec les abonnements (étape 7 du plan) : pas avant. */

// la date du jour et la fenetre du radar (annee en cours et suivante), reglees a chaque rendu (regler)
var AUJ = "2026-01-01", AN = 2026, DEBUT = Date.UTC(2026, 0, 1), FIN = Date.UTC(2028, 0, 1);
function regler() {
  var d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1, j = d.getDate();
  AUJ = y + "-" + (m < 10 ? "0" : "") + m + "-" + (j < 10 ? "0" : "") + j;
  AN = y; DEBUT = Date.UTC(y, 0, 1); FIN = Date.UTC(y + 2, 0, 1);
}
// simplifyPlatform de lib/fiche.ts (passe par universHtml : pas d'import croise)
var SIMPLIFIER = function (p) { return p; };
var MOIS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
var MOIS_COURT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
// les formats du site (lib/fiche.ts, FORMATS_ANIME)
var FORMATS = { TV: "Série TV", MOVIE: "Film", OVA: "OVA", ONA: "ONA", SPECIAL: "Spécial", TV_SHORT: "Court" };
// les types de jeu d'IGDB (game_type) : le libelle court d'un repere
var FORMATS_JEU = { "Main Game": "Jeu", "Remake": "Remake", "Remaster": "Remaster", "Standalone Expansion": "Extension",
  "Expansion": "Extension", "Expanded Game": "Édition", "Port": "Portage", "Episode": "Épisode", "Season": "Saison",
  "Bundle": "Compilation", "DLC/Addon": "DLC", "Pack": "Pack", "Update": "Mise à jour", "Mod": "Mod", "Fork": "Jeu" };
// l'origine d'un anime (source AniList) : « D'apres le manga d'Eiichirou Oda », « D'apres le jeu Ghost of Tsushima »
var ORIGINES = { MANGA: "manga", LIGHT_NOVEL: "light novel", NOVEL: "roman", WEB_NOVEL: "web novel", VISUAL_NOVEL: "visual novel",
  VIDEO_GAME: "jeu", GAME: "jeu", ONE_SHOT: "one shot", COMIC: "comic", PICTURE_BOOK: "livre illustré" };
// l'icone des notifications du site (NotificationDrawer.astro), telle quelle
var CLOCHE = '<svg class="pg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function jma(s) { var p = String(s).split("-"); return [+p[0], +p[1], +p[2]]; }
function jour(s) { var p = jma(s); return Date.UTC(p[0], p[1] - 1, p[2]); }

// Periode couverte par la date, selon sa precision : [debut, fin[ en ms. Une serie en cours commencee
// avant la fenetre court jusqu'a aujourd'hui.
function periode(it) {
  if (!it.date) return null;
  var p = jma(it.date);
  if (it.enCours && jour(it.date) < DEBUT) return [jour(it.date), jour(AUJ) + 86400000];
  if (it.prec === "year") return [Date.UTC(p[0], 0, 1), Date.UTC(p[0] + 1, 0, 1)];
  if (it.prec === "month") return [Date.UTC(p[0], p[1] - 1, 1), Date.UTC(p[0], p[1], 1)];
  return [jour(it.date), jour(it.date) + 86400000];
}
// Place sur la piste (0 a 100) : point pour un jour, segment pour un mois, une annee ou une serie en cours.
function place(it) {
  var r = periode(it);
  // « Date a annoncer », ou une date apres la fenetre : au bout de la piste, sans repere
  if (!r || r[0] >= FIN) return { debut: 100, fin: 100, ancre: 100, horsPiste: true, apres: !!r };
  var w = FIN - DEBUT;
  var a = Math.min(100, Math.max(0, (r[0] - DEBUT) / w * 100)), b = Math.max(a, Math.min(100, (r[1] - DEBUT) / w * 100));
  return { debut: a, fin: b, ancre: it.prec === "day" && !it.enCours ? a : (a + b) / 2, avant: r[0] < DEBUT };
}
function sorti(it) { var r = periode(it); return !!r && !it.enCours && r[1] <= jour(AUJ); }

// La date avec l'annee (le bloc couvre deux ans), au vocabulaire des cartes (dateBox) : « courant 2027 »,
// « février 2027 », « Date à annoncer » ; la pastille seulement pour un jour confirme.
function quand(it) {
  if (!it.date) return { val: '<span class="dval vague">Date à annoncer</span>', cd: "" };
  var p = jma(it.date), y = p[0], m = p[1], d = p[2];
  if (it.enCours && jour(it.date) < DEBUT) return { val: '<span class="dval">depuis ' + y + "</span>", cd: '<span class="dcd">en cours</span>' };
  if (it.prec === "year") return { val: '<span class="dval vague">courant ' + y + "</span>", cd: "" };
  if (it.prec === "month") return { val: '<span class="dval vague">' + MOIS_LONG[m - 1] + " " + y + "</span>", cd: "" };
  var j = Math.round((jour(it.date) - jour(AUJ)) / 86400000), cd;
  if (j < 0) cd = '<span class="dcd past">sorti</span>';
  else if (j === 0) cd = '<span class="dcd"><i></i>aujourd’hui</span>';
  else if (j === 1) cd = '<span class="dcd"><i></i>demain</span>';
  else if (j <= 15) cd = '<span class="dcd">' + j + " j</span>";
  else cd = '<span class="dcd far">dans ' + j + " j</span>";
  return { val: '<span class="dval">' + d + " " + MOIS_LONG[m - 1] + " " + y + "</span>", cd: cd };
}

// « Série TV · Netflix, ADN », « Jeu · PC, Switch 2 +3 », « Film » : le type, puis au plus deux plateformes,
// abregees comme sur les cartes (simplifyPlatform du site).
var RANG = { "PC": 0, "PS6": 1, "PS5": 1, "PS4": 1, "Xbox X|S": 2, "Xbox One": 2, "Switch 2": 3, "Switch": 3, "Nintendo": 3, "Mac": 4, "Linux": 4, "iOS": 5, "Android": 5 };
function typeDe(it) {
  if (it.domaine === "games") return it.fan ? "Jeu de fans" : "Jeu";
  return FORMATS[it.format] || "Anime";
}
function sousTitre(it) {
  var l = String(SIMPLIFIER(it.plateformes) || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  l.sort(function (a, b) { return (RANG[a] === undefined ? 9 : RANG[a]) - (RANG[b] === undefined ? 9 : RANG[b]); });
  var p = l.slice(0, 2).join(", ") + (l.length > 2 ? " +" + (l.length - 2) : "");
  return esc(typeDe(it)) + (p ? " · " + esc(p) : "");
}
function vignette(it) { return '<span class="uv-mv">' + (it.jaquette ? '<img src="' + esc(it.jaquette) + '" alt="" loading="lazy">' : "") + "</span>"; }
function classeMarque(it, ici) {
  var pl = place(it);
  return "uv-f-m " + (it.enCours && pl.avant ? "encours" : it.prec === "day" ? "jour" : it.prec === "month" ? "mois" : "an") +
    (sorti(it) ? " sorti" : "") + (ici ? " ici" : "");
}
function marque(it, ici) { return place(it).horsPiste ? "" : '<b class="' + classeMarque(it, ici) + '"></b>'; }

// Etiquette : la fiche ouverte n'est pas un lien, elle porte « cette fiche » a la place du type.
function etiquette(it, ici, style) {
  var q = quand(it), lien = !ici && it.lien, b = lien ? "a" : "div";
  return "<" + b + (style ? ' style="' + style + '"' : "") + ' class="uv-f-etiq' + (ici ? " ici" : "") + '"' + (lien ? ' href="' + esc(it.lien) + '"' : "") + ">" +
    vignette(it) +
    '<span class="uv-tx"><span class="uv-nom">' + esc(it.titre) + '</span><span class="uv-sous">' + (ici ? '<span class="hpill">cette fiche</span>' : sousTitre(it)) + "</span>" +
    '<span class="uv-quand">' + q.val + q.cd + "</span></span></" + b + ">";
}

// Le champ « univers » de l'API (module des licences), mis a la forme du bloc. Une serie (pas un film, un special ni un
// OVA) commencee avant la fenetre, que l'API ne dit ni terminee ni annulee, est en cours ; une autre sortie d'avant la
// fenetre passe dans la rangee « Avant », avec les reperes du passe ; une sortie sans page (pas de slug) n'est pas un lien.
var SERIES = { TV: 1, TV_SHORT: 1, ONA: 1 };
function enCoursAnime(format, statut, date) {
  return !!date && jour(date) < DEBUT && (!format || SERIES[format] === 1) && statut !== "FINISHED" && statut !== "CANCELLED";
}
// le statut de la fiche ouverte : la balise [STATUS:] de sa description ; un prochain episode annonce ([NEXT_EP:]) dit en cours
function statutFiche(item) {
  var d = String(item.description || ""), m = d.match(/\[STATUS:(\w+)\]/);
  if (/\[NEXT_EP:\d+\]/.test(d)) return "RELEASING";
  return m ? m[1] : null;
}
// le titre comme le site l'affiche partout (displayTitle de lib/api.ts : anglais d'abord)
function titreSite(x) { return (x.titleEnglish != null && x.titleEnglish !== "" ? x.titleEnglish : x.title) || x.title || ""; }
var cleTitre = function (t) {
  var x = String(t || "");
  return /[a-z]/i.test(x) ? x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "") : x.trim();
};
function texteOrigine(o) {
  if (!o || !ORIGINES[o.type]) return "";
  var t = ORIGINES[o.type], a = (o.auteurs || []).filter(Boolean);
  if (a.length) {
    var qui = a.length > 1 ? a.slice(0, -1).join(", ") + " et " + a[a.length - 1] : a[0];
    return "D’après le " + t + " " + (/^[aeiouyàâäéèêëîïôöùûü]/i.test(qui) ? "d’" : "de ") + qui;
  }
  return o.titre ? "D’après le " + t + " " + o.titre : "";
}
var REPERES_MAX = 4;   // une rangee « Avant » (4 tuiles sur ordinateur)
function depuisApi(u) {
  var autres = [], passees = [];
  (u.autres || []).forEach(function (a) {
    var dom = a.type === "game" ? "games" : "anime";
    var x = {
      titre: titreSite(a), domaine: dom, format: a.format, plateformes: a.platform || "",
      date: a.releaseDate || null, prec: a.releasePrecision || "day",
      enCours: dom === "anime" && enCoursAnime(a.format, a.statut, a.releaseDate),
      jaquette: a.cover || null,
      lien: a.slug ? "/" + dom + "/" + a.slug + "/" : null
    };
    // sortie d'avant la fenetre, pas en cours : un repere du passe (titre, type, annee)
    if (x.date && !x.enCours && jour(x.date) < DEBUT) passees.push({ titre: x.titre, type: a.type === "game" ? "game" : "anime", format: a.format, annee: jma(x.date)[0] });
    else autres.push(x);
  });
  // les reperes, une rangee au plus : les liens directs du module des licences (saison d'avant, original d'un remake),
  // puis les sorties du site d'avant la fenetre, puis les autres reperes, les plus recents d'abord ; un meme titre de la
  // meme annee une seule fois (deux oeuvres du meme nom, d'annees differentes, restent deux)
  var api = (u.reperes || []).slice(), recent = function (x, y) { return y.annee - x.annee; };
  var ordre = api.filter(function (r) { return r.direct; }).sort(recent)
    .concat(passees.sort(recent), api.filter(function (r) { return !r.direct; }).sort(recent));
  var vus = {}, rep = [];
  ordre.forEach(function (r) {
    var k = cleTitre(r.titre) + "|" + r.annee;
    if (!cleTitre(r.titre) || vus[k] || rep.length >= REPERES_MAX) return;
    vus[k] = 1;
    rep.push(r);
  });
  return {
    licence: u.nom, origine: texteOrigine(u.origine), avant: AN,
    autres: autres,
    reperes: rep.sort(function (x, y) { return x.annee - y.annee; })
  };
}
// La fiche ouverte, a la forme d'une sortie du bloc.
function ficheDe(item, domaine) {
  return { titre: titreSite(item), domaine: domaine, format: item.format, plateformes: item.platform || "", date: item.releaseDate || null,
    prec: item.releasePrecision || "day", jaquette: item.cover || null,
    enCours: domaine === "anime" && enCoursAnime(item.format, statutFiche(item), item.releaseDate) };
}

// Les reperes du passe : « One Piece Film: Red · Film · 2022 ». Pas de fiche, pas de lien ; dans l'ordre du temps.
function typeRepere(r) { return r.type === "game" ? FORMATS_JEU[r.format] || "Jeu" : FORMATS[r.format] || "Anime"; }
function repereTx(r) {
  return '<span class="uv-av-an">' + esc(r.annee) + '</span><span class="uv-av-tx"><span class="uv-av-nom">' + esc(r.titre) +
    '</span><span class="uv-av-sous">' + esc(typeRepere(r)) + "</span></span>";
}
// ordinateur (et telephone sans frise) : une rangee sous la frise
function avantHtml(reperes, avant, dansFrise) {
  if (!reperes.length) return "";
  return '<div class="uv-avant' + (dansFrise ? " dans-frise" : "") + '"><p class="uv-avant-t">Avant ' + esc(avant) + '</p><ol class="uv-avant-l">' +
    reperes.map(function (r) { return '<li class="uv-av">' + repereTx(r) + "</li>"; }).join("") + "</ol></div>";
}

// Une rangee d'etiquettes : chacune au plus pres de son repere, sans chevauchement, tout en %.
var F_ECART = 1.4, F_VIGNETTE = 3.3, F_LARGEUR = 29.3;   // % de la largeur : ~10 px, ~25 px (milieu de la vignette), ~220 px sur 752 px
function rangee(ancres) {
  var n = ancres.length, w = Math.min(F_LARGEUR, (100 - (n - 1) * F_ECART) / n), g = [], i;
  for (i = 0; i < n; i++) g[i] = Math.max(0, i ? Math.max(ancres[i] - F_VIGNETTE, g[i - 1] + w + F_ECART) : ancres[i] - F_VIGNETTE);
  for (i = n - 1; i >= 0; i--) g[i] = Math.min(g[i], i === n - 1 ? 100 - w : g[i + 1] - F_ECART - w);
  return { w: w, g: g };
}
function rangeeHtml(liste, sens) {
  if (!liste.length) return { etiqs: "", liens: "" };
  var r = rangee(liste.map(function (t) { return t.ancre; })), etiqs = "", liens = "";
  liste.forEach(function (t, i) {
    var x1 = t.ancre, x2 = r.g[i] + F_VIGNETTE;
    // bas : du repere (en haut) vers l'etiquette (en bas) ; haut : l'inverse
    liens += "<path" + (t.ici ? ' class="ici"' : "") + ' d="' + (sens === "bas"
      ? "M" + x1.toFixed(2) + " 0 C " + x1.toFixed(2) + " 16.5, " + x2.toFixed(2) + " 13.5, " + x2.toFixed(2) + " 30"
      : "M" + x1.toFixed(2) + " 55 L " + x1.toFixed(2) + " 30 C " + x1.toFixed(2) + " 13.5, " + x2.toFixed(2) + " 16.5, " + x2.toFixed(2) + " 0") + '"/>';
    etiqs += etiquette(t.it, t.ici, "width:" + r.w.toFixed(2) + "%;margin-left:" + r.g[i].toFixed(2) + "%");
  });
  return { etiqs: etiqs, liens: liens };
}

function frise(fiche, autres, passe, avant) {
  // la page de l'univers (/univers/<slug>/) n'a pas de fiche ouverte : fiche = null
  var tous = autres.map(function (a) { return { it: a, ici: false }; }).concat(fiche ? [{ it: fiche, ici: true }] : []);
  tous.forEach(function (t) { t.ancre = place(t.it).ancre; });
  tous.sort(function (a, b) { return a.ancre - b.ancre; });
  var auj = place({ date: AUJ, prec: "day" }).ancre;
  // la piste : mois, annee, aujourd'hui, puis un repere par sortie
  var piste = "";
  for (var k = 1; k < 24; k++) if (k !== 12) piste += '<i class="uv-f-mois" style="left:' + (k / 24 * 100).toFixed(2) + '%"></i>';
  piste += '<i class="uv-f-annee" style="left:50%"></i><i class="uv-f-auj" style="left:' + auj.toFixed(2) + '%"></i>';
  tous.forEach(function (t) {
    var pl = place(t.it);
    if (pl.horsPiste) return;
    piste += '<b class="' + classeMarque(t.it, t.ici) + '" style="left:' + pl.debut.toFixed(2) + "%" +
      (t.it.prec === "day" && !t.it.enCours ? "" : ";width:" + (pl.fin - pl.debut).toFixed(2) + "%") + '"></b>';
  });
  // jusqu'a 3 sorties : une rangee sous la piste ; des 4, une sur deux passe au-dessus
  // (sauf si son lien traverserait un repere ecrit : annees, « aujourd'hui »)
  var bas = [], haut = [];
  var gene = [[0, 4.5], [50, 55], [auj - 5, auj + 5]];
  tous.forEach(function (t, i) {
    var dessus = tous.length > 3 && i % 2 === 1 && !gene.some(function (z) { return t.ancre >= z[0] && t.ancre <= z[1]; });
    (dessus ? haut : bas).push(t);
  });
  var H = rangeeHtml(haut, "haut"), B = rangeeHtml(bas, "bas");
  var reperes = '<div class="uv-f-reperes"><span class="uv-f-an" style="left:0">' + AN + '</span><span class="uv-f-an" style="left:calc(50% + 7px)">' + (AN + 1) + '</span>' +
    '<span class="uv-f-ajd" style="left:' + auj.toFixed(2) + '%">aujourd’hui</span></div>';
  // deux rangees : les liens du dessus traversent la ligne des reperes (jamais sur un repere ecrit)
  var h = '<div class="uv-frise' + (haut.length ? " deux" : "") + '">' +
    (haut.length ? '<div class="uv-f-etiqs haut">' + H.etiqs + '</div><div class="uv-f-dessus"><svg class="uv-f-liens" viewBox="0 0 100 55" preserveAspectRatio="none" aria-hidden="true">' + H.liens + "</svg>" + reperes + "</div>" : reperes) +
    '<div class="uv-f-piste">' + piste + "</div>" +
    '<svg class="uv-f-liens" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' + B.liens + "</svg>" +
    '<div class="uv-f-etiqs">' + B.etiqs + "</div></div>";
  // telephone : la meme chose a la verticale, dans l'ordre du temps ; « aujourd'hui » a sa place
  var pj = jma(AUJ), AJD = '<div class="uv-fv-ajd"><span>aujourd’hui · ' + pj[2] + " " + MOIS_COURT[pj[1] - 1] + " " + pj[0] + "</span></div>";
  var v = '<div class="uv-fv">', an = null, pose = false, yAuj = pj[0];
  // les reperes du passe ouvrent la liste, sous « Avant 2026 » (avec une serie commencee avant la fenetre)
  if (passe.length) {
    an = "Avant " + avant;
    v += '<div class="uv-fv-an">' + esc(an) + "</div>" + passe.map(function (r) { return '<div class="uv-fv-av"><b class="uv-f-m rep"></b>' + repereTx(r) + "</div>"; }).join("");
  }
  tous.forEach(function (t) {
    var pl = place(t.it), y = pl.horsPiste && !pl.apres ? "Date à annoncer" : pl.avant ? "Avant " + avant : String(jma(t.it.date)[0]);
    if (y !== an) {
      if (!pose && (pl.horsPiste || (!pl.avant && yAuj < +y))) { v += AJD; pose = true; }
      v += '<div class="uv-fv-an">' + esc(y) + "</div>"; an = y;
    }
    if (!pose && !pl.avant && t.ancre >= auj) { v += AJD; pose = true; }
    v += etiquette(t.it, t.ici).replace('<span class="uv-mv">', marque(t.it, t.ici) + '<span class="uv-mv">');
  });
  if (!pose) v += AJD;
  return h + v + "</div>";
}

// « Suivre l'univers » : avec les abonnements (étape 7 du plan) ; d'ici là, ni le bouton ni sa promesse
var SUIVRE = false;

// Le bloc entier, pose a la fin de ficheHtml (modal et page).
function blocUnivers(u, fiche, suivi) {
  var autres = u.autres.slice(), rep = u.reperes || [];
  var corps = autres.length ? frise(fiche, autres, rep, u.avant) + avantHtml(rep, u.avant, true)
    : '<p class="uv-vide">Pas d’autre sortie ' + esc(u.licence) + " sur le radar pour l’instant." +
      (SUIVRE ? " Suivez l’univers : vous serez prévenu dès qu’un jeu, une saison ou un film arrive." : "") + "</p>" + avantHtml(rep, u.avant, false);
  return '<section class="uv uv-c" aria-labelledby="uv-titre">' +
    '<h3 class="uv-titre" id="uv-titre">Univers ' + esc(u.licence) + "</h3>" +
    (SUIVRE ? '<button class="uv-suivre' + (suivi ? " suivi" : "") + '" type="button" aria-pressed="' + (suivi ? "true" : "false") + '">' + CLOCHE +
    (suivi ? "Univers suivi" : "Suivre l’univers") + "</button>" : "") +
    (u.origine ? '<p class="uv-origine">' + esc(u.origine) + "</p>" : "") +
    '<div class="uv-corps">' + corps + "</div></section>";
}

/** Le bloc d'une fiche (modal et page) : rien quand la fiche n'a pas d'univers, ni d'autre sortie ni de passé (tant que
 *  « Suivre l'univers » n'existe pas, un bloc vide n'apprendrait rien). La date du jour est relue à chaque rendu. */
export function universHtml(item, domaine, simplifier) {
  if (!item || !item.univers) return "";
  // une donnée inattendue ne casse jamais la fiche (modal et page) : elle reste, sans le bloc
  try {
    regler();
    if (typeof simplifier === "function") SIMPLIFIER = simplifier;
    var u = depuisApi(item.univers);
    if (!SUIVRE && !u.autres.length && !u.reperes.length) return "";
    return blocUnivers(u, ficheDe(item, domaine), false);
  } catch (e) {
    return "";
  }
}
