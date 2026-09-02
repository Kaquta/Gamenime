/**
 * Email service: business-level functions for sending emails.
 *
 * Responsibilities:
 * - Generate secure tokens (reset password, email verification)
 * - Store token hashes in DB (never plain tokens)
 * - Build URLs with correct base
 * - Render templates and call email.ts for actual sending
 *
 * Design (ETAT CLEAN):
 * - Each function returns `{ ok: boolean, reason?: string }` for easy testing
 * - Never throws to caller (auth and notification flows must remain responsive)
 * - All DB writes use the provided connection/pool (no hidden pools)
 * - Atomic transactions where multiple writes are linked
 * - Constants (TTL) declared at module top for clarity
 */

import { createHash, randomBytes } from "crypto";
import { sendEmail } from "./email.js";
import {
  passwordResetTemplate,
  welcomeTemplate,
  verificationEmailTemplate,
  reminderEmailTemplate,
  alertEmailTemplate,
} from "./email-templates.js";

// ============================================================
// Title cleanup for display (emails, notifications)
// ============================================================
// Retire les artefacts de la DB destinés à des usages internes :
// - Suffixe " (YYYY)" en fin de titre (RAWG pour différencier homonymes)
// - Tags métadonnées [FORMAT:X] [STATUS:X] etc. au cas où ils traîneraient
function cleanTitleForDisplay(title: string | null | undefined): string {
  if (!title) return "";
  return String(title)
    .replace(/\s*\[(FORMAT|STATUS|SEASON|EPISODES|LENGTH|NEXT_EP):[^\]]*\]/g, "")
    .replace(/\s*\((19|20)\d{2}\)\s*$/, "")
    .trim();
}

// ============================================================
// Configuration constants
// ============================================================

const SITE_URL = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
const RESET_TOKEN_TTL_MINUTES = 30;
const VERIFICATION_TOKEN_TTL_HOURS = 48;

// ============================================================
// Shared types
// ============================================================

export interface EmailResult {
  ok: boolean;
  reason?: string;
}

// ============================================================
// Token helpers (private)
// ============================================================

/**
 * Generate a cryptographically secure URL-safe token.
 * Uses 32 random bytes (256 bits) encoded as base64url.
 */
function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hash a token using SHA-256.
 * We store only hashes in the DB, never plain tokens.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ============================================================
// Password reset
// ============================================================

export interface SendPasswordResetEmailParams {
  db: any;
  userId: number;
  email: string;
  displayName: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Create a password reset token, store its hash, and send the email.
 * The plain token is sent ONLY in the email, never returned or logged.
 */
export async function sendPasswordResetEmail(
  params: SendPasswordResetEmailParams
): Promise<EmailResult> {
  const { db, userId, email, displayName, ip, userAgent } = params;
  if (!userId || !email) return { ok: false, reason: "missing_user_or_email" };

  try {
    const token = generateSecureToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, tokenHash, expiresAt, ip || null, (userAgent || "").slice(0, 255) || null]
    );

    const resetUrl = `${SITE_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
    const tpl = passwordResetTemplate(displayName || "", resetUrl, RESET_TOKEN_TTL_MINUTES);
    const sent = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html });

    if (!sent) return { ok: false, reason: "smtp_failed" };
    return { ok: true };
  } catch (err: any) {
    console.error("[email-service] sendPasswordResetEmail failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

/**
 * Verify and consume a reset token atomically.
 */
export async function consumePasswordResetToken(
  db: any,
  plainToken: string
): Promise<{ ok: true; userId: number } | { ok: false; reason: string }> {
  if (!plainToken || typeof plainToken !== "string") {
    return { ok: false, reason: "invalid_token" };
  }

  try {
    const tokenHash = hashToken(plainToken);
    const rows: any = await db.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) return { ok: false, reason: "not_found" };

    const row = rows[0];
    if (row.used_at) return { ok: false, reason: "already_used" };
    if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired" };

    const updateResult: any = await db.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL`,
      [row.id]
    );

    if (!updateResult.affectedRows) return { ok: false, reason: "already_used" };
    return { ok: true, userId: Number(row.user_id) };
  } catch (err: any) {
    console.error("[email-service] consumePasswordResetToken failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

// ============================================================
// Welcome email
// ============================================================

export interface SendWelcomeEmailParams {
  email: string;
  displayName: string | null;
}

export async function sendWelcomeEmail(params: SendWelcomeEmailParams): Promise<EmailResult> {
  const { email, displayName } = params;
  if (!email) return { ok: false, reason: "missing_email" };

  try {
    const tpl = welcomeTemplate(displayName || "");
    const sent = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html });
    if (!sent) return { ok: false, reason: "smtp_failed" };
    return { ok: true };
  } catch (err: any) {
    console.error("[email-service] sendWelcomeEmail failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

// ============================================================
// Email verification
// ============================================================

export interface SendVerificationEmailParams {
  db: any;
  userId: number;
  email: string;
  displayName: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function sendVerificationEmail(
  params: SendVerificationEmailParams
): Promise<EmailResult> {
  const { db, userId, email, displayName, ip, userAgent } = params;
  if (!userId || !email) return { ok: false, reason: "missing_user_or_email" };

  try {
    const token = generateSecureToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, tokenHash, expiresAt, ip || null, (userAgent || "").slice(0, 255) || null]
    );

    const verifyUrl = `${SITE_URL}/auth/verify-email?token=${encodeURIComponent(token)}`;
    const tpl = verificationEmailTemplate(displayName || "", verifyUrl, VERIFICATION_TOKEN_TTL_HOURS);
    const sent = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html });

    if (!sent) return { ok: false, reason: "smtp_failed" };
    return { ok: true };
  } catch (err: any) {
    console.error("[email-service] sendVerificationEmail failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

/**
 * Atomic: mark token as used + set users.email_verified = 1.
 */
export async function consumeVerificationToken(
  db: any,
  plainToken: string
): Promise<{ ok: true; userId: number } | { ok: false; reason: string }> {
  if (!plainToken || typeof plainToken !== "string") {
    return { ok: false, reason: "invalid_token" };
  }

  let conn: any = null;
  try {
    const tokenHash = hashToken(plainToken);
    conn = await db.getConnection();
    await conn.beginTransaction();

    const rows: any = await conn.query(
      `SELECT id, user_id, expires_at, used_at
       FROM email_verification_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) { await conn.rollback(); return { ok: false, reason: "not_found" }; }

    const row = rows[0];
    if (row.used_at) { await conn.rollback(); return { ok: false, reason: "already_used" }; }
    if (new Date(row.expires_at) < new Date()) { await conn.rollback(); return { ok: false, reason: "expired" }; }

    const updateResult: any = await conn.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL`,
      [row.id]
    );

    if (!updateResult.affectedRows) { await conn.rollback(); return { ok: false, reason: "already_used" }; }

    await conn.query(
      `UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = ?`,
      [row.user_id]
    );

    await conn.commit();
    return { ok: true, userId: Number(row.user_id) };
  } catch (err: any) {
    if (conn) try { await conn.rollback(); } catch {}
    console.error("[email-service] consumeVerificationToken failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  } finally {
    if (conn) try { conn.release(); } catch {}
  }
}

// ============================================================
// Notification emails: reminders (J-7, J-1, J0)
// ============================================================

export interface SendReminderEmailParams {
  email: string;
  displayName: string | null;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  itemId: number;
  daysLeft: number;
  releaseDate: string | null;
  platform?: string | null;
}

/**
 * Send a reminder email (J-7, J-1, or J0).
 * Caller is responsible for checking user.email_notifications_enabled and email_verified.
 */
export async function sendReminderEmail(params: SendReminderEmailParams): Promise<EmailResult> {
  if (!params.email || !params.itemTitle) return { ok: false, reason: "missing_data" };
  const cleanedTitle = cleanTitleForDisplay(params.itemTitle);
  try {
    const isUpcoming = params.releaseDate && new Date(params.releaseDate) > new Date();
    // Le type va dans l'ancre : /upcoming melange animes et jeux, sans lui
    // le front ne sait pas quelle fiche charger.
    const itemUrl = `${SITE_URL}${isUpcoming ? "/upcoming" : "/" + params.itemType}#item-${params.itemType}-${params.itemId}`;
    const tpl = reminderEmailTemplate({
      displayName: params.displayName || "",
      itemTitle: cleanedTitle,
      itemCover: params.itemCover,
      itemType: params.itemType,
      daysLeft: params.daysLeft,
      releaseDate: params.releaseDate,
      itemUrl,
      platform: params.platform || null,
    });

    const sent = await sendEmail({ to: params.email, subject: tpl.subject, html: tpl.html });
    if (!sent) return { ok: false, reason: "smtp_failed" };
    return { ok: true };
  } catch (err: any) {
    console.error("[email-service] sendReminderEmail failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

// ============================================================
// Notification emails: alerts (genre+platform match)
// ============================================================

export interface SendAlertEmailParams {
  email: string;
  displayName: string | null;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  itemId: number;
  matchValue: string;
  releaseDate?: string | null;
  platform?: string | null;
}

/**
 * Send an alert email (Premium feature: genre AND platform match).
 * Caller is responsible for checking user.email_notifications_enabled and email_verified.
 */
export async function sendAlertEmail(params: SendAlertEmailParams): Promise<EmailResult> {
  if (!params.email || !params.itemTitle) return { ok: false, reason: "missing_data" };
  const cleanedTitle = cleanTitleForDisplay(params.itemTitle);

  try {
    const isUpcoming = params.releaseDate && new Date(params.releaseDate) > new Date();
    // Le type va dans l'ancre : /upcoming melange animes et jeux, sans lui
    // le front ne sait pas quelle fiche charger.
    const itemUrl = `${SITE_URL}${isUpcoming ? "/upcoming" : "/" + params.itemType}#item-${params.itemType}-${params.itemId}`;
    const tpl = alertEmailTemplate({
      displayName: params.displayName || "",
      itemTitle: cleanedTitle,
      itemCover: params.itemCover,
      itemType: params.itemType,
      matchValue: params.matchValue,
      itemUrl,
      platform: params.platform || null,
    });

    const sent = await sendEmail({ to: params.email, subject: tpl.subject, html: tpl.html });
    if (!sent) return { ok: false, reason: "smtp_failed" };
    return { ok: true };
  } catch (err: any) {
    console.error("[email-service] sendAlertEmail failed:", err?.message || err);
    return { ok: false, reason: "internal_error" };
  }
}

// ============================================================
// Cleanup helpers (call periodically from cron)
// ============================================================

/**
 * Delete expired + old used password reset tokens.
 */
export async function cleanupPasswordResetTokens(db: any): Promise<number> {
  try {
    const result: any = await db.query(
      `DELETE FROM password_reset_tokens
       WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
          OR (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`
    );
    return Number(result.affectedRows || 0);
  } catch (err: any) {
    console.error("[email-service] cleanupPasswordResetTokens failed:", err?.message || err);
    return 0;
  }
}

/**
 * Delete expired + old used verification tokens.
 */
export async function cleanupVerificationTokens(db: any): Promise<number> {
  try {
    const result: any = await db.query(
      `DELETE FROM email_verification_tokens
       WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
          OR (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`
    );
    return Number(result.affectedRows || 0);
  } catch (err: any) {
    console.error("[email-service] cleanupVerificationTokens failed:", err?.message || err);
    return 0;
  }
}
