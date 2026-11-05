/**
 * Contrôle quotidien des données des animés (16 octobre 2026).
 *
 * Rey, après « Cette semaine » (62 animes sans route et Détective Conan absent, vus à l'œil) : « Faut automatiser pour
 * éviter ce genre de bug » ; son choix : les données manquantes, un contrôle chaque jour, ce qui est sûr réparé seul et
 * le reste en alerte Discord. Ses règles : pour « Cette semaine », « du moment que c'est sur nos plateformes, et que c'est
 * EU ou International » ; pour les animes à venir, les japonais « et chinois aussi ». Puis (même jour, après le relevé
 * des origines) : les animes classés « Ecchi » par AniList entrent comme les autres, et un anime sur une de nos
 * plateformes de streaming entre quelle que soit son origine (coréens compris, à venir aussi dès qu'une plateforme est
 * annoncée) ; restent refusés : le contenu adulte (hentai, porno…) et, sans aucune de nos plateformes, les titres écrits
 * en coréen (hangul) ou en pinyin à tons (règle de /anime/bulk, isLikelyJapaneseAnime).
 *
 * Chaque jour à 5 h 30 UTC, et 20 min après chaque démarrage de l'API :
 *  1. « Cette semaine » (planning sous-titré d'AnimeSchedule) :
 *     - un anime absent de la base y entre, avec sa route, s'il est sur une de nos plateformes d'après AniList : tout
 *       format (sauf clip musical), toute popularité ; la fiche AnimeSchedule le désigne par AniList, sinon par MAL ;
 *     - un anime en base sans route reçoit celle du planning (sa fiche AnimeSchedule porte son identifiant, et aucun
 *       autre anime n'a cette route) ;
 *     - un anime en base masqué (aucune de nos plateformes) est relu sur AniList : s'il y est désormais sur une des
 *       nôtres, /anime/bulk l'ajoute (rien n'est écrasé).
 *  2. Fenêtre du site : parmi les 300 animes les plus suivis chez AniList qui commencent dans l'année en cours ou la
 *     suivante, ceux qui manquent y entrent : sortis ou en cours, s'ils sont sur nos plateformes ; à venir, s'ils sont
 *     japonais ou chinois, en série TV, film, OVA ou ONA, suivis par plus de 1 000 personnes (la règle du workflow
 *     AniList, la Chine en plus ; un anime chinois sans plateforme reste masqué, règle du site, et s'affiche dès qu'une
 *     des nôtres est annoncée : plateformes.ts).
 *     Les entrées passent par /anime/bulk, sous la forme du workflow AniList, avec ses règles (contenu adulte, origine,
 *     liste de blocage) appliquées avant l'envoi. Jamais envoyé : un anime de la liste de blocage (supprimé ou fusionné
 *     à la main), ni un anime que /anime/bulk rattacherait à une fiche d'un autre anime (même titre, ou titre et date,
 *     ou jaquette et date : il en remplacerait l'identifiant) : signalé (homonyme).
 *  3. Signalé sur Discord, une seule fois par problème tant qu'il dure (table controle_signalements ; une alerte que
 *     Discord n'a pas reçue repart au contrôle suivant) : route déjà portée par un autre anime (route fausse ou
 *     doublon), anime de la semaine passé sous une autre route ou arrêté par la liste de blocage, homonyme, anime
 *     refusé ou rattaché à une autre fiche par /anime/bulk, /anime/bulk en erreur (tous revus au contrôle suivant),
 *     workflows n8n muets depuis plus de 6 h, contrôle incomplet deux fois de suite (source illisible). Les
 *     réparations vont au fil des workflows.
 * Le bilan va au journal de l'API et au suivi des cycles (« controle-donnees », surveillé par le contrôle de santé).
 * Jamais deux contrôles à la fois, même lancés de deux processus (verrou MariaDB).
 *
 * Réglages : CONTROLE_DONNEES_ENABLED=0 coupe le contrôle. CONTROLE_ANILIST_URL et ANIMESCHEDULE_API_URL : essais.
 */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { trackLastRun, pushActivity, getLastRun } from "./dashboard.js";
import { sanitizePlatform, isLikelyJapaneseAnime, normalizeTitle, normalizeTitleStrict } from "./core.js";
import { CHAMPS_MEDIA, versEnvoi, plateformes, enBase, bloqueesParLaListe, envoyer } from "./series-en-cours.js";
import { routesParIdentifiant } from "./refetch-cron.js";
import { planifier } from "./pilotage.js";
import { aniListRefuse, tourAniList } from "./file-anilist.js";

const ANILIST_URL = process.env.CONTROLE_ANILIST_URL || "https://graphql.anilist.co";
const AS_API = (process.env.ANIMESCHEDULE_API_URL || "https://animeschedule.net/api/v3").replace(/\/+$/, "");
const HEURE_UTC = 5;
const MINUTE_UTC = 30;
const PREMIER_MS = 20 * 60 * 1000;
const PAGES_FENETRE = 6; // 6 × 50 = les 300 plus suivis
const WORKFLOW_MUET_H = 6;
const FICHES_MAX = 60;
const ENVOIS_MAX = 50;
const ENVOI_DELAI_MS = 5 * 60 * 1000;
const PAUSE_AL_MS = 2100; // AniList : moins de 30 requêtes par minute
// AniList refuse une requête (429, trop de requêtes dans la minute : juste après un démarrage de l'API, ses autres
// passages l'interrogent aussi) : réessayée après l'attente demandée (Retry-After, 90 s au plus ; 60 s s'il n'en
// donne pas), deux fois au plus, comme popularite.ts ; 3 min d'attente au plus sur tout le contrôle.
const ESSAIS_429_AL = 2;
const ATTENTE_429_AL_MS = 60000;
const ATTENTES_429_AL_MAX_MS = 180000;
const PAUSE_AS_MS = 400;
const DISCORD_MAX = 3800; // caractères par message (la description d'un embed en accepte 4 096)
const FORMATS_A_VENIR = ["TV", "MOVIE", "OVA", "ONA"];
const PAYS_A_VENIR = ["JP", "CN"];
const VERROU = "gn_controle_donnees";
/** Les mots que /anime/bulk refuse (index.ts, BLOCKED_WORDS ; « ecchi » n'en fait plus partie depuis le 16 octobre). */
const MOTS_REFUSES = ["hentai", "erotic", "sexual content", "adult only", "porn", "xxx", "nude", "nsfw"];
/** Les règles d'entrée de /anime/bulk qu'on applique avant l'envoi (pas d'alerte pour un refus voulu) : contenu adulte
 * (mêmes mots) et filtre d'origine (isLikelyJapaneseAnime : sur une de nos plateformes de streaming, toute origine
 * passe ; sinon hangul ou pinyin à tons = refusé, le chinois sans tons passe, comme sur AniList). */
export function horsRegles(e: Record<string, unknown>): boolean {
  return raisonHorsRegles(e) !== null;
}

/** La règle d'entrée qui écarte cet envoi : « adulte (hentai) », « origine coréenne sans nos plateformes »… ; null sinon. */
export function raisonHorsRegles(e: Record<string, unknown>): string | null {
  const t = `${e.title ?? ""} ${e.genre ?? ""}`.toLowerCase();
  const mot = MOTS_REFUSES.find((w) => t.includes(w));
  if (mot) return `adulte (${mot})`;
  const o = isLikelyJapaneseAnime({ title: e.title as string, titleEnglish: e.titleEnglish as string, titleNative: e.titleNative as string, platform: (e.platform as string) ?? null });
  if (o.likely) return null;
  return o.reason === "hangul_detected" ? "origine coréenne sans nos plateformes" : o.reason === "pinyin_tones" ? "origine chinoise sans nos plateformes" : "origine";
}

export function configControle(): { actif: boolean } {
  return { actif: process.env.CONTROLE_DONNEES_ENABLED !== "0" };
}

const TABLE =
  "CREATE TABLE IF NOT EXISTS controle_signalements (" +
  "cle VARCHAR(190) NOT NULL PRIMARY KEY, " +
  "libelle VARCHAR(500) NOT NULL, " +
  "envoye TINYINT NOT NULL DEFAULT 0, " +
  "premier DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
  "dernier DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP" +
  ") CHARACTER SET utf8mb4";

/** Anime affiché dans « Cette semaine » : la règle de /feed/week (routes.ts). */
const VISIBLE =
  "(TRIM(IFNULL(platform, '')) <> '' OR ((pays_origine IS NULL OR pays_origine IN ('JP', '--')) AND " +
  "(release_precision IS NULL OR release_precision <> 'day' OR release_date IS NULL OR release_date > UTC_DATE())))";

export interface EntreeControle {
  id: number;
  titre: string;
  plateforme: string;
  origine: "semaine" | "fenetre";
}

export interface BilanControle {
  semaine: { total: number; affiches: number; masques: number; absents: number; sansRoute: number; autreRoute: number; illisibles: number } | null;
  /** animes manquants proposés à l'entrée (après les règles d'entrée et les signalements en cours) */
  candidats: number;
  /** écartés avant l'envoi par les règles d'entrée du site (contenu adulte ; coréen ou chinois sans nos plateformes) */
  horsRegles: number;
  /** les mêmes : « titre (raison) » */
  horsReglesTitres: string[];
  entrees: EntreeControle[];
  /** routes de « Cette semaine » posées : « Titre » (#id) → route */
  routes: string[];
  /** plateformes ajoutées à un anime masqué de la semaine : « Titre » (#id) : plateformes */
  plateformes: string[];
  /** déjà en base (fiche existante complétée par /anime/bulk) */
  dejaLa: number;
  /** liste de blocage (supprimés ou fusionnés à la main) */
  bloquees: string[];
  /** pas envoyés : /anime/bulk les rattacherait à la fiche d'un autre anime */
  homonymes: string[];
  refusees: string[];
  /** rattachés par /anime/bulk à une fiche existante qui portait un autre identifiant AniList */
  fusions: string[];
  /** /anime/bulk en erreur pour ces animes (envoyés un par un) : nouvel essai au contrôle suivant */
  echecs: string[];
  conflits: string[];
  /** dernier envoi de chaque workflow, en heures (suivi de l'API ; null hors de l'API ou sans envoi depuis son démarrage) */
  workflows: { anilistH: number | null; animescheduleH: number | null };
  /** problèmes en cours (déjà signalés ou nouveaux) */
  problemes: number;
  /** alertes envoyées sur Discord à ce passage */
  signales: string[];
  /** alertes que Discord n'a pas reçues (webhook absent ou en erreur) : nouvel essai au contrôle suivant */
  nonEnvoyees: string[];
  erreurs: string[];
  occupe: boolean;
}

/** « I'm Dating a Dark Summoner! [Crunchyroll] (cette semaine) » */
export function decrireEntree(e: EntreeControle): string {
  return `${e.titre} [${e.plateforme || "a venir, plateforme non annoncee"}] (${e.origine === "semaine" ? "cette semaine" : "fenetre du site"})`;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idDe = (v: unknown, re: RegExp): number | null => {
  const m = re.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
};
const anilistDe = (w: any) => idDe(w?.aniList ?? w?.anilist, /anilist\.co\/anime\/(\d+)/i);
const malDe = (w: any) => idDe(w?.mal ?? w?.myanimelist, /myanimelist\.net\/anime\/(\d+)/i);
const titreDe = (m: any) => String(m?.title?.english || m?.title?.romaji || m?.title?.native || "?");
const enHeures = (ms: number) => Math.round((ms / 3600000) * 10) / 10;
const pl = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** Une promesse bornée dans le temps (app.inject n'a pas de délai). */
function avecDelai<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, ko) => { t = setTimeout(() => ko(new Error(message)), ms); })]).finally(() => clearTimeout(t));
}

/** La semaine ISO de « Cette semaine » (comme /feed/week) et ses 7 jours en UTC. */
function laSemaine(now: Date): { week: number; year: number; jours: string[] } {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  const lundi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  lundi.setUTCDate(lundi.getUTCDate() - ((lundi.getUTCDay() || 7) - 1));
  const jours = Array.from({ length: 7 }, (_, k) => new Date(lundi.getTime() + k * 86400000).toISOString().slice(0, 10));
  return { week, year: t.getUTCFullYear(), jours };
}

async function lireAS(chemin: string, jeton: string): Promise<any> {
  const r = await fetch(AS_API + chemin, {
    headers: { Authorization: "Bearer " + jeton, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 404) return null; // rien de trouvé
  if (r.status === 429) throw new Error("AnimeSchedule : trop de requetes (429)");
  if (!r.ok) throw new Error(`AnimeSchedule : HTTP ${r.status}`);
  return r.json();
}

/** Admis à entrer : sur une de nos plateformes (AniList) ; ou, hors « Cette semaine », à venir japonais ou chinois. */
export function admis(m: any, semaine: boolean): boolean {
  if (!m || m.isAdult || m.format === "MUSIC" || !Number.isInteger(Number(m.id))) return false;
  if (sanitizePlatform(plateformes(m))) return true;
  if (semaine) return false;
  return m.status === "NOT_YET_RELEASED" && PAYS_A_VENIR.includes(String(m.countryOfOrigin)) &&
    FORMATS_A_VENIR.includes(String(m.format)) && Number(m.popularity) > 1000;
}

/** La jaquette que /anime/bulk compare (une jaquette générique ne compte pas). */
function jaquettePourDoublons(cover: unknown): string | null {
  const c = typeof cover === "string" && cover ? cover : null;
  if (!c || /\/(default|placeholder|noimage|no-image|missing)\.(jpg|png)/i.test(c) || /cover\/(medium|large)\/default/i.test(c)) return null;
  return c;
}

/**
 * La fiche d'un AUTRE anime que /anime/bulk prendrait pour celui-ci (ses critères de doublon : même titre ; titre
 * normalisé et date ; titre réduit et date ; jaquette et date) : il la mettrait à jour et en remplacerait l'identifiant
 * AniList. Une fiche sans identifiant AniList (ou du même anime) n'est pas un homonyme : elle serait complétée.
 * Strict (mise à jour de la fiche « sauf ») : toute autre fiche que /anime/bulk pourrait prendre (ses critères, ou le
 * même identifiant AniList ou MAL) est un homonyme : il pourrait la mettre à jour à la place de « sauf ».
 */
async function homonyme(pool: any, e: Record<string, unknown>, sauf = 0, strict = false): Promise<{ id: number; titre: string; al: number } | null> {
  const date = (e.releaseDate as string) || null;
  const c = jaquettePourDoublons(e.cover);
  const al = Number(e.anilistId) || 0;
  const mal = Number(e.malId) || 0;
  const lignes: any[] = await pool.query(
    "SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS te, CAST(IFNULL(anilist_id, 0) AS UNSIGNED) AS al, " +
      "CAST(IFNULL(mal_id, 0) AS UNSIGNED) AS mal FROM anime_items WHERE id <> ? AND (title = ? " +
      "OR (release_date = ? AND title_normalized_strict IS NOT NULL AND title_normalized_strict != '' AND title_normalized_strict = ?) " +
      "OR (release_date = ? AND LOWER(REGEXP_REPLACE(title, '[^[:alnum:]]', '')) = ?) " +
      "OR (? IS NOT NULL AND release_date = ? AND cover = ?)" +
      (strict ? " OR (? > 0 AND anilist_id = ?) OR (? > 0 AND mal_id = ?)" : "") +
      ") LIMIT 10",
    [sauf, String(e.title ?? ""), date, normalizeTitleStrict(String(e.title ?? "")), date, normalizeTitle(String(e.title ?? "")), c, date, c, ...(strict ? [al, al, mal, mal] : [])]
  );
  for (const l of lignes) {
    const lal = Number(l.al) || 0;
    const lmal = Number(l.mal) || 0;
    if (strict || (lal && lal !== al) || (lmal && mal && lmal !== mal)) return { id: Number(l.id), titre: String(l.te || l.title || ""), al: lal };
  }
  return null;
}

/** Le titre comme /anime/bulk le réduit en base (critère 3 : minuscules, lettres et chiffres seulement). */
const reduit = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Sans accents ni majuscules (la comparaison de titres de MariaDB). */
const sansAccents = (t: string): string => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * Deux animes envoyés au même contrôle que /anime/bulk confondrait (mêmes critères) : les clés du premier, entré
 * (« gardees »), et celles qu'on cherche pour les suivants (« cherchees ») ; le critère 3 compare le titre réduit en
 * base au titre normalisé de l'envoi.
 */
function clesDeDoublon(e: Record<string, unknown>): { gardees: string[]; cherchees: string[] } {
  const t = String(e.title ?? "");
  const date = String(e.releaseDate ?? "");
  const communes = ["t:" + sansAccents(t)];
  const n = normalizeTitleStrict(t);
  if (n && date) communes.push(`n:${date}:${n}`);
  const c = jaquettePourDoublons(e.cover);
  if (c && date) communes.push(`c:${date}:${c}`);
  return {
    gardees: [...communes, ...(date ? [`r:${date}:${reduit(t)}`] : [])],
    cherchees: [...communes, ...(date ? [`r:${date}:${normalizeTitle(t)}`] : [])],
  };
}

/** Une clé de signalement tient dans la table (190 caractères) : au-delà, la fin devient une empreinte. */
const cleCourte = (k: string): string => (k.length <= 190 ? k : k.slice(0, 140) + "#" + createHash("sha1").update(k).digest("hex"));

function bilanVide(): BilanControle {
  return {
    semaine: null, candidats: 0, horsRegles: 0, horsReglesTitres: [], entrees: [], routes: [], plateformes: [], dejaLa: 0, bloquees: [], homonymes: [], refusees: [],
    fusions: [], echecs: [], conflits: [], workflows: { anilistH: null, animescheduleH: null }, problemes: 0, signales: [],
    nonEnvoyees: [], erreurs: [], occupe: false,
  };
}

/**
 * Des lignes sur Discord, en autant de messages qu'il faut ; rend le nombre de lignes reçues (dans l'ordre). Un 429 :
 * un nouvel essai après l'attente demandée ; une autre erreur arrête l'envoi (la suite repart au contrôle suivant).
 */
async function discord(url: string | undefined, titre: string, lignes: string[], couleur: number): Promise<number> {
  if (!url || !lignes.length) return 0;
  const paquets: string[][] = [];
  let p: string[] = [], n = 0;
  for (const l of lignes.map((x) => x.slice(0, DISCORD_MAX))) {
    if (p.length && n + l.length + 1 > DISCORD_MAX) {
      paquets.push(p);
      p = [];
      n = 0;
    }
    p.push(l);
    n += l.length + 1;
  }
  if (p.length) paquets.push(p);
  let recues = 0;
  for (let i = 0; i < paquets.length; i++) {
    if (i) await dormir(1100);
    const corps = JSON.stringify({
      embeds: [{ title: i ? `${titre} (suite)` : titre, description: paquets[i].join("\n"), color: couleur, footer: { text: "GameNime · Contrôle quotidien des données" }, timestamp: new Date().toISOString() }],
    });
    let ok = false;
    for (let essai = 0; essai < 2 && !ok; essai++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: corps, signal: AbortSignal.timeout(15000) });
        if (r.ok) ok = true;
        else if (r.status === 429 && !essai) {
          const d: any = await r.json().catch(() => null);
          await dormir(Math.min(10000, Math.max(1000, Number(d?.retry_after ?? 2) * 1000)));
        } else break;
      } catch {
        break;
      }
    }
    if (!ok) break;
    recues += paquets[i].length;
  }
  return recues;
}

type Connu = { libelle: string; envoye: boolean };
// signalements gardés en mémoire si la table est inutilisable (on ne répète pas une alerte à chaque passage)
const signalesEnMemoire = new Map<string, Connu>();
// contrôles sautés de suite (verrou pris) : le premier compte comme un passage (un autre contrôle tourne), pas les
// suivants (un verrou resté pris ne doit pas cacher un contrôle arrêté au contrôle de santé)
let sautesDeSuite = 0;

/**
 * Un contrôle. app.pool pour la base ; app.inject (dans l'API) ou le réseau (passage lancé à la main) pour /anime/bulk.
 */
export async function passageControle(app: FastifyInstance): Promise<BilanControle> {
  const bilan = bilanVide();
  // l'interrupteur est au Pilotage (pilotage.ts) : CONTROLE_DONNEES_ENABLED ne sert plus qu'à la première mise en route
  const pool = (app as any).pool;
  if (!pool) {
    app.log.warn("controle des donnees : base introuvable");
    return bilan;
  }
  const debut = Date.now();
  const conn = await pool.getConnection();
  let verrou = false;
  try {
    const l: any[] = await conn.query(`SELECT GET_LOCK('${VERROU}', 0) AS l`);
    verrou = Number(l?.[0]?.l) === 1;
    if (!verrou) {
      bilan.occupe = true;
      app.log.info("controle des donnees : un autre controle tourne, celui-ci est saute");
      if (++sautesDeSuite === 1) trackLastRun("controle-donnees", { occupe: true }, 0);
      return bilan;
    }
    sautesDeSuite = 0;
    await controler(app, pool, bilan);
    app.log.info(
      {
        semaine: bilan.semaine,
        candidats: bilan.candidats,
        horsRegles: bilan.horsReglesTitres,
        entrees: bilan.entrees.map(decrireEntree),
        routes: bilan.routes,
        plateformes: bilan.plateformes,
        dejaLa: bilan.dejaLa,
        bloquees: bilan.bloquees,
        homonymes: bilan.homonymes,
        refusees: bilan.refusees,
        fusions: bilan.fusions,
        echecs: bilan.echecs,
        conflits: bilan.conflits,
        workflows: bilan.workflows,
        problemes: bilan.problemes,
        signales: bilan.signales,
        nonEnvoyees: bilan.nonEnvoyees.length,
        erreurs: bilan.erreurs,
      },
      "controle des donnees : termine"
    );
    trackLastRun(
      "controle-donnees",
      {
        entrees: bilan.entrees.length, routes: bilan.routes.length, plateformes: bilan.plateformes.length, bloquees: bilan.bloquees.length,
        homonymes: bilan.homonymes.length, refusees: bilan.refusees.length, fusions: bilan.fusions.length, echecs: bilan.echecs.length,
        conflits: bilan.conflits.length, problemes: bilan.problemes, signales: bilan.signales.length,
        ...(bilan.nonEnvoyees.length ? { nonEnvoyees: bilan.nonEnvoyees.length } : {}), ...(bilan.erreurs.length ? { erreurs: bilan.erreurs } : {}),
      },
      Date.now() - debut
    );
    const reparations = bilan.entrees.length + bilan.routes.length + bilan.plateformes.length;
    if (reparations || bilan.signales.length) {
      pushActivity({
        type: "controle",
        message: `Contrôle des données : ${pl(reparations, "réparation", "réparations")}, ${pl(bilan.signales.length, "signalement", "signalements")}`,
        detail: [...bilan.entrees.map((e) => e.titre), ...bilan.routes, ...bilan.plateformes, ...bilan.signales].join(" ; ").slice(0, 200),
        level: bilan.signales.length ? "warn" : "info",
      });
    }
  } catch (e: any) {
    bilan.erreurs.push(String(e?.message ?? e));
    app.log.warn({ err: String(e?.message ?? e) }, "controle des donnees : interrompu, reprise au prochain passage");
    trackLastRun("controle-donnees", { error: String(e?.message ?? e) }, Date.now() - debut);
  } finally {
    // un verrou qu'on n'a pas pu rendre : la connexion est fermée (MariaDB le rend), pas remise au pool
    let rendu = true;
    if (verrou) rendu = await conn.query(`SELECT RELEASE_LOCK('${VERROU}')`).then(() => true, () => false);
    if (rendu) conn.release();
    else await Promise.resolve(conn.destroy()).catch(() => {});
  }
  return bilan;
}

type Ligne = { id: number; titre: string; al: number; mal: number; route: string; vis: boolean };
type Candidat = { m: any; route: string | null; origine: "semaine" | "fenetre" };

async function controler(app: FastifyInstance, pool: any, bilan: BilanControle): Promise<void> {
  const jeton = process.env.ANIMESCHEDULE_TOKEN || "";
  const cle = process.env.ANIME_API_KEY || "";
  const maintenant = new Date();
  const annee = maintenant.getUTCFullYear();
  const problemes = new Map<string, string>(); // clé -> libellé
  const signaler = (k: string, libelle: string): void => {
    problemes.set(cleCourte(k), libelle);
  };
  const evalues = new Set<string>(); // familles (ou clés) de problèmes entièrement évaluées à ce passage
  const erreursPar = new Map<string, string>(); // source -> première erreur
  const erreur = (source: string, e: unknown): void => {
    const m = String((e as any)?.message ?? e);
    bilan.erreurs.push(m);
    if (!erreursPar.has(source)) erreursPar.set(source, m);
  };

  // ── le catalogue
  const lignes: any[] = await pool.query(
    "SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS te, CAST(IFNULL(anilist_id, 0) AS UNSIGNED) AS al, " +
      `CAST(IFNULL(mal_id, 0) AS UNSIGNED) AS mal, anime_schedule_route AS route, ${VISIBLE} AS vis FROM anime_items`
  );
  const catalogue: Ligne[] = lignes.map((r) => ({
    id: Number(r.id),
    titre: String(r.te || r.title || ""),
    al: Number(r.al) || 0,
    mal: Number(r.mal) || 0,
    route: r.route ? String(r.route).trim() : "",
    vis: Number(r.vis) === 1,
  }));
  const parRoute = new Map<string, Ligne[]>(), parAl = new Map<number, Ligne>(), parMal = new Map<number, Ligne>();
  for (const x of catalogue) {
    if (x.route) parRoute.set(x.route, [...(parRoute.get(x.route) ?? []), x]);
    if (x.al && !parAl.has(x.al)) parAl.set(x.al, x);
    if (x.mal && !parMal.has(x.mal)) parMal.set(x.mal, x);
  }
  const parId = new Map<number, Ligne>(catalogue.map((x) => [x.id, x]));
  const trouve = (al: number | null, mal: number | null): Ligne | null => (al && parAl.get(al)) || (mal && parMal.get(mal)) || null;

  // ── les workflows n8n : le dernier envoi de chacun à /anime/bulk (suivi de l'API, mesuré avant les envois du
  //    contrôle) ; aucun envoi depuis un démarrage de l'API vieux de plus de 6 h compte aussi. Hors de l'API (passage
  //    lancé à la main), le suivi n'existe pas : non évalué.
  for (const [nom, source, champ] of [["AniList", "anilist", "anilistH"], ["AnimeSchedule", "animeschedule", "animescheduleH"]] as const) {
    const run = getLastRun(`push-anime-${source}`);
    const h = run ? enHeures(Date.now() - run.ts) : process.uptime() > WORKFLOW_MUET_H * 3600 ? enHeures(process.uptime() * 1000) : null;
    if (h === null) continue;
    bilan.workflows[champ] = h;
    evalues.add(`workflow:${nom}`);
    if (h > WORKFLOW_MUET_H) {
      signaler(
        `workflow:${nom}`,
        run
          ? `Workflow n8n ${nom} : dernier envoi il y a ${Math.round(h)} h (toutes les 3 h normalement)`
          : `Workflow n8n ${nom} : aucun envoi depuis le démarrage de l'API, il y a ${Math.round(h)} h (toutes les 3 h normalement)`
      );
    }
  }

  // ── 1. « Cette semaine » : les animes du planning qui ne s'affichent pas
  const absentsSemaine: Array<{ route: string; al: number | null; mal: number | null }> = [];
  const masquesSemaine = new Map<number, { x: Ligne; route: string }>(); // AniList -> anime masqué de la semaine
  let semaineLue = false;
  if (!jeton) erreur("AnimeSchedule", "jeton AnimeSchedule absent : semaine et routes non controlees");
  else {
    try {
      const { week, year, jours } = laSemaine(maintenant);
      const planning = await lireAS(`/timetables/sub?week=${week}&year=${year}`, jeton);
      if (!Array.isArray(planning)) throw new Error("AnimeSchedule : planning illisible");
      const dans = planning.filter((a: any) => {
        const d = a?.episodeDate ? new Date(a.episodeDate) : null;
        return a?.route && d && !Number.isNaN(d.getTime()) && jours.includes(d.toISOString().slice(0, 10));
      });
      const s = { total: dans.length, affiches: 0, masques: 0, absents: 0, sansRoute: 0, autreRoute: 0, illisibles: 0 };
      const parEp = new Map<string, number>();
      for (const a of dans) parEp.set(String(a.route), (parEp.get(String(a.route)) ?? 0) + 1);
      let fiches = 0, fichesKo = 0, tropDeFiches = false;
      for (const [route, n] of parEp) {
        const l = parRoute.get(route) ?? [];
        if (l.some((x) => x.vis)) { s.affiches += n; continue; }
        if (l.length) {
          s.masques += n;
          for (const x of l) if (x.al && !masquesSemaine.has(x.al)) masquesSemaine.set(x.al, { x, route });
          continue;
        }
        if (fiches >= FICHES_MAX) {
          s.illisibles += n;
          if (!tropDeFiches) erreur("AnimeSchedule", `plus de ${FICHES_MAX} fiches AnimeSchedule à lire : la fin de la semaine n'est pas contrôlée`);
          tropDeFiches = true;
          continue;
        }
        if (fiches++) await dormir(PAUSE_AS_MS);
        let fiche: any = null;
        try {
          fiche = await lireAS("/anime/" + encodeURIComponent(route), jeton);
        } catch (e: any) {
          fichesKo++;
          s.illisibles += n;
          if (fichesKo === 1) erreur("AnimeSchedule", e);
          continue;
        }
        const al = fiche ? anilistDe(fiche.websites) : null;
        const mal = fiche ? malDe(fiche.websites) : null;
        // l'identifiant AniList d'abord ; MAL seulement si la fiche n'a pas de lien AniList (plusieurs animes AniList
        // peuvent partager un même MAL : une 2e partie, par exemple)
        const x = al ? trouve(al, null) : trouve(null, mal);
        if (!x) {
          s.absents += n;
          if (al || mal) absentsSemaine.push({ route, al, mal });
          continue;
        }
        const sansRoute = !x.route;
        if (sansRoute) {
          // sûr : la fiche AnimeSchedule de cette route porte son identifiant, et aucun anime n'a cette route
          const r: any = await pool.query(
            "UPDATE anime_items a LEFT JOIN anime_items b ON b.anime_schedule_route = ? AND b.id <> a.id " +
              "SET a.anime_schedule_route = ?, a.updated_at = a.updated_at " +
              "WHERE a.id = ? AND (a.anime_schedule_route IS NULL OR a.anime_schedule_route = '') AND b.id IS NULL",
            [route, route, x.id]
          );
          if (Number(r?.affectedRows) === 1) {
            x.route = route;
            parRoute.set(route, [x]);
            bilan.routes.push(`« ${x.titre} » (#${x.id}) → ${route}`);
          }
        } else {
          signaler(`autre-route:${route}`, `« ${x.titre} » (#${x.id}) a la route « ${x.route} », mais le planning de la semaine le passe sous « ${route} » : épisodes absents de « Cette semaine »`);
        }
        if (!x.vis) {
          s.masques += n;
          if (x.al && !masquesSemaine.has(x.al)) masquesSemaine.set(x.al, { x, route });
        } else if (sansRoute) s.sansRoute += n;
        else s.autreRoute += n;
      }
      bilan.semaine = s;
      semaineLue = !fichesKo && !tropDeFiches;
      if (semaineLue) evalues.add("autre-route");
    } catch (e: any) {
      erreur("AnimeSchedule", e);
    }
  }

  // ── AniList : les absents et les masqués de la semaine, puis la fenêtre du site
  let dernierAL = 0;
  let attentes429 = 0;
  const aniList = async (query: string, variables: Record<string, unknown>): Promise<any> => {
    for (let essai = 0; ; essai++) {
      const attente = PAUSE_AL_MS - (Date.now() - dernierAL);
      if (dernierAL && attente > 0) await dormir(attente);
      await tourAniList(); // la file AniList commune (file-anilist.ts)
      dernierAL = Date.now();
      const r = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429) aniListRefuse(r.headers.get("retry-after"));
      if (r.status === 429 && essai < ESSAIS_429_AL) {
        const s = Number(r.headers.get("retry-after"));
        const ms = Number.isFinite(s) && s > 0 ? Math.min(s, 90) * 1000 : ATTENTE_429_AL_MS;
        if (attentes429 + ms <= ATTENTES_429_AL_MAX_MS) {
          await r.text().catch(() => "");
          attentes429 += ms;
          await dormir(ms);
          continue;
        }
      }
      const d: any = await r.json().catch(() => null);
      if (!r.ok || !d || (Array.isArray(d.errors) && d.errors.length)) {
        throw new Error(`AniList : ${!r.ok ? "HTTP " + r.status : String(d?.errors?.[0]?.message ?? "reponse illisible").slice(0, 120)}`);
      }
      return d.data ?? {};
    }
  };
  const candidats = new Map<number, Candidat>();
  const majPlateformes: Array<{ x: Ligne; m: any }> = [];
  let anilistLu = true;
  try {
    const ids = [...new Set([...absentsSemaine.map((x) => x.al).filter((x): x is number => !!x), ...masquesSemaine.keys()])].slice(0, 50);
    const mals = [...new Set(absentsSemaine.filter((x) => !x.al && x.mal).map((x) => x.mal as number))].slice(0, 50);
    const parIdAL = new Map<number, any>();
    const parMalAL = new Map<number, any[]>();
    if (ids.length) {
      const d = await aniList(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${CHAMPS_MEDIA} } } }`, { ids });
      for (const m of d?.Page?.media ?? []) parIdAL.set(Number(m.id), m);
    }
    if (mals.length) {
      const d = await aniList(`query ($mals: [Int]) { Page(perPage: 50) { media(idMal_in: $mals, type: ANIME) { ${CHAMPS_MEDIA} } } }`, { mals });
      for (const m of d?.Page?.media ?? []) parMalAL.set(Number(m.idMal), [...(parMalAL.get(Number(m.idMal)) ?? []), m]);
    }
    for (const x of absentsSemaine) {
      // par MAL : un seul anime AniList pour ce MAL, sinon on ne sait pas lequel passe cette semaine
      const parMal = x.al ? [] : parMalAL.get(Number(x.mal)) ?? [];
      const m = x.al ? parIdAL.get(x.al) : parMal.length === 1 ? parMal[0] : null;
      if (m && admis(m, true) && !candidats.has(Number(m.id)) && !trouve(Number(m.id), null)) candidats.set(Number(m.id), { m, route: x.route, origine: "semaine" });
    }
    for (const [al, { x }] of masquesSemaine) {
      const m = parIdAL.get(al);
      if (m && admis(m, true)) majPlateformes.push({ x, m });
    }
    for (let p = 1; p <= PAGES_FENETRE; p++) {
      const d = await aniList(
        `query ($p: Int, $deb: FuzzyDateInt, $fin: FuzzyDateInt) { Page(page: $p, perPage: 50) { pageInfo { hasNextPage } ` +
          `media(type: ANIME, isAdult: false, startDate_greater: $deb, startDate_lesser: $fin, sort: [POPULARITY_DESC]) { ${CHAMPS_MEDIA} } } }`,
        { p, deb: (annee - 1) * 10000 + 1231, fin: (annee + 2) * 10000 + 101 }
      );
      for (const m of d?.Page?.media ?? []) {
        const id = Number(m.id);
        if (candidats.has(id) || trouve(id, Number(m.idMal) || null)) continue;
        if (admis(m, false)) candidats.set(id, { m, route: null, origine: "fenetre" });
      }
      if (!d?.Page?.pageInfo?.hasNextPage) break;
    }
  } catch (e: any) {
    anilistLu = false;
    erreur("AniList", e);
  }

  // ── les signalements en cours
  let connus = new Map<string, Connu>();
  let tableOk = true;
  try {
    await pool.query(TABLE);
    await pool.query("ALTER TABLE controle_signalements ADD COLUMN IF NOT EXISTS envoye TINYINT NOT NULL DEFAULT 0");
    connus = new Map(
      (await pool.query("SELECT cle, libelle, envoye FROM controle_signalements")).map((r: any) => [String(r.cle), { libelle: String(r.libelle), envoye: Number(r.envoye) === 1 }])
    );
  } catch (e: any) {
    tableOk = false;
    connus = new Map(signalesEnMemoire);
    erreur("base", "signalements : " + String(e?.message ?? e).slice(0, 120));
  }

  // ── 2. les entrées : ce qui manque, sans les règles d'entrée du site ; tout est revu à chaque contrôle (un anime
  //    refusé est renvoyé, un homonyme revérifié) : un signalement réglé sort de la table
  const tri = [...candidats.values()].sort((a, b) => (a.origine === b.origine ? Number(b.m.popularity) - Number(a.m.popularity) : a.origine === "semaine" ? -1 : 1));
  const series: Array<Record<string, unknown>> = [];
  const origineDe = new Map<number, "semaine" | "fenetre">();
  for (const c of tri) {
    const e = versEnvoi(c.m);
    if (!e) continue;
    const raison = raisonHorsRegles(e);
    if (raison) {
      bilan.horsRegles++;
      bilan.horsReglesTitres.push(`${titreDe(c.m)} (${raison})`);
      continue;
    }
    if (c.route) e.animeScheduleRoute = c.route;
    const al = Number(e.anilistId);
    origineDe.set(al, c.origine);
    series.push(e);
  }
  bilan.candidats = series.length;
  let entreesFaites = false;
  if (!series.length && !majPlateformes.length) entreesFaites = true;
  else if (!cle) erreur("envoi", "ANIME_API_KEY absente : entrees impossibles");
  else {
    try {
      // l'envoi : tout d'un coup ; si /anime/bulk répond par une erreur (un anime mal formé fait échouer tout l'envoi),
      // un par un : les autres passent ; celui qui échoue est signalé et renvoyé au contrôle suivant
      const envoyerTout = async (items: Array<Record<string, unknown>>): Promise<Map<number, string>> => {
        const echecs = new Map<number, string>();
        if (!items.length) return echecs;
        const un = (x: Array<Record<string, unknown>>) => avecDelai(envoyer(app, x, cle), ENVOI_DELAI_MS, "/anime/bulk : pas de reponse en 5 min");
        try {
          await un(items);
        } catch (e: any) {
          if (!/^\/anime\/bulk : HTTP \d+/.test(String(e?.message))) throw e;
          for (const x of items) {
            await un([x]).catch((err: any) => {
              echecs.set(Number(x.anilistId), String(err?.message ?? err));
            });
          }
        }
        return echecs;
      };

      const avant = await enBase(pool, series);
      const nouvelles = series.filter((e) => !avant.has(Number(e.anilistId)));
      bilan.dejaLa = series.length - nouvelles.length;
      const bloquees = await bloqueesParLaListe(pool, nouvelles);
      const envois: Array<Record<string, unknown>> = [];
      const vus = new Map<string, string>(); // clé de doublon -> titre déjà envoyé à ce passage
      for (const e of nouvelles) {
        const al = Number(e.anilistId);
        const t = String(e.titleEnglish || e.title);
        if (bloquees.has(al)) {
          // supprimé ou fusionné à la main : signalé seulement s'il passe cette semaine (épisodes absents de « Cette semaine »)
          bilan.bloquees.push(t);
          if (origineDe.get(al) === "semaine") {
            signaler(`bloquee:${al}`, `« ${t} » (AniList ${al}) passe cette semaine mais la liste de blocage l'arrête (supprimé ou fusionné à la main) : épisodes absents de « Cette semaine »`);
          }
          continue;
        }
        if (envois.length >= ENVOIS_MAX) {
          // revu au contrôle suivant : ses signalements en cours sont gardés
          for (const f of ["envoi", "homonyme", "refusee", "fusion"]) if (connus.has(`${f}:${al}`)) signaler(`${f}:${al}`, connus.get(`${f}:${al}`)!.libelle);
          continue;
        }
        const h = await homonyme(pool, e);
        const k = clesDeDoublon(e);
        const deja = h ? null : k.cherchees.map((x) => vus.get(x)).find(Boolean);
        if (h || deja) {
          bilan.homonymes.push(t);
          signaler(
            `homonyme:${al}`,
            h
              ? `« ${t} » (AniList ${al}) pas entré : /anime/bulk le prendrait pour la fiche « ${h.titre} » (#${h.id}, AniList ${h.al || "aucun"}) et la remplacerait (même titre, ou même date) : à vérifier`
              : `« ${t} » (AniList ${al}) pas entré : même titre (ou même date) que « ${deja} », entré au même contrôle : à vérifier`
          );
          continue;
        }
        for (const x of k.gardees) vus.set(x, t);
        envois.push(e);
      }

      const echecs = await envoyerTout(envois);
      const apres = await enBase(pool, envois);
      for (const e of envois) {
        const al = Number(e.anilistId);
        const a = apres.get(al);
        const t = String(e.titleEnglish || e.title);
        const echec = echecs.get(al);
        if (!a && echec) {
          bilan.echecs.push(t);
          signaler(`envoi:${al}`, `« ${t} » (AniList ${al}) : ${echec.slice(0, 160)} ; nouvel essai au prochain contrôle`);
        } else if (!a) {
          bilan.refusees.push(t);
          signaler(`refusee:${al}`, `« ${t} » (AniList ${al}) introuvable en base après l'envoi à /anime/bulk (refusé, ou rattaché à une autre fiche)`);
        } else if (parId.has(a.id)) {
          // /anime/bulk l'a reconnu dans une fiche existante : complétée ; si cette fiche portait un autre identifiant
          // AniList, il vient d'être remplacé : à vérifier
          const ancien = parId.get(a.id)!;
          if (ancien.al && ancien.al !== al) {
            bilan.fusions.push(t);
            signaler(`fusion:${al}`, `« ${t} » (AniList ${al}) rattaché par /anime/bulk à la fiche « ${ancien.titre} » (#${a.id}, AniList ${ancien.al} jusque-là) : fusion à vérifier`);
          } else bilan.dejaLa++;
        } else bilan.entrees.push({ id: a.id, titre: a.titre || t, plateforme: a.plateforme, origine: origineDe.get(al) ?? "fenetre" });
      }

      // les masqués de la semaine qu'AniList met désormais sur une de nos plateformes : /anime/bulk les complète, s'il
      // ne peut prendre que leur fiche (aucune autre ne lui ressemble, pas de liste de blocage)
      const majs: Array<{ x: Ligne; e: Record<string, unknown> }> = [];
      const aMettre = majPlateformes.slice(0, 20).map(({ x, m }) => ({ x, e: versEnvoi(m) })).filter((y): y is { x: Ligne; e: Record<string, unknown> } => !!y.e && !horsRegles(y.e));
      const bloqueesMaj = await bloqueesParLaListe(pool, aMettre.map((y) => y.e));
      for (const { x, e } of aMettre) {
        const al = Number(e.anilistId);
        if (bloqueesMaj.has(al)) {
          bilan.bloquees.push(x.titre);
          continue;
        }
        const h = await homonyme(pool, e, x.id, true);
        if (h) {
          bilan.homonymes.push(x.titre);
          signaler(`homonyme:${al}`, `« ${x.titre} » (#${x.id}) : plateforme pas ajoutée, /anime/bulk pourrait mettre à jour la fiche « ${h.titre} » (#${h.id}) à sa place (même titre, même date ou même identifiant) : à vérifier`);
          continue;
        }
        majs.push({ x, e });
      }
      const echecsMaj = await envoyerTout(majs.map((y) => y.e));
      for (const { x, e } of majs) {
        const al = Number(e.anilistId);
        const r: any[] = await pool.query("SELECT TRIM(IFNULL(platform, '')) AS p FROM anime_items WHERE id = ? AND anilist_id = ?", [x.id, al]);
        const p = String(r?.[0]?.p ?? "");
        if (p) bilan.plateformes.push(`« ${x.titre} » (#${x.id}) : ${p}`);
        else {
          bilan.echecs.push(x.titre);
          signaler(`envoi:${al}`, `« ${x.titre} » (#${x.id}) : plateforme d'AniList (${String(e.platform ?? "")}) non enregistrée${echecsMaj.has(al) ? " : " + String(echecsMaj.get(al)).slice(0, 120) : ""} ; nouvel essai au prochain contrôle`);
        }
      }
      entreesFaites = true;
    } catch (e: any) {
      erreur("envoi", e);
    }
  }
  // les familles liées aux entrées ne sont évaluées que si tout a été lu (sinon un signalement en cours sortirait de
  // la table, et l'anime serait renvoyé et signalé de nouveau)
  if (entreesFaites && anilistLu && (semaineLue || !jeton)) for (const f of ["bloquee", "refusee", "fusion", "homonyme", "envoi"]) evalues.add(f);

  // ── 3. routes déjà portées par un autre anime (le passage des routes ne pose rien pour elles)
  if (jeton) {
    const sansRoute = catalogue.filter((x) => !x.route && x.al > 0);
    if (sansRoute.length) {
      const res = await routesParIdentifiant("anilist", sansRoute.map((x) => x.al), jeton);
      for (const x of sansRoute) {
        for (const r of res.routes.get(x.al) ?? []) {
          const p = (parRoute.get(r) ?? [])[0];
          if (!p) continue;
          const lib = `Route « ${r} » portée par « ${p.titre} » (#${p.id}${p.al ? `, AniList ${p.al}` : ""}) ; AnimeSchedule la donne à « ${x.titre} » (#${x.id}, AniList ${x.al}) : ${p.al === x.al ? "doublon en base" : "route fausse"}`;
          bilan.conflits.push(lib);
          signaler(`conflit:${r}`, lib);
        }
      }
      if (res.erreur) erreur("AnimeSchedule", res.erreur);
      else evalues.add("conflit");
    } else evalues.add("conflit");
  }

  // ── un contrôle incomplet deux fois de suite (source illisible) : signalé au deuxième
  for (const [source, m] of erreursPar) signaler(`erreur:${source}`, `Contrôle des données incomplet deux fois de suite : ${m.slice(0, 200)}`);
  evalues.add("erreur");

  // ── signalements : chaque problème une fois (une alerte non reçue repart) ; un problème réglé sort de la table
  // (il sera signalé s'il revient)
  const famille = (k: string) => k.slice(0, k.indexOf(":"));
  const estEvalue = (k: string) => evalues.has(k) || evalues.has(famille(k));
  const aAlerter = [...problemes].filter(([k]) => !connus.get(k)?.envoye && (famille(k) !== "erreur" || connus.has(k)));
  if (tableOk) {
    let ko = 0;
    for (const [k, lib] of problemes) {
      await pool
        .query("INSERT INTO controle_signalements (cle, libelle) VALUES (?, ?) ON DUPLICATE KEY UPDATE libelle = VALUES(libelle), dernier = NOW()", [k, lib.slice(0, 500)])
        .catch((e: any) => {
          if (!ko++) erreur("base", "signalements : " + String(e?.message ?? e).slice(0, 120));
        });
    }
    for (const k of [...connus.keys()].filter((k) => !problemes.has(k) && estEvalue(k))) {
      await pool.query("DELETE FROM controle_signalements WHERE cle = ?", [k]).catch(() => {});
    }
  }
  if (!tableOk) {
    for (const k of [...signalesEnMemoire.keys()]) if (!problemes.has(k) && estEvalue(k)) signalesEnMemoire.delete(k);
    for (const [k, lib] of problemes) signalesEnMemoire.set(k, { libelle: lib, envoye: signalesEnMemoire.get(k)?.envoye ?? false });
  }
  const recues = await discord(process.env.DISCORD_WEBHOOK_ERRORS, "⚠️ Données à vérifier", aAlerter.map(([, l]) => "• " + l), 15158332);
  const livrees = aAlerter.slice(0, recues).map(([k]) => k);
  if (livrees.length) {
    if (tableOk) {
      await pool
        .query(`UPDATE controle_signalements SET envoye = 1 WHERE cle IN (${livrees.map(() => "?").join(",")})`, livrees)
        .catch((e: any) => erreur("base", "signalements : " + String(e?.message ?? e).slice(0, 120)));
    } else for (const k of livrees) signalesEnMemoire.set(k, { libelle: problemes.get(k) ?? "", envoye: true });
  }
  bilan.problemes = problemes.size;
  bilan.signales = aAlerter.slice(0, recues).map(([, l]) => l);
  bilan.nonEnvoyees = aAlerter.slice(recues).map(([, l]) => l);

  // ── les réparations, au fil des workflows
  const titres: string[] = [];
  if (bilan.entrees.length) titres.push(`${pl(bilan.entrees.length, "anime entré", "animes entrés")} en base`);
  if (bilan.routes.length) titres.push(pl(bilan.routes.length, "route posée", "routes posées"));
  if (bilan.plateformes.length) titres.push(pl(bilan.plateformes.length, "plateforme ajoutée", "plateformes ajoutées"));
  await discord(
    process.env.DISCORD_WEBHOOK_WORKFLOWS,
    `✅ ${titres.join(", ")}`,
    [
      ...bilan.entrees.map((e) => `• ${e.titre} — ${e.plateforme || "à venir, plateforme non annoncée"}${e.origine === "semaine" ? " (« Cette semaine »)" : ""}`),
      ...bilan.routes.map((r) => `• Route : ${r}`),
      ...bilan.plateformes.map((p) => `• Plateforme : ${p}`),
    ],
    3066993
  );
}

/** Le contrôle chaque jour à 5 h 30 UTC, et 20 min après le démarrage s'il n'a pas tourné depuis. Jamais deux à la fois. */
export function startControleDonnees(app: FastifyInstance): void {
  // Pilotage (pilotage.ts) : un seul passage à la fois (verrou du planificateur ; GET_LOCK pour ceux lancés ailleurs)
  planifier({
    id: "controle-donnees", premierMs: PREMIER_MS, heuresUtc: [HEURE_UTC + MINUTE_UTC / 60], suivi: "controle-donnees", actifParDefaut: configControle().actif,
    passage: async () => {
      await passageControle(app);
    },
  });
  app.log.info("controle des donnees : planifie (20 min apres le demarrage, puis chaque jour a 5 h 30 UTC)");
}
