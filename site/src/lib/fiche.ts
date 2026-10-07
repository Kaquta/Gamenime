/**
 * Rendu des fiches — fonctions pures partagees.
 *
 * Extrait tel quel du bloc <script> de SectionBlock.astro : aucune ligne de
 * logique modifiee, seuls les `export` et le typage sont ajoutes. C'est ce
 * qui permet de comparer les deux versions caractere par caractere avant de
 * brancher quoi que ce soit.
 *
 * Raison d'etre : renderSearchCard dans index.astro avait diverge de
 * SectionBlock (data-type et bandes de trailer manquants, fiche inaccessible
 * sur mobile). Une seule source pour le modal, la recherche et les pages
 * indexables evite que ca se reproduise.
 */

import { displayTitle } from "./api";

export function formatDate(v) {
  if (!v) return "Date inconnue";
  var d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d);
}
// ETAT CLEAN: prefer the GameNime API-generated label (handles fuzzy dates
// like "Prévu 2026"). Fall back to formatDate for legacy endpoints that
// don't include releaseDateLabel.
export function dateLabel(item) {
  // precision=year: ne jamais afficher le 01-01 fictif, montrer "Prevu AAAA"
  if (item && item.releasePrecision === "year" && item.releaseDate) {
    return "Prévu " + String(item.releaseDate).slice(0, 4);
  }
  // precision=month: on connait que le mois -> "Prevu MOIS AAAA" (pas de jour fictif 01)
  if (item && item.releasePrecision === "month" && item.releaseDate) {
    var moisFr = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
    var parts = String(item.releaseDate).split("-");
    var moisIdx = parseInt(parts[1], 10) - 1;
    if (moisIdx >= 0 && moisIdx < 12) return "Prévu " + moisFr[moisIdx] + " " + parts[0];
  }
  // precision=day (ou inconnue avec label API): vraie date precise
  if (item && item.releaseDateLabel) return item.releaseDateLabel;
  return formatDate(item ? item.releaseDate : null);
}
// Bloc date du modal : la barre montre la LARGEUR de l'incertitude a l'echelle
// de l'annee. Le compte a rebours n'apparait qu'en precision "day" — sans jour
// confirme, un J-x serait invente (et le rappel serveur ne partirait pas non plus).
export function detailDateBlock(item) {
  if (!item || !item.releaseDate) {
    return '<div class="detail-dateblock"><div class="detail-dateline">' +
      '<span class="detail-datevalue soft">Date non annoncee</span></div></div>';
  }
  var prec = item.releasePrecision || "day";
  var parts = String(item.releaseDate).split("-");
  var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  var left, width, note, wide = "";
  if (prec === "year") {
    left = 0; width = 100; note = "mois non annonce"; wide = " wide";
  } else if (prec === "month") {
    left = ((m - 1) / 12) * 100; width = 100 / 12; note = "jour non annonce";
  } else {
    var doy = Math.round((new Date(y, m - 1, d).getTime() - new Date(y, 0, 1).getTime()) / 86400000);
    left = (doy / 365) * 100; width = 1.5; note = "jour confirme";
  }
  if (left + width > 100) left = 100 - width;
  var cd = "";
  if (prec === "day") {
    var rel = new Date(item.releaseDate); rel.setHours(0, 0, 0, 0);
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var j = Math.round((rel.getTime() - now.getTime()) / 86400000);
    if (j > 0) cd = '<span class="detail-countdown"><span class="cd-dot"></span>J-' + j + '</span>';
    else if (j === 0) cd = '<span class="detail-countdown"><span class="cd-dot"></span>Sortie aujourd\u0027hui</span>';
    else cd = '<span class="detail-countdown is-out">Sorti</span>';
  }
  var soft = prec === "day" ? "" : " soft";
  return '<div class="detail-dateblock">' +
    '<div class="detail-dateline"><span class="detail-datevalue' + soft + '">' + dateLabel(item) + '</span>' + cd + '</div>' +
    '<div class="detail-window' + wide + '"><span style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></span></div>' +
    '<div class="detail-windowlegend"><span>janv. ' + y + '</span><span>' + note + '</span><span>dec. ' + y + '</span></div>' +
  '</div>';
}
// Plateformes en chips. Un distributeur YouTube officiel (Muse Asia, Ani-One,
// Medialink) s'affiche par son NOM avec un marqueur discret : jamais "YouTube" seul.
// Modal : noms COMPLETS ("PlayStation 5", "Xbox Series X|S"), contrairement
// aux cartes qui raccourcissent en PS5 / Xbox X|S. Meme regle en revanche sur
// le doublon : des qu'une version precise existe pour une famille, le generique
// de cette famille disparait ("PlayStation, PlayStation 5" -> "PlayStation 5").
// Titres alternatifs : le natif japonais, plus le romaji s'il differe du
// titre affiche. displayTitle preferant l'anglais, montrer les deux sans
// filtrer repeterait ce qui est deja en gros juste au-dessus.
export function altEsc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function altTitles(item) {
  var affiche = String(displayTitle(item) || "").trim();
  var parts = [];
  var nat = item.titleNative ? String(item.titleNative).trim() : "";
  var rom = item.title ? String(item.title).trim() : "";
  if (nat && nat !== affiche) parts.push('<span class="alt-nat">' + altEsc(nat) + '</span>');
  if (rom && rom !== affiche && rom !== nat) parts.push(altEsc(rom));
  if (!parts.length) return "";
  return '<div class="alt-titles">' + parts.join('<span class="alt-sep">\u00b7</span>') + '</div>';
}

export function dedupeGeneric(list) {
  var FAMILIES = [
    { generic: "playstation", precise: /^playstation \d/ },
    { generic: "xbox", precise: /^xbox (series|one)/ },
    { generic: "nintendo", precise: /^nintendo (switch|3ds|ds|wii)/ }
  ];
  var lower = list.map(function (x) { return x.toLowerCase(); });
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var fam = null;
    for (var f = 0; f < FAMILIES.length; f++) {
      if (lower[i] === FAMILIES[f].generic) { fam = FAMILIES[f]; break; }
    }
    if (fam) {
      var precisExiste = false;
      for (var k = 0; k < lower.length; k++) {
        if (fam.precise.test(lower[k])) { precisExiste = true; break; }
      }
      if (precisExiste) continue;
    }
    var label = lower[i] === "pc (microsoft windows)" ? "PC" : list[i];
    if (out.indexOf(label) === -1) out.push(label);
  }
  return out;
}
export function detailPlatforms(item) {
  var raw = (item && item.platform) ? String(item.platform) : "";
  var list = dedupeGeneric(raw.split(",").map(function(x) { return x.trim(); }).filter(Boolean));
  if (!list.length) {
    return '<div class="detail-platforms"><span class="plat-chip tbc">Aucune plateforme annoncee</span></div>';
  }
  return '<div class="detail-platforms">' + list.map(function(name) {
    var yt = /muse asia|ani-one|medialink/i.test(name) ? '<i class="plat-yt">YOUTUBE</i>' : '';
    return '<span class="plat-chip">' + name + yt + '</span>';
  }).join("") + '</div>';
}

export function getStatusLabel(item) {
  if (!item.releaseDate) return "À surveiller";
  // precision=year: la date 01-01 est fictive (on connait que l'annee) -> toujours "A venir"
  if (item.releasePrecision === "year") return "À venir";
  var now = new Date(); now.setHours(0,0,0,0);
  var rel = new Date(item.releaseDate); rel.setHours(0,0,0,0);
  var diff = Math.round((rel.getTime() - now.getTime()) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff > 0) return "À venir";
  // Calcule depuis la date plutot que lu en base : is_recently_released
  // n'etait ecrit qu'a l'ingestion et jamais recalcule, donc un item entre
  // comme "a venir" restait a 0 apres sa sortie (Sekiro, sorti le jour meme,
  // affichait "Sorti" au lieu de "Recent").
  if (diff >= -30) return "Récent";
  return "Sorti";
}
// Libelle de repli quand un ANIME n'a pas encore de plateforme renseignee.
// Calcul au runtime : une fois la date passee, l'oeuvre est diffusee au Japon
// mais aucun diffuseur EU n'est connu -> on le dit sans pretendre "Japon uniquement".
export function platformFallback(item) {
  if (!item.releaseDate || item.releasePrecision === "year") return "Plateforme EU non annoncée";
  var rel = new Date(item.releaseDate); rel.setHours(0,0,0,0);
  var now = new Date(); now.setHours(0,0,0,0);
  return rel <= now ? "Sortie Japon · EU à confirmer" : "Plateforme EU non annoncée";
}

export function getCountdownHtml(item) {
  // Countdown UNIQUEMENT si date precise (day). Sinon (month/year), date approximative -> pas de compte a rebours trompeur
  if (item.releasePrecision && item.releasePrecision !== "day") return "";
  var dt = item.releaseDatetime || item.releaseDate;
  if (!dt) return "";
  var rel = new Date(dt);
  if (Number.isNaN(rel.getTime())) return "";
  var ms = rel.getTime() - Date.now();
  if (ms <= 0 || ms > 20 * 24 * 3600000) return "";
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  var days = Math.floor(ms / 86400000);
  var label = "Sortie";
  var desc = item.description || "";
  var epMatch = desc.match(/\[NEXT_EP:(\d+)\]/);
  if (epMatch) label = "Épisode " + epMatch[1];
  else if (desc.toLowerCase().includes("dlc")) label = "DLC";
  else if (desc.toLowerCase().includes("season") || desc.toLowerCase().includes("saison")) label = "Nouvelle saison";
  else if (desc.toLowerCase().includes("update") || desc.toLowerCase().includes("mise à jour")) label = "Mise à jour";
  var timeStr;
  if (days >= 2) { timeStr = days + "j " + (h % 24) + "h"; }
  else { timeStr = h + "h " + m + "m " + s + "s"; }
  return '<div class="item-countdown" data-release="' + rel.toISOString() + '">' +
    '<span class="countdown-timer">' + timeStr + '</span>' +
    '<span class="countdown-tooltip">' + label + '</span></div>';
}
// Pastille de temps : un seul element porte le degre de certitude.
// 5 etats — imminent (minute), proche (jours), lointain (arrondi), vague
// (mois/annee, aucun compte a rebours), sorti. Meme regle que le modal et
// que les rappels : pas de J- sans jour confirme.
var MOIS_LONG = ["janvier","f\u00e9vrier","mars","avril","mai","juin","juillet","ao\u00fbt","septembre","octobre","novembre","d\u00e9cembre"];
// Bloc date : reprend la structure du modal en miniature — valeur, compte a
// rebours, barre de precision. Rien n'est pose sur la jaquette (ses coins sont
// deja pris par .content-tag, .rank-badge et .fav-heart).
export function dateBox(item) {
  if (!item.releaseDate) {
    return '<div class="dbox"><div class="dline"><span class="dval vague">Date non annoncee</span></div></div>';
  }
  var prec = item.releasePrecision || "day";
  var p = String(item.releaseDate).split("-");
  var y = +p[0], m = +p[1], d = +p[2];
  var val, cd = "", left, width, wide = "";
  if (prec === "year") {
    val = '<span class="dval vague">courant ' + y + '</span>';
    left = 0; width = 100; wide = " wide";
  } else if (prec === "month") {
    val = '<span class="dval vague">courant ' + MOIS_LONG[m - 1] + '</span>';
    left = ((m - 1) / 12) * 100; width = 100 / 12;
  } else {
    val = '<span class="dval">' + d + ' ' + MOIS_LONG[m - 1] + '</span>';
    var doy = Math.round((new Date(y, m - 1, d).getTime() - new Date(y, 0, 1).getTime()) / 86400000);
    left = (doy / 365) * 100; width = 3;
    var rel = new Date(item.releaseDate); rel.setHours(0, 0, 0, 0);
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var j = Math.round((rel.getTime() - now.getTime()) / 86400000);
    if (j < 0) cd = '<span class="dcd past">sorti</span>';
    else if (j === 0) cd = '<span class="dcd"><i></i>aujourd\u0027hui</span>';
    else if (j === 1) cd = '<span class="dcd"><i></i>demain</span>';
    else if (j <= 15) cd = '<span class="dcd">' + j + ' j</span>';
    else cd = '<span class="dcd far">dans ' + j + ' j</span>';
  }
  if (left + width > 100) left = 100 - width;
  return '<div class="dbox"><div class="dline">' + val + cd + '</div>' +
    '<div class="wbar' + wide + '"><i style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></i></div></div>';
}
// Plateformes en chips (comme dans le modal). Rien d'invente : si aucune
// source ne connait de plateforme, on l'ecrit.
export function platChips(item, domain) {
  var raw = simplifyPlatform(item.platform) || "";
  var list = raw.split(",").map(function(x) { return x.trim(); }).filter(Boolean);
  if (!list.length) {
    var fb = String(domain).indexOf("anime") !== -1 ? "Plateforme EU non annoncee" : (item.genre || "Non annoncee");
    return '<div class="chips"><span class="chip tbc">' + fb + '</span></div>';
  }
  // Ordre d'affichage : PC et consoles d'abord, mobile ensuite. Sans ca le tri
  // vient de la source et iOS/Android passent devant PS5 sur un jeu console.
  var RANG = { "PC": 0, "PS6": 1, "PS5": 1, "PS4": 1, "PS3": 1, "PlayStation": 1,
               "Xbox X|S": 2, "Xbox One": 2, "Xbox": 2,
               "Switch 2": 3, "Switch": 3, "Nintendo": 3,
               "Mac": 4, "Linux": 4, "iOS": 5, "Android": 5 };
  list.sort(function (a, b) {
    var ra = RANG[a] === undefined ? 9 : RANG[a];
    var rb = RANG[b] === undefined ? 9 : RANG[b];
    return ra - rb;
  });
  var reste = list.length - 3;
  return '<div class="chips">' + list.slice(0, 3).map(function(n) {
    return '<span class="chip">' + n + '</span>';
  }).join("") + (reste > 0 ? '<span class="chip more">+' + reste + '</span>' : '') + '</div>';
}
// Badge popularite : seuils propres a chaque domaine. AniList compte des
// utilisateurs (max ~687000), IGDB des hypes (max ~778) : un seuil unique
// mettait le badge sur 98% des animes et 8% des jeux.
export function hypePill(item, domain) {
  var pop = Number(item.popularity || 0);
  var estAnime = String(domain).indexOf("anime") !== -1;
  var seuil = estAnime ? 50000 : 100;
  if (pop < seuil) return '';
  var today = new Date().toISOString().slice(0, 10);
  if (!item.releaseDate) return '';
  return item.releaseDate > today
    ? '<span class="hpill">tr\u00e8s attendu</span>'
    : '<span class="hpill">populaire</span>';
}

export function ytId(url) {
  if (!url) return null;
  var m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function getSmiley(p) {
  if (p >= 80) return "😄"; if (p >= 60) return "🙂";
  if (p >= 40) return "😐"; if (p >= 20) return "😕"; return "😢";
}

export function parseScreenshots(item) {
  if (!item.screenshots) return [];
  try { var arr = JSON.parse(item.screenshots); return Array.isArray(arr) ? arr : []; }
  catch(e) { return []; }
}

export function simplifyPlatform(p) {
  // La base garde le detail ("PlayStation 5", "Xbox Series X|S").
  // Certaines lignes melangent generique et precis :
  //   "PC, PlayStation, Xbox, PlayStation 5, Xbox Series X|S"
  // Regle : des qu'une version precise existe pour une famille,
  // le generique de cette famille disparait.
  if (!p) return "";
  var LABELS = {
    "playstation 6": "PS6",
    "playstation 5": "PS5",
    "playstation 4": "PS4",
    "playstation 3": "PS3",
    "xbox series x|s": "Xbox X|S",
    "xbox series s/x": "Xbox X|S",
    "xbox series": "Xbox X|S",
    "xbox one": "Xbox One",
    "nintendo switch 2": "Switch 2",
    "nintendo switch": "Switch",
    "pc (microsoft windows)": "PC",
    "apple macintosh": "Mac"
  };
  var FAMILIES = [
    { generic: "playstation", precise: /^playstation \d/ },
    { generic: "xbox", precise: /^xbox (series|one)/ },
    { generic: "nintendo", precise: /^nintendo (switch|3ds|ds|wii)/ }
  ];
  var parts = String(p).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  var lower = parts.map(function (x) { return x.toLowerCase(); });
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var fam = null;
    for (var f = 0; f < FAMILIES.length; f++) {
      if (lower[i] === FAMILIES[f].generic) { fam = FAMILIES[f]; break; }
    }
    if (fam) {
      var precisExiste = false;
      for (var k = 0; k < lower.length; k++) {
        if (fam.precise.test(lower[k])) { precisExiste = true; break; }
      }
      if (precisExiste) continue;
    }
    var label = LABELS[lower[i]] || parts[i];
    if (out.indexOf(label) === -1) out.push(label);
  }
  return out.join(", ");
}

export function formatPegi(rating) {
  if (!rating) return "";
  if (rating.indexOf("PEGI") === 0) return rating;
  // AniList renvoie "R - 17+ (violence & profanity)" : illisible sur mobile.
  var court = rating.match(/^(G|PG|PG-13|R|R\+|Rx)\s*-\s*([0-9]+\+)/);
  if (court) return court[2];
  if (/^R\s*-\s*17/.test(rating)) return "17+";
  if (/Hentai|Rx/i.test(rating)) return "18+";
  var map = { "Everyone": "PEGI 3", "Everyone 10+": "PEGI 7", "E": "PEGI 3", "E10+": "PEGI 7", "Teen": "PEGI 12", "T": "PEGI 12", "Mature": "PEGI 16", "M": "PEGI 16", "Adults Only": "PEGI 18", "AO": "PEGI 18", "Rating Pending": "PEGI RP", "RP": "PEGI RP" };
  return map[rating] || rating;
}

export function getHypeLabel(item) {
  if (!item.popularity || Number(item.popularity) < 70) return null;
  if (!item.releaseDate) return null;
  var now = new Date(); now.setHours(0,0,0,0);
  var rel = new Date(item.releaseDate); rel.setHours(0,0,0,0);
  if (rel > now) return "Très attendu";
  return "Populaire";
}

export function renderCard(item, domain, rank) {
  var status = getStatusLabel(item);
  var media = item.cover
    ? '<img src="' + item.cover + '" alt="' + displayTitle(item) + '" loading="lazy" />'
    : '<div class="item-placeholder">Aucune image</div>';
  var info = simplifyPlatform(item.platform) || (String(domain).indexOf("anime") !== -1 ? platformFallback(item) : (item.genre || "Information à venir"));
  var countdown = getCountdownHtml(item);
  var hasTrailer = item.trailerUrl && ytId(item.trailerUrl);
  var videoId = hasTrailer ? ytId(item.trailerUrl) : null;
  var screens = parseScreenshots(item);
  var rankBadge = rank ? '<div class="rank-badge">#' + rank + '</div>' : '';
  var contentTagBadge = item.contentTag ? '<div class="content-tag">' + item.contentTag + '</div>' : '';
  var screensAttr = !hasTrailer && screens.length ? " data-screens='" + JSON.stringify(screens) + "'" : '';
  var hype = getHypeLabel(item);
  var hypeBadge = '';
  if (hype === "Populaire") hypeBadge = '<span class="item-badge popular">🔥 Populaire</span>';
  else if (hype === "Très attendu") hypeBadge = '<span class="item-badge anticipated">⭐ Très attendu</span>';

  // --cover permet a l'accueil d'afficher l'affiche floutee en fond de carte
  // sans dupliquer la balise <img>. encodeURI suffit : ces URL n'ont ni
  // parenthese ni espace, et la propriete est ignoree partout ailleurs.
  var coverVar = item.cover ? ' style="--cover:url(' + encodeURI(item.cover) + ')"' : '';

  return '<article class="item-card' + (hasTrailer ? ' has-trailer' : '') + '"' + coverVar +
    ' data-id="' + item.id + '" data-domain="' + domain + '"' +
    ' data-slug="' + (item.slug || '') + '"' +
    ' data-format="' + (item.format || '') + '"' +
    ' data-platform="' + String(item.platform || '').replace(/"/g, '') + '"' +
    (videoId ? ' data-yt="' + videoId + '"' : '') + screensAttr + '>' +
    '<div class="item-media">' + media + '</div>' +
    '<div class="item-hover-video"></div>' +
    (hasTrailer ? '<div class="trailer-band top" data-band-id="' + item.id + '" data-band-domain="' + domain + '"></div><div class="trailer-band bottom" data-band-id="' + item.id + '" data-band-domain="' + domain + '"></div>' : '') +
    '<div class="item-hover-slides"></div>' +
    '<div class="item-overlay"></div>' +
    contentTagBadge +
    rankBadge +
    '<button class="fav-heart" data-fav-id="' + item.id + '" data-fav-type="' + domain + '" aria-label="Favori">♡</button>' +
    '<div class="item-body">' +
    // Le titre porte le lien vers la fiche : HTML valide, invisible a l'oeil,
    // sans effet sur la grille, et le texte d'ancrage est le titre de l'oeuvre.
    // Le coeur et les bandes du trailer restent hors du <a>, donc aucun clic
    // sur eux ne peut declencher de navigation.
    '<h3>' + (item.slug
      ? '<a class="item-link" href="/' + (String(domain).indexOf("anime") !== -1 ? 'anime' : 'games') + '/' + item.slug + '/">' + displayTitle(item) + '</a>'
      : displayTitle(item)) + '</h3>' +
    dateBox(item) + platChips(item, domain) + hypePill(item, domain) +
    '</div></article>';
}
 
 
 
 
/* ═══════════════════════════════════════════════════════════════════════════
   ACCUEIL — maquette validee le 3 octobre (session 35)
   ═══════════════════════════════════════════════════════════════════════════
   Trois blocs de l'accueil ont un corps de carte a eux : « Cette semaine »,
   les deux « Derniers sortis » et les deux « Top 25 ». Le reste du site ne
   change pas et garde renderCard.
 
   Ce qui NE change pas, et pourquoi :
   - la coquille reste <article class="item-card"> avec ses data-id/data-domain,
     son .item-hover-video, ses .trailer-band, son .fav-heart et son <a
     class="item-link"> dans le h3. Ce sont les crochets des ecouteurs delegues
     de SectionBlock : survol -> bande-annonce YouTube, clic -> modale, coeur ->
     favoris. Changer la coquille, c'est tout perdre d'un coup.
   - le lien interne reste dans le h3 : c'est lui qui peuple le HTML livre et
     qui a sorti les fiches de « detectee, non indexee ».
 
   Ce qui change : le CORPS. .ds-l / .ds-t / .bds pour les derniers sortis,
   .se-tags / .se-t / .se-m pour la semaine, tels que valides.
 
   Le Top 25 fait exception : dans la maquette c'est une ligne de classement,
   pas une carte. C'est donc un <a> entier, sans survol ni modale — conforme a
   la demande (« si je laisse la souris sur item le trailer se lance » ne visait
   que Cette semaine et Derniers sortis).
   ═══════════════════════════════════════════════════════════════════════════ */
 
// Les informations de la carte viennent des MEMES fonctions que le catalogue :
// dateBox (la ligne « 3 octobre » + la pastille d'etat), platChips (les
// plateformes) et hypePill. L'accueil avait ses propres etiquettes — « SORTI
// LE 2 OCT. », des badges Jeu/Anime — c'est ce qu'on retire : une seule source
// pour toute l'information du site, et elle se corrige a un seul endroit.
 
// Le coeur des favoris. Son balisage ne doit exister qu'a un seul endroit :
// c'est lui que l'ecouteur delegue reconnait (data-fav-id / data-fav-type) et
// que updateAllHearts() bascule entre ♡ et ♥.
function coeurFavori(item, domain) {
  return '<button class="fav-heart" data-fav-id="' + item.id +
    '" data-fav-type="' + domain + '" aria-label="Favori">♡</button>';
}
 
// Coquille commune. Tout ce que les ecouteurs delegues vont chercher est ici,
// dans le meme ordre que renderCard : si une de ces lignes disparait, c'est une
// fonctionnalite du site qui disparait avec elle.
function coquilleAccueil(item, domain, classes, corps, coeurAilleurs?) {
  const hasTrailer = item.trailerUrl && ytId(item.trailerUrl);
  const videoId = hasTrailer ? ytId(item.trailerUrl) : null;
  const screens = parseScreenshots(item);
  const screensAttr = !hasTrailer && screens.length
    ? " data-screens='" + JSON.stringify(screens) + "'" : "";
  const media = item.cover
    ? '<img src="' + item.cover + '" alt="' + displayTitle(item) + '" loading="lazy" />'
    : '<div class="item-placeholder">Aucune image</div>';
  // --cover sert au fond floute (::before) sans dupliquer la balise <img>.
  const coverVar = item.cover ? ' style="--cover:url(' + encodeURI(item.cover) + ')"' : "";
 
  return '<article class="item-card ' + classes + (hasTrailer ? " has-trailer" : "") + '"' + coverVar +
    ' data-id="' + item.id + '" data-domain="' + domain + '"' +
    ' data-slug="' + (item.slug || "") + '"' +
    ' data-format="' + (item.format || "") + '"' +
    ' data-platform="' + String(item.platform || "").replace(/"/g, "") + '"' +
    (videoId ? ' data-yt="' + videoId + '"' : "") + screensAttr + ">" +
    '<div class="item-media">' + media + "</div>" +
    '<div class="item-hover-video"></div>' +
    // Ni bandes ni pastille ici. Les .trailer-band du catalogue servaient a
    // rattraper le clic que l'iframe YouTube avalait ; sur l'accueil la video
    // est transparente au clic, donc toute la carte ouvre la fiche et les
    // bandes n'ont plus de role. La pastille « Bande-annonce », elle, se
    // posait sur le titre de la carte large.
    '<div class="item-hover-slides"></div>' +
    '<div class="item-overlay"></div>' +
    (coeurAilleurs ? "" : coeurFavori(item, domain)) +
    corps +
    "</article>";
}
 
// Le titre, avec son lien vers la fiche quand elle existe. Identique a
// renderCard : meme classe, meme forme d'URL, meme texte d'ancrage.
function titreAccueil(item, domain, classe) {
  const txt = displayTitle(item);
  const lien = item.slug
    ? '<a class="item-link" href="/' +
      (String(domain).indexOf("anime") !== -1 ? "anime" : "games") + "/" + item.slug + '/">' + txt + "</a>"
    : txt;
  return '<h3 class="' + classe + '">' + lien + "</h3>";
}
 
/**
 * Carte large des deux « Derniers sortis ».
 * Jaquette a gauche, texte a droite, fond floute tire de la jaquette.
 */
export function renderCardDerniers(item, domain) {
  const corps = '<div class="item-body ds-info">' +
    titreAccueil(item, domain, "ds-t") +
    dateBox(item) +
    platChips(item, domain) +
    hypePill(item, domain) +
    "</div>";
  return coquilleAccueil(item, domain, "ds-sl", corps);
}
 
/**
 * Grande diapositive de « Cette semaine ».
 * WeekRadar pose lui-meme accLibelle (« Aujourd'hui · 11:30 ») et accEpisode :
 * ces deux valeurs dependent de l'heure de la VISITE, pas de celle du build,
 * et le compte a rebours .cd est rafraichi toutes les 30 secondes.
 */
export function renderCardSemaine(item, domain) {
  const ep = item.accEpisode
    ? '<div class="se-m">Épisode <b>' + item.accEpisode + "</b>" +
      (item.accPlateforme ? " · sur <b>" + item.accPlateforme + "</b>" : "") + "</div>"
    : "";
  // La ligne de date est celle du site (.dbox / .dval / .dcd), mais son contenu
  // nous appartient : dateBox ne connait que le jour, alors qu'un episode a une
  // heure de diffusion et un compte a rebours que WeekRadar rafraichit.
  const quand = '<div class="dbox"><div class="dline">' +
    '<span class="dval">' + (item.accLibelle || "") + "</span>" +
    '<span class="dcd"></span></div></div>';
  const corps = '<div class="item-body se-txt">' +
    titreAccueil(item, domain, "se-t") +
    ep +
    quand +
    platChips(item, domain) +
    hypePill(item, domain) +
    "</div>";
  // Le coeur reprend sa place habituelle, dans le coin de la carte, comme sur
  // toutes les autres du site : « Me rappeler » disparait, les favoris restent.
  return coquilleAccueil(item, domain, "se-sl", corps);
}
 
/**
 * Ligne du Top 25.
 *
 * C'est une .item-card comme les autres : c'est cette classe que les ecouteurs
 * delegues de SectionBlock reconnaissent. Elle herite donc, sans une ligne de
 * JavaScript en plus, du clic vers LA MEME modale que le catalogue et du survol
 * qui lance la bande-annonce dans .item-hover-video.
 * Le titre reste un <a class="item-link"> : c'est lui qui peuple le HTML livre,
 * et le gestionnaire annule sa navigation pour ouvrir la modale a la place.
 *
 * Sans page de fiche (synopsis trop court), pas de lien : une URL qui n'existe
 * pas renverrait l'accueil en 200 et Google indexerait un doublon.
 */
export function renderRangTop(item, domain, rank) {
  const estAnime = String(domain).indexOf("anime") !== -1;
  const sousTitre = estAnime
    ? (item.genre || platformFallback(item))
    : (simplifyPlatform(item.platform) || item.genre || "Information à venir");
  const hasTrailer = item.trailerUrl && ytId(item.trailerUrl);
  const videoId = hasTrailer ? ytId(item.trailerUrl) : null;
  const titre = displayTitle(item);
  const vignette = item.cover
    ? '<img src="' + item.cover + '" alt="' + titre + '" loading="lazy" />'
    : "";
  const lien = item.slug
    ? '<a class="item-link" href="/' + (estAnime ? "anime" : "games") + "/" + item.slug + '/">' + titre + "</a>"
    : titre;
  return '<article class="item-card tl' + (rank <= 3 ? " p3" : "") + (hasTrailer ? " has-trailer" : "") + '"' +
    ' data-id="' + item.id + '" data-domain="' + domain + '"' +
    ' data-slug="' + (item.slug || "") + '"' +
    (videoId ? ' data-yt="' + videoId + '"' : "") + ">" +
    '<span class="r">' + rank + "</span>" +
    '<span class="mv">' + vignette + "</span>" +
    '<span class="tx"><span class="n">' + lien + "</span>" +
    '<span class="gn">' + sousTitre + "</span></span>" +
    '<div class="item-hover-video"></div>' +
    "</article>";
}
