/**
 * Email templates for GameNime.
 *
 * Design « Vitre · Caméléon » (6 octobre 2026) : comme les pages Connexion et Mes préférences du
 * site — page neutre sombre, carte arrondie, cachet en kanji, boutons et icônes en braise.
 * Tout est en tableaux et en styles en ligne (Gmail, Outlook, Apple Mail) ; pas de police web : la
 * police de l'appareil (San Francisco, Roboto, Segoe UI…), et ses kanji pour les cachets.
 * Mêmes fonctions, mêmes paramètres et mêmes sujets qu'avant : seul le rendu change.
 */

const SITE_NAME = "GameNime";
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
// Adresse de contact du pied (« Une question ? »), et non l'adresse d'envoi (noreply@).
// Même valeur dans email.ts : « Répondre » y mène aussi.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "contact@gamenime.fr";
const PREFS_URL = `${SITE_URL}/account/preferences`;

// Couleurs : la braise du site (jeton « braise » : #ff9c4c -> #d7501e, texte #0e0e12) sur une page sombre.
const C = {
  page: "#0a0a0a",
  carte: "#161616",
  carteBord: "#272727",
  titre: "#ffffff",
  texte: "#c5c6cc",
  fort: "#f5f5f7",
  discret: "#8d8f97",
  lien: "#ffb877",
  kicker: "#ffb877",
  boite: "#1e1e1e",
  boiteBord: "#2f2f2f",
  pastille: "#202020",
  pastilleBord: "#3a3a3a",
  pastilleTexte: "#e6e6ea",
  marque: "#ffffff",
  kana: "#dedede",
  kanaFil: "#4a4a4a",
  filet: "#555555",
  devise: "#c5c6cc",
  pied: "#8d8f97",
  ombre: "0 30px 70px -30px rgba(0,0,0,.9)",
  schema: "dark",
  couvBord: "#2c2c2c",
  sep: "#262626",
  braise: "#ff9c4c",
  braiseFonce: "#d7501e",
  braisePlein: "#eb7635", // Outlook ne lit pas les degrades : la couleur du milieu
  surBraise: "#0e0e12",
};
const DEGRADE = `linear-gradient(180deg, ${C.braise} 0%, ${C.braiseFonce} 100%)`;
const POLICE = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const POLICE_TITRE = "Poppins,Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const POLICE_JP = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,'Noto Sans CJK JP','Noto Sans JP',sans-serif";
const POLICE_MONO = "'JetBrains Mono','SF Mono',Menlo,Consolas,'Roboto Mono','DejaVu Sans Mono',monospace";

/**
 * Base HTML wrapper shared by all emails : l'en-tête du site (新 GameNime ゲームニメ et sa devise),
 * la carte, le pied. `apercu` = le texte que la messagerie montre sous le sujet.
 */
function wrap(title: string, apercu: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <meta name="color-scheme" content="${C.schema}"/>
  <meta name="supported-color-schemes" content="${C.schema}"/>
  <title>${title}</title>
  <style>
    @media (max-width: 620px) {
      .gn-carte { padding: 26px 20px !important; }
      .gn-titre { font-size: 22px !important; }
      .gn-marque { font-size: 28px !important; }
      .gn-couv { width: 96px !important; }
      .gn-couv img { width: 96px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${apercu}&#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:30px 12px 34px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td align="center" style="padding:0 0 22px;">
              ${marque()}
            </td>
          </tr>
          <tr>
            <td class="gn-carte" bgcolor="${C.carte}" style="background:${C.carte};border:1px solid ${C.carteBord};border-radius:22px;padding:34px 38px;box-shadow:${C.ombre};font-family:${POLICE};font-size:15px;line-height:1.6;color:${C.texte};">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 16px 0;font-family:${POLICE};font-size:12px;line-height:1.7;color:${C.pied};">
              <a href="${SITE_URL}" style="color:${C.pied};text-decoration:none;font-weight:600;">gamenime.fr</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${PREFS_URL}" style="color:${C.pied};text-decoration:underline;">Mes préférences</a><br/>
              Une question&nbsp;? <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.lien};text-decoration:none;">${SUPPORT_EMAIL}</a><br/>
              &copy; ${new Date().getFullYear()} ${SITE_NAME}
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
 * La marque du site : le sceau 新 en braise, GameNime, ゲームニメ à la verticale, et la devise entre deux filets.
 */
function marque(): string {
  const kana = ["ゲ", "｜", "ム", "ニ", "メ"].join("<br/>");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>
                  <td width="46" height="46" align="center" valign="middle" bgcolor="${C.braisePlein}" style="width:46px;height:46px;border-radius:23px;background:${C.braisePlein};background-image:${DEGRADE};font-family:${POLICE_JP};font-size:22px;font-weight:700;line-height:46px;color:${C.surBraise};text-align:center;">新</td>
                  <td class="gn-marque" style="padding:0 12px 0 13px;font-family:${POLICE_TITRE};font-size:34px;font-weight:700;line-height:1;letter-spacing:-0.5px;color:${C.marque};white-space:nowrap;">${SITE_NAME}</td>
                  <td aria-hidden="true" style="border-left:1px solid ${C.kanaFil};padding:0 0 0 9px;font-family:${POLICE_JP};font-size:9px;font-weight:700;line-height:10px;color:${C.kana};text-align:center;">${kana}</td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:12px;">
                <tr>
                  <td width="44" style="width:44px;border-top:1px solid ${C.filet};font-size:0;line-height:0;">&nbsp;</td>
                  <td style="padding:0 12px;font-family:${POLICE};font-size:12.5px;font-weight:500;line-height:1.3;color:${C.devise};white-space:nowrap;">Animés et jeux : les sorties les plus attendues</td>
                  <td width="44" style="width:44px;border-top:1px solid ${C.filet};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>`;
}

/**
 * Cachet (kanji à la verticale, en braise, comme sur le site) et titre de la carte, avec une petite ligne au-dessus.
 */
function entete(kanji: string, surtitre: string, titreHtml: string): string {
  const k = Array.from(kanji).join("<br/>");
  return `<p style="margin:0 0 10px;font-family:${POLICE};font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.kicker};">${surtitre}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
      <tr>
        <td valign="middle" style="padding-right:13px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="${C.braisePlein}" style="background:${C.braisePlein};background-image:${DEGRADE};border-radius:7px;padding:5px 4px;font-family:${POLICE_JP};font-size:10px;font-weight:700;line-height:12px;color:${C.surBraise};">${k}</td>
          </tr></table>
        </td>
        <td valign="middle" class="gn-titre" style="font-family:${POLICE_TITRE};font-size:25px;font-weight:700;line-height:1.2;letter-spacing:-0.3px;color:${C.titre};">${titreHtml}</td>
      </tr>
    </table>`;
}

/**
 * Primary action button used in transactional emails : la braise du bouton Sign in du site.
 */
function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px;">
      <tr>
        <td align="center" bgcolor="${C.braisePlein}" style="border-radius:999px;background:${C.braisePlein};background-image:${DEGRADE};">
          <a href="${href}" style="display:inline-block;padding:14px 30px;border-radius:999px;font-family:${POLICE};font-size:15px;font-weight:600;line-height:20px;color:${C.surBraise};text-decoration:none;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function para(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${POLICE};font-size:15px;line-height:1.6;color:${C.texte};">${html}</p>`;
}

function petit(html: string, marge = "16px 0 0"): string {
  return `<p style="margin:${marge};font-family:${POLICE};font-size:12.5px;line-height:1.6;color:${C.discret};">${html}</p>`;
}

function lienSecours(url: string): string {
  return `<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid ${C.sep};font-family:${POLICE};font-size:12px;line-height:1.6;color:${C.discret};word-break:break-all;">Si le bouton ne marche pas, copie ce lien&nbsp;:<br/><a href="${url}" style="color:${C.lien};text-decoration:none;">${url}</a></p>`;
}

function pastilles(valeurs: string[]): string {
  return valeurs.map((v) =>
    `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 11px;border:1px solid ${C.pastilleBord};border-radius:999px;background:${C.pastille};font-family:${POLICE};font-size:12.5px;font-weight:600;line-height:18px;color:${C.pastilleTexte};white-space:nowrap;">${v}</span>`
  ).join("");
}

function plateformes(platform: string | null): string {
  const liste = String(platform || "").split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  if (!liste.length) return `<span style="font-family:${POLICE};font-size:13.5px;font-style:italic;color:${C.discret};">à confirmer</span>`;
  return pastilles(liste.map(escapeHtml));
}

// ============================================================
// Auth emails
// ============================================================

export function passwordResetTemplate(displayName: string, resetUrl: string, expiresInMinutes: number) {
  const safeName = escapeHtml(displayName || "toi");
  const content = `
    ${entete("会員", "Ton compte", "Réinitialisation de mot de passe")}
    ${para(`Bonjour ${safeName},`)}
    ${para("Tu as demandé à réinitialiser ton mot de passe GameNime. Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe&nbsp;:")}
    ${button("Réinitialiser mon mot de passe", resetUrl)}
    ${petit(`Ce lien expire dans <strong style="color:${C.fort};">${expiresInMinutes} minutes</strong>. Si tu n'as pas fait cette demande, ignore ce message.`)}
    ${lienSecours(resetUrl)}
  `;
  return {
    subject: `Réinitialise ton mot de passe ${SITE_NAME}`,
    html: wrap("Réinitialisation", `Ton lien est valable ${expiresInMinutes} minutes.`, content),
  };
}

export function welcomeTemplate(displayName: string) {
  const safeName = escapeHtml(displayName || "toi");
  const puce = (t: string) => `<tr>
        <td valign="top" width="22" style="width:22px;padding:3px 0 9px;"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${C.braise};"></span></td>
        <td valign="top" style="padding:0 0 9px;font-family:${POLICE};font-size:15px;line-height:1.5;color:${C.texte};">${t}</td>
      </tr>`;
  const content = `
    ${entete("会員", "Bienvenue", `Bienvenue sur ${SITE_NAME}&nbsp;!`)}
    ${para(`Salut ${safeName},`)}
    ${para("Ton compte a été créé. Tu peux maintenant&nbsp;:")}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 4px;">
      ${puce("Ajouter tes animés et jeux préférés en favoris")}
      ${puce("Recevoir des rappels avant leur sortie")}
      ${puce("Découvrir les dernières sorties chaque jour")}
    </table>
    ${button("Explorer GameNime", SITE_URL)}
    ${petit(`Tes rappels et tes alertes se règlent dans <a href="${PREFS_URL}" style="color:${C.lien};text-decoration:none;">Mes préférences</a>.`)}
  `;
  return {
    subject: `Bienvenue sur ${SITE_NAME} 🎮`,
    html: wrap("Bienvenue", "Ton compte est prêt : favoris, rappels et dernières sorties.", content),
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

// Le sujet d'un e-mail est du texte brut, pas du HTML : le titre y va tel quel. Échappé, « Marvel's »
// s'afficherait « Marvel&#039;s » dans la boîte de réception.
function sujet(titre: string): string {
  return String(titre).replace(/\s+/g, " ").trim();
}

export function verificationEmailTemplate(displayName: string, verifyUrl: string, expiresInHours: number) {
  const safeName = escapeHtml(displayName || "toi");
  const content = `
    ${entete("会員", "Ton compte", "Confirme ton e-mail")}
    ${para(`Bonjour ${safeName},`)}
    ${para(`Bienvenue sur ${SITE_NAME} ! Pour recevoir tes rappels de sortie par e-mail, confirme ton adresse en cliquant sur le bouton ci-dessous&nbsp;:`)}
    ${button("Confirmer mon e-mail", verifyUrl)}
    ${petit(`Ce lien expire dans <strong style="color:${C.fort};">${expiresInHours} heures</strong>. Si tu n'as pas créé de compte sur ${SITE_NAME}, ignore ce message.`)}
    ${lienSecours(verifyUrl)}
  `;
  return {
    subject: `Confirme ton email pour ${SITE_NAME}`,
    html: wrap("Confirmation email", `Un clic pour activer tes rappels par e-mail (lien valable ${expiresInHours} h).`, content),
  };
}

// ============================================================
// Notification emails (reminders + alerts)
// ============================================================

export interface ReminderEmailData {
  displayName: string;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  daysLeft: number; // 7, 1, or 0
  releaseDate: string | null;
  itemUrl: string;
  platform: string | null;
}

/**
 * La fiche dans l'e-mail : jaquette a gauche (132 px, 96 px sur telephone), a droite la date ou
 * la correspondance, puis les plateformes en pastilles — comme les cartes du site.
 */
function fiche(cover: string | null, titre: string, droite: string): string {
  const couv = cover
    ? `<td class="gn-couv" width="132" valign="top" style="width:132px;padding-right:18px;"><img src="${escapeHtml(cover)}" alt="${titre}" width="132" style="display:block;width:132px;height:auto;border:1px solid ${C.couvBord};border-radius:12px;" /></td>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">
      <tr>
        ${couv}
        <td valign="top">${droite}</td>
      </tr>
    </table>`;
}

function etiquette(t: string): string {
  return `<p style="margin:0 0 7px;font-family:${POLICE};font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${C.discret};">${t}</p>`;
}

export function reminderEmailTemplate(data: ReminderEmailData) {
  const safeName = escapeHtml(data.displayName || "toi");
  const safeTitle = escapeHtml(data.itemTitle);
  const labelText = data.daysLeft === 0
    ? `Sortie aujourd'hui !`
    : data.daysLeft === 1
    ? `Sortie demain !`
    : `Sortie dans ${data.daysLeft} jours`;
  // Date exacte : "demain" seul devient faux si le mail est lu plus tard.
  const dateLongue = data.releaseDate
    ? new Date(data.releaseDate + "T12:00:00").toLocaleDateString("fr-FR", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
        timeZone: "Europe/Paris",
      })
    : null;
  const quand = data.daysLeft === 0 ? "aujourd'hui"
    : data.daysLeft === 1 ? "demain"
    : `dans ${data.daysLeft} jours`;

  // La boite de date des cartes du site : la date en chasse fixe, et la pastille « dans 7 jours ».
  const boiteDate = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.boite}" style="background:${C.boite};border:1px solid ${C.boiteBord};border-radius:12px;margin:0 0 16px;">
        <tr>
          <td style="padding:12px 14px;">
            <p style="margin:0 0 8px;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${C.braisePlein};background-image:${DEGRADE};font-family:${POLICE};font-size:11.5px;font-weight:700;line-height:16px;color:${C.surBraise};">● ${quand}</span></p>
            ${dateLongue ? `<p style="margin:0;font-family:${POLICE_MONO};font-size:15px;font-weight:700;line-height:1.35;color:${C.fort};">${dateLongue}</p>` : ""}
          </td>
        </tr>
      </table>`;
  const droite = `${boiteDate}
        ${etiquette(data.itemType === "anime" ? "Où le regarder" : "Où y jouer")}
        <div style="margin:0;">${plateformes(data.platform)}</div>`;

  const content = `
    ${entete("予定", "Rappel de sortie", safeTitle)}
    ${para(`Bonjour ${safeName} — tu suis ${data.itemType === "anime" ? "cet anime" : "ce jeu"}, et il sort ${quand}.`)}
    ${fiche(data.itemCover, safeTitle, droite)}
    ${button("Voir la fiche", data.itemUrl)}
    <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid ${C.sep};font-family:${POLICE};font-size:12px;line-height:1.6;color:${C.discret};">
      Tu reçois ce message parce que <strong style="color:${C.texte};">${safeTitle}</strong> est dans tes favoris.<br/>
      <a href="${PREFS_URL}" style="color:${C.lien};text-decoration:none;">Gérer mes notifications</a>
    </p>
  `;
  return {
    subject: `${sujet(data.itemTitle)} — ${labelText}`,
    html: wrap(`Rappel ${SITE_NAME}`, `${labelText}${dateLongue ? " — " + dateLongue : ""}`, content),
  };
}

export interface AlertEmailData {
  displayName: string;
  itemTitle: string;
  itemCover: string | null;
  itemType: "anime" | "game";
  matchValue: string; // e.g. "Action sur PC"
  itemUrl: string;
  platform: string | null;
}

export function alertEmailTemplate(data: AlertEmailData) {
  const safeName = escapeHtml(data.displayName || "toi");
  const safeTitle = escapeHtml(data.itemTitle);
  const safeMatch = escapeHtml(data.matchValue);
  // « nouvel » devant une voyelle : « un nouvel anime », « un nouveau jeu »
  const nouveau = data.itemType === "anime" ? "nouvel anime" : "nouveau jeu";
  const Nouveau = nouveau.charAt(0).toUpperCase() + nouveau.slice(1);
  const droite = `${etiquette("Correspond à")}
        <div style="margin:0 0 14px;">${pastilles([safeMatch])}</div>
        ${etiquette("📺 Plateforme")}
        <div style="margin:0;">${plateformes(data.platform)}</div>`;

  const content = `
    ${entete("通知", "⚡ Nouveauté qui matche tes goûts", safeTitle)}
    ${para(`Bonjour ${safeName}, un ${nouveau} correspond à tes préférences.`)}
    ${fiche(data.itemCover, safeTitle, droite)}
    ${button("Découvrir", data.itemUrl)}
    ${petit(`Tu reçois cet e-mail grâce à tes alertes. Tu peux les modifier ou désactiver les e-mails dans <a href="${PREFS_URL}" style="color:${C.lien};text-decoration:none;">Mes préférences</a>.`, "20px 0 0")}
  `;
  return {
    subject: `⚡ ${Nouveau} : ${sujet(data.itemTitle)}`,
    html: wrap(`Alerte ${SITE_NAME}`, `Un ${nouveau} correspond à tes préférences : ${safeMatch}.`, content),
  };
}
