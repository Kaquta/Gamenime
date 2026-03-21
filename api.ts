import type { ContentItem } from "./types";

const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "";

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error ${response.status} on ${url}`);
  }

  return response.json() as Promise<T>;
}

export async function getAnimeItems(): Promise<ContentItem[]> {
  // content-api sert /anime/items (sans /api/ — c'est nginx qui ajoute ce préfixe)
  const data = await fetchJson<{ items?: ContentItem[] } | ContentItem[]>(
    "/anime/items",
  );
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function getGameItems(): Promise<ContentItem[]> {
  const data = await fetchJson<{ items?: ContentItem[] } | ContentItem[]>(
    "/games/items",
  );
  return Array.isArray(data) ? data : (data.items ?? []);
}
