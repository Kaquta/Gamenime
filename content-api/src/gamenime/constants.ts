/**
 * GameNime API constants.
 *
 * All magic numbers and configuration values are centralized here.
 * Change a value here to adjust scoring/capacity globally.
 *
 * Design principle (ETAT CLEAN):
 * - One source of truth per concept
 * - Documented "why" for non-obvious values
 * - Frozen objects to prevent runtime mutation
 *
 * SESSION 10 REFACTOR:
 * - Scoring simplifié à popularity + rating_score (signal social + qualitatif)
 * - Suppression de freshness/completeness/out_of_window/popularity_cap :
 *   le Top 150 doit refléter le mérite pur, pas la fraîcheur ou la complétude.
 * - Capacités explicites : Top 25 homepage, Top 150 catalogues + à venir.
 */

// ============================================================
// Capacity (eviction system)
// ============================================================

/** Max number of anime displayed in /feed/anime endpoints (catalogue Sortis). */
export const CAPACITY_ANIME = 150;

/** Max number of games displayed in /feed/games endpoints (catalogue Sortis). */
export const CAPACITY_GAMES = 150;

/** Max number of upcoming anime displayed in /feed/anime?status=upcoming. */
export const CAPACITY_UPCOMING_ANIME = 150;

/** Max number of upcoming games displayed in /feed/games?status=upcoming. */
export const CAPACITY_UPCOMING_GAMES = 150;

/** Top par catégorie sur la homepage (Top 25 Animés / Top 25 Jeux Vidéo). */
export const CAPACITY_HOME_TOP = 25;

/** "Derniers Sortis" par catégorie sur la homepage (25 anime + 25 jeux). */
export const CAPACITY_HOME_LATEST = 25;

/**
 * Mixed feed (homepage) - DEPRECATED but kept for backward compatibility.
 * Use CAPACITY_HOME_TOP and CAPACITY_HOME_LATEST instead.
 */
export const CAPACITY_HOME = 24;

/** Search results max per type. */
export const SEARCH_LIMIT_PER_TYPE = 30;

// ============================================================
// Database fetch limits
// ============================================================

/**
 * Max rows fetched from DB per query before in-memory scoring.
 * Set high enough to capture relevant items, low enough to bound RAM.
 *
 * SESSION 10: bumped from 500 to 1000 — la DB contient maintenant ~500
 * jeux et ~250 anime, et on veut garder une bonne marge pour le tri.
 */
export const MAX_DB_FETCH = 1000;

/**
 * Wide net for "raisonnablement récent" items.
 * 3 years before/after = catches edge cases for late additions.
 */
export const DB_DATE_RANGE_YEARS = 3;

// ============================================================
// Scoring weights — Session 10 simplification
// ============================================================
//
// La formule de scoring est volontairement minimaliste :
//
//   score(item) = popularity_normalized(item.popularity)
//               + rating_normalized(item.ratingScore)
//
// Pas de bonus fraîcheur, pas de bonus complétude, pas de pénalité hors fenêtre :
//   - La fraîcheur est gérée par l'onglet "Derniers Sortis" (tri par date).
//   - La complétude est garantie par les workflows Complement (IGDB, Jikan).
//   - La fenêtre 2026-2027 est filtrée en SQL (WHERE release_date BETWEEN ...),
//     pas via un bonus de score.
//
// Conséquence ETAT CLEAN : un item ne sort du Top 150 que s'il est dépassé
// en mérite (popularité ou note), jamais par ringardisation temporelle.
//
// ============================================================

/**
 * Multiplicateur logarithmique pour normaliser la popularité.
 *
 * Formule : Math.log10(popularity + 1) * POPULARITY_LOG_MULTIPLIER
 *   pop=10      → 209
 *   pop=100     → 402
 *   pop=1000    → 600
 *   pop=10000   → 800
 *   pop=100000  → 1000
 *
 * Le log empêche les blockbusters d'écraser linéairement les autres items
 * tout en préservant une vraie hiérarchie. Pas de cap dur (contrairement
 * à l'ancien POPULARITY_CAP=200 qui aplatissait tous les top tier).
 */
export const POPULARITY_LOG_MULTIPLIER = 200;

/**
 * Multiplicateur du rating qualitatif (0-100) pour le score final.
 *
 * Formule : (ratingScore / 100) * RATING_SCORE_MULTIPLIER
 *   rating=60  → 300
 *   rating=80  → 400
 *   rating=95  → 475
 *
 * Choix de 500 : un item bien noté (95/100) gagne 475 points, ce qui
 * correspond environ à 100k+ de popularité. Donc qualité ≈ popularité,
 * mais aucun ne domine totalement l'autre.
 */
export const RATING_SCORE_MULTIPLIER = 500;

// ============================================================
// Cache
// ============================================================

/** Feed endpoint cache TTL (ms). 5 minutes is a good balance. */
export const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================
// Validation
// ============================================================

/** Strings that mean "missing data" even when the field is non-null. */
export const MISSING_VALUE_SENTINELS = Object.freeze(["", "unknown", "null", "[]", "none", "n/a"]);

// ============================================================
// Platform validation (whitelist)
// ============================================================

/**
 * Canonical list of valid platforms.
 * Any value not in this list (and not in PLATFORM_ALIASES) is sanitized to null.
 *
 * Names are kept short and user-friendly. Workflow data with longer names
 * (e.g. "PC (Microsoft Windows)") is normalized via PLATFORM_ALIASES.
 */
export const VALID_PLATFORMS = Object.freeze([
  // Streaming anime
  "Crunchyroll",
  "Netflix",
  "YouTube",
  "Bilibili TV",
  "Tencent Video",
  "iQ",
  "Amazon Prime Video",
  "HIDIVE",
  "Disney+",
  "Hulu",
  "Wakanim",
  "ADN",
  "Funimation",
  // Gaming - canonical short forms
  "PC",
  "PlayStation",
  "Xbox",
  "Nintendo",
  "Apple Macintosh",
  "Linux",
  "iOS",
  "Android",
  "Web",
  "Steam",
  "Epic Games",
  // Gaming - raw versions kept for modal detail
  // (PC is the only one we always alias to short form because
  //  "PC (Microsoft Windows)" looks bad in detail too)
  "PlayStation 5",
  "PlayStation 4",
  "PlayStation 3",
  "Xbox Series X|S",
  "Xbox One",
  "Xbox 360",
  "Nintendo Switch 2",
  "Nintendo Switch",
  "Nintendo 3DS",
  "Nintendo DS",
]);

/**
 * Map raw platform variants (from upstream APIs) to their canonical form.
 *
 * IGDB and similar APIs use long, version-specific names — we collapse
 * them to a generic platform family so the UI stays clean.
 *
 * Examples:
 *   "PC (Microsoft Windows)"  → "PC"
 *   "Xbox Series X|S"         → "Xbox"
 *   "PlayStation 5"           → "PlayStation"
 *   "Nintendo Switch"         → "Nintendo"
 *   "Disney Plus"             → "Disney+"
 *   "Prime Video"             → "Amazon Prime Video"
 *   "iQIYI"                   → "iQ"
 *   "Bilibili"                → "Bilibili TV"
 */
export const PLATFORM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // PC: always alias to short form (long form looks bad in modal detail too)
  "PC (Microsoft Windows)": "PC",
  // Streaming aliases (real renames, not version collapsing)
  "Bilibili": "Bilibili TV",
  "Disney Plus": "Disney+",
  "Prime Video": "Amazon Prime Video",
  "iQIYI": "iQ",
  // NOTE: Xbox/PlayStation/Nintendo versions are kept as-is in DB.
  // The frontend simplifyPlatform() collapses them on cards for compact display,
  // while the modal shows the full version for detail.
});

// ════════════════════════════════════════════════════════════════
// NICHE FILTERING — Session 13.3
// Critères pour rejeter les niches games au push ET cleanup DB
// ════════════════════════════════════════════════════════════════
// Un game est considéré "niche à rejeter" si TOUS ces critères sont vrais :
//   - popularity < NICHE_POPULARITY_THRESHOLD
//   - release_date < (today - NICHE_AGE_DAYS days)
//   - rating_score IS NULL OU < NICHE_RATING_PROTECTION (préserve cult favorites)
// Une fois ces 3 critères réunis : l'item est dégagé (push refusé OU cleanup applicable).

export const NICHE_POPULARITY_THRESHOLD = 10;
export const NICHE_AGE_DAYS = 30;
export const NICHE_RATING_PROTECTION = 70; // un game noté >= 70 reste même si peu populaire
