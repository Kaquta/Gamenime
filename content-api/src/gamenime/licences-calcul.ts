/**
 * licences-calcul.ts — Les règles du module des licences (licences.ts) : la licence de chaque fiche du site, et le passé
 * de chaque licence (les repères).
 *
 * Reprise du relevé v3.1 (releve-licences.sh, 22 octobre 2026 : règles mesurées sur le serveur et relues deux fois),
 * avec les décisions de Rey du 21 et du 22 octobre et les corrections du plan (licences-module-plan.md, § 1 à 3) :
 *  - nom de la licence en anglais ; pont par le titre : le nom de la licence suivi de deux-points (« One Piece: »),
 *    un titre égal au nom seulement pour un nom de franchise ;
 *  - le passé sans limite d'années : les sorties d'avant l'année en cours deviennent des repères (titre, type, année ;
 *    pas de fiche, pas de lien ; jamais dans les Tops, le calendrier ni les alertes) ;
 *  - repères gardés au seuil bas (5 000 membres AniList, 5 notes IGDB), ou lien direct d'une fiche ;
 *  - le bloc : 4 repères ; 2 animés et 2 jeux quand il y a des deux ; seuil moyen (20 000 / 20) pour le type de la
 *    fiche, seuil bas pour l'autre ; les œuvres principales d'abord, les liens directs en tête (2 au plus) ;
 *  - ponts par le nom vers les catalogues appliqués, avec garde-fous (nom de 2 mots ou de 8 lettres au moins).
 * Corrections apprises du relevé v3.1 :
 *  1. un animé d'une autre œuvre d'origine entre s'il est atteint par un lien fort (suite, prélude, œuvre mère, dérivé,
 *     version alternative) depuis un animé du radar de la licence ou un animé d'une de ses œuvres d'origine (pas depuis un
 *     spécial sans œuvre d'origine, comme un croisement), et son œuvre d'origine devient une clé de la licence ; après une
 *     « histoire parallèle » (side story), le parcours continue (les films chaînés entre eux), mais plus aucun animé
 *     d'une autre œuvre d'origine n'entre par là ; un animé que Wikidata range dans une autre franchise n'entre jamais
 *     (deux franchises différentes ne sont jamais réunies) ;
 *  2. deux licences du radar qui partagent une franchise Wikidata (celle de leurs fiches, ou celle d'au moins deux animés
 *     de leur passé) sont réunies ; reliées par leur passé sans franchise commune, elles restent séparées ;
 *  3. le pont par le nom vers IGDB est tenté pour toute licence sans franchise ni collection IGDB ;
 *  4. l'ordre du bloc (plus haut) ;
 *  5. profondeur AniList 8 (2 500 animés au plus ; essai à blanc du 22 octobre : à 6, 32 animés restaient non lus) ;
 *  6. un animé entré par le titre de la licence (hors titre de croisement) sert de pont, comme un animé de même origine ;
 *  7. l'origine d'un animé : sa source du même type que son origine (le manga pour un manga), la plus populaire ;
 *  8. le nom d'une licence sans franchise : l'œuvre d'origine de son œuvre la plus populaire, animé du radar ou de son
 *     passé (sans œuvre d'origine, le titre de cet animé ; pour une fiche du radar, son titre sur le site) (Rey, 22
 *     octobre) ; règles 4 : le titre n'est coupé aux deux-points que devant un vrai nom, un nom fort (2 mots ou 8
 *     lettres : « Tougen Anki ») ou un nom que porte aussi le titre japonais (« Frieren », de « Sousou no Frieren ») ;
 *     sinon il reste entier (« Mission: Yozakura Family » : « Mission » n'est pas dans « Yozakura-san Chi no
 *     Daisakusen ») ; « The Movie » retiré (« Mononoke ») ; règles 5 (Rey, 23 octobre) : le nom doit être un mot à lui
 *     seul du titre japonais, tel qu'il est écrit (« Sakuna: Of Rice and Ruin » reste entier : « Tensui no Sakuna-hime »
 *     ne porte pas « Sakuna » seul) ;
 *  9. deux licences reliées par leur passé dont les franchises Wikidata sont rangées dans une même franchise (Love Live!)
 *     sont réunies, sous le nom de celle-ci (Rey, 22 octobre) ; ici, la franchise d'une licence qui n'en a pas est celle
 *     des animés de son passé (« Love Live! Nijigasaki… » : celle de sa première saison) ;
 * 10. le pont par le nom vers une franchise ou une collection IGDB ajoute aussi le jeu qui porte le nom même de celle-ci
 *     (IGDB ne range pas « Ghost of Tsushima » dans la franchise « Ghost of Tsushima ») ;
 * 11. règles 6 (Rey, 23 octobre) : deux noms à égalité (même rang, autant de fiches) : celui qui se lit dans les titres
 *     des fiches de la licence l'emporte, avant l'ordre alphabétique (« Vampire Survivors », pas « Survivaton » : le
 *     premier Vampire Survivors est rangé par Wikidata dans les deux séries, et Vampire Crawlers est « d'après » lui) ;
 *     un nom d'un seul mot ne se lit qu'en tête du titre (« Warriors » ne passe pas devant « The Legend of Zelda » pour
 *     Hyrule Warriors).
 * 12. règles 7 (Rey, 2 novembre) : pour un animé, la « série » Wikidata (P179) ne sert plus, ni comme clé ni pour le
 *     passé : Wikidata y range aussi des cases de diffusion (Firefly Wedding et High School! Kimengumi, deux mangas
 *     sans rapport, étaient réunis par la case Noitamina de Fuji TV, et Tsuritama entrait dans leur passé). Les jeux
 *     gardent leurs séries. Contrôle à chaque passage : deux groupes d'animés d'œuvres d'origine différentes (mangas
 *     AniList) ne sont réunis par une clé ou une franchise commune que si son nom se lit dans les titres de l'un d'eux ou
 *     d'une fiche qui porte la clé ; sinon la réunion est refusée et notée, et ce nom ne nomme pas une licence dont les
 *     titres ne le portent pas.
 * Les fiches à plusieurs franchises restent seules (la règle des parapluies, mesurée, est abandonnée : Rey, 22 octobre).
 * Ici, aucun accès à la base : les fiches arrivent du module, et le résultat lui est rendu.
 */
import { AniList, Igdb, Incomplet, PanneSource, RefusRequete, Wikidata } from "./licences-sources.js";

// ─────────────────────────────────────────────────────────────── textes

const REMPL: Array<[number, string]> = [[0x153, "oe"], [0x152, "OE"], [0xe6, "ae"], [0xc6, "AE"], [0xdf, "ss"], [0xd7, "x"], [0x2013, "-"], [0x2014, "-"], [0x2018, "'"], [0x2019, "'"], [0x201c, '"'], [0x201d, '"'], [0x2026, "..."], [0xbd, "1/2"], [0x2606, "*"], [0x2605, "*"], [0xb7, "-"], [0xa0, " "]];
/** Texte ASCII seul (accents retirés, autres signes remplacés ou enlevés). */
export function asc(s: unknown): string {
  let t = String(s ?? "");
  for (const [a, b] of REMPL) t = t.split(String.fromCharCode(a)).join(b);
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return t.replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}
/** Une ligne de rapport en ASCII, son retrait gardé. */
export function ascLigne(s: unknown): string {
  const t = String(s ?? "");
  return (t.match(/^ */) as RegExpMatchArray)[0] + asc(t);
}
/** Nom normalisé pour comparer deux noms de licence. */
export function norm(s: unknown): string {
  return asc(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}
/** Le nom d'avant les deux-points (« One Piece: Grand Gourmet » -> « one piece »), normalisé ; null sans deux-points. */
export function avantDeuxPoints(titre: unknown): string | null {
  const t = String(titre ?? ""), k = t.indexOf(":");
  return k > 0 ? norm(t.slice(0, k)) || null : null;
}
/** Un titre correspond à un nom : égal au nom, ou le nom suivi de deux-points. */
export function titreDuNom(titre: unknown, n: string): boolean {
  if (!titre || !n) return false;
  return norm(titre) === n || avantDeuxPoints(titre) === n;
}
/** Noms courts IGDB possibles d'un nom (« JoJo's Bizarre Adventure » -> jojos-bizarre-adventure…). */
export function slugsDe(nom: string): string[] {
  const a = asc(nom).toLowerCase(), v = new Set<string>();
  const s = (x: string) => x.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  v.add(s(a.replace(/'/g, "").replace(/&/g, " ")));
  v.add(s(a.replace(/'/g, "").replace(/&/g, " and ")));
  v.add(s(a.replace(/&/g, " ")));
  v.add(s(a.replace(/'/g, "").replace(/&/g, " ").replace(/\band\b/g, " ")));
  v.add(s(a.replace(/ s\b/g, "s")));
  return [...v].filter((x) => x.length >= 3);
}
/** Réduit des noms de franchise : deux noms égaux, ou dont l'un commence l'autre (mot entier), n'en font qu'un. */
export function reduire(noms: Iterable<string>): string[] {
  const l = [...new Set([...noms].filter(Boolean))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const gardes: string[] = [];
  for (const n of l) if (!gardes.some((g) => n === g || n.startsWith(g + " "))) gardes.push(n);
  return gardes;
}
/** Deux ensembles de noms de franchise compatibles : l'un vide, ou un nom commun (ou qui commence l'autre). */
export function compatibles(a: string[], b: string[]): boolean {
  return !a.length || !b.length || a.some((x) => b.some((y) => x === y || x.startsWith(y + " ") || y.startsWith(x + " ")));
}
/** Garde-fou des ponts par le nom (Rey, 22 octobre) : un nom de 2 mots, ou de 8 lettres au moins. */
export function nomAssezFort(n: string): boolean {
  const mots = n.split(" ").filter(Boolean);
  return mots.length >= 2 || n.replace(/[^a-z]/g, "").length >= 8;
}
/** L'adresse d'une licence (« One Piece » -> one-piece). */
export function slugLicence(nom: string): string {
  const s = asc(nom).toLowerCase().replace(/['`]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 80).replace(/-+$/, "") || "licence";
}
/** Le titre (normalisé) porte le nom (normalisé) en mots entiers. */
const porteNom = (titre: string, nom: string): boolean => !!nom && (" " + titre + " ").includes(" " + nom + " ");
/** Le titre japonais (romaji) porte le nom (normalisé) comme un mot à lui seul, tel qu'il est écrit : « Sousou no
 *  Frieren » porte « frieren », « Tensui no Sakuna-hime » ne porte pas « sakuna » (Rey, 23 octobre : « Sakuna: Of Rice
 *  and Ruin »). Un nom de plusieurs mots : en mots entiers, comme porteNom. */
const motDuTitreVo = (vo: string, nom: string): boolean => {
  if (!nom) return false;
  if (nom.includes(" ")) return porteNom(norm(vo), nom);
  return asc(vo).toLowerCase().split(/[\s~/:;,!?()[\]{}"]+/).some((m) => m.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") === nom);
};

// ─────────────────────────────────────────────────────────────── règles

/** Version des règles : le garde-fou contre une baisse anormale ne joue pas au premier passage d'une nouvelle version. */
export const VERSION_REGLES = "7";
/** Seuils de popularité des repères : membres AniList pour un animé, notes IGDB pour un jeu. */
export const SEUILS = { bas: { al: 5000, ig: 5 }, moyen: { al: 20000, ig: 20 } } as const;
/** Repères montrés par le bloc d'une fiche. */
export const REPERES_BLOC = 4;

const SANS_LIEN = new Set(["CHARACTER", "OTHER"]);
/** Liens forts : un animé d'une autre œuvre d'origine entre par eux (suite, prélude, œuvre mère, dérivé, autre version). */
const FORTS = new Set(["PREQUEL", "SEQUEL", "PARENT", "SPIN_OFF", "ALTERNATIVE"]);
/** Après une histoire parallèle, plus aucun lien fort : un croisement « X vs Y » ne fait entrer aucun animé de X ou de Y. */
const FEUILLE = "SIDE_STORY";
/** Relations de résumé ou de compilation : des deux animés, le plus tardif est le résumé ou la compilation (pas une œuvre
 * principale du bloc). */
const COMPILS = new Set(["SUMMARY", "COMPILATION", "CONTAINS"]);
/** Lien direct d'un animé du radar : sa saison précédente, son œuvre mère, son autre version. */
const DIRECTS = new Set(["PREQUEL", "PARENT", "ALTERNATIVE"]);
const STATUTS_SORTIS = new Set(["FINISHED", "RELEASING", "HIATUS"]);
const FORMATS_REPERE = new Set(["TV", "TV_SHORT", "MOVIE", "ONA", "OVA", "SPECIAL"]);
/** Œuvres principales : série, film, ONA ; jeu principal, remake, extension autonome. */
const FORMATS_PRINCIPAUX = new Set(["TV", "MOVIE", "ONA"]);
const TYPES_JEU = /^(main game|remake|remaster|expanded game|standalone expansion)$/i;
const TYPES_JEU_IDS = [0, 4, 8, 9, 10];
const NOMS_TYPES_ANCIENS: Record<number, string> = { 0: "main game", 4: "standalone expansion", 8: "remake", 9: "remaster", 10: "expanded game" };
const STATUTS_ECARTES = /cancel|rumou?r/i;
const STATUTS_ECARTES_IDS = [6, 7];
/** Origines qu'une fiche de jeu peut reprendre de sa licence (un manga, un roman…, pas un jeu ni une œuvre originale). */
const ORIGINES_LIVRES = new Set(["MANGA", "LIGHT_NOVEL", "NOVEL", "WEB_NOVEL", "VISUAL_NOVEL", "DOUJINSHI", "COMIC", "PICTURE_BOOK"]);
const ORIGINES_SANS = new Set(["ORIGINAL", "OTHER", "ANIME", "MULTIMEDIA_PROJECT"]);
/** Ordre des liens : les franchises d'abord, puis séries et origines, puis les liens faibles. */
const FORCE: Record<string, number> = { "wd-franchise": 0, "igdb-franchise": 0, "wd-fiche": 1, "wd-serie": 1, "wd-origine": 1, "anilist-origine": 1, "igdb-parent": 1, "anilist-relation": 2, "igdb-collection": 2, "wd-serie-igdb": 2 };
/** Force d'une revendication sur une œuvre du passé : la plus forte l'emporte ; à égalité entre licences, à aucune. */
const FORCE_SOURCE: Record<string, number> = { "igdb-remake": 0, "igdb-base": 0, anilist: 1, "igdb-franchise": 1, wd: 2, "igdb-collection": 3, "nom-igdb": 4, "nom-anilist": 4 };

// ─────────────────────────────────────────────────────────────── types

export type Dom = "anime" | "game";

/** Une fiche du site (page ou liste), telle que le module la lit. */
export interface FicheSite {
  dom: Dom;
  id: number;
  /** La fiche a une adresse (slug) : une page, donc un lien. */
  page: boolean;
  /** Titre anglais d'abord, comme le site. */
  titre: string | null;
  titreVo: string | null;
  format: string | null;
  date: string | null;
  prec: string | null;
  pop: number;
  anilist: number | null;
  malBase: number | null;
  igdb: number | null;
}

export interface Origine {
  /** Type d'œuvre d'origine selon AniList (MANGA, LIGHT_NOVEL, VIDEO_GAME…). */
  type: string;
  titre: string | null;
  auteurs: string[];
}

export interface RepereCalcule {
  source: "anilist" | "igdb";
  id: number;
  dom: Dom;
  titre: string;
  /** Format AniList (TV, MOVIE…) ou type IGDB (main game, remake…). */
  format: string | null;
  annee: number;
  pop: number;
  principal: boolean;
  /** D'où vient le repère : anilist, igdb-franchise, wd, nom-igdb… */
  par: string;
}

export interface DirectCalcule {
  dom: Dom;
  id: number;
  source: "anilist" | "igdb";
  sourceId: number;
  /** PREQUEL, PARENT, ALTERNATIVE (animés) ; ORIGINAL (d'un remake ou d'un remaster), BASE (jeu de base). */
  nature: string;
}

export interface MembreCalcule {
  dom: Dom;
  id: number;
  /** Le lien qui a mis la fiche dans la licence (franchise Wikidata, relation AniList, titre, nom…), « seule » sinon. */
  par: string;
  origine: Origine | null;
}

export interface LicenceCalculee {
  /** Repère interne du calcul (pas l'identifiant en base). */
  cle: string;
  nom: string;
  membres: MembreCalcule[];
  reperes: RepereCalcule[];
  directs: DirectCalcule[];
  /** Clés d'identité : de quoi retrouver la licence d'un passage à l'autre. */
  cles: string[];
  origine: Origine | null;
  /** Popularité de la fiche la plus populaire du radar. */
  pop: number;
  /** Une fiche seule à plusieurs franchises (croisement, parapluie). */
  multi: boolean;
  /** Le nom de la règle d'avant, quand le nom vient de l'œuvre principale : repris si une licence en base, que rien ne
   *  reprend (en sommeil, fusionnée), porte déjà ce nom (licences.ts, rapprocher). */
  nomRepli?: string;
}

export interface Diagnostic {
  /** Animés du passé écartés : autre œuvre d'origine, franchise Wikidata différente. */
  exclus: Array<{ id: number; titre: string; an: number | null; pop: number; licence: string; raison: string }>;
  /** Animés d'une autre œuvre d'origine entrés par un lien fort. */
  forts: Array<{ id: number; titre: string; an: number | null; pop: number; licence: string; lien: string }>;
  /** Animés à égale distance de deux licences, sans œuvre d'origine commune : à aucune. */
  egaux: Array<{ id: number; titre: string; an: number | null; licences: string[] }>;
  /** Œuvres revendiquées à égalité par plusieurs licences : à aucune. */
  partages: Array<{ dom: Dom; id: number; titre: string; licences: string[] }>;
  /** Licences du radar reliées par leur passé, sans franchise commune : laissées séparées. */
  reliees: Array<{ a: string; b: string; via: string }>;
  /** Licences du radar réunies par une franchise Wikidata commune, ou par la franchise qui range les leurs. */
  reunies: Array<{ noms: string[]; franchise: string }>;
  /** Licences sans franchise nommées par leur œuvre principale : le nom que la règle d'avant donnait, le nouveau. */
  nomsPrincipaux: Array<{ avant: string; nom: string; pop: number; sorties: number }>;
  /** Jeux croisés (trois franchises ou plus) écartés. */
  croises: Array<{ id: number; titre: string; an: number | null; licence: string }>;
  /** Fiches à plusieurs franchises, laissées seules. */
  multi: Array<{ dom: Dom; id: number; titre: string; franchises: string[] }>;
  pontsTitre: Array<{ dom: Dom; id: number; titre: string; licence: string }>;
  pontsNom: string[];
  pontsCatalogue: Array<{ licence: string; sens: "igdb" | "anilist"; nom: string; ajoutes: number; ambigu?: boolean }>;
  ambigusTitre: Array<{ dom: Dom; id: number; titre: string; nom: string }>;
  /** Réunions refusées qui tiennent ; origine : par le contrôle des œuvres d'origine (règles 7), son id étant la clé et
   *  les œuvres d'origine des deux licences (« wd:Q1|101|202 ») ; les autres : la paire de fiches (« anime:12|anime:40 »). */
  refuses: Array<{ lien: string; cle: string; a: string; b: string; id: string; origine: boolean; paires: string[] }>;
  /** Clés IGDB ou Wikidata portées par plusieurs licences : sans passé. */
  partageesCles: string[];
}

export interface Comptes {
  fiches: number;
  animes: number;
  jeux: number;
  anilistLus: number;
  igdbLus: number;
  noeuds: number;
  profondeur: number;
  arretParcours: string | null;
  nonLus: number;
  jeuxPasse: number;
  wdAnimes: number;
  wdJeux: number;
}

export interface Calcul {
  annee: number;
  licences: LicenceCalculee[];
  diag: Diagnostic;
  replis: string[];
  comptes: Comptes;
}

export interface Regles {
  profMax: number;
  noeudsMax: number;
  parFranchise: number;
  nomsMax: number;
}

export const REGLES_PAR_DEFAUT: Regles = { profMax: 8, noeudsMax: 2500, parFranchise: 100, nomsMax: 320 };

export interface Contexte {
  fiches: FicheSite[];
  al: AniList;
  ig: Igdb;
  wd: Wikidata;
  /** L'année en cours : les repères sont d'avant. */
  annee: number;
  regles: Regles;
  dire?: (ligne: string) => void;
}

// ─────────────────────────────────────────────────────────────── requêtes AniList

const CHAMPS_AL = "id idMal format status isAdult popularity startDate { year month day } title { romaji english }";
const REQ_RADAR =
  "query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(id_in: $ids, type: ANIME) { id idMal popularity source(version: 3) title { romaji english } " +
  "relations { edges { relationType(version: 2) node { id type format popularity title { romaji english } } } } } } }";
/** Les œuvres d'origine d'animés du passé (le nom d'une licence sans franchise : celle de son œuvre la plus populaire). */
const REQ_SOURCES =
  "query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(id_in: $ids, type: ANIME) { id idMal popularity source(version: 3) title { romaji english } " +
  "relations { edges { relationType(version: 2) node { id type format popularity title { romaji english } } } } } } }";
const REQ_AUTEURS = "query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(id_in: $ids, type: ANIME) { id staff(perPage: 8, sort: [RELEVANCE, ID]) { edges { role node { name { full } } } } } } }";
const REQ_PASSE = `query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(id_in: $ids, type: ANIME) { ${CHAMPS_AL} relations { edges { relationType(version: 2) node { id type } } } } } }`;
const REQ_PAR_ID = REQ_PASSE;
const REQ_PAR_MAL = `query ($ids: [Int], $n: Int) { Page(page: 1, perPage: $n) { media(idMal_in: $ids, type: ANIME) { ${CHAMPS_AL} relations { edges { relationType(version: 2) node { id type } } } } } }`;

// ─────────────────────────────────────────────────────────────── petits outils

const N = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const uniq = <T>(l: Iterable<T>): T[] => [...new Set(l)];
function ajouterA<K, V>(m: Map<K, Set<V>>, k: K, v: V): boolean {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set<V>()));
  const avant = s.size;
  s.add(v);
  return s.size > avant;
}
function pousser<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}
const json = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

interface LienAl {
  type: string;
  id: number;
  mtype: string;
  format: string | null;
  titre: string | null;
  romaji: string | null;
  pop: number;
}
/** Les formats AniList d'une œuvre d'origine, selon le type d'origine d'un animé. */
const FORMATS_SOURCE: Record<string, string[]> = { MANGA: ["MANGA", "ONE_SHOT"], LIGHT_NOVEL: ["NOVEL"], NOVEL: ["NOVEL"], WEB_NOVEL: ["NOVEL"] };
/**
 * L'œuvre d'origine d'un animé parmi ses sources AniList : celle du même type que son origine (le manga pour un manga),
 * la plus populaire (ONE PIECE : le manga, pas le roman « Loguetown-hen » qu'AniList donne en premier).
 */
function meilleureSource(source: string | null, rel: Array<{ type: string; mtype: string; format: string | null; pop?: number }>): number {
  const l = rel.map((e, k) => ({ e, k })).filter(({ e }) => e.type === "SOURCE" && e.mtype === "MANGA");
  if (!l.length) return -1;
  const voulus = FORMATS_SOURCE[String(source)];
  const bons = voulus ? l.filter(({ e }) => voulus.includes(String(e.format))) : [];
  return [...(bons.length ? bons : l)].sort((a, b) => (b.e.pop || 0) - (a.e.pop || 0) || a.k - b.k)[0].k;
}
interface RadarAl {
  mal: number | null;
  pop: number;
  source: string | null;
  titre: string | null;
  romaji: string | null;
  rel: LienAl[];
}
interface Noeud {
  id: number;
  mal: number | null;
  format: string | null;
  statut: string | null;
  adulte: boolean;
  pop: number;
  an: number | null;
  titre: string | null;
  romaji: string | null;
  voisins: Array<{ id: number; type: string }>;
  sources: number[];
  prof: number;
}
interface CleIg {
  id: number | null;
  slug: string;
  nom: string;
}
interface RadarIg {
  slug: string | null;
  franchises: CleIg[];
  collections: CleIg[];
  principale: CleIg | null;
  parent: number | null;
}
interface Cle {
  k: string;
  t: string;
  nom: string | null;
  nom2: string | null;
}
/** Une œuvre du passé, telle que les sources la donnent. */
interface Passe {
  dom: Dom;
  id: number;
  titre: string | null;
  an: number | null;
  pop: number;
  format: string | null;
  statut: string | null;
  adulte: boolean;
  type: number | null;
  typeOk: boolean | null;
  statutOk: boolean;
  version: boolean;
}

function lireRadarAl(x: any): RadarAl {
  const edges = Array.isArray(x?.relations?.edges) ? x.relations.edges : [];
  return {
    mal: N(x?.idMal) > 0 ? N(x.idMal) : null,
    pop: N(x?.popularity),
    source: typeof x?.source === "string" ? x.source : null,
    titre: x?.title?.english || x?.title?.romaji || null,
    romaji: x?.title?.romaji || null,
    rel: edges
      .map((e: any) => ({ type: String(e?.relationType ?? ""), id: N(e?.node?.id), mtype: String(e?.node?.type ?? ""), format: e?.node?.format || null, titre: e?.node?.title?.english || e?.node?.title?.romaji || null, romaji: e?.node?.title?.romaji || null, pop: N(e?.node?.popularity) }))
      .filter((e: LienAl) => e.id > 0),
  };
}
function noeudAl(x: any): Noeud {
  const edges = Array.isArray(x?.relations?.edges) ? x.relations.edges : [];
  return {
    id: N(x?.id), mal: N(x?.idMal) > 0 ? N(x.idMal) : null, format: x?.format || null, statut: x?.status || null,
    adulte: x?.isAdult === true, pop: N(x?.popularity), an: N(x?.startDate?.year) || null,
    titre: x?.title?.english || x?.title?.romaji || null, romaji: x?.title?.romaji || null,
    voisins: edges.filter((e: any) => e?.node?.type === "ANIME" && !SANS_LIEN.has(e?.relationType) && N(e?.node?.id) > 0).map((e: any) => ({ id: N(e.node.id), type: String(e.relationType) })),
    sources: edges.filter((e: any) => e?.relationType === "SOURCE" && e?.node?.type === "MANGA" && N(e?.node?.id) > 0).map((e: any) => N(e.node.id)),
    prof: 0,
  };
}
const passeAnime = (n: Noeud): Passe => ({ dom: "anime", id: n.id, titre: n.titre, an: n.an, pop: n.pop, format: n.format, statut: n.statut, adulte: n.adulte, type: null, typeOk: null, statutOk: true, version: false });
const listeIg = (a: unknown): CleIg[] =>
  (Array.isArray(a) ? a : []).filter((x: any) => x && x.slug).map((x: any) => ({ id: N(x.id) > 0 ? N(x.id) : null, slug: String(x.slug), nom: x.name || x.slug }));
/** Les auteurs de l'œuvre d'origine d'un animé (rôle « Original Creator » ou « Original Story »), deux au plus. */
function auteursDe(x: any): string[] {
  const edges = Array.isArray(x?.staff?.edges) ? x.staff.edges : [];
  const l: string[] = [];
  for (const e of edges) {
    const role = String(e?.role ?? "");
    const nom = String(e?.node?.name?.full ?? "").trim();
    if (nom && /^original (creator|story|work)\b/i.test(role) && !/design/i.test(role) && !l.includes(nom)) l.push(nom);
  }
  return l.slice(0, 2);
}

// ─────────────────────────────────────────────────────────────── Wikidata

const Q = (b: any): string => String(b?.value ?? "").replace(/^.*\/entity\//, "");
const estQ = (x: string): boolean => /^Q\d+$/.test(x);
const val = (b: any): string => String(b?.value ?? "");
const echap = (v: string): string => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const estSlug = (v: unknown): boolean => /^[a-z0-9][a-z0-9-]*$/.test(String(v));

/** Fiches Wikidata qui portent ces valeurs d'une propriété : valeur -> [Q]. */
async function parPropriete(wd: Wikidata, prop: string, valeurs: Array<string | number>, motif = /^[0-9]+$/): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  const liste = uniq(valeurs.map(String)).filter((v) => motif.test(v));
  for (let i = 0; i < liste.length; i += 150) {
    const paquet = liste.slice(i, i + 150);
    for (const b of await wd.sparql(`SELECT ?cle ?item WHERE { VALUES ?cle { ${paquet.map((v) => `"${echap(v)}"`).join(" ")} } ?item wdt:${prop} ?cle . }`)) {
      const k = val(b.cle), it = Q(b.item);
      if (estQ(it)) res.set(k, uniq([...(res.get(k) || []), it]));
    }
  }
  return res;
}

interface DetailWd {
  fr: string[];
  s: string[];
  sfr: string[];
  b: string[];
  bfr: string[];
  bs: string[];
}
/** Pour des fiches Wikidata : franchise (P8345), série (P179), œuvre d'origine (P144), et leurs franchises ; libellés en anglais d'abord. */
async function details(wd: Wikidata, items: string[]): Promise<{ res: Map<string, DetailWd>; libelles: Map<string, string> }> {
  const res = new Map<string, DetailWd>(), libelles = new Map<string, string>();
  const liste = uniq(items).filter(estQ);
  const ajoute = (k: string, champ: keyof DetailWd, q: string) => {
    if (!estQ(q)) return;
    const o = res.get(k);
    if (o && !o[champ].includes(q)) o[champ].push(q);
  };
  for (let i = 0; i < liste.length; i += 60) {
    const paquet = liste.slice(i, i + 60);
    for (const q of paquet) if (!res.has(q)) res.set(q, { fr: [], s: [], sfr: [], b: [], bfr: [], bs: [] });
    const req = `SELECT ?item ?itemLabel ?fr ?frLabel ?s ?sLabel ?sfr ?sfrLabel ?b ?bLabel ?bfr ?bfrLabel ?bs ?bsLabel WHERE {
  VALUES ?item { ${paquet.map((x) => "wd:" + x).join(" ")} }
  OPTIONAL { ?item wdt:P8345 ?fr . }
  OPTIONAL { ?item wdt:P179 ?s . OPTIONAL { ?s wdt:P8345 ?sfr . } }
  OPTIONAL { ?item wdt:P144 ?b . OPTIONAL { ?b wdt:P8345 ?bfr . } OPTIONAL { ?b wdt:P179 ?bs . } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr". }
}`;
    for (const b of await wd.sparql(req)) {
      const k = Q(b.item);
      if (!res.has(k)) continue;
      for (const c of ["fr", "s", "sfr", "b", "bfr", "bs"] as Array<keyof DetailWd>) {
        if (!b[c]) continue;
        ajoute(k, c, Q(b[c]));
        if (b[c + "Label"]) libelles.set(Q(b[c]), val(b[c + "Label"]));
      }
      if (b.itemLabel) libelles.set(k, val(b.itemLabel));
    }
  }
  return { res, libelles };
}

/** Fiches Wikidata d'une franchise IGDB (P11573, souvent une série de jeux) : nom court -> [Q], et libellés. */
async function seriesParIgdb(wd: Wikidata, slugs: string[]): Promise<{ res: Map<string, string[]>; libelles: Map<string, string> }> {
  const res = new Map<string, string[]>(), libelles = new Map<string, string>();
  const liste = uniq(slugs).filter(estSlug);
  for (let i = 0; i < liste.length; i += 150) {
    const paquet = liste.slice(i, i + 150);
    for (const b of await wd.sparql(`SELECT ?cle ?item ?itemLabel WHERE { VALUES ?cle { ${paquet.map((v) => `"${v}"`).join(" ")} } ?item wdt:P11573 ?cle . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr". } }`)) {
      const k = val(b.cle), it = Q(b.item);
      if (!estQ(it)) continue;
      res.set(k, uniq([...(res.get(k) || []), it]));
      if (b.itemLabel) libelles.set(it, val(b.itemLabel));
    }
  }
  return { res, libelles };
}

/** Les œuvres d'une franchise ou d'une série Wikidata (P8345, P179) qui ont un identifiant AniList, MyAnimeList ou IGDB. */
async function membresWd(wd: Wikidata, items: string[]): Promise<Map<string, Array<{ x: string; al: number | null; mal: number | null; ig: string | null; xf: string[] }>>> {
  const res = new Map<string, Array<{ x: string; al: number | null; mal: number | null; ig: string | null; xf: string[] }>>();
  const liste = uniq(items).filter(estQ);
  /** Un paquet de franchises ; un paquet qui atteint la limite de 20 000 réponses est coupé en deux. */
  const lire = async (paquet: string[]): Promise<void> => {
    const req = `SELECT ?f ?x ?al ?mal ?ig ?xf WHERE {
  VALUES ?f { ${paquet.map((x) => "wd:" + x).join(" ")} }
  { ?x wdt:P8345 ?f . } UNION { ?x wdt:P179 ?f . }
  OPTIONAL { ?x wdt:P8729 ?al . }
  OPTIONAL { ?x wdt:P4086 ?mal . }
  OPTIONAL { ?x wdt:P5794 ?ig . }
  OPTIONAL { ?x wdt:P8345 ?xf . }
  FILTER(BOUND(?al) || BOUND(?mal) || BOUND(?ig))
} LIMIT 20000`;
    const l = await wd.sparql(req);
    if (l.length >= 20000) {
      if (paquet.length === 1) throw new Incomplet("Wikidata : 20 000 œuvres pour une seule franchise, liste peut-être coupée");
      const m = Math.ceil(paquet.length / 2);
      await lire(paquet.slice(0, m));
      await lire(paquet.slice(m));
      return;
    }
    // une ligne par combinaison : les franchises d'un membre réunies, chaque membre (identifiants) une fois
    const xfDe = new Map<string, Set<string>>();
    for (const b of l) {
      const x = Q(b.x), xf = b.xf ? Q(b.xf) : "";
      if (estQ(x) && estQ(xf)) ajouterA(xfDe, x, xf);
    }
    const vus = new Set<string>();
    for (const b of l) {
      const f = Q(b.f), x = Q(b.x);
      if (!estQ(f) || !estQ(x)) continue;
      const mb = { x, al: /^[0-9]+$/.test(val(b.al)) ? Number(val(b.al)) : null, mal: /^[0-9]+$/.test(val(b.mal)) ? Number(val(b.mal)) : null, ig: estSlug(val(b.ig)) ? val(b.ig) : null, xf: [...(xfDe.get(x) || [])] };
      const k = `${f}|${x}|${mb.al}|${mb.mal}|${mb.ig}`;
      if (vus.has(k)) continue;
      vus.add(k);
      pousser(res, f, mb);
    }
  };
  for (let i = 0; i < liste.length; i += 40) await lire(liste.slice(i, i + 40));
  return res;
}

/** Les libellés de fiches Wikidata (anglais d'abord). */
async function libellesWd(wd: Wikidata, items: string[]): Promise<Map<string, string>> {
  const res = new Map<string, string>();
  const liste = uniq(items).filter(estQ);
  for (let i = 0; i < liste.length; i += 200) {
    const paquet = liste.slice(i, i + 200);
    for (const b of await wd.sparql(`SELECT ?item ?itemLabel WHERE { VALUES ?item { ${paquet.map((x) => "wd:" + x).join(" ")} } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr". } }`)) {
      const k = Q(b.item);
      if (estQ(k) && b.itemLabel) res.set(k, val(b.itemLabel));
    }
  }
  return res;
}

/** La franchise dans laquelle Wikidata range une franchise (P8345 de la franchise elle-même) : Q -> [Q], et libellés. */
async function franchisesParentes(wd: Wikidata, items: string[]): Promise<{ res: Map<string, string[]>; libelles: Map<string, string> }> {
  const res = new Map<string, string[]>(), libelles = new Map<string, string>();
  const liste = uniq(items).filter(estQ);
  for (let i = 0; i < liste.length; i += 200) {
    const paquet = liste.slice(i, i + 200);
    for (const b of await wd.sparql(`SELECT ?f ?p ?pLabel WHERE { VALUES ?f { ${paquet.map((x) => "wd:" + x).join(" ")} } ?f wdt:P8345 ?p . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr". } }`)) {
      const f = Q(b.f), p = Q(b.p);
      if (!estQ(f) || !estQ(p) || f === p) continue;
      res.set(f, uniq([...(res.get(f) || []), p]));
      if (b.pLabel) libelles.set(p, val(b.pLabel));
    }
  }
  return { res, libelles };
}

/** La franchise Wikidata (P8345) des animés AniList : identifiant AniList -> [Q], et libellés. */
async function franchisesAniList(wd: Wikidata, ids: number[]): Promise<{ res: Map<number, string[]>; libelles: Map<string, string> }> {
  const res = new Map<number, string[]>(), libelles = new Map<string, string>();
  const liste = uniq(ids.map(String)).filter((v) => /^[0-9]+$/.test(v));
  for (let i = 0; i < liste.length; i += 150) {
    const paquet = liste.slice(i, i + 150);
    for (const b of await wd.sparql(`SELECT ?al ?f ?fLabel WHERE { VALUES ?al { ${paquet.map((v) => `"${v}"`).join(" ")} } ?x wdt:P8729 ?al . ?x wdt:P8345 ?f . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr". } }`)) {
      const k = Number(val(b.al)), f = Q(b.f);
      if (!(k > 0) || !estQ(f)) continue;
      res.set(k, uniq([...(res.get(k) || []), f]));
      if (b.fLabel) libelles.set(f, val(b.fLabel));
    }
  }
  return { res, libelles };
}

// ─────────────────────────────────────────────────────────────── le calcul

export async function calculerLicences(ctx: Contexte): Promise<Calcul> {
  const { al, ig, wd, regles } = ctx;
  const AN = ctx.annee;
  const T0 = Math.floor(Date.UTC(AN, 0, 1) / 1000);
  const dire = ctx.dire ?? (() => {});
  const replis: string[] = [];
  const repli = (m: string) => {
    if (!replis.includes(m)) replis.push(m);
  };
  const diag: Diagnostic = { exclus: [], forts: [], egaux: [], partages: [], reliees: [], reunies: [], nomsPrincipaux: [], croises: [], multi: [], pontsTitre: [], pontsNom: [], pontsCatalogue: [], ambigusTitre: [], refuses: [], partageesCles: [] };
  const fiches = ctx.fiches.map((f) => ({ ...f, mal: null as number | null }));
  const comptesParcours: { profondeur: number; arret: string | null; nonLus: number } = { profondeur: 0, arret: null, nonLus: 0 };

  // ── 1. AniList répond-il ? (une suspension arrête tout de suite : sans AniList, ni passé ni liens entre animés)
  await al.sonde();

  // ── 2. les sources des fiches du radar
  const radarAl = new Map<number, RadarAl>();
  for (const x of await al.parLots(REQ_RADAR, uniq(fiches.filter((f) => f.anilist).map((f) => f.anilist as number)), 25)) radarAl.set(N(x.id), lireRadarAl(x));
  // l'identifiant MyAnimeList : celui d'AniList ; celui de la base seulement pour un animé qu'AniList ne donne pas (un
  // identifiant faux en base ne fait pas entrer une autre franchise)
  for (const f of fiches) if (f.dom === "anime") f.mal = f.anilist && radarAl.has(f.anilist) ? (radarAl.get(f.anilist) as RadarAl).mal : f.malBase || null;
  // les auteurs de la ligne d'origine : lecture à part ; un refus d'AniList (champ) ne coûte que la ligne d'origine
  const auteurs = new Map<number, string[]>();
  try {
    for (const x of await al.parLots(REQ_AUTEURS, [...radarAl.keys()], 25)) auteurs.set(N(x.id), auteursDe(x));
  } catch (e) {
    if (!(e instanceof RefusRequete)) throw e;
    repli(`AniList : auteurs refusés (${e.message}) : ligne d'origine sans auteur`);
  }
  dire(`  AniList  : ${radarAl.size} animés du radar lus (${al.n} requêtes)`);

  // IGDB : franchises, collections ; puis, à part, la franchise principale et le jeu parent
  const radarIg = new Map<number, RadarIg>();
  let secondes = true;
  const idsIg = uniq(fiches.filter((f) => f.igdb).map((f) => f.igdb as number));
  for (let i = 0; i < idsIg.length; i += 500) {
    const p = idsIg.slice(i, i + 500);
    const r = await ig.requete("games", `fields id,slug,name,franchises.name,franchises.slug,collections.name,collections.slug; where id = (${p.join(",")}); limit 500;`);
    const d = json(r.texte);
    if (r.status !== 200 || !Array.isArray(d)) throw new PanneSource(`IGDB : HTTP ${r.status}`);
    for (const g of d) {
      const id = N(g?.id);
      if (id > 0) radarIg.set(id, { slug: typeof g.slug === "string" ? g.slug : null, franchises: listeIg(g.franchises), collections: listeIg(g.collections), principale: null, parent: null });
    }
    if (!secondes) continue;
    const r2 = await ig.requete("games", `fields id,franchise.name,franchise.slug,parent_game; where id = (${p.join(",")}); limit 500;`);
    const d2 = json(r2.texte);
    if (r2.status === 400) {
      secondes = false;
      repli("IGDB : franchise principale et jeu parent refusés (HTTP 400) : lus sans");
      continue;
    }
    if (r2.status !== 200 || !Array.isArray(d2)) throw new PanneSource(`IGDB (franchise principale, jeu parent) : HTTP ${r2.status}`);
    for (const g of d2) {
      const x = radarIg.get(N(g?.id));
      if (!x) continue;
      if (g.franchise && g.franchise.slug) x.principale = { id: N(g.franchise.id) > 0 ? N(g.franchise.id) : null, slug: String(g.franchise.slug), nom: g.franchise.name || g.franchise.slug };
      if (N(g.parent_game) > 0) x.parent = N(g.parent_game);
    }
  }
  dire(`  IGDB     : ${radarIg.size} jeux du radar lus (${ig.n} requêtes)`);

  // IGDB : le champ du type de jeu (game_type ; category est l'ancien nom) et celui du statut (game_status, status)
  const igE = { mode: null as string | null, statut: null as string | null, types: new Set<number>(TYPES_JEU_IDS), statutsEcartes: new Set<number>(STATUTS_ECARTES_IDS), retires: new Set<string>(), remasters: true, slugListe: true, casse: null as string | null };
  const nomTypeJeu = new Map<number, string>();
  {
    const unId = [...radarIg.keys()][0];
    for (const [cle, champs] of [["mode", ["game_type", "category"]], ["statut", ["game_status", "status"]]] as Array<["mode" | "statut", string[]]>) {
      if (!unId) break;
      let refus = 0;
      for (const champ of champs) {
        const r = await ig.requete("games", `fields id,${champ}; where id = (${unId}); limit 1;`);
        if (r.status === 200) {
          igE[cle] = champ;
          break;
        }
        if (r.status !== 400) throw new PanneSource(`IGDB : HTTP ${r.status}`);
        refus++;
      }
      if (refus === champs.length) repli(cle === "mode" ? "IGDB : champ du type de jeu refusé (game_type, category) : DLC et éditions non repérés par leur type" : "IGDB : champ du statut refusé (game_status, status) : jeux annulés non repérés");
    }
    if (igE.mode === "game_type") {
      const r = await ig.requete("game_types", "fields id,type; limit 100;");
      const d = json(r.texte);
      if (r.status === 200 && Array.isArray(d) && d.length) {
        const ok = d.filter((t: any) => TYPES_JEU.test(String(t?.type || "").trim()));
        if (ok.length) igE.types = new Set(ok.map((t: any) => N(t.id)));
        for (const t of d) if (t && Number.isFinite(Number(t.id))) nomTypeJeu.set(N(t.id), String(t.type || ""));
      } else if (r.status === 400 || (r.status === 200 && Array.isArray(d))) repli("IGDB : liste des types de jeu refusée ou vide : numérotation ancienne");
      else throw new PanneSource(`IGDB (types de jeu) : HTTP ${r.status}`);
    }
    if (igE.statut === "game_status") {
      const r = await ig.requete("game_statuses", "fields id,status; limit 100;");
      const d = json(r.texte);
      if (r.status === 200 && Array.isArray(d) && d.length) igE.statutsEcartes = new Set(d.filter((s: any) => STATUTS_ECARTES.test(String(s?.status || ""))).map((s: any) => N(s.id)));
      else if (r.status === 400 || (r.status === 200 && Array.isArray(d))) repli("IGDB : liste des statuts refusée ou vide : numérotation ancienne");
      else throw new PanneSource(`IGDB (statuts) : HTTP ${r.status}`);
    }
  }
  const typeDe = (g: any): number | null => {
    if (!igE.mode || igE.retires.has(igE.mode)) return null;
    const v = g[igE.mode];
    if (v == null) return null;
    const n = Number(typeof v === "object" ? v.id : v);
    return Number.isFinite(n) ? n : null;
  };
  const statutDe = (g: any): number | null => {
    if (!igE.statut || igE.retires.has(igE.statut)) return null;
    const v = g[igE.statut];
    if (v == null) return null;
    const n = Number(typeof v === "object" ? v.id : v);
    return Number.isFinite(n) ? n : null;
  };
  const nomType = (t: number | null): string | null => (t == null ? null : igE.mode === "game_type" ? nomTypeJeu.get(t) || null : NOMS_TYPES_ANCIENS[t] || null);
  const anDe = (t: unknown): number | null => (N(t) > 0 ? new Date(N(t) * 1000).getUTCFullYear() : null);
  const frDe = (g: any): number[] => uniq([N(g.franchise) || 0, ...(Array.isArray(g.franchises) ? g.franchises.map(N) : [])].filter((x) => x > 0));
  const passeJeu = (g: any): Passe => {
    const t = typeDe(g), st = statutDe(g);
    return { dom: "game", id: N(g.id), titre: g.name || g.slug || null, an: anDe(g.first_release_date), pop: N(g.total_rating_count), format: nomType(t), statut: null, adulte: false, type: t, typeOk: t == null ? null : igE.types.has(t), statutOk: st == null ? true : !igE.statutsEcartes.has(st), version: N(g.version_parent) > 0 };
  };
  // jeu croisé : trois franchises ou plus (Smash Bros, Jump Force), sauf si sa franchise principale est une de la licence
  // (Kingdom Hearts dans Kingdom Hearts) ; à deux, une collaboration, gardée
  const jeuCroise = (g: any, franchisesLicence?: Set<number>): boolean => frDe(g).length >= 3 && !(N(g.franchise) > 0 && !!franchisesLicence?.has(N(g.franchise)));
  const OPTIONNELS = ["version_parent", "franchise", "franchises", "game_type", "category", "game_status", "status"];
  const champsJeux = (): string => ["id", "name", "slug", "first_release_date", "total_rating_count", "version_parent", "franchise", "franchises", ...(igE.mode ? [igE.mode] : []), ...(igE.statut ? [igE.statut] : [])].filter((c) => !igE.retires.has(c)).join(",");
  class Erreur400 extends Error {
    constructor(message: string, public champ: string | null) {
      super(message);
    }
  }
  /** Jeux IGDB ; un champ facultatif refusé (« Invalid Field ») est retiré et le repli noté ; un champ indispensable refusé : arrêt. */
  const jeux = async (where: string, limite: number): Promise<any[]> => {
    if (igE.casse) throw new PanneSource(igE.casse);
    for (let essai = 0; essai <= OPTIONNELS.length; essai++) {
      const r = await ig.requete("games", `fields ${champsJeux()}; where ${where}; sort total_rating_count desc; limit ${limite};`);
      const d = json(r.texte);
      if (r.status === 200 && Array.isArray(d)) return d.filter((g: any) => g && N(g.id) > 0);
      if (r.status === 400 && /invalid field/i.test(r.texte)) {
        const cause = Array.isArray(d) ? d.map((x: any) => String(x?.cause ?? "")).join(" ") : "";
        const champ = (cause.match(/'([A-Za-z0-9_.]+)'/) || [])[1] || null;
        if (champ && OPTIONNELS.includes(champ) && !igE.retires.has(champ) && champsJeux().split(",").includes(champ)) {
          igE.retires.add(champ);
          repli(`IGDB : champ refusé ${champ} : lu sans (${champ === "franchise" || champ === "franchises" ? "jeux croisés moins bien repérés" : "type, édition ou statut des jeux moins bien repérés"})`);
          continue;
        }
        if (champ && champsJeux().split(",").includes(champ)) {
          igE.casse = `IGDB : champ refusé ${asc(champ)} : passé des jeux impossible`;
          throw new PanneSource(igE.casse);
        }
        throw new Erreur400(`IGDB : champ refusé${champ ? " " + asc(champ) : ""} (HTTP 400)`, champ);
      }
      throw new PanneSource(`IGDB : HTTP ${r.status}`);
    }
    throw new PanneSource("IGDB : champs refusés");
  };
  const cacheF = new Map<number, any[]>(), cacheC = new Map<number, any[]>();
  const formesKO = new Set<string>();
  /** Les jeux d'une franchise (franchise principale ou autres franchises) ; une forme du filtre refusée n'est plus essayée. */
  const jeuxFranchise = async (F: number, avantAnnee = true): Promise<any[]> => {
    const cle = avantAnnee ? F : -F;
    const deja = cacheF.get(cle);
    if (deja) return deja;
    const formes = ([["ou", `(franchise = ${F} | franchises = (${F}))`], ["franchises", `franchises = (${F})`], ["franchise", `franchise = ${F}`]] as Array<[string, string]>).filter(([k]) => !formesKO.has(k));
    let derniere: Error | null = null;
    for (const [k, w] of formes) {
      try {
        const l = await jeux(avantAnnee ? `${w} & first_release_date < ${T0}` : w, regles.parFranchise);
        cacheF.set(cle, l);
        return l;
      } catch (e) {
        if (!(e instanceof Erreur400)) throw e;
        derniere = e;
        const ko = e.champ === "franchise" ? ["ou", "franchise"] : e.champ === "franchises" ? ["ou", "franchises"] : [k];
        for (const x of ko) formesKO.add(x);
        repli(e.champ ? `IGDB : champ ${asc(e.champ)} refusé dans le filtre : jeux lus par l'autre champ` : `IGDB : forme ${k} du filtre refusée`);
      }
    }
    throw derniere ? new PanneSource(derniere.message) : new PanneSource("IGDB : jeux des franchises illisibles");
  };
  const jeuxCollection = async (C: number): Promise<any[]> => {
    const deja = cacheC.get(C);
    if (deja) return deja;
    let l: any[];
    try {
      l = await jeux(`collections = (${C}) & first_release_date < ${T0}`, regles.parFranchise);
    } catch (e) {
      if (e instanceof Erreur400) throw new PanneSource(e.message);
      throw e;
    }
    cacheC.set(C, l);
    return l;
  };
  const jeuxParSlugs = async (slugs: string[]): Promise<any[]> => {
    if (igE.slugListe) {
      try {
        return await jeux(`slug = (${slugs.map((s) => `"${s}"`).join(",")})`, 500);
      } catch (e) {
        if (!(e instanceof Erreur400)) throw e;
        igE.slugListe = false;
        repli("IGDB : liste de noms courts refusée : lue un par un (forme ou)");
      }
    }
    try {
      return await jeux(slugs.map((s) => `slug = "${s}"`).join(" | "), 500);
    } catch (e) {
      if (e instanceof Erreur400) throw new PanneSource(e.message);
      throw e;
    }
  };

  // Wikidata : fiches des animés (AniList, MyAnimeList), de leur manga, des jeux (nom court IGDB), séries des franchises IGDB
  const wdAnimeAl = await parPropriete(wd, "P8729", fiches.filter((f) => f.anilist).map((f) => f.anilist as number));
  const wdAnimeMal = await parPropriete(wd, "P4086", fiches.filter((f) => f.mal).map((f) => f.mal as number));
  const sourcesManga = new Set<number>();
  for (const x of radarAl.values()) for (const e of x.rel) if (e.type === "SOURCE" && e.mtype === "MANGA") sourcesManga.add(e.id);
  const wdManga = await parPropriete(wd, "P8731", [...sourcesManga]);
  const wdJeux = await parPropriete(wd, "P5794", [...radarIg.values()].map((g) => g.slug).filter((s): s is string => !!s), /^[a-z0-9][a-z0-9-]*$/);
  const franchSlugs = uniq([...radarIg.values()].flatMap((g) => [...g.franchises, ...(g.principale ? [g.principale] : [])].map((f) => f.slug)));
  const wdSerIgdb = await seriesParIgdb(wd, franchSlugs);
  const tousQ = new Set<string>();
  for (const m of [wdAnimeAl, wdAnimeMal, wdManga, wdJeux]) for (const l of m.values()) for (const q of l) tousQ.add(q);
  const wdd = await details(wd, [...tousQ]);
  const libelles = wdd.libelles;
  for (const [k, v] of wdSerIgdb.libelles) if (!libelles.has(k)) libelles.set(k, v);
  const lib = (q: string | null): string | null => {
    if (!q) return null;
    const l = libelles.get(q);
    return l && !/^Q\d+$/.test(l) ? l : null;
  };
  dire(`  Wikidata : ${tousQ.size} fiches lues (${wd.n} requêtes)`);

  // ── 3. clés et franchises de chaque fiche
  const cles: Array<Map<string, Cle>> = fiches.map(() => new Map());
  const franchises: Array<Set<string>> = fiches.map(() => new Set());
  const pose = (i: number, k: string, t: string, nom?: string | null, nom2?: string | null) => {
    const c = cles[i].get(k);
    if (!c || FORCE[t] < FORCE[c.t]) cles[i].set(k, { k, t, nom: nom || (c && c.nom) || null, nom2: nom2 || (c && c.nom2) || null });
  };
  const parAniList = new Map<number, number>(), parIgdb = new Map<number, number>();
  fiches.forEach((f, i) => {
    if (f.anilist) parAniList.set(f.anilist, i);
    if (f.igdb) parIgdb.set(f.igdb, i);
  });
  const relWd = (q: string, i: number, origine: string): void => {
    pose(i, "wd:" + q, origine);
    const d = wdd.res.get(q);
    if (!d) return;
    // une franchise sans nom (ni anglais ni français) relie, mais ne compte pas comme une franchise de plus
    for (const x of [...d.fr, ...d.sfr, ...d.bfr]) {
      pose(i, "wd:" + x, "wd-franchise");
      const l = lib(x);
      if (l) franchises[i].add(norm(l));
    }
    // règles 7 : la série Wikidata d'un animé (ou de son œuvre d'origine) n'est pas une clé : Wikidata y range aussi des
    // cases de diffusion (Noitamina). Celles des jeux restent (« The Legend of Zelda » est une série de jeux).
    if (fiches[i].dom !== "anime") for (const x of [...d.s, ...d.bs]) pose(i, "wd:" + x, "wd-serie");
    for (const x of d.b) pose(i, "wd:" + x, "wd-origine");
  };
  const relations: Array<[number, number, string, string]> = [];
  /** Les relations AniList entre fiches du radar (fiche, fiche, type de relation) : traitées après les clés (4 bis). */
  const relationsAl: Array<{ a: number; b: number; type: string }> = [];
  fiches.forEach((f, i) => {
    if (f.dom === "anime") {
      const x = f.anilist ? radarAl.get(f.anilist) : undefined;
      if (x) {
        for (const e of x.rel) {
          if (e.type === "SOURCE" && e.mtype === "MANGA") {
            pose(i, "als:" + e.id, "anilist-origine", e.titre, e.romaji);
            for (const q of wdManga.get(String(e.id)) || []) relWd(q, i, "wd-origine");
          }
          if (e.mtype === "ANIME" && !SANS_LIEN.has(e.type) && parAniList.has(e.id) && parAniList.get(e.id) !== i) relationsAl.push({ a: i, b: parAniList.get(e.id) as number, type: e.type });
        }
      }
      for (const q of new Set([...(f.anilist ? wdAnimeAl.get(String(f.anilist)) || [] : []), ...(f.mal ? wdAnimeMal.get(String(f.mal)) || [] : [])])) relWd(q, i, "wd-fiche");
    } else {
      const g = f.igdb ? radarIg.get(f.igdb) : undefined;
      if (g) {
        const toutes = [...g.franchises, ...(g.principale && !g.franchises.some((x) => x.slug === g.principale?.slug) ? [g.principale] : [])];
        for (const fr of toutes) {
          pose(i, "igf:" + fr.slug, "igdb-franchise", fr.nom);
          franchises[i].add(norm(fr.nom));
          for (const q of wdSerIgdb.res.get(fr.slug) || []) pose(i, "wd:" + q, "wd-serie-igdb");
        }
        for (const c of g.collections) pose(i, "igc:" + c.slug, "igdb-collection", c.nom);
        if (g.parent && parIgdb.has(g.parent) && parIgdb.get(g.parent) !== i) relations.push([i, parIgdb.get(g.parent) as number, "igdb-parent", `jeu ${g.parent}`]);
        for (const q of (g.slug && wdJeux.get(g.slug)) || []) relWd(q, i, "wd-fiche");
      }
    }
  });

  // ── 4. groupes par les données : une fiche qui porte plusieurs franchises ne relie rien (croisement, licence parapluie) ;
  //       deux groupes de franchises différentes ne sont jamais réunis
  const ident = franchises.map((s) => reduire(s));
  const multi = new Set(fiches.map((_, i) => i).filter((i) => ident[i].length >= 2));
  for (const i of multi) diag.multi.push({ dom: fiches[i].dom, id: fiches[i].id, titre: fiches[i].titre || "", franchises: ident[i] });
  const parent = fiches.map((_, i) => i);
  const idG = fiches.map((_, i) => ident[i].slice());
  const racine = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const refuses: Array<{ a: number; b: number; t: string; cle: string; k?: string; origine?: boolean }> = [];
  /** Règles 7 : les clés dont une réunion a été refusée (œuvres d'origine différentes) : elles ne nomment une licence que
   *  si ses titres portent leur nom. Refaites après les réunions : une réunion refusée puis faite par un autre chemin
   *  (relation AniList, pont par le nom, franchise commune) ne conteste plus rien. */
  const contestees = new Set<string>();
  // règles 7 : les œuvres d'origine (mangas, AniList) de chaque groupe, suivies à chaque réunion. Deux groupes d'origines
  // différentes ne sont réunis par une clé que si son nom (franchise, œuvre Wikidata) se lit dans les titres de l'un des
  // deux ou d'une fiche qui porte la clé (« My Hero Academia: Vigilantes », autre manga, reste dans My Hero Academia ; une
  // suite au seul titre japonais, « Mairimashita! Iruma-kun… », aussi) ; un nom lu dans aucun titre (Noitamina, une case
  // de diffusion) ne réunit rien : la réunion est refusée et notée (Firefly Wedding et High School! Kimengumi). Les
  // relations AniList ont leur propre règle (4 bis).
  const origG = fiches.map((f) => new Set<number>(f.dom === "anime" && f.anilist ? (radarAl.get(f.anilist)?.rel || []).filter((e) => e.type === "SOURCE" && e.mtype === "MANGA").map((e) => e.id) : []));
  const nomCompactCle = (cle: string): string | null => {
    const n = cle.startsWith("wd:") ? lib(cle.slice(3)) : parCle.get(cle)?.nom ?? null;
    const c = n ? norm(n).replace(/ /g, "") : "";
    return c.length >= 3 ? c : null;
  };
  /** Le nom (compact) se lit dans le titre ou le titre original d'une fiche. */
  const titrePorte = (i: number, c: string): boolean => [fiches[i].titre, fiches[i].titreVo].some((x) => !!x && norm(x).replace(/ /g, "").includes(c));
  const porteLeNom = (r: number, c: string): boolean => fiches.some((_, i) => racine(i) === r && titrePorte(i, c));
  /** Les titres (anglais, romaji) des œuvres d'origine, compacts : « Case Closed » se lit dans le titre anglais du manga
   *  Meitantei Conan, pas dans celui de l'animé. */
  const titresOrigine = new Map<number, string[]>();
  for (const f of fiches) if (f.dom === "anime" && f.anilist) for (const e of radarAl.get(f.anilist)?.rel || []) {
    if (e.type === "SOURCE" && e.mtype === "MANGA" && !titresOrigine.has(e.id)) titresOrigine.set(e.id, [e.titre, e.romaji].filter((x): x is string => !!x).map((x) => norm(x).replace(/ /g, "")));
  }
  const origineLeNom = (r: number, c: string): boolean => [...origG[r]].some((m) => (titresOrigine.get(m) || []).some((t) => t.includes(c)));
  const originesDifferentes = (x: number, y: number, t: string, cle: string): boolean => {
    if (t === "anilist-relation" || origG[x].size === 0 || origG[y].size === 0 || [...origG[x]].some((v) => origG[y].has(v))) return false;
    // le nom se lit dans les titres de l'un des deux groupes ou de leurs œuvres d'origine, ou d'une fiche qui porte la
    // clé : l'ordre des réunions n'y change rien (une suite au seul titre japonais rejoint sa franchise même si elle passe
    // avant la saison au titre anglais)
    const c = nomCompactCle(cle);
    return !(c && (porteLeNom(x, c) || porteLeNom(y, c) || origineLeNom(x, c) || origineLeNom(y, c) || (parCle.get(cle)?.fiches || []).some((i) => titrePorte(i, c))));
  };
  const unirRacines = (x: number, y: number) => {
    const [p, e] = x < y ? [x, y] : [y, x];
    parent[e] = p;
    idG[p] = reduire([...idG[p], ...idG[e]]);
    for (const v of origG[e]) origG[p].add(v);
  };
  const unir = (a: number, b: number, t: string, cle: string): void => {
    if (multi.has(a) || multi.has(b)) return;
    const x = racine(a), y = racine(b);
    if (x === y) return;
    if (!compatibles(idG[x], idG[y])) {
      refuses.push({ a, b, t, cle });
      return;
    }
    if (originesDifferentes(x, y, t, cle)) {
      refuses.push({ a, b, t, cle: `${nomCle(cle)} : œuvres d'origine différentes`, k: cle, origine: true });
      contestees.add(cle);
      return;
    }
    unirRacines(x, y);
  };
  const parCle = new Map<string, { k: string; t: string; nom: string | null; fiches: number[] }>();
  const nomCle = (cle: string): string => asc((cle.startsWith("wd:") ? lib(cle.slice(3)) : parCle.get(cle)?.nom) || cle);
  cles.forEach((m, i) => {
    for (const c of m.values()) {
      let pc = parCle.get(c.k);
      if (!pc) parCle.set(c.k, (pc = { k: c.k, t: c.t, nom: c.nom, fiches: [] }));
      pc.fiches.push(i);
      if (FORCE[c.t] < FORCE[pc.t]) pc.t = c.t;
      if (!pc.nom && c.nom) pc.nom = c.nom;
    }
  });
  const liens = [...parCle.values()].filter((c) => c.fiches.length >= 2).map((c) => ({ ...c, force: FORCE[c.t] }));
  const paires = new Set<string>();
  for (const [a, b, t, cle] of relations) {
    const p = `${t}:${Math.min(a, b)}:${Math.max(a, b)}`;
    if (paires.has(p)) continue;
    paires.add(p);
    liens.push({ k: cle, t, nom: null, fiches: [a, b], force: FORCE[t] });
  }
  liens.sort((p, q) => p.force - q.force || p.fiches.length - q.fiches.length);
  // le lien qui a mis chaque fiche dans sa licence (le plus fort)
  const parFiche = new Map<number, string>();
  const relier = (a: number, b: number, t: string, k: string) => {
    const avant = racine(a) === racine(b);
    unir(a, b, t, k);
    if (!avant && racine(a) === racine(b)) {
      if (!parFiche.has(a)) parFiche.set(a, t);
      if (!parFiche.has(b)) parFiche.set(b, t);
    }
  };
  for (const c of liens) {
    // le pivot : la première fiche qui n'est pas à plusieurs franchises (une fiche LEGO Star Wars en tête ne coupe pas
    // la clé Star Wars de ses autres fiches)
    const piv = c.fiches.find((x) => !multi.has(x));
    if (piv == null) continue;
    for (const b of c.fiches) if (b !== piv) relier(piv, b, c.t, c.k);
  }

  // ── 4 bis. les relations AniList entre fiches du radar. Une fiche sans œuvre d'origine reliée à des licences d'origines
  //          ou de franchises différentes est un croisement (« Lupin III vs Conan ») : elle reste seule, comme une fiche à
  //          plusieurs franchises. Deux fiches d'origines différentes ne sont reliées que par un lien fort (suite, prélude,
  //          œuvre mère, dérivé, autre version).
  {
    const origines = fiches.map((f) => new Set<number>(f.dom === "anime" && f.anilist ? (radarAl.get(f.anilist)?.rel || []).filter((e) => e.type === "SOURCE" && e.mtype === "MANGA").map((e) => e.id) : []));
    const origR = new Map<number, Set<number>>(), membresR = new Map<number, number[]>();
    fiches.forEach((_, i) => {
      const r = racine(i);
      let o = origR.get(r);
      if (!o) origR.set(r, (o = new Set()));
      for (const x of origines[i]) o.add(x);
      pousser(membresR, r, i);
    });
    const disjointes = (a: Set<number> | undefined, b: Set<number> | undefined): boolean => !!a && !!b && a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));
    const differents = (x: number, y: number): boolean => disjointes(origR.get(x), origR.get(y)) || (idG[x].length > 0 && idG[y].length > 0 && !compatibles(idG[x], idG[y]));
    const partenaires = new Map<number, Set<number>>();
    for (const { a, b } of relationsAl) {
      ajouterA(partenaires, a, b);
      ajouterA(partenaires, b, a);
    }
    for (const [x, ps] of partenaires) {
      const rx = racine(x);
      if (multi.has(x) || origines[x].size || (membresR.get(rx) || []).length > 1) continue;
      const rs = uniq([...ps].filter((y) => !multi.has(y)).map(racine).filter((r) => r !== rx));
      let croise = false;
      for (let u = 0; u < rs.length && !croise; u++) for (let v = u + 1; v < rs.length && !croise; v++) croise = differents(rs[u], rs[v]);
      if (!croise) continue;
      multi.add(x);
      diag.multi.push({ dom: fiches[x].dom, id: fiches[x].id, titre: fiches[x].titre || "", franchises: rs.map((r) => asc(fiches[(membresR.get(r) || [r])[0]].titre || "")) });
    }
    const vues = new Set<string>();
    for (const { a, b, type } of relationsAl) {
      const p = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (vues.has(p) || multi.has(a) || multi.has(b)) continue;
      const x = racine(a), y = racine(b);
      if (x === y) continue;
      if (differents(x, y) && !FORTS.has(type)) {
        refuses.push({ a, b, t: "anilist-relation", cle: "origines différentes" });
        continue;
      }
      vues.add(p);
      relier(a, b, "anilist-relation", `anime ${fiches[b].anilist}`);
      if (racine(a) !== racine(b)) continue;
      const r = racine(a), o = origR.get(r) || new Set<number>();
      for (const k of [x, y]) if (k !== r) for (const v of origR.get(k) || []) o.add(v);
      origR.set(r, o);
    }
  }

  const groupesDe = (): Map<number, number[]> => {
    const g = new Map<number, number[]>();
    fiches.forEach((_, i) => pousser(g, racine(i), i));
    return g;
  };
  const seulMulti = (m: number[]): boolean => m.length === 1 && multi.has(m[0]);
  /** Noms forts d'un groupe (normalisés) : franchises et séries Wikidata, franchises IGDB, œuvres d'origine AniList. */
  const nomsForts = (m: number[]): Set<string> => {
    const s = new Set<string>();
    for (const i of m) for (const c of cles[i].values()) {
      const q = c.k.startsWith("wd:") ? c.k.slice(3) : null;
      if ((c.t === "wd-franchise" || c.t === "wd-serie") && q && lib(q)) s.add(norm(lib(q)));
      if ((c.t === "igdb-franchise" || c.t === "anilist-origine") && c.nom) s.add(norm(c.nom));
      if (c.t === "anilist-origine" && c.nom2) s.add(norm(c.nom2));
    }
    for (const x of [...s]) if (x.length < 3) s.delete(x);
    return s;
  };
  /** Noms de franchise d'un groupe (franchises Wikidata et IGDB seulement). */
  const nomsFranchise = (m: number[]): Set<string> => {
    const s = new Set<string>();
    for (const i of m) for (const c of cles[i].values()) {
      const q = c.k.startsWith("wd:") ? c.k.slice(3) : null;
      if (c.t === "wd-franchise" && q && lib(q)) s.add(norm(lib(q)));
      if (c.t === "igdb-franchise" && c.nom) s.add(norm(c.nom));
    }
    return s;
  };

  // ── 5. pont par le nom : un groupe de jeux et un groupe d'animés qui portent un même nom fort
  const marques = new Map<number, string>();
  const marquer = (i: number, m: string) => {
    if (!marques.has(i)) marques.set(i, m);
  };
  {
    const g = groupesDe(), anime: Array<[number, number[]]> = [], jeuxG: Array<[number, number[]]> = [];
    for (const [r, m] of g) {
      if (seulMulti(m)) continue;
      const a = m.some((i) => fiches[i].dom === "anime"), j = m.some((i) => fiches[i].dom === "game");
      if (a && !j) anime.push([r, m]);
      else if (j && !a) jeuxG.push([r, m]);
    }
    const index = new Map<string, Array<[number, number[]]>>();
    for (const [r, m] of anime) for (const n of nomsForts(m)) if (nomAssezFort(n)) pousser(index, n, [r, m]);
    for (const [r, m] of jeuxG) {
      const vus = new Set<number>();
      for (const n of [...nomsForts(m)].filter(nomAssezFort).sort((a, b) => b.length - a.length)) {
        for (const [ra, ma] of index.get(n) || []) {
          if (vus.has(ra)) continue;
          vus.add(ra);
          const x = racine(r), y = racine(ra);
          if (x === y) continue;
          if (!compatibles(idG[x], idG[y])) {
            refuses.push({ a: m[0], b: ma[0], t: "nom", cle: n });
            continue;
          }
          unirRacines(x, y);
          diag.pontsNom.push(n);
          for (const i of m) marquer(i, "nom");
        }
      }
    }
  }

  // ── 6. pont par le titre : une fiche seule dont le titre commence par le nom fort d'une autre licence suivi de
  //       deux-points (« One Piece: », « Pokémon: ») ; un titre égal au nom, seulement pour un nom de franchise
  {
    const g = groupesDe(), cible = new Map<string, Map<number, boolean>>();
    for (const [r, m] of g) {
      if (seulMulti(m)) continue;
      const fr = nomsFranchise(m);
      for (const n of nomsForts(m)) {
        if (n.length < 4) continue;
        let c = cible.get(n);
        if (!c) cible.set(n, (c = new Map()));
        c.set(r, fr.has(n));
      }
    }
    const candidats: Array<{ i: number; nom: string; rc: number }> = [];
    for (const [r, m] of g) {
      if (m.length !== 1 || multi.has(m[0])) continue;
      const i = m[0];
      const bruts = uniq([fiches[i].titre, fiches[i].titreVo].filter((t): t is string => !!t));
      const avants = new Set(bruts.map(avantDeuxPoints).filter((t): t is string => !!t));
      const entiers = new Set(bruts.map(norm));
      let best: { n: string; rc: number } | null = null, ex = false;
      for (const [n, rs] of cible) {
        for (const [rc, estFr] of rs) {
          if (rc === r) continue;
          if (!avants.has(n) && !(estFr && entiers.has(n))) continue;
          if (!best || n.length > best.n.length) {
            best = { n, rc };
            ex = false;
          } else if (n.length === best.n.length && best.rc !== rc) ex = true;
        }
      }
      if (!best) continue;
      if (ex) {
        diag.ambigusTitre.push({ dom: fiches[i].dom, id: fiches[i].id, titre: fiches[i].titre || "", nom: best.n });
        continue;
      }
      candidats.push({ i, nom: best.n, rc: best.rc });
    }
    for (const c of candidats) {
      const x = racine(c.i), y = racine(c.rc);
      if (x === y) continue;
      if (!compatibles(idG[x], idG[y])) {
        refuses.push({ a: c.i, b: c.rc, t: "titre", cle: c.nom });
        continue;
      }
      unirRacines(x, y);
      marquer(c.i, "titre");
      diag.pontsTitre.push({ dom: fiches[c.i].dom, id: fiches[c.i].id, titre: fiches[c.i].titre || "", licence: c.nom });
    }
  }

  // le nom d'une licence (anglais) : franchise Wikidata, franchise IGDB, série Wikidata, œuvre d'origine AniList,
  // collection IGDB ; une franchise Wikidata du passé (au moins 2 animés) quand les fiches n'ont aucune franchise ; à
  // défaut, le titre de la fiche (avant les deux-points)
  const frPasse = new Map<number, Map<string, number>>(); // racine -> franchise Wikidata du passé -> animés
  /** Fiche -> la franchise mère qui a réuni sa licence à une autre (7e, Love Live!) : elle donne le nom. */
  const mereDe = new Map<number, string>();
  /** Sans « Season N », « Part N », « 2nd Season »… à la fin ; avec film (le nom d'une œuvre principale, règles 4),
   *  ni « The Movie », « : The Movie », « – The Movie 2 », « Movie 3 » (« Bleach: The Movie » -> « Bleach »). */
  const sansSaison = (nom: string, film = false): string => {
    let s = nom;
    for (let k = 0; k < 3; k++) {
      s = s.replace(/\s+(season|part|cour)\s+\d+$/i, "").replace(/\s+\d+(st|nd|rd|th)\s+(season|part|cour)$/i, "");
      if (film) s = s.replace(/(:|\s+[\u2013\u2014-])?\s+the\s+movie(\s+\d+)?$/i, "").replace(/\s+movie\s+\d+$/i, "");
      s = s.trim();
    }
    return s.length >= 3 ? s : nom;
  };
  /** Un nom tiré d'un titre : avant les deux-points (4 lettres au moins), sans saison. Avec garde (le nom d'une œuvre
   *  principale, règles 4 et 5) : coupé seulement devant un vrai nom, un nom fort (2 mots ou 8 lettres) ou un mot à lui
   *  seul du titre japonais vo (« Frieren: Beyond Journey's End », vo « Sousou no Frieren » -> « Frieren ») ; sinon le
   *  titre entier (« Mission: Yozakura Family », vo « Yozakura-san Chi no Daisakusen » ; « Sakuna: Of Rice and Ruin »,
   *  vo « Tensui no Sakuna-hime ») ; et sans « The Movie ». */
  const nomDeTitre = (t: string, garde = false, vo: string | null = null): string => {
    const avant = t.split(": ")[0];
    const na = norm(avant);
    // le titre japonais compte s'il n'est pas le même titre (saisons écrites autrement comprises)
    const vrai = avant === t || nomAssezFort(na) || (!!vo && norm(sansSaison(vo)) !== norm(sansSaison(t)) && motDuTitreVo(vo, na));
    const coupe = avant.length >= 4 && (!garde || vrai);
    return sansSaison((coupe ? avant : t) || "(sans titre)", garde);
  };
  /** Le nom d'une licence et son rang (0 : le titre d'une fiche, faute de mieux). */
  const libelleRang = (membres: number[], r?: number): { nom: string; rang: number } => {
    // rang : franchise Wikidata 6, franchise IGDB 5, franchise Wikidata du passé 4, série Wikidata 3, œuvre d'origine
    // AniList 2, collection IGDB 1 ; puis le nombre de fiches qui portent le nom
    // une licence réunie sous une franchise mère (Love Live!) porte son nom
    for (const i of membres) {
      const q = mereDe.get(i);
      if (q && lib(q)) return { nom: lib(q) as string, rang: 7 };
    }
    const rangs = new Map<string, number>(), nb = new Map<string, number>();
    let vus = new Set<string>();
    const pousse = (nom: string | null, rang: number) => {
      if (!nom) return;
      rangs.set(nom, Math.max(rangs.get(nom) || 0, rang));
      if (vus.has(nom)) return;
      vus.add(nom);
      nb.set(nom, (nb.get(nom) || 0) + 1);
    };
    let franchise = false;
    // règles 7 : une clé contestée (réunion refusée) ne nomme la licence que si ses titres portent son nom
    const titresC = membres.flatMap((i) => [fiches[i].titre, fiches[i].titreVo]).filter((x): x is string => !!x).map((x) => norm(x).replace(/ /g, ""));
    const nommeMal = (k: string): boolean => {
      if (!contestees.has(k)) return false;
      const c = nomCompactCle(k);
      return !c || !titresC.some((t) => t.includes(c));
    };
    for (const i of membres) {
      vus = new Set<string>();
      for (const c of cles[i].values()) {
        if (nommeMal(c.k)) continue;
        const q = c.k.startsWith("wd:") ? c.k.slice(3) : null;
        if (c.t === "wd-franchise") {
          pousse(lib(q), 6);
          if (lib(q)) franchise = true;
        } else if (c.t === "igdb-franchise") {
          pousse(c.nom, 5);
          if (c.nom) franchise = true;
        } else if (c.t === "wd-serie") pousse(lib(q), 3);
        else if (c.t === "anilist-origine") pousse(c.nom, 2);
        else if (c.t === "igdb-collection") pousse(c.nom, 1);
      }
    }
    vus = new Set<string>();
    if (!franchise && r != null) for (const [q, k] of frPasse.get(r) || []) if (k >= 2 && lib(q) && !nommeMal("wd:" + q)) pousse(lib(q), 4);
    // à rang et nombre de fiches égaux, le nom qui se lit dans les titres des fiches de la licence (règles 6, Rey, 23
    // octobre : « Vampire Survivors », pas « Survivaton », la série Wikidata de leur œuvre d'origine), puis l'ordre
    // alphabétique
    const lu = new Map<string, number>();
    const luDans = (nom: string): number => {
      let n = lu.get(nom);
      if (n === undefined) {
        // un nom d'un seul mot ne compte qu'en tête du titre (« Warriors » ne se lit pas dans « Hyrule Warriors: Age of
        // Imprisonment » : un mot commun ne passe pas devant le vrai nom) ; un nom de plusieurs mots, en mots entiers
        const k = norm(nom);
        const lit = (t: string) => (k.includes(" ") ? porteNom(t, k) : t === k || t.startsWith(k + " "));
        n = k ? membres.filter((i) => [fiches[i].titre, fiches[i].titreVo].some((t) => !!t && lit(norm(t)))).length : 0;
        lu.set(nom, n);
      }
      return n;
    };
    const best = [...rangs.entries()].sort((a, b) => b[1] - a[1] || (nb.get(b[0]) || 0) - (nb.get(a[0]) || 0) || luDans(b[0]) - luDans(a[0]) || a[0].localeCompare(b[0]))[0];
    if (best) return { nom: best[0], rang: best[1] };
    return { nom: nomDeTitre(String(fiches[membres[0]].titre || fiches[membres[0]].titreVo || "")), rang: 0 };
  };
  const libelle = (membres: number[], r?: number): string => libelleRang(membres, r).nom;
  let G = groupesDe();
  for (const m of G.values()) m.sort((a, b) => String(fiches[a].date || "9").localeCompare(String(fiches[b].date || "9")));
  /** Les noms donnés aux licences en route (diagnostic) : nom -> une fiche de chaque licence qui l'a porté. */
  const nomsDits = new Map<string, Set<number>>();
  const nomL = (r: number): string => {
    const m = G.get(racine(r)) || [r];
    const n = m.length === 1 && multi.has(m[0]) ? fiches[m[0]].titre || "" : libelle(m, racine(r));
    ajouterA(nomsDits, n, m[0]);
    return n;
  };
  dire(`  licences du radar : ${[...G.values()].filter((m) => m.length >= 2).length} d'au moins 2 fiches ; ${multi.size} fiche(s) à plusieurs franchises laissées seules`);

  // ── 7. le passé de chaque licence : ses sorties d'avant l'année en cours
  const popAnimeG = new Map<number, number>(), popJeuG = new Map<number, number>();
  for (const [r, m] of G) for (const i of m) {
    const t = fiches[i].dom === "anime" ? popAnimeG : popJeuG;
    t.set(r, Math.max(t.get(r) || 0, fiches[i].pop));
  }
  const directs = new Map<number, Map<string, string>>(); // fiche -> (« a:id » | « j:id ») -> nature
  const direct = (i: number, k: string, nature: string) => {
    let m = directs.get(i);
    if (!m) directs.set(i, (m = new Map()));
    if (!m.has(k)) m.set(k, nature);
  };
  const liensRadar: Array<{ via: string; a: number; b: number }> = [];
  /** Les fiches des licences de diag.reliees, dans le même ordre (celles réunies ensuite sont retirées à la fin). */
  const relieesIdx: Array<{ a: number; b: number }> = [];
  const lienRadar = (via: string, ra: number, rb: number) => {
    if (ra !== rb) liensRadar.push({ via, a: Math.min(ra, rb), b: Math.max(ra, rb) });
  };

  // 7a. AniList : les animés reliés, de proche en proche, depuis les animés du radar (pas depuis une fiche à plusieurs
  //     franchises). Lecture d'abord (toutes licences ensemble), attribution ensuite, licence par licence.
  const departsG = new Map<number, number[]>();
  for (const [id, i] of parAniList) if (!multi.has(i)) pousser(departsG, racine(i), id);
  const sources0 = new Map<number, Set<number>>();
  for (const [r, ids] of departsG) for (const id of ids) for (const e of radarAl.get(id)?.rel || []) if (e.type === "SOURCE" && e.mtype === "MANGA") ajouterA(sources0, r, e.id);
  const nomsT = new Map<number, { compacts: string[]; mots: RegExp[] }>();
  /** Les noms de la licence : sans espaces (comparés comme en v1 : « Hanamonogatari » porte « monogatari ») et en
   *  expressions de mots entiers, les espaces facultatifs (« spy x family », « spyxfamily ») pour le pont par le titre. */
  const nomsDe = (r: number): { compacts: string[]; mots: RegExp[] } => {
    let l = nomsT.get(r);
    if (!l) {
      const m = G.get(r) || [r];
      const compacts = uniq([...nomsForts(m), norm(libelle(m))].map((n) => n.replace(/ /g, ""))).filter((n) => n.length >= 4);
      l = { compacts, mots: compacts.map((n) => new RegExp(`(?:^| )${[...n].join(" ?")}(?= |$)`, "g")) };
      nomsT.set(r, l);
    }
    return l;
  };
  const titresN = (n: Noeud): string[] => [n.titre, n.romaji].filter((x): x is string => !!x).map(norm);
  /** Le titre porte un nom de la licence (comme en v1 : sans espaces, au milieu d'un mot aussi) : admission par le titre. */
  const titreDeLaLicence = (n: Noeud, r: number): boolean => {
    const t = titresN(n).map((x) => x.replace(/ /g, ""));
    return nomsDe(r).compacts.some((k) => t.some((x) => x.includes(k)));
  };
  /** Le titre porte un nom de la licence en mots entiers : pont par le titre. */
  const titreMotsDeLaLicence = (n: Noeud, r: number): boolean => {
    const t = titresN(n);
    return nomsDe(r).mots.some((k) => t.some((x) => {
      k.lastIndex = 0;
      return k.test(x);
    }));
  };
  const sourceDiff = (n: Noeud, srcs: Set<number> | undefined): boolean => n.sources.length > 0 && !n.sources.some((s) => srcs?.has(s));
  // pont : un animé de même origine que la licence ; ou, pour une licence dont les animés du radar n'ont pas d'œuvre
  // d'origine (jugé sur ces animés-là, pas sur les origines adoptées en route : le résultat ne dépend pas de l'ordre des
  // relations), un animé sans origine atteint depuis le radar sans passer par un animé qui en a une (libre) : un
  // croisement sans origine atteint par Lupin III ne fait pas entrer Conan dans une licence d'animés originaux
  // un animé entré par le titre de la licence (Fate/Zero dans « Fate ») sert aussi de pont : ses liens forts comptent
  // (Lord El-Melloi II, dérivé de Fate/Zero Season 2) ; pas un titre de croisement (« Lupin the 3rd vs Detective Conan »)
  //  (le nom de la licence retiré du titre d'abord : « Spy x Family », « Spice and Wolf » ne sont pas des croisements ;
  //  « & » compte, comme « and » : « Dream 9 Toriko & One Piece & Dragon Ball Z »)
  const titreCroise = (n: Noeud, r: number): boolean => titresN(n).some((t) => {
    let x = t;
    for (const k of nomsDe(r).mots) x = x.replace(k, " ");
    return / (vs|versus|x|and) /.test(` ${x} `);
  });
  const estPont = (n: Noeud, srcs: Set<number> | undefined, r: number, libre: boolean): boolean =>
    n.sources.some((x) => srcs?.has(x)) || (!n.sources.length && !sources0.get(r)?.size && libre) || (titreMotsDeLaLicence(n, r) && !titreCroise(n, r));
  /** Le rang d'un parcours depuis un animé : 1 fermé (après une histoire parallèle), 2 ouvert, 3 ouvert et libre (sans origine). */
  const rangDe = (ouvert: boolean, libre: boolean, n: Noeud): number => (ouvert ? (libre && !n.sources.length ? 3 : 2) : 1);
  const noeuds = new Map<number, Noeud>();
  {
    interface EtatLecture {
      fort: boolean;
      /** Atteint sans passer par une histoire parallèle : un lien fort peut partir de lui. */
      ouvert: boolean;
      /** Atteint par un chemin ouvert parti du radar qui ne passe par aucun animé ayant une œuvre d'origine. */
      libre: boolean;
      /** 0 : pas encore parcouru ; sinon le rang du dernier parcours (rangDe). */
      etendu: number;
    }
    const vus = new Map<number, Map<number, EtatLecture>>();
    const srcExp = new Map<number, Set<number>>([...sources0].map(([r, s]) => [r, new Set(s)]));
    const srcChangees = new Set<number>();
    let aLire = new Set<number>();
    const aEvaluer = new Set<number>();
    const demandes = new Set<number>();
    // pont : le lien part d'un animé du radar, ou d'un animé dont l'œuvre d'origine est celle de la licence (un spécial
    // sans œuvre d'origine, comme un croisement « X vs Y », ne fait entrer aucun animé d'une autre œuvre)
    const atteindre = (v: number, r: number, t: string, pont: boolean, ouvertAmont: boolean, libreAmont: boolean): void => {
      if (parAniList.has(v)) return;
      let m = vus.get(v);
      if (!m) vus.set(v, (m = new Map()));
      let s = m.get(r);
      const neuf = !s;
      if (!s) m.set(r, (s = { fort: false, ouvert: false, libre: false, etendu: 0 }));
      const fort = FORTS.has(t) && pont && ouvertAmont, ouvert = ouvertAmont && t !== FEUILLE, libre = libreAmont && ouvert;
      const mieux = neuf || (fort && !s.fort) || (ouvert && !s.ouvert) || (libre && !s.libre);
      s.fort = s.fort || fort;
      s.ouvert = s.ouvert || ouvert;
      s.libre = s.libre || libre;
      if (!mieux) return;
      if (noeuds.has(v)) aEvaluer.add(v);
      else if (!demandes.has(v)) aLire.add(v);
    };
    for (const [r, ids] of departsG) for (const id of ids) for (const e of radarAl.get(id)?.rel || []) if (e.mtype === "ANIME" && !SANS_LIEN.has(e.type)) atteindre(e.id, r, e.type, true, true, true);
    let prof = 0, arret: string | null = null, nonLus = 0;
    while (aLire.size || aEvaluer.size) {
      if (aLire.size) {
        if (prof >= regles.profMax || noeuds.size >= regles.noeudsMax) {
          arret = arret || (prof >= regles.profMax ? "profondeur" : "noeuds");
          nonLus += aLire.size;
          aLire = new Set();
        } else {
          prof++;
          const popO = (id: number): number => Math.max(0, ...[...(vus.get(id)?.keys() || [])].map((r) => popAnimeG.get(r) || 0));
          const ids = [...aLire].sort((a, b) => popO(b) - popO(a) || a - b);
          const lot = ids.slice(0, regles.noeudsMax - noeuds.size);
          if (ids.length > lot.length) {
            arret = arret || "noeuds";
            nonLus += ids.length - lot.length;
          }
          aLire = new Set();
          for (const id of lot) demandes.add(id);
          for (const x of await al.parLots(REQ_PASSE, lot, 50)) {
            const n = noeudAl(x);
            if (!(n.id > 0) || noeuds.has(n.id) || parAniList.has(n.id)) continue;
            n.prof = prof;
            noeuds.set(n.id, n);
            aEvaluer.add(n.id);
          }
          dire(`  passé AniList : niveau ${prof}, ${noeuds.size} animés lus (${al.n} requêtes AniList en tout)`);
        }
      }
      const liste = [...aEvaluer];
      aEvaluer.clear();
      for (const v of liste) {
        const n = noeuds.get(v);
        if (!n || n.adulte) continue;
        for (const [r, s] of vus.get(v) || []) {
          const rang = rangDe(s.ouvert, s.libre, n);
          if (s.etendu >= rang) continue;
          const etr = sourceDiff(n, srcExp.get(r)) && !titreDeLaLicence(n, r);
          if (etr && !s.fort) continue;
          if (etr) for (const x of n.sources) if (ajouterA(srcExp, r, x)) srcChangees.add(r);
          s.etendu = rang;
          const pont = estPont(n, srcExp.get(r), r, s.libre);
          for (const e of n.voisins) atteindre(e.id, r, e.type, pont, s.ouvert, s.libre && !n.sources.length);
        }
      }
      // une licence dont les œuvres d'origine se sont élargies : ses animés arrêtés plus tôt sont réévalués
      if (srcChangees.size) {
        for (const [v, m] of vus) if (noeuds.has(v)) for (const [r, s] of m) if (srcChangees.has(r) && s.etendu === 0) aEvaluer.add(v);
        srcChangees.clear();
      }
    }
    comptesParcours.profondeur = prof;
    comptesParcours.arret = arret;
    comptesParcours.nonLus = nonLus;
  }
  dire(`  passé AniList : ${noeuds.size} animés lus${comptesParcours.arret ? ` ; arrêt : ${comptesParcours.arret}, ${comptesParcours.nonLus} non lus` : ""}`);
  // les résumés et compilations : de deux animés liés par une telle relation, le plus tardif (à année égale, le film ou
  // le spécial face à la série) ; ils restent des repères, mais pas des œuvres principales du bloc
  const compilations = new Set<number>();
  const SECONDAIRES = new Set(["MOVIE", "SPECIAL", "OVA", "TV_SHORT"]);
  /** L'année et le format d'un animé : du passé, ou une fiche du radar (son année : celle de sa date). */
  const anFormat = (id: number): { id: number; an: number | null; format: string | null; radar: boolean } | null => {
    const m = noeuds.get(id);
    if (m) return { id, an: m.an, format: m.format, radar: false };
    const i = parAniList.get(id);
    if (i == null) return null;
    const an = Number(String(fiches[i].date || "").slice(0, 4));
    return { id, an: an > 0 ? an : null, format: fiches[i].format, radar: true };
  };
  const compiler = (a: ReturnType<typeof anFormat>, b: ReturnType<typeof anFormat>) => {
    if (!a || !b) return;
    // une fiche du radar sans date (à annoncer) : on ne sait pas laquelle est venue après, rien n'est tranché
    if ((a.radar && !a.an) || (b.radar && !b.an)) return;
    let c: number | null = null;
    if (a.an && b.an && a.an !== b.an) c = a.an > b.an ? a.id : b.id;
    else if (SECONDAIRES.has(String(a.format)) !== SECONDAIRES.has(String(b.format))) c = SECONDAIRES.has(String(a.format)) ? a.id : b.id;
    if (c != null && noeuds.has(c)) compilations.add(c);
  };
  for (const n of noeuds.values()) for (const e of n.voisins) if (COMPILS.has(e.type)) compiler(anFormat(n.id), anFormat(e.id));
  for (const [id, x] of radarAl) for (const e of x.rel) if (e.mtype === "ANIME" && COMPILS.has(e.type)) compiler(anFormat(id), anFormat(e.id));

  // 7b. la franchise Wikidata des animés du passé : deux franchises différentes ne sont jamais réunies
  const frNoeuds = await franchisesAniList(wd, [...noeuds.keys()]);
  for (const [k, v] of frNoeuds.libelles) if (!libelles.has(k)) libelles.set(k, v);
  const frQRadar = (r: number): Set<string> => {
    const s = new Set<string>();
    for (const i of G.get(r) || []) for (const c of cles[i].values()) if (c.t === "wd-franchise" && c.k.startsWith("wd:")) s.add(c.k.slice(3));
    return s;
  };
  /** Des franchises Wikidata (q) autres que celles de la licence : identifiants différents et noms incompatibles. */
  const contraireQ = (q: string[], frQ: Set<string>, frNoms: string[]): boolean => {
    if (!q.length) return false;
    if (q.some((x) => frQ.has(x))) return false;
    const noms = reduire(q.map((x) => norm(lib(x) || "")).filter(Boolean));
    if (!noms.length || !frNoms.length) return false;
    return !compatibles(noms, frNoms);
  };
  /** Wikidata range l'animé dans une autre franchise que la licence. */
  const contraireWd = (n: Noeud, frQ: Set<string>, frNoms: string[]): boolean => contraireQ(frNoeuds.res.get(n.id) || [], frQ, frNoms);

  // 7c. l'attribution, licence par licence, sur les animés lus
  interface Adm {
    d: number;
    fort: boolean;
    ouvert: boolean;
    admis: boolean;
    /** Atteint par un chemin ouvert parti du radar qui ne passe par aucun animé ayant une œuvre d'origine. */
    libre: boolean;
    /** 0 : pas encore parcouru ; sinon le rang du dernier parcours (rangDe). */
    etendu: number;
    lienFort: string | null;
    autreOrigine: boolean;
    raison: string | null;
  }
  const admis = new Map<number, Map<number, Adm>>();
  const srcFin = new Map<number, Set<number>>();
  const radarDe = (id: number): number | null => (parAniList.has(id) ? (parAniList.get(id) as number) : null);
  for (const [r, deps] of departsG) {
    const srcs = new Set(sources0.get(r) || []);
    const A = new Map<number, Adm>();
    const frQ = frQRadar(r), frNoms = idG[r];
    let file: number[] = [];
    const relacher = (du: number, voisins: Array<{ id: number; type: string }>, pont: boolean, ouvertAmont: boolean, libreAmont: boolean) => {
      for (const e of voisins) {
        const i2 = radarDe(e.id);
        if (i2 != null) {
          if (!multi.has(i2) && racine(i2) !== r) lienRadar("AniList", r, racine(i2));
          continue;
        }
        if (!noeuds.has(e.id)) continue;
        let s = A.get(e.id);
        const neuf = !s;
        if (!s) A.set(e.id, (s = { d: du + 1, fort: false, ouvert: false, libre: false, admis: false, etendu: 0, lienFort: null, autreOrigine: false, raison: null }));
        const f = FORTS.has(e.type) && pont && ouvertAmont, o = ouvertAmont && e.type !== FEUILLE, l = libreAmont && o;
        const mieux = neuf || (f && !s.fort) || (o && !s.ouvert) || (l && !s.libre);
        if (f && !s.fort) s.lienFort = e.type;
        s.fort = s.fort || f;
        s.ouvert = s.ouvert || o;
        s.libre = s.libre || l;
        s.d = Math.min(s.d, du + 1);
        if (mieux) file.push(e.id);
      }
    };
    for (const id of deps) relacher(0, (radarAl.get(id)?.rel || []).filter((e) => e.mtype === "ANIME" && !SANS_LIEN.has(e.type)).map((e) => ({ id: e.id, type: e.type })), true, true, true);
    let changees = false;
    for (;;) {
      while (file.length) {
        const lot = file;
        file = [];
        for (const v of lot) {
          const s = A.get(v) as Adm, n = noeuds.get(v) as Noeud;
          if (s.admis && s.etendu >= rangDe(s.ouvert, s.libre, n)) continue;
          if (n.adulte) {
            s.raison = "animé pour adultes";
            continue;
          }
          if (contraireWd(n, frQ, frNoms)) {
            s.raison = "franchise Wikidata différente";
            continue;
          }
          const etr = sourceDiff(n, srcs) && !titreDeLaLicence(n, r);
          if (etr && !s.fort) {
            s.raison = "autre œuvre d'origine";
            continue;
          }
          s.admis = true;
          s.raison = null;
          if (etr) {
            s.autreOrigine = true;
            for (const x of n.sources) if (!srcs.has(x)) {
              srcs.add(x);
              changees = true;
            }
          }
          const rang = rangDe(s.ouvert, s.libre, n);
          if (s.etendu < rang) {
            s.etendu = rang;
            relacher(s.d, n.voisins, estPont(n, srcs, r, s.libre), s.ouvert, s.libre && !n.sources.length);
          }
        }
      }
      if (!changees) break;
      changees = false;
      for (const [v, s] of A) if (!s.admis) file.push(v);
    }
    admis.set(r, A);
    srcFin.set(r, srcs);
  }

  // 7d. chaque animé du passé à une seule licence : celles de sa propre œuvre d'origine d'abord, puis celles dont il est
  //     un lien direct, puis la plus proche ; à égalité sans œuvre d'origine commune, à aucune
  const directsVers = new Map<number, Set<number>>();
  for (const [r, deps] of departsG) for (const a of deps) for (const e of radarAl.get(a)?.rel || []) if (e.mtype === "ANIME" && DIRECTS.has(e.type)) ajouterA(directsVers, e.id, r);
  const attribue = new Map<number, number>(); // animé du passé -> racine (d'avant les réunions : racine() la suit)
  const egauxR: Array<{ v: number; rs: number[] }> = [];
  {
    const parNoeud = new Map<number, Array<{ r: number; d: number; s: Adm }>>();
    const vusPar = new Map<number, Array<{ r: number; d: number; s: Adm }>>();
    for (const [r, A] of admis) for (const [v, s] of A) {
      if (s.admis) pousser(parNoeud, v, { r, d: s.d, s });
      else pousser(vusPar, v, { r, d: s.d, s });
    }
    for (const [v, cands0] of parNoeud) {
      const n = noeuds.get(v) as Noeud;
      let cands = cands0;
      const memeSrc = cands.filter((c) => n.sources.some((x) => srcFin.get(c.r)?.has(x)));
      if (memeSrc.length) cands = memeSrc;
      const dirs = cands.filter((c) => directsVers.get(v)?.has(c.r));
      if (dirs.length) cands = dirs;
      const dmin = Math.min(...cands.map((c) => c.d));
      const gs = cands.filter((c) => c.d === dmin);
      if (gs.length > 1) {
        const s0 = srcFin.get(gs[0].r);
        const memeOrigine = memeSrc.length > 0 || (!!s0 && s0.size > 0 && gs.every((c) => [...(srcFin.get(c.r) || [])].some((x) => s0.has(x))));
        if (!memeOrigine) {
          egauxR.push({ v, rs: gs.map((c) => c.r) });
          continue;
        }
        gs.sort((a, b) => (popAnimeG.get(b.r) || 0) - (popAnimeG.get(a.r) || 0) || a.r - b.r);
        for (let k = 1; k < gs.length; k++) lienRadar("AniList", gs[0].r, gs[k].r);
      }
      attribue.set(v, gs[0].r);
      if (gs[0].s.autreOrigine) diag.forts.push({ id: v, titre: n.titre || "", an: n.an, pop: n.pop, licence: nomL(gs[0].r), lien: gs[0].s.lienFort || "" });
    }
    for (const [v, l] of vusPar) {
      if (parNoeud.has(v)) continue;
      const n = noeuds.get(v) as Noeud;
      const c = [...l].sort((a, b) => a.d - b.d)[0];
      if (c.s.raison && c.s.raison !== "animé pour adultes") diag.exclus.push({ id: v, titre: n.titre || "", an: n.an, pop: n.pop, licence: nomL(c.r), raison: c.s.raison });
    }
  }
  for (const [id, i] of parAniList) {
    if (multi.has(i)) continue;
    for (const e of radarAl.get(id)?.rel || []) if (e.mtype === "ANIME" && DIRECTS.has(e.type) && attribue.get(e.id) === racine(i)) direct(i, "a:" + e.id, e.type);
  }

  // 7e. deux licences du radar qui partagent une franchise Wikidata (celle de leurs fiches, ou celle d'au moins deux
  //     animés de leur passé) sont réunies ; deux franchises différentes, jamais
  {
    for (const [v, r] of attribue) for (const q of frNoeuds.res.get(v) || []) {
      let m = frPasse.get(r);
      if (!m) frPasse.set(r, (m = new Map()));
      m.set(q, (m.get(q) || 0) + 1);
    }
    const FS = new Map<number, Set<string>>();
    for (const [r, m] of G) {
      if (seulMulti(m)) continue;
      const s = frQRadar(r);
      for (const [q, k] of frPasse.get(r) || []) if (k >= 2) s.add(q);
      if (s.size) FS.set(r, s);
    }
    const parQ = new Map<string, number[]>();
    for (const [r, s] of FS) for (const q of s) pousser(parQ, q, r);
    const titreDe = (r: number): string => {
      const i = (G.get(r) || [r])[0];
      return fiches[i].titre || fiches[i].titreVo || "";
    };
    const reunir = (a: number, b: number, q: string) => {
      const x = racine(a), y = racine(b);
      if (x === y || !compatibles(idG[x], idG[y])) return;
      // règles 7 : le même contrôle qu'aux clés (étape 4) : œuvres d'origine différentes et nom de la franchise lu dans
      // aucun de leurs titres : pas de réunion
      if (originesDifferentes(x, y, "wd-franchise", "wd:" + q)) {
        refuses.push({ a: x, b: y, t: "wd-franchise", cle: `${nomCle("wd:" + q)} : œuvres d'origine différentes`, k: "wd:" + q, origine: true });
        contestees.add("wd:" + q);
        return;
      }
      const noms = [titreDe(x), titreDe(y)];
      unirRacines(x, y);
      diag.reunies.push({ noms, franchise: lib(q) || q });
    };
    for (const [q, rs] of parQ) for (let k = 1; k < rs.length; k++) reunir(rs[0], rs[k], q);
    // reliées par leur passé : réunies si l'une n'a pas de franchise et que ses titres portent celle de l'autre ; un titre
    // de croisement (« Detective Conan vs. Yaiba », « X × Y ») ne compte pas
    const titresDe = (r: number): string[] => (G.get(r) || []).flatMap((i) => [fiches[i].titre, fiches[i].titreVo].filter((t): t is string => !!t).map(norm));
    // un croisement : le nom accolé à un autre titre par « vs » ou « versus » (« Detective Conan vs. Yaiba »), ou par
    // « x » à un autre nom fort du radar (« One Piece x Jujutsu Kaisen ») ; pas « Spy x Family », « Hunter x Hunter »,
    // « Final Fantasy X » ni « Pokémon X and Y »
    const nomsTous = new Set<string>();
    for (const m2 of G.values()) for (const n of nomsForts(m2)) nomsTous.add(n);
    const croisementAvec = (t: string, nom: string): boolean => {
      const e = nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^| )${e} (vs|versus) \\S|\\S (vs|versus) ${e}( |$)`).test(t)) return true;
      const autres = [...nomsTous].filter((n) => n !== nom);
      const i = t.indexOf(nom + " x ");
      if (i >= 0 && (i === 0 || t[i - 1] === " ")) {
        const reste = t.slice(i + nom.length + 3);
        if (autres.some((n) => reste === n || reste.startsWith(n + " "))) return true;
      }
      const j = t.indexOf(" x " + nom);
      if (j >= 0 && (j + 3 + nom.length === t.length || t[j + 3 + nom.length] === " ")) {
        const avant = t.slice(0, j);
        if (autres.some((n) => avant === n || avant.endsWith(" " + n))) return true;
      }
      return false;
    };
    // les œuvres d'origine d'une licence (celles de ses fiches et celles adoptées en route) ; et celles adoptées en route
    // seulement, avec les animés qui les ont apportées : une licence qui a adopté une œuvre d'origine que l'autre n'a pas
    // n'est réunie à elle par le titre que si l'animé qui l'a apportée porte aussi son nom (« Kaiju Saga Z » oui ; pas
    // « Toriko » pour un croisement « Toriko x One Piece »)
    const apporteurs = (r: number, src: number): Noeud[] => {
      const out: Noeud[] = [];
      for (const [r0, A] of admis) if (racine(r0) === racine(r)) for (const [v, st] of A) {
        const n = noeuds.get(v);
        if (st.admis && st.autreOrigine && n && n.sources.includes(src)) out.push(n);
      }
      return out;
    };
    const titresNoeud = (n: Noeud): string[] => [n.titre, n.romaji].filter((t): t is string => !!t).map(norm);
    const sourcesDe = (r: number): Set<number> => {
      const out = new Set<number>();
      for (const [r0, sr] of srcFin) if (racine(r0) === racine(r)) for (const v of sr) out.add(v);
      return out;
    };
    const adopteesDe = (r: number): number[] => {
      const out: number[] = [];
      for (const [r0, sr] of srcFin) if (racine(r0) === racine(r)) for (const v of sr) if (!sources0.get(r0)?.has(v)) out.push(v);
      return out;
    };
    const vusL = new Set<string>();
    for (const l of liensRadar) {
      const k = `${l.a},${l.b}`;
      if (vusL.has(k)) continue;
      vusL.add(k);
      let fait = false;
      for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
        if (fait || racine(x) === racine(y) || FS.has(y) || !FS.has(x)) continue;
        const sx = sourcesDe(x);
        const hors = uniq(adopteesDe(y).filter((v) => !sx.has(v)));
        const q = [...(FS.get(x) as Set<string>)].find((q2) => {
          const nom = norm(lib(q2) || "");
          if (nom.length < 4 || !titresDe(y).some((t) => porteNom(t, nom) && !croisementAvec(t, nom))) return false;
          return hors.every((v) => {
            const ap = apporteurs(y, v);
            return ap.length > 0 && ap.every((n) => titresNoeud(n).some((t) => porteNom(t, nom) && !croisementAvec(t, nom)));
          });
        });
        if (q) {
          reunir(x, y, q);
          fait = true;
        }
      }
      if (racine(l.a) !== racine(l.b)) {
        diag.reliees.push({ a: nomL(l.a), b: nomL(l.b), via: l.via });
        relieesIdx.push({ a: l.a, b: l.b });
      }
    }
    // reliées par leur passé, et leurs franchises rangées par Wikidata dans une même franchise (« Love Live!
    // Hasunosora… » et « Love Live! Nijigasaki… » dans « Love Live! ») : réunies, sous le nom de celle-ci (Rey, 22 octobre),
    // si les titres des fiches de chacune portent ce nom (pas un éditeur, un auteur ou un parapluie de croisements).
    // Les franchises d'une licence, ici : les siennes, sinon celles des animés de son passé atteints par un chemin ouvert
    // (pas par une histoire parallèle) et qui ne sont pas des croisements (« Love Live! Nijigasaki… » : celle de sa
    // première saison) ; seulement ses franchises propres (pas une franchise que les deux portent)
    const frRepli = new Map<number, Set<string>>();
    for (const [v, r] of attribue) {
      const n = noeuds.get(v), st = admis.get(r)?.get(v);
      if (!n || !st?.ouvert || titreCroise(n, r)) continue;
      for (const q of frNoeuds.res.get(v) || []) ajouterA(frRepli, r, q);
    }
    const frDeL = (r: number): Set<string> => FS.get(r) || frRepli.get(r) || new Set();
    const lies = liensRadar.filter((l) => racine(l.a) !== racine(l.b) && frDeL(l.a).size > 0 && frDeL(l.b).size > 0);
    if (lies.length) {
      const par = await franchisesParentes(wd, uniq(lies.flatMap((l) => [...frDeL(l.a), ...frDeL(l.b)])));
      for (const [k, v] of par.libelles) if (!libelles.has(k)) libelles.set(k, v);
      const fichesDe = (r: number): number[] => fiches.map((_, i) => i).filter((i) => racine(i) === racine(r));
      const portentNom = (r: number, nom: string): boolean => nom.length >= 4 && titresDe(r).some((t) => porteNom(t, nom) && !croisementAvec(t, nom));
      for (const l of lies) {
        if (racine(l.a) === racine(l.b)) continue;
        const fa = frDeL(l.a), fb = frDeL(l.b);
        const meres = (f: Set<string>, autre: Set<string>): Set<string> => new Set([...f].filter((q) => !autre.has(q)).flatMap((q) => par.res.get(q) || []));
        const ma = meres(fa, fb), mb = meres(fb, fa);
        // la franchise qui range une franchise propre de chacune, ou une franchise de l'une qui range une franchise propre
        // de l'autre ; son nom porté par les titres des deux
        const p = uniq([...[...ma].filter((q) => mb.has(q)), ...[...ma].filter((q) => fb.has(q)), ...[...mb].filter((q) => fa.has(q))]).find((q) => {
          const nom = norm(lib(q) || "");
          return !!lib(q) && portentNom(l.a, nom) && portentNom(l.b, nom);
        });
        if (!p) continue;
        const noms = [titreDe(racine(l.a)), titreDe(racine(l.b))];
        // la franchise commune devient une franchise de leurs fiches : elle donne le nom et une clé d'identité
        for (const i of [...fichesDe(l.a), ...fichesDe(l.b)]) {
          pose(i, "wd:" + p, "wd-franchise");
          mereDe.set(i, p);
        }
        unirRacines(racine(l.a), racine(l.b));
        const rr = racine(l.a);
        idG[rr] = reduire([...idG[rr], norm(lib(p) as string)]);
        diag.reunies.push({ noms, franchise: lib(p) || p });
        // une licence du radar rangée dans cette franchise même la rejoint, comme deux licences de même franchise
        for (const [r2, s2] of FS) if (s2.has(p) && racine(r2) !== racine(rr)) {
          reunir(rr, r2, p);
          if (racine(r2) === racine(rr)) for (const i of fichesDe(r2)) mereDe.set(i, p);
        }
      }
    }
    G = groupesDe();
    for (const m of G.values()) m.sort((a, b) => String(fiches[a].date || "9").localeCompare(String(fiches[b].date || "9")));
    nomsT.clear();
    // règles 7 : les réunions sont faites ; une clé reste contestée si l'une de ses réunions refusées tient encore
    contestees.clear();
    for (const x of refuses) if (x.origine && x.k && racine(x.a) !== racine(x.b)) contestees.add(x.k);
    // à égale distance de deux licences : à la licence réunie si elles le sont maintenant, sinon à aucune
    for (const x of egauxR) {
      const rs = uniq(x.rs.map(racine));
      const n = noeuds.get(x.v) as Noeud;
      if (rs.length === 1) attribue.set(x.v, rs[0]);
      else diag.egaux.push({ id: x.v, titre: n.titre || "", an: n.an, licences: rs.map(nomL) });
    }
    // les popularités et les pas suivants suivent les nouvelles racines
    popAnimeG.clear();
    popJeuG.clear();
    for (const [r, m] of G) for (const i of m) {
      const t = fiches[i].dom === "anime" ? popAnimeG : popJeuG;
      t.set(r, Math.max(t.get(r) || 0, fiches[i].pop));
    }
    const fp = new Map(frPasse);
    frPasse.clear();
    for (const [r, m] of fp) {
      const rr = racine(r);
      let mm = frPasse.get(rr);
      if (!mm) frPasse.set(rr, (mm = new Map()));
      for (const [q, k] of m) mm.set(q, (mm.get(q) || 0) + k);
    }
  }
  dire(`  passé AniList : ${attribue.size} animés attribués ; ${diag.exclus.length} écartés ; ${diag.forts.length} entrés par un lien fort ; ${diag.reunies.length} licence(s) réunie(s)`);

  // les revendications sur les œuvres du passé (une œuvre à une seule licence)
  const revendications = new Map<string, Array<{ r: number; src: string; rep: Passe }>>();
  const revendiquer = (r: number, src: string, rep: Passe) => pousser(revendications, (rep.dom === "anime" ? "a:" : "j:") + rep.id, { r: racine(r), src, rep });
  for (const [v, r] of attribue) revendiquer(r, "anilist", passeAnime(noeuds.get(v) as Noeud));

  // 7f. IGDB : l'original d'un remake ou d'un remaster du radar, le jeu de base d'une extension (liens directs), puis les
  //     jeux des franchises et collections de chaque licence ; une franchise ou une collection portée par des fiches de
  //     plusieurs licences ne donne de passé à aucune ; un jeu croisé (trois franchises ou plus) est écarté
  const groupesIg = new Map<string, Set<number>>(), nomsIg = new Map<string, string>();
  for (const [r, m] of G) for (const i of m) {
    if (multi.has(i) || fiches[i].dom !== "game" || !fiches[i].igdb) continue;
    const g = radarIg.get(fiches[i].igdb as number);
    if (!g) continue;
    for (const [k, x] of [...[...g.franchises, ...(g.principale ? [g.principale] : [])].map((fr) => ["f" + fr.id, fr] as [string, CleIg]), ...g.collections.map((c) => ["c" + c.id, c] as [string, CleIg])]) {
      if (!x.id) continue;
      ajouterA(groupesIg, k, r);
      nomsIg.set(k, x.nom);
    }
  }
  const partagee = (k: string): boolean => (groupesIg.get(k)?.size || 0) > 1;
  for (const [k, v] of groupesIg) if (v.size > 1) diag.partageesCles.push(`IGDB ${asc(nomsIg.get(k) || k)}`);
  const radarIds = [...parIgdb.keys()];
  /** Les originaux d'un lot de jeux du radar ; un lot qui atteint la limite de 500 réponses est coupé en deux. */
  const originaux = async (ids: number[]): Promise<any[]> => {
    const p = ids.join(",");
    let d: any = null;
    if (igE.remasters) {
      const r = await ig.requete("games", `fields id,name,slug,first_release_date,total_rating_count,remakes,remasters; where remakes = (${p}) | remasters = (${p}); limit 500;`);
      d = json(r.texte);
      const champ = r.status === 400 && /invalid field/i.test(r.texte) ? ((r.texte.match(/'([A-Za-z0-9_.]+)'/) || [])[1] || "?") : null;
      if (r.status === 400 && (!champ || champ === "remasters")) {
        igE.remasters = false;
        repli("IGDB : originaux des remasters refusés : seulement ceux des remakes");
        d = null;
      } else if (r.status !== 200 || !Array.isArray(d)) throw new PanneSource(champ ? `IGDB (originaux) : champ refusé ${asc(champ)}` : `IGDB (originaux) : HTTP ${r.status}`);
    }
    if (!igE.remasters) {
      const r = await ig.requete("games", `fields id,name,slug,first_release_date,total_rating_count,remakes; where remakes = (${p}); limit 500;`);
      d = json(r.texte);
      if (r.status !== 200 || !Array.isArray(d)) throw new PanneSource(`IGDB (originaux) : HTTP ${r.status}`);
    }
    if (d.length >= 500) {
      if (ids.length === 1) throw new Incomplet("IGDB (originaux) : 500 réponses pour un seul jeu, liste peut-être coupée");
      const m = Math.ceil(ids.length / 2);
      return [...(await originaux(ids.slice(0, m))), ...(await originaux(ids.slice(m)))];
    }
    return d;
  };
  for (let k = 0; k < radarIds.length; k += 200) {
    for (const o of await originaux(radarIds.slice(k, k + 200))) {
      if (!o || !(N(o.id) > 0) || parIgdb.has(N(o.id))) continue;
      const ao = anDe(o.first_release_date);
      if (!ao || ao >= AN) continue;
      for (const rid of [...(o.remakes || []), ...(o.remasters || [])].map(N)) {
        if (!parIgdb.has(rid)) continue;
        const i = parIgdb.get(rid) as number;
        revendiquer(racine(i), "igdb-remake", { ...passeJeu(o), typeOk: null });
        direct(i, "j:" + N(o.id), "ORIGINAL");
      }
    }
  }
  const parents = new Map<number, number[]>();
  for (const [id, g] of radarIg) if (g.parent && !parIgdb.has(g.parent) && parIgdb.has(id)) pousser(parents, g.parent, parIgdb.get(id) as number);
  const lp = [...parents.keys()];
  for (let k = 0; k < lp.length; k += 200) {
    let l: any[];
    try {
      l = await jeux(`id = (${lp.slice(k, k + 200).join(",")})`, 500);
    } catch (e) {
      throw e instanceof Erreur400 ? new PanneSource(e.message) : e;
    }
    for (const g of l) {
      const a = anDe(g.first_release_date);
      if (!a || a >= AN) continue;
      for (const i of parents.get(N(g.id)) || []) {
        revendiquer(racine(i), "igdb-base", passeJeu(g));
        direct(i, "j:" + N(g.id), "BASE");
      }
    }
  }
  const clesG = new Map<number, { f: Set<number>; c: Set<number> }>();
  const avecClesIg = new Set<number>();
  /** Toutes les franchises IGDB des jeux du radar d'une licence (partagées ou non). */
  const frIgL = new Map<number, Set<number>>();
  for (const [r, m] of G) for (const i of m) {
    if (multi.has(i) || fiches[i].dom !== "game" || !fiches[i].igdb) continue;
    const g = radarIg.get(fiches[i].igdb as number);
    if (g) for (const fr of [...g.franchises, ...(g.principale ? [g.principale] : [])]) if (fr.id) ajouterA(frIgL, r, fr.id);
  }
  const frIgLicence = (r: number): Set<number> => frIgL.get(racine(r)) || new Set();
  for (const [r, m] of G) {
    const s = { f: new Set<number>(), c: new Set<number>() };
    for (const i of m) {
      if (multi.has(i) || fiches[i].dom !== "game" || !fiches[i].igdb) continue;
      const g = radarIg.get(fiches[i].igdb as number);
      if (!g) continue;
      if (g.franchises.length || g.collections.length || g.principale) avecClesIg.add(r);
      for (const fr of [...g.franchises, ...(g.principale ? [g.principale] : [])]) if (fr.id && !partagee("f" + fr.id)) s.f.add(fr.id);
      for (const c of g.collections) if (c.id && !partagee("c" + c.id)) s.c.add(c.id);
    }
    if (s.f.size || s.c.size) clesG.set(r, s);
  }
  const jeuxPasse = new Set<number>();
  for (const [r, s] of clesG) {
    for (const [ens, src] of [[s.f, "igdb-franchise"], [s.c, "igdb-collection"]] as Array<[Set<number>, string]>) {
      for (const k of ens) {
        const l = src === "igdb-franchise" ? await jeuxFranchise(k) : await jeuxCollection(k);
        for (const g of l) {
          const gid = N(g.id);
          if (parIgdb.has(gid)) {
            lienRadar("IGDB", r, racine(parIgdb.get(gid) as number));
            continue;
          }
          if (jeuCroise(g, frIgLicence(r))) {
            diag.croises.push({ id: gid, titre: g.name || "", an: anDe(g.first_release_date), licence: nomL(r) });
            continue;
          }
          revendiquer(r, src, passeJeu(g));
          jeuxPasse.add(gid);
        }
      }
    }
  }
  dire(`  IGDB : ${jeuxPasse.size} jeux du passé lus (${ig.n} requêtes IGDB en tout)`);

  // 7g. Wikidata : les animés et les jeux des franchises et séries de chaque licence (pas d'une clé portée par plusieurs
  //     licences)
  const itemsG = new Map<number, Set<string>>(), groupesWd = new Map<string, Set<number>>();
  for (const [r, m] of G) for (const i of m) if (!multi.has(i)) for (const c of cles[i].values()) {
    if ((c.t === "wd-franchise" || c.t === "wd-serie" || c.t === "wd-serie-igdb") && c.k.startsWith("wd:")) ajouterA(groupesWd, c.k.slice(3), r);
  }
  for (const [q, gs] of groupesWd) {
    if (gs.size > 1) {
      diag.partageesCles.push(`Wikidata ${asc(lib(q) || q)}`);
      continue;
    }
    ajouterA(itemsG, [...gs][0], q);
  }
  const membres = await membresWd(wd, uniq([...itemsG.values()].flatMap((s) => [...s])));
  const aLireAl = new Set<number>(), aLireMal = new Set<number>(), aLireSlug = new Set<string>();
  const attacheWd: Array<[number, "al" | "mal" | "ig", number | string, string[]]> = [];
  const malRadar = new Map<number, number>();
  fiches.forEach((f, i) => {
    if (f.dom === "anime" && f.mal) malRadar.set(f.mal, i);
  });
  const igRadarSlug = new Map<string, number>();
  for (const [id, g] of radarIg) if (g.slug && parIgdb.has(id)) igRadarSlug.set(g.slug, parIgdb.get(id) as number);
  for (const [r, s] of itemsG) for (const q of s) for (const mb of membres.get(q) || []) {
    if (mb.al) {
      if (parAniList.has(mb.al)) lienRadar("Wikidata", r, racine(parAniList.get(mb.al) as number));
      else {
        attacheWd.push([r, "al", mb.al, mb.xf]);
        if (!noeuds.has(mb.al)) aLireAl.add(mb.al);
      }
    } else if (mb.mal) {
      if (malRadar.has(mb.mal)) lienRadar("Wikidata", r, racine(malRadar.get(mb.mal) as number));
      else {
        attacheWd.push([r, "mal", mb.mal, mb.xf]);
        aLireMal.add(mb.mal);
      }
    }
    if (mb.ig) {
      if (igRadarSlug.has(mb.ig)) lienRadar("Wikidata", r, racine(igRadarSlug.get(mb.ig) as number));
      else {
        attacheWd.push([r, "ig", mb.ig, mb.xf]);
        aLireSlug.add(mb.ig);
      }
    }
  }
  const alWd = new Map<number, Noeud>(), malWd = new Map<number, Noeud>(), slugWd = new Map<string, any>();
  for (const x of await al.parLots(REQ_PAR_ID, [...aLireAl], 50)) alWd.set(N(x.id), noeudAl(x));
  for (const x of await al.parLots(REQ_PAR_MAL, [...aLireMal], 50)) {
    const n = noeudAl(x);
    if (n.mal) malWd.set(n.mal, n);
  }
  for (const l of [...cacheF.values(), ...cacheC.values()]) for (const g of l) if (g.slug) slugWd.set(String(g.slug), g);
  const resteSlugs = [...aLireSlug].filter((s) => !slugWd.has(s));
  for (let k = 0; k < resteSlugs.length; k += 100) for (const g of await jeuxParSlugs(resteSlugs.slice(k, k + 100))) if (g.slug) slugWd.set(String(g.slug), g);
  // les noms des franchises IGDB de ces jeux (pour une licence sans jeu du radar : comparés aux noms de franchise de la
  // licence)
  const nomsFrIg = new Map<number, string>();
  {
    const ids = uniq(attacheWd.filter(([, t]) => t === "ig").flatMap(([, , v]) => frDe(slugWd.get(v as string) || {}))).filter((x) => x > 0);
    for (let k = 0; k < ids.length; k += 500) {
      const r = await ig.requete("franchises", `fields id,name; where id = (${ids.slice(k, k + 500).join(",")}); limit 500;`);
      const d = json(r.texte);
      if (r.status !== 200 || !Array.isArray(d)) throw new PanneSource(`IGDB (noms des franchises) : HTTP ${r.status}`);
      for (const x of d) if (x && N(x.id) > 0 && x.name) nomsFrIg.set(N(x.id), String(x.name));
    }
  }
  // les mêmes filtres que le parcours AniList : un animé qu'il a écarté reste écarté ; une autre œuvre d'origine (sans le
  // nom de la licence dans son titre) ou une autre franchise Wikidata, écartée ; un jeu dont aucune franchise IGDB n'est
  // celle de la licence (quand la licence en a), écarté
  {
    const sansLib = uniq(attacheWd.filter(([, t]) => t !== "ig").flatMap(([, , , xf]) => xf)).filter((q) => !libelles.has(q));
    for (const [k, v] of await libellesWd(wd, sansLib)) libelles.set(k, v);
  }
  const ecartesParcours = new Map<number, Set<number>>();
  for (const [r0, A] of admis) for (const [v, st] of A) if (!st.admis && st.raison) ajouterA(ecartesParcours, v, racine(r0));
  const srcLicence = new Map<number, Set<number>>();
  for (const [r0, sr] of srcFin) for (const x of sr) ajouterA(srcLicence, racine(r0), x);
  let wdAnimes = 0, wdJeuxN = 0;
  const vusEcartWd = new Set<string>();
  const ecarterWd = (n: Noeud, r: number, raison: string) => {
    const k = `${n.id}:${racine(r)}`;
    if (vusEcartWd.has(k)) return;
    vusEcartWd.add(k);
    diag.exclus.push({ id: n.id, titre: n.titre || "", an: n.an, pop: n.pop, licence: nomL(r), raison: `${raison} (Wikidata)` });
  };
  for (const [r, t, v, xf] of attacheWd) {
    if (t === "al" || t === "mal") {
      const n = t === "al" ? noeuds.get(v as number) || alWd.get(v as number) : malWd.get(v as number);
      if (!n || parAniList.has(n.id)) continue;
      if (ecartesParcours.get(n.id)?.has(racine(r))) continue;
      if (sourceDiff(n, srcLicence.get(racine(r))) && !titreDeLaLicence(n, racine(r))) {
        ecarterWd(n, r, "autre œuvre d'origine");
        continue;
      }
      // sa franchise Wikidata : celle que donne son identifiant AniList, et la sienne (P8345) quand Wikidata la donne
      if (contraireQ(uniq([...(frNoeuds.res.get(n.id) || []), ...xf]), frQRadar(racine(r)), idG[racine(r)])) {
        ecarterWd(n, r, "franchise Wikidata différente");
        continue;
      }
      revendiquer(r, "wd", passeAnime(n));
      wdAnimes++;
    } else {
      const g = slugWd.get(v as string);
      if (!g || parIgdb.has(N(g.id))) continue;
      const frL = frIgLicence(r);
      if (jeuCroise(g, frL)) {
        diag.croises.push({ id: N(g.id), titre: g.name || "", an: anDe(g.first_release_date), licence: nomL(r) });
        continue;
      }
      const frG = frDe(g);
      const nomsG = reduire(frG.map((x) => norm(nomsFrIg.get(x) || "")).filter(Boolean));
      if ((frL.size && frG.length && !frG.some((x) => frL.has(x))) || (!frL.size && nomsG.length && idG[racine(r)].length && !compatibles(nomsG, idG[racine(r)]))) {
        diag.croises.push({ id: N(g.id), titre: g.name || "", an: anDe(g.first_release_date), licence: nomL(r) });
        continue;
      }
      revendiquer(r, "wd", passeJeu(g));
      wdJeuxN++;
    }
  }
  dire(`  Wikidata : ${membres.size} franchise(s) ou série(s) avec des œuvres liées (${wd.n} requêtes en tout)`);

  // 7h. ponts par le nom vers les catalogues : une licence sans franchise ni collection IGDB cherche une franchise ou une
  //     collection IGDB de même nom ; une licence de jeux sans animé cherche un animé AniList dont le titre est le nom, ou
  //     le nom suivi de deux-points ; nom de 2 mots ou de 8 lettres au moins, noms ambigus laissés
  const nomsCatalogue = (m: number[]): string[] => {
    const s = new Set(nomsForts(m));
    for (const i of m) for (const c of cles[i].values()) if (c.t === "igdb-collection" && c.nom) s.add(norm(c.nom));
    for (const i of m) for (const t of [fiches[i].titre, fiches[i].titreVo]) {
      const a = avantDeuxPoints(t);
      if (a && a.split(" ").length >= 2) s.add(a);
    }
    return [...s].filter((n) => n.length >= 4 && nomAssezFort(n));
  };
  const passeAnimes = new Set<number>(), passeJeux = new Set<number>();
  for (const l of revendications.values()) for (const x of l) (x.rep.dom === "anime" ? passeAnimes : passeJeux).add(racine(x.r));
  const aDesAnimes = (r: number, m: number[]): boolean => m.some((i) => fiches[i].dom === "anime") || passeAnimes.has(r);
  const aDesJeux = (r: number, m: number[]): boolean => m.some((i) => fiches[i].dom === "game") || passeJeux.has(r);
  {
    const parSlug = new Map<string, Set<number>>();
    for (const [r, m] of G) {
      if (seulMulti(m) || avecClesIg.has(r)) continue;
      for (const n of nomsCatalogue(m)) for (const s of slugsDe(n)) ajouterA(parSlug, s, r);
    }
    const trouves = new Map<string, { point: string; id: number; nom: string; slug: string; groupes: Set<number> }>();
    for (const point of ["franchises", "collections"]) {
      const l = [...parSlug.keys()];
      for (let k = 0; k < l.length; k += 100) {
        const p = l.slice(k, k + 100);
        let r = await ig.requete(point, `fields id,name,slug; where slug = (${p.map((s) => `"${s}"`).join(",")}); limit 500;`);
        if (r.status === 400) {
          repli(`IGDB ${point} : liste de noms courts refusée, lue en forme ou`);
          r = await ig.requete(point, `fields id,name,slug; where ${p.map((s) => `slug = "${s}"`).join(" | ")}; limit 500;`);
        }
        const d = json(r.texte);
        if (r.status !== 200 || !Array.isArray(d)) throw new PanneSource(`IGDB ${point} : HTTP ${r.status}`);
        for (const x of d) if (x && N(x.id) > 0 && parSlug.has(String(x.slug))) trouves.set(`${point}:${N(x.id)}`, { point, id: N(x.id), nom: x.name || x.slug, slug: String(x.slug), groupes: parSlug.get(String(x.slug)) as Set<number> });
      }
    }
    // le jeu qui porte le nom même de la franchise ou de la collection trouvée : IGDB ne l'y range pas toujours (la
    // franchise « Ghost of Tsushima » n'a que « Ghost of Tsushima: Legends », le jeu « Ghost of Tsushima » est seulement
    // dans la série « Ghost ») ; il est ajouté à ses jeux
    const jeuDuNom = new Map<string, any>();
    {
      const sl = uniq([...trouves.values()].map((t) => t.slug));
      for (let k = 0; k < sl.length; k += 100) for (const g of await jeuxParSlugs(sl.slice(k, k + 100))) if (g && g.slug) jeuDuNom.set(String(g.slug), g);
    }
    for (const t of trouves.values()) {
      if (t.groupes.size !== 1) {
        diag.pontsCatalogue.push({ licence: [...t.groupes].map(nomL).join(" / "), sens: "igdb", nom: t.nom, ajoutes: 0, ambigu: true });
        continue;
      }
      const r = [...t.groupes][0];
      const k = (t.point === "franchises" ? "f" : "c") + t.id;
      if ([...(groupesIg.get(k) || [])].some((x) => x !== r)) {
        diag.pontsCatalogue.push({ licence: nomL(r), sens: "igdb", nom: t.nom, ajoutes: 0, ambigu: true });
        continue;
      }
      const l0 = t.point === "franchises" ? await jeuxFranchise(t.id) : await jeuxCollection(t.id);
      const g0 = jeuDuNom.get(t.slug);
      const l = g0 && !l0.some((g) => N(g.id) === N(g0.id)) ? [...l0, g0] : l0;
      let ajoutes = 0;
      for (const g of l) {
        if (parIgdb.has(N(g.id))) {
          lienRadar("nom", r, racine(parIgdb.get(N(g.id)) as number));
          continue;
        }
        if (jeuCroise(g, t.point === "franchises" ? new Set([t.id]) : frIgLicence(r))) {
          diag.croises.push({ id: N(g.id), titre: g.name || "", an: anDe(g.first_release_date), licence: nomL(r) });
          continue;
        }
        revendiquer(r, "nom-igdb", passeJeu(g));
        ajoutes++;
      }
      diag.pontsCatalogue.push({ licence: nomL(r), sens: "igdb", nom: t.nom, ajoutes });
    }
    // jeux -> AniList (les licences les plus populaires d'abord)
    const parNomA = new Map<string, Set<number>>();
    for (const [r, m] of G) {
      if (seulMulti(m) || aDesAnimes(r, m) || !aDesJeux(r, m)) continue;
      for (const n of nomsCatalogue(m)) ajouterA(parNomA, n, r);
    }
    const popNom = (n: string): number => Math.max(0, ...[...(parNomA.get(n) || [])].map((r) => popJeuG.get(r) || 0));
    const noms = [...parNomA.keys()].sort((a, b) => popNom(b) - popNom(a) || a.localeCompare(b)).slice(0, regles.nomsMax);
    if (noms.length) {
      dire(`  recherche AniList de ${noms.length} nom(s) de licences de jeux`);
      const res = await al.chercher(noms, CHAMPS_AL);
      const vus = new Set<string>();
      for (const [n, l] of res) {
        const ok = l.filter((x: any) => titreDuNom(x.title?.english, n) || titreDuNom(x.title?.romaji, n));
        if (!ok.length) continue;
        const gs = parNomA.get(n) as Set<number>;
        if (gs.size !== 1) {
          diag.pontsCatalogue.push({ licence: [...gs].map(nomL).join(" / "), sens: "anilist", nom: n, ajoutes: 0, ambigu: true });
          continue;
        }
        const r = [...gs][0];
        let ajoutes = 0;
        for (const x of ok) {
          const nd = noeudAl(x);
          if (vus.has(r + ":" + nd.id)) continue;
          vus.add(r + ":" + nd.id);
          if (parAniList.has(nd.id)) {
            lienRadar("nom", r, racine(parAniList.get(nd.id) as number));
            continue;
          }
          revendiquer(r, "nom-anilist", passeAnime(nd));
          ajoutes++;
        }
        if (ajoutes) diag.pontsCatalogue.push({ licence: nomL(r), sens: "anilist", nom: n, ajoutes });
      }
    }
  }

  // ── 8. chaque œuvre du passé à une seule licence : la revendication la plus forte ; à égalité entre licences, à aucune
  const valideA = (x: Passe): boolean => !!x.an && x.an < AN && !x.adulte && FORMATS_REPERE.has(String(x.format)) && STATUTS_SORTIS.has(String(x.statut));
  const valideJ = (x: Passe): boolean => !!x.an && x.an < AN && !x.version && x.typeOk !== false && x.statutOk !== false;
  const passeDe = new Map<number, Array<{ rep: Passe; src: string }>>();
  for (const [, l0] of revendications) {
    const parR = new Map<number, { src: string; rep: Passe }>();
    for (const x of l0) {
      const r = racine(x.r);
      const avant = parR.get(r);
      if (!avant || FORCE_SOURCE[x.src] < FORCE_SOURCE[avant.src]) parR.set(r, { src: x.src, rep: x.rep });
    }
    const l = [...parR.entries()];
    const fmin = Math.min(...l.map(([, x]) => FORCE_SOURCE[x.src]));
    const gs = l.filter(([, x]) => FORCE_SOURCE[x.src] === fmin);
    if (gs.length > 1) {
      const rep = gs[0][1].rep;
      if (rep.dom === "anime" ? valideA(rep) : valideJ(rep)) diag.partages.push({ dom: rep.dom, id: rep.id, titre: rep.titre || "", licences: gs.map(([r]) => nomL(r)) });
      continue;
    }
    pousser(passeDe, gs[0][0], gs[0][1]);
  }

  // ── 9. le résultat, licence par licence
  const origineAnime = (f: FicheSite): Origine | null => {
    const x = f.anilist ? radarAl.get(f.anilist) : undefined;
    if (!x || !x.source || ORIGINES_SANS.has(x.source)) return null;
    const k = meilleureSource(x.source, x.rel);
    const src = k >= 0 ? x.rel[k] : null;
    return { type: x.source, titre: src ? src.titre : null, auteurs: f.anilist ? auteurs.get(f.anilist) || [] : [] };
  };
  // le nom d'une licence sans franchise (Rey, 22 octobre) : l'œuvre d'origine de son œuvre la plus populaire, animé du
  // radar ou de son passé (« Bungo Stray Dogs » et pas « Bungo Stray Dogs: Wan! ») ; sans œuvre d'origine, le titre de
  // cet animé ; une licence qui a une franchise (Wikidata, IGDB, ou celle de son passé) garde son nom
  // (avec le titre japonais de l'œuvre elle-même : sans la lecture de ses sources, le même nom)
  const principales = new Map<number, { id: number; pop: number; radar: boolean; titre: string | null; romaji: string | null }>();
  for (const [r, m] of G) {
    if (seulMulti(m) || libelleRang(m, r).rang >= 4) continue;
    let best: { id: number; pop: number; radar: boolean; titre: string | null; romaji: string | null } | null = null;
    for (const i of m) {
      const f = fiches[i];
      const x = f.dom === "anime" && f.anilist ? radarAl.get(f.anilist) : undefined;
      // une fiche du radar : son titre sur le site, d'abord
      if (x && (!best || x.pop > best.pop)) best = { id: f.anilist as number, pop: x.pop, radar: true, titre: f.titre || x.titre || null, romaji: x.romaji };
    }
    for (const x of passeDe.get(r) || []) if (x.rep.dom === "anime" && (!best || x.rep.pop > best.pop)) best = { id: x.rep.id, pop: x.rep.pop, radar: false, titre: x.rep.titre, romaji: noeuds.get(x.rep.id)?.romaji ?? null };
    if (best) principales.set(r, best);
  }
  const sourcesPrincipales = new Map<number, RadarAl>();
  const aLireNoms = uniq([...principales.values()].filter((p) => !p.radar).map((p) => p.id));
  if (aLireNoms.length) {
    try {
      for (const x of await al.parLots(REQ_SOURCES, aLireNoms, 25)) sourcesPrincipales.set(N(x.id), lireRadarAl(x));
    } catch (e) {
      // une requête refusée (sa forme) : les titres donnent les noms ; une panne d'AniList : rien n'est écrit, comme ailleurs
      if (!(e instanceof RefusRequete)) throw e;
      repli(`AniList : œuvres d'origine des œuvres principales non lues (${String((e as Error).message).slice(0, 80)}) : leurs titres donnent les noms`);
    }
  }
  const nomPrincipal = (r: number): string | null => {
    const p = principales.get(r);
    if (!p) return null;
    const x = p.radar ? radarAl.get(p.id) : sourcesPrincipales.get(p.id);
    const k = x ? meilleureSource(x.source, x.rel) : -1;
    // le titre de l'œuvre d'origine (sans elle, celui de cet animé), coupé aux deux-points devant un vrai nom seulement :
    // « Mission: Yozakura Family » entier, « Tougen Anki: Legend of the Cursed Blood » -> « Tougen Anki »,
    // « Frieren: Beyond Journey's End » -> « Frieren », « Mononoke The Movie: … » -> « Mononoke »
    const src = x && k >= 0 && x.rel[k].titre ? x.rel[k] : null;
    const t = src ? src.titre : p.titre;
    return t ? nomDeTitre(String(t), true, src ? src.romaji : x?.romaji || p.romaji) : null;
  };
  // les noms : celui de l'œuvre principale, sauf s'il est déjà celui d'une autre licence (« Initial D » pour MF Ghost
  // quand une licence de jeux s'appelle déjà « Initial D ») : alors celui de la règle d'avant
  const nomsAvant = new Map<number, string>(), nomsP = new Map<number, string>(), nomsFin = new Map<number, string>();
  for (const [r, m] of G) {
    const estMulti = seulMulti(m);
    nomsAvant.set(r, estMulti ? fiches[m[0]].titre || fiches[m[0]].titreVo || "(sans titre)" : libelle(m, r));
    const p = estMulti ? null : nomPrincipal(r);
    if (p && p !== nomsAvant.get(r)) nomsP.set(r, p);
  }
  for (const [r, n] of nomsAvant) nomsFin.set(r, nomsP.get(r) || n);
  for (let tour = 0; tour < 5; tour++) {
    const compte = new Map<string, number>();
    for (const n of nomsFin.values()) compte.set(norm(n), (compte.get(norm(n)) || 0) + 1);
    let change = false;
    for (const [r, p] of nomsP) if (nomsFin.get(r) === p && (compte.get(norm(p)) || 0) > 1) {
      nomsFin.set(r, nomsAvant.get(r) as string);
      change = true;
    }
    if (!change) break;
  }
  const nomDeFiche = new Map<number, string>();
  const licences: LicenceCalculee[] = [];
  for (const [r, m] of G) {
    const estMulti = seulMulti(m);
    const directsLic = new Set<string>();
    const directsListe: DirectCalcule[] = [];
    const reperesLic: RepereCalcule[] = [];
    const vusRep = new Set<string>();
    const passes = passeDe.get(r) || [];
    const parCleRep = new Map(passes.map((x) => [(x.rep.dom === "anime" ? "a:" : "j:") + x.rep.id, x]));
    for (const i of m) for (const [k, nature] of directs.get(i) || []) {
      const x = parCleRep.get(k);
      if (!x || !(x.rep.dom === "anime" ? valideA(x.rep) : valideJ(x.rep))) continue;
      directsLic.add(k);
      directsListe.push({ dom: fiches[i].dom, id: fiches[i].id, source: x.rep.dom === "anime" ? "anilist" : "igdb", sourceId: x.rep.id, nature });
    }
    for (const x of passes) {
      const k = (x.rep.dom === "anime" ? "a:" : "j:") + x.rep.id;
      if (vusRep.has(k)) continue;
      const rep = x.rep;
      if (!(rep.dom === "anime" ? valideA(rep) : valideJ(rep))) continue;
      const seuil = rep.dom === "anime" ? SEUILS.bas.al : SEUILS.bas.ig;
      if (rep.pop < seuil && !directsLic.has(k)) continue;
      vusRep.add(k);
      reperesLic.push({
        source: rep.dom === "anime" ? "anilist" : "igdb", id: rep.id, dom: rep.dom, titre: String(rep.titre || "").slice(0, 300), format: rep.format,
        annee: rep.an as number, pop: rep.pop,
        principal: rep.dom === "anime" ? FORMATS_PRINCIPAUX.has(String(rep.format)) && !compilations.has(rep.id) : !/remaster|expanded/i.test(String(rep.format || "")),
        par: x.src,
      });
    }
    const membresL: MembreCalcule[] = m.map((i) => ({ dom: fiches[i].dom, id: fiches[i].id, par: marques.get(i) || parFiche.get(i) || (m.length > 1 ? "relation" : "seule"), origine: fiches[i].dom === "anime" ? origineAnime(fiches[i]) : null }));
    // l'origine de la licence (pour ses fiches de jeu) : celle de son animé du radar le plus populaire, d'après un livre
    let origine: Origine | null = null;
    for (const i of [...m].filter((j) => fiches[j].dom === "anime").sort((a, b) => fiches[b].pop - fiches[a].pop)) {
      const o = origineAnime(fiches[i]);
      if (o && ORIGINES_LIVRES.has(o.type)) {
        origine = o;
        break;
      }
    }
    // les clés d'identité
    const ck = new Set<string>();
    for (const i of m) {
      ck.add(`f:${fiches[i].dom}:${fiches[i].id}`);
      if (!estMulti) for (const c of cles[i].values()) {
        if (c.t === "wd-franchise" && c.k.startsWith("wd:")) ck.add("wdf:" + c.k.slice(3));
        else if ((c.t === "wd-serie" || c.t === "wd-serie-igdb") && c.k.startsWith("wd:")) ck.add("wds:" + c.k.slice(3));
        else if (c.t === "igdb-franchise") ck.add(c.k);
        else if (c.t === "igdb-collection") ck.add(c.k);
        else if (c.t === "anilist-origine") ck.add(c.k);
      }
      if (fiches[i].anilist) ck.add("al:" + fiches[i].anilist);
      if (fiches[i].igdb) ck.add("ig:" + fiches[i].igdb);
    }
    for (const [q, k] of frPasse.get(r) || []) if (k >= 2) ck.add("wdf:" + q);
    for (const s of srcFin.get(r) || []) ck.add("als:" + s);
    for (const x of reperesLic.slice(0, 200)) ck.add((x.dom === "anime" ? "al:" : "ig:") + x.id);
    const nomAvant = nomsAvant.get(r) as string;
    const nom = nomsFin.get(r) || nomAvant;
    if (nom !== nomAvant) diag.nomsPrincipaux.push({ avant: nomAvant, nom, pop: Math.max(0, ...m.map((i) => fiches[i].pop)), sorties: m.length + reperesLic.length });
    for (const i of m) nomDeFiche.set(i, nom);
    licences.push({
      cle: "r" + r,
      nom,
      membres: membresL,
      reperes: reperesLic,
      directs: directsListe,
      cles: [...ck].slice(0, 400),
      origine,
      pop: Math.max(0, ...m.map((i) => fiches[i].pop)),
      multi: estMulti,
      ...(nom !== nomAvant ? { nomRepli: nomAvant } : {}),
    });
  }
  // les refus qui tiennent : deux fiches réunies quand même par un autre chemin ne sont pas un refus. Un refus du contrôle
  // des origines (règles 7) a pour identifiant la clé et les œuvres d'origine des deux licences (le même d'une saison à
  // l'autre, quelle que soit la fiche en tête) ; les autres, la paire de fiches. Une ligne par identifiant et par raison.
  const vusRefus = new Set<string>();
  const sigOrigines = (i: number): string => [...origG[racine(i)]].sort((p, q) => p - q).join(",");
  // les paires (clé, œuvre d'origine de chaque côté) d'un refus du contrôle : un refus n'est « nouveau » que si aucune
  // n'était notée (une suite d'un autre manga qui entre ou sort du radar ne le fait pas revenir)
  const pairesOrigines = (k: string, a: number, b: number): string[] => {
    const out: string[] = [];
    for (const u of origG[racine(a)]) for (const v of origG[racine(b)]) out.push(`${k}|${Math.min(u, v)}|${Math.max(u, v)}`);
    return out;
  };
  diag.refuses = refuses.filter((x) => racine(x.a) !== racine(x.b)).map((x) => ({
    lien: x.t, cle: x.cle, a: asc(fiches[x.a].titre || ""), b: asc(fiches[x.b].titre || ""), origine: !!x.origine,
    id: x.origine && x.k ? `${x.k}|${[sigOrigines(x.a), sigOrigines(x.b)].sort().join("|")}` : [x.a, x.b].map((i) => `${fiches[i].dom}:${fiches[i].id}`).sort().join("|"),
    paires: x.origine && x.k ? pairesOrigines(x.k, x.a, x.b) : [],
  })).filter((x) => !vusRefus.has(`${x.id} ${x.cle}`) && !!vusRefus.add(`${x.id} ${x.cle}`));
  // le diagnostic suit les noms définitifs (il a été écrit en route, avec les noms d'alors) : un nom donné en route
  // devient celui de la licence qui a pris ses fiches (réunions, nom de l'œuvre principale) ; porté en route par des
  // licences qui ont fini sous des noms différents, il reste tel quel. Deux licences réunies depuis ne sont plus «
  // reliées, laissées séparées ».
  const nouveau = (n: string): string => {
    const f = nomsDits.get(n);
    if (!f) return n;
    const fin = new Set([...f].map((i) => nomDeFiche.get(i) || n));
    return fin.size === 1 ? [...fin][0] : n;
  };
  {
    const garder = relieesIdx.map((x) => racine(x.a) !== racine(x.b));
    diag.reliees = diag.reliees.filter((_, k) => garder[k] !== false);
  }
  for (const l of [diag.exclus, diag.forts, diag.croises, diag.pontsCatalogue] as Array<Array<{ licence: string }>>) for (const x of l) x.licence = nouveau(x.licence);
  for (const l of [diag.egaux, diag.partages] as Array<Array<{ licences: string[] }>>) for (const x of l) x.licences = x.licences.map(nouveau);
  for (const x of diag.reliees) {
    x.a = nouveau(x.a);
    x.b = nouveau(x.b);
  }

  return {
    annee: AN,
    licences,
    diag,
    replis,
    comptes: {
      fiches: fiches.length, animes: fiches.filter((f) => f.dom === "anime").length, jeux: fiches.filter((f) => f.dom === "game").length,
      anilistLus: radarAl.size, igdbLus: radarIg.size, noeuds: noeuds.size, profondeur: comptesParcours.profondeur, arretParcours: comptesParcours.arret,
      nonLus: comptesParcours.nonLus, jeuxPasse: jeuxPasse.size, wdAnimes, wdJeux: wdJeuxN,
    },
  };
}

// ─────────────────────────────────────────────────────────────── le bloc d'une fiche

export interface RepereBloc {
  source: "anilist" | "igdb";
  id: number;
  dom: Dom;
  titre: string;
  format: string | null;
  annee: number;
  pop: number;
  principal: boolean;
}

/**
 * Les repères du bloc d'une fiche (décisions de Rey, 22 octobre) : 4 au plus ; une sortie du même type que la fiche au
 * seuil moyen, de l'autre type au seuil bas, un lien direct toujours ; 2 animés et 2 jeux quand il y a des deux ; les
 * œuvres principales d'abord, les liens directs de la fiche en tête (2 au plus en tout), puis du plus récent au plus
 * ancien (à année égale, le plus populaire). Rendus dans l'ordre du temps.
 */
export function choisirReperes(dom: Dom, reperes: RepereBloc[], directs: Set<string>): Array<RepereBloc & { direct: boolean }> {
  const cle = (x: RepereBloc) => `${x.source}:${x.id}`;
  const passe = reperes.filter((x) => {
    if (directs.has(cle(x))) return true;
    const S = x.dom === dom ? SEUILS.moyen : SEUILS.bas;
    return x.pop >= (x.dom === "anime" ? S.al : S.ig);
  });
  // les 2 liens directs prioritaires : les œuvres principales d'abord, puis les plus récents
  const dirs = passe.filter((x) => directs.has(cle(x))).sort((a, b) => Number(b.principal) - Number(a.principal) || b.annee - a.annee || b.pop - a.pop).slice(0, 2);
  const prio = new Set(dirs.map(cle));
  const ordre = [...passe].sort((a, b) =>
    Number(b.principal) - Number(a.principal) || Number(prio.has(cle(b))) - Number(prio.has(cle(a))) || b.annee - a.annee || b.pop - a.pop || a.titre.localeCompare(b.titre));
  const a = ordre.filter((x) => x.dom === "anime"), j = ordre.filter((x) => x.dom === "game");
  let pris: RepereBloc[];
  if (a.length && j.length) {
    const na = Math.min(a.length, Math.max(2, REPERES_BLOC - j.length));
    const nj = Math.min(j.length, REPERES_BLOC - na);
    pris = [...a.slice(0, na), ...j.slice(0, nj)];
  } else pris = ordre.slice(0, REPERES_BLOC);
  return pris.map((x) => ({ ...x, direct: directs.has(cle(x)) })).sort((x, y) => x.annee - y.annee || x.titre.localeCompare(y.titre));
}

/** Mesures d'un ensemble de licences (garde-fou, bilan) : licences de 2 sorties ou plus, fiches dont le bloc montre
 * quelque chose, repères, licences qui mêlent animés et jeux. */
export function mesurer(licences: Array<{ membres: Array<{ dom: Dom; id: number }>; reperes: RepereBloc[]; directs: Array<{ dom: Dom; id: number; source: string; sourceId: number }> }>): { licences2: number; blocs: number; reperes: number; croisees: number; reperesAnimes: number; reperesJeux: number } {
  let licences2 = 0, blocs = 0, reperes = 0, croisees = 0, reperesAnimes = 0, reperesJeux = 0;
  for (const l of licences) {
    reperes += l.reperes.length;
    for (const x of l.reperes) if (x.dom === "anime") reperesAnimes++;
    else reperesJeux++;
    if (l.membres.length + l.reperes.length >= 2) licences2++;
    const a = l.membres.some((x) => x.dom === "anime") || l.reperes.some((x) => x.dom === "anime");
    const j = l.membres.some((x) => x.dom === "game") || l.reperes.some((x) => x.dom === "game");
    if (a && j) croisees++;
    for (const f of l.membres) {
      if (l.membres.length > 1) {
        blocs++;
        continue;
      }
      const d = new Set(l.directs.filter((x) => x.dom === f.dom && x.id === f.id).map((x) => `${x.source}:${x.sourceId}`));
      if (choisirReperes(f.dom, l.reperes, d).length) blocs++;
    }
  }
  return { licences2, blocs, reperes, croisees, reperesAnimes, reperesJeux };
}
