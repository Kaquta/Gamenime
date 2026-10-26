/**
 * GameNime API routes (Fastify).
 *
 * Endpoints:
 *   GET /feed/home              - Mixed top items (anime + games)
 *   GET /feed/anime             - Top anime items
 *   GET /feed/games             - Top game items
 *   GET /feed/search?q=...      - Search across both types
 *   GET /admin/feed/stats       - Diagnostic (admin only, x-api-key)
 *
 * Design (ETAT CLEAN):
 * - All inputs validated with Zod (no `any` casts)
 * - LIKE patterns escaped to prevent wildcard injection
 * - In-memory cache (5min TTL) on /feed/home (highest traffic)
 * - Structured logs (request.log.info) on every endpoint
 * - DB queries bounded by MAX_DB_FETCH (predictable RAM usage)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { expandSearchTerm } from "./search-aliases.js";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { demarrerDuMoment, trierDuMoment } from "./du-moment.js";
import { z } from "zod";
import {
  CAPACITY_ANIME,
  CAPACITY_GAMES,
  CAPACITY_UPCOMING_ANIME,
  CAPACITY_UPCOMING_GAMES,
  CAPACITY_HOME,
  SEARCH_LIMIT_PER_TYPE,
  MAX_DB_FETCH,
  DB_DATE_RANGE_YEARS,
  FEED_CACHE_TTL_MS,
} from "./constants.js";
import type { GameNimeItem } from "./core.js";
import {
  computeGameNimeScore,
  sortForGameNimeTop,
  sansBonusEurope,
  sortByDate,
  getReleaseWindow,
  isMissing,
  normalizeTitle,
  computeFieldCount,
  sanitizePlatform,
  mergePlatforms,
  hasYearSuffix,
  formatReleaseDateLabel, stripDisplayTags} from "./core.js";
// Bascule des synopsis (21 octobre 2026) : le synopsis validé par Rey remplace la description sur le site
import { DESCRIPTION_SITE, MAJ_SITE, SYNOPSIS_PAGE } from "./synopsis-site.js";

// ============================================================
// Helpers
// ============================================================

/**
 * Escape SQL LIKE wildcards (% and _) to prevent unintended matches.
 * Without this, a search for "100_off" would match "100Xoff".
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Build the wide DB date filter: 3 years back, 3 years forward.
 * Used to bound DB queries while keeping enough items for scoring.
 */
function buildWideDateFilter(now: Date = new Date()): { start: string; end: string } {
  const startYear = now.getUTCFullYear() - DB_DATE_RANGE_YEARS;
  const endYear = now.getUTCFullYear() + DB_DATE_RANGE_YEARS;
  return {
    start: `${startYear}-01-01`,
    end: `${endYear}-12-31`,
  };
}

/**
 * Filter items by release status.
 * - "all": no filter
 * - "released": items already released (releaseDate <= today)
 * - "upcoming": items not yet released (releaseDate > today)
 *
 * Items with no releaseDate are excluded from "released" and "upcoming"
 * filters but kept in "all".
 */
type ReleaseStatus = "released" | "upcoming" | "all";

/**
 * Return true if the game has at least one DLC in the [start, end] window.
 * Used to keep older games that have a fresh DLC in the current window.
 * Safe against malformed JSON.
 */
function hasDlcInWindow(
  dlcsJson: string | null | undefined,
  start: string,
  end: string
): boolean {
  if (!dlcsJson) return false;
  try {
    const parsed = JSON.parse(dlcsJson);
    if (!Array.isArray(parsed)) return false;
    return parsed.some((dlc: any) => {
      const d = dlc?.releaseDate;
      return typeof d === "string" && d >= start && d <= end;
    });
  } catch {
    return false;
  }
}

function filterByStatus(
  items: GameNimeItem[],
  status: ReleaseStatus,
  now: Date = new Date()
): GameNimeItem[] {
  if (status === "all") return items;

  const todayISO = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const windowStart = `${year}-01-01`;
  const windowEnd = `${year + 1}-12-31`;

  if (status === "released") {
    return items.filter((i) => {
      if (!i.releaseDate) return false;
      // ETAT CLEAN: seule une date PRECISE (precision 'day') peut etre "sortie".
      // year/month/null = on ne connait pas le JOUR exact (le 1er du mois stocke
      // est une convention, pas une vraie date). Ces items restent en upcoming
      // jusqu'a ce qu'une source fournisse le jour precis (precision 'day').
      if (i.releasePrecision !== "day") return false;
      const inWindow = i.releaseDate <= todayISO && i.releaseDate >= windowStart;
      if (!inWindow && i.releaseDate < windowStart) {
        // Older game/anime with a DLC released in the current window
        return hasDlcInWindow(i.dlcs, windowStart, todayISO);
      }
      return inWindow;
    });
  }

  if (status === "upcoming") {
    return items.filter((i) => {
      if (!i.releaseDate) return false;
      // ETAT CLEAN: precision imprecise (year/month/null) = TOUJOURS a venir dans
      // la fenetre, peu importe la date stockee (le 1er du mois/annee est une
      // convention). On ne connait pas le jour exact => "Prevu [mois/annee]".
      // Symetrique de released qui n'accepte QUE precision 'day'.
      if (i.releasePrecision !== "day") {
        return i.releaseDate >= windowStart && i.releaseDate <= windowEnd;
      }
      const inWindow = i.releaseDate > todayISO && i.releaseDate <= windowEnd;
      // ETAT CLEAN: DLC fallback applies ONLY to games OUTSIDE current window
      // (i.e. older games released BEFORE windowStart that have a DLC coming).
      // A game already in the current window stays in 'released' only — its
      // future Season Pass / DLC doesn't make the game itself 'upcoming'.
      if (!inWindow && i.releaseDate < windowStart) {
        return hasDlcInWindow(i.dlcs, todayISO, windowEnd);
      }
      return inWindow;
    });
  }

  return items;
}

// ============================================================
// In-memory cache for high-traffic endpoints
// ============================================================

interface CacheEntry {
  data: any;
  expiresAt: number;
}

const feedCache = new Map<string, CacheEntry>();

function getCached(key: string): any | null {
  const entry = feedCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    feedCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: any): void {
  feedCache.set(key, { data, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
}

/** Clear the entire cache (useful when items are updated). */
export function clearFeedCache(): void {
  feedCache.clear();
  oublierBadges();
}

// ============================================================
// SQL queries (parameterized, bounded)
// ============================================================

// Films au cinéma en France (10 octobre 2026, Rey : « la plus importante c'est EU, Japon va nous
// servir à rien la date »). Un film annoncé au cinéma en France (fr_cinema, posé par le module
// plateformes depuis annonces_fr) a pour date, sur tout le site, celle du cinéma, au jour près ; il
// est montré même sans aucune de nos plateformes (le site écrit « Cinéma » / « Au cinéma »).
const FILM_AU_CINEMA = "(format = 'MOVIE' AND fr_cinema IS NOT NULL)";
export const DATE_ANIME_SITE = `IF(${FILM_AU_CINEMA}, fr_cinema, release_date)`;
export const PRECISION_ANIME_SITE = `IF(${FILM_AU_CINEMA}, 'day', release_precision)`;
const CINEMA_FR = "DATE_FORMAT(IF(format = 'MOVIE', fr_cinema, NULL), '%Y-%m-%d')";
/** « Au cinéma » tient lieu de plateforme tant que le film n'en a aucune : c'est ce qu'affiche un site qui ne
 * connaît pas encore cinemaFr (au lieu de « Sortie Japon · EU à confirmer »). */
export const PLATEFORME_ANIME_SITE = `IF(TRIM(IFNULL(platform, '')) = '' AND ${FILM_AU_CINEMA}, 'Au cinéma', platform)`;
/** Anime montré sur le site : une de nos plateformes ; ou au cinéma en France ; ou japonais (ou pays inconnu) et pas encore sorti au jour près.
 * Jamais un anime annulé chez AniList (dates-animes.ts, 19 octobre 2026) : il revient tout seul si AniList le relance. */
export const ANIME_VISIBLE = `(IFNULL(statut_anilist, '') <> 'CANCELLED' AND (TRIM(IFNULL(platform, '')) <> '' OR ${FILM_AU_CINEMA} OR ((pays_origine IS NULL OR pays_origine IN ('JP', '--')) AND (release_precision IS NULL OR release_precision <> 'day' OR release_date IS NULL OR release_date > UTC_DATE()))))`;

const SELECT_ANIME = `
  SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish, cover, genre, ${PLATEFORME_ANIME_SITE} AS platform, ${DESCRIPTION_SITE} AS description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
         CAST(popularity AS SIGNED) AS popularity,
         CAST(europe_bonus AS SIGNED) AS europeBonus,
         screenshots,
         DATE_FORMAT(${DATE_ANIME_SITE}, '%Y-%m-%d') AS releaseDate,
         ${PRECISION_ANIME_SITE} AS releasePrecision,
         ${CINEMA_FR} AS cinemaFr,
         trailer_url AS trailerUrl,
         format,
         'anime' AS type
  FROM anime_items
  WHERE ${DATE_ANIME_SITE} BETWEEN ? AND ?
    AND cover IS NOT NULL AND cover != ''
    AND title IS NOT NULL AND title != ''
    AND ${ANIME_VISIBLE}
  ORDER BY popularity DESC, ${DATE_ANIME_SITE} DESC
  LIMIT ?
`;
/** Les animés « Date à annoncer » (dates-animes.ts : reportés sans nouvelle date chez AniList), les mêmes colonnes.
 * Seulement pour « À venir », où ils passent à la fin (sortByDate). */
const SELECT_ANIME_A_ANNONCER = SELECT_ANIME.replace(`WHERE ${DATE_ANIME_SITE} BETWEEN ? AND ?`, `WHERE ${DATE_ANIME_SITE} IS NULL AND date_a_annoncer = 1`);
async function animesAAnnoncer(pool: any): Promise<GameNimeItem[]> {
  if (SELECT_ANIME_A_ANNONCER === SELECT_ANIME) return [];
  return pool.query(SELECT_ANIME_A_ANNONCER, [100]);
}

const SELECT_GAMES = `
  SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish, cover, genre, platform, ${DESCRIPTION_SITE} AS description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
         CAST(popularity AS SIGNED) AS popularity,
         CAST(europe_bonus AS SIGNED) AS europeBonus,
         screenshots,
         DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
         release_precision AS releasePrecision,
         trailer_url AS trailerUrl,
         dlcs,
         game_type AS gameType,
         'game' AS type
  FROM game_items
  WHERE release_date BETWEEN ? AND ?
    AND cover IS NOT NULL AND cover != ''
    AND title IS NOT NULL AND title != ''
  ORDER BY popularity DESC, release_date DESC
  LIMIT ?
`;
/** Les jeux « Date à annoncer » (igdb-jeux.ts : un faux jour qu'IGDB ne date plus, 23 octobre 2026), les mêmes colonnes.
 * Seulement pour « À venir » trié par date, où ils passent à la fin (sortByDate), comme les animés. */
const SELECT_GAMES_A_ANNONCER = SELECT_GAMES.replace("WHERE release_date BETWEEN ? AND ?", "WHERE release_date IS NULL AND date_a_annoncer = 1");
async function jeuxAAnnoncer(pool: any): Promise<GameNimeItem[]> {
  if (SELECT_GAMES_A_ANNONCER === SELECT_GAMES) return [];
  // une base sans la colonne (copie d'avant le patch) : « À venir » reste servi, sans eux
  try {
    return await pool.query(SELECT_GAMES_A_ANNONCER, [100]);
  } catch {
    return [];
  }
}

// ============================================================
// Badges « Populaire » / « Très attendu »
// ============================================================

// 14 octobre 2026 (Rey, après le relevé releve-badges.sh) : le badge va aux 30 titres les plus
// populaires de chaque catégorie — jeux sortis, jeux à venir, animes sortis, animes à venir —, ex
// æquo compris, sur toute la fenêtre du site (pas seulement les cartes d'une page : le catalogue
// montre les 150 derniers sortis, l'accueil les 25 derniers). Il est calculé ici, une fois pour tout
// le site : listes, accueil, recherche, semaine et fiche disent la même chose (le site n'a plus de
// seuil à lui). Un titre sorti a « populaire », un titre à venir « tres-attendu » ; sorti ou à venir
// comme dans les listes du site (filterByStatus : une date au mois ou à l'année reste « à venir »).
// Le classement se refait tout seul : un titre qui dépasse le 30e prend le badge, le 30e le perd.
export type Badge = "populaire" | "tres-attendu";
const BADGE_RANG = 30;

export interface ListeBadge {
  /** les titres qui portent le badge */
  ids: Set<number>;
  /** popularité du 30e (null : liste vide) */
  seuil: number | null;
}
export interface BadgesDomaine {
  populaire: ListeBadge;
  tresAttendu: ListeBadge;
}
export interface BadgesSite {
  anime: BadgesDomaine;
  games: BadgesDomaine;
}

/** Les BADGE_RANG plus populaires, ex æquo compris ; une popularité nulle ne compte jamais. */
function plusPopulaires(items: GameNimeItem[]): ListeBadge {
  const pops = items.map((i) => Number(i.popularity) || 0).filter((p) => p > 0).sort((a, b) => b - a);
  if (pops.length === 0) return { ids: new Set(), seuil: null };
  const seuil = pops[Math.min(BADGE_RANG, pops.length) - 1];
  return { ids: new Set(items.filter((i) => (Number(i.popularity) || 0) >= seuil).map((i) => Number(i.id))), seuil };
}

function badgesDomaine(rows: GameNimeItem[], now: Date): BadgesDomaine {
  const sortis = filterByStatus(rows, "released", now);
  // Un titre déjà sorti (un ancien jeu dont une extension sort cette année et une autre plus tard est dans les
  // deux listes) ne concourt que parmi les sortis : il ne prend pas une place des « à venir ».
  const dejaSortis = new Set(sortis.map((i) => Number(i.id)));
  const aVenir = filterByStatus(rows, "upcoming", now).filter((i) => !dejaSortis.has(Number(i.id)));
  return { populaire: plusPopulaires(sortis), tresAttendu: plusPopulaires(aVenir) };
}

let badgesCache: { data: BadgesSite; expiresAt: number } | null = null;
let badgesEnCours: Promise<BadgesSite> | null = null;
let badgesEchec: { erreur: unknown; jusqua: number } | null = null;
let badgesVersion = 0;
/** Après un échec, la même erreur est rendue 30 s sans réinterroger la base (pas deux requêtes de 1000 lignes par visite). */
const BADGES_ECHEC_MS = 30 * 1000;

/** Oublie le calcul (clearFeedCache : popularités ou dates changées) ; un calcul en cours n'est pas gardé. */
function oublierBadges(): void {
  badgesCache = null;
  badgesEnCours = null;
  badgesEchec = null;
  badgesVersion++;
}

/** Les quatre listes de badges, recalculées au plus toutes les 5 min (la durée du cache des flux). */
export async function lireBadges(pool: any): Promise<BadgesSite> {
  if (badgesCache && badgesCache.expiresAt > Date.now()) return badgesCache.data;
  if (badgesEnCours) return badgesEnCours;
  if (badgesEchec && badgesEchec.jusqua > Date.now()) throw badgesEchec.erreur;
  const version = badgesVersion;
  const calcul = (async (): Promise<BadgesSite> => {
    const now = new Date();
    const wide = buildWideDateFilter(now);
    const [anime, games]: [GameNimeItem[], GameNimeItem[]] = await Promise.all([
      pool.query(SELECT_ANIME, [wide.start, wide.end, MAX_DB_FETCH]),
      pool.query(SELECT_GAMES, [wide.start, wide.end, MAX_DB_FETCH]),
    ]);
    const data: BadgesSite = { anime: badgesDomaine(anime, now), games: badgesDomaine(games, now) };
    if (version === badgesVersion) {
      badgesCache = { data, expiresAt: Date.now() + FEED_CACHE_TTL_MS };
      badgesEchec = null;
    }
    return data;
  })();
  badgesEnCours = calcul;
  calcul.then(
    () => {
      if (badgesEnCours === calcul) badgesEnCours = null;
    },
    (erreur) => {
      if (badgesEnCours === calcul) badgesEnCours = null;
      if (version === badgesVersion) badgesEchec = { erreur, jusqua: Date.now() + BADGES_ECHEC_MS };
    }
  );
  return calcul;
}

/** Le badge d'un titre (type « anime » ou « game ») : « populaire » s'il est parmi les 30 plus populaires des titres
 * sortis, « tres-attendu » parmi ceux à venir, sinon null. */
export function badgeDe(b: BadgesSite | null, type: unknown, id: unknown): Badge | null {
  if (!b) return null;
  const d = type === "anime" ? b.anime : type === "game" || type === "games" ? b.games : null;
  const n = Number(id);
  if (!d || !Number.isFinite(n)) return null;
  if (d.populaire.ids.has(n)) return "populaire";
  if (d.tresAttendu.ids.has(n)) return "tres-attendu";
  return null;
}

// ============================================================
// Zod validation schemas
// ============================================================

const slugsQuerySchema = z.object({
  type: z.enum(["anime", "game", "all"]).default("all"),
  // Par defaut, seules les fiches avec un vrai synopsis deviennent des
  // pages : une page sans texte serait du contenu mince pour Google.
  withDescription: z.coerce.number().int().min(0).max(1).default(1),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  type: z.enum(["anime", "game", "all"]).default("all"),
});

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  status: z.enum(["released", "upcoming", "all"]).default("all"),
  orderBy: z.enum(["score", "date"]).default("score"),
  genre: z.string().max(300).optional(),
  platform: z.string().max(300).optional(),
  search: z.string().max(200).optional(),
  releasedAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  releasedBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// Filtre en memoire : genre/platform (OR, insensible casse, substring), search (titre), dates
function applyFeedFilters(items: GameNimeItem[], q: any): GameNimeItem[] {
  let out = items;
  // Genre : au moins un des genres demandes present dans la liste de l'item
  if (q.genre) {
    const wanted = String(q.genre).split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length) {
      out = out.filter((it) => {
        const g = ((it as any).genre || "").toLowerCase();
        return wanted.some((w: string) => g.includes(w));
      });
    }
  }
  // Platform : au moins une des plateformes demandees (substring -> "PlayStation" matche "PlayStation 5")
  if (q.platform) {
    const wanted = String(q.platform).split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length) {
      out = out.filter((it) => {
        const p = ((it as any).platform || "").toLowerCase();
        return wanted.some((w: string) => p.includes(w));
      });
    }
  }
  // Search : texte dans le titre (romaji ou anglais)
  if (q.search) {
    // Recherche avec surnoms : "gta" trouve aussi "grand theft auto", "jjk" -> "jujutsu kaisen".
    const terms = expandSearchTerm(String(q.search));
    if (terms.length > 0 && terms[0]) {
      out = out.filter((it) => {
        const t1 = ((it as any).title || "").toLowerCase();
        const t2 = ((it as any).titleEnglish || "").toLowerCase();
        return terms.some((term) => t1.includes(term) || t2.includes(term));
      });
    }
  }
  // Dates (sur release_date au format YYYY-MM-DD)
  if (q.releasedAfter) {
    out = out.filter((it) => { const d = (it as any).releaseDate; return d && d >= q.releasedAfter; });
  }
  if (q.releasedBefore) {
    out = out.filter((it) => { const d = (it as any).releaseDate; return d && d <= q.releasedBefore; });
  }
  return out;
}

// ============================================================
// Routes
// ============================================================

/**
 * AniList and similar APIs use a small set of "default" cover URLs when an
 * item has no real image yet. These covers should NEVER be used to detect
 * duplicates because dozens of unrelated items share them.
 */
function isGenericCover(url: string): boolean {
  if (!url) return true;
  const lowered = url.toLowerCase();
  // Common generic patterns from AniList, Jikan, etc.
  return (
    lowered.includes("/default.jpg") ||
    lowered.includes("/default.png") ||
    lowered.includes("/cover/medium/default") ||
    lowered.includes("/cover/large/default") ||
    lowered.includes("placeholder") ||
    lowered.includes("noimage") ||
    lowered.includes("no-image") ||
    lowered.includes("missing.png") ||
    lowered.includes("missing.jpg")
  );
}

/**
 * Build duplicate groups using union-find on multiple keys:
 *   - K1: type + normalizedTitle + releaseDate (catches transliterations)
 *   - K2: type + cover + releaseDate (catches different language titles)
 *
 * Two items are merged into the same group if they share AT LEAST ONE key.
 * This catches cases where:
 *   - Same anime with romaji vs English title (same cover)
 *   - Same anime with transliteration variants (same normalized title)
 *
 * Returns a Map<groupId, items[]> with only groups containing 2+ items.
 */
function buildDuplicateGroups(
  items: GameNimeItem[]
): Map<string, GameNimeItem[]> {
  // Build key→items index for both keys
  const titleIdx = new Map<string, GameNimeItem[]>();
  const coverIdx = new Map<string, GameNimeItem[]>();
  // SESSION 11 ETAT CLEAN ABSOLU : 5e critere anti-doublon (titleEnglish + date)
  const englishIdx = new Map<string, GameNimeItem[]>();
  // SESSION 12.7 ETAT CLEAN ABSOLU : 6e + 7e criteres anti-doublon (IDs externes)
  // Detecte les doublons cross-source ou eleceec d'un meme anime stocke avec
  // titres differents (romaji vs english vs translit) mais meme anilist_id ou mal_id.
  const anilistIdx = new Map<string, GameNimeItem[]>();
  const malIdx = new Map<string, GameNimeItem[]>();
  // Un jeu n'a ni anilist_id ni mal_id : rawg_id/igdb_id sont ses SEULS
  // identifiants stables. Sans ces cles, les jeux ne sont dedoublonnes que
  // par titre et cover (cas "The Sinking City 2" vs "Sinking City 2").
  const rawgIdx = new Map<string, GameNimeItem[]>();
  const igdbIdx = new Map<string, GameNimeItem[]>();

  for (const item of items) {
    // un titre que la normalisation vide (écriture non latine, symboles seuls) ne rapproche rien : sinon tous ces titres
    // de même date, ou sans date, formaient un seul groupe (17 octobre 2026)
    const titreNorm = normalizeTitle(item.title);
    // une fiche sans date (animé « Date à annoncer », jeu sans date) n'est pas rapprochée par son seul titre : deux
    // fiches différentes, toutes deux sans date, ne font pas un doublon (la fusion, automatique quand elle est allumée,
    // en supprimerait une) ; ses identifiants (AniList et MAL, IGDB et RAWG) la rapprochent toujours de ses vrais
    // doublons (20 octobre 2026)
    if (titreNorm && item.releaseDate) {
      const titleKey = `${item.type}:T:${titreNorm}:${item.releaseDate || "no-date"}`;
      (titleIdx.get(titleKey) || titleIdx.set(titleKey, []).get(titleKey)!).push(item);
    }

    if (item.cover && item.releaseDate && !isGenericCover(item.cover)) {
      const coverKey = `${item.type}:C:${item.cover}:${item.releaseDate}`;
      (coverIdx.get(coverKey) || coverIdx.set(coverKey, []).get(coverKey)!).push(item);
    }

    // SESSION 11 critere 5 : titleEnglish normalise + date.
    // Detecte les variantes de title (romaji) qui partagent le meme title_english.
    // Ex: "Boku no Hero Academia No. 170+1: More" et "Boku no Hero Academia: More"
    //     ont tous deux titleEnglish convergent vers "myheroacademiamore" -> match auto.
    // Skip si titleEnglish manquant : evite faux positifs sur items obscurs.
    if (item.titleEnglish && item.releaseDate) {
      const normEng = normalizeTitle(item.titleEnglish);
      if (normEng) {
        const englishKey = `${item.type}:E:${normEng}:${item.releaseDate}`;
        (englishIdx.get(englishKey) || englishIdx.set(englishKey, []).get(englishKey)!).push(item);
      }
    }

    // SESSION 12.7 critere 6 : anilist_id (cle d'identification stable AniList)
    // Plus fiable que tout titre car indep de la traduction.
    const aid = (item as any).anilistId;
    if (aid && aid > 0) {
      const aidKey = `${item.type}:A:${aid}`;
      (anilistIdx.get(aidKey) || anilistIdx.set(aidKey, []).get(aidKey)!).push(item);
    }

    // SESSION 12.7 critere 7 : mal_id (cle d'identification stable MyAnimeList/Jikan)
    const mid = (item as any).malId;
    if (mid && mid > 0) {
      const midKey = `${item.type}:M:${mid}`;
      (malIdx.get(midKey) || malIdx.set(midKey, []).get(midKey)!).push(item);
    }

    const rid = (item as any).rawgId;
    if (rid && rid > 0) {
      const ridKey = `${item.type}:R:${rid}`;
      (rawgIdx.get(ridKey) || rawgIdx.set(ridKey, []).get(ridKey)!).push(item);
    }

    const gid = (item as any).igdbId;
    if (gid && gid > 0) {
      const gidKey = `${item.type}:G:${gid}`;
      (igdbIdx.get(gidKey) || igdbIdx.set(gidKey, []).get(gidKey)!).push(item);
    }
  }

  // Union-find par fiche : « type:numéro » (17 octobre 2026). Un animé et un jeu peuvent porter le même numéro :
  // rangés sous le seul numéro, ils devenaient un même nœud, donc un faux groupe de doublons, et la fusion supprimait
  // la fiche gagnante elle-même. Les clés de rapprochement portent déjà le type : un animé n'est jamais rapproché d'un jeu.
  const noeud = (item: GameNimeItem): string => `${item.type}:${item.id}`;
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (parent.get(x) === x) return x;
    const p = find(parent.get(x)!);
    parent.set(x, p);
    return p;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const item of items) parent.set(noeud(item), noeud(item));

  // For every shared key (title, cover, or titleEnglish), union items together
  for (const list of [...titleIdx.values(), ...coverIdx.values(), ...englishIdx.values(), ...anilistIdx.values(), ...malIdx.values(), ...rawgIdx.values(), ...igdbIdx.values()]) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) union(noeud(list[0]), noeud(list[i]));
  }

  // Additional pass: detect "(YYYY)" asymmetry duplicates.
  // RAWG adds "(YYYY)" placeholders to legacy entries; the real entry
  // has no year suffix. We union them ONLY if:
  //   - same type
  //   - same normalized title (without the year suffix)
  //   - one has the year suffix, the other doesn't (true asymmetry)
  //   - release dates within 2 years (guards against remakes/reboots)
  const asymKey = new Map<string, GameNimeItem[]>();
  for (const item of items) {
    const titreN = normalizeTitle(item.title);
    if (!titreN) continue;
    const key = `${item.type}:N:${titreN}`;
    const list = asymKey.get(key) || [];
    list.push(item);
    asymKey.set(key, list);
  }
  for (const list of asymKey.values()) {
    if (list.length < 2) continue;
    const withYear = list.filter((i) => hasYearSuffix(i.title));
    const withoutYear = list.filter((i) => !hasYearSuffix(i.title));
    if (withYear.length === 0 || withoutYear.length === 0) continue;

    // Asymmetry exists. Now check pairwise dates within 2 years.
    for (const a of withoutYear) {
      for (const b of withYear) {
        const dateA = a.releaseDate ? new Date(a.releaseDate + "T00:00:00Z") : null;
        const dateB = b.releaseDate ? new Date(b.releaseDate + "T00:00:00Z") : null;
        if (!dateA || !dateB) continue;
        const yearsApart = Math.abs(dateA.getTime() - dateB.getTime()) / (365.25 * 86400000);
        if (yearsApart <= 2) union(noeud(a), noeud(b));
      }
    }
  }

  // Group by root id
  const groups = new Map<string, GameNimeItem[]>();
  for (const item of items) {
    const root = find(noeud(item));
    const key = String(root);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }

  // Keep only groups with 2+ items
  for (const [k, v] of groups.entries()) {
    if (v.length < 2) groups.delete(k);
  }

  return groups;
}

export async function registerGameNimeRoutes(
  app: FastifyInstance,
  pool: any,
  options: { adminApiKey?: string } = {}
): Promise<void> {
  // Top 25 « du moment » (du-moment.ts, 16 octobre 2026) : ses relevés démarrent avec les routes qui le servent.
  demarrerDuMoment({ pool, log: app.log, rafraichir: clearFeedCache });

  // ─────────────────────────────────────────────────
  // GET /feed/home — mixed top items (homepage)
  // ─────────────────────────────────────────────────

// SESSION 12.7+: applique le strip des tags métadonnées aux descriptions servies au frontend.
// Les tags restent intacts en DB.
// 14 octobre 2026 : et le badge « populaire » / « tres-attendu » de chaque titre (lireBadges).
function applyDisplayStripToItems<T extends { description?: string | null }>(items: T[], badges: BadgesSite | null): T[] {
  return items.map(i => ({
    ...i,
    description: stripDisplayTags(i.description),
    contentTag: (i as any).format === "MOVIE" ? "FILM" : ((i as any).gameType === "DLC" ? "DLC" : null),
    badge: badgeDe(badges, (i as any).type, (i as any).id),
  }));
}

/** Les badges du site, ou aucun si le calcul échoue : un flux ne tombe jamais à cause d'un badge. */
async function badgesOuRien(req: FastifyRequest): Promise<BadgesSite | null> {
  try {
    return await lireBadges(pool);
  } catch (e: any) {
    req.log.warn({ err: e?.message }, "badges : calcul impossible");
    return null;
  }
}

  app.get("/feed/home", async (req: FastifyRequest, reply: FastifyReply) => {
    const cacheKey = "feed:home";
    const cached = getCached(cacheKey);
    if (cached) {
      req.log.debug({ cacheKey }, "feed.home cache hit");
      return reply.send(cached);
    }

    const now = new Date();
    const wide = buildWideDateFilter(now);

    const [animeRaw, gamesRaw]: [GameNimeItem[], GameNimeItem[]] = await Promise.all([
      pool.query(SELECT_ANIME, [wide.start, wide.end, MAX_DB_FETCH]),
      pool.query(SELECT_GAMES, [wide.start, wide.end, MAX_DB_FETCH]),
    ]);

    const animeRawSorted = sortForGameNimeTop(animeRaw, CAPACITY_ANIME, now);
    const gamesRawSorted = sortForGameNimeTop(gamesRaw, CAPACITY_GAMES, now);

    // Mixed top: combine and re-sort (sans le bonus europeen : animes et jeux restent comparables comme avant)
    const mixedRaw = sortForGameNimeTop(sansBonusEurope([...animeRawSorted, ...gamesRawSorted]), CAPACITY_HOME, now);
    const badges = await badgesOuRien(req);
    const anime = applyDisplayStripToItems(animeRawSorted, badges);
    const games = applyDisplayStripToItems(gamesRawSorted, badges);
    const mixed = applyDisplayStripToItems(mixedRaw, badges);

    const payload = {
      window: getReleaseWindow(now),
      generatedAt: now.toISOString(),
      counts: { anime: anime.length, games: games.length, home: mixed.length },
      home: mixed,
      anime,
      games,
    };

    setCached(cacheKey, payload);
    req.log.info(
      { animeFetched: animeRaw.length, gamesFetched: gamesRaw.length, homeSize: mixed.length },
      "feed.home computed"
    );

    return reply.send(payload);
  });

  // ─────────────────────────────────────────────────
  // GET /feed/today — sorties du jour (anime + jeux)
  // Pour le bot Discord. Seulement les dates au jour (20 octobre 2026) : une date au mois tombait le 1er, et le bot
  // annoncait « sorti aujourd'hui » le 1er novembre un titre prevu en novembre (une fausse information). Le film au
  // cinema en France a son jour (PRECISION_ANIME_SITE).
  // ─────────────────────────────────────────────────
  app.get("/feed/today", async (req: FastifyRequest, reply: FastifyReply) => {
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const SELECT_TODAY_ANIME = `
      SELECT title, title_english AS titleEnglish, cover, ${PLATEFORME_ANIME_SITE} AS platform,
             DATE_FORMAT(${DATE_ANIME_SITE}, '%Y-%m-%d') AS releaseDate,
             'anime' AS type
      FROM anime_items
      WHERE ${DATE_ANIME_SITE} = ?
        AND IFNULL(${PRECISION_ANIME_SITE}, 'day') = 'day'
        AND title IS NOT NULL AND title != ''
        AND ${ANIME_VISIBLE}
      ORDER BY popularity DESC
    `;
    const SELECT_TODAY_GAMES = `
      SELECT title, title_english AS titleEnglish, cover, platform,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             'game' AS type
      FROM game_items
      WHERE release_date = ?
        AND IFNULL(release_precision, 'day') = 'day'
        AND title IS NOT NULL AND title != ''
      ORDER BY popularity DESC
    `;
    const [anime, games]: [any[], any[]] = await Promise.all([
      pool.query(SELECT_TODAY_ANIME, [todayISO]),
      pool.query(SELECT_TODAY_GAMES, [todayISO]),
    ]);
    // Pas de badge pour le bot Discord : ces lignes n'ont pas d'identifiant.
    const animeClean = applyDisplayStripToItems(anime, null);
    const gamesClean = applyDisplayStripToItems(games, null);
    const payload = {
      date: todayISO,
      generatedAt: now.toISOString(),
      counts: { anime: animeClean.length, games: gamesClean.length, total: animeClean.length + gamesClean.length },
      anime: animeClean,
      games: gamesClean,
    };
    req.log.info({ date: todayISO, anime: animeClean.length, games: gamesClean.length }, "feed.today");
    return reply.send(payload);
  });

  // ─────────────────────────────────────────────────
  // GET /feed/anime — top anime
  // ─────────────────────────────────────────────────
  app.get("/feed/anime", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    const status: ReleaseStatus = parsed.success ? parsed.data.status : "all";
    // Plafond selon le contexte : "a venir" = 300 (CAPACITY_UPCOMING_ANIME),
    // le reste (Top) = 150 (CAPACITY_ANIME). Le Top reste intouche.
    const cap = status === "upcoming" ? CAPACITY_UPCOMING_ANIME : CAPACITY_ANIME;
    const requested = parsed.success ? parsed.data.limit ?? cap : cap;
    const limit = Math.min(requested, cap);
    const orderBy: "score" | "date" = parsed.success ? parsed.data.orderBy : "score";

    const now = new Date();
    const wide = buildWideDateFilter(now);
    const allRows: GameNimeItem[] = await pool.query(SELECT_ANIME, [wide.start, wide.end, MAX_DB_FETCH]);
    // « Date à annoncer » (reportés sans nouvelle date) : à la fin d'« À venir » trié par date, jamais ailleurs
    const statusFiltered = status === "upcoming" && orderBy === "date"
      ? [...filterByStatus(allRows, status, now), ...(await animesAAnnoncer(pool))]
      : filterByStatus(allRows, status, now);
    const filtered = parsed.success ? applyFeedFilters(statusFiltered, parsed.data) : statusFiltered;
    // les sortis par score : le Top 25 « du moment » (du-moment.ts) ; le reste comme avant
    const itemsRaw = orderBy === "date"
      ? sortByDate(filtered, limit, now, status === "upcoming")
      : status === "released" ? trierDuMoment("anime", filtered, limit, now) : sortForGameNimeTop(filtered, limit, now);
    const items = applyDisplayStripToItems(itemsRaw, await badgesOuRien(req));

    req.log.info({ fetched: allRows.length, filtered: filtered.length, returned: items.length, status, orderBy }, "feed.anime computed");

    return reply.send({
      window: getReleaseWindow(now),
      status,
      orderBy,
      total: items.length,
      items,
    });
  });

  // ─────────────────────────────────────────────────
  // GET /feed/games — top games
  // ─────────────────────────────────────────────────
  app.get("/feed/games", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    const statusG: ReleaseStatus = parsed.success ? parsed.data.status : "all";
    const capG = statusG === "upcoming" ? CAPACITY_UPCOMING_GAMES : CAPACITY_GAMES;
    const requested = parsed.success ? parsed.data.limit ?? capG : capG;
    const limit = Math.min(requested, capG);
    const status: ReleaseStatus = parsed.success ? parsed.data.status : "all";
    const orderBy: "score" | "date" = parsed.success ? parsed.data.orderBy : "score";

    const now = new Date();
    const wide = buildWideDateFilter(now);
    const allRows: GameNimeItem[] = await pool.query(SELECT_GAMES, [wide.start, wide.end, MAX_DB_FETCH]);
    // « Date à annoncer » (IGDB n'a plus aucune date) : à la fin d'« À venir » trié par date, jamais ailleurs
    const statusFiltered = status === "upcoming" && orderBy === "date"
      ? [...filterByStatus(allRows, status, now), ...(await jeuxAAnnoncer(pool))]
      : filterByStatus(allRows, status, now);
    const filtered = parsed.success ? applyFeedFilters(statusFiltered, parsed.data) : statusFiltered;
    // les sortis par score : le Top 25 « du moment » (du-moment.ts) ; le reste comme avant
    const itemsRaw = orderBy === "date"
      ? sortByDate(filtered, limit, now, status === "upcoming")
      : status === "released" ? trierDuMoment("game", filtered, limit, now) : sortForGameNimeTop(filtered, limit, now);
    const items = applyDisplayStripToItems(itemsRaw, await badgesOuRien(req));

    req.log.info({ fetched: allRows.length, filtered: filtered.length, returned: items.length, status, orderBy }, "feed.games computed");

    return reply.send({
      window: getReleaseWindow(now),
      status,
      orderBy,
      total: items.length,
      items,
    });
  });

  // ─────────────────────────────────────────────────
  // GET /feed/search — search across both types
  // ─────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // GET /feed/week — radar hebdo des episodes en diffusion (session 33)
  // AnimeSchedule /timetables/sub donne episodeNumber + episodeDate (ISO, heure
  // exacte). On croise sur anime_schedule_route : cle deterministe, pas de match
  // par titre. Seuls les animes DEJA en base ressortent, donc les filtres de
  // popularite et de qualite s'appliquent naturellement.
  // Rien n'est stocke dans anime_items : l'episode courant est volatil, une colonne serait
  // perimee entre deux crons. Cache memoire 15 min.
  // Semaine de secours (20 octobre 2026) : le 20 octobre, AnimeSchedule a repondu HTTP 521 juste apres le redemarrage
  // de la mise en prod, et la semaine vide a ete gardee 15 min : « Cette semaine » avait disparu de l'accueil. Apres un
  // echec (erreur HTTP, reseau, 10 s sans reponse, reponse sans episode de la semaine), la derniere bonne semaine est
  // resservie : celle de la
  // memoire, sinon celle gardee en base (semaine_animeschedule : une ligne par semaine ISO, les seuls champs lus), qui
  // survit a un redemarrage. Un echec n'est garde qu'une minute ; une lecture d'AnimeSchedule au plus a la fois.
  // ─────────────────────────────────────────────────────────────────────────
  let weekCache: { at: number; ttl: number; data: any } | null = null;
  const WEEK_CACHE_MS = Number(process.env.SEMAINE_CACHE_MS) || 15 * 60 * 1000;
  const WEEK_REESSAI_MS = Number(process.env.SEMAINE_REESSAI_MS) || 60 * 1000;
  const WEEK_DELAI_MS = Number(process.env.SEMAINE_DELAI_MS) || 10 * 1000;
  let semaineEnCours: Promise<any> | null = null;
  let derniereBonne: { cle: string; timetable: any[] } | null = null;
  let tableSemaine: Promise<boolean> | null = null;
  function tableSemainePrete(): Promise<boolean> {
    if (tableSemaine) return tableSemaine;
    // creee une fois ; un echec (droits, base) sera retente a la prochaine semaine a garder ou a relire
    const prete: Promise<boolean> = pool
      .query(
        "CREATE TABLE IF NOT EXISTS semaine_animeschedule (semaine VARCHAR(10) NOT NULL PRIMARY KEY, " +
          "donnees MEDIUMTEXT NOT NULL, le DATETIME NOT NULL)"
      )
      .then(() => true)
      .catch((e: any) => {
        app.log.warn({ err: e?.message }, "feed/week: table semaine_animeschedule indisponible");
        tableSemaine = null;
        return false;
      });
    tableSemaine = prete;
    return prete;
  }
  // les seuls champs de la semaine lus plus bas
  const compacter = (t: any[]) =>
    t.map((a) => ({ route: a?.route ?? null, episodeDate: a?.episodeDate ?? null, episodeNumber: a?.episodeNumber ?? null, episodes: a?.episodes ?? null }));

  function isoWeek(d: Date): { week: number; year: number } {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return { week, year: t.getUTCFullYear() };
  }

  // Le badge de chaque anime, le même que dans les listes (lireBadges) : posé à chaque réponse, pas gardé dans le
  // cache de la semaine (15 min), pour suivre le classement comme le reste du site.
  async function semaineAvecBadges(req: FastifyRequest, data: any): Promise<any> {
    const badges = data.total > 0 ? await badgesOuRien(req) : null;
    const avec = (e: any) => ({ ...e, badge: badgeDe(badges, "anime", e.id) });
    return { ...data, days: data.days.map((d: any) => ({ ...d, episodes: d.episodes.map(avec) })), imminent: data.imminent.map(avec) };
  }

  app.get("/feed/week", async (req: FastifyRequest, reply: FastifyReply) => {
    if (weekCache && Date.now() - weekCache.at < weekCache.ttl) {
      return semaineAvecBadges(req, weekCache.data);
    }
    // une lecture au plus a la fois : les visiteurs arrives pendant la lecture attendent la meme
    const enCours = semaineEnCours ?? (semaineEnCours = calculerSemaine(req).finally(() => { semaineEnCours = null; }));
    return semaineAvecBadges(req, await enCours);
  });

  async function calculerSemaine(req: FastifyRequest): Promise<any> {
    const token = process.env.ANIMESCHEDULE_TOKEN || "";
    const now = new Date();
    const { week, year } = isoWeek(now);
    const cle = `${year}-W${String(week).padStart(2, "0")}`;

    // une entree n'est utile que si elle a une route et un episode dans la semaine demandee (lundi 00:00 UTC + 7 j) :
    // une reponse sans aucune entree utile ([], [{}], dates « 0001-01-01 »...) est un echec, elle ne remplace pas la
    // derniere bonne semaine
    const debutSemaine = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() || 7) - 1) * 86400000;
    const utile = (a: any) => {
      const t = new Date(a?.episodeDate ?? NaN).getTime();
      return typeof a?.route === "string" && a.route !== "" && t >= debutSemaine && t < debutSemaine + 7 * 86400000;
    };
    let timetable: any[] = [];
    let source = "animeschedule";
    try {
      const res = await fetch(
        `https://animeschedule.net/api/v3/timetables/sub?week=${week}&year=${year}`,
        { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(WEEK_DELAI_MS) }
      );
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j) && j.some(utile)) timetable = j;
        else req.log.warn({ tableau: Array.isArray(j), entrees: Array.isArray(j) ? j.length : null }, "feed/week: AnimeSchedule reponse sans episode de la semaine");
      } else {
        req.log.warn({ status: res.status }, "feed/week: AnimeSchedule HTTP error");
      }
    } catch (e: any) {
      req.log.warn({ err: e?.message }, "feed/week: AnimeSchedule fetch failed");
    }
    const lue = timetable.length > 0;
    if (lue) {
      const garde = compacter(timetable);
      derniereBonne = { cle, timetable: garde };
      // gardee en base pour un redemarrage ; la reponse n'attend pas
      tableSemainePrete()
        .then(async (prete) => {
          if (!prete) return;
          await pool.query(
            "INSERT INTO semaine_animeschedule (semaine, donnees, le) VALUES (?, ?, UTC_TIMESTAMP()) " +
              "ON DUPLICATE KEY UPDATE donnees = VALUES(donnees), le = VALUES(le)",
            [cle, JSON.stringify(garde)]
          );
          await pool.query("DELETE FROM semaine_animeschedule WHERE le < UTC_TIMESTAMP() - INTERVAL 60 DAY");
        })
        .catch((e: any) => {
          // table effacee depuis (base restauree...) : recreee a la prochaine semaine gardee
          if (e?.errno === 1146) tableSemaine = null;
          req.log.warn({ err: e?.message }, "feed/week: semaine pas gardee en base");
        });
    } else if (derniereBonne && derniereBonne.cle === cle) {
      timetable = derniereBonne.timetable;
      source = "memoire";
    } else if (await tableSemainePrete()) {
      try {
        const r: any[] = await pool.query("SELECT donnees FROM semaine_animeschedule WHERE semaine = ?", [cle]);
        const t = r.length ? JSON.parse(String(r[0].donnees)) : null;
        if (Array.isArray(t) && t.length > 0) {
          timetable = t;
          derniereBonne = { cle, timetable: t };
          source = "base";
        }
      } catch (e: any) {
        if (e?.errno === 1146) tableSemaine = null;
        req.log.warn({ err: e?.message }, "feed/week: semaine gardee illisible");
      }
    }
    if (!lue && timetable.length === 0) source = "aucune";

    const routes = timetable.map((a) => a?.route).filter(Boolean);
    let byRoute = new Map<string, any>();
    if (routes.length > 0) {
      const ph = routes.map(() => "?").join(",");
      const rows: any[] = await pool.query(
        `SELECT id, slug, title, title_english AS titleEnglish, cover, platform, trailer_url AS trailerUrl,
                anime_schedule_route AS route, popularity
         FROM anime_items WHERE anime_schedule_route IN (${ph}) AND IFNULL(statut_anilist, '') <> 'CANCELLED' AND (TRIM(IFNULL(platform, '')) <> '' OR ((pays_origine IS NULL OR pays_origine IN ('JP', '--')) AND (release_precision IS NULL OR release_precision <> 'day' OR release_date IS NULL OR release_date > UTC_DATE())))`,
        routes
      );
      for (const r of rows) byRoute.set(r.route, r);
    }

    // Lundi 00:00 UTC de la semaine courante
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1));

    const DAY_NAMES = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
    const days: any[] = [];
    for (let k = 0; k < 7; k++) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + k);
      days.push({
        date: d.toISOString().slice(0, 10),
        dayName: DAY_NAMES[k],
        dayNum: d.getUTCDate(),
        episodes: [] as any[],
      });
    }

    const nowMs = Date.now();
    let total = 0;
    for (const a of timetable) {
      const item = byRoute.get(a?.route);
      if (!item) continue;
      const when = a?.episodeDate ? new Date(a.episodeDate) : null;
      if (!when || Number.isNaN(when.getTime())) continue;
      const idx = days.findIndex((x) => x.date === when.toISOString().slice(0, 10));
      if (idx < 0) continue;
      days[idx].episodes.push({
        id: item.id,
        // Le slug permet un vrai lien vers la fiche depuis l'accueil, au lieu
        // d'ouvrir seulement la modale : autant de liens internes que d'episodes.
        slug: item.slug ?? null,
        // La bande-annonce au survol sur l'accueil : sans elle, les cartes de
        // la semaine sont les seules du site a ne pas en avoir.
        trailerUrl: item.trailerUrl ?? null,
        title: item.title,
        titleEnglish: item.titleEnglish,
        cover: item.cover,
        platform: item.platform,
        popularity: item.popularity,
        episodeNumber: a.episodeNumber ?? null,
        episodeTotal: a.episodes ?? null,
        airingAt: when.toISOString(),
        aired: when.getTime() <= nowMs,
      });
      total++;
    }

    for (const d of days) {
      d.episodes.sort((x: any, y: any) => x.airingAt.localeCompare(y.airingAt));
      d.count = d.episodes.length;
    }

    const imminent = days
      .flatMap((d) => d.episodes)
      .filter((e: any) => !e.aired)
      .sort((a: any, b: any) => a.airingAt.localeCompare(b.airingAt))
      .slice(0, 3);

    const data = {
      generatedAt: new Date().toISOString(),
      weekStart: days[0].date,
      weekEnd: days[6].date,
      today: new Date().toISOString().slice(0, 10),
      total,
      fetched: timetable.length,
      // d'ou vient la semaine : animeschedule (lue a l'instant) ; memoire ou base (la derniere bonne, AnimeSchedule en
      // echec) ; aucune (rien a resservir)
      source,
      days,
      imminent,
    };
    // un echec n'est garde qu'une minute : AnimeSchedule est relu des que possible
    weekCache = { at: Date.now(), ttl: lue ? WEEK_CACHE_MS : WEEK_REESSAI_MS, data };
    req.log.info({ total, fetched: timetable.length, source }, "feed/week");
    return data;
  }

  // ─────────────────────────────────────────────────
  // GET /feed/badges — qui porte le badge (lecture seule, 14 octobre 2026)
  // Les identifiants des titres « populaire » et « tres-attendu » de chaque catégorie, et la popularité du
  // dernier : les mêmes que dans les flux (même cache). Sert aux vérifications de l'installation.
  // ─────────────────────────────────────────────────
  app.get("/feed/badges", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = await lireBadges(pool);
    const liste = (l: ListeBadge) => ({ ids: [...l.ids].sort((x, y) => x - y), seuil: l.seuil });
    return reply.send({
      anime: { populaire: liste(b.anime.populaire), tresAttendu: liste(b.anime.tresAttendu) },
      games: { populaire: liste(b.games.populaire), tresAttendu: liste(b.games.tresAttendu) },
    });
  });

  // Liste id + slug + updatedAt pour le build des pages indexables et le
  // sitemap. Volontairement minimal : /feed/anime renverrait des megaoctets
  // de fiches completes la ou le build n'a besoin que de deux champs.
  app.get("/feed/slugs", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = slugsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const { type, withDescription } = parsed.data;
    // Longueur du VRAI texte : les balises [FORMAT:] [STATUS:] [SEASON:] posees
    // par n8n gonflaient la mesure, si bien qu'une fiche generique de 43
    // caracteres passait le seuil quand un vrai synopsis pouvait echouer.
    // Bascule des synopsis (21 octobre 2026) : un synopsis validé par Rey de 150 caractères ou plus est aussi un vrai
    // synopsis (la page l'affiche à la place de la description) ; une page déjà là le reste (sa description compte).
    const descCond = withDescription
      ? ` AND (${SYNOPSIS_PAGE} OR (description IS NOT NULL` +
        " AND LENGTH(TRIM(REGEXP_REPLACE(description, '\\[[A-Z]+:[^]]*\\]', ''))) >= 150))"
      : "";
    const lister = async (table: "anime_items" | "game_items", t: "anime" | "game") => {
      const rows: Array<{ id: number; slug: string; updatedAt: string; title: string; titleEnglish: string | null; releaseDate: string | null; releasePrecision: string | null }> = await pool.query(
        `SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish,
                DATE_FORMAT(${table === "anime_items" ? DATE_ANIME_SITE : "release_date"}, '%Y-%m-%d') AS releaseDate,
                ${table === "anime_items" ? PRECISION_ANIME_SITE : "release_precision"} AS releasePrecision,
                DATE_FORMAT(${MAJ_SITE}, '%Y-%m-%d') AS updatedAt
         FROM ${table}
         WHERE slug IS NOT NULL AND slug != ''${descCond}${table === "anime_items" ? ` AND ${ANIME_VISIBLE}` : ""}
         ORDER BY id`
      );
      return rows.map((r) => ({ ...r, type: t }));
    };
    const items = [
      ...(type === "anime" || type === "all" ? await lister("anime_items", "anime") : []),
      ...(type === "game" || type === "all" ? await lister("game_items", "game") : []),
    ];
    return reply.send({ total: items.length, items });
  });

  app.get("/feed/search", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }

    const { q, type } = parsed.data;
    // Surnoms : "gta" -> "grand theft auto", "jjk" -> "jujutsu kaisen".
    // Le dictionnaire existait deja mais n'etait branche que sur le
    // parametre search= des feeds, pas sur la recherche du site — d'ou
    // "gta" qui ne renvoyait que "IGTAP", un titre contenant g-t-a.
    const alias = expandSearchTerm(q);
    const qEffectif = alias.length > 1 ? alias[1] : q;
    const escapedPattern = `%${escapeLikePattern(qEffectif)}%`;
    // Recherche par mots : chaque terme doit apparaitre dans au moins un
    // des titres. Sans ca, "one piece film" echouait des que le titre reel
    // intercalait autre chose entre les mots.
    const mots = qEffectif.split(/\s+/).filter((m) => m.length >= 2).slice(0, 6);
    const motsPattern = mots.map((m) => `%${escapeLikePattern(m)}%`);
    const now = new Date();

    let anime: GameNimeItem[] = [];
    let games: GameNimeItem[] = [];

    if (type === "anime" || type === "all") {
      anime = await pool.query(
        `SELECT id, slug, title, title_english AS titleEnglish, cover, genre, ${PLATEFORME_ANIME_SITE} AS platform, ${DESCRIPTION_SITE} AS description, rating, rating_score AS ratingScore, popularity, screenshots,
                CAST(europe_bonus AS SIGNED) AS europeBonus,
                DATE_FORMAT(${DATE_ANIME_SITE}, '%Y-%m-%d') AS releaseDate,
                IF(${FILM_AU_CINEMA}, NULL, DATE_FORMAT(release_datetime, '%Y-%m-%dT%H:%i:%s')) AS releaseDatetime,
                ${PRECISION_ANIME_SITE} AS releasePrecision,
                ${CINEMA_FR} AS cinemaFr,
                is_recently_released AS isRecentlyReleased,
                trailer_url AS trailerUrl,
                format,
                'anime' AS type
         FROM anime_items
         WHERE ${mots.length
           ? mots.map(() => "(title LIKE ? OR title_english LIKE ? OR title_native LIKE ?)").join(" AND ")
           : "(title LIKE ? OR title_english LIKE ? OR title_native LIKE ?)"}
         AND ${ANIME_VISIBLE}
         LIMIT ?`,
        [...(mots.length
          ? motsPattern.flatMap((m) => [m, m, m])
          : [escapedPattern, escapedPattern, escapedPattern]), SEARCH_LIMIT_PER_TYPE]
      );
    }

    if (type === "game" || type === "all") {
      games = await pool.query(
        `SELECT id, slug, title, title_english AS titleEnglish, cover, genre, platform, ${DESCRIPTION_SITE} AS description, rating, rating_score AS ratingScore, popularity, screenshots,
                CAST(europe_bonus AS SIGNED) AS europeBonus,
                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
                DATE_FORMAT(release_datetime, '%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
                release_precision AS releasePrecision,
                is_recently_released AS isRecentlyReleased,
                trailer_url AS trailerUrl,
                'game' AS type
         FROM game_items
         WHERE ${mots.length
           ? mots.map(() => "(title LIKE ? OR title_english LIKE ?)").join(" AND ")
           : "(title LIKE ? OR title_english LIKE ?)"}
         LIMIT ?`,
        [...(mots.length
          ? motsPattern.flatMap((m) => [m, m])
          : [escapedPattern, escapedPattern]), SEARCH_LIMIT_PER_TYPE]
      );
    }

    // Score and sort search results too ; animes et jeux melanges : sans le bonus europeen (« anime » ou « game » seuls : avec)
    const trouves = type === "all" ? sansBonusEurope([...anime, ...games]) : [...anime, ...games];
    const itemsRaw = sortForGameNimeTop(trouves, SEARCH_LIMIT_PER_TYPE * 2, now);
    const items = applyDisplayStripToItems(itemsRaw, await badgesOuRien(req));

    req.log.info({ query: q, type, found: items.length }, "feed.search executed");

    return reply.send({ query: q, type, total: items.length, items });
  });

  // ─────────────────────────────────────────────────
  // GET /admin/incomplete-items — priority queue for enrichment
  // ─────────────────────────────────────────────────
  app.get("/admin/incomplete-items", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const querySchema = z.object({
      type: z.enum(["anime", "game", "all"]).default("all"),
      priority: z.enum(["critical", "high", "medium", "low", "all"]).default("all"),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }

    const { type, priority, limit } = parsed.data;
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);

    // Build a query that returns only upcoming items in window
    const SELECT_INCOMPLETE = (table: string, kind: "anime" | "game") => `
      SELECT CAST(id AS UNSIGNED) AS id, title, cover, genre, platform,
             description, rating, trailer_url AS trailerUrl, screenshots,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             '${kind}' AS type
      FROM ${table}
      WHERE release_date >= ?
        AND release_date <= DATE_ADD(?, INTERVAL 1 YEAR)
      ORDER BY release_date ASC
    `;

    const animeRows = (type === "anime" || type === "all")
      ? await pool.query(SELECT_INCOMPLETE("anime_items", "anime"), [todayISO, todayISO])
      : [];
    const gameRows = (type === "game" || type === "all")
      ? await pool.query(SELECT_INCOMPLETE("game_items", "game"), [todayISO, todayISO])
      : [];

    function classifyAndCheck(item: any) {
      const missing: string[] = [];
      if (isMissing(item.cover)) missing.push("cover");
      if (isMissing(item.genre)) missing.push("genre");
      if (isMissing(item.platform)) missing.push("platform");
      if (isMissing(item.description)) missing.push("description");
      if (isMissing(item.rating)) missing.push("rating");
      if (isMissing(item.trailerUrl)) missing.push("trailer");
      if (isMissing(item.screenshots)) missing.push("screenshots");

      if (missing.length === 0) return null;

      const days = Math.floor(
        (new Date(item.releaseDate + "T00:00:00Z").getTime() - now.getTime()) / 86400000
      );

      let prio: "critical" | "high" | "medium" | "low";
      if (days <= 7) prio = "critical";
      else if (days <= 30) prio = "high";
      else if (days <= 90) prio = "medium";
      else prio = "low";

      return {
        id: item.id,
        title: item.title,
        type: item.type,
        releaseDate: item.releaseDate,
        daysLeft: days,
        priority: prio,
        missing,
      };
    }

    const all = [...animeRows, ...gameRows]
      .map(classifyAndCheck)
      .filter((x) => x !== null) as any[];

    const filtered = priority === "all" ? all : all.filter((x) => x.priority === priority);

    const totals = {
      critical: all.filter((x) => x.priority === "critical").length,
      high: all.filter((x) => x.priority === "high").length,
      medium: all.filter((x) => x.priority === "medium").length,
      low: all.filter((x) => x.priority === "low").length,
    };

    // Sort by priority (critical first) then by daysLeft asc
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => {
      const po = order[a.priority] - order[b.priority];
      if (po !== 0) return po;
      return a.daysLeft - b.daysLeft;
    });

    req.log.info({ totalIncomplete: all.length, returned: Math.min(filtered.length, limit) }, "admin.incomplete-items");

    return reply.send({
      generatedAt: now.toISOString(),
      totals,
      items: filtered.slice(0, limit),
    });
  });

  // ─────────────────────────────────────────────────
  // GET /admin/find-duplicates — detect duplicates by normalized title + date
  // ─────────────────────────────────────────────────
  app.get("/admin/find-duplicates", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const querySchema = z.object({
      type: z.enum(["anime", "game", "all"]).default("all"),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const { type } = parsed.data;

    // Fetch all items (wide range, no limit since we need to compare everything)
    const SELECT_ALL = (table: string, kind: "anime" | "game") => `
      SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, genre, platform,
             description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
             CAST(popularity AS SIGNED) AS popularity,
             trailer_url AS trailerUrl, screenshots,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             CAST(anilist_id AS SIGNED) AS anilistId,
             CAST(mal_id AS SIGNED) AS malId,
             ${kind === "game" ? "CAST(rawg_id AS SIGNED) AS rawgId, CAST(igdb_id AS SIGNED) AS igdbId," : "NULL AS rawgId, NULL AS igdbId,"}
             '${kind}' AS type
      FROM ${table}
    `;

    const animeRows = (type === "anime" || type === "all")
      ? await pool.query(SELECT_ALL("anime_items", "anime"))
      : [];
    const gameRows = (type === "game" || type === "all")
      ? await pool.query(SELECT_ALL("game_items", "game"))
      : [];

    // Group items into duplicate sets.
    // An item joins ANY group it matches (title-based OR cover-based).
    // A union-find approach merges groups when items share keys.
    const groups = buildDuplicateGroups([...animeRows, ...gameRows]);

    // Keep only groups with > 1 item
    const duplicates: any[] = [];
    for (const [key, items] of groups.entries()) {
      if (items.length < 2) continue;

      // Sort: no-year-suffix first (RAWG legacy entries have year suffix),
      // then completeness, popularity, oldest id (stable winner)
      items.sort((a, b) => {
        const ya = hasYearSuffix(a.title) ? 1 : 0;
        const yb = hasYearSuffix(b.title) ? 1 : 0;
        if (ya !== yb) return ya - yb;  // no-year-suffix wins
        const ca = computeFieldCount(a);
        const cb = computeFieldCount(b);
        if (ca !== cb) return cb - ca;
        const pa = Number(a.popularity || 0);
        const pb = Number(b.popularity || 0);
        if (pa !== pb) return pb - pa;
        return Number(a.id) - Number(b.id);
      });

      duplicates.push({
        normalizedKey: key,
        type: items[0].type,
        count: items.length,
        winner: {
          id: items[0].id,
          title: items[0].title,
          fieldCount: computeFieldCount(items[0]),
          popularity: items[0].popularity,
        },
        toMerge: items.slice(1).map((i) => ({
          id: i.id,
          title: i.title,
          fieldCount: computeFieldCount(i),
          popularity: i.popularity,
        })),
      });
    }

    req.log.info({ totalGroups: duplicates.length, type }, "admin.find-duplicates");

    return reply.send({
      generatedAt: new Date().toISOString(),
      totalDuplicateGroups: duplicates.length,
      duplicates,
    });
  });

  // ─────────────────────────────────────────────────
  // POST /admin/merge-duplicates — merge and delete duplicates
  //   ?dryRun=true (default) — simulation, no changes
  //   ?dryRun=false — actually perform merge + delete
  //
  // Strategy:
  //   1. Detect groups by (type + normalizedTitle + releaseDate)
  //   2. Pick winner = most fields filled, then most popular, then oldest id
  //   3. Merge missing fields into winner from losers
  //   4. Migrate ALL relations (favorites, votes, notifications, logs)
  //      from losers to winner
  //   5. Delete losers
  //   6. Invalidate feed cache
  // ─────────────────────────────────────────────────
  app.post("/admin/merge-duplicates", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    // Use enum for dryRun (z.coerce.boolean has surprising behavior with "false")
    const querySchema = z.object({
      type: z.enum(["anime", "game", "all"]).default("all"),
      dryRun: z.enum(["true", "false"]).default("true"),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const { type } = parsed.data;
    const dryRun = parsed.data.dryRun !== "false";

    const SELECT_ALL = (table: string, kind: "anime" | "game") => `
      SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, genre, platform,
             description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
             CAST(popularity AS SIGNED) AS popularity,
             trailer_url AS trailerUrl, screenshots,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             CAST(anilist_id AS SIGNED) AS anilistId,
             CAST(mal_id AS SIGNED) AS malId,
             ${kind === "game" ? "CAST(rawg_id AS SIGNED) AS rawgId, CAST(igdb_id AS SIGNED) AS igdbId," : "NULL AS rawgId, NULL AS igdbId,"}
             '${kind}' AS type
      FROM ${table}
    `;

    const animeRows = (type === "anime" || type === "all")
      ? await pool.query(SELECT_ALL("anime_items", "anime"))
      : [];
    const gameRows = (type === "game" || type === "all")
      ? await pool.query(SELECT_ALL("game_items", "game"))
      : [];

    // Group items into duplicate sets (title OR cover match).
    const groups = buildDuplicateGroups([...animeRows, ...gameRows]);

    // Mapping JS field -> DB column
    const FIELD_TO_COL: Record<string, string> = {
      cover: "cover",
      genre: "genre",
      platform: "platform",
      description: "description",
      rating: "rating",
      trailerUrl: "trailer_url",
      screenshots: "screenshots",
      popularity: "popularity",
    };

    // Tables that reference items by item_id + item_type
    const RELATIONAL_TABLES = ["favorites", "votes", "notification_events", "alert_log", "reminder_log"];

    const actions: any[] = [];
    let merged = 0;
    let deleted = 0;
    let relationsMigrated = 0;

    for (const [key, items] of groups.entries()) {
      if (items.length < 2) continue;

      // Sort: no-year-suffix first (RAWG legacy entries have year suffix),
      // then completeness, popularity, oldest id (stable winner)
      items.sort((a, b) => {
        const ya = hasYearSuffix(a.title) ? 1 : 0;
        const yb = hasYearSuffix(b.title) ? 1 : 0;
        if (ya !== yb) return ya - yb;
        const ca = computeFieldCount(a);
        const cb = computeFieldCount(b);
        if (ca !== cb) return cb - ca;
        const pa = Number(a.popularity || 0);
        const pb = Number(b.popularity || 0);
        if (pa !== pb) return pb - pa;
        return Number(a.id) - Number(b.id);
      });

      const winner = items[0];
      const losers = items.slice(1);
      // garde-fou (17 octobre 2026) : jamais une fiche d'une autre sorte, ni la fiche gardée elle-même, parmi celles à supprimer
      if (losers.some((l) => l.type !== winner.type || String(l.id) === String(winner.id))) {
        req.log.error({ key, winnerId: String(winner.id) }, "merge-duplicates : groupe incoherent ignore");
        continue;
      }
      const table = winner.type === "anime" ? "anime_items" : "game_items";

      // Build merge updates
      // - For "platform": MERGE the lists (never lose a valid platform)
      // - For other fields: take the first non-empty loser value if winner is empty
      const updates: any = {};
      for (const field of Object.keys(FIELD_TO_COL)) {
        if (field === "platform") {
          // Always merge platforms across winner + all losers (lossless)
          let combined = (winner as any).platform;
          for (const loser of losers) {
            combined = mergePlatforms(combined, (loser as any).platform);
          }
          if (combined !== (winner as any).platform) {
            updates.platform = combined;
          }
          continue;
        }
        if (isMissing((winner as any)[field])) {
          for (const loser of losers) {
            if (!isMissing((loser as any)[field])) {
              updates[field] = (loser as any)[field];
              break;
            }
          }
        }
      }

      const action: any = {
        normalizedKey: key,
        type: winner.type,
        winnerId: winner.id,
        winnerTitle: winner.title,
        loserIds: losers.map((l) => l.id),
        loserTitles: losers.map((l) => l.title),
        fieldsToMerge: Object.keys(updates),
        relationsMigrated: 0,
        applied: false,
      };

      if (!dryRun) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();

          // 1. UPDATE winner with merged fields
          if (Object.keys(updates).length > 0) {
            const setClauses: string[] = [];
            const values: any[] = [];
            for (const [k, v] of Object.entries(updates)) {
              setClauses.push(`${FIELD_TO_COL[k]} = ?`);
              values.push(v);
            }
            values.push(winner.id);
            await conn.query(
              `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = ?`,
              values
            );
            merged++;
          }

          // 2. Migrate ALL relations (favorites, votes, notification_events, alert_log, reminder_log)
          for (const loser of losers) {
            for (const relTable of RELATIONAL_TABLES) {
              // Use INSERT IGNORE-style update: if winner already has the relation
              // for the same user, the UPDATE on a unique key would fail.
              // Strategy: DELETE conflicting + UPDATE the rest.
              try {
                // ETAT CLEAN: prevent UNIQUE constraint violation during merge.
                // For tables with (user_id, item_type, item_id) unique key
                // (favorites, votes, alert_log, reminder_log), delete loser rows
                // whose user_id already has an equivalent row on the winner.
                // Uses multi-table DELETE (MariaDB-supported).
                await conn.query(
                  `DELETE l FROM ${relTable} l
                   INNER JOIN ${relTable} w
                     ON w.user_id = l.user_id
                    AND w.item_type = l.item_type
                    AND w.item_id = ?
                   WHERE l.item_type = ?
                     AND l.item_id = ?`,
                  [winner.id, winner.type, loser.id]
                );
              } catch (e) {
                // Tables without user_id (e.g. notification_events) — skip dedup,
                // they don't have unique constraints that could fail.
              }

              // Then migrate the rest
              const result: any = await conn.query(
                `UPDATE ${relTable} SET item_id = ? WHERE item_type = ? AND item_id = ?`,
                [winner.id, winner.type, loser.id]
              );
              const migrated = Number(result.affectedRows || 0);
              action.relationsMigrated += migrated;
              relationsMigrated += migrated;
            }
          }

          // 3. SESSION 13+: INSERT blocklist (mémorise loser pour empêcher recréation au push)
          //    DELETE losers from main table
          for (const loser of losers) {
            await conn.query(
              `INSERT INTO merge_blocklist
               (item_type, blocked_title, blocked_cover, blocked_anilist_id, blocked_mal_id, redirect_to_id, reason)
               VALUES (?, ?, ?, ?, ?, ?, 'auto_merge')`,
              [winner.type, loser.title, loser.cover || null,
               (loser as any).anilistId || null, (loser as any).malId || null,
               winner.id]
            );
            await conn.query(`DELETE FROM ${table} WHERE id = ? AND id <> ?`, [loser.id, winner.id]);
            deleted++;
          }

          await conn.commit();
          action.applied = true;
        } catch (e: any) {
          await conn.rollback();
          req.log.error({ err: e?.message, stack: e?.stack?.slice(0, 300), key }, "merge failed");
          action.error = e?.message;
        } finally {
          conn.release();
        }
      }

      actions.push(action);
    }

    if (!dryRun && actions.some((a) => a.applied)) {
      clearFeedCache();
    }

    req.log.info(
      { groups: actions.length, merged, deleted, relationsMigrated, dryRun },
      "admin.merge-duplicates"
    );
    if (!dryRun) {
      trackLastRun("auto-merge", { groups: actions.length, merged, deleted });
      if (merged > 0) {
        pushActivity({
          type: "merge",
          message: `Auto-Merge fusionne ${merged} items`,
          detail: `${actions.length} groupes traites, ${deleted} supprimes, ${relationsMigrated} relations migrees`,
          level: "info",
        });
      }
    }

    return reply.send({
      dryRun,
      totalGroups: actions.length,
      itemsMerged: merged,
      itemsDeleted: deleted,
      relationsMigrated,
      actions,
    });
  });

  // ─────────────────────────────────────────────────
  // POST /admin/sanitize-platforms — cleanup invalid platforms
  //   ?dryRun=true (default) — simulation, no changes
  //   ?dryRun=false — actually perform the UPDATE
  //
  // Re-applies sanitizePlatform() to every existing row.
  // Replaces invalid values (Unknown, studio names, etc.) with NULL.
  // ─────────────────────────────────────────────────
  app.post("/admin/sanitize-platforms", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const querySchema = z.object({
      type: z.enum(["anime", "game", "all"]).default("all"),
      dryRun: z.enum(["true", "false"]).default("true"),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const { type } = parsed.data;
    const dryRun = parsed.data.dryRun !== "false";

    const tables: Array<{ name: string; kind: "anime" | "game" }> = [];
    if (type === "anime" || type === "all") tables.push({ name: "anime_items", kind: "anime" });
    if (type === "game" || type === "all") tables.push({ name: "game_items", kind: "game" });

    const summary: any[] = [];
    let totalUpdated = 0;
    let totalNullified = 0;
    let totalCleaned = 0;
    let totalUnchanged = 0;

    for (const { name: table, kind } of tables) {
      const rows: any = await pool.query(
        `SELECT CAST(id AS UNSIGNED) AS id, platform FROM ${table} WHERE platform IS NOT NULL`
      );

      const changes: any[] = [];
      for (const row of rows) {
        const sanitized = sanitizePlatform(row.platform);
        if (sanitized === row.platform) continue; // no change

        const change = {
          id: row.id,
          before: row.platform,
          after: sanitized,
          action: sanitized === null ? "nullified" : "cleaned",
        };

        if (!dryRun) {
          await pool.query(
            `UPDATE ${table} SET platform = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [sanitized, row.id]
          );
        }

        changes.push(change);
        if (change.action === "nullified") totalNullified++;
        else totalCleaned++;
        totalUpdated++;
      }

      totalUnchanged += rows.length - changes.length;

      summary.push({
        table,
        kind,
        rowsScanned: rows.length,
        changes: changes.length,
        sample: changes.slice(0, 5),
      });
    }

    if (!dryRun && totalUpdated > 0) {
      clearFeedCache();
    }

    req.log.info(
      { totalUpdated, totalNullified, totalCleaned, dryRun },
      "admin.sanitize-platforms"
    );

    return reply.send({
      dryRun,
      totalUpdated,
      totalNullified,
      totalCleaned,
      totalUnchanged,
      summary,
    });
  });

  // ─────────────────────────────────────────────────
  // ─────────────────────────────────────────────────
  // POST /admin/cleanup-niches — Session 13.3
  // Supprime les games niches deja en DB (memes criteres que filtre au push)
  // Query params : type=game, dryRun=true|false (default true)
  // ─────────────────────────────────────────────────
  app.post("/admin/cleanup-niches", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }
    const query = req.query as any;
    const type = query?.type;
    const dryRun = String(query?.dryRun ?? "true") !== "false";

    if (type !== "game") {
      return reply.code(400).send({ error: "type must be 'game' (anime not supported)" });
    }

    const NICHE_POP_THRESHOLD = 10;
    const NICHE_AGE_DAYS = 30;
    const NICHE_RATING_PROTECTION = 70;

    try {
      const niches: any[] = await pool.query(
        `SELECT id, title, popularity, rating_score, release_date,
                DATEDIFF(CURDATE(), release_date) AS age_days
         FROM game_items
         WHERE release_date <= CURDATE()
           AND release_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND popularity < ?
           AND (rating_score IS NULL OR rating_score < ?)
         ORDER BY popularity ASC, release_date ASC`,
        [NICHE_AGE_DAYS, NICHE_POP_THRESHOLD, NICHE_RATING_PROTECTION]
      );

      const nicheIds = niches.map((n: any) => Number(n.id));

      let affectedFavorites = 0, affectedVotes = 0, affectedNotifs = 0;
      if (nicheIds.length > 0) {
        const favCount: any = await pool.query(
          `SELECT COUNT(*) AS n FROM favorites WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]
        );
        affectedFavorites = Number(favCount[0]?.n || 0);
        const voteCount: any = await pool.query(
          `SELECT COUNT(*) AS n FROM votes WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]
        );
        affectedVotes = Number(voteCount[0]?.n || 0);
        const notifCount: any = await pool.query(
          `SELECT COUNT(*) AS n FROM notification_events WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]
        );
        affectedNotifs = Number(notifCount[0]?.n || 0);
      }

      if (dryRun) {
        return reply.send({
          dryRun: true,
          niches_count: niches.length,
          would_delete: niches.length,
          affected_favorites: affectedFavorites,
          affected_votes: affectedVotes,
          affected_notifs: affectedNotifs,
          sample: niches.slice(0, 10).map((n: any) => ({
            id: Number(n.id), title: n.title, popularity: Number(n.popularity),
            rating_score: n.rating_score == null ? null : Number(n.rating_score),
            release_date: n.release_date, age_days: Number(n.age_days),
          })),
        });
      }

      let deleted = 0;
      if (nicheIds.length > 0) {
        await pool.query(`DELETE FROM favorites WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]);
        await pool.query(`DELETE FROM votes WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]);
        await pool.query(`DELETE FROM user_notifications WHERE event_id IN (SELECT id FROM notification_events WHERE item_type = 'game' AND item_id IN (?))`, [nicheIds]).catch(() => {});
        await pool.query(`DELETE FROM notification_events WHERE item_type = 'game' AND item_id IN (?)`, [nicheIds]);
        const result: any = await pool.query(`DELETE FROM game_items WHERE id IN (?)`, [nicheIds]);
        deleted = Number(result?.affectedRows || nicheIds.length);
        clearFeedCache();
      }

      req.log.info({ deleted, affectedFavorites, affectedVotes, affectedNotifs }, "admin.cleanup-niches");
      return reply.send({
        dryRun: false,
        deleted,
        affected_favorites: affectedFavorites,
        affected_votes: affectedVotes,
        affected_notifs: affectedNotifs,
      });
    } catch (e: any) {
      req.log.error({ err: e?.message }, "cleanup-niches failed");
      return reply.code(500).send({ error: "Internal error", detail: e?.message });
    }
  });

  // GET /admin/feed/stats — diagnostic (admin only)
  // ─────────────────────────────────────────────────
  app.get("/admin/feed/stats", async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.adminApiKey) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== options.adminApiKey) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const now = new Date();
    const wide = buildWideDateFilter(now);
    const window = getReleaseWindow(now);

    const [animeRaw, gamesRaw]: [GameNimeItem[], GameNimeItem[]] = await Promise.all([
      pool.query(SELECT_ANIME, [wide.start, wide.end, MAX_DB_FETCH]),
      pool.query(SELECT_GAMES, [wide.start, wide.end, MAX_DB_FETCH]),
    ]);

    function buildStats(items: GameNimeItem[]) {
      if (items.length === 0) return { count: 0 };
      const scores = items.map((i) => computeGameNimeScore(i, now));
      return {
        count: items.length,
        inWindow: items.filter((i) => i.releaseDate &&
          i.releaseDate >= window.start && i.releaseDate <= window.end).length,
        avgScore: Math.round(scores.reduce((s, n) => s + n, 0) / scores.length),
        topScore: Math.max(...scores),
        bottomScore: Math.min(...scores),
      };
    }

    return reply.send({
      window,
      cache: { entries: feedCache.size },
      anime: buildStats(animeRaw),
      games: buildStats(gamesRaw),
    });
  });
}
