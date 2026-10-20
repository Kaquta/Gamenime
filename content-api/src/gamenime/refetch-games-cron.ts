/**
 * GameNime Phase B GAMES — Cron interne re-fetch des games incomplets
 * Symétrique à refetch-cron.ts (anime), pour les jeux via IGDB seul.
 *
 * Source externe : IGDB (via igdb_id) → cover haute qualité, plateformes, description, note,
 * type (DLC), bande-annonce, date. RAWG est retiré (13 octobre 2026, igdb-jeux.ts) : les jeux
 * sans igdb_id sont rattachés par le passage de igdb-jeux, toutes les 3 h.
 *
 * Cycle : toutes les heures, batch 100, delay 800ms entre items.
 */
import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { setIgdbWarnPool, igdbFetch } from "./twitch.js";
import { sanitizePlatform as gnSanitizePlatform } from "./core.js";
import { choisirDateIgdb, configIgdbJeux, lierJeuxVerrouille } from "./igdb-jeux.js";
import { clearFeedCache } from "./routes.js";
import { planifier } from "./pilotage.js";

const REFETCH_INTERVAL_MS = 60 * 60 * 1000; // 1h
const REFETCH_BATCH_SIZE = 100;
const REFETCH_DELAY_MS = 800;

interface IncompleteGame {
  id: number;
  title: string;
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
  releaseDate?: string | null;        // "YYYY-MM-DD" (jour=01 si precision month/year)
  releasePrecision?: "day" | "month" | "year" | null;  // precision reelle selon la source
}

/**
 * IGDB : recupere via Twitch OAuth + IGDB API (jeton Twitch partage, twitch.ts).
 */
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


// IGDB seul (RAWG retire) : la fiche IGDB telle quelle, champs absents a null.
function mergeSources(igdb: SourceData | null): SourceData {
  return {
    cover: igdb?.cover ?? null,
    platform: igdb?.platform ?? null,
    description: igdb?.description ?? null,
    ratingScore: igdb?.ratingScore ?? null,
    gameType: igdb?.gameType ?? null,
    trailerUrl: igdb?.trailerUrl ?? null,
    releaseDate: igdb?.releaseDate && igdb?.releasePrecision ? igdb.releaseDate : null,
    releasePrecision: igdb?.releaseDate && igdb?.releasePrecision ? igdb.releasePrecision : null,
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
      "SELECT id, title, igdb_id, cover, platform, trailer_url, description, rating_score, game_type, DATE_FORMAT(release_date,'%Y-%m-%d') AS release_date, release_precision " +
      "FROM game_items " +
      // Criteres calibres (session 27, repris de gnAuditGame) : seuls cover,
      // plateforme et description sont de vrais manques. rating_score NULL est
      // normal avant la sortie (pas de reviews) et game_type NULL signifie
      // "jeu standard, pas un DLC" — les inclure mettait 433 jeux sur 477 dans
      // la file, noyant les 3 items reellement sans plateforme.
      // Les covers rawg/igdb sont les VRAIES covers, pas des hotlinks.
      "WHERE (cover IS NULL OR cover = '' OR platform IS NULL OR platform = '' OR description IS NULL OR LENGTH(TRIM(description)) < 10) " +
      "AND igdb_id IS NOT NULL AND igdb_id > 0 " +
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
        const igdb = item.igdb_id ? await fetchIgdb(item.igdb_id) : null;
        const merged = mergeSources(igdb);

        const updates: string[] = [];
        const params: any[] = [];
        const itemChanges: Array<{ field: string; oldValue: any; newValue: any }> = [];

        // ETAT CLEAN cover : 
        //   - Si cover vide → remplir
        //   - Si cover RAWG/IGDB → REFRESH (URLs peuvent mourir ; une cover RAWG devient la jaquette IGDB)
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
        // La note n'est plus ecrite ici : igdb-jeux la prend chez IGDB a partir de 5 votes (une seule regle).
        // game_type (lossless - on remplit si vide)
        if ((item.game_type == null || item.game_type === "") && merged.gameType) {
          updates.push("game_type = ?");
          params.push(merged.gameType);
          itemChanges.push({ field: "game_type", oldValue: item.game_type, newValue: merged.gameType });
        }

        // Marquer TOUJOURS last_refetch_at (meme si rien a enrichir) :
        // un jeu de base (game_type null legitime) est ainsi verifie une fois
        // puis laisse tranquille 7 jours -> casse la boucle infinie.
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
      "SELECT id, title, igdb_id, cover, platform, trailer_url, description, rating_score, game_type, DATE_FORMAT(release_date,'%Y-%m-%d') AS release_date, release_precision FROM game_items WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows || rows.length === 0) {
      return { ok: true, found: false, enriched: false, fields: [] };
    }
    const item = rows[0];
    const igdb = item.igdb_id ? await fetchIgdb(item.igdb_id) : null;
    const merged = mergeSources(igdb);
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
    // Note : igdb-jeux (IGDB, 5 votes au moins), pas ici.
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
// Appariement des jeux sans igdb_id (bouton admin /admin/match-orphan-games).
// Le passage de igdb-jeux le fait deja toutes les 3 h ; meme regle : titre
// (chiffres romains, sous-titres, acces anticipe), un identifiant IGDB deja
// porte par un autre jeu : la copie est fusionnee dans cette fiche (14 octobre).
// Sous le meme verrou que le passage : jamais deux rattachements en meme temps.
// ─────────────────────────────────────────────────────────────────────────
export async function matchOrphanGamesCycle(app: FastifyInstance): Promise<{
  ok: boolean;
  scanned: number;
  matched: number;
  changes: Array<{ id: number; title: string; igdbId: number }>;
  doublons: Array<{ id: number; title: string; igdbId: number; autre: { id: number; titre: string } }>;
  /** Doublons fusionnés (la copie supprimée, la fiche qui porte l'identifiant IGDB gardée). */
  fusions: Array<{ id: number; title: string; igdbId: number; gardee: { id: number; titre: string } }>;
  /** Identifiant IGDB déplacé vers la fiche au titre le plus juste (rien de supprimé). */
  transferts: Array<{ igdbId: number; de: { id: number; titre: string }; vers: { id: number; titre: string } }>;
  erreur?: string;
  msg?: string;
  occupe?: boolean;
}> {
  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Match orphans cycle: pool DB introuvable");
    return { ok: false, scanned: 0, matched: 0, changes: [], doublons: [], fusions: [], transferts: [], erreur: "pool DB introuvable", msg: "pool DB introuvable" };
  }
  try {
    // une fiche rattachée ou fusionnée (copie supprimée) : le cache des flux est vidé
    const r = await lierJeuxVerrouille({ pool, log: app.log, rafraichir: clearFeedCache }, configIgdbJeux());
    app.log.info({ scanned: r.cherches, matched: r.lies.length, doublons: r.doublons.length, fusions: r.fusions.length, transferts: r.transferts.length, erreur: r.erreur, occupe: r.occupe }, "Match orphans cycle: termine");
    return {
      ok: !r.erreur && !r.occupe,
      scanned: r.cherches,
      matched: r.lies.length,
      changes: r.lies.map((x) => ({ id: x.id, title: x.titre, igdbId: x.igdb })),
      doublons: r.doublons.map((x) => ({ id: x.id, title: x.titre, igdbId: x.igdb, autre: x.autre })),
      fusions: r.fusions.map((x) => ({ id: x.perdant.id, title: x.perdant.titre, igdbId: x.igdb, gardee: x.gagnant })),
      transferts: r.transferts.map((x) => ({ igdbId: x.igdb, de: x.de, vers: x.vers })),
      ...(r.erreur ? { erreur: r.erreur, msg: "IGDB : " + r.erreur } : {}),
      ...(r.occupe ? { occupe: true, msg: "un passage des jeux IGDB tourne deja, reessaie dans quelques minutes" } : {}),
    };
  } catch (e: any) {
    app.log.error({ err: e?.message }, "Match orphans cycle: erreur");
    const m = String(e?.message || e).slice(0, 200);
    return { ok: false, scanned: 0, matched: 0, changes: [], doublons: [], fusions: [], transferts: [], erreur: m, msg: m };
  }
}

export function startRefetchGamesCron(app: FastifyInstance) {
  app.post("/admin/refetch-incomplete-games", adminRefetchGamesHandler);
  setIgdbWarnPool((app as any).pool);
  // Pilotage (pilotage.ts) : premier passage 15 min après le démarrage (après la Phase B des animés), puis toutes les heures
  planifier({
    id: "phase-b-jeux", premierMs: 15 * 60 * 1000, rythmeMs: REFETCH_INTERVAL_MS, suivi: "refetch-games-cron", processAdmin: "refetch-incomplete-games",
    passage: async () => {
      await refetchIncompleteGamesCycle(app);
    },
  });
  // Les jeux sans igdb_id sont rattaches par le passage de igdb-jeux (toutes les 3 h).
  app.log.info({ intervalMs: REFETCH_INTERVAL_MS, batchSize: REFETCH_BATCH_SIZE }, "Refetch Games cron demarre");
}
