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
 */

// ============================================================
// Capacity (eviction system)
// ============================================================

/** Max number of anime displayed in /feed/anime endpoints. */
export const CAPACITY_ANIME = 150;

/** Max number of games displayed in /feed/games endpoints. */
export const CAPACITY_GAMES = 150;

/** Mixed feed (homepage) - top items across both types. */
export const CAPACITY_HOME = 24;

/** Search results max per type. */
export const SEARCH_LIMIT_PER_TYPE = 30;

// ============================================================
// Database fetch limits
// ============================================================

/**
 * Max rows fetched from DB per query before in-memory scoring.
 * Set high enough to capture relevant items, low enough to bound RAM.
 */
export const MAX_DB_FETCH = 500;

/**
 * Wide net for "raisonnablement récent" items.
 * 3 years before/after = catches edge cases for late additions.
 */
export const DB_DATE_RANGE_YEARS = 3;

// ============================================================
// Scoring weights
// ============================================================

/** Bonus when item is in the current visibility window (year, year+1). */
export const SCORE_IN_WINDOW = 100;

/** Popularity cap — prevents megablockbusters from crushing newer items. */
export const POPULARITY_CAP = 200;

/**
 * Penalty per month outside the window.
 * Older items lose pertinence progressively (smooth eviction).
 */
export const PENALTY_PER_MONTH_OUT_OF_WINDOW = 5;

// ============================================================
// Freshness scoring (boosted weights — "Nouveauté > Popularité")
// ============================================================

/**
 * Freshness bonus by release proximity.
 * Imminent releases (next 7 days) get the biggest boost.
 */
export const FRESHNESS_THRESHOLDS = Object.freeze({
  IMMINENT_BONUS: 80,        // J0 → J+7
  IMMINENT_DAYS: 7,
  SOON_BONUS: 60,            // J+8 → J+30
  SOON_DAYS: 30,
  UPCOMING_BONUS: 35,        // J+31 → J+90
  UPCOMING_DAYS: 90,
  JUST_RELEASED_BONUS: 50,   // J-1 → J-7 (sortie cette semaine)
  JUST_RELEASED_DAYS: 7,
  RECENT_BONUS: 35,          // J-8 → J-30
  RECENT_DAYS: 30,
  TIEPID_BONUS: 18,          // J-31 → J-90
  TIEPID_DAYS: 90,
  COLD_BONUS: 8,             // J-91 → J-180
  COLD_DAYS: 180,
});

// ============================================================
// Completeness scoring
// ============================================================

/**
 * Per-field bonus for "fiche complete" (item with rich data ranks higher).
 */
export const COMPLETENESS_WEIGHTS = Object.freeze({
  cover: 8,
  genre: 6,
  platform: 10,
  description: 8,
  rating: 4,
  trailer: 12,
  screenshots: 4,
});

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
  // Gaming
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
  // PC variants
  "PC (Microsoft Windows)": "PC",
  // Xbox variants
  "Xbox Series X|S": "Xbox",
  "Xbox One": "Xbox",
  "Xbox 360": "Xbox",
  // PlayStation variants
  "PlayStation 5": "PlayStation",
  "PlayStation 4": "PlayStation",
  "PlayStation 3": "PlayStation",
  // Nintendo variants
  "Nintendo Switch 2": "Nintendo",
  "Nintendo Switch": "Nintendo",
  "Nintendo 3DS": "Nintendo",
  "Nintendo DS": "Nintendo",
  // Streaming aliases
  "Bilibili": "Bilibili TV",
  "Disney Plus": "Disney+",
  "Prime Video": "Amazon Prime Video",
  "iQIYI": "iQ",
});
