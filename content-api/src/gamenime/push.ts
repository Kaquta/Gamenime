/**
 * push.ts — Notifications sur l'appareil (Web Push), maquette validée par Rey le 30 octobre 2026 (« Excellent »).
 *
 * Les mêmes notifications que la cloche, sur chaque appareil activé, même site fermé :
 *  - seulement les favoris (encore suivis au moment d'envoyer) : ni les alertes « genre + plateforme » (alert_*), ni les
 *    changements d'image (*_cover_added) ;
 *  - une seule notification par titre et par événement (une ligne de user_notifications, un envoi par appareil, noté
 *    avant l'envoi : jamais deux fois) ; un appui ouvre la fiche, comme la cloche (/anime/?n=<notification>#item-anime-<id> :
 *    une adresse par notification, la fiche se rouvre même si l'onglet y était déjà) ; le titre de la notification est
 *    celui du site (anglais s'il existe) ;
 *  - à toute heure, dans la minute (choix de Rey du 31 octobre 2026 : plus de pause entre 22 h et 8 h, chacun règle les
 *    notifications de son appareil) ; le service garde une notification jamais au-delà de ses 24 h (TTL) ; seulement ce
 *    qui a moins de 24 h, pas encore lu dans la cloche, arrivé après l'activation de l'appareil ;
 *  - une même étiquette (le titre et la sorte d'événement) : la plus récente seule, envoyée en dernier ; au-delà de 4
 *    d'un coup pour un appareil, les autres sont dites en une seule (« Et 3 autres nouveautés dans ta cloche » : toutes
 *    celles ainsi regroupées et pas encore lues ; elle remplace la précédente) ;
 *  - un appareil activé sur le staging (pour l'essai) ne reçoit rien tant que le même compte a le même appareil activé
 *    sur le site public (sinon tout arriverait deux fois) ;
 *  - un service en panne : nouvel essai plus tard (10 min, puis 20, 40… au plus 4 h) ; un appareil n'est oublié que si
 *    le service le dit désabonné (404, 410), avec son compte (supprimé : tout part avec lui), ou quand le mot de passe
 *    est réinitialisé (oublierAppareils, index.ts).
 * Le chiffrement (RFC 8291, aes128gcm) et la signature VAPID (RFC 8292, ES256) se font avec node:crypto, sans
 * dépendance ajoutée ; les clés VAPID sont créées au premier démarrage et gardées en base (push_cles), jamais
 * affichées. Seuls les services de notification des navigateurs sont appelés (Google, Mozilla, Apple, Microsoft) : une
 * adresse d'abonnement ailleurs est refusée, une redirection aussi.
 * Ligne du Pilotage « Notifications sur l'appareil » (push, toutes les minutes). Routes (compte connecté) :
 * GET /push/cle, POST /push/abonnement, POST /push/desabonnement, POST /push/etat, POST /push/essai.
 */
import type { FastifyInstance } from "fastify";
import { createCipheriv, createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { planifier } from "./pilotage.js";

// ─────────────────────────────────────────────────────────────── réglages

const MIN = 60 * 1000;
const H = 60 * MIN;
/** Ce qui a plus de 24 h ne part plus (l'heure de la cloche). */
const FRAIS_H = 24;
/** Au plus 4 notifications d'un coup par appareil ; les autres en une seule. */
export const MAX_PAR_APPAREIL = 4;
/** Au plus 10 appareils par compte (les plus anciens sont oubliés). */
const MAX_APPAREILS = 10;
/**
 * Un service en panne pour un appareil : nouvel essai après 10 min, puis 20, 40… au plus 4 h (gardé en base). Une panne
 * n'oublie jamais un appareil : seul le service peut le dire désabonné (404, 410).
 */
const REPOS_MIN_MS = 10 * MIN;
const REPOS_MAX_MS = 4 * H;
/** Les notifications en attente lues par appareil et par passage (les plus récentes ; les autres au passage suivant). */
const LOT_PAR_APPAREIL = 50;
const TTL_S = 24 * 3600;
/** En dessous de 60 s de TTL, rien ne part : le service n'aurait pas le temps de la livrer avant ses 24 h. */
const TTL_MIN_S = 60;
/** Les services de notification des navigateurs (adresses d'abonnement admises). */
const SERVICES = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

export interface PushDeps {
  pool: any;
  log: any;
  /** getAuthenticatedUser (index.ts) : le compte connecté, ou null. */
  utilisateur: (req: any) => Promise<{ id: number } | null>;
  /** fetch (essais : un faux service). */
  envoyer?: (url: string, init: any) => Promise<{ status: number; text?: () => Promise<string> }>;
  /** L'adresse du site pour le « sub » de VAPID. */
  site?: string;
}

const N = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const message = (e: unknown): string => String((e as any)?.message ?? e).split(/\r?\nsql:/)[0].replace(/^\(conn:[^)]*\)\s*/, "").slice(0, 200);
const b64u = (b: Buffer): string => b.toString("base64url");
const deB64u = (s: string): Buffer => Buffer.from(String(s || ""), "base64url");
const JOUR_PARIS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
/** Le jour à Paris : « 2026-10-31 ». */
export const jourParis = (t: number): string => JOUR_PARIS.format(new Date(t));

// ─────────────────────────────────────────────────────────────── chiffrement et VAPID

/** Le corps chiffré d'une notification (RFC 8291 + RFC 8188, aes128gcm, un seul bloc). */
export function chiffrer(clair: Buffer, p256dh: string, auth: string, ephemere?: { prive: Buffer }, sel?: Buffer): Buffer {
  const ua = deB64u(p256dh), secret = deB64u(auth);
  if (ua.length !== 65 || ua[0] !== 4 || secret.length !== 16) throw new Error("clés de l'abonnement invalides");
  const as = createECDH("prime256v1");
  if (ephemere) as.setPrivateKey(ephemere.prive);
  else as.generateKeys();
  const asPub = as.getPublicKey();
  const ecdh = as.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh, secret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32));
  const salt = sel ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const chiffre = Buffer.concat([c.update(Buffer.concat([clair, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, chiffre]);
}

interface Cles {
  publique: string;
  privee: KeyObject;
}
let CLES: Promise<Cles> | null = null;

/** Les clés VAPID : relues en base, ou créées une fois (jamais affichées). */
function cles(pool: any): Promise<Cles> {
  if (CLES) return CLES;
  const p = (async () => {
    await tables(pool);
    const lire = async () => (await pool.query("SELECT publique, privee FROM push_cles WHERE id = 1"))[0];
    let r = await lire();
    if (!r) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk: any = privateKey.export({ format: "jwk" });
      const pub = b64u(Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)]));
      // une seule fois, même avec deux démarrages en même temps : la première écrite reste
      await pool.query("INSERT IGNORE INTO push_cles (id, publique, privee, cree_le) VALUES (1, ?, ?, ?)", [pub, JSON.stringify(jwk), Date.now()]);
      r = await lire();
    }
    return { publique: String(r.publique), privee: createPrivateKey({ key: JSON.parse(String(r.privee)), format: "jwk" }) };
  })();
  CLES = p.catch((e) => {
    CLES = null;
    throw e;
  });
  return CLES;
}

const JWT = new Map<string, { t: string; fin: number }>();
/** L'en-tête Authorization de VAPID pour un service (jeton gardé 11 h, valable 12 h). */
export function vapid(aud: string, c: Cles, site: string, maintenant: number = Date.now()): string {
  const deja = JWT.get(aud);
  if (deja && deja.fin > maintenant + MIN) return `vapid t=${deja.t}, k=${c.publique}`;
  const exp = Math.floor(maintenant / 1000) + 12 * 3600;
  const b = (o: any) => b64u(Buffer.from(JSON.stringify(o)));
  const corps = `${b({ typ: "JWT", alg: "ES256" })}.${b({ aud, exp, sub: site })}`;
  const sig = sign("sha256", Buffer.from(corps), { key: c.privee, dsaEncoding: "ieee-p1363" });
  const t = `${corps}.${b64u(sig)}`;
  JWT.set(aud, { t, fin: maintenant + 11 * H });
  return `vapid t=${t}, k=${c.publique}`;
}

/** Une adresse d'abonnement admise : https, chez un service de notification connu. */
export function adresseAdmise(endpoint: unknown): URL | null {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
    return SERVICES.some((r) => r.test(u.hostname)) ? u : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── base

let TABLES: Promise<void> | null = null;
function tables(pool: any): Promise<void> {
  if (TABLES) return TABLES;
  const p = (async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS push_cles (id TINYINT UNSIGNED NOT NULL PRIMARY KEY, publique VARCHAR(120) NOT NULL, privee TEXT NOT NULL, cree_le BIGINT NOT NULL) " +
        "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    // un compte supprimé : ses appareils partent avec lui (et leurs envois avec eux), comme le dit la politique de
    // confidentialité
    await pool.query(
      "CREATE TABLE IF NOT EXISTS push_abonnements (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT(10) UNSIGNED NOT NULL, " +
        "endpoint TEXT NOT NULL, empreinte CHAR(64) NOT NULL, p256dh VARCHAR(140) NOT NULL, auth VARCHAR(40) NOT NULL, appareil VARCHAR(60) NULL, " +
        "origine VARCHAR(100) NULL, depuis BIGINT UNSIGNED NOT NULL DEFAULT 0, cree_le BIGINT NOT NULL, vu_le BIGINT NOT NULL, " +
        "echecs INT NOT NULL DEFAULT 0, repos_jusqua BIGINT NULL, UNIQUE KEY empreinte (empreinte), KEY user_id (user_id), " +
        "CONSTRAINT fk_push_abonnements_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE) " +
        "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS push_envois (abonnement_id INT UNSIGNED NOT NULL, notification_id BIGINT UNSIGNED NOT NULL, statut VARCHAR(12) NOT NULL, " +
        "code SMALLINT NULL, le BIGINT NOT NULL, PRIMARY KEY (abonnement_id, notification_id), KEY le (le), " +
        "CONSTRAINT fk_push_envois_abonnement FOREIGN KEY (abonnement_id) REFERENCES push_abonnements (id) ON DELETE CASCADE) " +
        "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
  })();
  TABLES = p.catch((e) => {
    TABLES = null;
    throw e;
  });
  return TABLES;
}
const empreinte = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex");
/** payload_json : déjà un objet (colonne JSON, le connecteur la lit), ou un texte. */
function lireJson(v: unknown): any {
  if (v && typeof v === "object" && !Buffer.isBuffer(v)) return v;
  try {
    const o = JSON.parse(String(v ?? ""));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────── les textes (maquette, planche 2)

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
// les noms des plateformes comme la maquette (« PC, PS5, Xbox Series X|S et Switch 2 ») ; la version précise d'une
// famille cache son nom générique, comme le site (fiche.ts)
const COURTS: Record<string, string> = {
  "playstation 5": "PS5", "playstation 4": "PS4", "playstation 3": "PS3", "nintendo switch 2": "Switch 2", "nintendo switch": "Switch",
  "pc (microsoft windows)": "PC", "apple macintosh": "Mac",
};
const FAMILLES_PLATEFORMES = [
  { generique: "playstation", precis: /^playstation \d/ },
  { generique: "xbox", precis: /^xbox (series|one)/ },
  { generique: "nintendo", precis: /^nintendo (switch|3ds|ds|wii)/ },
];
/** « Crunchyroll et Netflix », « PC, PS5, Xbox Series X|S et Switch 2 ». */
export function liste(p: unknown): string {
  const brut = (Array.isArray(p) ? p.map(String) : String(p ?? "").split(",")).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== "unknown");
  const bas = brut.map((x) => x.toLowerCase());
  const u: string[] = [];
  brut.forEach((x, i) => {
    const f = FAMILLES_PLATEFORMES.find((y) => y.generique === bas[i]);
    if (f && bas.some((y) => f.precis.test(y))) return;
    const l = COURTS[bas[i]] ?? x;
    if (!u.includes(l)) u.push(l);
  });
  return u.length <= 1 ? u.join("") : `${u.slice(0, -1).join(", ")} et ${u[u.length - 1]}`;
}
/** « le 23 octobre 2027 », « pour octobre 2027 », « courant 2027 » : après « prévu ». */
function prevu(libelle: string): string {
  const t = libelle.trim();
  if (/^courant /i.test(t)) return t;
  if (/^\d/.test(t)) return `le ${t}`;
  return `pour ${t}`;
}
const anParis = (t: number): number => Number(jourParis(t).slice(0, 4));
/** « le 23 octobre » (sans l'année si c'est cette année-ci, à Paris). */
function leJour(iso: unknown, maintenant: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return "";
  return `le ${Number(m[3])} ${MOIS[Number(m[2]) - 1]}` + (Number(m[1]) !== anParis(maintenant) ? ` ${m[1]}` : "");
}
const premiereMinuscule = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Le texte de la notification d'un événement de la cloche (null : pas sur l'appareil). */
export function texte(type: string, p: any, plateformesFiche: unknown, maintenant: number = Date.now()): string | null {
  const t = String(type || "");
  if (/^alert_/.test(t) || /cover_added$/.test(t)) return null;
  // les anciens compteurs d'épisodes de la description (index.ts) : remplacés par anime_episode_aired (suivi-favoris.ts)
  if (t === "anime_episode_added" || t === "anime_next_episode") return null;
  const nv = String(p?.newValue ?? "").trim();
  if (t === "anime_episode_aired") {
    const pl = liste(p?.platforms);
    return `Épisode ${N(p?.episode)} dispo` + (pl ? ` sur ${pl}` : "");
  }
  const rappel = /^reminder_j(\d+)$/.exec(t);
  if (rappel) {
    let n = Number(rappel[1]);
    // le jour de sortie compté au moment de l'envoi : un rappel parti le lendemain ne dit pas « aujourd'hui » ; déjà
    // sorti, il ne part plus
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(p?.releaseDate ?? ""));
    if (d) {
      n = Math.round((Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) - Date.parse(`${jourParis(maintenant)}T00:00:00Z`)) / 86400000);
      if (n < 0) return null;
    }
    const pl = liste(plateformesFiche);
    if (n === 0) return "Sort aujourd'hui" + (pl ? ` sur ${pl}` : "");
    if (n === 1) return "Sort demain" + (pl ? ` sur ${pl}` : "");
    const j = leJour(p?.releaseDate, maintenant);
    return `Sort dans ${n} jours` + (j ? `, ${j}` : "");
  }
  if (/_release_date_announced$/.test(t)) return nv ? `Date annoncée : prévu ${prevu(nv)}` : "Date annoncée";
  if (/_release_date_changed$/.test(t)) return nv || "La date a changé";
  if (/_trailer_added$/.test(t)) return "Nouvelle bande-annonce";
  if (/_platform_added$/.test(t)) return nv ? `Dispo sur ${liste(nv)}` : "Nouvelle plateforme";
  if (t === "anime_platform_cinema") {
    // « Au cinéma en France le 23 octobre » (l'année seulement si ce n'est pas celle-ci, comme la maquette)
    const sansAn = nv.replace(new RegExp(` ${anParis(maintenant)}$`), "");
    return nv ? `Au cinéma ${premiereMinuscule(sansAn)}` : "Au cinéma en France";
  }
  if (t === "anime_season_added") {
    const m = /^(WINTER|SPRING|SUMMER|FALL)\s+(\d{4})$/i.exec(nv);
    const saison: Record<string, string> = { WINTER: "hiver", SPRING: "printemps", SUMMER: "été", FALL: "automne" };
    return m ? `Nouvelle saison : ${saison[m[1].toUpperCase()]} ${m[2]}` : nv ? `Nouvelle saison : ${nv}` : "Nouvelle saison";
  }
  if (t === "game_dlc_announced") return nv ? `Nouveau DLC annoncé : ${nv}` : "Nouveau DLC annoncé";
  if (t === "game_dlc_released") return nv ? `DLC disponible : ${nv}` : "DLC disponible";
  const label = String(p?.label ?? "").trim();
  return label && nv ? `${label} : ${nv}` : label || nv || null;
}

// ─────────────────────────────────────────────────────────────── l'envoi

export interface Abonnement {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Issue = "envoye" | "expire" | "refuse" | "reessai";

/**
 * Envoie une notification à un appareil. « expire » : l'abonnement n'existe plus (404, 410) ; « reessai » : plus tard
 * (pas de réponse, 429, 5xx) ; « refuse » : une autre erreur. ttl : ce que le service la garde, en secondes.
 */
export async function pousser(deps: PushDeps, a: Abonnement, contenu: Record<string, any>, urgence: "normal" | "low" = "normal", ttl: number = TTL_S): Promise<{ issue: Issue; code: number }> {
  const u = adresseAdmise(a.endpoint);
  if (!u) return { issue: "refuse", code: 0 };
  const c = await cles(deps.pool);
  let corps = Buffer.from(JSON.stringify(contenu));
  // une notification tient dans 4 Ko chiffrée : le texte est coupé s'il le faut
  if (corps.length > 3000) corps = Buffer.from(JSON.stringify({ ...contenu, body: String(contenu.body || "").slice(0, 300) }));
  let chiffre: Buffer;
  try {
    chiffre = chiffrer(corps, a.p256dh, a.auth);
  } catch {
    // des clés d'abonnement inutilisables (vérifiées à l'enregistrement : ne devrait pas arriver)
    return { issue: "refuse", code: 0 };
  }
  const envoyer = deps.envoyer ?? ((url: string, init: any) => fetch(url, init));
  let r: { status: number };
  try {
    r = await envoyer(u.href, {
      method: "POST",
      // seuls les services de notification : une redirection ailleurs est refusée
      redirect: "error",
      headers: {
        TTL: String(Math.max(0, Math.floor(ttl))),
        Urgency: urgence,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: vapid(u.origin, c, deps.site || process.env.PUBLIC_SITE_URL || "https://gamenime.fr"),
      },
      body: chiffre,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { issue: "reessai", code: 0 };
  }
  const s = N(r.status);
  if (s >= 200 && s < 300) return { issue: "envoye", code: s };
  if (s === 404 || s === 410) return { issue: "expire", code: s };
  if (s === 429 || s >= 500) return { issue: "reessai", code: s };
  return { issue: "refuse", code: s };
}

// ─────────────────────────────────────────────────────────────── le passage (toutes les minutes)

// les appareils à servir : compte à la cloche allumée, pas au repos après une panne de leur service ; un appareil du
// staging se tait tant que le même compte a le même appareil (même libellé) sur le site public
const APPAREILS =
  "SELECT a.id, a.endpoint, a.p256dh, a.auth, a.echecs FROM push_abonnements a INNER JOIN users u ON u.id = a.user_id AND u.notifications_enabled = 1 " +
  "WHERE (a.repos_jusqua IS NULL OR a.repos_jusqua <= ?) " +
  "AND NOT (IFNULL(a.origine, '') LIKE '%staging.%' AND EXISTS (SELECT 1 FROM push_abonnements b WHERE b.user_id = a.user_id AND b.id <> a.id " +
  "AND b.appareil <=> a.appareil AND IFNULL(b.origine, '') NOT LIKE '%staging.%')) ORDER BY a.id";
// les notifications de la cloche à envoyer à un appareil : arrivées après son activation, de moins de 24 h, pas lues, pas
// encore envoyées à cet appareil, d'un titre toujours en favori ; ni alertes ni images
const JOINTURES =
  "FROM push_abonnements a " +
  "INNER JOIN user_notifications un ON un.user_id = a.user_id AND un.id > a.depuis AND un.is_read = 0 " +
  "AND un.created_at >= NOW() - INTERVAL " + FRAIS_H + " HOUR AND (un.deliver_at IS NULL OR un.deliver_at <= NOW()) " +
  "INNER JOIN notification_events ne ON ne.id = un.event_id AND ne.event_type NOT LIKE 'alert\\_%' AND ne.event_type NOT LIKE '%cover\\_added' " +
  "LEFT JOIN push_envois pe ON pe.abonnement_id = a.id AND pe.notification_id = un.id ";
const CONDITIONS =
  "WHERE a.id = ? AND pe.notification_id IS NULL " +
  // le type comparé à un texte, pas à l'autre colonne : favorites et notification_events n'ont pas forcément le même
  // interclassement (« Illegal mix of collations »)
  "AND EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = a.user_id AND f.item_type = IF(ne.item_type = 'game', 'game', 'anime') AND f.item_id = ne.item_id) ";
// les plus récentes d'abord, un lot par appareil
const EN_ATTENTE =
  "SELECT un.id AS nid, TIMESTAMPDIFF(SECOND, un.created_at, NOW()) AS age, ne.item_type AS t, ne.item_id AS iid, ne.event_type AS type, " +
  "ne.payload_json AS payload, COALESCE(NULLIF(TRIM(ai.title_english), ''), ai.title, NULLIF(TRIM(gi.title_english), ''), gi.title) AS titre, " +
  "COALESCE(ai.platform, gi.platform) AS plateformes " +
  JOINTURES +
  "LEFT JOIN anime_items ai ON ne.item_type = 'anime' AND ai.id = ne.item_id " +
  "LEFT JOIN game_items gi ON ne.item_type = 'game' AND gi.id = ne.item_id " +
  CONDITIONS +
  "ORDER BY un.id DESC LIMIT " + LOT_PAR_APPAREIL;
// celles d'avant le lot (plus de 50 en attente) : dites dans le regroupement (?, l'appareil ; ?, la plus ancienne du lot)
const AVANT_LE_LOT =
  "SELECT un.id AS nid, TIMESTAMPDIFF(SECOND, un.created_at, NOW()) AS age, ne.item_type AS t, ne.item_id AS iid, ne.event_type AS type, ne.payload_json AS payload " +
  JOINTURES + CONDITIONS + "AND un.id < ? ORDER BY un.id DESC LIMIT 1000";
// celles déjà dites dans un regroupement et pas encore lues : comptées dans le suivant, qui le remplace
const DEJA_REGROUPEES =
  "SELECT COUNT(*) AS n FROM push_envois pe INNER JOIN user_notifications un ON un.id = pe.notification_id AND un.is_read = 0 " +
  "AND un.created_at >= NOW() - INTERVAL " + FRAIS_H + " HOUR WHERE pe.abonnement_id = ? AND pe.statut = 'groupe'";

/**
 * La famille d'un événement : une notification de la même famille et du même titre remplace la précédente (Épisode 6
 * après 5, « Reporté » après « Date annoncée »). Le cinéma a la sienne ; deux DLC différents, deux familles.
 */
function famille(type: string, p: any): string {
  if (/cinema/.test(type)) return "cinema";
  const m = /(episode|release_date|trailer|platform|dlc|reminder)/.exec(type);
  if (!m) return "autre";
  if (m[1] === "dlc") return `dlc-${createHash("sha256").update(String(p?.newValue ?? "")).digest("hex").slice(0, 8)}`;
  return m[1];
}

/** Ce que reçoit le service worker : titre (celui du site), texte, fiche à ouvrir (comme la cloche), étiquette, icône. */
export function contenu(type: string, itemType: string, itemId: number, titre: unknown, payload: any, plateformes: unknown, maintenant: number = Date.now(), nid: number = 0): Record<string, any> | null {
  const corps = texte(type, payload, plateformes, maintenant);
  if (!corps) return null;
  const jeu = itemType === "game";
  const id = Math.trunc(N(itemId));
  return {
    title: String(titre || payload?.title || "GameNime"),
    body: corps,
    // la fiche par la page de sa catégorie, comme la cloche et les e-mails : toute fiche s'ouvre, même sans page à elle ;
    // une adresse par notification (?n=) : la fiche se rouvre même si l'onglet est resté sur la précédente
    url: id > 0 ? `/${jeu ? "games" : "anime"}/${nid > 0 ? `?n=${Math.trunc(nid)}` : ""}#item-${jeu ? "game" : "anime"}-${id}` : "/",
    tag: `gn-${jeu ? "game" : "anime"}-${id}-${famille(type, payload)}`,
    icon: "/favicon-192.png?v=4",
  };
}

/** Le repos d'un appareil après sa n-ième panne de suite : 10 min, 20, 40… au plus 4 h. */
export const reposApres = (echecs: number): number => Math.min(REPOS_MIN_MS * 2 ** Math.max(0, Math.min(10, echecs - 1)), REPOS_MAX_MS);

/** Un appareil : ses notifications en attente, une par étiquette, 4 au plus d'un coup, le reste en une seule. */
async function servir(deps: PushDeps, ap: any, noter: (aid: number, nids: number[], statut: string, code: number) => Promise<any>, bilan: Record<string, any>, maintenant: number, ici: () => number): Promise<void> {
  const pool = deps.pool;
  const aid = N(ap.id);
  const ls: any[] = await pool.query(EN_ATTENTE, [aid]);
  if (!ls.length) return;
  const a: Abonnement = { id: aid, endpoint: String(ap.endpoint), p256dh: String(ap.p256dh), auth: String(ap.auth) };
  // une notification par étiquette : la plus récente (les autres sont remplacées : l'appareil n'en montrerait qu'une)
  const vues = new Set<string>();
  const uniques: Array<{ nid: number; age: number; c: Record<string, any> }> = [];
  const ignorees: number[] = [], remplacees: number[] = [];
  for (const l of ls) {
    const c = contenu(String(l.type), String(l.t), N(l.iid), l.titre, lireJson(l.payload), l.plateformes, ici(), N(l.nid));
    if (!c) {
      ignorees.push(N(l.nid));
      continue;
    }
    if (vues.has(c.tag)) {
      remplacees.push(N(l.nid));
      continue;
    }
    vues.add(c.tag);
    uniques.push({ nid: N(l.nid), age: N(l.age), c });
  }
  await noter(aid, ignorees, "ignore", 0);
  await noter(aid, remplacees, "remplace", 0);
  bilan.remplaces += remplacees.length;
  // plus de 50 en attente : les plus anciennes, au-delà du lot, sont remplacées si une plus récente a la même étiquette,
  // sinon dites dans le regroupement
  const anciennes: Array<{ nid: number; age: number }> = [];
  if (ls.length >= LOT_PAR_APPAREIL) {
    const vieilles: any[] = await pool.query(AVANT_LE_LOT, [aid, Math.min(...ls.map((l) => N(l.nid)))]);
    const ign: number[] = [], rem: number[] = [];
    for (const l of vieilles) {
      const c = contenu(String(l.type), String(l.t), N(l.iid), null, lireJson(l.payload), null, ici(), N(l.nid));
      if (!c) ign.push(N(l.nid));
      else if (vues.has(c.tag)) rem.push(N(l.nid));
      else {
        vues.add(c.tag);
        anciennes.push({ nid: N(l.nid), age: N(l.age) });
      }
    }
    await noter(aid, ign, "ignore", 0);
    await noter(aid, rem, "remplace", 0);
    bilan.remplaces += rem.length;
  }
  if (!uniques.length && !anciennes.length) return;
  bilan.appareils++;
  // les 4 plus récentes une par une ; le reste en une seule, envoyée d'abord (les plus récentes s'affichent au-dessus)
  const seules = uniques.slice(0, MAX_PAR_APPAREIL).reverse();
  const reste = [...uniques.slice(MAX_PAR_APPAREIL), ...anciennes];
  const envois: Array<{ nids: number[]; age: number; c: Record<string, any>; groupe: boolean }> = [];
  if (reste.length) {
    // le compte : celles de ce regroupement et celles des précédents pas encore lues (celui-ci les remplace)
    const deja = N((await pool.query(DEJA_REGROUPEES, [aid]))[0]?.n);
    const n = reste.length + deja;
    envois.push({
      nids: reste.map((x) => x.nid),
      // gardé tant que la plus récente du regroupement a moins de 24 h
      age: Math.min(...reste.map((x) => x.age)),
      c: { title: "GameNime", body: `Et ${n} autre${n > 1 ? "s" : ""} nouveauté${n > 1 ? "s" : ""} dans ta cloche`, url: "/", tag: "gn-reste", icon: "/favicon-192.png?v=4" },
      groupe: true,
    });
  }
  for (const x of seules) envois.push({ nids: [x.nid], age: x.age, c: x.c, groupe: false });
  for (const e of envois) {
    // gardée par le service jusqu'à ses 24 h au plus
    const ttl = TTL_S - e.age;
    if (ttl < TTL_MIN_S) continue;
    // noté avant l'envoi : une panne de l'API pendant l'envoi ne le refait pas
    await noter(aid, e.nids, "envoi", 0);
    const r = await pousser(deps, a, e.c, "normal", ttl);
    if (r.issue === "reessai") {
      // rien n'est parti : repris plus tard, l'appareil au repos (il n'est jamais oublié pour une panne)
      await pool.query(`DELETE FROM push_envois WHERE abonnement_id = ? AND notification_id IN (${e.nids.map(() => "?").join(", ")}) AND statut = 'envoi'`, [aid, ...e.nids]);
      const echecs = N(ap.echecs) + 1;
      await pool.query("UPDATE push_abonnements SET echecs = ?, repos_jusqua = ? WHERE id = ?", [echecs, maintenant + reposApres(echecs), aid]);
      bilan.reessais++;
      return;
    }
    if (r.issue === "expire") {
      // l'appareil s'est désabonné (ou a changé d'adresse) : oublié, ses envois avec lui
      await pool.query("DELETE FROM push_abonnements WHERE id = ?", [aid]);
      bilan.expires++;
      return;
    }
    await noter(aid, e.nids, r.issue === "envoye" && e.groupe ? "groupe" : r.issue, r.code);
    if (r.issue === "envoye") {
      bilan.envoyes += e.nids.length;
      if (e.groupe) bilan.regroupes += e.nids.length;
      await pool.query("UPDATE push_abonnements SET echecs = 0, repos_jusqua = NULL, vu_le = ? WHERE id = ?", [maintenant, aid]);
    } else bilan.refuses++;
  }
}

export async function passagePush(deps: PushDeps, maintenant: number = Date.now()): Promise<Record<string, any> | null> {
  const pool = deps.pool;
  await tables(pool);
  // l'heure du passage, et celle de chaque envoi (les jours qui restent avant une sortie sont comptés au moment d'envoyer)
  const debut = Date.now();
  const ici = (): number => maintenant + (Date.now() - debut);
  const appareils: any[] = await pool.query(APPAREILS, [maintenant]);
  if (!appareils.length) return null;
  // les clés d'abord : sans elles rien n'est noté « en cours » (une panne ici est l'erreur du passage)
  await cles(pool);
  const bilan: Record<string, any> = { envoyes: 0, appareils: 0, expires: 0, refuses: 0, reessais: 0, regroupes: 0, remplaces: 0, erreurs: 0 };
  const noter = (aid: number, nids: number[], statut: string, code: number) =>
    nids.length
      ? pool.query(
          // IGNORE : l'appareil effacé entre-temps (déconnexion, autre compte) n'est pas une erreur
          `INSERT IGNORE INTO push_envois (abonnement_id, notification_id, statut, code, le) VALUES ${nids.map(() => "(?, ?, ?, ?, ?)").join(", ")} ` +
            "ON DUPLICATE KEY UPDATE statut = VALUES(statut), code = VALUES(code), le = VALUES(le)",
          nids.flatMap((nid) => [aid, nid, statut, code || null, maintenant]),
        )
      : Promise.resolve();
  for (const ap of appareils) {
    try {
      await servir(deps, ap, noter, bilan, maintenant, ici);
    } catch (e) {
      // une erreur pour un appareil n'empêche pas les autres d'être servis
      bilan.erreurs++;
      deps.log.warn({ module: "push", err: message(e) }, "push : un appareil en erreur, les autres continuent");
    }
  }
  await pool.query("DELETE FROM push_envois WHERE le < ?", [maintenant - 30 * 24 * H]);
  return bilan.envoyes + bilan.expires + bilan.refuses + bilan.reessais + bilan.erreurs > 0 ? bilan : null;
}

/**
 * Les appareils d'un compte, oubliés (mot de passe réinitialisé : un tiers qui avait le compte n'y reçoit plus rien).
 * Ne lève jamais d'erreur : la route qui l'appelle continue quoi qu'il arrive.
 */
export async function oublierAppareils(pool: any, userId: number): Promise<void> {
  try {
    await pool.query("DELETE FROM push_abonnements WHERE user_id = ?", [Math.trunc(N(userId))]);
  } catch {
    // table pas encore créée, base indisponible : rien à oublier, ou repris à la prochaine réinitialisation
  }
}

// ─────────────────────────────────────────────────────────────── les routes (compte connecté)

/** « Android · Chrome », « iPhone · Safari », « Windows · Edge » : pour reconnaître ses appareils (rien d'autre). */
export function appareilDe(ua: unknown): string {
  const s = String(ua ?? "");
  const sys = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : "Appareil";
  const nav = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return nav ? `${sys} · ${nav}` : sys;
}

const DERNIER_ESSAI = new Map<number, number>();

export function registerPush(app: FastifyInstance, deps: PushDeps): void {
  DEPS = deps;
  const pool = deps.pool;
  const corpsObjet = (req: any): Record<string, any> | null => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null);
  const lireAbonnement = (b: Record<string, any> | null) => {
    const u = adresseAdmise(b?.endpoint);
    const k = b?.keys && typeof b.keys === "object" ? b.keys : {};
    const p256dh = typeof k.p256dh === "string" ? k.p256dh : "", auth = typeof k.auth === "string" ? k.auth : "";
    const okCles = (() => {
      try {
        const a = deB64u(p256dh), s = deB64u(auth);
        if (!(a.length === 65 && a[0] === 4 && s.length === 16 && p256dh.length <= 140 && auth.length <= 40)) return false;
        // un point de la courbe P-256 (sinon aucun envoi ne pourrait être chiffré)
        const e = createECDH("prime256v1");
        e.generateKeys();
        e.computeSecret(a);
        return true;
      } catch {
        return false;
      }
    })();
    return u && okCles ? { endpoint: u.href, p256dh, auth } : null;
  };

  // la clé publique de VAPID (pour s'abonner dans le navigateur)
  app.get("/push/cle", async (req: any, reply: any) => {
    try {
      const c = await cles(pool);
      reply.header("Cache-Control", "no-store");
      return reply.send({ ok: true, cle: c.publique });
    } catch (e) {
      req.log.warn({ module: "push", err: message(e) }, "push : clé indisponible");
      return reply.code(503).send({ ok: false, error: "Indisponible" });
    }
  });

  // l'adresse du site d'où vient la demande (le staging ou le site public) : « staging.gamenime.fr »
  const origineDe = (req: any): string | null => {
    for (const v of [req.headers?.origin, req.headers?.referer]) {
      try {
        if (typeof v === "string" && v) return new URL(v).hostname.toLowerCase().slice(0, 100);
      } catch {}
    }
    return null;
  };

  // cet appareil s'abonne (ou se réabonne) pour le compte connecté
  app.post("/push/abonnement", async (req: any, reply: any) => {
    try {
      const user = await deps.utilisateur(req);
      if (!user) return reply.code(401).send({ ok: false, error: "Non authentifié" });
      const ab = lireAbonnement(corpsObjet(req));
      if (!ab) return reply.code(400).send({ ok: false, error: "Abonnement invalide" });
      await tables(pool);
      const maintenant = Date.now();
      const e = empreinte(ab.endpoint);
      // seulement ce qui arrive à partir de maintenant : la dernière notification de la cloche sert de repère
      const m: any[] = await pool.query("SELECT IFNULL(MAX(id), 0) AS m FROM user_notifications");
      const depuis = N(m[0]?.m);
      const appareil = appareilDe(req.headers["user-agent"]).slice(0, 60);
      const origine = origineDe(req);
      const enregistrer = async (): Promise<void> => {
        const deja: any[] = await pool.query("SELECT id, user_id FROM push_abonnements WHERE empreinte = ?", [e]);
        if (deja.length && N(deja[0].user_id) === N(user.id)) {
          // le même appareil, le même compte : les clés peuvent avoir changé, le repère reste
          await pool.query("UPDATE push_abonnements SET p256dh = ?, auth = ?, appareil = ?, origine = ?, vu_le = ?, echecs = 0, repos_jusqua = NULL WHERE id = ?", [ab.p256dh, ab.auth, appareil, origine, maintenant, deja[0].id]);
          return;
        }
        // un autre compte sur cet appareil : il ne reçoit plus celles de l'ancien (ses envois partent avec)
        if (deja.length) await pool.query("DELETE FROM push_abonnements WHERE id = ?", [deja[0].id]);
        await pool.query(
          "INSERT INTO push_abonnements (user_id, endpoint, empreinte, p256dh, auth, appareil, origine, depuis, cree_le, vu_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [user.id, ab.endpoint, e, ab.p256dh, ab.auth, appareil, origine, depuis, maintenant, maintenant],
        );
      };
      try {
        await enregistrer();
      } catch (x) {
        // deux demandes en même temps pour le même appareil : la seconde reprend celle qui vient d'être écrite
        if ((x as any)?.errno !== 1062) throw x;
        await enregistrer();
      }
      // au plus 10 appareils par compte : les plus anciens sont oubliés
      const trop: any[] = await pool.query("SELECT id FROM push_abonnements WHERE user_id = ? ORDER BY vu_le DESC, id DESC LIMIT 1000 OFFSET " + MAX_APPAREILS, [user.id]);
      for (const t of trop) await pool.query("DELETE FROM push_abonnements WHERE id = ?", [t.id]);
      return reply.send({ ok: true, actif: true });
    } catch (e) {
      req.log.warn({ module: "push", err: message(e) }, "push : abonnement refusé par la base");
      return reply.code(500).send({ ok: false, error: "Erreur serveur" });
    }
  });

  // cet appareil se désabonne
  app.post("/push/desabonnement", async (req: any, reply: any) => {
    try {
      const user = await deps.utilisateur(req);
      if (!user) return reply.code(401).send({ ok: false, error: "Non authentifié" });
      const u = adresseAdmise(corpsObjet(req)?.endpoint);
      if (!u) return reply.code(400).send({ ok: false, error: "Abonnement invalide" });
      await tables(pool);
      // seulement l'abonnement de ce compte (ses envois partent avec lui) ; « retire » : il y en avait un
      const r: any = await pool.query("DELETE FROM push_abonnements WHERE empreinte = ? AND user_id = ?", [empreinte(u.href), user.id]);
      return reply.send({ ok: true, actif: false, retire: N(r?.affectedRows) });
    } catch (e) {
      req.log.warn({ module: "push", err: message(e) }, "push : désabonnement refusé par la base");
      return reply.code(500).send({ ok: false, error: "Erreur serveur" });
    }
  });

  // cet appareil est-il abonné pour ce compte ? (l'adresse reste dans le corps : jamais dans les journaux)
  app.post("/push/etat", async (req: any, reply: any) => {
    try {
      const user = await deps.utilisateur(req);
      if (!user) return reply.code(401).send({ ok: false, error: "Non authentifié" });
      const u = adresseAdmise(corpsObjet(req)?.endpoint);
      if (!u) return reply.send({ ok: true, actif: false });
      await tables(pool);
      const r: any[] = await pool.query("SELECT id FROM push_abonnements WHERE empreinte = ? AND user_id = ?", [empreinte(u.href), user.id]);
      return reply.send({ ok: true, actif: r.length > 0 });
    } catch (e) {
      req.log.warn({ module: "push", err: message(e) }, "push : état illisible");
      return reply.code(500).send({ ok: false, error: "Erreur serveur" });
    }
  });

  // « Envoyer une notification d'essai » : à cet appareil seulement, une fois toutes les 20 s au plus
  app.post("/push/essai", async (req: any, reply: any) => {
    try {
      const user = await deps.utilisateur(req);
      if (!user) return reply.code(401).send({ ok: false, error: "Non authentifié" });
      const u = adresseAdmise(corpsObjet(req)?.endpoint);
      if (!u) return reply.code(400).send({ ok: false, error: "Abonnement invalide" });
      const maintenant = Date.now();
      if ((DERNIER_ESSAI.get(N(user.id)) ?? 0) > maintenant - 20000) return reply.code(429).send({ ok: false, error: "Attends quelques secondes" });
      DERNIER_ESSAI.set(N(user.id), maintenant);
      await tables(pool);
      const r: any[] = await pool.query("SELECT id, endpoint, p256dh, auth FROM push_abonnements WHERE empreinte = ? AND user_id = ?", [empreinte(u.href), user.id]);
      if (!r.length) return reply.code(404).send({ ok: false, error: "Cet appareil n'est pas activé" });
      const a: Abonnement = { id: N(r[0].id), endpoint: String(r[0].endpoint), p256dh: String(r[0].p256dh), auth: String(r[0].auth) };
      const res = await pousser(deps, a, { title: "GameNime", body: "Notification d’essai : c’est bien activé sur cet appareil.", url: "/account/preferences/", tag: "gn-essai", icon: "/favicon-192.png?v=4" }, "normal", 300);
      if (res.issue === "expire") {
        await pool.query("DELETE FROM push_envois WHERE abonnement_id = ?", [a.id]);
        await pool.query("DELETE FROM push_abonnements WHERE id = ?", [a.id]);
      }
      req.log.info({ module: "push", issue: res.issue, code: res.code }, "push : notification d'essai");
      return reply.send({ ok: res.issue === "envoye", issue: res.issue });
    } catch (e) {
      req.log.warn({ module: "push", err: message(e) }, "push : essai en erreur");
      return reply.code(500).send({ ok: false, error: "Erreur serveur" });
    }
  });
}

let DEPS: PushDeps | null = null;

/** Ce que montre la ligne du Pilotage : appareils activés, envois du jour. */
async function chiffres(pool: any): Promise<Record<string, any>> {
  await tables(pool);
  const a: any[] = await pool.query("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS c, SUM(repos_jusqua > ?) AS r FROM push_abonnements", [Date.now()]);
  const e: any[] = await pool.query("SELECT statut, COUNT(*) AS n FROM push_envois WHERE le >= ? GROUP BY statut", [Date.now() - 24 * H]);
  const j: Record<string, number> = {};
  for (const x of e) j[String(x.statut)] = N(x.n);
  return { appareils: N(a[0]?.n), comptes: N(a[0]?.c), auRepos: N(a[0]?.r), jour: j };
}

/** La ligne du Pilotage « Notifications sur l'appareil » (après l'écoute de l'API). */
export function startPush(): void {
  const deps = DEPS;
  if (!deps) throw new Error("registerPush d'abord");
  // les clés VAPID dès le démarrage (créées une fois)
  void cles(deps.pool).catch((e) => deps.log.warn({ module: "push", err: message(e) }, "push : clés pas encore prêtes (nouvel essai au prochain passage)"));
  planifier({
    id: "push", premierMs: 2 * MIN, rythmeMs: MIN, actifParDefaut: true,
    infos: () => chiffres(deps.pool),
    passage: async () => {
      const b = await passagePush(deps);
      if (!b) return { rien: true };
      deps.log.info({ module: "push", ...b }, "notifications sur l'appareil : envoyées");
      return { bilan: b };
    },
  });
}
