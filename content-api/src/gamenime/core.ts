/**
 * GameNime API core: pure scoring & windowing functions.
 *
 * Design (ETAT CLEAN):
 * - All functions are PURE (no side effects, no I/O)
 * - All functions are testable in isolation (no DB, no network)
 * - Constants imported from constants.ts (single source of truth)
 * - Types are strict (no `any`, no implicit casts)
 *
 * Mental model (session 10 refactor):
 * - The visibility "window" is the year and year+1 calendar range,
 *   used by SQL filters and date helpers (NOT in scoring anymore).
 * - The Top 150 score is pure mérite : popularity + rating qualitatif.
 * - Freshness is handled by the "Derniers Sortis" tab (sortByDate).
 * - Completeness is guaranteed by the Complement workflows (IGDB, Jikan).
 *
 * Scoring formula:
 *   score = popularityNormalized(popularity)   // log-scaled, 0 → 1000+
 *         + ratingNormalized(ratingScore)      // linear 0-100 → 0-500
 *
 * Conséquence ETAT CLEAN : un item ne sort du Top 150 que s'il est
 * dépassé en mérite (popularité ou note), jamais par ringardisation
 * temporelle.
 */

import {
  POPULARITY_LOG_MULTIPLIER,
  RATING_SCORE_MULTIPLIER,
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
  /**
   * Titre anglais pour l'affichage utilisateur (session 10).
   * Le champ `title` reste le romaji (clé d'identification stable).
   * Frontend : displayTitle = titleEnglish ?? title.
   */
  titleEnglish?: string | null;
  type: ItemType;
  cover?: string | null;
  genre?: string | null;
  platform?: string | null;
  description?: string | null;
  rating?: string | null;
  /**
   * Note qualitative 0-100 normalisée par les workflows (session 10).
   * Distincte de `popularity` (signal social, nb fans/votes/userCount).
   * NULL = inconnu → contribue 0 au score (graceful degradation).
   */
  ratingScore?: number | null;
  popularity?: number | null;
  releaseDate?: string | null;          // ISO date "YYYY-MM-DD"
  releasePrecision?: ReleasePrecision | null;
  trailerUrl?: string | null;
  screenshots?: string | null;
  dlcs?: string | null;          // JSON string [{name, releaseDate}] - games only
}

export interface ScoredItem extends GameNimeItem {
  gameNimeScore: number;
  releaseDateLabel: string;
}

export interface ReleaseWindow {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

/**
 * Precision of an item's release date.
 * - "day"   : full date known (e.g. "2026-05-15")
 * - "month" : only month known (e.g. "May 2026", stored as "2026-05-01")
 * - "year"  : only year known (e.g. "2026", stored as "2026-01-01")
 */
export type ReleasePrecision = "day" | "month" | "year";

// ============================================================
// Window helpers
// ============================================================

/**
 * Current visibility window: [year-01-01, year+1-12-31].
 *
 * Example: in 2026, the window is [2026-01-01, 2027-12-31].
 *
 * On Jan 1st of next year (2027), the window slides to [2027, 2028].
 * The window is used for SQL filtering (WHERE release_date BETWEEN ...)
 * and date display logic — NOT for scoring (session 10 refactor).
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
 * Also strips trailing "(YYYY)" patterns commonly added by RAWG as
 * placeholders (e.g. "Mixtape (2025)" -> same as "Mixtape").
 *
 * Combined with date + type matching, this catches:
 *   - transliteration variants: "Love Live Hasu no Sora" / "Love Live Hasunosora"
 *   - RAWG year placeholders: "Mixtape" / "Mixtape (2025)"
 *
 * The (type + normalizedTitle + releaseDate) triplet protects against
 * false positives by requiring an exact date match.
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";

  // ── SESSION 11 ETAT CLEAN : pré-normalisation des saisons/cours ──
  // GameNime API gère NATIVEMENT les variantes cross-source de saisons.
  // Garantit que "4th Season" / "Season 4" / "S4" / "IV" / " 4" trailing matchent tous "_s4".
  // Étend le critère 2 (normalizedTitle + date) du système anti-doublon.
  //
  // GARDES-FOUS contre faux positifs :
  // 1. Chiffres trailing limités à 1-12 (les saisons au-delà n'existent pas en pratique)
  // 2. Chiffres romains limités à I-VI (≤ 6 saisons en romain)
  // 3. Le strip (YYYY) trailing reste appliqué AVANT pour ne pas matcher l'année
  // 4. Les arcs nommés (ex: "Ougonkyou-hen") restent distincts (sémantique humaine)
  const romanMap: Record<string, string> = {
    I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6",
  };

  const preNorm = title
    // Strip "(YYYY)" trailing AVANT tout (sinon le 4 de 2024 serait pris pour saison 4)
    .replace(/\s*\(\d{4}\)\s*$/, "")
    // "4th/1st/2nd/3rd Season" → "_s4"
    .replace(/\s+(\d{1,2})(?:st|nd|rd|th)\s+season\b/gi, " _s$1")
    // "Season 4" → "_s4"
    .replace(/\s+season\s+(\d{1,2})\b/gi, " _s$1")
    // "Saison 4" → "_s4" (FR)
    .replace(/\s+saison\s+(\d{1,2})\b/gi, " _s$1")
    // " S4" (espace + S + chiffre 1-2 digits) → "_s4"
    .replace(/\s+s(\d{1,2})\b/gi, " _s$1")
    // Chiffres romains I-VI trailing → "_s2" etc.
    .replace(/\s+(VI|V|IV|III|II|I)\s*$/g, function(_, r: string) {
      return " _s" + (romanMap[r] || "");
    })
    // Chiffre trailing seul (1-12) → "_s4"
    // ⚠️ Limité à 1-12 pour éviter "Final Fantasy 7" / "Made in Abyss 2026"
    .replace(/\s+(\d{1,2})\s*$/g, function(_, n: string) {
      const num = parseInt(n, 10);
      return num >= 1 && num <= 12 ? " _s" + n : " " + n;
    })
    // "2nd/1st Cour" or "Part 2" → "_c2"
    .replace(/\s+(\d{1,2})(?:st|nd|rd|th)\s+(?:cour|part)\b/gi, " _c$1")
    .replace(/\s+(?:cour|part)\s+(\d{1,2})\b/gi, " _c$1");

  return preNorm
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/[^a-z0-9_]/g, "");           // garde le _ pour préserver _s4/_c2
}

/**
 * Detect if a title contains a trailing year placeholder like "(2025)".
 * Used as one of the asymmetry signals for duplicate detection.
 */
export function hasYearSuffix(title: string | null | undefined): boolean {
  if (!title) return false;
  return /\s*\(\d{4}\)\s*$/.test(title);
}

/**
 * Compute a "completeness count" for an item — used to decide which
 * version of a duplicate to keep (the one with more filled fields wins).
 *
 * Note: this is distinct from any scoring concept. It's purely a
 * tie-breaker for duplicate merge logic.
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

/**
 * Merge two platform values into one canonical, deduplicated list.
 *
 * Combines all valid platforms from both inputs (after sanitization)
 * and returns them in VALID_PLATFORMS order. Used during duplicate
 * merge to never lose a valid platform when fusing two items.
 *
 * Examples:
 *   mergePlatforms("PC", "PC, PlayStation, Xbox")
 *     -> "PC, PlayStation, Xbox"
 *
 *   mergePlatforms("PC, Nintendo Switch 2", "PlayStation 5")
 *     -> "PC, PlayStation 5, Nintendo Switch 2"
 *
 *   mergePlatforms(null, "PC, Xbox")
 *     -> "PC, Xbox"
 *
 *   mergePlatforms("Unknown", "A-1 Pictures")
 *     -> null (both invalid)
 */
/**
 * Constantes pour la sanitization de release_datetime (session 12).
 *
 * Sémantique Option C validée Rey :
 *   - release_date = sortie globale de la saison/série
 *   - release_datetime = prochain épisode programmé OU première diffusion imminente
 *
 * Fenêtre de validité : release_date doit être dans [now - 30j, now + 7j].
 *   - Anime sorti depuis ≤ 30j → en cours de diffusion, datetime du prochain ep ✅
 *   - Anime qui sort dans ≤ 7j → première diffusion imminente ✅
 *   - Hors fenêtre → datetime probablement issu d'une saison différente, on rejette
 */
export const RELEASE_DATETIME_WINDOW_PAST_DAYS = 30;
export const RELEASE_DATETIME_WINDOW_FUTURE_DAYS = 7;

/**
 * Format MariaDB datetime accepté : "YYYY-MM-DD HH:MM:SS" ou ISO "YYYY-MM-DDTHH:MM:SS".
 */
const RELEASE_DATETIME_FORMAT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** Sentinel AnimeSchedule "0001-01-01..." = absence de donnée → null. */
const SENTINEL_DATE_PREFIX = "0001-01-01";

/**
 * Valide et nettoie un releaseDatetime selon 3 critères :
 *
 *   1. FORMAT       — string MariaDB ou ISO. Sentinel "0001-01-01..." → null.
 *   2. PARSING      — la string doit représenter une date JS valide.
 *   3. COHÉRENCE    — releaseDate doit être dans [now-30j, now+7j].
 *                     Évite les datetime polluants (résidus jpnTime de saisons précédentes).
 *
 * Retourne le datetime sanitizé (string MariaDB UTC) ou null si invalide.
 *
 * ETAT CLEAN session 12 : la règle de cohérence vit ICI, source unique de vérité.
 *
 * @example
 *   sanitizeReleaseDatetime("2026-04-04", "2026-04-04 09:25:00")  → "2026-04-04 09:25:00"
 *   sanitizeReleaseDatetime("2026-10-04", "2026-03-28 07:30:00")  → null (résidu)
 *   sanitizeReleaseDatetime("2026-04-04", "0001-01-01T00:00:00Z") → null (sentinel)
 */
export function sanitizeReleaseDatetime(
  releaseDate: string | null | undefined,
  releaseDatetime: string | null | undefined,
  now: Date = new Date()
): string | null {
  if (!releaseDate || !releaseDatetime) return null;
  if (typeof releaseDatetime !== "string") return null;
  if (releaseDatetime.startsWith(SENTINEL_DATE_PREFIX)) return null;
  if (!RELEASE_DATETIME_FORMAT_RE.test(releaseDatetime)) return null;

  const isoForParse = releaseDatetime.includes("T")
    ? releaseDatetime
    : releaseDatetime.replace(" ", "T") + "Z";
  const dtMs = new Date(isoForParse).getTime();
  if (Number.isNaN(dtMs)) return null;

  const rdMs = new Date(releaseDate + "T00:00:00Z").getTime();
  if (Number.isNaN(rdMs)) return null;

  const nowMs = now.getTime();
  const deltaDays = (rdMs - nowMs) / 86400000;
  if (
    deltaDays < -RELEASE_DATETIME_WINDOW_PAST_DAYS ||
    deltaDays > RELEASE_DATETIME_WINDOW_FUTURE_DAYS
  ) {
    return null;
  }

  const d = new Date(dtMs);
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    pad2(d.getUTCMonth() + 1) +
    "-" +
    pad2(d.getUTCDate()) +
    " " +
    pad2(d.getUTCHours()) +
    ":" +
    pad2(d.getUTCMinutes()) +
    ":" +
    pad2(d.getUTCSeconds())
  );
}

/**
 * Constants pour isLikelyJapaneseAnime (session 12.5).
 *
 * Stratégie : détecter les ÉCRITURES non-japonaises (hangul coréen, hanzi
 * chinois avec tons pinyin) dans les titres natifs envoyés par les workflows.
 *
 * Le titre natif (titleNative) est un champ optionnel envoyé par les workflows :
 *   - AniList : item.title.native
 *   - Jikan   : item.title_japanese (mal nommé : peut contenir du hangul KR)
 *   - AnimeSchedule : item.names.native
 *
 * On ne stocke PAS titleNative en DB (juste utilisé pour la décision d'admission).
 */

// Hiragana \u3040-\u309F + Katakana \u30A0-\u30FF = JP confirmé à 99%
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;

// Hangul (Coréen) \uAC00-\uD7AF + Hangul Jamo \u1100-\u11FF
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF]/;

// Pinyin avec tons (mā má mǎ mà ...) = signal fort de chinois romanisé
const PINYIN_TONES_RE = /[ǎěǐǒǔǍĚǏǑǓ]/;  // SESSION 12.5b : caron uniquement (ton 3 pinyin), évite faux positifs Pokémon/Tokyo/Café

/**
 * Décide si un item est probablement un anime japonais (vs donghua KR/CN).
 *
 * Stratégie en passes (échec rapide sur signaux forts négatifs) :
 *   1. NÉGATIF FORT — hangul détecté → KR rejet
 *   2. NÉGATIF FORT — pinyin avec tons → CN rejet
 *   3. POSITIF — kana détecté → JP confirmé
 *   4. PAR DÉFAUT — laisser passer (cas titres romaji JP : "Naruto", "Bleach")
 *
 * Source unique de vérité : workflows poussent BRUT (avec titleNative), API tranche.
 */
export function isLikelyJapaneseAnime(item: {
  title?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
}): { likely: boolean; reason: string } {
  const all =
    (item.title || "") + " " +
    (item.titleEnglish || "") + " " +
    (item.titleNative || "");

  if (HANGUL_RE.test(all)) return { likely: false, reason: "hangul_detected" };
  if (PINYIN_TONES_RE.test(all)) return { likely: false, reason: "pinyin_tones" };
  if (KANA_RE.test(all)) return { likely: true, reason: "kana_detected" };
  return { likely: true, reason: "default_jp" };
}

/**
 * Normalize un titre pour matching cross-source robuste (session 12.5).
 *
 * Différences vs normalizeTitle() :
 *   - TOKEN-SET SORT : ordre des mots indifférent
 *     "Steel Ball Run: JoJo no Kimyou na Bouken"
 *     ≡ "JoJo no Kimyou na Bouken: Steel Ball Run"
 *
 *   - L↔R UNIFICATION : transcription coréenne (ㄹ → L ou R selon système)
 *     "Cheongchun Blossom: Uliui Bom" ≡ "Cheongchun Blossom: Uriui Bom"
 *
 *   - SUFFIXES SAISON ÉLARGIS : ajoute "STAGE" / "PHASE" / "ARC"
 *     "1st STAGE" / "Stage 1" / "Phase 1" → tous matchent "_s1"
 *
 * Garde les garde-fous de normalizeTitle() :
 *   - Strip "(YYYY)" trailing avant tout
 *   - Chiffres trailing limités à 1-12
 *   - Romains limités à I-VI
 */
// Tokens modifiers à ignorer dans le hash (Movie, Special, OVA, etc.)
// Évite que "X Movie" et "X" soient considérés différents.
// Les saisons numérotées sont déjà gérées séparément via _s1, _s2, etc.
const MODIFIER_TOKENS_STRICT = new Set([
  "movie", "special", "ova", "ona", "recap", "compilation",
  "summary", "tv", "short", "pv", "pilot"
]);

export function normalizeTitleStrict(title: string | null | undefined): string {
  if (!title) return "";

  let s = title;

  // 1. Strip "(YYYY)" trailing
  // SESSION 13+: convertir "Zero" trailing en "0" (Phantom Blade Zero == Phantom Blade 0)
  s = s.replace(/\s+zero\s*$/i, " 0");
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");

  // 2. Extract saison/cour comme suffixes séparés
  let seasonSuffix = "";
  let courSuffix = "";

  const romanMap: Record<string, string> = {
    I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6",
  };

  const seasonPatterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, (m) => m[1]],
    [/\bseason\s+(\d{1,2})\b/i, (m) => m[1]],
    [/\bsaison\s+(\d{1,2})\b/i, (m) => m[1]],
    [/\b(\d{1,2})(?:st|nd|rd|th)\s+stage\b/i, (m) => m[1]],
    [/\bstage\s+(\d{1,2})\b/i, (m) => m[1]],
    [/\b(\d{1,2})(?:st|nd|rd|th)\s+phase\b/i, (m) => m[1]],
    [/\b(\d{1,2})(?:st|nd|rd|th)\s+arc\b/i, (m) => m[1]],
    [/\bs(\d{1,2})\b/i, (m) => m[1]],
  ];

  for (const [pat, extract] of seasonPatterns) {
    const m = s.match(pat);
    if (m) {
      seasonSuffix = "_s" + extract(m);
      s = s.replace(pat, " ");
      break;
    }
  }

  if (!seasonSuffix) {
    const romanMatch = s.match(/\s+(VI|V|IV|III|II|I)\s*$/);
    if (romanMatch && romanMap[romanMatch[1]]) {
      seasonSuffix = "_s" + romanMap[romanMatch[1]];
      s = s.replace(/\s+(VI|V|IV|III|II|I)\s*$/, "");
    }
  }

  if (!seasonSuffix) {
    const numMatch = s.match(/\s+(\d{1,2})\s*$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num >= 1 && num <= 12) {
        seasonSuffix = "_s" + numMatch[1];
        s = s.replace(/\s+\d{1,2}\s*$/, "");
      }
    }
  }

  const courPatterns: RegExp[] = [
    /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:cour|part)\b/i,
    /\b(?:cour|part)\s+(\d{1,2})\b/i,
  ];
  for (const pat of courPatterns) {
    const m = s.match(pat);
    if (m) {
      courSuffix = "_c" + m[1];
      s = s.replace(pat, " ");
      break;
    }
  }

  // 3. Lowercase + strip diacritics
  s = s.toLowerCase()
       .normalize("NFD")
       .replace(/[\u0300-\u036f]/g, "")
       .replace(/[\u2122\u00ae\u00a9]/g, "");

  // 4. L → R unification (transcription ambigüe coréen + occasionnellement JP)
  s = s.replace(/l/g, "r");

  // 5. Tokenize
  let tokens: string[] = Array.from(s.match(/[a-z0-9]+/g) || []);

  // 5b. SESSION 12.6 : strip les modifiers (movie, special, ova...)
  tokens = tokens.filter(t => !MODIFIER_TOKENS_STRICT.has(t));

  // 6. Sort (ordre indifférent)
  tokens.sort();

  // 7. Join + suffixes
  return tokens.join("") + seasonSuffix + courSuffix;
}

export function mergePlatforms(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  const sa = sanitizePlatform(a);
  const sb = sanitizePlatform(b);
  if (!sa && !sb) return null;
  if (!sa) return sb;
  if (!sb) return sa;
  // Combine and re-sanitize to dedupe + reorder canonically
  return sanitizePlatform(`${sa}, ${sb}`);
}

// ============================================================
// Score components (session 10 — pure popularity + rating)
// ============================================================

/**
 * Normalise la popularité (signal social) en score logarithmique.
 *
 * Le log empêche les blockbusters d'écraser linéairement les autres items
 * tout en préservant une vraie hiérarchie. Pas de cap dur : un item à
 * 1M de popularité reste légitimement en tête.
 *
 *   pop=0       → 0
 *   pop=10      → 209
 *   pop=100     → 402
 *   pop=1000    → 600
 *   pop=10000   → 800
 *   pop=100000  → 1000
 *   pop=1000000 → 1200
 *
 * Pure function: deterministic output for any input.
 */
function popularityNormalized(popularity: number | null | undefined): number {
  const p = Number(popularity) || 0;
  if (p <= 0) return 0;
  return Math.log10(p + 1) * POPULARITY_LOG_MULTIPLIER;
}

/**
 * Normalise la note qualitative (0-100) en score linéaire.
 *
 * NULL = note inconnue → contribue 0 (graceful degradation : aucune
 * pénalité, juste absence de bonus). Le scoring se rabat alors sur
 * popularityNormalized seul, ce qui marche tant que les workflows
 * n'ont pas tous été mis à jour pour pousser ratingScore.
 *
 *   ratingScore=null ou 0 → 0
 *   ratingScore=60        → 300
 *   ratingScore=80        → 400
 *   ratingScore=95        → 475
 *   ratingScore=100       → 500
 *
 * Pure function: deterministic output for any input.
 */
function ratingNormalized(ratingScore: number | null | undefined): number {
  const r = Number(ratingScore) || 0;
  if (r <= 0) return 0;
  return (r / 100) * RATING_SCORE_MULTIPLIER;
}

// ============================================================
// Final score (session 10 — pure mérite)
// ============================================================

/**
 * Compute the final pertinence score (Top 150 selection).
 *
 * Formula:
 *   score = popularityNormalized(item.popularity)
 *         + ratingNormalized(item.ratingScore)
 *
 * Le Top 150 reflète les meilleurs items selon :
 *   - popularity (signal social : nb de fans/votes/userCount)
 *   - rating_score (signal critique : note qualitative moyenne)
 *
 * Aucun bonus fenêtre, fraîcheur ou complétude :
 *   - Le filtre fenêtre se fait en SQL (WHERE release_date BETWEEN ...)
 *   - La fraîcheur est gérée par l'onglet "Derniers Sortis" (sortByDate)
 *   - La complétude est garantie par les workflows Complement
 *
 * Conséquence ETAT CLEAN : un item ne sort du Top 150 que s'il est
 * dépassé en mérite, jamais par ringardisation temporelle.
 *
 * NB: le paramètre `now` est conservé dans la signature pour préserver
 * la compatibilité avec les appelants (sortForGameNimeTop, sortByDate).
 * Il n'est plus utilisé dans le calcul final.
 */
export function computeGameNimeScore(item: GameNimeItem, _now: Date = new Date()): number {
  return popularityNormalized(item.popularity)
       + ratingNormalized(item.ratingScore);
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
      releaseDateLabel: formatReleaseDateLabel(item.releaseDate, item.releasePrecision),
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
 * Format a release date into a human-readable French label based on precision.
 *
 * Examples:
 *   ("2026-05-15", "day")   -> "15 mai 2026"
 *   ("2026-05-01", "month") -> "Prévu mai 2026"
 *   ("2026-01-01", "year")  -> "Prévu 2026"
 *   (null, *)               -> ""
 *
 * Pure function: deterministic output for any input.
 */
const FRENCH_MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function formatReleaseDateLabel(
  releaseDate: string | null | undefined,
  precision: ReleasePrecision | null | undefined = "day"
): string {
  if (!releaseDate) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  if (!match) return "";
  const [, year, month, day] = match;
  const monthIdx = parseInt(month, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return "";

  const p = precision || "day";

  if (p === "year") {
    return `Prévu ${year}`;
  }
  if (p === "month") {
    return `Prévu ${FRENCH_MONTHS[monthIdx]} ${year}`;
  }
  // precision === "day"
  return `${parseInt(day, 10)} ${FRENCH_MONTHS[monthIdx]} ${year}`;
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
      releaseDateLabel: formatReleaseDateLabel(item.releaseDate, item.releasePrecision),
    }))
    .sort((a, b) => {
      // 1. Items without date go to the bottom
      if (!a.releaseDate && b.releaseDate) return 1;
      if (a.releaseDate && !b.releaseDate) return -1;
      if (!a.releaseDate && !b.releaseDate) return a.id - b.id;

      // 1b. SESSION 18 : pour ascending (upcoming), priorité par précision de date.
      // Les dates FIXES (day) en tête : un item avec compte à rebours (sortie confirmée
      // et imminente) prime sur une date approximative (month) ou vague (year).
      // Ordre : day (0) < month (1) < year (2). Les "01-01"/"01" fictifs ne masquent plus les vraies dates.
      if (ascending) {
        const precRank = (p: string | null | undefined): number =>
          p === "day" ? 0 : p === "month" ? 1 : 2;
        const aPrec = precRank(a.releasePrecision);
        const bPrec = precRank(b.releasePrecision);
        if (aPrec !== bPrec) return aPrec - bPrec;
      }

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

/**
 * SESSION 12.7+: nettoie une description pour l'affichage utilisateur.
 * Retire les tags métadonnées internes [FORMAT:X] [STATUS:X] [SEASON:X]
 * [EPISODES:X] [LENGTH:X] [NEXT_EP:X] qui sont stockés en DB pour la détection
 * de changements (notifications Premium) mais ne doivent pas être visibles
 * par l'utilisateur final.
 *
 * Les tags restent INTACTS en DB. Seul l'affichage est nettoyé.
 * Retourne null si après strip la description est vide ou < 10 chars.
 */
export function stripDisplayTags(desc: string | null | undefined): string | null {
  if (!desc || typeof desc !== "string") return null;
  const cleaned = desc
    .replace(/\s*\[(FORMAT|STATUS|SEASON|EPISODES|LENGTH|NEXT_EP):[^\]]*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length < 10) return null;
  return cleaned;
}
