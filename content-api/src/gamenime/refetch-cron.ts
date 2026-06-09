/**
 * GameNime Phase B — Cron interne re-fetch des items incomplets
 */

import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";

const REFETCH_INTERVAL_MS = 60 * 60 * 1000;
const REFETCH_BATCH_SIZE = 200;
const REFETCH_DELAY_MS = 800;

interface IncompleteItem {
  id: number;
  title: string;
  anilist_id: number | null;
  mal_id: number | null;
  anime_schedule_route: string | null;
  cover: string | null;
  platform: string | null;
  trailer_url: string | null;
  description: string | null;
  format: string | null;
}

interface SourceData {
  cover?: string | null;
  platform?: string | null;
  trailerUrl?: string | null;
  description: string | null;
  format?: string | null;
}

export async function fetchAniList(anilistId: number): Promise<SourceData | null> {
  if (!anilistId) return null;

  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { format description coverImage { extraLarge large } trailer { id site } externalLinks { site type url } streamingEpisodes { site } } }`;

  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: anilistId } }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    const media = data?.data?.Media;
    if (!media) return null;

    const cover = media.coverImage?.extraLarge ?? media.coverImage?.large ?? null;

    const platforms = new Set<string>();
    if (Array.isArray(media.externalLinks)) {
      for (const link of media.externalLinks) {
        if (link?.type === "STREAMING" && link?.site) {
          platforms.add(link.site);
        }
      }
    }
    if (Array.isArray(media.streamingEpisodes)) {
      for (const ep of media.streamingEpisodes) {
        if (ep?.site) platforms.add(ep.site);
      }
    }
    const platform = platforms.size > 0 ? Array.from(platforms).join(", ") : null;

    let trailerUrl: string | null = null;
    if (media.trailer?.site === "youtube" && media.trailer?.id) {
      trailerUrl = "https://www.youtube.com/watch?v=" + media.trailer.id;
    }

    const description = stripDescriptionTags(media.description);
    const format = media.format ?? null;
    return { cover, platform, trailerUrl, description, format };
  } catch (e) {
    return null;
  }
}

export async function fetchJikan(malId: number): Promise<SourceData | null> {
  if (!malId) return null;

  try {
    const res = await fetch("https://api.jikan.moe/v4/anime/" + malId);
    if (!res.ok) return null;
    const json = await res.json() as any;
    const data = json?.data;
    if (!data) return null;

    const cover = data.images?.jpg?.large_image_url ?? data.images?.jpg?.image_url ?? null;

    const platforms: string[] = [];
    if (Array.isArray(data.streaming)) {
      for (const s of data.streaming) {
        if (s?.name) platforms.push(s.name);
      }
    }
    const platform = platforms.length > 0 ? platforms.join(", ") : null;

    let trailerUrl: string | null = null;
    if (data.trailer?.youtube_id) {
      trailerUrl = "https://www.youtube.com/watch?v=" + data.trailer.youtube_id;
    }

    const description = stripDescriptionTags(data.synopsis);
    return { cover, platform, trailerUrl, description };
  } catch (e) {
    return null;
  }
}

export async function fetchAnimeSchedule(route: string, apiToken: string): Promise<SourceData | null> {
  if (!route) return null;

  try {
    const res = await fetch("https://animeschedule.net/api/v3/anime/" + encodeURIComponent(route), {
      headers: { "Authorization": "Bearer " + apiToken },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data) return null;

    const cover = data.imageVersionRoute
      ? "https://img.animeschedule.net/production/assets/public/img/anime/" + data.imageVersionRoute
      : null;

    const platforms: string[] = [];
    if (data.websites?.streams && Array.isArray(data.websites.streams)) {
      for (const s of data.websites.streams) {
        if (s?.name) platforms.push(s.name);
      }
    }
    const platform = platforms.length > 0 ? platforms.join(", ") : null;

    const description = stripDescriptionTags(data.description);
    return { cover, platform, trailerUrl: null, description };
  } catch (e) {
    return null;
  }
}

/**
 * SESSION 12.7+: nettoie une description en retirant :
 *   - les tags AniList workflow [FORMAT:X] [STATUS:X] [SEASON:X] [EPISODES:X] [LENGTH:X]
 *   - les balises HTML communes (<br>, <i>, <b>, <strong>, <em>)
 *   - les whitespace et newlines de fin
 * Retourne null si après nettoyage la description est vide ou trop courte (<10 chars).
 */
export function stripDescriptionTags(desc: string | null | undefined): string | null {
  if (!desc || typeof desc !== "string") return null;
  let cleaned = desc
    .replace(/\s?\[(FORMAT|STATUS|SEASON|EPISODES|LENGTH):[^\]]+\]/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(i|b|strong|em|u)>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length < 10) return null;
  return cleaned;
}

/**
 * SESSION 12.7+: détecte si une cover est sur un domaine hotlink-protected.
 * MAL et AnimeSchedule bloquent les requêtes du navigateur depuis d'autres
 * domaines (Referer check), même si la requête HTTP côté serveur réussit.
 * Ces covers DOIVENT être remplacées par AniList si possible.
 */
export function isHotlinkProtectedCover(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("myanimelist.net") || url.includes("animeschedule.net");
}

/**
 * SESSION 12.7+: détecte si une cover vient d'AniList (= utilisable côté navigateur).
 */
export function isAniListCover(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("anilistcdn") || url.includes("s4.anilist.co");
}

export function mergeSources(
  aniList: SourceData | null,
  jikan: SourceData | null,
  animeSchedule: SourceData | null
): SourceData {
  const sources = [aniList, jikan, animeSchedule].filter(s => s !== null) as SourceData[];
  return {
    cover: sources.find(s => s.cover)?.cover ?? null,
    platform: sources.find(s => s.platform)?.platform ?? null,
    trailerUrl: sources.find(s => s.trailerUrl)?.trailerUrl ?? null,
    description: sources.find(s => s.description)?.description ?? null,
    format: sources.find(s => s.format)?.format ?? null,
  };
}

export async function refetchIncompleteCycle(app: FastifyInstance): Promise<{
  scanned: number;
  enriched: number;
  errors: number;
  changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }>;
}> {
  const animeScheduleToken = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Refetch cycle: pool DB introuvable");
    return { scanned: 0, enriched: 0, errors: 0, changes: [] };
  }

  const conn = await pool.getConnection();
  let scanned = 0;
  let enriched = 0;
  let errors = 0;
  const changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }> = [];

  try {
    const items: IncompleteItem[] = await conn.query(
      "SELECT id, title, anilist_id, mal_id, anime_schedule_route, cover, platform, trailer_url, description, format FROM anime_items WHERE (platform IS NULL OR platform = '' OR cover IS NULL OR cover = '' OR trailer_url IS NULL OR trailer_url = '' OR description IS NULL OR description = '' OR LENGTH(TRIM(description)) < 10 OR cover LIKE '%myanimelist.net%' OR cover LIKE '%animeschedule.net%' OR format IS NULL OR format = '') AND (anilist_id IS NOT NULL OR mal_id IS NOT NULL OR anime_schedule_route IS NOT NULL) ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
    );

    scanned = items.length;
    app.log.info({ scanned }, "Refetch cycle: items scannes");

    for (const item of items) {
      try {
        const [aniList, jikan, animeSchedule] = await Promise.all([
          item.anilist_id ? fetchAniList(item.anilist_id) : null,
          item.mal_id ? fetchJikan(item.mal_id) : null,
          item.anime_schedule_route && animeScheduleToken
            ? fetchAnimeSchedule(item.anime_schedule_route, animeScheduleToken)
            : null,
        ]);

        const merged = mergeSources(aniList, jikan, animeSchedule);

        const updates: string[] = [];
        const params: any[] = [];
        const itemChanges: Array<{ field: string; oldValue: any; newValue: any }> = [];

        // SESSION 12.7+: cover upgrade en 2 cas:
        //   (1) cover absente ET on a une cover quelconque
        //   (2) cover hotlink-protected (MAL/AS) ET on a une cover AniList (utilisable navigateur)
        const coverIsEmpty = !item.cover || item.cover === "";
        const coverIsHotlinkProtected = isHotlinkProtectedCover(item.cover);
        const newCoverFromAniList = aniList?.cover && isAniListCover(aniList.cover);
        if (coverIsEmpty && merged.cover) {
          updates.push("cover = ?");
          params.push(merged.cover);
          itemChanges.push({ field: "cover", oldValue: item.cover, newValue: merged.cover });
        } else if (coverIsHotlinkProtected && newCoverFromAniList) {
          updates.push("cover = ?");
          params.push(aniList!.cover);
          itemChanges.push({ field: "cover", oldValue: item.cover, newValue: aniList!.cover });
        }
        if ((!item.platform || item.platform === "") && merged.platform) {
          updates.push("platform = ?");
          params.push(merged.platform);
          itemChanges.push({ field: "platform", oldValue: item.platform, newValue: merged.platform });
        }
        if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
          updates.push("trailer_url = ?");
          params.push(merged.trailerUrl);
          itemChanges.push({ field: "trailer_url", oldValue: item.trailer_url, newValue: merged.trailerUrl });
        }
        // SESSION 12.7+: description (lossless append - on remplit si vide ou trop courte)
        const descIsMissing = !item.description || item.description === "" || (typeof item.description === "string" && item.description.trim().length < 10);
        if (descIsMissing && merged.description) {
          updates.push("description = ?");
          params.push(merged.description);
          itemChanges.push({ field: "description", oldValue: item.description, newValue: merged.description.substring(0, 80) + "..." });
        }
        // FORMAT (lossless append - on remplit si vide)
        const formatIsMissing = !item.format || item.format === "";
        if (formatIsMissing && merged.format) {
          updates.push("format = ?");
          params.push(merged.format);
          itemChanges.push({ field: "format", oldValue: item.format, newValue: merged.format });
        }

        if (updates.length > 0) {
          params.push(item.id);
          await conn.query(
            "UPDATE anime_items SET " + updates.join(", ") + " WHERE id = ?",
            params
          );
          enriched++;
          for (const ch of itemChanges) {
            changes.push({ id: item.id, title: item.title, ...ch });
          }
          app.log.info({ id: item.id, title: item.title, fields: itemChanges.map(c => c.field) }, "Item enriched");
        }
      } catch (e) {
        errors++;
        app.log.warn({ id: item.id, err: (e as any)?.message }, "Refetch item failed");
      }

      await new Promise(resolve => setTimeout(resolve, REFETCH_DELAY_MS));
    }

    app.log.info({ scanned, enriched, errors, changesCount: changes.length }, "Refetch cycle termine");
    trackLastRun("refetch-cron", { scanned, enriched, errors });
    if (enriched > 0) pushActivity({ type: "refetch", message: `Phase B enriched ${enriched} items`, detail: `${scanned} scanned, ${errors} errors`, level: "info" });
  } finally {
    conn.release();
  }

  return { scanned, enriched, errors, changes };
}

export function startRefetchCron(app: FastifyInstance): NodeJS.Timeout {
  app.log.info({ intervalMs: REFETCH_INTERVAL_MS, batchSize: REFETCH_BATCH_SIZE }, "Refetch cron demarre");

  setTimeout(() => {
    refetchIncompleteCycle(app).catch(e => app.log.error({ err: e?.message }, "Refetch cycle error"));
  }, 5 * 60 * 1000);

  return setInterval(() => {
    refetchIncompleteCycle(app).catch(e => app.log.error({ err: e?.message }, "Refetch cycle error"));
  }, REFETCH_INTERVAL_MS);
}

export async function adminRefetchHandler(app: FastifyInstance, _req: any, reply: any) {
  const result = await refetchIncompleteCycle(app);
  return reply.send({
    ok: true,
    scanned: result.scanned,
    enriched: result.enriched,
    errors: result.errors,
    changes: result.changes.slice(0, 50),
  });
}
