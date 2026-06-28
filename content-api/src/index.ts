import Fastify from "fastify";
import * as mariadb from "mariadb";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import bcrypt from "bcryptjs";
import cookie from "@fastify/cookie";
import { sendEmail, verifySmtpConnection } from "./email.js";
import { sendPasswordResetEmail, sendWelcomeEmail, consumePasswordResetToken, sendVerificationEmail, consumeVerificationToken, sendReminderEmail, sendAlertEmail } from "./email-service.js";
import { registerGameNimeRoutes, clearFeedCache } from "./gamenime/routes.js";
import { normalizeTitle as gnNormalizeTitle, sanitizePlatform as gnSanitizePlatform, mergePlatforms as gnMergePlatforms, sanitizeReleaseDatetime as gnSanitizeReleaseDatetime, isLikelyJapaneseAnime as gnIsLikelyJapaneseAnime, normalizeTitleStrict as gnNormalizeTitleStrict } from "./gamenime/core.js";

import { startRefetchCron, adminRefetchHandler, refetchOneAnimeItem, fetchAniList, fetchJikan } from "./gamenime/refetch-cron.js";
import { startRefetchGamesCron, refetchOneGameItem, fetchRawg, fetchIgdb } from "./gamenime/refetch-games-cron.js";
import { adminLookupHandler, startLookupCron } from "./gamenime/lookup-cron.js";
import { adminQualityCheckHandler, startQualityCron } from "./gamenime/quality-cron.js";
import { startDashboard, pushActivity, trackLastRun, trackVisit, trackPing, setStatsPool } from "./gamenime/dashboard.js";

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


// Global event bus for real-time notifications (Premium feature)
const notifBus = new EventEmitter();
notifBus.setMaxListeners(1000); // Support jusqu'à 1000 utilisateurs connectés simultanément

function emitNotification(userId: number, notification: any) {
  notifBus.emit(`user:${userId}`, notification);
}

const pool = mariadb.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASS!,
  database: process.env.DB_NAME!,
  connectionLimit: 8,
});

// Phase B : exposer pool à Fastify pour le cron refetch
(app as any).pool = pool;


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
            u.email_verified AS emailVerified,
            u.avatar, u.is_premium AS isPremium, u.premium_plan AS premiumPlan, u.premium_expires_at AS premiumExpiresAt,
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
  // Auto-expire premium if expired
  const isPremiumActive = user.isPremium && (!user.premiumExpiresAt || new Date(user.premiumExpiresAt).getTime() > Date.now());
  if (user.isPremium && !isPremiumActive) {
    await pool.query(`UPDATE users SET is_premium = 0 WHERE id = ?`, [user.id]);
    await pool.query(`INSERT INTO premium_audit_log (user_id, action, old_plan, new_plan, old_expires_at, actor, reason) VALUES (?, ?, ?, NULL, ?, ?, ?)`, [user.id, "expire", user.premiumPlan, user.premiumExpiresAt, "cron", "auto-expire on getUser"]);
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    notificationsEnabled: !!user.notificationsEnabled,
    emailNotificationsEnabled: !!user.emailNotificationsEnabled,
    emailVerified: !!user.emailVerified,
    avatar: user.avatar || "luffy",
    sessionId: user.sessionId,
    isPremium: isPremiumActive,
    premiumPlan: isPremiumActive ? user.premiumPlan : null,
    premiumExpiresAt: isPremiumActive ? user.premiumExpiresAt : null,
  };
}


// ── Premium helpers ────────────────────────────────
async function requireAuth(req: any, reply: any) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    reply.code(401).send({ error: "Non authentifié" });
    return null;
  }
  return user;
}

async function requirePremium(req: any, reply: any) {
  // FREE LAUNCH : plus de restriction Premium, juste authentification.
  // Pour reactiver le Premium plus tard, restaurer le check ci-dessous :
  //   if (!user.isPremium) { reply.code(403).send({ error: "Accès Premium requis", premiumRequired: true }); return null; }
  return await requireAuth(req, reply);
}

async function requireEmailVerified(req: any, reply: any) {
  const user = await requireAuth(req, reply);
  if (!user) return null;
  if (!user.emailVerified) {
    reply.code(403).send({ error: "Email non vérifié. Confirme ton email avant de continuer.", code: "EMAIL_NOT_VERIFIED" });
    return null;
  }
  return user;
}

async function logPremiumAction(userId: number, action: string, data: any = {}) {
  try {
    await pool.query(
      `INSERT INTO premium_audit_log (user_id, action, old_plan, new_plan, old_expires_at, new_expires_at, reason, actor, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, action, data.oldPlan || null, data.newPlan || null, data.oldExpiresAt || null, data.newExpiresAt || null, data.reason || null, data.actor || "system", data.metadata ? JSON.stringify(data.metadata) : null]
    );
  } catch (e) {
    console.error("Audit log failed:", e);
  }
}
// ── Zod schemas ────────────────────────────────────
const Item = z.object({
  title: z.string().min(1),
  titleEnglish: z.string().max(500).nullable().optional().default(null),
  cover: z.string().nullable().optional().default(null),
  genre: z.string().nullable().optional().default(null),
  platform: z.string().nullable().optional().default(null),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
  releaseDatetime: z.string().nullable().optional().default(null),
  titleNative: z.string().nullable().optional().default(null),  // SESSION 12.5 : utilisé pour isLikelyJapaneseAnime, NON stocké en DB
  anilistId: z.number().int().nullable().optional().default(null),  // PHASE A : ID externe AniList
  malId: z.number().int().nullable().optional().default(null),  // PHASE A : ID externe MyAnimeList/Jikan
  animeScheduleRoute: z.string().nullable().optional().default(null),  // PHASE A : route AnimeSchedule
  rawgId: z.number().int().nullable().optional().default(null),  // PHASE B GAMES : ID externe RAWG
  igdbId: z.number().int().nullable().optional().default(null),  // PHASE B GAMES : ID externe IGDB
  releasePrecision: z.enum(["day", "month", "year"]).optional().default("day"),
  isRecentlyReleased: z.boolean().optional().default(false),
  trailerUrl: z.string().url().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  rating: z.string().nullable().optional().default(null),
  // Session 10: note qualitative 0-100, normalisée par les workflows.
  // Distincte de `popularity` (signal social, nb fans/votes) et `rating` (PEGI/ESRB texte).
  // NULL = inconnu → core.ts dégrade en popularity-only.
  ratingScore: z.number().int().min(0).max(100).nullable().optional().default(null),
  popularity: z.number().int().optional().default(0),
  screenshots: z.string().nullable().optional().default(null),
  dlcs: z.string().nullable().optional().default(null),
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
const requestPasswordResetSchema = z.object({
  email: z.string().email().max(190),
});
const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8).max(100),
});
const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});
const resendVerificationSchema = z.object({
  email: z.string().email().max(190),
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

// Parse JSON safely from DB fields (handles Buffer, null, empty strings)
function parseJsonSafe<T = any>(value: any, defaultValue: T): T {
  try {
    if (value === null || value === undefined) return defaultValue;
    // MariaDB JSON fields are already parsed to objects/arrays
    if (typeof value === "object") return value as T;
    const str = typeof value === "string" ? value : value.toString();
    if (!str.trim()) return defaultValue;
    const parsed = JSON.parse(str);
    return parsed === null ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

// Simple in-memory rate limiter for sensitive endpoints
// Maintains a sliding window of timestamps per key
const rateLimitStore = new Map<string, number[]>();

function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const attempts = (rateLimitStore.get(key) || []).filter(ts => ts > cutoff);
  if (attempts.length >= maxAttempts) return false;
  attempts.push(now);
  rateLimitStore.set(key, attempts);
  return true;
}

// Periodic cleanup to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // keep last hour max
  for (const [key, attempts] of rateLimitStore.entries()) {
    const filtered = attempts.filter(ts => ts > cutoff);
    if (filtered.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, filtered);
  }
}, 5 * 60 * 1000);

function requireApiKey(expected: string | undefined, provided: unknown) {
  if (!expected) return { ok: false as const, code: 500, msg: "API key not configured" };
  if (typeof provided !== "string" || provided !== expected) return { ok: false as const, code: 401, msg: "Unauthorized" };
  return { ok: true as const };
}

// SESSION 18 : Notification Discord pour les process admin (lancements manuels)
const DISCORD_GREEN = 3066993;   // succès
const DISCORD_RED = 15158332;    // erreur
async function notifyDiscord(webhookUrl: string | undefined, title: string, description: string, color: number): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color,
          footer: { text: "GameNime · Panneau admin" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) {
    app.log.warn({ err: (e as any)?.message }, "Discord notify failed");
  }
}
// Helper : notifie succès (workflows) ou erreur (erreurs) selon le résultat
async function notifyProcessResult(label: string, ok: boolean, summary: string): Promise<void> {
  if (ok) {
    await notifyDiscord(process.env.DISCORD_WEBHOOK_WORKFLOWS, "✅ " + label, summary, DISCORD_GREEN);
  } else {
    await notifyDiscord(process.env.DISCORD_WEBHOOK_ERRORS, "❌ " + label, summary, DISCORD_RED);
  }
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

    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";
    const userAgent = String(req.headers["user-agent"] || "");

    // Fire-and-forget: welcome + verification emails must never block registration
    void sendWelcomeEmail({ email, displayName }).catch(() => {});
    void sendVerificationEmail({ db: pool, userId, email, displayName, ip, userAgent }).catch(() => {});

    return reply.code(201).send({ ok: true, user: { id: userId, email, displayName, emailVerified: false } });
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

// ============================================================
// Password reset flow (ETAT CLEAN)
// - Step 1: user requests a reset link (rate limited per IP+email)
// - Step 2: user clicks link, submits new password (token verified)
// ============================================================

app.post("/auth/request-password-reset", async (req, reply) => {
  try {
    const body = requestPasswordResetSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";

    // Rate limit: max 3 requests per 15 minutes per IP+email
    const rlKey = `pwreset:${ip}:${email}`;
    if (!checkRateLimit(rlKey, 3, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Trop de demandes. Réessaie dans 15 minutes." });
    }

    // Lookup user (silently succeed even if user doesn't exist - prevents email enumeration)
    const rows: any = await pool.query(
      `SELECT id, email, display_name FROM users WHERE email = ? LIMIT 1`,
      [email]
    );

    if (rows.length) {
      const u = rows[0];
      const userAgent = String(req.headers["user-agent"] || "");
      // Fire-and-forget: never let email failure leak user existence
      void sendPasswordResetEmail({
        db: pool,
        userId: Number(u.id),
        email: u.email,
        displayName: u.display_name,
        ip,
        userAgent,
      }).catch((e) => req.log.error(e, "sendPasswordResetEmail failed"));
    }

    // Always return same response to prevent email enumeration attack
    return reply.send({ ok: true, message: "Si cet email existe, un lien a été envoyé." });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Email invalide", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/auth/reset-password", async (req, reply) => {
  try {
    const body = resetPasswordSchema.parse(req.body);
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";

    // Rate limit: max 5 attempts per 15 minutes per IP (defense against token brute force)
    const rlKey = `pwconsume:${ip}`;
    if (!checkRateLimit(rlKey, 5, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Trop de tentatives. Réessaie dans 15 minutes." });
    }

    // Verify and consume token (atomic)
    const result = await consumePasswordResetToken(pool, body.token);
    if (!result.ok) {
      const msg = result.reason === "expired"
        ? "Lien expiré, demande un nouveau lien."
        : result.reason === "already_used"
        ? "Lien déjà utilisé, demande un nouveau lien."
        : "Lien invalide.";
      return reply.code(400).send({ error: msg });
    }

    // Update password
    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await pool.query(
      `UPDATE users SET password_hash = ? WHERE id = ?`,
      [passwordHash, result.userId]
    );

    // Invalidate all existing sessions for this user (security best practice)
    await pool.query(
      `DELETE FROM user_sessions WHERE user_id = ?`,
      [result.userId]
    );

    return reply.send({ ok: true, message: "Mot de passe mis à jour. Reconnecte-toi." });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Données invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ============================================================
// Email verification flow (ETAT CLEAN)
// ============================================================

app.post("/auth/verify-email", async (req, reply) => {
  try {
    const body = verifyEmailSchema.parse(req.body);
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";

    // Rate limit: max 5 attempts per 15 minutes per IP
    const rlKey = `verifyemail:${ip}`;
    if (!checkRateLimit(rlKey, 5, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Trop de tentatives. Réessaie dans 15 minutes." });
    }

    const result = await consumeVerificationToken(pool, body.token);
    if (!result.ok) {
      const msg = result.reason === "expired"
        ? "Lien expiré, demande un nouveau lien."
        : result.reason === "already_used"
        ? "Email déjà confirmé."
        : "Lien invalide.";
      return reply.code(400).send({ error: msg });
    }

    return reply.send({ ok: true, message: "Email confirmé avec succès." });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Données invalides", details: err.errors });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/auth/resend-verification", async (req, reply) => {
  try {
    const body = resendVerificationSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";

    // Rate limit: max 2 resends per 15 minutes per IP+email
    const rlKey = `resendverify:${ip}:${email}`;
    if (!checkRateLimit(rlKey, 2, 15 * 60 * 1000)) {
      return reply.code(429).send({ error: "Trop de demandes. Réessaie dans 15 minutes." });
    }

    const rows: any = await pool.query(
      `SELECT id, email, display_name, email_verified FROM users WHERE email = ? LIMIT 1`,
      [email]
    );

    if (rows.length && !rows[0].email_verified) {
      const u = rows[0];
      const userAgent = String(req.headers["user-agent"] || "");
      void (async () => {
        try {
          const result = await sendVerificationEmail({
            db: pool,
            userId: Number(u.id),
            email: u.email,
            displayName: u.display_name,
            ip,
            userAgent,
          });
          console.log("[resend-verification] Result:", JSON.stringify(result));
        } catch (e: any) {
          console.error("[resend-verification] EXCEPTION:", e?.message, e?.stack);
        }
      })();
    }

    // Always return same response (anti-enumeration)
    return reply.send({ ok: true, message: "Si cet email existe et n'est pas confirmé, un lien a été envoyé." });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return reply.code(400).send({ error: "Email invalide", details: err.errors });
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
        emailVerified: user.emailVerified,
        avatar: user.avatar,
        isPremium: user.isPremium,
        premiumPlan: user.premiumPlan,
        premiumExpiresAt: user.premiumExpiresAt,
      }
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ── Premium endpoints ──────────────────────────────
app.get("/premium/status", async (req, reply) => {
  const user = await requireAuth(req, reply);
  if (!user) return;
  try {
    const auditRows: any = await pool.query(
      `SELECT action, old_plan, new_plan, new_expires_at, actor, reason, created_at FROM premium_audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );
    return reply.send({
      isPremium: user.isPremium,
      plan: user.premiumPlan,
      expiresAt: user.premiumExpiresAt,
      history: auditRows.map((r: any) => ({
        action: r.action,
        oldPlan: r.old_plan,
        newPlan: r.new_plan,
        newExpiresAt: r.new_expires_at,
        actor: r.actor,
        reason: r.reason,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/premium/cancel", async (req, reply) => {
  const user = await requireAuth(req, reply);
  if (!user) return;
  if (!user.isPremium) {
    return reply.code(400).send({ error: "Aucun abonnement actif" });
  }
  try {
    await pool.query(
      `UPDATE users SET is_premium = 0, premium_plan = NULL WHERE id = ?`,
      [user.id]
    );
    await logPremiumAction(user.id, "cancel", {
      oldPlan: user.premiumPlan,
      oldExpiresAt: user.premiumExpiresAt,
      actor: "user",
      reason: "User manual cancel",
    });
    return reply.send({ ok: true, message: "Abonnement annulé" });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/premium/generate-reminders", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ error: auth.msg });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const results = { created: 0, skipped: 0, details: [] as any[] };

    for (const offset of [7, 0]) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + offset);
      const targetStr = targetDate.toISOString().slice(0, 10);

      for (const itemType of ["anime", "game"] as const) {
        const table = itemType === "anime" ? "anime_items" : "game_items";

        const rows: any = await pool.query(
          `SELECT DISTINCT f.user_id, i.id AS item_id, i.title, i.cover, i.platform, i.release_date,
                  u.email AS user_email, u.display_name AS user_display_name,
                  u.email_notifications_enabled AS user_email_enabled,
                  u.email_verified AS user_email_verified,
                  u.is_premium AS user_is_premium,
                  u.premium_expires_at AS user_premium_expires_at,
                  u.notifications_enabled AS user_notifs_enabled
           FROM favorites f
           INNER JOIN ${table} i ON i.id = f.item_id
           INNER JOIN users u ON u.id = f.user_id
           WHERE f.item_type = ?
             AND DATE(i.release_date) = ?
             AND u.notifications_enabled = 1
             AND NOT EXISTS (
               SELECT 1 FROM reminder_log r
               WHERE r.user_id = f.user_id
                 AND r.item_type = ?
                 AND r.item_id = i.id
                 AND r.day_offset = ?
             )`,
          [itemType, targetStr, itemType, offset]
        );

        for (const row of rows) {
          const label = offset === 0 ? "Sortie aujourd\x27hui !" : (offset === 1 ? "Sortie demain !" : "Sortie dans 7 jours");
          const eventType = `reminder_j${offset}`;
          const eventKey = `${itemType}:${row.item_id}:${eventType}:${targetStr}`;
          const payload = JSON.stringify({ title: row.title, cover: row.cover, label, releaseDate: row.release_date, daysLeft: offset });

          await pool.query(
            `INSERT INTO notification_events (item_type, item_id, event_type, event_key, payload_json) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_at = event_at`,
            [itemType, row.item_id, eventType, eventKey, payload]
          );
          const eventRows: any = await pool.query(`SELECT id FROM notification_events WHERE event_key = ? LIMIT 1`, [eventKey]);
          const eventId = eventRows[0].id;

          // FREE LAUNCH : tout le monde recoit en instantane (deliver_at NULL)
          // L'infra Premium reste en place (vierge) pour un futur Premium different
          await pool.query(
            `INSERT INTO user_notifications (user_id, event_id, deliver_at) VALUES (?, ?, NULL) ON DUPLICATE KEY UPDATE event_id = event_id`,
            [row.user_id, eventId]
          );

          await pool.query(
            `INSERT INTO reminder_log (user_id, item_type, item_id, day_offset, release_date) VALUES (?, ?, ?, ?, ?)`,
            [row.user_id, itemType, row.item_id, offset, targetStr]
          );

          // FREE LAUNCH : email pour tous ceux qui l'ont active + verifie
          // Email envoye UNIQUEMENT le Jour J (offset 0) pour ne pas spammer. In-app reste sur J-7 et J-0.
          const reminderEmailEligible = !!(offset === 0 && Number(row.user_email_enabled) === 1 && Number(row.user_email_verified) === 1);
          if (reminderEmailEligible) {
            void (async () => {
              try {
                const emailResult = await sendReminderEmail({
                  email: row.user_email,
                  displayName: row.user_display_name,
                  itemTitle: row.title,
                  itemCover: row.cover,
                  itemType,
                  itemId: row.item_id,
                  daysLeft: offset,
                  releaseDate: row.release_date ? String(row.release_date).slice(0, 10) : null,
                  platform: row.platform || null,
                });
                if (emailResult.ok) {
                  await pool.query(
                    `UPDATE reminder_log SET email_sent_at = NOW() WHERE user_id = ? AND item_type = ? AND item_id = ? AND day_offset = ?`,
                    [row.user_id, itemType, row.item_id, offset]
                  );
                }
              } catch (e) { /* fire-and-forget */ }
            })();
          }

          results.created++;
          results.details.push({ user_id: row.user_id, item_type: itemType, title: row.title, offset, label, email_eligible: reminderEmailEligible });
        }
      }
    }

    return reply.send({ ok: true, ...results });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.get("/premium/preferences", async (req, reply) => {
  const user = await requirePremium(req, reply);
  if (!user) return;
  try {
    const rows: any = await pool.query(
      `SELECT alert_genres, alert_platforms, reminder_days_before, agenda_type, agenda_platforms, agenda_confirmed, agenda_alarms FROM user_alert_preferences WHERE user_id = ?`,
      [user.id]
    );
    if (!rows.length) {
      return reply.send({ alertGenres: [], alertPlatforms: [], reminderDaysBefore: [7, 0], agendaType: "", agendaPlatforms: [], agendaConfirmed: false, agendaAlarms: [] });
    }
    const p = rows[0];
    return reply.send({
      alertGenres: parseJsonSafe(p.alert_genres, []),
      alertPlatforms: parseJsonSafe(p.alert_platforms, []),
      reminderDaysBefore: parseJsonSafe(p.reminder_days_before, [7, 0]),
      agendaType: p.agenda_type || "",
      agendaPlatforms: parseJsonSafe(p.agenda_platforms, []),
      agendaConfirmed: p.agenda_confirmed === 1,
      agendaAlarms: parseJsonSafe(p.agenda_alarms, []),
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.patch("/premium/preferences", async (req, reply) => {
  const user = await requirePremium(req, reply);
  if (!user) return;
  try {
    const body = req.body as any;
    const alertGenres = Array.isArray(body.alertGenres) ? body.alertGenres.slice(0, 30).map(String) : [];
    const alertPlatforms = Array.isArray(body.alertPlatforms) ? body.alertPlatforms.slice(0, 30).map(String) : [];
    const reminderDays = Array.isArray(body.reminderDaysBefore) ? body.reminderDaysBefore.filter((d: any) => [0, 7].includes(Number(d))) : [7, 0];
    const agendaType = (body.agendaType === "anime" || body.agendaType === "game") ? body.agendaType : "";
    const agendaPlatforms = Array.isArray(body.agendaPlatforms) ? body.agendaPlatforms.slice(0, 20).map(String) : [];
    const agendaConfirmed = (body.agendaConfirmed === true || body.agendaConfirmed === 1) ? 1 : 0;
    const agendaAlarms = Array.isArray(body.agendaAlarms) ? body.agendaAlarms.filter((d: any) => [0, 1, 7].includes(Number(d))).map(Number) : [];

    await pool.query(
      `INSERT INTO user_alert_preferences (user_id, alert_genres, alert_platforms, reminder_days_before, agenda_type, agenda_platforms, agenda_confirmed, agenda_alarms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE alert_genres = VALUES(alert_genres), alert_platforms = VALUES(alert_platforms), reminder_days_before = VALUES(reminder_days_before), agenda_type = VALUES(agenda_type), agenda_platforms = VALUES(agenda_platforms), agenda_confirmed = VALUES(agenda_confirmed), agenda_alarms = VALUES(agenda_alarms)`,
      [user.id, JSON.stringify(alertGenres), JSON.stringify(alertPlatforms), JSON.stringify(reminderDays), agendaType, JSON.stringify(agendaPlatforms), agendaConfirmed, JSON.stringify(agendaAlarms)]
    );
    return reply.send({ ok: true, alertGenres, alertPlatforms, reminderDaysBefore: reminderDays, agendaType, agendaPlatforms, agendaConfirmed: agendaConfirmed === 1, agendaAlarms });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/premium/generate-alerts", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ error: auth.msg });

  try {
    const hours = Math.max(Math.min(Number((req.query as any)?.hours || 24), 720), 1);
    const results = { created: 0, scanned: 0, details: [] as any[] };

    const prefsRows: any = await pool.query(
      `SELECT p.user_id, p.alert_genres, p.alert_platforms,
              u.email AS user_email, u.display_name AS user_display_name,
              u.email_notifications_enabled AS user_email_enabled,
              u.email_verified AS user_email_verified
       FROM user_alert_preferences p
       INNER JOIN users u ON u.id = p.user_id
       WHERE (p.alert_genres IS NOT NULL OR p.alert_platforms IS NOT NULL)`
    );

    if (!prefsRows.length) {
      return reply.send({ ok: true, ...results, message: "Aucun user avec prefs" });
    }

    for (const itemType of ["anime", "game"] as const) {
      const table = itemType === "anime" ? "anime_items" : "game_items";
      const items: any = await pool.query(
        `SELECT id, title, cover, genre, platform, release_date FROM ${table} WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
        [hours]
      );
      results.scanned += items.length;

      for (const item of items) {
        const itemGenres = (item.genre || "").toLowerCase().split(",").map((g: string) => g.trim()).filter(Boolean);
        const itemPlatforms = (item.platform || "").toLowerCase().split(",").map((p: string) => p.trim()).filter(Boolean);

        for (const prefRow of prefsRows) {
          const userGenres = parseJsonSafe(prefRow.alert_genres, []);
          const userPlatforms = parseJsonSafe(prefRow.alert_platforms, []);
          let genreMatch: string | null = null;
          let platformMatch: string | null = null;

          for (const g of userGenres) {
            const gLower = String(g).toLowerCase();
            if (itemGenres.some((ig: string) => ig.includes(gLower) || gLower.includes(ig))) {
              genreMatch = g;
              break;
            }
          }

          for (const p of userPlatforms) {
            const pLower = String(p).toLowerCase();
            if (pLower === "mobile") {
              if (itemPlatforms.some((ip: string) => ip.includes("ios") || ip.includes("android"))) {
                platformMatch = p;
                break;
              }
            } else if (pLower === "pc") {
              if (itemPlatforms.some((ip: string) => ip.includes("pc") || ip.includes("web"))) {
                platformMatch = p;
                break;
              }
            } else if (itemPlatforms.some((ip: string) => ip.includes(pLower))) {
              platformMatch = p;
              break;
            }
          }

          // Require BOTH genre AND platform match
          if (!genreMatch || !platformMatch) continue;

          const matchType = "combined";
          const matchValue = `${genreMatch} sur ${platformMatch}`;


          const existingRows: any = await pool.query(
            `SELECT id FROM alert_log WHERE user_id = ? AND item_type = ? AND item_id = ? LIMIT 1`,
            [prefRow.user_id, itemType, item.id]
          );
          if (existingRows.length) continue;

          const label = `Nouveau ${genreMatch} sur ${platformMatch}`;
          const eventType = "alert_combined_match";
          const eventKey = `${itemType}:${item.id}:${eventType}:${prefRow.user_id}`;
          const payload = JSON.stringify({ title: item.title, cover: item.cover, label, match: matchValue, releaseDate: item.release_date });

          await pool.query(
            `INSERT INTO notification_events (item_type, item_id, event_type, event_key, payload_json) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_at = event_at`,
            [itemType, item.id, eventType, eventKey, payload]
          );
          const eventRows: any = await pool.query(`SELECT id FROM notification_events WHERE event_key = ? LIMIT 1`, [eventKey]);
          const eventId = eventRows[0].id;

          await pool.query(
            `INSERT INTO user_notifications (user_id, event_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE event_id = event_id`,
            [prefRow.user_id, eventId]
          );

          await pool.query(
            `INSERT INTO alert_log (user_id, item_type, item_id, match_type, match_value) VALUES (?, ?, ?, ?, ?)`,
            [prefRow.user_id, itemType, item.id, matchType, matchValue]
          );

          const alertEmailEligible = !!(Number(prefRow.user_email_enabled) === 1 && Number(prefRow.user_email_verified) === 1);
          if (alertEmailEligible) {
            void (async () => {
              try {
                const emailResult = await sendAlertEmail({
                  email: prefRow.user_email,
                  displayName: prefRow.user_display_name,
                  itemTitle: item.title,
                  itemCover: item.cover,
                  itemType,
                  itemId: item.id,
                  matchValue,
                  platform: item.platform || null,
                  releaseDate: item.releaseDate || null,
                });
                if (emailResult.ok) {
                  await pool.query(
                    `UPDATE alert_log SET email_sent_at = NOW() WHERE user_id = ? AND item_type = ? AND item_id = ?`,
                    [prefRow.user_id, itemType, item.id]
                  );
                }
              } catch (e) { /* fire-and-forget */ }
            })();
          }

          results.created++;
          results.details.push({ user_id: prefRow.user_id, item_type: itemType, title: item.title, matchType, matchValue, email_eligible: alertEmailEligible });
        }
      }
    }

    return reply.send({ ok: true, ...results });
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

app.post("/auth/reset-password-legacy", async (req, reply) => {
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

// ── Calendar export (ICS) ──────────────────────────
app.get("/me/calendar-token", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    const rows: any = await pool.query(
      `SELECT calendar_token FROM users WHERE id = ?`,
      [user.id]
    );
    let token = rows?.[0]?.calendar_token || null;
    if (!token) {
      token = randomBytes(32).toString("hex");
      await pool.query(`UPDATE users SET calendar_token = ? WHERE id = ?`, [token, user.id]);
    }
    const base = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
    const host = base.replace(/^https?:\/\//, "");
    return reply.send({
      ok: true,
      token,
      url: `${base}/cal/${token}.ics`,
      webcal: `webcal://${host}/cal/${token}.ics`,
    });
  } catch (err: any) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

app.post("/me/calendar-token/regenerate", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    const token = randomBytes(32).toString("hex");
    await pool.query(`UPDATE users SET calendar_token = ? WHERE id = ?`, [token, user.id]);
    const base = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
    const host = base.replace(/^https?:\/\//, "");
    return reply.send({
      ok: true,
      token,
      url: `${base}/cal/${token}.ics`,
      webcal: `webcal://${host}/cal/${token}.ics`,
    });
  } catch (err: any) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ── Calendar ICS feed (public, via token) ──────────
function icsEscape(s: string | null): string {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
function icsDate(d: any): string {
  // Format YYYYMMDD pour un evenement "toute la journee"
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function icsDateNextDay(d: any): string {
  const dt = new Date(d);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return icsDate(dt);
}

app.get("/cal/:token.ics", async (req, reply) => {
  try {
    const token = (req.params as any).token;
    if (!token || typeof token !== "string" || token.length < 32) {
      return reply.code(404).send("Not found");
    }
    const users = await pool.query(
      `SELECT id FROM users WHERE calendar_token = ? LIMIT 1`,
      [token]
    );
    if (!users || users.length === 0) {
      return reply.code(404).send("Not found");
    }
    const userId = users[0].id;

    // Agenda simple : tous les favoris avec vraie date (exclut precision=year — Q3)
    const rows = await pool.query(
      `SELECT f.item_type, i.title, i.title_english AS titleEnglish, i.platform,
              i.release_precision AS releasePrecision,
              DATE_FORMAT(i.release_date, '%Y-%m-%d') AS releaseDate
       FROM favorites f
       INNER JOIN anime_items i ON f.item_type = 'anime' AND f.item_id = i.id
       WHERE f.user_id = ?
         AND i.release_date IS NOT NULL
         AND (i.release_precision IS NULL OR i.release_precision != 'year')
       UNION ALL
       SELECT f.item_type, g.title, g.title_english AS titleEnglish, g.platform,
              g.release_precision AS releasePrecision,
              DATE_FORMAT(g.release_date, '%Y-%m-%d') AS releaseDate
       FROM favorites f
       INNER JOIN game_items g ON f.item_type = 'game' AND f.item_id = g.id
       WHERE f.user_id = ?
         AND g.release_date IS NOT NULL
         AND (g.release_precision IS NULL OR g.release_precision != 'year')`,
      [userId, userId]
    );

    const favorites = rows as any[];

    const base = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
    const now = new Date();
    const stamp = `${icsDate(now)}T000000Z`;

    let ics = "BEGIN:VCALENDAR\r\n";
    ics += "VERSION:2.0\r\n";
    ics += "PRODID:-//GameNime//Radar Sorties//FR\r\n";
    ics += "CALSCALE:GREGORIAN\r\n";
    ics += "METHOD:PUBLISH\r\n";
    ics += "X-WR-CALNAME:GameNime — Mes sorties\r\n";
    ics += "X-WR-TIMEZONE:Europe/Paris\r\n";

    for (const it of favorites) {
      const title = it.titleEnglish || it.title || "Sortie";
      const emoji = it.item_type === "anime" ? "📺" : "🎮";
      const platform = it.platform ? ` — ${it.platform}` : "";
      const uid = `${it.item_type}-${icsDate(it.releaseDate)}-${Buffer.from(title).toString("hex").slice(0, 16)}@gamenime.fr`;
      ics += "BEGIN:VEVENT\r\n";
      ics += `UID:${uid}\r\n`;
      ics += `DTSTAMP:${stamp}\r\n`;
      ics += `DTSTART;VALUE=DATE:${icsDate(it.releaseDate)}\r\n`;
      ics += `DTEND;VALUE=DATE:${icsDateNextDay(it.releaseDate)}\r\n`;
      ics += `SUMMARY:${emoji} ${icsEscape(title)}\r\n`;
      ics += `DESCRIPTION:${icsEscape("Sortie" + platform + " · via GameNime " + base)}\r\n`;
      ics += "END:VEVENT\r\n";
    }

    ics += "END:VCALENDAR\r\n";

    reply.header("Content-Type", "text/calendar; charset=utf-8");
    reply.header("Content-Disposition", 'inline; filename="gamenime.ics"');
    return reply.send(ics);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send("Error");
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


app.get("/notifications/stream", async (req, reply) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return reply.code(401).send({ error: "Non authentifié" });
  // FREE LAUNCH : SSE temps reel ouvert a tous les users connectes

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();

  reply.raw.write(`: connected at ${new Date().toISOString()}\n\n`);

  const channel = `user:${user.id}`;
  const listener = (notification: any) => {
    try {
      reply.raw.write(`event: notification\n`);
      reply.raw.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch (e) { /* client disconnected */ }
  };
  notifBus.on(channel, listener);

  const keepalive = setInterval(() => {
    try { reply.raw.write(`: ping\n\n`); } catch (e) {}
  }, 30000);

  req.raw.on("close", () => {
    clearInterval(keepalive);
    notifBus.off(channel, listener);
  });
});
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
       WHERE user_id = ? AND is_read = 0
         AND (deliver_at IS NULL OR deliver_at <= NOW())`,
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

app.delete("/notifications/:id", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });
    const params = notificationParamsSchema.parse(req.params);
    const result: any = await pool.query(
      `DELETE FROM user_notifications WHERE id = ? AND user_id = ?`,
      [params.id, user.id]
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


// ────────────────────────────────────────────────────
// PATCH /me/notification-channels — toggle in-app / email
// SESSION 12.7+: Free = in-app uniquement. Email = Premium only.
// Le serveur applique cette règle indépendamment du frontend.
// ────────────────────────────────────────────────────
app.patch("/me/notification-channels", async (req, reply) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return reply.code(401).send({ error: "Non authentifié" });

    const schema = z.object({
      notificationsEnabled: z.boolean().optional(),
      emailNotificationsEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    const { notificationsEnabled, emailNotificationsEnabled } = parsed.data;
    const updates: string[] = [];
    const params: any[] = [];

    if (typeof notificationsEnabled === "boolean") {
      updates.push("notifications_enabled = ?");
      params.push(notificationsEnabled ? 1 : 0);
    }

    if (typeof emailNotificationsEnabled === "boolean") {
      // FREE LAUNCH : email activable par tous (plus de restriction Premium)
      updates.push("email_notifications_enabled = ?");
      params.push(emailNotificationsEnabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: "no_changes" });
    }

    params.push(user.id);
    await pool.query(
      "UPDATE users SET " + updates.join(", ") + " WHERE id = ?",
      params
    );

    const updated: any = await pool.query(
      "SELECT notifications_enabled AS notificationsEnabled, email_notifications_enabled AS emailNotificationsEnabled FROM users WHERE id = ?",
      [user.id]
    );
    return reply.send({
      ok: true,
      notificationsEnabled: Number(updated[0].notificationsEnabled) === 1,
      emailNotificationsEnabled: Number(updated[0].emailNotificationsEnabled) === 1,
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Erreur serveur" });
  }
});

// ── Notification helpers ───────────────────────────
function isBlankNotificationValue(v: any): boolean {
  return v === null || v === undefined || String(v).trim() === "" || String(v).trim() === "Unknown";
}


/**
 * Creates a user notification + emits via SSE for real-time delivery to Premium users.
 * Returns true if inserted (new), false if already existed.
 */
async function createUserNotificationWithSSE(
  db: any,
  userId: number,
  eventId: number,
  context: {
    itemType: "anime" | "game";
    itemId: number;
    eventType: string;
    eventKey: string;
    payload: any;
  }
): Promise<boolean> {
  const result: any = await db.query(
    `INSERT INTO user_notifications (user_id, event_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE event_id = event_id`,
    [userId, eventId]
  );
  const isNew = Number(result.affectedRows || 0) === 1;
  if (isNew) {
    try {
      emitNotification(userId, {
        id: eventId,
        itemType: context.itemType,
        itemId: context.itemId,
        eventType: context.eventType,
        eventKey: context.eventKey,
        payload: context.payload,
        eventAt: new Date().toISOString(),
      });
    } catch (e) { console.error("SSE emit failed:", e); }
  }
  return isNew;
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

  // FREE LAUNCH : livraison instantanee pour tous (deliver_at = NULL)
  await db.query(
    `INSERT IGNORE INTO user_notifications (user_id, event_id, deliver_at)
     SELECT f.user_id, ?, NULL AS deliver_at
     FROM favorites f
     INNER JOIN users u ON u.id = f.user_id
     WHERE f.item_type = ? AND f.item_id = ? AND u.notifications_enabled = 1`,
    [eventId, itemType, itemId]
  );

  // FREE LAUNCH : emit temps reel SSE a tous les users avec notifs activees
  try {
    const targetRows: any = await db.query(
      `SELECT f.user_id FROM favorites f INNER JOIN users u ON u.id = f.user_id WHERE f.item_type = ? AND f.item_id = ? AND u.notifications_enabled = 1`,
      [itemType, itemId]
    );
    const sseNotif = { id: eventId, itemType, itemId, eventType, eventKey, payload, eventAt: new Date().toISOString() };
    for (const row of targetRows) {
      emitNotification(row.user_id, sseNotif);
    }
  } catch (e) {
    console.error("SSE emit failed:", e);
  }
}

async function createNotificationsForItemChange(
  db: any,
  itemType: "anime" | "game",
  before: any,
  after: any
) {
  if (!before || !after || !after.id) return;
  const title = after.title || before.title || null;
  const cover = after.cover || before.cover || null;

  if (isBlankNotificationValue(before.platform) && !isBlankNotificationValue(after.platform)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_platform_added`,
      `${itemType}:${after.id}:platform_added:${sha256(String(after.platform)).slice(0, 12)}`,
      { title, cover, label: "Plateforme ajoutée", oldValue: before.platform || null, newValue: after.platform });
  }

  if (isBlankNotificationValue(before.trailerUrl) && !isBlankNotificationValue(after.trailerUrl)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_trailer_added`,
      `${itemType}:${after.id}:trailer_added:${sha256(String(after.trailerUrl)).slice(0, 12)}`,
      { title, cover, label: "Trailer ajouté", oldValue: before.trailerUrl || null, newValue: after.trailerUrl });
  }

  if (isBlankNotificationValue(before.releaseDate) && !isBlankNotificationValue(after.releaseDate)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_release_date_announced`,
      `${itemType}:${after.id}:release_date:${after.releaseDate}`,
      { title, cover, label: "Date annoncée", oldValue: before.releaseDate || null, newValue: after.releaseDate });
  }

  if (isBlankNotificationValue(before.cover) && !isBlankNotificationValue(after.cover)) {
    await createNotificationEventAndFanout(db, itemType, Number(after.id),
      `${itemType}_cover_added`,
      `${itemType}:${after.id}:cover_added`,
      { title, cover, label: "Image ajoutée", newValue: "Nouvelle image disponible" });
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
        { title, cover, label: "Nouvel épisode", oldValue: beforeEp ? String(beforeEp) + " épisodes" : null, newValue: afterEp + " épisodes" });
    }

    const beforeSeason = String(before.description || "").match(/\[SEASON:([^\]]+)\]/);
    const afterSeason = String(after.description || "").match(/\[SEASON:([^\]]+)\]/);
    if (afterSeason && (!beforeSeason || beforeSeason[1] !== afterSeason[1])) {
      await createNotificationEventAndFanout(db, itemType, Number(after.id),
        `${itemType}_season_added`,
        `${itemType}:${after.id}:season:${sha256(afterSeason[1]).slice(0, 12)}`,
        { title, cover, label: "Nouvelle saison", oldValue: beforeSeason ? beforeSeason[1] : null, newValue: afterSeason[1] });
    }

    const beforeNext = String(before.description || "").match(/\[NEXT_EP:(\d+)\]/);
    const afterNext = String(after.description || "").match(/\[NEXT_EP:(\d+)\]/);
    const beforeNextN = beforeNext ? Number(beforeNext[1]) : 0;
    const afterNextN = afterNext ? Number(afterNext[1]) : 0;
    if (afterNextN > beforeNextN && afterNextN > 0) {
      await createNotificationEventAndFanout(db, itemType, Number(after.id),
        `${itemType}_next_episode`,
        `${itemType}:${after.id}:next_ep:${afterNextN}`,
        { title, cover, label: "Épisode " + afterNextN + " à venir", newValue: "Épisode " + afterNextN });
    }
  }

  // DLC detection for games (Premium feature: detailed tracking)
  if (itemType === "game") {
    const beforeDlcs = parseJsonSafe<any[]>(before.dlcs, []);
    const afterDlcs = parseJsonSafe<any[]>(after.dlcs, []);
    if (Array.isArray(afterDlcs) && afterDlcs.length > beforeDlcs.length) {
      const beforeNames = new Set(beforeDlcs.map((d: any) => String(d?.name || "").toLowerCase()).filter(Boolean));
      for (const dlc of afterDlcs) {
        const dlcName = String(dlc?.name || "").trim();
        if (!dlcName) continue;
        if (beforeNames.has(dlcName.toLowerCase())) continue;
        const dlcKey = sha256(dlcName.toLowerCase()).slice(0, 12);
        const hasReleaseDate = dlc?.releaseDate && String(dlc.releaseDate).match(/^\d{4}-\d{2}-\d{2}/);
        const now = new Date();
        const dlcDate = hasReleaseDate ? new Date(String(dlc.releaseDate)) : null;
        const isReleased = dlcDate !== null && dlcDate <= now;
        const eventType = isReleased ? "game_dlc_released" : "game_dlc_announced";
        const label = isReleased ? "DLC disponible" : "Nouveau DLC annoncé";
        await createNotificationEventAndFanout(db, itemType, Number(after.id),
          eventType,
          `${itemType}:${after.id}:dlc:${dlcKey}`,
          { title, cover, label, newValue: dlcName, releaseDate: dlc?.releaseDate || null, description: dlc?.description || null });
      }
    }
  }
}


// ── Phase B refetch endpoint ──
app.post("/admin/refetch-incomplete", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  return adminRefetchHandler(app, req, reply);
});

// SESSION 18 : Refetch UN item precis par ID (bouton "Reparer" admin)
app.post("/admin/refetch-one", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  const q = req.query as any;
  const id = Number(q.id);
  const type = q.type;
  if (!id || !Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ ok: false, msg: "id invalide" });
  }
  if (type !== "anime" && type !== "game") {
    return reply.code(400).send({ ok: false, msg: "type doit etre 'anime' ou 'game'" });
  }
  const result = type === "anime"
    ? await refetchOneAnimeItem(app, id)
    : await refetchOneGameItem(app, id);
  return reply.send(result);
});

// SESSION 18 : Supprimer un item + l'ajouter à la blocklist (rejet pur, empêche le retour)
app.delete("/admin/items/:type/:id", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  const params = req.params as any;
  const type = String(params.type || "");
  const id = parseInt(String(params.id || ""), 10);
  if ((type !== "anime" && type !== "game") || !id || isNaN(id)) {
    return reply.code(400).send({ ok: false, msg: "type (anime|game) et id requis" });
  }
  const pool = (app as any).pool;
  const table = type === "anime" ? "anime_items" : "game_items";
  try {
    // 1. Récupérer l'item AVANT suppression (pour memo blocklist)
    const rows = await pool.query(
      `SELECT id, title, title_normalized_strict AS normalized, cover, anilist_id, mal_id FROM ${table} WHERE id = ?`,
      [id]
    );
    if (!rows.length) return reply.send({ ok: true, found: false, msg: "Item introuvable" });
    const it = rows[0];
    // 2. Ajouter à merge_blocklist avec redirect_to_id = -1 (rejet pur)
    await pool.query(
      `INSERT INTO merge_blocklist
       (item_type, blocked_title, blocked_normalized, blocked_cover, blocked_anilist_id, blocked_mal_id, redirect_to_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, -1, ?)`,
      [type, it.title || "", it.normalized || null, it.cover || null, it.anilist_id || null, it.mal_id || null, "Supprime manuellement via admin"]
    );
    // 3. DELETE l'item
    await pool.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    app.log.info({ id, type, title: it.title }, "admin.delete-item + blocklist");
    return reply.send({ ok: true, found: true, deleted: true, blocklisted: true, title: it.title });
  } catch (e) {
    app.log.error({ err: (e as any)?.message, id, type }, "admin.delete-item failed");
    return reply.code(500).send({ ok: false, msg: (e as any)?.message || "erreur" });
  }
});

// SESSION 18 : Voir la donnée brute des sources externes pour un item
app.get("/admin/item-raw-sources", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  const q = req.query as any;
  const id = parseInt(String(q.id || ""), 10);
  const type = String(q.type || "");
  if ((type !== "anime" && type !== "game") || !id || isNaN(id)) {
    return reply.code(400).send({ ok: false, msg: "type (anime|game) et id requis" });
  }
  const pool = (app as any).pool;
  try {
    if (type === "anime") {
      const rows = await pool.query(`SELECT id, title, anilist_id, mal_id FROM anime_items WHERE id = ?`, [id]);
      if (!rows.length) return reply.send({ ok: true, found: false });
      const it = rows[0];
      const [anilist, jikan] = await Promise.all([
        it.anilist_id ? fetchAniList(it.anilist_id) : Promise.resolve(null),
        it.mal_id ? fetchJikan(it.mal_id) : Promise.resolve(null),
      ]);
      return reply.send({ ok: true, found: true, type, id, title: it.title,
        ids: { anilist_id: it.anilist_id, mal_id: it.mal_id },
        sources: { anilist, jikan } });
    } else {
      const rows = await pool.query(`SELECT id, title, rawg_id, igdb_id FROM game_items WHERE id = ?`, [id]);
      if (!rows.length) return reply.send({ ok: true, found: false });
      const it = rows[0];
      const [rawg, igdb] = await Promise.all([
        it.rawg_id ? fetchRawg(it.rawg_id) : Promise.resolve(null),
        it.igdb_id ? fetchIgdb(it.igdb_id) : Promise.resolve(null),
      ]);
      return reply.send({ ok: true, found: true, type, id, title: it.title,
        ids: { rawg_id: it.rawg_id, igdb_id: it.igdb_id },
        sources: { rawg, igdb } });
    }
  } catch (e) {
    app.log.error({ err: (e as any)?.message, id, type }, "admin.item-raw-sources failed");
    return reply.code(500).send({ ok: false, msg: (e as any)?.message || "erreur" });
  }
});

// SESSION 18 : Editer le trailer d'un item manuellement (force le remplacement, contourne lossless volontairement)
app.patch("/admin/item-trailer", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  const body = req.body as any;
  const id = parseInt(String(body?.id || ""), 10);
  const type = String(body?.type || "");
  let trailerUrl = String(body?.trailerUrl || "").trim();
  if ((type !== "anime" && type !== "game") || !id || isNaN(id)) {
    return reply.code(400).send({ ok: false, msg: "type (anime|game) et id requis" });
  }
  // Validation : URL YouTube valide OU vide (pour effacer)
  if (trailerUrl !== "") {
    const isYouTube = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]+/.test(trailerUrl);
    if (!isYouTube) {
      return reply.code(400).send({ ok: false, msg: "URL YouTube invalide (attendu: youtube.com/watch?v=... ou youtu.be/...)" });
    }
  }
  const pool = (app as any).pool;
  const table = type === "anime" ? "anime_items" : "game_items";
  try {
    const finalValue = trailerUrl === "" ? null : trailerUrl;
    const result = await pool.query(
      `UPDATE ${table} SET trailer_url = ?, updated_at = NOW() WHERE id = ?`,
      [finalValue, id]
    );
    const affected = result?.affectedRows ?? 0;
    if (affected === 0) return reply.send({ ok: true, found: false, msg: "Item introuvable" });
    app.log.info({ id, type, trailerUrl: finalValue }, "admin.edit-trailer");
    return reply.send({ ok: true, found: true, updated: true, trailerUrl: finalValue });
  } catch (e) {
    app.log.error({ err: (e as any)?.message, id, type }, "admin.edit-trailer failed");
    return reply.code(500).send({ ok: false, msg: (e as any)?.message || "erreur" });
  }
});


// Phase C : Lookup AniList IDs par titre (pour items legacy sans IDs externes)
app.post("/admin/lookup-anilist-ids", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  return adminLookupHandler(app, req, reply);
});


// Quality check J-7 : auto-enrichit les items sortant dans 7 jours, retourne ceux qui restent incomplets
app.post("/admin/quality-check-j7", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ ok: false, msg: auth.msg });
  return adminQualityCheckHandler(app, req, reply);
});


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
    if (q.noCover === "1") conditions.push("(cover IS NULL OR cover = '')");
    if (q.releasedAfter) { conditions.push("release_date >= ?"); params.push(q.releasedAfter); }
    if (q.releasedBefore) { conditions.push("release_date <= ?"); params.push(q.releasedBefore); }
    if (q.upcoming === "1") conditions.push("(release_date > CURDATE() OR release_precision = 'year')");
    if (q.released === "1") conditions.push("release_date <= CURDATE() AND (release_precision IS NULL OR release_precision != 'year')");
    if (q.genre) { conditions.push("genre LIKE ?"); params.push(`%${q.genre}%`); }
    if (q.platform) {
      const plats = String(q.platform).split(",").map((p:string) => p.trim()).filter(Boolean);
      const platConds: string[] = [];
      for (const p of plats) {
        if (p === "Mobile") {
          platConds.push("(platform LIKE ? OR platform LIKE ?)");
          params.push("%iOS%", "%Android%");
        } else if (p === "PC") {
          platConds.push("(platform LIKE ? OR platform LIKE ?)");
          params.push("%PC%", "%Web%");
        } else {
          platConds.push("platform LIKE ?");
          params.push(`%${p}%`);
        }
      }
      if (platConds.length) conditions.push("(" + platConds.join(" OR ") + ")");
    }
    if (q.search) { conditions.push("title LIKE ?"); params.push(`%${q.search}%`); }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const rows: any = await pool.query(
      `SELECT id, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,
              DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate,
              DATE_FORMAT(release_datetime,'%Y-%m-%dT%H:%i:%s') AS releaseDatetime,
              is_recently_released AS isRecentlyReleased, trailer_url AS trailerUrl,
              release_precision AS releasePrecision
       FROM ${table} ${where} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { items: rows, limit, offset };
  });

  app.get(`${prefix}/items/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };

    const rows: any = await pool.query(
      `SELECT id, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,
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

    const cleanedItems = parsed.data.items
      .filter(b => !isAdultContent(b.title, b.genre, b.rating))
      .map(b => ({
        ...b,
        // ETAT CLEAN: sanitize platform against whitelist
        // Garbage values (Unknown, studio names) become null
        platform: gnSanitizePlatform(b.platform),
      }));
    const filtered = parsed.data.items.length - cleanedItems.length;

    if (filtered > 0) req.log.info(`Filtered ${filtered} adult items`);
    if (cleanedItems.length === 0) {
      return reply.code(200).send({ ok: true, total: 0, filtered });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const b of cleanedItems) {
        // ETAT CLEAN: 3-key duplicate lookup
        //   1. exact title match
        //   2. normalized title + release_date (catches transliterations: Hasunosora vs Hasu no Sora)
        //   3. cover URL + release_date (catches different language titles: Smoking Behind / Yani Suu Futari)
        // Generic covers (default.jpg, placeholder, etc.) are excluded from the cover match
        // because dozens of items share them when no real image is available.
        // ═══ SESSION 12.5 : Filtre d admission EU/JP ═══
        // Source unique de vérité pour le pays d origine.
        // Les workflows poussent brut (avec titleNative), l API tranche.
        // Si l item n est pas probable JP (hangul/pinyin tons), on skip.
        const jpCheck = gnIsLikelyJapaneseAnime(b as any);
        if (!jpCheck.likely) {
          app.log.info({ title: b.title, reason: jpCheck.reason }, "item rejected: not japanese");
          continue;
        }

        // ═══ SESSION 13.3 : Filtre NICHES (GAMES UNIQUEMENT) ═══
        // Reject games si : popularity < 10 ET released > 30 jours ET rating_score < 70
        // Logique : laisse 30j aux nouveautes pour monter + protege cult favorites
        // ZERO IMPACT sur anime (garde itemType === "game")
        if (itemType === "game") {
          const pop = Number((b as any).popularity ?? 0);
          const ratingScore = (b as any).ratingScore != null ? Number((b as any).ratingScore) : null;
          const releaseDate = (b as any).releaseDate;
          if (releaseDate) {
            const ageDays = (Date.now() - new Date(releaseDate).getTime()) / 86400000;
            const isNiche = pop < 10 && ageDays > 30 && (ratingScore === null || ratingScore < 70);
            if (isNiche) {
              app.log.info({ title: b.title, popularity: pop, ratingScore, ageDays: Math.round(ageDays) }, "game rejected: niche");
              continue;
            }
          }
        }

        const normalizedIncoming = gnNormalizeTitle(b.title);
        const normalizedStrictIncoming = gnNormalizeTitleStrict(b.title);  // SESSION 12.5c
        const coverIsGeneric = !b.cover ||
          /\/(default|placeholder|noimage|no-image|missing)\.(jpg|png)/i.test(b.cover) ||
          /cover\/(medium|large)\/default/i.test(b.cover);
        const lookupCover = coverIsGeneric ? null : b.cover;


        // ═══ SESSION 13+: Check merge_blocklist (priorité absolue) ═══
        // Auto-Merge mémorise les losers ici. Si un workflow re-pousse un loser,
        // on redirige vers le winner au lieu de recréer le doublon.
        // Critères ABSOLUS (zéro faux positif possible) : anilist_id / mal_id / cover / title exact
        let blocklistRedirect: any = null;
        let blocklistReject = false;
        try {
          const blRows: any = await conn.query(
            `SELECT redirect_to_id FROM merge_blocklist
             WHERE item_type = ?
               AND (
                 (? IS NOT NULL AND blocked_anilist_id = ?)
                 OR (? IS NOT NULL AND blocked_mal_id = ?)
                 OR (? IS NOT NULL AND blocked_cover = ?)
                 OR blocked_title = ?
               )
             LIMIT 1`,
            [itemType, b.anilistId, b.anilistId, b.malId, b.malId, lookupCover, lookupCover, b.title]
          );
          if (blRows.length > 0) {
            if (blRows[0].redirect_to_id <= 0) {
              blocklistReject = true;
              app.log.info({ title: b.title, type: itemType }, "blocklist REJECT (redirect_to_id<=0), item skipped");
              pushActivity({
                type: "blocklist_hit",
                message: `Blocklist REJET : ${b.title}`,
                detail: `Item indesirable bloque (${itemType})`,
                level: "warn",
              });
            } else {
            const winRows: any = await conn.query(
              `SELECT id, title, title_english AS titleEnglish, title_normalized_strict AS titleNormalizedStrict, anilist_id AS anilistId, mal_id AS malId, anime_schedule_route AS animeScheduleRoute${itemType === "game" ? ", rawg_id AS rawgId, igdb_id AS igdbId" : ""}, platform, DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate, trailer_url AS trailerUrl, cover, description, rating, rating_score AS ratingScore${itemType === "game" ? ", dlcs" : ""}
               FROM ${table} WHERE id = ? LIMIT 1`,
              [blRows[0].redirect_to_id]
            );
            if (winRows.length > 0) {
              blocklistRedirect = winRows[0];
              app.log.info({ title: b.title, redirectId: blRows[0].redirect_to_id, type: itemType }, "blocklist hit, redirecting to winner");
              pushActivity({
                type: "blocklist_hit",
                message: `Blocklist hit : ${b.title}`,
                detail: `Redirige vers id ${blRows[0].redirect_to_id} (${itemType})`,
                level: "warn",
              });
            } else {
              app.log.warn({ redirectId: blRows[0].redirect_to_id, title: b.title }, "blocklist winner not found, falling back to normal flow");
            }
            }
          }
        } catch (e: any) {
          app.log.error({ err: e?.message, title: b.title }, "blocklist check failed, falling back");
        }
        if (blocklistReject) { continue; }

        const beforeRows: any = blocklistRedirect ? [blocklistRedirect] : await conn.query(
          `SELECT id, title, title_english AS titleEnglish, title_normalized_strict AS titleNormalizedStrict, anilist_id AS anilistId, mal_id AS malId, anime_schedule_route AS animeScheduleRoute${itemType === "game" ? ", rawg_id AS rawgId, igdb_id AS igdbId" : ""}, platform, DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate, trailer_url AS trailerUrl, cover, description, rating, rating_score AS ratingScore${itemType === "game" ? ", dlcs" : ""}
           FROM ${table}
           WHERE (
             /* SESSION 12.7 — Critère 7 : anilist_id (clé d'identification stable AniList) */
             (? IS NOT NULL AND anilist_id = ?)
             /* SESSION 12.7 — Critère 8 : mal_id (clé d'identification stable MAL/Jikan) */
             OR (? IS NOT NULL AND mal_id = ?)
             /* Critère 1 : titre exact */
             OR title = ?
             OR (
               release_date = ?
               AND title_normalized_strict IS NOT NULL
               AND title_normalized_strict != ''
               AND title_normalized_strict = ?
             )
             OR (
               release_date = ?
               AND LOWER(REGEXP_REPLACE(title, '[^[:alnum:]]', '')) = ?
             )
             OR (
               ? IS NOT NULL
               AND release_date = ?
               AND cover = ?
             )
           )
           LIMIT 1`,
          [
            /* Critère 7 : anilist_id (NULL-check + match) */
            b.anilistId, b.anilistId,
            /* Critère 8 : mal_id (NULL-check + match) */
            b.malId, b.malId,
            /* PHASE B GAMES : rawg_id + igdb_id (lossless append) */
            (b as any).rawgId ?? null, (b as any).rawgId ?? null,
            (b as any).igdbId ?? null, (b as any).igdbId ?? null,
            /* Critère 1 : titre exact */
            b.title,
            /* Critère 2 : normalize_strict + date */
            b.releaseDate || null, normalizedStrictIncoming,
            /* Critère 3 : regex + date */
            b.releaseDate || null, normalizedIncoming,
            /* Critère 4 : cover + date (non-générique) */
            lookupCover, b.releaseDate || null, lookupCover,
          ]
        );
        const before = beforeRows.length ? beforeRows[0] : null;

        // ETAT CLEAN: when updating an existing item, GameNime API merges
        // platform lists (never loses a valid platform). For new inserts,
        // the platform is just the sanitized incoming value.
        if (before) {
          (b as any).platform = gnMergePlatforms(before.platform, b.platform);
        }

        // ETAT CLEAN session 12:
        // Sanitization du release_datetime (validation format + cohérence avec release_date).
        // Évite les datetime polluants (résidus jpnTime des saisons précédentes
        // poussés par AnimeSchedule pour des items qui sortent dans plusieurs mois).
        // Si datetime invalide/incohérent → null, et la règle lossless conserve la
        // valeur précédente (IF VALUES(release_datetime) IS NOT NULL ...).
        (b as any).releaseDatetime = gnSanitizeReleaseDatetime(b.releaseDate, b.releaseDatetime);

        // ETAT CLEAN session 10:
        // INSERT colonnes/placeholders/values incluent rating_score (note qualitative 0-100).
        // - INT, donc pas de comparaison `!= ''` (interdit sur INT en MariaDB)
        // - Pas de comparaison `> 0` non plus : un score=0 reste valide même si peu probable
        // - Règle lossless : `IF(? IS NOT NULL, ?, rating_score)` (pattern aligné sur release_date)
        const insertCols = itemType === "game"
          ? "(title,title_english,title_normalized_strict,anilist_id,mal_id,anime_schedule_route,rawg_id,igdb_id,cover,genre,platform,release_date,release_datetime,release_precision,is_recently_released,trailer_url,description,rating,rating_score,popularity,screenshots,dlcs)"
          : "(title,title_english,title_normalized_strict,anilist_id,mal_id,anime_schedule_route,cover,genre,platform,release_date,release_datetime,release_precision,is_recently_released,trailer_url,description,rating,rating_score,popularity,screenshots)";
        const insertPh = itemType === "game" ? "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" : "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
        const insertVals: any[] = [
          b.title, b.titleEnglish, normalizedStrictIncoming, b.anilistId, b.malId, b.animeScheduleRoute, ...(itemType === "game" ? [(b as any).rawgId ?? null, (b as any).igdbId ?? null] : []), b.cover, b.genre, b.platform, b.releaseDate, b.releaseDatetime,
          b.releasePrecision || "day",
          b.isRecentlyReleased ? 1 : 0, b.trailerUrl, b.description, b.rating, b.ratingScore, b.popularity, b.screenshots
        ];
        if (itemType === "game") insertVals.push((b as any).dlcs ?? null);

        if (before) {
          // ETAT CLEAN: existing item found via normalized title — UPDATE BY ID
          // (avoids creating a new row even if the title string differs)
          const dlcsClause = itemType === "game"
            ? ", dlcs = IF(? IS NOT NULL AND ? != '', ?, dlcs)"
            : "";
          const dlcsParams = itemType === "game"
            ? [(b as any).dlcs ?? null, (b as any).dlcs ?? null, (b as any).dlcs ?? null]
            : [];

          await conn.query(
            `UPDATE ${table} SET
               title_english = IF(? IS NOT NULL AND ? != '', ?, title_english),
             cover = IF(cover IS NULL OR cover = '', ?, cover),
               genre = IF(? IS NOT NULL AND ? != '', ?, genre),
               platform = IF(? IS NOT NULL AND ? != '' AND ? != 'Unknown', ?, platform),
               title_normalized_strict = IF(? IS NOT NULL AND ? != '', ?, title_normalized_strict),
               anilist_id = IF(? IS NOT NULL, ?, anilist_id),
               mal_id = IF(? IS NOT NULL, ?, mal_id),${itemType === "game" ? `
               rawg_id = IF(? IS NOT NULL, ?, rawg_id),
               igdb_id = IF(? IS NOT NULL, ?, igdb_id),` : ""}
               anime_schedule_route = IF(? IS NOT NULL AND ? != '', ?, anime_schedule_route),
               release_date = IF(? IS NOT NULL, ?, release_date),
               release_datetime = IF(? IS NOT NULL, ?, release_datetime),
               release_precision = ?,
               is_recently_released = ?,
               trailer_url = IF(? IS NOT NULL AND ? != '', ?, trailer_url),
               description = IF(description IS NULL OR description = '', ?, description),
               rating = IF(? IS NOT NULL AND ? != '', ?, rating),
               rating_score = IF(? IS NOT NULL, ?, rating_score),
               popularity = IF(? > 0, ?, popularity),
               screenshots = IF(? IS NOT NULL AND ? != '', ?, screenshots)${dlcsClause},
               updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              b.titleEnglish, b.titleEnglish, b.titleEnglish,
              b.cover,
              b.genre, b.genre, b.genre,
              b.platform, b.platform, b.platform, b.platform,
              normalizedStrictIncoming, normalizedStrictIncoming, normalizedStrictIncoming,
              b.anilistId, b.anilistId,
              b.malId, b.malId,
              ...(itemType === "game" ? [
                (b as any).rawgId ?? null, (b as any).rawgId ?? null,
                (b as any).igdbId ?? null, (b as any).igdbId ?? null,
              ] : []),
              b.animeScheduleRoute, b.animeScheduleRoute, b.animeScheduleRoute,
              b.releaseDate, b.releaseDate,
              b.releaseDatetime, b.releaseDatetime,
              b.releasePrecision || "day",
              b.isRecentlyReleased ? 1 : 0,
              b.trailerUrl, b.trailerUrl, b.trailerUrl,
              b.description,
              b.rating, b.rating, b.rating,
              b.ratingScore, b.ratingScore,
              b.popularity, b.popularity,
              b.screenshots, b.screenshots, b.screenshots,
              ...dlcsParams,
              before.id,
            ]
          );
        } else {
          // No existing item — INSERT new row
          // ON DUPLICATE KEY UPDATE remains as a safety net for unique title collisions
          await conn.query(
            `INSERT INTO ${table}
               ${insertCols}
             VALUES ${insertPh}
             ON DUPLICATE KEY UPDATE
               title_english=IF(VALUES(title_english) IS NOT NULL AND VALUES(title_english) != '', VALUES(title_english), title_english),
               cover=IF(cover IS NULL OR cover = '', VALUES(cover), cover),
               genre=IF(VALUES(genre) IS NOT NULL AND VALUES(genre) != '', VALUES(genre), genre),
               platform=IF(VALUES(platform) IS NOT NULL AND VALUES(platform) != '' AND VALUES(platform) != 'Unknown', VALUES(platform), platform),
               title_normalized_strict=IF(VALUES(title_normalized_strict) IS NOT NULL AND VALUES(title_normalized_strict) != '', VALUES(title_normalized_strict), title_normalized_strict),
               anilist_id=IF(VALUES(anilist_id) IS NOT NULL, VALUES(anilist_id), anilist_id),
               mal_id=IF(VALUES(mal_id) IS NOT NULL, VALUES(mal_id), mal_id),${itemType === "game" ? `
               rawg_id=IF(VALUES(rawg_id) IS NOT NULL, VALUES(rawg_id), rawg_id),
               igdb_id=IF(VALUES(igdb_id) IS NOT NULL, VALUES(igdb_id), igdb_id),` : ""}
               anime_schedule_route=IF(VALUES(anime_schedule_route) IS NOT NULL AND VALUES(anime_schedule_route) != '', VALUES(anime_schedule_route), anime_schedule_route),
               release_date=IF(VALUES(release_date) IS NOT NULL, VALUES(release_date), release_date),
               release_datetime=IF(VALUES(release_datetime) IS NOT NULL, VALUES(release_datetime), release_datetime),
               release_precision=VALUES(release_precision),
               is_recently_released=VALUES(is_recently_released),
               trailer_url=IF(VALUES(trailer_url) IS NOT NULL AND VALUES(trailer_url) != '', VALUES(trailer_url), trailer_url),
               description=IF(description IS NULL OR description = '', VALUES(description), description),
               rating=IF(VALUES(rating) IS NOT NULL AND VALUES(rating) != '', VALUES(rating), rating),
               rating_score=IF(VALUES(rating_score) IS NOT NULL, VALUES(rating_score), rating_score),
               popularity=IF(VALUES(popularity) > 0, VALUES(popularity), popularity),
               screenshots=IF(VALUES(screenshots) IS NOT NULL AND VALUES(screenshots) != '', VALUES(screenshots), screenshots)${itemType === "game" ? ",\n               dlcs=IF(VALUES(dlcs) IS NOT NULL AND VALUES(dlcs) != '', VALUES(dlcs), dlcs)" : ""},
               updated_at=CURRENT_TIMESTAMP`,
            insertVals
          );
        }

        const afterRows: any = await conn.query(
          `SELECT id, title, platform, DATE_FORMAT(release_date,'%Y-%m-%d') AS releaseDate, trailer_url AS trailerUrl, cover, description, rating, rating_score AS ratingScore${itemType === "game" ? ", dlcs" : ""}
           FROM ${table} WHERE title = ? LIMIT 1`,
          [b.title]
        );
        const after = afterRows.length ? afterRows[0] : null;

        if (before && after) {
          await createNotificationsForItemChange(conn, itemType, before, after);
        }
      }

      await conn.commit();

      // Invalidate GameNime feed cache after bulk insert
      // (new items may have changed the top scores)
      clearFeedCache();
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

    // Tracking dashboard : detect source via cover heuristique
    if (cleanedItems.length > 0) {
      const sample = cleanedItems[0];
      const cover = String((sample as any).cover || "");
      let source = "unknown";
      if (cover.includes("anilistcdn") || cover.includes("anilist.co")) source = "anilist";
      else if (cover.includes("myanimelist.net")) source = "jikan";
      else if (cover.includes("animeschedule.net")) source = "animeschedule";
      else if (cover.includes("rawg.io") || cover.includes("igdb")) source = "rawg";
      const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
      trackLastRun(`push-${prefix.replace("/", "")}-${source}`, { total: cleanedItems.length, filtered });
      pushActivity({
        type: "push",
        message: `${sourceLabel} pushed ${cleanedItems.length} ${prefix.replace("/", "")} items`,
        detail: filtered > 0 ? `${filtered} filtered (adult)` : `${cleanedItems.length} items processed`,
        level: "info",
      });
    }
    return reply.code(200).send({ ok: true, total: cleanedItems.length, filtered });
  });
}

// ── Register domains ───────────────────────────────
app.get("/health", async () => ({ ok: true, service: "content-api" }));
registerDomain("/anime", "anime_items", "ANIME_API_KEY");
registerDomain("/games", "game_items", "GAMES_API_KEY");


app.post("/admin/test-email", async (req, reply) => {
  const expected = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  const provided = req.headers["x-api-key"];
  const auth = requireApiKey(expected, provided);
  if (!auth.ok) return reply.code(auth.code).send({ error: auth.msg });
  const body = req.body as any;
  const to = String(body?.to || "").trim();
  if (!to) return reply.code(400).send({ error: "to required" });
  const ok = await sendEmail({
    to,
    subject: "Test GameNime - Email fonctionnel",
    html: `<p>Bonjour,</p><p>Ceci est un email de test envoy\u00e9 par GameNime.</p><p>Si tu re\u00e7ois ce mail, la configuration SMTP fonctionne parfaitement.</p><p>\u00c0 bient\u00f4t,<br/>GameNime</p>`,
  });
  return reply.send({ ok });
});

void verifySmtpConnection();

// Register GameNime API routes (feed/scoring engine)
await registerGameNimeRoutes(app, pool, {
  adminApiKey: process.env.ANIME_API_KEY,
});

// Tracking visiteurs (trafic du site) — alimente le dashboard
app.post("/track", async (req, reply) => {
  try {
    const body: any = req.body || {};
    const xff = (req.headers["x-forwarded-for"] as string) || "";
    const ip = (req.headers["x-real-ip"] as string) || xff.split(",")[0]?.trim() || req.ip || "unknown";
    const ua = (req.headers["user-agent"] as string) || "";
    const vid = hashIp(ip + ua);
    if (body.ping === true) {
      trackPing(vid);
    } else {
      trackVisit(String(body.path || "/"), String(body.ref || ""), vid);
    }
  } catch {}
  reply.send({ ok: true });
});

setStatsPool(pool);
startDashboard(app, pool);
startRefetchGamesCron(app);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

startRefetchCron(app);

// Phase C : démarre le cron interne lookup AniList par titre (toutes les heures)
startLookupCron(app);

// Quality check J-7 : démarre cron quotidien 8h UTC
startQualityCron(app);

