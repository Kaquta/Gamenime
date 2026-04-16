import Fastify from "fastify";
import * as mariadb from "mariadb";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import cookie from "@fastify/cookie";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, ignoreTrailingSlash: true });

function sanitizeBigInt(value: any): any {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= max && value >= -max ? Number(value) : value.toString();
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
await app.register(cookie);

const pool = mariadb.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASS!,
  database: process.env.DB_NAME!,
  connectionLimit: 8,
});

const COOKIE_NAME = process.env.APP_COOKIE_NAME || "gn_session";
const COOKIE_SECURE = String(process.env.APP_COOKIE_SECURE || "false") === "true";
const SESSION_DURATION_DAYS = Number(process.env.SESSION_DURATION_DAYS || 30);

const BLOCKED_WORDS = ["hentai", "erotic", "sexual content", "adult only", "porn", "xxx", "nude", "nsfw", "ecchi"];

function isAdultContent(title: string, genre: string | null, rating: string | null): boolean {
  const check = ((title || "") + " " + (genre || "") + " " + (rating || "")).toLowerCase();
  return BLOCKED_WORDS.some(w => check.includes(w));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}
function getSessionExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DURATION_DAYS);
  return d;
}
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
function hashIp(ip: string): string {
  return createHash("sha256").update(ip + "_gamenime_salt").digest("hex").slice(0, 16);
}
function setAuthCookie(reply: any, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires: getSessionExpiresAt(),
  });
}
function clearAuthCookie(reply: any) {
  reply.clearCookie(COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
  });
}
function getAuthToken(req: any): string | null {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie && typeof fromCookie === "string") return fromCookie;
  const auth = req.headers?.authorization;
  if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}
async function getAuthenticatedUser(req: any) {
  const token = getAuthToken(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  const rows: any = await pool.query(
    `SELECT u.id, u.email, u.display_name AS displayName,
            u.notifications_enabled AS notificationsEnabled,
            u.email_notifications_enabled AS emailNotificationsEnabled,
            u.avatar,
            s.id AS sessionId, s.expires_at AS expiresAt
     FROM user_sessions s INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return null;
  const user = rows[0];
  if (!user.expiresAt || new Date(user.expiresAt).getTime() < Date.now()) {
    await pool.query(`DELETE FROM user_sessions WHERE id = ?`, [user.sessionId]);
    return null;
  }
  await pool.query(`UPDATE user_sessions SET last_seen_at = NOW() WHERE id = ?`, [user.sessionId]);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    notificationsEnabled: !!user.notificationsEnabled,
    emailNotificationsEnabled: !!user.emailNotificationsEnabled,
    avatar: user.avatar || "luffy",
    sessionId: user.sessionId,
  };
}

// ── Zod schemas ────────────────────────────────────
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
const registerBodySchema = z.object({
  email: z.string().email().max(190),
  password: z.string().min(8).max(100),
  displayName: z.string().trim().min(2).max(80).optional().nullable(),
});
const loginBodySchema = z.object({
  email: z.string().email().max(190),
  password: z.string().min(8).max(100),
});
const favoriteBodySchema = z.object({
  itemType: z.enum(["anime", "game"]),
  itemId: z.coerce.number().int().positive(),
});
const favoriteParamsSchema = z.object({
  itemType: z.enum(["anime", "game"]),
  itemId: z.coerce.number().int().positive(),
});
const notificationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(30),
  unreadOnly: z.union([z.literal("0"), z.literal("1")]).optional().default("0"),
});
const notificationParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

function requireApiKey(expected: string | undefined, provided: unknown) {
  if (!expected) return { ok: false as const, code: 500, msg: "API key not configured" };
  if (typeof provided !== "string" || provided !== expected) return { ok: false as const, code: 401, msg: "Unauthorized" };
  return { ok: true as const };
}

// ── Auth routes ────────────────────────────────────
app.post("/auth/register", async (req, reply) => {
  try {
    const body = registerBodySchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const displayName = body.displayName?.trim() || null;
    const existing: any = await pool.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
    if (existing.length) return reply.code(409).send({ error: "Email déjà utilisé" });

    const passwordHash = await bcrypt.hash(body.password, 12);
    const result: any = await pool.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)`,
      [email, passwordHash, displayName]
    );

    const userId = Number(result.insertId);
    const sessionToken = createSessionToken();

    await pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [userId, sha256(sessionToken), getSessionExpiresAt()]
    );

    setAuthCookie(reply, sessionToken);
    return reply.code(201).send({ ok: true, user: { id: userId, email, displayName } });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Données invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/auth/login", async (req, reply) => {
  try {
    const body = loginBodySchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const rows: any = await pool.query(
      `SELECT id, email, password_hash, display_name FROM users WHERE email = ? LIMIT 1`,
      [email]
    );
    if (!rows.length) return reply.code(401).send({ error: "Identifiants invalides" });

    const user = rows[0];
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) return reply.code(401).send({ error: "Identifiants invalides" });

    const sessionToken = createSessionToken();

    await pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [user.id, sha256(sessionToken), getSessionExpiresAt()]
    );

    setAuthCookie(reply, sessionToken);
    return reply.send({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name }
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Données invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/auth/logout", async (req, reply) => {
  try {
    const token = getAuthToken(req);
    if (token) {
      await pool.query(`DELETE FROM user_sessions WHERE token_hash = ?`, [sha256(token)]);
    }
    clearAuthCookie(reply);
    return reply.send({ ok: true });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.get("/auth/me", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        notificationsEnabled: user.notificationsEnabled,
        emailNotificationsEnabled: user.emailNotificationsEnabled,
        avatar: user.avatar,
      }
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/auth/cleanup-sessions", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ error: auth.msg });

  const result: any = await pool.query(`DELETE FROM user_sessions WHERE expires_at < NOW()`);
  return reply.send({ ok: true, deleted: Number(result.affectedRows) || 0 });
});


app.patch("/auth/profile", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    const body = req.body as any;
    const displayName = body.displayName !== undefined ? String(body.displayName || "").trim().slice(0, 80) : null;
    const avatar = body.avatar !== undefined ? String(body.avatar || "").trim().slice(0, 50) : null;
    if (displayName !== null) await pool.query("UPDATE users SET display_name = ? WHERE id = ?", [displayName || null, user.id]);
    if (avatar !== null) await pool.query("UPDATE users SET avatar = ? WHERE id = ?", [avatar, user.id]);
    const rows: any = await pool.query("SELECT id, email, display_name AS displayName, avatar, notifications_enabled AS notificationsEnabled, email_notifications_enabled AS emailNotificationsEnabled FROM users WHERE id = ?", [user.id]);
    return reply.send({ ok: true, user: rows[0] });
  } catch (err) { req.log.error(err); return reply.code(500).send({ error: "Erreur serveur" }); }
});

app.patch("/auth/password", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    const body = req.body as any;
    if (!body.currentPassword || !body.newPassword) return reply.code(400).send({ error: "Mots de passe requis" });
    if (String(body.newPassword).length < 8) return reply.code(400).send({ error: "8 caractères minimum" });
    const rows: any = await pool.query("SELECT password_hash FROM users WHERE id = ?", [user.id]);
    const ok = await bcrypt.compare(body.currentPassword, rows[0].password_hash);
    if (!ok) return reply.code(401).send({ error: "Mot de passe actuel incorrect" });
    const hash = await bcrypt.hash(body.newPassword, 12);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
    return reply.send({ ok: true });
  } catch (err) { req.log.error(err); return reply.code(500).send({ error: "Erreur serveur" }); }
});

app.post("/auth/reset-password", async (req, reply) => {
  try {
    const body = req.body as any;
    if (!body.email || !body.displayName || !body.newPassword) return reply.code(400).send({ error: "Tous les champs sont requis" });
    if (String(body.newPassword).length < 8) return reply.code(400).send({ error: "8 caractères minimum" });
    const rows: any = await pool.query("SELECT id, display_name FROM users WHERE email = ?", [normalizeEmail(body.email)]);
    if (!rows.length) return reply.code(404).send({ error: "Compte introuvable" });
    if (String(rows[0].display_name || "").toLowerCase() !== String(body.displayName).toLowerCase().trim()) return reply.code(403).send({ error: "Pseudo incorrect" });
    const hash = await bcrypt.hash(body.newPassword, 12);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, rows[0].id]);
    return reply.send({ ok: true });
  } catch (err) { req.log.error(err); return reply.code(500).send({ error: "Erreur serveur" }); }
});
// ── Favorites ──────────────────────────────────────
async function ensureFavoriteTargetExists(itemType: "anime" | "game", itemId: number) {
  const table = itemType === "anime" ? "anime_items" : "game_items";
  const rows: any = await pool.query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [itemId]);
  return rows.length > 0;
}

app.get("/favorites", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const rows: any = await pool.query(
      `SELECT
          f.id,
          f.item_type AS itemType,
          f.item_id AS itemId,
          f.created_at AS createdAt,
          COALESCE(a.title, g.title) AS title,
          COALESCE(a.cover, g.cover) AS cover,
          COALESCE(a.genre, g.genre) AS genre,
          COALESCE(a.platform, g.platform) AS platform,
          COALESCE(DATE_FORMAT(a.release_date,'%Y-%m-%d'), DATE_FORMAT(g.release_date,'%Y-%m-%d')) AS releaseDate,
          COALESCE(a.trailer_url, g.trailer_url) AS trailerUrl
       FROM favorites f
       LEFT JOIN anime_items a ON f.item_type = 'anime' AND a.id = f.item_id
       LEFT JOIN game_items g ON f.item_type = 'game' AND g.id = f.item_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`,
      [user.id]
    );

    return reply.send({ items: rows });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/favorites", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const body = favoriteBodySchema.parse(req.body);
    const exists = await ensureFavoriteTargetExists(body.itemType, body.itemId);
    if (!exists) return reply.code(404).send({ error: "Item introuvable" });

    await pool.query(
      `INSERT INTO favorites (user_id, item_type, item_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [user.id, body.itemType, body.itemId]
    );

    return reply.code(201).send({ ok: true, itemType: body.itemType, itemId: body.itemId });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Données invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.delete("/favorites/:itemType/:itemId", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const params = favoriteParamsSchema.parse(req.params);
    const result: any = await pool.query(
      `DELETE FROM favorites WHERE user_id = ? AND item_type = ? AND item_id = ?`,
      [user.id, params.itemType, params.itemId]
    );

    return reply.send({ ok: true, deleted: Number(result.affectedRows) || 0 });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Paramètres invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ── Notifications ──────────────────────────────────
function parseNotificationPayload(value: any) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

app.get("/notifications", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const query = notificationQuerySchema.parse(req.query);
    const conditions: string[] = ["un.user_id = ?"];
    const params: any[] = [user.id];

    if (query.unreadOnly === "1") conditions.push("un.is_read = 0");
    params.push(query.limit);

    const rows: any = await pool.query(
      `SELECT
          un.id,
          un.is_read AS isRead,
          DATE_FORMAT(un.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
          DATE_FORMAT(un.read_at, '%Y-%m-%d %H:%i:%s') AS readAt,
          ne.id AS eventId,
          ne.item_type AS itemType,
          ne.item_id AS itemId,
          ne.event_type AS eventType,
          DATE_FORMAT(ne.event_at, '%Y-%m-%d %H:%i:%s') AS eventAt,
          ne.payload_json AS payload
       FROM user_notifications un
       INNER JOIN notification_events ne ON ne.id = un.event_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY un.created_at DESC
       LIMIT ?`,
      params
    );

    const items = rows.map((r: any) => ({
      id: r.id,
      isRead: !!r.isRead,
      createdAt: r.createdAt,
      readAt: r.readAt,
      eventId: r.eventId,
      itemType: r.itemType,
      itemId: r.itemId,
      eventType: r.eventType,
      eventAt: r.eventAt,
      payload: parseNotificationPayload(r.payload),
    }));

    const unreadRows: any = await pool.query(
      `SELECT COUNT(*) AS unreadCount
       FROM user_notifications
       WHERE user_id = ? AND is_read = 0`,
      [user.id]
    );

    return reply.send({
      items,
      unreadCount: Number(unreadRows[0]?.unreadCount || 0),
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Paramètres invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/notifications/:id/read", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const params = notificationParamsSchema.parse(req.params);
    const result: any = await pool.query(
      `UPDATE user_notifications SET is_read = 1, read_at = NOW()
       WHERE id = ? AND user_id = ? AND is_read = 0`,
      [params.id, user.id]
    );

    return reply.send({ ok: true, updated: Number(result.affectedRows) || 0 });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Paramètres invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/notifications/read-all", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const result: any = await pool.query(
      `UPDATE user_notifications SET is_read = 1, read_at = NOW()
       WHERE user_id = ? AND is_read = 0`,
      [user.id]
    );

    return reply.send({ ok: true, updated: Number(result.affectedRows) || 0 });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ── Notification helpers ───────────────────────────
function isBlankNotificationValue(v: any): boolean {
  return v === null || v === undefined || String(v).trim() === "" || String(v).trim() === "Unknown";
}

async function createNotificationEventAndFanout(
  db: any,
  itemType: "anime" | "game",
  itemId: number,
  eventType: string,
  eventKey: string,
  payload: any
) {
  const result: any = await db.query(
    `INSERT INTO notification_events
       (item_type, item_id, event_type, event_key, payload_json, event_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       payload_json = VALUES(payload_json),
       event_at = VALUES(event_at)`,
    [itemType, itemId, eventType, eventKey, JSON.stringify(payload)]
  );

  const eventId = Number(result.insertId || 0);
  if (!eventId) return;

  await db.query(
    `INSERT IGNORE INTO user_notifications (user_id, event_id)
     SELECT f.user_id, ?
     FROM favorites f
     INNER JOIN users u ON u.id = f.user_id
     WHERE f.item_type = ? AND f.item_id = ? AND u.notifications_enabled = 1`,
    [eventId, itemType, itemId]
  );
}

async function createNotificationsForItemChange(
  db: any,
  itemType: "anime" | "game",
  before: any,
  after: any
) {
  if (!before || !after || !after.id) return;
  const title = after.title || before.title || null;

  if (isBlankNotificationValue(before.platform) && !isBlankNotificationValue(after.platform)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_platform_added`,
      `${itemType}:${after.id}:platform_added:${sha256(String(after.platform)).slice(0, 12)}`,
      { title, label: "Plateforme ajoutée", oldValue: before.platform || null, newValue: after.platform });
  }

  if (isBlankNotificationValue(before.trailerUrl) && !isBlankNotificationValue(after.trailerUrl)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_trailer_added`,
      `${itemType}:${after.id}:trailer_added:${sha256(String(after.trailerUrl)).slice(0, 12)}`,
      { title, label: "Trailer ajouté", oldValue: before.trailerUrl || null, newValue: after.trailerUrl });
  }

  if (isBlankNotificationValue(before.releaseDate) && !isBlankNotificationValue(after.releaseDate)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_release_date_announced`,
      `${itemType}:${after.id}:release_date:${after.releaseDate}`,
      { title, label: "Date annoncée", oldValue: before.releaseDate || null, newValue: after.releaseDate });
  }

  if (isBlankNotificationValue(before.cover) && !isBlankNotificationValue(after.cover)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_cover_added`,
      `${itemType}:${after.id}:cover_added`,
      { title, label: "Image ajoutée", newValue: "Nouvelle image disponible" });
  }

  if (itemType === "anime") {
    const beforeEpMatch = String(before.description || "").match(/\[EPISODES:(\d+)\]/);
    const afterEpMatch = String(after.description || "").match(/\[EPISODES:(\d+)\]/);
    const beforeEp = beforeEpMatch ? Number(beforeEpMatch[1]) : 0;
    const afterEp = afterEpMatch ? Number(afterEpMatch[1]) : 0;
    if (afterEp > beforeEp && afterEp > 0) {
      await createNotificationEventAndFanout(db, itemType, Number(after.id),
        `${itemType}_episode_added`,
        `${itemType}:${after.id}:episodes:${afterEp}`,
        { title, label: "Nouvel épisode", oldValue: beforeEp ? String(beforeEp) + " épisodes" : null, newValue: afterEp + " épisodes" });
    }

    const beforeSeason = String(before.description || "").match(/\[SEASON:([^\]]+)\]/);
    const afterSeason = String(after.description || "").match(/\[SEASON:([^\]]+)\]/);
    if (afterSeason && (!beforeSeason || beforeSeason[1] !== afterSeason[1])) {
      await createNotificationEventAndFanout(db, itemType, Number(after.id),
        `${itemType}_season_added`,
        `${itemType}:${after.id}:season:${sha256(afterSeason[1]).slice(0, 12)}`,
        { title, label: "Nouvelle saison", oldValue: beforeSeason ? beforeSeason[1] : null, newValue: afterSeason[1] });
    }

    const beforeNext = String(before.description || "").match(/\[NEXT_EP:(\d+)\]/);
    const afterNext = String(after.description || "").match(/\[NEXT_EP:(\d+)\]/);
    const beforeNextN = beforeNext ? Number(beforeNext[1]) : 0;
    const afterNextN = afterNext ? Number(afterNext[1]) : 0;
    if (afterNextN > beforeNextN && afterNextN > 0) {
      await createNotificationEventAndFanout(db, itemType, Number(after.id),
        `${itemType}_next_episode`,
        `${itemType}:${after.id}:next_ep:${afterNextN}`,
        { title, label: "Épisode " + afterNextN + " à venir", newValue: "Épisode " + afterNextN });
    }
  }
}


// ── Content domains ────────────────────────────────
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

    const rows: any = await pool.query(
      `SELECT id, title, cover, genre, platform, description, rating, popularity, screenshots,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              DATE_FORMAT(release_datetime,'%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
              is_recently_released AS isRecentlyReleased, trailer_url AS trailerUrl
       FROM ${table} ${where} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { items: rows, limit, offset };
  });

  app.get(`${prefix}/items/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };

    const rows: any = await pool.query(
      `SELECT id, title, cover, genre, platform, description, rating, popularity, screenshots,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              DATE_FORMAT(release_datetime,'%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
              is_recently_released AS isRecentlyReleased, trailer_url AS trailerUrl
       FROM ${table} WHERE id = ?`,
      [id]
    );

    if (!rows.length) return reply.code(404).send({ error: "Not found" });

    const voteRows: any = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END),0) AS upvotes,
              COALESCE(SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END),0) AS downvotes
       FROM votes WHERE item_id=? AND item_type=?`,
      [id, itemType]
    );

    const up = Number(voteRows[0]?.upvotes ?? 0);
    const down = Number(voteRows[0]?.downvotes ?? 0);
    const total = up + down;

    return {
      ...rows[0],
      votes: { up, down, total, percent: total > 0 ? Math.round((up / total) * 100) : 0 }
    };
  });

  app.post(`${prefix}/items/:id/vote`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { vote?: number };
    if (body.vote !== 1 && body.vote !== -1) return reply.code(400).send({ error: "vote must be 1 or -1" });

    const ip = req.headers["x-real-ip"] as string || req.headers["x-forwarded-for"] as string || req.ip;
    const voterHash = hashIp(ip);

    try {
      await pool.query(
        `INSERT INTO votes (item_id,item_type,vote,voter_hash) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE vote=VALUES(vote)`,
        [id, itemType, body.vote, voterHash]
      );

      const vr: any = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END),0) AS u,
                COALESCE(SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END),0) AS d
         FROM votes WHERE item_id=? AND item_type=?`,
        [id, itemType]
      );

      const up = Number(vr[0]?.u ?? 0);
      const down = Number(vr[0]?.d ?? 0);
      const total = up + down;

      return {
        ok: true,
        votes: { up, down, total, percent: total > 0 ? Math.round((up / total) * 100) : 0 }
      };
    } catch (e: any) {
      req.log.error(e);
      return reply.code(500).send({ error: "Internal Server Error" });
    }
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

    const cleanedItems = parsed.data.items.filter(b => !isAdultContent(b.title, b.genre, b.rating));
    const filtered = parsed.data.items.length - cleanedItems.length;

    if (filtered > 0) req.log.info(`Filtered ${filtered} adult items`);
    if (cleanedItems.length === 0) {
      return reply.code(200).send({ ok: true, total: 0, filtered });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const b of cleanedItems) {
        const beforeRows: any = await conn.query(
          `SELECT id, title, platform, DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate, trailer_url AS trailerUrl, cover, description, rating
           FROM ${table} WHERE title = ? LIMIT 1`,
          [b.title]
        );
        const before = beforeRows.length ? beforeRows[0] : null;

        await conn.query(
          `INSERT INTO ${table}
             (title,cover,genre,platform,release_date,release_datetime,is_recently_released,trailer_url,description,rating,popularity,screenshots)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             cover=IF(VALUES(cover) IS NOT NULL AND VALUES(cover) != '', VALUES(cover), cover),
             genre=IF(VALUES(genre) IS NOT NULL AND VALUES(genre) != '', VALUES(genre), genre),
             platform=IF(VALUES(platform) IS NOT NULL AND VALUES(platform) != '' AND VALUES(platform) != 'Unknown', VALUES(platform), platform),
             release_date=IF(VALUES(release_date) IS NOT NULL, VALUES(release_date), release_date),
             release_datetime=IF(VALUES(release_datetime) IS NOT NULL, VALUES(release_datetime), release_datetime),
             is_recently_released=VALUES(is_recently_released),
             trailer_url=IF(VALUES(trailer_url) IS NOT NULL AND VALUES(trailer_url) != '', VALUES(trailer_url), trailer_url),
             description=IF(VALUES(description) IS NOT NULL AND VALUES(description) != '', VALUES(description), description),
             rating=IF(VALUES(rating) IS NOT NULL AND VALUES(rating) != '', VALUES(rating), rating),
             popularity=IF(VALUES(popularity) > 0, VALUES(popularity), popularity),
             screenshots=IF(VALUES(screenshots) IS NOT NULL AND VALUES(screenshots) != '', VALUES(screenshots), screenshots),
             updated_at=CURRENT_TIMESTAMP`,
          [
            b.title,
            b.cover,
            b.genre,
            b.platform,
            b.releaseDate,
            b.releaseDatetime,
            b.isRecentlyReleased ? 1 : 0,
            b.trailerUrl,
            b.description,
            b.rating,
            b.popularity,
            b.screenshots
          ]
        );

        const afterRows: any = await conn.query(
          `SELECT id, title, platform, DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate, trailer_url AS trailerUrl, cover, description, rating
           FROM ${table} WHERE title = ? LIMIT 1`,
          [b.title]
        );
        const after = afterRows.length ? afterRows[0] : null;

        if (before && after) {
          await createNotificationsForItemChange(conn, itemType, before, after);
        }
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      req.log.error(e);
      return reply.code(500).send({ error: "Internal Server Error" });
    } finally {
      conn.release();
    }

    try {
      const blockedLike = BLOCKED_WORDS
        .map(w => `genre LIKE '%${w}%' OR title LIKE '%${w}%' OR rating LIKE '%${w}%'`)
        .join(" OR ");
      await pool.query(`DELETE FROM ${table} WHERE ${blockedLike}`);
    } catch (cleanErr) {
      req.log.warn(cleanErr, "adult cleanup failed");
    }
    try {
      await pool.query(
        `DELETE FROM ${table}
         WHERE id NOT IN (
           SELECT id FROM (
             SELECT id FROM ${table}
             ORDER BY
               CASE WHEN release_date >= "2026-01-01" AND release_date <= "2027-12-31" THEN 0 ELSE 1 END,
               release_date DESC,
               popularity DESC
             LIMIT 150
           ) AS keep_items
         )`
      );
    } catch (cleanErr) {
      req.log.warn(cleanErr, "cleanup failed");
    }

    return reply.code(200).send({ ok: true, total: cleanedItems.length, filtered });
  });
}

// ── Register domains ───────────────────────────────
app.get("/health", async () => ({ ok: true, service: "content-api" }));
registerDomain("/anime", "anime_items", "ANIME_API_KEY");
registerDomain("/games", "game_items", "GAMES_API_KEY");

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
