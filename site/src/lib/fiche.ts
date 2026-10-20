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

import { displayTitle, getItemDetail, postVote } from "./api";

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
      '<span class="detail-datevalue soft">Date à annoncer</span></div></div>';
  }
  var prec = item.releasePrecision || "day";
  var parts = String(item.releaseDate).split("-");
  var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  var left, width, note, wide = "";
  if (prec === "year") {
    left = 0; width = 100; note = "mois non annoncé"; wide = " wide";
  } else if (prec === "month") {
    left = ((m - 1) / 12) * 100; width = 100 / 12; note = "jour non annoncé";
  } else {
    var doy = Math.round((new Date(y, m - 1, d).getTime() - new Date(y, 0, 1).getTime()) / 86400000);
    left = (doy / 365) * 100; width = 1.5; note = "jour confirmé";
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
    '<div class="detail-windowlegend"><span>janv. ' + y + '</span><span>' + note + '</span><span>déc. ' + y + '</span></div>' +
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
// Texte d'une description (AniList, IGDB, synopsis) : rien d'executable. Les retours a la ligne et
// l'italique ou le gras d'AniList restent, sans attribut ; toute autre balise est retiree.
export function descSure(t) {
  var gardees = [];
  return String(t == null ? "" : t)
    .replace(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi, function(m, fin, tag) {
      if (!/^(br|i|b|em|strong)$/i.test(tag)) return "";
      gardees.push("<" + fin + tag.toLowerCase() + ">");
      return "\u0000" + (gardees.length - 1) + "\u0000";
    })
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\u0000(\d+)\u0000/g, function(m, k) { return gardees[+k]; });
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
    // Film au cinema en France, sans encore aucune de nos plateformes : des
    // qu'une plateforme arrive, elle prend la place de « Au cinéma ».
    if (item && item.cinemaFr) return '<div class="detail-platforms"><span class="plat-chip">Au cinéma</span></div>';
    return '<div class="detail-platforms"><span class="plat-chip tbc">Aucune plateforme annoncée</span></div>';
  }
  return '<div class="detail-platforms">' + list.map(function(name) {
    var yt = /muse asia|ani-one|medialink/i.test(name) ? '<i class="plat-yt">YOUTUBE</i>' : '';
    return '<span class="plat-chip">' + altEsc(name) + yt + '</span>';
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
    return '<div class="dbox"><div class="dline"><span class="dval vague">Date à annoncer</span></div></div>';
  }
  var prec = item.releasePrecision || "day";
  var p = String(item.releaseDate).split("-");
  var y = +p[0], m = +p[1], d = +p[2];
  var val, cd = "", left, width, wide = "";
  if (prec === "year") {
    val = '<span class="dval vague">courant ' + y + '</span>';
    left = 0; width = 100; wide = " wide";
  } else if (prec === "month") {
    val = '<span class="dval vague">' + MOIS_LONG[m - 1] + ' ' + y + '</span>';
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
export function platChips(item, domain, cinema?) {
  var raw = simplifyPlatform(item.platform) || "";
  // L'API ecrit « Au cinéma » a la place d'une plateforme absente (pour le site d'avant cinemaFr).
  if (item.cinemaFr && raw.trim() === "Au cinéma") raw = "";
  var list = raw.split(",").map(function(x) { return x.trim(); }).filter(Boolean);
  if (!list.length && item.cinemaFr) {
    return '<div class="chips"><span class="chip">' + (cinema || "Au cinéma") + '</span></div>';
  }
  if (!list.length) {
    var fb = String(domain).indexOf("anime") !== -1 ? "Plateforme EU non annoncée" : (item.genre || "Non annoncée");
    return '<div class="chips"><span class="chip tbc">' + altEsc(fb) + '</span></div>';
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
    return '<span class="chip">' + altEsc(n) + '</span>';
  }).join("") + (reste > 0 ? '<span class="chip more">+' + reste + '</span>' : '') + '</div>';
}
// Badge popularite : c'est l'API qui le decide (item.badge, 14 octobre 2026),
// pour les 30 titres les plus populaires de chaque liste : jeux sortis, jeux a
// venir, animes sortis, animes a venir. « populaire » pour un titre sorti,
// « tres-attendu » pour un titre a venir. Le site n'a plus de seuil a lui :
// carte, recherche, semaine et fiche disent la meme chose.
export function hypePill(item, domain) {
  var b = item ? item.badge : null;
  if (b === "tres-attendu") return '<span class="hpill">tr\u00e8s attendu</span>';
  if (b === "populaire") return '<span class="hpill">populaire</span>';
  return '';
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

// Le meme badge pour la fiche (voir hypePill) : decide par l'API.
export function getHypeLabel(item) {
  var b = item ? item.badge : null;
  if (b === "populaire") return "Populaire";
  if (b === "tres-attendu") return "Très attendu";
  return null;
}

export function renderCard(item, domain, rank) {
  var status = getStatusLabel(item);
  var media = item.cover
    ? '<img src="' + altEsc(item.cover) + '" alt="' + altEsc(displayTitle(item)) + '" loading="lazy" />'
    : '<div class="item-placeholder">Aucune image</div>';
  var info = simplifyPlatform(item.platform) || (String(domain).indexOf("anime") !== -1 ? platformFallback(item) : (item.genre || "Information à venir"));
  var countdown = getCountdownHtml(item);
  var hasTrailer = item.trailerUrl && ytId(item.trailerUrl);
  var videoId = hasTrailer ? ytId(item.trailerUrl) : null;
  var screens = parseScreenshots(item);
  var rankBadge = rank ? '<div class="rank-badge">#' + rank + '</div>' : '';
  var contentTagBadge = item.contentTag ? '<div class="content-tag">' + item.contentTag + '</div>' : '';
  var screensAttr = !hasTrailer && screens.length ? " data-screens='" + JSON.stringify(screens).replace(/&/g, "&amp;").replace(/'/g, "&#39;") + "'" : '';
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
      ? '<a class="item-link" href="/' + (String(domain).indexOf("anime") !== -1 ? 'anime' : 'games') + '/' + item.slug + '/">' + altEsc(displayTitle(item)) + '</a>'
      : altEsc(displayTitle(item))) + '</h3>' +
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
    ? " data-screens='" + JSON.stringify(screens).replace(/&/g, "&amp;").replace(/'/g, "&#39;") + "'" : "";
  const media = item.cover
    ? '<img src="' + altEsc(item.cover) + '" alt="' + altEsc(displayTitle(item)) + '" loading="lazy" />'
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
  const txt = altEsc(displayTitle(item));
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
    platChips(item, domain, "Cinéma") +
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
  const titre = altEsc(displayTitle(item));
  const vignette = item.cover
    ? '<img src="' + altEsc(item.cover) + '" alt="' + titre + '" loading="lazy" />'
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
    '<span class="gn">' + altEsc(sousTitre) + "</span></span>" +
    '<div class="item-hover-video"></div>' +
    "</article>";
}


/* ═══════════════════════════════════════════════════════════════════════════
   FICHE COMPLETE — le modal ET la page de l'item (/games/slug/, /anime/slug/)
   ═══════════════════════════════════════════════════════════════════════════
   Le modal construisait sa fiche dans SectionBlock ; la page avait la sienne,
   figee au build et d'un autre dessin (ni votes, ni infos, ni icones) : apres
   un F5 sur l'adresse d'une fiche, on ne retrouvait pas le modal. Les deux
   viennent maintenant d'ici. La page est rendue au build avec ce meme HTML
   (pour Google), puis rechargee avec les donnees en direct (rafraichirFiche).
   mode "modal" : le HTML du modal (titre h2, bande-annonce puis description).
   mode "page"  : titre h1 ; bande-annonce et description cote a cote (l'une
   sous l'autre au telephone) ; vignette au lieu de l'iframe : YouTube ne se
   charge qu'au clic, sur place. */
var FORMATS_ANIME = { TV: "Série TV", MOVIE: "Film", OVA: "OVA", ONA: "ONA", SPECIAL: "Spécial", TV_SHORT: "Court" };
var STATUTS_ANIME = { RELEASING: "En cours", FINISHED: "Terminé", NOT_YET_RELEASED: "Pas encore sorti", CANCELLED: "Annulé", HIATUS: "En pause" };

export function ficheHtml(item, domain, mode?) {
  var page = mode === "page";
  var videoId = item.trailerUrl ? ytId(item.trailerUrl) : null;
  var genres = (item.genre || "").split(",").map(function(g) { return g.trim(); }).filter(Boolean);
  var rawDesc = item.description || "";

  var epMatch = rawDesc.match(/\[EPISODES:(\d+)\]/);
  var fmtMatch = rawDesc.match(/\[FORMAT:(\w+)\]/);
  var statMatch = rawDesc.match(/\[STATUS:(\w+)\]/);
  var seaMatch = rawDesc.match(/\[SEASON:([^\]]+)\]/);
  var nextMatch = rawDesc.match(/\[NEXT_EP:(\d+)\]/);
  var desc = rawDesc.replace(/\[(?:EPISODES|FORMAT|STATUS|SEASON|NEXT_EP):[^\]]+\]/g, '').trim() || "Aucune description disponible pour le moment.";

  var animeInfoHtml = '';
  if (fmtMatch || epMatch || statMatch || seaMatch || nextMatch) {
    var infos = [];
    if (fmtMatch) infos.push('<span class="info-tag"><svg class="info-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/></svg>' + (FORMATS_ANIME[fmtMatch[1]] || fmtMatch[1]) + '</span>');
    if (epMatch) infos.push('<span class="info-tag"><svg class="info-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 12h20"/></svg>' + epMatch[1] + ' épisodes</span>');
    if (statMatch) {
      var st = statMatch[1];
      // Le [STATUS:] de la description peut etre perime (fige au fetch).
      // Une date au jour deja passee est fiable : l'anime est sorti, on corrige.
      // Une date au mois ou a l'annee ne dit pas le jour : on garde le statut.
      if (st === "NOT_YET_RELEASED" && item.releaseDate && (item.releasePrecision || "day") === "day") {
        var relSt = new Date(item.releaseDate); relSt.setHours(0,0,0,0);
        var todaySt = new Date(); todaySt.setHours(0,0,0,0);
        if (relSt <= todaySt) st = "RELEASING";
      }
      infos.push('<span class="info-tag"><svg class="info-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>' + (STATUTS_ANIME[st] || st) + '</span>');
    }
    if (seaMatch) infos.push('<span class="info-tag"><svg class="info-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg> ' + altEsc(seaMatch[1]) + '</span>');
    if (nextMatch) infos.push('<span class="info-tag countdown-info"><svg class="info-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Prochain : Épisode ' + nextMatch[1] + '</span>');
    animeInfoHtml = '<div class="detail-anime-info">' + infos.join('') + '</div>';
  }

  var v = item.votes || { up: 0, down: 0, total: 0, percent: 0 };
  var smiley = getSmiley(v.percent);
  var pegiLabel = formatPegi(item.rating);
  var ratingHtml = pegiLabel ? '<span class="pegi-tag"><svg class="tag-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6l8-3Z"/></svg>' + altEsc(pegiLabel) + '</span>' : '';
  var hype = getHypeLabel(item);
  var hypeHtml = '';
  if (hype === "Populaire") hypeHtml = '<span class="popular-tag"><svg class="tag-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 6-2.7 6-6 0-3.4-2.4-5-3.5-7.5C13.6 6.4 13 4 13 2c-2 1.5-4 4-4 7 0 1.5.5 2.5 1 3.5-1 0-2.5-1-3-2.5-1 1.5-1 3-1 6 0 3.3 2 6 6 6Z"/></svg>Populaire</span>';
  else if (hype === "Très attendu") hypeHtml = '<span class="anticipated-tag"><svg class="tag-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3 6.5 7 1-5 5 1.2 7L12 18l-6.2 3.5L7 14.5l-5-5 7-1Z"/></svg>Très attendu</span>';
  var screens = parseScreenshots(item);

  var mediaHtml = '';
  if (videoId && page) {
    // Vignette plutot qu'iframe : YouTube chargerait plusieurs centaines de
    // kilo-octets a l'ouverture, et Google mesure la vitesse des pages.
    mediaHtml = '<a class="fiche-trailer" href="https://www.youtube.com/watch?v=' + videoId + '" data-yt="' + videoId + '" target="_blank" rel="noopener noreferrer">' +
      '<img src="https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg" alt="Bande-annonce de ' + altEsc(displayTitle(item)) + '" loading="lazy" width="480" height="360" />' +
      '<span class="fiche-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg></span>' +
      '<span class="fiche-trailer-lab">Voir la bande-annonce</span></a>';
  } else if (videoId) {
    mediaHtml = '<div class="detail-trailer">' +
      '<iframe src="https://www.youtube.com/embed/' + videoId + '?rel=0" frameborder="0" allowfullscreen ' +
      'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>';
  } else if (screens.length) {
    mediaHtml = '<div class="detail-gallery">' +
      '<div class="gallery-main"><img src="' + altEsc(screens[0]) + '" alt="screenshot" id="galleryMain" /></div>' +
      '<div class="gallery-thumbs">' +
      screens.map(function(s, i) { return '<img src="' + altEsc(s) + '" alt="screenshot ' + (i+1) + '" class="gallery-thumb' + (i===0?' active':'') + '" />'; }).join("") +
      '</div></div>';
  }
  var descriptionHtml = '<div class="detail-description">' +
      (page ? '<h2>Description</h2>' : '<h3>Description</h3>') +
      '<p>' + descSure(desc) + '</p>' +
    '</div>';

  return '<div class="detail-header">' +
      '<div class="detail-cover">' + (item.cover ? '<img src="' + altEsc(item.cover) + '" alt="' + altEsc(displayTitle(item)) + '" />' : '') + '</div>' +
      '<div class="detail-info">' +
        (page ? '<h1>' + altEsc(displayTitle(item)) + '</h1>' : '<h2>' + altEsc(displayTitle(item)) + '</h2>') +
        altTitles(item) +
        detailDateBlock(item) +
        '<div class="detail-section-label">' + (domain === 'games' ? 'Où y jouer' : 'Où le regarder') + '</div>' +
        detailPlatforms(item) +
        '<div class="detail-genres">' +
          genres.map(function(g) { return '<span class="genre-tag"><svg class="tag-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9V4a1 1 0 0 1 1-1h5l12 12-6 6L2 9Z"/><circle cx="7" cy="8" r="1.4"/></svg>' + altEsc(g) + '</span>'; }).join("") +
          ratingHtml +
          hypeHtml +
        '</div>' +
        animeInfoHtml +
      '</div>' +
    '</div>' +
    (page
      ? '<div class="fiche-duo' + (mediaHtml ? '' : ' seule') + '">' + mediaHtml + descriptionHtml + '</div>'
      : mediaHtml + descriptionHtml) +
    '<div class="detail-votes">' +
      '<button class="vote-btn vote-up" data-vote="1">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z"/></svg>' +
        '<span>' + v.up + '</span>' +
      '</button>' +
      '<button class="vote-btn vote-down" data-vote="-1">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M22 4h-2c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h2V4zM2.17 11.12c-.11.25-.17.52-.17.8V13c0 1.1.9 2 2 2h5.5l-.92 4.65c-.05.22-.02.46.08.66.23.45.52.86.88 1.22L10 22l6.41-6.41c.38-.38.59-.89.59-1.42V6.34C17 5.05 15.95 4 14.66 4h-8.1c-.71 0-1.36.37-1.72.97L2.17 11.12z"/></svg>' +
        '<span>' + v.down + '</span>' +
      '</button>' +
      '<div class="vote-smiley">' +
        '<span class="smiley-emoji">' + smiley + '</span>' +
        '<span class="smiley-percent">' + v.percent + '%</span>' +
      '</div>' +
    '</div>';
}

/** Branche la fiche : galerie, votes et (page) la vignette qui lance la bande-annonce sur place.
 *  A appeler une fois par element insere : deux appels sur le meme bloc doubleraient les votes.
 *  L'element lui-meme compte (une vignette de bande-annonce remplacee seule au rechargement). */
function dansFiche(racine, sel) {
  var l = Array.prototype.slice.call(racine.querySelectorAll(sel));
  return racine.matches && racine.matches(sel) ? [racine].concat(l) : l;
}
export function brancherFiche(racine, domain, id) {
  dansFiche(racine, ".gallery-thumb").forEach(function(thumb) {
    thumb.addEventListener("click", function(ev) {
      ev.stopPropagation();
      var img = racine.querySelector("#galleryMain");
      if (img) img.src = thumb.src;
      racine.querySelectorAll(".gallery-thumb").forEach(function(t) { t.classList.remove("active"); });
      thumb.classList.add("active");
    });
  });
  dansFiche(racine, ".vote-btn").forEach(function(btn) {
    btn.addEventListener("click", async function(ev) {
      ev.stopPropagation();
      var vote = parseInt(btn.dataset.vote);
      try {
        var res = await postVote(domain, id, vote);
        var vd = res.votes;
        racine.querySelector(".vote-up span").textContent = String(vd.up);
        racine.querySelector(".vote-down span").textContent = String(vd.down);
        racine.querySelector(".smiley-emoji").textContent = getSmiley(vd.percent);
        racine.querySelector(".smiley-percent").textContent = vd.percent + "%";
      } catch (err) { console.error("Vote error:", err); }
    });
  });
  dansFiche(racine, "a.fiche-trailer[data-yt]").forEach(function(a) {
    a.addEventListener("click", function(ev) {
      ev.preventDefault();
      var yt = a.getAttribute("data-yt");
      var box = document.createElement("div");
      box.className = "detail-trailer";
      box.setAttribute("data-yt", yt);
      box.innerHTML = '<iframe src="https://www.youtube.com/embed/' + yt + '?rel=0&autoplay=1" frameborder="0" allowfullscreen ' +
        'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>';
      a.replaceWith(box);
    });
  });
}

/** Page : recharge la fiche avec les donnees en direct (le HTML livre date du build). Seuls les blocs
 *  qui ont change sont remplaces ; une bande-annonce en cours de lecture n'est jamais interrompue.
 *  Sans reponse de l'API, la fiche du build reste affichee. */
export async function rafraichirFiche(zone, domain, id) {
  var item;
  try {
    item = await getItemDetail(domain, id);
  } catch (e) {
    return false;
  }
  var neuf = document.createElement("div");
  neuf.innerHTML = ficheHtml(item, domain, "page");
  var a = Array.prototype.slice.call(zone.children), b = Array.prototype.slice.call(neuf.children);
  if (a.length !== b.length || a.some(function(x, k) { return x.className !== b[k].className; })) {
    zone.replaceChildren.apply(zone, b);
    brancherFiche(zone, domain, id);
    return true;
  }
  for (var k = 0; k < a.length; k++) {
    if (a[k].isEqualNode(b[k])) continue;
    if (a[k].classList.contains("fiche-duo")) {
      var ancien = Array.prototype.slice.call(a[k].children), nouveau = Array.prototype.slice.call(b[k].children);
      for (var j = 0; j < nouveau.length; j++) {
        var x = ancien[j], y = nouveau[j];
        if (x && x.isEqualNode(y)) continue;
        // Video lancee (iframe a la place de la vignette) et meme bande-annonce : on la laisse jouer.
        if (x && x.classList.contains("detail-trailer") && y.classList.contains("fiche-trailer") && x.getAttribute("data-yt") === y.getAttribute("data-yt")) continue;
        if (x) x.replaceWith(y); else a[k].appendChild(y);
        brancherFiche(y, domain, id);
      }
      continue;
    }
    a[k].replaceWith(b[k]);
    brancherFiche(b[k], domain, id);
  }
  return true;
}
