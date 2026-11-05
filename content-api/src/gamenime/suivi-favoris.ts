/**
 * suivi-favoris.ts — Épisodes et dates des favoris (30 octobre 2026).
 *
 * L'invitation aux notifications sur l'appareil (maquette validée par Rey le 30 octobre) promet « Chaque épisode » et
 * « Si la date change ». Le relevé du serveur du 30 octobre l'a montré : aucune de ces deux notifications n'était créée.
 * La détection des épisodes (createNotificationsForItemChange, index.ts) lit un compteur de la description que plus rien
 * ne met à jour (0 notification d'épisode en 30 jours), et un report de date ne prévenait personne. Rey : « Les ajouter
 * d'abord », vérifié à blanc avant tout envoi.
 *
 * Deux lignes du Pilotage (famille « Surveillance et comptes ») :
 *  - « Épisodes et dates des favoris » (suivi-favoris, toutes les 10 min, allumée) relève, sans rien envoyer :
 *      - les épisodes sortis des animés suivis (favoris, cloche allumée) : les horaires de « Cette semaine » (AnimeSchedule,
 *        gardés par /feed/week dans semaine_animeschedule : la semaine en cours et la précédente), avec le même tri des
 *        animés que la semaine du site. Un épisode n'est annoncé que s'il est dit sorti (« aired ») par une semaine lue
 *        après son créneau, en sous-titres (airType « sub » : la semaine « sub » d'AnimeSchedule reprend l'horaire
 *        japonais quand elle n'a pas celui des sous-titres) et hors d'une période de retard (delayedFrom..delayedUntil).
 *        Une semaine gardée avant ce module (sans ces champs) n'annonce rien. Il est revérifié juste avant l'envoi.
 *        Seulement sur une de nos plateformes européennes (règle de Rey, 30 octobre) : un animé dont la fiche n'en a
 *        aucune (VALID_PLATFORMS, constants.ts) n'est pas annoncé, même s'il est dans « Cette semaine ».
 *        « Épisode 5 · Crunchyroll, Netflix » : les plateformes de la fiche ;
 *      - les changements de date des titres suivis : la date du site (celle du cinéma en France pour un film ; pour un
 *        jeu, un 31/12 ou un 1/1 à venir marqué « jour » est l'année, comme le lit igdb-jeux.ts) est gardée titre par
 *        titre (suivi_favoris_dates). Un changement n'est pris qu'une fois resté 6 h sans bouger (plus que le cycle de
 *        3 h des jeux IGDB) ; il est « reporté », « avancé » ou « précisé » (jour connu dans le même mois, mois connu
 *        dans la même année), avec toujours la précision connue. La date annoncée d'un jeu sans date est donnée ici ;
 *        celle d'un animé l'est déjà par dates-animes.ts. Ne sont pas annoncés : une date moins précise, un jour d'écart
 *        (le plus souvent le fuseau du Japon), une nouvelle date déjà passée, un titre sorti depuis plus de 30 jours
 *        (une correction), un animé annulé, un film au cinéma en France (le module des plateformes annonce ses dates).
 *        La trouvaille est notée au journal avant que la date gardée n'avance (une panne entre les deux ne perd rien),
 *        et la date du site est revérifiée juste avant l'envoi ;
 *    chaque trouvaille est notée une fois dans le journal (suivi_favoris) ;
 *  - « Envoi aux abonnés » (envoi-favoris, coupée à la première mise en route) envoie à la cloche les trouvailles encore
 *    fraîches : un épisode sorti depuis moins de 12 h, une date changée depuis moins de 48 h (même événement, même cloche,
 *    même temps réel que les autres notifications : createNotificationEventAndFanout), une seule fois (la trouvaille est
 *    marquée « en cours » avant l'envoi). Ce qui n'est plus vrai au moment d'envoyer est « annulé ». Coupée, tout reste
 *    relevé à blanc : ce qui aurait été envoyé est montré dans la ligne du dessus.
 * Garde-fou : plus de 25 épisodes ou de 10 changements de date d'un seul passage, rien de ce passage n'est envoyé, ni
 * épisode ni date (« retenus », alerte dans le Pilotage).
 * GET /admin/suivi-favoris/essai (clé de l'API) : ce qui serait parti ces 7 derniers jours (épisodes) et les changements
 * de date en observation, en lecture seule.
 * Les instants sont en millisecondes (BIGINT), comme le Pilotage : aucune conversion de fuseau.
 */
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { avancer, interrupteur, planifier } from "./pilotage.js";
import { libelleDate, type Precision } from "./dates-animes.js";
import { VALID_PLATFORMS } from "./constants.js";

// ─────────────────────────────────────────────────────────────── réglages

const MIN = 60 * 1000;
const H = 60 * MIN;
const J = 24 * H;
/** Un épisode est envoyé jusqu'à 12 h après sa sortie, un changement de date jusqu'à 48 h après avoir été pris. */
export const FRAIS_EPISODE_MS = 12 * H;
export const FRAIS_DATE_MS = 48 * H;
/** Un changement de date doit rester 6 h sans bouger (le cycle des jeux IGDB est de 3 h). */
export const STABLE_MS = 6 * H;
/** Garde-fous : au-delà, rien de ce passage n'est envoyé. */
export const MAX_EPISODES = 25;
export const MAX_DATES = 10;
const GARDE_JOURNAL_MS = 60 * J;
const ESSAI_MS = 7 * J;

export type Sorte = "episode" | "date";
type TypeItem = "anime" | "game";

export interface SuiviDeps {
  pool: any;
  log: any;
  /** Relit la semaine du site (GET /feed/week) : la garde à jour en base (sans effet si elle est en cache). */
  rafraichirSemaine?: () => Promise<void>;
  /** createNotificationEventAndFanout (index.ts) : l'événement, la cloche des abonnés, le temps réel. */
  notifier: (db: any, itemType: TypeItem, itemId: number, eventType: string, eventKey: string, payload: any) => Promise<void>;
}

/** Une trouvaille : ce qui part (ou partirait) dans la cloche des abonnés. */
export interface Trouvaille {
  cle: string;
  sorte: Sorte;
  itemType: TypeItem;
  itemId: number;
  eventType: string;
  payload: Record<string, any>;
  /** La sortie de l'épisode, ou l'instant où le changement de date est pris. */
  quand: number;
}

let DEPS: SuiviDeps | null = null;

// ─────────────────────────────────────────────────────────────── petits outils

const N = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const message = (e: unknown): string => String((e as any)?.message ?? e).split(/\r?\nsql:/)[0].replace(/^\(conn:[^)]*\)\s*/, "").slice(0, 200);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOUR_PARIS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
/** Le jour à Paris, AAAA-MM-JJ : un titre prévu aujourd'hui n'est pas encore « sorti ». */
export const jourParis = (t: number): string => JOUR_PARIS.format(new Date(t));

/** La semaine ISO, comme /feed/week (routes.ts) : « 2026-W44 ». */
export function cleSemaine(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const jour = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - jour);
  const debutAnnee = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const semaine = Math.ceil(((t.getTime() - debutAnnee.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(semaine).padStart(2, "0")}`;
}

// les plateformes admises par l'API (constants.ts : pour les animés, celles disponibles en Europe), par nom en minuscules
const ADMISES = new Map<string, string>((VALID_PLATFORMS as readonly string[]).map((x) => [x.toLowerCase(), x]));

/**
 * Les plateformes de la fiche, dans leur ordre, sans doublon, et seulement celles admises par l'API (« Unknown », un
 * nom de studio… ne comptent pas) : « Crunchyroll, Netflix ». Vide : sur aucune de nos plateformes.
 */
export function plateformes(p: unknown): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const x of String(p ?? "").split(",")) {
    const v = ADMISES.get(x.trim().toLowerCase());
    if (!v || vus.has(v)) continue;
    vus.add(v);
    out.push(v);
  }
  return out;
}

/** Le titre affiché par le site : le titre anglais s'il existe (displayTitle, site/src/lib/api.ts). */
const titreSite = (r: any): string => {
  const en = r?.titleEnglish ?? r?.title_english;
  return String(en != null && String(en).trim() !== "" ? en : r?.title ?? "").trim();
};

// ─────────────────────────────────────────────────────────────── épisodes

/** Une entrée de la semaine AnimeSchedule, telle que /feed/week la garde (compacter, routes.ts). */
interface EntreeSemaine {
  route?: unknown;
  episodeDate?: unknown;
  episodeNumber?: unknown;
  airingStatus?: unknown;
  airType?: unknown;
  delayedFrom?: unknown;
  delayedUntil?: unknown;
}

const instant = (v: unknown): number => {
  const t = Date.parse(String(v ?? ""));
  // « 0001-01-01 » : pas de date
  return Number.isFinite(t) && new Date(t).getUTCFullYear() > 1900 ? t : NaN;
};

/** Marqué en retard chez AnimeSchedule : « delayed-air », ou un créneau dans la période de retard (delayedFrom..delayedUntil). */
export function enRetard(a: EntreeSemaine): boolean {
  if (String(a?.airingStatus ?? "").toLowerCase() === "delayed-air") return true;
  const de = instant(a?.delayedFrom), jusqua = instant(a?.delayedUntil), e = instant(a?.episodeDate);
  return Number.isFinite(de) && Number.isFinite(jusqua) && Number.isFinite(e) && de <= e && e < jusqua;
}

/** Ce que dit une entrée lue à l'instant lu : l'épisode est sorti (sous-titré, dit « aired », lu après son créneau). */
export function sortiSelon(a: EntreeSemaine, lu: number): "sorti" | "retard" | "pas-encore" | "brut" | "inconnu" {
  if (enRetard(a)) return "retard";
  if (!("airingStatus" in (a || {}))) return "inconnu";
  const e = instant(a?.episodeDate);
  if (!Number.isFinite(e) || !Number.isFinite(lu) || lu < e || String(a?.airingStatus ?? "").toLowerCase() !== "aired") return "pas-encore";
  if (String(a?.airType ?? "").toLowerCase() !== "sub") return "brut";
  return "sorti";
}

// le même tri des animés que la semaine du site (/feed/week, routes.ts), puis les animés suivis seulement
const ANIMES_DE_LA_SEMAINE =
  "SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, platform, anime_schedule_route AS route " +
  "FROM anime_items WHERE anime_schedule_route IN (@ROUTES@) AND IFNULL(statut_anilist, '') <> 'CANCELLED' " +
  "AND (TRIM(IFNULL(platform, '')) <> '' OR ((pays_origine IS NULL OR pays_origine IN ('JP', '--')) AND " +
  "(release_precision IS NULL OR release_precision <> 'day' OR release_date IS NULL OR release_date > UTC_DATE()))) " +
  "AND id IN (SELECT f.item_id FROM favorites f INNER JOIN users u ON u.id = f.user_id WHERE f.item_type = 'anime' AND u.notifications_enabled = 1)";

export interface BilanEpisodes {
  semaines: string[];
  /** Les semaines gardées avant ce module (sans les champs du retard) : elles n'annoncent rien. */
  sansRetards: string[];
  entrees: number;
  retardes: number;
  /** Pas encore dits sortis par une semaine lue après leur créneau (le passage suivant les reprend). */
  enAttente: number;
  /** Horaire japonais seulement (pas de sous-titres connus) : pas annoncés. */
  bruts: number;
  /** Sortis, mais l'animé n'est sur aucune de nos plateformes européennes (sa fiche) : pas annoncés. */
  sansPlateforme: number;
  suivis: number;
  trouves: Trouvaille[];
}

/**
 * Les épisodes des animés suivis sortis entre maintenant - fenetreMs et maintenant (la semaine en cours et la
 * précédente, telles que gardées en base). Lecture seule.
 */
export async function releverEpisodes(pool: any, maintenant: number, fenetreMs: number): Promise<BilanEpisodes> {
  const cles = [cleSemaine(new Date(maintenant)), cleSemaine(new Date(maintenant - 7 * J))];
  const res: BilanEpisodes = { semaines: [], sansRetards: [], entrees: 0, retardes: 0, enAttente: 0, bruts: 0, sansPlateforme: 0, suivis: 0, trouves: [] };
  let lignes: any[] = [];
  try {
    // « le » : l'heure de la lecture d'AnimeSchedule (UTC_TIMESTAMP, routes.ts), lue telle quelle
    lignes = await pool.query("SELECT semaine, donnees, DATE_FORMAT(le, '%Y-%m-%dT%H:%i:%sZ') AS lu FROM semaine_animeschedule WHERE semaine IN (?, ?)", cles);
  } catch (e) {
    // pas encore de semaine gardée (la table naît avec la première semaine lue par /feed/week)
    if ((e as any)?.errno === 1146) return res;
    throw e;
  }
  const entrees: Array<{ a: EntreeSemaine; lu: number }> = [];
  for (const l of lignes) {
    let t: unknown;
    try {
      t = JSON.parse(String(l.donnees));
    } catch {
      continue;
    }
    if (!Array.isArray(t)) continue;
    res.semaines.push(String(l.semaine));
    if (t.length && !t.some((a: any) => a && typeof a === "object" && "airingStatus" in a)) res.sansRetards.push(String(l.semaine));
    const lu = Date.parse(String(l.lu ?? ""));
    for (const a of t as EntreeSemaine[]) entrees.push({ a, lu });
  }
  res.semaines.sort().reverse();
  res.sansRetards.sort().reverse();
  // les épisodes de la fenêtre, une fois chacun (la même entrée peut être gardée dans deux semaines)
  const retenues = new Map<string, { route: string; n: number; quand: number }>();
  for (const { a, lu } of entrees) {
    const route = typeof a?.route === "string" ? a.route : "";
    const n = Number(a?.episodeNumber);
    const quand = Date.parse(String(a?.episodeDate ?? ""));
    if (!route || !Number.isInteger(n) || n <= 0 || !Number.isFinite(quand)) continue;
    if (quand > maintenant || quand <= maintenant - fenetreMs) continue;
    res.entrees++;
    const v = sortiSelon(a, lu);
    if (v === "retard") res.retardes++;
    else if (v === "pas-encore") res.enAttente++;
    else if (v === "brut") res.bruts++;
    if (v !== "sorti") continue;
    const k = `${route}#${n}`;
    const deja = retenues.get(k);
    if (!deja || quand > deja.quand) retenues.set(k, { route, n, quand });
  }
  if (!retenues.size) return res;
  const routes = [...new Set([...retenues.values()].map((x) => x.route))];
  const animes: any[] = await pool.query(ANIMES_DE_LA_SEMAINE.replace("@ROUTES@", routes.map(() => "?").join(",")), routes);
  // comme /feed/week : une route, une fiche
  const parRoute = new Map<string, any>();
  for (const r of animes) parRoute.set(String(r.route), r);
  res.suivis = parRoute.size;
  for (const x of [...retenues.values()].sort((a, b) => a.quand - b.quand)) {
    const a = parRoute.get(x.route);
    if (!a) continue;
    const id = N(a.id);
    const plats = plateformes(a.platform);
    // sur aucune de nos plateformes européennes : pas annoncé (« Cette semaine » montre aussi un animé pas encore sorti
    // selon sa fiche, avant qu'il ait une plateforme)
    if (!plats.length) {
      res.sansPlateforme++;
      continue;
    }
    const texte = `Épisode ${x.n} · ${plats.join(", ")}`;
    res.trouves.push({
      cle: `anime:${id}:episode:${x.n}`,
      sorte: "episode",
      itemType: "anime",
      itemId: id,
      eventType: "anime_episode_aired",
      payload: { title: titreSite(a), cover: a.cover || null, label: "Nouvel épisode", newValue: texte, episode: x.n, platforms: plats, airingAt: new Date(x.quand).toISOString() },
      quand: x.quand,
    });
  }
  return res;
}

// ─────────────────────────────────────────────────────────────── dates

/** Ce que le site montre d'une date : AAAA-MM-JJ (le 1er du mois pour un mois, le 1er janvier pour une année), ou rien. */
export interface Valeur {
  date: string | null;
  prec: Precision | null;
  cinema: boolean;
}

/** La date du site, rangée : une même année ou un même mois ont toujours la même écriture (IGDB garde le 31/12). */
export function valeurDe(d: unknown, p: unknown, cinema: unknown = 0): Valeur {
  const c = N(cinema) === 1 || cinema === true;
  const s = d instanceof Date ? (Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "") : String(d ?? "");
  if (!DATE_RE.test(s)) return { date: null, prec: null, cinema: c };
  const prec: Precision = p === "month" || p === "year" ? p : "day";
  const date = prec === "year" ? `${s.slice(0, 4)}-01-01` : prec === "month" ? `${s.slice(0, 7)}-01` : s;
  return { date, prec, cinema: c };
}

/** Un jeu : un 31/12 ou un 1/1 à venir marqué « jour » est une année déguisée (fauxJour, igdb-jeux.ts). */
export function sansFauxJour(v: Valeur, aujourdHui: string): Valeur {
  if (v.prec !== "day" || !v.date || !/-(12-31|01-01)$/.test(v.date) || v.date <= aujourdHui) return v;
  return { date: `${v.date.slice(0, 4)}-01-01`, prec: "year", cinema: v.cinema };
}

const memeValeur = (a: Valeur, b: Valeur): boolean => a.date === b.date && (a.date === null || a.prec === b.prec) && a.cinema === b.cinema;

/** Le premier et le dernier jour de la période (un jour, un mois, une année). */
function periode(v: Valeur): [string, string] {
  const d = v.date as string;
  if (v.prec === "year") return [`${d.slice(0, 4)}-01-01`, `${d.slice(0, 4)}-12-31`];
  if (v.prec === "month") {
    const [y, m] = d.split("-").map(Number);
    const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${d.slice(0, 7)}-01`, `${d.slice(0, 7)}-${String(fin).padStart(2, "0")}`];
  }
  return [d, d];
}
const RANG: Record<Precision, number> = { year: 0, month: 1, day: 2 };
const jourMs = (iso: string): number => Date.parse(iso + "T00:00:00Z");
const jourIso = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** Un titre sorti depuis plus de 30 jours selon sa date d'avant : un changement est une correction, pas une nouvelle. */
export const RECUL_JOURS = 30;

export type Changement = "annoncee" | "reporte" | "avance" | "precise";

/**
 * Ce que vaut le passage de avant à apres pour les abonnés, ou rien.
 * aujourdHui : le jour à Paris (AAAA-MM-JJ).
 */
export function classer(avant: Valeur, apres: Valeur, aujourdHui: string, itemType: TypeItem): Changement | null {
  // un film au cinéma en France : le module des plateformes annonce ses dates (« Au cinéma en France le … »)
  if (avant.cinema || apres.cinema) return null;
  if (!avant.date && !apres.date) return null;
  if (!avant.date) {
    // la date annoncée d'un animé est donnée par dates-animes.ts ; celle d'un jeu, ici (sauf une date déjà passée)
    if (itemType === "anime") return null;
    return periode(apres)[1] >= aujourdHui ? "annoncee" : null;
  }
  const [a0, a1] = periode(avant);
  // sorti depuis plus de 30 jours selon la date d'avant : une correction de la source, pas une nouvelle
  if (a1 < jourIso(jourMs(aujourdHui) - RECUL_JOURS * J)) return null;
  // plus de date (« Date à annoncer ») : reporté sans nouvelle date
  if (!apres.date) return "reporte";
  const [b0, b1] = periode(apres);
  // une nouvelle date déjà passée (sortie surprise, correction d'une source) n'est pas annoncée
  if (b1 < aujourdHui) return null;
  const dansAvant = b0 >= a0 && b1 <= a1;
  if (dansAvant) return RANG[apres.prec as Precision] > RANG[avant.prec as Precision] ? "precise" : null;
  // moins précis (le jour devient un mois, le mois une année) : rien à annoncer
  if (a0 >= b0 && a1 <= b1) return null;
  // un jour d'écart, d'un jour à l'autre : le plus souvent le fuseau du Japon, pas un report
  if (avant.prec === "day" && apres.prec === "day" && Math.abs(jourMs(b0) - jourMs(a0)) <= J) return null;
  if (b0 > a1) return "reporte";
  if (b1 < a0) return "avance";
  return null;
}

/** « du 23 octobre 2026 », « d’octobre 2026 », « de mars 2027 », « de 2027 » : après « au lieu ». */
function complement(v: Valeur): string {
  const [y, m, d] = (v.date as string).split("-").map(Number);
  if (v.prec === "year") return `de ${y}`;
  const mois = MOIS[m - 1];
  if (v.prec === "month") return `${/^[aeiouyàâéèêîôû]/i.test(mois) ? "d’" : "de "}${mois} ${y}`;
  return `du ${d} ${mois} ${y}`;
}

/**
 * Le texte de la cloche et la clé de l'événement d'un changement de date. La clé porte le début de l'observation du
 * changement : un même passage repris (panne) retrouve la même ; un nouveau changement, même vers une date déjà
 * annoncée, en a une autre.
 */
export function changementDate(sorte: Changement, avant: Valeur, apres: Valeur, itemType: TypeItem, itemId: number, titre: string, cover: string | null, depuis: number): Omit<Trouvaille, "quand"> {
  const nouveau = apres.date ? libelleDate(apres.date, apres.prec) : "date à annoncer";
  const ancien = avant.date ? libelleDate(avant.date, avant.prec) : "Date à annoncer";
  const base = { title: titre, cover, oldValue: ancien, date: apres.date, precision: apres.prec, oldDate: avant.date, oldPrecision: avant.prec, change: sorte };
  if (sorte === "annoncee") {
    // la même forme que la date annoncée d'un animé (dates-animes.ts) : le même événement, le même texte (la clé porte en
    // plus le début de l'observation)
    return {
      cle: `${itemType}:${itemId}:release_date:${apres.date}:${depuis}`, sorte: "date", itemType, itemId, eventType: `${itemType}_release_date_announced`,
      payload: { ...base, label: "Date annoncée", newValue: nouveau },
    };
  }
  const textes: Record<Exclude<Changement, "annoncee">, [string, string]> = {
    reporte: ["Date reportée", `Reporté : ${nouveau} (au lieu ${complement(avant)})`],
    avance: ["Date avancée", `Avancé : ${nouveau} (au lieu ${complement(avant)})`],
    precise: ["Date précisée", `Date précisée : ${nouveau}`],
  };
  const [label, texte] = textes[sorte];
  const v = (x: Valeur) => (x.date ? `${x.date}:${x.prec}` : "tba");
  return {
    cle: `${itemType}:${itemId}:release_date_changed:${v(avant)}:${v(apres)}:${depuis}`, sorte: "date", itemType, itemId, eventType: `${itemType}_release_date_changed`,
    payload: { ...base, label, newValue: texte },
  };
}

// les titres suivis (favoris, cloche allumée) et la date que le site montre
const TITRES_SUIVIS =
  "SELECT 'anime' AS t, CAST(a.id AS UNSIGNED) AS id, a.title, a.title_english AS titleEnglish, a.cover, " +
  "DATE_FORMAT(IF(a.format = 'MOVIE' AND a.fr_cinema IS NOT NULL, a.fr_cinema, a.release_date), '%Y-%m-%d') AS d, " +
  "IF(a.format = 'MOVIE' AND a.fr_cinema IS NOT NULL, 'day', a.release_precision) AS p, " +
  "IF(a.format = 'MOVIE' AND a.fr_cinema IS NOT NULL, 1, 0) AS cinema, IF(IFNULL(a.statut_anilist, '') = 'CANCELLED', 1, 0) AS annule " +
  "FROM anime_items a WHERE a.id IN (SELECT f.item_id FROM favorites f INNER JOIN users u ON u.id = f.user_id WHERE f.item_type = 'anime' AND u.notifications_enabled = 1) " +
  "UNION ALL " +
  "SELECT 'game' AS t, CAST(g.id AS UNSIGNED) AS id, g.title, g.title_english AS titleEnglish, g.cover, DATE_FORMAT(g.release_date, '%Y-%m-%d') AS d, " +
  "g.release_precision AS p, 0 AS cinema, 0 AS annule " +
  "FROM game_items g WHERE g.id IN (SELECT f.item_id FROM favorites f INNER JOIN users u ON u.id = f.user_id WHERE f.item_type = 'game' AND u.notifications_enabled = 1)";

export interface BilanDates {
  suivis: number;
  nouveaux: number;
  observation: number;
  oublies: number;
  trouves: Trouvaille[];
  /** Les changements pris à annoncer : leur date gardée n'avance qu'une fois la trouvaille notée au journal (confirmer). */
  pris: Array<{ t: TypeItem; id: number; v: Valeur }>;
}

/** La date que montre le site pour une ligne de TITRES_SUIVIS (un faux jour d'IGDB est l'année). */
export function valeurSite(r: any, aujourdHui: string): Valeur {
  const v = valeurDe(r.d, r.p, r.cinema);
  return r.t === "game" ? sansFauxJour(v, aujourdHui) : v;
}

/** La date gardée avance : l'observation est finie. */
export async function confirmer(pool: any, t: TypeItem, id: number, v: Valeur, maintenant: number): Promise<void> {
  await pool.query(
    "UPDATE suivi_favoris_dates SET date_vue = ?, prec_vue = ?, cinema = ?, cand_date = NULL, cand_prec = NULL, cand_cinema = NULL, cand_depuis = NULL, vu_le = ? " +
      "WHERE item_type = ? AND item_id = ?",
    [v.date, v.prec, v.cinema ? 1 : 0, maintenant, t, id],
  );
}

/**
 * Compare la date de chaque titre suivi à celle gardée : garde la première vue, observe un changement, le prend après
 * 6 h sans bouger. Écrit seulement dans suivi_favoris_dates ; un changement pris à annoncer n'y avance pas encore
 * (rendu dans « pris » : le passage le note au journal, puis appelle confirmer).
 */
export async function suivreDates(pool: any, maintenant: number): Promise<BilanDates> {
  const res: BilanDates = { suivis: 0, nouveaux: 0, observation: 0, oublies: 0, trouves: [], pris: [] };
  const titres: any[] = await pool.query(TITRES_SUIVIS);
  const gardes: any[] = await pool.query(
    "SELECT item_type, CAST(item_id AS UNSIGNED) AS item_id, date_vue, prec_vue, cinema, cand_date, cand_prec, cand_cinema, cand_depuis FROM suivi_favoris_dates",
  );
  const parCle = new Map<string, any>();
  for (const g of gardes) parCle.set(`${g.item_type}:${N(g.item_id)}`, g);
  const aujourdHui = jourParis(maintenant);
  const vus = new Set<string>();
  for (const r of titres) {
    const t: TypeItem = r.t === "game" ? "game" : "anime";
    const id = N(r.id);
    const k = `${t}:${id}`;
    if (vus.has(k)) continue;
    vus.add(k);
    res.suivis++;
    const cur = valeurSite(r, aujourdHui);
    const g = parCle.get(k);
    if (!g) {
      // première vue : la date est gardée, rien n'est annoncé
      await pool.query(
        "INSERT INTO suivi_favoris_dates (item_type, item_id, date_vue, prec_vue, cinema, vu_le) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE date_vue = VALUES(date_vue), prec_vue = VALUES(prec_vue), cinema = VALUES(cinema), " +
          "cand_date = NULL, cand_prec = NULL, cand_cinema = NULL, cand_depuis = NULL, vu_le = VALUES(vu_le)",
        [t, id, cur.date, cur.prec, cur.cinema ? 1 : 0, maintenant],
      );
      res.nouveaux++;
      continue;
    }
    const vue = valeurDe(g.date_vue, g.prec_vue, g.cinema);
    if (memeValeur(cur, vue)) {
      // revenue à la date gardée (la source s'est reprise) : l'observation s'arrête
      if (g.cand_depuis !== null && g.cand_depuis !== undefined) {
        await pool.query("UPDATE suivi_favoris_dates SET cand_date = NULL, cand_prec = NULL, cand_cinema = NULL, cand_depuis = NULL, vu_le = ? WHERE item_type = ? AND item_id = ?", [maintenant, t, id]);
      }
      continue;
    }
    const enObservation = g.cand_depuis !== null && g.cand_depuis !== undefined;
    const cand = enObservation ? valeurDe(g.cand_date, g.cand_prec, g.cand_cinema) : null;
    if (!cand || !memeValeur(cand, cur)) {
      // un changement nouveau (ou un autre que celui observé) : observé à partir de maintenant
      await pool.query(
        "UPDATE suivi_favoris_dates SET cand_date = ?, cand_prec = ?, cand_cinema = ?, cand_depuis = ?, vu_le = ? WHERE item_type = ? AND item_id = ?",
        [cur.date, cur.prec, cur.cinema ? 1 : 0, maintenant, maintenant, t, id],
      );
      res.observation++;
      continue;
    }
    const depuis = N(g.cand_depuis);
    if (maintenant - depuis < STABLE_MS) {
      res.observation++;
      continue;
    }
    // resté 6 h : pris. À annoncer : noté au journal d'abord (le passage), la date gardée avance ensuite.
    const sorte = N(r.annule) === 1 ? null : classer(vue, cur, aujourdHui, t);
    if (!sorte) {
      await confirmer(pool, t, id, cur, maintenant);
      continue;
    }
    res.trouves.push({ ...changementDate(sorte, vue, cur, t, id, titreSite(r), r.cover || null, depuis), quand: maintenant });
    res.pris.push({ t, id, v: cur });
  }
  // les titres qui ne sont plus suivis : oubliés (un retour dans les favoris repart de la date du moment)
  for (const k of parCle.keys()) {
    if (vus.has(k)) continue;
    const [t, id] = k.split(":");
    await pool.query("DELETE FROM suivi_favoris_dates WHERE item_type = ? AND item_id = ?", [t, Number(id)]);
    res.oublies++;
  }
  return res;
}

// ─────────────────────────────────────────────────────────────── base

let TABLES: Promise<void> | null = null;
function tablesPretes(pool: any): Promise<void> {
  if (TABLES) return TABLES;
  const p = (async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS suivi_favoris (" +
        "cle VARCHAR(191) NOT NULL, sorte VARCHAR(8) NOT NULL, item_type VARCHAR(10) NOT NULL, item_id INT UNSIGNED NOT NULL, " +
        "event_type VARCHAR(64) NOT NULL, payload_json TEXT NOT NULL, quand BIGINT NOT NULL, releve_le BIGINT NOT NULL, " +
        "statut VARCHAR(12) NOT NULL, traite_le BIGINT NULL, abonnes INT NULL, " +
        "PRIMARY KEY (cle), KEY statut_quand (statut, quand), KEY releve (releve_le)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS suivi_favoris_dates (" +
        "item_type VARCHAR(10) NOT NULL, item_id INT UNSIGNED NOT NULL, date_vue CHAR(10) NULL, prec_vue VARCHAR(5) NULL, " +
        "cinema TINYINT(1) NOT NULL DEFAULT 0, cand_date CHAR(10) NULL, cand_prec VARCHAR(5) NULL, cand_cinema TINYINT(1) NULL, " +
        "cand_depuis BIGINT NULL, vu_le BIGINT NOT NULL, PRIMARY KEY (item_type, item_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
  })();
  // un échec (droits, base) sera retenté au prochain passage
  TABLES = p.catch((e) => {
    TABLES = null;
    throw e;
  });
  return TABLES;
}
/** Une table effacée depuis (base restaurée…) : recréée au passage suivant. */
function siTableAbsente(e: unknown): void {
  if ((e as any)?.errno === 1146) TABLES = null;
}
/** Pour les essais seulement : les tables seront recréées au prochain passage. */
export function _oublierTables(): void {
  TABLES = null;
}

/** Note les trouvailles nouvelles dans le journal ; rend celles qui y entrent (les autres y étaient déjà). */
async function noter(pool: any, trouves: Trouvaille[], statut: "attente" | "retenu", maintenant: number): Promise<Trouvaille[]> {
  const nouvelles: Trouvaille[] = [];
  for (const x of trouves) {
    const r: any = await pool.query(
      "INSERT IGNORE INTO suivi_favoris (cle, sorte, item_type, item_id, event_type, payload_json, quand, releve_le, statut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [x.cle, x.sorte, x.itemType, x.itemId, x.eventType, JSON.stringify(x.payload), x.quand, maintenant, statut],
    );
    if (N(r?.affectedRows) === 1) nouvelles.push(x);
  }
  return nouvelles;
}

/** Parmi ces trouvailles, celles qui ne sont pas encore au journal. */
async function absentes(pool: any, trouves: Trouvaille[]): Promise<Trouvaille[]> {
  if (!trouves.length) return [];
  const cles = trouves.map((x) => x.cle);
  const vus = new Set<string>();
  for (let i = 0; i < cles.length; i += 200) {
    const lot = cles.slice(i, i + 200);
    const r: any[] = await pool.query(`SELECT cle FROM suivi_favoris WHERE cle IN (${lot.map(() => "?").join(",")})`, lot);
    for (const x of r) vus.add(String(x.cle));
  }
  return trouves.filter((x) => !vus.has(x.cle));
}

const resume = (x: Trouvaille) => ({ titre: String(x.payload.title ?? ""), texte: String(x.payload.newValue ?? ""), sorte: x.sorte });

// ─────────────────────────────────────────────────────────────── les deux passages

/** « Épisodes et dates des favoris » : relève, note au journal, n'envoie rien. */
export async function passageSuivi(deps: SuiviDeps, maintenant: number = Date.now()): Promise<Record<string, any>> {
  try {
    return await suivi(deps, maintenant);
  } catch (e) {
    siTableAbsente(e);
    throw e;
  }
}
async function suivi(deps: SuiviDeps, maintenant: number): Promise<Record<string, any>> {
  const pool = deps.pool;
  await tablesPretes(pool);
  const bilan: Record<string, any> = { episodes: 0, dates: 0, retenus: 0 };
  const envoi = interrupteur("envoi-favoris") === true;
  bilan.envoi = envoi;
  // la semaine du site d'abord : /feed/week la garde en base (une lecture d'AnimeSchedule au plus toutes les 15 min)
  if (deps.rafraichirSemaine) {
    try {
      await deps.rafraichirSemaine();
    } catch (e) {
      bilan.semaineErreur = message(e);
    }
  }
  // les épisodes, puis les dates : une panne de l'un n'empêche pas l'autre (la ligne est en erreur)
  const erreurs: string[] = [];
  let epNeufs: Trouvaille[] = [];
  try {
    const ep = await releverEpisodes(pool, maintenant, FRAIS_EPISODE_MS);
    Object.assign(bilan, { semaines: ep.semaines, entrees: ep.entrees, retardes: ep.retardes, pasEncore: ep.enAttente, bruts: ep.bruts, sansPlateforme: ep.sansPlateforme, animesSuivis: ep.suivis });
    epNeufs = await absentes(pool, ep.trouves);
  } catch (e) {
    siTableAbsente(e);
    erreurs.push(`épisodes : ${message(e)}`);
  }
  let dt: BilanDates | null = null, dtNeufs: Trouvaille[] = [];
  try {
    dt = await suivreDates(pool, maintenant);
    Object.assign(bilan, { titresSuivis: dt.suivis, datesNouvelles: dt.nouveaux, observation: dt.observation, oublies: dt.oublies });
    dtNeufs = await absentes(pool, dt.trouves);
  } catch (e) {
    siTableAbsente(e);
    erreurs.push(`dates : ${message(e)}`);
    dt = null;
  }
  // le garde-fou vaut pour tout le passage : trop d'épisodes ou trop de dates, rien de ce passage ne part
  const retenu = epNeufs.length > MAX_EPISODES || dtNeufs.length > MAX_DATES;
  const statut = retenu ? "retenu" : "attente";
  let epNotes: Trouvaille[] = [], dtNotes: Trouvaille[] = [];
  try {
    epNotes = await noter(pool, epNeufs, statut, maintenant);
    dtNotes = await noter(pool, dtNeufs, statut, maintenant);
    // notés : les dates gardées avancent (une panne avant ce point : repris au passage suivant, avec la même clé)
    if (dt) for (const x of dt.pris) await confirmer(pool, x.t, x.id, x.v, maintenant);
  } catch (e) {
    siTableAbsente(e);
    erreurs.push(`journal : ${message(e)}`);
  }
  if (erreurs.length) bilan.erreur = erreurs.join(" ; ");
  bilan.episodes = epNotes.length;
  bilan.dates = dtNotes.length;
  bilan.retenus = retenu ? epNotes.length + dtNotes.length : 0;
  if (retenu) {
    const g: string[] = [];
    if (epNeufs.length > MAX_EPISODES) g.push(`${epNeufs.length} épisodes d'un coup`);
    if (dtNeufs.length > MAX_DATES) g.push(`${dtNeufs.length} changements de date d'un coup`);
    bilan.garde = g.join(", ");
  }
  bilan.trouvailles = [...epNotes, ...dtNotes].slice(0, 12).map((x) => ({ ...resume(x), statut: retenu ? "retenu" : envoi ? "a-envoyer" : "a-blanc" }));
  // envoi coupé : ce qui n'est plus frais est noté « à blanc » (il serait parti) ; allumé, la ligne d'envoi s'en charge
  if (!envoi) {
    const r: any = await pool.query(
      "UPDATE suivi_favoris SET statut = 'blanc', traite_le = ? WHERE statut = 'attente' AND ((sorte = 'episode' AND quand < ?) OR (sorte = 'date' AND quand < ?))",
      [maintenant, maintenant - FRAIS_EPISODE_MS, maintenant - FRAIS_DATE_MS],
    );
    bilan.blancs = N(r?.affectedRows);
  }
  await pool.query("DELETE FROM suivi_favoris WHERE releve_le < ?", [maintenant - GARDE_JOURNAL_MS]);
  const att: any[] = await pool.query("SELECT COUNT(*) AS n FROM suivi_favoris WHERE statut = 'attente'");
  bilan.enAttente = N(att[0]?.n);
  // du nouveau à envoyer : la ligne d'envoi passe tout de suite (si elle est allumée)
  if (envoi && !retenu && bilan.episodes + bilan.dates > 0) avancer("envoi-favoris", 5000);
  return bilan;
}

/** « Envoi aux abonnés » : la cloche des abonnés, pour ce qui est encore frais et encore vrai. */
export async function passageEnvoi(deps: SuiviDeps, maintenant: number = Date.now()): Promise<Record<string, any> | null> {
  try {
    return await envoi(deps, maintenant);
  } catch (e) {
    siTableAbsente(e);
    throw e;
  }
}
async function envoi(deps: SuiviDeps, maintenant: number): Promise<Record<string, any> | null> {
  const pool = deps.pool;
  await tablesPretes(pool);
  const lignes: any[] = await pool.query(
    "SELECT cle, sorte, item_type, CAST(item_id AS UNSIGNED) AS item_id, event_type, payload_json, quand FROM suivi_favoris WHERE statut = 'attente' ORDER BY quand, cle LIMIT 200",
  );
  if (!lignes.length) return null;
  const bilan: Record<string, any> = { envoyes: 0, abonnes: 0, tard: 0, annules: 0, liste: [] as any[] };
  const marquer = (cle: string, de: string, vers: string) =>
    pool.query("UPDATE suivi_favoris SET statut = ?, traite_le = ? WHERE cle = ? AND statut = ?", [vers, maintenant, cle, de]);
  // encore vrai au moment d'envoyer : l'épisode toujours dit sorti par la dernière semaine lue ; la date du site toujours
  // celle annoncée (lus une fois pour tout le passage)
  let episodesVrais: Set<string> | null = null, datesDuSite: Map<string, Valeur> | null = null;
  const aujourdHui = jourParis(maintenant);
  for (const l of lignes) {
    const frais = l.sorte === "episode" ? FRAIS_EPISODE_MS : FRAIS_DATE_MS;
    if (maintenant - N(l.quand) > frais) {
      await marquer(String(l.cle), "attente", "trop_tard");
      bilan.tard++;
      continue;
    }
    let payload: any;
    try {
      payload = JSON.parse(String(l.payload_json));
    } catch {
      await marquer(String(l.cle), "attente", "trop_tard");
      bilan.tard++;
      continue;
    }
    if (l.sorte === "episode") {
      if (!episodesVrais) episodesVrais = new Set((await releverEpisodes(pool, maintenant, FRAIS_EPISODE_MS)).trouves.map((x) => x.cle));
      if (!episodesVrais.has(String(l.cle))) {
        await marquer(String(l.cle), "attente", "annule");
        bilan.annules++;
        continue;
      }
    } else {
      if (!datesDuSite) {
        datesDuSite = new Map();
        for (const r of await pool.query(TITRES_SUIVIS)) datesDuSite.set(`${r.t}:${N(r.id)}`, valeurSite(r, aujourdHui));
      }
      const v = datesDuSite.get(`${l.item_type}:${N(l.item_id)}`);
      const voulu = valeurDe(payload?.date, payload?.precision);
      if (!v || !memeValeur({ ...v, cinema: false }, voulu)) {
        await marquer(String(l.cle), "attente", "annule");
        bilan.annules++;
        continue;
      }
    }
    // marqué « en cours » avant l'envoi : une panne pendant l'envoi ne le refait pas (une seule fois)
    const pris: any = await marquer(String(l.cle), "attente", "envoi");
    if (N(pris?.affectedRows) !== 1) continue;
    const type: TypeItem = l.item_type === "game" ? "game" : "anime";
    // une erreur ici arrête le passage ; la trouvaille reste « en cours » (rien n'est renvoyé)
    await deps.notifier(pool, type, N(l.item_id), String(l.event_type), String(l.cle), payload);
    const c: any[] = await pool.query(
      "SELECT COUNT(*) AS n FROM user_notifications un INNER JOIN notification_events ne ON ne.id = un.event_id WHERE ne.event_key = ?",
      [l.cle],
    );
    const n = N(c[0]?.n);
    await pool.query("UPDATE suivi_favoris SET statut = 'envoye', traite_le = ?, abonnes = ? WHERE cle = ? AND statut = 'envoi'", [maintenant, n, l.cle]);
    bilan.envoyes++;
    bilan.abonnes += n;
    if (bilan.liste.length < 12) bilan.liste.push({ titre: String(payload?.title ?? ""), texte: String(payload?.newValue ?? ""), abonnes: n });
  }
  return bilan.envoyes + bilan.tard + bilan.annules > 0 ? bilan : null;
}

/** Ce que montre la ligne « Épisodes et dates des favoris » : les derniers relevés du journal. */
async function derniersReleves(pool: any): Promise<Record<string, any>> {
  await tablesPretes(pool);
  let r: any[], c: any[];
  try {
    r = await pool.query("SELECT sorte, payload_json, quand, releve_le, statut, abonnes FROM suivi_favoris ORDER BY releve_le DESC, quand DESC LIMIT 10");
    c = await pool.query("SELECT statut, COUNT(*) AS n FROM suivi_favoris WHERE releve_le >= ? GROUP BY statut", [Date.now() - 7 * J]);
  } catch (e) {
    siTableAbsente(e);
    throw e;
  }
  const comptes: Record<string, number> = {};
  for (const x of c) comptes[String(x.statut)] = N(x.n);
  return {
    comptes,
    recents: r.map((x) => {
      let p: any = {};
      try {
        p = JSON.parse(String(x.payload_json));
      } catch {}
      return { sorte: String(x.sorte), titre: String(p?.title ?? ""), texte: String(p?.newValue ?? ""), quand: N(x.quand), statut: String(x.statut), abonnes: x.abonnes === null ? null : N(x.abonnes) };
    }),
  };
}

// ─────────────────────────────────────────────────────────────── l'essai à blanc

/**
 * Ce qui serait parti ces 7 derniers jours (les épisodes, avec le nombre d'abonnés) et les changements de date en
 * observation (ce qu'ils annonceraient s'ils restent 6 h). Lecture seule.
 */
export async function essai(pool: any, maintenant: number = Date.now()): Promise<Record<string, any>> {
  const ep = await releverEpisodes(pool, maintenant, ESSAI_MS);
  const abonnes = new Map<number, number>();
  const ids = [...new Set(ep.trouves.map((x) => x.itemId))];
  if (ids.length) {
    const r: any[] = await pool.query(
      `SELECT f.item_id AS id, COUNT(DISTINCT f.user_id) AS n FROM favorites f INNER JOIN users u ON u.id = f.user_id WHERE f.item_type = 'anime' AND u.notifications_enabled = 1 AND f.item_id IN (${ids.map(() => "?").join(",")}) GROUP BY f.item_id`,
      ids,
    );
    for (const x of r) abonnes.set(N(x.id), N(x.n));
  }
  const titres: any[] = await pool.query(TITRES_SUIVIS);
  const parCle = new Map<string, any>();
  for (const x of titres) parCle.set(`${x.t}:${N(x.id)}`, x);
  const aujourdHui = jourParis(maintenant);
  let gardees = 0, journal: Record<string, number> = {};
  const observation: any[] = [];
  try {
    const g: any[] = await pool.query("SELECT item_type, CAST(item_id AS UNSIGNED) AS item_id, date_vue, prec_vue, cinema, cand_date, cand_prec, cand_cinema, cand_depuis FROM suivi_favoris_dates");
    gardees = g.length;
    for (const x of g) {
      if (x.cand_depuis === null || x.cand_depuis === undefined) continue;
      const r = parCle.get(`${x.item_type}:${N(x.item_id)}`);
      const t: TypeItem = x.item_type === "game" ? "game" : "anime";
      const avant = valeurDe(x.date_vue, x.prec_vue, x.cinema), apres = valeurDe(x.cand_date, x.cand_prec, x.cand_cinema);
      const sorte = r && N(r.annule) !== 1 ? classer(avant, apres, aujourdHui, t) : null;
      observation.push({
        titre: r ? titreSite(r) : `${t} ${N(x.item_id)}`,
        depuis: new Date(N(x.cand_depuis)).toISOString(),
        texte: sorte ? changementDate(sorte, avant, apres, t, N(x.item_id), "", null, 0).payload.newValue : null,
        avant: avant.date ? libelleDate(avant.date, avant.prec) : "sans date",
        apres: apres.date ? libelleDate(apres.date, apres.prec) : "sans date",
      });
    }
    const j: any[] = await pool.query("SELECT statut, COUNT(*) AS n FROM suivi_favoris GROUP BY statut");
    for (const x of j) journal[String(x.statut)] = N(x.n);
  } catch {
    // tables pas encore créées (premier passage pas encore fait)
    journal = {};
  }
  return {
    ok: true,
    maintenant: new Date(maintenant).toISOString(),
    suivi: interrupteur("suivi-favoris") === true,
    envoi: interrupteur("envoi-favoris") === true,
    semaines: ep.semaines,
    sansRetards: ep.sansRetards,
    entrees: ep.entrees,
    retardes: ep.retardes,
    pasEncore: ep.enAttente,
    bruts: ep.bruts,
    sansPlateforme: ep.sansPlateforme,
    episodes: ep.trouves.map((x) => ({ titre: x.payload.title, texte: x.payload.newValue, episode: x.payload.episode, quand: x.payload.airingAt, abonnes: abonnes.get(x.itemId) ?? 0 })),
    dates: { titresSuivis: parCle.size, gardees, observation: observation.length, enObservation: observation.slice(0, 20) },
    journal,
  };
}

// ─────────────────────────────────────────────────────────────── démarrage

function cleAttendue(): string {
  return process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY || "";
}
function cleBonne(fournie: unknown): boolean {
  const attendue = cleAttendue();
  if (!attendue || typeof fournie !== "string") return false;
  const a = Buffer.from(attendue), b = Buffer.from(fournie);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** La route de l'essai à blanc (avant l'écoute de l'API, comme les autres routes). */
export function registerSuiviFavoris(app: FastifyInstance, deps: SuiviDeps): void {
  DEPS = deps;
  app.get("/admin/suivi-favoris/essai", async (req: any, reply: any) => {
    if (!cleBonne(req.headers["x-api-key"])) return reply.code(401).send({ ok: false, error: "Unauthorized" });
    try {
      return reply.send(await essai(deps.pool));
    } catch (e) {
      req.log.warn({ module: "suivi-favoris", err: message(e) }, "suivi des favoris : essai en erreur");
      return reply.code(500).send({ ok: false, error: message(e) });
    }
  });
}

/** Les deux lignes du Pilotage (après l'écoute de l'API : les passages relisent /feed/week par app.inject). */
export function startSuiviFavoris(): void {
  const deps = DEPS;
  if (!deps) throw new Error("registerSuiviFavoris d'abord");
  planifier({
    id: "suivi-favoris", premierMs: 3 * MIN, rythmeMs: 10 * MIN, actifParDefaut: true,
    infos: () => derniersReleves(deps.pool),
    passage: async () => {
      const b = await passageSuivi(deps);
      const log = { module: "suivi-favoris", episodes: b.episodes, dates: b.dates, retenus: b.retenus, envoi: b.envoi, enAttente: b.enAttente };
      if (b.garde) deps.log.warn({ ...log, garde: b.garde }, "suivi des favoris : garde-fou, rien de ce passage n'est envoyé");
      else if (b.episodes + b.dates > 0) deps.log.info(log, "suivi des favoris : relevé");
      return { bilan: b };
    },
  });
  planifier({
    id: "envoi-favoris", premierMs: 5 * MIN, rythmeMs: 10 * MIN, actifParDefaut: false,
    passage: async () => {
      const b = await passageEnvoi(deps);
      // rien à envoyer : rien n'est noté (un passage toutes les 10 min)
      if (!b) return { rien: true };
      if (b.envoyes) deps.log.info({ module: "envoi-favoris", envoyes: b.envoyes, abonnes: b.abonnes, tard: b.tard }, "envoi aux abonnés : envoyé");
      return { bilan: b };
    },
  });
}
