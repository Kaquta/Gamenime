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
import { igdbLog, setIgdbWarnPool, igdbFetch } from "./twitch.js";
import { normalizeTitleStrict as gnNormalizeTitleStrict, sanitizePlatform as gnSanitizePlatform, matchWindowDays as gnMatchWindowDays } from "./core.js";

const REFETCH_INTERVAL_MS = 60 * 60 * 1000; // 1h
const REFETCH_BATCH_SIZE = 100;
const REFETCH_DELAY_MS = 800;
// Appariement des orphelins : filet de rattrapage, pas temps-reel.
// De nouveaux gros titres sans ID n'arrivent pas toutes les heures -> 3h.
const ORPHAN_MATCH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h

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
  game_type: string | null;
}

interface SourceData {
  cover?: string | null;
  platform?: string | null;
  trailerUrl?: string | null;
  description?: string | null;
  ratingScore?: number | null;
  gameType?: string | null;
  slug?: string | null;
  releaseDate?: string | null;        // "YYYY-MM-DD" (jour=01 si precision month/year)
  releasePrecision?: "day" | "month" | "year" | null;  // precision reelle selon la source
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
    // RAWG : "released" = YYYY-MM-DD, "tba" = date non annoncee. RAWG n'expose
    // AUCUNE precision : un jeu "prevu 2027" y apparait souvent au 31/12. On ne
    // peut donc pas certifier le jour -> precision "day" seulement si la date
    // n'est pas un placeholder (31/12 ou 01/01), sinon "year". IGDB (qui a le
    // champ human) prime de toute facon dans mergeSources a precision egale.
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    if (!data?.tba && typeof data?.released === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.released)) {
      releaseDate = data.released;
      const mmdd = data.released.slice(5);
      releasePrecision = (mmdd === "12-31" || mmdd === "01-01") ? "year" : "day";
      if (releasePrecision === "year") releaseDate = data.released.slice(0, 4) + "-01-01";
    }
    return {
      cover,
      platform,
      description: description ? String(description).substring(0, 2000) : null,
      ratingScore: ratingMetacritic,
      slug: data?.slug ?? null,
      releaseDate,
      releasePrecision,
    };
  } catch {
    return null;
  }
}

/**
 * IGDB : recupere via Twitch OAuth + IGDB API
 * Token Twitch cache ~60 jours (re-fetch automatique a l expiration)
 */

/**
 * Cherche un jeu IGDB par son SLUG RAWG (ancre fiable, pas de match par titre).
 * Securites : exactement UN resultat + slug strictement identique, sinon null.
 * Mieux vaut un champ vide qu une donnee fausse.
 */
export async function lookupIgdbBySlug(slug: string): Promise<number | null> {
  if (!slug) return null;
  const safe = slug.replace(/["\\]/g, "");
  try {
    const res = await igdbFetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `fields id, slug; where slug = "${safe}"; limit 2;`,
    });
    if (!res.ok) { igdbLog("warn", "slug_http", { slug, status: res.status }); return null; }
    const data = await res.json() as any;
    if (!Array.isArray(data) || data.length !== 1) { igdbLog("info", "slug_absent", { slug, trouves: Array.isArray(data) ? data.length : -1 }); return null; }
    if (data[0]?.slug !== slug) { igdbLog("info", "slug_different", { slug, recu: data[0]?.slug }); return null; }
    return Number(data[0].id) || null;
  } catch (e) {
    igdbLog("warn", "slug_exception", { slug, err: (e as any)?.message });
    return null;
  }
}

// Repli quand le slug RAWG ne correspond a aucun slug IGDB : IGDB suffixe les
// siens pour desambiguer (ex. "tomak-save-the-earth-regeneration--1" quand un
// autre jeu porte un titre proche). On recherche alors par titre.
// Garde-fous : titre normalise STRICTEMENT identique, et un seul candidat.
// Zero candidat = inconnu, deux ou plus = ambigu — dans les deux cas on
// n'ecrit rien. Un champ vide vaut mieux qu'une plateforme fausse.
export async function lookupIgdbByTitle(
  title: string,
  releaseDate?: string | null,
  releasePrecision?: string | null,
): Promise<number | null> {
  if (!title) return null;
  const safe = String(title).replace(/["\\]/g, "");
  try {
    const res = await igdbFetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `search "${safe}"; fields id, name, first_release_date; limit 20;`,
    });
    if (!res.ok) { igdbLog("warn", "titre_http", { title, status: res.status }); return null; }
    const data = await res.json() as any;
    if (!Array.isArray(data) || data.length === 0) { igdbLog("info", "titre_aucun_resultat", { title }); return null; }
    const wanted = gnNormalizeTitleStrict(title);
    if (!wanted) return null;
    let exact = data.filter((g: any) => gnNormalizeTitleStrict(String(g?.name || "")) === wanted);
    // Filtre par fenetre de dates dynamique (largeur selon precision, detection placeholder 12-31/01-01).
    // Applique seulement si une date de reference existe ET s'il reste plusieurs candidats a departager.
    // Filtre par fenetre de dates : s'applique des qu'il y a AU MOINS un candidat
    // exact (pas seulement plusieurs). Sinon un candidat unique hors periode passait
    // sans controle (cas Dusk : entree 2026 vs seul "Dusk" IGDB date 2018).
    if (releaseDate && exact.length >= 1) {
      const refMs = new Date(releaseDate + "T00:00:00Z").getTime();
      const tolMs = gnMatchWindowDays(releaseDate, releasePrecision as any) * 86400000;
      const withDate = exact.filter((g: any) => g.first_release_date);
      const windowed = withDate.filter((g: any) =>
        Math.abs(g.first_release_date * 1000 - refMs) <= tolMs
      );
      //  - Au moins un candidat DANS la fenetre -> on resserre dessus.
      //  - Des candidats ONT une date mais AUCUN dans la fenetre -> ces dates disent
      //    "hors periode" : REJET (exact=[]) -> "ambigu ou absent", zero ecriture (Dusk).
      //  - Aucun candidat n'a de date IGDB -> donnee manquante, on garde tel quel.
      if (windowed.length > 0) {
        exact = windowed;
      } else if (withDate.length > 0) {
        exact = [];
      }
    }
    if (exact.length !== 1) { igdbLog("info", "titre_ambigu_ou_absent", { title, candidats_exacts: exact.length, resultats: data.length }); return null; }
    igdbLog("info", "titre_rattache", { title, igdbId: exact[0].id });
    return Number(exact[0].id) || null;
  } catch (e) {
    igdbLog("warn", "titre_exception", { title, err: (e as any)?.message });
    return null;
  }
}

export async function fetchIgdb(igdbId: number): Promise<SourceData | null> {
  if (!igdbId) return null;
  try {
    const res = await igdbFetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `fields name, summary, storyline, cover.image_id, platforms.name, rating, total_rating, game_type, videos.video_id, videos.name, release_dates.human, release_dates.date; where id = ${igdbId};`,
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
    // IGDB game_type (nouveau champ, remplace category deprecie).
    // Taggue "DLC" (choix Rey) : 1=DLC, 2=Expansion, 4=Standalone Expansion,
    // 6=Episode, 7=Season, 13=Pack/Addon (couvre Character/Map/Skin Pack,
    // Story Expansion), 14=Update. Restent jeux de base (null) :
    // 0=Main, 3=Bundle, 5=Mod, 8=Remake, 9=Remaster, 10=Expanded, 11=Port, 12=Fork.
    const gt = game.game_type;
    const gameType = [1, 2, 4, 6, 7, 13, 14].includes(gt) ? "DLC" : null;
    // Trailer IGDB : priorite "Launch", puis dernier "Trailer", sinon derniere
    // video. Ne comble que les trous (le code appelant n ecrit que si vide).
    let trailerUrl: string | null = null;
    if (Array.isArray(game.videos) && game.videos.length > 0) {
      const par = (re: RegExp) => game.videos.filter((v: any) => re.test(String(v?.name || "")));
      const choix = par(/launch/i)[0] || par(/trailer/i).slice(-1)[0] || game.videos[game.videos.length - 1];
      if (choix?.video_id) trailerUrl = "https://www.youtube.com/watch?v=" + choix.video_id;
    }
    return {
      cover,
      platform: platforms,
      description: description ? String(description).substring(0, 2000) : null,
      ratingScore,
      gameType,
      trailerUrl,
      ...(() => { const dd = choisirDateIgdb(game.release_dates); return { releaseDate: dd.date, releasePrecision: dd.precision }; })(),
    };
  } catch {
    return null;
  }
}


// Parse le champ "human" d'IGDB pour deduire la VRAIE precision :
// "2027"=year, "Q1 2027"=year, "Feb 2027"=month, "Feb 18, 2027"=day.
// IGDB stocke un placeholder au 31/12 quand il ne connait que l'annee : sans ce
// parsing on presenterait "31 decembre 2027" comme une date ferme (mensonge).
function parseDateIgdb(human: string, ts: number | null): { date: string | null; precision: "day" | "month" | "year" | null } {
  if (!ts) return { date: null, precision: null };
  const d = new Date(ts * 1000);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const h = String(human || "").trim();
  if (/^[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/.test(h)) {
    return { date: y + "-" + pad2(m) + "-" + pad2(day), precision: "day" };
  }
  if (/^[A-Za-z]{3,}\s+\d{4}/.test(h)) {
    return { date: y + "-" + pad2(m) + "-01", precision: "month" };
  }
  return { date: y + "-01-01", precision: "year" };
}

// Choisit la meilleure date parmi les release_dates IGDB : la plus PRECOCE encore
// a venir (evite la date asiatique passee, cf. Aion 2 : KR nov 2025 vs EU sep 2026).
// Si toutes sont passees, prend la plus recente.
function choisirDateIgdb(rds: any[]): { date: string | null; precision: "day" | "month" | "year" | null } {
  if (!Array.isArray(rds) || rds.length === 0) return { date: null, precision: null };
  const now = Math.floor(Date.now() / 1000);
  const valides = rds.filter(r => r?.date);
  if (valides.length === 0) return { date: null, precision: null };
  const futures = valides.filter(r => r.date > now).sort((a, b) => a.date - b.date);
  const choix = futures[0] || valides.sort((a, b) => b.date - a.date)[0];
  return parseDateIgdb(choix.human, choix.date);
}

function mergeSources(rawg: SourceData | null, igdb: SourceData | null): SourceData {
  const sources = [rawg, igdb].filter(s => s !== null) as SourceData[];
  return {
    cover: sources.find(s => s.cover)?.cover ?? null,
    platform: sources.find(s => s.platform)?.platform ?? null,
    description: sources.find(s => s.description)?.description ?? null,
    ratingScore: sources.find(s => s.ratingScore != null)?.ratingScore ?? null,
    gameType: sources.find(s => s.gameType)?.gameType ?? null,
    trailerUrl: sources.find(s => s.trailerUrl)?.trailerUrl ?? null,
    ...(() => {
      // Date : preferer la source avec la MEILLEURE precision (day > month > year).
      // IGDB prime a precision egale (il a le champ human, RAWG ne l'a pas).
      const rang: Record<string, number> = { day: 3, month: 2, year: 1 };
      let best: SourceData | null = null;
      for (const s of [igdb, rawg]) {
        if (!s?.releaseDate || !s?.releasePrecision) continue;
        if (!best || rang[s.releasePrecision] > rang[best.releasePrecision!]) best = s;
      }
      return { releaseDate: best?.releaseDate ?? null, releasePrecision: best?.releasePrecision ?? null };
    })(),
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
      "SELECT id, title, rawg_id, igdb_id, cover, platform, trailer_url, description, rating_score, game_type, DATE_FORMAT(release_date,'%Y-%m-%d') AS release_date, release_precision " +
      "FROM game_items " +
      // Criteres calibres (session 27, repris de gnAuditGame) : seuls cover,
      // plateforme et description sont de vrais manques. rating_score NULL est
      // normal avant la sortie (pas de reviews) et game_type NULL signifie
      // "jeu standard, pas un DLC" — les inclure mettait 433 jeux sur 477 dans
      // la file, noyant les 3 items reellement sans plateforme.
      // Les covers rawg/igdb sont les VRAIES covers, pas des hotlinks.
      "WHERE (cover IS NULL OR cover = '' OR platform IS NULL OR platform = '' OR description IS NULL OR LENGTH(TRIM(description)) < 10) " +
      "AND (rawg_id IS NOT NULL OR igdb_id IS NOT NULL) " +
      // Anti-boucle modulee par l'urgence : un jeu qui sort dans moins de 30 jours
      // est reessaye chaque jour, les autres tous les 7 jours. Sans ca, un echec
      // passager (fiche source absente, token expire) sur un item proche de sa
      // sortie reste fige une semaine — cas Aisle Survive, sans plateforme jusqu'a
      // la veille de sa sortie alors que la file du cron etait vide.
      "AND (last_refetch_at IS NULL " +
      "     OR (release_date IS NOT NULL " +
      "         AND release_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY " +
      "         AND last_refetch_at < NOW() - INTERVAL 1 DAY) " +
      "     OR last_refetch_at < NOW() - INTERVAL 7 DAY) " +
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
        let merged = mergeSources(rawg, igdb);
        // FALLBACK IGDB par slug : RAWG a repondu mais laisse la plateforme vide,
        // et le jeu n a pas d igdb_id -> le rattacher via son slug RAWG (ancre fiable).
        // Aucun appel RAWG supplementaire (le slug vient de la reponse deja recue).
        if (!item.igdb_id && !merged.platform && rawg?.slug) {
          const foundId = await lookupIgdbBySlug(rawg.slug) || await lookupIgdbByTitle(item.title);
          if (foundId) {
            app.log.info({ id: item.id, title: item.title, slug: rawg.slug, igdbId: foundId }, "IGDB rattache par slug");
            await conn.query("UPDATE game_items SET igdb_id = ? WHERE id = ?", [foundId, item.id]);
            const igdbData = await fetchIgdb(foundId);
            if (igdbData) merged = mergeSources(rawg, igdbData);
          }
        }

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
        // IGDB renvoie "PC (Microsoft Windows)" la ou la base attend "PC".
        merged.platform = gnSanitizePlatform(merged.platform);
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
        // game_type (lossless - on remplit si vide)
        if ((item.game_type == null || item.game_type === "") && merged.gameType) {
          updates.push("game_type = ?");
          params.push(merged.gameType);
          itemChanges.push({ field: "game_type", oldValue: item.game_type, newValue: merged.gameType });
        }

        // Marquer TOUJOURS last_refetch_at (meme si rien a enrichir) :
        // un jeu de base (game_type null legitime) est ainsi verifie une fois
        // puis laisse tranquille 7 jours -> casse la boucle infinie sur RAWG.
        if (updates.length > 0) {
          updates.push("last_refetch_at = NOW()");
          params.push(item.id);
          await conn.query("UPDATE game_items SET " + updates.join(", ") + " WHERE id = ?", params);
          enriched++;
          for (const ch of itemChanges) {
            changes.push({ id: item.id, title: item.title, ...ch });
          }
          app.log.info({ id: item.id, title: item.title, fields: itemChanges.map(c => c.field) }, "Game enriched");
        } else {
          // Rien a enrichir, mais on marque quand meme la verification.
          await conn.query("UPDATE game_items SET last_refetch_at = NOW() WHERE id = ?", [item.id]);
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

// SESSION 18: Refetch UN seul jeu par ID (pour le bouton "Réparer" admin)
export async function refetchOneGameItem(app: FastifyInstance, id: number): Promise<{
  ok: boolean; found: boolean; enriched: boolean; title?: string; fields: string[]; error?: string;
}> {
  const pool = (app as any).pool;
  if (!pool) return { ok: false, found: false, enriched: false, fields: [], error: "pool DB introuvable" };
  const conn = await pool.getConnection();
  try {
    const rows: IncompleteGame[] = await conn.query(
      "SELECT id, title, rawg_id, igdb_id, cover, platform, trailer_url, description, rating_score, game_type, DATE_FORMAT(release_date,'%Y-%m-%d') AS release_date, release_precision FROM game_items WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows || rows.length === 0) {
      return { ok: true, found: false, enriched: false, fields: [] };
    }
    const item = rows[0];
    const [rawg, igdb] = await Promise.all([
      item.rawg_id ? fetchRawg(item.rawg_id) : null,
      item.igdb_id ? fetchIgdb(item.igdb_id) : null,
    ]);
    let merged = mergeSources(rawg, igdb);
    // FALLBACK IGDB par slug (meme logique que le cron).
    if (!item.igdb_id && !merged.platform && rawg?.slug) {
      const foundId = await lookupIgdbBySlug(rawg.slug) || await lookupIgdbByTitle(item.title);
      if (foundId) {
        app.log.info({ id: item.id, title: item.title, slug: rawg.slug, igdbId: foundId }, "IGDB rattache par slug");
        await conn.query("UPDATE game_items SET igdb_id = ? WHERE id = ?", [foundId, item.id]);
        const igdbData = await fetchIgdb(foundId);
        if (igdbData) merged = mergeSources(rawg, igdbData);
      }
    }
    const updates: string[] = [];
    const params: any[] = [];
    const fields: string[] = [];
    const coverIsEmpty = !item.cover || item.cover === "";
    const coverFromTrustedCdn = item.cover && (item.cover.includes("media.rawg.io") || item.cover.includes("images.igdb.com"));
    if (merged.cover && (coverIsEmpty || coverFromTrustedCdn)) {
      if (merged.cover !== item.cover) {
        updates.push("cover = ?"); params.push(merged.cover); fields.push("cover");
      }
    }
    if ((!item.platform || item.platform === "") && merged.platform) {
      updates.push("platform = ?"); params.push(gnSanitizePlatform(merged.platform)); fields.push("plateforme");
    }
    const descIsMissing = !item.description || item.description === "" || (typeof item.description === "string" && item.description.trim().length < 10);
    if (descIsMissing && merged.description) {
      updates.push("description = ?"); params.push(merged.description); fields.push("description");
    }
    if (item.rating_score == null && merged.ratingScore != null) {
      updates.push("rating_score = ?"); params.push(merged.ratingScore); fields.push("rating");
    }
    if ((item.game_type == null || item.game_type === "") && merged.gameType) {
      updates.push("game_type = ?"); params.push(merged.gameType); fields.push("type");
    }
    if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
      updates.push("trailer_url = ?"); params.push(merged.trailerUrl); fields.push("trailer");
    }
    // DATE : la source fait autorite, MAIS on ne regresse jamais en precision
    // (day acquis ne redevient pas year). On ecrit si la date OU la precision
    // change, pour capter un report ou une date qui se precise.
    if (merged.releaseDate && merged.releasePrecision) {
      const rang: Record<string, number> = { day: 3, month: 2, year: 1 };
      const ancienne = (item as any).release_date || null;
      const ancienneP = (item as any).release_precision || null;
      // Un 31/12 ou 01/01 stocke en precision "day" est un PLACEHOLDER IGDB
      // ("prevu 2027" fige au 31 decembre), pas une vraie date au jour pres.
      // On autorise donc la regression dans ce cas precis, sinon un faux "day"
      // se protegerait lui-meme et resterait faux a vie.
      const mmdd = String(ancienne || "").slice(5);
      const ancienneEstPlaceholder = ancienneP === "day" && (mmdd === "12-31" || mmdd === "01-01");
      const regresse = ancienneP && !ancienneEstPlaceholder && rang[merged.releasePrecision] < rang[ancienneP];
      if (!regresse && (merged.releaseDate !== ancienne || merged.releasePrecision !== ancienneP)) {
        updates.push("release_date = ?"); params.push(merged.releaseDate);
        updates.push("release_precision = ?"); params.push(merged.releasePrecision);
        fields.push("date:" + merged.releaseDate + "(" + merged.releasePrecision + ")");
      }
    }
    if (updates.length > 0) {
      params.push(item.id);
      await conn.query("UPDATE game_items SET " + updates.join(", ") + " WHERE id = ?", params);
      app.log.info({ id: item.id, fields }, "refetchOne game enriched");
      return { ok: true, found: true, enriched: true, title: item.title, fields };
    }
    return { ok: true, found: true, enriched: false, title: item.title, fields: [] };
  } catch (e) {
    return { ok: false, found: true, enriched: false, fields: [], error: (e as any)?.message || "erreur" };
  } finally {
    conn.release();
  }
}

export async function adminRefetchGamesHandler(req: any, reply: any) {
  const k1 = process.env.ADMIN_API_KEY;
  const k2 = process.env.ANIME_API_KEY;
  const k3 = process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const valid = (k1 && provided === k1) || (k2 && provided === k2) || (k3 && provided === k3);
  if (!valid) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const result = await refetchIncompleteGamesCycle(req.server);
  return reply.send({ ok: true, ...result });
}

// ─────────────────────────────────────────────────────────────────────────
// Appariement des jeux ORPHELINS (sans aucun ID source).
// Un jeu sans rawg_id NI igdb_id echappe a toute la dedup par ID et n'est
// jamais enrichi (le refetch principal exige un ID de depart). On tente de
// lui attribuer un igdb_id par appariement titre + fenetre de dates dynamique
// (largeur selon release_precision, detection placeholder 12-31/01-01).
// Une fois l'igdb_id pose, le jeu bascule sous le match-par-ID (filet fort).
// LECTURE SEULE pour l'instant : logue sans ecrire (DRY_RUN=true).
// ─────────────────────────────────────────────────────────────────────────
export async function matchOrphanGamesCycle(app: FastifyInstance): Promise<{
  scanned: number;
  matched: number;
  changes: Array<{ id: number; title: string; igdbId: number }>;
}> {
  const DRY_RUN = false; // ECRITURE ACTIVE (valide sur 90 apparies : Dusk-like rejetes, Parallel->bon, 0 sans-date)
  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Match orphans cycle: pool DB introuvable");
    return { scanned: 0, matched: 0, changes: [] };
  }
  const conn = await pool.getConnection();
  let scanned = 0, matched = 0;
  const changes: Array<{ id: number; title: string; igdbId: number }> = [];
  try {
    const items: any[] = await conn.query(
      "SELECT id, title, DATE_FORMAT(release_date,'%Y-%m-%d') AS release_date, release_precision " +
      "FROM game_items " +
      "WHERE igdb_id IS NULL AND rawg_id IS NULL " +
      "AND title IS NOT NULL AND title != '' " +
      "ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
    );
    scanned = items.length;
    app.log.info({ scanned, dryRun: DRY_RUN }, "Match orphans cycle: jeux sans ID scannes");
    for (const item of items) {
      const igdbId = await lookupIgdbByTitle(item.title, item.release_date, item.release_precision);
      if (igdbId) {
        matched++;
        changes.push({ id: item.id, title: item.title, igdbId });
        if (DRY_RUN) {
          app.log.info({ id: item.id, title: item.title, igdbId }, "[DRY_RUN] apparierait");
        } else {
          await conn.query("UPDATE game_items SET igdb_id = ? WHERE id = ?", [igdbId, item.id]);
          app.log.info({ id: item.id, title: item.title, igdbId }, "orphelin rattache par titre");
        }
      }
      await new Promise(r => setTimeout(r, REFETCH_DELAY_MS));
    }
    app.log.info({ scanned, matched, dryRun: DRY_RUN }, "Match orphans cycle: termine");
  } catch (e: any) {
    app.log.error({ err: e?.message }, "Match orphans cycle: erreur");
  } finally {
    conn.release();
  }
  return { scanned, matched, changes };
}

export function startRefetchGamesCron(app: FastifyInstance) {
  app.post("/admin/refetch-incomplete-games", adminRefetchGamesHandler);
  setIgdbWarnPool((app as any).pool);
  setTimeout(() => {
    refetchIncompleteGamesCycle(app).catch(e => app.log.error(e, "First Games refetch cycle failed"));
  }, 15 * 60 * 1000); // First run after 15 min (let Phase B anime run first)
  setInterval(() => {
    refetchIncompleteGamesCycle(app).catch(e => app.log.error(e, "Games refetch cycle failed"));
  }, REFETCH_INTERVAL_MS);
  // Appariement des jeux orphelins (sans aucun ID) : premier run a 30 min, puis toutes les 3h.
  // Attribue un igdb_id par titre + fenetre dynamique -> le jeu bascule sous le match-par-ID.
  setTimeout(() => {
    matchOrphanGamesCycle(app).catch(e => app.log.error(e, "First orphan match cycle failed"));
  }, 30 * 60 * 1000);
  setInterval(() => {
    matchOrphanGamesCycle(app).catch(e => app.log.error(e, "Orphan match cycle failed"));
  }, ORPHAN_MATCH_INTERVAL_MS);
  app.log.info({ intervalMs: REFETCH_INTERVAL_MS, batchSize: REFETCH_BATCH_SIZE, orphanMatchMs: ORPHAN_MATCH_INTERVAL_MS }, "Refetch Games cron demarre");
}
