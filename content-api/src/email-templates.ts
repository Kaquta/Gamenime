/**
 * Email templates for GameNime.
 * All HTML is inline-styled for maximum email client compatibility.
 * Maintainability: centralized templates, no HTML in business logic.
 */

const BRAND_COLOR = "#e85a20";
const BRAND_GRADIENT = "linear-gradient(135deg, #ff9246, #d7501e)";
const SITE_NAME = "GameNime";
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
const SUPPORT_EMAIL = process.env.SMTP_FROM_EMAIL || "contact@gamenime.fr";

/**
 * Base HTML wrapper shared by all emails.
 * Keeps consistent branding and footer.
 */
function wrap(title: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:${BRAND_GRADIENT};padding:28px 32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-family:Georgia,serif;font-style:italic;font-size:28px;font-weight:700;">${SITE_NAME}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;color:#333333;font-size:15px;line-height:1.6;">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#f9f9f9;padding:20px 32px;text-align:center;color:#888888;font-size:12px;border-top:1px solid #eeeeee;">
              <p style="margin:0 0 6px;">&copy; ${new Date().getFullYear()} ${SITE_NAME}</p>
              <p style="margin:0;">Une question ? <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_COLOR};text-decoration:none;">${SUPPORT_EMAIL}</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Primary action button used in transactional emails.
 */
function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background:${BRAND_GRADIENT};border-radius:999px;">
        <a href="${href}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

// ============================================================
// Auth emails
// ============================================================

export function passwordResetTemplate(displayName: string, resetUrl: string, expiresInMinutes: number) {
  const safeName = escapeHtml(displayName || "toi");
  const content = `
    <h2 style="margin:0 0 16px;color:#222;font-size:20px;">Réinitialisation de mot de passe</h2>
    <p style="margin:0 0 12px;">Bonjour ${safeName},</p>
    <p style="margin:0 0 12px;">Tu as demandé à réinitialiser ton mot de passe GameNime. Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
    ${button("Réinitialiser mon mot de passe", resetUrl)}
    <p style="margin:0 0 12px;color:#888;font-size:13px;">Ce lien expire dans <strong>${expiresInMinutes} minutes</strong>. Si tu n'as pas fait cette demande, ignore ce message.</p>
    <p style="margin:16px 0 0;color:#888;font-size:12px;word-break:break-all;">Si le bouton ne marche pas, copie ce lien : <br/>${resetUrl}</p>
  `;
  return {
    subject: `Réinitialise ton mot de passe ${SITE_NAME}`,
    html: wrap("Réinitialisation", content),
  };
}

export function welcomeTemplate(displayName: string) {
  const safeName = escapeHtml(displayName || "toi");
  const content = `
    <h2 style="margin:0 0 16px;color:#222;font-size:20px;">Bienvenue sur ${SITE_NAME} !</h2>
    <p style="margin:0 0 12px;">Salut ${safeName},</p>
    <p style="margin:0 0 12px;">Ton compte a été créé. Tu peux maintenant :</p>
    <ul style="margin:0 0 16px;padding-left:20px;color:#444;">
      <li style="margin-bottom:6px;">Ajouter tes animés et jeux préférés en favoris</li>
      <li style="margin-bottom:6px;">Recevoir des notifications sur les nouveautés</li>
      <li style="margin-bottom:6px;">Découvrir les dernières sorties chaque jour</li>
    </ul>
    ${button("Explorer GameNime", SITE_URL)}
    <p style="margin:16px 0 0;color:#888;font-size:13px;">Passe en <a href="${SITE_URL}/premium" style="color:${BRAND_COLOR};">Premium</a> pour des notifications temps réel, des rappels intelligents et bien plus.</p>
  `;
  return {
    subject: `Bienvenue sur ${SITE_NAME} 🎮`,
    html: wrap("Bienvenue", content),
  };
}

// ============================================================
// Utility
// ============================================================

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function verificationEmailTemplate(displayName: string, verifyUrl: string, expiresInHours: number) {
  const safeName = escapeHtml(displayName || "toi");
  const content = `
    <h2 style="margin:0 0 16px;color:#222;font-size:20px;">Confirme ton email</h2>
    <p style="margin:0 0 12px;">Bonjour ${safeName},</p>
    <p style="margin:0 0 12px;">Bienvenue sur ${SITE_NAME} ! Pour activer toutes les fonctionnalités (notamment Premium et les notifications email), confirme ton adresse en cliquant sur le bouton ci-dessous :</p>
    ${button("Confirmer mon email", verifyUrl)}
    <p style="margin:0 0 12px;color:#888;font-size:13px;">Ce lien expire dans <strong>${expiresInHours} heures</strong>. Si tu n'as pas créé de compte sur ${SITE_NAME}, ignore ce message.</p>
    <p style="margin:16px 0 0;color:#888;font-size:12px;word-break:break-all;">Si le bouton ne marche pas, copie ce lien : <br/>${verifyUrl}</p>
  `;
  return {
    subject: `Confirme ton email pour ${SITE_NAME}`,
    html: wrap("Confirmation email", content),
  };
}

// ============================================================
// Notification emails (reminders + alerts)
// To append to email-templates.ts
// ============================================================

export interface ReminderEmailData {
  displayName: string;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  daysLeft: number; // 7, 1, or 0
  releaseDate: string | null;
  itemUrl: string;
}

export function reminderEmailTemplate(data: ReminderEmailData) {
  const safeName = escapeHtml(data.displayName || "toi");
  const safeTitle = escapeHtml(data.itemTitle);
  const typeLabel = data.itemType === "anime" ? "anime" : "jeu";
  const labelText = data.daysLeft === 0
    ? `Sortie aujourd'hui !`
    : data.daysLeft === 1
    ? `Sortie demain !`
    : `Sortie dans ${data.daysLeft} jours`;
  const subjectPrefix = data.daysLeft === 0
    ? "🎉"
    : data.daysLeft === 1
    ? "⏰"
    : "📅";
  const coverHtml = data.itemCover
    ? `<img src="${escapeHtml(data.itemCover)}" alt="${safeTitle}" style="max-width:280px;width:100%;border-radius:12px;margin:16px 0;display:block;" />`
    : "";

  const content = `
    <h2 style="margin:0 0 16px;color:#222;font-size:20px;">${labelText}</h2>
    <p style="margin:0 0 12px;">Bonjour ${safeName},</p>
    <p style="margin:0 0 12px;">Le ${typeLabel} <strong>${safeTitle}</strong> que tu suis sort ${data.daysLeft === 0 ? "aujourd'hui" : data.daysLeft === 1 ? "demain" : "dans " + data.daysLeft + " jours"} !</p>
    ${coverHtml}
    ${button("Voir la fiche", data.itemUrl)}
    <p style="margin:16px 0 0;color:#888;font-size:12px;">Tu reçois cet email parce que cet ${typeLabel} est dans tes favoris. Tu peux désactiver les notifications email dans ton compte.</p>
  `;
  return {
    subject: `${subjectPrefix} ${safeTitle} — ${labelText}`,
    html: wrap(`Rappel ${SITE_NAME}`, content),
  };
}

export interface AlertEmailData {
  displayName: string;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  matchValue: string; // e.g. "Action sur PC"
  itemUrl: string;
}

export function alertEmailTemplate(data: AlertEmailData) {
  const safeName = escapeHtml(data.displayName || "toi");
  const safeTitle = escapeHtml(data.itemTitle);
  const safeMatch = escapeHtml(data.matchValue);
  const typeLabel = data.itemType === "anime" ? "anime" : "jeu";
  const coverHtml = data.itemCover
    ? `<img src="${escapeHtml(data.itemCover)}" alt="${safeTitle}" style="max-width:280px;width:100%;border-radius:12px;margin:16px 0;display:block;" />`
    : "";

  const content = `
    <h2 style="margin:0 0 16px;color:#222;font-size:20px;">⚡ Nouveauté qui matche tes goûts</h2>
    <p style="margin:0 0 12px;">Bonjour ${safeName},</p>
    <p style="margin:0 0 12px;">Un nouveau ${typeLabel} correspond à tes préférences <strong>${safeMatch}</strong> :</p>
    <h3 style="margin:0 0 8px;color:#222;font-size:18px;">${safeTitle}</h3>
    ${coverHtml}
    ${button("Découvrir", data.itemUrl)}
    <p style="margin:16px 0 0;color:#888;font-size:12px;">Tu reçois cet email grâce à tes préférences Premium. Tu peux modifier tes alertes ou désactiver les emails dans ton compte.</p>
  `;
  return {
    subject: `⚡ Nouveau ${typeLabel} : ${safeTitle}`,
    html: wrap(`Alerte ${SITE_NAME}`, content),
  };
}
