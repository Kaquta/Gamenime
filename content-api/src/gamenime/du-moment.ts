/**
 * du-moment.ts — Le Top 25 « du moment » (16 octobre 2026).
 *
 * Demande de Rey (16 octobre) : « je veux le TOP 25 du moment genre le plus populaires actuellement », « en Live pas
 * par rapport au site ». Le classement d'avant (core.ts, computeGameNimeScore) repose sur la popularité CUMULÉE : un
 * titre sorti en janvier et terminé depuis restait en tête.
 *
 * Décisions de Rey après le relevé releve-top25.sh (16 octobre, 23 h 40) :
 *  - animés : l'activité AniList des 7 derniers jours complets (MediaTrend.trending : épisodes vus, ajouts aux listes,
 *    notes) ; valeur = 200 × log10(1 + activité), l'échelle de la popularité d'avant ;
 *  - jeux : la moyenne de trois mesures, chacune ramenée à sa médiane chez nos jeux (log10(1 + mesure / médiane)) :
 *      · les spectateurs Twitch (Helix) et les joueurs Steam, relevés par ce module toutes les heures et moyennés sur
 *        24 h (la mesure « heures regardées » d'IGDB valait 0 pour EA Sports FC 27 ou WARDOGS, parmi les plus regardés,
 *        et une seule photo dépend de l'heure) ;
 *      · les visites des fiches IGDB ;
 *    valeur = 200 × moyenne. Seuls les jeux rattachés à IGDB sont classés (Steam seul ne départage pas un jeu PC d'un
 *    jeu console) ;
 *  - au tri, le bonus Europe s'ajoute à la valeur, comme au classement d'avant ;
 *  - le titre « Top 25 » ne change pas ; le bandeau « à la une » des pages Animés et Jeux suit ce classement.
 *
 * Où il sert : /feed/anime et /feed/games avec status=released, triés par score (routes.ts → trierDuMoment) : le
 * Top 25 de l'accueil et le bandeau des pages Animés et Jeux. Les titres mesurés d'abord (valeur + bonus Europe), puis
 * ceux sans mesure (tout neufs, sans identifiant) dans l'ordre d'avant. Le Top 150, les badges, l'accueil mélangé, la
 * recherche et les autres listes gardent le classement d'avant. Retour au classement d'avant pour tout le Top quand le
 * module est coupé ou que ses mesures datent (animés : plus de 24 h ; jeux : plus de 12 h) : jamais de Top figé.
 *
 * Passages (un verrou de la base par domaine : un seul à la fois, y compris celui de l'installateur) :
 *  - animés : 40 min après le démarrage, puis toutes les 3 h ; mesurés : tous les animés de l'année déjà sortis avec
 *    un identifiant AniList (un peu plus que ceux que montre routes.ts : un changement de ses règles ne laisse jamais
 *    un titre montré sans mesure). Une requête toutes les 3 s, lots de 20 (moins si AniList trouve la requête trop
 *    lourde), jamais entre h:56 et h:04 (n8n interroge AniList : la requête attend h:04) ; une erreur : le lot est
 *    relancé une fois 10 s plus tard ; un refus 429 : l'attente demandée (90 s au plus, sinon arrêt), deux fois au
 *    plus. Moins de 80 % des animés lus : rien n'est écrit, nouvel essai 1 h plus tard ; un passage arrêté en route
 *    garde, pour les animés qu'il n'a pas lus, leur valeur d'avant (24 h au plus) ;
 *  - jeux : 15 min après le démarrage, puis toutes les heures : catégories Twitch retrouvées par l'identifiant IGDB
 *    (revues chaque semaine ; celles que Twitch n'a pas encore, à chaque passage) ; spectateurs en direct (les
 *    diffusions suivies par 2 personnes ou plus ; un lot de catégories qui dépasse 2 500 diffusions est relu catégorie
 *    par catégorie) ; un jeu sans catégorie Twitch compte 0 spectateur, comme au relevé ; joueurs Steam des pages
 *    confirmées de jeux_steam (une requête toutes les 0,6 s ; arrêt sur 429 ou 403, 3 erreurs de suite ou 20 min) ;
 *    visites IGDB toutes les 6 h (un lot de 20 jeux ou plus couvert à moins de la moitié : relancé une fois, sinon les
 *    visites d'avant restent) ; puis le calcul sur les relevés des dernières 24 h. Relevés gardés 3 jours.
 *    Un relevé raté (ni Twitch ni la moitié de Steam), ou ni spectateurs Twitch ni visites IGDB (Steam seul ne voit que
 *    le PC ; c'est le cas sans jeton Twitch, et Steam n'est alors pas lu) : pas de calcul cette heure-là, le
 *    classement d'avant reste.
 *
 * Tables : moment_mesures (valeur par titre, écrites d'un bloc : une transaction), moment_releves (relevés horaires des
 * jeux), moment_visites, jeux_twitch. Toutes les dates en UTC. Rien d'autre n'est écrit (ni les fiches, ni updated_at).
 * Interrupteur : DU_MOMENT_ENABLED « 0 » (le Top reprend le classement d'avant). ANILIST_URL : seulement pour les essais.
 */
import { clearTimeout, setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { interrupteur, planifier, type RetourPassage } from "./pilotage.js";
import { sortForGameNimeTop, type GameNimeItem, type ScoredItem } from "./core.js";
import { getTwitchToken, igdbFetch, invalidateTwitchToken } from "./twitch.js";
import type { Journal, SqlPool } from "./presse.js";

// ─────────────────────────────────────────────────────────────── réglages
const HEURE = 60 * 60 * 1000;
const PREMIER_JEUX_MS = 15 * 60 * 1000;
const PREMIER_ANIMES_MS = 40 * 60 * 1000;
const PASSAGE_ANIMES_MS = 3 * HEURE;
const RELANCE_ANIMES_MS = HEURE;
const RECHARGE_MS = 60 * 1000;
const PERIME_MS: Record<Domaine, number> = { anime: 24 * HEURE, game: 12 * HEURE };
/** Un animé non lu (passage arrêté en route) garde sa valeur d'avant au plus ce temps. */
const GARDE_MS = 24 * HEURE;
const VERROU: Record<Domaine, string> = { anime: "gamenime_du_moment_animes", game: "gamenime_du_moment_jeux" };
const JOUR_S = 86400;
const COUVERTURE_ANIMES = 0.8;
const LOT_SUSPECT = 20;
const VISITES_MS = 6 * HEURE;
const VISITES_VALIDES_MS = 48 * HEURE;
const CATEGORIES_JOURS = 7;
const RELEVES_JOURS = 3;
const UA = "GameNime/1.0 (https://gamenime.fr)";

export type Domaine = "anime" | "game";

interface Connexion {
  query: (sql: string, params?: unknown[]) => Promise<any>;
  release: () => unknown;
  destroy?: () => unknown;
}
export interface DuMomentDeps {
  /** Le pool mariadb de l'API ; getConnection sert au verrou (sans elle, pas de verrou). */
  pool: SqlPool & { getConnection?: () => Promise<Connexion> };
  log: Journal;
  /** Vide le cache des flux de l'API après un calcul. */
  rafraichir?: () => void;
}
export interface DuMomentConfig {
  anilist: string;
  helix: string;
  steam: string;
  igdb: string;
  pauseAniListMs: number;
  pauseHelixMs: number;
  pauseSteamMs: number;
  pauseIgdbMs: number;
  /** Attente après un 429 d'AniList sans Retry-After ; attente demandée acceptée au plus (au-delà : arrêt). */
  attente429Ms: number;
  attenteMaxMs: number;
  /** Attente avant de relancer un lot d'AniList en erreur. */
  pauseRepriseMs: number;
  /** Pas de requête AniList entre h:56 et h:04 (n8n). */
  eviterN8n: boolean;
  lotAniList: number;
  lotIgdb: number;
  /** Pages de 100 diffusions lues au plus par lot de catégories (au-delà : catégorie par catégorie). */
  pagesHelix: number;
  /** Durée maximale de la lecture de Steam. */
  steamMaxMs: number;
}

export function duMomentActif(env: Record<string, string | undefined> = process.env): boolean {
  return env["DU_MOMENT_ENABLED"] !== "0";
}

/** Le Top du moment d'un domaine est-il allumé ? L'interrupteur du Pilotage (pilotage.ts), sinon DU_MOMENT_ENABLED. */
function classementActif(domaine: Domaine): boolean {
  const p = interrupteur(domaine === "anime" ? "moment-animes" : "moment-jeux");
  return p === null ? duMomentActif() : p;
}

export function configDuMoment(env: Record<string, string | undefined> = process.env): DuMomentConfig {
  const rapide = env["DU_MOMENT_ESSAI_RAPIDE"] === "1"; // essais seulement : attentes de 10 ms
  const p = (ms: number) => (rapide ? Math.min(ms, 10) : ms);
  return {
    anilist: env["ANILIST_URL"] || "https://graphql.anilist.co",
    helix: "https://api.twitch.tv/helix",
    steam: "https://api.steampowered.com",
    igdb: "https://api.igdb.com/v4",
    pauseAniListMs: p(3000),
    pauseHelixMs: p(150),
    pauseSteamMs: p(600),
    pauseIgdbMs: p(300),
    attente429Ms: p(60000),
    attenteMaxMs: 90000,
    pauseRepriseMs: p(10000),
    eviterN8n: !rapide,
    lotAniList: 20,
    lotIgdb: 100,
    pagesHelix: 25,
    steamMaxMs: 20 * 60 * 1000,
  };
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Date UTC « AAAA-MM-JJ HH:MM:SS » pour une colonne DATETIME (tout est en UTC dans ce module). */
const sqlDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** Date d'une colonne lue par DATE_FORMAT(…, '%Y-%m-%d %H:%i:%s'), en millisecondes UTC. */
const msDe = (s: unknown): number => {
  const t = Date.parse(String(s ?? "").replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : 0;
};
const court = (e: unknown, n = 160) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, n);
/** Erreur de la base, sans la requête ni ses valeurs. */
const erreurBase = (e: unknown) => {
  const err = e as { code?: string; text?: string; message?: string };
  return (err.text ? (err.code ? err.code + " : " : "") + err.text : String(err.message ?? e)).slice(0, 160);
};
function mediane(valeurs: number[]): number | null {
  const s = valeurs.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : null;
}
/** Attente avant une requête AniList : jusqu'à h:04 entre h:56 et h:04 (n8n interroge AniList vers h:00), sinon 0. */
export function attenteN8n(d: Date): number {
  const mn = d.getUTCMinutes();
  if (mn >= 4 && mn < 56) return 0;
  const fin = new Date(d.getTime());
  if (mn >= 56) fin.setUTCHours(d.getUTCHours() + 1, 4, 0, 0);
  else fin.setUTCMinutes(4, 0, 0);
  return fin.getTime() - d.getTime();
}

// ─────────────────────────────────────────────────────────────── tables et verrou
const TABLES = [
  "CREATE TABLE IF NOT EXISTS moment_mesures (domaine VARCHAR(5) NOT NULL, item_id INT NOT NULL, valeur DOUBLE NOT NULL, " +
    "detail VARCHAR(255) NULL, calcule_le DATETIME NOT NULL, PRIMARY KEY (domaine, item_id)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS moment_releves (game_id INT NOT NULL, le DATETIME NOT NULL, spectateurs INT NULL, joueurs INT NULL, " +
    "PRIMARY KEY (game_id, le), KEY le (le)) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS moment_visites (game_id INT NOT NULL PRIMARY KEY, igdb_id INT NOT NULL, visites DOUBLE NOT NULL, " +
    "lu_le DATETIME NOT NULL) CHARACTER SET utf8mb4",
  "CREATE TABLE IF NOT EXISTS jeux_twitch (game_id INT NOT NULL PRIMARY KEY, igdb_id INT NOT NULL, twitch_id VARCHAR(20) NULL, " +
    "lu_le DATETIME NOT NULL) CHARACTER SET utf8mb4",
];
export async function creerTables(pool: SqlPool): Promise<void> {
  for (const t of TABLES) await pool.query(t);
}

/** Verrou de la base (GET_LOCK, sans attente) : rend la fonction qui le libère, ou null s'il est déjà pris. */
async function prendreVerrou(pool: DuMomentDeps["pool"], nom: string): Promise<(() => Promise<void>) | null> {
  if (typeof pool.getConnection !== "function") return async () => {};
  const conn = await pool.getConnection();
  const rendre = async () => {
    try {
      await Promise.resolve(conn.release());
    } catch {
      /* connexion déjà perdue */
    }
  };
  try {
    const r = await conn.query("SELECT GET_LOCK(CONCAT(?, '.', IFNULL(DATABASE(), '')), 0) AS pris", [nom]);
    if (Number(r?.[0]?.pris) !== 1) {
      await rendre();
      return null;
    }
  } catch (e) {
    await rendre();
    throw e;
  }
  return async () => {
    try {
      await conn.query("SELECT RELEASE_LOCK(CONCAT(?, '.', IFNULL(DATABASE(), '')))", [nom]);
    } catch {
      if (typeof conn.destroy === "function") {
        try {
          await Promise.resolve(conn.destroy());
          return;
        } catch {
          /* rendue au pool, qui écarte les connexions perdues */
        }
      }
    }
    await rendre();
  };
}

/**
 * Écrit les valeurs d'un domaine (par paquets) puis retire celles que ce passage n'a pas écrites, sauf celles des
 * titres qu'il n'a pas pu lire (garder : leur valeur d'avant reste, 24 h au plus). D'un bloc (une transaction) : l'API
 * ne relit jamais un classement à moitié écrit. En cas d'erreur, la connexion est fermée et la base annule tout.
 */
async function ecrireMesures(pool: DuMomentDeps["pool"], domaine: Domaine, valeurs: Array<{ id: number; valeur: number; detail: string }>, le: string, garder: number[] = []): Promise<void> {
  const conn = typeof pool.getConnection === "function" ? await pool.getConnection() : null;
  const bloc = !!conn && typeof conn.destroy === "function";
  const q = (sql: string, params?: unknown[]) => (conn ? conn.query(sql, params) : pool.query(sql, params));
  let fini = false;
  try {
    if (bloc) await q("START TRANSACTION");
    for (let i = 0; i < valeurs.length; i += 200) {
      const lot = valeurs.slice(i, i + 200);
      await q(
        "INSERT INTO moment_mesures (domaine, item_id, valeur, detail, calcule_le) VALUES " +
          lot.map(() => "(?, ?, ?, ?, ?)").join(", ") +
          " ON DUPLICATE KEY UPDATE valeur = VALUES(valeur), detail = VALUES(detail), calcule_le = VALUES(calcule_le)",
        lot.flatMap((v) => [domaine, v.id, v.valeur, v.detail.slice(0, 255), le]),
      );
    }
    const g = [...new Set(garder)];
    await q(
      "DELETE FROM moment_mesures WHERE domaine = ? AND calcule_le < ?" + (g.length ? ` AND (item_id NOT IN (${g.map(() => "?").join(", ")}) OR calcule_le < ?)` : ""),
      g.length ? [domaine, le, ...g, sqlDate(msDe(le) - GARDE_MS)] : [domaine, le],
    );
    if (bloc) await q("COMMIT");
    fini = true;
  } finally {
    if (conn) {
      try {
        await Promise.resolve(fini || !bloc ? conn.release() : conn.destroy!());
      } catch {
        /* connexion déjà perdue */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────── le classement servi par routes.ts
interface Memoire {
  valeurs: Map<number, number>;
  /** Date du dernier calcul (ms UTC). */
  le: number;
}
const memoire: Record<Domaine, Memoire | null> = { anime: null, game: null };
let vuLe = "";

/** Recharge les valeurs depuis la base (au démarrage, après un passage, et quand un autre processus en a écrit). */
export async function chargerMesures(pool: SqlPool): Promise<void> {
  const lignes: any[] = await pool.query(
    "SELECT domaine, CAST(item_id AS UNSIGNED) AS id, valeur, DATE_FORMAT(calcule_le, '%Y-%m-%d %H:%i:%s') AS le FROM moment_mesures",
  );
  const neuve: Record<Domaine, Memoire | null> = { anime: null, game: null };
  for (const l of lignes) {
    const d = String(l.domaine) as Domaine;
    if (d !== "anime" && d !== "game") continue;
    const m = (neuve[d] ??= { valeurs: new Map(), le: 0 });
    const v = Number(l.valeur);
    if (Number.isFinite(v)) m.valeurs.set(Number(l.id), v);
    m.le = Math.max(m.le, msDe(l.le));
  }
  memoire.anime = neuve.anime;
  memoire.game = neuve.game;
}

/** Recharge seulement si un calcul plus récent est en base (une requête légère, chaque minute). */
async function rechargerSiNeuf(pool: SqlPool): Promise<void> {
  const r: any[] = await pool.query("SELECT DATE_FORMAT(MAX(calcule_le), '%Y-%m-%d %H:%i:%s') AS le, COUNT(*) AS n, SUM(valeur) AS s FROM moment_mesures");
  const marque = `${r?.[0]?.le ?? ""}|${r?.[0]?.n ?? ""}|${r?.[0]?.s ?? ""}`;
  if (marque === vuLe) return;
  await chargerMesures(pool);
  vuLe = marque;
}

/**
 * Le Top « du moment » d'une liste de sortis (déjà filtrée par routes.ts) : les titres mesurés d'abord, par valeur +
 * bonus Europe ; puis ceux sans mesure, dans l'ordre d'avant. Mêmes champs que sortForGameNimeTop (gameNimeScore reste
 * le score d'avant). Ordre d'avant pour toute la liste si le module est coupé ou si ses mesures datent.
 */
export function trierDuMoment(domaine: Domaine, items: GameNimeItem[], limit: number, now: Date = new Date()): ScoredItem[] {
  const tous = sortForGameNimeTop(items, items.length, now);
  try {
    const m = memoire[domaine];
    if (!classementActif(domaine) || !m || !m.valeurs.size || now.getTime() - m.le > PERIME_MS[domaine]) return tous.slice(0, limit);
    const notes = tous.map((x, k) => {
      const v = m.valeurs.get(Number(x.id));
      return { x, k, s: v === undefined ? null : v + Math.max(0, Number(x.europeBonus) || 0) };
    });
    notes.sort((a, b) => {
      if ((a.s === null) !== (b.s === null)) return a.s === null ? 1 : -1;
      if (a.s !== null && b.s !== null && a.s !== b.s) return b.s - a.s;
      return a.k - b.k;
    });
    return notes.slice(0, limit).map((n) => n.x);
  } catch {
    return tous.slice(0, limit); // filet : le classement d'avant plutôt qu'une erreur du flux
  }
}

// ─────────────────────────────────────────────────────────────── animés (AniList)
/**
 * Les animés de l'année déjà sortis (date de sortie, ou de cinéma en France, entre le 1er janvier et aujourd'hui) avec
 * un identifiant AniList : tous ceux que routes.ts montre comme sortis, et un peu plus (sans ses règles de visibilité
 * ni de précision de la date). Les valeurs des animés ne dépendent pas des autres : mesurer plus ne change rien au tri.
 */
const SQL_ANIMES =
  "SELECT CAST(id AS UNSIGNED) AS id, CAST(anilist_id AS UNSIGNED) AS al FROM anime_items WHERE anilist_id > 0 " +
  "AND (release_date BETWEEN MAKEDATE(YEAR(UTC_DATE()), 1) AND UTC_DATE() OR fr_cinema BETWEEN MAKEDATE(YEAR(UTC_DATE()), 1) AND UTC_DATE())";
const Q_TENDANCES =
  "query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(id_in: $ids, type: ANIME) { id " +
  "trends(sort: DATE_DESC, perPage: 12) { nodes { date trending } } } } }";

class TropDeRequetes extends Error {
  readonly attenteMs: number | null;
  constructor(attenteMs: number | null) {
    super("AniList : trop de requêtes (HTTP 429)");
    this.attenteMs = attenteMs;
  }
}

/** Une page AniList ; lève TropDeRequetes sur un 429, une erreur sinon (le message d'AniList pour une requête trop lourde). */
async function pageAniList(cfg: DuMomentConfig, ids: number[]): Promise<any[]> {
  const r = await fetch(cfg.anilist, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ query: Q_TENDANCES, variables: { ids, n: ids.length } }),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) {
    const s = Number(r.headers.get("retry-after"));
    await r.body?.cancel().catch(() => {});
    throw new TropDeRequetes(Number.isFinite(s) && s > 0 ? s * 1000 : null);
  }
  const d: any = await r.json().catch(() => null);
  if (Array.isArray(d?.errors) && d.errors.length) throw new Error(`AniList : ${String(d.errors[0]?.message ?? "erreur").slice(0, 100)}`);
  if (!r.ok) throw new Error(`AniList : HTTP ${r.status}`);
  if (!Array.isArray(d?.data?.Page?.media)) throw new Error("AniList : réponse illisible");
  return d.data.Page.media;
}

/**
 * Activité des 7 derniers jours complets (hier et les 6 jours d'avant ; aujourd'hui n'est pas fini) : un relevé par
 * jour UTC (le plus récent si AniList en donne plusieurs).
 */
export function activite7(nodes: Array<{ date?: unknown; trending?: unknown }>, maintenant: number): { activite: number; jours: number } {
  const j0 = Math.floor(maintenant / 1000 / JOUR_S) * JOUR_S;
  const parJour = new Map<number, number>();
  for (const n of [...nodes].sort((a, b) => Number(b?.date) - Number(a?.date))) {
    const d = Number(n?.date);
    if (!Number.isFinite(d) || d <= 0) continue;
    const j = Math.floor(d / JOUR_S) * JOUR_S;
    if (!parJour.has(j)) parJour.set(j, Number(n?.trending) || 0);
  }
  let activite = 0, jours = 0;
  for (const [j, v] of parJour) {
    if (j >= j0 - 7 * JOUR_S && j < j0) {
      activite += Math.max(0, v);
      jours++;
    }
  }
  return { activite, jours };
}

export interface BilanAnimes {
  /** Animés de l'année déjà sortis avec un identifiant AniList. */
  animes: number;
  /** Identifiants AniList demandés et rendus. */
  demandes: number;
  lus: number;
  absents: number;
  ecrits: number;
  requetes: number;
  erreur?: string;
  occupe?: boolean;
}

export async function passageAnimes(deps: DuMomentDeps, cfg: DuMomentConfig = configDuMoment()): Promise<BilanAnimes> {
  const res: BilanAnimes = { animes: 0, demandes: 0, lus: 0, absents: 0, ecrits: 0, requetes: 0 };
  const rendre = await prendreVerrou(deps.pool, VERROU.anime);
  if (!rendre) return { ...res, occupe: true };
  try {
    await creerTables(deps.pool);
    const lignes: any[] = await deps.pool.query(SQL_ANIMES);
    const parAl = new Map<number, number[]>();
    for (const l of lignes) {
      const al = Number(l.al), id = Number(l.id);
      if (!(al > 0) || !(id > 0)) continue;
      parAl.set(al, [...(parAl.get(al) ?? []), id]);
    }
    res.animes = lignes.length;
    const ids = [...parAl.keys()];
    const lus = new Map<number, { activite: number; jours: number }>();
    const maintenant = Date.now();
    let taille = cfg.lotAniList, i = 0, refus = 0, reprise = false;
    while (i < ids.length) {
      const lot = ids.slice(i, i + taille);
      if (res.requetes) await dormir(cfg.pauseAniListMs);
      const n8n = cfg.eviterN8n ? attenteN8n(new Date()) : 0;
      if (n8n > 0) await dormir(n8n);
      res.requetes++;
      let media: any[];
      try {
        media = await pageAniList(cfg, lot);
      } catch (e) {
        if (e instanceof TropDeRequetes) {
          const ms = e.attenteMs ?? cfg.attente429Ms;
          if (refus < 2 && ms <= cfg.attenteMaxMs) {
            refus++;
            await dormir(ms);
            continue;
          }
          res.erreur = ms > cfg.attenteMaxMs ? `AniList demande d'attendre ${Math.round(ms / 1000)} s (HTTP 429) : passage arrêté` : court(e);
          break;
        }
        if (/complex/i.test(court(e)) && taille > 5) {
          taille = Math.max(5, Math.floor(taille / 2));
          continue;
        }
        if (!reprise) {
          reprise = true;
          await dormir(cfg.pauseRepriseMs);
          continue;
        }
        res.erreur = court(e);
        break;
      }
      reprise = false;
      res.demandes += lot.length;
      for (const m of media) {
        const al = Number(m?.id);
        if (parAl.has(al)) lus.set(al, activite7(m?.trends?.nodes ?? [], maintenant));
      }
      i += lot.length;
    }
    res.lus = [...lus.keys()].reduce((s, al) => s + (parAl.get(al)?.length ?? 0), 0);
    res.absents = res.demandes - lus.size;
    if (ids.length && lus.size < COUVERTURE_ANIMES * ids.length) {
      res.erreur = `${res.erreur ? res.erreur + " ; " : ""}${lus.size} animés lus sur ${ids.length} : rien n'est écrit (les valeurs d'avant restent)`;
      return res;
    }
    const valeurs: Array<{ id: number; valeur: number; detail: string }> = [];
    for (const [al, a] of lus) {
      for (const id of parAl.get(al) ?? []) valeurs.push({ id, valeur: 200 * Math.log10(1 + a.activite), detail: JSON.stringify({ a: a.activite, j: a.jours }) });
    }
    // les lots jamais lus (passage arrêté en route) : leurs animés gardent leur valeur d'avant (24 h au plus)
    const garder = ids.slice(i).flatMap((al) => parAl.get(al) ?? []);
    if (garder.length) res.erreur = `${res.erreur ?? "passage arrêté"} ; ${garder.length} animés non lus : leur valeur d'avant reste (24 h au plus)`;
    await ecrireMesures(deps.pool, "anime", valeurs, sqlDate(Date.now()), garder);
    res.ecrits = valeurs.length;
    await chargerMesures(deps.pool).catch(() => {});
    deps.rafraichir?.();
    return res;
  } finally {
    await rendre();
  }
}

// ─────────────────────────────────────────────────────────────── jeux (Twitch, Steam, IGDB)
/** Les jeux de la fenêtre large de routes.ts ; « sortis » comme filterByStatus (date au jour près, passée, dans
 * l'année ; un ancien jeu avec une extension sortie dans l'année). */
const SQL_JEUX =
  "SELECT CAST(id AS UNSIGNED) AS id, CAST(IFNULL(igdb_id, 0) AS UNSIGNED) AS igdb, DATE_FORMAT(release_date, '%Y-%m-%d') AS d, " +
  "release_precision AS p, dlcs FROM game_items WHERE release_date BETWEEN ? AND ? AND cover IS NOT NULL AND cover <> '' " +
  "AND title IS NOT NULL AND title <> ''";
export function jeuSorti(x: { d?: unknown; p?: unknown; dlcs?: unknown }, maintenant: Date = new Date()): boolean {
  const auj = maintenant.toISOString().slice(0, 10);
  const debut = `${maintenant.getUTCFullYear()}-01-01`;
  const d = typeof x.d === "string" ? x.d : "";
  if (!d || x.p !== "day") return false;
  if (d <= auj && d >= debut) return true;
  if (d >= debut || !x.dlcs) return false;
  try {
    const l = JSON.parse(String(x.dlcs));
    return Array.isArray(l) && l.some((y: any) => typeof y?.releaseDate === "string" && y.releaseDate >= debut && y.releaseDate <= auj);
  } catch {
    return false;
  }
}

class Arret extends Error {}

/** Une requête Helix (jeton Twitch partagé avec IGDB ; un 401 : jeton renouvelé une fois). */
async function helix(cfg: DuMomentConfig, chemin: string): Promise<any> {
  for (let essai = 0; ; essai++) {
    const jeton = await getTwitchToken();
    if (!jeton) throw new Error("Twitch : pas de jeton (identifiants absents ou refusés)");
    const r = await fetch(`${cfg.helix}/${chemin}`, {
      headers: { "Client-Id": process.env.TWITCH_CLIENT_ID || "", Authorization: `Bearer ${jeton}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401 && essai === 0) {
      await r.body?.cancel().catch(() => {});
      invalidateTwitchToken();
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && essai < 2) {
      await r.body?.cancel().catch(() => {});
      const reset = Number(r.headers.get("ratelimit-reset"));
      const ms = r.status === 429 && Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now() + 500) : 2000;
      if (ms > 65000) throw new Error(`Twitch ${chemin.split("?")[0]} : HTTP 429 (attente de ${Math.round(ms / 1000)} s demandée)`);
      await dormir(ms);
      continue;
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d?.data)) throw new Error(`Twitch ${chemin.split("?")[0]} : HTTP ${r.status}`);
    return d;
  }
}

/** Joueurs Steam en ce moment (Steam Web API, sans clé) : { joueurs } (null : pas de compteur) ou { erreur } ; Arret sur 429 ou 403. */
async function joueursSteam(cfg: DuMomentConfig, app: number): Promise<{ joueurs?: number | null; erreur?: string }> {
  for (let essai = 0; ; essai++) {
    let r: Response;
    try {
      r = await fetch(`${cfg.steam}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(String(app))}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      if (essai === 0) {
        await dormir(2000);
        continue;
      }
      return { erreur: court(e, 80) };
    }
    if (r.status === 429 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      throw new Arret(`Steam : HTTP ${r.status}`);
    }
    if (r.status >= 500 && essai === 0) {
      await r.body?.cancel().catch(() => {});
      await dormir(2000);
      continue;
    }
    const d: any = await r.json().catch(() => null);
    if (r.ok && typeof d?.response?.player_count === "number") return { joueurs: Math.max(0, Math.round(d.response.player_count)) };
    if (r.status === 404 || (d?.response && d.response.player_count === undefined)) return { joueurs: null };
    return { erreur: `HTTP ${r.status}` };
  }
}

export interface BilanJeux {
  /** Jeux sortis montrés ; rattachés à IGDB. */
  jeux: number;
  igdb: number;
  /** Twitch : catégories connues, jeux diffusés en ce moment, spectateurs comptés. */
  categories: number;
  diffuses: number;
  spectateurs: number;
  twitchOk: boolean;
  /** Catégories comptées sur leurs 2 500 premières diffusions seulement (les plus suivies). */
  plafonnees: number;
  /** Steam : jeux sur Steam, joueurs lus. */
  surSteam: number;
  steamLus: number;
  steamArret?: string;
  /** Visites IGDB relues à ce passage (null : pas cette fois). */
  visites: number | null;
  /** Jeux classés (une valeur écrite). */
  classes: number;
  erreurs: string[];
  occupe?: boolean;
}

export async function passageJeux(deps: DuMomentDeps, cfg: DuMomentConfig = configDuMoment()): Promise<BilanJeux> {
  const res: BilanJeux = { jeux: 0, igdb: 0, categories: 0, diffuses: 0, spectateurs: 0, twitchOk: false, plafonnees: 0, surSteam: 0, steamLus: 0, visites: null, classes: 0, erreurs: [] };
  const rendre = await prendreVerrou(deps.pool, VERROU.game);
  if (!rendre) return { ...res, occupe: true };
  try {
    await creerTables(deps.pool);
    const maintenant = new Date();
    const an = maintenant.getUTCFullYear();
    const jeux = ((await deps.pool.query(SQL_JEUX, [`${an - 3}-01-01`, `${an + 3}-12-31`])) as any[])
      .filter((x) => jeuSorti(x, maintenant))
      .map((x) => ({ id: Number(x.id), igdb: Number(x.igdb) || 0 }));
    res.jeux = jeux.length;
    const avecIgdb = jeux.filter((x) => x.igdb > 0);
    res.igdb = avecIgdb.length;
    // 0. le jeton Twitch (Helix et IGDB) : sans lui ni visites récentes, rien ne peut être classé (Steam n'est pas lu)
    const jeton = await getTwitchToken().catch(() => null);
    if (!jeton) {
      res.erreurs.push("Twitch : pas de jeton (identifiants absents ou refusés)");
      const v: any[] = await deps.pool.query("SELECT COUNT(*) AS n FROM moment_visites WHERE lu_le >= ?", [sqlDate(Date.now() - VISITES_VALIDES_MS)]);
      if (!(Number(v?.[0]?.n) > 0)) {
        res.erreurs.push("ni spectateurs Twitch ni visites IGDB (Steam seul ne voit que le PC) : classement inchangé");
        return res;
      }
    }

    // 1. catégories Twitch, par l'identifiant IGDB (revues chaque semaine ; celles que Twitch n'a pas encore, à chaque passage)
    const categorie = new Map<number, string | null>();
    const vieux = new Set<number>();
    for (const l of (await deps.pool.query("SELECT CAST(game_id AS UNSIGNED) AS g, CAST(igdb_id AS UNSIGNED) AS i, twitch_id AS t, DATE_FORMAT(lu_le, '%Y-%m-%d %H:%i:%s') AS le FROM jeux_twitch")) as any[]) {
      const j = avecIgdb.find((x) => x.id === Number(l.g));
      if (!j || j.igdb !== Number(l.i)) continue;
      categorie.set(j.id, l.t ? String(l.t) : null);
      if (Date.now() - msDe(l.le) > CATEGORIES_JOURS * 24 * HEURE) vieux.add(j.id);
    }
    const aRevoir = jeton ? avecIgdb.filter((x) => !categorie.has(x.id) || categorie.get(x.id) === null || vieux.has(x.id)) : [];
    let twitchPossible = !!jeton;
    try {
      for (let i = 0; i < aRevoir.length; i += 100) {
        const lot = aRevoir.slice(i, i + 100);
        if (i) await dormir(cfg.pauseHelixMs);
        const d = await helix(cfg, `games?${[...new Set(lot.map((x) => x.igdb))].map((x) => `igdb_id=${x}`).join("&")}`);
        const parIgdb = new Map<number, string>();
        for (const g of d.data) if (Number(g?.igdb_id) > 0 && g?.id) parIgdb.set(Number(g.igdb_id), String(g.id));
        const le = sqlDate(Date.now());
        for (const x of lot) categorie.set(x.id, parIgdb.get(x.igdb) ?? null);
        await deps.pool.query(
          "INSERT INTO jeux_twitch (game_id, igdb_id, twitch_id, lu_le) VALUES " + lot.map(() => "(?, ?, ?, ?)").join(", ") +
            " ON DUPLICATE KEY UPDATE igdb_id = VALUES(igdb_id), twitch_id = VALUES(twitch_id), lu_le = VALUES(lu_le)",
          lot.flatMap((x) => [x.id, x.igdb, parIgdb.get(x.igdb) ?? null, le]),
        );
      }
    } catch (e) {
      res.erreurs.push(`catégories Twitch : ${court(e, 120)}`);
      if (!categorie.size) twitchPossible = false;
    }
    // 2. spectateurs en direct : les diffusions suivies par 2 personnes ou plus (les plus suivies d'abord) ; un lot de
    // catégories qui dépasse 2 500 diffusions est relu catégorie par catégorie (sinon les petites y valaient 0)
    const spectateurs = new Map<string, number>();
    const cats = [...new Set([...categorie.values()].filter((x): x is string => !!x))];
    res.categories = cats.length;
    const diffusions = async (lot: string[]): Promise<{ parCat: Map<string, number>; plafond: boolean }> => {
      const parCat = new Map<string, number>();
      let apres = "";
      for (let page = 0; page < cfg.pagesHelix; page++) {
        await dormir(cfg.pauseHelixMs);
        const d = await helix(cfg, `streams?first=100&type=live&${lot.map((x) => `game_id=${encodeURIComponent(x)}`).join("&")}${apres ? `&after=${encodeURIComponent(apres)}` : ""}`);
        for (const s of d.data) parCat.set(String(s?.game_id), (parCat.get(String(s?.game_id)) ?? 0) + Math.max(0, Number(s?.viewer_count) || 0));
        apres = d?.pagination?.cursor || "";
        const dernier = d.data.length ? Number(d.data[d.data.length - 1]?.viewer_count) || 0 : 0;
        if (!apres || !d.data.length || dernier < 2) return { parCat, plafond: false };
      }
      return { parCat, plafond: true };
    };
    if (twitchPossible && cats.length) {
      try {
        for (let i = 0; i < cats.length; i += 100) {
          const lot = cats.slice(i, i + 100);
          const r = await diffusions(lot);
          const lus = r.plafond && lot.length > 1 ? [] : [r];
          if (!lus.length) for (const c of lot) lus.push(await diffusions([c]));
          for (const x of lus) {
            if (x.plafond) res.plafonnees++;
            for (const [c, v] of x.parCat) spectateurs.set(c, (spectateurs.get(c) ?? 0) + v);
          }
        }
        res.twitchOk = true;
        res.diffuses = [...spectateurs.values()].filter((v) => v > 0).length;
        res.spectateurs = [...spectateurs.values()].reduce((s, v) => s + v, 0);
      } catch (e) {
        res.erreurs.push(`spectateurs Twitch : ${court(e, 120)}`);
      }
    }
    // 3. joueurs Steam (pages confirmées) ; les jeux les plus populaires d'abord
    const apps = new Map<number, number>();
    if (jeux.length) {
      const ids = jeux.map((x) => x.id);
      for (const l of (await deps.pool.query(
        `SELECT CAST(s.game_id AS UNSIGNED) AS g, CAST(s.app_id AS UNSIGNED) AS a FROM jeux_steam s JOIN game_items g ON g.id = s.game_id ` +
          `WHERE s.statut = 'ok' AND s.app_id > 0 AND s.game_id IN (${ids.map(() => "?").join(", ")}) ORDER BY g.popularity DESC`,
        ids,
      )) as any[]) apps.set(Number(l.g), Number(l.a));
    }
    res.surSteam = apps.size;
    const joueurs = new Map<number, number>();
    const finSteam = Date.now() + cfg.steamMaxMs;
    let deSuite = 0;
    try {
      for (const [g, a] of apps) {
        if (Date.now() > finSteam) throw new Arret("Steam : 20 min écoulées");
        await dormir(cfg.pauseSteamMs);
        const r = await joueursSteam(cfg, a);
        if (r.erreur) {
          if (++deSuite >= 3) throw new Arret(`Steam : 3 erreurs de suite (${r.erreur})`);
          continue;
        }
        deSuite = 0;
        if (r.joueurs !== null && r.joueurs !== undefined) joueurs.set(g, r.joueurs);
      }
    } catch (e) {
      if (!(e instanceof Arret)) throw e;
      res.steamArret = e.message;
      res.erreurs.push(e.message);
    }
    res.steamLus = joueurs.size;
    // 4. relevé de cette heure
    const heure = sqlDate(Math.floor(Date.now() / HEURE) * HEURE);
    const releve: Array<[number, number | null, number | null]> = [];
    for (const x of jeux) {
      const t = categorie.get(x.id);
      const s = res.twitchOk && t ? spectateurs.get(t) ?? 0 : null;
      const j = joueurs.get(x.id) ?? null;
      if (s !== null || j !== null) releve.push([x.id, s, j]);
    }
    for (let i = 0; i < releve.length; i += 200) {
      const lot = releve.slice(i, i + 200);
      await deps.pool.query(
        "INSERT INTO moment_releves (game_id, le, spectateurs, joueurs) VALUES " +
          lot.map(() => "(?, ?, ?, ?)").join(", ") +
          " ON DUPLICATE KEY UPDATE spectateurs = IFNULL(VALUES(spectateurs), spectateurs), joueurs = IFNULL(VALUES(joueurs), joueurs)",
        lot.flatMap(([g, s, j]) => [g, heure, s, j]),
      );
    }
    await deps.pool.query("DELETE FROM moment_releves WHERE le < ?", [sqlDate(Date.now() - RELEVES_JOURS * 24 * HEURE)]);
    // 5. visites IGDB (toutes les 6 h)
    const derniere: any[] = await deps.pool.query("SELECT DATE_FORMAT(MAX(lu_le), '%Y-%m-%d %H:%i:%s') AS le FROM moment_visites");
    if (jeton && avecIgdb.length && Date.now() - msDe(derniere?.[0]?.le) > VISITES_MS) {
      try {
        const lues = new Map<number, number>();
        const ids = [...new Set(avecIgdb.map((x) => x.igdb))];
        for (let i = 0; i < ids.length; i += cfg.lotIgdb) {
          const lot = ids.slice(i, i + cfg.lotIgdb);
          const corps = `fields game_id,value; where game_id = (${lot.join(",")}) & popularity_type = 1; limit 500;`;
          const lire = async (): Promise<any[]> => {
            for (let essai = 0; ; essai++) {
              await dormir(essai ? 1500 : cfg.pauseIgdbMs);
              const r = await igdbFetch(`${cfg.igdb}/popularity_primitives`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "text/plain" }, body: corps });
              if ((r.status === 429 || r.status >= 500) && essai < 2) {
                await r.body?.cancel().catch(() => {});
                continue;
              }
              const d: any = await r.json().catch(() => null);
              if (!r.ok || !Array.isArray(d)) throw new Error(`IGDB : HTTP ${r.status}`);
              return d;
            }
          };
          const couverts = (d: any[]) => new Set(d.map((p) => Number(p?.game_id))).size;
          let d = await lire();
          if (lot.length >= LOT_SUSPECT && couverts(d) < lot.length / 2) d = await lire();
          if (lot.length >= LOT_SUSPECT && couverts(d) < lot.length / 2) throw new Error(`IGDB : réponse incomplète (un lot de ${lot.length} jeux, ${couverts(d)} mesurés)`);
          for (const p of d) {
            const v = Number(p?.value);
            if (Number(p?.game_id) > 0 && Number.isFinite(v)) lues.set(Number(p.game_id), Math.max(v, lues.get(Number(p.game_id)) ?? 0));
          }
        }
        const le = sqlDate(Date.now());
        const lignes = avecIgdb.map((x) => [x.id, x.igdb, lues.get(x.igdb) ?? 0, le] as const);
        for (let i = 0; i < lignes.length; i += 200) {
          const lot = lignes.slice(i, i + 200);
          await deps.pool.query(
            "INSERT INTO moment_visites (game_id, igdb_id, visites, lu_le) VALUES " + lot.map(() => "(?, ?, ?, ?)").join(", ") +
              " ON DUPLICATE KEY UPDATE igdb_id = VALUES(igdb_id), visites = VALUES(visites), lu_le = VALUES(lu_le)",
            lot.flat(),
          );
        }
        res.visites = avecIgdb.filter((x) => lues.has(x.igdb)).length;
      } catch (e) {
        res.erreurs.push(`visites IGDB : ${court(e, 120)} (les visites d'avant restent)`);
      }
    }
    // 6. calcul sur les relevés des dernières 24 h
    const releveOk = res.twitchOk || (res.surSteam > 0 && res.steamLus >= res.surSteam / 2);
    if (!releveOk) {
      res.erreurs.push("relevé de cette heure incomplet (ni Twitch ni la moitié de Steam) : classement inchangé");
      return res;
    }
    const moyennes = new Map<number, { s: number | null; j: number | null }>();
    for (const l of (await deps.pool.query(
      "SELECT CAST(game_id AS UNSIGNED) AS g, AVG(spectateurs) AS s, AVG(joueurs) AS j FROM moment_releves WHERE le >= ? GROUP BY game_id",
      [sqlDate(Date.now() - 24 * HEURE)],
    )) as any[]) moyennes.set(Number(l.g), { s: l.s === null ? null : Number(l.s), j: l.j === null ? null : Number(l.j) });
    const visites = new Map<number, number>();
    for (const l of (await deps.pool.query("SELECT CAST(game_id AS UNSIGNED) AS g, visites, DATE_FORMAT(lu_le, '%Y-%m-%d %H:%i:%s') AS le FROM moment_visites")) as any[]) {
      if (Date.now() - msDe(l.le) <= VISITES_VALIDES_MS) visites.set(Number(l.g), Number(l.visites) || 0);
    }
    const medS = mediane(avecIgdb.filter((x) => categorie.get(x.id)).map((x) => moyennes.get(x.id)?.s ?? 0));
    const medV = mediane(avecIgdb.map((x) => visites.get(x.id) ?? 0));
    const medJ = mediane(avecIgdb.filter((x) => apps.has(x.id)).map((x) => moyennes.get(x.id)?.j ?? 0));
    if (!medS && !medV) {
      res.erreurs.push("ni spectateurs Twitch ni visites IGDB (Steam seul ne voit que le PC) : classement inchangé");
      return res;
    }
    const n = (v: number, m: number) => Math.log10(1 + Math.max(0, v) / m);
    const valeurs: Array<{ id: number; valeur: number; detail: string }> = [];
    for (const x of avecIgdb) {
      const mo = moyennes.get(x.id);
      const parts: number[] = [];
      const t = categorie.get(x.id); // undefined : pas encore cherchée ; null : Twitch n'a pas de catégorie pour ce jeu
      if (medS && t === null) parts.push(0); // comme au relevé validé : 0 spectateur
      else if (medS && t && mo?.s !== null && mo?.s !== undefined) parts.push(n(mo.s, medS));
      if (medV && visites.has(x.id)) parts.push(n(visites.get(x.id)!, medV));
      if (medJ && apps.has(x.id) && mo?.j !== null && mo?.j !== undefined) parts.push(n(mo.j, medJ));
      if (!parts.length) continue;
      valeurs.push({
        id: x.id,
        valeur: (200 * parts.reduce((s, v) => s + v, 0)) / parts.length,
        detail: JSON.stringify({ s: mo?.s == null ? null : Math.round(mo.s), j: mo?.j == null ? null : Math.round(mo.j), v: visites.get(x.id) ?? null, n: parts.length }),
      });
    }
    if (avecIgdb.length && valeurs.length < avecIgdb.length / 2) {
      res.erreurs.push(`${valeurs.length} jeux mesurés sur ${avecIgdb.length} : classement inchangé`);
      return res;
    }
    await ecrireMesures(deps.pool, "game", valeurs, sqlDate(Date.now()));
    res.classes = valeurs.length;
    await chargerMesures(deps.pool).catch(() => {});
    deps.rafraichir?.();
    return res;
  } finally {
    await rendre();
  }
}

// ─────────────────────────────────────────────────────────────── passages automatiques
let demarre = false;
const enCours: Record<Domaine, boolean> = { anime: false, game: false };

/** Démarre les passages et le rechargement des valeurs (appelé par routes.ts, une fois). */
export function demarrerDuMoment(deps: DuMomentDeps, env: Record<string, string | undefined> = process.env): void {
  if (demarre) return;
  demarre = true;
  // Pilotage (pilotage.ts) : DU_MOMENT_ENABLED ne sert plus qu'à la première mise en route. Coupé au Pilotage, le Top 25
  // du domaine reprend aussitôt le classement d'avant (le tri relit l'interrupteur à chaque appel de flux).
  const actifParDefaut = duMomentActif(env);
  deps.log.info({ module: "du-moment", actifParDefaut }, "Top du moment : planifié (animés toutes les 3 h, jeux toutes les heures)");
  const cfg = configDuMoment(env);
  void rechargerSiNeuf(deps.pool).catch(() => {});
  const recharge = env["DU_MOMENT_ESSAI_RAPIDE"] === "1" ? 2000 : RECHARGE_MS; // essais : relecture toutes les 2 s
  setInterval(() => void rechargerSiNeuf(deps.pool).catch(() => {}), recharge).unref();

  // rien d'écrit pour les animés : nouvel essai 1 h plus tard (le planificateur avance le passage suivant)
  const tickAnimes = async (): Promise<RetourPassage | void> => {
    if (enCours.anime) return;
    enCours.anime = true;
    const debut = Date.now();
    let rejouer = false;
    try {
      const r = await passageAnimes(deps, cfg);
      trackLastRun("du-moment-animes", { ...r }, Date.now() - debut);
      if (r.occupe) deps.log.info({ module: "du-moment" }, "Top du moment (animés) : un passage tourne déjà");
      else if (r.erreur) {
        deps.log.warn({ module: "du-moment", ...r }, "Top du moment (animés) : passage incomplet");
        pushActivity({ type: "du-moment", message: "Top du moment (animés) : passage incomplet", detail: r.erreur, level: "warn" });
        rejouer = !r.ecrits; // rien d'écrit : nouvel essai 1 h plus tard
      } else {
        deps.log.info({ module: "du-moment", ...r }, "Top du moment (animés) : passage terminé");
        pushActivity({ type: "du-moment", message: `Top du moment (animés) : ${r.ecrits} animés mesurés`, detail: `${r.requetes} requêtes AniList`, level: "info" });
      }
    } catch (e) {
      deps.log.error({ module: "du-moment", err: court(e) }, "Top du moment (animés) : erreur");
      trackLastRun("du-moment-animes", { erreur: erreurBase(e) }, Date.now() - debut);
      rejouer = true;
    } finally {
      enCours.anime = false;
    }
    return rejouer ? { reessayerDansMs: RELANCE_ANIMES_MS } : undefined;
  };
  const tickJeux = async (): Promise<RetourPassage | void> => {
    if (enCours.game) return;
    enCours.game = true;
    const debut = Date.now();
    try {
      const r = await passageJeux(deps, cfg);
      trackLastRun("du-moment-jeux", { ...r }, Date.now() - debut);
      if (r.occupe) deps.log.info({ module: "du-moment" }, "Top du moment (jeux) : un passage tourne déjà");
      else if (r.erreurs.length) {
        deps.log.warn({ module: "du-moment", ...r }, "Top du moment (jeux) : passage avec erreurs");
        pushActivity({ type: "du-moment", message: "Top du moment (jeux) : passage avec erreurs", detail: r.erreurs.join(" · ").slice(0, 300), level: "warn" });
      } else deps.log.info({ module: "du-moment", ...r }, "Top du moment (jeux) : passage terminé");
    } catch (e) {
      deps.log.error({ module: "du-moment", err: court(e) }, "Top du moment (jeux) : erreur");
      trackLastRun("du-moment-jeux", { erreur: erreurBase(e) }, Date.now() - debut);
    } finally {
      enCours.game = false;
    }
  };
  const rafraichir = () => deps.rafraichir?.();
  planifier({
    id: "moment-jeux", premierMs: PREMIER_JEUX_MS, rythmeMs: HEURE, suivi: "du-moment-jeux", actifParDefaut, passage: tickJeux,
    quandCoupe: rafraichir, quandRallume: rafraichir,
  });
  planifier({
    id: "moment-animes", premierMs: PREMIER_ANIMES_MS, rythmeMs: PASSAGE_ANIMES_MS, suivi: "du-moment-animes", actifParDefaut, passage: tickAnimes,
    quandCoupe: rafraichir, quandRallume: rafraichir,
  });
}
