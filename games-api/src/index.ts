import Fastify from "fastify";
import * as mariadb from "mariadb";
import { z } from "zod";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

const pool = mariadb.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASS!,
  database: process.env.DB_NAME!,
  connectionLimit: 8
});

function requireApiKey(req: any, reply: any) {
  const m = req.method.toUpperCase();
  const isWrite = m === "POST" || m === "PUT" || m === "DELETE" || m === "PATCH";
  if (!isWrite) return;
  const expected = process.env.API_KEY;
  const provided = req.headers["x-api-key"];
  if (!expected) return reply.code(500).send({ error: "API_KEY not configured" });
  if (typeof provided !== "string" || provided !== expected) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}
app.addHook("preHandler", requireApiKey);

const Item = z.object({
  title: z.string().min(1),
  cover: z.string().min(1),
  genre: z.string().optional(),
  platform: z.string().min(1),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isRecentlyReleased: z.boolean().optional().default(false),
  trailerUrl: z.string().url().optional()
});
const Bulk = z.object({ items: z.array(Item).min(1).max(200) });

app.get("/health", async () => ({ ok: true, service: "games-api" }));

app.get("/items", async (req) => {
  const q = req.query as any;
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
     FROM game_items ${where}
     ORDER BY release_date ${order}
     LIMIT ? OFFSET ?;`,
    [limit, offset]
  );
  return { items: rows, limit, offset };
});

app.post("/bulk", async (req, reply) => {
  const parsed = Bulk.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const items = parsed.data.items;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const b of items) {
      await conn.query(
        `INSERT INTO game_items (title, cover, genre, platform, release_date, is_recently_released, trailer_url)
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

app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
