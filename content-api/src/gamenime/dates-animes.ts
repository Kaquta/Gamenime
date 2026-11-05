/**
 * dates-animes.ts — Dates des animés : AniList fait référence (19 octobre 2026).
 *
 * Relevé du 19 octobre (releve-dates-animes.sh) : 14 dates fausses sur 446, toutes montrées sur le site.
 *  - Sekiro: No Defeat affiché sorti le 4 septembre 2026 (avant-première au Japon) ; AniList : janvier 2027.
 *  - Junket Bank, reporté sans nouvelle date : le site gardait octobre 2026.
 *  - 12 séries datées quelques jours après la date d'AniList.
 * Causes : seule la Phase B remettait une date à jour, pour les 200 animés incomplets seulement ; une date n'était jamais
 * effacée ; la date au jour d'AnimeSchedule passait devant AniList, même ancienne ; la Phase B lisait AniList deux fois
 * plus vite que sa limite, et une lecture refusée laissait la place à l'autre source.
 *
 * Ce module, 40 min après le démarrage de l'API puis toutes les heures (ligne « Dates des animés » du Pilotage) :
 *  - relit chez AniList la date (startDate) et le statut des animés qui ont un identifiant AniList et qui sont datés dans
 *    la fenêtre du site ou après, sans date, ou datés au mois ou à l'année : par paquets de 50, une requête par paquet ;
 *  - AniList fait référence (verdictDate, que la Phase B applique aussi) : sa date est reprise quand elle diffère, dans
 *    les deux sens. La date du site est gardée à un jour près du jour d'AniList (le fuseau du Japon), ou quand elle tombe
 *    dans la période d'AniList (mois, année) avec au moins sa précision ;
 *  - un jour du site plus précis qu'AniList, pour un animé pas encore sorti, n'est gardé que si AnimeSchedule le
 *    confirme (relu ici : 20 fiches au plus par passage, les moins récemment relues d'abord ; un jour déjà passé ne peut
 *    plus l'être ; une fiche disparue ne confirme rien) ; sinon la date d'AniList est reprise
 *    (« janvier 2027 ») : un report qui garde le mois ou l'année, ou un jour inventé, n'envoie plus de rappel J-7 ni ne
 *    passe l'animé en « sorti ». De même, un mois plus précis que l'année d'AniList laisse la place à l'année ;
 *  - pas encore sorti chez AniList et sans date, alors que le site avait une date dans sa fenêtre : « Date à annoncer »
 *    (date effacée, date_a_annoncer = 1), à la fin d'« À venir », à la deuxième lecture sans date d'affilée, au moins
 *    45 min après la première (le passage suivant) : une date effacée un moment chez AniList puis remise ne fait ni
 *    « Date à annoncer » ni « Date annoncée » pour la même date (20 octobre 2026). En attendant la deuxième lecture,
 *    aucun rappel J-7 ni J0 ne part pour lui (sansDateAConfirmer, lu par index.ts). Quand AniList redonne une date, ses
 *    abonnés (favoris) sont prévenus sur le site, comme pour la première date d'un animé jamais daté, pas encore sorti.
 *    Un animé jamais daté reste comme avant (hors des listes) ; un film au cinéma en France garde ses dates ;
 *  - annulé chez AniList : retiré du site (statut_anilist = 'CANCELLED', voir ANIME_VISIBLE dans routes.ts ; ni rappel ni
 *    agenda, index.ts). Il revient tout seul si AniList le relance ;
 *  - rien n'est écrit sur un identifiant AniList douteux : partagé par plusieurs animés (doublon), ou une date d'AniList
 *    d'avant la fenêtre, à plus de 45 jours de celle du site (une autre saison ?) ; ni quand AniList se contredit (pas
 *    encore sorti mais daté du passé, ou sorti mais daté de l'avenir, ou un animé sorti sur le site qu'AniList dit pas
 *    encore sorti et sans date). Ces cas sont nommés dans le bilan du Pilotage ;
 *  - n'écrit que ce qui change, sans toucher updated_at ; vide le cache des flux s'il a changé quelque chose.
 * AniList est partagé : les requêtes AniList de ce module attendent leur tour dans la file commune de l'API
 * (file-anilist.ts : 2,5 s entre deux requêtes, tous modules confondus, sous la limite annoncée par AniList). Un refus
 * (429) suspend toute la file le temps demandé par AniList.
 * Variables, pour les essais seulement : ANILIST_URL (faux AniList), ANILIST_PAS_MS (pas de la file, file-anilist.ts),
 * ANIMESCHEDULE_API_URL (faux AnimeSchedule, comme refetch-cron.ts), DATES_CONFIRMATION_MS (écart minimal entre les deux
 * lectures sans date).
 */
import type { FastifyInstance } from "fastify";
import { pushActivity } from "./dashboard.js";
import { planifier } from "./pilotage.js";
import { clearFeedCache } from "./routes.js";
import type { Journal, SqlPool } from "./presse.js";
import { aniListRefuse, tourAniList } from "./file-anilist.js";

// ─────────────────────────────────────────────────────────────── AniList, partagé

// la file AniList commune est dans file-anilist.ts (toute l'API y passe) ; gardée ici pour les modules qui l'importent
export { aniListRefuse, tourAniList };
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── la règle

export type Precision = "day" | "month" | "year";
export interface DateDuSite {
  date: string | null;
  precision: Precision | null;
}
/** Ce qu'AniList dit d'un animé : sa date (startDate) et son statut. */
export interface DateAniList {
  date: string | null;
  precision: Precision | null;
  statut: string | null;
}
export type Verdict =
  | { quoi: "garder" }
  | { quoi: "ecrire"; date: string; precision: Precision }
  /** jour du site plus précis qu'AniList, animé pas encore sorti : gardé si AnimeSchedule le confirme, sinon la date d'AniList */
  | { quoi: "a-confirmer"; date: string; precision: Precision }
  | { quoi: "a-annoncer" }
  | { quoi: "annule" }
  | { quoi: "incoherent"; raison: string }
  | { quoi: "douteux"; raison: string };

const JOUR_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const jourUtc = (d: string): number => Date.parse(d.slice(0, 10) + "T00:00:00Z");
const ecartJours = (a: string, b: string): number => Math.round((jourUtc(a) - jourUtc(b)) / JOUR_MS);
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** Marge autour du début de la fenêtre : un écart de fuseau au 1er janvier n'est pas « une autre saison ». */
const MARGE_DOUTEUX_JOURS = 45;

/** Comme sur les cartes du site : « 8 janvier 2027 », « janvier 2027 », « courant 2027 ». */
export function libelleDate(date: string, precision: Precision | null): string {
  const [y, m, d] = date.split("-").map(Number);
  if (precision === "year") return `courant ${y}`;
  if (precision === "month") return `${MOIS[m - 1]} ${y}`;
  return `${d} ${MOIS[m - 1]} ${y}`;
}

export function precisionDe(p: unknown): Precision | null {
  return p === "day" || p === "month" || p === "year" ? p : null;
}

/** startDate d'AniList : date et précision (le 1er du mois pour un mois, le 1er janvier pour une année). */
export function dateDe(sd: any): { date: string | null; precision: Precision | null } {
  const y = Number(sd?.year), m = Number(sd?.month), j = Number(sd?.day);
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return { date: null, precision: null };
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (!Number.isInteger(m) || m < 1 || m > 12) return { date: `${y}-01-01`, precision: "year" };
  const iso = `${y}-${p2(m)}-${p2(j)}`;
  if (Number.isInteger(j) && j >= 1 && j <= 31 && new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso) return { date: iso, precision: "day" };
  return { date: `${y}-${p2(m)}-01`, precision: "month" };
}

/** La date du site tombe dans la période de ref avec au moins sa précision (à un jour près pour un jour : le fuseau du Japon). */
export function dansLaPeriode(site: DateDuSite, ref: { date: string; precision: Precision }): boolean {
  if (!site.date || !site.precision || !DATE_RE.test(site.date)) return false;
  if (ref.precision === "day") return site.precision === "day" && Math.abs(ecartJours(site.date, ref.date)) <= 1;
  if (ref.precision === "month") return site.precision !== "year" && site.date.slice(0, 7) === ref.date.slice(0, 7);
  return site.date.slice(0, 4) === ref.date.slice(0, 4);
}

const jjmmaaaa = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Ce que devient la date d'un animé d'après AniList, et le jour d'AnimeSchedule s'il est connu (Phase B, ou relu ici).
 *  1. date d'AniList d'avant la fenêtre, à plus de 45 jours de celle du site, que le site ne date pas d'avant la
 *     fenêtre : « douteux » (une autre saison ?), rien n'est écrit, pas même le statut ;
 *  2. annulé : « annule » (le module retire l'animé du site ; la date ne change pas) ;
 *  3. sans date chez AniList : pas encore sorti, « a-annoncer » (sauf un animé déjà sorti au jour sur le site :
 *     « incoherent ») ; autre statut, rien ;
 *  4. AniList se contredit (pas encore sorti mais daté au jour de plus de 2 jours, ou sorti mais daté au jour dans plus
 *     de 2 jours) : « incoherent », rien n'est écrit ;
 *  5. AniList au mois ou à l'année : un jour d'AnimeSchedule dans cette période la précise, sauf un jour déjà passé
 *     (de plus de 2 jours) quand AniList dit « pas encore sorti » ;
 *  6. date du site dans la période retenue, avec au moins sa précision : gardée ; mais un jour du site plus précis que
 *     la référence, pour un animé pas encore sorti, est « a-confirmer » par AnimeSchedule, ou remplacé tout de suite par
 *     la date retenue s'il est déjà passé (de plus de 2 jours : AnimeSchedule ne peut plus le confirmer, 5.) ; un mois
 *     plus précis que l'année d'AniList, pour un animé pas encore sorti, est remplacé par l'année ; sinon la date retenue
 *     est écrite.
 */
export function verdictDate(al: DateAniList, jourAS: string | null, site: DateDuSite, aujourdHui: string): Verdict {
  const debutFenetre = aujourdHui.slice(0, 4) + "-01-01";
  const alDate = al.date && al.precision && DATE_RE.test(al.date) ? al.date : null;
  const siteDate = site.date && DATE_RE.test(site.date) ? site.date : null;
  if (alDate && alDate < debutFenetre && !(siteDate && siteDate < debutFenetre) && !(siteDate && Math.abs(ecartJours(siteDate, alDate)) <= MARGE_DOUTEUX_JOURS)) {
    return { quoi: "douteux", raison: `AniList le date du ${jjmmaaaa(alDate)}, avant la fenêtre (une autre saison ?)` };
  }
  if (al.statut === "CANCELLED") return { quoi: "annule" };
  const pasSorti = al.statut === "NOT_YET_RELEASED";
  if (!alDate || !al.precision) {
    if (!pasSorti) return { quoi: "garder" };
    if (siteDate && site.precision === "day" && ecartJours(aujourdHui, siteDate) > 2) {
      return { quoi: "incoherent", raison: `sorti le ${jjmmaaaa(siteDate)} sur le site, mais pas encore sorti et sans date chez AniList` };
    }
    return { quoi: "a-annoncer" };
  }
  if (al.precision === "day" && pasSorti && ecartJours(aujourdHui, alDate) > 2) {
    return { quoi: "incoherent", raison: `pas encore sorti chez AniList, mais daté du ${jjmmaaaa(alDate)}` };
  }
  if (al.precision === "day" && (al.statut === "RELEASING" || al.statut === "FINISHED") && ecartJours(alDate, aujourdHui) > 2) {
    return { quoi: "incoherent", raison: `sorti chez AniList, mais daté du ${jjmmaaaa(alDate)}` };
  }
  let ref: { date: string; precision: Precision } = { date: alDate, precision: al.precision };
  if (jourAS && DATE_RE.test(jourAS) && al.precision !== "day" && dansLaPeriode({ date: jourAS, precision: "day" }, ref) && !(pasSorti && ecartJours(aujourdHui, jourAS) > 2)) {
    ref = { date: jourAS, precision: "day" };
  }
  if (dansLaPeriode(site, ref)) {
    if (pasSorti && site.precision === "day" && ref.precision !== "day") {
      // un jour déjà passé qu'AniList dit « pas encore sorti » : le site ne doit plus le montrer sorti
      if (ecartJours(aujourdHui, site.date!) > 2) return { quoi: "ecrire", date: ref.date, precision: ref.precision };
      return { quoi: "a-confirmer", date: ref.date, precision: ref.precision };
    }
    // un mois du site plus précis que l'année d'AniList : seul AniList donne un mois (AnimeSchedule donne un jour), c'est
    // donc un ancien état d'AniList, un report dans l'année : l'année d'AniList
    if (pasSorti && site.precision === "month" && ref.precision === "year") return { quoi: "ecrire", date: ref.date, precision: ref.precision };
    return { quoi: "garder" };
  }
  return { quoi: "ecrire", date: ref.date, precision: ref.precision };
}

// ─────────────────────────────────────────────────────────────── le passage

export interface DatesDeps {
  pool: SqlPool;
  log: Journal;
  /** Vide le cache des flux de l'API après écriture. */
  rafraichir?: () => void;
  /** Heure de la dernière lecture AnimeSchedule de chaque animé (pour les essais ; sinon celle du module). */
  luAS?: Map<number, number>;
  /** Heure de la première de ses lectures sans date d'affilée, par animé (pour les essais ; sinon celle du module). */
  sansDate?: Map<number, number>;
  /** Animés dont l'identifiant était absent d'AniList au dernier passage, avec cet identifiant (pour les essais ; sinon
   * ceux du module). */
  absents?: Map<number, number>;
}
export interface DatesConfig {
  url: string;
  /** AnimeSchedule (adresse et jeton), pour confirmer un jour du site plus précis qu'AniList. */
  asUrl: string;
  asJeton: string;
}
export function configDates(env: Record<string, string | undefined> = process.env): DatesConfig {
  return {
    url: env["ANILIST_URL"] || "https://graphql.anilist.co",
    asUrl: (env["ANIMESCHEDULE_API_URL"] || "https://animeschedule.net/api/v3").replace(/\/+$/, ""),
    asJeton: env["ANIMESCHEDULE_TOKEN"] || "",
  };
}

/** AniList refuse la requête (429). */
class TropDeRequetes extends Error {
  constructor(readonly attenteMs: number) {
    super("AniList : trop de requêtes (repris au prochain passage)");
  }
}

/** Réponse partielle d'AniList (des données et des erreurs) : ce paquet n'est pas relu à ce passage (20 octobre 2026). */
class ReponsePartielle extends Error {}

const PAQUET = 50;
/** Fiches AnimeSchedule lues au plus par passage, et le reste de requêtes qu'on laisse à la Phase B. */
const AS_MAX = 20;
const AS_RESTE_MIN = 25;
/** Heure de la dernière lecture AnimeSchedule de chaque animé à confirmer : les moins récemment relus passent d'abord. */
const LU_AS = new Map<number, number>();
/** « Date à annoncer » à la deuxième lecture sans date d'affilée, au moins 45 min après la première : l'heure de la
 * première, par animé (oubliée dès qu'AniList redonne une date ; après un redémarrage de l'API, reprise du bilan du dernier passage). */
const SANS_DATE = new Map<number, number>();
const CONFIRMATION_SANS_DATE_MS = process.env.DATES_CONFIRMATION_MS ? Math.max(0, Number(process.env.DATES_CONFIRMATION_MS) || 0) : 45 * 60 * 1000;
/** Les animés (numéros de fiche) dont l'identifiant AniList était absent de la réponse d'AniList au dernier passage, avec
 * cet identifiant : /anime/bulk ne remplace que celui-là (s'il a changé entre-temps, plus rien n'est remplacé). */
const ABSENTS = new Map<number, number>();
/** Plus de 5 absents dans un même paquet : réponse d'AniList jugée incomplète (incident chez eux), ses absents ne sont pas
 * notés pour /anime/bulk (ils restent signalés). */
const ABSENTS_PAQUET_MAX = 5;
/** La mémoire des lectures sans date a été reprise en base depuis le démarrage de l'API (chargerSansDate), et le
 * chargement en cours (partagé : les rappels et le premier passage attendent le même). */
let SANS_DATE_CHARGE = false;
let CHARGEMENT_SANS_DATE: Promise<void> | null = null;

/** Les animés lus sans date chez AniList à leur dernière lecture (en attente de la deuxième lecture, ou déjà « Date à
 * annoncer ») : index.ts n'envoie pas de rappel J-7 ni J0 pour eux (20 octobre 2026). */
export function sansDateAConfirmer(): ReadonlySet<number> {
  return new Set(SANS_DATE.keys());
}

/** Les animés dont l'identifiant AniList a disparu d'AniList (fiche fusionnée ou supprimée chez eux), vus au dernier passage :
 * index.ts (/anime/bulk) accepte alors de le remplacer par celui d'un envoi du même animé (même MAL quand les deux en ont un,
 * sinon même titre). */
export function absentsDAniList(): ReadonlyMap<number, number> {
  return new Map(ABSENTS);
}

/** Après un redémarrage de l'API, la mémoire des lectures sans date est vide : elle est reprise une fois du bilan du dernier
 * passage (pilotage_passages). Sans cela, la deuxième lecture attendrait jusqu'à 2 h, et un rappel J-7 ou J0 pourrait
 * partir entre-temps pour une date qu'AniList a retirée. En cas d'échec (table absente, base indisponible), nouvel essai
 * au prochain appel. */
export async function chargerSansDate(pool: SqlPool): Promise<void> {
  if (SANS_DATE_CHARGE) return;
  if (!CHARGEMENT_SANS_DATE) CHARGEMENT_SANS_DATE = lireSansDate(pool).finally(() => (CHARGEMENT_SANS_DATE = null));
  await CHARGEMENT_SANS_DATE;
}

/** Le dernier passage qui a noté sa mémoire (un passage en erreur dès le début, ou un bilan tronqué, ne la porte pas). */
async function lireSansDate(pool: SqlPool): Promise<void> {
  try {
    const r: any = await pool.query("SELECT bilan FROM pilotage_passages WHERE module = 'dates-animes' AND fin IS NOT NULL AND JSON_EXISTS(bilan, '$.aConfirmer') ORDER BY id DESC LIMIT 1");
    let b: any = null;
    try {
      b = r?.[0]?.bilan ? JSON.parse(String(r[0].bilan)) : null;
    } catch {
      b = null;
    }
    for (const x of Array.isArray(b?.aConfirmer) ? b.aConfirmer : []) {
      const id = Number(x?.[0]), t = Number(x?.[1]);
      if (Number.isInteger(id) && id > 0 && Number.isFinite(t) && t > 0 && !SANS_DATE.has(id)) SANS_DATE.set(id, t);
    }
    SANS_DATE_CHARGE = true;
  } catch {
    // nouvel essai au prochain appel
  }
}

/** index.ts (/anime/bulk) vient de remplacer l'identifiant disparu de cet animé : une seule fois par disparition vue (un
 * autre envoi ne le remplace pas de nouveau ; le passage suivant relit le nouvel identifiant). */
export function absentRemplace(id: number): void {
  ABSENTS.delete(id);
}

/** Les envois de /anime/bulk ignorés (autre identifiant AniList que la fiche) déjà montrés au tableau de bord : une fois par
 * fiche et par identifiant tant que l'API tourne (un homonyme renvoyé à chaque import n'en chasse pas les autres lignes). */
const IGNORES_MONTRES = new Set<string>();
export function ignoreAMontrer(fiche: number, anilistId: number): boolean {
  const cle = `${fiche}:${anilistId}`;
  if (IGNORES_MONTRES.has(cle)) return false;
  if (IGNORES_MONTRES.size >= 1000) IGNORES_MONTRES.clear();
  IGNORES_MONTRES.add(cle);
  return true;
}

/** Date et statut de 50 animés au plus. Lève une erreur sur un 429, une erreur HTTP ou une réponse illisible. */
export async function pageDates(cfg: DatesConfig, ids: number[]): Promise<Map<number, DateAniList>> {
  await tourAniList();
  const query = "query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id status startDate { year month day } } } }";
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { ids } }),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) throw new TropDeRequetes(aniListRefuse(r.headers.get("retry-after")));
  if (!r.ok) throw new Error(`AniList : HTTP ${r.status}`);
  const d: any = await r.json().catch(() => null);
  // GraphQL : AniList peut répondre 200 avec une erreur dans le corps et data vide
  if (!Array.isArray(d?.data?.Page?.media)) {
    const msg = d?.errors?.[0]?.message ? ` (${String(d.errors[0].message).slice(0, 80)})` : "";
    throw new Error("AniList : réponse illisible" + msg);
  }
  // une réponse partielle (des données et des erreurs) peut porter des dates vides : elle ne compte pas (des animés
  // passeraient à tort « sans date ») ; ce paquet seul n'est pas relu, il est repris au passage suivant
  if (Array.isArray(d?.errors) && d.errors.length) {
    throw new ReponsePartielle("AniList : réponse partielle" + (d.errors[0]?.message ? ` (${String(d.errors[0].message).slice(0, 80)})` : ""));
  }
  const out = new Map<number, DateAniList>();
  for (const m of d.data.Page.media) {
    const id = Number(m?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.set(id, { ...dateDe(m?.startDate), statut: typeof m?.status === "string" ? m.status : null });
  }
  return out;
}

/** Un paquet, réessayé une fois après un 429 (l'attente demandée par AniList). */
async function paquetDates(cfg: DatesConfig, ids: number[], compter: () => void): Promise<Map<number, DateAniList>> {
  try {
    compter();
    return await pageDates(cfg, ids);
  } catch (e) {
    if (!(e instanceof TropDeRequetes)) throw e;
    await dormir(e.attenteMs);
    compter();
    return pageDates(cfg, ids);
  }
}

/** Le jour de sortie qu'AnimeSchedule donne (premier, lu comme la Phase B le lit), null s'il n'en donne pas, et ses
 * requêtes restantes ; « erreur » si la fiche est illisible ou AnimeSchedule en panne ; « limite » sur un 429 (la Phase B
 * se sert aussi d'AnimeSchedule). Une fiche disparue (404 : route renommée ou supprimée) ne confirme aucun jour. */
async function jourAnimeSchedule(cfg: DatesConfig, route: string): Promise<{ jour: string | null; reste: number | null; introuvable?: true } | "erreur" | "limite"> {
  try {
    const r = await fetch(cfg.asUrl + "/anime/" + encodeURIComponent(route), {
      headers: { Authorization: "Bearer " + cfg.asJeton, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 429) return "limite";
    const brut = r.headers.get("x-ratelimit-remaining");
    const reste = brut !== null && Number.isFinite(Number(brut)) ? Number(brut) : null;
    if (r.status === 404) return { jour: null, reste, introuvable: true };
    if (!r.ok) return "erreur";
    const d: any = await r.json().catch(() => null);
    if (!d || typeof d !== "object") return "erreur";
    // son « 0001-01-01 » veut dire : aucune date
    const p = typeof d.premier === "string" && !d.premier.startsWith("0001-01-01") ? /^(\d{4}-\d{2}-\d{2})/.exec(d.premier) : null;
    return { jour: p ? p[1] : null, reste };
  } catch {
    return "erreur";
  }
}

interface Ligne {
  id: number;
  title: string | null;
  cover: string | null;
  anilist_id: number;
  anime_schedule_route: string | null;
  release_date: string | null;
  release_precision: string | null;
  date_a_annoncer: number;
  statut_anilist: string | null;
  cinema: number;
}

/** Bilan d'un passage (montré par la ligne « Dates des animés » du Pilotage). */
export interface BilanDates {
  /** Animés relus (identifiant AniList ; dans la fenêtre ou après, sans date, ou datés au mois ou à l'année). */
  lus: number;
  /** Requêtes envoyées à AniList, et fiches lues chez AnimeSchedule (dont celles en erreur). */
  requetes: number;
  requetesAS: number;
  erreursAS: number;
  /** Fiches AnimeSchedule introuvables (404) : plusieurs dans un passage, l'adresse de l'API a peut-être changé. */
  introuvablesAS: number;
  /** Animés absents de la réponse d'AniList (fiche supprimée ou fusionnée) : rien n'est changé. */
  absents: number;
  /** Animés dont l'identifiant AniList est porté par un autre animé (doublon) : rien n'est changé. */
  partages: number;
  /** Dates changées (dont celles qui reviennent après « Date à annoncer »). */
  changees: number;
  /** Jours du site plus précis qu'AniList : confirmés par AnimeSchedule, ou remplacés par la date d'AniList. */
  confirmes: number;
  nonConfirmes: number;
  /** Passés à « Date à annoncer » à ce passage. */
  aAnnoncer: number;
  /** Pas encore sortis et sans date chez AniList, pas encore confirmés (première lecture sans date, ou deuxième moins de
   * 45 min après) : « Date à annoncer » au passage suivant si AniList ne redonne pas de date ; rien n'est changé ici. */
  sansDate: number;
  /** Paquets laissés pour une réponse partielle d'AniList : ni relus ni écrits à ce passage, repris au suivant. */
  partiels: number;
  /** Les animés en attente de leur deuxième lecture sans date, avec l'heure de la première : repris par chargerSansDate
   * après un redémarrage de l'API (les 500 plus récents au plus). */
  aConfirmer?: Array<[number, number]>;
  /** Datés après « Date à annoncer », ou datés pour la première fois et pas encore sortis : leurs abonnés sont prévenus. */
  annoncees: number;
  /** Abonnés prévenus d'une date annoncée. */
  prevenus: number;
  /** Passés à « annulé » chez AniList (retirés du site), et relancés (de retour). */
  annules: number;
  relances: number;
  /** AniList se contredit, ou identifiant douteux : rien n'est changé. */
  incoherents: number;
  douteux: number;
  /** Écritures refusées par la base (le passage continue). */
  echecs: number;
  /** Ce qui a arrêté le passage (AniList, ou la base après 3 refus de suite). */
  erreur?: string;
  erreurBase?: string;
  changements: Array<{ titre: string; avant: string; apres: string }>;
  signales: Array<{ titre: string; raison: string }>;
}

const LISTE_MAX = 30;

function texteDate(date: string | null, precision: Precision | null, aAnnoncer: boolean): string {
  if (aAnnoncer && !date) return "Date à annoncer";
  if (!date || !DATE_RE.test(date)) return "sans date";
  return precision ? libelleDate(date, precision) : `${libelleDate(date, "day")} (précision inconnue)`;
}

/** Prévient sur le site les abonnés (favoris) d'un animé dont la date est annoncée ; rend le nombre de prévenus. */
async function prevenirAbonnes(pool: SqlPool, l: Ligne, date: string, precision: Precision): Promise<number> {
  // même événement que index.ts (createNotificationsForItemChange : « Date annoncée ») : une seule notification par date
  const payload = { title: l.title, cover: l.cover, label: "Date annoncée", oldValue: "Date à annoncer", newValue: libelleDate(date, precision) };
  const r: any = await pool.query(
    "INSERT INTO notification_events (item_type, item_id, event_type, event_key, payload_json, event_at) " +
      "VALUES ('anime', ?, 'anime_release_date_announced', ?, ?, NOW()) " +
      "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), payload_json = VALUES(payload_json), event_at = VALUES(event_at)",
    [l.id, `anime:${l.id}:release_date:${date}`, JSON.stringify(payload)]
  );
  const evenement = Number(r?.insertId || 0);
  if (!evenement) throw new Error("événement de notification non créé");
  const f: any = await pool.query(
    "INSERT IGNORE INTO user_notifications (user_id, event_id, deliver_at) " +
      "SELECT f.user_id, ?, NULL FROM favorites f INNER JOIN users u ON u.id = f.user_id " +
      "WHERE f.item_type = 'anime' AND f.item_id = ? AND u.notifications_enabled = 1",
    [evenement, l.id]
  );
  return Number(f?.affectedRows || 0);
}

/** Erreur du pilote mariadb : code et texte du serveur, sans la requête ni ses valeurs. */
function texteErreurBase(e: unknown): string {
  const err = e as { code?: string; text?: string; message?: string };
  return (err?.text ? (err.code ? err.code + " : " : "") + err.text : String(err?.message ?? e)).slice(0, 160);
}

/** Un passage : relit la date et le statut des animés chez AniList et écrit ce qui change. */
export async function passageDatesAnimes(deps: DatesDeps, cfg: DatesConfig = configDates(), maintenant: Date = new Date()): Promise<BilanDates> {
  const aujourdHui = maintenant.toISOString().slice(0, 10);
  const debutFenetre = aujourdHui.slice(0, 4) + "-01-01";
  const finFenetre = `${Number(aujourdHui.slice(0, 4)) + 1}-12-31`;
  const vusSansDate = deps.sansDate ?? SANS_DATE;
  const absentsAL = deps.absents ?? ABSENTS;
  // après un redémarrage de l'API : la mémoire des lectures sans date reprend celle du dernier passage
  if (!deps.sansDate) await chargerSansDate(deps.pool);
  let lignes: Ligne[];
  try {
    lignes = await deps.pool.query(
      "SELECT id, title, cover, anilist_id, anime_schedule_route, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, release_precision, " +
        "date_a_annoncer, statut_anilist, (format = 'MOVIE' AND fr_cinema IS NOT NULL) AS cinema FROM anime_items " +
        "WHERE anilist_id IS NOT NULL AND anilist_id > 0 AND (release_date IS NULL OR release_date >= ? OR release_precision IS NULL " +
        "OR release_precision <> 'day' OR date_a_annoncer = 1 OR statut_anilist = 'CANCELLED') ORDER BY popularity DESC, id",
      [debutFenetre]
    );
  } catch (e) {
    // « Base de données » au Pilotage (et non « AniList »), sans le texte de la requête
    throw new Error(`base : ${texteErreurBase(e)}`);
  }
  const res: BilanDates = {
    lus: lignes.length, requetes: 0, requetesAS: 0, erreursAS: 0, introuvablesAS: 0, absents: 0, partages: 0, changees: 0, confirmes: 0, nonConfirmes: 0, aAnnoncer: 0, sansDate: 0, partiels: 0,
    annoncees: 0, prevenus: 0, annules: 0, relances: 0, incoherents: 0, douteux: 0, echecs: 0, changements: [], signales: [],
  };
  const signaler = (titre: string, raison: string) => {
    if (res.signales.length < LISTE_MAX) res.signales.push({ titre, raison });
  };
  // un identifiant AniList porté par deux animés (doublon pas encore fusionné, ou mauvais rattachement) : on n'y touche pas
  const parAnilist = new Map<number, Ligne[]>();
  for (const l of lignes) {
    const a = Number(l.anilist_id);
    const liste = parAnilist.get(a);
    if (liste) liste.push(l);
    else parAnilist.set(a, [l]);
  }
  const ids: number[] = [];
  for (const [a, liste] of parAnilist) {
    if (liste.length > 1) {
      res.partages += liste.length;
      signaler(liste.map((x) => x.title || `#${x.id}`).join(" / "), `identifiant AniList ${a} porté par ${liste.length} animés`);
    } else ids.push(a);
  }
  let ecrit = false;
  let refusDeSuite = 0;
  let arret = false;
  // paquets relus ; le texte de la première réponse partielle d'AniList (ces paquets sont comptés dans res.partiels)
  let paquetsLus = 0;
  let premierPartiel = "";

  /** Écrit ce qui change pour une ligne, d'après son verdict. Rend false quand la base a refusé 3 écritures de suite. */
  const traiter = async (l: Ligne, verdict: Verdict, statutAniList: string | null, confirmation: "confirme" | "non-confirme" | null): Promise<boolean> => {
    const titre = l.title || `#${l.id}`;
    const site: DateDuSite = { date: l.release_date, precision: precisionDe(l.release_precision) };
    const aAnnoncer = Number(l.date_a_annoncer) === 1;
    const cinema = Number(l.cinema) === 1;
    // ce qui change : la date (et l'heure de sortie avec elle quand la date disparaît), le drapeau, le statut
    let date: { date: string | null; precision: Precision | null; aAnnoncer: 0 | 1 } | null = null;
    let annonce = false;
    if (verdict.quoi === "a-annoncer") {
      // seulement un animé reporté (il avait une date) et montré (sa date était dans la fenêtre du site) ; un film au
      // cinéma en France garde ses dates, et ses rappels (il n'attend pas de deuxième lecture)
      if (cinema) vusSansDate.delete(l.id);
      if (l.release_date && l.release_date >= debutFenetre && l.release_date <= finFenetre && !cinema) {
        // à la deuxième lecture sans date d'affilée, au moins 45 min après la première (le passage suivant)
        const premiere = vusSansDate.get(l.id);
        if (premiere !== undefined && maintenant.getTime() - premiere >= CONFIRMATION_SANS_DATE_MS) date = { date: null, precision: null, aAnnoncer: 1 };
        else {
          if (premiere === undefined) vusSansDate.set(l.id, maintenant.getTime());
          res.sansDate++;
          signaler(titre, `sans date chez AniList (sur le site : ${texteDate(l.release_date, site.precision, false)}) : « Date à annoncer » si le passage suivant le confirme`);
        }
      }
    } else if (verdict.quoi === "ecrire") {
      date = { date: verdict.date, precision: verdict.precision, aAnnoncer: 0 };
      // ses abonnés sont prévenus : un animé « Date à annoncer » qui reçoit une date, ou un animé jamais daté (le site le
      // montre aussi « Date à annoncer ») qui reçoit sa première date et n'est pas encore sorti
      const finPeriode = verdict.precision === "day" ? verdict.date : verdict.precision === "month" ? verdict.date.slice(0, 7) + "-31" : verdict.date.slice(0, 4) + "-12-31";
      annonce = aAnnoncer || (!l.release_date && statutAniList === "NOT_YET_RELEASED" && finPeriode >= aujourdHui);
    } else if (verdict.quoi === "garder" && aAnnoncer && l.release_date && site.precision) {
      // drapeau resté levé à côté d'une date écrite entre-temps (Phase B) : la date est annoncée
      date = { date: l.release_date, precision: site.precision, aAnnoncer: 0 };
      annonce = true;
    }
    if (verdict.quoi === "incoherent" || verdict.quoi === "douteux") {
      if (verdict.quoi === "incoherent") res.incoherents++;
      else res.douteux++;
      signaler(titre, verdict.raison);
    }
    // un identifiant douteux est peut-être celui d'un autre animé : son statut n'est pas repris non plus
    const statut = verdict.quoi !== "douteux" && statutAniList && statutAniList !== l.statut_anilist ? statutAniList : null;
    if (!date && !statut) {
      if (confirmation === "confirme") res.confirmes++;
      return true;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (date) {
      sets.push("release_date = ?", "release_precision = ?", "date_a_annoncer = ?");
      params.push(date.date, date.precision, date.aAnnoncer);
      // l'heure de sortie (première diffusion imminente, ou prochain épisode d'une série en cours) : effacée avec la date,
      // pour une date qui n'est pas au jour, ou quand la première d'un animé pas encore sorti change de jour
      if (!date.date || date.precision !== "day" || (statutAniList === "NOT_YET_RELEASED" && date.date !== l.release_date)) sets.push("release_datetime = NULL");
    }
    if (statut) {
      sets.push("statut_anilist = ?");
      params.push(statut);
    }
    let r: any;
    try {
      // écrit seulement si la ligne n'a pas changé depuis la lecture ; updated_at reste tel quel
      r = await deps.pool.query(
        "UPDATE anime_items SET " + sets.join(", ") + ", updated_at = updated_at WHERE id = ? AND release_date <=> ? AND release_precision <=> ? " +
          "AND date_a_annoncer = ? AND statut_anilist <=> ?" +
          // « Date à annoncer » : jamais un film dont la date du cinéma vient d'être écrite (plateformes.ts, entre la lecture
          // et cette écriture) : il garde ses dates
          (date && !date.date ? " AND NOT (IFNULL(format, '') = 'MOVIE' AND fr_cinema IS NOT NULL)" : ""),
        [...params, l.id, l.release_date, l.release_precision, Number(l.date_a_annoncer) || 0, l.statut_anilist]
      );
    } catch (e) {
      const texte = texteErreurBase(e);
      res.echecs++;
      res.erreurBase ??= texte;
      if (++refusDeSuite >= 3) {
        res.erreur = `base : ${texte} (passage arrêté après 3 refus de suite)`;
        return false;
      }
      return true;
    }
    refusDeSuite = 0;
    if (Number(r?.affectedRows ?? 0) === 0) return true;
    ecrit = true;
    if (confirmation === "confirme") res.confirmes++;
    else if (confirmation === "non-confirme") res.nonConfirmes++;
    if (statut === "CANCELLED") {
      res.annules++;
      signaler(titre, "annulé chez AniList : retiré du site");
    } else if (statut && l.statut_anilist === "CANCELLED") {
      res.relances++;
      signaler(titre, "relancé chez AniList : de retour sur le site");
    }
    if (!date) return true;
    if (!date.date) res.aAnnoncer++;
    // une date écrite (le drapeau baissé seul, la date déjà là, ne compte pas : « mars 2027 → mars 2027 »)
    const nouvelle = !!date.date && (date.date !== l.release_date || date.precision !== site.precision);
    if (nouvelle) res.changees++;
    let note = false;
    if ((nouvelle || !date.date) && res.changements.length < LISTE_MAX) {
      res.changements.push({ titre, avant: texteDate(l.release_date, site.precision, aAnnoncer), apres: texteDate(date.date, date.precision, !date.date) });
      note = true;
    }
    if (date.date && annonce) {
      res.annoncees++;
      // un film au cinéma en France garde la date du cinéma sur le site : rien à annoncer
      if (!cinema) {
        try {
          res.prevenus += await prevenirAbonnes(deps.pool, l, date.date, date.precision as Precision);
        } catch (e) {
          // notification pas faite : la ligne est remise comme avant (si elle n'a pas changé entre-temps) ; le passage
          // suivant écrit de nouveau la date et prévient de nouveau
          deps.log.warn({ module: "dates-animes", id: l.id, err: (e as Error).message }, "dates des animés : abonnés non prévenus");
          const remis: any = await deps.pool.query(
            "UPDATE anime_items SET release_date = ?, release_precision = ?, date_a_annoncer = ?, updated_at = updated_at WHERE id = ? AND release_date <=> ? AND date_a_annoncer = 0",
            [l.release_date, l.release_precision, Number(l.date_a_annoncer) || 0, l.id, date.date]
          ).catch(() => null);
          if (Number(remis?.affectedRows ?? 0) === 1) {
            // rien n'a changé pour ce passage : ni date changée, ni date annoncée
            res.annoncees--;
            if (nouvelle) res.changees--;
            if (note) res.changements.pop();
            signaler(titre, "abonnés pas prévenus : date remise comme avant (nouvel essai au passage suivant)");
          } else {
            signaler(titre, "abonnés pas prévenus");
          }
        }
      }
    }
    return true;
  };

  // les jours à confirmer par AnimeSchedule (jour du site plus précis qu'AniList, pas encore sorti, fiche AnimeSchedule
  // connue) : traités après les autres, les moins récemment relus d'abord
  const aConfirmer: Array<{ l: Ligne; v: DateAniList; verdict: Extract<Verdict, { quoi: "a-confirmer" }> }> = [];
  paquets: for (let i = 0; i < ids.length; i += PAQUET) {
    const paquet = ids.slice(i, i + PAQUET);
    let valeurs: Map<number, DateAniList>;
    try {
      valeurs = await paquetDates(cfg, paquet, () => res.requetes++);
    } catch (e) {
      if (e instanceof ReponsePartielle) {
        // ce paquet seul n'est pas relu (ni date, ni « sans date », ni absent) : les autres le sont ; repris au passage
        // suivant
        res.partiels++;
        premierPartiel ||= e.message;
        signaler(`${paquet.length} animé(s), paquet ${i / PAQUET + 1}`, `${e.message} : pas relus à ce passage (repris au suivant)`);
        continue;
      }
      res.erreur = (e as Error).message;
      break;
    }
    paquetsLus++;
    // trop d'absents dans le paquet : réponse incomplète d'AniList, ses absents ne sont pas notés pour /anime/bulk
    const absentsFiables = paquet.filter((x) => !valeurs.has(x)).length <= ABSENTS_PAQUET_MAX;
    for (const a of paquet) {
      const l = parAnilist.get(a)![0];
      const v = valeurs.get(a);
      if (!v) {
        res.absents++;
        if (absentsFiables) absentsAL.set(l.id, a);
        signaler(l.title || `#${l.id}`, "absent d'AniList (fiche supprimée ou fusionnée ?) : rien n'est changé");
        continue;
      }
      absentsAL.delete(l.id);
      // AniList donne une date, ou un autre statut que « pas encore sorti » : les lectures sans date repartent de zéro
      if ((v.date && v.precision) || v.statut !== "NOT_YET_RELEASED") vusSansDate.delete(l.id);
      const site: DateDuSite = { date: l.release_date, precision: precisionDe(l.release_precision) };
      const verdict = verdictDate(v, null, site, aujourdHui);
      if (verdict.quoi === "a-confirmer" && l.anime_schedule_route) {
        aConfirmer.push({ l, v, verdict });
        continue;
      }
      let final: Verdict = verdict;
      let confirmation: "confirme" | "non-confirme" | null = null;
      if (verdict.quoi === "a-confirmer") {
        // pas de fiche AnimeSchedule pour confirmer le jour : la date d'AniList
        final = { quoi: "ecrire", date: verdict.date, precision: verdict.precision };
        confirmation = "non-confirme";
      } else if (verdict.quoi === "ecrire" && site.precision === "day" && verdict.precision !== "day" && dansLaPeriode(site, verdict)) {
        // un jour déjà passé qu'AniList dit « pas encore sorti » : remplacé tout de suite par la date d'AniList
        confirmation = "non-confirme";
      }
      if (!(await traiter(l, final, v.statut, confirmation))) {
        arret = true;
        break paquets;
      }
    }
  }
  // aucune réponse complète d'AniList : le passage est en erreur au Pilotage
  if (res.partiels && !paquetsLus && !res.erreur) res.erreur = `${premierPartiel} : aucun paquet relu`;
  if (!arret && aConfirmer.length) {
    // 20 fiches AnimeSchedule au plus par passage, les moins récemment relues d'abord (à égalité, les plus populaires) :
    // s'il y en a plus de 20, elles sont toutes relues à tour de rôle
    const lu = deps.luAS ?? LU_AS;
    aConfirmer.sort((x, y) => (lu.get(x.l.id) ?? 0) - (lu.get(y.l.id) ?? 0));
    let asFini = !cfg.asJeton;
    for (const { l, v, verdict } of aConfirmer) {
      const site: DateDuSite = { date: l.release_date, precision: precisionDe(l.release_precision) };
      let r: Awaited<ReturnType<typeof jourAnimeSchedule>> | null = null;
      if (!asFini && res.requetesAS < AS_MAX) {
        res.requetesAS++;
        r = await jourAnimeSchedule(cfg, l.anime_schedule_route!);
        // une fiche refusée (429) n'a pas été lue : elle garde sa place dans la file
        if (r !== "limite") lu.set(l.id, Date.now());
        if (r === "erreur") res.erreursAS++;
        else if (typeof r === "object" && r.introuvable) res.introuvablesAS++;
        // un 429, peu de requêtes restantes, ou deux fiches en erreur (panne, jeton refusé) : plus de lecture pour ce
        // passage (on en laisse à la Phase B ; une panne ne fait pas attendre 15 s par fiche)
        if (r === "limite" || res.erreursAS >= 2 || (typeof r === "object" && r.reste !== null && r.reste < AS_RESTE_MIN)) asFini = true;
      }
      let final: Verdict;
      let confirmation: "confirme" | "non-confirme" | null = null;
      if (r && typeof r === "object") {
        const avecAS = verdictDate(v, r.jour, site, aujourdHui);
        if (avecAS.quoi === "garder" || avecAS.quoi === "ecrire") {
          // le jour du site, ou celui d'AnimeSchedule dans la période d'AniList (ou la date d'AniList si le jour
          // d'AnimeSchedule est hors de sa période)
          final = avecAS;
          confirmation = avecAS.quoi === "garder" || avecAS.precision === "day" ? "confirme" : "non-confirme";
        } else {
          // AnimeSchedule ne confirme pas le jour (sans date, ou un jour hors de la période d'AniList) : la date d'AniList
          final = { quoi: "ecrire", date: verdict.date, precision: verdict.precision };
          confirmation = "non-confirme";
        }
      } else {
        // AnimeSchedule pas lu (en panne, trop de requêtes, plafond du passage) : rien ne change, nouvel essai à l'heure suivante
        const pourquoi = r === "erreur" ? "AnimeSchedule ne répond pas" : r === "limite" ? "AnimeSchedule : trop de requêtes" : "AnimeSchedule pas relu à ce passage";
        signaler(l.title || `#${l.id}`, `jour du ${jjmmaaaa(l.release_date!)} plus précis qu'AniList (${texteDate(verdict.date, verdict.precision, false)}), pas encore confirmé : ${pourquoi}`);
        final = { quoi: "garder" };
      }
      if (!(await traiter(l, final, v.statut, confirmation))) break;
    }
  }
  if (ecrit) deps.rafraichir?.();
  // la mémoire des lectures sans date : les animés qui ne sont plus relus (fiche supprimée, sortis de la sélection) sont
  // oubliés ; elle est notée dans le bilan (reprise après un redémarrage de l'API), les 500 plus récentes au plus
  const relus = new Set(lignes.map((x) => x.id));
  for (const id of [...vusSansDate.keys()]) if (!relus.has(id)) vusSansDate.delete(id);
  res.aConfirmer = [...vusSansDate.entries()].slice(-500);
  return res;
}

// ─────────────────────────────────────────────────────────────── le Pilotage

/** Déclaré par startRefetchCron (refetch-cron.ts) : 40 min après le démarrage, puis toutes les heures. */
export function planifierDatesAnimes(app: FastifyInstance): void {
  planifier({
    id: "dates-animes", premierMs: 40 * 60 * 1000, rythmeMs: 60 * 60 * 1000,
    passage: async () => {
      const pool = (app as any).pool;
      if (!pool) throw new Error("base introuvable");
      const b = await passageDatesAnimes({ pool, log: app.log, rafraichir: clearFeedCache });
      const log = { module: "dates-animes", lus: b.lus, changees: b.changees, aAnnoncer: b.aAnnoncer, sansDate: b.sansDate, annoncees: b.annoncees, annules: b.annules, erreur: b.erreur };
      if (b.erreur || b.echecs) app.log.warn(log, b.erreur ? "dates des animés : passage interrompu" : "dates des animés : écritures refusées par la base");
      else app.log.info(log, "dates des animés : passage terminé");
      if (b.changees + b.aAnnoncer + b.annules + b.relances > 0 || b.erreur || b.echecs) {
        pushActivity({
          type: "dates-animes",
          message: `Dates des animés : ${b.changees} date(s) changée(s), ${b.aAnnoncer} « Date à annoncer », ${b.annules} annulé(s)`,
          detail: `${b.lus} animés relus` + (b.annoncees ? `, ${b.annoncees} date(s) annoncée(s) (${b.prevenus} abonné(s) prévenu(s))` : "") + (b.erreur ? ` · ${b.erreur}` : ""),
          level: b.erreur || b.echecs ? "warn" : "info",
        });
      }
      return { bilan: { ...b } };
    },
  });
}
