/**
 * GameNime Phase B GAMES — Cron interne re-fetch des games incomplets
 * Symétrique à refetch-cron.ts (anime) mais pour games via RAWG + IGDB.
 *
 * Sources externes :
 *   - RAWG (via rawg_id) → cover, description, rating (metacritic), platforms
 *   - IGDB (via igdb_id) → cover haute qualité, description (TODO: requires API key)
 *
 * Cycle : toutes les heures, batch 100, delay 800ms entre items (rate limit RAWG).
 */
import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";

const REFETCH_INTERVAL_MS = 60 * 60 * 1000; // 1h
const REFETCH_BATCH_SIZE = 100;
const REFETCH_DELAY_MS = 800;

interface IncompleteGame {
  id: number;
  title: string;
  rawg_id: number | null;
  igdb_id: number | null;
  cover: string | null;
  platform: string | null;
  trailer_url: string | null;
  description: string | null;
  rating_score: number | null;
}

interface SourceData {
  cover?: string | null;
  platform?: string | null;
  trailerUrl?: string | null;
  description?: string | null;
  ratingScore?: number | null;
}

/**
 * RAWG : récupère un game via son ID.
 * https://api.rawg.io/api/games/{id}?key=API_KEY
 */
export async function fetchRawg(rawgId: number): Promise<SourceData | null> {
  if (!rawgId) return null;
  const apiKey = process.env.RAWG_API_KEY || "";
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.rawg.io/api/games/${rawgId}?key=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const cover = data?.background_image ?? null;
    const description = data?.description_raw ?? data?.description ?? null;
    const ratingMetacritic = data?.metacritic ?? null;
    // RAWG platforms : array of { platform: { name } }
    const platforms = Array.isArray(data?.platforms)
      ? data.platforms.map((p: any) => p?.platform?.name).filter(Boolean)
      : [];
    const platform = platforms.length > 0 ? platforms.join(", ") : null;
    return {
      cover,
      platform,
      description: description ? String(description).substring(0, 2000) : null,
      ratingScore: ratingMetacritic,
    };
  } catch {
    return null;
  }
}

/**
 * IGDB : recupere via Twitch OAuth + IGDB API
 * Token Twitch cache ~60 jours (re-fetch automatique a l expiration)
 */
let TWITCH_TOKEN: { token: string; expiresAt: number } | null = null;

async function getTwitchToken(): Promise<string | null> {
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;

  // Token valide encore ?
  if (TWITCH_TOKEN && TWITCH_TOKEN.expiresAt > Date.now() + 60000) {
    return TWITCH_TOKEN.token;
  }

  try {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: "POST" }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data?.access_token) return null;
    TWITCH_TOKEN = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 5184000) * 1000,
    };
    return TWITCH_TOKEN.token;
  } catch {
    return null;
  }
}

export async function fetchIgdb(igdbId: number): Promise<SourceData | null> {
  if (!igdbId) return null;
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  if (!clientId) return null;
  const token = await getTwitchToken();
  if (!token) return null;

  try {
    const res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: `fields name, summary, storyline, cover.image_id, platforms.name, rating, total_rating; where id = ${igdbId};`,
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!Array.isArray(data) || data.length === 0) return null;
    const game = data[0];

    // Cover IGDB : format URL = https://images.igdb.com/igdb/image/upload/t_cover_big_2x/{image_id}.jpg
    const cover = game.cover?.image_id
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${game.cover.image_id}.jpg`
      : null;

    const platforms = Array.isArray(game.platforms)
      ? game.platforms.map((p: any) => p?.name).filter(Boolean).join(", ")
      : null;

    const description = game.summary || game.storyline || null;

    // IGDB rating : 0-100, on garde tel quel
    const ratingScore = game.total_rating ? Math.round(Number(game.total_rating)) : null;

    return {
      cover,
      platform: platforms,
      description: description ? String(description).substring(0, 2000) : null,
      ratingScore,
    };
  } catch {
    return null;
  }
}

function mergeSources(rawg: SourceData | null, igdb: SourceData | null): SourceData {
  const sources = [rawg, igdb].filter(s => s !== null) as SourceData[];
  return {
    cover: sources.find(s => s.cover)?.cover ?? null,
    platform: sources.find(s => s.platform)?.platform ?? null,
    description: sources.find(s => s.description)?.description ?? null,
    ratingScore: sources.find(s => s.ratingScore != null)?.ratingScore ?? null,
  };
}

export async function refetchIncompleteGamesCycle(app: FastifyInstance): Promise<{
  scanned: number;
  enriched: number;
  errors: number;
  changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }>;
}> {
  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Refetch Games cycle: pool DB introuvable");
    return { scanned: 0, enriched: 0, errors: 0, changes: [] };
  }
  const conn = await pool.getConnection();
  let scanned = 0;
  let enriched = 0;
  let errors = 0;
  const changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }> = [];

  try {
    const items: IncompleteGame[] = await conn.query(
      "SELECT id, title, rawg_id, igdb_id, cover, platform, trailer_url, description, rating_score " +
      "FROM game_items " +
      "WHERE (cover IS NULL OR cover = '' OR cover LIKE '%media.rawg.io%' OR cover LIKE '%images.igdb.com%' OR platform IS NULL OR platform = '' OR description IS NULL OR description = '' OR LENGTH(TRIM(description)) < 10 OR rating_score IS NULL) " +
      "AND (rawg_id IS NOT NULL OR igdb_id IS NOT NULL) " +
      "ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
    );
    scanned = items.length;
    app.log.info({ scanned }, "Refetch Games cycle: items scannes");

    for (const item of items) {
      try {
        const [rawg, igdb] = await Promise.all([
          item.rawg_id ? fetchRawg(item.rawg_id) : null,
          item.igdb_id ? fetchIgdb(item.igdb_id) : null,
        ]);
        const merged = mergeSources(rawg, igdb);

        const updates: string[] = [];
        const params: any[] = [];
        const itemChanges: Array<{ field: string; oldValue: any; newValue: any }> = [];

        // ETAT CLEAN cover : 
        //   - Si cover vide → remplir
        //   - Si cover RAWG/IGDB → REFRESH (URLs peuvent mourir, on force la fraicheur)
        //   - Sinon (cover externe ou inconnue) → ne pas toucher
        const coverIsEmpty = !item.cover || item.cover === "";
        const coverFromTrustedCdn = item.cover && (item.cover.includes("media.rawg.io") || item.cover.includes("images.igdb.com"));
        if (merged.cover && (coverIsEmpty || coverFromTrustedCdn)) {
          if (merged.cover !== item.cover) {
            updates.push("cover = ?");
            params.push(merged.cover);
            itemChanges.push({ field: "cover", oldValue: item.cover, newValue: merged.cover });
          }
        }
        if ((!item.platform || item.platform === "") && merged.platform) {
          updates.push("platform = ?");
          params.push(merged.platform);
          itemChanges.push({ field: "platform", oldValue: item.platform, newValue: merged.platform });
        }
        const descIsMissing = !item.description || item.description === "" || (typeof item.description === "string" && item.description.trim().length < 10);
        if (descIsMissing && merged.description) {
          updates.push("description = ?");
          params.push(merged.description);
          itemChanges.push({ field: "description", oldValue: item.description, newValue: merged.description.substring(0, 80) + "..." });
        }
        if (item.rating_score == null && merged.ratingScore != null) {
          updates.push("rating_score = ?");
          params.push(merged.ratingScore);
          itemChanges.push({ field: "rating_score", oldValue: item.rating_score, newValue: merged.ratingScore });
        }

        if (updates.length > 0) {
          params.push(item.id);
          await conn.query("UPDATE game_items SET " + updates.join(", ") + " WHERE id = ?", params);
          enriched++;
          for (const ch of itemChanges) {
            changes.push({ id: item.id, title: item.title, ...ch });
          }
          app.log.info({ id: item.id, title: item.title, fields: itemChanges.map(c => c.field) }, "Game enriched");
        }
      } catch (e: any) {
        errors++;
        app.log.warn({ err: e?.message, id: item.id, title: item.title }, "Game refetch error");
      }
      await new Promise(r => setTimeout(r, REFETCH_DELAY_MS));
    }

    app.log.info({ scanned, enriched, errors, changesCount: changes.length }, "Refetch Games cycle termine");
    trackLastRun("refetch-games-cron", { scanned, enriched, errors });
    if (enriched > 0) {
      pushActivity({
        type: "refetch",
        message: `Phase B Games enriched ${enriched} items`,
        detail: `${scanned} scanned, ${errors} errors`,
        level: "info",
      });
    }
  } finally {
    conn.release();
  }
  return { scanned, enriched, errors, changes };
}

export async function adminRefetchGamesHandler(req: any, reply: any) {
  const expected = process.env.GAMES_API_KEY || process.env.ANIME_API_KEY;
  const provided = req.headers["x-api-key"];
  if (!expected || provided !== expected) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const result = await refetchIncompleteGamesCycle(req.server);
  return reply.send({ ok: true, ...result });
}

export function startRefetchGamesCron(app: FastifyInstance) {
  app.post("/admin/refetch-incomplete-games", adminRefetchGamesHandler);
  setTimeout(() => {
    refetchIncompleteGamesCycle(app).catch(e => app.log.error(e, "First Games refetch cycle failed"));
  }, 15 * 60 * 1000); // First run after 15 min (let Phase B anime run first)
  setInterval(() => {
    refetchIncompleteGamesCycle(app).catch(e => app.log.error(e, "Games refetch cycle failed"));
  }, REFETCH_INTERVAL_MS);
  app.log.info({ intervalMs: REFETCH_INTERVAL_MS, batchSize: REFETCH_BATCH_SIZE }, "Refetch Games cron demarre");
}
