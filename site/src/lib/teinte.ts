// Couleur d'une jaquette (design Caméléon) pour la fiche : la page d'un jeu ou d'un anime et le modal.
// Le même calcul que les pages Accueil, Anime, Jeux et À venir (leurs scripts du coin), mot pour mot :
// teinte dominante de l'image réduite à 48 px, puis les couleurs --ep-* (accent, lumière, nuit, verre)
// réglées par les densités du design (--ep-k-fond, --ep-k-lueur, --ep-k-verre, --ep-k-voile).
// La teinte vient d'abord du manifeste des images HD (/hd/manifeste.json, calculée par le serveur : pas
// besoin d'autorisation de lecture), sinon de l'image elle-même. Sans teinte (image illisible ou sans
// autorisation de lecture) : rien n'est posé, l'élément garde les couleurs qu'il a.

function nb(x: number) { return Math.round(x * 10) / 10; }
function hsl(h: number, s: number, l: number, a?: number) {
  return (a === undefined ? "hsl(" : "hsla(") + h + ", " + nb(s) + "%, " + nb(l) + "%" + (a === undefined ? ")" : ", " + nb(a * 100) / 100 + ")");
}
function rgb(h: number, s: number, l: number) {
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [r, g, b].map(function (v) { return Math.round((v + m) * 255); }).join(", ");
}
function reglage(el: Element, n: string) {
  var v = parseFloat(getComputedStyle(el).getPropertyValue(n));
  return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
}

/** Pose les couleurs --ep-* de la teinte h (0 à 360) sur l'élément (la page : <html> ; le modal : le modal seul). */
export function teinter(el: HTMLElement, h: number) {
  var kf = reglage(el, "--ep-k-fond"), kl = reglage(el, "--ep-k-lueur"), kv = reglage(el, "--ep-k-verre"), kw = reglage(el, "--ep-k-voile");
  var t = ((Math.round(h) % 360) + 360) % 360, s = 1, st = el.style;
  st.setProperty("--ep-a", hsl(t, 85 * s, 72));             // accent clair (pastilles, onglet actif)
  st.setProperty("--ep-b", hsl(t, 70 * s, 56));             // accent profond (bas du degrade)
  st.setProperty("--ep-c", hsl(t, 80 * s, 58, .3 * kl));    // lumiere
  st.setProperty("--ep-c2", hsl(t, 80 * s, 58, .16 * kl));  // lumiere douce
  st.setProperty("--ep-d", hsl(t, 16 * s * kf, 9));         // nuit teintee (haut)
  st.setProperty("--ep-e", hsl(t, 12 * s * kf, 4));         // nuit teintee (bas)
  st.setProperty("--ep-f", hsl(t, 70 * s, 72, .34));        // filets et bords teintes
  st.setProperty("--ep-g", hsl(t, 75 * s, 87));             // texte pale teinte
  st.setProperty("--ep-h", hsl(t, 80 * s, 76, .55));        // reflet teinte (aretes)
  st.setProperty("--ep-p1", hsl(t, 20 * s * kv, 16, .5));   // verre teinte (haut)
  st.setProperty("--ep-p2", hsl(t, 16 * s * kv, 7, .8));    // verre teinte (bas)
  st.setProperty("--ep-rgb", rgb(t, 16 * s * kw, 6));       // voile sur les images, en r, g, b
}

var EP = ["--ep-a", "--ep-b", "--ep-c", "--ep-c2", "--ep-d", "--ep-e", "--ep-f", "--ep-g", "--ep-h", "--ep-p1", "--ep-p2", "--ep-rgb"];

/** Retire les couleurs posées par teinter : l'élément reprend celles qu'il hérite. */
export function deteinter(el: HTMLElement) {
  EP.forEach(function (n) { el.style.removeProperty(n); });
}

/** Les couleurs --ep-* que porte un élément en ce moment (pour les figer ailleurs avec poser). */
export function couleurs(el: Element): Record<string, string> {
  var cs = getComputedStyle(el), c: Record<string, string> = {};
  EP.forEach(function (n) { var v = cs.getPropertyValue(n).trim(); if (v) c[n] = v; });
  return c;
}

/** Pose sur l'élément des couleurs lues par couleurs(). */
export function poser(el: HTMLElement, c: Record<string, string>) {
  EP.forEach(function (n) { if (c[n]) el.style.setProperty(n, c[n]); });
}

// teinte dominante : histogramme des teintes (24 cases) pondere par la vivacite, puis la fenetre de
// 45 degres la plus lourde et sa moyenne circulaire. Les gris et les noirs ne comptent pas.
export function teinteDominante(d: Uint8ClampedArray): number | null {
  var poids: number[] = [], sx: number[] = [], sy: number[] = [], k;
  for (k = 0; k < 24; k++) { poids[k] = 0; sx[k] = 0; sy[k] = 0; }
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var v = mx, s = mx ? (mx - mn) / mx : 0;
    if (v < 0.2 || s < 0.18) continue;
    var c = mx - mn, h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
    h /= 6; if (h < 0) h += 1;
    var w = s * v * v;
    k = Math.floor(h * 24) % 24;
    poids[k] += w; sx[k] += w * Math.cos(2 * Math.PI * h); sy[k] += w * Math.sin(2 * Math.PI * h);
  }
  var best = -1, lourd = 0;
  for (k = 0; k < 24; k++) {
    var t = poids[(k + 23) % 24] + poids[k] + poids[(k + 1) % 24];
    if (t > lourd) { lourd = t; best = k; }
  }
  if (best < 0) return null;
  var x = 0, y = 0;
  [(best + 23) % 24, best, (best + 1) % 24].forEach(function (j) { x += sx[j]; y += sy[j]; });
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

var MEMO: Record<string, number | null> = {}, GARDE = "gn-teintes", garde: Record<string, number> = {};
function relire() { try { return JSON.parse(localStorage.getItem(GARDE) || "{}") || {}; } catch (e) { return {}; } }
garde = relire();

// le manifeste des images HD (une fois par page) : pour chaque jaquette traitee par le serveur, sa teinte (h)
var HD: Promise<Record<string, any> | null> | null = null;
function manifeste() {
  if (!HD) HD = fetch("/hd/manifeste.json").then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) { return m && m.images && typeof m.images === "object" ? m.images : null; })
    .catch(function () { return null; });
  return HD;
}

/** La teinte d'une image (memoire, puis le stockage du navigateur partage avec les pages, puis le manifeste
 *  des images HD, puis le calcul sur l'image). Deja connue : fin est appelee tout de suite. */
export function teinteImage(src: string, fin: (h: number | null) => void) {
  if (Object.prototype.hasOwnProperty.call(MEMO, src)) { fin(MEMO[src]); return; }
  if (typeof garde[src] === "number") { MEMO[src] = garde[src]; fin(garde[src]); return; }
  manifeste().then(function (images) {
    var e = images && Object.prototype.hasOwnProperty.call(images, src) ? images[src] : null;
    if (e && typeof e.h === "number" && isFinite(e.h)) { MEMO[src] = e.h; garder(src, e.h); fin(e.h); return; }
    calculer(src, fin);
  });
}

// la teinte gardee dans le navigateur, pour la prochaine visite (adresses courtes seulement : pas d'image en data:)
function garder(src: string, h: number) {
  if (src.length >= 400) return;
  try {
    var g = relire();                    // les pages ecrivent aussi ici : relu avant d'ajouter
    if (Object.keys(g).length > 300) g = {};
    g[src] = h; localStorage.setItem(GARDE, JSON.stringify(g)); garde = g;
  } catch (e) { /* stockage plein ou interdit : tant pis */ }
}

function calculer(src: string, fin: (h: number | null) => void) {
  var im = new Image();
  im.crossOrigin = "anonymous";          // l'image doit autoriser la lecture (CORS) ; sinon : neutre
  im.onload = function () {
    var h: number | null = null;
    try {
      var w = 48, hh = Math.max(1, Math.round(48 * im.naturalHeight / im.naturalWidth));
      var cv = document.createElement("canvas"); cv.width = w; cv.height = hh;
      var cx = cv.getContext("2d")!;
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
      cx.drawImage(im, 0, 0, w, hh);
      h = teinteDominante(cx.getImageData(0, 0, w, hh).data);
    } catch (e) { h = null; }
    MEMO[src] = h;
    if (h !== null) garder(src, h);
    fin(h);
  };
  im.onerror = function () { MEMO[src] = null; fin(null); };
  // image d'un autre site : adresse a part, pour ne pas reprendre la copie deja
  // en cache sans autorisation de lecture (celle de la carte)
  var u = src;
  try {
    if (/^https?:/i.test(src) && new URL(src, location.href).origin !== location.origin) u = src + (src.indexOf("?") < 0 ? "?" : "&") + "gn-teinte=1";
  } catch (e) { u = src; }
  im.src = u;
}
