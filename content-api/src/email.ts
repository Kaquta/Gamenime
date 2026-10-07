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
// Adresse de contact : « Répondre » y mène, l'expéditeur reste l'adresse d'envoi (noreply@).
// Même valeur dans email-templates.ts, pour le pied « Une question ? ». (6 octobre 2026.)
export const CONTACT_EMAIL = process.env.SUPPORT_EMAIL || "contact@gamenime.fr";

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
      text: payload.text || versTexte(payload.html),
      replyTo: payload.replyTo || CONTACT_EMAIL,
    });
    return true;
  } catch (err: any) {
    console.error("[email] Send failed:", err?.message || err);
    return false;
  }
}

/**
 * Version texte d'un e-mail HTML, envoyée avec lui : messageries sans HTML, montres, lecteurs
 * d'écran, filtres anti-spam. Retirer seulement les balises y laissait le CSS du <style> et le
 * texte d'aperçu caché ; ici on garde le texte lisible, les liens en clair et les retours à la ligne.
 * (6 octobre 2026, avec le nouveau design des e-mails.)
 */
export function versTexte(html: string): string {
  const COLLE = "\u0001"; // colle une étiquette à la ligne qui la suit
  const CJK = "[\\u3000-\\u30ff\\u4e00-\\u9fff\\uff00-\\uffef]";
  const entites: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "©",
    laquo: "«", raquo: "»", rsquo: "’", hellip: "…", mdash: "—", ndash: "–", middot: "·",
  };
  const decoder = (t: string): string =>
    t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m: string, e: string) => {
      if (e[0] !== "#") return entites[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
  const texteDe = (t: string): string => decoder(t.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  const court = (u: string): string => u.replace(/^(https?:\/\/|mailto:)/i, "").replace(/\/+$/, "").toLowerCase();

  let s = html
    // rien à lire : l'en-tête, les styles, les commentaires, le texte d'aperçu caché,
    // le décor (aria-hidden) et les cachets en kanji à la verticale
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<div\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<(td|span|div)\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(new RegExp(`<td\\b[^>]*>\\s*${CJK}(?:\\s*<br\\s*/?>\\s*${CJK})*\\s*</td>`, "gi"), "")
    // les retours à la ligne du code HTML ne comptent pas
    .replace(/[ \t\r\n]+/g, " ");

  // les liens en clair : « Voir la fiche : https://… » en fin de ligne, « Mes préférences (https://…) » dans une phrase
  s = s.replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (m: string, href: string, contenu: string, pos: number, tout: string) => {
      const url = decoder(href).trim();
      const texte = texteDe(contenu);
      if (/^mailto:/i.test(url)) return texte || url.slice(7);
      if (!texte || court(texte) === court(url)) return url;
      return /^\s*(<|$)/.test(tout.slice(pos + m.length)) ? `${texte} : ${url}` : `${texte} (${url})`;
    });

  s = s
    // étiquettes en capitales (comme le text-transform du HTML), collées à ce qui suit
    .replace(/<p\b[^>]*text-transform:\s*uppercase[^>]*>([\s\S]*?)<\/p>/gi,
      (_m: string, t: string) => `\n\n${texteDe(t).toLocaleUpperCase("fr-FR")}${COLLE}`)
    // une pastille seule dans son paragraphe (« ● dans 7 jours ») : collée à la date qui suit
    .replace(/<p\b[^>]*>\s*<span\b[^>]*>([^<]*)<\/span>\s*<\/p>/gi, (_m: string, t: string) => `\n\n${texteDe(t)}${COLLE}`)
    // la puce ronde des listes, et les pastilles côte à côte
    .replace(/<span\b[^>]*border-radius[^>]*>\s*<\/span>/gi, "• ")
    .replace(/<\/span>\s*<span\b/gi, "</span> · <span")
    // les blocs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(table|p|h[1-6]|ul|ol)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(tr|div|li)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(new RegExp(`${COLLE}\\s*`, "g"), "\n");

  return decoder(s)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
