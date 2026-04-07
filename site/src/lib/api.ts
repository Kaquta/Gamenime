export interface ContentItem {
  id: number | string;
  title: string;
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
