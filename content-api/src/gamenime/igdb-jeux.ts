/**
 * igdb-jeux.ts — Les jeux avec IGDB seul : RAWG retiré (13 octobre 2026).
 *
 * Décisions de Rey (13 octobre, d'après le relevé releve-igdb.sh) :
 *  - popularité des jeux = les listes IGDB : « je veux y jouer » (2), « j'y joue » (3) et « j'y ai
 *    joué » (4). C'est l'équivalent des membres AniList pour les animes, avant comme après la sortie.
 *    Une seule échelle : les envois n8n ne l'écrivent plus (index.ts, /games/bulk).
 *  - note = total_rating d'IGDB, à partir de 5 votes ; une note déjà en base est gardée quand IGDB
 *    n'en a pas (même règle que les animes avec AniList).
 *  - covers RAWG (media.rawg.io) remplacées par la jaquette IGDB : RAWG ne les entretient plus pour nous.
 *  - découverte : chaque jour, les jeux de la fenêtre du site (année courante et suivante) que les
 *    listes IGDB placeraient parmi les 150 premiers, sortis ou à venir, et qui manquent, sont ajoutés
 *    par /games/bulk (mêmes contrôles que les envois n8n).
 *
 * Échelle : PopScore d'IGDB donne des parts (la part du jeu dans toutes les listes IGDB). Popularité =
 * part × 1 000 000 : les millionièmes, du même ordre que les anciens « hypes ». Les seuils du site
 * (badges) et les planchers de franchise (franchise_floors) gardent ainsi leur sens.
 *
 * Un passage (20 min après le démarrage, puis toutes les 3 h) :
 *  1. rattache à IGDB les jeux qui n'y sont pas (titre : chiffres romains, sous-titres, « (AAAA) »,
 *     accès anticipé) ; un identifiant IGDB déjà porté par un autre jeu : la copie est fusionnée dans
 *     cette fiche (14 octobre, voir plus bas) ;
 *  2. lit chez IGDB les listes et les notes de tous les jeux rattachés ;
 *  3. écrit popularity_source (valeur IGDB, 0 sans identifiant IGDB) et popularity (avec les planchers
 *     de franchise, comme le cycle quotidien de refetch-cron), la note et la jaquette, sans toucher
 *     updated_at (date des sitemaps). Un jeu dont IGDB ne rend plus la fiche (identifiant fusionné ou
 *     supprimé) garde ses valeurs et est signalé.
 * IGDB en panne ou réponse incomplète (un lot vide, ou des listes pour moitié moins de jeux qu'au passage
 * précédent) : rien n'est écrit, nouvel essai 1 h plus tard.
 *
 * Découverte : la date d'un jeu est sa première sortie, dans la fenêtre. Un jeu sorti avant la fenêtre
 * (portage, réédition) est écarté, sauf si toutes ses dates d'avant sont des accès anticipés : sa date est
 * alors la première sortie hors accès anticipé de la fenêtre (la 1.0). Un jeu qui porte le titre d'une
 * fiche de la base (règles de /games/bulk), ou qui ressemble à un jeu pas encore rattaché, n'est jamais
 * ajouté : il est signalé (homonyme ou doublon à vérifier).
 *
 * Un verrou de la base (GET_LOCK) garantit un seul passage à la fois, y compris celui de l'installateur.
 * Interrupteur : IGDB_JEUX_ENABLED « 0 » (les envois n8n écrivent alors de nouveau popularité et note).
 *
 * 14 octobre 2026 (relevé releve-jeux.sh, décisions de Rey) :
 *  - « Pas de doublon, surtout pas sur le site » : un jeu sans IGDB que le rattachement reconnaît comme une
 *    fiche déjà présente (même identifiant IGDB) y est fusionné, comme la fusion du tableau de bord (favoris,
 *    votes, notifications, alertes et rappels déplacés ; titre et cover de la copie dans merge_blocklist,
 *    renvoyés vers la fiche gardée ; la copie supprimée). Garde-fou : les deux fiches se ressemblent elles-mêmes
 *    (titre et date). Deux fiches qui portent le même identifiant IGDB sont fusionnées de même.
 *  - rattachement : la date IGDB compte avec sa propre précision (« 2027 » couvre l'année) ; accès anticipé en
 *    cours (notre date entre l'accès anticipé et la sortie complète) ; plusieurs candidats départagés par le
 *    studio ou l'année entre parenthèses, ou par la seule fiche datée ; sous-titre inséré (« The Witcher 3:
 *    Wild Hunt - Songs of the Past ») ; extensions et DLC si aucun jeu ne porte ce titre ; titre anglais.
 *  - rattachement douteux (titre différent, date à plus de 3 ans) : remplacé par la seule autre fiche au
 *    titre exact et à la bonne date (Ecstatica, le remaster de 2026).
 *  - popularité d'un jeu à venir : « je veux y jouer » seul (GTA VI devant Path of Exile 2, gonflé par son
 *    accès anticipé) ; un jeu sorti garde les trois listes.
 *  - dates (jusqu'ici jamais remises à jour pour les jeux) : à chaque passage, la date IGDB (première sortie
 *    dans la fenêtre, règle de la découverte), puis celle de Steam (steam-jeux.ts) qui la précise ou
 *    l'avance, jamais plus tard (dateFinale). updated_at n'est pas touché. Un 31/12 ou un 1/1 « au jour »
 *    encore à venir est l'année (faux jour), chez nous comme chez IGDB.
 *
 * 14 octobre 2026, après le relevé releve-dates.sh (décisions de Rey) :
 *  - « Advanced Access » d'IGDB (accès anticipé payant de quelques jours : Forza Horizon 6 le 15 mai pour le
 *    19, Fable, Call of Duty) n'est pas la sortie, comme l'accès anticipé : la date retenue est la sortie
 *    complète. Une date de simple mise à jour (« Next-Gen Optimization Patch Release ») ne compte jamais.
 *  - Steam recule une date floue (mois ou année) quand sa date tombe après toute cette période et que le jeu
 *    reste à venir : un report qu'IGDB n'a pas encore noté (« 2026 » chez IGDB, « 2027 » ou « Q1 2027 » sur
 *    Steam). Une date au jour n'est jamais reculée (un jeu sort parfois d'abord sur console), ni la date d'un
 *    jeu rattaché par un titre seulement proche (le gel des avances d'IGDB reste juste).
 */
import { clearTimeout, setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { igdbFetch } from "./twitch.js";
// steam-jeux se sert aussi de ce module (import circulaire sans effet : rien n'est appelé au chargement)
import { startSteamJeuxCron } from "./steam-jeux.js";
import { interrupteur, planifier, type RetourPassage } from "./pilotage.js";
import { isMissing, matchWindowDays, mergePlatforms, normalizeTitle, normalizeTitleStrict } from "./core.js";
import type { Journal, SqlPool } from "./presse.js";

const PREMIER_PASSAGE_MS = 20 * 60 * 1000;
const PASSAGE_MS = 3 * 60 * 60 * 1000;
const PREMIERE_DECOUVERTE_MS = 50 * 60 * 1000;
const DECOUVERTE_MS = 24 * 60 * 60 * 1000;
const APRES_ECHEC_MS = 60 * 60 * 1000;
const APRES_OCCUPE_MS = 10 * 60 * 1000;
const VERROU = "gamenime_igdb_jeux";
const TYPES_LISTES = [2, 3, 4]; // je veux y jouer, j'y joue, j'y ai joué
const TYPES_JEU = "(0,8,9)"; // jeu principal, remake, remaster
const THEME_EROTIQUE = 42;
const URL_IGDB = "https://api.igdb.com/v4/";
/** Un lot d'au moins cette taille qui revient vide est une réponse incomplète d'IGDB, pas une absence de données. */
const LOT_VIDE_SUSPECT = 20;

interface Connexion {
  query: (sql: string, params?: unknown[]) => Promise<any>;
  release: () => unknown;
  destroy?: () => unknown;
}

export interface IgdbJeuxDeps {
  /** Le pool mariadb de l'API ; getConnection sert au verrou (sans elle, pas de verrou). */
  pool: SqlPool & { getConnection?: () => Promise<Connexion> };
  log: Journal;
  /** Vide le cache des flux de l'API après écriture. */
  rafraichir?: () => void;
  /** Une requête IGDB (point, corps apicalypse) ; par défaut igdbFetch (jeton Twitch partagé). */
  igdb?: (point: string, corps: string) => Promise<Response>;
  /** Ajout de jeux par /games/bulk ; rend le nombre de jeux traités. */
  ajouter?: (items: ItemDecouvert[]) => Promise<{ ok: boolean; total?: number; erreur?: string }>;
}

export interface IgdbJeuxConfig {
  /** Popularité = part IGDB × echelle. */
  echelle: number;
  /** Pause entre deux requêtes IGDB (4 par seconde au plus, partagées avec la Phase B). */
  pauseMs: number;
  /** Attente après un 429 avant le nouvel essai. */
  attenteMs: number;
  /** Jeux sans IGDB cherchés par passage. */
  maxLiens: number;
  /** Votes IGDB minimum pour prendre la note. */
  votesMin: number;
  /** Rang dont la popularité fixe le seuil de la découverte (sortis et à venir). */
  rang: number;
  /** Popularité minimale d'un jeu découvert. */
  seuilMin: number;
  /** Jeux ajoutés au plus par découverte. */
  maxAjouts: number;
  /** Pages de 500 valeurs lues au plus, par mesure, pour la découverte. */
  pagesMax: number;
}

export function configIgdbJeux(_env: Record<string, string | undefined> = process.env): IgdbJeuxConfig {
  return { echelle: 1_000_000, pauseMs: 500, attenteMs: 1500, maxLiens: 100, votesMin: 5, rang: 150, seuilMin: 20, maxAjouts: 25, pagesMax: 20 };
}

/** Jeux IGDB allumé ? L'interrupteur du Pilotage d'abord (pilotage.ts) ; IGDB_JEUX_ENABLED à la première mise en route. */
export function igdbJeuxActif(env: Record<string, string | undefined> = process.env): boolean {
  const p = env === process.env ? interrupteur("igdb-jeux") : null;
  return p === null ? env["IGDB_JEUX_ENABLED"] !== "0" : p;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => String((e as any)?.cause?.code || (e as Error)?.message || e).slice(0, 200);

// ── Requêtes IGDB : une à la fois, espacées ; un 429 attend puis réessaie (3 fois)

let derniere = 0;
async function requete(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, point: string, corps: string): Promise<any[]> {
  const appel =
    deps.igdb ??
    ((p: string, c: string) => igdbFetch(URL_IGDB + p, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: c }));
  for (let essai = 0; ; essai++) {
    const attente = derniere + cfg.pauseMs - Date.now();
    if (attente > 0) await dormir(attente);
    derniere = Date.now();
    let r: Response;
    try {
      r = await appel(point, corps);
    } catch (e) {
      if (essai < 2) {
        await dormir(cfg.attenteMs);
        continue;
      }
      throw new Error(`IGDB ${point} injoignable (${message(e)})`);
    }
    if (r.status === 429 && essai < 3) {
      await r.body?.cancel().catch(() => {});
      await dormir(cfg.attenteMs * (essai + 1));
      continue;
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d)) {
      const cause = Array.isArray(d) ? d.map((x: any) => x?.cause || x?.title).filter(Boolean).join(" ; ") : d?.message || "";
      throw new Error(`IGDB ${point} : HTTP ${r.status}${cause ? " (" + String(cause).slice(0, 120) + ")" : ""}`);
    }
    return d;
  }
}

// ── Dates, jaquette, bande-annonce (partagés avec la Phase B, refetch-games-cron)

export type Precision = "day" | "month" | "year";

/**
 * Le champ « human » d'IGDB donne la vraie précision : "2027" ou "Q1 2027" = année, "Feb 2027" = mois,
 * "Feb 18, 2027" = jour. IGDB stocke un 31/12 quand il ne connaît que l'année.
 */
export function parseDateIgdb(human: string, ts: number | null): { date: string | null; precision: Precision | null } {
  if (!ts) return { date: null, precision: null };
  const d = new Date(ts * 1000);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const h = String(human || "").trim();
  if (/^[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/.test(h)) return { date: y + "-" + pad2(m) + "-" + pad2(day), precision: "day" };
  if (/^[A-Za-z]{3,}\s+\d{4}/.test(h)) return { date: y + "-" + pad2(m) + "-01", precision: "month" };
  return { date: y + "-01-01", precision: "year" };
}

/** La meilleure date parmi les release_dates : la plus proche encore à venir, sinon la plus récente (cas Aion 2). */
export function choisirDateIgdb(rds: any[], maintenant: number = Date.now()): { date: string | null; precision: Precision | null } {
  if (!Array.isArray(rds) || rds.length === 0) return { date: null, precision: null };
  const now = Math.floor(maintenant / 1000);
  const valides = rds.filter((r) => r?.date);
  if (valides.length === 0) return { date: null, precision: null };
  const futures = valides.filter((r) => r.date > now).sort((a, b) => a.date - b.date);
  const choix = futures[0] || [...valides].sort((a, b) => b.date - a.date)[0];
  return parseDateIgdb(choix.human, choix.date);
}

/** Date d'IGDB marquée accès anticipé, alpha ou bêta (statut de la date, quand IGDB le donne) : des mois ou des années. */
const accesLong = (r: any) => /early access|alpha|beta/i.test(String(r?.status?.name ?? ""));
/**
 * Pas la sortie : accès anticipé, alpha, bêta, ou « Advanced Access » (quelques jours d'avance pour une édition
 * payante). Le rattachement ne compte que l'accès anticipé long (accesLong) : quelques jours n'élargissent pas sa fenêtre.
 */
const anticipee = (r: any) => accesLong(r) || /advanced access/i.test(String(r?.status?.name ?? ""));

/** Date d'IGDB pour l'Europe ou le monde entier (région de la date, quand IGDB la donne). */
const europeenne = (r: any) => /europe|worldwide/i.test(String(r?.release_region?.region ?? ""));

/**
 * Date d'IGDB annulée ou retirée (statut « Cancelled », « Offline »), ou d'une simple mise à jour (« Next-Gen
 * Optimization Patch Release ») : elle ne compte jamais.
 */
const annulee = (r: any) => /cancel|offline|patch/i.test(String(r?.status?.name ?? ""));

/** Les dates utiles d'une fiche, triées : sans les dates annulées ; Europe et monde entier seules quand IGDB en donne. */
function datesUtiles(rds: any[], champsDates: boolean): any[] {
  const toutes = (Array.isArray(rds) ? rds : [])
    .filter((r) => Number(r?.date) > 0 && !(champsDates && annulee(r)))
    .sort((a, b) => Number(a.date) - Number(b.date));
  return champsDates && toutes.some(europeenne) ? toutes.filter(europeenne) : toutes;
}
const dateDe = (r: any): { date: string; precision: Precision } | null => {
  if (!r) return null;
  const d = parseDateIgdb(r.human, Number(r.date));
  return d.date && d.precision ? { date: d.date, precision: d.precision } : null;
};

/**
 * Date d'un jeu (découverte et passage) : sa première sortie, si elle tombe dans la fenêtre du site. Les dates
 * d'Europe et du monde entier passent seules quand IGDB en donne (une sortie japonaise ou coréenne plus tôt ne
 * compte pas) ; une date annulée ne compte jamais. Accès anticipé, alpha et bêta ne sont pas la sortie : la
 * première date de la fenêtre qui n'en est pas une (la 1.0) passe avant ; s'il n'y en a pas, la première date
 * de la fenêtre (le jeu n'est jouable qu'en accès anticipé). Un jeu sorti avant la fenêtre n'est retenu que si
 * TOUTES ses dates d'avant sont des accès anticipés : sa date est alors la 1.0 de la fenêtre. Sinon (portage,
 * réédition d'un jeu plus ancien) : null. champsDates à false (statut et région refusés par IGDB) : toutes les
 * régions, aucune exception d'accès anticipé.
 */
export function dateDecouverte(rds: any[], f: { debutTs: number; finTs: number }, champsDates = true): { date: string; precision: Precision } | null {
  const datees = datesUtiles(rds, champsDates);
  const accesAnticipe = champsDates;
  const avant = datees.filter((r) => Number(r.date) < f.debutTs);
  const dedans = datees.filter((r) => Number(r.date) >= f.debutTs && Number(r.date) <= f.finTs);
  const sortie = accesAnticipe ? dedans.find((r) => !anticipee(r)) : undefined;
  const choix = avant.length === 0 ? (sortie ?? dedans[0]) : accesAnticipe && avant.every(anticipee) ? sortie : undefined;
  return dateDe(choix);
}

/**
 * Jeu reporté au-delà de la fenêtre : aucune date utile avant ni dans la fenêtre, une après. La première (le jeu
 * quitte alors le site jusqu'à ce que la fenêtre l'atteigne). null sinon.
 */
export function dateApresFenetre(rds: any[], f: { debutTs: number; finTs: number }, champsDates = true): { date: string; precision: Precision } | null {
  const datees = datesUtiles(rds, champsDates);
  if (!datees.length || datees.some((r) => Number(r.date) <= f.finTs)) return null;
  return dateDe(datees.find((r) => !(champsDates && anticipee(r))) ?? datees[0]);
}

export const urlJaquetteIgdb = (imageId: string) => `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${imageId}.jpg`;

/** Bande-annonce : « Launch » d'abord, puis la dernière « Trailer », sinon la dernière vidéo. */
export function choisirBandeAnnonce(videos: any[]): string | null {
  if (!Array.isArray(videos) || videos.length === 0) return null;
  const par = (re: RegExp) => videos.filter((v: any) => re.test(String(v?.name || "")));
  const choix = par(/launch/i)[0] || par(/trailer/i).slice(-1)[0] || videos[videos.length - 1];
  return choix?.video_id && /^[A-Za-z0-9_-]{11}$/.test(choix.video_id) ? "https://www.youtube.com/watch?v=" + choix.video_id : null;
}

// ── Titres : rapprochement souple et sûr

const ACCENTS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
const ROMAINS: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20",
};

/** Mots d'un titre : sans accents ni ponctuation, « (2026) » et parenthèse finale retirés, chiffres romains en chiffres, sans « the » initial. */
export function motsTitre(titre: string | null | undefined): string[] {
  let s = String(titre || "").normalize("NFD").replace(ACCENTS, "").toLowerCase();
  s = s.replace(/[™®©]/g, "").replace(/&/g, " and ").replace(/['’`]/g, "");
  s = s.replace(/\s*\([^()]*\)\s*$/, "");
  const mots = s.split(/[^a-z0-9]+/).filter(Boolean).map((m) => ROMAINS[m] ?? m);
  if (mots.length > 1 && mots[0] === "the") mots.shift();
  return mots;
}

/**
 * Degré de correspondance de deux titres : 1 identiques ; 2 un numéro en plus d'un côté
 * (« Resident Evil 9: Requiem » / « Resident Evil Requiem ») ; 3 l'un prolonge l'autre
 * (sous-titre : « Inkonbini » / « Inkonbini: One Store… », ou préfixe : « Toxic Commando » /
 * « John Carpenter's Toxic Commando ») ; 0 sinon.
 */
export function degreTitres(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const ja = a.join(" ");
  const jb = b.join(" ");
  if (ja === jb || a.join("") === b.join("")) return 1;
  const sansUnNombre = (x: string[], y: string[]) =>
    x.length === y.length + 1 && x.some((m, i) => /^\d+$/.test(m) && [...x.slice(0, i), ...x.slice(i + 1)].join(" ") === y.join(" "));
  if (sansUnNombre(a, b) || sansUnNombre(b, a)) return 2;
  const prolonge = (court: string[], long: string[]) =>
    long.length > court.length &&
    ((court.join("").length >= 5 && long.slice(0, court.length).join(" ") === court.join(" ")) ||
      (court.length >= 2 && long.slice(long.length - court.length).join(" ") === court.join(" ")));
  if (prolonge(a, b) || prolonge(b, a)) return 3;
  return 0;
}

/**
 * 4 : un sous-titre inséré au milieu, d'un côté ou de l'autre (« The Witcher 3: Songs of the Past » /
 * « The Witcher 3: Wild Hunt - Songs of the Past ») ; 3 mots au moins du côté court, 1 à 3 mots insérés.
 */
export function degreInsere(a: string[], b: string[]): boolean {
  const [court, long] = a.length < b.length ? [a, b] : [b, a];
  const k = long.length - court.length;
  if (court.length < 3 || k < 1 || k > 3) return false;
  for (let i = 1; i < court.length; i++) {
    if (long.slice(0, i).join(" ") === court.slice(0, i).join(" ") && long.slice(i + k).join(" ") === court.slice(i).join(" ")) return true;
  }
  return false;
}

/** Degré de deux titres, sous-titre inséré compris : 1 à 3 (degreTitres), 4 (degreInsere), 0 sinon. */
export function titresProches(a: string[], b: string[]): number {
  return degreTitres(a, b) || (degreInsere(a, b) ? 4 : 0);
}

const nomsIgdb = (g: any): string[] => [g?.name, ...(Array.isArray(g?.alternative_names) ? g.alternative_names.map((x: any) => x?.name) : [])].filter((x) => typeof x === "string" && x);
const jourIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Les dates d'une fiche IGDB : instant, précision (champ « human »), accès anticipé (statut, quand IGDB le donne). */
interface DateFiche {
  ms: number;
  prec: Precision;
  ea: boolean;
}
function datesFiche(g: any): DateFiche[] {
  const res: DateFiche[] = [];
  for (const r of Array.isArray(g?.release_dates) ? g.release_dates : []) {
    if (Number(r?.date) > 0) res.push({ ms: Number(r.date) * 1000, prec: parseDateIgdb(r.human, Number(r.date)).precision || "day", ea: accesLong(r) });
  }
  const premiere = Number(g?.first_release_date);
  if (premiere > 0 && !res.some((x) => x.ms === premiere * 1000)) res.push({ ms: premiere * 1000, prec: "day", ea: false });
  return res.sort((x, y) => x.ms - y.ms);
}

/**
 * Une date d'IGDB dans la fenêtre de la nôtre ; la largeur tient compte des deux précisions (une date IGDB
 * « 2027 » couvre l'année). Accès anticipé en cours : notre date entre une date d'accès anticipé et la
 * sortie complète (au plus 3 ans après). Vrai sans date d'un côté.
 */
function dateCompatible(g: any, date: string | null, precision: string | null): boolean {
  if (!date) return true;
  const ds = datesFiche(g);
  if (!ds.length) return true;
  const ref = Date.parse(date + "T00:00:00Z");
  const notre = matchWindowDays(date, precision as any);
  if (ds.some((d) => Math.abs(d.ms - ref) <= Math.max(notre, matchWindowDays(jourIso(d.ms), d.prec)) * 86400000)) return true;
  return ds.some((a) => a.ea && a.ms <= ref) && ds.some((s) => !s.ea && s.ms >= ref && s.ms - ref <= 3 * 366 * 86400000);
}
/** Accès anticipé : toutes les dates d'IGDB avant la nôtre, la dernière à moins de 3 ans (version 1.0 plus tard). */
function accesAnticipe(g: any, date: string | null): boolean {
  if (!date) return false;
  const ds = datesFiche(g);
  if (!ds.length) return false;
  const ref = Date.parse(date + "T00:00:00Z");
  const max = Math.max(...ds.map((d) => d.ms));
  return max < ref && ref - max <= 3 * 366 * 86400000;
}

export interface Rattachement {
  etat: "un" | "ambigu" | "aucun";
  igdb?: number;
  nom?: string;
  /** Par où le rattachement passe : le titre (jeu principal), une extension ou un DLC, le titre anglais. */
  voie?: "jeu" | "extension" | "anglais";
  /** Degré du titre retenu : 1 titre identique (ou nom alternatif d'IGDB), 2 à un numéro près, 3 prolongé, 4 sous-titre inséré. */
  degre?: number;
  /** Les noms de la fiche IGDB retenue (nom et noms alternatifs) : le garde-fou des fusions s'en sert. */
  noms?: string[];
}

export interface OptionsRattachement {
  /** Fiches IGDB écartées (rattachement douteux, identifiant perdu par un transfert : on en cherche une autre). */
  exclure?: number | number[];
  /** Titre anglais : dernier essai quand le titre ne donne rien. */
  titreAnglais?: string | null;
  /** Titre exact seulement (degré 1), jeux principaux : pour remplacer une fiche déjà posée. */
  exact?: boolean;
}

const TYPES_EXTENSION = "(1,2,4)"; // DLC, extension, extension autonome
const CHAMPS_RECHERCHE = "id, name, alternative_names.name, game_type, first_release_date, release_dates.date, release_dates.human";
/** Statut des dates (accès anticipé) dans les recherches ; refusé par IGDB (HTTP 400) : on s'en passe. */
let statutRecherche = true;
async function rechercheIgdb(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, q: string, types: string): Promise<any[]> {
  const corps = (champs: string) => `search "${q}"; fields ${champs}; where game_type = ${types}; limit 20;`;
  if (statutRecherche) {
    try {
      return await requete(deps, cfg, "games", corps(CHAMPS_RECHERCHE + ", release_dates.status.name"));
    } catch (e) {
      if (!/HTTP 400/.test(message(e))) throw e;
      // refusée aussi sans le statut : le statut n'y est pour rien, on le garde
      const res = await requete(deps, cfg, "games", corps(CHAMPS_RECHERCHE));
      statutRecherche = false;
      return res;
    }
  }
  return requete(deps, cfg, "games", corps(CHAMPS_RECHERCHE));
}

/**
 * Plusieurs candidats dans la fenêtre : le studio ou l'année entre parenthèses à la fin de notre titre
 * (« Exodus (Archetype Entertainment) », « Doom (2016) ») les départage ; sinon un seul candidat vraiment
 * daté (les autres n'ont aucune date). null : toujours ambigu.
 */
async function departager(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, titre: string, candidats: any[]): Promise<any | null> {
  const parenthese = String(titre).match(/\(([^()]+)\)\s*$/)?.[1]?.trim() ?? "";
  if (/^\d{4}$/.test(parenthese)) {
    const r = candidats.filter((g) => datesFiche(g).some((d) => new Date(d.ms).getUTCFullYear() === Number(parenthese)));
    if (r.length === 1) return r[0];
  } else if (parenthese) {
    const mots = motsTitre(parenthese).filter((m) => m.length >= 3);
    if (mots.length) {
      const ids = candidats.map((g) => Number(g.id)).filter((x) => x > 0);
      const d = await requete(deps, cfg, "games", `fields id, involved_companies.company.name; where id = (${ids.join(",")}); limit 50;`);
      const studio = d.filter((g: any) =>
        (Array.isArray(g?.involved_companies) ? g.involved_companies : []).some((ic: any) => {
          const c = motsTitre(ic?.company?.name);
          return mots.every((m) => c.includes(m));
        })
      );
      if (studio.length === 1) return candidats.find((g) => Number(g.id) === Number(studio[0].id)) ?? null;
    }
  }
  const datees = candidats.filter((g) => datesFiche(g).length > 0);
  return datees.length === 1 ? datees[0] : null;
}

/**
 * Le titre chez IGDB, pour un type de fiches : recherche du titre, puis sans les numéros si la première ne
 * donne aucun titre proche ; par degré (dans l'ordre donné), les candidats dans la fenêtre de date ; un seul =
 * rattaché, plusieurs = départagés ou ambigus ; au degré 1, un candidat unique en accès anticipé.
 * titres : un titre proche a été vu (même à une autre date).
 */
async function chercherPar(
  deps: IgdbJeuxDeps,
  cfg: IgdbJeuxConfig,
  titre: string,
  date: string | null,
  precision: string | null,
  types: string,
  degres: number[],
  exclure: Set<number>
): Promise<Rattachement & { titres: boolean }> {
  const nous = motsTitre(titre);
  if (!nous.length) return { etat: "aucun", titres: false };
  const nettoye = String(titre).replace(/\s*\([^()]*\)\s*$/, "").replace(/["\\]/g, "").trim();
  const recherches = [nettoye];
  const sansNumeros = nettoye.replace(/\b(\d+|ii|iii|iv|vi|vii|viii|ix)\b/gi, " ").replace(/\s*:\s*/g, " ").replace(/\s+/g, " ").trim();
  if (sansNumeros && sansNumeros.toLowerCase() !== nettoye.toLowerCase()) recherches.push(sansNumeros);
  for (const q of recherches) {
    const res = (await rechercheIgdb(deps, cfg, q, types)).filter((g) => Number(g?.id) > 0 && !exclure.has(Number(g.id)));
    const parDegre: Array<any[]> = [[], [], [], [], []];
    for (const g of res) {
      const d = Math.min(...nomsIgdb(g).map((n) => titresProches(nous, motsTitre(n)) || 9));
      if (degres.includes(d)) parDegre[d].push(g);
    }
    for (const d of degres) {
      if (!parDegre[d].length) continue;
      const dedans = parDegre[d].filter((g) => dateCompatible(g, date, precision));
      const un = (g: any): Rattachement & { titres: boolean } => ({ etat: "un", igdb: Number(g.id), nom: String(g.name || ""), degre: d, noms: nomsIgdb(g), titres: true });
      if (dedans.length === 1) return un(dedans[0]);
      if (dedans.length > 1) {
        const choix = await departager(deps, cfg, titre, dedans);
        return choix ? un(choix) : { etat: "ambigu", titres: true };
      }
      if (d === 1 && parDegre[1].length === 1 && accesAnticipe(parDegre[1][0], date)) return un(parDegre[1][0]);
    }
    if (parDegre.some((x) => x.length)) return { etat: "aucun", titres: true };
  }
  return { etat: "aucun", titres: false };
}

/**
 * Cherche la fiche IGDB d'un jeu par son titre (jeux principaux, remakes, remasters) :
 *  1. degrés 1 à 3 puis sous-titre inséré (4), date compatible (précision des deux côtés, accès anticipé en
 *     cours compris) ; plusieurs candidats : départagés par le studio ou l'année entre parenthèses, ou par la
 *     seule fiche datée ;
 *  2. aucun titre proche parmi les jeux : les extensions et DLC, titre exact, à un numéro près ou avec un
 *     sous-titre inséré (jamais un simple début de titre : « Warlock » n'est pas « The Warlock of Firetop… ») ;
 *  3. le titre anglais, s'il diffère.
 */
export async function trouverIgdb(
  deps: IgdbJeuxDeps,
  cfg: IgdbJeuxConfig,
  titre: string,
  date: string | null,
  precision: string | null,
  opts: OptionsRattachement = {}
): Promise<Rattachement> {
  const exclure = new Set((Array.isArray(opts.exclure) ? opts.exclure : [opts.exclure]).map(Number).filter((x) => x > 0));
  const degres = opts.exact ? [1] : [1, 2, 3, 4];
  const jeu = await chercherPar(deps, cfg, titre, date, precision, TYPES_JEU, degres, exclure);
  if (jeu.etat !== "aucun") return { etat: jeu.etat, igdb: jeu.igdb, nom: jeu.nom, degre: jeu.degre, noms: jeu.noms, voie: "jeu" };
  if (!jeu.titres && !opts.exact) {
    const ext = await chercherPar(deps, cfg, titre, date, precision, TYPES_EXTENSION, [1, 2, 4], exclure);
    if (ext.etat !== "aucun") return { etat: ext.etat, igdb: ext.igdb, nom: ext.nom, degre: ext.degre, noms: ext.noms, voie: "extension" };
  }
  const anglais = String(opts.titreAnglais || "").trim();
  if (anglais && motsTitre(anglais).join(" ") !== motsTitre(titre).join(" ")) {
    const en = await chercherPar(deps, cfg, anglais, date, precision, TYPES_JEU, degres, exclure);
    if (en.etat !== "aucun") return { etat: en.etat, igdb: en.igdb, nom: en.nom, degre: en.degre, noms: en.noms, voie: "anglais" };
  }
  return { etat: "aucun" };
}

// ── Verrou de la base (un passage à la fois, API ou installateur)

/** Un verrou nommé de la base (GET_LOCK, propre à la base) : null s'il est déjà pris ; sinon la fonction qui le rend. */
export async function prendreVerrou(pool: IgdbJeuxDeps["pool"], nom: string = VERROU): Promise<(() => Promise<void>) | null> {
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

// ── Lecture des listes et des fiches

/**
 * Parts IGDB (types 2, 3, 4) de ces jeux : igdb -> somme des parts. Paquets réduits si une réponse est pleine.
 * lots (facultatif) reçoit les identifiants de chaque paquet lu, pour le contrôle des réponses partielles.
 */
/** Les trois listes IGDB d'un jeu (parts) : « je veux y jouer », « j'y joue », « j'y ai joué ». */
export interface ListesJeu {
  veut: number;
  joue: number;
  fini: number;
}
/** Part retenue (décision de Rey, 14 octobre) : un jeu à venir, « je veux y jouer » seul ; un jeu sorti, les trois listes. */
export const partListes = (l: ListesJeu | undefined, statut: "sorti" | "a venir"): number => (!l ? 0 : statut === "a venir" ? l.veut : l.veut + l.joue + l.fini);

/**
 * Les trois listes IGDB (types 2, 3, 4) de ces jeux. Paquets réduits si une réponse est pleine.
 * lots (facultatif) reçoit les identifiants de chaque paquet lu, pour le contrôle des réponses partielles.
 */
async function lireListes(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, ids: number[], lots?: number[][]): Promise<Map<number, ListesJeu>> {
  const res = new Map<number, ListesJeu>();
  let taille = 150;
  for (let i = 0; i < ids.length; ) {
    const paquet = ids.slice(i, i + taille);
    const d = await requete(deps, cfg, "popularity_primitives", `fields game_id, popularity_type, value; where game_id = (${paquet.join(",")}) & popularity_type = (${TYPES_LISTES.join(",")}); limit 500;`);
    if (d.length >= 500 && taille > 10) {
      taille = Math.ceil(taille / 2);
      continue;
    }
    if (d.length === 0 && paquet.length >= LOT_VIDE_SUSPECT) throw new Error(`IGDB popularity_primitives : réponse vide pour ${paquet.length} jeux`);
    for (const p of d) {
      const g = Number(p?.game_id);
      const v = Number(p?.value);
      const t = Number(p?.popularity_type);
      if (!(g > 0 && Number.isFinite(v) && v > 0 && TYPES_LISTES.includes(t))) continue;
      const l = res.get(g) ?? { veut: 0, joue: 0, fini: 0 };
      if (t === 2) l.veut += v;
      else if (t === 3) l.joue += v;
      else l.fini += v;
      res.set(g, l);
    }
    lots?.push(paquet);
    i += paquet.length;
  }
  return res;
}
async function lireFiches(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, ids: number[], champs: string, filtre = ""): Promise<Map<number, any>> {
  const res = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 400) {
    const paquet = ids.slice(i, i + 400);
    const d = await requete(deps, cfg, "games", `fields ${champs}; where id = (${paquet.join(",")})${filtre}; limit 500;`);
    // sans filtre, un lot de nos jeux ne revient jamais vide : sinon IGDB a mal répondu
    if (!filtre && d.length === 0 && paquet.length >= LOT_VIDE_SUSPECT) throw new Error(`IGDB games : réponse vide pour ${paquet.length} jeux`);
    for (const g of d) {
      if (Number(g?.id) > 0) res.set(Number(g.id), g);
    }
  }
  return res;
}

/** Fiches et leurs dates (statut et région en plus ; refusés par IGDB, HTTP 400 : sans eux, complets à false). */
async function lireFichesDates(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, ids: number[], champs: string): Promise<{ fiches: Map<number, any>; complets: boolean }> {
  try {
    return { fiches: await lireFiches(deps, cfg, ids, champs + CHAMPS_DATES), complets: true };
  } catch (e) {
    if (!/HTTP 400/.test(message(e))) throw e;
    return { fiches: await lireFiches(deps, cfg, ids, champs), complets: false };
  }
}

/**
 * Les pages Steam de ces jeux chez IGDB (external_games, source 1 = Steam ; ancien champ « category » si
 * IGDB refuse le nouveau) : identifiant IGDB -> identifiants Steam (appid), dans l'ordre d'IGDB.
 */
let sourceExterne = "external_game_source";
export async function lireIdsSteam(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, ids: number[]): Promise<Map<number, number[]>> {
  const res = new Map<number, number[]>();
  const lire = async (lot: number[]) => {
    const corps = (c: string) => `fields game, uid, ${c}; where game = (${lot.join(",")}) & ${c} = 1; limit 500;`;
    if (sourceExterne === "external_game_source") {
      try {
        return await requete(deps, cfg, "external_games", corps("external_game_source"));
      } catch (e) {
        if (!/HTTP 400/.test(message(e))) throw e;
        const r = await requete(deps, cfg, "external_games", corps("category"));
        sourceExterne = "category";
        return r;
      }
    }
    return requete(deps, cfg, "external_games", corps("category"));
  };
  // 100 jeux par requête : un jeu peut avoir plusieurs pages Steam, et IGDB rend 500 lignes au plus
  for (let i = 0; i < ids.length; i += 100) {
    for (const e of await lire(ids.slice(i, i + 100))) {
      const uid = String(e?.uid ?? "");
      const g = Number(e?.game);
      if (!/^\d{1,10}$/.test(uid) || !(g > 0)) continue;
      const l = res.get(g) ?? [];
      if (!l.includes(Number(uid))) l.push(Number(uid));
      res.set(g, l);
    }
  }
  return res;
}

// ── Planchers de franchise (même règle que applyFranchiseFloorsCycle, refetch-cron.ts)

/** Les planchers actifs ; une table absente = aucun plancher ; toute autre erreur arrête le passage. */
async function lirePlanchers(pool: SqlPool): Promise<Array<{ motif: string; valeur: number }>> {
  let r: any[];
  try {
    r = await pool.query("SELECT pattern, floor_value FROM franchise_floors WHERE active = 1");
  } catch (e) {
    if (Number((e as any)?.errno) === 1146) return [];
    throw new Error("base : planchers de franchise illisibles (" + message(e) + ")");
  }
  return r.map((x) => ({ motif: String(x.pattern || ""), valeur: Number(x.floor_value) || 0 })).filter((x) => x.motif && x.valeur > 0);
}
function correspond(titre: string, motif: string): boolean {
  const norm = (v: string) => v.normalize("NFD").replace(ACCENTS, "").toLowerCase();
  const t = norm(titre);
  const m = norm(motif);
  if (m.startsWith("%") && m.endsWith("%")) return t.includes(m.slice(1, -1));
  if (m.endsWith("%")) return t.startsWith(m.slice(0, -1));
  if (m.startsWith("%")) return t.endsWith(m.slice(1));
  return t === m;
}
function plancher(titre: string, planchers: Array<{ motif: string; valeur: number }>): number {
  let p = 0;
  for (const f of planchers) if (f.valeur > p && correspond(titre, f.motif)) p = f.valeur;
  return p;
}

// ── Dates : IGDB, puis Steam (décisions de Rey, 13 et 14 octobre)

export interface DateJeu {
  date: string | null;
  precision: Precision | null;
}
const RANG_PRECISION: Record<string, number> = { day: 3, month: 2, year: 1 };
/** Un 31/12 ou un 1/1 marqué « jour » est une année déguisée (IGDB stocke un 31/12 quand il ne connaît que l'année). */
export const fauxJour = (d: DateJeu) => d.precision === "day" && /-(12-31|01-01)$/.test(String(d.date || ""));
const precisionReelle = (d: DateJeu): Precision => (fauxJour(d) ? "year" : (d.precision ?? "year"));
const finDuMois = (date: string) => {
  const [a, m] = date.split("-").map(Number);
  return `${date.slice(0, 7)}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
/**
 * Un faux jour d'IGDB encore à venir (« Dec 31, 2027 » marqué jour) est l'année : IGDB n'y donne pas un jour
 * sûr. Un faux jour passé reste tel quel (le jeu est sorti, au jour près ou presque).
 */
export function sansFauxJour(d: { date: string; precision: Precision } | null, aujourdhui: string): { date: string; precision: Precision } | null {
  if (!d || !fauxJour(d) || d.date <= aujourdhui) return d;
  return { date: `${d.date.slice(0, 4)}-01-01`, precision: "year" };
}
/** La période que couvre une date : le jour, le mois ou l'année. */
function periode(d: DateJeu): { debut: string; fin: string } {
  const date = String(d.date);
  const p = precisionReelle(d);
  if (p === "year") return { debut: `${date.slice(0, 4)}-01-01`, fin: `${date.slice(0, 4)}-12-31` };
  if (p === "month") return { debut: `${date.slice(0, 7)}-01`, fin: finDuMois(date) };
  return { debut: date, fin: date };
}
const moinsJours = (date: string, n: number) => new Date(Date.parse(date + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10);

/**
 * La date affichée d'un jeu.
 *  1. IGDB (première sortie de la fenêtre, dateDecouverte) fait autorité, sauf une date moins précise qui
 *     contient la nôtre (« 2026 » ne remplace pas le 19 novembre 2026) ; un faux jour (31/12, 1/1) est remplacé.
 *  2. Steam (date PC, hors accès anticipé, dans la fenêtre) « précise ou avance » : plus précise et pas plus
 *     tard que la période retenue, ou de même précision et au moins 2 jours plus tôt, ou l'année d'un faux
 *     jour. Une date au jour n'est jamais reculée (un jeu sort parfois d'abord sur console) ; à un jour près,
 *     la date européenne d'IGDB reste (heure de sortie). Une date floue (mois ou année) l'est quand Steam
 *     tombe après toute sa période et que le jeu reste à venir : un report qu'IGDB n'a pas encore noté (pas
 *     avec reculer à false, rattachement au titre seulement proche ; jamais un 1/1 ou un 31/12 d'IGDB déjà
 *     passé, une vraie sortie).
 *  prudent (page Steam retrouvée par le seul titre, catalogue) : Steam ne fait que préciser la période retenue,
 *  sans en sortir ni changer le statut (sorti / à venir) : un homonyme ne déplace jamais un jeu.
 */
export function dateFinale(
  nous: DateJeu,
  igdb: DateJeu | null,
  steam: DateJeu | null,
  f: { debut: string; fin: string },
  opts: { prudent?: boolean; aujourdhui?: string; reculer?: boolean } = {}
): DateJeu & { source: "base" | "igdb" | "steam" } {
  let base: DateJeu & { source: "base" | "igdb" | "steam" } = { date: nous.date, precision: nous.precision, source: "base" };
  if (igdb?.date && igdb.precision) {
    if (!nous.date || fauxJour(nous)) base = { ...igdb, source: "igdb" };
    else if (RANG_PRECISION[igdb.precision] >= RANG_PRECISION[precisionReelle(nous)]) base = { ...igdb, source: "igdb" };
    else {
      const p = periode(igdb);
      if (!(nous.date >= p.debut && nous.date <= p.fin)) base = { ...igdb, source: "igdb" };
    }
  }
  if (!steam?.date || !steam.precision || steam.date < f.debut || steam.date > f.fin) return base;
  if (!base.date) return opts.prudent ? base : { ...steam, source: "steam" };
  const ps = periode(steam);
  const pb = periode(base);
  const rs = RANG_PRECISION[steam.precision];
  const rb = RANG_PRECISION[precisionReelle(base)];
  if (opts.prudent) {
    const annee = fauxJour(base) && steam.precision === "year" && steam.date.slice(0, 4) === String(base.date).slice(0, 4);
    const dedans = annee || (rs > rb && ps.debut >= pb.debut && ps.fin <= pb.fin);
    const memeStatut = !opts.aujourdhui || statutSite(steam.date, steam.precision, opts.aujourdhui) === statutSite(String(base.date), base.precision ?? "year", opts.aujourdhui);
    return dedans && memeStatut ? { ...steam, source: "steam" } : base;
  }
  if (rs > rb && ps.debut <= pb.fin) return { ...steam, source: "steam" };
  if (rs === rb && ps.debut <= moinsJours(pb.debut, 2)) return { ...steam, source: "steam" };
  if (fauxJour(base) && steam.precision === "year" && steam.date.slice(0, 4) === String(base.date).slice(0, 4)) return { ...steam, source: "steam" };
  // date floue (mois ou année) et Steam après toute sa période, le jeu encore à venir : un report qu'IGDB n'a pas
  // encore noté. Un 1/1 ou un 31/12 d'IGDB déjà passé est une vraie sortie (sansFauxJour) : jamais reculé.
  const sortieIgdb = fauxJour(base) && base.source === "igdb" && !!opts.aujourdhui && String(base.date) <= opts.aujourdhui;
  const aVenir = !opts.aujourdhui || statutSite(steam.date, steam.precision, opts.aujourdhui) === "a venir";
  if (opts.reculer !== false && rb < RANG_PRECISION.day && !sortieIgdb && aVenir && ps.debut > pb.fin) return { ...steam, source: "steam" };
  return base;
}

/** La ligne Steam venue d'IGDB d'un jeu qui perd son identifiant IGDB (la table peut ne pas exister encore). */
async function supprimerSteamIgdb(pool: SqlPool | { query: (sql: string, params?: unknown[]) => Promise<any> }, id: number): Promise<void> {
  try {
    await pool.query("DELETE FROM jeux_steam WHERE game_id = ? AND origine = 'igdb'", [id]);
  } catch (e) {
    if (Number((e as any)?.errno) !== 1146) throw e;
  }
}

/** Ce que Steam dit des jeux (table jeux_steam, cycle steam-jeux) : page valide, hors accès anticipé, lue depuis moins de 7 jours. */
async function lireSteam(pool: SqlPool): Promise<Map<number, DateJeu & { origine: string }>> {
  const res = new Map<number, DateJeu & { origine: string }>();
  let r: any[];
  try {
    r = await pool.query(
      "SELECT game_id, origine, DATE_FORMAT(date_steam, '%Y-%m-%d') AS date, precision_steam AS prec FROM jeux_steam " +
        "WHERE statut = 'ok' AND acces_anticipe = 0 AND date_steam IS NOT NULL AND precision_steam IS NOT NULL AND lu_le >= NOW() - INTERVAL 7 DAY"
    );
  } catch (e) {
    if (Number((e as any)?.errno) === 1146) return res;
    throw new Error("base : dates Steam illisibles (" + message(e) + ")");
  }
  for (const x of r) if (Number(x.game_id) > 0 && x.date) res.set(Number(x.game_id), { date: String(x.date), precision: x.prec as Precision, origine: String(x.origine ?? "") });
  return res;
}

// ── Doublons : fusion (même règle que /admin/merge-duplicates, routes.ts)

/** Une fiche, telle qu'elle était avant la fusion (pour la montrer à côté de l'autre). */
export interface FicheFusion {
  id: number;
  titre: string;
  date: string | null;
  precision: string | null;
  plateformes: string | null;
  popularite: number;
}
export interface Fusion {
  gagnant: FicheFusion;
  perdant: FicheFusion;
  igdb: number;
  /** Favoris, votes, notifications, alertes et rappels passés sur la fiche gardée. */
  relations: number;
  motif: string;
}
/** Le meilleur degré entre les titres d'une fiche (titre, titre anglais) et des noms IGDB : 1 à 4, 0 aucun. */
export function degreFiche(x: any, noms: string[]): number {
  let meilleur = 0;
  for (const t of [motsTitre(x?.title), motsTitre(x?.title_english)].filter((m) => m.length)) {
    for (const n of noms) {
      const d = titresProches(t, motsTitre(n));
      if (d && (!meilleur || d < meilleur)) meilleur = d;
    }
  }
  return meilleur;
}

/**
 * Garde-fou avant de supprimer une fiche (copie) au profit d'une autre (gardée), pour la fiche IGDB de noms
 * « noms » (nom et noms alternatifs) :
 *  - les deux fiches portent un nom de la fiche IGDB (degrés 1 à 4), et la gardée au moins aussi bien que la
 *    copie : une fiche mal rattachée (« Lunar Outpost » sur la fiche « Moon Base Alpha ») n'absorbe jamais la
 *    bonne ; degreMax limite le degré de la copie (2 pour un identifiant qu'IGDB ne connaît plus) ;
 *  - les deux fiches se ressemblent par le titre, ou portent chacune exactement un nom de la fiche IGDB
 *    (« Kujaku », nom alternatif de « Peacock Tales ») ;
 *  - leurs dates sont compatibles (fenêtres des deux précisions).
 */
export function memeJeu(gardee: any, copie: any, noms: string[], degreMax = 4): boolean {
  const dG = degreFiche(gardee, noms);
  const dC = degreFiche(copie, noms);
  if (!dG || !dC || dG > dC || dC > degreMax) return false;
  const titres = (x: any) => [motsTitre(x?.title), motsTitre(x?.title_english)].filter((m) => m.length);
  const proches = titres(gardee).some((ta) => titres(copie).some((tb) => titresProches(ta, tb) > 0));
  if (!proches && !(dG === 1 && dC === 1)) return false;
  const jour = (x: any) => (x?.date_iso ? String(x.date_iso) : null);
  const da = jour(gardee);
  const db = jour(copie);
  if (!da || !db) return true;
  const ecart = Math.abs(Date.parse(da + "T00:00:00Z") - Date.parse(db + "T00:00:00Z")) / 86400000;
  return ecart <= Math.max(matchWindowDays(da, gardee.release_precision), matchWindowDays(db, copie.release_precision));
}

/** Tables qui désignent un jeu par (item_type, item_id), comme la fusion du tableau de bord. */
const TABLES_LIEES = ["favorites", "votes", "notification_events", "alert_log", "reminder_log"];
const vide = (v: unknown) => v == null || String(v).trim() === "";
/** Ce que la fiche gardée reprend de la copie quand elle ne l'a pas (comme la fusion du tableau de bord). */
const REPRIS = ["title_english", "cover", "genre", "description", "rating", "trailer_url", "screenshots"];

/**
 * Fusionne deux fiches du même jeu, en une transaction : la fiche gardée (celle qui porte l'identifiant IGDB)
 * reste ; ses plateformes s'ajoutent celles de la copie ; elle reprend ce qu'elle n'a pas (titre anglais,
 * cover, genres, description, bande-annonce, captures, synopsis) ; favoris, votes, notifications, alertes et
 * rappels passent sur elle ; le titre et la cover de la copie vont dans merge_blocklist, renvoyés vers la
 * gardée (un envoi qui les reprendrait la met à jour) ; la copie est supprimée. null : garde-fou (memeJeu) non
 * tenu, ou fiches changées entre-temps : rien n'est fait.
 */
export async function fusionnerJeux(
  deps: IgdbJeuxDeps,
  gagnantId: number,
  perdantId: number,
  igdb: number,
  motif: string,
  opts: { noms: string[]; idMort?: number; degreMax?: number }
): Promise<Fusion | null> {
  if (typeof deps.pool.getConnection !== "function" || gagnantId === perdantId) return null;
  const conn = await deps.pool.getConnection();
  try {
    await conn.query("START TRANSACTION");
    const lignes: any[] = await conn.query("SELECT *, DATE_FORMAT(release_date, '%Y-%m-%d') AS date_iso FROM game_items WHERE id IN (?, ?) FOR UPDATE", [gagnantId, perdantId]);
    const g = lignes.find((x) => Number(x.id) === gagnantId);
    const p = lignes.find((x) => Number(x.id) === perdantId);
    // la copie n'a pas d'identifiant IGDB, ou le même, ou un identifiant qu'IGDB ne connaît plus (idMort)
    const idCopie = Number(p?.igdb_id) || 0;
    if (!g || !p || Number(g.igdb_id) !== igdb || (idCopie > 0 && idCopie !== igdb && idCopie !== Number(opts.idMort)) || !memeJeu(g, p, opts.noms ?? [], opts.degreMax)) {
      await conn.query("ROLLBACK");
      return null;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const plateformes = mergePlatforms(g.platform, p.platform);
    if (plateformes && plateformes !== g.platform) {
      sets.push("platform = ?");
      params.push(plateformes);
    }
    for (const col of REPRIS) {
      if (col in g && col in p && isMissing(g[col]) && !isMissing(p[col])) {
        sets.push(`\`${col}\` = ?`);
        params.push(p[col]);
      }
    }
    if ("synopsis_fr" in g && vide(g.synopsis_fr) && !vide(p.synopsis_fr)) {
      for (const col of Object.keys(p).filter((c) => /^synopsis_[a-z0-9_]+$/.test(c))) {
        sets.push(`\`${col}\` = ?`);
        params.push(p[col]);
      }
    }
    if (sets.length) await conn.query(`UPDATE game_items SET ${sets.join(", ")}, updated_at = updated_at WHERE id = ?`, [...params, gagnantId]);
    let relations = 0;
    for (const t of [...TABLES_LIEES, "jeux_steam"]) {
      try {
        if (t === "jeux_steam") {
          await conn.query("DELETE FROM jeux_steam WHERE game_id = ?", [perdantId]);
          continue;
        }
        // une ligne que la gagnante a déjà (même utilisateur) n'est pas déplacée : elle part avec la copie
        const compte = async () => Number((await conn.query(`SELECT COUNT(*) AS n FROM ${t} WHERE item_type = 'game' AND item_id = ?`, [perdantId]))?.[0]?.n ?? 0);
        const avant = await compte();
        if (!avant) continue;
        await conn.query(`UPDATE IGNORE ${t} SET item_id = ? WHERE item_type = 'game' AND item_id = ?`, [gagnantId, perdantId]);
        relations += avant - (await compte());
        await conn.query(`DELETE FROM ${t} WHERE item_type = 'game' AND item_id = ?`, [perdantId]);
      } catch (e) {
        if (Number((e as any)?.errno) !== 1146) throw e;
      }
    }
    await conn.query("INSERT INTO merge_blocklist (item_type, blocked_title, blocked_cover, redirect_to_id, reason) VALUES ('game', ?, ?, ?, ?)", [
      String(p.title ?? ""),
      vide(p.cover) ? null : p.cover,
      gagnantId,
      motif,
    ]);
    await conn.query("DELETE FROM game_items WHERE id = ?", [perdantId]);
    await conn.query("COMMIT");
    const fiche = (x: any, id: number): FicheFusion => ({
      id,
      titre: String(x.title ?? ""),
      date: x.date_iso ?? null,
      precision: x.release_precision ?? null,
      plateformes: x.platform ?? null,
      popularite: Number(x.popularity) || 0,
    });
    return { gagnant: fiche(g, gagnantId), perdant: fiche(p, perdantId), igdb, relations, motif };
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    try {
      await Promise.resolve(conn.release());
    } catch {
      /* connexion déjà perdue */
    }
  }
}

/**
 * Fiche gardée d'un groupe qui porte le même identifiant IGDB : celle dont le titre colle le mieux à la fiche
 * IGDB, puis sans « (AAAA) », la plus complète, la plus populaire, la plus ancienne.
 */
const remplis = (x: any) => ["cover", "platform", "description", "trailer_url", "synopsis_fr"].filter((c) => !vide(x[c])).length;
const sansAnnee = (t: unknown) => (/\(\d{4}\)\s*$/.test(String(t ?? "")) ? 0 : 1);
const rangTitre = (x: any, noms: string[]) => degreFiche(x, noms) || 9;
function gagnantDAbord(noms: string[]) {
  return (a: any, b: any): number =>
    rangTitre(a, noms) - rangTitre(b, noms) ||
    sansAnnee(b.title) - sansAnnee(a.title) ||
    remplis(b) - remplis(a) ||
    Number(b.popularity || 0) - Number(a.popularity || 0) ||
    Number(a.id) - Number(b.id);
}

/** Une paire de fiches qui portent le même identifiant IGDB sans pouvoir être fusionnées (garde-fou). */
export interface PartageRefuse {
  igdb: number;
  nom: string;
  gardee: { id: number; titre: string };
  autre: { id: number; titre: string };
}

/**
 * Les fiches qui portent le même identifiant IGDB : fusionnées dans la gardée si le garde-fou tient ; sinon
 * signalées (la gardée et l'autre). Les noms de la fiche IGDB sont lus pour choisir la gardée.
 */
async function fusionnerMemeIgdb(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig): Promise<{ fusions: Fusion[]; refuses: PartageRefuse[] }> {
  const res: { fusions: Fusion[]; refuses: PartageRefuse[] } = { fusions: [], refuses: [] };
  const groupes: any[] = await deps.pool.query("SELECT igdb_id FROM game_items WHERE igdb_id > 0 GROUP BY igdb_id HAVING COUNT(*) > 1 LIMIT 50");
  if (!groupes.length) return res;
  const ids = groupes.map((x) => Number(x.igdb_id));
  const fiches = await requete(deps, cfg, "games", `fields id, name, alternative_names.name; where id = (${ids.join(",")}); limit ${ids.length};`);
  const nomsDe = new Map<number, string[]>(fiches.map((g: any) => [Number(g.id), nomsIgdb(g)]));
  for (const igdb of ids) {
    const noms = nomsDe.get(igdb) ?? [];
    const lignes: any[] = await deps.pool.query("SELECT *, DATE_FORMAT(release_date, '%Y-%m-%d') AS date_iso FROM game_items WHERE igdb_id = ?", [igdb]);
    if (lignes.length < 2) continue;
    lignes.sort(gagnantDAbord(noms));
    const g = lignes[0];
    for (const p of lignes.slice(1)) {
      const fz = noms.length ? await fusionnerJeux(deps, Number(g.id), Number(p.id), igdb, "meme_igdb", { noms }) : null;
      if (fz) res.fusions.push(fz);
      else res.refuses.push({ igdb, nom: noms[0] ?? "", gardee: { id: Number(g.id), titre: String(g.title ?? "") }, autre: { id: Number(p.id), titre: String(p.title ?? "") } });
    }
  }
  return res;
}

// ── Passage : rattachement, fusion des doublons, dates, popularité, notes, jaquettes

export interface BilanLiens {
  cherches: number;
  lies: Array<{ id: number; titre: string; igdb: number; nom: string; voie?: string }>;
  ambigus: Array<{ id: number; titre: string }>;
  introuvables: Array<{ id: number; titre: string }>;
  /** Même jeu qu'une fiche qui porte déjà cet identifiant IGDB, sans fusion possible (fiches changées entre-temps). */
  doublons: Array<{ id: number; titre: string; igdb: number; nom: string; autre: { id: number; titre: string } }>;
  /** Même jeu qu'une fiche qui porte déjà cet identifiant IGDB : fusionné dans celle-ci. */
  fusions: Fusion[];
  /**
   * Fusion refusée, mais la fiche sans IGDB porte le nom de la fiche IGDB mieux que celle qui l'avait (titre
   * exact contre titre prolongé) : l'identifiant passe sur elle ; l'autre fiche est recherchée de nouveau.
   */
  transferts: Transfert[];
  erreur?: string;
}

/** Une date changée par le passage. */
export interface ChangementDate {
  id: number;
  titre: string;
  popularite: number;
  avant: DateJeu;
  apres: DateJeu;
  source: "igdb" | "steam";
  /** fauxJour : un 31/12 ou 1/1 devenu une vraie date ou l'année ; report, avance, precise, autre. */
  sorte: "fauxJour" | "report" | "avance" | "precise" | "autre";
  statut?: { avant: "sorti" | "a venir"; apres: "sorti" | "a venir" };
}

export interface BilanJeux {
  jeux: number;
  avecIgdb: number;
  avecListes: number;
  popularites: number;
  notes: number;
  notesGardees: number;
  jaquettes: number;
  planchers: number;
  /**
   * Rattachements douteux, à vérifier : « titre » (sans rapport avec la fiche IGDB), « date » (fiche sans sortie
   * dans la fenêtre ni après, première sortie à plus de 3 ans ; ou titre seulement proche et date avancée au-delà
   * de sa fenêtre) : ni date ni jaquette écrites, listes et note gardées ; « partage » (identifiant porté aussi
   * par une autre fiche, fusion refusée) : rien de la fiche.
   */
  douteux: Array<{ id: number; titre: string; nom: string; raison: string }>;
  /** Rattachements douteux corrigés : le titre et la date désignent une autre fiche IGDB, une seule. */
  relies: Array<{ id: number; titre: string; ancien: number; nouveau: number; nom: string }>;
  /**
   * Jeux dont IGDB ne rend plus la fiche (identifiant fusionné ou supprimé, absence confirmée) : nouveau
   * rattachement par le titre (« relie »), fusion dans la fiche qui porte déjà la bonne fiche IGDB (« fusionne »),
   * sinon l'identifiant mort est retiré, popularité 0 (« introuvable », « doublon » si une autre fiche porte la
   * fiche retrouvée) ; « non verifie » si IGDB a mal répondu (valeurs gardées).
   */
  absents: Array<{ id: number; titre: string; igdb: number; issue: "relie" | "fusionne" | "doublon" | "introuvable" | "non verifie"; nouveau?: number; nom?: string; autre?: { id: number; titre: string } }>;
  /** Toutes les fusions du passage (rattachement, même identifiant IGDB, identifiants morts, douteux). */
  fusions: Fusion[];
  dates: ChangementDate[];
  /** false : IGDB a refusé le statut et la région des dates (règle stricte : pas d'accès anticipé, toutes les régions). */
  champsComplets: boolean;
  liens: BilanLiens;
  requetes: number;
  erreur?: string;
  occupe?: boolean;
}

const bilanVide = (): BilanJeux => ({
  jeux: 0, avecIgdb: 0, avecListes: 0, popularites: 0, notes: 0, notesGardees: 0, jaquettes: 0, planchers: 0, douteux: [], relies: [], absents: [],
  fusions: [], dates: [], champsComplets: true, liens: { cherches: 0, lies: [], ambigus: [], introuvables: [], doublons: [], fusions: [], transferts: [] }, requetes: 0,
});

let compteur = 0;
function compter(deps: IgdbJeuxDeps): IgdbJeuxDeps {
  const base = deps.igdb;
  return {
    ...deps,
    igdb: (p, c) => {
      compteur++;
      return base
        ? base(p, c)
        : igdbFetch(URL_IGDB + p, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: c });
    },
  };
}

export interface Transfert {
  igdb: number;
  nom: string;
  de: { id: number; titre: string };
  vers: { id: number; titre: string };
}

/** Identifiants IGDB qu'une fiche a perdus par un transfert : elle n'y est plus jamais rattachée. */
const TABLE_ECARTES =
  "CREATE TABLE IF NOT EXISTS jeux_igdb_ecartes (game_id INT NOT NULL, igdb_id INT NOT NULL, le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (game_id, igdb_id)) CHARACTER SET utf8mb4";
/** Tables où un utilisateur a lié un jeu (une fiche qui en a ne perd pas son identifiant par un transfert). */
const TABLES_UTILISATEURS = ["favorites", "votes", "alert_log", "reminder_log"];

/**
 * L'identifiant IGDB passe d'une fiche (porteur) à une autre sans IGDB (copie), en une transaction, quand la
 * copie porte un nom de la fiche IGDB strictement mieux que le porteur (« Grand Saga » contre « Grand Saga
 * Origins » pour la fiche « Grand Saga ») et que personne n'a lié le porteur (favori, vote, alerte, rappel) ;
 * le porteur perd l'identifiant (il n'y sera plus jamais rattaché, jeux_igdb_ecartes) et sa ligne Steam venue
 * d'IGDB ; il est cherché de nouveau. Rien n'est supprimé. null : condition non remplie, ou fiches changées.
 */
async function transfererIgdb(deps: IgdbJeuxDeps, porteurId: number, copieId: number, igdb: number, noms: string[]): Promise<Transfert | null> {
  if (typeof deps.pool.getConnection !== "function" || !noms.length || porteurId === copieId) return null;
  await deps.pool.query(TABLE_ECARTES);
  const conn = await deps.pool.getConnection();
  try {
    await conn.query("START TRANSACTION");
    const lignes: any[] = await conn.query("SELECT id, title, title_english, igdb_id FROM game_items WHERE id IN (?, ?) FOR UPDATE", [porteurId, copieId]);
    const po = lignes.find((x) => Number(x.id) === porteurId);
    const co = lignes.find((x) => Number(x.id) === copieId);
    const dP = po ? degreFiche(po, noms) : 0;
    const dC = co ? degreFiche(co, noms) : 0;
    let lie = false;
    for (const t of TABLES_UTILISATEURS) {
      try {
        if (Number((await conn.query(`SELECT COUNT(*) AS n FROM ${t} WHERE item_type = 'game' AND item_id = ?`, [porteurId]))?.[0]?.n ?? 0) > 0) lie = true;
      } catch (e) {
        if (Number((e as any)?.errno) !== 1146) throw e;
      }
    }
    if (!po || !co || lie || Number(po.igdb_id) !== igdb || Number(co.igdb_id) > 0 || !dC || (dP && dC >= dP)) {
      await conn.query("ROLLBACK");
      return null;
    }
    await conn.query("UPDATE game_items SET igdb_id = NULL, last_refetch_at = NULL, updated_at = updated_at WHERE id = ?", [porteurId]);
    await conn.query("UPDATE game_items SET igdb_id = ?, last_refetch_at = NULL, updated_at = updated_at WHERE id = ?", [igdb, copieId]);
    await conn.query("INSERT IGNORE INTO jeux_igdb_ecartes (game_id, igdb_id) VALUES (?, ?)", [porteurId, igdb]);
    await supprimerSteamIgdb(conn, porteurId);
    await conn.query("COMMIT");
    return { igdb, nom: noms[0] ?? "", de: { id: porteurId, titre: String(po.title ?? "") }, vers: { id: copieId, titre: String(co.title ?? "") } };
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    try {
      await Promise.resolve(conn.release());
    } catch {
      /* connexion déjà perdue */
    }
  }
}

/** Rattache à IGDB les jeux qui n'y sont pas (les plus populaires d'abord) ; un doublon est fusionné. */
export async function lierJeux(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig = configIgdbJeux()): Promise<BilanLiens> {
  const res: BilanLiens = { cherches: 0, lies: [], ambigus: [], introuvables: [], doublons: [], fusions: [], transferts: [] };
  // identifiants qu'une fiche a perdus par un transfert : jamais repris
  const ecartes = new Map<number, number[]>();
  try {
    for (const x of (await deps.pool.query("SELECT game_id, igdb_id FROM jeux_igdb_ecartes")) as any[])
      ecartes.set(Number(x.game_id), [...(ecartes.get(Number(x.game_id)) ?? []), Number(x.igdb_id)]);
  } catch (e) {
    if (Number((e as any)?.errno) !== 1146) throw e;
  }
  const lignes: any[] = await deps.pool.query(
    "SELECT id, title, title_english, DATE_FORMAT(release_date, '%Y-%m-%d') AS date, release_precision AS prec FROM game_items " +
      "WHERE (igdb_id IS NULL OR igdb_id = 0) AND title IS NOT NULL AND title <> '' ORDER BY popularity DESC, id LIMIT ?",
    [cfg.maxLiens]
  );
  for (const l of lignes) {
    const id = Number(l.id);
    const titre = String(l.title);
    let r: Rattachement;
    try {
      r = await trouverIgdb(deps, cfg, titre, l.date ?? null, l.prec ?? null, { titreAnglais: l.title_english ?? null, exclure: ecartes.get(id) });
    } catch (e) {
      res.erreur = message(e);
      break;
    }
    res.cherches++;
    if (r.etat === "ambigu") res.ambigus.push({ id, titre });
    else if (r.etat === "aucun" || !r.igdb) res.introuvables.push({ id, titre });
    else {
      try {
        const autre: any[] = await deps.pool.query("SELECT id, title FROM game_items WHERE igdb_id = ? AND id <> ? LIMIT 1", [r.igdb, id]);
        if (autre.length) {
          // le même jeu que la fiche qui porte déjà cet identifiant IGDB : la copie est fusionnée dans celle-ci
          // (garde-fou : les deux fiches portent un nom de la fiche IGDB, la gardée au moins aussi bien)
          const fz = await fusionnerJeux(deps, Number(autre[0].id), id, r.igdb, "doublon_igdb", { noms: r.noms ?? [] });
          if (fz) {
            res.fusions.push(fz);
            continue;
          }
          // fusion refusée : si cette fiche colle mieux à la fiche IGDB que celle qui la porte, l'identifiant passe
          // sur elle (rien n'est supprimé) ; sinon les deux fiches sont signalées
          const t = await transfererIgdb(deps, Number(autre[0].id), id, r.igdb, r.noms ?? []);
          if (t) res.transferts.push(t);
          else res.doublons.push({ id, titre, igdb: r.igdb, nom: r.nom ?? "", autre: { id: Number(autre[0].id), titre: String(autre[0].title) } });
          continue;
        }
        const u: any = await deps.pool.query(
          "UPDATE game_items SET igdb_id = ?, last_refetch_at = NULL, updated_at = updated_at WHERE id = ? AND (igdb_id IS NULL OR igdb_id = 0)",
          [r.igdb, id]
        );
        if (Number(u?.affectedRows ?? 0) > 0) res.lies.push({ id, titre, igdb: r.igdb, nom: r.nom ?? "", voie: r.voie });
      } catch (e) {
        res.erreur = "base : " + message(e);
        break;
      }
    }
  }
  return res;
}

/** Un passage complet, sous le verrou de la base (déjà pris ailleurs : rien n'est fait, « occupe »). */
export async function passageJeux(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig = configIgdbJeux(), maintenant: Date = new Date()): Promise<BilanJeux> {
  const liberer = await prendreVerrou(deps.pool);
  if (!liberer) return { ...bilanVide(), occupe: true };
  const avant = compteur;
  const d = compter(deps);
  try {
    const r = await passageSousVerrou(d, cfg, maintenant);
    r.requetes = compteur - avant;
    return r;
  } finally {
    await liberer();
  }
}

const RELIES_MAX = 10;

async function passageSousVerrou(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, maintenant: Date): Promise<BilanJeux> {
  const res = bilanVide();
  const f = fenetreSite(maintenant);
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  // 1. rattachement (une panne d'IGDB ici est notée ; la suite le révélera aussi), doublons fusionnés,
  //    puis les fiches qui portent le même identifiant IGDB
  res.liens = await lierJeux(deps, cfg);
  res.fusions.push(...res.liens.fusions);
  // fiches qui partagent un identifiant IGDB sans pouvoir être fusionnées : signalées ; l'autre fiche n'en prend
  // ni la date, ni les valeurs, ni la jaquette (elle est traitée comme sans IGDB et cherchée au titre exact)
  const partages = new Set<number>();
  try {
    const mi = await fusionnerMemeIgdb(deps, cfg);
    res.fusions.push(...mi.fusions);
    for (const x of mi.refuses) {
      partages.add(x.autre.id);
      res.liens.doublons.push({ id: x.autre.id, titre: x.autre.titre, igdb: x.igdb, nom: x.nom, autre: x.gardee });
    }
  } catch (e) {
    res.erreur = message(e);
    return res;
  }

  // 2. jeux, fiches IGDB (avec leurs dates), listes, planchers, ce que dit Steam
  const jeux: any[] = await deps.pool.query(
    "SELECT id, title, title_english, igdb_id, cover, rating_score, popularity, popularity_source, DATE_FORMAT(release_date, '%Y-%m-%d') AS date, " +
      "release_precision AS prec FROM game_items"
  );
  res.jeux = jeux.length;
  const ids = [...new Set(jeux.map((j) => Number(j.igdb_id)).filter((x) => x > 0))];
  res.avecIgdb = jeux.filter((j) => Number(j.igdb_id) > 0).length;
  let fiches: Map<number, any>;
  let parts: Map<number, ListesJeu>;
  let planchers: Array<{ motif: string; valeur: number }>;
  let steam: Map<number, DateJeu & { origine: string }>;
  const lots: number[][] = [];
  try {
    const lu = await lireFichesDates(
      deps,
      cfg,
      ids,
      "id, name, alternative_names.name, total_rating, total_rating_count, cover.image_id, first_release_date, release_dates.date, release_dates.human"
    );
    fiches = lu.fiches;
    res.champsComplets = lu.complets;
    parts = await lireListes(deps, cfg, ids, lots);
    planchers = await lirePlanchers(deps.pool);
    steam = await lireSteam(deps.pool);
  } catch (e) {
    res.erreur = message(e);
    return res;
  }
  res.avecListes = jeux.filter((j) => parts.has(Number(j.igdb_id))).length;
  // Réponse incomplète : listes pour moitié moins de jeux qu'au passage précédent (popularity_source > 0)…
  const avant = jeux.filter((j) => Number(j.igdb_id) > 0 && Number(j.popularity_source) > 0).length;
  if (avant >= 50 && res.avecListes < avant / 2) {
    res.erreur = `réponse IGDB incomplète : listes pour ${res.avecListes} jeux (${avant} au passage précédent)`;
    return res;
  }
  // … ou un paquet nettement moins couvert que les autres (moitié de la couverture d'ensemble)
  const avecValeur = new Set(jeux.filter((j) => Number(j.igdb_id) > 0 && Number(j.popularity_source) > 0).map((j) => Number(j.igdb_id)));
  const couvertures = lots.map((lot) => {
    const attendus = lot.filter((x) => avecValeur.has(x));
    return { attendus: attendus.length, recus: attendus.filter((x) => parts.has(x)).length };
  });
  const totalAttendus = couvertures.reduce((s, c) => s + c.attendus, 0);
  const totalRecus = couvertures.reduce((s, c) => s + c.recus, 0);
  const faible = couvertures.find((c) => totalAttendus > 0 && c.attendus >= LOT_VIDE_SUSPECT && c.recus / c.attendus < totalRecus / totalAttendus / 2);
  if (faible) {
    res.erreur = `réponse IGDB incomplète : un lot avec des listes pour ${faible.recus} jeux sur ${faible.attendus}`;
    return res;
  }

  // 3. écriture : date, valeur IGDB (selon le statut), plancher, note, jaquette
  let changes = 0;
  const absents: any[] = [];
  const douteux: Array<{ j: any; fiche: any }> = [];
  const signaler = (j: any, nom: string, raison: string) => {
    if (res.douteux.length < 60) res.douteux.push({ id: Number(j.id), titre: String(j.title), nom, raison });
  };
  for (const j of jeux) {
    const igdb = Number(j.igdb_id) || 0;
    const partage = partages.has(Number(j.id));
    const fiche = igdb && !partage ? fiches.get(igdb) : undefined;
    if (igdb && !partage && !fiche) {
      // identifiant qu'IGDB ne connaît plus (fiche fusionnée ou supprimée) : traité après (étape 4)
      absents.push(j);
      continue;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const nous: DateJeu = { date: j.date ?? null, precision: j.prec ?? null };
    // rattachement douteux : titre sans rapport avec la fiche IGDB (« titre »), ou fiche sans aucune sortie dans
    // la fenêtre ni après, et première sortie à plus de 3 ans de NOTRE date (« date ») : la date n'est pas remise
    // à jour et la jaquette n'est pas prise (listes et note restent, comme avant : un titre traduit, un long accès
    // anticipé sont souvent de bons rattachements) ; identifiant partagé avec une autre fiche, fusion refusée
    // (« partage ») : rien de cette fiche (ni date, ni valeurs, ni note, ni jaquette)
    let raison = partage ? "partage" : "";
    let dIgdb: { date: string; precision: Precision } | null = null;
    let reporte = false;
    if (fiche) {
      const dedans = dateDecouverte(fiche.release_dates, f, res.champsComplets);
      const apres = dedans ? null : dateApresFenetre(fiche.release_dates, f, res.champsComplets);
      dIgdb = sansFauxJour(dedans ?? apres, aujourdhui);
      reporte = !!apres;
      const ts = Number(fiche.first_release_date) * 1000;
      const ecart = j.date && ts > 0 ? Math.abs(Date.parse(j.date + "T00:00:00Z") - ts) : 0;
      raison = !degreFiche(j, nomsIgdb(fiche)) ? "titre" : !dedans && !apres && ecart > 3 * 366 * 86400000 ? "date" : "";
    }
    // date : IGDB (première sortie dans la fenêtre, ou report au-delà), puis Steam ; le statut qui en découle
    // choisit les listes. Steam retrouvé par le seul titre (catalogue) : il ne fait que préciser notre période ;
    // jeu reporté au-delà de la fenêtre : Steam (lu avant le report) ne le ramène pas.
    let fin: DateJeu & { source: "base" | "igdb" | "steam" } = { date: nous.date, precision: nous.precision, source: "base" };
    if (!raison) {
      const st = reporte ? undefined : steam.get(Number(j.id));
      const dSteam = st?.date && st.precision ? sansFauxJour({ date: st.date, precision: st.precision }, aujourdhui) : null;
      const reculer = !fiche || degreFiche(j, nomsIgdb(fiche)) <= 2;
      fin = dateFinale(nous, dIgdb, dSteam, f, { prudent: st?.origine === "catalogue", aujourdhui, reculer });
      // titre seulement proche (prolongé, sous-titre) et date IGDB avancée au-delà de sa fenêtre : sans doute un
      // autre jeu (un report est suivi ; une date PC de Steam, page au titre vérifié, aussi) ; rien n'est écrit
      if (fiche && fin.source === "igdb" && fin.date && nous.date && fin.date < nous.date && degreFiche(j, nomsIgdb(fiche)) >= 3) {
        const ecart = (Date.parse(nous.date + "T00:00:00Z") - Date.parse(fin.date + "T00:00:00Z")) / 86400000;
        if (ecart > matchWindowDays(nous.date, nous.precision)) {
          raison = "date";
          fin = { date: nous.date, precision: nous.precision, source: "base" };
        }
      }
    }
    if (raison) {
      signaler(j, fiche ? String(fiche.name || "") : "", raison);
      douteux.push({ j, fiche });
    }
    if (fin.date && fin.precision && (fin.date !== nous.date || fin.precision !== nous.precision)) {
      sets.push("release_date = ?", "release_precision = ?");
      params.push(fin.date, fin.precision);
      res.dates.push(changementDate(j, nous, fin, aujourdhui));
    }
    const statut: "sorti" | "a venir" = fin.date && fin.precision ? statutSite(fin.date, fin.precision, aujourdhui) : "a venir";
    const source = fiche ? Math.round(partListes(parts.get(igdb), statut) * cfg.echelle) : 0; // « partage » : pas de fiche
    const p = plancher(String(j.title || ""), planchers);
    const popularite = Math.max(source, p);
    if (p > source) res.planchers++;
    if (Number(j.popularity_source ?? -1) !== source) {
      sets.push("popularity_source = ?");
      params.push(source);
    }
    if (Number(j.popularity ?? -1) !== popularite) {
      sets.push("popularity = ?");
      params.push(popularite);
      res.popularites++;
    }
    const votes = Number(fiche?.total_rating_count) || 0;
    const note = fiche && votes >= cfg.votesMin && Number.isFinite(Number(fiche.total_rating)) ? Math.max(0, Math.min(100, Math.round(Number(fiche.total_rating)))) : null;
    if (note != null && Number(j.rating_score ?? -1) !== note) {
      sets.push("rating_score = ?");
      params.push(note);
      res.notes++;
    } else if (note == null && j.rating_score != null) res.notesGardees++;
    const imageId = raison ? null : fiche?.cover?.image_id;
    const cover = String(j.cover || "");
    let gardeCover = false;
    if (imageId && /^[A-Za-z0-9_-]+$/.test(String(imageId)) && (!cover || /media\.rawg\.io/i.test(cover))) {
      sets.push("cover = ?");
      params.push(urlJaquetteIgdb(String(imageId)));
      gardeCover = true;
      res.jaquettes++;
    }
    if (!sets.length) continue;
    params.push(Number(j.id));
    try {
      // la jaquette n'est remplacée que si la cover n'a pas changé entre-temps
      await deps.pool.query(
        `UPDATE game_items SET ${sets.join(", ")}, updated_at = updated_at WHERE id = ?${gardeCover ? " AND (cover <=> ?)" : ""}`,
        gardeCover ? [...params, j.cover] : params
      );
      changes++;
    } catch (e) {
      res.erreur = "base : " + message(e);
      break;
    }
  }

  // 4. identifiants qu'IGDB ne rend plus : l'absence est d'abord confirmée par une question à part (une fiche
  //    oubliée par une réponse partielle n'est pas absente) ; puis nouveau rattachement par le titre (mêmes
  //    règles) ; le même jeu qu'une autre fiche : fusion (titre à un numéro près au plus) ; sinon l'identifiant
  //    mort est retiré : le jeu redevient « sans IGDB » (popularité 0, avec son plancher ; cherché à chaque
  //    passage), et les identifiants morts ne s'accumulent pas.
  //    La question de confirmation porte aussi une fiche témoin (rendue par la lecture du passage) : si IGDB ne
  //    la rend pas, il répond mal et rien n'est touché (« non verifie ») ; s'il la rend, les fiches qui manquent
  //    sont bien mortes.
  let igdbMuet = false;
  let absentsSuspects = false;
  const presents = new Set<number>();
  if (absents.length && !res.erreur) {
    try {
      const ids = [...new Set(absents.map((j) => Number(j.igdb_id)))];
      const temoin = [...fiches.keys()].find((x) => x > 0 && !ids.includes(x)) ?? 0;
      let recus = 0;
      for (let i = 0; i < ids.length; i += 400) {
        const lot = [...ids.slice(i, i + 400), ...(temoin ? [temoin] : [])];
        const rep = await requete(deps, cfg, "games", `fields id; where id = (${lot.join(",")}); limit ${lot.length};`);
        recus += rep.length;
        const vus = new Set(rep.map((g: any) => Number(g?.id)));
        if (temoin && !vus.has(temoin)) absentsSuspects = true;
        for (const x of vus) if (x !== temoin) presents.add(x);
      }
      if (!temoin && ids.length >= 5 && recus === 0) absentsSuspects = true;
    } catch {
      igdbMuet = true;
    }
  }
  for (const j of absents) {
    const igdb = Number(j.igdb_id);
    const entree: BilanJeux["absents"][number] = { id: Number(j.id), titre: String(j.title), igdb, issue: "introuvable" };
    res.absents.push(entree);
    if (res.erreur || igdbMuet || absentsSuspects || presents.has(igdb)) {
      entree.issue = "non verifie";
      continue;
    }
    let r: Rattachement;
    try {
      r = await trouverIgdb(deps, cfg, String(j.title), j.date ?? null, j.prec ?? null, { exclure: igdb, titreAnglais: j.title_english ?? null });
    } catch {
      igdbMuet = true;
      entree.issue = "non verifie";
      continue;
    }
    try {
      if (r.etat === "un" && r.igdb && r.igdb !== igdb) {
        entree.nouveau = r.igdb;
        entree.nom = r.nom ?? "";
        const autre: any[] = await deps.pool.query("SELECT id, title FROM game_items WHERE igdb_id = ? AND id <> ? LIMIT 1", [r.igdb, Number(j.id)]);
        if (autre.length) {
          entree.autre = { id: Number(autre[0].id), titre: String(autre[0].title) };
          const fz = await fusionnerJeux(deps, Number(autre[0].id), Number(j.id), r.igdb, "doublon_igdb", { noms: r.noms ?? [], idMort: igdb, degreMax: 2 });
          if (fz) {
            entree.issue = "fusionne";
            res.fusions.push(fz);
            changes++;
            continue;
          }
          entree.issue = "doublon";
        } else {
          const u: any = await deps.pool.query(
            "UPDATE game_items SET igdb_id = ?, last_refetch_at = NULL, updated_at = updated_at WHERE id = ? AND igdb_id = ?",
            [r.igdb, Number(j.id), igdb]
          );
          if (Number(u?.affectedRows ?? 0) > 0) {
            entree.issue = "relie";
            changes++;
            continue; // valeurs de la nouvelle fiche au prochain passage
          }
        }
      }
      // fusion refusée avec la fiche retrouvée (titre trop loin) : jamais rattaché à elle ensuite (sinon le
      // rattachement ordinaire, plus large, la fusionnerait au passage suivant)
      if (entree.issue === "doublon" && entree.nouveau) {
        await deps.pool.query(TABLE_ECARTES);
        await deps.pool.query("INSERT IGNORE INTO jeux_igdb_ecartes (game_id, igdb_id) VALUES (?, ?)", [Number(j.id), entree.nouveau]);
      }
      // identifiant mort retiré (la ligne Steam qu'il donnait part avec lui)
      const p = plancher(String(j.title || ""), planchers);
      const u: any = await deps.pool.query(
        "UPDATE game_items SET igdb_id = NULL, popularity_source = 0, popularity = ?, last_refetch_at = NULL, updated_at = updated_at WHERE id = ? AND igdb_id = ?",
        [p, Number(j.id), igdb]
      );
      if (Number(u?.affectedRows ?? 0) > 0) {
        await supprimerSteamIgdb(deps.pool, Number(j.id));
        if (Number(j.popularity ?? -1) !== p) res.popularites++;
        changes++;
      }
    } catch (e) {
      res.erreur = "base : " + message(e);
      break;
    }
  }

  // 5. rattachements douteux : le titre exact et la date désignent une autre fiche IGDB, une seule ? on la prend
  //    (jaquette comprise ; le reste au prochain passage)
  if (!res.erreur && !igdbMuet) {
    douteux.sort((a, b) => Number(b.j.popularity || 0) - Number(a.j.popularity || 0));
    for (const { j } of douteux.slice(0, RELIES_MAX)) {
      const ancien = Number(j.igdb_id);
      let r: Rattachement;
      try {
        r = await trouverIgdb(deps, cfg, String(j.title), j.date ?? null, j.prec ?? null, { exclure: ancien, titreAnglais: j.title_english ?? null, exact: true });
      } catch {
        break;
      }
      if (r.etat !== "un" || !r.igdb) continue;
      try {
        const autre: any[] = await deps.pool.query("SELECT id FROM game_items WHERE igdb_id = ? AND id <> ? LIMIT 1", [r.igdb, Number(j.id)]);
        // la bonne fiche est déjà portée par un autre jeu : celui-ci porte une autre fiche IGDB, il n'est pas
        // supprimé sur une présomption ; il reste signalé comme douteux
        if (autre.length) continue;
        let jaquette: string | null = null;
        try {
          const nf = (await requete(deps, cfg, "games", `fields cover.image_id; where id = ${r.igdb}; limit 1;`))[0];
          if (nf?.cover?.image_id && /^[A-Za-z0-9_-]+$/.test(String(nf.cover.image_id))) jaquette = urlJaquetteIgdb(String(nf.cover.image_id));
        } catch {
          /* la jaquette viendra au prochain passage si la cover est vide ou de RAWG */
        }
        // la cover de l'ancienne fiche (IGDB ou RAWG) laisse place à la jaquette de la nouvelle
        const coverAncienne = !j.cover || /media\.rawg\.io|images\.igdb\.com/i.test(String(j.cover));
        const u: any = await deps.pool.query(
          `UPDATE game_items SET igdb_id = ?, last_refetch_at = NULL${jaquette && coverAncienne ? ", cover = ?" : ""}, updated_at = updated_at WHERE id = ? AND igdb_id = ?`,
          jaquette && coverAncienne ? [r.igdb, jaquette, Number(j.id), ancien] : [r.igdb, Number(j.id), ancien]
        );
        if (Number(u?.affectedRows ?? 0) > 0) {
          res.relies.push({ id: Number(j.id), titre: String(j.title), ancien, nouveau: r.igdb, nom: r.nom ?? "" });
          changes++;
        }
      } catch (e) {
        res.erreur = "base : " + message(e);
        break;
      }
    }
  }
  if (changes > 0 || res.liens.lies.length > 0 || res.fusions.length > 0 || res.liens.transferts.length > 0) deps.rafraichir?.();
  return res;
}

/** Ce qu'un changement de date fait au jeu : faux jour corrigé, report, avance, date précisée. */
function changementDate(j: any, avant: DateJeu, apres: DateJeu & { source: string }, aujourdhui: string): ChangementDate {
  const c: ChangementDate = {
    id: Number(j.id),
    titre: String(j.title ?? ""),
    popularite: Number(j.popularity) || 0,
    avant,
    apres: { date: apres.date, precision: apres.precision },
    source: apres.source === "steam" ? "steam" : "igdb",
    sorte: "autre",
  };
  if (avant.date && apres.date) {
    const pa = periode(avant);
    const pn = periode(apres);
    if (fauxJour(avant)) c.sorte = "fauxJour";
    else if (pn.debut > pa.fin) c.sorte = "report";
    else if (pn.fin < pa.debut) c.sorte = "avance";
    else if (RANG_PRECISION[precisionReelle(apres)] > RANG_PRECISION[precisionReelle(avant)]) c.sorte = "precise";
    const sa = avant.precision ? statutSite(avant.date, avant.precision, aujourdhui) : "a venir";
    const sn = apres.precision ? statutSite(apres.date, apres.precision, aujourdhui) : "a venir";
    if (sa !== sn) c.statut = { avant: sa, apres: sn };
  }
  return c;
}

// ── Découverte : les jeux populaires de la fenêtre du site qui manquent

export interface ItemDecouvert {
  title: string;
  cover: string;
  platform: string | null;
  genre: string | null;
  releaseDate: string;
  releasePrecision: Precision;
  description: string | null;
  igdbId: number;
  trailerUrl: string | null;
  popularity: number;
  ratingScore: number | null;
}

export interface BilanDecouverte {
  seuilSortis: number;
  seuilAVenir: number;
  lus: number;
  candidats: number;
  ajoutes: Array<{ titre: string; date: string; popularite: number; statut: "sorti" | "a venir" }>;
  /** Retenus mais pas ajoutés : la base a déjà ce titre (homonyme), un jeu pas encore rattaché lui ressemble, ou il est bloqué. */
  signales: Array<{ titre: string; raison: "homonyme" | "a rattacher" | "bloque"; autre: { id: number; titre: string } }>;
  /** false : IGDB a refusé le statut et la région des dates (règle stricte : pas d'accès anticipé, toutes les régions). */
  champsComplets: boolean;
  /** Candidats dont au moins une date porte un statut (accès anticipé, sortie complète…). */
  avecStatut: number;
  ecartes: { sousSeuil: number; horsFenetre: number; sansJaquette: number; erotique: number; deTrop: number };
  requetes: number;
  erreur?: string;
  occupe?: boolean;
}

/** Fenêtre du site : du 1er janvier de l'année courante au 31 décembre de l'année suivante (UTC). */
export function fenetreSite(maintenant: Date = new Date()): { debut: string; fin: string; debutTs: number; finTs: number } {
  const an = maintenant.getUTCFullYear();
  return { debut: `${an}-01-01`, fin: `${an + 1}-12-31`, debutTs: Date.UTC(an, 0, 1) / 1000, finTs: Date.UTC(an + 1, 11, 31, 23, 59, 59) / 1000 };
}

/** Une découverte, sous le verrou ; les jeux retenus passent par deps.ajouter (/games/bulk). */
export async function decouverteJeux(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig = configIgdbJeux(), maintenant: Date = new Date()): Promise<BilanDecouverte> {
  const vide: BilanDecouverte = {
    seuilSortis: 0, seuilAVenir: 0, lus: 0, candidats: 0, ajoutes: [], signales: [], champsComplets: true, avecStatut: 0,
    ecartes: { sousSeuil: 0, horsFenetre: 0, sansJaquette: 0, erotique: 0, deTrop: 0 }, requetes: 0,
  };
  const liberer = await prendreVerrou(deps.pool);
  if (!liberer) return { ...vide, occupe: true };
  const avant = compteur;
  const d = compter(deps);
  try {
    const r = await decouverteSousVerrou(d, cfg, maintenant, vide);
    r.requetes = compteur - avant;
    return r;
  } finally {
    await liberer();
  }
}

/** Statut sur le site (routes.ts, filterByStatus) : sorti = date au jour près, passée ; sinon à venir. */
const statutSite = (date: string, precision: Precision, aujourdhui: string): "sorti" | "a venir" => (precision === "day" && date <= aujourdhui ? "sorti" : "a venir");

const CHAMPS_DECOUVERTE =
  "id, name, alternative_names.name, cover.image_id, platforms.name, genres.name, summary, storyline, release_dates.date, release_dates.human, " +
  "first_release_date, videos.video_id, videos.name, themes, total_rating, total_rating_count";
/** Statut (accès anticipé…) et région des dates : demandés en plus ; refusés par IGDB (HTTP 400), on s'en passe. */
const CHAMPS_DATES = ", release_dates.status.name, release_dates.release_region.region";

/** Mots trop courants pour rapprocher deux titres à eux seuls. */
const MOTS_COMMUNS = new Set(["the", "and", "game", "games", "edition", "remastered", "remaster", "remake", "deluxe", "definitive", "complete", "collection",
  "world", "story", "online", "part", "chapter", "episode", "season", "simulator", "super", "ultimate", "legend", "legends", "tales", "chronicles"]);
const motsSignificatifs = (mots: string[]) => mots.filter((m) => m.length >= 4 && !/^\d+$/.test(m) && !MOTS_COMMUNS.has(m));

interface SansIgdb {
  id: number;
  titre: string;
  mots: string[][];
  date: string | null;
  prec: string | null;
}

/**
 * Ce que /games/bulk ferait de ce jeu : le confondre avec une fiche de la base (mêmes règles de titre :
 * titre exact, titre normalisé + date, titre sans ponctuation + date), le bloquer (merge_blocklist), ou il
 * ressemble à un jeu de la base pas encore rattaché (mêmes règles que le rattachement). null : jeu nouveau.
 */
async function collision(deps: IgdbJeuxDeps, g: any, item: ItemDecouvert, sansIgdb: SansIgdb[]): Promise<BilanDecouverte["signales"][number] | null> {
  const titre = item.title;
  const r: any[] = await deps.pool.query(
    "SELECT id, title, igdb_id FROM game_items WHERE title = ? OR title_english = ? " +
      "OR (release_date = ? AND title_normalized_strict IS NOT NULL AND title_normalized_strict <> '' AND title_normalized_strict = ?) " +
      "OR (release_date = ? AND LOWER(REGEXP_REPLACE(title, '[^[:alnum:]]', '')) = ?) LIMIT 1",
    [titre, titre, item.releaseDate, normalizeTitleStrict(titre), item.releaseDate, normalizeTitle(titre)]
  );
  if (r.length) return { titre, raison: Number(r[0].igdb_id) > 0 ? "homonyme" : "a rattacher", autre: { id: Number(r[0].id), titre: String(r[0].title) } };
  try {
    const bl: any[] = await deps.pool.query("SELECT id FROM merge_blocklist WHERE item_type = 'game' AND (blocked_title = ? OR blocked_cover = ?) LIMIT 1", [titre, item.cover]);
    if (bl.length) return { titre, raison: "bloque", autre: { id: 0, titre } };
  } catch {
    /* pas de liste de blocage */
  }
  // un jeu pas encore rattaché (souvent un titre traduit, que le rattachement n'a pas su relier) : même titre
  // à la façon du rattachement, ou un mot significatif commun, à une date proche
  const eux = nomsIgdb(g).map(motsTitre).filter((x) => x.length);
  const leursMots = new Set(eux.flatMap(motsSignificatifs));
  for (const s of sansIgdb) {
    const proche = s.mots.some((a) => eux.some((b) => degreTitres(a, b) > 0)) || s.mots.some((a) => motsSignificatifs(a).some((m) => leursMots.has(m)));
    if (proche && dateCompatible(g, s.date, s.prec)) return { titre, raison: "a rattacher", autre: { id: s.id, titre: s.titre } };
  }
  return null;
}

async function decouverteSousVerrou(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, maintenant: Date, res: BilanDecouverte): Promise<BilanDecouverte> {
  const f = fenetreSite(maintenant);
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const seuil = async (sql: string, params: unknown[]) => Number((await deps.pool.query(sql, params))?.[0]?.p ?? 0) || 0;
  // seuils : popularité du 150e jeu de la fenêtre, sortis et à venir (mêmes statuts que le site)
  res.seuilSortis = Math.max(
    cfg.seuilMin,
    await seuil(
      "SELECT popularity AS p FROM game_items WHERE release_precision = 'day' AND release_date BETWEEN ? AND ? AND cover IS NOT NULL AND cover <> '' " +
        "ORDER BY popularity DESC LIMIT 1 OFFSET ?",
      [f.debut, aujourdhui, cfg.rang - 1]
    )
  );
  res.seuilAVenir = Math.max(
    cfg.seuilMin,
    await seuil(
      "SELECT popularity AS p FROM game_items WHERE ((release_precision = 'day' AND release_date > ? AND release_date <= ?) " +
        "OR (IFNULL(release_precision, '') <> 'day' AND release_date BETWEEN ? AND ?)) AND cover IS NOT NULL AND cover <> '' ORDER BY popularity DESC LIMIT 1 OFFSET ?",
      [aujourdhui, f.fin, f.debut, f.fin, cfg.rang - 1]
    )
  );
  const connus = new Set<number>(((await deps.pool.query("SELECT igdb_id FROM game_items WHERE igdb_id IS NOT NULL AND igdb_id > 0")) as any[]).map((x) => Number(x.igdb_id)));
  // un jeu dont la somme des trois listes passe le seuil a au moins une liste au tiers du seuil
  const plancherPart = Math.min(res.seuilSortis, res.seuilAVenir) / 3 / cfg.echelle;
  const candidats = new Set<number>();
  try {
    for (const type of TYPES_LISTES) {
      for (let page = 0; page < cfg.pagesMax; page++) {
        const lot = await requete(deps, cfg, "popularity_primitives", `fields game_id, value; where popularity_type = ${type}; sort value desc; limit 500; offset ${page * 500};`);
        res.lus += lot.length;
        for (const p of lot) if (Number(p?.value) >= plancherPart && !connus.has(Number(p?.game_id))) candidats.add(Number(p.game_id));
        if (lot.length < 500 || Number(lot[lot.length - 1]?.value) < plancherPart) break;
      }
    }
    const ids = [...candidats].filter((x) => x > 0);
    // une date dans la fenêtre ; première sortie au plus 3 ans avant (accès anticipé puis 1.0) : la règle fine est dateDecouverte
    const filtre =
      ` & game_type = ${TYPES_JEU} & version_parent = null & release_dates.date >= ${f.debutTs} & release_dates.date <= ${f.finTs}` +
      ` & (first_release_date = null | first_release_date >= ${f.debutTs - 3 * 366 * 86400})`;
    let fiches: Map<number, any>;
    try {
      fiches = await lireFiches(deps, cfg, ids, CHAMPS_DECOUVERTE + CHAMPS_DATES, filtre);
    } catch (e) {
      // statut et région refusés par IGDB : sans eux, aucun accès anticipé n'est reconnu (règle plus stricte)
      if (!/HTTP 400/.test(message(e))) throw e;
      res.champsComplets = false;
      fiches = await lireFiches(deps, cfg, ids, CHAMPS_DECOUVERTE, filtre);
    }
    res.candidats = fiches.size;
    res.avecStatut = [...fiches.values()].filter((g) => Array.isArray(g.release_dates) && g.release_dates.some((r: any) => r?.status?.name)).length;
    const parts = await lireListes(deps, cfg, [...fiches.keys()]);
    const planchers = await lirePlanchers(deps.pool);
    const retenus: Array<{ g: any; item: ItemDecouvert; source: number; statut: "sorti" | "a venir" }> = [];
    for (const g of fiches.values()) {
      if (Array.isArray(g.themes) && g.themes.map(Number).includes(THEME_EROTIQUE)) {
        res.ecartes.erotique++;
        continue;
      }
      const dt = sansFauxJour(dateDecouverte(g.release_dates, f, res.champsComplets), aujourdhui);
      if (!dt) {
        res.ecartes.horsFenetre++;
        continue;
      }
      const statut = statutSite(dt.date, dt.precision, aujourdhui);
      // un jeu à venir : « je veux y jouer » seul ; un jeu sorti : les trois listes (comme le passage)
      const source = Math.round(partListes(parts.get(Number(g.id)), statut) * cfg.echelle);
      if (source < (statut === "sorti" ? res.seuilSortis : res.seuilAVenir)) {
        res.ecartes.sousSeuil++;
        continue;
      }
      const imageId = g?.cover?.image_id;
      if (!imageId || !/^[A-Za-z0-9_-]+$/.test(String(imageId))) {
        res.ecartes.sansJaquette++;
        continue;
      }
      const noms = (x: any[]) => (Array.isArray(x) ? x.map((y) => y?.name).filter(Boolean) : []);
      const votes = Number(g.total_rating_count) || 0;
      const titre = String(g.name).slice(0, 500);
      retenus.push({
        g,
        source,
        statut,
        item: {
          title: titre,
          cover: urlJaquetteIgdb(String(imageId)),
          platform: noms(g.platforms).join(", ") || null,
          genre: noms(g.genres).slice(0, 3).join(", ") || null,
          releaseDate: dt.date,
          releasePrecision: dt.precision,
          description: String(g.summary || g.storyline || "").slice(0, 2000) || null,
          igdbId: Number(g.id),
          trailerUrl: choisirBandeAnnonce(g.videos),
          popularity: Math.max(source, plancher(titre, planchers)),
          ratingScore: votes >= cfg.votesMin && Number.isFinite(Number(g.total_rating)) ? Math.max(0, Math.min(100, Math.round(Number(g.total_rating)))) : null,
        },
      });
    }
    retenus.sort((a, b) => b.item.popularity - a.item.popularity);
    // les jeux de la base pas encore rattachés : un candidat qui leur ressemble n'est pas ajouté (doublon)
    const sansIgdb: SansIgdb[] = (
      (await deps.pool.query(
        "SELECT id, title, title_english, DATE_FORMAT(release_date, '%Y-%m-%d') AS date, release_precision AS prec FROM game_items " +
          "WHERE (igdb_id IS NULL OR igdb_id = 0) AND title IS NOT NULL AND title <> ''"
      )) as any[]
    ).map((x) => ({ id: Number(x.id), titre: String(x.title), mots: [motsTitre(x.title), motsTitre(x.title_english)].filter((m) => m.length), date: x.date ?? null, prec: x.prec ?? null }));
    const choisis: typeof retenus = [];
    const titresChoisis = new Map<string, string>();
    let i = 0;
    for (; i < retenus.length && choisis.length < cfg.maxAjouts; i++) {
      const x = retenus[i];
      const cle = normalizeTitle(x.item.title);
      if (titresChoisis.has(cle)) {
        res.signales.push({ titre: x.item.title, raison: "homonyme", autre: { id: 0, titre: String(titresChoisis.get(cle)) } });
        continue;
      }
      const c = await collision(deps, x.g, x.item, sansIgdb);
      if (c) {
        res.signales.push(c);
        continue;
      }
      titresChoisis.set(cle, x.item.title);
      choisis.push(x);
    }
    res.ecartes.deTrop = retenus.length - i;
    if (choisis.length) {
      if (!deps.ajouter) throw new Error("ajout de jeux indisponible");
      const r = await deps.ajouter(choisis.map((x) => x.item));
      if (!r.ok) throw new Error("ajout refusé par /games/bulk" + (r.erreur ? " (" + String(r.erreur).slice(0, 120) + ")" : ""));
      // popularité et note tout de suite (/games/bulk ne les écrit plus pour les jeux) ; un jeu que
      // /games/bulk a refusé n'a pas de ligne : il n'est pas compté
      for (const x of choisis) {
        const u: any = await deps.pool.query(
          "UPDATE game_items SET popularity_source = ?, popularity = GREATEST(?, IFNULL(popularity, 0)), rating_score = IFNULL(?, rating_score), updated_at = updated_at WHERE igdb_id = ?",
          [x.source, x.item.popularity, x.item.ratingScore, x.item.igdbId]
        );
        if (Number(u?.affectedRows ?? 0) > 0) res.ajoutes.push({ titre: x.item.title, date: x.item.releaseDate, popularite: x.item.popularity, statut: x.statut });
      }
      if (res.ajoutes.length) deps.rafraichir?.();
    }
  } catch (e) {
    res.erreur = message(e);
  }
  return res;
}

// ── Cycle

interface EtatCycle {
  enCours: boolean;
  /** Nouvel essai programmé (après un échec, ou verrou pris par un autre passage). */
  relance: ReturnType<typeof setTimeout> | null;
  /** Les doublons (passage) ou jeux à vérifier (découverte) déjà signalés : le fil d'activité ne les répète pas. */
  signales?: string;
  /** Les rattachements douteux déjà signalés (passage). */
  douteux?: string;
}

/**
 * Un tour du passage. Rend au planificateur (pilotage.ts) le délai du nouvel essai : 1 h après un échec, 10 min si le
 * verrou est pris par un autre passage (rien n'est alors noté).
 */
async function tourPassage(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, etat: EtatCycle): Promise<RetourPassage | void> {
  if (etat.enCours) return;
  etat.enCours = true;
  let reessai: number | null = null;
  const debut = Date.now();
  try {
    const p = await passageJeux(deps, cfg);
    if (p.occupe) {
      deps.log.info({ module: "igdb-jeux" }, "jeux IGDB : un autre passage tient le verrou (nouvel essai dans 10 min)");
      return { bilan: { occupe: true }, reessayerDansMs: APRES_OCCUPE_MS };
    }
    trackLastRun(
      "igdb-jeux",
      {
        ...p,
        douteux: p.douteux.length,
        absents: p.absents.length,
        dates: p.dates.length,
        fusions: p.fusions.map((x) => `${x.perdant.titre} (#${x.perdant.id}) -> ${x.gagnant.titre} (#${x.gagnant.id})`).slice(0, 20),
        relies: p.relies.length,
        liens: { lies: p.liens.lies.length, doublons: p.liens.doublons.length, fusions: p.liens.fusions.length, transferts: p.liens.transferts.length, introuvables: p.liens.introuvables.length, ambigus: p.liens.ambigus.length },
      },
      Date.now() - debut
    );
    if (p.erreur) {
      deps.log.warn({ module: "igdb-jeux", erreur: p.erreur }, "jeux IGDB : passage interrompu (nouvel essai dans 1 h)");
      reessai = APRES_ECHEC_MS;
    } else {
      deps.log.info(
        {
          module: "igdb-jeux", jeux: p.jeux, avecListes: p.avecListes, popularites: p.popularites, notes: p.notes, jaquettes: p.jaquettes, lies: p.liens.lies.length,
          fusions: p.fusions.length, dates: p.dates.length, relies: p.relies.length, absents: p.absents.length,
        },
        "jeux IGDB : passage terminé"
      );
    }
    const doublons = p.liens.doublons.map((x) => `${x.id}=${x.autre.id}`).sort().join(",");
    const nouveauxDoublons = doublons !== "" && doublons !== etat.signales;
    etat.signales = doublons;
    // rattachements douteux (date non remise à jour) : signalés au fil d'activité quand la liste change
    const douteux = p.douteux.map((x) => `${x.id}:${x.raison}`).sort().join(",");
    if (!p.erreur && douteux !== "" && douteux !== etat.douteux) {
      pushActivity({
        type: "igdb",
        message: `Jeux IGDB : ${p.douteux.length} rattachement${p.douteux.length > 1 ? "s" : ""} à vérifier (date non remise à jour)`,
        detail: p.douteux.slice(0, 5).map((x) => `${x.titre} (${x.raison}${x.nom ? " : " + x.nom : ""})`).join(", "),
        level: "warn",
      });
    }
    if (!p.erreur) etat.douteux = douteux;
    if (p.erreur || p.liens.lies.length || nouveauxDoublons || p.jaquettes || p.fusions.length || p.relies.length || p.liens.transferts.length) {
      pushActivity({
        type: "igdb",
        message: p.erreur ? "Jeux IGDB : passage interrompu" : `Jeux IGDB : ${p.popularites} popularités, ${p.notes} notes, ${p.dates.length} dates`,
        detail: p.erreur
          ? p.erreur
          : `${p.liens.lies.length} rattachés, ${p.fusions.length} doublon${p.fusions.length > 1 ? "s" : ""} fusionné${p.fusions.length > 1 ? "s" : ""}` +
            `${p.fusions.length ? " (" + p.fusions.slice(0, 3).map((x) => x.perdant.titre + " → " + x.gagnant.titre).join(", ") + ")" : ""}` +
            `, ${p.liens.doublons.length} doublons à vérifier, ${p.relies.length} rattachements corrigés` +
            `${p.liens.transferts.length ? ", identifiant déplacé : " + p.liens.transferts.slice(0, 3).map((x) => x.de.titre + " → " + x.vers.titre).join(", ") : ""}, ${p.jaquettes} jaquettes`,
        level: p.erreur || nouveauxDoublons ? "warn" : "info",
      });
    }
  } catch (e) {
    deps.log.error({ module: "igdb-jeux", err: message(e) }, "jeux IGDB : erreur (nouvel essai dans 1 h)");
    trackLastRun("igdb-jeux", { erreur: message(e) }, Date.now() - debut);
    reessai = APRES_ECHEC_MS;
  } finally {
    etat.enCours = false;
  }
  return reessai ? { reessayerDansMs: reessai } : undefined;
}

async function tourDecouverte(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig, etat: EtatCycle): Promise<RetourPassage | void> {
  if (etat.enCours) return;
  etat.enCours = true;
  let reessai: number | null = null;
  const debut = Date.now();
  try {
    const dcv = await decouverteJeux(deps, cfg);
    if (dcv.occupe) {
      deps.log.info({ module: "igdb-jeux" }, "jeux IGDB : un autre passage tient le verrou, découverte dans 10 min");
      return { bilan: { occupe: true }, reessayerDansMs: APRES_OCCUPE_MS };
    }
    trackLastRun("igdb-decouverte", { ...dcv, signales: dcv.signales.slice(0, 20) }, Date.now() - debut);
    const resume = { module: "igdb-jeux", seuilSortis: dcv.seuilSortis, seuilAVenir: dcv.seuilAVenir, candidats: dcv.candidats, ajoutes: dcv.ajoutes.length, signales: dcv.signales.length, ecartes: dcv.ecartes };
    if (dcv.erreur) {
      deps.log.warn({ ...resume, erreur: dcv.erreur }, "jeux IGDB : découverte interrompue (nouvel essai dans 1 h)");
      reessai = APRES_ECHEC_MS;
    } else {
      deps.log.info(resume, "jeux IGDB : découverte terminée");
    }
    if (dcv.ajoutes.length || dcv.erreur) {
      pushActivity({
        type: "igdb",
        message: dcv.erreur ? "Jeux IGDB : découverte interrompue" : `Jeux IGDB : ${dcv.ajoutes.length} jeu${dcv.ajoutes.length > 1 ? "x" : ""} ajouté${dcv.ajoutes.length > 1 ? "s" : ""}`,
        detail: dcv.erreur ? dcv.erreur : dcv.ajoutes.slice(0, 5).map((x) => x.titre).join(", "),
        level: dcv.erreur ? "warn" : "info",
      });
    }
    // jeux populaires pas ajoutés (homonyme, doublon possible) : signalés quand la liste change
    const signales = dcv.signales.map((x) => `${x.titre}>${x.autre.id}`).sort().join(",");
    if (!dcv.erreur && signales !== "" && signales !== etat.signales) {
      pushActivity({
        type: "igdb",
        message: `Jeux IGDB : ${dcv.signales.length} jeu${dcv.signales.length > 1 ? "x" : ""} à vérifier (pas ajouté${dcv.signales.length > 1 ? "s" : ""})`,
        detail: dcv.signales.slice(0, 5).map((x) => `${x.titre} (${x.raison} : ${x.autre.titre})`).join(", "),
        level: "warn",
      });
    }
    if (!dcv.erreur) etat.signales = signales;
  } catch (e) {
    deps.log.error({ module: "igdb-jeux", err: message(e) }, "jeux IGDB : erreur de découverte (nouvel essai dans 1 h)");
    trackLastRun("igdb-decouverte", { erreur: message(e) }, Date.now() - debut);
    reessai = APRES_ECHEC_MS;
  } finally {
    etat.enCours = false;
  }
  return reessai ? { reessayerDansMs: reessai } : undefined;
}

/** Le rattachement seul, sous le verrou (bouton « Appariement orphelins » du tableau de bord). */
export async function lierJeuxVerrouille(deps: IgdbJeuxDeps, cfg: IgdbJeuxConfig = configIgdbJeux()): Promise<BilanLiens & { occupe?: boolean }> {
  const liberer = await prendreVerrou(deps.pool);
  if (!liberer) return { cherches: 0, lies: [], ambigus: [], introuvables: [], doublons: [], fusions: [], transferts: [], occupe: true };
  try {
    const r = await lierJeux(deps, cfg);
    if (r.lies.length || r.fusions.length || r.transferts.length) deps.rafraichir?.();
    return r;
  } finally {
    await liberer();
  }
}

/**
 * Démarrage : passage 20 min après le démarrage puis toutes les 3 h ; découverte à 50 min puis chaque jour.
 * Chacun a son état : un échec programme un nouvel essai 1 h plus tard, un verrou pris 10 min plus tard.
 */
export function startIgdbJeuxCron(deps: IgdbJeuxDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts, 17 octobre 2026) : IGDB_JEUX_ENABLED ne sert plus qu'à la première mise en route. Coupé au
  // Pilotage, le passage s'arrête, la découverte et Steam aussi (ils en dépendent), et les envois de n8n reprennent la
  // main sur la popularité des jeux (igdbJeuxActif, relu à chaque /games/bulk).
  const cfg = configIgdbJeux(env);
  const actifParDefaut = env["IGDB_JEUX_ENABLED"] !== "0";
  deps.log.info({ module: "igdb-jeux", actifParDefaut }, "jeux IGDB : planifié (listes et notes toutes les 3 h, découverte chaque jour)");
  const passage: EtatCycle = { enCours: false, relance: null };
  const decouverte: EtatCycle = { enCours: false, relance: null };
  planifier({
    id: "igdb-jeux", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "igdb-jeux", actifParDefaut,
    passage: () => tourPassage(deps, cfg, passage),
  });
  planifier({
    id: "igdb-decouverte", premierMs: PREMIERE_DECOUVERTE_MS, rythmeMs: DECOUVERTE_MS, suivi: "igdb-decouverte", actifParDefaut, dependDe: "igdb-jeux",
    passage: () => tourDecouverte(deps, cfg, decouverte),
  });
  // Steam (dates PC et plateforme PC) : son propre cycle (steam-jeux.ts), arrêté avec celui-ci
  startSteamJeuxCron({ pool: deps.pool, log: deps.log, rafraichir: deps.rafraichir }, env);
}
