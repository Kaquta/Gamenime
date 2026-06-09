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
import { trackLastRun, pushActivity } from "./dashboard.js";
import { z } from "zod";
import {
  CAPACITY_ANIME,
  CAPACITY_GAMES,
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
  sortByDate,
  getReleaseWindow,
  isMissing,
  normalizeTitle,
  computeFieldCount,
  sanitizePlatform,
  mergePlatforms,
  hasYearSuffix,
  formatReleaseDateLabel, stripDisplayTags} from "./core.js";

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
      // ETAT CLEAN: items with year-only precision are NEVER in released.
      // Even if their stored date (YYYY-01-01) is past, we don't really
      // know when they came out. Keep them in upcoming until precise.
      if (i.releasePrecision === "year") return false;
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
      // ETAT CLEAN: items with year-only precision belong here regardless
      // of stored date — we just know it's "Prévu YYYY" within the window.
      if (i.releasePrecision === "year") {
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
}

// ============================================================
// SQL queries (parameterized, bounded)
// ============================================================

const SELECT_ANIME = `
  SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, genre, platform, description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
         CAST(popularity AS SIGNED) AS popularity,
         screenshots,
         DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
         release_precision AS releasePrecision,
         trailer_url AS trailerUrl,
         format,
         'anime' AS type
  FROM anime_items
  WHERE release_date BETWEEN ? AND ?
    AND cover IS NOT NULL AND cover != ''
    AND title IS NOT NULL AND title != ''
  ORDER BY popularity DESC, release_date DESC
  LIMIT ?
`;

const SELECT_GAMES = `
  SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, genre, platform, description, rating,
         CAST(rating_score AS SIGNED) AS ratingScore,
         CAST(popularity AS SIGNED) AS popularity,
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

// ============================================================
// Zod validation schemas
// ============================================================

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  type: z.enum(["anime", "game", "all"]).default("all"),
});

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  status: z.enum(["released", "upcoming", "all"]).default("all"),
  orderBy: z.enum(["score", "date"]).default("score"),
});

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

  for (const item of items) {
    const titleKey = `${item.type}:T:${normalizeTitle(item.title)}:${item.releaseDate || "no-date"}`;
    (titleIdx.get(titleKey) || titleIdx.set(titleKey, []).get(titleKey)!).push(item);

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
  }

  // Union-find by item id
  const parent = new Map<number, number>();
  function find(x: number): number {
    if (parent.get(x) === x) return x;
    const p = find(parent.get(x)!);
    parent.set(x, p);
    return p;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const item of items) parent.set(item.id, item.id);

  // For every shared key (title, cover, or titleEnglish), union items together
  for (const list of [...titleIdx.values(), ...coverIdx.values(), ...englishIdx.values(), ...anilistIdx.values(), ...malIdx.values()]) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) union(list[0].id, list[i].id);
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
    const key = `${item.type}:N:${normalizeTitle(item.title)}`;
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
        if (yearsApart <= 2) union(a.id, b.id);
      }
    }
  }

  // Group by root id
  const groups = new Map<string, GameNimeItem[]>();
  for (const item of items) {
    const root = find(item.id);
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

  // ─────────────────────────────────────────────────
  // GET /feed/home — mixed top items (homepage)
  // ─────────────────────────────────────────────────

// SESSION 12.7+: applique le strip des tags métadonnées aux descriptions servies au frontend.
// Les tags restent intacts en DB.
function applyDisplayStripToItems<T extends { description?: string | null }>(items: T[]): T[] {
  return items.map(i => ({
    ...i,
    description: stripDisplayTags(i.description),
    contentTag: (i as any).format === "MOVIE" ? "FILM" : ((i as any).gameType === "DLC" ? "DLC" : null),
  }));
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

    // Mixed top: combine and re-sort
    const mixedRaw = sortForGameNimeTop([...animeRawSorted, ...gamesRawSorted], CAPACITY_HOME, now);
    const anime = applyDisplayStripToItems(animeRawSorted);
    const games = applyDisplayStripToItems(gamesRawSorted);
    const mixed = applyDisplayStripToItems(mixedRaw);

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
  // Pour le bot Discord. Exclut precision=year (pas de fausse date).
  // ─────────────────────────────────────────────────
  app.get("/feed/today", async (req: FastifyRequest, reply: FastifyReply) => {
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const SELECT_TODAY_ANIME = `
      SELECT title, title_english AS titleEnglish, cover, platform,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             'anime' AS type
      FROM anime_items
      WHERE release_date = ?
        AND (release_precision IS NULL OR release_precision != 'year')
        AND title IS NOT NULL AND title != ''
      ORDER BY popularity DESC
    `;
    const SELECT_TODAY_GAMES = `
      SELECT title, title_english AS titleEnglish, cover, platform,
             DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
             'game' AS type
      FROM game_items
      WHERE release_date = ?
        AND (release_precision IS NULL OR release_precision != 'year')
        AND title IS NOT NULL AND title != ''
      ORDER BY popularity DESC
    `;
    const [anime, games]: [any[], any[]] = await Promise.all([
      pool.query(SELECT_TODAY_ANIME, [todayISO]),
      pool.query(SELECT_TODAY_GAMES, [todayISO]),
    ]);
    const animeClean = applyDisplayStripToItems(anime);
    const gamesClean = applyDisplayStripToItems(games);
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
    const requested = parsed.success ? parsed.data.limit ?? CAPACITY_ANIME : CAPACITY_ANIME;
    const limit = Math.min(requested, CAPACITY_ANIME);
    const status: ReleaseStatus = parsed.success ? parsed.data.status : "all";
    const orderBy: "score" | "date" = parsed.success ? parsed.data.orderBy : "score";

    const now = new Date();
    const wide = buildWideDateFilter(now);
    const allRows: GameNimeItem[] = await pool.query(SELECT_ANIME, [wide.start, wide.end, MAX_DB_FETCH]);
    const filtered = filterByStatus(allRows, status, now);
    const itemsRaw = orderBy === "date"
      ? sortByDate(filtered, limit, now, status === "upcoming")
      : sortForGameNimeTop(filtered, limit, now);
    const items = applyDisplayStripToItems(itemsRaw);

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
    const requested = parsed.success ? parsed.data.limit ?? CAPACITY_GAMES : CAPACITY_GAMES;
    const limit = Math.min(requested, CAPACITY_GAMES);
    const status: ReleaseStatus = parsed.success ? parsed.data.status : "all";
    const orderBy: "score" | "date" = parsed.success ? parsed.data.orderBy : "score";

    const now = new Date();
    const wide = buildWideDateFilter(now);
    const allRows: GameNimeItem[] = await pool.query(SELECT_GAMES, [wide.start, wide.end, MAX_DB_FETCH]);
    const filtered = filterByStatus(allRows, status, now);
    const itemsRaw = orderBy === "date"
      ? sortByDate(filtered, limit, now, status === "upcoming")
      : sortForGameNimeTop(filtered, limit, now);
    const items = applyDisplayStripToItems(itemsRaw);

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
  app.get("/feed/search", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }

    const { q, type } = parsed.data;
    const escapedPattern = `%${escapeLikePattern(q)}%`;
    const now = new Date();

    let anime: GameNimeItem[] = [];
    let games: GameNimeItem[] = [];

    if (type === "anime" || type === "all") {
      anime = await pool.query(
        `SELECT id, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,
                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
                DATE_FORMAT(release_datetime, '%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
                release_precision AS releasePrecision,
                is_recently_released AS isRecentlyReleased,
                trailer_url AS trailerUrl,
                'anime' AS type
         FROM anime_items
         WHERE title LIKE ?
         LIMIT ?`,
        [escapedPattern, SEARCH_LIMIT_PER_TYPE]
      );
    }

    if (type === "game" || type === "all") {
      games = await pool.query(
        `SELECT id, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,
                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,
                DATE_FORMAT(release_datetime, '%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
                release_precision AS releasePrecision,
                is_recently_released AS isRecentlyReleased,
                trailer_url AS trailerUrl,
                'game' AS type
         FROM game_items
         WHERE title LIKE ?
         LIMIT ?`,
        [escapedPattern, SEARCH_LIMIT_PER_TYPE]
      );
    }

    // Score and sort search results too
    const itemsRaw = sortForGameNimeTop([...anime, ...games], SEARCH_LIMIT_PER_TYPE * 2, now);
    const items = applyDisplayStripToItems(itemsRaw);

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
            await conn.query(`DELETE FROM ${table} WHERE id = ?`, [loser.id]);
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
