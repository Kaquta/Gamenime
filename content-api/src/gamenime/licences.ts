/**
 * licences.ts — Le module des licences : chaque fiche du site dans sa licence, et le passé de chaque licence (repères),
 * pour le bloc « Univers » de la fiche, l'onglet Univers et les pages par licence.
 *
 * Plan validé par Rey le 22 octobre 2026 (« Yes, oubli pas mes maquettes » ; licences-module-plan.md). Les règles sont dans
 * licences-calcul.ts, les lectures dans licences-sources.ts. Ici :
 *  - un passage par jour, à 3 h 10 UTC, ligne « Licences et univers » du Pilotage (famille « Univers ») ; un passage
 *    manqué est rattrapé 22 min après le démarrage, ou 1 min après le rallumage ; ▶ lance un passage complet ;
 *  - installé coupé (LICENCES_ENABLED à « 1 » pour l'allumer à la première mise en route) : un essai à blanc d'abord
 *    (licences-essai.ts, lancé dans l'API par POST /admin/licences/essai : il partage le rythme AniList de l'API, sa
 *    suspension après un 429 et le jeton Twitch), puis Rey allume la ligne ;
 *  - couper la ligne n'efface rien : le calcul s'arrête, les licences déjà calculées restent servies ;
 *  - n'écrit que dans ses tables (licences, licences_fiches, licences_reperes, licences_directs, licences_etat), créées
 *    sous son verrou ; aucune fiche n'est touchée (ni updated_at, ni le sitemap) ;
 *  - tout ou rien : une transaction ; une source en panne (rouge), un passage incomplet ou une baisse anormale (orange) :
 *    rien n'est écrit, l'ancien calcul reste servi, nouvel essai 6 h plus tard (passage automatique) ; une baisse
 *    anormale revue au moins 18 h plus tard (et moins de 3 jours) est écrite ;
 *  - une licence n'est jamais supprimée : sans fiche sur le radar, elle passe en sommeil et garde ses clés ; elle se
 *    réveille avec le même identifiant quand une sortie de la licence revient sur le radar ;
 *  - l'API : le champ « univers » des fiches (GET /anime/items/:id, /games/items/:id), GET /feed/univers et
 *    GET /univers/:slug ; licences et repères en mémoire, les autres sorties relues dans la base (gardées 30 s : leurs
 *    dates sont celles de leur propre fiche).
 *
 * Variables : LICENCES_ENABLED (première mise en route seulement) ; pour les essais seulement :
 * LICENCES_ANILIST_URL, LICENCES_IGDB_URL, LICENCES_WDQS_URL, LICENCES_PAUSE_AL_MS, LICENCES_PAUSE_IG_MS,
 * LICENCES_PAUSE_WD_MS, LICENCES_ATTENTE_MS, LICENCES_N8N (« 0 »), LICENCES_N8N_DECALAGE_MIN, LICENCES_N8N_ECHELLE,
 * LICENCES_LIMITE_MIN, LICENCES_CACHE_SORTIES_MS, LICENCES_RELIRE_MS.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pushActivity } from "./dashboard.js";
import { prendreVerrou } from "./igdb-jeux.js";
import { ascLigne, calculerLicences, choisirReperes, mesurer, norm, slugLicence, VERSION_REGLES, REGLES_PAR_DEFAUT } from "./licences-calcul.js";
import type { Calcul, Dom, FicheSite, LicenceCalculee, Origine, RepereBloc, Regles } from "./licences-calcul.js";
import { AniList, Igdb, Incomplet, PanneSource, Wikidata } from "./licences-sources.js";
import { planifier } from "./pilotage.js";
import type { Journal, SqlPool } from "./presse.js";
import { ANIME_VISIBLE, DATE_ANIME_SITE, PLATEFORME_ANIME_SITE, PRECISION_ANIME_SITE } from "./routes.js";

const MIN = 60 * 1000;
const H = 60 * MIN;
const VERROU = "gamenime_licences";
const APRES_ECHEC_MS = 6 * H;
const AGENT = "GameNime/1.0 (https://gamenime.fr; licences et univers) Node.js";

// ─────────────────────────────────────────────────────────────── configuration

export interface LicencesDeps {
  pool: SqlPool & { getConnection?: () => Promise<any> };
  log: Journal;
  /** GET d'une route de l'API (flux du site) : l'API elle-même (app.inject) ; l'essai passe par HTTP. */
  lireFlux: (chemin: string) => Promise<any>;
  /** Appel IGDB : igdbFetch (jeton Twitch partagé) par défaut. */
  igdb?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface LicencesConfig {
  anilistUrl: string;
  igdbBase: string;
  wdqsUrl: string;
  pauseAl: number;
  pauseIg: number;
  pauseWd: number;
  attenteMs: number | undefined;
  n8n: boolean;
  /** Essais seulement : décale l'horloge de la pause n8n (minutes) et la raccourcit. */
  n8nDecalageMin: number;
  n8nEchelle: number;
  limiteMs: number;
  reqAlMax: number;
  reqIgMax: number;
  regles: Regles;
}

const nombre = (v: string | undefined, d: number): number => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function configLicences(env: Record<string, string | undefined> = process.env): LicencesConfig {
  return {
    anilistUrl: env["LICENCES_ANILIST_URL"] || "https://graphql.anilist.co",
    igdbBase: String(env["LICENCES_IGDB_URL"] || "https://api.igdb.com/v4").replace(/\/+$/, ""),
    wdqsUrl: env["LICENCES_WDQS_URL"] || "https://query.wikidata.org/sparql",
    pauseAl: nombre(env["LICENCES_PAUSE_AL_MS"], 4000),
    pauseIg: nombre(env["LICENCES_PAUSE_IG_MS"], 600),
    pauseWd: nombre(env["LICENCES_PAUSE_WD_MS"], 1500),
    attenteMs: env["LICENCES_ATTENTE_MS"] ? nombre(env["LICENCES_ATTENTE_MS"], 0) : undefined,
    n8n: env["LICENCES_N8N"] !== "0",
    n8nDecalageMin: nombre(env["LICENCES_N8N_DECALAGE_MIN"], 0),
    n8nEchelle: Math.min(1, Math.max(0, nombre(env["LICENCES_N8N_ECHELLE"], 1))),
    limiteMs: nombre(env["LICENCES_LIMITE_MIN"], 50) * MIN,
    reqAlMax: 150,
    reqIgMax: 900,
    regles: { ...REGLES_PAR_DEFAUT },
  };
}

// ─────────────────────────────────────────────────────────────── tables

const TABLES = [
  "CREATE TABLE IF NOT EXISTS licences (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL, " +
    "nom VARCHAR(255) NOT NULL, actif TINYINT NOT NULL DEFAULT 1, origine_type VARCHAR(30) NULL, origine_titre VARCHAR(255) NULL, " +
    "origine_auteurs VARCHAR(255) NULL, cles MEDIUMTEXT NOT NULL, anciens_slugs TEXT NULL, nb_fiches SMALLINT UNSIGNED NOT NULL DEFAULT 0, " +
    "nb_animes SMALLINT UNSIGNED NOT NULL DEFAULT 0, nb_jeux SMALLINT UNSIGNED NOT NULL DEFAULT 0, nb_reperes SMALLINT UNSIGNED NOT NULL DEFAULT 0, " +
    "pop INT NOT NULL DEFAULT 0, fusionnee_dans INT UNSIGNED NULL, creee_le DATETIME NOT NULL, vue_le DATETIME NOT NULL, " +
    "UNIQUE KEY slug (slug)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS licences_fiches (domaine VARCHAR(5) NOT NULL, item_id INT NOT NULL, licence_id INT UNSIGNED NOT NULL, " +
    "par VARCHAR(40) NOT NULL, origine_type VARCHAR(30) NULL, origine_titre VARCHAR(255) NULL, origine_auteurs VARCHAR(255) NULL, " +
    "PRIMARY KEY (domaine, item_id), KEY licence (licence_id)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS licences_reperes (source VARCHAR(8) NOT NULL, source_id INT NOT NULL, licence_id INT UNSIGNED NOT NULL, " +
    "domaine VARCHAR(5) NOT NULL, titre VARCHAR(300) NOT NULL, format VARCHAR(30) NULL, annee SMALLINT NOT NULL, popularite INT NOT NULL, " +
    "principal TINYINT NOT NULL, par VARCHAR(20) NOT NULL, PRIMARY KEY (source, source_id), KEY licence (licence_id)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS licences_directs (domaine VARCHAR(5) NOT NULL, item_id INT NOT NULL, source VARCHAR(8) NOT NULL, " +
    "source_id INT NOT NULL, nature VARCHAR(20) NOT NULL, PRIMARY KEY (domaine, item_id, source, source_id)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS licences_etat (cle VARCHAR(40) NOT NULL PRIMARY KEY, valeur MEDIUMTEXT NULL, le DATETIME NOT NULL) CHARACTER SET utf8mb4",
];
export async function creerTables(pool: SqlPool): Promise<void> {
  for (const t of TABLES) await pool.query(t);
}

// ─────────────────────────────────────────────────────────────── les fiches du site

const N = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tableAbsente = (e: any): boolean => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e?.message ?? e)) || e?.code === "ER_NO_SUCH_TABLE";
const items = (d: any): any[] => (Array.isArray(d?.items) ? d.items : []).filter((x: any) => x && N(x.id) > 0);

/**
 * Les fiches du site, comme le relevé v3.1 les a lues : celles qui ont une page (/feed/slugs, comme le build), et celles
 * que montrent les listes (derniers sortis, à venir, Top 25, les 24 mois du calendrier), avec ou sans page.
 */
export async function lireFiches(deps: Pick<LicencesDeps, "pool" | "lireFlux">, annee: number): Promise<FicheSite[]> {
  const vues = new Map<string, any>();
  const ajouter = (dom: Dom, x: any, page: boolean) => {
    const k = dom + ":" + N(x.id);
    const o = vues.get(k) || { dom, id: N(x.id), page: false };
    o.page = o.page || page;
    for (const c of ["title", "titleEnglish", "releaseDate", "releasePrecision", "format", "popularity"]) if (o[c] == null && x[c] != null) o[c] = x[c];
    vues.set(k, o);
  };
  for (const x of items(await deps.lireFlux("/feed/slugs?type=anime"))) ajouter("anime", x, true);
  for (const x of items(await deps.lireFlux("/feed/slugs?type=game"))) ajouter("game", x, true);
  const mois: string[] = [];
  for (let a = annee; a <= annee + 1; a++) for (let m = 1; m <= 12; m++) {
    const fin = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    mois.push(`status=all&orderBy=date&limit=200&releasedAfter=${a}-${mm}-01&releasedBefore=${a}-${mm}-${fin}`);
  }
  for (const [dom, flux] of [["anime", "anime"], ["game", "games"]] as Array<[Dom, string]>) {
    for (const q of ["status=released&limit=150&orderBy=date", "status=upcoming&limit=300&orderBy=date", "status=released&limit=25", ...mois]) {
      for (const x of items(await deps.lireFlux(`/feed/${flux}?${q}`))) ajouter(dom, x, false);
    }
  }
  const lus = [...vues.values()];
  const sa = lus.filter((x) => x.dom === "anime"), sg = lus.filter((x) => x.dom === "game");
  const base = { anime: new Map<number, any>(), game: new Map<number, any>() };
  const colA = new Set((await deps.pool.query("SHOW COLUMNS FROM anime_items")).map((c: any) => String(c.Field)));
  const colG = new Set((await deps.pool.query("SHOW COLUMNS FROM game_items")).map((c: any) => String(c.Field)));
  const ca = ["anilist_id", "mal_id", "format", "popularity"].filter((c) => colA.has(c));
  const cg = ["igdb_id", "popularity"].filter((c) => colG.has(c));
  for (let i = 0; i < sa.length; i += 500) for (const l of await deps.pool.query(`SELECT id, ${ca.join(", ")} FROM anime_items WHERE id IN (?)`, [sa.slice(i, i + 500).map((a) => a.id)])) base.anime.set(N(l.id), l);
  for (let i = 0; i < sg.length; i += 500) for (const l of await deps.pool.query(`SELECT id, ${cg.join(", ")} FROM game_items WHERE id IN (?)`, [sg.slice(i, i + 500).map((g) => g.id)])) base.game.set(N(l.id), l);
  return lus
    .map((x): FicheSite => {
      const l = (x.dom === "anime" ? base.anime : base.game).get(x.id) || {};
      return {
        dom: x.dom, id: x.id, page: x.page, titre: x.titleEnglish || x.title || null, titreVo: x.title || null,
        format: x.dom === "anime" ? l.format || x.format || null : null, date: x.releaseDate || null, prec: x.releasePrecision || null,
        pop: N(l.popularity ?? x.popularity),
        anilist: x.dom === "anime" && N(l.anilist_id) > 0 ? N(l.anilist_id) : null,
        malBase: x.dom === "anime" && N(l.mal_id) > 0 ? N(l.mal_id) : null,
        igdb: x.dom === "game" && N(l.igdb_id) > 0 ? N(l.igdb_id) : null,
      };
    })
    .sort((a, b) => (a.dom === b.dom ? a.id - b.id : a.dom === "anime" ? -1 : 1));
}

// ─────────────────────────────────────────────────────────────── la mémoire (ce que l'API sert)

interface LicenceMem {
  id: number;
  slug: string;
  nom: string;
  origine: Origine | null;
  pop: number;
  nbAnimes: number;
  nbJeux: number;
}
export interface Memoire {
  /** Les repères sont d'avant cette année (« Avant 2026 »). */
  avant: number;
  regles: string | null;
  licences: Map<number, LicenceMem>;
  parSlug: Map<string, number>;
  fiche: Map<string, { licence: number; origine: Origine | null }>;
  membres: Map<number, Array<{ dom: Dom; id: number }>>;
  reperes: Map<number, RepereBloc[]>;
  directs: Map<string, Set<string>>;
  directsListe: Map<number, Array<{ dom: Dom; id: number; source: string; sourceId: number }>>;
  feed: any | null;
}
let MEMOIRE: Memoire | null = null;
/** Chaque lecture de la mémoire a son numéro : seule la plus récente commencée remplace la mémoire servie. */
let GENERATION = 0;
/** La première lecture après le démarrage : les routes l'attendent (8 s au plus) plutôt que de servir une fiche sans univers. */
let PREMIERE: Promise<void> | null = null;
let MEMOIRE_LUE = false;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function memoirePrete(): Promise<Memoire | null> {
  if (!MEMOIRE_LUE && PREMIERE) await Promise.race([PREMIERE, dormir(8000)]);
  return MEMOIRE;
}
/** Relit la mémoire et la sert, si aucune lecture plus récente n'a commencé entre-temps. */
async function relireMemoire(pool: SqlPool): Promise<void> {
  const g = ++GENERATION;
  const m = await chargerMemoire(pool);
  if (g === GENERATION) {
    MEMOIRE = m;
    MEMOIRE_LUE = true;
  }
}

const origineDe = (type: unknown, titre: unknown, auteurs: unknown): Origine | null =>
  type ? { type: String(type), titre: titre ? String(titre) : null, auteurs: String(auteurs || "").split("|").map((s) => s.trim()).filter(Boolean) } : null;

/**
 * Les licences actives, relues dans la base ; null si le module n'a encore rien écrit (ou si ses tables manquent). Les
 * cinq lectures se font dans une même transaction en lecture seule : elles voient toutes la base au même instant, même si
 * un passage écrit pendant ce temps.
 */
export async function chargerMemoire(pool: SqlPool & { getConnection?: () => Promise<any> }): Promise<Memoire | null> {
  const conn = typeof pool.getConnection === "function" ? await pool.getConnection() : null;
  const q = (sql: string): Promise<any> => (conn ? conn.query(sql) : pool.query(sql));
  try {
    if (conn) await q("START TRANSACTION READ ONLY");
    const m = await lireMemoire(q);
    if (conn) await q("COMMIT");
    return m;
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch {
        /* déjà rendue */
      }
    }
  }
}

async function lireMemoire(q: (sql: string) => Promise<any>): Promise<Memoire | null> {
  let lignes: any[];
  try {
    lignes = await q("SELECT id, slug, nom, origine_type, origine_titre, origine_auteurs, pop, nb_animes, nb_jeux, anciens_slugs FROM licences WHERE actif = 1");
  } catch (e: any) {
    if (tableAbsente(e)) return null;
    throw e;
  }
  if (!lignes.length) return null;
  const etat = new Map<string, string>();
  for (const l of await q("SELECT cle, valeur FROM licences_etat")) etat.set(String(l.cle), String(l.valeur ?? ""));
  const m: Memoire = {
    avant: N(etat.get("annee")) || new Date().getUTCFullYear(), regles: etat.get("regles") ?? null,
    licences: new Map(), parSlug: new Map(), fiche: new Map(), membres: new Map(), reperes: new Map(), directs: new Map(), directsListe: new Map(), feed: null,
  };
  for (const l of lignes) {
    const id = N(l.id);
    m.licences.set(id, { id, slug: String(l.slug), nom: String(l.nom), origine: origineDe(l.origine_type, l.origine_titre, l.origine_auteurs), pop: N(l.pop), nbAnimes: N(l.nb_animes), nbJeux: N(l.nb_jeux) });
    m.parSlug.set(String(l.slug), id);
    let anciens: unknown = [];
    try {
      anciens = JSON.parse(String(l.anciens_slugs || "[]"));
    } catch {
      anciens = [];
    }
    for (const s of Array.isArray(anciens) ? anciens : []) if (!m.parSlug.has(String(s))) m.parSlug.set(String(s), id);
  }
  // les adresses des licences fondues dans une autre mènent à celle qui les a reprises (10 fusions de suite au plus)
  {
    const fondues = new Map<number, { slugs: string[]; dans: number }>();
    for (const l of await q("SELECT id, slug, anciens_slugs, fusionnee_dans FROM licences WHERE actif = 0 AND fusionnee_dans IS NOT NULL")) {
      let anciens: unknown = [];
      try {
        anciens = JSON.parse(String(l.anciens_slugs || "[]"));
      } catch {
        anciens = [];
      }
      fondues.set(N(l.id), { slugs: [String(l.slug), ...(Array.isArray(anciens) ? anciens.map(String) : [])], dans: N(l.fusionnee_dans) });
    }
    for (const [, f] of fondues) {
      let cible = f.dans;
      for (let k = 0; k < 10 && !m.licences.has(cible) && fondues.has(cible); k++) cible = (fondues.get(cible) as { dans: number }).dans;
      if (m.licences.has(cible)) for (const s of f.slugs) if (!m.parSlug.has(s)) m.parSlug.set(s, cible);
    }
  }
  for (const l of await q("SELECT domaine, item_id, licence_id, origine_type, origine_titre, origine_auteurs FROM licences_fiches")) {
    const lic = N(l.licence_id);
    if (!m.licences.has(lic)) continue;
    const dom = (l.domaine === "anime" ? "anime" : "game") as Dom;
    m.fiche.set(`${dom}:${N(l.item_id)}`, { licence: lic, origine: origineDe(l.origine_type, l.origine_titre, l.origine_auteurs) });
    const liste = m.membres.get(lic) || [];
    liste.push({ dom, id: N(l.item_id) });
    m.membres.set(lic, liste);
  }
  for (const l of await q("SELECT source, source_id, licence_id, domaine, titre, format, annee, popularite, principal FROM licences_reperes")) {
    const lic = N(l.licence_id);
    if (!m.licences.has(lic)) continue;
    const liste = m.reperes.get(lic) || [];
    liste.push({ source: l.source === "igdb" ? "igdb" : "anilist", id: N(l.source_id), dom: l.domaine === "anime" ? "anime" : "game", titre: String(l.titre), format: l.format ? String(l.format) : null, annee: N(l.annee), pop: N(l.popularite), principal: N(l.principal) === 1 });
    m.reperes.set(lic, liste);
  }
  for (const l of await q("SELECT domaine, item_id, source, source_id FROM licences_directs")) {
    const dom = (l.domaine === "anime" ? "anime" : "game") as Dom;
    const k = `${dom}:${N(l.item_id)}`;
    const s = m.directs.get(k) || new Set<string>();
    s.add(`${l.source}:${N(l.source_id)}`);
    m.directs.set(k, s);
    const f = m.fiche.get(k);
    if (f) {
      const liste = m.directsListe.get(f.licence) || [];
      liste.push({ dom, id: N(l.item_id), source: String(l.source), sourceId: N(l.source_id) });
      m.directsListe.set(f.licence, liste);
    }
  }
  return m;
}

/** Les mesures d'une mémoire (garde-fou) : le même calcul que pour un passage. */
function mesurerMemoire(m: Memoire): ReturnType<typeof mesurer> {
  return mesurer([...m.licences.keys()].map((id) => ({ membres: m.membres.get(id) || [], reperes: m.reperes.get(id) || [], directs: m.directsListe.get(id) || [] })));
}

// ─────────────────────────────────────────────────────────────── ce que l'API sert

export interface Sortie {
  type: Dom;
  id: number;
  slug: string | null;
  title: string | null;
  titleEnglish: string | null;
  format: string | null;
  statut: string | null;
  platform: string | null;
  cover: string | null;
  releaseDate: string | null;
  releasePrecision: string | null;
}

/** Les sorties du radar d'une licence, avec les données à jour de leur fiche (mêmes règles que les flux). */
async function lireSorties(pool: SqlPool, liste: Array<{ dom: Dom; id: number }>): Promise<Sortie[]> {
  const ia = liste.filter((x) => x.dom === "anime").map((x) => x.id), ig = liste.filter((x) => x.dom === "game").map((x) => x.id);
  const out: Sortie[] = [];
  if (ia.length) {
    for (const l of await pool.query(
      `SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish, format, statut_anilist AS statut, ${PLATEFORME_ANIME_SITE} AS platform, cover,
              DATE_FORMAT(${DATE_ANIME_SITE}, '%Y-%m-%d') AS releaseDate, ${PRECISION_ANIME_SITE} AS releasePrecision
       FROM anime_items WHERE id IN (?) AND ${ANIME_VISIBLE}`, [ia])) {
      out.push({ type: "anime", id: N(l.id), slug: l.slug ? String(l.slug) : null, title: l.title ?? null, titleEnglish: l.titleEnglish ?? null, format: l.format ?? null, statut: l.statut ?? null, platform: l.platform ?? null, cover: l.cover ?? null, releaseDate: l.releaseDate ?? null, releasePrecision: l.releasePrecision ?? null });
    }
  }
  if (ig.length) {
    for (const l of await pool.query(
      `SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish, platform, cover,
              DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate, release_precision AS releasePrecision
       FROM game_items WHERE id IN (?)`, [ig])) {
      out.push({ type: "game", id: N(l.id), slug: l.slug ? String(l.slug) : null, title: l.title ?? null, titleEnglish: l.titleEnglish ?? null, format: null, statut: null, platform: l.platform ?? null, cover: l.cover ?? null, releaseDate: l.releaseDate ?? null, releasePrecision: l.releasePrecision ?? null });
    }
  }
  return out.sort((a, b) => String(a.releaseDate ?? "9999").localeCompare(String(b.releaseDate ?? "9999")) || a.id - b.id);
}

/**
 * Les sorties du radar d'une licence, gardées 30 s (le build du site demande toutes ses fiches d'un coup : une lecture
 * par licence, pas une par fiche). Le cache est celui de la mémoire servie : une nouvelle mémoire (passage écrit) relit
 * les sorties de ses propres membres, et l'ancienne part avec son cache (WeakMap).
 */
const CACHE_SORTIES = new WeakMap<Memoire, Map<number, { t: number; p: Promise<Sortie[]> }>>();
function sortiesLicence(pool: SqlPool, m: Memoire, lic: number): Promise<Sortie[]> {
  let parLicence = CACHE_SORTIES.get(m);
  if (!parLicence) CACHE_SORTIES.set(m, (parLicence = new Map()));
  const cache = parLicence;
  const c = cache.get(lic);
  if (c && Date.now() - c.t < nombre(process.env.LICENCES_CACHE_SORTIES_MS, 30000)) return c.p;
  if (cache.size > 5000) cache.clear();
  const p = lireSorties(pool, m.membres.get(lic) || []);
  cache.set(lic, { t: Date.now(), p });
  p.catch(() => {
    if (cache.get(lic)?.p === p) cache.delete(lic);
  });
  return p;
}
/** Le champ univers d'une fiche porte au plus 40 autres sorties (une licence anormale ne gonfle pas chaque fiche). */
const AUTRES_MAX = 40;
const repereSortie = (x: RepereBloc & { direct?: boolean }) => ({ titre: x.titre, type: x.dom, format: x.format, annee: x.annee, direct: !!x.direct });

/** Le champ « univers » d'une fiche (null : pas encore de licence calculée pour elle). */
export async function universDe(pool: SqlPool, type: Dom, id: number): Promise<Record<string, any> | null> {
  const m = await memoirePrete();
  if (!m) return null;
  const k = `${type}:${id}`;
  const f = m.fiche.get(k);
  const L = f ? m.licences.get(f.licence) : undefined;
  if (!f || !L) return null;
  const autres = (m.membres.get(L.id) || []).filter((x) => !(x.dom === type && x.id === id));
  const lues = autres.length ? (await sortiesLicence(pool, m, L.id)).filter((x) => !(x.type === type && x.id === id)) : [];
  return {
    id: L.id,
    slug: L.slug,
    nom: L.nom,
    origine: type === "anime" ? f.origine : L.origine,
    // le bloc en montre bien moins ; la page de l'univers les a toutes
    autres: lues.length > AUTRES_MAX ? lues.slice(0, AUTRES_MAX) : lues,
    nbAutres: lues.length,
    reperes: choisirReperes(type, m.reperes.get(L.id) || [], m.directs.get(k) || new Set()).map(repereSortie),
    avant: m.avant,
  };
}

// ─────────────────────────────────────────────────────────────── l'essai à blanc, dans l'API

/** Les dépendances du module (posées par startLicencesCron) : l'essai à blanc les reprend. */
let DEPS: LicencesDeps | null = null;
interface EssaiDansApi {
  debut: number;
  fin: number | null;
  code: number | null;
  lignes: string[];
}
let ESSAI: EssaiDansApi | null = null;
const LIGNES_ESSAI_MAX = 6000;
const iso = (t: number): string => new Date(t).toISOString();

function cleAttendue(): string {
  return process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY || "";
}
function cleBonne(fournie: unknown): boolean {
  const attendue = cleAttendue();
  if (!attendue || typeof fournie !== "string") return false;
  const a = Buffer.from(attendue), b = Buffer.from(fournie);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** La clé d'administration (comme le Pilotage) ; false : la réponse est partie. */
function garde(req: any, reply: any): boolean {
  if (!cleAttendue()) {
    reply.code(500).send({ ok: false, msg: "clé d'administration non configurée" });
    return false;
  }
  if (!cleBonne(req.headers["x-api-key"])) {
    reply.code(401).send({ ok: false, msg: "non autorisé" });
    return false;
  }
  return true;
}

/** Lance l'essai à blanc dans l'API ; il tourne jusqu'au bout, même si personne ne suit plus son rapport. */
function lancerEssai(deps: LicencesDeps): EssaiDansApi {
  const e: EssaiDansApi = { debut: Date.now(), fin: null, code: null, lignes: [] };
  const dire = (l: string) => {
    if (e.lignes.length < LIGNES_ESSAI_MAX) e.lignes.push(ascLigne(l));
  };
  // les avertissements du calcul vont au journal de l'API et au rapport, comme en ligne de commande
  const log = {
    info: (o: object, m?: string) => deps.log.info(o, m),
    warn: (o: object, m?: string) => {
      deps.log.warn(o, m);
      dire(`  (avertissement) ${m ?? ""} ${JSON.stringify(o)}`);
    },
    error: (o: object, m?: string) => {
      deps.log.error?.(o, m);
      dire(`  (erreur) ${m ?? ""} ${JSON.stringify(o)}`);
    },
  } as Journal;
  void (async () => {
    try {
      const { essaiLicences } = await import("./licences-essai.js");
      e.code = await essaiLicences({ pool: deps.pool, lireFlux: deps.lireFlux, log }, configLicences(process.env), dire, "/tmp/licences-essai.json");
    } catch (x) {
      dire("");
      dire(`ARRET : ${message(x)} : rien n'a ete ecrit.`);
      e.code = 1;
    } finally {
      e.fin = Date.now();
    }
  })();
  return e;
}

export function registerLicencesRoutes(app: FastifyInstance, pool: SqlPool): void {
  // l'essai à blanc, dans l'API (licences-essai.sh) : il partage le rythme AniList de l'API et le jeton Twitch.
  // POST : le lance (409 s'il tourne déjà) ; GET ?depuis=N : son rapport, à partir de la ligne N.
  app.post("/admin/licences/essai", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    reply.header("Cache-Control", "no-store");
    if (ESSAI && ESSAI.fin == null) return reply.code(409).send({ ok: false, enCours: true, debut: iso(ESSAI.debut) });
    if (!DEPS) return reply.code(503).send({ ok: false, msg: "module des licences pas encore démarré" });
    ESSAI = lancerEssai(DEPS);
    return reply.code(202).send({ ok: true, debut: iso(ESSAI.debut) });
  });
  app.get("/admin/licences/essai", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    reply.header("Cache-Control", "no-store");
    const e = ESSAI;
    if (!e) return { ok: true, essai: null };
    const depuis = Math.max(0, Math.floor(Number(req.query?.depuis) || 0));
    return { ok: true, essai: { debut: iso(e.debut), fin: e.fin ? iso(e.fin) : null, code: e.code, total: e.lignes.length, lignes: e.lignes.slice(depuis, depuis + 1000) } };
  });
  // les licences actives (onglet Univers) : nom, adresse, comptes ; la forme exacte suivra la maquette de l'onglet
  app.get("/feed/univers", async () => {
    const m = await memoirePrete();
    if (!m) return { total: 0, avant: new Date().getUTCFullYear(), licences: [] };
    if (!m.feed) {
      const licences = [...m.licences.values()].map((L) => {
        const mb = m.membres.get(L.id) || [], rp = m.reperes.get(L.id) || [];
        const animes = mb.filter((x) => x.dom === "anime").length, jeux = mb.length - animes;
        const ra = rp.filter((x) => x.dom === "anime").length;
        return { id: L.id, slug: L.slug, nom: L.nom, animes, jeux, reperes: rp.length, croisee: (animes > 0 || ra > 0) && (jeux > 0 || rp.length - ra > 0), pop: L.pop };
      }).filter((x) => x.animes + x.jeux > 0).sort((a, b) => b.pop - a.pop || a.nom.localeCompare(b.nom));
      m.feed = { total: licences.length, avant: m.avant, licences };
    }
    return m.feed;
  });
  // une licence entière (page de l'univers) : toutes ses sorties du radar et tout son passé au seuil bas
  app.get("/univers/:slug", async (req, reply) => {
    const m = await memoirePrete();
    const slug = String((req.params as any)?.slug ?? "").toLowerCase();
    const id = m?.parSlug.get(slug);
    const L = id != null ? m?.licences.get(id) : undefined;
    if (!m || !L) return reply.code(404).send({ error: "Not found" });
    const directs = new Set<string>();
    for (const x of m.directsListe.get(L.id) || []) directs.add(`${x.source}:${x.sourceId}`);
    const reperes = [...(m.reperes.get(L.id) || [])].sort((a, b) => a.annee - b.annee || a.titre.localeCompare(b.titre)).map((x) => repereSortie({ ...x, direct: directs.has(`${x.source}:${x.id}`) }));
    return { id: L.id, slug: L.slug, nom: L.nom, origine: L.origine, fiches: await sortiesLicence(pool, m, L.id), reperes, avant: m.avant };
  });
}

// ─────────────────────────────────────────────────────────────── d'un passage à l'autre

interface Ancienne {
  id: number;
  slug: string;
  nom: string;
  actif: boolean;
  cles: Set<string>;
  anciens: string[];
  nbFiches: number;
}
interface LignePlan {
  calc: LicenceCalculee;
  id: number | null;
  slug: string;
  anciens: string[];
  etat: "gardee" | "nouvelle" | "reveillee";
}
export interface Plan {
  lignes: LignePlan[];
  endormies: number[];
  fusions: Array<{ id: number; dans: LignePlan }>;
  changements: { nouvelles: string[]; reunies: string[]; separees: string[]; reveillees: string[]; endormies: string[]; renommees: string[] };
}

const POIDS: Array<[string, number]> = [["f:", 5], ["wdf:", 4], ["igf:", 3], ["als:", 3], ["wds:", 2], ["igc:", 2], ["al:", 1], ["ig:", 1]];
const poidsCle = (k: string): number => POIDS.find(([p]) => k.startsWith(p))?.[1] ?? 1;

async function lireAnciennes(pool: SqlPool): Promise<Ancienne[]> {
  const out: Ancienne[] = [];
  let lignes: any[];
  try {
    lignes = await pool.query("SELECT id, slug, nom, actif, cles, anciens_slugs, nb_fiches FROM licences");
  } catch (e) {
    if (tableAbsente(e)) return out;
    throw e;
  }
  for (const l of lignes) {
    let cles: unknown = [], anciens: unknown = [];
    try {
      cles = JSON.parse(String(l.cles || "[]"));
    } catch {
      cles = [];
    }
    try {
      anciens = JSON.parse(String(l.anciens_slugs || "[]"));
    } catch {
      anciens = [];
    }
    out.push({ id: N(l.id), slug: String(l.slug), nom: String(l.nom), actif: N(l.actif) === 1, cles: new Set(Array.isArray(cles) ? cles.map(String) : []), anciens: Array.isArray(anciens) ? anciens.map(String) : [], nbFiches: N(l.nb_fiches) });
  }
  return out;
}

/**
 * Chaque licence calculée retrouve la licence en base qui partage le plus de clés avec elle (les fiches d'abord, puis
 * franchises et œuvres d'origine) ; une licence en base sans correspondant passe en sommeil, ou est marquée « fusionnée
 * dans » celle qui a repris ses fiches ; l'adresse suit le nom, les anciennes sont gardées.
 */
export function rapprocher(calc: Calcul, anciennes: Ancienne[]): Plan {
  const parCle = new Map<string, Ancienne[]>();
  for (const a of anciennes) for (const k of a.cles) {
    const l = parCle.get(k);
    if (l) l.push(a);
    else parCle.set(k, [a]);
  }
  const paires: Array<{ j: number; a: Ancienne; score: number; fiches: number }> = [];
  calc.licences.forEach((L, j) => {
    const sc = new Map<number, { a: Ancienne; score: number; fiches: number }>();
    for (const k of L.cles) for (const a of parCle.get(k) || []) {
      const o = sc.get(a.id) || { a, score: 0, fiches: 0 };
      o.score += poidsCle(k);
      if (k.startsWith("f:")) o.fiches++;
      sc.set(a.id, o);
    }
    for (const o of sc.values()) if (o.score >= 3) paires.push({ j, ...o });
  });
  paires.sort((x, y) => y.fiches - x.fiches || y.score - x.score || y.a.nbFiches - x.a.nbFiches || x.a.id - y.a.id || calc.licences[y.j].pop - calc.licences[x.j].pop);
  const pourCalc = new Map<number, Ancienne>(), prises = new Set<number>();
  for (const p of paires) {
    if (pourCalc.has(p.j) || prises.has(p.a.id)) continue;
    pourCalc.set(p.j, p.a);
    prises.add(p.a.id);
  }
  // le nom de l'œuvre principale déjà porté par une licence de la base que rien ne reprend (en sommeil, fusionnée) : la
  // licence garde le nom de la règle d'avant ; le même choix d'un passage à l'autre (une licence n'est jamais supprimée)
  {
    const pris = new Set<string>();
    for (const a of anciennes) if (!prises.has(a.id)) pris.add(norm(a.nom));
    for (const L of calc.licences) if (L.nomRepli && pris.has(norm(L.nom))) {
      const nom = L.nom;
      L.nom = L.nomRepli;
      // le rapport de l'essai ne l'annonce plus comme nommée par son œuvre principale
      calc.diag.nomsPrincipaux = calc.diag.nomsPrincipaux.filter((x) => !(x.avant === L.nom && x.nom === nom));
    }
  }
  // les adresses : uniques parmi toutes les licences (actives, en sommeil ou fusionnées), anciennes adresses comprises
  const occupees = new Map<string, number>();
  for (const a of anciennes) for (const s of [a.slug, ...a.anciens]) if (!occupees.has(s)) occupees.set(s, a.id);
  const lignes: LignePlan[] = calc.licences.map((L, j) => {
    const a = pourCalc.get(j) || null;
    const base = slugLicence(L.nom);
    let slug = a && a.slug === base ? base : "";
    for (let n = 1; !slug; n++) {
      const essai = n === 1 ? base : `${base}-${n}`;
      const t = occupees.get(essai);
      if (t == null || (a && t === a.id)) slug = essai;
    }
    occupees.set(slug, a ? a.id : -1 - j);
    const anciens = a && a.slug !== slug ? [a.slug, ...a.anciens].filter((s, k, l) => s !== slug && l.indexOf(s) === k).slice(0, 10) : a ? a.anciens.filter((s) => s !== slug) : [];
    return { calc: L, id: a ? a.id : null, slug, anciens, etat: !a ? "nouvelle" : a.actif ? "gardee" : "reveillee" };
  });
  const changements: Plan["changements"] = { nouvelles: [], reunies: [], separees: [], reveillees: [], endormies: [], renommees: [] };
  const endormies: number[] = [], fusions: Plan["fusions"] = [];
  // chaque fiche (clé f:) est dans une seule ligne calculée : l'index évite de comparer chaque ancienne à chaque ligne
  const ligneDeFiche = new Map<string, number>();
  lignes.forEach((l, j) => {
    for (const k of l.calc.cles) if (k.startsWith("f:") && !ligneDeFiche.has(k)) ligneDeFiche.set(k, j);
  });
  const lignesDe = (a: Ancienne): Map<number, number> => {
    const n = new Map<number, number>();
    for (const k of a.cles) {
      if (!k.startsWith("f:")) continue;
      const j = ligneDeFiche.get(k);
      if (j != null) n.set(j, (n.get(j) || 0) + 1);
    }
    return n;
  };
  // la ligne qui a repris le plus de fiches d'une ancienne licence non reprise : elle s'y fond (à égalité, la première)
  for (const a of anciennes) {
    if (prises.has(a.id)) continue;
    let best: { j: number; n: number } | null = null;
    for (const [j, n] of lignesDe(a)) if (!best || n > best.n || (n === best.n && j < best.j)) best = { j, n };
    if (best && a.actif) {
      fusions.push({ id: a.id, dans: lignes[best.j] });
      changements.reunies.push(`${a.nom} -> ${lignes[best.j].calc.nom}`);
    } else if (a.actif) {
      endormies.push(a.id);
      changements.endormies.push(a.nom);
    }
  }
  const parId = new Map(anciennes.map((a) => [a.id, a] as [number, Ancienne]));
  for (const l of lignes) {
    if (l.etat === "nouvelle" && l.calc.membres.length + l.calc.reperes.length >= 2) changements.nouvelles.push(l.calc.nom);
    if (l.etat === "reveillee") changements.reveillees.push(l.calc.nom);
    const a = l.id != null ? parId.get(l.id) : undefined;
    if (a && a.nom !== l.calc.nom) changements.renommees.push(`${a.nom} -> ${l.calc.nom}`);
  }
  // une ancienne licence dont les fiches sont parties dans plusieurs licences : séparée
  for (const a of anciennes) {
    if (!a.actif) continue;
    const dans = [...lignesDe(a).keys()].sort((x, y) => x - y);
    if (dans.length >= 2) changements.separees.push(`${a.nom} -> ${dans.map((j) => lignes[j].calc.nom).join(" / ")}`);
  }
  return { lignes, endormies, fusions, changements };
}

/** Le passage écrit, tout ou rien (une transaction). */
async function ecrire(pool: LicencesDeps["pool"], plan: Plan, annee: number, mesures: Record<string, number>, refus: string[]): Promise<void> {
  const conn = typeof pool.getConnection === "function" ? await pool.getConnection() : null;
  const q = (sql: string, params?: unknown[]): Promise<any> => (conn ? conn.query(sql, params) : pool.query(sql, params));
  let fini = false;
  try {
    if (conn) await q("START TRANSACTION");
    const txt = (s: unknown, n: number): string | null => (s == null || s === "" ? null : String(s).slice(0, n));
    const origine = (o: Origine | null): [string | null, string | null, string | null] => (o ? [txt(o.type, 30), txt(o.titre, 255), txt(o.auteurs.join(" | "), 255)] : [null, null, null]);
    // les adresses qui changent passent d'abord par une adresse provisoire (deux licences peuvent échanger les leurs)
    const anciennesAdresses = new Map<number, string>();
    for (const l of await q("SELECT id, slug FROM licences")) anciennesAdresses.set(N(l.id), String(l.slug));
    for (const l of plan.lignes) if (l.id != null && anciennesAdresses.get(l.id) !== l.slug) await q("UPDATE licences SET slug = ? WHERE id = ?", [`~${l.id}`, l.id]);
    for (const l of plan.lignes) {
      const L = l.calc;
      const animes = L.membres.filter((x) => x.dom === "anime").length;
      const champs = [l.slug, txt(L.nom, 255), ...origine(L.origine), JSON.stringify(L.cles), JSON.stringify(l.anciens), L.membres.length, animes, L.membres.length - animes, Math.min(L.reperes.length, 65535), Math.round(L.pop)];
      if (l.id != null) {
        await q("UPDATE licences SET slug = ?, nom = ?, actif = 1, origine_type = ?, origine_titre = ?, origine_auteurs = ?, cles = ?, anciens_slugs = ?, nb_fiches = ?, nb_animes = ?, nb_jeux = ?, nb_reperes = ?, pop = ?, fusionnee_dans = NULL, vue_le = NOW() WHERE id = ?", [...champs, l.id]);
      } else {
        const r = await q("INSERT INTO licences (slug, nom, actif, origine_type, origine_titre, origine_auteurs, cles, anciens_slugs, nb_fiches, nb_animes, nb_jeux, nb_reperes, pop, creee_le, vue_le) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())", champs);
        l.id = N(r?.insertId);
        if (!(l.id > 0)) throw new Error("base : licence insérée sans identifiant");
      }
    }
    if (plan.endormies.length) await q("UPDATE licences SET actif = 0 WHERE id IN (?)", [plan.endormies]);
    for (const f of plan.fusions) await q("UPDATE licences SET actif = 0, fusionnee_dans = ? WHERE id = ?", [f.dans.id, f.id]);
    await q("DELETE FROM licences_fiches");
    await q("DELETE FROM licences_reperes");
    await q("DELETE FROM licences_directs");
    const parLots = async (table: string, colonnes: string[], lignes: unknown[][]) => {
      for (let i = 0; i < lignes.length; i += 300) {
        const lot = lignes.slice(i, i + 300);
        await q(`INSERT INTO ${table} (${colonnes.join(", ")}) VALUES ${lot.map(() => `(${colonnes.map(() => "?").join(", ")})`).join(", ")}`, lot.flat());
      }
    };
    await parLots("licences_fiches", ["domaine", "item_id", "licence_id", "par", "origine_type", "origine_titre", "origine_auteurs"],
      plan.lignes.flatMap((l) => l.calc.membres.map((x) => [x.dom, x.id, l.id, String(x.par).slice(0, 40), ...origine(x.origine)])));
    await parLots("licences_reperes", ["source", "source_id", "licence_id", "domaine", "titre", "format", "annee", "popularite", "principal", "par"],
      plan.lignes.flatMap((l) => l.calc.reperes.map((x) => [x.source, x.id, l.id, x.dom, String(x.titre).slice(0, 300), txt(x.format, 30), x.annee, Math.min(Math.round(x.pop), 2147483647), x.principal ? 1 : 0, String(x.par).slice(0, 20)])));
    await parLots("licences_directs", ["domaine", "item_id", "source", "source_id", "nature"],
      plan.lignes.flatMap((l) => l.calc.directs.map((x) => [x.dom, x.id, x.source, x.sourceId, String(x.nature).slice(0, 20)])));
    for (const [cle, valeur] of [["regles", VERSION_REGLES], ["annee", String(annee)], ["mesures", JSON.stringify(mesures)], ["refus", JSON.stringify(refus.slice(0, 5000))]]) {
      await q("INSERT INTO licences_etat (cle, valeur, le) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur), le = VALUES(le)", [cle, valeur]);
    }
    await q("DELETE FROM licences_etat WHERE cle = 'garde'");
    if (conn) await q("COMMIT");
    fini = true;
  } finally {
    if (conn) {
      if (!fini) {
        // la base annule tout : la connexion est fermée plutôt que rendue au milieu d'une transaction
        try {
          await conn.query("ROLLBACK");
        } catch {
          /* connexion perdue */
        }
        try {
          if (typeof conn.destroy === "function") conn.destroy();
          else conn.release();
        } catch {
          /* déjà fermée */
        }
      } else {
        try {
          conn.release();
        } catch {
          /* déjà rendue */
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────── le passage

export interface BilanLicences {
  fiches: number;
  animes: number;
  jeux: number;
  licences: number;
  licences2: number;
  blocs: number;
  croisees: number;
  reperes: number;
  pontsTitre: number;
  pontsNom: number;
  pontsCatalogue: number;
  requetes: { al: number; ig: number; wd: number };
  pausesN8n: number;
  duree: number;
  ecrit: boolean;
  erreur?: string;
  arret?: string;
  garde?: string;
  occupe?: boolean;
  replis: string[];
  /** Les changements, 30 au plus par liste ; comptes : le nombre de chaque sorte. */
  changements: (Plan["changements"] & { comptes: Record<string, number> }) | null;
  aVerifier: Record<string, string[]>;
  /** Règles 7 : les réunions refusées par le contrôle des œuvres d'origine ; nouvelles : absentes du dernier passage écrit
   *  (10 au plus) ; premier : aucun passage écrit ne les avait encore notées (toutes sont « nouvelles »). */
  refusees: number;
  refusNouveaux: string[];
  refusNouveauxN: number;
  refusPremier: boolean;
}

/** Les changements pour le bilan : 30 au plus par liste (le bilan est gardé au Pilotage), et le compte de chaque sorte. */
export function changementsBilan(ch: Plan["changements"]): NonNullable<BilanLicences["changements"]> {
  const comptes: Record<string, number> = {};
  const out: any = { comptes };
  for (const [k, l] of Object.entries(ch)) {
    comptes[k] = l.length;
    out[k] = l.slice(0, 30);
  }
  return out;
}

export interface ResultatPassage {
  bilan: BilanLicences;
  calc: Calcul | null;
  plan: Plan | null;
  ancienne: Memoire | null;
}

/** Les baisses notées par le garde-fou depuis le dernier passage écrit : mesure -> valeur et date où elle a été vue. */
type Baisses = Record<string, { v: number; le: number }>;
async function gardePrecedente(pool: SqlPool): Promise<Baisses> {
  let l: any[];
  try {
    l = await pool.query("SELECT valeur FROM licences_etat WHERE cle = 'garde'");
  } catch (e) {
    if (tableAbsente(e)) return {};
    throw e;
  }
  if (!l.length) return {};
  const out: Baisses = {};
  try {
    const g = JSON.parse(String(l[0].valeur || ""));
    for (const [k, x] of Object.entries(g && typeof g.m === "object" && g.m ? g.m : {})) {
      const b = x as any;
      if (b && Number.isFinite(b.v) && Number.isFinite(b.le)) out[k] = { v: Number(b.v), le: Number(b.le) };
    }
  } catch {
    /* illisible : comme rien de noté */
  }
  return out;
}
/** Les réunions refusées au dernier passage écrit (paires clé et œuvres d'origine) ; null : jamais notées. */
async function refusPrecedents(pool: SqlPool): Promise<Set<string> | null> {
  let l: any[];
  try {
    l = await pool.query("SELECT valeur FROM licences_etat WHERE cle = 'refus'");
  } catch (e) {
    if (tableAbsente(e)) return null;
    throw e;
  }
  if (!l.length) return null;
  try {
    const v = JSON.parse(String(l[0].valeur || ""));
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    return null;
  }
}
async function noterGarde(pool: SqlPool, m: Baisses): Promise<void> {
  await pool.query("INSERT INTO licences_etat (cle, valeur, le) VALUES ('garde', ?, NOW()) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur), le = VALUES(le)", [JSON.stringify({ m })]);
}

const message = (e: unknown): string => String((e as any)?.message ?? e).split(/\r?\nsql:/)[0].replace(/^\(conn:[^)]*\)\s*/, "").replace(/\s+/g, " ").slice(0, 200);

/**
 * Un passage : les fiches du site, le calcul, le rapprochement avec les licences en base, le garde-fou, puis l'écriture
 * (ecrire) et la mémoire relue. À blanc (essai) : rien n'est écrit, le résultat est rendu.
 */
export async function passageLicences(deps: LicencesDeps, cfg: LicencesConfig, o: { ecrire: boolean; dire?: (l: string) => void }): Promise<ResultatPassage> {
  const debut = Date.now();
  const bilan: BilanLicences = {
    fiches: 0, animes: 0, jeux: 0, licences: 0, licences2: 0, blocs: 0, croisees: 0, reperes: 0, pontsTitre: 0, pontsNom: 0, pontsCatalogue: 0,
    requetes: { al: 0, ig: 0, wd: 0 }, pausesN8n: 0, duree: 0, ecrit: false, replis: [], changements: null, aVerifier: {},
    refusees: 0, refusNouveaux: [], refusNouveauxN: 0, refusPremier: false,
  };
  let rendre: (() => Promise<void>) | null;
  try {
    rendre = await prendreVerrou(deps.pool as any, VERROU);
  } catch (e) {
    return { bilan: { ...bilan, erreur: `base : ${message(e)}` }, calc: null, plan: null, ancienne: null };
  }
  if (!rendre) return { bilan: { ...bilan, occupe: true }, calc: null, plan: null, ancienne: null };
  const fin = debut + cfg.limiteMs;
  const al = new AniList({ url: cfg.anilistUrl, pauseMs: cfg.pauseAl, n8n: cfg.n8n, maxRequetes: cfg.reqAlMax, fin, attenteMs: cfg.attenteMs, decalageN8nMin: cfg.n8nDecalageMin, echelleN8n: cfg.n8nEchelle, dire: o.dire });
  const ig = new Igdb({ base: cfg.igdbBase, pauseMs: cfg.pauseIg, maxRequetes: cfg.reqIgMax, fin, attenteMs: cfg.attenteMs, appel: deps.igdb });
  const wd = new Wikidata({ url: cfg.wdqsUrl, pauseMs: cfg.pauseWd, fin, agent: AGENT, attenteMs: cfg.attenteMs });
  let calc: Calcul | null = null, plan: Plan | null = null, ancienne: Memoire | null = null;
  try {
    // les tables ne sont créées que pour écrire : l'essai à blanc ne crée rien
    if (o.ecrire) await creerTables(deps.pool);
    const annee = new Date().getUTCFullYear();
    const fiches = await lireFiches(deps, annee);
    if (!fiches.length) throw new PanneSource("aucune fiche lue dans les flux du site");
    if (!deps.igdb && (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET)) throw new PanneSource("identifiants Twitch absents de l'environnement");
    calc = await calculerLicences({ fiches, al, ig, wd, annee, regles: cfg.regles, dire: o.dire });
    const mes = mesurer(calc.licences);
    Object.assign(bilan, {
      fiches: calc.comptes.fiches, animes: calc.comptes.animes, jeux: calc.comptes.jeux, licences: calc.licences.length,
      licences2: mes.licences2, blocs: mes.blocs, croisees: mes.croisees, reperes: mes.reperes,
      pontsTitre: calc.diag.pontsTitre.length, pontsNom: calc.diag.pontsNom.length, pontsCatalogue: calc.diag.pontsCatalogue.filter((p) => !p.ambigu && p.ajoutes).length,
      replis: calc.replis.slice(0, 10),
    });
    const L30 = <T>(l: T[], f: (x: T) => string): string[] => l.slice(0, 30).map(f);
    bilan.aVerifier = {
      exclus: L30(calc.diag.exclus.sort((a, b) => b.pop - a.pop), (x) => `${x.titre} (${x.an ?? "?"}) : pas pour ${x.licence} (${x.raison})`),
      forts: L30(calc.diag.forts.sort((a, b) => b.pop - a.pop), (x) => `${x.titre} (${x.an ?? "?"}) : dans ${x.licence} (${x.lien})`),
      reunies: L30(calc.diag.reunies, (x) => `${x.noms.join(" + ")} (franchise ${x.franchise})`),
      reliees: L30(calc.diag.reliees, (x) => `${x.a} / ${x.b} (${x.via})`),
      egaux: L30(calc.diag.egaux, (x) => `${x.titre} : ${x.licences.join(" / ")}`),
      partages: L30(calc.diag.partages, (x) => `${x.titre} : ${x.licences.join(" / ")}`),
      multi: L30(calc.diag.multi, (x) => `${x.titre} (${x.franchises.join(", ")})`),
      refuses: L30(calc.diag.refuses, (x) => `${x.a} / ${x.b} (${x.lien} : ${x.cle})`.slice(0, 160)),
    };
    // règles 7 : les réunions refusées par les contrôles, et celles que le dernier passage écrit n'avait pas
    // (ceux du contrôle des œuvres d'origine seulement : les autres refus, des règles d'avant, restent au diagnostic)
    const dejaRefus = await refusPrecedents(deps.pool);
    const refusC = calc.diag.refuses.filter((x) => x.origine);
    // en base : les paires (clé, œuvre d'origine de chaque côté) des refus ; un refus est nouveau si aucune de ses paires
    // n'était notée au dernier passage écrit. Une ligne par refus (un même refus peut venir de deux étapes).
    const refusIds = [...new Set(refusC.flatMap((x) => x.paires))];
    const nouveauxRefus = refusC.filter((x, k, l) => !x.paires.some((p) => dejaRefus?.has(p)) && l.findIndex((y) => y.id === x.id) === k);
    bilan.refusPremier = dejaRefus === null;
    bilan.refusees = new Set(refusC.map((x) => x.id)).size;
    bilan.refusNouveauxN = nouveauxRefus.length;
    bilan.refusNouveaux = nouveauxRefus.slice(0, 10).map((x) => `${x.a} / ${x.b} (${x.cle})`.slice(0, 160));
    ancienne = await chargerMemoire(deps.pool);
    plan = rapprocher(calc, await lireAnciennes(deps.pool));
    bilan.changements = changementsBilan(plan.changements);
    // garde-fou : une baisse de plus de 25 % par rapport au dernier passage écrit, avec les mêmes règles ; toutes les
    // mesures en baisse sont regardées (la première sert au texte)
    const baisses: Array<{ k: string; v: number; texte: string }> = [];
    if (ancienne && ancienne.regles === VERSION_REGLES && ancienne.avant === annee) {
      const av = mesurerMemoire(ancienne);
      const noms: Record<string, string> = { licences2: "licences de 2 sorties ou plus", blocs: "fiches dont le bloc montre quelque chose", reperes: "repères", reperesAnimes: "repères animés", reperesJeux: "repères jeux" };
      for (const k of ["licences2", "blocs", "reperes", "reperesAnimes", "reperesJeux"] as const) {
        if (av[k] >= 20 && mes[k] < 0.75 * av[k]) baisses.push({ k, v: mes[k], texte: `baisse anormale : ${noms[k]} ${av[k]} -> ${mes[k]} (plus de 25 %)` });
      }
      if (baisses.length) bilan.garde = baisses[0].texte;
    }
    // une baisse est notée avec la date où elle a été vue ; revue à 5 % près moins de 3 jours après, elle garde cette
    // date (relance après échec, passage lancé à la main, mesure qui oscille autour du seuil). Quand toutes les baisses
    // du passage ont été vues au moins 18 h plus tôt, ce sont de vraies baisses : le passage est écrit (le garde-fou ne
    // bloque pas le module pour toujours). Une baisse vue pour la première fois le garde fermé.
    let leve: string | null = null;
    if (baisses.length) {
      const prec = await gardePrecedente(deps.pool);
      const note: Baisses = {};
      const maintenant = Date.now();
      for (const [k, x] of Object.entries(prec)) if (maintenant - x.le >= 0 && maintenant - x.le < 72 * H) note[k] = x;
      let toutes = true;
      for (const b of baisses) {
        const p = note[b.k];
        const meme = !!p && Math.abs(p.v - b.v) <= Math.max(2, 0.05 * p.v);
        if (!meme) {
          note[b.k] = { v: b.v, le: maintenant };
          toutes = false;
        } else if (maintenant - p.le < 18 * H) toutes = false;
      }
      if (toutes) {
        leve = baisses.map((b) => b.texte).join(" ; ");
        bilan.replis.push(`garde-fou levé : ${leve}, baisse confirmée par un passage d'au moins 18 h plus tôt`);
        delete bilan.garde;
      } else if (o.ecrire && JSON.stringify(note) !== JSON.stringify(prec)) await noterGarde(deps.pool, note);
    }
    if (o.ecrire && !bilan.garde) {
      await ecrire(deps.pool, plan, annee, mes, refusIds);
      bilan.ecrit = true;
      if (leve) {
        deps.log.warn({ module: "licences", garde: leve }, "licences : baisse confirmée, écrite");
        pushActivity({ type: "licences", message: "Licences : baisse confirmée, écrite", detail: leve, level: "warn" });
      }
      // la mémoire de l'API : relue tout de suite ; si la base flanche ici, l'ancienne reste servie jusqu'au démarrage
      // suivant ou au passage suivant (ce qui est écrit est complet)
      try {
        await relireMemoire(deps.pool);
      } catch (e) {
        bilan.replis.push(`mémoire de l'API non relue (${message(e)}) : les anciennes licences restent servies jusqu'au prochain passage`);
      }
    }
  } catch (e) {
    if (e instanceof Incomplet) bilan.arret = message(e);
    else if (e instanceof PanneSource) bilan.erreur = message(e);
    else bilan.erreur = /^(base|ER_|\(conn)/i.test(message(e)) || (e as any)?.sqlMessage ? `base : ${message(e)}` : message(e);
  } finally {
    bilan.requetes = { al: al.n, ig: ig.n, wd: wd.n };
    bilan.pausesN8n = al.pauses;
    bilan.duree = Math.round((Date.now() - debut) / 1000);
    await rendre();
  }
  return { bilan, calc, plan, ancienne };
}

// ─────────────────────────────────────────────────────────────── démarrage

/** Le cycle quotidien, déclaré au Pilotage ; la mémoire est relue au démarrage. */
export function startLicencesCron(deps: LicencesDeps, env: Record<string, string | undefined> = process.env): void {
  const cfg = configLicences(env);
  const actifParDefaut = env["LICENCES_ENABLED"] === "1";
  DEPS = deps;
  // la mémoire : relue au démarrage, puis chaque minute tant que la base ne répond pas
  const lire = async (essai: number): Promise<void> => {
    try {
      await relireMemoire(deps.pool);
    } catch (e) {
      if (essai === 1) deps.log.warn({ module: "licences", err: message(e) }, "licences : mémoire non relue au démarrage (nouvel essai chaque minute)");
      if (!MEMOIRE_LUE) setTimeout(() => void lire(essai + 1), nombre(env["LICENCES_RELIRE_MS"], MIN)).unref?.();
    }
  };
  PREMIERE = lire(1);
  let enCours = false;
  planifier({
    id: "licences", premierMs: 22 * MIN, heuresUtc: [3 + 10 / 60], actifParDefaut,
    passage: async () => {
      if (enCours) return { bilan: { occupe: true }, reessayerDansMs: 30 * MIN };
      enCours = true;
      try {
        const { bilan } = await passageLicences(deps, cfg, { ecrire: true });
        if (bilan.occupe) {
          // le verrou est pris (un essai à blanc) : la journée n'est pas perdue, nouvel essai dans 30 min
          deps.log.info({ module: "licences" }, "licences : un passage tourne déjà (essai à blanc ?), nouvel essai dans 30 min");
          return { bilan: { occupe: true }, reessayerDansMs: 30 * MIN };
        }
        const resume = { fiches: bilan.fiches, licences: bilan.licences, licences2: bilan.licences2, blocs: bilan.blocs, reperes: bilan.reperes, refusees: bilan.refusees, requetes: bilan.requetes, duree: bilan.duree };
        const ch = bilan.changements;
        // les comptes entiers (les listes du bilan sont coupées à 30)
        const nb = (k: string): number => (ch ? Number(ch.comptes?.[k] ?? (ch as any)[k]?.length ?? 0) : 0);
        const nChg = nb("nouvelles") + nb("reunies") + nb("separees") + nb("reveillees");
        if (bilan.erreur || bilan.arret || bilan.garde) {
          const raison = bilan.erreur || bilan.arret || bilan.garde || "";
          deps.log.warn({ module: "licences", ...resume, raison }, "licences : rien n'est écrit");
          pushActivity({ type: "licences", message: "Licences : rien n'est écrit", detail: raison, level: "warn" });
          return { bilan: bilan as any, reessayerDansMs: APRES_ECHEC_MS };
        }
        deps.log.info({ module: "licences", ...resume }, "licences : passage terminé");
        if (nChg) pushActivity({ type: "licences", message: `Licences : ${nChg} changement${nChg > 1 ? "s" : ""}`, detail: `${bilan.blocs} blocs remplis sur ${bilan.fiches} fiches`, level: "info" });
        // règles 7 : le contrôle a refusé des réunions que le dernier passage écrit n'avait pas vues (au premier passage
        // qui les note, toutes : le message le dit)
        const nR = N(bilan.refusNouveauxN), s = nR > 1 ? "s" : "";
        if (nR) {
          pushActivity({
            type: "licences",
            message: bilan.refusPremier ? `Univers : contrôle en place, ${nR} réunion${s} refusée${s} (premier relevé)` : `Univers : ${nR} nouvelle${s} réunion${s} refusée${s} par le contrôle`,
            detail: bilan.refusNouveaux.slice(0, 3).join(" ; ").slice(0, 300),
            level: "info",
          });
        }
        return { bilan: bilan as any };
      } finally {
        enCours = false;
      }
    },
  });
  deps.log.info({ module: "licences", actifParDefaut }, "licences : planifié (chaque jour à 3 h 10 UTC)");
}

/** Essais seulement : la mémoire servie par l'API. */
export function _memoirePourEssais(m?: Memoire | null): Memoire | null {
  if (m !== undefined) {
    // comme au démarrage : une mémoire vide n'a pas encore été lue
    GENERATION++;
    MEMOIRE = m;
    MEMOIRE_LUE = m != null;
    PREMIERE = null;
  }
  return MEMOIRE;
}
