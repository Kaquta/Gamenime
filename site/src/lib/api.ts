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

export async function getFeedAnime(opts: { status?: FeedStatus; limit?: number; orderBy?: FeedOrderBy } = {}): Promise<FeedItem[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
  const qs = params.toString();
  const url = qs ? `/api/feed/anime?${qs}` : "/api/feed/anime";
  const data = await fetchJson<{ items: FeedItem[] }>(url);
  return data.items;
}

export async function getFeedGames(opts: { status?: FeedStatus; limit?: number; orderBy?: FeedOrderBy } = {}): Promise<FeedItem[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
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
