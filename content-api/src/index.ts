import Fastify from "fastify";
import * as mariadb from "mariadb";
import { z } from "zod";
import { createHash } from "crypto";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

function sanitizeBigInt(value: any): any {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = -max;
    return value <= max && value >= min ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map(sanitizeBigInt);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeBigInt(v);
    return out;
  }
  return value;
}

app.addHook("preSerialization", async (_req, _reply, payload) => sanitizeBigInt(payload));

const pool = mariadb.createPool({
  host: process.env.DB_HOST!, user: process.env.DB_USER!,
  password: process.env.DB_PASS!, database: process.env.DB_NAME!,
  connectionLimit: 8,
});

const BLOCKED_WORDS = ['hentai','erotic','sexual content','adult only','porn','xxx','nude','nsfw','ecchi'];

function isAdultContent(title: string, genre: string | null, rating: string | null): boolean {
  const check = ((title || '') + ' ' + (genre || '') + ' ' + (rating || '')).toLowerCase();
  return BLOCKED_WORDS.some(w => check.includes(w));
}

const Item = z.object({
  title: z.string().min(1),
  cover: z.string().nullable().optional().default(null),
  genre: z.string().nullable().optional().default(null),
  platform: z.string().nullable().optional().default(null),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
  releaseDatetime: z.string().nullable().optional().default(null),
  isRecentlyReleased: z.boolean().optional().default(false),
  trailerUrl: z.string().url().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  rating: z.string().nullable().optional().default(null),
  popularity: z.number().int().optional().default(0),
  screenshots: z.string().nullable().optional().default(null),
});
const Bulk = z.object({ items: z.array(Item).min(1).max(200) });

function requireApiKey(expected: string | undefined, provided: unknown) {
  if (!expected) return { ok: false as const, code: 500, msg: "API key not configured" };
  if (typeof provided !== "string" || provided !== expected) return { ok: false as const, code: 401, msg: "Unauthorized" };
  return { ok: true as const };
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip + "_gamenime_salt").digest("hex").slice(0, 16);
}

function registerDomain(prefix: "/anime" | "/games", table: string, apiKeyEnv: "ANIME_API_KEY" | "GAMES_API_KEY") {
  const itemType = prefix === "/anime" ? "anime" : "game";

  app.get(`${prefix}/health`, async () => ({ ok: true, domain: prefix.slice(1) }));

  app.get(`${prefix}/items`, async (req) => {
    const q = req.query as any;
    const limit = Math.min(parseInt(q.limit ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(q.offset ?? "0", 10) || 0, 0);
    const orderBy = q.orderBy === "popularity" ? "popularity" : "release_date";
    const order = q.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [];
    const params: any[] = [];
    if (q.recent === "1") conditions.push("is_recently_released=1");
    if (q.noTrailer === "1") conditions.push("(trailer_url IS NULL OR trailer_url = '')");
    if (q.noDesc === "1") conditions.push("(description IS NULL OR description = '')");
    if (q.releasedAfter) { conditions.push("release_date >= ?"); params.push(q.releasedAfter); }
    if (q.releasedBefore) { conditions.push("release_date <= ?"); params.push(q.releasedBefore); }
    if (q.upcoming === "1") conditions.push("release_date > CURDATE()");
    if (q.released === "1") conditions.push("release_date <= CURDATE()");
    if (q.genre) { conditions.push("genre LIKE ?"); params.push(`%${q.genre}%`); }
    if (q.search) { conditions.push("title LIKE ?"); params.push(`%${q.search}%`); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const rows = await pool.query(
      `SELECT id, title, cover, genre, platform, description, rating, popularity, screenshots,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              DATE_FORMAT(release_datetime,'%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
              is_recently_released AS isRecentlyReleased,
              trailer_url AS trailerUrl
       FROM ${table} ${where}
       ORDER BY ${orderBy} ${order}
       LIMIT ? OFFSET ?;`,
      [...params, limit, offset]
    );
    return { items: rows, limit, offset };
  });

  app.get(`${prefix}/items/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await pool.query(
      `SELECT id, title, cover, genre, platform, description, rating, popularity, screenshots,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              DATE_FORMAT(release_datetime,'%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
              is_recently_released AS isRecentlyReleased,
              trailer_url AS trailerUrl
       FROM ${table} WHERE id = ?;`, [id]
    );
    if (!rows.length) return reply.code(404).send({ error: "Not found" });

    const voteRows = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END),0) AS upvotes,
              COALESCE(SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END),0) AS downvotes
       FROM votes WHERE item_id=? AND item_type=?;`, [id, itemType]
    );
    const up = Number(voteRows[0]?.upvotes ?? 0);
    const down = Number(voteRows[0]?.downvotes ?? 0);
    const total = up + down;
    const percent = total > 0 ? Math.round((up / total) * 100) : 0;
    return { ...rows[0], votes: { up, down, total, percent } };
  });

  app.post(`${prefix}/items/:id/vote`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { vote?: number };
    if (body.vote !== 1 && body.vote !== -1) return reply.code(400).send({ error: "vote must be 1 or -1" });
    const ip = req.headers["x-real-ip"] as string || req.headers["x-forwarded-for"] as string || req.ip;
    const voterHash = hashIp(ip);
    try {
      await pool.query(`INSERT INTO votes (item_id,item_type,vote,voter_hash) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE vote=VALUES(vote);`, [id, itemType, body.vote, voterHash]);
      const vr = await pool.query(`SELECT COALESCE(SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END),0) AS u,
        COALESCE(SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END),0) AS d FROM votes WHERE item_id=? AND item_type=?;`, [id, itemType]);
      const up = Number(vr[0]?.u ?? 0), down = Number(vr[0]?.d ?? 0), total = up + down;
      return { ok: true, votes: { up, down, total, percent: total > 0 ? Math.round((up / total) * 100) : 0 } };
    } catch (e: any) { req.log.error(e); return reply.code(500).send({ error: "Internal Server Error" }); }
  });

  app.post(`${prefix}/bulk`, async (req, reply) => {
    const expected = process.env[apiKeyEnv];
    const provided = req.headers["x-api-key"];
    const auth = requireApiKey(expected, provided);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.msg });
    const parsed = Bulk.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues, body: req.body }, "bulk validation failed");
      return reply.code(400).send({ error: parsed.error.issues });
    }

    // Filtrer contenu adulte
    const cleanedItems = parsed.data.items.filter(b => !isAdultContent(b.title, b.genre, b.rating));
    const filtered = parsed.data.items.length - cleanedItems.length;
    if (filtered > 0) req.log.info(`Filtered ${filtered} adult items`);
    if (cleanedItems.length === 0) return reply.code(200).send({ ok: true, total: 0, filtered });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const b of cleanedItems) {
        await conn.query(
          `INSERT INTO ${table} (title,cover,genre,platform,release_date,release_datetime,is_recently_released,trailer_url,description,rating,popularity,screenshots)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             cover=IF(VALUES(cover) IS NOT NULL AND VALUES(cover) != '', VALUES(cover), cover),
             genre=IF(VALUES(genre) IS NOT NULL AND VALUES(genre) != '', VALUES(genre), genre),
             platform=VALUES(platform),
             release_datetime=IF(VALUES(release_datetime) IS NOT NULL, VALUES(release_datetime), release_datetime),
             is_recently_released=VALUES(is_recently_released),
             trailer_url=IF(VALUES(trailer_url) IS NOT NULL AND VALUES(trailer_url) != '', VALUES(trailer_url), trailer_url),
             description=IF(VALUES(description) IS NOT NULL AND VALUES(description) != '', VALUES(description), description),
             rating=IF(VALUES(rating) IS NOT NULL AND VALUES(rating) != '', VALUES(rating), rating),
             popularity=IF(VALUES(popularity) > 0, VALUES(popularity), popularity),
             screenshots=IF(VALUES(screenshots) IS NOT NULL AND VALUES(screenshots) != '', VALUES(screenshots), screenshots),
             updated_at=CURRENT_TIMESTAMP;`,
          [b.title,b.cover,b.genre,b.platform,b.releaseDate,b.releaseDatetime,b.isRecentlyReleased?1:0,b.trailerUrl,b.description,b.rating,b.popularity,b.screenshots]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      req.log.error(e);
      return reply.code(500).send({ error: "Internal Server Error" });
    } finally {
      conn.release();
    }

    // Nettoyer contenu adulte existant
    try {
      const blockedLike = BLOCKED_WORDS.map(w => `genre LIKE '%${w}%' OR title LIKE '%${w}%' OR rating LIKE '%${w}%'`).join(' OR ');
      await pool.query(`DELETE FROM ${table} WHERE ${blockedLike}`);
    } catch (cleanErr) {
      req.log.warn(cleanErr, "adult cleanup failed");
    }

    // Garder max 100 items
    try {
      await pool.query(
        `DELETE FROM ${table} WHERE id NOT IN (
          SELECT id FROM (SELECT id FROM ${table} ORDER BY popularity DESC, release_date DESC LIMIT 100) AS top100
        )`
      );
    } catch (cleanErr) {
      req.log.warn(cleanErr, "cleanup failed");
    }

    return reply.code(200).send({ ok: true, total: cleanedItems.length, filtered });
  });
}

app.get("/health", async () => ({ ok: true, service: "content-api" }));
registerDomain("/anime", "anime_items", "ANIME_API_KEY");
registerDomain("/games", "game_items", "GAMES_API_KEY");
app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
