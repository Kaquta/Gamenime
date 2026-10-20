/**
 * europe.ts — Bonus européen : l'intérêt des lecteurs européens de Wikipédia pour chaque anime.
 *
 * Décision de Rey (12 octobre 2026, « Oui pour le bonus ») : AniList reste la base de la
 * popularité ; un bonus tiré des pages vues de Wikipédia en français, allemand, italien et
 * espagnol s'y ajoute. Relevé du 12 octobre (releve-europe.sh) : 320 animes sur 439 ont au
 * moins un article dans ces langues, le plus souvent par leur œuvre d'origine (le manga).
 *
 * Un passage par jour (contrôle 40 min après le démarrage, puis toutes les heures, jamais entre
 * h:56 et h:04 où n8n interroge AniList : un passage si le dernier date de plus de 23 h) :
 *  1. AniList : saisons précédentes (PREQUEL, PARENT, 3 crans) et œuvre d'origine (SOURCE,
 *     manga ou light novel ; AniList ne connaît pas les jeux vidéo, aucun n'est donc pris).
 *     L'identifiant MyAnimeList est celui qu'AniList donne ; celui de la base ne sert qu'à défaut.
 *  2. Wikidata : fiches par identifiant AniList (P8729, P8731) ou MyAnimeList (P4086, P4087),
 *     la série dont elles font partie (P179), et leurs articles dans les langues retenues.
 *  3. Wikimedia : pages vues des 30 derniers jours complets (lecteurs humains) de chaque article
 *     candidat, une requête à la fois ; d'abord les animes de la fenêtre du site, les plus populaires
 *     en tête (2 500 articles et 25 min au plus). Lecture arrêtée si Wikimedia demande d'attendre ou
 *     échoue 10 fois de suite : les animes non lus gardent leurs valeurs, relus 6 h plus tard.
 *  4. Par langue, l'article le plus lu parmi les candidats (fiche de l'anime, sa série, saisons
 *     précédentes, œuvre d'origine) : un article de saison peu lu ne cache pas celui de la série.
 *     Total pondéré : fr, de, it × 1 ; es × 0,25 (es.wikipedia est surtout lue en Amérique latine).
 *  5. bonus = arrondi(40 × log10(1 + vues/100)) : 1 000 vues → 42 ; 10 000 → 80 ; 100 000 → 120.
 *     Il s'ajoute au score des classements d'animes (core.ts, computeGameNimeScore) ; les listes
 *     qui mêlent animes et jeux s'en passent (sansBonusEurope). Les jeux ont le leur (plus bas).
 *
 * Écrit europe_vues, europe_bonus, europe_detail (article et vues par langue) et europe_le, sans
 * toucher updated_at. Un anime dont un article n'a pas pu être lu garde ses valeurs. AniList ou
 * Wikidata en panne (réponse en erreur ou incomplète) : rien n'est écrit, nouvel essai 6 h plus
 * tard. Un verrou de la base (GET_LOCK) garantit un seul passage à la fois, y compris celui que
 * lance l'installateur. Au démarrage, le bonus est recalculé depuis europe_detail (un réglage
 * changé s'applique tout de suite).
 *
 * JEUX (décision de Rey du 14 octobre 2026, après le relevé releve-europe-jeux.sh : « Ok ») : le même
 * bonus, ajouté au score des classements de jeux, avec l'article du jeu lui-même et jamais celui de sa
 * série (règle A : l'article d'une licence gonflerait une suite ou une réédition). Un passage par jour,
 * séparé de celui des animes mais sous le même verrou (contrôle 55 min après le démarrage, puis toutes
 * les heures : un passage si le dernier date de plus de 23 h) :
 *  1. les jeux que les flux peuvent montrer (fenêtre large, DB_DATE_RANGE_YEARS autour de l'année ;
 *     jaquette et titre ; les MAX_DB_FETCH plus populaires), ceux de l'année courante et des suivantes
 *     d'abord, les plus populaires en tête ;
 *  2. IGDB : le nom court (slug) de chaque jeu, que Wikidata range sous « IGDB game ID » (P5794) ;
 *  3. Wikidata : la fiche du jeu par ce nom court ; à défaut par sa page Steam (P1733, table
 *     jeux_steam), seulement une page que steam-jeux.ts a lue et reconnue (une page Steam peut être
 *     une réédition, ou un candidat pas encore vérifié) ; puis ses articles dans les langues retenues ;
 *  4. Wikipédia : pages vues par paquets de 50 articles (API de chaque Wikipédia, prop=pageviews : les
 *     mêmes chiffres que l'API des pages vues, vérifié sur 20 articles le 14 octobre), sur la même
 *     fenêtre de 30 jours ; par langue, le plus lu des articles du jeu (s'il a plusieurs fiches) ;
 *  5. même formule ; force EUROPE_JEUX_POIDS (celle des animes par défaut).
 * IGDB (réponse en erreur, ou noms courts pour moins de 80 % des jeux) ou Wikidata en panne : rien n'est
 * écrit, nouvel essai 6 h plus tard. Un paquet d'articles illisible : ses jeux gardent leurs valeurs.
 * Les listes qui mêlent animes et jeux restent sans bonus (sansBonusEurope). Les badges ne le prennent
 * pas (popularité seule). Interrupteur des jeux seuls : EUROPE_JEUX_ENABLED (« 0 » : bonus des jeux
 * retiré, rien n'est lu) ; EUROPE_ENABLED à « 0 » coupe les deux.
 *
 * Variables : EUROPE_ENABLED (« 0 » : bonus retiré, rien n'est lu ; actif sinon), EUROPE_POIDS
 * (40), EUROPE_LANGUES (« fr:1,de:1,it:1,es:0.25 »), EUROPE_JEUX_ENABLED, EUROPE_JEUX_POIDS ; les
 * *_URL et les pauses servent aux tests.
 */
import { setInterval, setTimeout } from "node:timers";
import { DB_DATE_RANGE_YEARS, MAX_DB_FETCH } from "./constants.js";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { interrupteur, planifier } from "./pilotage.js";
import type { Journal, SqlPool } from "./presse.js";
import { igdbFetch } from "./twitch.js";

const PREMIER_CONTROLE_MS = 40 * 60 * 1000;
const CONTROLE_MS = 60 * 60 * 1000;
/** Un contrôle qui tomberait entre h:56 et h:04 (n8n et AniList) est décalé d'autant. */
const DECALAGE_MS = 10 * 60 * 1000;
const APRES_ECHEC_MS = 6 * 60 * 60 * 1000;
/** Attente demandée (Retry-After) au-delà de laquelle on renonce au lieu d'attendre. */
const ATTENTE_MAX_MS = 90 * 1000;
const AGENT = "GameNime/1.0 (https://gamenime.fr; popularite europeenne) Node.js";
const PROPS = { anime: "P8729", manga: "P8731", malAnime: "P4086", malManga: "P4087", serie: "P179" } as const;
const CRANS = 3;
const ERREURS_DE_SUITE_MAX = 10;
const VERROU = "gamenime_bonus_europe";
/** Jeux : « IGDB game ID » (nom court) et « Steam application ID » ; le premier contrôle, 15 min après celui des animes. */
const PROPS_JEUX = { igdb: "P5794", steam: "P1733" } as const;
const PREMIER_CONTROLE_JEUX_MS = 55 * 60 * 1000;
/** Une réponse d'IGDB qui donne le nom court de moins de 80 % des jeux demandés est tenue pour incomplète. */
const IGDB_COMPLET = 0.8;
/** Une page Steam ne mène à la fiche d'un jeu que si steam-jeux.ts l'a lue et reconnue (titre du jeu) : pas une
 * page d'un autre titre, pas une page qui n'est pas un jeu, absente ou pas encore lue (candidat à vérifier). */
const STEAM_RECONNUE = "ok";
const NOM_COURT = /^[a-z0-9][a-z0-9-]*$/;

interface Connexion {
  query: (sql: string, params?: unknown[]) => Promise<any>;
  release: () => unknown;
  destroy?: () => unknown;
}

export interface EuropeDeps {
  /** Le pool mariadb de l'API ; getConnection sert au verrou (sans elle, pas de verrou). */
  pool: SqlPool & { getConnection?: () => Promise<Connexion> };
  log: Journal;
  /** Vide le cache des flux de l'API après écriture. */
  rafraichir?: () => void;
  /** Appel à IGDB (jeux) : igdbFetch par défaut, avec le jeton Twitch partagé de l'API. */
  igdb?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface EuropeConfig {
  anilistUrl: string;
  wdqsUrl: string;
  pvUrl: string;
  pauseAniListMs: number;
  pauseWdqsMs: number;
  pausePvMs: number;
  /** Attente avant un nouvel essai (429, 503, coupure) quand le service ne la donne pas. */
  attenteMs: number;
  /** Force du bonus (W). */
  poids: number;
  /** Langues retenues et leur poids dans le total. */
  langues: Array<[string, number]>;
  /** Articles lus au plus par passage. */
  maxArticles: number;
  /** Durée au-delà de laquelle la lecture des pages vues s'arrête (depuis le début du passage). */
  dureeMaxMs: number;
  /** Jeux : adresse d'IGDB (games), API de chaque Wikipédia (« {lang} » remplacé par la langue). */
  igdbUrl: string;
  wikiUrl: string;
  pauseIgdbMs: number;
  pauseWikiMs: number;
  /** Wikipédia en retard de réplication (maxlag) : attente avant l'unique nouvel essai. */
  attenteMaxlagMs: number;
  /** Force du bonus des jeux (W). */
  poidsJeux: number;
}

const POIDS_DEFAUT = 40;
const LANGUES_DEFAUT: Array<[string, number]> = [["fr", 1], ["de", 1], ["it", 1], ["es", 0.25]];

/** « fr:1,de:1,it:1,es:0.25 » ; une valeur mal formée donne le réglage par défaut. */
export function lireLangues(texte: string | undefined): Array<[string, number]> {
  if (!texte || !texte.trim()) return LANGUES_DEFAUT;
  const res: Array<[string, number]> = [];
  for (const morceau of texte.split(",")) {
    const m = morceau.trim().match(/^([a-z]{2,3}):(\d+(?:\.\d+)?)$/);
    if (!m) return LANGUES_DEFAUT;
    const p = Number(m[2]);
    if (!(p >= 0 && p <= 1) || res.some(([l]) => l === m[1])) return LANGUES_DEFAUT;
    res.push([m[1], p]);
  }
  return res.length ? res : LANGUES_DEFAUT;
}

/** Force lue dans une variable : un nombre de 0 à 200, sinon `defaut`. */
function lirePoids(v: string | undefined, defaut: number): number {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 200 ? n : defaut;
}

export function configEurope(env: Record<string, string | undefined> = process.env): EuropeConfig {
  const poids = lirePoids(env["EUROPE_POIDS"], POIDS_DEFAUT);
  return {
    anilistUrl: env["ANILIST_URL"] || "https://graphql.anilist.co",
    wdqsUrl: env["EUROPE_WDQS_URL"] || "https://query.wikidata.org/sparql",
    pvUrl: env["EUROPE_PV_URL"] || "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article",
    // AniList : ~30 requêtes par passage, partagées avec les autres cycles de l'API et n8n (limite 30/min)
    pauseAniListMs: 4000,
    pauseWdqsMs: 1000,
    pausePvMs: 350,
    attenteMs: 30000,
    poids,
    langues: lireLangues(env["EUROPE_LANGUES"]),
    maxArticles: 2500,
    dureeMaxMs: 25 * 60 * 1000,
    igdbUrl: env["EUROPE_IGDB_URL"] || "https://api.igdb.com/v4/games",
    wikiUrl: env["EUROPE_WIKI_URL"] || "https://{lang}.wikipedia.org/w/api.php",
    // IGDB : 4 requêtes par seconde au plus, partagées avec les cycles des jeux ; 2 à 3 requêtes par passage
    pauseIgdbMs: 500,
    pauseWikiMs: 300,
    attenteMaxlagMs: 5000,
    poidsJeux: lirePoids(env["EUROPE_JEUX_POIDS"], poids),
  };
}

/** Vues pondérées et bonus. */
export function vuesEurope(detail: Record<string, { v: number }>, langues: Array<[string, number]>): number {
  return Math.round(langues.reduce((s, [l, p]) => s + p * (Number(detail[l]?.v) || 0), 0));
}
export function bonusEurope(vues: number, poids: number): number {
  return Math.round(poids * Math.log10(1 + Math.max(0, vues) / 100));
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => String((e as any)?.cause?.code || (e as Error)?.message || e).slice(0, 160);

/** Attente demandée par Retry-After (secondes ou date HTTP), en ms ; null si absente ou illisible. */
export function attenteDemandee(entete: string | null, maintenant: number = Date.now()): number | null {
  if (!entete || !entete.trim()) return null;
  const s = Number(entete);
  if (Number.isFinite(s)) return Math.max(0, s) * 1000;
  const t = Date.parse(entete);
  return Number.isFinite(t) ? Math.max(0, t - maintenant) : null;
}

/**
 * Une requête ; un seul nouvel essai après une coupure, un 429 ou un 503, après l'attente demandée
 * (Retry-After, 5 s au moins). Une attente demandée de plus de 90 s n'est pas faite : la réponse
 * (429 ou 503) est rendue telle quelle et l'appelant renonce.
 */
async function appel(cfg: EuropeConfig, url: string, options: RequestInit, nom: string): Promise<Response> {
  for (let essai = 0; essai < 2; essai++) {
    let r: Response;
    try {
      r = await fetch(url, { ...options, headers: { "User-Agent": AGENT, ...((options.headers as Record<string, string>) ?? {}) }, signal: AbortSignal.timeout(75000) });
    } catch (e) {
      if (essai === 0) {
        await dormir(cfg.attenteMs);
        continue;
      }
      throw new Error(`${nom} injoignable (${message(e)})`);
    }
    if ((r.status === 429 || r.status === 503) && essai === 0) {
      const ms = attenteDemandee(r.headers.get("retry-after"));
      if (ms != null && ms > ATTENTE_MAX_MS) return r;
      await r.body?.cancel().catch(() => {});
      await dormir(ms != null ? Math.max(ms, 5000) : cfg.attenteMs);
      continue;
    }
    return r;
  }
  throw new Error(`${nom} : pas de réponse`);
}

// ── AniList : saisons précédentes et œuvre d'origine

export interface Relations {
  mal: number | null;
  precedentes: Array<{ id: number; mal: number | null }>;
  sources: Array<{ id: number; mal: number | null }>;
}

const REQ_RELATIONS =
  "query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id idMal relations { edges { relationType(version: 2) node { id idMal type } } } } } }";

/**
 * Relations d'animes AniList (paquets de 25, réduits si AniList trouve la requête trop complexe).
 * Lève une erreur sinon, y compris pour une réponse qui porte des erreurs ou des relations manquantes :
 * une réponse partielle ferait perdre des candidats et baisser des bonus à tort.
 */
export async function relationsAniList(cfg: EuropeConfig, ids: number[], compteur = { n: 0 }): Promise<Map<number, Relations>> {
  const res = new Map<number, Relations>();
  let taille = 25;
  for (let i = 0; i < ids.length; ) {
    const paquet = ids.slice(i, i + taille);
    if (compteur.n++) await dormir(cfg.pauseAniListMs);
    const r = await appel(
      cfg,
      cfg.anilistUrl,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query: REQ_RELATIONS, variables: { ids: paquet } }) },
      "AniList"
    );
    const d: any = await r.json().catch(() => null);
    const media = d?.data?.Page?.media;
    const enErreur = Array.isArray(d?.errors) && d.errors.length > 0;
    if (!r.ok || enErreur || !Array.isArray(media) || media.some((m: any) => !Number(m?.id) || !Array.isArray(m?.relations?.edges))) {
      const msg = String(d?.errors?.[0]?.message || (r.ok ? "réponse incomplète" : `HTTP ${r.status}`)).slice(0, 120);
      if (/complex/i.test(msg) && taille > 5) {
        taille = Math.ceil(taille / 2);
        continue;
      }
      throw new Error("AniList : " + msg);
    }
    for (const m of d.data.Page.media) {
      const rel: Relations = { mal: Number(m?.idMal) || null, precedentes: [], sources: [] };
      for (const e of m?.relations?.edges ?? []) {
        const n = e?.node;
        const id = Number(n?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const x = { id, mal: Number(n?.idMal) || null };
        if (n.type === "ANIME" && (e.relationType === "PREQUEL" || e.relationType === "PARENT")) rel.precedentes.push(x);
        if (n.type === "MANGA" && e.relationType === "SOURCE") rel.sources.push(x);
      }
      res.set(Number(m.id), rel);
    }
    i += paquet.length;
  }
  return res;
}

// ── Wikidata (SPARQL)

async function sparql(cfg: EuropeConfig, requete: string, compteur: { n: number }): Promise<any[]> {
  if (compteur.n++) await dormir(cfg.pauseWdqsMs);
  const r = await appel(
    cfg,
    cfg.wdqsUrl,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" }, body: new URLSearchParams({ query: requete }).toString() },
    "Wikidata"
  );
  const d: any = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(d?.results?.bindings)) throw new Error(`Wikidata : HTTP ${r.status}${d ? "" : " (réponse illisible)"}`);
  return d.results.bindings;
}
const entite = (b: any): string => String(b?.value ?? "").replace(/^.*\/entity\//, "");
const estQ = (x: string) => /^Q\d+$/.test(x);

async function parPaquets<T>(liste: T[], taille: number, f: (paquet: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < liste.length; i += taille) await f(liste.slice(i, i + taille));
}

/** Fiches Wikidata qui portent ces valeurs d'une propriété : valeur -> [Q…]. */
export async function fichesWikidata(cfg: EuropeConfig, prop: string, valeurs: Array<string | number>, compteur = { n: 0 }): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  const liste = [...new Set(valeurs.map(String))].filter((v) => /^\d+$/.test(v));
  await parPaquets(liste, 200, async (paquet) => {
    const vals = paquet.map((v) => `"${v}"`).join(" ");
    for (const b of await sparql(cfg, `SELECT ?cle ?item WHERE { VALUES ?cle { ${vals} } ?item wdt:${prop} ?cle . }`, compteur)) {
      const k = String(b?.cle?.value ?? "");
      const it = entite(b?.item);
      if (estQ(it)) res.set(k, [...(res.get(k) ?? []), it]);
    }
  });
  return res;
}

/** Série (P179) de fiches Wikidata : Q -> [Q série]. */
export async function seriesWikidata(cfg: EuropeConfig, items: string[], compteur = { n: 0 }): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  await parPaquets([...new Set(items)].filter(estQ), 200, async (paquet) => {
    for (const b of await sparql(cfg, `SELECT ?item ?serie WHERE { VALUES ?item { ${paquet.map((x) => "wd:" + x).join(" ")} } ?item wdt:${PROPS.serie} ?serie . }`, compteur)) {
      const k = entite(b?.item);
      const s = entite(b?.serie);
      if (estQ(k) && estQ(s)) res.set(k, [...(res.get(k) ?? []), s]);
    }
  });
  return res;
}

/** Articles Wikipédia de fiches Wikidata dans ces langues : Q -> {fr: titre, …}. */
export async function articlesWikidata(cfg: EuropeConfig, items: string[], langues: string[], compteur = { n: 0 }): Promise<Map<string, Record<string, string>>> {
  const res = new Map<string, Record<string, string>>();
  const wikis = langues.map((l) => `(<https://${l}.wikipedia.org/> "${l}")`).join(" ");
  await parPaquets([...new Set(items)].filter(estQ), 200, async (paquet) => {
    for (const b of await sparql(
      cfg,
      `SELECT ?item ?lang ?titre WHERE { VALUES ?item { ${paquet.map((x) => "wd:" + x).join(" ")} } VALUES (?wiki ?lang) { ${wikis} } ?article schema:about ?item ; schema:isPartOf ?wiki ; schema:name ?titre . }`,
      compteur
    )) {
      const k = entite(b?.item);
      const l = String(b?.lang?.value ?? "");
      const t = String(b?.titre?.value ?? "");
      if (estQ(k) && langues.includes(l) && t) res.set(k, { ...(res.get(k) ?? {}), [l]: t });
    }
  });
  return res;
}

/** Fiches Wikidata par nom court IGDB (« IGDB game ID », texte) : nom court -> [Q…]. */
export async function fichesParNomCourt(cfg: EuropeConfig, noms: string[], compteur = { n: 0 }): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  await parPaquets([...new Set(noms)].filter((v) => NOM_COURT.test(v)), 200, async (paquet) => {
    for (const b of await sparql(cfg, `SELECT ?cle ?item WHERE { VALUES ?cle { ${paquet.map((v) => `"${v}"`).join(" ")} } ?item wdt:${PROPS_JEUX.igdb} ?cle . }`, compteur)) {
      const k = String(b?.cle?.value ?? "");
      const it = entite(b?.item);
      if (estQ(it) && !(res.get(k) ?? []).includes(it)) res.set(k, [...(res.get(k) ?? []), it]);
    }
  });
  return res;
}

// ── IGDB : le nom court (slug) des jeux

/**
 * Noms courts IGDB des jeux, par paquets de 500 : identifiant IGDB -> nom court. Comme igdb-jeux.ts, une
 * coupure est réessayée 2 fois et un 429 3 fois (attente croissante : IGDB est partagé avec les cycles des
 * jeux). Lève une erreur si IGDB répond en erreur, ou donne le nom court de moins de 80 % des jeux demandés
 * (réponse incomplète : des jeux perdraient leur fiche, et leur bonus, à tort).
 */
export async function nomsCourtsIgdb(cfg: EuropeConfig, ids: number[], appelIgdb: (url: string, init: RequestInit) => Promise<Response>, compteur = { n: 0 }): Promise<Map<number, string>> {
  const res = new Map<number, string>();
  const liste = [...new Set(ids)].filter((x) => Number.isInteger(x) && x > 0);
  for (let i = 0; i < liste.length; i += 500) {
    const paquet = liste.slice(i, i + 500);
    let r: Response;
    for (let essai = 0; ; essai++) {
      if (compteur.n++) await dormir(cfg.pauseIgdbMs);
      try {
        r = await appelIgdb(cfg.igdbUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Accept: "application/json", "User-Agent": AGENT },
          body: `fields slug; where id = (${paquet.join(",")}); limit 500;`,
        });
      } catch (e) {
        if (essai < 2) {
          await dormir(cfg.attenteMs);
          continue;
        }
        throw new Error(`IGDB injoignable (${message(e)})`);
      }
      if (r.status === 429 && essai < 3) {
        await r.body?.cancel().catch(() => {});
        await dormir(cfg.attenteMs * (essai + 1));
        continue;
      }
      break;
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d)) throw new Error(`IGDB : HTTP ${r.status}${d ? "" : " (réponse illisible)"}`);
    for (const g of d) if (Number(g?.id) > 0 && typeof g?.slug === "string" && NOM_COURT.test(g.slug)) res.set(Number(g.id), g.slug);
  }
  if (liste.length && res.size < IGDB_COMPLET * liste.length) throw new Error(`IGDB : réponse incomplète (${res.size} noms courts pour ${liste.length} jeux)`);
  return res;
}

// ── Wikipédia : pages vues par paquets de 50 articles (jeux)

const tiret = (j: string) => `${j.slice(0, 4)}-${j.slice(4, 6)}-${j.slice(6, 8)}`;

/**
 * Vues d'articles d'une langue sur la fenêtre, par paquets de 50 (API de Wikipédia, prop=pageviews) :
 * titre -> vues ; 0 pour une page qui n'existe pas ; null si le paquet n'a pas pu être lu. Wikipédia peut
 * réussir la requête mais échouer pour certains titres : il le signale (warnings.pageviews) et rend ces
 * titres sans aucun chiffre, comme une page jamais lue ; ils comptent alors comme non lus (null), pour que
 * leurs jeux gardent leurs valeurs au lieu de tomber à 0. Un retard de
 * réplication (maxlag) attend puis réessaie une fois. La lecture s'arrête, avec son motif (`arret`), si
 * Wikipédia demande d'attendre (429 après le nouvel essai, ou 503 avec plus de 90 s d'attente demandée),
 * après 10 paquets en échec de suite, ou quand `avant` (appelé avant chaque paquet : la durée) rend un
 * motif ; les titres non lus restent absents, ceux déjà lus sont rendus.
 */
export async function vuesParPaquets(
  cfg: EuropeConfig,
  lang: string,
  titres: string[],
  f: { debut: string; fin: string },
  compteur = { n: 0 },
  avant?: () => string | null
): Promise<{ vues: Map<string, number | null>; arret?: string }> {
  const vues = new Map<string, number | null>();
  const debut = tiret(f.debut);
  const fin = tiret(f.fin);
  const url = cfg.wikiUrl.replace("{lang}", lang);
  const demander = async (params: Record<string, string>) => {
    if (compteur.n++) await dormir(cfg.pauseWikiMs);
    const r = await appel(cfg, url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(params).toString() }, "Wikipédia");
    if (r.status === 429 || (r.status === 503 && (attenteDemandee(r.headers.get("retry-after")) ?? 0) > ATTENTE_MAX_MS)) {
      await r.body?.cancel().catch(() => {});
      throw new ArretWikimedia(`Wikipédia (${lang}) demande d'attendre (${r.status})`);
    }
    const d: any = await r.json().catch(() => null);
    return { ok: r.ok, d };
  };
  const liste = [...new Set(titres)];
  let deSuite = 0;
  for (let i = 0; i < liste.length; i += 50) {
    const motif = avant?.() ?? (deSuite >= ERREURS_DE_SUITE_MAX ? `${ERREURS_DE_SUITE_MAX} paquets en échec de suite (${lang})` : null);
    if (motif) return { vues, arret: motif };
    const paquet = liste.slice(i, i + 50);
    const jours = new Map<string, { manque: boolean; v: Record<string, number | null> }>();
    const normal = new Map(paquet.map((t) => [t, t]));
    let suite: Record<string, string> = {};
    let ok = true;
    let avertis = false;
    for (let tour = 0; tour < 20; tour++) {
      const params = { action: "query", prop: "pageviews", pvipdays: "40", titles: paquet.join("|"), format: "json", formatversion: "2", maxlag: "5", ...suite };
      let rep: { ok: boolean; d: any };
      try {
        rep = await demander(params);
        if (rep.d?.error?.code === "maxlag") {
          await dormir(cfg.attenteMaxlagMs);
          rep = await demander(params);
        }
      } catch (e) {
        if (e instanceof ArretWikimedia) return { vues, arret: message(e) };
        ok = false;
        break;
      }
      const d = rep.d;
      if (!rep.ok || d?.error || !Array.isArray(d?.query?.pages)) {
        ok = false;
        break;
      }
      if (d?.warnings?.pageviews) avertis = true;
      for (const n of d.query.normalized ?? []) for (const [t, v] of normal) if (v === n?.from) normal.set(t, String(n.to));
      for (const p of d.query.pages) {
        const m = jours.get(String(p?.title)) ?? { manque: !!p?.missing || !!p?.invalid, v: {} };
        if (p?.pageviews && typeof p.pageviews === "object") Object.assign(m.v, p.pageviews);
        jours.set(String(p?.title), m);
      }
      if (!d.continue) break;
      suite = Object.fromEntries(Object.entries(d.continue).map(([k, v]) => [k, String(v)]));
      if (tour === 19) ok = false;
    }
    deSuite = ok ? 0 : deSuite + 1;
    for (const t of paquet) {
      const m = ok ? jours.get(normal.get(t) ?? t) : undefined;
      if (!m) {
        vues.set(t, null);
        continue;
      }
      let s = 0;
      let chiffres = 0;
      for (const [j, n] of Object.entries(m.v))
        if (j >= debut && j <= fin && n != null) {
          s += Number(n) || 0;
          chiffres++;
        }
      vues.set(t, m.manque ? 0 : avertis && chiffres === 0 ? null : s);
    }
  }
  return { vues };
}

// ── Wikimedia : pages vues

const jourUtc = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Fenêtre des 30 derniers jours complets (jusqu'à avant-hier : les chiffres de la veille arrivent en cours de journée). */
export function fenetre(maintenant: Date = new Date()): { debut: string; fin: string } {
  const fin = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()) - 2 * 86400000);
  const debut = new Date(fin.getTime() - 29 * 86400000);
  return { debut: jourUtc(debut), fin: jourUtc(fin) };
}

/** Wikimedia demande d'attendre (429 après le nouvel essai, ou 503 avec plus de 90 s d'attente demandée) : on arrête de lire. */
export class ArretWikimedia extends Error {}

/**
 * Vues d'un article sur la fenêtre ; 0 si Wikimedia n'a aucun chiffre (404) ; null si la lecture a
 * échoué. Lève ArretWikimedia si Wikimedia demande d'attendre.
 */
export async function vuesArticle(cfg: EuropeConfig, lang: string, titre: string, f: { debut: string; fin: string }): Promise<number | null> {
  let r: Response;
  try {
    const article = encodeURIComponent(titre.replace(/ /g, "_"));
    r = await appel(cfg, `${cfg.pvUrl}/${lang}.wikipedia/all-access/user/${article}/daily/${f.debut}/${f.fin}`, { headers: { Accept: "application/json" } }, "Wikimedia");
  } catch {
    return null;
  }
  if (r.status === 429 || (r.status === 503 && (attenteDemandee(r.headers.get("retry-after")) ?? 0) > ATTENTE_MAX_MS)) {
    await r.body?.cancel().catch(() => {});
    throw new ArretWikimedia(`Wikimedia demande d'attendre (${r.status})`);
  }
  if (r.status === 404) {
    await r.body?.cancel().catch(() => {});
    return 0;
  }
  const d: any = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(d?.items)) return null;
  return d.items.reduce((s: number, x: any) => s + (Number(x?.views) || 0), 0);
}

/**
 * Verrou de la base (GET_LOCK, un par base) : un seul passage à la fois, cycle de l'API ou passage
 * lancé par l'installateur. Rendu par MariaDB si le processus s'arrête (connexion fermée).
 * Rend la fonction qui le libère, ou null s'il est déjà pris ailleurs.
 */
async function prendreVerrou(pool: EuropeDeps["pool"]): Promise<(() => Promise<void>) | null> {
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
    const r = await conn.query("SELECT GET_LOCK(CONCAT(?, '.', IFNULL(DATABASE(), '')), 0) AS pris", [VERROU]);
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
      await conn.query("SELECT RELEASE_LOCK(CONCAT(?, '.', IFNULL(DATABASE(), '')))", [VERROU]);
    } catch {
      // RELEASE_LOCK impossible : fermer la connexion rend le verrou
      if (typeof conn.destroy === "function") {
        try {
          await Promise.resolve(conn.destroy());
          return;
        } catch {
          /* on la rend au pool, qui écarte les connexions perdues */
        }
      }
    }
    await rendre();
  };
}

// ── Passage

export interface PassageEurope {
  /** Animes lus en base (identifiant AniList ou MyAnimeList). */
  animes: number;
  /** Animes avec au moins un article dans les langues retenues. */
  avecArticle: number;
  /** Articles candidats lus chez Wikimedia, et lectures échouées. */
  articles: number;
  erreursArticles: number;
  /** Animes écrits ; animes gardés tels quels (un article illisible) ; bonus qui ont changé. */
  ecrits: number;
  gardes: number;
  bonusChanges: number;
  requetes: { anilist: number; wikidata: number; wikimedia: number };
  /** AniList ou Wikidata en panne : rien n'est écrit. */
  erreur?: string;
  /** Lecture des pages vues arrêtée en route (Wikimedia, durée) : les animes non lus gardent leurs valeurs. */
  arret?: string;
  /** Plafond d'articles atteint : les animes les moins populaires gardent leurs valeurs. */
  plafond?: boolean;
  /** Un autre passage tient le verrou : rien n'est fait. */
  occupe?: boolean;
}

/** Ce que le passage a calculé, pour un relevé (installateur). */
export interface DetailEurope {
  id: number;
  vues: number;
  bonus: number;
  detail: Record<string, { t: string; v: number }>;
}

interface LigneAnime {
  id: number;
  anilist_id: number | null;
  mal_id: number | null;
  europe_bonus: number | null;
}

const bilanVide = (): PassageEurope => ({ animes: 0, avecArticle: 0, articles: 0, erreursArticles: 0, ecrits: 0, gardes: 0, bonusChanges: 0, requetes: { anilist: 0, wikidata: 0, wikimedia: 0 } });

/**
 * Un passage complet, sous le verrou de la base (déjà pris ailleurs : rien n'est fait, `occupe`).
 * `releve`, s'il est donné, reçoit le résultat de chaque anime calculé.
 */
export async function passageEurope(deps: EuropeDeps, cfg: EuropeConfig = configEurope(), releve?: Map<number, DetailEurope>, progres?: (lus: number, total: number) => void): Promise<PassageEurope> {
  const liberer = await prendreVerrou(deps.pool);
  if (!liberer) return { ...bilanVide(), occupe: true };
  try {
    return await passageSousVerrou(deps, cfg, releve, progres);
  } finally {
    await liberer();
  }
}

async function passageSousVerrou(deps: EuropeDeps, cfg: EuropeConfig, releve?: Map<number, DetailEurope>, progres?: (lus: number, total: number) => void): Promise<PassageEurope> {
  const debut = Date.now();
  const ca = { n: 0 };
  const cw = { n: 0 };
  let cp = 0;
  // ceux de la fenêtre du site (année courante et suivantes, ou date inconnue) d'abord, puis les plus
  // populaires : si la lecture s'arrête en route, ce sont les moins suivis qui attendent
  const lignes: LigneAnime[] = await deps.pool.query(
    "SELECT id, anilist_id, mal_id, europe_bonus FROM anime_items WHERE (anilist_id IS NOT NULL AND anilist_id > 0) OR (mal_id IS NOT NULL AND mal_id > 0) " +
      "ORDER BY IFNULL(release_date >= MAKEDATE(YEAR(CURDATE()), 1), 1) DESC, popularity DESC, id"
  );
  const res: PassageEurope = { ...bilanVide(), animes: lignes.length };
  const fin = () => {
    res.requetes = { anilist: ca.n, wikidata: cw.n, wikimedia: cp };
    return res;
  };
  const langues = cfg.langues.map(([l]) => l);

  // 1. AniList
  let rel: Map<number, Relations>;
  try {
    const propres = lignes.map((l) => Number(l.anilist_id)).filter((x) => x > 0);
    rel = await relationsAniList(cfg, propres, ca);
    let niveau = propres;
    for (let cran = 2; cran <= CRANS; cran++) {
      const suivants = [...new Set(niveau.flatMap((id) => (rel.get(id)?.precedentes ?? []).map((p) => p.id)))].filter((id) => !rel.has(id));
      if (!suivants.length) break;
      for (const [k, v] of await relationsAniList(cfg, suivants, ca)) rel.set(k, v);
      niveau = suivants;
    }
  } catch (e) {
    res.erreur = message(e);
    return fin();
  }
  const ancetres = (id: number) => {
    const vus = new Set([id]);
    const out: Array<{ id: number; mal: number | null }> = [];
    let front = [id];
    for (let cran = 0; cran < CRANS && front.length; cran++) {
      const next: number[] = [];
      for (const x of front)
        for (const p of rel.get(x)?.precedentes ?? [])
          if (!vus.has(p.id)) {
            vus.add(p.id);
            out.push(p);
            next.push(p.id);
          }
      front = next;
    }
    return out;
  };

  // 2. Wikidata
  const cles = { anime: new Set<number>(), malAnime: new Set<number>(), manga: new Set<number>(), malManga: new Set<number>() };
  const plan = new Map<number, { al: number | null; mal: number | null; anc: Array<{ id: number; mal: number | null }>; sources: Array<{ id: number; mal: number | null }> }>();
  for (const l of lignes) {
    const al = Number(l.anilist_id) || null;
    const r = al ? rel.get(al) : undefined;
    // l'identifiant MyAnimeList d'AniList fait foi ; celui de la base (ancien rapprochement) ne sert qu'à défaut
    const mal = r ? r.mal : Number(l.mal_id) || null;
    const anc = al ? ancetres(al) : [];
    const sources = [...(r?.sources ?? []), ...anc.flatMap((p) => rel.get(p.id)?.sources ?? [])];
    plan.set(Number(l.id), { al, mal, anc, sources });
    if (al) cles.anime.add(al);
    if (mal) cles.malAnime.add(mal);
    for (const p of anc) {
      cles.anime.add(p.id);
      if (p.mal) cles.malAnime.add(p.mal);
    }
    for (const s of sources) {
      cles.manga.add(s.id);
      if (s.mal) cles.malManga.add(s.mal);
    }
  }
  let F: Record<keyof typeof cles, Map<string, string[]>>;
  let S: Map<string, string[]>;
  let A: Map<string, Record<string, string>>;
  try {
    F = {
      anime: await fichesWikidata(cfg, PROPS.anime, [...cles.anime], cw),
      malAnime: await fichesWikidata(cfg, PROPS.malAnime, [...cles.malAnime], cw),
      manga: await fichesWikidata(cfg, PROPS.manga, [...cles.manga], cw),
      malManga: await fichesWikidata(cfg, PROPS.malManga, [...cles.malManga], cw),
    };
    const tous = Object.values(F).flatMap((m) => [...m.values()].flat());
    S = await seriesWikidata(cfg, tous, cw);
    A = await articlesWikidata(cfg, [...tous, ...[...S.values()].flat()], langues, cw);
  } catch (e) {
    res.erreur = message(e);
    return fin();
  }

  // 3. articles candidats de chaque anime, par langue
  const de = (m: Map<string, string[]>, v: number | null | undefined) => (v != null ? m.get(String(v)) ?? [] : []);
  const candidats = new Map<number, Record<string, string[]>>();
  const uniques = new Map<string, number | null | undefined>();
  for (const l of lignes) {
    const p = plan.get(Number(l.id))!;
    const propres = [...de(F.anime, p.al), ...de(F.malAnime, p.mal)];
    const anc = p.anc.flatMap((x) => [...de(F.anime, x.id), ...de(F.malAnime, x.mal)]);
    const items = [
      ...propres,
      ...propres.flatMap((x) => S.get(x) ?? []),
      ...anc,
      ...anc.flatMap((x) => S.get(x) ?? []),
      ...p.sources.flatMap((x) => [...de(F.manga, x.id), ...de(F.malManga, x.mal)]),
    ];
    const parLangue: Record<string, string[]> = {};
    for (const lang of langues) {
      const titres = [...new Set(items.map((x) => A.get(x)?.[lang]).filter((t): t is string => !!t))];
      if (titres.length) {
        parLangue[lang] = titres;
        for (const t of titres) uniques.set(`${lang}|${t}`, undefined);
      }
    }
    candidats.set(Number(l.id), parLangue);
  }

  // 4. pages vues, une requête à la fois (les articles non lus restent à undefined : leurs animes gardent leurs valeurs)
  const f = fenetre();
  let deSuite = 0;
  for (const k of uniques.keys()) {
    if (res.articles >= cfg.maxArticles) {
      res.plafond = true;
      break;
    }
    if (deSuite >= ERREURS_DE_SUITE_MAX) {
      res.arret = `${ERREURS_DE_SUITE_MAX} lectures en échec de suite`;
      break;
    }
    if (Date.now() - debut > cfg.dureeMaxMs) {
      res.arret = `durée maximale atteinte (${Math.round(cfg.dureeMaxMs / 60000)} min)`;
      break;
    }
    if (cp++) await dormir(cfg.pausePvMs);
    const i = k.indexOf("|");
    let n: number | null;
    try {
      n = await vuesArticle(cfg, k.slice(0, i), k.slice(i + 1), f);
    } catch (e) {
      res.articles++;
      res.erreursArticles++;
      res.arret = message(e);
      break;
    }
    uniques.set(k, n);
    res.articles++;
    if (n == null) {
      res.erreursArticles++;
      deSuite++;
    } else deSuite = 0;
    progres?.(res.articles, uniques.size);
  }

  // 5. par langue l'article le plus lu, total pondéré, bonus ; écriture
  let changes = 0;
  for (const l of lignes) {
    const id = Number(l.id);
    const parLangue = candidats.get(id) ?? {};
    const detail: Record<string, { t: string; v: number }> = {};
    let complet = true;
    for (const [lang, titres] of Object.entries(parLangue)) {
      for (const t of titres) {
        const n = uniques.get(`${lang}|${t}`);
        if (n == null) {
          complet = false;
          continue;
        }
        if (!detail[lang] || n > detail[lang].v) detail[lang] = { t: t.slice(0, 200), v: n };
      }
    }
    if (Object.keys(parLangue).length) res.avecArticle++;
    if (!complet) {
      res.gardes++;
      continue;
    }
    const vues = vuesEurope(detail, cfg.langues);
    const bonus = bonusEurope(vues, cfg.poids);
    releve?.set(id, { id, vues, bonus, detail });
    try {
      await deps.pool.query(
        "UPDATE anime_items SET europe_vues = ?, europe_bonus = ?, europe_detail = ?, europe_le = NOW(), updated_at = updated_at WHERE id = ?",
        [vues, bonus, JSON.stringify(detail), id]
      );
    } catch {
      res.gardes++;
      continue;
    }
    res.ecrits++;
    if (Number(l.europe_bonus ?? -1) !== bonus) changes++;
  }
  res.bonusChanges = changes;
  if (changes > 0) deps.rafraichir?.();
  return fin();
}

/** Recalcule vues pondérées et bonus d'une table depuis europe_detail (réglage changé) ; rend le nombre de bonus changés. */
async function recalculerTable(deps: EuropeDeps, table: "anime_items" | "game_items", poids: number, langues: Array<[string, number]>): Promise<number> {
  const lignes: Array<{ id: number; europe_detail: string | null; europe_vues: number | null; europe_bonus: number | null }> = await deps.pool.query(
    `SELECT id, europe_detail, europe_vues, europe_bonus FROM ${table} WHERE europe_detail IS NOT NULL`
  );
  let changes = 0;
  for (const l of lignes) {
    let detail: Record<string, { t: string; v: number }>;
    try {
      detail = JSON.parse(String(l.europe_detail));
    } catch {
      continue;
    }
    const vues = vuesEurope(detail, langues);
    const bonus = bonusEurope(vues, poids);
    if (Number(l.europe_vues ?? -1) === vues && Number(l.europe_bonus ?? -1) === bonus) continue;
    await deps.pool.query(`UPDATE ${table} SET europe_vues = ?, europe_bonus = ?, updated_at = updated_at WHERE id = ?`, [vues, bonus, l.id]);
    changes++;
  }
  if (changes > 0) deps.rafraichir?.();
  return changes;
}

/** Animes : recalcule vues pondérées et bonus depuis europe_detail (réglage changé) ; rend le nombre de bonus changés. */
export async function recalculerBonus(deps: EuropeDeps, cfg: EuropeConfig = configEurope()): Promise<number> {
  return recalculerTable(deps, "anime_items", cfg.poids, cfg.langues);
}

/** Jeux : la même chose, avec la force des jeux. */
export async function recalculerBonusJeux(deps: EuropeDeps, cfg: EuropeConfig = configEurope()): Promise<number> {
  return recalculerTable(deps, "game_items", cfg.poidsJeux, cfg.langues);
}

// ── Passage des jeux

export interface PassageJeuxEurope {
  /** Jeux lus en base (fenêtre large des flux). */
  jeux: number;
  /** Jeux avec une fiche Wikidata ; ceux qui ne l'ont que par leur page Steam. */
  avecFiche: number;
  parSteam: number;
  /** Jeux avec au moins un article à eux dans les langues retenues. */
  avecArticle: number;
  /** Articles lus chez Wikipédia, et articles illisibles (paquet en échec). */
  articles: number;
  erreursArticles: number;
  /** Jeux écrits ; jeux gardés tels quels (un article non lu) ; bonus qui ont changé. */
  ecrits: number;
  gardes: number;
  bonusChanges: number;
  requetes: { igdb: number; wikidata: number; wikipedia: number };
  /** IGDB ou Wikidata en panne : rien n'est écrit. */
  erreur?: string;
  /** Lecture des pages vues arrêtée en route (Wikipédia, durée) : les jeux non lus gardent leurs valeurs. */
  arret?: string;
  /** Un autre passage tient le verrou : rien n'est fait. */
  occupe?: boolean;
}

interface LigneJeu {
  id: number;
  igdb_id: number | null;
  europe_bonus: number | null;
}

const bilanJeuxVide = (): PassageJeuxEurope => ({
  jeux: 0,
  avecFiche: 0,
  parSteam: 0,
  avecArticle: 0,
  articles: 0,
  erreursArticles: 0,
  ecrits: 0,
  gardes: 0,
  bonusChanges: 0,
  requetes: { igdb: 0, wikidata: 0, wikipedia: 0 },
});

/**
 * Un passage des jeux, sous le verrou de la base partagé avec celui des animes (déjà pris ailleurs : rien
 * n'est fait, `occupe`). `releve`, s'il est donné, reçoit le résultat de chaque jeu calculé.
 */
export async function passageEuropeJeux(deps: EuropeDeps, cfg: EuropeConfig = configEurope(), releve?: Map<number, DetailEurope>, progres?: (lus: number, total: number) => void): Promise<PassageJeuxEurope> {
  const liberer = await prendreVerrou(deps.pool);
  if (!liberer) return { ...bilanJeuxVide(), occupe: true };
  try {
    return await passageJeuxSousVerrou(deps, cfg, releve, progres);
  } finally {
    await liberer();
  }
}

async function passageJeuxSousVerrou(deps: EuropeDeps, cfg: EuropeConfig, releve?: Map<number, DetailEurope>, progres?: (lus: number, total: number) => void): Promise<PassageJeuxEurope> {
  const debut = Date.now();
  const ci = { n: 0 };
  const cw = { n: 0 };
  const cp = { n: 0 };
  // les jeux que les flux peuvent montrer (SELECT_GAMES de routes.ts : fenêtre large, jaquette et titre, les
  // MAX_DB_FETCH plus populaires) ; l'année courante et les suivantes d'abord, puis les plus populaires
  const an = new Date().getUTCFullYear();
  const lignes: LigneJeu[] = await deps.pool.query(
    "SELECT id, igdb_id, europe_bonus FROM (SELECT id, igdb_id, europe_bonus, release_date, popularity FROM game_items " +
      "WHERE release_date BETWEEN ? AND ? AND cover IS NOT NULL AND cover != '' AND title IS NOT NULL AND title != '' " +
      "ORDER BY popularity DESC, release_date DESC LIMIT ?) g ORDER BY release_date >= MAKEDATE(YEAR(CURDATE()), 1) DESC, popularity DESC, id",
    [`${an - DB_DATE_RANGE_YEARS}-01-01`, `${an + DB_DATE_RANGE_YEARS}-12-31`, MAX_DB_FETCH]
  );
  const res: PassageJeuxEurope = { ...bilanJeuxVide(), jeux: lignes.length };
  const fin = () => {
    res.requetes = { igdb: ci.n, wikidata: cw.n, wikipedia: cp.n };
    return res;
  };
  const langues = cfg.langues.map(([l]) => l);

  // pages Steam reconnues des jeux (steam-jeux.ts) ; sans la table, seul le chemin IGDB reste
  const steam = new Map<number, number>();
  try {
    for (const s of (await deps.pool.query("SELECT game_id, app_id, statut FROM jeux_steam")) as any[])
      if (Number(s?.app_id) > 0 && String(s?.statut ?? "") === STEAM_RECONNUE) steam.set(Number(s.game_id), Number(s.app_id));
  } catch (e) {
    if (Number((e as any)?.errno) !== 1146) throw e;
  }

  // 1. IGDB : noms courts
  let noms: Map<number, string>;
  try {
    noms = await nomsCourtsIgdb(cfg, lignes.map((l) => Number(l.igdb_id)).filter((x) => x > 0), deps.igdb ?? igdbFetch, ci);
  } catch (e) {
    res.erreur = message(e);
    return fin();
  }

  // 2. Wikidata : la fiche du jeu par son nom court IGDB, à défaut par sa page Steam ; puis ses articles
  const plan = new Map<number, string[]>();
  let A: Map<string, Record<string, string>>;
  try {
    const parNom = await fichesParNomCourt(cfg, [...noms.values()], cw);
    const parSteam = await fichesWikidata(cfg, PROPS_JEUX.steam, [...steam.values()], cw);
    for (const l of lignes) {
      const id = Number(l.id);
      const nom = noms.get(Number(l.igdb_id));
      const parIgdb = nom ? parNom.get(nom) ?? [] : [];
      const app = steam.get(id);
      const propres = parIgdb.length ? parIgdb : app ? parSteam.get(String(app)) ?? [] : [];
      if (propres.length) {
        res.avecFiche++;
        if (!parIgdb.length) res.parSteam++;
      }
      plan.set(id, propres);
    }
    A = await articlesWikidata(cfg, [...new Set([...plan.values()].flat())], langues, cw);
  } catch (e) {
    res.erreur = message(e);
    return fin();
  }

  // 3. les articles du jeu lui-même, par langue (règle A : jamais ceux de sa série)
  const candidats = new Map<number, Record<string, string[]>>();
  const aLire = new Map<string, Set<string>>(langues.map((l) => [l, new Set<string>()]));
  for (const l of lignes) {
    const id = Number(l.id);
    const parLangue: Record<string, string[]> = {};
    for (const lang of langues) {
      const titres = [...new Set((plan.get(id) ?? []).map((q) => A.get(q)?.[lang]).filter((t): t is string => !!t))];
      if (!titres.length) continue;
      parLangue[lang] = titres;
      for (const t of titres) aLire.get(lang)!.add(t);
    }
    if (Object.keys(parLangue).length) res.avecArticle++;
    candidats.set(id, parLangue);
  }

  // 4. pages vues, langue après langue, par paquets de 50 (titres dans l'ordre des jeux) ; un article non lu
  // reste absent : ses jeux gardent leurs valeurs (une lecture arrêtée en allemand garde tous les jeux qui ont
  // un article en allemand, en italien ou en espagnol)
  const f = fenetre();
  const lus = new Map<string, number | null>();
  const total = [...aLire.values()].reduce((s, x) => s + x.size, 0);
  const avant = () => (Date.now() - debut > cfg.dureeMaxMs ? `durée maximale atteinte (${Math.round(cfg.dureeMaxMs / 60000)} min)` : null);
  for (const lang of langues) {
    const titres = [...aLire.get(lang)!];
    if (!titres.length) continue;
    const r = await vuesParPaquets(cfg, lang, titres, f, cp, avant);
    for (const [t, n] of r.vues) {
      lus.set(`${lang}|${t}`, n);
      res.articles++;
      if (n == null) res.erreursArticles++;
    }
    progres?.(res.articles, total);
    if (r.arret) {
      res.arret = r.arret;
      break;
    }
  }

  // 5. par langue le plus lu de ses articles, total pondéré, bonus ; écriture
  let changes = 0;
  for (const l of lignes) {
    const id = Number(l.id);
    const detail: Record<string, { t: string; v: number }> = {};
    let complet = true;
    for (const [lang, titres] of Object.entries(candidats.get(id) ?? {})) {
      for (const t of titres) {
        const n = lus.get(`${lang}|${t}`);
        if (n == null) {
          complet = false;
          continue;
        }
        if (!detail[lang] || n > detail[lang].v) detail[lang] = { t: t.slice(0, 200), v: n };
      }
    }
    if (!complet) {
      res.gardes++;
      continue;
    }
    const vues = vuesEurope(detail, cfg.langues);
    const bonus = bonusEurope(vues, cfg.poidsJeux);
    releve?.set(id, { id, vues, bonus, detail });
    try {
      await deps.pool.query(
        "UPDATE game_items SET europe_vues = ?, europe_bonus = ?, europe_detail = ?, europe_le = NOW(), updated_at = updated_at WHERE id = ?",
        [vues, bonus, JSON.stringify(detail), id]
      );
    } catch {
      res.gardes++;
      continue;
    }
    res.ecrits++;
    if (Number(l.europe_bonus ?? -1) !== bonus) changes++;
  }
  res.bonusChanges = changes;
  if (changes > 0) deps.rafraichir?.();
  return fin();
}

/**
 * État du cycle : un passage à la fois ; après un échec, pas de nouvel essai avant 6 h. `incomplet` :
 * le dernier passage a arrêté sa lecture en route ; le suivant se fait 6 h plus tard même si les animes
 * déjà écrits datent de moins de 23 h, pour relire ceux qui ont attendu.
 */
export interface EtatEurope {
  enCours: boolean;
  prochainEssai: number;
  incomplet?: boolean;
  /** La dernière erreur inattendue (base, bug) : le Pilotage la montre. */
  erreur?: string;
}

/**
 * Un contrôle du cycle : rien si un passage tourne (ici ou ailleurs, verrou de la base), si le dernier
 * échec date de moins de 6 h ou si le dernier passage date de moins de 23 h ; sinon un passage.
 * Après un passage interrompu ou une lecture arrêtée par Wikimedia, pas de nouvel essai avant 6 h.
 */
export async function controleEurope(deps: EuropeDeps, cfg: EuropeConfig, etat: EtatEurope, forcer = false): Promise<"occupe" | "attente" | "recent" | PassageEurope> {
  if (etat.enCours) return "occupe";
  // forcer : passage lancé à la main depuis le Pilotage (ni l'attente après un échec, ni le passage récent ne l'arrêtent)
  if (!forcer && Date.now() < etat.prochainEssai) return "attente";
  etat.enCours = true;
  const debut = Date.now();
  try {
    const r: any = await deps.pool.query("SELECT MAX(europe_le) > NOW() - INTERVAL 23 HOUR AS recent FROM anime_items");
    if (!forcer && Number(r?.[0]?.recent) && !etat.incomplet) return "recent";
    const p = await passageEurope(deps, cfg);
    if (p.occupe) {
      deps.log.info({ module: "europe" }, "bonus européen : un passage tourne déjà (jeux ou installation) ; contrôle suivant dans 1 h");
      return "occupe";
    }
    trackLastRun("europe-wikipedia", { ...p }, Date.now() - debut);
    if (!p.erreur) etat.incomplet = !!p.arret;
    if (p.erreur || p.arret) {
      etat.prochainEssai = Date.now() + APRES_ECHEC_MS;
      deps.log.warn({ module: "europe", ...p }, p.erreur ? "bonus européen : passage interrompu (nouvel essai dans 6 h)" : "bonus européen : lecture arrêtée en route (les animes non lus sont relus dans 6 h)");
    } else if (p.plafond) {
      deps.log.warn({ module: "europe", ...p }, `bonus européen : plafond de ${cfg.maxArticles} articles atteint, les animes les moins populaires gardent leurs valeurs`);
    } else {
      deps.log.info({ module: "europe", ...p }, "bonus européen : passage terminé");
    }
    const suite = p.erreur ? ` · ${p.erreur}` : p.arret ? ` · lecture arrêtée : ${p.arret}` : p.plafond ? ` · plafond de ${cfg.maxArticles} articles atteint` : "";
    pushActivity({
      type: "europe",
      message: p.erreur ? "Bonus européen : passage interrompu" : `Bonus européen : ${p.ecrits} animes relus, ${p.bonusChanges} bonus changés`,
      detail: `${p.avecArticle} animes avec article, ${p.articles} articles lus` + (p.erreursArticles ? `, ${p.erreursArticles} illisibles` : "") + suite,
      level: p.erreur || p.arret || p.plafond || p.erreursArticles ? "warn" : "info",
    });
    return p;
  } catch (e) {
    etat.prochainEssai = Date.now() + APRES_ECHEC_MS;
    etat.erreur = message(e);
    deps.log.error({ module: "europe", err: message(e) }, "bonus européen : erreur");
    return "attente";
  } finally {
    etat.enCours = false;
  }
}

/**
 * Un contrôle du cycle des jeux : rien si un passage tourne (ici ou ailleurs, verrou de la base partagé
 * avec les animes), si le dernier échec date de moins de 6 h ou si le dernier passage des jeux date de
 * moins de 23 h ; sinon un passage. Après un passage interrompu ou une lecture arrêtée, pas de nouvel
 * essai avant 6 h.
 */
export async function controleEuropeJeux(deps: EuropeDeps, cfg: EuropeConfig, etat: EtatEurope, forcer = false): Promise<"occupe" | "attente" | "recent" | PassageJeuxEurope> {
  if (etat.enCours) return "occupe";
  if (!forcer && Date.now() < etat.prochainEssai) return "attente";
  etat.enCours = true;
  const debut = Date.now();
  try {
    const r: any = await deps.pool.query("SELECT MAX(europe_le) > NOW() - INTERVAL 23 HOUR AS recent FROM game_items");
    if (!forcer && Number(r?.[0]?.recent) && !etat.incomplet) return "recent";
    const p = await passageEuropeJeux(deps, cfg);
    if (p.occupe) {
      deps.log.info({ module: "europe" }, "bonus européen des jeux : un passage tourne déjà ; contrôle suivant dans 1 h");
      return "occupe";
    }
    trackLastRun("europe-jeux-wikipedia", { ...p }, Date.now() - debut);
    if (!p.erreur) etat.incomplet = !!p.arret;
    if (p.erreur || p.arret) {
      etat.prochainEssai = Date.now() + APRES_ECHEC_MS;
      deps.log.warn({ module: "europe", ...p }, p.erreur ? "bonus européen des jeux : passage interrompu (nouvel essai dans 6 h)" : "bonus européen des jeux : lecture arrêtée en route (les jeux non lus sont relus dans 6 h)");
    } else {
      deps.log.info({ module: "europe", ...p }, "bonus européen des jeux : passage terminé");
    }
    const suite = p.erreur ? ` · ${p.erreur}` : p.arret ? ` · lecture arrêtée : ${p.arret}` : "";
    pushActivity({
      type: "europe",
      message: p.erreur ? "Bonus européen des jeux : passage interrompu" : `Bonus européen des jeux : ${p.ecrits} jeux relus, ${p.bonusChanges} bonus changés`,
      detail: `${p.avecFiche} jeux avec une fiche, ${p.avecArticle} avec un article, ${p.articles} articles lus` + (p.erreursArticles ? `, ${p.erreursArticles} illisibles` : "") + suite,
      level: p.erreur || p.arret || p.erreursArticles ? "warn" : "info",
    });
    return p;
  } catch (e) {
    etat.prochainEssai = Date.now() + APRES_ECHEC_MS;
    etat.erreur = message(e);
    deps.log.error({ module: "europe", err: message(e) }, "bonus européen des jeux : erreur");
    return "attente";
  } finally {
    etat.enCours = false;
  }
}

/** Bonus retiré d'une table (interrupteur) : le classement redevient celui de la popularité seule ; les vues relevées restent en base. */
async function retirerBonus(deps: EuropeDeps, table: "anime_items" | "game_items"): Promise<void> {
  try {
    const r: any = await deps.pool.query(`UPDATE ${table} SET europe_bonus = NULL, updated_at = updated_at WHERE europe_bonus IS NOT NULL`);
    if (Number(r?.affectedRows ?? 0) > 0) deps.rafraichir?.();
  } catch (e) {
    deps.log.error({ module: "europe", err: message(e) }, `bonus européen : retrait du bonus impossible (${table})`);
  }
}

/** n8n interroge AniList vers l'heure pile : un contrôle qui tomberait entre h:56 et h:04 attend 10 min. */
export function heurePleine(maintenant: Date = new Date()): boolean {
  const m = maintenant.getUTCMinutes();
  return m >= 56 || m <= 4;
}

/**
 * Démarrage : interrupteurs, recalcul du bonus, puis un contrôle des animes 40 min après le démarrage et
 * toutes les heures (décalé de 10 min s'il tombe autour de l'heure pile) ; celui des jeux 55 min après le
 * démarrage, puis toutes les heures.
 */
export function startEuropeCron(deps: EuropeDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts, 17 octobre 2026) : EUROPE_ENABLED et EUROPE_JEUX_ENABLED ne servent plus qu'à la première
  // mise en route. Coupé au Pilotage, le bonus du domaine est retiré tout de suite (les vues relevées restent en base) ;
  // rallumé, il est recalculé depuis ces vues, et le passage suivant les relit.
  const cfg = configEurope(env);
  const animesParDefaut = env["EUROPE_ENABLED"] !== "0";
  const jeuxParDefaut = animesParDefaut && env["EUROPE_JEUX_ENABLED"] !== "0";
  deps.log.info(
    { module: "europe", poids: cfg.poids, langues: cfg.langues.map(([l, p]) => `${l}:${p}`).join(","), animesParDefaut, jeuxParDefaut },
    "bonus européen : planifié (Wikipédia, un passage par jour)"
  );
  const sansPassage = (r: unknown) => (r === "occupe" ? { bilan: { occupe: true } } : typeof r === "string" ? { rien: true } : undefined);
  // une erreur inattendue (base, bug) : le contrôle attend 6 h, comme avant, et le Pilotage la montre en erreur
  const verifier = (et: EtatEurope, avant: number, r: unknown): unknown => {
    if (r === "attente" && et.prochainEssai !== avant) throw new Error(et.erreur || "erreur inattendue (nouvel essai dans 6 h)");
    return r;
  };
  const etat: EtatEurope = { enCours: false, prochainEssai: 0 };
  // un contrôle des animés 40 min après le démarrage et toutes les heures ; autour de l'heure pile, le contrôle est
  // repoussé de 10 min (sans tenir le module occupé) et les suivants gardent ce décalage
  planifier({
    id: "europe-animes", premierMs: PREMIER_CONTROLE_MS, rythmeMs: CONTROLE_MS, suivi: "europe-wikipedia", actifParDefaut: animesParDefaut,
    passage: async ({ manuel }) => {
      if (!manuel && heurePleine()) return { rien: true, reessayerDansMs: DECALAGE_MS };
      const avant = etat.prochainEssai;
      const r = verifier(etat, avant, await controleEurope(deps, cfg, etat, manuel));
      // coupé pendant le passage (ou lancé à la main, coupé) : le bonus qu'il vient d'écrire est retiré aussitôt
      if (interrupteur("europe-animes") === false) await retirerBonus(deps, "anime_items");
      return sansPassage(r);
    },
    quandCoupe: () => retirerBonus(deps, "anime_items"),
    quandRallume: async () => {
      await recalculerBonus(deps, cfg);
    },
    // pour le Pilotage : le prochain passage réel (6 h après un échec ou une lecture arrêtée en route)
    infos: async () => ({ prochainEssai: etat.prochainEssai, incomplet: !!etat.incomplet }),
  });
  // celui des jeux 55 min après le démarrage, puis toutes les heures
  const etatJeux: EtatEurope = { enCours: false, prochainEssai: 0 };
  planifier({
    id: "europe-jeux", premierMs: PREMIER_CONTROLE_JEUX_MS, rythmeMs: CONTROLE_MS, suivi: "europe-jeux-wikipedia", actifParDefaut: jeuxParDefaut,
    passage: async ({ manuel }) => {
      const avant = etatJeux.prochainEssai;
      const r = verifier(etatJeux, avant, await controleEuropeJeux(deps, cfg, etatJeux, manuel));
      if (interrupteur("europe-jeux") === false) await retirerBonus(deps, "game_items");
      return sansPassage(r);
    },
    quandCoupe: () => retirerBonus(deps, "game_items"),
    quandRallume: async () => {
      await recalculerBonusJeux(deps, cfg);
    },
    infos: async () => ({ prochainEssai: etatJeux.prochainEssai, incomplet: !!etatJeux.incomplet }),
  });
  // au démarrage, comme avant : le bonus suit l'interrupteur (retiré s'il est coupé, recalculé s'il est allumé)
  if (interrupteur("europe-animes") === false) void retirerBonus(deps, "anime_items");
  else void recalculerBonus(deps, cfg).catch((e) => deps.log.error({ module: "europe", err: message(e) }, "bonus européen : recalcul impossible"));
  if (interrupteur("europe-jeux") === false) void retirerBonus(deps, "game_items");
  else void recalculerBonusJeux(deps, cfg).catch((e) => deps.log.error({ module: "europe", err: message(e) }, "bonus européen des jeux : recalcul impossible"));
}
