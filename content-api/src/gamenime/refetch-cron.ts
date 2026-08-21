/**
 * GameNime Phase B — Cron interne re-fetch des items incomplets
 */

import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { resoudreDistributeurYouTube } from "./youtube-verify.js";
import { sanitizePlatform, normalizeTitleStrict } from "./core.js";

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
  releaseDate?: string | null;        // "YYYY-MM-DD" (jour=01 si precision month/year)
  releasePrecision?: "day" | "month" | "year" | null;  // precision reelle selon la source
}

export async function fetchAniList(anilistId: number): Promise<SourceData | null> {
  if (!anilistId) return null;

  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { format description startDate { year month day } coverImage { extraLarge large } trailer { id site } externalLinks { site type url } streamingEpisodes { site } } }`;

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
          if (link.site === "YouTube") {
            // AniList etiquette "YouTube" sans preciser le distributeur.
            // On resout la vraie chaine : distributeur officiel -> son nom
            // (Muse Asia, Ani-One...) ; promo/PV -> retire (null).
            const distributeur = await resoudreDistributeurYouTube(link.url);
            if (distributeur) platforms.add(distributeur);
          } else {
            platforms.add(link.site);
          }
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
    // Deduire date + precision reelle depuis startDate AniList (day=null => precision month, month=null => year)
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    const sd = media.startDate;
    if (sd && sd.year) {
      const pad2 = (n: number) => String(n).padStart(2, "0");
      if (sd.month && sd.day) {
        releaseDate = sd.year + "-" + pad2(sd.month) + "-" + pad2(sd.day);
        releasePrecision = "day";
      } else if (sd.month) {
        releaseDate = sd.year + "-" + pad2(sd.month) + "-01";
        releasePrecision = "month";
      } else {
        releaseDate = sd.year + "-01-01";
        releasePrecision = "year";
      }
    }
    return { cover, platform, trailerUrl, description, format, releaseDate, releasePrecision };
  } catch (e) {
    return null;
  }
}

export async function fetchJikan(malId: number): Promise<SourceData | null> {
  if (!malId) return null;

  try {
    // /full contient streaming[] directement (Disney+, Hulu, ADN...) en UN seul
    // appel, plus stable que la fiche + /streaming separes (qui declenchaient un 429).
    let json: any = null;
    for (let attempt = 0; attempt < 3 && !json; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1200));
      try {
        const res = await fetch("https://api.jikan.moe/v4/anime/" + malId + "/full");
        if (res.ok) json = await res.json() as any;
      } catch { /* retry Jikan instable */ }
    }
    if (!json) return null;
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
    // Jikan : ATTENTION prop.from invente day:1/month:1 quand il ne connait que l'annee/mois.
    // La VRAIE precision est dans aired.string : "2027"=year, "Jul 2026"=month, "Jul 2, 2026"=day.
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    const from = data.aired?.prop?.from;
    const airedStr = String(data.aired?.string || "");
    if (from && from.year) {
      const pad2 = (n: number) => String(n).padStart(2, "0");
      // "Jul 2, 2026" (mois jour, annee) => day precis
      if (/^[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/.test(airedStr)) {
        releaseDate = from.year + "-" + pad2(from.month) + "-" + pad2(from.day);
        releasePrecision = "day";
      // "Jul 2026" (mois annee, sans jour) => month
      } else if (/^[A-Za-z]{3,}\s+\d{4}/.test(airedStr)) {
        releaseDate = from.year + "-" + pad2(from.month) + "-01";
        releasePrecision = "month";
      // "2027" ou autre (annee seule) => year
      } else {
        releaseDate = from.year + "-01-01";
        releasePrecision = "year";
      }
    }
    return { cover, platform, trailerUrl, description, releaseDate, releasePrecision };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rattachement des routes AnimeSchedule (session 33)
// ─────────────────────────────────────────────────────────────────────────
// refetch-cron UTILISE anime_schedule_route mais ne la CREE jamais : 243 animes
// sur 392 n'en ont pas, dont 91 avec popularity > 10000 (Frieren S2, Dandadan
// S3, Oshi no Ko S3...). Sans route, impossible de les croiser avec le
// timetable — ils n'apparaissent pas dans le radar hebdo.
// Validation stricte, comme lookupIgdbByTitle : titre normalise identique ET
// annee a plus ou moins 1. Plus d'un candidat -> on n'ecrit rien.
export async function lookupAnimeScheduleRoute(
  titre: string,
  annee: number | null,
  apiToken: string
): Promise<string | null> {
  if (!titre || !apiToken) return null;
  try {
    const url = "https://animeschedule.net/api/v3/anime?q=" + encodeURIComponent(titre);
    const res = await fetch(url, { headers: { Authorization: "Bearer " + apiToken } });
    if (!res.ok) return null;
    const txt = await res.text();
    if (!txt || txt.trim()[0] !== "{" && txt.trim()[0] !== "[") return null;
    const data = JSON.parse(txt) as any;
    const liste: any[] = Array.isArray(data) ? data : (data?.anime || []);
    if (!liste.length) return null;

    const vise = normalizeTitleStrict(titre);
    if (!vise) return null;
    let cands = liste.filter((a) => normalizeTitleStrict(String(a?.title || "")) === vise);
    if (annee) {
      const dansAnnee = cands.filter((a) => {
        const y = Number(a?.year || 0);
        return y > 0 && Math.abs(y - annee) <= 1;
      });
      if (dansAnnee.length > 0) cands = dansAnnee;
    }
    if (cands.length !== 1) return null;
    return String(cands[0].route || "") || null;
  } catch {
    return null;
  }
}

// Discord : silence quand il n'y a rien a signaler. Un message quotidien
// "0 route trouvee" polluerait le salon — on ne parle que si on a rattache
// quelque chose, ou si le cycle a echoue.
async function notifierRoutes(scanned: number, matched: number, erreur: string | null): Promise<void> {
  const url = erreur
    ? process.env.DISCORD_WEBHOOK_ERRORS
    : process.env.DISCORD_WEBHOOK_WORKFLOWS;
  if (!url) return;
  if (!erreur && matched === 0) return;
  const titre = erreur ? "❌ Routes AnimeSchedule" : "✅ Routes AnimeSchedule";
  const desc = erreur
    ? `Échec après ${scanned} anime(s) scanné(s), ${matched} rattaché(s).\n\`${erreur}\``
    : `**${matched}** route(s) rattachée(s) sur **${scanned}** anime(s) sans route.`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: titre,
          description: desc,
          color: erreur ? 15158332 : 3066993,
          footer: { text: "GameNime · Cron quotidien" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch {
    /* le suivi ne doit jamais faire echouer le cycle */
  }
}

export async function matchAnimeRoutesCycle(app: FastifyInstance): Promise<{
  scanned: number;
  matched: number;
}> {
  const DRY_RUN = false;
  const token = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool || !token) {
    app.log.warn("Match routes cycle: pool ou token absent");
    return { scanned: 0, matched: 0 };
  }
  const debut = Date.now();
  const conn = await pool.getConnection();
  let scanned = 0, matched = 0;
  try {
    const items: any[] = await conn.query(
      "SELECT id, title, YEAR(release_date) AS annee FROM anime_items " +
      "WHERE (anime_schedule_route IS NULL OR anime_schedule_route = '') " +
      "AND title IS NOT NULL AND title != '' " +
      "ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
    );
    scanned = items.length;
    for (const it of items) {
      const route = await lookupAnimeScheduleRoute(it.title, it.annee || null, token);
      if (route) {
        matched++;
        if (DRY_RUN) {
          app.log.info({ id: it.id, title: it.title, route }, "[DRY_RUN] route trouvee");
        } else {
          await conn.query("UPDATE anime_items SET anime_schedule_route = ? WHERE id = ?", [route, it.id]);
          app.log.info({ id: it.id, title: it.title, route }, "route AnimeSchedule rattachee");
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    app.log.info({ scanned, matched, dryRun: DRY_RUN }, "Match routes cycle: termine");
    trackLastRun("match-anime-routes", { scanned, matched, dryRun: DRY_RUN }, Date.now() - debut);
    if (matched > 0) {
      pushActivity({
        type: "routes",
        message: `${matched} route${matched > 1 ? "s" : ""} AnimeSchedule rattachée${matched > 1 ? "s" : ""}`,
        detail: `${scanned} anime${scanned > 1 ? "s" : ""} scanné${scanned > 1 ? "s" : ""} sans route`,
        level: "info",
      });
    }
    await notifierRoutes(scanned, matched, null);
  } catch (e: any) {
    app.log.error({ err: e?.message }, "Match routes cycle: erreur");
    trackLastRun("match-anime-routes", { scanned, matched, error: e?.message }, Date.now() - debut);
    pushActivity({
      type: "routes",
      message: "Échec du rattachement des routes",
      detail: e?.message ?? "erreur inconnue",
      level: "error",
    });
    await notifierRoutes(scanned, matched, e?.message ?? "erreur inconnue");
  } finally {
    conn.release();
  }
  return { scanned, matched };
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
    // AnimeSchedule : champ 'premier' = vraie date de sortie (jour). Les autres
    // (subPremier, jpnTime, subTime...) sont des sentinels 0001-01-01 => ignores.
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    const premier = data.premier;
    if (typeof premier === "string" && !premier.startsWith("0001-01-01")) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(premier);
      if (m) {
        releaseDate = m[1] + "-" + m[2] + "-" + m[3];
        releasePrecision = "day";  // premier donne toujours le jour
      }
    }
    return { cover, platform, trailerUrl: null, description, releaseDate, releasePrecision };
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

// Une plateforme est "faible" si elle est absente ou reduite au seul YouTube
// (souvent la chaine promo, pas un vrai diffuseur). Definition unique, reutilisee
// par le cron, le refetch unitaire et la fusion des sources.
export function isPlatformWeak(p: string | null | undefined): boolean {
  // Weak si vide, OU si contient "YouTube" brut (seul ou en liste). AniList
  // etiquette "YouTube" sans distributeur ; un re-fetch resout ce YouTube en
  // nom de distributeur (Muse Asia...) ou le retire. Detecter YouTube n'importe
  // ou dans la chaine permet au re-fetch de corriger les 103 animes pollues.
  // Converge : apres resolution, plus de "YouTube" brut -> plus weak.
  if (!p || p.trim() === "") return true;
  return /(^|,\s*)YouTube(\s*,|\s*$)/.test(p.trim());
}
export function mergeSources(
  aniList: SourceData | null,
  jikan: SourceData | null,
  animeSchedule: SourceData | null
): SourceData {
  const sources = [aniList, jikan, animeSchedule].filter(s => s !== null) as SourceData[];
  // AnimeSchedule est volontairement limitee a la date et, en dernier recours, a la
  // plateforme : ses covers sont des hotlinks (cf. isHotlinkCover) et son vocabulaire
  // de format n'est pas normalise sur l'enum AniList.
  const primary = [aniList, jikan].filter(s => s !== null) as SourceData[];
  // Date : preferer la source avec la MEILLEURE precision (day > month > year).
  // AniList prioritaire a precision egale (ordre du tableau : aniList d'abord).
  const precRank: Record<string, number> = { day: 3, month: 2, year: 1 };
  let bestDate: string | null = null;
  let bestPrecision: "day" | "month" | "year" | null = null;
  for (const s of sources) {
    if (s.releaseDate && s.releasePrecision) {
      if (bestPrecision === null || precRank[s.releasePrecision] > precRank[bestPrecision]) {
        bestDate = s.releaseDate;
        bestPrecision = s.releasePrecision;
      }
    }
  }
  // Plateformes : FUSIONNER toutes les sources (pas juste la premiere).
  // AniList a souvent que "YouTube", Jikan a les vraies (Disney+, Hulu, ADN...).
  // On combine tout en dedupliquant.
  const platformSet = new Set<string>();
  const addPlatforms = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const p of raw.split(",").map(x => x.trim()).filter(Boolean)) platformSet.add(p);
  };
  for (const s of primary) addPlatforms(s.platform);
  const mergedPlatform = platformSet.size > 0 ? Array.from(platformSet).join(", ") : null;
  // AnimeSchedule ne contribue PAS aux plateformes : sur un echantillon de 12 items
  // sans plateforme, un seul remontait un stream, et c'etait "YouTube" — donc une
  // valeur deja consideree comme faible, qui aurait masque le libelle "Plateforme EU
  // non annoncee" par un diffuseur ou l'utilisateur ne trouverait rien.
  // Perimetre de cette source : la date de sortie, et elle seule.
  return {
    cover: primary.find(s => s.cover)?.cover ?? null,
    platform: mergedPlatform,
    trailerUrl: primary.find(s => s.trailerUrl)?.trailerUrl ?? null,
    description: primary.find(s => s.description)?.description ?? null,
    format: primary.find(s => s.format)?.format ?? null,
    releaseDate: bestDate,
    releasePrecision: bestPrecision,
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
      "SELECT id, title, anilist_id, mal_id, anime_schedule_route, cover, platform, trailer_url, description, format, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, release_precision FROM anime_items WHERE (platform IS NULL OR platform = '' OR TRIM(platform) = 'YouTube' OR cover IS NULL OR cover = '' OR trailer_url IS NULL OR trailer_url = '' OR description IS NULL OR description = '' OR LENGTH(TRIM(description)) < 10 OR cover LIKE '%myanimelist.net%' OR cover LIKE '%animeschedule.net%' OR format IS NULL OR format = '' OR release_precision IS NULL OR release_precision <> 'day') AND (anilist_id IS NOT NULL OR mal_id IS NOT NULL OR anime_schedule_route IS NOT NULL) AND release_date >= CURDATE() - INTERVAL 365 DAY ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
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
    app.log.info({ jikanPlatform: jikan?.platform, aniListPlatform: aniList?.platform, mergedPlatform: merged.platform, itemPlatform: item.platform }, "DEBUG platform merge");

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
        const platformIsWeak = isPlatformWeak(item.platform);
        const cleanPlatform = sanitizePlatform(merged.platform);
        if (platformIsWeak && cleanPlatform && cleanPlatform !== item.platform) {
          updates.push("platform = ?");
          params.push(cleanPlatform);
          itemChanges.push({ field: "platform", oldValue: item.platform, newValue: cleanPlatform });
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

        // DATE : objectif = converger vers precision 'day'. Ne JAMAIS regresser.
        // Update si precision MEILLEURE (day>month>year) ou date differente a precision egale.
        // Etat Clean : la SOURCE fait autorite. Adopte sa date des qu'elle differe
        // (precision OU jour), dans les 2 sens. Corrige les faux 'day' (ex: 2027-01-01
        // day -> year quand la source ne connait que l'annee).
        if (merged.releaseDate && merged.releasePrecision) {
          const dateChanged = merged.releaseDate !== (item as any).release_date;
          const precChanged = merged.releasePrecision !== (item as any).release_precision;
          if (dateChanged || precChanged) {
            updates.push("release_date = ?");
            params.push(merged.releaseDate);
            updates.push("release_precision = ?");
            params.push(merged.releasePrecision);
            itemChanges.push({ field: "release_date", oldValue: (item as any).release_date + " (" + ((item as any).release_precision || "?") + ")", newValue: merged.releaseDate + " (" + merged.releasePrecision + ")" });
          }
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

  // Rattachement des routes AnimeSchedule (session 33).
  // Rythme quotidien, pas horaire : il ne traite que les nouveaux entrants,
  // et chaque item coute un appel API avec 400 ms d'attente. Une saison
  // d'anime apporte quelques dizaines de titres tous les trois mois.
  const ROUTES_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    matchAnimeRoutesCycle(app).catch(e => app.log.error({ err: e?.message }, "Match routes cycle error"));
  }, 12 * 60 * 1000);
  setInterval(() => {
    matchAnimeRoutesCycle(app).catch(e => app.log.error({ err: e?.message }, "Match routes cycle error"));
  }, ROUTES_INTERVAL_MS);

  return setInterval(() => {
    refetchIncompleteCycle(app).catch(e => app.log.error({ err: e?.message }, "Refetch cycle error"));
  }, REFETCH_INTERVAL_MS);
}

// SESSION 18: Refetch UN seul item anime par ID (pour le bouton "Réparer" admin)
export async function refetchOneAnimeItem(app: FastifyInstance, id: number): Promise<{
  ok: boolean; found: boolean; enriched: boolean; title?: string; fields: string[]; error?: string;
}> {
  const animeScheduleToken = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool) return { ok: false, found: false, enriched: false, fields: [], error: "pool DB introuvable" };
  const conn = await pool.getConnection();
  try {
    const rows: IncompleteItem[] = await conn.query(
      "SELECT id, title, anilist_id, mal_id, anime_schedule_route, cover, platform, trailer_url, description, format, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, release_precision FROM anime_items WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows || rows.length === 0) {
      return { ok: true, found: false, enriched: false, fields: [] };
    }
    const item = rows[0];
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
    const fields: string[] = [];
    const coverIsEmpty = !item.cover || item.cover === "";
    const coverIsHotlinkProtected = isHotlinkProtectedCover(item.cover);
    const newCoverFromAniList = aniList?.cover && isAniListCover(aniList.cover);
    if (coverIsEmpty && merged.cover) {
      updates.push("cover = ?"); params.push(merged.cover); fields.push("cover");
    } else if (coverIsHotlinkProtected && newCoverFromAniList) {
      updates.push("cover = ?"); params.push(aniList!.cover); fields.push("cover");
    }
    const platformIsWeakOne = isPlatformWeak(item.platform);
    const cleanPlatformOne = sanitizePlatform(merged.platform);
    if (platformIsWeakOne && cleanPlatformOne && cleanPlatformOne !== item.platform) {
      updates.push("platform = ?"); params.push(cleanPlatformOne); fields.push("plateforme");
    }
    if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
      updates.push("trailer_url = ?"); params.push(merged.trailerUrl); fields.push("trailer");
    }
    const descIsMissing = !item.description || item.description === "" || (typeof item.description === "string" && item.description.trim().length < 10);
    if (descIsMissing && merged.description) {
      updates.push("description = ?"); params.push(merged.description); fields.push("description");
    }
    const formatIsMissing = !item.format || item.format === "";
    if (formatIsMissing && merged.format) {
      updates.push("format = ?"); params.push(merged.format); fields.push("format");
    }
    // DATE : objectif = converger vers precision 'day'. Ne JAMAIS regresser.
    // Etat Clean : la SOURCE fait autorite. Adopte sa date des qu'elle differe (2 sens).
    if (merged.releaseDate && merged.releasePrecision) {
      const dateChanged = merged.releaseDate !== (item as any).release_date;
      const precChanged = merged.releasePrecision !== (item as any).release_precision;
      if (dateChanged || precChanged) {
        updates.push("release_date = ?"); params.push(merged.releaseDate);
        updates.push("release_precision = ?"); params.push(merged.releasePrecision);
        fields.push("date:" + merged.releaseDate + "(" + merged.releasePrecision + ")");
      }
    }
    if (updates.length > 0) {
      params.push(item.id);
      await conn.query("UPDATE anime_items SET " + updates.join(", ") + " WHERE id = ?", params);
      app.log.info({ id: item.id, fields }, "refetchOne anime enriched");
      return { ok: true, found: true, enriched: true, title: item.title, fields };
    }
    return { ok: true, found: true, enriched: false, title: item.title, fields: [] };
  } catch (e) {
    return { ok: false, found: true, enriched: false, fields: [], error: (e as any)?.message || "erreur" };
  } finally {
    conn.release();
  }
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
