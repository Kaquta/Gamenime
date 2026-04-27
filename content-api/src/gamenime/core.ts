/**
 * GameNime API core: pure scoring & windowing functions.
 *
 * Design (ETAT CLEAN):
 * - All functions are PURE (no side effects, no I/O)
 * - All functions are testable in isolation (no DB, no network)
 * - Constants imported from constants.ts (single source of truth)
 * - Types are strict (no `any`, no implicit casts)
 *
 * Mental model:
 * - The visibility "window" is the year and year+1 calendar range.
 * - Items in the window get a baseline bonus (SCORE_IN_WINDOW).
 * - Outside the window, items decay smoothly (penalty per month).
 * - Freshness (proximity to release) boosts imminent releases.
 * - Popularity is capped to avoid megablockbusters dominating forever.
 *
 * The result is an "eviction score": when the catalog is full, the
 * lowest-scored item makes room for a higher-scored newcomer.
 */

import {
  SCORE_IN_WINDOW,
  POPULARITY_CAP,
  PENALTY_PER_MONTH_OUT_OF_WINDOW,
  FRESHNESS_THRESHOLDS,
  COMPLETENESS_WEIGHTS,
  MISSING_VALUE_SENTINELS,
  VALID_PLATFORMS,
  PLATFORM_ALIASES,
} from "./constants.js";

// ============================================================
// Types
// ============================================================

export type ItemType = "anime" | "game";

export interface GameNimeItem {
  id: number;
  title: string;
  type: ItemType;
  cover?: string | null;
  genre?: string | null;
  platform?: string | null;
  description?: string | null;
  rating?: string | null;
  popularity?: number | null;
  releaseDate?: string | null;   // ISO date "YYYY-MM-DD"
  trailerUrl?: string | null;
  screenshots?: string | null;
  dlcs?: string | null;          // JSON string [{name, releaseDate}] - games only
}

export interface ScoredItem extends GameNimeItem {
  gameNimeScore: number;
}

export interface ReleaseWindow {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

// ============================================================
// Window helpers
// ============================================================

/**
 * Current visibility window: [year-01-01, year+1-12-31].
 *
 * Example: in 2026, the window is [2026-01-01, 2027-12-31].
 *
 * On Jan 1st of next year (2027), the window slides to [2027, 2028]
 * but items from the previous year do NOT get instantly removed —
 * they progressively lose their pertinence score and get evicted
 * naturally as new items arrive (smooth transition).
 */
export function getReleaseWindow(now: Date = new Date()): ReleaseWindow {
  const year = now.getUTCFullYear();
  return {
    start: `${year}-01-01`,
    end: `${year + 1}-12-31`,
  };
}

/**
 * Returns true if the date string falls inside the current window.
 * Returns false for invalid or missing dates.
 */
export function isInReleaseWindow(date?: string | null, now: Date = new Date()): boolean {
  if (!date) return false;

  const { start, end } = getReleaseWindow(now);
  const d = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(d.getTime())) return false;

  return (
    d >= new Date(`${start}T00:00:00Z`) &&
    d <= new Date(`${end}T23:59:59Z`)
  );
}

// ============================================================
// Validation
// ============================================================

/**
 * Returns true when a field should be treated as missing/empty.
 * Catches null, undefined, empty strings, and known sentinel values.
 */
export function isMissing(value?: string | number | null): boolean {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  return MISSING_VALUE_SENTINELS.includes(normalized);
}

/**
 * Normalize a title for duplicate detection.
 *
 * AGGRESSIVE strategy: collapse all non-alphanumeric characters.
 * Combined with date + type matching, this catches transliteration variants:
 *   "Love Live! Hasu no Sora" / "Love Live Hasunosora" → match
 *
 * The (type + normalizedTitle + releaseDate) triplet protects against
 * false positives by requiring an exact date match.
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Compute a "completeness score" for an item — used to decide which
 * version of a duplicate to keep (the one with more filled fields wins).
 */
export function computeFieldCount(item: GameNimeItem): number {
  let count = 0;
  if (!isMissing(item.cover)) count++;
  if (!isMissing(item.genre)) count++;
  if (!isMissing(item.platform)) count++;
  if (!isMissing(item.description)) count++;
  if (!isMissing(item.rating)) count++;
  if (!isMissing(item.trailerUrl)) count++;
  if (!isMissing(item.screenshots)) count++;
  return count;
}

/**
 * Sanitize a platform value against the whitelist + alias map.
 *
 * - Splits comma-separated values
 * - Resolves each part via PLATFORM_ALIASES first (e.g. "PC (Microsoft Windows)" → "PC")
 * - Keeps only canonical values present in VALID_PLATFORMS
 * - Deduplicates (e.g. "Xbox One, Xbox Series X|S" → "Xbox" once)
 * - Returns null when nothing valid remains
 *
 * Used to prevent garbage data (Unknown, studio names) from polluting
 * the platform field while gracefully handling vendor-specific naming.
 *
 * Examples:
 *   "Unknown"                              → null
 *   "A-1 Pictures"                         → null  (studio)
 *   "PC (Microsoft Windows)"               → "PC"
 *   "Xbox Series X|S, Xbox One"            → "Xbox"  (deduplicated)
 *   "PlayStation 5, PC (Microsoft Windows)" → "PlayStation, PC"
 *   "Crunchyroll, A-1 Pictures"            → "Crunchyroll"  (filtered)
 *   "Bilibili"                             → "Bilibili TV"  (alias)
 *   ""                                     → null
 */
export function sanitizePlatform(value: string | null | undefined): string | null {
  if (isMissing(value)) return null;

  const valid = new Set<string>();
  const validList = VALID_PLATFORMS as readonly string[];
  const aliases = PLATFORM_ALIASES as Readonly<Record<string, string>>;

  for (const raw of String(value).split(",")) {
    const part = raw.trim();
    if (!part) continue;

    // Try alias first (e.g. "PC (Microsoft Windows)" → "PC")
    const canonical = aliases[part];
    if (canonical && validList.includes(canonical)) {
      valid.add(canonical);
      continue;
    }

    // Otherwise check if already canonical
    if (validList.includes(part)) {
      valid.add(part);
    }
  }

  if (valid.size === 0) return null;

  // Preserve VALID_PLATFORMS order for stable output
  const ordered = validList.filter((p) => valid.has(p));
  return ordered.join(", ");
}

// ============================================================
// Score components
// ============================================================

/**
 * Bonus for "fiche complete": more data = higher base score.
 * Maximum possible = sum of all weights (currently 52).
 */
export function computeCompletenessScore(item: GameNimeItem): number {
  let score = 0;
  if (!isMissing(item.cover))       score += COMPLETENESS_WEIGHTS.cover;
  if (!isMissing(item.genre))       score += COMPLETENESS_WEIGHTS.genre;
  if (!isMissing(item.platform))    score += COMPLETENESS_WEIGHTS.platform;
  if (!isMissing(item.description)) score += COMPLETENESS_WEIGHTS.description;
  if (!isMissing(item.rating))      score += COMPLETENESS_WEIGHTS.rating;
  if (!isMissing(item.trailerUrl))  score += COMPLETENESS_WEIGHTS.trailer;
  if (!isMissing(item.screenshots)) score += COMPLETENESS_WEIGHTS.screenshots;
  return score;
}

/**
 * Freshness bonus based on release proximity.
 * Imminent releases (next 7 days) get the maximum boost.
 * Recent past releases also get a boost (people just discovered it).
 *
 * Returns 0 for invalid/missing dates or items > 6 months old.
 */
export function computeFreshnessScore(item: GameNimeItem, now: Date = new Date()): number {
  if (!item.releaseDate) return 0;

  const release = new Date(`${item.releaseDate}T00:00:00Z`);
  if (Number.isNaN(release.getTime())) return 0;

  const diffDays = Math.floor((release.getTime() - now.getTime()) / 86400000);
  const t = FRESHNESS_THRESHOLDS;

  // Future releases
  if (diffDays >= 0 && diffDays <= t.IMMINENT_DAYS)             return t.IMMINENT_BONUS;
  if (diffDays > t.IMMINENT_DAYS && diffDays <= t.SOON_DAYS)    return t.SOON_BONUS;
  if (diffDays > t.SOON_DAYS && diffDays <= t.UPCOMING_DAYS)    return t.UPCOMING_BONUS;

  // Past releases (negative diffDays)
  if (diffDays < 0 && diffDays >= -t.JUST_RELEASED_DAYS)        return t.JUST_RELEASED_BONUS;
  if (diffDays < -t.JUST_RELEASED_DAYS && diffDays >= -t.RECENT_DAYS)  return t.RECENT_BONUS;
  if (diffDays < -t.RECENT_DAYS && diffDays >= -t.TIEPID_DAYS)  return t.TIEPID_BONUS;
  if (diffDays < -t.TIEPID_DAYS && diffDays >= -t.COLD_DAYS)    return t.COLD_BONUS;

  return 0;
}

/**
 * Penalty for items that have aged out of the window.
 * Each month outside the window subtracts PENALTY_PER_MONTH_OUT_OF_WINDOW points.
 * Returns 0 (no penalty) for items inside the window or with invalid dates.
 */
export function computeOutOfWindowPenalty(item: GameNimeItem, now: Date = new Date()): number {
  if (!item.releaseDate) return 0;
  if (isInReleaseWindow(item.releaseDate, now)) return 0;

  const release = new Date(`${item.releaseDate}T00:00:00Z`);
  if (Number.isNaN(release.getTime())) return 0;

  const currentYear = now.getUTCFullYear();
  const windowStart = new Date(`${currentYear}-01-01T00:00:00Z`);

  // Pénalité uniquement pour les items du PASSÉ hors fenêtre
  // (vieillissement progressif → éviction naturelle).
  // Pour les items dans le FUTUR lointain, pas de pénalité —
  // ils manquent juste du bonus fenêtre/fraîcheur.
  if (release < windowStart) {
    const diffDays = Math.floor((windowStart.getTime() - release.getTime()) / 86400000);
    const monthsOut = Math.floor(diffDays / 30);
    return monthsOut * PENALTY_PER_MONTH_OUT_OF_WINDOW;
  }

  return 0;
}

// ============================================================
// Final score
// ============================================================

/**
 * Compute the final pertinence score (eviction score).
 *
 * Formula:
 *   + popularity (capped to POPULARITY_CAP)
 *   + SCORE_IN_WINDOW if in window, else 0
 *   + freshness bonus (boosted weights)
 *   + completeness bonus
 *   - out-of-window penalty (smooth decay)
 *
 * The final score determines who stays in the catalog when capacity is reached.
 */
export function computeGameNimeScore(item: GameNimeItem, now: Date = new Date()): number {
  let score = 0;

  // 1. Popularity (capped)
  score += Math.min(Number(item.popularity || 0), POPULARITY_CAP);

  // 2. Window bonus
  if (isInReleaseWindow(item.releaseDate, now)) {
    score += SCORE_IN_WINDOW;
  }

  // 3. Freshness boost
  score += computeFreshnessScore(item, now);

  // 4. Completeness
  score += computeCompletenessScore(item);

  // 5. Out-of-window decay
  score -= computeOutOfWindowPenalty(item, now);

  return score;
}

// ============================================================
// Sorting & top selection
// ============================================================

/**
 * Sort items by score (descending), tie-break by popularity, then by id.
 * Returns the top N items with their gameNimeScore attached.
 *
 * Pure function: doesn't mutate the input array.
 */
export function sortForGameNimeTop(
  items: GameNimeItem[],
  limit: number,
  now: Date = new Date()
): ScoredItem[] {
  return items
    .map((item) => ({
      ...item,
      id: Number(item.id),
      popularity: item.popularity != null ? Number(item.popularity) : null,
      gameNimeScore: Number(computeGameNimeScore(item, now)),
    }))
    .sort((a, b) => {
      if (b.gameNimeScore !== a.gameNimeScore) {
        return b.gameNimeScore - a.gameNimeScore;
      }
      const popDiff = Number(b.popularity || 0) - Number(a.popularity || 0);
      if (popDiff !== 0) return popDiff;
      return a.id - b.id;
    })
    .slice(0, limit);
}
/**
 * Sort items by release date with popularity tie-break.
 * Items with no releaseDate are placed last regardless of direction.
 *
 * @param ascending - if true, soonest date first (good for "A venir");
 *                    if false (default), most recent first (good for "Derniers sortis").
 */
export function sortByDate(
  items: GameNimeItem[],
  limit: number,
  now: Date = new Date(),
  ascending: boolean = false
): ScoredItem[] {
  return items
    .map((item) => ({
      ...item,
      id: Number(item.id),
      popularity: item.popularity != null ? Number(item.popularity) : null,
      gameNimeScore: Number(computeGameNimeScore(item, now)),
    }))
    .sort((a, b) => {
      // 1. Items without date go to the bottom
      if (!a.releaseDate && b.releaseDate) return 1;
      if (a.releaseDate && !b.releaseDate) return -1;
      if (!a.releaseDate && !b.releaseDate) return a.id - b.id;

      // 2. By date - direction depends on ascending param
      if (a.releaseDate !== b.releaseDate) {
        if (ascending) {
          return a.releaseDate! < b.releaseDate! ? -1 : 1;
        }
        return a.releaseDate! < b.releaseDate! ? 1 : -1;
      }

      // 3. Tie-break: popularity, then id (stable)
      const popDiff = Number(b.popularity || 0) - Number(a.popularity || 0);
      if (popDiff !== 0) return popDiff;
      return a.id - b.id;
    })
    .slice(0, limit);
}

