export interface ContentItem {
  id: number | string;
  title: string;
  titleEnglish?: string | null;
  cover: string | null;
  genre: string | null;
  platform: string | null;
  releaseDate: string | null;
  releaseDatetime?: string | null;
  isRecentlyReleased: boolean | number;
  trailerUrl?: string | null;
  description?: string | null;
  rating?: string | null;
  popularity?: number;
  screenshots?: string | null;
}

export interface VoteData {
  up: number; down: number; total: number; percent: number;
}

export interface ItemDetail extends ContentItem {
  votes: VoteData;
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`API ${r.status} on ${path}`);
  return r.json() as Promise<T>;
}

export async function getAnimeItems(params?: string): Promise<ContentItem[]> {
  const data = await fetchJson<{ items?: ContentItem[] }>(`/api/anime/items${params ? '?'+params : ''}`);
  return data.items ?? [];
}

export async function getGameItems(params?: string): Promise<ContentItem[]> {
  const data = await fetchJson<{ items?: ContentItem[] }>(`/api/games/items${params ? '?'+params : ''}`);
  return data.items ?? [];
}

export async function getItemDetail(domain: "anime" | "games", id: number | string): Promise<ItemDetail> {
  return fetchJson<ItemDetail>(`/api/${domain}/items/${id}`);
}

export async function postVote(domain: "anime" | "games", id: number | string, vote: 1 | -1): Promise<{ ok: boolean; votes: VoteData }> {
  const r = await fetch(`/api/${domain}/items/${id}/vote`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vote }),
  });
  if (!r.ok) throw new Error(`Vote failed ${r.status}`);
  return r.json();
}

// ─────────────────────────────────────────────────────────
// GameNime feed endpoints (scoring intelligent)
// ─────────────────────────────────────────────────────────

export interface FeedItem extends ContentItem {
  type: "anime" | "game";
  gameNimeScore: number;
}

export interface FeedHomeResponse {
  window: { start: string; end: string };
  generatedAt: string;
  counts: { anime: number; games: number; home: number };
  home: FeedItem[];
  anime: FeedItem[];
  games: FeedItem[];
}

export async function getFeedHome(): Promise<FeedHomeResponse> {
  return fetchJson<FeedHomeResponse>("/api/feed/home");
}

export type FeedStatus = "released" | "upcoming" | "all";

export type FeedOrderBy = "score" | "date";

export async function getFeedAnime(opts: { status?: FeedStatus; limit?: number; orderBy?: FeedOrderBy; genre?: string; platform?: string; search?: string; releasedAfter?: string; releasedBefore?: string } = {}): Promise<FeedItem[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
  if (opts.genre) params.set("genre", opts.genre);
  if (opts.platform) params.set("platform", opts.platform);
  if (opts.search) params.set("search", opts.search);
  if (opts.releasedAfter) params.set("releasedAfter", opts.releasedAfter);
  if (opts.releasedBefore) params.set("releasedBefore", opts.releasedBefore);
  const qs = params.toString();
  const url = qs ? `/api/feed/anime?${qs}` : "/api/feed/anime";
  const data = await fetchJson<{ items: FeedItem[] }>(url);
  return data.items;
}

export async function getFeedGames(opts: { status?: FeedStatus; limit?: number; orderBy?: FeedOrderBy; genre?: string; platform?: string; search?: string; releasedAfter?: string; releasedBefore?: string } = {}): Promise<FeedItem[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
  if (opts.genre) params.set("genre", opts.genre);
  if (opts.platform) params.set("platform", opts.platform);
  if (opts.search) params.set("search", opts.search);
  if (opts.releasedAfter) params.set("releasedAfter", opts.releasedAfter);
  if (opts.releasedBefore) params.set("releasedBefore", opts.releasedBefore);
  const qs = params.toString();
  const url = qs ? `/api/feed/games?${qs}` : "/api/feed/games";
  const data = await fetchJson<{ items: FeedItem[] }>(url);
  return data.items;
}

export async function searchFeed(query: string, type: "anime" | "game" | "all" = "all"): Promise<FeedItem[]> {
  const url = `/api/feed/search?q=${encodeURIComponent(query)}&type=${type}`;
  const data = await fetchJson<{ items: FeedItem[] }>(url);
  return data.items;
}

/**
 * Session 10 ETAT CLEAN — Helper displayTitle.
 * Retourne le titre anglais si dispo, sinon retombe sur le titre romaji (clé DB).
 * Source unique de verite pour l'affichage des titres dans tout le frontend.
 */
export function displayTitle(item: { title: string; titleEnglish?: string | null }): string {
  return item.titleEnglish ?? item.title;
}

// ─────────────────────────────────────────────────────────
// Radar hebdo — episodes en diffusion (session 33)
// ─────────────────────────────────────────────────────────
export interface WeekEpisode {
  id: number;
  title: string;
  titleEnglish?: string | null;
  cover: string | null;
  platform: string | null;
  popularity?: number;
  episodeNumber: number | null;
  episodeTotal: number | null;
  airingAt: string;
  aired: boolean;
}
export interface WeekDay {
  date: string;
  dayName: string;
  dayNum: number;
  count: number;
  episodes: WeekEpisode[];
}
export interface WeekResponse {
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  today: string;
  total: number;
  fetched: number;
  days: WeekDay[];
  imminent: WeekEpisode[];
}
export async function getFeedWeek(): Promise<WeekResponse> {
  return fetchJson<WeekResponse>(`/api/feed/week`);
}

// ─────────────────────────────────────────────────────────
// Plateformes jeux : version precise plutot que generique
// ─────────────────────────────────────────────────────────
// La base garde le detail ("PlayStation 5", "Xbox Series X|S").
// Certaines lignes melangent generique et precis :
//   "PC, PlayStation, Xbox, PlayStation 5, Xbox Series X|S"
// Regle : des qu'une version precise existe pour une famille,
// le generique de cette famille disparait.
const PLATFORM_LABELS: Record<string, string> = {
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
  "apple macintosh": "Mac",
};
// Famille -> a quoi reconnait-on une version precise
const FAMILIES: Array<{ generic: string; precise: RegExp }> = [
  { generic: "playstation", precise: /^playstation \d/ },
  { generic: "xbox", precise: /^xbox (series|one)/ },
  { generic: "nintendo", precise: /^nintendo (switch|3ds|ds|wii)/ },
];

export function formatPlatforms(raw: string | null | undefined): string {
  if (!raw) return "";
  const parts = String(raw).split(",").map((p) => p.trim()).filter(Boolean);
  const lower = parts.map((p) => p.toLowerCase());

  // Retirer le generique quand une version precise de la meme famille existe
  const kept = parts.filter((p, i) => {
    const fam = FAMILIES.find((f) => lower[i] === f.generic);
    if (!fam) return true;
    return !lower.some((x) => fam.precise.test(x));
  });

  // Renommer + dedupliquer en gardant l'ordre
  const out: string[] = [];
  for (const p of kept) {
    const label = PLATFORM_LABELS[p.toLowerCase()] || p;
    if (out.indexOf(label) === -1) out.push(label);
  }
  return out.join(", ");
}
