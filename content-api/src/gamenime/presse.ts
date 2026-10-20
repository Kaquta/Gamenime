/**
 * presse.ts — Les diffusions annoncées en France, lues dans la presse.
 *
 * AniList ne dit ni où ni quand un anime sort en France (il ne connaît même pas
 * ADN). La presse, si : « en simulcast sur ADN le 11 octobre à 18 h ». Ce module
 * lit Gameblog (plan du site + texte de l'article), LevelUp (flux RSS, texte
 * complet), ADN News et Crunchyroll News (flux RSS, texte complet), AnimOtaku, Manga-News et Anime News
 * Network (flux RSS, puis la page des articles qui citent un anime du site), en
 * respectant le robots.txt de chaque site. Il garde les articles qui parlent
 * franchement d'un anime du site et d'une plateforme, fait extraire par Ollama les
 * diffusions annoncées, puis VÉRIFIE chaque réponse contre le texte. Dans le doute,
 * rien n'est gardé :
 *   - la phrase citée existe dans l'article, et parle de cet anime et de cette plateforme ;
 *   - le pays est écrit dans la phrase (ou, sur un site français, aucun autre pays n'y est) ;
 *   - la date et l'heure sont écrites dans la phrase ; l'heure n'est gardée qu'à l'heure française ;
 *   - une suite (saison 2…) n'est gardée que si l'article parle de cette saison ;
 *   - une adaptation en prises de vues réelles (live-action, drama) n'est jamais gardée.
 *
 * Tables : presse_articles (articles déjà lus), annonces_fr (diffusions gardées,
 * avec leur source). Rien d'autre n'est modifié.
 *
 * Variables :
 *   PRESSE_ENABLED           « 1 » pour activer (sinon le module ne fait rien)
 *   PRESSE_MAX_PAR_PASSAGE   articles envoyés à Ollama par passage (défaut 4)
 *   PRESSE_JOURS             jours de Gameblog relus à chaque passage (défaut 3)
 *   OLLAMA_URL, SYNOPSIS_MODEL, SYNOPSIS_THREADS : les mêmes que les synopsis
 *     (mêmes num_ctx et num_thread : Ollama garde le modèle chargé)
 *   PRESSE_GAMEBLOG_URL, PRESSE_LEVELUP_URL, PRESSE_ADN_URL, PRESSE_ANIMOTAKU_URL,
 *   PRESSE_MANGANEWS_URL, PRESSE_ANN_URL, PRESSE_CRUNCHYROLL_URL : seulement pour les tests
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { planifier } from "./pilotage.js";

// ─────────────────────────────────────────────────────────────── types
export interface SqlPool {
  query: (sql: string, params?: unknown[]) => Promise<any>;
}
export interface Journal {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
export interface PresseDeps {
  pool: SqlPool;
  log: Journal;
}
export interface PresseConfig {
  ollamaUrl: string;
  modele: string;
  coeurs: number;
  maxParPassage: number;
  jours: number;
  gameblog: string;
  levelup: string;
  adn: string;
  animotaku: string;
  manganews: string;
  ann: string;
  crunchyroll: string; // le service des news de Crunchyroll (flux RSS par langue)
}
export interface Alias {
  forme: string;
  complet: boolean;
}
export interface AnimeCat {
  id: number;
  title: string;
  titleEnglish: string | null;
  platform: string | null;
  popularity: number;
  format: string | null;
  alias: Alias[];
  saison: number;
}
export interface Cite {
  it: AnimeCat;
  forme: string;
  complet: boolean;
}
export interface Article {
  url: string;
  source: string;
  langue: "fr" | "en" | "es";
  titre: string;
  texte: string;
  publie: string; // ISO
  impose?: boolean;
  officielle?: boolean; // source officielle de la plateforme (ADN News) : lue en premier
}
export interface Plateforme {
  nom: string;
  re: RegExp; // sur le texte normalisé
  brut?: RegExp; // en plus, sur le texte d'origine (casse, signes)
  exigeDate?: boolean; // le cinéma ne compte qu'avec une date dans la phrase
  horsFrance?: boolean; // n'existe pas en France : jamais gardée pour la France
  site: string | null; // nom dans la liste blanche du site, sinon null
}
export interface Verdict {
  statut: "garde" | "hors_france" | "rejete";
  raison: string;
  anime: AnimeCat | null;
  plateforme: Plateforme | null;
  pays: string; // FR, EUROPE, MONDE, ou ce que l'article dit
  date: string | null;
  heure: string | null;
  phrase: string;
  notes: string[];
  demande: string; // ce qu'Ollama a répondu (plateforme · anime), pour les journaux et l'essai
}

const AGENT = "GameNimeBot/1.0 (+https://gamenime.fr)";
const NUM_CTX = 5120; // comme les synopsis : pas de rechargement du modèle
const NUM_PREDICT = 800;
const OLLAMA_DELAI_MS = 15 * 60 * 1000; // Ollama traite une demande à la fois : on peut attendre la fin d'un synopsis
const PREMIER_PASSAGE_MS = 3 * 60 * 1000;
const PASSAGE_MS = 60 * 60 * 1000;
const MAX_PAGES_GAMEBLOG = 25;

export function lireConfig(env: Record<string, string | undefined> = process.env): PresseConfig | null {
  if (env["PRESSE_ENABLED"] !== "1") return null;
  return configEssai(env);
}
export function configEssai(env: Record<string, string | undefined> = process.env): PresseConfig {
  const entier = (v: string | undefined, def: number, min: number, max: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  return {
    ollamaUrl: (env["OLLAMA_URL"] || "http://ollama:11434").replace(/\/+$/, ""),
    modele: env["SYNOPSIS_MODEL"] || "ministral-3:8b",
    coeurs: entier(env["SYNOPSIS_THREADS"], 4, 1, 64),
    maxParPassage: entier(env["PRESSE_MAX_PAR_PASSAGE"], 4, 1, 20),
    jours: entier(env["PRESSE_JOURS"], 3, 1, 30),
    gameblog: (env["PRESSE_GAMEBLOG_URL"] || "https://www.gameblog.fr").replace(/\/+$/, ""),
    levelup: (env["PRESSE_LEVELUP_URL"] || "https://www.levelup.com").replace(/\/+$/, ""),
    adn: (env["PRESSE_ADN_URL"] || "https://news.animationdigitalnetwork.com/fr").replace(/\/+$/, ""),
    animotaku: (env["PRESSE_ANIMOTAKU_URL"] || "https://animotaku.fr").replace(/\/+$/, ""),
    manganews: (env["PRESSE_MANGANEWS_URL"] || "https://www.manga-news.com").replace(/\/+$/, ""),
    ann: (env["PRESSE_ANN_URL"] || "https://www.animenewsnetwork.com").replace(/\/+$/, ""),
    crunchyroll: (env["PRESSE_CRUNCHYROLL_URL"] || "https://cr-news-api-service.prd.crunchyrollsvc.com").replace(/\/+$/, ""),
  };
}

// ─────────────────────────────────────────────────────────────── texte
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const coupe = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const jjmmaaaa = (iso: string | null | undefined) =>
  iso && iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "?";

async function lire(url: string, gz = false, timeout = 25000): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": AGENT, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!gz) return await r.text();
  const brut = Buffer.from(await r.arrayBuffer());
  try {
    return zlib.gunzipSync(brut).toString("utf8");
  } catch {
    return brut.toString("utf8"); // déjà décompressé en route
  }
}

const ENTITES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", hellip: "…", laquo: "«", raquo: "»", ndash: "–", mdash: "—", eacute: "é", egrave: "è",
  ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ucirc: "û",
  ugrave: "ù", euml: "ë", oelig: "œ", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ",
};
export function decoder(s: string): string {
  return String(s || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITES[e.toLowerCase()] ?? m;
  });
}
/** Texte lisible : un paragraphe (ou une ligne de liste, précédée de « • ») par ligne. */
export function enTexte(html: string): string {
  return decoder(
    String(html || "")
      .replace(/<(script|style|figure|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
/** Forme de comparaison : minuscules, sans accents, mots séparés par une espace. */
export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export const contient = (texteNorm: string, motif: string) => !!motif && (" " + texteNorm + " ").includes(" " + motif + " ");
const occurrences = (texteNorm: string, motif: string) => (" " + texteNorm + " ").split(" " + motif + " ").length - 1;
export const empreinte = (url: string) => createHash("sha1").update(url).digest("hex");

/** Découpe une ligne en phrases, sans couper après « No. », « M. », « Vol. »… ni avant un chiffre. */
const ABREVIATIONS = /(?:^|[\s(])(?:no|n°|nº|dr|mr|mrs|ms|m|mme|mlle|vol|ep|st|vs|etc|jr|sr|inc|ltd|co|p|pp|fig|cf|ex|env|av|apr|t)\.$/i;
export function decouperPhrases(ligne: string): string[] {
  const out: string[] = [];
  let debut = 0;
  const fin = /[.!?…]+(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = fin.exec(ligne))) {
    const bout = m.index + m[0].length;
    const morceau = ligne.slice(debut, bout);
    const suite = ligne.slice(bout).trimStart();
    if (m[0] === "." && ABREVIATIONS.test(morceau)) continue;
    if (/^\d/.test(suite)) continue;
    if (morceau.trim()) out.push(morceau.trim());
    debut = bout;
  }
  const reste = ligne.slice(debut).trim();
  if (reste) out.push(reste);
  return out;
}

// ─────────────────────────────────────────────────────────────── plateformes
// ADN : en capitales, et pas « l'ADN de la série » (l'ADN, son ADN, el ADN…).
const ADN_BRUT = /(?<![lLdDsS][’'])(?<!\b(?:[Ss]on|[Ss]a|[Ss]es|[Ll]eurs?|[Nn]otre|[Vv]otre|[Ee]l|[Dd]el|[Ss]us?|[Uu]ne?|[Tt]he|[Ii]ts|[Tt]heir|[Oo]ur|[Yy]our|[Mm]on|[Tt]on)\s)\bADN\b|Animation Digital Network|Anime Digital Networks?/;
export const PLATEFORMES: Plateforme[] = [
  { nom: "ADN", re: /\b(adn|animation digital network|anime digital networks?)\b/, brut: ADN_BRUT, site: "ADN" },
  { nom: "Crunchyroll", re: /\bcrunchyroll\b/, site: "Crunchyroll" },
  { nom: "Netflix", re: /\bnetflix\b/, site: "Netflix" },
  { nom: "Prime Video", re: /\b(prime video|amazon prime( video)?|amazon video)\b/, site: "Amazon Prime Video" },
  { nom: "Disney+", re: /\bdisney( plus)?\b/, brut: /Disney\s?\+|Disney Plus/i, site: "Disney+" },
  { nom: "HIDIVE", re: /\bhidive\b/, horsFrance: true, site: "HIDIVE" },
  { nom: "Hulu", re: /\bhulu\b/, horsFrance: true, site: "Hulu" },
  { nom: "U-Next", re: /\bu next\b/, horsFrance: true, site: null },
  { nom: "HBO Max", re: /\bhbo( max)?\b/, site: "HBO Max" },
  { nom: "MANGAS (télé)", re: /\bmangas\b/, brut: /\bMANGAS\b/, site: null },
  { nom: "J-One (télé)", re: /\bj one\b/, site: null },
  { nom: "Game One (télé)", re: /\bgame one\b/, site: null },
  { nom: "Cinéma", re: /\b(cinema|cinemas|au cine|en salles?|theaters?|theatres?|cines)\b/, exigeDate: true, site: null },
];
const MOTS_PLATEFORME = /\b(adn|animation digital network|crunchyroll|netflix|prime video|amazon prime|disney|hidive|hulu|hbo max|simulcast|vostfr|en salles?|au cinema|theaters|theatres|theatrical)\b/;

/** La plateforme qu'Ollama a nommée (son nom à lui, comparé sans casse ni accents). */
export function plateformeDe(nom: string): Plateforme | null {
  const n = norm(nom);
  if (!n) return null;
  return PLATEFORMES.find((p) => p.re.test(" " + n + " ")) ?? null;
}

// ─────────────────────────────────────────────────────────────── dates, heures, pays
const MOIS: Record<string, string[]> = {
  fr: ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"],
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  abr: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sept", "oct", "nov", "dec"],
};
const TOUS_MOIS = [...new Set(Object.values(MOIS).flat())].join("|");
/** Une date écrite : « 11 octobre », « 11 de octubre », « October 11 », « Oct 11 ». */
const UNE_DATE = new RegExp(`\\b(\\d{1,2}(er)? (de )?(${TOUS_MOIS})|(${TOUS_MOIS}) \\d{1,2})\\b`);

/** Le jour et le mois de la date sont-ils écrits dans ce texte (normalisé ; « brut » pour l'anglais « May ») ? */
export function dateDansTexte(iso: string, texteNorm: string, brut = ""): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return false;
  const mois = parseInt(m[2]!, 10), jour = parseInt(m[3]!, 10);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return false;
  const j = String(jour);
  const motifs: string[] = [];
  for (const [langue, liste] of Object.entries(MOIS)) {
    const mo = liste[mois - 1]!;
    if (mo === "may" && (langue === "en" || langue === "abr")) continue; // « may » est aussi un verbe : vu à part
    motifs.push(`${j} ${mo}`, `${j} de ${mo}`, `${mo} ${j}`);
    if (jour === 1) motifs.push(`1er ${mo}`);
  }
  motifs.push(`${String(jour).padStart(2, "0")} ${String(mois).padStart(2, "0")}`);
  if (motifs.some((x) => contient(texteNorm, x))) return true;
  return mois === 5 && new RegExp(`\\bMay\\.?\\s+${j}\\b|\\b${j}(st|nd|rd|th)?\\s+May\\b`).test(brut);
}
/** L'année écrite juste après le jour et le mois (« 11 octobre 2026 », « October 11, 2026 »), sinon 0. */
export function anneeEcrite(iso: string, texteNorm: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return 0;
  const mois = parseInt(m[2]!, 10), j = String(parseInt(m[3]!, 10));
  for (const liste of Object.values(MOIS)) {
    const mo = liste[mois - 1]!;
    for (const motif of [`${j} ${mo}`, `${j} de ${mo}`, `${mo} ${j}`, `1er ${mo}`]) {
      const r = new RegExp(`(?:^| )${motif} (?:de |del )?(20\\d\\d)\\b`).exec(texteNorm);
      if (r) return parseInt(r[1]!, 10);
    }
  }
  return 0;
}
/** Sans année écrite : la première occurrence de ce jour et ce mois à partir de la publication (moins 3 jours). */
export function anneeProbable(iso: string, publieIso: string): number {
  const p = Date.parse(publieIso || new Date().toISOString());
  const base = new Date(Number.isFinite(p) ? p : Date.now());
  const y = base.getUTCFullYear();
  const md = iso.slice(5, 10);
  const candidat = Date.parse(`${y}-${md}T12:00:00Z`);
  return Number.isFinite(candidat) && candidat >= base.getTime() - 3 * 86400000 ? y : y + 1;
}
/** L'heure est-elle écrite ? « 18h », « 18 h 30 », « 18:00 », « à 18 heures » (« 17 heures de jeu » ne compte pas). */
export function heureDansTexte(hhmm: string, texteNorm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return false;
  const h = parseInt(m[1]!, 10), mn = m[2]!;
  if (h > 23) return false;
  const motifs = [`${h}h${mn}`, `${h} h ${mn}`, `${h} ${mn}`];
  if (mn === "00") {
    motifs.push(`${h}h`, `${h} h`);
    for (const avant of ["a", "des", "vers", "partir de", "las", "at", "from"]) for (const unite of ["heures", "horas", "hrs"]) motifs.push(`${avant} ${h} ${unite}`);
  }
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffixe = h >= 12 ? "pm" : "am";
  motifs.push(`${h12} ${suffixe}`, `${h12}${suffixe}`, `${h12} ${suffixe[0]} m`);
  if (mn !== "00") motifs.push(`${h12} ${mn} ${suffixe}`, `${h12} ${mn}${suffixe}`);
  return motifs.some((x) => contient(texteNorm, x));
}

const PAYS: Record<string, string> = {
  fr: "FR", france: "FR", francia: "FR", belgique: "BE", belgium: "BE", suisse: "CH", switzerland: "CH",
  espagne: "ES", spain: "ES", espana: "ES", italie: "IT", italy: "IT", italia: "IT", allemagne: "DE",
  germany: "DE", alemania: "DE", portugal: "PT", "etats unis": "US", "united states": "US", usa: "US",
  "estados unidos": "US", canada: "CA", mexique: "MX", mexico: "MX", japon: "JP", japan: "JP",
  monde: "MONDE", world: "MONDE", worldwide: "MONDE", mundo: "MONDE", "monde entier": "MONDE",
  "todo el mundo": "MONDE", international: "MONDE", internacional: "MONDE", europe: "EUROPE", europa: "EUROPE",
  eu: "EUROPE", "royaume uni": "GB", "united kingdom": "GB", uk: "GB", "latin america": "LATAM",
  latinoamerica: "LATAM", "amerique latine": "LATAM", latam: "LATAM",
};
export function codePays(x: unknown): string {
  const n = norm(x);
  if (!n) return "";
  if (PAYS[n]) return PAYS[n]!;
  return /^[a-z]{2}$/.test(n) ? n.toUpperCase() : n.toUpperCase().slice(0, 12);
}
// Ce que la phrase doit dire pour que le pays annoncé par Ollama soit cru.
const MOTS_FRANCE = /\b(france|francais|francaise|francaises|french|francia|frances|vostfr|vf)\b/;
const MOTS_EUROPE = /\b(europe|europa|europeen|europeenne|european|europeo|europea)\b/;
const MOTS_MONDE = /\b(monde entier|partout dans le monde|mondialement|worldwide|around the world|all over the world|globally|todo el mundo|a nivel mundial)\b/;
// (« territoires anglophones », « Amérique du Sud », « Océanie », « Moyen-Orient » : d'autres pays que la France)
const AUTRES_PAYS_MOTS =
  "etats unis|united states|usa|amerique du nord|north america|canada|mexique|mexico|latinoamerica|latin america|amerique latine|" +
  "japon|japan|australie|australia|nouvelle zelande|new zealand|espagne|spain|espana|italie|italy|allemagne|germany|royaume uni|" +
  "united kingdom|bresil|brazil|argentine|argentina|chili|chile|asie|asia|chine|china|coree|korea|inde|india|russie|russia|" +
  "afrique|africa|amerique du sud|south america|amerique centrale|central america|oceanie|oceania|moyen orient|middle east|" +
  "anglophones?|english speaking|germanophones?|hispanophones?|lusophones?|arabophones?";
const AUTRES_PAYS = new RegExp(`\\b(${AUTRES_PAYS_MOTS})\\b`);
// Le Japon cité comme repère d'un simulcast (« quelques heures après le Japon », « as it airs in Japan ») :
// ce n'est pas le pays visé par l'annonce.
const JAPON = /\b(japon|japan)\b/g;
const JAPON_REPERE = /\b(simulcast|simultanement|en meme temps que le japon|apres le japon|apres sa diffusion (au japon|japonaise)|heures apres|jours apres|juste apres|que le japon|qu au japon|diffusion japonaise|as it airs in japan|same day as japan|after (its|the) japanese|al mismo tiempo que japon|despues de (su )?(estreno|debut|emision) (original )?en japon|poco despues de su debut)\b/;
/** Un autre pays que la France dans ce texte ? (Le Japon repère d'un simulcast ne compte pas.) */
const autrePays = (texteNorm: string) => AUTRES_PAYS.test(JAPON_REPERE.test(texteNorm) ? texteNorm.replace(JAPON, " ") : texteNorm);
const EXCLUSION = /\b(sauf|hors|hormis|except|excepte|exception|exclusion|excluding|excepto|excepcion|exceptuando|excluyendo|salvo|dehors|outside|barring|minus)\b/;
// (relecture 3) les exclusions en deux mots, ramenées à « sauf » : « à part », « mis à part », « other than », « apart from »,
// « save for », « aside from », « fuera de », « todo el mundo menos » (pas « à part entière »)
// (relecture 4) + « everywhere but », « en toda Europa menos »
const EXCLUSION_2 = /\b(?:mis a part|a part(?! entiere| entier| egale)|other than|apart from|save for|aside from|fuera de|(?:mundo|mundial|paises|territorios|europa) menos|(?:everywhere|anywhere|all (?:territories|regions|countries|markets)) but)\b/g;
// (relecture 4) le pays suivi de « mis(e) à part », « laissé(e) de côté » (« dans le monde entier, la France mise à part »),
// lu avant que « à part » devienne « sauf »
const MIS_A_PART = /\b(?:france|europe|francia|europa|hexagone) (?:mise?s?|laissee?s?) (?:a part|de cote)\b/;
// la version exclue, pas un pays : « sauf la VF », « sauf pour la VF », « except the dub » (le premier mot après l'exclusion)
const VERSIONS_TETE = new Set(["vf", "vostfr", "vo", "vost", "vostf", "doublage", "doublee", "version", "versions", "dub", "dubs", "dubbed", "sub", "subs", "subtitles", "doblaje", "doblada"]);
// la fenêtre d'une exclusion s'arrête à une date (« sauf en Asie, dès le 9 janvier en France » n'exclut pas la France)
// (relecture 4) une date, pas un nombre ni un mois seuls : « sauf dans 2 pays : la France et la Belgique », « sauf jusqu'en
// mars en France », « except where rights may differ, such as France » excluent encore la France ; un nombre arrête la
// lecture s'il est une année, une heure ou une durée (« 2 jours plus tard en France »), ou suivi d'un mois ; un mois s'il ne
// suit pas « jusqu'(en / au) », « until »
const MOIS_FENETRE = new RegExp(`^(?:${TOUS_MOIS})$`);
const DUREE_FENETRE = /^(?:h|heures?|minutes?|jours?|semaines?|mois|ans?|hours?|days?|weeks?|months?|years?|horas?|dias?|semanas?|meses|anos?)$/;
const LIMITE_FENETRE = new Set(["jusqu", "jusque", "until", "till", "hasta"]);
function dateFenetre(mots: string[], j: number): boolean {
  const w = mots[j]!, suivant = mots[j + 1] ?? "";
  if (/^(?:starting|beginning|partir|compter)$/.test(w)) return true;
  if (mots.slice(Math.max(0, j - 3), j).some((x) => LIMITE_FENETRE.has(x))) return false;
  if (/^\d+$/.test(w)) return /^(?:19|20)\d\d$/.test(w) || MOIS_FENETRE.test(suivant) || DUREE_FENETRE.test(suivant) || (/^(?:er|de)$/.test(suivant) && MOIS_FENETRE.test(mots[j + 2] ?? ""));
  return MOIS_FENETRE.test(w) && w !== "may";
}
// … ou à une autre proposition (« sauf en Asie, avec une VF pour la France »)
const FIN_FENETRE = new Set(["avec", "with", "con", "qui", "which", "where", "mais", "but", "pero", "tandis", "alors", "puis", "then", "ensuite", "while", "whereas"]);
// (relecture 3) un pays suivi de son exclusion (« France excluded », « la France étant exclue »), l'espagnol (« no estará
// disponible en Francia »)
// (relecture 4) + « la France n'étant pas / n'est pas / ne sera pas concernée », « France has been excluded » ; pas « la France
// n'est pas concernée par ce retard » (elle n'est pas touchée : la diffusion y reste prévue)
const NEGATION_2 = /\b(?:france|europe|french (?:speaking )?territor(?:y|ies)|francia|europa) (?:(?:ne |n )?(?:is|are|being|will be|has been|have been|was|were|etant|est|sera|seront) )?(?:excluded|not included|exclue?s?|(?:non|pas) concernee?s?(?! par (?:ce|cet|cette|le|la|les|l|un|une) (?:retards?|reports?|decalages?|problemes?|changements?|delais?|pauses?|annulations?|soucis)\b))\b|\bnot including (?:france|europe)\b|\bno (?:esta |estara |sera |llegara )?(?:disponibles? )?(?:en|a) (?:francia|europa)\b/;
// la France qui attend (« alors que la France devra attendre », « En France, il faudra patienter ») ; pas « pas besoin
// d'attendre », « sans attendre », ni l'attente de la seule VF (« il faudra attendre quelques semaines pour la VF »)
const ATTENTE = /\b(?:en france|la france|les fans francais|le public francais|les abonnes francais|dans l hexagone)((?: [a-z0-9]+){0,5}?) (?:attendre|patienter)((?: [a-z0-9]+){0,6})/g;
const attenteFrance = (texteNorm: string) =>
  [...texteNorm.matchAll(ATTENTE)].some((m) => !/\b(?:pas|sans|besoin|inutile|fini|plus)\b/.test(m[1]!) && !/\b(?:vf|doublage|version francaise|doublee)\b/.test(m[2]!));
// « pas encore en France », « not available in Europe », « aucune date française », « sin fecha para España ».
// (relecture 2) + « (France exclue) », « France non comprise » : l'exclusion écrite après le pays.
const NEGATION = /\b(pas|plus) (encore )?(disponibles? |prevue?s? |annoncee?s? |diffusee?s? |sortie? )?(en|pour la) (france|europe)\b|\bnot (yet )?(be )?(available |coming |streaming |released )?(in|to) (france|europe)\b|\bno (word|news|plans?) (yet )?(on|for) (a |an )?(french|european|france|europe)\b|\bno (french|european) (release|stream|streaming|date)\b|\baucune? (date |sortie |diffusion |annonce )?(francaise|europeenne|en france|pour la france|en europe)\b|\b(france|europe|territoires? francais|pays francophones?|territoires? francophones?) (exclue?s?|excepte(?:e|s|es)?|non (?:comprise?s?|incluse?s?))\b/;
// Ce qui suit « sauf », « hors », « à l'exception de » : une liste de lieux (« de l'Asie, du Moyen-Orient et de la France »),
// lue jusqu'au premier mot qui n'est ni un lieu ni un mot de liaison (« hors abonnement, en France » n'exclut pas la France ;
// « sauf la VF » non plus : c'est une version, pas un pays).
const LIAISONS_EXCLUSION = new Set([
  "de", "du", "des", "d", "la", "le", "l", "les", "en", "au", "aux", "a", "et", "ni", "ou", "in", "the", "of", "and", "or", "for",
  "from", "pays", "territoires", "territoire", "regions", "region", "zones", "zone", "marches", "markets", "countries", "country",
  "territories", "territory", "quelques", "certains", "certaines", "plusieurs", "dont", "notamment", "comme", "including", "such",
  "as", "like", "some", "certain", "notable", "notables", "also", "aussi", "egalement", "metropolitaine",
  // (relecture 2) « sauf en Asie ainsi qu'en France », « à l'exception, pour l'instant, de la France », « except, for now, France »
  "ainsi", "qu", "que", "pour", "dans", "sur", "chez", "on", "at", "within", "instant", "moment", "now", "evidemment",
  // (« sauf en Asie de l'Est et en France », « except North Africa and France »)
  "nord", "sud", "est", "ouest", "north", "south", "east", "west", "centrale", "central", "northern", "southern", "eastern", "western",
]);
// (relecture 3) + « l'Hexagone », « chez nous », « notre pays », « le Vieux Continent »
const LIEU_VISE = /^(?:france|francia|francais|francaise|francaises|french|francophones?|french speaking|europe|europa|europeens?|europeennes?|european|union europeenne|european union|hexagone|chez nous|notre pays|vieux continent)(?= |$)/;
// (relecture 2) les mots d'une version, pas d'un pays : « sauf la VF », « hors VOSTFR » ; « hors abonnement », « hors-série » :
// pas une exclusion de lieu
const VERSIONS_EXCLUSION = new Set(["vf", "vostfr", "vo", "vost", "vostf"]);
const HORS_SANS_LIEU = new Set(["abonnement", "abonnements", "serie", "series", "champ", "taxe", "taxes", "frais", "publicite", "pub", "cadre", "norme", "normes", "prix"]);
const LIEU_AUTRE = new RegExp(
  `^(?:${AUTRES_PAYS_MOTS}|belgique|belgium|suisse|switzerland|luxembourg|monaco|quebec|portugal|pays bas|netherlands|autriche|austria|` +
    "pologne|poland|irlande|ireland|grece|greece|turquie|turkey|scandinavie|scandinavia|benelux|dom tom|outre mer|maghreb|maroc|" +
    "algerie|tunisie|cis|cei|uk|u k|ameriques?|americas|" +
    // (relecture 3) les territoires des listes de droits : la liste ne s'arrête plus au premier pays qu'elle ne connaît pas
    "taiwan|hong kong|macao|macau|singapour|singapore|thailande|thailand|vietnam|viet nam|indonesie|indonesia|philippines|malaisie|" +
    "malaysia|cambodge|cambodia|laos|myanmar|birmanie|mongolie|mongolia|pakistan|bangladesh|sri lanka|nepal|kazakhstan|ukraine|" +
    "bielorussie|belarus|pays baltes|baltes|baltic states|nordiques|nordic countries|scandinaves|balkans|danemark|denmark|suede|sweden|" +
    "norvege|norway|finlande|finland|islande|iceland|hongrie|hungary|roumanie|romania|bulgarie|bulgaria|tchequie|republique tcheque|" +
    "czech republic|czechia|slovaquie|slovakia|slovenie|slovenia|croatie|croatia|serbie|serbia|israel|emirats arabes unis|emirats|uae|" +
    "arabie saoudite|saudi arabia|qatar|egypte|egypt|nigeria|afrique du sud|south africa|colombie|colombia|perou|peru|venezuela|" +
    "equateur|ecuador|bolivie|bolivia|uruguay|paraguay|cuba|caraibes|caribbean|asie du sud est|southeast asia|asie pacifique|asia pacific|" +
    "apac|emea|latam|anz)(?= |$)",
);
/** « sauf la France », « except Europe », « pas encore en France » : le pays visé est exclu. */
function exclut(texteNorm0: string): boolean {
  if (MIS_A_PART.test(" " + texteNorm0 + " ")) return true;
  const texteNorm = texteNorm0.replace(EXCLUSION_2, "sauf");
  if (NEGATION.test(" " + texteNorm + " ") || NEGATION_2.test(" " + texteNorm + " ")) return true;
  const mots = texteNorm.split(" ");
  for (let k = 0; k < mots.length; k++) {
    if (!EXCLUSION.test(" " + mots[k] + " ")) continue;
    if (mots[k] === "hors" && HORS_SANS_LIEU.has(mots[k + 1] ?? "")) continue;
    // (relecture 3) « hors du commun », « hors de prix », « hors de question » : pas un lieu
    if (mots[k] === "hors" && /^(?:du|de|des) (?:commun|prix|question|temps|sentiers|controle)$/.test(mots.slice(k + 1, k + 3).join(" "))) continue;
    // (relecture 3) « sauf la VF qui arrivera plus tard », « sauf pour la VF », « except the dub » : une version, pas un pays ;
    // la suite de la liste est encore lue (« sauf la VF et la France »)
    let j0 = k + 1;
    while (j0 < mots.length && LIAISONS_EXCLUSION.has(mots[j0]!) && !LIEU_VISE.test(mots.slice(j0, j0 + 3).join(" "))) j0++;
    const debut = VERSIONS_TETE.has(mots[j0] ?? "") ? j0 + 1 : k + 1;
    // la France ou l'Europe dans les 8 mots qui suivent, jusqu'à une date ou une version (« sauf pour la France », « à
    // l'exception du territoire français », « sauf, pour des raisons de droits, en France » ; pas « sauf en Asie, dès le 9 janvier
    // en France », ni « sauf en Asie, et en VF pour la France »)
    const fen: string[] = [];
    for (let j = debut; j < mots.length && fen.length < 8; j++) {
      const w = mots[j]!;
      if (dateFenetre(mots, j) || FIN_FENETRE.has(w) || VERSIONS_EXCLUSION.has(w) || (w === "des" && /^(?:le|la|l|ce|cette|aujourd|demain|maintenant|\d+)$/.test(mots[j + 1] ?? ""))) break;
      fen.push(w);
    }
    const fenetre = " " + fen.join(" ") + " ";
    if (MOTS_FRANCE.test(fenetre) || MOTS_EUROPE.test(fenetre) || /\b(?:francophones?|hexagone|chez nous|notre pays|vieux continent)\b/.test(fenetre)) return true;
    // et plus loin, une liste de lieux (« de l'Asie, du Moyen-Orient et de la France ») ; un lieu avant un mot de liaison
    // (« Pays-Bas » : « pays » est aussi un mot de liaison)
    for (let j = debut, n = 0; j < mots.length && n < 40; n++) {
      const reste = mots.slice(j, j + 3).join(" ");
      if (LIEU_VISE.test(reste)) return true;
      const autre = LIEU_AUTRE.exec(reste);
      if (autre) {
        j += autre[0].split(" ").length;
        continue;
      }
      if (!LIAISONS_EXCLUSION.has(mots[j]!)) break;
      j++;
    }
  }
  return false;
}
// Adaptations en prises de vues réelles (texte normalisé) : « live action », « adaptation live », « drama »… (Tavily aussi)
// (« un drama CD » est un disque audio)
export const PRISES_REELLES = /\b(live action|prises? de vues? reelles?|en chair et en os|adaptation live|film live|serie live|[jkc] dramas?(?! cds?\b)|(?:le|un|ce|du|en|son|leur|les|des) dramas?(?! cds?\b))\b/;
/**
 * Une annonce gardée pour une adaptation en prises de vues réelles est rejetée (« La saison 2 du live-action One Piece
 * arrive sur Netflix… ») : d'après le titre de l'article, la phrase citée et les paragraphes autour d'elle (« la série
 * live-action … » peut être dite avant).
 */
export function sansPrisesReelles(v: Verdict, a: Article): Verdict {
  if (v.statut !== "garde") return v;
  const ph = norm(v.phrase);
  const paras = a.texte.split("\n").map((x) => norm(x));
  const debut = ph.split(" ").slice(0, 8).join(" ");
  const i = debut ? paras.findIndex((x) => x.includes(debut)) : -1;
  const contexte = [norm(a.titre), ...(i >= 0 ? paras.slice(Math.max(0, i - 1), i + 2) : []), ph].join(" ");
  return PRISES_REELLES.test(" " + contexte + " ") ? { ...v, statut: "rejete", raison: "adaptation en prises de vues réelles (live-action, drama)" } : v;
}
// Crunchyroll News : « Crunchyroll » y est aussi l'éditeur du site, le distributeur des films en France, l'éditeur de mangas
// et de vidéo, et des marques (Anime Awards, Expo, Game Vault, Store). Une annonce n'y est gardée que si la phrase citée dit
// tout elle-même, comme pour le texte lu par Tavily : la plateforme et l'anime y sont nommés ; ni tome, ni coffret, ni jeu,
// ni marque, ni recommandation ; rien pour un film ni pour une date de cinéma ; une suite, sa saison et elle seule.
const SOURCES_STRICTES = new Set(["Crunchyroll News"]);
// (relecture 2) + les récompenses (« aux Anime Awards de Crunchyroll »), l'éditeur (« édité en France par Crunchyroll »),
// les livres et disques (« parution », artbook, drama CD, vinyle), le concert, le jeu vidéo tiré de l'anime
// (relecture 3) « édité par / chez », « parution », « paraître » sortent d'EDITION (appliquée par Tavily à toutes les sources :
// « Adapté du manga édité chez Kana, X arrive sur ADN » est une annonce) : seul Crunchyroll éditeur compte (EDITEUR_CR) ;
// + les produits dérivés et « lance le jeu X »
export const EDITION = /\b(tomes?|volumes?|chapitres?|coffrets?|blu ray|dvd|librairies?|precommandes?|figurines?|game vault|jeux? mobiles?|crunchyroll (?:store|manga|games?|anime awards|awards|expo|news)|anime awards|awards|ceremonie|laureats?|nomine(?:e|s|es)?|nominations?|prix du meilleur|maison d edition|artbooks?|art books?|fanbooks?|drama cds?|vinyles?|concerts?|boutique|netflix games?|adaptation (?:en )?jeux? video|vetements|goodies|peluches?|t shirts?|merchandising|produits derives|anime de l annee|(?:lance|lancera|propose|proposera|ajoute|ajoutera|sort|sortira) (?:le|un|son|ce) (?:nouveau )?jeu)\b/;
/** (relecture 3) Crunchyroll éditeur de livres : « édité en France par Crunchyroll », « Les éditions Crunchyroll », « Crunchyroll publiera le manga X ». */
// (relecture 4) + « le catalogue manga de Crunchyroll », « en version papier chez Crunchyroll », et « Crunchyroll publiera /
// éditera X » sans le mot « manga » (pas « Crunchyroll publiera les épisodes / la bande-annonce / un nouveau visuel… »)
export const EDITEUR_CR = /\b(?:editions crunchyroll|(?:version|edition|format|tirage|en) papier (?:[a-z0-9]+ ){0,2}?(?:chez|par|de|d) crunchyroll|(?:editee?s?|publiee?s?|parution|paraitr\w*|parait|parue?s?|imprimee?s?|traduite?s?)(?: [a-z0-9]+){0,6}? (?:par|chez) crunchyroll|crunchyroll (?:publie|publiera|publieront|edite|editera|editeront|lance|lancera|sortira|imprime|traduit) (?:le|la|les|un|une|ses|son|sa) (?:(?:premier|premiere|nouveau|nouvelle) )?(?:mangas?|romans?|light novels?|tomes?|volumes?|artbooks?|webtoons?|manhwas?)|(?:catalogue|label|collection) (?:mangas?|papier|livres?) (?:de |d |chez )?crunchyroll|crunchyroll (?:publiera|publieront|editera|editeront)(?! (?:les |des |chaque |un |une |la |le |ses |son |sa )?(?:nouveaux? |nouvelles? |premiers? |premieres? )?(?:episodes?|bandes? annonces?|trailers?|videos?|teasers?|extraits?|visuels?|affiches?|simulcasts?|series?|saisons?)\b))\b/;
/** « Le jeu X arrive sur… » : la phrase parle d'un jeu. */
export const JEU_SUJET = /^(?:le|ce|un|les|des|son|leur|the|a|this) (?:nouveau |new )?(?:jeux?|games?)(?: video| mobiles?)? /;
/**
 * (relecture 2) « Le manga X arrive chez Crunchyroll… », « Le light novel X sera publié… » : la phrase parle d'un livre (Crunchyroll
 * est aussi l'éditeur de mangas en France, ex-Kazé : la règle ne vaut que pour Crunchyroll). Pas « The manga's anime… ».
 */
export const LIVRE_SUJET = /^(?:le|la|les|l|ce|cet|cette|un|une|son|sa|ses|leur|leurs|the|a|this) (?:(?:nouveau|nouvel|nouvelle|premier|premiere|dernier|derniere|officiel|officielle|new|first|official) )?(?:mangas?|light novels?|romans?|artbooks?|art books?|fanbooks?|guides?|webtoons?|manhwas?|one shots?|bandes? dessinees?|albums?|singles?|novels?) (?!s )/;
// (relecture 2) une phrase anglaise (tweet cité, article non traduit) n'a pas de pays implicite : le pays doit y être écrit
const MOTS_EN = new Set(["the", "will", "and", "as", "it", "in", "on", "with", "is", "its", "from", "starting", "to", "of", "this", "be", "are"]);
const MOTS_FR = new Set(["le", "la", "les", "des", "du", "et", "sur", "dans", "sera", "est", "une", "un", "au", "aux", "en", "pour", "avec"]);
// (relecture 3) un mot outil français s'écrit en minuscules : « EST », le fuseau, n'en est pas un (« … at 10am EST »)
const phraseAnglaise = (n: string, brut: string) => {
  const w = n.split(" ");
  const minuscules = new Set(norm(brut.replace(/\b[A-Z]{2,}\b/g, " ")).split(" "));
  return w.filter((x) => MOTS_EN.has(x)).length >= 3 && !w.some((x) => MOTS_FR.has(x) && minuscules.has(x));
};
// (relecture 3) + les comparaisons de Tavily (« Dans la lignée de X », « À l'image de X ») et « fans / amateurs de X, … découvrez Y »
const RECOMMANDATION = new RegExp(
  // (« d(?:e|u|es)? » : « fan de X » s'écrit « fan de » une fois normalisé ; « fans? d » suivi de \b ne prenait que « fan d'X »)
  "\\b(si vous avez (?:aime|adore|apprecie|kiffe|devore)|si vous aimez|si vous adorez|si vous etes fans? d(?:e|u|es)?|si (?:[a-z0-9]+ ){1,8}vous (?:a seduit|seduit|a conquis|a convaincu)|" +
    "vous plait|vous a plu|if you (?:liked|enjoyed|love|loved)|dans la lignee d(?:e|u|es)?|dans le sillage d(?:e|u|es)?|a l image d(?:e|u|es)?|a l instar d(?:e|u|es)?|" +
    "pour les (?:fans|amateurs|amatrices|amoureux|adeptes) d(?:e|u|es)?|(?:fans|amateurs|amatrices|adeptes|amoureux) d(?:e|u|es)? (?:[a-z0-9]+ ){1,10}?" +
    "(?:ne manquez pas|ne passez pas a cote|decouvrez|foncez|jetez un oeil|laissez vous tenter|devrait vous plaire|devrait vous seduire|vous plaira|a decouvrir|a voir))\\b",
);
// (relecture 3) + « Les mangas de janvier », « nouveautés manga », « en librairie »
const TITRE_EDITION = /\b(sorties? (?:mangas?|livres?|light novels?|romans?|blu ray|dvd|papier)|planning (?:mangas?|blu ray|dvd)|mangas? (?:de|du|d) (?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|la semaine|ce mois|l ete|l hiver|l automne|printemps)|nouveautes? (?:mangas?|papier|livres?)|en librairie|calendrier (?:mangas?|des sorties mangas?))\b/;
// (relecture 4) une phrase qui parle d'une diffusion (sous un titre sur un livre de Crunchyroll : la seule qui compte)
// (« sur Crunchyroll » : la plateforme ; l'éditeur s'écrit « chez Crunchyroll »)
const DIFFUSION_MOT = /\b(?:simulcast|episodes?|saisons?|seasons?|diffusee?s?|diffusion|diffusera|diffuseront|streaming|vostfr|vf|series?|animes?|animee?s?|en ligne|sur crunchyroll)\b/;
export const AUTRES_SAISONS = /\b(saisons|seasons|temporadas|premieres? saisons?|first season|precedentes? saisons?|saisons? precedentes?|previous seasons?|derniere saison|last season)\b/;
const FORMATS_FILM = new Set(["MOVIE", "SPECIAL", "OVA", "MUSIC"]);
const ROMAINS_SAISON: Record<number, string> = { 2: "ii", 3: "iii", 4: "iv", 5: "v" };
export function controleSource(v: Verdict, a: Article): Verdict {
  if (v.statut !== "garde" || !v.anime || !SOURCES_STRICTES.has(a.source)) return v;
  const rejet = (raison: string): Verdict => ({ ...v, statut: "rejete", raison: `${a.source} : ${raison}` });
  // la phrase citée entière (celle du verdict est coupée à 250 caractères)
  const debut = v.phrase.endsWith("…") ? v.phrase.slice(0, -1) : null;
  const ph = phrases(a).liste.find((x) => x.brut === v.phrase || (debut !== null && x.brut.startsWith(debut)));
  const n = ph?.texte ?? norm(v.phrase);
  if (v.notes.some((x) => x.includes("nommé dans une phrase précédente"))) return rejet("la plateforme n'est pas nommée dans la phrase citée");
  if (!nomme(v.anime, n)) return rejet("la phrase citée ne nomme pas l'anime");
  // (relecture 2) le nom du site en fin de titre (« … | Crunchyroll News ») n'est pas une marque citée par la phrase
  const sansSite = n.replace(/(?:^| )crunchyroll news$/, "");
  if (EDITION.test(" " + sansSite + " ") || JEU_SUJET.test(n + " ") || (v.plateforme?.nom === "Crunchyroll" && (LIVRE_SUJET.test(n + " ") || EDITEUR_CR.test(" " + n + " ")))) return rejet("tome, coffret, livre, jeu, récompense ou marque : pas une diffusion");
  // (relecture 2) un article sur une édition, une récompense, une marque (son titre, sans le nom du site) : rien n'y est une
  // diffusion (« Crunchyroll Manga : les sorties de janvier », « Anime Awards 2027 : les lauréats »)
  const titreN = norm(a.titre).replace(/\bcrunchyroll news\b/g, " ");
  if (EDITION.test(" " + titreN + " ") || TITRE_EDITION.test(" " + titreN + " ")) return rejet("article sur une édition, une récompense ou une marque : pas une diffusion");
  // (relecture 4) un article sur un livre de Crunchyroll (« Le manga X arrive chez Crunchyroll ») : une phrase qui ne dit rien
  // d'une diffusion (épisode, saison, simulcast, streaming, VOSTFR…) n'y est pas une annonce
  const titreNet = titreN.replace(/\s+/g, " ").trim();
  // (pas un titre qui parle aussi de l'anime : « Le manga X adapté en anime : … »)
  if (v.plateforme?.nom === "Crunchyroll" && (LIVRE_SUJET.test(titreNet + " ") || EDITEUR_CR.test(" " + titreNet + " ")) && !DIFFUSION_MOT.test(" " + titreNet + " ") && !DIFFUSION_MOT.test(" " + n + " ")) return rejet("article sur un livre de Crunchyroll : la phrase ne parle pas d'une diffusion");
  if (RECOMMANDATION.test(" " + n + " ")) return rejet("la phrase recommande une autre œuvre (« si vous avez aimé … »)");
  if (v.notes.some((x) => /^pays implicite|\(site français\)$/.test(x)) && phraseAnglaise(n, ph?.brut ?? v.phrase)) return rejet("phrase en anglais sans pays écrit");
  // (relecture 3) un film, ou une date de cinéma : rien n'est lu dans Crunchyroll News. Crunchyroll y est le distributeur des
  // films en France, et ses news mêlent la date du Japon, les reports, les avant-premières et les suites (trois relectures ont
  // encore trouvé des tournures qui passaient) ; les autres sites et Tavily donnent ces dates.
  const film = FORMATS_FILM.has(String(v.anime.format || "").toUpperCase());
  if (film || v.plateforme?.nom === "Cinéma") return rejet("film ou cinéma : rien n'est lu dans Crunchyroll News (date du Japon, reports, avant-premières)");
  const s = v.anime.saison;
  if (s >= 2) {
    // (les numéros du titre complet de l'anime ne comptent pas : « Season 3 Part 2 »)
    const titreAvecSaison = v.anime.alias.some(
      (al) => al.complet && contient(n, al.forme) && (saisonsCitees(al.forme).numeros.has(s) || (!!ROMAINS_SAISON[s] && new RegExp(`\\b${ROMAINS_SAISON[s]}$`).test(al.forme))),
    );
    let reste = " " + n + " ";
    for (const al of v.anime.alias) if (al.complet) reste = reste.split(" " + al.forme + " ").join(" ");
    const c = saisonsCitees(reste.trim());
    if (!c.numeros.has(s) && !titreAvecSaison) return rejet(`suite : la phrase ne nomme pas la saison ${s}`);
    if ([...c.numeros].some((x) => x !== s) || c.jusqua || AUTRES_SAISONS.test(reste)) return rejet(`suite : la phrase parle aussi d'une autre saison que la ${s}`);
  }
  return v;
}
// « Netflix le diffuse aux États-Unis, tandis que Crunchyroll l'aura en France » : chaque plateforme
// est jugée sur sa partie de phrase.
const CONTRASTE = /\b(?:while|whereas|but|however|tandis que|alors que|mais|cependant|mientras que|mientras|pero|sin embargo)\b|;/;
/** La partie de la phrase (normalisée) où la plateforme est nommée, sinon la phrase entière. */
export function partieDe(texteNorm: string, p: Plateforme): string {
  const parts = texteNorm.split(new RegExp(CONTRASTE.source, "g")).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return texteNorm;
  return parts.find((x) => p.re.test(" " + x + " ")) ?? texteNorm;
}
// (relecture 4) « ADN diffusera X en France, tandis que Crunchyroll le proposera dans le reste du monde », « … sur ADN en France
// et sur Crunchyroll dans le reste du monde » : la plateforme du « reste du monde » (lu de son nom au nom de la plateforme
// suivante, sans la France) n'est pas celle de la France quand la France est nommée ailleurs (verifier). Pas « comme dans le
// reste du monde ».
const RESTE_DU_MONDE = /\b(?:reste (?:du monde|de l europe|du globe)|rest of (?:the world|europe)|resto (?:del mundo|de europa))\b/;
const COMME_LE_RESTE = /\b(?:comme|que|qu|like|as|como)(?: dans| en| a| au| in| en el)?(?: le| l| the| el)? (?:reste|rest|resto)\b/;
function resteDuMonde(texteNorm: string, p: Plateforme): boolean {
  const t = " " + texteNorm + " ";
  const m = new RegExp(p.re.source).exec(t);
  if (!m) return false;
  let seg = t.slice(m.index + m[0].length);
  const suivantes = PLATEFORMES.filter((x) => x !== p).map((x) => new RegExp(x.re.source).exec(seg)?.index ?? -1).filter((k) => k >= 0);
  if (suivantes.length) seg = seg.slice(0, Math.min(...suivantes));
  return RESTE_DU_MONDE.test(seg) && !COMME_LE_RESTE.test(seg) && !MOTS_FRANCE.test(seg);
}
// « épisode 15 sur Crunchyroll le 9 octobre » : la date d'un épisode n'est pas celle du début de la diffusion.
const EPISODE = /\b(?:episode|episodio|ep)s? (\d{1,4})\b/;
const RENVOI_DATE = /\b(meme jour|le jour meme|same day|mismo dia|ese mismo dia|simultanement|en meme temps)\b/;
// Heure française : écrite en toutes lettres, ou CET / CEST en capitales (« cet » est aussi un mot français).
const HEURE_FRANCAISE = /\b(heure francaise|heure de paris|en france|french time|paris time|hora peninsular|hora de espana|hora de francia|en francia)\b/;
const FUSEAU_FRANCAIS_BRUT = /\b(CET|CEST)\b/;
const heureFrancaise = (texteNorm: string, brut: string) => HEURE_FRANCAISE.test(" " + texteNorm + " ") || FUSEAU_FRANCAIS_BRUT.test(brut);
// Heure donnée pour un autre fuseau (y compris sur un site français : « 17 h, heure japonaise »).
const HEURE_ETRANGERE = /\b(heure japonaise|heure du japon|heure de tokyo|japan time|japanese time|jst|pst|pdt|edt|cdmx|tiempo del centro|hora del centro|hora de mexico|hora del pacifico|hora del este|hora de argentina|hora de chile|hora de colombia|hora de peru)\b/;
const AU_JAPON = /\b(au japon|in japan|en japon)\b/;
const FUSEAU_BRUT = /\b(JST|PST|PDT|PT|EST|EDT|ET|CST|CDT|CT)\b/;
// Sans année écrite, une date n'est crue que dans les 5 mois qui suivent la publication.
const JOURS_SANS_ANNEE = 150;

// ─────────────────────────────────────────────────────────────── saisons
const NOMBRES: Record<string, number> = {
  deux: 2, two: 2, dos: 2, second: 2, deuxieme: 2, segunda: 2, segundo: 2,
  trois: 3, three: 3, tres: 3, third: 3, troisieme: 3, tercera: 3, tercero: 3,
  quatre: 4, four: 4, cuatro: 4, fourth: 4, quatrieme: 4, cuarta: 4,
  cinq: 5, five: 5, cinco: 5, fifth: 5, cinquieme: 5, quinta: 5,
  premiere: 1, first: 1, primera: 1, primero: 1,
};
const nombre = (s: string) => (/^\d+$/.test(s) ? parseInt(s, 10) : NOMBRES[s] ?? 0);

/** Numéro de saison d'un titre du catalogue (« Season 2 », « 2nd Season », « Part 2 », « III »), 1 sinon. */
export function numeroSaison(titres: Array<string | null | undefined>): number {
  for (const t of titres) {
    if (!t) continue;
    const n = norm(t);
    let m = /\b(season|saison|temporada|part|partie|cour)\s+(\d+)\b/.exec(n);
    if (m) return parseInt(m[2]!, 10);
    m = /\b(\d+)(st|nd|rd|th)\s+(season|cour|part)\b/.exec(n);
    if (m) return parseInt(m[1]!, 10);
    const r = /\s(ii|iii|iv|v)$/.exec(String(t).trim().toLowerCase());
    if (r) return { ii: 2, iii: 3, iv: 4, v: 5 }[r[1] as "ii" | "iii" | "iv" | "v"];
  }
  return 1;
}
/** Saisons citées dans un texte normalisé : numéros explicites et « 2 saisons » (= 1 à 2). */
export function saisonsCitees(texteNorm: string): { numeros: Set<number>; jusqua: number } {
  const numeros = new Set<number>();
  let jusqua = 0;
  const t = " " + texteNorm + " ";
  // (les nombres espagnols après « temporada » seulement : « la saison, très attendue » n'est pas une saison 3)
  const mot = "\\d+|deux|trois|quatre|cinq|two|three|four|five";
  const motEs = "\\d+|dos|tres|cuatro|cinco";
  for (const m of t.matchAll(new RegExp(`\\b(saison|season|partie|part|cour)\\s+(${mot})\\b`, "g"))) numeros.add(nombre(m[2]!));
  for (const m of t.matchAll(new RegExp(`\\btemporada\\s+(${motEs})\\b`, "g"))) numeros.add(nombre(m[1]!));
  for (const m of t.matchAll(/\b(\d+)(e|eme|er|nd|rd|th|st|a|o|era|da)?\s+(saison|season|temporada)\b/g)) numeros.add(parseInt(m[1]!, 10));
  for (const m of t.matchAll(/\b(premiere|first|primera|second|deuxieme|segunda|third|troisieme|tercera|fourth|quatrieme|cuarta|fifth|cinquieme|quinta)\s+(saison|season|temporada)\b/g)) numeros.add(nombre(m[1]!));
  for (const m of t.matchAll(new RegExp(`\\b(${mot})\\s+(saisons|seasons)\\b`, "g"))) jusqua = Math.max(jusqua, nombre(m[1]!));
  for (const m of t.matchAll(new RegExp(`\\b(${motEs})\\s+temporadas\\b`, "g"))) jusqua = Math.max(jusqua, nombre(m[1]!));
  // « la saison 2026 », « 2026 season » : une année, pas un numéro de saison.
  for (const n of [...numeros]) if (n < 1 || n > 20) numeros.delete(n);
  return { numeros, jusqua: jusqua > 20 ? 0 : jusqua };
}

// ─────────────────────────────────────────────────────────────── catalogue
const MOTS_TROP_COMMUNS = new Set(["charisma", "monster", "monsters", "historie", "studio cabana", "the fable", "bless", "gate"]);

/** Formes cherchées dans les articles. Un titre partiel d'un seul mot ne suffit pas (« tenkaichi »). */
export function alias(titres: Array<string | null | undefined>, saison: number): Alias[] {
  const a = new Map<string, boolean>();
  const ajoute = (f: string, complet: boolean) => {
    if (!f || a.has(f)) return;
    if (!complet && !f.includes(" ")) return;
    if (f.length < 6 || MOTS_TROP_COMMUNS.has(f)) return;
    a.set(f, complet);
  };
  for (const t of titres) {
    if (!t) continue;
    const complet = norm(t);
    ajoute(complet, true);
    // « Solo Leveling Season 2 -Arise from the Shadow- » : « solo leveling season 2 », « solo leveling ».
    const base = norm(String(t).split(/\s*[:：]\s+|\s+[-–~]\s*|\s*[-–~]\s+/)[0]);
    const sansSaison = complet
      .replace(/\b(season|saison|part|partie|cour|temporada)\s*\d+\b/g, " ")
      .replace(/\b\d+(st|nd|rd|th)\s+(season|cour|part)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const avantSaison = complet.split(/\b(?:season|saison|part|partie|cour|temporada)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+(?:season|cour|part)\b/)[0]!.trim();
    for (const b of [base, sansSaison, avantSaison]) {
      ajoute(b, false);
      // Pour une suite, la forme courte + la saison : « frieren saison 2 » vaut un titre complet.
      if (saison >= 2 && b) for (const s of [`saison ${saison}`, `season ${saison}`, `temporada ${saison}`]) ajoute(`${b} ${s}`, true);
    }
  }
  return [...a.entries()].map(([forme, complet]) => ({ forme, complet }));
}

export async function catalogue(pool: SqlPool): Promise<AnimeCat[]> {
  const rows: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, platform,
            CAST(IFNULL(popularity, 0) AS SIGNED) AS popularity, format
       FROM anime_items
      WHERE release_date BETWEEN MAKEDATE(YEAR(CURDATE()), 1) AND MAKEDATE(YEAR(CURDATE()) + 2, 1) - INTERVAL 1 DAY
        AND cover IS NOT NULL AND cover <> '' AND title IS NOT NULL AND title <> ''
      ORDER BY popularity DESC
      LIMIT 600`,
  );
  return rows.map((r) => {
    const saison = numeroSaison([r.titleEnglish, r.title]);
    return {
      id: Number(r.id), title: String(r.title), titleEnglish: r.titleEnglish ? String(r.titleEnglish) : null,
      platform: r.platform ? String(r.platform) : null, popularity: Number(r.popularity) || 0,
      format: r.format ? String(r.format) : null, saison, alias: alias([r.titleEnglish, r.title], saison),
    };
  });
}

/** Animes du catalogue cités franchement : dans le titre de l'article, deux fois au moins, ou une fois à côté d'une plateforme. */
export function animesCites(article: Article, cat: AnimeCat[]): Cite[] {
  const titreN = norm(article.titre);
  const corpsN = norm(article.titre + "\n" + article.texte);
  const paras = article.texte.split("\n").map((p) => norm(p));
  const trouves: Cite[] = [];
  for (const it of cat) {
    let meilleur: Alias | null = null;
    for (const al of it.alias) {
      if (!contient(corpsN, al.forme)) continue;
      const franc = contient(titreN, al.forme) || occurrences(corpsN, al.forme) >= 2
        || paras.some((p) => contient(p, al.forme) && MOTS_PLATEFORME.test(" " + p + " "));
      if (!franc) continue;
      if (!meilleur || (al.complet && !meilleur.complet) || (al.complet === meilleur.complet && al.forme.length > meilleur.forme.length)) meilleur = al;
    }
    if (meilleur) trouves.push({ it, forme: meilleur.forme, complet: meilleur.complet });
  }
  // Un titre complet trouvé rend inutiles les correspondances partielles qu'il contient.
  const complets = trouves.filter((t) => t.complet);
  const garde = trouves.filter((t) => t.complet || !complets.some((c) => c.forme.includes(t.forme)));
  return garde
    .sort((a, b) => Number(b.complet) - Number(a.complet) || b.it.popularity - a.it.popularity)
    .slice(0, 4);
}
export const parleDePlateforme = (article: Article) => MOTS_PLATEFORME.test(" " + norm(article.titre + "\n" + article.texte) + " ");

// ─────────────────────────────────────────────────────────────── sources
export function articleJsonLd(html: string): { titre: string; texte: string; publie: string } | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j: any;
    try {
      j = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const objets: any[] = (Array.isArray(j) ? j : [j]).flatMap((o: any) => (o && Array.isArray(o["@graph"]) ? o["@graph"] : [o]));
    for (const o of objets) {
      const type = ([] as string[]).concat(o?.["@type"] || []).join(" ");
      if (/Article/.test(type) && o.articleBody) {
        return { titre: decoder(String(o.headline || "")), texte: enTexte(String(o.articleBody)), publie: String(o.datePublished || "") };
      }
    }
  }
  return null;
}

export interface ItemFlux {
  titre: string;
  url: string;
  publie: string;
  html: string; // texte complet s'il y en a, sinon le résumé
  contenu: string; // content:encoded
  resume: string; // description
}
export function rssItems(xml: string): ItemFlux[] {
  const items: ItemFlux[] = [];
  for (const b of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const champ = (nom: string) => {
      const m = new RegExp(`<${nom}\\b[^>]*>([\\s\\S]*?)<\\/${nom}>`).exec(b[1]!);
      return m ? m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1") : "";
    };
    const contenu = champ("content:encoded");
    const resume = champ("description");
    items.push({
      titre: decoder(champ("title").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/<[^>]+>/g, "")).trim(),
      url: decoder(champ("link")).trim(),
      publie: champ("pubDate").trim(),
      html: contenu || resume,
      contenu,
      resume,
    });
  }
  return items;
}
/** Texte d'un champ de flux (HTML en clair ou échappé). */
const texteFlux = (s: string) => enTexte(/&lt;/.test(s) ? decoder(s) : s);

// ─────────────────────────────────────────────────────────────── robots.txt
function motifRegex(m: string): RegExp {
  const fin = m.endsWith("$");
  const corps = fin ? m.slice(0, -1) : m;
  return new RegExp("^" + corps.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (fin ? "$" : ""));
}
/** Règles du groupe GameNimeBot s'il existe, sinon « * » ; la règle la plus longue l'emporte, Allow à égalité. */
export function evaluerRobots(txt: string, chemin: string): { ok: boolean; delai: number } {
  const groupes: Array<{ agents: string[]; regles: Array<{ allow: boolean; motif: string }>; delai: number }> = [];
  let courant: (typeof groupes)[number] | null = null;
  let agentAvant = false;
  for (const brut of String(txt).split(/\r?\n/)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(brut.replace(/#.*/, "").trim());
    if (!m) continue;
    const cle = m[1]!.toLowerCase(), val = m[2]!.trim();
    if (cle === "user-agent") {
      if (!courant || !agentAvant) groupes.push((courant = { agents: [], regles: [], delai: 0 }));
      courant.agents.push(val.toLowerCase());
      agentAvant = true;
      continue;
    }
    agentAvant = false;
    if (!courant) continue;
    if (cle === "allow" || cle === "disallow") courant.regles.push({ allow: cle === "allow", motif: val });
    if (cle === "crawl-delay") courant.delai = Math.min(30, parseFloat(val) || 0);
  }
  const nous = groupes.filter((g) => g.agents.includes("gamenimebot"));
  const choisis = nous.length ? nous : groupes.filter((g) => g.agents.includes("*"));
  let meilleure: { allow: boolean; motif: string } | null = null;
  for (const g of choisis) {
    for (const r of g.regles) {
      if (!r.motif || !motifRegex(r.motif).test(chemin)) continue;
      if (!meilleure || r.motif.length > meilleure.motif.length || (r.motif.length === meilleure.motif.length && r.allow)) meilleure = r;
    }
  }
  return { ok: meilleure ? meilleure.allow : true, delai: Math.max(0, ...choisis.map((g) => g.delai)) };
}
const robotsCache = new Map<string, { quand: number; texte: string | null }>();
/** Le robots.txt du site autorise-t-il cette adresse ? (Relu toutes les 24 h ; illisible : on réessaie dans 1 h.) */
export async function robotsAutorise(url: string): Promise<{ ok: boolean; delaiMs: number; raison?: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, delaiMs: 0, raison: "adresse illisible" };
  }
  const c = robotsCache.get(u.origin);
  let texte: string | null;
  if (c && Date.now() - c.quand < (c.texte === null ? 3600 : 24 * 3600) * 1000) texte = c.texte;
  else {
    try {
      const r = await fetch(u.origin + "/robots.txt", { headers: { "User-Agent": AGENT }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      texte = r.ok ? await r.text() : r.status >= 400 && r.status < 500 ? "" : null;
    } catch {
      texte = null;
    }
    robotsCache.set(u.origin, { quand: Date.now(), texte });
  }
  if (texte === null) return { ok: false, delaiMs: 0, raison: "robots.txt illisible" };
  const v = evaluerRobots(texte, u.pathname + u.search);
  return { ok: v.ok, delaiMs: v.delai * 1000, raison: v.ok ? undefined : "interdit par le robots.txt du site" };
}

// ─────────────────────────────────────────────────────────────── pages d'articles
/** Texte d'une page d'article : JSON-LD articleBody, sinon paragraphes, listes et intertitres de <article>. */
export function texteDePage(html: string): string {
  const jl = articleJsonLd(html);
  if (jl && jl.texte.length > 300) return jl.texte;
  let zone = String(html || "");
  const a = zone.search(/<article\b/i), b = zone.lastIndexOf("</article>");
  if (a >= 0 && b > a) zone = zone.slice(a, b);
  zone = zone.replace(/<(script|style|noscript|figure|iframe|aside|nav|form|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const lignes: string[] = [];
  for (const m of zone.matchAll(/<(p|li|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const balise = m[1]!.toLowerCase();
    const t = decoder(m[2]!.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (t.length < (balise === "p" ? 30 : balise === "li" ? 12 : 8)) continue;
    if ((t.match(/[»›]/g) || []).length >= 2) continue; // fil d'Ariane
    const ligne = balise === "li" ? "• " + t : t;
    if (lignes[lignes.length - 1] !== ligne) lignes.push(ligne);
  }
  return lignes.join("\n");
}
/** Avant d'ouvrir une page : le titre ou le résumé cite-t-il un anime du site ? Les épisodes 2 et suivants ne comptent pas. */
export function pertinentSurTitre(titre: string, resume: string, cat: AnimeCat[]): boolean {
  const ep = /\bepisode (\d+)\b/.exec(norm(titre));
  if (ep && parseInt(ep[1]!, 10) >= 2) return false;
  const n = norm(titre + "\n" + resume);
  return cat.some((it) => it.alias.some((al) => contient(n, al.forme)));
}

// ─────────────────────────────────────────────────────────────── sources
export interface SourceFlux {
  nom: string;
  langue: Article["langue"];
  flux: string;
  page: boolean; // le flux ne donne qu'un résumé : on ouvre la page des articles pertinents
  delaiMs: number; // entre deux pages (au moins le Crawl-delay du robots.txt)
  officielle: boolean;
  canon?: (url: string) => string; // l'adresse d'un article telle que l'écrit le site (pour ne jamais la relire)
}
// Crunchyroll News : le flux écrit « https://crunchyroll.com/fr/news/… », le site et Tavily « https://www.crunchyroll.com/… »
// (la même page : une seule empreinte, Tavily ne relit pas ce que la presse a lu).
export const adresseCrunchyroll = (url: string) => url.replace(/^https?:\/\/crunchyroll\.com\//i, "https://www.crunchyroll.com/");
export function sourcesFlux(cfg: PresseConfig): SourceFlux[] {
  return [
    { nom: "ADN News", langue: "fr", flux: `${cfg.adn}/feed/`, page: false, delaiMs: 1000, officielle: true },
    // le flux français de Crunchyroll News (texte complet ; la page, dessinée par le navigateur, n'a pas de texte)
    { nom: "Crunchyroll News", langue: "fr", flux: `${cfg.crunchyroll}/v1/fr-FR/rss`, page: false, delaiMs: 1000, officielle: true, canon: adresseCrunchyroll },
    { nom: "AnimOtaku", langue: "fr", flux: `${cfg.animotaku}/feed/`, page: true, delaiMs: 1000, officielle: false },
    { nom: "Manga-News", langue: "fr", flux: `${cfg.manganews}/index.php/feed/news`, page: true, delaiMs: 1000, officielle: false },
    { nom: "ANN", langue: "en", flux: `${cfg.ann}/all/rss.xml?ann-edition=w`, page: true, delaiMs: 2000, officielle: false },
  ];
}
const MAX_PAGES_PAR_SOURCE = 15;
// Pages déjà ouvertes mais pas encore envoyées à Ollama (au-delà du maximum par passage) :
// gardées 12 h en mémoire pour ne pas les rouvrir au passage suivant.
const pagesLues = new Map<string, { quand: number; article: Article }>();
const DUREE_PAGES_MS = 12 * 3600 * 1000;
function pageEnMemoire(url: string): Article | null {
  const x = pagesLues.get(url);
  if (!x) return null;
  if (Date.now() - x.quand > DUREE_PAGES_MS) {
    pagesLues.delete(url);
    return null;
  }
  return x.article;
}
function retenirPage(a: Article): void {
  if (pagesLues.size > 500) pagesLues.clear();
  pagesLues.set(a.url, { quand: Date.now(), article: a });
}
/** Oublie les pages traitées (après leur passage chez Ollama). */
export function oublierPage(url: string): void {
  pagesLues.delete(url);
}

export function sourceDe(url: string, cfg: PresseConfig): { nom: string; langue: Article["langue"] } {
  if (/gameblog\./.test(url) || url.startsWith(cfg.gameblog + "/")) return { nom: "Gameblog", langue: "fr" };
  if (/levelup\./.test(url) || url.startsWith(cfg.levelup + "/")) return { nom: "LevelUp", langue: /\/en\//.test(url) ? "en" : "es" };
  if (/animationdigitalnetwork\./.test(url) || url.startsWith(cfg.adn + "/")) return { nom: "ADN News", langue: "fr" };
  if (/animotaku\./.test(url) || url.startsWith(cfg.animotaku + "/")) return { nom: "AnimOtaku", langue: "fr" };
  if (/manga-news\./.test(url) || url.startsWith(cfg.manganews + "/")) return { nom: "Manga-News", langue: "fr" };
  if (/animenewsnetwork\./.test(url) || url.startsWith(cfg.ann + "/")) return { nom: "ANN", langue: "en" };
  if (/^https?:\/\/(?:www\.)?crunchyroll\.com\//i.test(url) || url.startsWith(cfg.crunchyroll + "/")) return { nom: "Crunchyroll News", langue: /\/fr\//.test(url) ? "fr" : "en" };
  let nom = "?";
  try {
    nom = new URL(url).hostname;
  } catch { /* adresse illisible */ }
  return { nom, langue: "fr" };
}

export interface StatSource {
  flux: number; // articles dans le flux
  nouveaux: number; // jamais lus et récents
  pertinents: number; // citent un anime du site (ou texte complet déjà dans le flux)
  pages: number; // pages ouvertes
}
export interface Lecture {
  articles: Article[];
  horsSujet: Article[]; // titre et résumé sans anime du site : notés sans ouvrir la page
  interdits: Article[]; // page interdite par le robots.txt du site : notée, jamais ouverte
  erreurs: string[];
  gameblogFenetre: number;
  gameblogAdresse: number;
  gameblogLus: number;
  levelupFlux: number;
  sources: Record<string, StatSource>;
}

/**
 * Articles récents de toutes les sources. `dejaLus` : empreintes à ne pas relire
 * (on n'ouvre jamais deux fois la même page).
 */
export async function lireSources(cfg: PresseConfig, cat: AnimeCat[], dejaLus: (urls: string[]) => Promise<Set<string>>): Promise<Lecture> {
  const l: Lecture = { articles: [], horsSujet: [], interdits: [], erreurs: [], gameblogFenetre: 0, gameblogAdresse: 0, gameblogLus: 0, levelupFlux: 0, sources: {} };
  const maintenant = Date.now();
  // Gameblog : le plan du site (les articles anime y sont rangés sous /jeu-video/ed/news/).
  try {
    const plan = `${cfg.gameblog}/sitemap/sitemap.xml`;
    const rp = await robotsAutorise(plan);
    if (!rp.ok) throw new Error(`plan du site ${rp.raison}`);
    const index = await lire(plan);
    const morceaux = [...index.matchAll(/<loc>([^<]*news_chunk_(\d+)\.xml(?:\.gz)?)<\/loc>/g)]
      .map((m) => ({ url: decoder(m[1]!), n: parseInt(m[2]!, 10) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 2);
    const limite = new Date(maintenant - cfg.jours * 86400000).toISOString().slice(0, 10);
    const vus = new Map<string, string>();
    for (const m of morceaux) {
      const xml = await lire(m.url, true);
      for (const b of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
        const loc = decoder((/<loc>([^<]+)<\/loc>/.exec(b[1]!) || [])[1] || "");
        const modif = ((/<lastmod>([^<]+)<\/lastmod>/.exec(b[1]!) || [])[1] || "").slice(0, 10);
        if (loc && modif >= limite && /\/news\//.test(loc) && !vus.has(loc)) vus.set(loc, modif);
      }
    }
    l.gameblogFenetre = vus.size;
    const candidats: Array<{ url: string; modif: string }> = [];
    for (const [url, modif] of vus) {
      const mots = norm(url.split("/").filter(Boolean).pop() || "");
      const utile = /\b(adn|crunchyroll|netflix|prime|disney|hidive|simulcast|anime|animes|saison|episode|episodes|film)\b/.test(mots)
        || cat.some((it) => it.alias.some((al) => contient(mots, al.forme)));
      if (utile) candidats.push({ url, modif });
    }
    const connus = await dejaLus(candidats.map((c) => c.url));
    const aLire = candidats.filter((c) => !connus.has(empreinte(c.url))).sort((a, b) => b.modif.localeCompare(a.modif));
    l.gameblogAdresse = candidats.length;
    for (const c of aLire.slice(0, MAX_PAGES_GAMEBLOG)) {
      const deja = pageEnMemoire(c.url);
      if (deja) {
        l.articles.push(deja);
        continue;
      }
      const r = await robotsAutorise(c.url);
      if (!r.ok) {
        l.erreurs.push(`Gameblog ${c.url} : ${r.raison}`);
        if (r.raison !== "robots.txt illisible") l.interdits.push({ url: c.url, source: "Gameblog", langue: "fr", titre: "", texte: "", publie: c.modif });
        continue;
      }
      await dormir(Math.max(800, r.delaiMs)); // jamais deux requêtes collées
      try {
        const a = articleJsonLd(await lire(c.url));
        l.gameblogLus++;
        if (a) {
          const art: Article = { url: c.url, source: "Gameblog", langue: "fr", titre: a.titre, texte: a.texte, publie: a.publie || c.modif };
          retenirPage(art);
          l.articles.push(art);
        } else l.erreurs.push(`Gameblog ${c.url} : pas de texte d'article lisible`);
      } catch (e) {
        l.erreurs.push(`Gameblog ${c.url} : ${(e as Error).message}`);
      }
    }
  } catch (e) {
    l.erreurs.push(`Gameblog : ${(e as Error).message}`);
  }
  // LevelUp : les flux RSS donnent le texte complet.
  for (const [chemin, langue] of [["/arc/outboundfeeds/rss/category/noticias", "es"], ["/arc/outboundfeeds/rss/category/en/news", "en"]] as const) {
    try {
      const rp = await robotsAutorise(cfg.levelup + chemin);
      if (!rp.ok) throw new Error(`flux ${rp.raison}`);
      const items = rssItems(await lire(cfg.levelup + chemin));
      l.levelupFlux += items.length;
      const connus = await dejaLus(items.map((i) => i.url).filter(Boolean));
      for (const it of items) {
        if (!it.url || connus.has(empreinte(it.url))) continue;
        const t = Date.parse(it.publie);
        if (Number.isFinite(t) && t < maintenant - Math.max(cfg.jours, 2) * 86400000) continue;
        l.articles.push({ url: it.url, source: "LevelUp", langue, titre: it.titre, texte: enTexte(it.html), publie: Number.isFinite(t) ? new Date(t).toISOString() : "" });
      }
    } catch (e) {
      l.erreurs.push(`LevelUp ${chemin} : ${(e as Error).message}`);
    }
  }
  // ADN News et Crunchyroll News (texte complet dans le flux), AnimOtaku, Manga-News, ANN (résumé dans le flux : on ouvre la page
  // des seuls articles dont le titre ou le résumé cite un anime du site).
  for (const s of sourcesFlux(cfg)) {
    const st: StatSource = { flux: 0, nouveaux: 0, pertinents: 0, pages: 0 };
    l.sources[s.nom] = st;
    try {
      const rf = await robotsAutorise(s.flux);
      if (!rf.ok) throw new Error(`flux ${rf.raison}`);
      const items = rssItems(await lire(s.flux)).map((i) => (s.canon && i.url ? { ...i, url: s.canon(i.url) } : i));
      st.flux = items.length;
      const connus = await dejaLus(items.map((i) => i.url).filter(Boolean));
      for (const it of items) {
        if (!it.url || connus.has(empreinte(it.url))) continue;
        const t = Date.parse(it.publie);
        if (Number.isFinite(t) && t < maintenant - Math.max(cfg.jours, 2) * 86400000) continue;
        st.nouveaux++;
        const base = { url: it.url, source: s.nom, langue: s.langue, titre: it.titre, publie: Number.isFinite(t) ? new Date(t).toISOString() : "", officielle: s.officielle };
        if (!s.page) {
          st.pertinents++;
          l.articles.push({ ...base, texte: texteFlux(it.contenu || it.resume) });
          continue;
        }
        if (!pertinentSurTitre(it.titre, texteFlux(it.resume), cat)) {
          l.horsSujet.push({ ...base, texte: "" });
          continue;
        }
        st.pertinents++;
        const deja = pageEnMemoire(it.url);
        if (deja) {
          l.articles.push(deja);
          continue;
        }
        if (st.pages >= MAX_PAGES_PAR_SOURCE) continue; // la suite au prochain passage
        const rp = await robotsAutorise(it.url);
        if (!rp.ok) {
          l.erreurs.push(`${s.nom} ${coupe(it.url, 90)} : ${rp.raison}`);
          if (rp.raison !== "robots.txt illisible") l.interdits.push({ ...base, texte: "" });
          continue;
        }
        await dormir(Math.max(s.delaiMs, rp.delaiMs)); // aussi après le flux : jamais deux requêtes collées
        st.pages++;
        try {
          const texte = texteDePage(await lire(it.url));
          if (texte.length >= 200) {
            const art: Article = { ...base, texte };
            retenirPage(art);
            l.articles.push(art);
          }
          else l.erreurs.push(`${s.nom} ${coupe(it.url, 90)} : pas de texte d'article lisible`);
        } catch (e) {
          l.erreurs.push(`${s.nom} ${coupe(it.url, 90)} : ${(e as Error).message}`);
        }
      }
    } catch (e) {
      l.erreurs.push(`${s.nom} : ${(e as Error).message}`);
    }
  }
  return l;
}

/** Articles imposés (essai) : JSON-LD si la page en a, sinon le texte de la page. */
export async function lireArticles(urls: string[], cfg: PresseConfig): Promise<{ articles: Article[]; erreurs: string[] }> {
  const articles: Article[] = [];
  const erreurs: string[] = [];
  for (const url of urls) {
    try {
      const rp = await robotsAutorise(url);
      if (!rp.ok) {
        erreurs.push(`${url} : ${rp.raison}`);
        continue;
      }
      const html = await lire(url);
      const s = sourceDe(url, cfg);
      const a = articleJsonLd(html);
      if (a) {
        articles.push({ url, source: s.nom, langue: s.langue, titre: a.titre, texte: a.texte, publie: a.publie, impose: true });
        continue;
      }
      const texte = texteDePage(html);
      if (texte.length < 200) {
        erreurs.push(`${url} : pas de texte d'article lisible`);
        continue;
      }
      const meta = (re: RegExp) => decoder((re.exec(html) || [])[1] || "").trim();
      const titre = meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || meta(/<title[^>]*>([^<]*)<\/title>/i);
      const publie = meta(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i) || new Date().toISOString();
      articles.push({ url, source: s.nom, langue: s.langue, titre, texte, publie, impose: true, officielle: s.nom === "ADN News" || s.nom === "Crunchyroll News" });
    } catch (e) {
      erreurs.push(`${url} : ${(e as Error).message}`);
    }
  }
  return { articles, erreurs };
}

// ─────────────────────────────────────────────────────────────── Ollama
export const usage = { appels: 0, lus: 0, ecrits: 0, ms: 0, premier: 0 };

export class OllamaIndisponible extends Error {}

/** POST JSON par node:http : pas de limite de 300 s sur l'attente des en-têtes (celle de fetch). */
function posterJson(url: string, corps: unknown, delaiMs: number): Promise<{ statut: number; texte: string }> {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    const donnees = Buffer.from(JSON.stringify(corps));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json", "content-length": donnees.length } },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (c: Buffer) => morceaux.push(c));
        res.on("end", () => ok({ statut: res.statusCode || 0, texte: Buffer.concat(morceaux).toString("utf8") }));
        res.on("error", ko);
      },
    );
    req.setTimeout(delaiMs, () => req.destroy(new Error(`pas de réponse en ${Math.round(delaiMs / 60000)} min`)));
    req.on("error", ko);
    req.end(donnees);
  });
}

export async function verifierOllama(cfg: PresseConfig): Promise<void> {
  let noms: string[] = [];
  try {
    const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(15000) });
    const j: any = await r.json();
    noms = (j.models || []).map((m: any) => String(m.name));
  } catch (e) {
    throw new OllamaIndisponible(`Ollama ne répond pas (${(e as Error).message})`);
  }
  if (!noms.includes(cfg.modele)) throw new OllamaIndisponible(`le modèle ${cfg.modele} n'est pas installé dans Ollama (présents : ${noms.join(", ") || "aucun"})`);
}

export async function ollama(cfg: PresseConfig, messages: Array<{ role: string; content: string }>) {
  const t0 = Date.now();
  let r: { statut: number; texte: string };
  try {
    r = await posterJson(`${cfg.ollamaUrl}/api/chat`, {
      model: cfg.modele, messages, stream: false, format: "json", keep_alive: "5m",
      options: { temperature: 0, top_p: 0.9, num_ctx: NUM_CTX, num_predict: NUM_PREDICT, num_thread: cfg.coeurs },
    }, OLLAMA_DELAI_MS);
  } catch (e) {
    throw new OllamaIndisponible(`Ollama injoignable (${(e as Error).message})`);
  }
  if (r.statut < 200 || r.statut >= 300) throw new OllamaIndisponible(`Ollama HTTP ${r.statut} : ${coupe(r.texte, 160)}`);
  let j: any;
  try {
    j = JSON.parse(r.texte);
  } catch {
    throw new OllamaIndisponible("réponse d'Ollama illisible");
  }
  const ms = Date.now() - t0;
  usage.appels++;
  usage.lus += j.prompt_eval_count || 0;
  usage.ecrits += j.eval_count || 0;
  usage.ms += ms;
  if (usage.appels === 1) usage.premier = ms;
  const coupee = j.done_reason === "length" || (Number(j.eval_count) || 0) >= NUM_PREDICT;
  return { contenu: String(j.message?.content || ""), ms, lus: Number(j.prompt_eval_count || 0), ecrits: Number(j.eval_count || 0), coupee };
}

/** Les paragraphes utiles (plateforme, date, titre) et leurs voisins, 3 000 caractères au plus. */
export function extrait(article: Article, cites: Cite[]): string {
  let paras = article.texte.split("\n").map((p) => p.trim()).filter((p) => p.length > 1);
  if (paras.length < 4) {
    // Texte d'un seul bloc : on coupe en phrases, deux par morceau.
    const phrases = paras.flatMap((p) => decouperPhrases(p));
    paras = [];
    for (let i = 0; i < phrases.length; i += 2) paras.push(phrases.slice(i, i + 2).join(" "));
  }
  const formes = cites.flatMap((c) => c.it.alias.map((a) => a.forme));
  const note = paras.map((p) => {
    const n = norm(p);
    return (MOTS_PLATEFORME.test(" " + n + " ") ? 2 : 0) + (UNE_DATE.test(" " + n + " ") ? 2 : 0) + (formes.some((f) => contient(n, f)) ? 1 : 0);
  });
  const garde = new Set<number>();
  note.forEach((s, i) => {
    if (s > 0) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < paras.length) garde.add(k);
  });
  let idx = garde.size ? [...garde].sort((a, b) => a - b) : paras.map((_, i) => i);
  const longueur = () => idx.reduce((t, i) => t + paras[i]!.length + 1, 0);
  if (longueur() > 3000) idx = idx.filter((i) => note[i]! > 0);
  while (longueur() > 3000 && idx.length > 1) {
    let pire = idx[idx.length - 1]!;
    for (const i of idx) if (note[i]! < note[pire]!) pire = i;
    idx = idx.filter((i) => i !== pire);
  }
  return idx.map((i) => paras[i]).join("\n").slice(0, 3200);
}

export function messages(article: Article, cites: Cite[]) {
  const langue = { fr: "français", en: "anglais", es: "espagnol" }[article.langue];
  const plusieurs = cites.length > 1;
  const titres = cites.map((c) => `« ${c.it.titleEnglish || c.it.title} »`).join(", ");
  const champAnime = plusieurs ? `- "anime" : le titre tel qu'il est écrit dans la liste ci-dessus ;\n` : "";
  const format = plusieurs
    ? `{"diffusions":[{"anime":"","plateforme":"","pays":[],"date":null,"heure":null,"phrase":""}]}`
    : `{"diffusions":[{"plateforme":"","pays":[],"date":null,"heure":null,"phrase":""}]}`;
  return [
    {
      role: "system",
      content: "Tu lis des articles de presse sur les animes et tu en extrais uniquement des faits écrits noir sur blanc. Tu réponds en JSON valide, sans aucun autre texte.",
    },
    {
      role: "user",
      content:
        `Source : ${article.source} (article en ${langue}), publié le ${jjmmaaaa(article.publie)}.\n` +
        `Titre de l'article : ${article.titre}\n` +
        `Extrait :\n"""\n${extrait(article, cites)}\n"""\n\n` +
        `${plusieurs ? "Animes à chercher" : "Anime à chercher"} : ${titres}.\n\n` +
        `Liste les diffusions de ${plusieurs ? "ces animes" : "cet anime"} annoncées dans l'extrait qui concernent la France, l'Europe ou le monde entier, ou dont le pays n'est pas précisé : plateforme de streaming, chaîne de télévision ou sortie au cinéma. ` +
        `Ignore celles réservées à d'autres pays (États-Unis, Amérique latine, Japon…) et ignore les autres animes.\n` +
        `Pour chaque diffusion :\n` +
        champAnime +
        `- "plateforme" : son nom tel qu'écrit dans l'article (ADN, Crunchyroll, Netflix, Prime Video, Disney+, MANGAS, cinéma…) ;\n` +
        `- "pays" : ["FR"] pour la France, ["EUROPE"], ["MONDE"] si l'article dit monde entier, ou [] si l'article ne dit pas où ;\n` +
        `- "date" : AAAA-MM-JJ du jour où la diffusion commence sur CETTE plateforme, seulement si l'article le dit, sinon null ;\n` +
        `- "heure" : HH:MM de diffusion sur CETTE plateforme, seulement si l'article la donne, sinon null ;\n` +
        `- "phrase" : les 8 premiers mots, recopiés exactement, de la phrase de l'extrait qui annonce cette diffusion.\n` +
        `N'invente rien. Si l'extrait n'annonce aucune diffusion de ce genre, réponds {"diffusions":[]}.\n` +
        `Format : ${format}`,
    },
  ];
}

export function lireJson(contenu: string): any {
  const t = String(contenu || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch { /* illisible */ }
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── vérification
interface Phrase {
  brut: string;
  texte: string;
  debut: number;
  liste: boolean; // ligne de liste (« • … ») : elle se suffit à elle-même
}
const phrasesCache = new WeakMap<Article, { liste: Phrase[]; corps: string }>();
function phrases(article: Article) {
  const deja = phrasesCache.get(article);
  if (deja) return deja;
  const brutes = (article.titre + "\n" + article.texte)
    .split("\n")
    .flatMap((ligne) => {
      const estListe = ligne.startsWith("•");
      return decouperPhrases(ligne).map((p) => ({ brut: p, texte: norm(p), liste: estListe }));
    })
    .filter((p) => p.texte);
  const liste: Phrase[] = [];
  let pos = 0;
  for (const p of brutes) {
    liste.push({ ...p, debut: pos });
    pos += p.texte.length + 1;
  }
  const r = { liste, corps: brutes.map((p) => p.texte).join(" ") };
  phrasesCache.set(article, r);
  return r;
}
/** Plateformes nommées dans une phrase (avec les contrôles sur le texte d'origine : « ADN », « Disney+ », « MANGAS »). */
export function plateformesDe(p: { texte: string; brut: string }): Plateforme[] {
  return PLATEFORMES.filter((x) => x.re.test(" " + p.texte + " ") && (!x.brut || x.brut.test(p.brut)) && (!x.exigeDate || UNE_DATE.test(" " + p.texte + " ")));
}
const nomme = (it: AnimeCat, texteNorm: string) => it.alias.some((al) => contient(texteNorm, al.forme));

// Verbes de sortie : « X arrive sur… », « X will premiere… », « X llega… ».
// Forts : une annonce à eux seuls. Faibles (« est », « sera »…) : seulement suivis d'un participe de sortie,
// sauf quand la phrase ne nomme pas notre anime (là, « X est… » suffit à dire que la phrase parle de X).
const VERBES_FORTS = new Set([
  "arrive", "arrivera", "arriveront", "debarque", "debarquera", "debarqueront", "sort", "sortira", "sortiront", "revient", "reviendra",
  "demarre", "demarrera", "commence", "commencera", "arrives", "premieres", "launches", "debuts", "returns", "hits", "lands", "comes",
  "streams", "llega", "llegara", "llegaran", "estrena", "estrenara", "regresa", "regresara", "debuta", "debutara",
]);
const VERBES_FAIBLES = new Set(["est", "sera", "seront", "is", "will", "estara", "se"]);
const PARTICIPES = new Set([
  "diffuse", "diffusee", "diffuses", "diffusees", "disponible", "disponibles", "propose", "proposee", "lance", "lancee", "attendu", "attendue",
  "available", "streaming", "released", "premiering", "premiere", "stream", "arrive", "debut", "coming", "arriving", "launch",
  "estrenada", "estrenado", "estrena", "estrenara", "transmitida", "transmitido", "disponibles",
]);
const ADVERBES = new Set(["aussi", "egalement", "enfin", "bientot", "deja", "also", "finally", "soon", "tambien", "ya"]);
const LIAISONS = new Set(["x", "de", "des", "du", "la", "le", "les", "l", "d", "of", "the", "no", "to", "and", "et", "del", "el", "y", "on", "in", "a"]);
const majuscule = (w: string) => /^[«"“(]*[A-ZÀ-ÖØ-Þ]/u.test(w);
// Le nom s'arrête à la ponctuation, sauf « No. », « Vol. », « Dr. »… (« Kaiju No. 8 », « Dr. Stone »).
const finDeNom = (w: string) => /[:,;!?»"”)]$/.test(w) || (/\.$/.test(w) && !/^(no|n°|nº|vol|dr|mr|st|ep)\.$/i.test(w));

/**
 * Noms propres suivis d'un verbe de sortie : « Le nouvel anime Bakemono Fight arrive sur Crunchyroll »
 * -> « bakemono fight ». Un seul mot en tête de phrase ne compte pas (« Elle arrive », « Netflix sera »).
 * `strict` : seuls les verbes forts (ou « sera diffusé », « will premiere »…) comptent.
 */
export function sujetsAnnonces(brut: string, strict: boolean): string[] {
  const mots = brut.replace(/^[•\s]+/, "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let k = 0;
  while (k < mots.length) {
    if (!majuscule(mots[k]!)) {
      k++;
      continue;
    }
    const debut = k;
    const run: string[] = [];
    while (k < mots.length) {
      const w = mots[k]!;
      if (majuscule(w) || (run.length && /^\d+[.:]?$/.test(w))) run.push(w);
      else if (run.length && LIAISONS.has(norm(w)) && mots[k + 1] && majuscule(mots[k + 1]!)) run.push(w);
      else break;
      k++;
      if (finDeNom(w)) break; // ponctuation : le nom s'arrête là, et le verbe ne suit pas directement
    }
    const ponctue = finDeNom(run[run.length - 1] || "");
    if (!run.length || ponctue || (run.length < 2 && debut === 0)) continue;
    const sujet = norm(run.join(" "));
    if (!sujet || PLATEFORMES.some((p) => p.re.test(" " + sujet + " ")) || MOTS_FRANCE.test(" " + sujet + " ") || AUTRES_PAYS.test(" " + sujet + " ") || MOTS_EUROPE.test(" " + sujet + " ")) continue;
    const suite = norm(mots.slice(k, k + 6).join(" ")).split(" ");
    let j = 0;
    if (ADVERBES.has(suite[j] || "")) j++;
    const verbe = suite[j] || "";
    const annonce = VERBES_FORTS.has(verbe)
      || (VERBES_FAIBLES.has(verbe) && (!strict || suite.slice(j + 1, j + 4).some((x) => PARTICIPES.has(x))));
    if (annonce) out.push(sujet);
  }
  return out;
}

export function verifier(article: Article, cites: Cite[], d: any): Verdict {
  const { liste, corps } = phrases(article);
  const res: Verdict = {
    statut: "rejete", raison: "", anime: null, plateforme: null, pays: "", date: null, heure: null, phrase: "", notes: [],
    demande: `${coupe(String(d?.plateforme ?? "?"), 25)} · ${coupe(String(d?.anime || cites[0]?.it.titleEnglish || cites[0]?.it.title || "?"), 40)}`,
  };
  // 1. L'anime : un de ceux qu'on a cherchés. Avec un seul anime cherché, la réponse peut omettre son nom,
  //    mais si elle en donne un autre, elle est rejetée.
  let c: Cite | undefined;
  const na = norm(d?.anime);
  if (!na && cites.length === 1) c = cites[0];
  else if (na) {
    // Titre identique, puis titre qui contient une forme connue, puis forme connue qui contient le titre donné.
    const niveau = (x: Cite) => Math.max(0, ...x.it.alias.map((al) => (al.forme === na ? 3 : na.includes(al.forme) ? 2 : na.length >= 6 && al.forme.includes(na) ? 1 : 0)));
    const notes = cites.map((x) => ({ x, n: niveau(x) })).filter((o) => o.n > 0);
    const haut = Math.max(0, ...notes.map((o) => o.n));
    const premiers = notes.filter((o) => o.n === haut);
    if (premiers.length > 1) return { ...res, raison: `anime ambigu (« ${coupe(String(d?.anime), 40)} »)` };
    c = premiers[0]?.x;
  }
  if (!c) return { ...res, raison: `anime hors liste (« ${coupe(String(d?.anime || ""), 40)} »)` };
  res.anime = c.it;
  // 2. Plateforme connue.
  const p = plateformeDe(String(d?.plateforme || ""));
  if (!p) return { ...res, raison: `plateforme inconnue (« ${coupe(String(d?.plateforme || ""), 30)} »)` };
  res.plateforme = p;
  // 3. La phrase citée existe dans l'article. 8 ou 6 premiers mots, ou 6 mots consécutifs : prise sûre.
  //    5 ou 4 mots seulement : prise fragile, la plateforme doit alors être dans la phrase même.
  const mots = norm(d?.phrase).split(" ").filter(Boolean);
  const cherche = " " + corps + " ";
  const trouve = (m: string[]) => cherche.indexOf(" " + m.join(" ") + " ");
  let pos = -1, sure = false;
  for (const n of [8, 6]) if (pos < 0 && mots.length >= n && (pos = trouve(mots.slice(0, n))) >= 0) sure = true;
  for (let k = 1; pos < 0 && k + 6 <= Math.min(mots.length, 12); k++) if ((pos = trouve(mots.slice(k, k + 6))) >= 0) sure = true;
  for (const n of [5, 4]) if (pos < 0 && mots.length >= n) pos = trouve(mots.slice(0, n));
  if (pos < 0 && mots.length >= 2) {
    // Ligne courte recopiée en entier (« Netflix : 17 octobre ») : prise fragile elle aussi.
    const k = liste.findIndex((x) => x.texte === mots.join(" "));
    if (k >= 0) pos = liste[k]!.debut;
  }
  if (pos < 0) return { ...res, raison: "phrase citée introuvable dans l'article" };
  let i = liste.length - 1;
  while (i > 0 && liste[i]!.debut > pos) i--;
  const ph = liste[i]!;
  res.phrase = coupe(ph.brut, 250);
  // 4. La phrase parle de cet anime : elle le nomme, ou la plus proche des 4 phrases d'avant qui nomme
  //    un anime cherché nomme celui-ci. Dans les deux cas, aucun autre titre n'y est annoncé
  //    (« Le nouvel anime Bakemono Fight arrive sur Crunchyroll »).
  const autres = cites.filter((x) => x !== c);
  const nommeIci = nomme(c.it, ph.texte);
  const estLui = (sujet: string) => c!.it.alias.some((al) => al.forme.includes(sujet) || sujet.includes(al.forme));
  const autreSujet = sujetsAnnonces(ph.brut, nommeIci).find((x) => !estLui(x));
  if (autreSujet) return { ...res, raison: `la phrase annonce « ${coupe(autreSujet, 30)} »` };
  if (!nommeIci) {
    if (autres.some((x) => nomme(x.it, ph.texte))) return { ...res, raison: "la phrase citée parle d'un autre anime" };
    if (ph.liste) {
      // Ligne de liste sans titre : seulement une liste de plateformes (« • ADN : 11 octobre à 18 h »).
      const tete = ph.brut.replace(/^[•\s]+/, "").split(/\s+/).slice(0, 3).join(" ");
      if (!plateformesDe({ texte: norm(tete), brut: tete }).length) return { ...res, raison: "ligne de liste qui ne nomme pas cet anime" };
    }
    let proche: Cite | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 4) && !proche; k--) {
      const t = liste[k]!.texte;
      proche = nomme(c.it, t) ? c : cites.find((x) => nomme(x.it, t)) ?? null;
    }
    if (!proche && cites.length === 1 && nomme(c.it, norm(article.titre))) proche = c;
    if (proche !== c) return { ...res, raison: proche ? "les phrases d'avant parlent d'un autre anime" : "cet anime n'est pas nommé près de la phrase citée" };
  }
  // 5. La phrase parle de cette plateforme : elle la nomme, ou (prise sûre seulement) elle n'en nomme
  //    aucune et la dernière nommée dans les 4 phrases d'avant est celle-là.
  const ici = plateformesDe(ph);
  if (!ici.includes(p)) {
    if (ici.length) return { ...res, raison: `la phrase citée parle de ${ici.map((x) => x.nom).join(", ")}, pas de ${p.nom}` };
    if (!sure) return { ...res, raison: `${p.nom} absent de la phrase citée (citation trop courte pour chercher avant)` };
    if (ph.liste) return { ...res, raison: `${p.nom} absent de la ligne de liste citée` };
    let avant: Plateforme[] | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 4) && !avant; k--) {
      const pl = plateformesDe(liste[k]!);
      if (pl.length) avant = pl;
    }
    if (!avant || !avant.includes(p)) return { ...res, raison: `${p.nom} absent de la phrase citée et de celles d'avant` };
    res.notes.push(`${p.nom} nommé dans une phrase précédente`);
  }
  if (p.exigeDate && !UNE_DATE.test(" " + ph.texte + " ")) return { ...res, raison: "cinéma sans date dans la phrase" };
  const autour = liste.slice(Math.max(0, i - 1), i + 2).map((x) => x.texte).join(" ");
  const autourBrut = liste.slice(Math.max(0, i - 1), i + 2).map((x) => x.brut).join(" ");
  // 6. Saisons : la phrase ne doit pas parler d'une autre saison (si elle n'en cite aucune : ses voisines) ;
  //    une suite trouvée par son titre court doit avoir sa saison citée dans l'article ;
  //    un anime de saison 1 n'est pas une saison 2 annoncée.
  const sPhrase = saisonsCitees(ph.texte);
  const ici2 = sPhrase.numeros.size || sPhrase.jusqua ? sPhrase : saisonsCitees(autour);
  const s = c.it.saison;
  if (ici2.numeros.size && !ici2.numeros.has(s) && ici2.jusqua < s) return { ...res, raison: `la phrase parle de la saison ${[...ici2.numeros].join(", ")}, pas de la saison ${s}` };
  if (s >= 2 && !c.complet) {
    const tout = saisonsCitees(corps);
    if (!tout.numeros.has(s) && tout.jusqua < s) return { ...res, raison: `saison ${s} jamais citée dans l'article` };
  }
  // 7. Pays : ce que dit la phrase citée (la partie où la plateforme est nommée), puis ses voisines.
  //    Le texte décide ; la réponse d'Ollama ne sert qu'aux notes.
  const annonces = ([] as unknown[]).concat(d?.pays || []).map(codePays).filter(Boolean);
  const vises = annonces.filter((x) => ["FR", "EUROPE", "MONDE"].includes(x));
  const ailleurs = annonces.filter((x) => !["FR", "EUROPE", "MONDE"].includes(x));
  const phN = " " + ph.texte + " ";
  const zone = " " + (ici.includes(p) ? partieDe(ph.texte, p) : ph.texte) + " ";
  const franceIci = MOTS_FRANCE.test(zone);
  const europeIci = MOTS_EUROPE.test(zone);
  const mondeIci = MOTS_MONDE.test(zone);
  const autresIci = autrePays(zone) || (article.langue === "fr" && /\b(US|UK)\b/.test(ph.brut));
  const franceAutour = MOTS_FRANCE.test(" " + autour + " ");
  const autresAutour = autrePays(" " + autour + " ");
  const noteSi = (code: string, texte: string) => {
    if (annonces.length && !annonces.includes(code)) res.notes.push(`pays « ${annonces.join(",")} » corrigé : ${texte}`);
  };
  let pays = "";
  // (relecture 3) la partie de la plateforme ne nomme pas la France : une exclusion dans une autre partie de la phrase
  // (« dans le monde entier, mais pas en France », « worldwide, but not in France »), ou la France qui attend dans une phrase
  // voisine (« En France, il faudra attendre l'été ») l'emporte
  // (relecture 4) et la plateforme du « reste du monde », quand la France est nommée ailleurs (une autre partie de la phrase,
  // une phrase voisine : « En France, c'est ADN… »)
  if (exclut(zone.trim()) || (!franceIci && (exclut(ph.texte) || attenteFrance(" " + autour + " "))) || (ici.includes(p) && resteDuMonde(ph.texte, p) && MOTS_FRANCE.test(" " + autour + " "))) {
    pays = "?";
    res.notes.push("la phrase exclut la France ou l'Europe");
  } else if (autresIci && !franceIci && !europeIci && !mondeIci) {
    pays = ailleurs.join(",") || "?";
    if (vises.length) res.notes.push(`pays « ${annonces.join(",")} » : la phrase parle d'un autre pays`);
  } else if (franceIci) {
    pays = "FR";
    noteSi("FR", "la phrase parle de la France");
  } else if (europeIci) {
    pays = "EUROPE";
    noteSi("EUROPE", "la phrase parle de l'Europe");
  } else if (mondeIci) {
    pays = "MONDE";
    noteSi("MONDE", "la phrase parle du monde entier");
  } else if (ailleurs.length && !vises.length) pays = ailleurs.join(","); // seulement d'autres pays : hors France
  else if (franceAutour) {
    pays = "FR";
    noteSi("FR", "les phrases voisines parlent de la France");
  } else if (article.langue === "fr" && !autresAutour) {
    pays = "FR";
    res.notes.push(annonces.length ? `pays « ${annonces.join(",")} » non écrit dans la phrase : France (site français)` : "pays implicite (site français)");
  } else {
    pays = ailleurs.join(",") || "?";
    if (vises.length) res.notes.push(`pays « ${annonces.join(",")} » non écrit dans la phrase`);
  }
  res.pays = pays;
  // 8. Date et heure : écrites dans la phrase citée (la date peut être dans la phrase d'avant si
  //    celle-ci y renvoie : « le même jour »). L'année est celle écrite, sinon la plus proche à venir.
  //    L'heure n'est gardée qu'à l'heure française (site français, ou phrase qui le dit).
  if (d?.date) {
    const iso = String(d.date);
    let lieu = ph.texte, lieuBrut = ph.brut;
    if (!dateDansTexte(iso, lieu, lieuBrut) && i > 0 && RENVOI_DATE.test(" " + ph.texte + " ")) {
      lieu = liste[i - 1]!.texte + " " + ph.texte;
      lieuBrut = liste[i - 1]!.brut + " " + ph.brut;
    }
    const ep = EPISODE.exec(" " + ph.texte + " ");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) res.notes.push(`date illisible (${coupe(iso, 20)})`);
    else if (!dateDansTexte(iso, lieu, lieuBrut)) res.notes.push(`date ${jjmmaaaa(iso)} absente de la phrase, retirée`);
    else if (ep && parseInt(ep[1]!, 10) >= 2) res.notes.push(`date de l'épisode ${ep[1]}, pas du début de la diffusion, retirée`);
    else {
      const ecrite = anneeEcrite(iso, lieu);
      const annee = ecrite || anneeProbable(iso, article.publie);
      const juste = `${annee}${iso.slice(4)}`;
      if (juste !== iso) res.notes.push(`année corrigée : ${jjmmaaaa(iso)} → ${jjmmaaaa(juste)}`);
      const t = Date.parse(juste + "T12:00:00Z"), pub = Date.parse(article.publie || new Date().toISOString());
      const jours = ecrite ? 400 : JOURS_SANS_ANNEE;
      if (Number.isFinite(t) && Number.isFinite(pub) && t >= pub - 3 * 86400000 && t <= pub + jours * 86400000) res.date = juste;
      else res.notes.push(ecrite ? `date ${jjmmaaaa(juste)} passée ou trop lointaine, retirée` : `date ${jjmmaaaa(iso)} sans année, sans doute passée, retirée`);
    }
  }
  if (d?.heure) {
    const h = String(d.heure);
    if (!heureDansTexte(h, ph.texte)) res.notes.push(`heure ${coupe(h, 8)} absente de la phrase, retirée`);
    else if (HEURE_ETRANGERE.test(phN) || FUSEAU_BRUT.test(ph.brut)) res.notes.push(`heure ${coupe(h, 8)} d'un autre fuseau, retirée`);
    else if (heureFrancaise(ph.texte, ph.brut)) res.heure = h;
    else if (AU_JAPON.test(phN) || (article.langue !== "fr" && !heureFrancaise(autour, autourBrut))) res.notes.push(`heure ${coupe(h, 8)} d'un autre fuseau, retirée`);
    else res.heure = h;
  }
  if (["FR", "EUROPE", "MONDE"].includes(pays) && p.horsFrance) {
    res.notes.push(`${p.nom} n'existe pas en France`);
    res.statut = "hors_france";
    return res;
  }
  res.statut = ["FR", "EUROPE", "MONDE"].includes(pays) ? "garde" : "hors_france";
  return res;
}

// ─────────────────────────────────────────────────────────────── base
const versDatetime = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace("T", " ") : null;
};

/** Empreintes des articles déjà traités. Une erreur se retente deux fois, deux heures après. */
export async function dejaLusEnBase(pool: SqlPool, urls: string[]): Promise<Set<string>> {
  if (!urls.length) return new Set();
  const h = urls.map(empreinte);
  const rows: any[] = await pool.query(
    `SELECT url_hash FROM presse_articles
      WHERE url_hash IN (${h.map(() => "?").join(",")})
        AND NOT (statut = 'erreur' AND essais < 3 AND lu_le < NOW() - INTERVAL 2 HOUR)`,
    h,
  );
  return new Set(rows.map((r) => String(r.url_hash)));
}

export async function noterArticle(pool: SqlPool, a: Article, statut: string, animes: number[], note: string): Promise<void> {
  await pool.query(
    `INSERT INTO presse_articles (url_hash, url, source, titre, publie_le, statut, animes, note, essais)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE statut = VALUES(statut), animes = VALUES(animes), note = VALUES(note),
                             essais = essais + 1, lu_le = CURRENT_TIMESTAMP`,
    [empreinte(a.url), a.url.slice(0, 600), a.source, coupe(a.titre, 300), versDatetime(a.publie), statut, animes.join(",").slice(0, 255) || null, coupe(note, 255) || null],
  );
}

export async function enregistrerAnnonce(pool: SqlPool, a: Article, v: Verdict): Promise<void> {
  await pool.query(
    `INSERT INTO annonces_fr (anime_id, plateforme, pays, date_dispo, heure, source, url, url_hash, publie_le, phrase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE pays = VALUES(pays), date_dispo = COALESCE(VALUES(date_dispo), date_dispo),
                             heure = COALESCE(VALUES(heure), heure), phrase = VALUES(phrase)`,
    [v.anime!.id, v.plateforme!.nom, v.pays, v.date, v.heure, a.source, a.url.slice(0, 600), empreinte(a.url), versDatetime(a.publie), coupe(v.phrase, 250)],
  );
}

/** Une seule annonce par anime et plateforme dans un même article : celle qui en dit le plus. */
export function meilleures(verdicts: Verdict[]): Verdict[] {
  const par = new Map<string, Verdict>();
  const poids = (v: Verdict) => (v.date ? 2 : 0) + (v.heure ? 1 : 0);
  for (const v of verdicts) {
    if (v.statut !== "garde") continue;
    const cle = `${v.anime!.id}|${v.plateforme!.nom}`;
    const prec = par.get(cle);
    if (!prec || poids(v) > poids(prec)) par.set(cle, v);
  }
  return [...par.values()];
}

// ─────────────────────────────────────────────────────────────── passage
export interface Traite {
  article: Article;
  cites: Cite[];
  verdicts: Verdict[];
  ms: number;
  lus: number;
  ecrits: number;
  extraitLongueur: number;
  erreur?: string;
}
export interface Rapport {
  lecture: Omit<Lecture, "articles" | "horsSujet" | "interdits">;
  retenus: number;
  envoyes: number;
  traites: Traite[];
  gardees: number;
  arret?: string;
}

/**
 * Un passage. Hors essai : n'envoie que des articles jamais lus, note chaque article
 * lu et enregistre les annonces gardées. En essai : ne lit ni n'écrit la base
 * (sauf le catalogue) et peut recevoir des articles imposés.
 */
export async function passage(
  deps: PresseDeps,
  cfg: PresseConfig,
  opts: { essai: boolean; max: number; imposes?: Article[]; suivi?: (t: Traite, n: number, total: number) => void },
): Promise<Rapport> {
  // Les articles lus il y a plus de 90 jours sont oubliés (leurs annonces restent).
  if (!opts.essai) await deps.pool.query("DELETE FROM presse_articles WHERE lu_le < NOW() - INTERVAL 90 DAY");
  const cat = await catalogue(deps.pool);
  const dejaLus = opts.essai ? async () => new Set<string>() : (urls: string[]) => dejaLusEnBase(deps.pool, urls);
  const lecture = await lireSources(cfg, cat, dejaLus);
  const vus = new Set<string>();
  const tous = [...(opts.imposes || []), ...lecture.articles].filter((a) => (vus.has(a.url) ? false : (vus.add(a.url), true)));
  const retenus: Array<{ a: Article; cites: Cite[] }> = [];
  for (const a of tous) {
    const cites = animesCites(a, cat);
    if (cites.length && (parleDePlateforme(a) || a.impose)) retenus.push({ a, cites });
    else if (!opts.essai) {
      await noterArticle(deps.pool, a, "hors_sujet", cites.map((c) => c.it.id), "");
      oublierPage(a.url);
    }
  }
  if (!opts.essai) {
    for (const a of lecture.horsSujet) await noterArticle(deps.pool, a, "hors_sujet", [], "titre et résumé sans anime du site");
    for (const a of lecture.interdits) await noterArticle(deps.pool, a, "interdit", [], "page interdite par le robots.txt du site");
  }
  // Ordre : articles imposés, source officielle (ADN News), sites français, titre complet, plus récent.
  retenus.sort((x, y) => Number(!!y.a.impose) - Number(!!x.a.impose)
    || Number(!!y.a.officielle) - Number(!!x.a.officielle)
    || Number(y.a.langue === "fr") - Number(x.a.langue === "fr")
    || Number(y.cites.some((c) => c.complet)) - Number(x.cites.some((c) => c.complet))
    || String(y.a.publie).localeCompare(String(x.a.publie)));
  const envoyes = retenus.slice(0, opts.max);
  const { articles: _articles, horsSujet: _horsSujet, interdits: _interdits, ...resteLecture } = lecture;
  const rapport: Rapport = { lecture: resteLecture, retenus: retenus.length, envoyes: envoyes.length, traites: [], gardees: 0 };
  if (envoyes.length) await verifierOllama(cfg);
  let n = 0;
  for (const { a, cites } of envoyes) {
    n++;
    const t: Traite = { article: a, cites, verdicts: [], ms: 0, lus: 0, ecrits: 0, extraitLongueur: extrait(a, cites).length };
    let r;
    try {
      r = await ollama(cfg, messages(a, cites));
    } catch (e) {
      // Ollama tombé : on s'arrête là, l'article sera repris au prochain passage.
      rapport.arret = (e as Error).message;
      t.erreur = rapport.arret;
      rapport.traites.push(t);
      opts.suivi?.(t, n, envoyes.length);
      break;
    }
    t.ms = r.ms;
    t.lus = r.lus;
    t.ecrits = r.ecrits;
    const j = lireJson(r.contenu);
    const diffusions: any[] | null = j && Array.isArray(j.diffusions) ? j.diffusions : null;
    if (!diffusions) {
      // Réponse coupée (trop longue) : la relancer donnerait la même chose. Sinon, deux nouveaux essais plus tard.
      t.erreur = r.coupee ? "réponse trop longue, coupée" : `réponse illisible : ${coupe(r.contenu.replace(/\s+/g, " "), 160)}`;
      if (!opts.essai) {
        await noterArticle(deps.pool, a, r.coupee ? "tronque" : "erreur", cites.map((c) => c.it.id), t.erreur);
        oublierPage(a.url);
      }
    } else {
      t.verdicts = diffusions.map((d) => controleSource(sansPrisesReelles(verifier(a, cites, d), a), a));
      const gardes = meilleures(t.verdicts);
      rapport.gardees += gardes.length;
      if (!opts.essai) {
        for (const v of gardes) await enregistrerAnnonce(deps.pool, a, v);
        await noterArticle(deps.pool, a, gardes.length ? "annonces" : "sans_annonce", cites.map((c) => c.it.id), `${gardes.length} gardée(s) sur ${diffusions.length}`);
        oublierPage(a.url);
      }
    }
    rapport.traites.push(t);
    opts.suivi?.(t, n, envoyes.length);
  }
  return rapport;
}

// ─────────────────────────────────────────────────────────────── cron
let enCours = false;
let dernierAvertissement = 0;

export function startPresseCron(deps: PresseDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts) : PRESSE_ENABLED ne sert plus qu'à la première mise en route ; la configuration est lue dans
  // tous les cas, pour que l'interrupteur du Pilotage puisse rallumer la presse sans redémarrer l'API.
  const cfg = configEssai(env);
  const actifParDefaut = env["PRESSE_ENABLED"] === "1";
  deps.log.info({ module: "presse", modele: cfg.modele, maxParPassage: cfg.maxParPassage, jours: cfg.jours, actifParDefaut }, "presse : planifiée");
  const tick = async (): Promise<void> => {
    if (enCours) return;
    enCours = true;
    const debut = Date.now();
    try {
      const r = await passage(deps, cfg, { essai: false, max: cfg.maxParPassage });
      const details = {
        articlesLus: r.lecture.gameblogLus + r.lecture.levelupFlux + Object.values(r.lecture.sources).reduce((t, x) => t + x.nouveaux, 0),
        retenus: r.retenus, envoyes: r.envoyes,
        annonces: r.gardees, erreurs: r.lecture.erreurs.length, arret: r.arret ?? null,
      };
      trackLastRun("presse", details, Date.now() - debut);
      if (r.envoyes || r.arret || r.lecture.erreurs.length) {
        deps.log[r.arret ? "warn" : "info"]({ module: "presse", ...details, premieresErreurs: r.lecture.erreurs.slice(0, 3) }, "presse : passage terminé");
      }
      if (r.gardees > 0) {
        const titres = [...new Set(r.traites.flatMap((t) => meilleures(t.verdicts).map((v) => v.anime!.titleEnglish || v.anime!.title)))];
        pushActivity({ type: "presse", message: `${r.gardees} annonce${r.gardees > 1 ? "s" : ""} France lue${r.gardees > 1 ? "s" : ""} dans la presse`, detail: coupe(titres.join(", "), 200), level: "info" });
      }
      // Ollama occupé ou arrêté : on reprend au passage suivant ; le tableau de bord n'est prévenu qu'une fois par jour.
      if (r.arret && Date.now() - dernierAvertissement > 24 * 3600 * 1000) {
        dernierAvertissement = Date.now();
        pushActivity({ type: "presse", message: "Lecture de la presse en attente d'Ollama", detail: r.arret, level: "warn" });
      }
    } catch (e) {
      deps.log.error({ module: "presse", err: (e as Error).message }, "presse : passage interrompu");
      trackLastRun("presse", { erreur: (e as Error).message }, Date.now() - debut);
    } finally {
      enCours = false;
    }
  };
  planifier({ id: "presse", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "presse", actifParDefaut, passage: tick });
}
