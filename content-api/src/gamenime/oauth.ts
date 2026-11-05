/**
 * GameNime — se connecter avec Google ou Discord (4 novembre 2026, maquettes validées par Rey).
 *
 * Le flux « code » d'OAuth, entièrement côté serveur : aucun script de Google ni de Discord sur les pages du site.
 *   GET  /auth/:f            (f = google | discord ; ?mode=connexion|lier &retour=/chemin &depuis=signin|register)
 *        → une entrée gardée en mémoire (state, vérificateur PKCE pour Google), le même state dans un cookie court,
 *          puis la redirection vers l'écran de Google ou de Discord.
 *   GET  /auth/:f/retour     (?code &state, ou ?error)
 *        → le state doit être celui du cookie de CE navigateur et d'une entrée encore valable (10 min, une seule fois) ;
 *          le code est échangé contre l'identité (Google : jeton d'identité reçu directement de Google ; Discord :
 *          /users/@me) ; puis la connexion, la création du compte ou la liaison, et le retour sur la page d'origine
 *          avec ?gn=<code>-<f> (le site affiche la pastille, puis retire ce code de l'adresse).
 *   POST /auth/identites/:f/delier   (JSON seulement, refusé d'un autre site) : seulement s'il reste une autre façon
 *        de se connecter (le mot de passe, ou l'autre compte lié).
 *   GET  /auth/fournisseurs  : { google: bool, discord: bool } (clés présentes dans l'environnement).
 *   GET  /auth/photo/:f      (5 novembre 2026) : la photo de ce compte lié, au seul titulaire du compte (sa session).
 *
 * La photo du compte lié (5 novembre 2026, maquette validée par Rey : « Ta photo », des comptes liés, comme avatar) :
 *   à chaque connexion ou liaison, la photo de profil que Google (jeton d'identité, « picture ») ou Discord
 *   (/users/@me, « avatar ») donne est copiée ici (colonnes photo_* de user_identites) : seulement si elle a changé,
 *   depuis leurs serveurs d'images seulement, 512 Ko au plus, JPEG, PNG, WebP ou GIF (reconnus à leurs premiers
 *   octets). Une photo qui ne se télécharge pas laisse l'ancienne ; plus de photo chez le fournisseur : la copie est
 *   retirée. Les pages du site ne chargent rien chez Google ni chez Discord : la photo vient de l'API.
 *   Avatar « google » ou « discord » (PATCH /auth/profile) : seulement si la photo est là. Délier ce compte retire sa
 *   photo, et l'avatar redevient un animal.
 *
 * Rattachement d'une identité (fournisseur + identifiant chez lui) :
 *   - déjà liée : connexion à ce compte ;
 *   - sinon, un compte GameNime avec la même adresse (vérifiée par Google ou Discord) : lié, puis connexion.
 *     Si ce compte n'avait pas confirmé son adresse, on ne sait pas qui l'a créé : l'adresse est validée, et son mot de
 *     passe et ses sessions ouvertes sont retirés (il pourra recréer un mot de passe par lien). Sans ça, quelqu'un
 *     pourrait créer un compte à l'adresse d'un autre, attendre qu'il se connecte avec Google, et y garder un accès.
 *   - sinon : création du compte (pseudo : prénom Google ou nom Discord ; adresse vérifiée ; pas de mot de passe :
 *     password_hash vide, que bcrypt refuse toujours).
 *   - mode « lier » (depuis Mon compte, connecté, adresse confirmée) : l'identité est liée au compte connecté, sauf si
 *     elle l'est déjà à un autre compte (« déjà liée »). Un seul compte Google et un seul Discord par compte GameNime.
 *   - un compte à l'adresse jamais confirmée, repris : mot de passe, sessions, appareils, comptes liés et lien d'agenda
 *     retirés (tout ce que son créateur a pu y poser).
 * Les secrets (GOOGLE_CLIENT_SECRET, DISCORD_CLIENT_SECRET) ne sont jamais écrits nulle part : ni journal, ni réponse.
 */
import { createHash, randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { FastifyInstance } from "fastify";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<any>; getConnection: () => Promise<any> };
type Journal = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
type Outils = {
  pool: Pool;
  log: Journal;
  /** le compte de la session (getAuthenticatedUser d'index.ts), ou null */
  utilisateur: (req: any) => Promise<any>;
  /** ouvre une session pour ce compte : ligne user_sessions, visite notée, cookie de session posé */
  ouvrirSession: (reply: any, userId: number) => Promise<void>;
  /** ferme toutes les sessions d'un compte et oublie ses appareils (compte repris : voir plus haut) */
  fermerSessions: (userId: number) => Promise<void>;
  /** l'e-mail de bienvenue (sendWelcomeEmail) ; jamais bloquant */
  bienvenue: (email: string, displayName: string | null) => Promise<unknown>;
  /** limite d'essais d'index.ts (fenêtre glissante en mémoire) */
  limite: (cle: string, max: number, fenetreMs: number) => boolean;
  /** cookie Secure (APP_COOKIE_SECURE) */
  cookieSecure: boolean;
};

export type Fournisseur = "google" | "discord";
const NOMS: Record<Fournisseur, string> = { google: "Google", discord: "Discord" };
const cookieNom = (secure: boolean) => (secure ? "__Host-gn_oauth" : "gn_oauth");
const DUREE_MS = 10 * 60 * 1000;
const ENTREES_MAX = 5000;
const DELAI_MS = 10_000;

/** Les adresses de Cloudflare (https://www.cloudflare.com/ips/, liste du 28 septembre 2023, relue le 4 novembre 2026). */
const CLOUDFLARE = new BlockList();
for (const r of ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14",
  "172.64.0.0/13", "131.0.72.0/22"]) CLOUDFLARE.addSubnet(r.split("/")[0], Number(r.split("/")[1]), "ipv4");
for (const r of ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29",
  "2c0f:f248::/32"]) CLOUDFLARE.addSubnet(r.split("/")[0], Number(r.split("/")[1]), "ipv6");
function dans(liste: BlockList, ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return liste.check(ip, "ipv4");
  if (v !== 6) return false;
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? liste.check(m[1], "ipv4") : liste.check(ip, "ipv6");
}
function deCloudflare(ip: string): boolean {
  return dans(CLOUDFLARE, ip);
}
/** L'adresse du visiteur, pour les limites d'essais : celle que nginx voit (X-Real-IP, qu'il pose lui-même), sans jamais
 *  croire un en-tête envoyé par le visiteur. Le site ne passe pas par le relais de Cloudflare (relevé du 4 novembre) :
 *  en IPv4, nginx voit le visiteur ; en IPv6, le proxy de docker fait arriver tous les visiteurs par une même adresse
 *  privée, qui compte alors pour eux tous (version 2 : la version 1 croyait CF-Connecting-IP dans ce cas, qu'un
 *  visiteur IPv6 pouvait écrire lui-même). Si le relais de Cloudflare est activé un jour, une adresse de Cloudflare fait
 *  lire CF-Connecting-IP, que Cloudflare pose et remplace toujours (sinon l'adresse que Cloudflare a ajoutée à
 *  X-Forwarded-For). Sans nginx : la dernière de X-Forwarded-For, sinon celle de la connexion. (Avant le patch : la
 *  première adresse de X-Forwarded-For, que le visiteur choisit : les limites ne limitaient rien.) */
/** La clé d'une adresse pour les limites : une adresse IPv6 compte pour son bloc /64 (un abonné en a souvent des milliards :
 *  changer d'adresse dans son bloc ne donne pas un nouveau compteur) ; IPv4 telle quelle. */
function cleAdresse(ip: string): string {
  const brut = ip.split("%")[0];
  if (isIP(brut) !== 6) return ip;
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(brut);
  if (m) return m[1];
  const [tete, queue] = brut.split("::");
  const morceaux = (t: string | undefined) => (t ? t.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const a = morceaux(tete);
  const b = queue !== undefined ? morceaux(queue) : [];
  const g = queue !== undefined ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return g.slice(0, 4).map((x) => parseInt(x || "0", 16).toString(16)).join(":") + "::/64";
}
export function ipClient(req: any): string {
  return cleAdresse(adresseClient(req));
}
function adresseClient(req: any): string {
  const h = req?.headers || {};
  const xff = String(h["x-forwarded-for"] || "").split(",").map((x: string) => x.trim()).filter(Boolean);
  const reel = String(h["x-real-ip"] || "").trim();
  const pair = reel && reel.length <= 64 ? reel : xff.length ? xff[xff.length - 1].slice(0, 64) : String(req?.ip || "inconnue");
  if (!deCloudflare(pair)) return pair;
  const cf = String(h["cf-connecting-ip"] || "").trim();
  if (cf && cf.length <= 64 && isIP(cf)) return cf;
  for (let i = xff.length - 1; i >= 0; i--) {
    if (xff[i] === pair || deCloudflare(xff[i])) continue;
    if (xff[i].length <= 64 && isIP(xff[i])) return xff[i];
    break;
  }
  return pair;
}
/** Les sites d'où l'on peut partir (et où l'on revient) : l'adresse de retour se déclare chez Google et Discord. */
function sites(): string[] {
  return String(process.env.OAUTH_SITES || "https://gamenime.fr,https://staging.gamenime.fr")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s));
}
/** Le site de la demande, d'après l'en-tête Host que nginx transmet ; sinon le premier site. */
function siteDe(req: any): string {
  const liste = sites();
  const hote = String(req.headers?.host || "").toLowerCase().split(",")[0].trim();
  return liste.find((s) => s.toLowerCase().replace(/^https?:\/\//, "") === hote) || liste[0] || "https://gamenime.fr";
}
/** Un chemin du site, jamais une autre adresse : « /… », sans « // », sans barre oblique inverse, en ASCII imprimable
 *  (le site envoie toujours un chemin encodé ; un caractère hors ASCII dans l'en-tête Location ferait une erreur 500). */
function cheminSur(v: unknown, defaut = "/"): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 300 || s[0] !== "/" || s.startsWith("//") || /[^\x21-\x7e]/.test(s) || s.includes("\\")) return defaut;
  if (/^\/(signin|register)(\/|\?|#|$)/.test(s)) return defaut;
  return s;
}
function ajouterCode(chemin: string, code: string): string {
  const [avant, diese] = chemin.split("#");
  return avant + (avant.includes("?") ? "&" : "?") + "gn=" + encodeURIComponent(code) + (diese !== undefined ? "#" + diese : "");
}
/** Connexion pas aboutie : la page Connexion ou Inscription, avec l'erreur, et la page où revenir au prochain essai. */
function versErreur(depuis: string, code: string, retour: string): string {
  return `${depuis}?erreur=${encodeURIComponent(code)}` + (retour && retour !== "/" ? "&retour=" + encodeURIComponent(retour) : "");
}
function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Les adresses des fournisseurs (OAUTH_ESSAI_BASE : seulement pour le banc d'essai, jamais en production). */
function adresses(f: Fournisseur) {
  // jamais en production (NODE_ENV=production dans l'image) : le faux Google du banc ne signe rien
  const essai = process.env.NODE_ENV === "production" ? "" : String(process.env.OAUTH_ESSAI_BASE || "").replace(/\/+$/, "");
  if (essai) return { autoriser: `${essai}/${f}/autoriser`, jeton: `${essai}/${f}/jeton`, moi: `${essai}/${f}/moi` };
  return f === "google"
    ? { autoriser: "https://accounts.google.com/o/oauth2/v2/auth", jeton: "https://oauth2.googleapis.com/token", moi: "" }
    : { autoriser: "https://discord.com/oauth2/authorize", jeton: "https://discord.com/api/oauth2/token", moi: "https://discord.com/api/users/@me" };
}
function cles(f: Fournisseur): { id: string; secret: string } | null {
  const id = String((f === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.DISCORD_CLIENT_ID) || "").trim();
  const secret = String((f === "google" ? process.env.GOOGLE_CLIENT_SECRET : process.env.DISCORD_CLIENT_SECRET) || "").trim();
  return id && secret ? { id, secret } : null;
}

type Entree = { f: Fournisseur; mode: "connexion" | "lier"; retour: string; depuis: string; userId: number | null; verif: string; fin: number };
const ENTREES = new Map<string, Entree>();
/** Garde un départ ; table pleine (après le ménage des départs expirés) : refusé, pour qu'un afflux ne fasse jamais
 *  échouer les connexions déjà en cours. */
function ranger(state: string, e: Entree): boolean {
  const maintenant = Date.now();
  for (const [k, v] of ENTREES) if (v.fin < maintenant) ENTREES.delete(k);
  if (ENTREES.size >= ENTREES_MAX) return false;
  ENTREES.set(state, e);
  return true;
}

// photo : l'adresse de la photo chez le fournisseur ; null : il n'en a pas ; undefined : une adresse inattendue (rien ne change)
type Identite = { sujet: string; email: string; emailVerifie: boolean; libelle: string; prenom: string; photo: string | null | undefined };

async function demander(url: string, init: any): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DELAI_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const texte = await r.text();
    let d: any = null;
    try { d = JSON.parse(texte); } catch { d = null; }
    if (!r.ok) throw new Error(`HTTP ${r.status}` + (d && typeof d.error === "string" ? ` (${String(d.error).slice(0, 60)})` : ""));
    if (!d || typeof d !== "object") throw new Error("réponse illisible");
    return d;
  } finally {
    clearTimeout(t);
  }
}
/** Le contenu d'un jeton d'identité reçu directement de Google (TLS, client authentifié) : pas de signature à vérifier,
 *  mais l'émetteur, le destinataire et l'heure le sont. */
function lireJetonGoogle(jeton: string, clientId: string): any {
  const morceaux = String(jeton || "").split(".");
  if (morceaux.length !== 3) throw new Error("jeton d'identité illisible");
  const c = JSON.parse(Buffer.from(morceaux[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") throw new Error("émetteur inattendu");
  if (c.aud !== clientId) throw new Error("destinataire inattendu");
  if (!(Number(c.exp) * 1000 > Date.now() - 60_000)) throw new Error("jeton expiré");
  return c;
}

// ── la photo du compte lié (5 novembre 2026) ──
const PHOTO_MAX = 512 * 1024;
const PHOTO_DELAI_MS = 5_000;
const TYPES_PHOTO = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** Les colonnes photo_* de user_identites sont là (posées au démarrage) ; sinon tout marche comme avant, sans photo. */
let PHOTOS = false;
/** L'origine du faux fournisseur du banc d'essai (OAUTH_ESSAI_BASE ; jamais en production), sinon "". */
function origineEssai(): string {
  if (process.env.NODE_ENV === "production") return "";
  const b = String(process.env.OAUTH_ESSAI_BASE || "").replace(/\/+$/, "");
  try { return b ? new URL(b).origin : ""; } catch { return ""; }
}
/** Une adresse d'image de ce fournisseur : en https, sur ses serveurs d'images seulement (sinon null). */
function adressePhotoSure(f: Fournisseur, v: string): URL | null {
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  const essai = origineEssai();
  if (essai && u.origin === essai) return u;
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const hote = u.hostname.toLowerCase();
  const bon = f === "google" ? /^lh\d{1,2}\.googleusercontent\.com$/.test(hote) : hote === "cdn.discordapp.com" || hote === "media.discordapp.net";
  return bon ? u : null;
}
/** La photo Google (« picture » du jeton d'identité), en 256 px carrés (l'adresse donnée se termine par =s96-c) ;
 *  null : pas de photo ; undefined : une adresse inattendue. */
function photoGoogle(v: unknown): string | null | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (s.length > 380 || !adressePhotoSure("google", s)) return undefined;
  return s.replace(/=s\d{1,4}(-c)?$/, "=s256-c");
}
/** La photo Discord (« avatar » de /users/@me), en WebP fixe de 256 px ; null : l'avatar par défaut de Discord (pas de
 *  photo) ; undefined : une valeur inattendue. */
function photoDiscord(id: unknown, hash: unknown): string | null | undefined {
  if (hash === null || hash === undefined || hash === "") return null;
  const i = String(id ?? ""), h = String(hash);
  if (!/^\d{5,25}$/.test(i) || !/^(a_)?[0-9a-f]{32}$/.test(h)) return undefined;
  const essai = origineEssai();
  return `${essai ? essai + "/discord/cdn" : "https://cdn.discordapp.com"}/avatars/${i}/${h}.webp?size=256`;
}
/** Le type d'une image, d'après ses premiers octets (jamais d'après ce que le serveur annonce). */
function typePhoto(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  return null;
}
/** Télécharge une photo : 3 redirections au plus, chacune vers un serveur d'images du fournisseur ; 512 Ko et 5 s au
 *  plus ; une image reconnue, sinon null. */
async function telechargerPhoto(f: Fournisseur, adresse: string): Promise<{ octets: Buffer; type: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PHOTO_DELAI_MS);
  try {
    let u = adressePhotoSure(f, adresse);
    for (let saut = 0; u && saut <= 3; saut++) {
      const r = await fetch(u, { signal: ctl.signal, redirect: "manual", headers: { Accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9" } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => {});
        u = loc ? adressePhotoSure(f, new URL(loc, u).toString()) : null;
        continue;
      }
      if (!r.ok || !r.body || Number(r.headers.get("content-length") || 0) > PHOTO_MAX) {
        await r.body?.cancel().catch(() => {});
        return null;
      }
      const lecteur = r.body.getReader();
      const morceaux: Buffer[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        n += value.length;
        if (n > PHOTO_MAX) {
          await lecteur.cancel().catch(() => {});
          return null;
        }
        morceaux.push(Buffer.from(value));
      }
      const octets = Buffer.concat(morceaux);
      const type = typePhoto(octets);
      return type ? { octets, type } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
/** Vrai si ce compte a la photo de ce compte lié (PATCH /auth/profile : avatar « google » ou « discord »). */
export async function photoDe(pool: Pool, userId: number, f: string): Promise<boolean> {
  if (!PHOTOS || (f !== "google" && f !== "discord")) return false;
  try {
    const r: any = await pool.query("SELECT 1 AS a FROM user_identites WHERE user_id = ? AND fournisseur = ? AND photo IS NOT NULL LIMIT 1", [userId, f]);
    return !!(r && r.length);
  } catch {
    return false;
  }
}

async function identiteDe(f: Fournisseur, code: string, redirectUri: string, verif: string, k: { id: string; secret: string }): Promise<Identite> {
  const a = adresses(f);
  const corps = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: k.id, client_secret: k.secret });
  if (f === "google") corps.set("code_verifier", verif);
  const jeton = await demander(a.jeton, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: corps.toString(),
  });
  if (f === "google") {
    const c = lireJetonGoogle(jeton.id_token, k.id);
    const email = String(c.email || "").trim().toLowerCase();
    return {
      sujet: String(c.sub || ""),
      email,
      emailVerifie: c.email_verified === true || c.email_verified === "true",
      libelle: email,
      prenom: String(c.given_name || c.name || "").trim(),
      photo: photoGoogle(c.picture),
    };
  }
  if (typeof jeton.access_token !== "string" || !jeton.access_token) throw new Error("pas de jeton d'accès");
  const moi = await demander(a.moi, { headers: { Authorization: `Bearer ${jeton.access_token}`, Accept: "application/json" } });
  const email = String(moi.email || "").trim().toLowerCase();
  return {
    sujet: String(moi.id || ""),
    email,
    emailVerifie: moi.verified === true,
    libelle: moi.username ? "@" + String(moi.username) : String(moi.global_name || ""),
    prenom: String(moi.global_name || moi.username || "").trim(),
    photo: photoDiscord(moi.id, moi.avatar),
  };
}

/** Ce que Mon compte affiche : les comptes liés (avec l'empreinte de leur photo, ou null : le site la lit à
 *  /auth/photo/<f>?v=<empreinte>) et l'existence d'un mot de passe. */
export async function etatConnexion(pool: Pool, userId: number): Promise<{ identites: { fournisseur: Fournisseur; libelle: string; photo: string | null }[]; motDePasse: boolean }> {
  // jamais d'erreur ici : /auth/me en dépend (une erreur ferait croire à tout le monde qu'il n'est plus connecté)
  let identites: { fournisseur: Fournisseur; libelle: string; photo: string | null }[] = [];
  let motDePasse = true;
  try {
    const u: any = await pool.query("SELECT password_hash FROM users WHERE id = ? LIMIT 1", [userId]);
    motDePasse = !!(u && u[0] && String(u[0].password_hash || "").length > 0);
  } catch { /* on garde « avec mot de passe » */ }
  try {
    const ids: any = await pool.query(PHOTOS
      ? "SELECT fournisseur, libelle, photo_sha FROM user_identites WHERE user_id = ? ORDER BY fournisseur"
      : "SELECT fournisseur, libelle FROM user_identites WHERE user_id = ? ORDER BY fournisseur", [userId]);
    identites = (ids || []).map((r: any) => ({
      fournisseur: r.fournisseur as Fournisseur,
      libelle: String(r.libelle || ""),
      photo: /^[0-9a-f]{16}$/.test(String(r.photo_sha || "")) ? String(r.photo_sha) : null,
    }));
  } catch { /* table absente : aucun compte lié */ }
  return { identites, motDePasse };
}

function pseudoDe(id: Identite): string | null {
  let p = id.prenom.replace(/\s+/g, " ").trim().slice(0, 80);
  if (p.length < 2) p = id.email.split("@")[0].slice(0, 80);
  return p.length >= 2 ? p : null;
}

export async function registerOauth(app: FastifyInstance, o: Outils): Promise<void> {
  const { pool, log } = o;
  // la table des comptes liés ; si elle ne peut pas être créée, l'API démarre quand même (les routes diront « échec »)
  await pool.query(
    "CREATE TABLE IF NOT EXISTS user_identites (" +
    " id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT," +
    " user_id INT(10) UNSIGNED NOT NULL," +
    " fournisseur ENUM('google','discord') NOT NULL," +
    " sujet VARCHAR(64) NOT NULL," +
    " email VARCHAR(190) NULL," +
    " libelle VARCHAR(120) NULL," +
    " cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
    " vu_le DATETIME NULL," +
    " PRIMARY KEY (id)," +
    " UNIQUE KEY uq_identite (fournisseur, sujet)," +
    " UNIQUE KEY uq_compte_fournisseur (user_id, fournisseur)," +
    " CONSTRAINT fk_user_identites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  ).catch((err: any) => log.error({ err: String(err?.message || err).slice(0, 160) }, "[oauth] table user_identites non créée"));
  // la photo du compte lié (5 novembre 2026) : 4 colonnes de plus, posées une fois (ensuite, plus aucun ALTER au
  // démarrage) et sans jamais attendre plus de 10 s un verrou de la table ; si elles ne sont pas là, tout marche comme
  // avant, sans photo
  const colonnesPhoto = async (): Promise<number> => {
    const n: any = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'user_identites'" +
      " AND column_name IN ('photo_src', 'photo', 'photo_type', 'photo_sha')");
    return Number(n && n[0] && n[0].n);
  };
  try {
    if ((await colonnesPhoto()) !== 4) {
      await pool.query(
        "SET STATEMENT lock_wait_timeout = 10 FOR ALTER TABLE user_identites ADD COLUMN IF NOT EXISTS photo_src VARCHAR(400) NULL," +
        " ADD COLUMN IF NOT EXISTS photo MEDIUMBLOB NULL, ADD COLUMN IF NOT EXISTS photo_type VARCHAR(16) NULL, ADD COLUMN IF NOT EXISTS photo_sha CHAR(16) NULL"
      ).catch((err: any) => log.error({ err: String(err?.message || err).slice(0, 160) }, "[oauth] colonnes de la photo non posées"));
    }
    PHOTOS = (await colonnesPhoto()) === 4;
  } catch { PHOTOS = false; }
  if (!PHOTOS) log.error("[oauth] pas de photo des comptes liés (colonnes absentes)");

  const ip = ipClient;
  const COOKIE = cookieNom(o.cookieSecure);
  const poserCookie = (reply: any, v: string, maxAge: number) =>
    reply.setCookie(COOKIE, v, { httpOnly: true, secure: o.cookieSecure, sameSite: "lax", path: "/", maxAge });
  const ajouterIdentite = (db: any, userId: number, f: Fournisseur, id: Identite) => db.query(
    "INSERT INTO user_identites (user_id, fournisseur, sujet, email, libelle, vu_le) VALUES (?, ?, ?, ?, ?, NOW()) " +
    "ON DUPLICATE KEY UPDATE sujet = VALUES(sujet), email = VALUES(email), libelle = VALUES(libelle), vu_le = NOW()",
    [userId, f, id.sujet, id.email, id.libelle.slice(0, 120)]
  );
  /** La photo du compte lié, d'après ce que le fournisseur vient de donner : copiée si elle a changé (ou manque), retirée
   *  s'il n'y en a plus (l'avatar redevient alors un animal), laissée telle quelle si son adresse est inattendue ; jamais
   *  d'erreur : la connexion ne dépend pas de la photo. */
  const majPhoto = async (userId: number, f: Fournisseur, src: string | null | undefined): Promise<void> => {
    if (!PHOTOS || src === undefined) return;
    try {
      const r: any = await pool.query("SELECT photo_src AS src, photo IS NOT NULL AS a FROM user_identites WHERE user_id = ? AND fournisseur = ? LIMIT 1", [userId, f]);
      if (!r.length) return;
      if (!src) {
        if (r[0].src !== null || Number(r[0].a)) {
          await pool.query("UPDATE user_identites SET photo_src = NULL, photo = NULL, photo_type = NULL, photo_sha = NULL WHERE user_id = ? AND fournisseur = ?", [userId, f]);
          await pool.query("UPDATE users SET avatar = 'avatar_01' WHERE id = ? AND avatar = ?", [userId, f]);
          log.info({ f, userId }, "[oauth] plus de photo chez le fournisseur : copie retirée");
        }
        return;
      }
      if (r[0].src === src && Number(r[0].a)) return;
      const p = await telechargerPhoto(f, src);
      if (!p) {
        log.warn({ f, userId }, "[oauth] photo pas téléchargée (l'ancienne reste, s'il y en a une)");
        return;
      }
      await pool.query("UPDATE user_identites SET photo_src = ?, photo = ?, photo_type = ?, photo_sha = ? WHERE user_id = ? AND fournisseur = ?",
        [src, p.octets, p.type, createHash("sha256").update(p.octets).digest("hex").slice(0, 16), userId, f]);
      log.info({ f, userId, octets: p.octets.length }, "[oauth] photo copiée");
    } catch (err: any) {
      log.warn({ f, userId, err: String(err?.message || err).slice(0, 120) }, "[oauth] photo pas enregistrée");
    }
  };
  /** Un compte GameNime à la même adresse : lié puis connecté. S'il n'a jamais confirmé son adresse, on ne sait pas qui
   *  l'a créé : l'adresse est validée, et tout ce que son créateur a pu poser est retiré (mot de passe, pseudo, lien
   *  d'agenda, comptes déjà liés, sessions et appareils) ; seule l'identité qui vient de prouver l'adresse reste. D'un
   *  seul tenant : la ligne du compte est relue sous verrou (FOR UPDATE) ; une écriture déjà en route ailleurs (ancienne
   *  route, connexion, mot de passe changé) ne s'écrit que si le mot de passe lu n'a pas changé entre-temps. */
  const rattacher = async (reply: any, userId: number, f: Fournisseur, id: Identite): Promise<string> => {
    const c = await pool.getConnection();
    let repris = false;
    try {
      await c.beginTransaction();
      const r: any = await c.query("SELECT email_verified FROM users WHERE id = ? FOR UPDATE", [userId]);
      if (!r.length) throw new Error("compte disparu");
      if (!Number(r[0].email_verified)) {
        await c.query("UPDATE users SET email_verified = 1, email_verified_at = NOW(), password_hash = '', calendar_token = NULL, display_name = ? WHERE id = ?", [pseudoDe(id), userId]);
        await c.query("DELETE FROM user_identites WHERE user_id = ?", [userId]);
        // ses sessions aussi, avant de relâcher le verrou : une demande déjà en route avec l'une d'elles ne peut plus rien
        // écrire ensuite (pseudo, lien d'agenda, mot de passe) ; les appareils sont oubliés après
        await c.query("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
        repris = true;
      }
      await ajouterIdentite(c, userId, f, id);
      await c.commit();
    } catch (err) {
      await c.rollback().catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    if (repris) {
      await o.fermerSessions(userId);
      log.warn({ f, userId }, "[oauth] compte à l'adresse non confirmée repris : mot de passe, pseudo, agenda, comptes liés et sessions retirés");
    }
    await majPhoto(userId, f, id.photo);
    await o.ouvrirSession(reply, userId);
    log.info({ f, userId }, "[oauth] compte existant lié, connexion");
    return "relie";
  };

  app.get("/auth/fournisseurs", async (_req, reply) => reply.send({ google: !!cles("google"), discord: !!cles("discord") }));

  // ── la photo d'un compte lié : au seul titulaire du compte (sa session). L'adresse que le site lit porte l'empreinte
  //    de la photo (?v=), d'où une année dans le cache du navigateur (privé : jamais dans un cache partagé).
  app.get<{ Params: { f: string } }>("/auth/photo/:f", async (req: any, reply: any) => {
    const f = req.params.f as Fournisseur;
    if (f !== "google" && f !== "discord") return reply.code(404).send({ error: "Introuvable" });
    const u = await o.utilisateur(req).catch(() => null);
    if (!u) return reply.code(401).send({ error: "Non authentifié" });
    const r: any = PHOTOS ? await pool.query("SELECT photo, photo_type AS type FROM user_identites WHERE user_id = ? AND fournisseur = ? LIMIT 1", [u.id, f]) : [];
    const p = r && r[0];
    if (!p || !p.photo || !TYPES_PHOTO.includes(String(p.type))) return reply.code(404).send({ error: "Pas de photo" });
    return reply
      .header("Content-Type", String(p.type))
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .send(Buffer.from(p.photo));
  });

  // ── départ : vers l'écran de Google ou de Discord ──
  app.get<{ Params: { f: string }; Querystring: Record<string, string> }>("/auth/:f", async (req: any, reply: any) => {
    const f = req.params.f as Fournisseur;
    if (f !== "google" && f !== "discord") return reply.code(404).send({ error: "Introuvable" });
    const q = req.query || {};
    const mode = q.mode === "lier" ? "lier" : "connexion";
    const depuis = q.depuis === "register" ? "/register" : "/signin";
    const retour = cheminSur(q.retour);
    const site = siteDe(req);
    const ko = (code: string) => reply.redirect(site + (mode === "lier" ? ajouterCode(retour, `${code}-${f}`) : versErreur(depuis, `${code}-${f}`, retour)));
    if (!o.limite(`oauth-depart:${ip(req)}`, 30, 15 * 60 * 1000)) return ko("trop");
    const k = cles(f);
    if (!k) return ko("indisponible");
    let userId: number | null = null;
    if (mode === "lier") {
      const u = await o.utilisateur(req).catch(() => null);
      if (!u) return reply.redirect(site + "/signin" + (retour !== "/" ? "?retour=" + encodeURIComponent(retour) : ""));
      // lier demande une adresse confirmée : sinon le créateur d'un compte à l'adresse d'un autre pourrait y lier son
      // propre Google ou Discord avant que le vrai titulaire ne la reprenne
      if (!u.emailVerified) return ko("confirmer");
      userId = Number(u.id);
    }
    const state = b64url(randomBytes(32));
    const verif = b64url(randomBytes(32));
    if (!ranger(state, { f, mode, retour, depuis, userId, verif, fin: Date.now() + DUREE_MS })) return ko("trop");
    poserCookie(reply, state, DUREE_MS / 1000);
    const p = new URLSearchParams({ client_id: k.id, redirect_uri: `${site}/api/auth/${f}/retour`, response_type: "code", state });
    if (f === "google") {
      p.set("scope", "openid email profile");
      p.set("code_challenge", b64url(createHash("sha256").update(verif).digest()));
      p.set("code_challenge_method", "S256");
      p.set("prompt", "select_account");
    } else {
      p.set("scope", "identify email");
    }
    return reply.redirect(`${adresses(f).autoriser}?${p.toString()}`);
  });

  // ── retour de Google ou de Discord ──
  app.get<{ Params: { f: string }; Querystring: Record<string, string> }>("/auth/:f/retour", async (req: any, reply: any) => {
    const f = req.params.f as Fournisseur;
    if (f !== "google" && f !== "discord") return reply.code(404).send({ error: "Introuvable" });
    const q = req.query || {};
    const site = siteDe(req);
    const state = typeof q.state === "string" ? q.state : "";
    const duCookie = typeof req.cookies?.[COOKIE] === "string" ? req.cookies[COOKIE] : "";
    const e = state ? ENTREES.get(state) : undefined;
    if (e) ENTREES.delete(state);
    poserCookie(reply, "", 0);
    const fin = (code: string, ok = false) => {
      if (e && e.mode === "lier") return reply.redirect(site + ajouterCode(e.retour, `${code}-${f}`));
      if (ok && e) return reply.redirect(site + ajouterCode(e.retour, `${code}-${f}`));
      return reply.redirect(site + (e ? versErreur(e.depuis, `${code}-${f}`, e.retour) : versErreur("/signin", `${code}-${f}`, "/")));
    };
    if (!o.limite(`oauth-retour:${ip(req)}`, 30, 15 * 60 * 1000)) return fin("trop");
    // l'entrée doit exister, être de ce fournisseur, encore valable, et le cookie de CE navigateur doit porter le même state
    if (!e || e.f !== f || e.fin < Date.now() || !duCookie || duCookie !== state) {
      log.warn({ f, raison: !e ? "state inconnu" : e.f !== f ? "autre fournisseur" : e.fin < Date.now() ? "expiré" : "cookie absent ou différent" }, "[oauth] retour refusé");
      if (e && e.f === f && e.mode === "lier") return reply.redirect(site + ajouterCode(e.retour, `echec-${f}`));
      return reply.redirect(site + `/signin?erreur=echec-${f}`);
    }
    if (typeof q.error === "string" && q.error) return fin(q.error === "access_denied" ? "annule" : "echec");
    const code = typeof q.code === "string" ? q.code : "";
    const k = cles(f);
    if (!code || !k) return fin(k ? "echec" : "indisponible");
    let id: Identite;
    try {
      id = await identiteDe(f, code, `${site}/api/auth/${f}/retour`, e.verif, k);
    } catch (err: any) {
      log.warn({ f, err: String(err?.message || err).slice(0, 120) }, "[oauth] échange refusé");
      return fin("echec");
    }
    if (!id.sujet || id.sujet.length > 64) return fin("echec");
    if (!id.email || !id.emailVerifie || id.email.length > 190) return fin("email");
    // ASCII seulement : la base compare les adresses sans tenir compte des accents (« alice@orangé.fr », vérifiée chez le
    // fournisseur sur un domaine à quelqu'un d'autre, trouverait le compte « alice@orange.fr »)
    if (!/^[\x21-\x7e]+$/.test(id.email)) return fin("email");

    try {
      // ── lier au compte connecté ──
      if (e.mode === "lier") {
        const u = await o.utilisateur(req).catch(() => null);
        if (!u || Number(u.id) !== e.userId) return reply.redirect(site + "/signin" + (e.retour !== "/" ? "?retour=" + encodeURIComponent(e.retour) : ""));
        if (!u.emailVerified) return fin("confirmer");
        const deja: any = await pool.query("SELECT user_id FROM user_identites WHERE fournisseur = ? AND sujet = ? LIMIT 1", [f, id.sujet]);
        if (deja.length && Number(deja[0].user_id) !== e.userId) return fin("deja-lie");
        // l'adresse toujours confirmée, relue sous verrou au moment d'écrire (l'ancienne route de mot de passe la repasse
        // « à confirmer », et attend ce verrou)
        const c = await pool.getConnection();
        let confirme = false;
        try {
          await c.beginTransaction();
          const r: any = await c.query("SELECT email_verified FROM users WHERE id = ? FOR UPDATE", [e.userId]);
          confirme = !!(r.length && Number(r[0].email_verified));
          if (confirme) await ajouterIdentite(c, e.userId as number, f, id);
          await c.commit();
        } catch (err) {
          await c.rollback().catch(() => {});
          throw err;
        } finally {
          c.release();
        }
        if (!confirme) return fin("confirmer");
        await majPhoto(e.userId as number, f, id.photo);
        log.info({ f, userId: e.userId }, "[oauth] compte lié");
        return fin("lie", true);
      }
      // ── se connecter (ou créer le compte) ──
      const lie: any = await pool.query("SELECT user_id FROM user_identites WHERE fournisseur = ? AND sujet = ? LIMIT 1", [f, id.sujet]);
      if (lie.length) {
        const userId = Number(lie[0].user_id);
        await pool.query("UPDATE user_identites SET email = ?, libelle = ?, vu_le = NOW() WHERE fournisseur = ? AND sujet = ?", [id.email, id.libelle.slice(0, 120), f, id.sujet]);
        await majPhoto(userId, f, id.photo);
        await o.ouvrirSession(reply, userId);
        log.info({ f, userId }, "[oauth] connexion");
        return fin("connecte", true);
      }
      const existant: any = await pool.query("SELECT id, email FROM users WHERE email = ? LIMIT 1", [id.email]);
      if (existant.length) {
        // la même adresse exactement (la base trouve aussi une adresse qui ne diffère que par un accent)
        if (String(existant[0].email || "").trim().toLowerCase() !== id.email) return fin("echec");
        return fin(await rattacher(reply, Number(existant[0].id), f, id), true);
      }
      const pseudo = pseudoDe(id);
      let userId: number;
      try {
        const r: any = await pool.query(
          "INSERT INTO users (email, password_hash, display_name, avatar, email_verified, email_verified_at) VALUES (?, '', ?, 'avatar_01', 1, NOW())",
          [id.email, pseudo]
        );
        userId = Number(r.insertId);
      } catch (err: any) {
        // la même adresse créée entre-temps (double clic, ou une inscription au même instant) : c'est alors un compte
        // existant, avec les mêmes règles (une adresse jamais confirmée est reprise)
        if (err?.code !== "ER_DUP_ENTRY") throw err;
        const r2: any = await pool.query("SELECT id, email FROM users WHERE email = ? LIMIT 1", [id.email]);
        if (!r2.length || String(r2[0].email || "").trim().toLowerCase() !== id.email) throw err;
        return fin(await rattacher(reply, Number(r2[0].id), f, id), true);
      }
      await ajouterIdentite(pool, userId, f, id);
      await majPhoto(userId, f, id.photo);
      await o.ouvrirSession(reply, userId);
      void o.bienvenue(id.email, pseudo).catch((err: any) => log.error({ userId, err: err?.message || String(err) }, "[email] echec welcome (oauth)"));
      log.info({ f, userId }, "[oauth] compte créé");
      return fin("bienvenue", true);
    } catch (err: any) {
      log.error({ f, err: String(err?.message || err).slice(0, 160) }, "[oauth] erreur");
      return fin("echec");
    }
  });

  // ── délier ── (une transaction, la ligne du compte verrouillée : deux « délier » en même temps ne peuvent pas retirer
  //    la dernière façon de se connecter)
  app.post<{ Params: { f: string } }>("/auth/identites/:f/delier", async (req: any, reply: any) => {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return reply.code(403).send({ error: "Requête refusée" });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "JSON attendu" });
    const f = req.params.f as Fournisseur;
    if (f !== "google" && f !== "discord") return reply.code(404).send({ error: "Introuvable" });
    const u = await o.utilisateur(req);
    if (!u) return reply.code(401).send({ error: "Non authentifié" });
    const conn = await pool.getConnection();
    let refus = false;
    let retire = false;
    try {
      await conn.beginTransaction();
      const c: any = await conn.query("SELECT password_hash FROM users WHERE id = ? FOR UPDATE", [u.id]);
      const ids: any = await conn.query("SELECT fournisseur FROM user_identites WHERE user_id = ?", [u.id]);
      const motDePasse = !!(c && c[0] && String(c[0].password_hash || "").length > 0);
      const lies = (ids || []).map((r: any) => String(r.fournisseur));
      if (lies.includes(f)) {
        if (!motDePasse && lies.filter((x: string) => x !== f).length === 0) refus = true;
        else {
          await conn.query("DELETE FROM user_identites WHERE user_id = ? AND fournisseur = ?", [u.id, f]);
          // sa photo part avec lui : si c'était l'avatar, il redevient un animal
          await conn.query("UPDATE users SET avatar = 'avatar_01' WHERE id = ? AND avatar = ?", [u.id, f]);
          retire = true;
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    const etat = await etatConnexion(pool, Number(u.id));
    if (refus) return reply.code(409).send({ error: `C'est ta seule façon de te connecter : crée d'abord un mot de passe, ou lie un autre compte.`, ...etat });
    if (retire) log.info({ f, userId: u.id }, "[oauth] compte délié");
    return reply.send({ ok: true, ...etat });
  });
}

export const NOM_FOURNISSEUR = NOMS;
