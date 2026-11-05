/**
 * GameNime — les comptes du dashboard (section Administration › Comptes utilisateurs, 30 octobre 2026).
 *
 * La section lit ici TOUS les comptes (filtres, recherche, tri, par pages de 25) et la fiche d'un compte, et y fait les
 * quatre gestes demandés par Rey : renvoyer l'e-mail de confirmation, envoyer un lien de mot de passe, valider l'e-mail
 * à la main, supprimer le compte (le pseudo tapé en confirmation). Chaque geste est noté dans le journal du Pilotage.
 *
 * Routes, toutes à clé d'administration (nginx l'ajoute derrière /dashboard/admin/, comme pour les autres routes du
 * dashboard) :
 *   POST /admin/comptes/liste {filtre: tous|actifs|nonverif|reinit, q, tri: inscription|visite|anciens, nombre: 25}
 *        (la recherche passe dans le corps, pas dans l'adresse : elle ne finit pas dans les journaux)
 *   GET  /admin/comptes/:id
 *   POST /admin/comptes/:id/renvoyer-confirmation | lien-mot-de-passe | valider-email | supprimer {confirmation}
 * Les gestes et la liste n'acceptent que du JSON (Content-Type application/json) et refusent une requête venue d'un
 * autre site (Sec-Fetch-Site: cross-site) : un formulaire d'une autre page ne peut pas les déclencher.
 * Les adresses e-mail ne sortent jamais en clair : masquées ici, avant la réponse (un pseudo qui est une adresse aussi).
 *
 * Les mêmes définitions partout (tuiles, filtres, pastilles, flux du dashboard) :
 *  - actif : vu dans les 30 derniers jours ;
 *  - e-mail non vérifié : email_verified = 0 (« depuis plus de 7 j » : inscrit il y a plus de 7 jours) ;
 *  - réinitialisation en attente : la dernière demande de nouveau mot de passe des 30 derniers jours n'a pas servi, et
 *    le compte n'a pas été vu depuis (ni connexion ni visite).
 *
 * La dernière visite : la table compte_visites garde, pour chaque compte, l'heure de sa dernière requête connectée
 * (notée au plus une fois par heure et par compte : noterVisite, appelée par index.ts), et à coup sûr à l'inscription, à
 * la connexion, à la déconnexion et au changement de mot de passe (ces deux-là effacent des sessions). Avant ce patch, on
 * ne la connaissait que par les sessions encore ouvertes : au démarrage, la table reprend ce que disent les sessions.
 *
 * Les heures : la base vit à l'heure de Paris (NOW(), valeurs par défaut des colonnes), mais les dates d'expiration des
 * liens et des sessions sont écrites par l'API en UTC. Tout est donc calculé dans SQL : les dates à afficher partent en
 * texte, heure de la base (« AAAA-MM-JJ HH:MM »), et les expirations sont comparées à UTC_TIMESTAMP().
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sendPasswordResetEmail, sendVerificationEmail } from "../email-service.js";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<any> };
type Journal = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

const PAGE = 25;
const PAGE_MAX = 500;
const VISITE_PAS_MS = 60 * 60 * 1000;
const GESTE_PAS_MS = 60 * 1000;

// ─────────────────────────────────────────────────────────────── les définitions (SQL)

/** La dernière visite connue de chaque compte : compte_visites, et les sessions (connexion ou dernière requête). */
const VU = "(SELECT x.user_id, MAX(x.t) AS vu FROM (SELECT user_id, derniere AS t FROM compte_visites UNION ALL " +
  "SELECT user_id, COALESCE(last_seen_at, created_at) AS t FROM user_sessions) x GROUP BY x.user_id)";
/** La dernière demande de nouveau mot de passe des 30 derniers jours, par compte. */
const DEMANDE = "(SELECT p.user_id, p.created_at AS demandee, p.used_at, p.expires_at FROM password_reset_tokens p " +
  "JOIN (SELECT user_id, MAX(id) AS id FROM password_reset_tokens WHERE created_at >= NOW() - INTERVAL 30 DAY GROUP BY user_id) d " +
  "ON d.id = p.id)";
const DEPUIS = ` FROM users u LEFT JOIN ${VU} v ON v.user_id = u.id LEFT JOIN ${DEMANDE} r ON r.user_id = u.id`;
const ACTIF = "(v.vu IS NOT NULL AND v.vu >= NOW() - INTERVAL 30 DAY)";
const EN_ATTENTE = "(r.user_id IS NOT NULL AND r.used_at IS NULL AND (v.vu IS NULL OR v.vu <= r.demandee))";
const FILTRES: Record<string, string> = {
  tous: "1=1",
  actifs: ACTIF,
  nonverif: "u.email_verified = 0",
  reinit: EN_ATTENTE,
};
const TRIS: Record<string, string> = {
  inscription: "u.created_at DESC, u.id DESC",
  visite: "(v.vu IS NULL), v.vu DESC, u.id DESC",
  anciens: "u.created_at ASC, u.id ASC",
};
const DATE = (col: string) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i')`;

// ─────────────────────────────────────────────────────────────── petits outils

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function nOuNull(v: unknown): number | null {
  return v == null ? null : n(v);
}
function oui(v: unknown): boolean {
  return n(v) === 1;
}
function masquer(email: unknown): string {
  const e = String(email || "");
  const at = e.indexOf("@");
  if (at < 1) return "\u2022\u2022\u2022";
  return e[0] + "\u2022\u2022\u2022" + e.slice(at);
}
const RESSEMBLE_ADRESSE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Le pseudo, tel quel ; masqué comme une adresse s'il en est une. */
function nom(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return RESSEMBLE_ADRESSE.test(s) ? masquer(s) : s;
}
/** Ce qu'il faut taper pour supprimer le compte : le pseudo s'il s'affiche en entier et se tape (pas masqué, sur une
 * ligne) ; sinon null, et c'est #id (#id est toujours accepté). */
function confirmationDe(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || RESSEMBLE_ADRESSE.test(s) || /[\u0000-\u001f\u007f\u2022]/.test(s)) return null;
  return s;
}
/** Le nom d'un compte dans le journal et les messages : le pseudo et le #id. */
function qui(u: { id: number; nom: string | null }): string {
  return (u.nom ? u.nom.slice(0, 80) + " " : "") + "(#" + u.id + ")";
}
function raisonBase(e: any): string {
  const c = String(e?.code || "");
  if (/CONN|TIMEOUT|ECONN|ENOTFOUND|EHOSTUNREACH|PROTOCOL|ER_GET_CONNECTION|ER_SOCKET/i.test(c) || /connect|timeout/i.test(String(e?.message || ""))) {
    return "base injoignable";
  }
  return "erreur de la base" + (c ? " (" + c.slice(0, 40) + ")" : "");
}

/** La clé d'administration (celle des autres routes /admin), comparée à temps constant. */
function cle(fournie: unknown): { ok: true } | { ok: false; code: number; msg: string } {
  const attendue = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY || "";
  if (!attendue) return { ok: false, code: 500, msg: "API key not configured" };
  if (typeof fournie !== "string") return { ok: false, code: 401, msg: "Unauthorized" };
  const a = Buffer.from(fournie);
  const b = Buffer.from(attendue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 401, msg: "Unauthorized" };
  return { ok: true };
}

/** La liste et les gestes : du JSON venu du dashboard, pas un formulaire d'une autre page (le navigateur y joindrait le
 * mot de passe du staging, et nginx la clé). */
function requeteAdmise(req: any): { ok: true } | { ok: false; code: number; msg: string } {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return { ok: false, code: 403, msg: "requete venue d'un autre site" };
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return { ok: false, code: 415, msg: "JSON attendu" };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────── la table des visites

let PRETE = false;
let EN_COURS: Promise<void> | null = null;

async function creerTable(pool: Pool): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS compte_visites (" +
    " user_id INT(10) UNSIGNED NOT NULL," +
    " derniere DATETIME NOT NULL," +
    " PRIMARY KEY (user_id)," +
    " CONSTRAINT fk_compte_visites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  );
  // ce que disent les sessions (la seule trace des visites avant ce patch) : gardé s'il est plus récent
  await pool.query(
    "INSERT INTO compte_visites (user_id, derniere)" +
    " SELECT s.user_id, MAX(COALESCE(s.last_seen_at, s.created_at)) FROM user_sessions s JOIN users u ON u.id = s.user_id GROUP BY s.user_id" +
    " ON DUPLICATE KEY UPDATE derniere = GREATEST(compte_visites.derniere, VALUES(derniere))"
  );
}

/** La table existe : créée au démarrage, ou à la première lecture qui suit si la base ne répondait pas. */
async function tablePrete(pool: Pool): Promise<void> {
  if (PRETE) return;
  if (!EN_COURS) {
    EN_COURS = creerTable(pool)
      .then(() => { PRETE = true; })
      .finally(() => { EN_COURS = null; });
  }
  return EN_COURS;
}

/** Une lecture qui passe par compte_visites. Si la table a disparu (base restaurée d'une sauvegarde d'avant ce patch ?),
 * elle est recréée, puis la lecture refaite une fois. */
async function avecTable<T>(pool: Pool, lire: () => Promise<T>): Promise<T> {
  await tablePrete(pool);
  try {
    return await lire();
  } catch (e: any) {
    if (e?.code !== "ER_NO_SUCH_TABLE" || !/compte_visites/.test(String(e?.message || ""))) throw e;
    PRETE = false;
    await tablePrete(pool);
    return lire();
  }
}

const VISITES = new Map<number, number>();

/** Une requête connectée de ce compte : sa dernière visite est notée, au plus une fois par heure (sans attendre) ;
 * à coup sûr avec forcer (inscription, connexion, nouveau mot de passe). */
export function noterVisite(pool: Pool, userId: unknown, forcer = false): void {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  const t = Date.now();
  const avant = VISITES.get(id);
  if (!forcer && avant !== undefined && t - avant < VISITE_PAS_MS) return;
  if (VISITES.size > 100000) VISITES.clear();
  VISITES.set(id, t);
  tablePrete(pool)
    .then(() => pool.query("INSERT INTO compte_visites (user_id, derniere) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE derniere = NOW()", [id]))
    .catch((e: any) => {
      // compte supprimé entre-temps, ou base injoignable : la prochaine heure le notera ; table disparue : recréée alors
      if (e?.code === "ER_NO_SUCH_TABLE") PRETE = false;
    });
}

/** Une déconnexion : la visite est notée avant que la session ne soit effacée (attendue, mais jamais en erreur). */
export async function noterDeconnexion(pool: Pool, tokenHash: string): Promise<void> {
  try {
    await tablePrete(pool);
    await pool.query(
      "INSERT INTO compte_visites (user_id, derniere) SELECT user_id, NOW() FROM user_sessions WHERE token_hash = ? ON DUPLICATE KEY UPDATE derniere = NOW()",
      [tokenHash]
    );
  } catch {
    /* la déconnexion ne doit jamais échouer pour ça */
  }
}

// ─────────────────────────────────────────────────────────────── les lectures

export interface Chiffres {
  total: number;
  nouveaux_mois: number;
  actifs: number;
  non_verifies: number;
  non_verifies_vieux: number;
  reinit: number;
}

async function chiffres(pool: Pool): Promise<Chiffres> {
  const r: any = await avecTable(pool, () => pool.query(
    "SELECT COUNT(*) AS total," +
    " SUM(u.created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS nouveaux_mois," +
    ` SUM(${ACTIF}) AS actifs,` +
    " SUM(u.email_verified = 0) AS non_verifies," +
    " SUM(u.email_verified = 0 AND u.created_at < NOW() - INTERVAL 7 DAY) AS non_verifies_vieux," +
    ` SUM(${EN_ATTENTE}) AS reinit` + DEPUIS
  ));
  const x = r?.[0] || {};
  return {
    total: n(x.total), nouveaux_mois: n(x.nouveaux_mois), actifs: n(x.actifs), non_verifies: n(x.non_verifies),
    non_verifies_vieux: n(x.non_verifies_vieux), reinit: n(x.reinit),
  };
}

/** Les chiffres de la section, pour le flux du dashboard (dashboard.ts, toutes les 2 s par onglet ouvert) : aucun compte
 * nommé ; relus au plus toutes les 30 s. */
let FLUX: { le: number; v: Chiffres & { lu_le: number } } | null = null;
export async function chiffresComptes(pool: Pool): Promise<(Chiffres & { lu_le: number }) | { error: string }> {
  if (FLUX && Date.now() - FLUX.le < 30000) return FLUX.v;
  try {
    const v = { ...(await chiffres(pool)), lu_le: Date.now() };
    FLUX = { le: Date.now(), v };
    return v;
  } catch (e: any) {
    return { error: raisonBase(e) };
  }
}

function recherche(q: string): { sql: string; params: unknown[] } {
  const t = q.trim().slice(0, 100);
  if (!t) return { sql: "", params: [] };
  const motif = "%" + t.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const id = /^#?\d{1,10}$/.test(t) ? Number(t.replace("#", "")) : -1;
  return { sql: " AND (u.display_name LIKE ? OR u.email LIKE ? OR u.id = ?)", params: [motif, motif, id] };
}

async function liste(pool: Pool, filtre: string, tri: string, q: string, nombre: number) {
  const f = FILTRES[filtre] ?? FILTRES.tous;
  const o = TRIS[tri] ?? TRIS.inscription;
  const r = recherche(q);
  const total: any = await avecTable(pool, () => pool.query("SELECT COUNT(*) AS n" + DEPUIS + " WHERE " + f + r.sql, r.params));
  const lignes: any = await avecTable(pool, () => pool.query(
    "SELECT u.id, u.display_name AS nom, u.email, u.email_verified AS verifie," +
    ` ${DATE("u.created_at")} AS inscrit, DATEDIFF(NOW(), u.created_at) AS inscrit_jours,` +
    ` ${DATE("v.vu")} AS vu, DATEDIFF(NOW(), v.vu) AS vu_jours,` +
    ` ${ACTIF} AS actif, ${EN_ATTENTE} AS reinit` +
    DEPUIS + " WHERE " + f + r.sql + " ORDER BY " + o + " LIMIT " + Math.max(1, Math.min(PAGE_MAX, nombre)),
    r.params
  ));
  return {
    total: n(total?.[0]?.n),
    comptes: (lignes || []).map((x: any) => ({
      id: n(x.id), nom: nom(x.nom), email_masque: masquer(x.email), verifie: oui(x.verifie), actif: oui(x.actif), reinit: oui(x.reinit),
      inscrit: x.inscrit ? String(x.inscrit) : null, inscrit_jours: nOuNull(x.inscrit_jours),
      vu: x.vu ? String(x.vu) : null, vu_jours: nOuNull(x.vu_jours),
    })),
  };
}

async function fiche(pool: Pool, id: number) {
  const r: any = await avecTable(pool, () => pool.query(
    "SELECT u.id, u.display_name AS nom, u.email, u.email_verified AS verifie, u.email_notifications_enabled AS alertes_email," +
    " u.is_premium AS premium, u.stripe_subscription_id IS NOT NULL AS stripe," +
    ` ${DATE("u.email_verified_at")} AS verifie_le,` +
    ` ${DATE("u.created_at")} AS inscrit, DATEDIFF(NOW(), u.created_at) AS inscrit_jours,` +
    ` ${DATE("v.vu")} AS vu, DATEDIFF(NOW(), v.vu) AS vu_jours,` +
    ` ${ACTIF} AS actif, ${EN_ATTENTE} AS reinit,` +
    ` ${DATE("r.demandee")} AS reinit_demandee, (r.expires_at < UTC_TIMESTAMP()) AS reinit_expiree,` +
    " (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.expires_at > UTC_TIMESTAMP()) AS sessions," +
    " (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favoris," +
    " (SELECT COUNT(*) FROM reminder_log m WHERE m.user_id = u.id) AS rappels," +
    " (SELECT COUNT(*) FROM reminder_log m WHERE m.user_id = u.id AND m.email_sent_at IS NOT NULL) AS rappels_email" +
    DEPUIS + " WHERE u.id = ?",
    [id]
  ));
  const x = r?.[0];
  if (!x) return null;
  const l: any = await pool.query(
    `SELECT ${DATE("created_at")} AS cree, used_at IS NOT NULL AS utilise, expires_at < UTC_TIMESTAMP() AS expire` +
    " FROM email_verification_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    [id]
  );
  // le dernier lien créé (créé avant l'envoi : un envoi refusé par le serveur d'e-mails laisse aussi un lien)
  const lien = l?.[0] ? { cree: String(l[0].cree), etat: oui(l[0].utilise) ? "utilise" : oui(l[0].expire) ? "expire" : "valable" } : null;
  return {
    id: n(x.id), nom: nom(x.nom), email_masque: masquer(x.email), verifie: oui(x.verifie), verifie_le: x.verifie_le ? String(x.verifie_le) : null,
    inscrit: x.inscrit ? String(x.inscrit) : null, inscrit_jours: nOuNull(x.inscrit_jours),
    vu: x.vu ? String(x.vu) : null, vu_jours: nOuNull(x.vu_jours), actif: oui(x.actif),
    sessions: n(x.sessions), lien,
    reinit: oui(x.reinit), reinit_demandee: x.reinit_demandee ? String(x.reinit_demandee) : null, reinit_expiree: oui(x.reinit_expiree),
    favoris: n(x.favoris), alertes_email: oui(x.alertes_email), rappels: n(x.rappels), rappels_email: n(x.rappels_email),
    premium: oui(x.premium), stripe: oui(x.stripe), confirmation: confirmationDe(x.nom),
  };
}

// ─────────────────────────────────────────────────────────────── les gestes

/** Le journal du Pilotage (le geste de Rey, sans adresse e-mail). */
async function noter(pool: Pool, log: Journal, niveau: "info" | "warn", texte: string): Promise<void> {
  try {
    await pool.query("INSERT INTO pilotage_journal (le, qui, niveau, module, texte, detail) VALUES (?, 'rey', ?, 'Comptes', ?, NULL)", [
      Date.now(), niveau, texte.slice(0, 300),
    ]);
  } catch (e: any) {
    log.warn({ module: "comptes", err: String(e?.message || e) }, "comptes : journal du Pilotage non écrit");
  }
}

/** Un e-mail par compte et par minute au plus, quel que soit le bouton (un double clic n'envoie pas deux messages). */
const ENVOIS = new Map<number, number>();
function envoiRecent(id: number): boolean {
  const t = ENVOIS.get(id);
  return t !== undefined && Date.now() - t < GESTE_PAS_MS;
}

function raisonEnvoi(r: { reason?: string } | undefined): string {
  const x = String(r?.reason || "");
  if (x === "smtp_failed") return "le serveur d'e-mails a refusé l'envoi";
  if (x === "missing_user_or_email") return "adresse absente";
  return "erreur interne" + (x ? " (" + x.slice(0, 40) + ")" : "");
}

interface Compte {
  id: number;
  nom: string | null; // pour les messages et le journal (masqué s'il ressemble à une adresse)
  pseudo: string | null; // tel qu'en base, pour les e-mails (comme les envois du site)
  confirmation: string | null;
  email: string;
  verifie: boolean;
  stripe: boolean;
}
async function compte(pool: Pool, id: number): Promise<Compte | null> {
  const r: any = await pool.query(
    "SELECT id, display_name AS nom, email, email_verified AS verifie, stripe_subscription_id IS NOT NULL AS stripe FROM users WHERE id = ?",
    [id]
  );
  const x = r?.[0];
  if (!x) return null;
  return {
    id: n(x.id), nom: nom(x.nom), pseudo: x.nom == null ? null : String(x.nom), confirmation: confirmationDe(x.nom),
    email: String(x.email || ""), verifie: oui(x.verifie), stripe: oui(x.stripe),
  };
}

// ─────────────────────────────────────────────────────────────── les routes

function idDe(req: any): number | null {
  const s = String(req.params?.id ?? "");
  if (!/^\d{1,10}$/.test(s)) return null;
  const v = Number(s);
  return v > 0 && v <= 4294967295 ? v : null;
}

export async function registerComptes(app: FastifyInstance, pool: Pool): Promise<void> {
  const log = app.log as unknown as Journal;

  app.post("/admin/comptes/liste", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const j = requeteAdmise(req);
    if (!j.ok) return reply.code(j.code).send({ ok: false, msg: j.msg });
    const q = (req.body && typeof req.body === "object" ? req.body : {}) as any;
    const filtre = String(q.filtre || "tous");
    const tri = String(q.tri || "inscription");
    const nombre = Math.max(1, Math.min(PAGE_MAX, Math.floor(Number(q.nombre) || PAGE)));
    try {
      const c = await chiffres(pool);
      const l = await liste(pool, filtre, tri, String(q.q || ""), nombre);
      return reply.send({ ok: true, lu_le: Date.now(), filtre: FILTRES[filtre] ? filtre : "tous", tri: TRIS[tri] ? tri : "inscription", nombre_max: PAGE_MAX,
        chiffres: c, total: l.total, comptes: l.comptes });
    } catch (e: any) {
      log.warn({ module: "comptes", err: String(e?.message || e) }, "comptes : lecture impossible");
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  app.get("/admin/comptes/:id", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const id = idDe(req);
    if (!id) return reply.code(400).send({ ok: false, msg: "identifiant de compte invalide" });
    try {
      const c = await fiche(pool, id);
      if (!c) return reply.code(404).send({ ok: false, msg: "compte introuvable (supprimé ?)" });
      return reply.send({ ok: true, lu_le: Date.now(), compte: c });
    } catch (e: any) {
      log.warn({ module: "comptes", err: String(e?.message || e) }, "comptes : fiche illisible");
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  app.post("/admin/comptes/:id/renvoyer-confirmation", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const j = requeteAdmise(req);
    if (!j.ok) return reply.code(j.code).send({ ok: false, msg: j.msg });
    const id = idDe(req);
    if (!id) return reply.code(400).send({ ok: false, msg: "identifiant de compte invalide" });
    try {
      const u = await compte(pool, id);
      if (!u) return reply.code(404).send({ ok: false, msg: "compte introuvable (supprimé ?)" });
      if (u.verifie) return reply.code(409).send({ ok: false, msg: "e-mail déjà vérifié : rien à renvoyer" });
      if (envoiRecent(id)) return reply.code(429).send({ ok: false, msg: "un e-mail vient de partir vers ce compte : attends une minute" });
      ENVOIS.set(id, Date.now());
      const r = await sendVerificationEmail({ db: pool, userId: id, email: u.email, displayName: u.pseudo, ip: null, userAgent: "dashboard" });
      if (!r?.ok) {
        ENVOIS.delete(id);
        await noter(pool, log, "warn", qui(u) + " : e-mail de confirmation pas envoyé (" + raisonEnvoi(r) + ")");
        return reply.code(502).send({ ok: false, msg: "Envoi impossible : " + raisonEnvoi(r) });
      }
      await noter(pool, log, "info", qui(u) + " : e-mail de confirmation renvoyé");
      return reply.send({ ok: true, msg: "E-mail de confirmation renvoyé à " + masquer(u.email) + " (lien valable 48 h)" });
    } catch (e: any) {
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  app.post("/admin/comptes/:id/lien-mot-de-passe", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const j = requeteAdmise(req);
    if (!j.ok) return reply.code(j.code).send({ ok: false, msg: j.msg });
    const id = idDe(req);
    if (!id) return reply.code(400).send({ ok: false, msg: "identifiant de compte invalide" });
    try {
      const u = await compte(pool, id);
      if (!u) return reply.code(404).send({ ok: false, msg: "compte introuvable (supprimé ?)" });
      if (envoiRecent(id)) return reply.code(429).send({ ok: false, msg: "un e-mail vient de partir vers ce compte : attends une minute" });
      ENVOIS.set(id, Date.now());
      const r = await sendPasswordResetEmail({ db: pool, userId: id, email: u.email, displayName: u.pseudo, ip: null, userAgent: "dashboard" });
      if (!r?.ok) {
        ENVOIS.delete(id);
        await noter(pool, log, "warn", qui(u) + " : lien de mot de passe pas envoyé (" + raisonEnvoi(r) + ")");
        return reply.code(502).send({ ok: false, msg: "Envoi impossible : " + raisonEnvoi(r) });
      }
      await noter(pool, log, "info", qui(u) + " : lien de mot de passe envoyé");
      return reply.send({ ok: true, msg: "Lien de mot de passe envoyé à " + masquer(u.email) + " (valable 30 min)" });
    } catch (e: any) {
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  app.post("/admin/comptes/:id/valider-email", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const j = requeteAdmise(req);
    if (!j.ok) return reply.code(j.code).send({ ok: false, msg: j.msg });
    const id = idDe(req);
    if (!id) return reply.code(400).send({ ok: false, msg: "identifiant de compte invalide" });
    try {
      const u = await compte(pool, id);
      if (!u) return reply.code(404).send({ ok: false, msg: "compte introuvable (supprimé ?)" });
      if (u.verifie) return reply.code(409).send({ ok: false, msg: "e-mail déjà vérifié" });
      const r: any = await pool.query("UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = ? AND email_verified = 0", [id]);
      if (!n(r?.affectedRows)) return reply.code(409).send({ ok: false, msg: "e-mail déjà vérifié" });
      await noter(pool, log, "info", qui(u) + " : e-mail validé à la main");
      // les liens de confirmation encore ouverts ne servent plus (accessoire : l'e-mail est validé quoi qu'il arrive ici)
      await pool.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [id]).catch(() => {});
      return reply.send({ ok: true, msg: "E-mail de " + (u.nom || "#" + u.id) + " validé à la main (aucun message envoyé)" });
    } catch (e: any) {
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  app.post("/admin/comptes/:id/supprimer", async (req: any, reply) => {
    const a = cle(req.headers["x-api-key"]);
    if (!a.ok) return reply.code(a.code).send({ ok: false, msg: a.msg });
    const j = requeteAdmise(req);
    if (!j.ok) return reply.code(j.code).send({ ok: false, msg: j.msg });
    const id = idDe(req);
    if (!id) return reply.code(400).send({ ok: false, msg: "identifiant de compte invalide" });
    const confirmation = String((req.body as any)?.confirmation ?? "").trim();
    try {
      const u = await compte(pool, id);
      if (!u) return reply.code(404).send({ ok: false, msg: "compte introuvable (déjà supprimé ?)" });
      // le pseudo exact, ou #id (toujours accepté : pseudo masqué, sur plusieurs lignes, caractères rares)
      const attendu = u.confirmation || "#" + u.id;
      if (confirmation !== attendu && confirmation !== "#" + u.id) {
        return reply.code(400).send({ ok: false, msg: "confirmation fausse : tape exactement « " + attendu + " »" + (u.confirmation ? " (ou #" + u.id + ")" : "") });
      }
      // l'API n'appelle jamais Stripe : un compte qui garde un identifiant d'abonnement Stripe (Premium, ou résilié dans
      // l'appli) peut encore être facturé ; la suppression est refusée, à régler d'abord dans Stripe
      if (u.stripe) {
        return reply.code(409).send({ ok: false, msg: "compte avec un abonnement Stripe : règle-le d'abord dans Stripe, la suppression ne l'arrête pas" });
      }
      // favoris, alertes, rappels, notifications, sessions, liens et visites partent avec lui (ON DELETE CASCADE)
      const r: any = await pool.query("DELETE FROM users WHERE id = ?", [id]);
      if (!n(r?.affectedRows)) return reply.code(404).send({ ok: false, msg: "compte introuvable (déjà supprimé ?)" });
      VISITES.delete(id);
      ENVOIS.delete(id);
      await noter(pool, log, "info", qui(u) + " : compte supprimé");
      return reply.send({ ok: true, msg: "Compte " + qui(u) + " supprimé" });
    } catch (e: any) {
      return reply.code(503).send({ ok: false, msg: raisonBase(e) });
    }
  });

  try {
    await tablePrete(pool);
  } catch (e: any) {
    log.warn({ module: "comptes", err: String(e?.message || e) }, "comptes : table des visites pas encore créée (nouvel essai à la prochaine lecture)");
  }
}
