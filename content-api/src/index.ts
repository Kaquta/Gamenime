import Fastify from "fastify";
import * as mariadb from "mariadb";
import { z } from "zod";

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

app.addHook("preSerialization", async (_req, _reply, payload) => {
  return sanitizeBigInt(payload);
});

const pool = mariadb.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASS!,
  database: process.env.DB_NAME!,
  connectionLimit: 8,
});

const Item = z.object({
  title: z.string().min(1),
  cover: z.string().min(1),
  genre: z.string().optional(),
  platform: z.string().min(1),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isRecentlyReleased: z.boolean().optional().default(false),
  trailerUrl: z.string().url().optional(),
});
const Bulk = z.object({ items: z.array(Item).min(1).max(200) });

function requireApiKey(expected: string | undefined, provided: unknown) {
  if (!expected) return { ok: false as const, code: 500, msg: "API key not configured" };
  if (typeof provided !== "string" || provided !== expected) return { ok: false as const, code: 401, msg: "Unauthorized" };
  return { ok: true as const };
}

function registerDomain(prefix: "/anime" | "/games", table: string, apiKeyEnv: "ANIME_API_KEY" | "GAMES_API_KEY") {
  app.get(`${prefix}/health`, async () => ({ ok: true, domain: prefix.slice(1) }));

  app.get(`${prefix}/items`, async (req) => {
    const q = req.query as { recent?: string; limit?: string; offset?: string; order?: string };
    const limit = Math.min(parseInt(q.limit ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(q.offset ?? "0", 10) || 0, 0);
    const recent = q.recent === "1";
    const order = q.order === "asc" ? "ASC" : "DESC";
    const where = recent ? "WHERE is_recently_released=1" : "";

    const rows = await pool.query(
      `SELECT id, title, cover, genre, platform,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              is_recently_released AS isRecentlyReleased,
              trailer_url AS trailerUrl
       FROM ${table} ${where}
       ORDER BY release_date ${order}
       LIMIT ? OFFSET ?;`,
      [limit, offset]
    );
    return { items: rows, limit, offset };
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

    const items = parsed.data.items;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const b of items) {
        await conn.query(
          `INSERT INTO ${table} (title, cover, genre, platform, release_date, is_recently_released, trailer_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             cover=VALUES(cover),
             genre=VALUES(genre),
             platform=VALUES(platform),
             is_recently_released=VALUES(is_recently_released),
             trailer_url=VALUES(trailer_url),
             updated_at=CURRENT_TIMESTAMP;`,
          [b.title, b.cover, b.genre ?? null, b.platform, b.releaseDate, b.isRecentlyReleased ? 1 : 0, b.trailerUrl ?? null]
        );
      }
      await conn.commit();
      return reply.code(200).send({ ok: true, total: items.length });
    } catch (e) {
      await conn.rollback();
      req.log.error(e);
      return reply.code(500).send({ error: "Internal Server Error" });
    } finally {
      conn.release();
    }
  });
}

app.get("/health", async () => ({ ok: true, service: "content-api" }));

registerDomain("/anime", "anime_items", "ANIME_API_KEY");
registerDomain("/games", "game_items", "GAMES_API_KEY");

app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
