#!/usr/bin/env bash
# mails-essai.sh — GameNime : envoie les 6 e-mails (design A · Nuit) a une adresse, pour les voir dans une
# vraie messagerie (Gmail, Apple Mail, Outlook ; au telephone ; en mode sombre).
#   bash /opt/stack/scripts/mails-essai.sh ton@adresse.fr [Prenom]
# Sujets « [Essai] ». Les liens de confirmation et de mot de passe sont volontairement invalides.
# Les rappels et l'alerte prennent de vraies fiches a venir (jaquettes comprises), lues sur l'API.
# Installe le 6 octobre 2026 par mails-nuit.sh.
set -uo pipefail
DEST=${1:-}
NOM=${2:-Rey}
case "$DEST" in
  *@*.*) ;;
  *) echo "Usage : bash $0 ton@adresse.fr [Prenom]"; exit 1 ;;
esac
C=$(docker ps --format '{{.Names}}' | grep -E 'content-api' | head -n 1)
[ -n "$C" ] || { echo "ARRET : l'API (content-api) ne tourne pas."; exit 1; }
WD=$(docker inspect -f '{{.Config.WorkingDir}}' "$C" 2>/dev/null)
DIST=""
for d in "${WD%/}/dist" /app/dist /usr/src/app/dist /home/node/app/dist /srv/app/dist; do
  if docker exec "$C" test -f "$d/email-templates.js" 2>/dev/null; then DIST=$d; break; fi
done
[ -n "$DIST" ] || DIST=$(docker exec "$C" sh -c 'find / -xdev -name email-templates.js -path "*/dist/*" -not -path "*/node_modules/*" 2>/dev/null | head -n 1' | sed 's#/email-templates.js$##')
[ -n "$DIST" ] || { echo "ARRET : code compile introuvable dans $C."; exit 1; }
docker exec -i -e GN_MODE=envoi -e GN_DIST="$DIST" -e GN_DEST="$DEST" -e GN_NOM="$NOM" "$C" node --input-type=module 2>&1 <<'GN_JS'
// mails.mjs — GameNime, e-mails « A · Nuit » (6 octobre 2026). Lance DANS le conteneur content-api :
//   docker exec -i -e GN_MODE=... -e GN_DIST=<dossier dist> content-api node --input-type=module < mails.mjs
// GN_MODE=verifier  rend les 6 e-mails avec les donnees des maquettes et compare chacun a la maquette
//                   validee (empreinte sha256) ; controle la version texte. N'envoie RIEN.
// GN_MODE=pied      affiche l'adresse « Une question ? », celle de « Répondre » et le site des liens, tels que les
//                   vrais e-mails les auront.
// GN_MODE=envoi     envoie les 6 e-mails, sujets « [Essai] », a GN_DEST (prenom GN_NOM), avec de vraies
//                   fiches a venir lues sur l'API (jaquettes comprises).
import { createHash } from "node:crypto";
const D = process.env.GN_DIST || "", MODE = process.env.GN_MODE || "verifier";
let m, e;
try {
  m = await import(D + "/email-templates.js");
  e = await import(D + "/email.js");
} catch (err) {
  console.log("  KO  le code compile ne se charge pas : " + (err && err.message));
  process.exit(3);
}
if (MODE === "pied") {
  const t = m.welcomeTemplate("x");
  const adr = (t.html.match(/href="mailto:([^"]*)"/) || [])[1] || "?";
  const site = (t.html.match(/href="([^"]*)\/account\/preferences"/) || [])[1] || "?";
  console.log(adr + " " + (e.CONTACT_EMAIL || "?") + " " + site);
  process.exit(0);
}
if (MODE === "verifier" || MODE === "empreintes") {
  // les donnees des maquettes, a l'identique (les jaquettes ne sont pas chargees : rien ne sort)
  const H = "http://127.0.0.1:8765/hd/";
  const couv = { a: H + "bx170002-AAAAaaaa0002-6d5f04b8-960.webp", j: H + "bx170004-AAAAaaaa0004-9719c36d-960.webp", k: H + "bx-magic-AAAA-b521beb1-960.webp" };
  const F = {
    bienvenue: () => m.welcomeTemplate("Rey"),
    verification: () => m.verificationEmailTemplate("Rey", "https://gamenime.fr/auth/verify-email?token=c2VjcmV0LWV4ZW1wbGUtZGUtbWFxdWV0dGU", 48),
    motdepasse: () => m.passwordResetTemplate("Rey", "https://gamenime.fr/auth/reset-password?token=ZXhlbXBsZS1kZS1tYXF1ZXR0ZS1zZXVsZW1lbnQ", 30),
    rappel7: () => m.reminderEmailTemplate({ displayName: "Rey", itemTitle: "Tokyo Revengers: War of the Three Titan Arc", itemCover: couv.a, itemType: "anime", daysLeft: 7, releaseDate: "2026-10-13", itemUrl: "https://gamenime.fr/upcoming#item-anime-115", platform: "Crunchyroll, Netflix" }),
    rappel0: () => m.reminderEmailTemplate({ displayName: "Rey", itemTitle: "No Rest for the Wicked", itemCover: couv.j, itemType: "game", daysLeft: 0, releaseDate: "2026-10-06", itemUrl: "https://gamenime.fr/games#item-game-36920", platform: "PC, PS5, Xbox Series X|S" }),
    alerte: () => m.alertEmailTemplate({ displayName: "Rey", itemTitle: "Phantom Blade Zero", itemCover: couv.k, itemType: "game", matchValue: "Action sur PC", itemUrl: "https://gamenime.fr/upcoming#item-game-36903", platform: "PC, PS5" }),
  };
  const ATTENDU = {"bienvenue": ["827d8962fffc226f5f3192ca63214bfea4a6df1eea8b5a3a885dd83138a48ab9", 8504], "verification": ["b6538b8328dfb9ed0d27295479c75a30062083b14629e42b127df2ff4517826a", 7709], "motdepasse": ["e9953eb6dc09e3dd96d2b04d1b37fdef30efc0ebbe3e50fe6820407f03e5dfbf", 7703], "rappel7": ["35d7fd881644765f8253d4ec065423b0be548abb057e3787203a717c9fb42be7", 9422], "rappel0": ["fdf66326f7d01c7a87b553a2344f1cdd821ec433c506b5ed625eb65a4b47cbcf", 9671], "alerte": ["bf45a1d8756315f2dcbf754aae45fa80999534628d7bc2ca5f1d54f8341c5a98", 8982]};
  const sortie = {};
  let ecart = 0;
  for (const [k, f] of Object.entries(F)) {
    let t, texte;
    try {
      t = f();
      texte = e.versTexte(t.html);
    } catch (err) {
      console.log("  KO  " + k + " : le rendu plante (" + (err && err.message) + ")");
      process.exit(3);
    }
    if (!t || typeof t.html !== "string" || typeof t.subject !== "string" || typeof texte !== "string") {
      console.log("  KO  " + k + " : rendu vide");
      process.exit(3);
    }
    const h = createHash("sha256").update(t.subject + "\n" + t.html).digest("hex");
    sortie[k] = [h, t.html.length];
    if (MODE === "empreintes") continue;
    const pareil = !!ATTENDU[k] && h === ATTENDU[k][0];
    const propre = texte.length > 80 && !/@media|[{}]|display\s*:\s*none|<\/?[a-z][^>]*>/i.test(texte);
    if (!pareil || !propre) ecart++;
    console.log("  " + (pareil && propre ? "OK" : "KO") + "  " + k.padEnd(13) +
      (pareil ? "maquette identique" : "DIFFERENT de la maquette (" + t.html.length + " car. au lieu de " + (ATTENDU[k] ? ATTENDU[k][1] : "?") + ")") +
      ", texte " + (propre ? "propre" : "PAS PROPRE") + " (" + texte.split("\n").length + " lignes) · " + t.subject);
  }
  if (MODE === "empreintes") {
    console.log(JSON.stringify(sortie));
    process.exit(0);
  }
  console.log("  version texte du rappel J-7, donnees des maquettes (ce que lit une messagerie sans HTML) :");
  for (const l of e.versTexte(F.rappel7().html).split("\n")) console.log("  | " + l);
  process.exit(ecart ? 2 : 0);
}
if (MODE === "envoi") {
  const dest = process.env.GN_DEST || "", nom = process.env.GN_NOM || "Rey";
  const SITE = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
  const abs = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u : String(u).startsWith("/") ? SITE + u : null);
  const titre = (i, d) => (i && (i.titleEnglish || i.title)) || d;
  const url = (i, type) => SITE + "/upcoming#item-" + type + "-" + (i ? i.id : 0);
  const jour = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" });
  async function fiches(dom) {
    try {
      const r = await fetch("http://127.0.0.1:3000/feed/" + dom + "?status=upcoming&limit=60&orderBy=date");
      const d = await r.json();
      return (Array.isArray(d.items) ? d.items : []).filter((i) => i && abs(i.cover) && (i.titleEnglish || i.title));
    } catch {
      return [];
    }
  }
  const [A] = await fiches("anime");
  const [J, J2] = await fiches("games");
  const K = J2 || J;
  const liste = [
    ["Bienvenue", m.welcomeTemplate(nom)],
    ["Confirmation", m.verificationEmailTemplate(nom, SITE + "/auth/verify-email?token=essai-lien-non-valide", 48)],
    ["Mot de passe", m.passwordResetTemplate(nom, SITE + "/auth/reset-password?token=essai-lien-non-valide", 30)],
    ["Rappel J-7", m.reminderEmailTemplate({ displayName: nom, itemTitle: titre(A, "Exemple d'anime"), itemCover: abs(A && A.cover), itemType: "anime", daysLeft: 7, releaseDate: jour(7), itemUrl: url(A, "anime"), platform: (A && A.platform) || null })],
    ["Rappel jour J", m.reminderEmailTemplate({ displayName: nom, itemTitle: titre(J, "Exemple de jeu"), itemCover: abs(J && J.cover), itemType: "game", daysLeft: 0, releaseDate: jour(0), itemUrl: url(J, "game"), platform: (J && J.platform) || null })],
    ["Alerte", m.alertEmailTemplate({ displayName: nom, itemTitle: titre(K, "Exemple de jeu"), itemCover: abs(K && K.cover), itemType: "game", matchValue: "Essai", itemUrl: url(K, "game"), platform: (K && K.platform) || null })],
  ];
  console.log("  fiches utilisees : " + [titre(A, "(aucun anime trouve)"), titre(J, "(aucun jeu trouve)"), K !== J ? titre(K, "") : ""].filter(Boolean).join(" ; "));
  console.log("  envoi de " + liste.length + " e-mails a " + dest);
  let ko = 0;
  for (const [n, t] of liste) {
    const ok = await e.sendEmail({ to: dest, subject: "[Essai] " + t.subject, html: t.html });
    if (!ok) ko++;
    console.log("  " + (ok ? "OK" : "KO") + "  " + n.padEnd(14) + t.subject);
  }
  if (ko) console.log("  " + ko + " e-mail(s) non partis : voir la ligne « [email] » au-dessus (identifiants SMTP, quota OVH ?)");
  process.exit(ko ? 1 : 0);
}
console.log("  mode inconnu : " + MODE);
process.exit(3);
GN_JS
