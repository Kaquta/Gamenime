/**
 * SESSION 12.7+ — Quality Check J-7
 *
 * Tous les jours à 8h UTC, scanne les items dont la release_date est dans
 * 7 jours ou moins. Pour chaque item incomplet (cover hotlink, sans platform,
 * sans description, sans trailer), force un re-fetch agressif via AniList/
 * Jikan/AnimeSchedule. Les items qui restent incomplets après le re-fetch
 * sont retournés à l'appelant (workflow n8n Discord).
 *
 * Endpoint exposé : POST /admin/quality-check-j7?daysAhead=7
 * Cron auto : tous les jours à 8h UTC
 */

import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { sanitizePlatform } from "./core.js";
import {
  fetchAniList,
  fetchJikan,
  fetchAnimeSchedule,
  mergeSources,
  isHotlinkProtectedCover,
  isAniListCover,
} from "./refetch-cron.js";
import { lookupAniListByTitle } from "./lookup-cron.js";

const QUALITY_DELAY_MS = 800;

interface QualityIncomplete {
  id: number;
  title: string;
  popularity: number;
  release_date: string;
  days_until_release: number;
  missing: {
    cover_hotlink: boolean;
    cover_empty: boolean;
    platform: boolean;
    description: boolean;
    trailer: boolean;
  };
  has_external_ids: boolean;
}

interface QualityCheckResult {
  daysAhead: number;
  scanned: number;
  enriched: number;
  still_incomplete: number;
  incomplete_items: QualityIncomplete[];
}

export async function qualityCheckCycle(
  app: FastifyInstance,
  opts: { daysAhead?: number } = {}
): Promise<QualityCheckResult> {
  const { daysAhead = 7 } = opts;

  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Quality check : pool DB introuvable");
    return { daysAhead, scanned: 0, enriched: 0, still_incomplete: 0, incomplete_items: [] };
  }

  const conn = await pool.getConnection();
  let scanned = 0;
  let enriched = 0;
  const incomplete_items: QualityIncomplete[] = [];

  try {
    const items: any[] = await conn.query(
      "SELECT id, title, popularity, anilist_id, mal_id, anime_schedule_route, " +
        "cover, platform, trailer_url, description, " +
        "DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, " +
        "DATEDIFF(release_date, CURDATE()) AS days_until_release " +
      "FROM anime_items " +
      "WHERE release_date IS NOT NULL " +
        "AND release_date >= CURDATE() " +
        "AND release_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY) " +
        "AND (cover IS NULL OR cover = '' " +
          "OR cover LIKE '%myanimelist.net%' " +
          "OR cover LIKE '%animeschedule.net%' " +
          "OR platform IS NULL OR platform = '' " +
          "OR trailer_url IS NULL OR trailer_url = '' " +
          "OR description IS NULL OR description = '' " +
          "OR LENGTH(TRIM(description)) < 10) " +
      "ORDER BY release_date ASC, popularity DESC",
      [daysAhead]
    );

    scanned = items.length;
    app.log.info({ scanned, daysAhead }, "Quality check J-X : items scannes");

    const animeScheduleToken = process.env.ANIMESCHEDULE_TOKEN || "";

    for (const item of items) {
      try {
        // SESSION 18 : orphelin proche de sa sortie -> lookup AniList par titre d'abord (comme Phase C)
        if (!item.anilist_id && !item.mal_id) {
          try {
            const { match } = await lookupAniListByTitle(item.title, item.release_date, null);
            if (match && match.anilistId) {
              await conn.query(
                "UPDATE anime_items SET anilist_id = IF(anilist_id IS NULL, ?, anilist_id), " +
                  "mal_id = IF(mal_id IS NULL AND ? IS NOT NULL, ?, mal_id) WHERE id = ?",
                [match.anilistId, match.malId, match.malId, item.id]
              );
              item.anilist_id = match.anilistId;
              item.mal_id = match.malId;
              app.log.info({ id: item.id, title: item.title, anilistId: match.anilistId }, "QualityCheck: orphelin rattache via lookup");
            }
          } catch (lookupErr) {
            app.log.warn({ id: item.id, err: (lookupErr as any)?.message }, "QualityCheck: lookup orphelin echoue");
          }
        }
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

        const coverIsEmpty = !item.cover || item.cover === "";
        const coverIsHotlink = isHotlinkProtectedCover(item.cover);
        const newCoverFromAniList = aniList?.cover && isAniListCover(aniList.cover);

        if (coverIsEmpty && merged.cover) {
          updates.push("cover = ?");
          params.push(merged.cover);
          item.cover = merged.cover;
        } else if (coverIsHotlink && newCoverFromAniList) {
          updates.push("cover = ?");
          params.push(aniList!.cover);
          item.cover = aniList!.cover;
        }

        const cleanPlat = sanitizePlatform(merged.platform);
        if ((!item.platform || item.platform === "") && cleanPlat) {
          updates.push("platform = ?");
          params.push(cleanPlat);
          item.platform = cleanPlat;
        }

        if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
          updates.push("trailer_url = ?");
          params.push(merged.trailerUrl);
          item.trailer_url = merged.trailerUrl;
        }

        const descIsMissing = !item.description || item.description === "" ||
          (typeof item.description === "string" && item.description.trim().length < 10);
        if (descIsMissing && merged.description) {
          updates.push("description = ?");
          params.push(merged.description);
          item.description = merged.description;
        }

        if (updates.length > 0) {
          params.push(item.id);
          await conn.query(
            "UPDATE anime_items SET " + updates.join(", ") + " WHERE id = ?",
            params
          );
          enriched++;
        }

        const still_cover_hotlink = !!(item.cover && (
          item.cover.includes("myanimelist.net") || item.cover.includes("animeschedule.net")
        ));
        const still_cover_empty = !item.cover || item.cover === "";
        const still_no_platform = !item.platform || item.platform === "";
        const still_no_description = !item.description || item.description === "" ||
          (typeof item.description === "string" && item.description.trim().length < 10);
        const still_no_trailer = !item.trailer_url || item.trailer_url === "";

        const has_any_missing = still_cover_hotlink || still_cover_empty ||
                                still_no_platform || still_no_description || still_no_trailer;

        if (has_any_missing) {
          incomplete_items.push({
            id: item.id,
            title: item.title,
            popularity: Number(item.popularity || 0),
            release_date: item.release_date,
            days_until_release: Number(item.days_until_release),
            missing: {
              cover_hotlink: still_cover_hotlink,
              cover_empty: still_cover_empty,
              platform: still_no_platform,
              description: still_no_description,
              trailer: still_no_trailer,
            },
            has_external_ids: !!(item.anilist_id || item.mal_id || item.anime_schedule_route),
          });
        }
      } catch (e) {
        app.log.warn({ id: item.id, err: (e as any)?.message }, "Quality check item failed");
      }

      await new Promise(resolve => setTimeout(resolve, QUALITY_DELAY_MS));
    }

    app.log.info(
      { scanned, enriched, still_incomplete: incomplete_items.length },
      "Quality check J-X termine"
    );
    trackLastRun("quality-cron", { scanned, enriched, still_incomplete: incomplete_items.length });
    if (incomplete_items.length > 0 || enriched > 0) pushActivity({ type: "quality", message: `Quality Check J-7 termine`, detail: `${enriched} enriched, ${incomplete_items.length} still incomplete`, level: incomplete_items.length > 0 ? "warn" : "info" });
  } finally {
    conn.release();
  }

  return {
    daysAhead,
    scanned,
    enriched,
    still_incomplete: incomplete_items.length,
    incomplete_items,
  };
}

export async function adminQualityCheckHandler(
  app: FastifyInstance,
  req: any,
  reply: any
) {
  const daysAhead = Math.max(1, Math.min(30, parseInt(req.query?.daysAhead ?? "7", 10) || 7));
  const result = await qualityCheckCycle(app, { daysAhead });
  return reply.send({ ok: true, ...result });
}

export function startQualityCron(app: FastifyInstance): NodeJS.Timeout {
  app.log.info("Quality check cron demarre (J-7 quotidien 8h UTC)");

  function msUntilNext8h(): number {
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      8, 0, 0, 0
    ));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  const firstRunDelay = 5 * 60 * 1000;
  setTimeout(() => {
    qualityCheckCycle(app, { daysAhead: 7 }).catch(
      (e) => app.log.error({ err: e?.message }, "Quality check error")
    );
    setTimeout(scheduleDaily8h, msUntilNext8h());
  }, firstRunDelay);

  function scheduleDaily8h() {
    qualityCheckCycle(app, { daysAhead: 7 }).catch(
      (e) => app.log.error({ err: e?.message }, "Quality check error")
    );
    setTimeout(scheduleDaily8h, 24 * 60 * 60 * 1000);
  }

  return setTimeout(() => {}, 0);
}
