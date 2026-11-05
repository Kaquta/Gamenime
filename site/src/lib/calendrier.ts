/**
 * Calendrier des sorties : les donnees, lues au build (onglet « Calendrier », 15 octobre 2026).
 *
 * - Les fiches : /feed/slugs, exactement les pages du site (une sortie du calendrier a toujours sa fiche).
 *   Chaque fiche y a un vrai lien <a href> ecrit au build : Google trouve ainsi toutes les fiches.
 * - Pour chaque mois : la jaquette, la plateforme et la popularite, lues dans /feed/anime et /feed/games
 *   (status=all, bornes du mois). Une fiche absente de ces flux garde son titre et son lien, sans jaquette.
 * - La fenetre : celle de l'API (core.ts, getReleaseWindow), lue une fois par build dans /feed/anime (champ « window ») :
 *   l'annee d'avant (jamais avant 2026), l'annee en cours et la suivante, 24 mois en 2026, 36 ensuite (fenetre de 3 ans).
 * Les lectures sont gardees en memoire le temps du build : toutes les pages lisent les memes donnees.
 * Si l'API ne repond pas, le build s'arrete : un calendrier vide serait le bug qu'on corrige.
 */
import { displayTitle, formatPlatforms } from "./api";

export type TypeSortie = "anime" | "game";
export type Precision = "day" | "month" | "year";

export interface Sortie {
  id: number;
  type: TypeSortie;
  titre: string;
  lien: string;
  date: string | null; // AAAA-MM-JJ, la date du site
  precision: Precision;
  jaquette: string | null;
  plateformes: string;
  film: boolean;
  /** pour l'ordre dans un jour : le score GameNime sans le bonus europeen (comparable entre animes et jeux,
   *  comme les listes melangees de l'API ; la popularite brute ne l'est pas : ~950 pour un anime, ~5 pour un jeu) */
  rang: number;
}

interface Extra {
  jaquette: string | null;
  plateformes: string;
  film: boolean;
  rang: number;
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_COURTS = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
export const JOURS_COURTS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function api(): string {
  return "https://gamenime.fr/api";
}

async function lireJson(chemin: string): Promise<any> {
  const r = await fetch(`${api()}${chemin}`);
  if (!r.ok) throw new Error(`Calendrier : ${chemin} a repondu ${r.status}`);
  return r.json();
}

// ── les fiches (une seule lecture par build)
let fichesP: Promise<Sortie[]> | null = null;

function precisionDe(p: unknown): Precision {
  return p === "month" || p === "year" ? p : "day";
}

async function chargerFiches(): Promise<Sortie[]> {
  const out: Sortie[] = [];
  for (const [type, dossier] of [["anime", "anime"], ["game", "games"]] as const) {
    const data = await lireJson(`/feed/slugs?type=${type}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) throw new Error(`Calendrier : /feed/slugs?type=${type} ne renvoie aucune fiche`);
    for (const f of items) {
      if (!f || !f.slug) continue;
      out.push({
        id: Number(f.id),
        type,
        titre: displayTitle(f),
        lien: `/${dossier}/${f.slug}/`,
        date: typeof f.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.releaseDate) ? f.releaseDate : null,
        precision: precisionDe(f.releasePrecision),
        jaquette: null,
        plateformes: "",
        film: false,
        rang: 0,
      });
    }
  }
  return out;
}

export function lesFiches(): Promise<Sortie[]> {
  if (!fichesP) fichesP = chargerFiches();
  return fichesP;
}

// ── jaquettes, plateformes et popularite, mois par mois (une lecture par mois et par build)
const extras = new Map<string, Promise<Map<string, Extra>[]>>();

export function bornes(cle: string): { debut: string; fin: string } {
  const [a, m] = cle.split("-").map(Number);
  const der = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { debut: `${cle}-01`, fin: `${cle}-${String(der).padStart(2, "0")}` };
}

async function chargerExtras(cle: string): Promise<Map<string, Extra>> {
  const { debut, fin } = bornes(cle);
  const q = `status=all&orderBy=date&limit=200&releasedAfter=${debut}&releasedBefore=${fin}`;
  const out = new Map<string, Extra>();
  for (const [type, flux] of [["anime", "anime"], ["game", "games"]] as const) {
    const data = await lireJson(`/feed/${flux}?${q}`);
    for (const i of Array.isArray(data?.items) ? data.items : []) {
      if (!i || i.id === undefined) continue;
      out.set(`${type}:${Number(i.id)}`, {
        jaquette: typeof i.cover === "string" && i.cover ? vignette(i.cover) : null,
        plateformes: type === "game" ? formatPlatforms(i.platform) : String(i.platform || "").split(",").map((p: string) => p.trim()).filter(Boolean).join(", "),
        film: i.format === "MOVIE",
        rang: (Number(i.gameNimeScore) || 0) - Math.max(0, Number(i.europeBonus) || 0),
      });
    }
  }
  return out;
}

/** Les extras des 12 mois d'une annee, lus un mois apres l'autre (pas de rafale de requetes vers l'API). */
function lesExtrasDeLAnnee(annee: string): Promise<Map<string, Extra>[]> {
  let p = extras.get(annee);
  if (!p) {
    p = (async () => {
      const l: Map<string, Extra>[] = [];
      for (let m = 1; m <= 12; m++) l.push(await chargerExtras(`${annee}-${String(m).padStart(2, "0")}`));
      return l;
    })();
    extras.set(annee, p);
  }
  return p;
}

/** La jaquette en petit : IGDB et AniList ont une taille vignette (la grande pese dix fois plus). */
function vignette(src: string): string {
  if (/^https:\/\/images\.igdb\.com\//.test(src)) return src.replace(/\/t_[a-z0-9_]+\//, "/t_cover_small/");
  if (/anilistcdn\/media\/anime\/cover\/(large|extraLarge)\//.test(src)) return src.replace(/\/cover\/(large|extraLarge)\//, "/cover/medium/");
  return src;
}

// ── la fenetre : celle de l'API (core.ts, getReleaseWindow), envoyee avec chaque liste (champ « window » de /feed/anime)
// et lue une fois par build : une seule regle pour tout le site (patch d'entretien, novembre 2026). Du 1er janvier de
// l'annee d'avant (jamais avant 2026) au 31 decembre de l'annee suivante : 24 mois en 2026, 36 ensuite ; les pages de
// l'annee d'avant restent en ligne. Sans fenetre lisible, le build s'arrete (comme sans fiches).
let fenetreP: Promise<string[]> | null = null;

async function chargerFenetre(): Promise<string[]> {
  const data = await lireJson("/feed/anime?status=all&limit=1");
  const jourIso = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}$/;
  const debut = jourIso.exec(String(data?.window?.start ?? ""));
  const fin = jourIso.exec(String(data?.window?.end ?? ""));
  if (!debut || !fin) throw new Error("Calendrier : /feed/anime ne donne pas la fenetre (champ window)");
  const l: string[] = [];
  let a = Number(debut[1]), m = Number(debut[2]);
  const aFin = Number(fin[1]), mFin = Number(fin[2]);
  while ((a < aFin || (a === aFin && m <= mFin)) && l.length <= 120) {
    l.push(`${a}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; a++; }
  }
  if (l.length === 0 || l.length > 120) throw new Error(`Calendrier : fenetre de l'API inattendue (${debut[0]} au ${fin[0]})`);
  return l;
}

export function moisDeLaFenetre(): Promise<string[]> {
  if (!fenetreP) fenetreP = chargerFenetre();
  return fenetreP;
}

/** Les annees de la fenetre, dans l'ordre (le choix « Annee » des filtres : 2026 et 2027 en 2026 ; 2026 a 2028 en 2027). */
export async function anneesDeLaFenetre(): Promise<string[]> {
  return [...new Set((await moisDeLaFenetre()).map((k) => k.slice(0, 4)))];
}

export function moisCourant(maintenant: Date = new Date()): string {
  return `${maintenant.getFullYear()}-${String(maintenant.getMonth() + 1).padStart(2, "0")}`;
}

export function libelleMois(cle: string): string {
  const [a, m] = cle.split("-").map(Number);
  return `${MOIS[m - 1][0].toUpperCase()}${MOIS[m - 1].slice(1)} ${a}`;
}

export function libelleCourt(cle: string): string {
  return MOIS_COURTS[Number(cle.slice(5, 7)) - 1];
}

/** « d'octobre 2026 », « de mars 2027 » */
export function deMois(cle: string): string {
  const [a, m] = cle.split("-").map(Number);
  const nom = MOIS[m - 1];
  return `${/^[aeiouyéèêâ]/.test(nom) ? "d'" : "de "}${nom} ${a}`;
}

// ── un mois : la grille (semaines du lundi au dimanche) et ses sorties
export interface Jour {
  date: string;
  n: number;
  dansMois: boolean;
  semaine: string; // « lun. », « mar. »…
  sorties: Sortie[];
}

/** Un volet sous la grille : les sorties sans jour precis, ou hors de la fenetre. */
export interface Vague {
  titre: string;
  sorties: Sortie[];
  ouvert: boolean;
}

export interface Mois {
  cle: string;
  libelle: string;
  semaines: Jour[][];
  vagues: Vague[];
  nAnime: number; // sorties du mois (au jour ou au mois pres)
  nJeux: number;
}

function ordre(a: Sortie, b: Sortie): number {
  return b.rang - a.rang || a.titre.localeCompare(b.titre, "fr");
}

export async function leMois(cle: string, maintenant: Date = new Date()): Promise<Mois> {
  const annee = cle.slice(0, 4);
  const toutes = await lesFiches();
  // les extras de toute l'annee : une sortie « courant 2027 » peut etre rangee a n'importe quel mois
  const cartes = await lesExtrasDeLAnnee(annee);
  const extra = (s: Sortie): Sortie => {
    for (const c of cartes) {
      const e = c.get(`${s.type}:${s.id}`);
      if (e) return { ...s, ...e };
    }
    return s;
  };

  // la fenetre : une fiche datee avant ou apres (encore au catalogue) a aussi son lien, sur le premier ou le dernier mois ;
  // une fiche sans date, sur le mois en cours
  const fenetre = await moisDeLaFenetre();
  const premierMois = fenetre[0], dernierMois = fenetre[fenetre.length - 1];
  const parJour = new Map<string, Sortie[]>();
  const auMois: Sortie[] = [], aLAnnee: Sortie[] = [], avant: Sortie[] = [], apres: Sortie[] = [], sansDate: Sortie[] = [];
  for (const s0 of toutes) {
    if (!s0.date) {
      if (cle === moisCourant(maintenant)) sansDate.push(s0);
      continue;
    }
    const k = s0.precision === "year" ? s0.date.slice(0, 4) : s0.date.slice(0, 7);
    if (k < premierMois.slice(0, k.length)) {
      if (cle === premierMois) avant.push(s0);
      continue;
    }
    if (k > dernierMois.slice(0, k.length)) {
      if (cle === dernierMois) apres.push(s0);
      continue;
    }
    if (s0.precision === "year") {
      if (k === annee) aLAnnee.push(extra(s0));
      continue;
    }
    if (k !== cle) continue;
    const s = extra(s0);
    if (s.precision === "month") auMois.push(s);
    else {
      const l = parJour.get(s.date!) || [];
      l.push(s);
      parJour.set(s.date!, l);
    }
  }
  for (const l of parJour.values()) l.sort(ordre);
  const vagues: Vague[] = [];
  const volet = (titre: string, l: Sortie[], ouvert: boolean) => {
    if (l.length) vagues.push({ titre, sorties: l.sort(ordre), ouvert });
  };
  volet(`${libelleMois(cle)} · jour non annoncé`, auMois, true);
  volet(`Prévus en ${annee}, sans date précise`, aLAnnee, false);
  volet(`Sortis avant ${premierMois.slice(0, 4)}`, avant, false);
  volet(`Prévus après ${dernierMois.slice(0, 4)}`, apres, false);
  volet("Date à annoncer", sansDate, false);

  // la grille : du lundi de la premiere semaine au dimanche de la derniere
  const [a, m] = cle.split("-").map(Number);
  const premier = new Date(Date.UTC(a, m - 1, 1));
  const decal = (premier.getUTCDay() + 6) % 7;
  const nbJours = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const cases = Math.ceil((decal + nbJours) / 7) * 7;
  const semaines: Jour[][] = [];
  for (let k = 0; k < cases; k++) {
    const d = new Date(Date.UTC(a, m - 1, 1 - decal + k));
    const iso = d.toISOString().slice(0, 10);
    const dansMois = d.getUTCMonth() === m - 1;
    if (k % 7 === 0) semaines.push([]);
    semaines[semaines.length - 1].push({
      date: iso,
      n: d.getUTCDate(),
      dansMois,
      semaine: `${JOURS_COURTS[k % 7].toLowerCase()}.`,
      sorties: dansMois ? parJour.get(iso) || [] : [],
    });
  }

  const duMois = [...[...parJour.values()].flat(), ...auMois];
  return {
    cle,
    libelle: libelleMois(cle),
    semaines,
    vagues,
    nAnime: duMois.filter((s) => s.type === "anime").length,
    nJeux: duMois.filter((s) => s.type === "game").length,
  };
}

/** Le nombre de sorties de chaque mois de la fenetre (la bande des mois grise les mois vides). */
export async function comptesParMois(fenetre: string[]): Promise<Record<string, number>> {
  const toutes = await lesFiches();
  const c: Record<string, number> = Object.fromEntries(fenetre.map((k) => [k, 0]));
  for (const s of toutes) {
    if (!s.date || s.precision === "year") continue;
    const k = s.date.slice(0, 7);
    if (k in c) c[k]++;
  }
  return c;
}
