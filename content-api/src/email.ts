/**
 * Email service using SMTP (OVH MX Plan)
 * Maintainability: clear functions, no business logic inside.
 * Reliability: catches errors, returns boolean for easy testing.
 */
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "ssl0.ovh.net";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "GameNime";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_USER || !SMTP_PASSWORD) {
    console.warn("[email] SMTP credentials not configured. Emails disabled.");
    return null;
  }
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  return transporter;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/**
 * Send an email. Returns true on success, false on failure.
 * Never throws to caller to avoid breaking the main flow.
 */
export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  const tr = getTransporter();
  if (!tr) return false;
  try {
    await tr.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text || payload.html.replace(/<[^>]+>/g, ""),
      replyTo: payload.replyTo || SMTP_FROM_EMAIL,
    });
    return true;
  } catch (err: any) {
    console.error("[email] Send failed:", err?.message || err);
    return false;
  }
}

/**
 * Verify SMTP config on startup (non-blocking).
 */
export async function verifySmtpConnection(): Promise<boolean> {
  const tr = getTransporter();
  if (!tr) return false;
  try {
    await tr.verify();
    console.log("[email] SMTP connection verified");
    return true;
  } catch (err: any) {
    console.error("[email] SMTP verification failed:", err?.message || err);
    return false;
  }
}
