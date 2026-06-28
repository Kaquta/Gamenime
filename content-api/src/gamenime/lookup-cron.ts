/**
 * GameNime Phase C — Lookup AniList IDs par titre
 * Module séparé, ETAT CLEAN, lossless, idempotent.
 */

import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";

const LOOKUP_INTERVAL_MS = 60 * 60 * 1000;  // 1 heure
const LOOKUP_DELAY_MS = 1500;
const LOOKUP_CRON_LIMIT = 50;  // Items max par cycle automatique
const ALLOWED_FORMATS = new Set(["TV", "MOVIE", "OVA", "ONA", "TV_SHORT", "SPECIAL"]);

interface LegacyItem {
  id: number;
  title: string;
  release_date: string | null;
  popularity: number;
  mal_id: number | null;
}

interface AniListMatch {
  anilistId: number;
  malId: number | null;
  matchedTitle: string;
  format: string;
  year: number | null;
}

interface LookupChange {
  id: number;
  title: string;
  status: "matched" | "no_match" | "rejected" | "error";
  reason?: string;
  match?: AniListMatch;
}

export async function lookupAniListByTitle(
  title: string,
  releaseDate: string | null,
  knownMalId: number | null = null
): Promise<{ match: AniListMatch | null; reason: string }> {
  if (!title || title.length < 3) {
    return { match: null, reason: "title_too_short" };
  }

  // Fast path : si mal_id connu, query direct par idMal (zero faux match)
  if (knownMalId && knownMalId > 0) {
    try {
      const malQuery = `query ($idMal: Int) {
        Media(idMal: $idMal, type: ANIME) {
          id idMal format startDate { year } title { romaji english }
        }
      }`;
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: malQuery, variables: { idMal: knownMalId } }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const media = data?.data?.Media;
        if (media && media.id) {
          const format: string = media.format || "";
          if (ALLOWED_FORMATS.has(format)) {
            return {
              match: {
                anilistId: media.id,
                malId: media.idMal ?? null,
                matchedTitle: media.title?.romaji || media.title?.english || "",
                format,
                year: media.startDate?.year ?? null,
              },
              reason: "idMal_direct",
            };
          }
        }
      }
    } catch (e) {
      // fallthrough to search by title
    }
  }

  const query = `query ($search: String) {
    Page(page: 1, perPage: 5) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        idMal
        format
        startDate { year }
        title { romaji english }
      }
    }
  }`;

  // SESSION 18 : variantes de recherche pour rattraper les divergences de romanisation.
  // Sources mettent parfois des tirets ("Tenkou-saki") la ou AniList colle ("Tenkousaki").
  // On essaie le titre brut d'abord (gere les cas comme Nikke), puis sans tirets.
  const searchVariants: string[] = [title];
  const noDashTitle = title.replace(/-/g, "");
  if (noDashTitle !== title) searchVariants.push(noDashTitle);
  const refYear = releaseDate ? new Date(releaseDate).getUTCFullYear() : null;
  let lastReason = "no_results";

  for (const searchTerm of searchVariants) {
   try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { search: searchTerm } }),
    });

    if (res.status === 429) return { match: null, reason: "rate_limit_429" };
    if (!res.ok) { lastReason = "http_" + res.status; continue; }

    const data = (await res.json()) as any;
    const candidates = data?.data?.Page?.media;
    if (!candidates || candidates.length === 0) { lastReason = "no_results"; continue; }

    // ETAT CLEAN: si on connaît déjà le mal_id, privilégier le candidat qui matche
    if (knownMalId) {
      const malMatch = candidates.find((c: any) => c?.idMal === knownMalId);
      if (malMatch) {
        const format: string = malMatch?.format || "";
        const year: number | null = malMatch?.startDate?.year ?? null;
        if (ALLOWED_FORMATS.has(format)) {
          return {
            match: {
              anilistId: malMatch.id,
              malId: malMatch.idMal ?? null,
              matchedTitle: malMatch.title?.romaji ?? malMatch.title?.english ?? "",
              format,
              year,
            },
            reason: "ok_via_mal_id",
          };
        }
      }
    }

    for (const candidate of candidates) {
      const format: string = candidate?.format || "";
      const year: number | null = candidate?.startDate?.year ?? null;

      if (!ALLOWED_FORMATS.has(format)) continue;
      if (refYear && year && Math.abs(year - refYear) > 1) continue;

      return {
        match: {
          anilistId: candidate.id,
          malId: candidate.idMal ?? null,
          matchedTitle: candidate.title?.romaji ?? candidate.title?.english ?? "",
          format,
          year,
        },
        reason: searchTerm === title ? "ok" : "ok_dash_variant",
      };
    }

    lastReason = "no_valid_candidate";
   } catch (e) {
    lastReason = "exception";
   }
  }
  return { match: null, reason: lastReason };
}

export async function lookupMissingIdsCycle(
  app: FastifyInstance,
  opts: { releasedOnly?: boolean; limit?: number; dryRun?: boolean } = {}
): Promise<{
  scanned: number;
  matched: number;
  no_match: number;
  errors: number;
  changes: LookupChange[];
}> {
  const { releasedOnly = false, limit = 200, dryRun = false } = opts;

  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Lookup cycle : pool DB introuvable");
    return { scanned: 0, matched: 0, no_match: 0, errors: 0, changes: [] };
  }

  const conn = await pool.getConnection();
  let matched = 0;
  let no_match = 0;
  let errors = 0;
  const changes: LookupChange[] = [];

  try {
    const releasedClause = releasedOnly
      ? "AND release_date IS NOT NULL AND release_date <= CURDATE()"
      : "";

    const items: LegacyItem[] = await conn.query(
      "SELECT id, title, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, popularity, mal_id " +
        "FROM anime_items " +
        "WHERE anilist_id IS NULL " +
        releasedClause +
        " ORDER BY popularity DESC LIMIT " + Math.max(1, Math.min(limit, 500))
    );

    app.log.info({ scanned: items.length, releasedOnly, dryRun }, "Lookup cycle : items scannes");

    for (const item of items) {
      try {
        const { match, reason } = await lookupAniListByTitle(item.title, item.release_date, (item as any).mal_id ?? null);

        if (!match) {
          if (reason === "rate_limit_429") {
            errors++;
            changes.push({ id: item.id, title: item.title, status: "error", reason });
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          no_match++;
          changes.push({ id: item.id, title: item.title, status: "no_match", reason });
        } else {
          if (!dryRun) {
            await conn.query(
              "UPDATE anime_items SET anilist_id = IF(anilist_id IS NULL, ?, anilist_id), " +
                "mal_id = IF(mal_id IS NULL AND ? IS NOT NULL, ?, mal_id) WHERE id = ?",
              [match.anilistId, match.malId, match.malId, item.id]
            );
          }
          matched++;
          changes.push({ id: item.id, title: item.title, status: "matched", match });
          app.log.info(
            { id: item.id, title: item.title, anilistId: match.anilistId, format: match.format, year: match.year },
            "Item enriched (anilist_id)"
          );
        }
      } catch (e) {
        errors++;
        changes.push({ id: item.id, title: item.title, status: "error", reason: (e as any)?.message || "exception" });
        app.log.warn({ id: item.id, err: (e as any)?.message }, "Lookup item failed");
      }

      await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));
    }

    app.log.info({ scanned: items.length, matched, no_match, errors, changesCount: changes.length }, "Lookup cycle termine");
    trackLastRun("lookup-cron", { scanned: items.length, matched, no_match, errors });
    if (matched > 0) pushActivity({ type: "lookup", message: `Phase C matched ${matched} items`, detail: `${items.length} scanned, ${no_match} no_match, ${errors} errors`, level: "info" });
  } finally {
    conn.release();
  }

  return { scanned: matched + no_match + errors, matched, no_match, errors, changes };
}

export async function adminLookupHandler(app: FastifyInstance, req: any, reply: any) {
  const releasedOnly = String(req.query?.releasedOnly ?? "false") === "true";
  const limit = Math.max(1, Math.min(500, parseInt(req.query?.limit ?? "200", 10) || 200));
  const dryRun = String(req.query?.dryRun ?? "false") === "true";

  const result = await lookupMissingIdsCycle(app, { releasedOnly, limit, dryRun });

  return reply.send({
    ok: true,
    options: { releasedOnly, limit, dryRun },
    scanned: result.scanned,
    matched: result.matched,
    no_match: result.no_match,
    errors: result.errors,
    sample_matches: result.changes.filter((c) => c.status === "matched").slice(0, 20),
    sample_no_matches: result.changes.filter((c) => c.status === "no_match").slice(0, 20),
    sample_errors: result.changes.filter((c) => c.status === "error").slice(0, 10),
  });
}

/**
 * Démarre le cron interne Phase C (1 cycle par heure).
 * Cherche les items sans anilist_id et tente de les enrichir via AniList search.
 * 1er run après 10 min (laisser Phase B tourner d'abord), puis toutes les heures.
 */
export function startLookupCron(app: FastifyInstance): NodeJS.Timeout {
  app.log.info(
    { intervalMs: LOOKUP_INTERVAL_MS, batchSize: LOOKUP_CRON_LIMIT },
    "Lookup cron demarre (Phase C)"
  );

  // 1er run après 10 min (laisser Phase B prendre le devant après le boot)
  setTimeout(() => {
    lookupMissingIdsCycle(app, { releasedOnly: false, limit: LOOKUP_CRON_LIMIT, dryRun: false }).catch(
      (e) => app.log.error({ err: e?.message }, "Lookup cycle error")
    );
  }, 10 * 60 * 1000);

  // Puis toutes les heures
  return setInterval(() => {
    lookupMissingIdsCycle(app, { releasedOnly: false, limit: LOOKUP_CRON_LIMIT, dryRun: false }).catch(
      (e) => app.log.error({ err: e?.message }, "Lookup cycle error")
    );
  }, LOOKUP_INTERVAL_MS);
}

