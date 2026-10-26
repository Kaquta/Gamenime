/**
 * synopsis.ts — synopsis français rédigés en local par Ollama (v8.7).
 *
 * `description` garde le texte des sources (AniList, IGDB…) et ne sert plus
 * que d'entrée. Ollama en tire un synopsis original en français, rangé dans
 * `synopsis_fr` (migration 014) : la seule colonne que le site affichera.
 *
 * Trois temps, pour comprendre l'œuvre puis écrire avec nos mots :
 *   0. se renseigner : le module monte une fiche (personnages, genre, rôle,
 *      œuvre précédente ou série, genres IGDB) et un dossier. Les thèmes
 *      AniList ne servent plus qu'aux contrôles : montrés au modèle, ils lui
 *      faisaient écrire un synopsis sans histoire (essai v8.3 : Re:Zero Break
 *      Time, d'après « Chibi » et « Maids »).
 *      Animés (choix de Rey, 12 octobre : « Anime News Network, AniList, Kitsu,
 *      AnimeSchedule et la partie Presse ») : la description AniList à jour sert
 *      de texte de présentation ; le dossier prend les synopsis de Kitsu et
 *      d'AnimeSchedule, la fiche Anime News Network de la saison, les articles de
 *      presse que le module presse a rattachés à l'animé (relus, robots.txt
 *      respecté) et, pour une suite présentée en une ligne, la première saison
 *      sur ANN. Jeux : Wikipédia,
 *      histoire IGDB, page Steam. Pas de recherche web : les crédits Tavily vont
 *      au module plateformes. Le modèle ne va pas sur Internet lui-même : c'est ce
 *      module qui se renseigne pour lui. Sa mémoire mélange le vrai et le faux :
 *      ce qui est vrai, c'est ce que les sources confirment ;
 *   1. notes : le modèle tire du texte de présentation et du dossier des notes
 *      françaises télégraphiques, personnages nommés ;
 *   2. rédaction : il écrit le synopsis à partir des seules notes (et du genre
 *      des personnages qu'elles citent), sans revoir le texte d'origine.
 * Retirés en v8.2 après l'essai v8.1, qui prenait plus de 5 min par item :
 *   - le « Sens » (le texte redit en anglais avant les notes) : souvent écrit en
 *     français malgré la consigne, il a ajouté des erreurs (Witch Hat : « la
 *     sorcière Qifrey » ; Classroom v7 : « rejoignent la classe ») et environ
 *     30 s de génération par item ;
 *   - la relecture par le modèle : 4 remarques fausses sur 5 (Classroom : la
 *     White Room « absente des sources », puis retirée du synopsis), et près de
 *     2 min par item, en coupant le cache de la consigne de rédaction.
 * Les items passent par paquets (notes du paquet, puis rédaction du paquet) :
 * Ollama garde ainsi en cache la partie fixe de chaque prompt. Sur kaquta, lire
 * un prompt coûte environ 40 jetons/s et générer 3 jetons/s (essai v8.1).
 *
 * - Une suite présentée en une ligne (« The second season of Youjo Senki. ») :
 *   la première saison sur ANN sert de prémisse ; si rien n'en dit plus, pas de
 *   synopsis (no_source, nouvel essai 7 jours plus tard), jamais l'histoire de
 *   l'œuvre précédente. Essai v8.3 : Tanya II raconté avec le film d'avant.
 * - Ne remplit que les lignes vides : un synopsis relu ou écrit à la main n'est
 *   jamais régénéré. Pour en refaire un : synopsis_fr = NULL, synopsis_status = NULL.
 * - Ni date ni plateformes dans le texte : elles changent, et la fiche les
 *   affiche déjà (une seule source de vérité).
 * - Longueur proportionnelle aux notes : une source pauvre donne un synopsis
 *   court, plutôt qu'un texte rallongé de détails inventés.
 * - Fiche indisponible (pas d'identifiant, IGDB en panne) : on continue sans.
 *   AniList qui refuse (429) : un nouvel essai après l'attente demandée (90 s au
 *   plus). Encore refusé, en panne, injoignable ou réponse illisible : pas de
 *   synopsis sans fiche (v8.7, essai v8.6 : Tanya II et JJK S3 sans fiche) ;
 *   échec noté « fiche indisponible », nouvel essai une heure plus tard. Deux
 *   échecs de suite dans un passage : les animés suivants sont remis au passage
 *   d'après sans interroger AniList, rien n'est écrit pour eux.
 * - Jeux sans page Steam indiquée par IGDB : Steam est cherché au titre du site,
 *   puis à celui de l'article Wikipédia retenu, s'il désigne le même jeu
 *   (« Resident Evil 9: Requiem » → « Resident Evil Requiem »).
 * - Noms de la fiche écrits comme dans le texte (AniList « Yuuji », texte « Yuji » : Yuji).
 * - Année de sortie, ou sa décennie (« années 2020 » pour 2026) : retirée des
 *   notes, refusée dans le synopsis (la fiche du site affiche la date).
 * - Ajouts fréquents du modèle (genre de jeu, missions, course automobile,
 *   survie, morts-vivants…) : permis si le texte ou le dossier les confirment
 *   (Pragmata : « hostile artificial intelligence »), sinon retirés des notes et
 *   refusés dans le synopsis. Même règle pour l'année : RE Requiem est « set in
 *   October 2026 » (le cadre, permis), pas seulement sorti en 2026.
 * - Plateformes refusées (Wikipédia les cite en tête d'article).
 * - 2e essai : le modèle corrige son texte refusé, avec le motif et un conseil ;
 *   même chose pour un texte trop long.
 * - Tourne dans une fenêtre horaire (heure de Paris). Si Ollama ne répond pas,
 *   le passage s'arrête sans toucher aux items. Coupé ou mis en pause dans le
 *   Pilotage, il s'arrête après le synopsis en cours (v9.5).
 * - Ne modifie pas `updated_at`.
 * - Essai à blanc, sans rien écrire en base : synopsis-essai.ts.
 *
 * Branchement (v9.5) : le cycle est planifié par le Pilotage du dashboard, dans
 * synopsis-bloc.ts (startSynopsisCron), avec le bloc de relecture ; ce fichier
 * ne dépend pas du dashboard (l'essai à blanc, synopsis-essai.ts, s'en sert seul).
 *
 * Variables d'environnement (service content-api) :
 *   SYNOPSIS_ENABLED      "1" : allumé à la première mise en route du Pilotage (défaut "0") ;
 *                         ensuite, seul l'interrupteur du Pilotage compte
 *   OLLAMA_URL            défaut http://ollama:11434
 *   SYNOPSIS_MODEL        défaut ministral-3:8b
 *   SYNOPSIS_WINDOW       heures de Paris « début-fin », défaut 3-7 ; 0-24 = toujours
 *   SYNOPSIS_MAX_PER_RUN  items par passage, défaut 300
 *   SYNOPSIS_REVIEW_TOP   les N plus populaires de la fenêtre de 2 ans passent en relecture, défaut 25
 *   SYNOPSIS_THREADS      cœurs donnés à Ollama, défaut 4 (= « cpus » du service ollama ;
 *                         banc-ollama.sh mesure la vitesse selon le nombre de cœurs)
 *   TWITCH_CLIENT_ID/SECRET (déjà présents) : accès IGDB pour la fiche des jeux
 *   ANIMESCHEDULE_TOKEN   (déjà présent) : synopsis AnimeSchedule des animés
 *   Kitsu : API publique sans clé (kitsu.io), retrouvée par mal_id ou anilist_id
 *   Wikipédia (jeux) : API publique sans clé (en.wikipedia.org), joignable depuis le conteneur
 *   Steam (jeux) et Anime News Network (animés) : API publiques sans clé
 *   Presse (animés) : table presse_articles du module presse ; pages relues par GameNimeBot
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout } from "node:timers";
import { z } from "zod";
import { igdbFetch } from "./twitch.js";

// ─── Types et dépendances ────────────────────────────────────────────────────

export type ItemType = "anime" | "game";
// v9.5 : « correction » = Rey a signalé des phrases fausses dans le bloc du dashboard ; le cron les corrige
export type SynopsisStatus = "auto" | "to_review" | "approved" | "failed" | "no_source" | "correction";

/** Ce que le module attend du pool : mysql2 comme le connecteur mariadb conviennent. */
export interface SqlPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Sous-ensemble du logger pino de Fastify (app.log). */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SynopsisDeps {
  pool: SqlPool;
  log: Logger;
}

export interface SynopsisConfig {
  ollamaUrl: string;
  model: string;
  window: readonly [number, number];
  maxPerRun: number;
  reviewTop: number;
  threads: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** `maxTokens` : longueur de réponse permise (défaut 300). */
export type ChatFn = (cfg: SynopsisConfig, messages: ChatMessage[], temperature: number, maxTokens?: number) => Promise<string>;

/** Un essai de rédaction (essai à blanc et journaux, jamais enregistré). */
export interface Attempt {
  text: string;
  refused: string[]; // pourquoi il a été refait ou écarté (contrôles, longueur) ; vide = gardé
}

export interface Outcome {
  /**
   * `postponed` : rien n'est enregistré, l'item revient au passage suivant. AniList indisponible (essai
   * v8.6 : HTTP 429 sur Tanya II et JJK S3) : écrire sans fiche ferait perdre les personnages et leur
   * genre, l'œuvre précédente et les noms que cherche la presse.
   */
  status: Exclude<SynopsisStatus, "approved" | "correction"> | "postponed";
  text: string | null;
  note: string | null;
  /** Statut failed : dernière réponse refusée (journaux et essai à blanc, jamais enregistrée). */
  rejected?: string;
  /** Essais dans l'ordre ; le texte gardé est le dernier essai qui porte ce texte. */
  attempts?: Attempt[];
}

export interface RunReport {
  processed: number;
  auto: number;
  toReview: number;
  failed: number;
  noSource: number;
  postponed: number; // remis au passage suivant, rien d'enregistré (pas compté dans processed)
  stop: "done" | "window" | "ollama" | "off"; // off : coupé ou mis en pause dans le Pilotage (v9.5)
  corrections?: CorrectionReport; // v9.5 : corrections demandées dans le bloc, faites en premier
  durationS: number;
  tokens: { input: number; output: number };
  error?: string;
}

// ─── Réglages ────────────────────────────────────────────────────────────────

// Ollama traite une requête à la fois (OLLAMA_NUM_PARALLEL 1) et la presse s'en sert aussi : un appel peut
// attendre son tour plusieurs minutes. Appel par node:http (fetch coupe à 300 s), 15 min au plus.
const OLLAMA_TIMEOUT_MS = 15 * 60_000;
const FACTS_TIMEOUT_MS = 15_000; // AniList, IGDB
// AniList refuse au-delà de 30 requêtes par minute, budget partagé avec les Phases B et C et le cycle de
// popularité : un refus (429) est réessayé une fois après l'attente demandée (Retry-After), comme le fait
// popularite.ts. 60 s si AniList n'en dit rien ; s'il demande plus de 90 s, on n'attend pas (revue v8.7 :
// attendre 90 s pour un second refus certain bloquait le passage)
const ANILIST_WAIT_MS = 60_000;
const ANILIST_MAX_WAIT_MS = 90_000;
// fiche AniList indisponible pour un item (panne, refus répétés) : échec noté, nouvel essai 1 h plus tard
// (pas 7 jours) ; l'item ne bloque plus la file. Deux échecs de suite dans un passage = panne : les animés
// suivants de ce passage sont remis sans interroger AniList (revue v8.7)
const FACTS_DOWN = "fiche indisponible"; // début de synopsis_note pour ces échecs (règle de nouvel essai)
const FACTS_RETRY_MINUTES = 60;
const ANILIST_BREAKER = 2;
// AniList jugé en panne : réinterrogé 10 min plus tard, même au milieu d'un long passage (un passage de nuit
// dure des heures : une rafale de refus ne doit pas priver de fiche tous les animés de la nuit, revue v8.7)
const ANILIST_COOLDOWN_MS = 10 * 60_000;
const RETRY_DAYS = 7; // délai avant de retenter failed / no_source
const CHUNK = 8; // items par paquet (notes du paquet, puis rédaction)

const MIN_SOURCE = 60; // en dessous : pas de texte exploitable
// animés : mots qui racontent quelque chose de l'œuvre (storyWords), dans le texte et le dossier hors œuvre
// précédente (« The fourth season of Re:Zero… » : aucun) ; en dessous : pas de synopsis
const MIN_STORY_WORDS = 4;
const RETRY_NOTES_SOURCE = 150; // source « vide » selon le modèle mais au moins aussi longue : notes redemandées
const MAX_SOURCE = 1500; // texte source tronqué au-delà
const MAX_NOTES = 5; // essai v8.3 : à 6 notes, des textes de 440 à 520 car. et un 2e essai pour raccourcir
const NOTE_MAX = 220; // v9.3 : longueur d'une note (160 avant : Nioh 3, une note coupée au milieu d'un mot)
const MIN_NOTES_KEPT = 3; // v9.3 : moins de notes gardées et une preuve perdue : relance (essai v9.2 : 007, 169 car.)
const MAX_MAIN = 4; // personnages principaux dans la fiche
const MAX_OTHERS = 4; // personnages secondaires dans la fiche
const HARD_MIN = 50; // plus court : refusé (une source pauvre donne une phrase, pas rien)
// v9.1 : une phrase par note, 100 caractères environ chacune (lengthHint) ; le modèle dépasse d'environ un quart
const HARD_MAX = 650;
const SOFT_MAX = 560; // au-delà : un essai pour raccourcir, puis relecture
const COPY_RUN = 6; // 6 mots consécutifs communs avec la source = copie
const TEMPERATURES = [0.1, 0.2] as const; // rédaction : 1er essai, puis correction après refus
const NOTES_TOKENS = 600; // étape 1 : 5 notes au plus, chacune avec sa preuve (v9.1)
const WRITE_TOKENS = 400;
const MAX_SENSE = 8; // « Sens » écrit quand même par le modèle : lignes gardées pour l'affichage
// fenêtre du modèle : consigne + exemples (~2 000 jetons), fiche, dossier et texte (~1 200), réponse (300)
const NUM_CTX = 5120;

// Dossier : de quoi se renseigner sans dépasser la fenêtre du modèle (NUM_CTX)
const MIN_TAG_RANK = 60; // thèmes AniList : pertinence minimale (0-100)
const MAX_TAGS = 8;
const MAX_PREQUEL_TEXT = 700; // résumé de l'œuvre précédente (saison ou film)
const MAX_IGDB_TEXT = 700; // histoire ou résumé IGDB
const MAX_WIKI_INTRO = 600; // Wikipédia : début de l'article
const MAX_WIKI_STORY = 800; // Wikipédia : début de l'intrigue, du synopsis ou du cadre
const MAX_WIKI_GAMEPLAY = 400; // Wikipédia : début du gameplay (jeux)
const MAX_STEAM_TEXT = 700; // page Steam : « About this game »
const MAX_ANN_TEXT = 700; // Anime News Network : résumé de l'intrigue
const MAX_ANN_BYTES = 5_000_000; // réponse d'ANN au-delà : ignorée (une recherche trop large)
const ANN_GAP_MS = 1100; // règle d'ANN : une requête par seconde
const MAX_DOSSIER = 2000; // tout le dossier (lire un prompt coûte : environ 40 jetons/s sur kaquta)
const RICH_SOURCE = 300; // texte de présentation assez riche : le résumé de l'œuvre précédente n'apporte rien
const MAX_SYNOPSIS_TEXT = 900; // synopsis Kitsu ou AnimeSchedule
const NEAR_DUPLICATE = 0.6; // part de suites de 4 mots déjà lues au-delà de laquelle un texte est un doublon
const PREQUEL_SOURCE = "Œuvre précédente"; // début du libellé du résumé de l'œuvre précédente, dans le dossier
const PRESSE_SOURCE = "Presse"; // début du libellé d'un passage d'article de presse
const OLD_ARTICLE_YEARS = 3; // jeu : article Wikipédia d'un jeu sorti au moins 3 ans avant celui-ci = un autre jeu
// SYNOPSIS_WIKIPEDIA_URL : pour les tests (faux serveur) ; en production, l'API anglaise
const WIKI_API = process.env["SYNOPSIS_WIKIPEDIA_URL"] || "https://en.wikipedia.org/w/api.php";
const WIKI_AGENT = "GameNime/1.0 (https://gamenime.fr; synopsis)"; // règle de Wikimedia : un User-Agent qui identifie l'outil
// SYNOPSIS_KITSU_URL, SYNOPSIS_ANIMESCHEDULE_URL : pour les tests (faux serveurs)
const KITSU_API = process.env["SYNOPSIS_KITSU_URL"] || "https://kitsu.io/api/edge";
const ANIMESCHEDULE_API = process.env["SYNOPSIS_ANIMESCHEDULE_URL"] || "https://animeschedule.net/api/v3";
// SYNOPSIS_STEAM_URL, SYNOPSIS_ANN_URL : pour les tests (faux serveurs)
const STEAM_STORE = process.env["SYNOPSIS_STEAM_URL"] || "https://store.steampowered.com";
const ANN_API = process.env["SYNOPSIS_ANN_URL"] || "https://cdn.animenewsnetwork.com/encyclopedia/api.xml";

const TABLES: Record<ItemType, { table: string; kind: string; ext: string; mal: string; route: string }> = {
  anime: { table: "anime_items", kind: "format", ext: "anilist_id", mal: "mal_id", route: "anime_schedule_route" },
  game: { table: "game_items", kind: "game_type", ext: "igdb_id", mal: "NULL", route: "NULL" },
};

const EnvSchema = z.object({
  SYNOPSIS_ENABLED: z.enum(["0", "1"]).default("0"),
  OLLAMA_URL: z.string().url().default("http://ollama:11434"),
  SYNOPSIS_MODEL: z.string().min(1).default("ministral-3:8b"),
  SYNOPSIS_WINDOW: z.string().default("3-7"),
  SYNOPSIS_MAX_PER_RUN: z.coerce.number().int().min(1).max(5000).default(300),
  SYNOPSIS_REVIEW_TOP: z.coerce.number().int().min(0).max(1000).default(25),
  SYNOPSIS_THREADS: z.coerce.number().int().min(1).max(64).default(4),
});

/**
 * Config lue dans l'environnement ; null si SYNOPSIS_ENABLED n'est pas à 1 (essai à blanc, qui le force).
 * Lève une erreur si une valeur est invalide.
 */
export function readConfig(env: Record<string, string | undefined>): SynopsisConfig | null {
  if (EnvSchema.parse(env).SYNOPSIS_ENABLED !== "1") return null;
  return settingsFrom(env);
}

/**
 * v9.5 : les réglages, que le module soit allumé ou non. L'interrupteur est dans le Pilotage : il rallume le
 * synopsis sans redémarrer l'API. Lève une erreur si une valeur est invalide.
 */
export function settingsFrom(env: Record<string, string | undefined>): SynopsisConfig {
  const e = EnvSchema.parse(env);
  return {
    ollamaUrl: e.OLLAMA_URL.replace(/\/+$/, ""),
    model: e.SYNOPSIS_MODEL,
    window: parseWindow(e.SYNOPSIS_WINDOW),
    maxPerRun: e.SYNOPSIS_MAX_PER_RUN,
    reviewTop: e.SYNOPSIS_REVIEW_TOP,
    threads: e.SYNOPSIS_THREADS,
  };
}

// ─── Fenêtre horaire ─────────────────────────────────────────────────────────

export function parseWindow(spec: string): readonly [number, number] {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec.trim());
  const start = Number(m?.[1]);
  const end = Number(m?.[2]);
  if (!m || start > 23 || end < 1 || end > 24 || start === end) {
    throw new Error(`SYNOPSIS_WINDOW invalide : « ${spec} » (attendu « début-fin », ex. 3-7 ou 0-24)`);
  }
  return [start, end];
}

const PARIS_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" });

export function parisHour(d: Date): number {
  return Number(PARIS_HOUR.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0") % 24;
}

/** [début, fin) ; une fenêtre comme 22-6 passe minuit. */
export function inWindow(hour: number, [start, end]: readonly [number, number]): boolean {
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ─── Fiche de l'œuvre : se renseigner avant de lire ──────────────────────────

export type Gender = "masculin" | "féminin" | "non binaire";

export interface Character {
  name: string;
  gender: Gender | null;
  main: boolean; // rôle principal (AniList) ; IGDB ne distingue pas
}

/** Texte de référence du dossier : Wikipédia, histoire IGDB, œuvre précédente AniList. */
export interface DossierEntry {
  source: string; // « Wikipédia : Pragmata », « Histoire (IGDB) », « Œuvre précédente (AniList) : … »
  text: string;
}

export interface ItemFacts {
  characters: Character[];
  prequel: string | null; // animés : œuvre précédente (relation PREQUEL)
  series: string | null; // jeux : série ou franchise
  genres: string[]; // jeux : genres, thèmes et modes IGDB (« Role-playing (RPG) », « Multiplayer »)
  tags: string[]; // animés : thèmes AniList sans spoiler (« Witch », « Survival »)
  dossier: DossierEntry[]; // de quoi comprendre et vérifier : ce qui y est confirmé peut s'écrire
  cast?: string[]; // animés : tous les personnages lus sur AniList (25 au plus), pour reconnaître leurs noms dans la presse
}

/** Fiche, ou pourquoi elle manque (« pas d'identifiant AniList », « IGDB HTTP 401 »…). */
export interface FactsResult {
  facts: ItemFacts | null;
  note: string | null;
  wikiTitle?: string | null; // jeux : article Wikipédia indiqué par IGDB
  steamId?: number | null; // jeux : page Steam indiquée par IGDB
  description?: string | null; // animés : description AniList à jour, texte de présentation
  malId?: number | null; // animés : identifiant MyAnimeList donné par AniList (pour Kitsu)
  retryLater?: boolean; // AniList indisponible pour l'instant (refus répétés, panne, réseau) : item remis
  press?: PresseSeen[]; // animés : articles de presse examinés et ce qu'il en est sorti (essai à blanc)
  officialLinks?: OfficialLink[]; // v9.3 : site officiel (AniList « Official Site », IGDB websites type 1)
  nativeTitle?: string; // animés : titre japonais (AniList), pour reconnaître le site officiel japonais
  nativeNames?: ReadonlyArray<readonly [string, string]>; // animés : noms japonais des personnages et leur forme latine (glossaire de traduction)
  official?: OfficialSeen; // v9.3 : ce que le site officiel a donné (essai, journaux)
  officialPending?: OfficialPending; // v9.3 : description japonaise du site officiel, à traduire (draftItems, qui a Ollama)
}

export type FactsFn = (type: ItemType, item: ItemRow) => Promise<FactsResult>;

/** Genre d'AniList (« Male », « Female », « Non-binary ») ou d'IGDB (nom, ou ancien code 0 / 1). */
export function genderOf(raw: string | number | null | undefined): Gender | null {
  if (raw === 0) return "masculin";
  if (raw === 1) return "féminin";
  const g = String(raw ?? "").trim().toLowerCase();
  if (g === "male") return "masculin";
  if (g === "female") return "féminin";
  if (g === "non-binary" || g === "nonbinary" || g === "non binary") return "non binaire";
  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Valeur d'une table indexée par un mot du texte, sans les propriétés héritées : « constructor »
 * (un mot qu'on trouve dans les sources) donnait la fonction Object et faisait planter le contrôle,
 * donc le passage, sur le même item à chaque fois (relecture de la v8.4).
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const ANILIST_URL = "https://graphql.anilist.co";

const ANILIST_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    idMal
    title { native }
    description(asHtml: false)
    characters(sort: [ROLE, RELEVANCE, ID], perPage: 25) { edges { role node { name { full native } gender } } }
    externalLinks { url site language }
    relations { edges { relationType(version: 2) node { type title { romaji english } description(asHtml: false) } } }
    tags { name rank isMediaSpoiler isGeneralSpoiler }
  }
}`;

const AniListFactsResponse = z.object({
  data: z
    .object({
      Media: z
        .object({
          idMal: z.number().nullish(),
          title: z.object({ native: z.string().nullish() }).nullish(),
          description: z.string().nullish(),
          externalLinks: z.array(z.object({ url: z.string().nullish(), site: z.string().nullish(), language: z.string().nullish() }).nullish()).nullish(),
          characters: z
            .object({
              edges: z
                .array(
                  z.object({
                    role: z.string().nullish(),
                    node: z.object({ name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(), gender: z.string().nullish() }).nullish(),
                  }),
                )
                .nullish(),
            })
            .nullish(),
          relations: z
            .object({
              edges: z
                .array(
                  z.object({
                    relationType: z.string().nullish(),
                    node: z
                      .object({
                        type: z.string().nullish(),
                        title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
                        description: z.string().nullish(),
                      })
                      .nullish(),
                  }),
                )
                .nullish(),
            })
            .nullish(),
          tags: z
            .array(
              z.object({
                name: z.string().nullish(),
                rank: z.number().nullish(),
                isMediaSpoiler: z.boolean().nullish(),
                isGeneralSpoiler: z.boolean().nullish(),
              }),
            )
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  // réponse partielle (une partie de la requête en erreur, ex. characters à null) : pas une fiche complète
  errors: z.array(z.unknown()).nullish(),
});

export type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attente demandée par un refus (en-tête Retry-After : secondes ou date HTTP), 1 s au moins ; 60 s sans en-tête lisible. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  const raw = (header ?? "").trim();
  const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : Number.NaN;
  if (!Number.isFinite(ms)) return ANILIST_WAIT_MS;
  return Math.max(1000, Math.ceil(ms));
}

/**
 * Fiche AniList de l'animé. Un refus (429) est réessayé une fois, après l'attente demandée (90 s au plus :
 * au-delà, pas d'attente). Encore refusé, AniList en panne, injoignable, réponse coupée ou illisible :
 * `retryLater` (draftItems : échec noté, nouvel essai 1 h plus tard). Seuls 400 et 404 (requête ou
 * identifiant inconnus, rien à attendre) laissent continuer sans fiche, comme avant. Ne lève jamais d'erreur.
 */
export async function fetchAniListFacts(anilistId: number, url = ANILIST_URL, wait: Sleep = sleep): Promise<FactsResult> {
  const ask = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: anilistId } }),
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
  let res: Response;
  let body: string;
  let waited = 0;
  try {
    res = await ask();
    if (res.status === 429) {
      const asked = retryAfterMs(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => undefined); // libère la connexion pendant l'attente
      if (asked > ANILIST_MAX_WAIT_MS) return { facts: null, note: `AniList HTTP 429 (attente demandée : ${Math.round(asked / 1000)} s)`, retryLater: true };
      waited = asked;
      await wait(waited);
      res = await ask();
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const second = waited > 0 ? ` (2e essai après ${Math.round(waited / 1000)} s d'attente)` : "";
      // 400, 404 : la requête ou l'identifiant ne changeront pas, rien à attendre ; on continue sans fiche
      // (403 d'un pare-feu, 408, 429, 5xx : passagers)
      const later = res.status !== 400 && res.status !== 404;
      return { facts: null, note: `AniList HTTP ${res.status}${second}`, ...(later ? { retryLater: true } : {}) };
    }
    body = await res.text(); // réponse coupée en route : une panne passagère, pas une fiche vide (revue v8.7)
  } catch (err) {
    return { facts: null, note: `AniList injoignable : ${errMessage(err)}`, retryLater: true };
  }
  const second = waited > 0 ? `2e essai après ${Math.round(waited / 1000)} s d'attente` : "";
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const parsed = AniListFactsResponse.safeParse(json);
  const media = parsed.success ? parsed.data.data?.Media : null;
  if (!media) return { facts: null, note: "réponse d'AniList illisible", retryLater: true };
  // une erreur GraphQL dans une réponse 200 : des champs manquent (personnages à null…), la fiche serait fausse
  if (parsed.success && (parsed.data.errors?.length ?? 0) > 0) return { facts: null, note: "réponse d'AniList partielle (erreur GraphQL)", retryLater: true };

  const main: Character[] = [];
  const others: Character[] = [];
  const seen = new Set<string>();
  const cast = [...new Set((media.characters?.edges ?? []).map((e) => e.node?.name?.full?.trim() ?? "").filter(Boolean))];
  for (const edge of media.characters?.edges ?? []) {
    const name = edge.node?.name?.full?.trim();
    if (!name || seen.has(name)) continue;
    const character = { name, gender: genderOf(edge.node?.gender), main: edge.role === "MAIN" };
    if (edge.role === "MAIN" && main.length < MAX_MAIN) main.push(character);
    else if (edge.role === "SUPPORTING" && others.length < MAX_OTHERS) others.push(character);
    else continue;
    seen.add(name);
  }
  const prequel = (media.relations?.edges ?? []).find((e) => e.relationType === "PREQUEL" && (e.node?.type ?? "ANIME") === "ANIME");
  const prequelTitle = prequel?.node?.title?.english?.trim() || prequel?.node?.title?.romaji?.trim() || null;
  // thèmes sûrs (rang AniList élevé, sans spoiler) : « Witch », « Survival », « Horses »…
  const tags = (media.tags ?? [])
    .filter((t) => t.name && !t.isMediaSpoiler && !t.isGeneralSpoiler && (t.rank ?? 0) >= MIN_TAG_RANK)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .slice(0, MAX_TAGS)
    .map((t) => t.name!.trim());
  // le résumé de l'œuvre précédente (saison ou film) : une suite décrite en une ligne garde de quoi
  // être située. Le libellé dit que c'est l'avant : essai v7, le film de Tanya raconté comme la saison 2
  const dossier: DossierEntry[] = [];
  const previous = clipText(cleanSource(prequel?.node?.description ?? null), MAX_PREQUEL_TEXT);
  if (prequelTitle && previous.length >= MIN_SOURCE) dossier.push({ source: `${PREQUEL_SOURCE} (AniList) : ${prequelTitle}`, text: previous });
  // v9.3 : le site officiel (lien « Official Site » d'AniList) et les noms japonais, pour lire et traduire sa description
  const officialLinks = (media.externalLinks ?? [])
    .filter((l) => /^official\s*site$/i.test(l?.site?.trim() ?? "") && /^https?:\/\//i.test(l?.url?.trim() ?? ""))
    .map((l): OfficialLink => ({ url: l!.url!.trim(), language: l!.language?.trim() || null }));
  const nativeNames = (media.characters?.edges ?? [])
    .map((e) => [e.node?.name?.native?.trim() ?? "", e.node?.name?.full?.trim() ?? ""] as const)
    .filter(([native, full]) => native.length > 0 && full.length > 0);
  return {
    facts: { characters: [...main, ...others], prequel: prequelTitle, series: null, genres: [], tags, dossier, ...(cast.length ? { cast } : {}) },
    // visible dans l'essai et les journaux : AniList a refusé une fois (limite de requêtes partagée)
    note: second ? `AniList : refus 429, fiche obtenue au ${second}` : null,
    description: media.description?.trim() || null,
    malId: media.idMal && media.idMal > 0 ? media.idMal : null,
    ...(officialLinks.length ? { officialLinks } : {}),
    ...(media.title?.native?.trim() ? { nativeTitle: media.title.native.trim() } : {}),
    ...(nativeNames.length ? { nativeNames } : {}),
  };
}

// ─── Kitsu et AnimeSchedule : les autres synopsis de la saison (animés) ──────
// Trois textes de la même saison (AniList, Kitsu, AnimeSchedule) : le modèle croise
// ce qu'ils disent et écrit le sien. Souvent, ils se recopient : les doublons sont
// écartés du dossier (trimDossier), il ne reste que ce qui ajoute quelque chose.

const KitsuMappingsResponse = z.object({
  data: z
    .array(
      z.object({
        relationships: z.object({ item: z.object({ data: z.object({ type: z.string(), id: z.string() }).nullish() }).nullish() }).nullish(),
      }),
    )
    .nullish(),
  included: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        attributes: z.object({ synopsis: z.string().nullish(), description: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

/** Synopsis Kitsu de l'anime, retrouvé par son identifiant MyAnimeList, sinon AniList. Ne lève jamais d'erreur. */
export async function fetchKitsu(ids: { mal: number | null; anilist: number | null }, api = KITSU_API): Promise<WebResult> {
  const tries: Array<[string, number]> = [];
  if (ids.mal) tries.push(["myanimelist/anime", ids.mal]);
  if (ids.anilist) tries.push(["anilist/anime", ids.anilist]);
  if (tries.length === 0) return { entry: null, note: "Kitsu : pas d'identifiant" };
  try {
    for (const [site, id] of tries) {
      const qs = new URLSearchParams({ "filter[externalSite]": site, "filter[externalId]": String(id), include: "item" });
      const res = await fetch(`${api}/mappings?${qs}`, {
        headers: { accept: "application/vnd.api+json", "user-agent": WIKI_AGENT },
        signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
      });
      if (!res.ok) return { entry: null, note: `Kitsu HTTP ${res.status}` };
      const parsed = KitsuMappingsResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return { entry: null, note: "réponse de Kitsu illisible" };
      const ref = parsed.data.data?.[0]?.relationships?.item?.data;
      const anime = ref?.type === "anime" ? parsed.data.included?.find((x) => x.type === "anime" && x.id === ref.id) : undefined;
      if (!anime) continue;
      const text = clipText(cleanSource(anime.attributes?.synopsis || anime.attributes?.description || null), MAX_SYNOPSIS_TEXT);
      return text.length >= MIN_SOURCE ? { entry: { source: "Synopsis (Kitsu)", text }, note: null } : { entry: null, note: "Kitsu : synopsis vide" };
    }
    return { entry: null, note: "Kitsu : pas de fiche" };
  } catch (err) {
    return { entry: null, note: `Kitsu injoignable : ${errMessage(err)}` };
  }
}

const AnimeScheduleResponse = z.object({ description: z.string().nullish() });

/** Synopsis AnimeSchedule de l'anime (route rattachée par refetch-cron, jeton ANIMESCHEDULE_TOKEN). Ne lève jamais d'erreur. */
export async function fetchAnimeScheduleSynopsis(
  route: string | null,
  token = process.env["ANIMESCHEDULE_TOKEN"] ?? "",
  api = ANIMESCHEDULE_API,
): Promise<WebResult> {
  if (!route?.trim()) return { entry: null, note: "AnimeSchedule : pas de route" };
  if (!token.trim()) return { entry: null, note: "AnimeSchedule : ANIMESCHEDULE_TOKEN absent" };
  try {
    const res = await fetch(`${api}/anime/${encodeURIComponent(route.trim())}`, {
      headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" },
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!res.ok) return { entry: null, note: `AnimeSchedule HTTP ${res.status}` };
    const parsed = AnimeScheduleResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { entry: null, note: "réponse d'AnimeSchedule illisible" };
    const text = clipText(cleanSource(parsed.data.description ?? null), MAX_SYNOPSIS_TEXT);
    return text.length >= MIN_SOURCE ? { entry: { source: "Synopsis (AnimeSchedule)", text }, note: null } : { entry: null, note: "AnimeSchedule : synopsis vide" };
  } catch (err) {
    return { entry: null, note: `AnimeSchedule injoignable : ${errMessage(err)}` };
  }
}

/** Signature d'igdbFetch (twitch.ts : jeton Twitch, Client-ID, nouvel essai sur 401). */
export type IgdbFetch = (url: string, init: RequestInit) => Promise<Response>;

const IgdbNamed = z.array(z.object({ name: z.string().nullish() })).nullish();

const IgdbGamesResponse = z.array(
  z.object({
    collections: IgdbNamed,
    franchises: IgdbNamed,
    genres: IgdbNamed,
    themes: IgdbNamed,
    game_modes: IgdbNamed,
    summary: z.string().nullish(),
    storyline: z.string().nullish(),
    // v9.3 : type 1 = site officiel (« type » remplace l'ancien « category », même code)
    websites: z.array(z.object({ url: z.string().nullish(), type: z.union([z.number(), z.object({ id: z.number().nullish() })]).nullish() })).nullish(),
  }),
);

const IGDB_GAME_FIELDS = "collections.name, franchises.name, genres.name, themes.name, game_modes.name, summary, storyline, websites.url";

/** « https://en.wikipedia.org/wiki/Resident_Evil_Requiem » → « Resident Evil Requiem ». */
export function wikiTitleFromUrl(url: string): string | null {
  const m = /^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i.exec(url.trim());
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, " ").trim() || null;
  } catch {
    return null;
  }
}

const IgdbCharactersResponse = z.array(
  z.object({
    name: z.string().nullish(),
    gender: z.number().nullish(),
    character_gender: z.object({ name: z.string().nullish() }).nullish(),
  }),
);

export async function fetchIgdbFacts(igdbId: number, igdb: IgdbFetch = igdbFetch): Promise<FactsResult> {
  const post = (endpoint: string, body: string) =>
    igdb(`https://api.igdb.com/v4/${endpoint}`, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body });
  try {
    // le type de site (officiel) en plus ; si IGDB refuse ce champ (400), la fiche sans lui plutôt que pas de fiche
    let gameRes = await post("games", `fields ${IGDB_GAME_FIELDS}, websites.type; where id = ${igdbId};`);
    if (gameRes.status === 400) {
      await gameRes.body?.cancel().catch(() => undefined);
      gameRes = await post("games", `fields ${IGDB_GAME_FIELDS}; where id = ${igdbId};`);
    }
    if (!gameRes.ok) return { facts: null, note: `IGDB HTTP ${gameRes.status}` };
    const games = IgdbGamesResponse.safeParse(await gameRes.json().catch(() => null));
    const game = games.success ? games.data[0] : undefined;
    const series = game?.collections?.[0]?.name?.trim() || game?.franchises?.[0]?.name?.trim() || null;
    // ce que le jeu est vraiment (essai v5 : Path of Exile 2 présenté comme un « MMORPG »). Sauf le mode
    // « Massively Multiplayer Online (MMO) », qu'IGDB donne aussi à des jeux en ligne qui n'en sont pas :
    // essai v8.3, Path of Exile 2 de nouveau « MMORPG », sur la foi de ce mode
    const genres = [
      ...new Set(
        [...(game?.genres ?? []), ...(game?.themes ?? []), ...(game?.game_modes ?? [])]
          .map((g) => g.name?.trim() ?? "")
          .filter((g) => g.length > 0 && !/massively multiplayer/i.test(g)),
      ),
    ];
    const dossier: DossierEntry[] = [];
    const storyline = clipText(cleanSource(game?.storyline ?? null), MAX_IGDB_TEXT);
    if (storyline.length >= MIN_SOURCE) dossier.push({ source: "Histoire (IGDB)", text: storyline });
    const summary = clipText(cleanSource(game?.summary ?? null), MAX_IGDB_TEXT);
    if (summary.length >= MIN_SOURCE) dossier.push({ source: "Résumé (IGDB)", text: summary });
    const wikiTitle = (game?.websites ?? []).map((w) => wikiTitleFromUrl(w.url ?? "")).find((t) => t !== null) ?? null;
    const steamId = (game?.websites ?? []).map((w) => steamAppId(w.url ?? "")).find((id) => id !== null) ?? null;
    const officialLinks = (game?.websites ?? [])
      .filter((w) => (typeof w.type === "number" ? w.type : w.type?.id) === 1 && /^https?:\/\//i.test(w.url?.trim() ?? ""))
      .map((w): OfficialLink => ({ url: w.url!.trim(), language: null }));

    // champ récent (character_gender) d'abord, ancien code (gender) si IGDB le refuse
    let charRes = await post("characters", `fields name, character_gender.name; where games = (${igdbId}); limit ${MAX_MAIN + MAX_OTHERS};`);
    if (charRes.status === 400) charRes = await post("characters", `fields name, gender; where games = (${igdbId}); limit ${MAX_MAIN + MAX_OTHERS};`);
    const parsed = charRes.ok ? IgdbCharactersResponse.safeParse(await charRes.json().catch(() => null)) : null;
    const seen = new Set<string>();
    const characters: Character[] = [];
    for (const c of parsed?.success ? parsed.data : []) {
      const name = c.name?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      characters.push({ name, gender: genderOf(c.character_gender?.name ?? c.gender), main: false });
    }
    return {
      facts: { characters, prequel: null, series, genres, tags: [], dossier },
      note: charRes.ok ? null : `IGDB personnages HTTP ${charRes.status}`,
      wikiTitle,
      steamId,
      ...(officialLinks.length ? { officialLinks } : {}),
    };
  } catch (err) {
    return { facts: null, note: `IGDB injoignable : ${errMessage(err)}` };
  }
}

// ─── Wikipédia : se renseigner sur l'œuvre ───────────────────────────────────
// Le modèle local n'a pas Internet et sa mémoire mélange le vrai et le faux
// (essai v5 : Path of Exile 2 « MMORPG », Steel Ball Run « course automobile ») :
// le code lit Wikipédia pour lui. Ce que l'article confirme peut s'écrire
// (Pragmata : « hostile artificial intelligence » ; RE Requiem : « set in October 2026 »).

const WikiSearchResponse = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string() })).nullish() }).nullish(),
});

const WikiExtractResponse = z.object({
  query: z
    .object({ pages: z.array(z.object({ title: z.string(), extract: z.string().nullish(), missing: z.boolean().nullish() })).nullish() })
    .nullish(),
});

/** Comparaison de titres : minuscules, sans accents ni ponctuation. */
function titleKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const TITLE_STOPWORDS = new Set(["the", "and", "of", "a", "an", "to", "no", "in", "on", "for", "with"]);

/**
 * Titres de l'œuvre à chercher : Wikipédia décrit la série, rarement une saison.
 * « Frieren: Beyond Journey’s End Season 2 » → « Frieren: Beyond Journey’s End », « Frieren ».
 */
export function baseTitles(title: string): string[] {
  const noSeason = title
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ")
    .replace(/\b(?:season|saison|cour|part)\s*\d+\b/gi, " ")
    .replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)\b(?=\s*(?::|$))/g, " ")
    .replace(/\s+:/g, ":")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:–—-]+$/, "")
    .trim();
  const beforeColon = noSeason.split(/\s*[:：–—]\s+/)[0]?.trim() ?? "";
  return [...new Set([noSeason, beforeColon].filter((t) => titleKey(t).length >= 2))];
}

/** Titre comparé sans article de tête : « The Saga of Tanya the Evil » = « Saga of Tanya the Evil ». */
function wikiKey(s: string): string {
  return titleKey(s).replace(/^(?:the|a|an) (?=\S)/, "");
}

// numéro de suite en fin de titre : « slay the spire 2 », « grand theft auto vi », « final fantasy xiv »
const SEQUEL_NUMBER = /(?:^| )(\d{1,4}|x{1,2}|xx?(?:i{1,3}|iv|ix|vi{0,3})|i{2,3}|iv|vi{0,3}|ix)$/;
// même numéro en chiffres ou en romains : « Little Nightmares 3 » = « Little Nightmares III »
const SEQUEL_TWIN = new Map(
  ["ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"].flatMap((roman, i): Array<[string, string]> => [
    [String(i + 2), roman],
    [roman, String(i + 2)],
  ]),
);

/**
 * Article qui correspond le mieux à l'un des titres : identique (3), qui le prolonge (2), qui en contient
 * tous les mots (1). Sans l'article de tête : essai v7, « Saga of Tanya the Evil » tombait sur l'article
 * du film (qui le prolonge) au lieu de « The Saga of Tanya the Evil », la série.
 * Un titre qui finit par un numéro de suite veut un article qui porte ce numéro : essai v8.3, Slay the
 * Spire 2 décrit avec l'article du premier jeu (2019), qui en contenait tous les autres mots.
 */
export function bestWikiTitle(candidates: readonly string[], bases: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (/^list of|\(disambiguation\)/i.test(candidate)) continue;
    const c = wikiKey(candidate);
    const cWords = new Set(c.split(" "));
    let score = 0;
    for (const base of bases) {
      const b = wikiKey(base);
      if (!b) continue;
      const number = SEQUEL_NUMBER.exec(b)?.[1];
      if (number && !cWords.has(number) && !cWords.has(SEQUEL_TWIN.get(number) ?? "")) continue;
      if (c === b || /^(.+) (?:tv series|manga|anime|video game|novel series|light novel)$/.exec(c)?.[1] === b) score = Math.max(score, 3);
      else if (c.startsWith(`${b} `)) score = Math.max(score, 2);
      else {
        const words = b.split(" ").filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w));
        if (words.length > 0 && words.every((w) => cWords.has(w))) score = Math.max(score, 1);
      }
    }
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

const ANIME_ARTICLE = /\b(?:anime|manga|light novel|web novel|visual novel|animated|television series)\b/i;
const GAME_ARTICLE = /\bvideo game\b|\bgame (?:developed|published)\b|\b(?:action|adventure|role-playing|horror|strategy|shooter|platform|racing|fighting|puzzle|simulation|sports|survival) (?:video )?game\b/i;
const STORY_HEADING = /^(?:premise|plot|synopsis|story|setting|plot summary|story and setting|setting and story|plot and setting|setting and characters|characters and setting)$/i;

// « (Japanese: とんがり帽子のアトリエ, Hepburn: Tongari Bōshi no Atorie) » : rien pour le synopsis, et
// les caractères japonais coûtent cher en jetons (lire un prompt : environ 40 jetons/s sur kaquta)
const JAPANESE_ASIDE = /\s*\([^()]*(?:Japanese:|Hepburn:|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[^()]*\)/gu;

/**
 * Ce qu'on garde d'un article : le début (de quoi il s'agit), le début de l'intrigue,
 * du synopsis ou du cadre (le point de départ, pas la fin), et pour un jeu le début du gameplay.
 */
export function wikiDossierText(extract: string, type: ItemType): string {
  const sections: Array<{ heading: string; level: number; lines: string[] }> = [{ heading: "", level: 1, lines: [] }];
  for (const line of extract.replace(JAPANESE_ASIDE, "").split("\n")) {
    const h = /^(={2,})\s*(.+?)\s*\1\s*$/.exec(line.trim());
    if (h) sections.push({ heading: h[2] ?? "", level: h[1]?.length ?? 2, lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  // une section et ses sous-sections ; le début de l'article (i = 0) n'a pas de sous-section
  const body = (i: number): string => {
    const level = sections[i]!.level;
    const out: string[] = [...sections[i]!.lines];
    for (let j = i + 1; i > 0 && j < sections.length && sections[j]!.level > level; j++) out.push(...sections[j]!.lines);
    return out.join("\n").replace(/\n{2,}/g, "\n").trim();
  };
  const parts = [clipText(body(0), MAX_WIKI_INTRO)];
  const story = sections.findIndex((s, i) => i > 0 && STORY_HEADING.test(s.heading) && body(i).length > 0);
  if (story > 0) parts.push(clipText(body(story), MAX_WIKI_STORY));
  if (type === "game") {
    const gameplay = sections.findIndex((s, i) => i > 0 && /^gameplay$/i.test(s.heading) && body(i).length > 0);
    if (gameplay > 0) parts.push(clipText(body(gameplay), MAX_WIKI_GAMEPLAY));
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

export interface WikiResult {
  entry: DossierEntry | null;
  note: string | null; // pourquoi il n'y a pas d'article
  title?: string; // titre de l'article gardé (jeux : second titre pour chercher la page Steam)
}

/** Article Wikipédia (anglais) de l'œuvre : celui qu'indique IGDB, sinon le mieux trouvé. Ne lève jamais d'erreur. */
export async function fetchWikipedia(type: ItemType, item: ItemRow, known: string | null = null, api = WIKI_API): Promise<WikiResult> {
  const get = async (params: Record<string, string>): Promise<unknown> => {
    const qs = new URLSearchParams({ format: "json", formatversion: "2", ...params });
    const res = await fetch(`${api}?${qs}`, { headers: { "user-agent": WIKI_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(FACTS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    let title = known;
    if (!title) {
      // un jeu : le titre entier (« Resident Evil 9: Requiem » ne doit pas tomber sur la série) ; un animé : la série
      const bases = workTitles(type, item);
      const shortest = [...bases].sort((a, b) => a.length - b.length)[0] ?? "";
      const queries = [bases[0] ?? "", shortest].filter((q, i, all) => q.length > 0 && all.findIndex((x) => titleKey(x) === titleKey(q)) === i);
      for (const q of queries) {
        const found = WikiSearchResponse.safeParse(await get({ action: "query", list: "search", srsearch: `${q} ${type === "game" ? "video game" : "anime"}`, srlimit: "8" }));
        title = bestWikiTitle(found.success ? (found.data.query?.search ?? []).map((s) => s.title) : [], bases);
        if (title) break;
      }
      if (!title) return { entry: null, note: "pas d'article Wikipédia" };
    }
    const parsed = WikiExtractResponse.safeParse(
      await get({ action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", redirects: "1", titles: title }),
    );
    const page = parsed.success ? parsed.data.query?.pages?.find((p) => !p.missing && p.extract) : undefined;
    if (!page?.extract) return { entry: null, note: `article Wikipédia introuvable (${title})` };
    if (!(type === "game" ? GAME_ARTICLE : ANIME_ARTICLE).test(page.extract.slice(0, 2000))) {
      return { entry: null, note: `article Wikipédia écarté (${page.title})` };
    }
    // un autre jeu du même nom : « Slay the Spire is a 2019 … game » pour Slay the Spire 2, attendu en 2026.
    // Sauf pour un remake ou un remaster : l'article du jeu d'origine raconte la même histoire
    const year = type === "game" ? Number(/\b(?:is|was) an? ((?:19|20)\d{2})\b/.exec(page.extract.slice(0, 400))?.[1] ?? 0) : 0;
    const remake = /remake|remaster/i.test(item.kind ?? "");
    if (year > 0 && !remake && item.release_year !== null && year <= item.release_year - OLD_ARTICLE_YEARS) {
      return { entry: null, note: `article Wikipédia écarté (${page.title} : jeu de ${year})` };
    }
    const text = wikiDossierText(page.extract, type);
    return text.length >= MIN_SOURCE
      ? { entry: { source: `Wikipédia : ${page.title}`, text }, note: null, title: page.title }
      : { entry: null, note: "article Wikipédia trop court" };
  } catch (err) {
    return { entry: null, note: `Wikipédia injoignable : ${errMessage(err)}` };
  }
}

/** Ce qu'apporte une source en ligne (Kitsu, AnimeSchedule, Steam) : une entrée du dossier, ou pourquoi rien. */
export interface WebResult {
  entry: DossierEntry | null;
  note: string | null; // pourquoi la source n'apporte rien
}

/** Titres qui désignent l'œuvre : la série pour un animé, le titre entier pour un jeu. */
function workTitles(type: ItemType, item: ItemRow): string[] {
  const shown = item.title_english?.trim() || item.title;
  const all = type === "game" ? [shown] : [...baseTitles(shown), ...baseTitles(item.title)];
  return all.filter((x, i) => x.length > 0 && all.findIndex((y) => titleKey(y) === titleKey(x)) === i);
}

// ─── Steam : la page du jeu (jeux) ───────────────────────────────────────────
// API publique du magasin, sans clé. La description « About this game » est écrite par
// l'éditeur (ton publicitaire), mais elle donne l'histoire et ce que propose le jeu, même
// pour les petits jeux sans article Wikipédia (essai v8.3 : Vexlands, Bendy, Elementallis).

/** « https://store.steampowered.com/app/2868840/Slay_the_Spire_2/ » (ou /agecheck/app/…) → 2868840. */
export function steamAppId(url: string): number | null {
  const m = /^https?:\/\/store\.steampowered\.com\/(?:agecheck\/)?app\/(\d+)/i.exec(url.trim());
  return m?.[1] ? Number(m[1]) : null;
}

const SteamSearchResponse = z.object({
  items: z.array(z.object({ id: z.number(), name: z.string(), type: z.string().nullish() })).nullish(),
});

const SteamDetailsResponse = z.record(
  z.string(),
  z.object({
    success: z.boolean(),
    data: z
      .object({
        type: z.string().nullish(), // « game », « dlc », « music », « demo »…
        about_the_game: z.string().nullish(),
        detailed_description: z.string().nullish(),
        short_description: z.string().nullish(),
        release_date: z.object({ date: z.string().nullish() }).nullish(), // « Mar 4, 2013 », « Coming soon »
      })
      .nullish(),
  }),
);

const ROMAN_NUMERAL = /^(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})$/; // i à xxxix
const ROMAN_VALUES: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10 };

/** Valeur d'un numéro écrit en chiffres (« 9 ») ou en romains (« xiv ») ; null pour un autre mot. */
function numeralValue(word: string): number | null {
  if (/^\d{1,4}$/.test(word)) return Number(word);
  if (!ROMAN_NUMERAL.test(word)) return null;
  let total = 0;
  for (let k = 0; k < word.length; k++) {
    const cur = ROMAN_VALUES[word[k] ?? ""] ?? 0;
    const next = ROMAN_VALUES[word[k + 1] ?? ""] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/**
 * Le titre de l'article Wikipédia (`alias`) désigne-t-il le même jeu que le titre du site, nommé
 * autrement ? Les mêmes mots qui comptent, dans un sens comme dans l'autre, et pas d'autre numéro ;
 * un numéro de suite en fin de titre doit s'y retrouver. Oui : « Resident Evil 9: Requiem » →
 * « Resident Evil Requiem », « Slay the Spire 2 » → « Slay the Spire II ». Non (revue v8.7) : le jeu
 * d'avant (« Hades II » → « Hades »), une extension ou un jeu dérivé (« Elden Ring » → « Elden Ring
 * Nightreign », « … Silksong - Sea of Sorrow » → « … Silksong »), un autre numéro (« Nioh 3 » → « Nioh 2 »,
 * « Final Fantasy » → « Final Fantasy XIV »).
 */
export function aliasCovers(shown: string, alias: string): boolean {
  const words = (s: string) => titleKey(s).split(" ").filter((w) => w.length > 0);
  const own = words(shown);
  const other = words(alias);
  const significant = (ws: string[]) => new Set(ws.filter((w) => !TITLE_STOPWORDS.has(w) && numeralValue(w) === null));
  const a = significant(own);
  const b = significant(other);
  if (a.size !== b.size || [...a].some((w) => !b.has(w))) return false;
  const numbers = (ws: string[]) => ws.map(numeralValue).filter((n): n is number => n !== null);
  const ownNumbers = numbers(own);
  const otherNumbers = numbers(other);
  if (otherNumbers.some((n) => !ownNumbers.includes(n))) return false;
  const trailing = numeralValue(own[own.length - 1] ?? "");
  return trailing === null || otherNumbers.includes(trailing);
}

/**
 * Description de la page Steam du jeu : celle qu'indique IGDB, sinon le seul jeu de la recherche
 * Steam qui porte exactement le même titre (pas une édition, un DLC ou une bande originale) et
 * qui n'est pas sorti des années avant (« Tomb Raider » de 2013 pour celui de 2027). Le titre
 * cherché : celui du site, puis `alias` (titre de l'article Wikipédia retenu, sans sa précision
 * « (video game) ») s'il est différent et désigne le même jeu (aliasCovers). Ne lève jamais d'erreur.
 */
export async function fetchSteam(item: ItemRow, known: number | null = null, store = STEAM_STORE, alias: string | null = null): Promise<WebResult> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${store}${path}`, {
      headers: { accept: "application/json", "user-agent": WIKI_AGENT },
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    let id = known;
    let viaAlias = false;
    if (!id) {
      const shown = item.title_english?.trim() || item.title;
      const stripped = (alias ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim(); // « Replaced (video game) » → « Replaced »
      const other = stripped && aliasCovers(shown, stripped) ? stripped : "";
      const terms = [shown, other].filter((t, i, all) => wikiKey(t).length > 0 && all.findIndex((x) => wikiKey(x) === wikiKey(t)) === i);
      for (const term of terms) {
        const found = SteamSearchResponse.safeParse(await get(`/api/storesearch/?${new URLSearchParams({ term, l: "english", cc: "US" })}`));
        const key = wikiKey(term);
        const same = [...new Set((found.success ? (found.data.items ?? []) : []).filter((x) => wikiKey(x.name.replace(/[™®©]/g, " ")) === key).map((x) => x.id))];
        if (same.length > 1) return { entry: null, note: "Steam : plusieurs jeux de ce titre" };
        id = same[0] ?? null;
        viaAlias = term !== shown;
        if (id) break;
      }
      if (!id) return { entry: null, note: "Steam : pas de page" };
    }
    // deux filtres séparés par une virgule (vérifié le 9 octobre : la date de sortie vient avec la description)
    const parsed = SteamDetailsResponse.safeParse(await get(`/api/appdetails?appids=${id}&filters=basic,release_date&l=english`));
    const app = parsed.success ? parsed.data[String(id)] : undefined;
    if (!app?.success || !app.data) return { entry: null, note: "Steam : page indisponible" };
    if (!known) {
      // trouvé par le titre : un jeu (ou une extension), et pas un homonyme sorti des années avant. Trouvé par
      // le titre Wikipédia : sorti au plus un an avant l'item (pas le jeu d'avant, revue v8.7)
      if (app.data.type && !["game", "dlc"].includes(app.data.type)) return { entry: null, note: `Steam : pas un jeu (${app.data.type})` };
      const year = Number(/\b(?:19|20)\d{2}\b/.exec(app.data.release_date?.date ?? "")?.[0] ?? 0);
      const gap = viaAlias ? 2 : OLD_ARTICLE_YEARS;
      if (year && item.release_year !== null && item.release_year - year >= gap) return { entry: null, note: `Steam : un autre jeu du même titre (${year})` };
    }
    // le premier champ qui, nettoyé, dit quelque chose (« About this game » est parfois fait d'images seules)
    const fields = [app.data.about_the_game, app.data.detailed_description, app.data.short_description];
    const text = fields.map((f) => clipText(cleanSource(f ?? "", true), MAX_STEAM_TEXT)).find((t) => t.length >= MIN_SOURCE);
    return text ? { entry: { source: "Page Steam", text }, note: null } : { entry: null, note: "Steam : description vide" };
  } catch (err) {
    return { entry: null, note: `Steam injoignable : ${errMessage(err)}` };
  }
}

// ─── Anime News Network : l'encyclopédie (animés) ────────────────────────────
// API publique sans clé, une requête par seconde. Une fiche par saison (« Frieren: Beyond
// Journey's End », précision « TV 2 »), avec souvent un résumé de l'intrigue (« Plot Summary »),
// plus rare pour les saisons récentes. On cherche par le nom de la série (ANN trouve tout ce qui
// le contient), puis on ne garde que les fiches qui portent exactement le nom de l'œuvre ou de
// la série : « Steins;Gate » n'est pas « Gate », « My Hero Academia: Vigilantes » n'est pas
// « My Hero Academia » (revue v8.6). Ensuite le format et l'année ; dans le doute, rien.
// La première saison sert de prémisse à une suite décrite en une ligne.

export interface AnnEntry {
  id: number;
  name: string;
  type: string; // « TV », « movie », « OAV », « ONA », « special »
  precision: string; // « TV », « TV 2 », « movie »
  year: number | null; // première année de diffusion (« Vintage »)
  years: number[]; // toutes ses années de diffusion (une saison en deux parties : deux années)
  plot: string; // résumé de l'intrigue, vide s'il n'y en a pas
}

export interface AnnResult {
  entry: DossierEntry | null; // la fiche de cette saison, si elle a un résumé
  premise: DossierEntry | null; // la première saison de la série, si elle a un résumé (pour une suite décrite en une ligne)
  note: string | null;
}

// attributs d'une balise, valeurs entre guillemets comprises : un « > » dans une valeur ne ferme pas la balise
const XML_ATTRS = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*?)`;
// <anime …>…</anime>, ou <anime …/> (fiche vide), sans quoi la fiche vide avalerait la suivante
const ANN_ANIME = new RegExp(String.raw`<anime\b${XML_ATTRS}\s*(?:\/>|>([\s\S]*?)<\/anime\s*>)`, "g");
const ANN_INFO = new RegExp(String.raw`<info\b${XML_ATTRS}\s*(?:\/>|>([\s\S]*?)<\/info\s*>)`, "g");

function xmlAttr(attrs: string, key: string): string {
  const m = new RegExp(String.raw`\s${key}\s*=\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return decodeEntities(m?.[1] ?? m?.[2] ?? "").trim();
}

/** Texte d'une balise <info> : sans CDATA ni balises ; les entités restantes sont pour cleanSource. */
function xmlText(raw: string): string {
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Fiches <anime> d'une réponse XML d'ANN : attributs et infos utiles (lecture simple, sans bibliothèque). */
export function parseAnnXml(xml: string): AnnEntry[] {
  const out: AnnEntry[] = [];
  for (const m of xml.matchAll(ANN_ANIME)) {
    const attrs = m[1] ?? "";
    const infos = [...(m[2] ?? "").matchAll(ANN_INFO)].map((x) => ({ type: xmlAttr(x[1] ?? "", "type"), text: xmlText(x[2] ?? "") }));
    const vintage = infos.filter((x) => x.type === "Vintage").map((x) => x.text);
    // la diffusion d'origine : pas les lignes précisées entre parenthèses (« 2018-02-03 (Italy) », « (advance screening) »)
    const main = vintage.filter((v) => !v.includes("("));
    const years = [...new Set((main.length ? main : vintage).flatMap((v) => (v.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number)))].sort((a, b) => a - b);
    const name = xmlAttr(attrs, "name");
    // la précision est un attribut ; sinon, elle est à la fin du nom : « Saga of Tanya the Evil (TV 2) »
    const precision = xmlAttr(attrs, "precision") || (/\(([^()]+)\)\s*$/.exec(name)?.[1] ?? "");
    out.push({
      id: Number(xmlAttr(attrs, "id")) || 0,
      name: name.replace(/\s*\([^()]+\)\s*$/, "").trim() || name,
      type: xmlAttr(attrs, "type"),
      precision,
      year: years[0] ?? null,
      years,
      plot: infos.find((x) => x.type === "Plot Summary")?.text ?? "",
    });
  }
  return out;
}

/** Numéro de saison écrit dans un titre : « Season 2 », « 4th Season », « Saga of Tanya the Evil II » ; null sans numéro. */
export function seasonNumber(title: string): number | null {
  const m = /\bseason\s*(\d+)\b/i.exec(title) ?? /\b(\d+)(?:st|nd|rd|th)\s+season\b/i.exec(title) ?? /\bsaison\s*(\d+)\b/i.exec(title);
  if (m?.[1]) return Number(m[1]);
  const roman = /\s(II|III|IV|V|VI)(?=\s*(?::|$))/.exec(title)?.[1];
  return roman ? ["", "I", "II", "III", "IV", "V", "VI"].indexOf(roman) : null;
}

/** Numéro de la saison dans la précision d'ANN : « TV 2 » → 2, « TV » → 1. */
function annSeason(e: AnnEntry): number {
  return Number(/(\d+)\s*$/.exec(e.precision)?.[1] ?? 1);
}

// format AniList → type ANN
const ANN_TYPES: Readonly<Record<string, readonly string[]>> = {
  TV: ["TV"],
  TV_SHORT: ["TV"],
  MOVIE: ["movie"],
  ONA: ["ONA"],
  OVA: ["OAV"],
  SPECIAL: ["special", "TV special"],
};

/**
 * Noms de l'item pour ANN, avec leur précision : le titre entier (3), sans la saison (2),
 * la série avant les deux-points (1). « Frieren: Beyond Journey’s End Season 2 » :
 * le titre (3), « Frieren: Beyond Journey’s End » (2), « Frieren » (1).
 */
function annNames(item: ItemRow): Map<string, number> {
  const names = new Map<string, number>();
  const put = (t: string, rank: number) => {
    const k = wikiKey(t);
    if (k && (names.get(k) ?? 0) < rank) names.set(k, rank);
  };
  for (const t of [item.title_english?.trim() ?? "", item.title.trim()]) {
    if (!t) continue;
    put(t, 3);
    const [noSeason, ...series] = baseTitles(t);
    if (noSeason) put(noSeason, 2);
    for (const s of series) put(s, 1);
  }
  return names;
}

/**
 * Fiche ANN de cet item, ou null dans le doute (essai v7 : un film raconté comme la saison 2 ;
 * revue v8.6 : « My Hero Academia: Vigilantes » pris pour la dernière saison de la série).
 * `sequel` : AniList lui connaît une œuvre précédente (une suite, pas un spin-off).
 * Format connu et identique ; même année de diffusion ; à défaut (ANN n'a pas encore la date),
 * une fiche sans date qui porte le titre exact ou le même numéro de saison. Entre plusieurs :
 * le nom le plus précis, puis le numéro de saison ; et une seule à la fin.
 */
export function pickAnnEntry(entries: readonly AnnEntry[], item: ItemRow, thisYear = new Date().getFullYear(), sequel = false): AnnEntry | null {
  const types = lookup(ANN_TYPES, (item.kind ?? "").trim().toUpperCase());
  if (!types) return null; // format inconnu : on ne devine pas
  const names = annNames(item);
  const rank = (e: AnnEntry) => names.get(wikiKey(e.name)) ?? 0;
  const season = seasonNumber(item.title_english ?? "") ?? seasonNumber(item.title);
  const year = item.release_year;
  const named = entries.filter((e) => types.includes(e.type) && rank(e) > 0);
  const dated = year !== null ? named.filter((e) => e.years.includes(year)) : [];
  let fit = dated;
  if (fit.length === 0) {
    // sans date commune : une fiche pas encore datée (ou, pour un item sans année, d'une année à venir),
    // et une preuve qu'elle est la bonne : le titre exact, ou le numéro de saison
    fit = named
      .filter((e) => e.year === null || (year === null && e.year >= thisYear))
      .filter((e) => rank(e) === 3 || (season !== null && annSeason(e) === season));
  }
  if (fit.length > 1) {
    const best = Math.max(...fit.map(rank));
    fit = fit.filter((e) => rank(e) === best);
  }
  if (fit.length > 1 && season !== null) fit = fit.filter((e) => annSeason(e) === season);
  const own = fit.length === 1 ? fit[0]! : null;
  // « Season 3 » dans le titre, mais une fiche numérotée autrement (ou la saison 1 de la série) : une autre saison
  if (own && season !== null && annSeason(own) !== season && (annSeason(own) > 1 || rank(own) === 1)) return null;
  // le seul nom de la série (avant les deux-points) : une suite qu'AniList connaît, ou le même numéro de saison ;
  // pas un spin-off (« Demon Slayer: Kimetsu Academy » n'est pas « Demon Slayer (TV 5) », revue v8.6)
  if (own && rank(own) === 1 && !sequel && (season === null || annSeason(own) !== season)) return null;
  return own;
}

/**
 * Première saison de la série, prémisse d'une suite : la seule fiche TV de saison 1 au nom
 * de la série (pas au titre de l'item lui-même : un homonyme), avec un résumé, et plus ancienne.
 */
function annPremise(entries: readonly AnnEntry[], item: ItemRow, own: AnnEntry | null): AnnEntry | null {
  const names = annNames(item);
  const series = (e: AnnEntry) => {
    const r = names.get(wikiKey(e.name)) ?? 0;
    return r === 1 || r === 2;
  };
  const firsts = entries.filter((e) => e.type === "TV" && annSeason(e) === 1 && e.id !== own?.id && series(e));
  const first = firsts.length === 1 ? firsts[0]! : null;
  if (!first?.plot || first.year === null) return null;
  return item.release_year === null || first.year < item.release_year ? first : null;
}

let annNext = 0; // heure à partir de laquelle la requête suivante à ANN peut partir

/** Attendre son tour (une requête par seconde) ; la place est prise avant d'attendre : deux appels ne partent pas ensemble. */
async function annTurn(gapMs: number): Promise<void> {
  const at = Math.max(Date.now(), annNext);
  annNext = at + gapMs;
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Corps de la réponse, ou null au-delà de `max` octets : la lecture s'arrête dès la limite franchie. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Fiche Anime News Network de l'animé, et la première saison de la série en prémisse.
 * Recherche par le nom de la série (anglais, sinon titre d'origine). `sequel` : AniList lui connaît
 * une œuvre précédente. Ne lève jamais d'erreur.
 */
export async function fetchAnn(item: ItemRow, api = ANN_API, gapMs = ANN_GAP_MS, sequel = false): Promise<AnnResult> {
  if (!lookup(ANN_TYPES, (item.kind ?? "").trim().toUpperCase())) {
    return { entry: null, premise: null, note: `ANN : format ${item.kind?.trim() || "inconnu"}, pas de recherche` };
  }
  // nom de la série, sans saison ; ASCII (ANN cherche mal les apostrophes typographiques)
  const ascii = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();
  const bases = [...baseTitles(item.title_english?.trim() || ""), ...baseTitles(item.title)].map(ascii);
  const heads = bases.map((b) => b.split(/\s*[:：–—]\s+/)[0]?.trim() ?? "").filter((b) => /\p{L}{4,}/u.test(b));
  const terms = heads.filter((t, i) => heads.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i); // « GATE » et « Gate » : une seule recherche
  if (terms.length === 0) return { entry: null, premise: null, note: "ANN : titre trop court pour chercher" };
  const names = annNames(item);
  try {
    for (const term of terms.slice(0, 2)) {
      await annTurn(gapMs);
      const res = await fetch(`${api}?${new URLSearchParams({ anime: `~${term}` })}`, {
        headers: { accept: "application/xml", "user-agent": WIKI_AGENT },
        signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { entry: null, premise: null, note: `ANN HTTP ${res.status}` };
      }
      const xml = await readCapped(res, MAX_ANN_BYTES);
      if (xml === null) return { entry: null, premise: null, note: "ANN : recherche trop large" };
      // les fiches au nom de l'œuvre ou de la série seulement (« ~Gate » trouve aussi « Steins;Gate »)
      const entries = parseAnnXml(xml).filter((e) => names.has(wikiKey(e.name)));
      if (entries.length === 0) continue;
      const label = (e: AnnEntry) => `Anime News Network : ${e.name}${e.precision ? ` (${e.precision})` : ""}`;
      const clip = (e: AnnEntry) => clipText(cleanSource(e.plot), MAX_ANN_TEXT);
      const own = pickAnnEntry(entries, item, new Date().getFullYear(), sequel);
      const first = annPremise(entries, item, own);
      const entry = own && clip(own).length >= MIN_SOURCE ? { source: label(own), text: clip(own) } : null;
      const premise = first && clip(first).length >= MIN_SOURCE ? { source: `${label(first)}, début de la série`, text: clip(first) } : null;
      const note = entry ? null : own ? "ANN : fiche sans résumé" : "ANN : pas de fiche pour cette saison";
      return { entry, premise, note };
    }
    return { entry: null, premise: null, note: "ANN : pas de fiche" };
  } catch (err) {
    return { entry: null, premise: null, note: `ANN injoignable : ${errMessage(err)}` };
  }
}

// ─── Presse : les articles que le module presse a rattachés à l'animé ────────
// Choix de Rey (12 octobre) : « la partie Presse » fait partie des sources des synopsis. Le module
// presse (presse.ts, et Tavily) note dans `presse_articles` les animés que cite chaque article qu'il
// lit (Gameblog, ADN News, AnimOtaku, Manga-News, Anime News Network…). On relit ici ces articles et
// on garde le passage qui décrit l'animé, sans les phrases d'annonce (plateforme, date, studio,
// édition) : la fiche du site les affiche déjà. Seule la table est partagée : aucun code de la presse
// n'est importé, une mise à jour de l'un ne casse pas l'autre. Pas de crédit Tavily : on ne cherche
// rien, on relit des pages déjà trouvées. robots.txt respecté, une page à la fois par site.
// Dans le doute, rien (huit relectures indépendantes, v8.6) :
// - un article n'est relu que si son titre nomme l'animé, sans parler d'une autre saison, d'un film ou
//   d'un live-action ; dans un article-liste, seule la partie de l'animé compte ;
// - une phrase gardée nomme l'animé ou un de ses personnages (AniList), ou suit une telle phrase sans
//   rien d'autre entre les deux : une autre œuvre, une autre saison, un film, un spin-off, un nom venu
//   d'ailleurs coupent le fil ; les annonces (dates, plateformes, équipe, édition) sont retirées ;
// - la presse complète les autres sources : seule, elle ne suffit jamais à écrire un synopsis.

const MAX_PRESSE_ARTICLES = 2; // articles gardés par animé
const MAX_PRESSE_ROWS = 8; // articles de la table examinés au plus par animé (leur titre d'abord)
const MAX_PRESSE_READ = 4; // pages relues au plus par animé
const MAX_PRESSE_TEXT = 450; // passage gardé d'un article
const MAX_PRESSE_SCAN = 2000; // lignes d'un article où chercher la partie de l'animé (un guide en a plusieurs centaines)
const MAX_PRESSE_LINES = 400; // lignes lues au plus à partir du début du passage
const MAX_PRESSE_BYTES = 3_000_000; // page plus lourde : ignorée
const PRESSE_GAP_MS = 1000; // entre deux pages d'un même site (plus si robots.txt le demande, 10 s au plus)
export const PRESSE_AGENT = "GameNimeBot/1.0 (+https://gamenime.fr; synopsis)";

export interface PresseResult {
  entries: DossierEntry[];
  note: string | null; // pourquoi la presse n'apporte rien (null : aucun article sur cet animé)
  seen?: PresseSeen[]; // chaque article de la table, et ce qu'il en est sorti (affiché par l'essai à blanc)
}

/** Un article examiné : « passage gardé (312 car.) », « titre sans numéro de saison », « non lu (…) »… */
export interface PresseSeen {
  site: string;
  titre: string;
  verdict: string;
}

export interface RobotsRules {
  rules: Array<{ allow: boolean; pattern: string }>;
  delayMs: number;
}

/** Règles de robots.txt pour GameNimeBot : son groupe s'il en a un, sinon celui de « * ». */
export function parseRobots(txt: string, agent = "gamenimebot"): RobotsRules {
  interface Group {
    agents: string[];
    rules: Array<{ allow: boolean; pattern: string }>;
    delay: number;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let agentLine = false; // plusieurs User-agent d'affilée partagent le même groupe
  for (const raw of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ""));
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (key === "user-agent") {
      if (!current || !agentLine) groups.push((current = { agents: [], rules: [], delay: 0 }));
      current.agents.push(value.toLowerCase());
      agentLine = true;
      continue;
    }
    agentLine = false;
    if (!current) continue;
    if ((key === "allow" || key === "disallow") && value) current.rules.push({ allow: key === "allow", pattern: value });
    if (key === "crawl-delay" && Number(value) > 0) current.delay = Number(value) * 1000;
  }
  // le groupe dont un User-agent est exactement le nôtre (« GameNimeBot », « GameNimeBot/1.0 ») ; sinon « * »
  const own = groups.filter((g) => g.agents.some((a) => a.split("/")[0] === agent));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), delayMs: Math.max(0, ...chosen.map((g) => g.delay)) };
}

/** Chemin en octets encodés, %xx en majuscules : « /actualités/ » et « /actualit%c3%a9s/ » → « /actualit%C3%A9s/ ». */
function robotsPath(s: string): string {
  return s.replace(/[^\x00-\x7F]/gu, (c) => encodeURIComponent(c)).replace(/%[0-9a-f]{2}/gi, (x) => x.toUpperCase());
}

/** Chemin permis : la règle la plus longue qui s'applique décide ; à égalité, Allow (RFC 9309). */
export function robotsAllows(r: RobotsRules, pathAndQuery: string): boolean {
  const path = robotsPath(pathAndQuery);
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of r.rules) {
    const pattern = robotsPath(rule.pattern);
    const end = pattern.endsWith("$");
    const body = end ? pattern.slice(0, -1) : pattern;
    if (!new RegExp(`^${body.split("*").map(escapeRegExp).join(".*")}${end ? "$" : ""}`).test(path)) continue;
    if (!best || pattern.length > best.length || (pattern.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: pattern.length };
    }
  }
  return best ? best.allow : true;
}

const hostNext = new Map<string, number>(); // heure à partir de laquelle on peut relire ce site

async function hostTurn(host: string, gapMs: number): Promise<void> {
  const at = Math.max(Date.now(), hostNext.get(host) ?? 0);
  hostNext.set(host, at + gapMs);
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

const robotsCache = new Map<string, { until: number; rules: Promise<RobotsRules | null> }>();

/** robots.txt d'un site (redirections sur le même site seulement) ; null : on ne lit rien sur ce site. */
async function loadRobots(origin: string): Promise<RobotsRules | null> {
  let url = new URL("/robots.txt", origin);
  const first = url.host;
  try {
    for (let hop = 0; hop < 5; hop++) {
      await hostTurn(url.host, PRESSE_GAP_MS);
      const res = await fetch(url, { headers: { "user-agent": PRESSE_AGENT }, redirect: "manual", signal: AbortSignal.timeout(FACTS_TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const next = new URL(res.headers.get("location") ?? "", url);
        if (!sameSite(next.hostname, url.hostname)) return null; // robots.txt d'un autre site : on ne lit rien
        url = next;
        continue;
      }
      if (res.ok) {
        const txt = await readCapped(res, 500_000);
        if (txt === null) return null;
        const rules = parseRobots(txt);
        // le délai demandé vaut dès la première page, juste après robots.txt (revue v8.6)
        for (const host of new Set([first, url.host])) hostNext.set(host, Math.max(hostNext.get(host) ?? 0, Date.now() + rules.delayMs));
        return rules;
      }
      await res.body?.cancel().catch(() => undefined);
      // pas de robots.txt (404, 410…) : tout est permis ; serveur en panne ou 429 : rien
      return res.status >= 400 && res.status < 500 && res.status !== 429 ? { rules: [], delayMs: 0 } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** robots.txt d'un site, gardé 24 h (1 h s'il était illisible) ; une seule lecture même pour des appels simultanés. */
function robotsFor(origin: string): Promise<RobotsRules | null> {
  const hit = robotsCache.get(origin);
  if (hit && hit.until > Date.now()) return hit.rules;
  const rules = loadRobots(origin);
  robotsCache.set(origin, { until: Date.now() + 3600_000, rules });
  void rules.then((r) => {
    if (r) robotsCache.set(origin, { until: Date.now() + 24 * 3600_000, rules });
  });
  return rules;
}

/**
 * Page d'un article : robots.txt vérifié à chaque adresse, pas de redirection vers un autre site. Ne lève jamais d'erreur.
 * `maxDelayMs` : délai de robots.txt accepté entre deux pages (10 s pour la presse ; 30 s pour le site officiel, v9.3).
 */
export async function readArticlePage(url: string, gapMs = PRESSE_GAP_MS, maxDelayMs = 10_000): Promise<{ html: string } | { note: string }> {
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { note: "adresse illisible" };
      const rules = await robotsFor(u.origin);
      if (!rules) return { note: `robots.txt illisible (${u.hostname})` };
      if (!robotsAllows(rules, u.pathname + u.search)) return { note: `page refusée par robots.txt (${u.hostname})` };
      // un site qui demande plus de 10 s entre deux pages (30 s pour le site officiel) : on ne le fait pas attendre, on passe
      if (rules.delayMs > maxDelayMs) return { note: `délai de robots.txt trop long (${u.hostname}, ${Math.round(rules.delayMs / 1000)} s)` };
      await hostTurn(u.host, Math.max(gapMs, rules.delayMs));
      const res = await fetch(u, {
        headers: { "user-agent": PRESSE_AGENT, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const to = res.headers.get("location");
        if (!to) return { note: `redirection sans adresse (${u.hostname})` };
        const next = new URL(to, u);
        if (!sameSite(next.hostname, u.hostname)) return { note: `redirection vers un autre site (${next.hostname})` };
        current = next.href;
        continue;
      }
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
        await res.body?.cancel().catch(() => undefined);
        return { note: res.ok ? `pas une page (${u.hostname})` : `HTTP ${res.status} (${u.hostname})` };
      }
      const html = await readCapped(res, MAX_PRESSE_BYTES);
      return html === null ? { note: `page trop lourde (${u.hostname})` } : { html };
    }
    return { note: "trop de redirections" };
  } catch (err) {
    return { note: `page injoignable : ${errMessage(err)}` };
  }
}

/** Une ligne du texte d'un article : un paragraphe, un élément de liste, ou un titre. */
export interface PageLine {
  text: string;
  heading: boolean; // titre d'une partie : h2 à h6, un h1 après le premier, ou un paragraphe tout en gras
  title?: boolean; // le premier h1 : le titre de l'article lui-même
}

const NO_NAMES: ReadonlySet<string> = new Set();

// blocs sans texte d'article : retirés en entier (scripts, menus, formulaires, pieds de page…)
const DROPPED_BLOCKS = new Set(["script", "style", "noscript", "template", "iframe", "svg", "form", "nav", "aside", "footer", "figure", "button", "select"]);

/**
 * HTML sans ces blocs, en un seul passage (temps proportionnel à la page, même avec des milliers
 * d'icônes) : une balise fermante cherchée une fois ; un bloc jamais fermé ne perd que sa balise.
 * Sur le HTML brut : des entités décodées avant (« l&#39;elfe » dans un attribut) fausseraient les guillemets.
 */
function dropBlocks(html: string): string {
  const out: string[] = [];
  const unclosed = new Set<string>(); // plus de balise fermante de ce nom plus loin
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const name = m[1]!.toLowerCase();
    if (!DROPPED_BLOCKS.has(name)) continue;
    const after = m.index + m[0].length;
    out.push(html.slice(last, m.index), "\n");
    last = after;
    if (m[2] || unclosed.has(name)) continue; // <svg … /> ; ou bloc jamais fermé : la balise seule
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = after;
    if (close.exec(html)) {
      last = close.lastIndex;
      open.lastIndex = close.lastIndex;
    } else {
      unclosed.add(name);
    }
  }
  out.push(html.slice(last));
  return out.join("");
}

/**
 * HTML → lignes : paragraphes, éléments de liste, titres (marqués, chacun sur une seule ligne) ; une
 * phrase coupée par une balise est recollée. Les balises sont retirées avant de décoder les entités :
 * un « &lt; » du texte ne passe jamais pour le début d'une balise.
 */
function pageLines(raw: string): PageLine[] {
  // HTML échappé (« &lt;p&gt;… », parfois deux fois : « &amp;lt;p&amp;gt; ») : décodé d'abord pour en lire les balises
  let html = raw;
  for (let i = 0; i < 2 && !/<[a-z][^>]*>/i.test(html) && /&(?:amp;)*lt;[a-z]/i.test(html); i++) html = decodeEntities(html);
  const marked = dropBlocks(html)
    // titre (h1 à h6) sur une seule ligne ; un titre fait d'une image : son texte alternatif
    .replace(/<h([1-6])\b[^>]*>([\s\S]{0,600}?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, " ").trim() || (/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i.exec(inner)?.slice(1).find(Boolean) ?? "");
      return `\n${level === "1" ? "\u0002" : "\u0001"}${text}\n`;
    })
    // intitulé en gras en tête de paragraphe, suivi d'un signe (« <strong>Kowloon Generic Romance</strong>, adapté… ») :
    // « Kowloon Generic Romance : adapté… », que workLabel reconnaît
    .replace(
      /(<p\b[^>]*>)\s*<(strong|b)\b[^>]*>([^<]{2,80}?)\s*([,.:;–—-]?)\s*<\/\2\s*>\s*([,.:;–—-]?)\s*(?=[^\s<])/gi,
      (whole: string, p: string, _tag: string, inner: string, inside: string, after: string) =>
        (inside || after) && titleLike(decodeEntities(inner)) ? `${p}${inner} : ` : whole,
    )
    // paragraphe tout en gras : un titre s'il est court et sans point final, ou s'il a l'air d'un titre d'œuvre
    // suivi d'un point (« Kowloon Generic Romance. ») ; pas un chapô en gras (« Le voyage continue pour l'elfe. »)
    .replace(/<p\b[^>]*>\s*<(strong|b)\b[^>]*>([^<]{1,120})<\/\1\s*>\s*<\/p\s*>/gi, (whole: string, _tag: string, inner: string) => {
      const t = decodeEntities(inner).trim();
      const head = t.replace(/\.$/, "");
      return titleLike(t) || (head !== t && titleLike(head) && workTitleLine(head, NO_NAMES)) ? `\n\u0001${inner}\n` : whole;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|li|ul|ol|table|tr|td|th|hr|blockquote|section|header|main|article|dl|dt|dd|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(decodeEntities(marked)).replace(/[ \t\u00a0]+/g, " ");
  const lines: PageLine[] = [];
  let titled = false;
  for (const part of text.split("\n")) {
    const t = part.replace(/[\u0001\u0002]/g, "").trim();
    if (!t) continue;
    // le premier h1 est le titre de l'article ; un autre h1 est le titre d'une partie
    const title = part.includes("\u0002") && !titled;
    const heading = !title && /[\u0001\u0002]/.test(part);
    if (title) titled = true;
    const prev = lines[lines.length - 1];
    // « who<div>discovers » : la suite d'une phrase, pas un nouveau paragraphe
    if (!heading && !title && prev && !prev.heading && !prev.title && !/[.!?…:;»"”)\]]$/.test(prev.text) && /^\p{Ll}/u.test(t)) prev.text += ` ${t}`;
    else lines.push(title ? { text: t, heading: false, title: true } : { text: t, heading });
  }
  return lines;
}

// classe ou id d'un bloc de commentaire ou d'articles liés ; pas les états et rubriques de WordPress
// (« comments-open », « tag-teaser », « category-sidebar-news », revue v8.6)
const auxToken = (c: string) =>
  !/^(?:comments-(?:open|closed)|no-comments|has-[\w-]+|tag-[\w-]+|category-[\w-]+|post-\d+|type-[\w-]+|status-[\w-]+|format-[\w-]+|hentry)$/i.test(c) &&
  /(?:^|[-_])(?:comments?|commentlist|reply|replies|related|recommend\w*|teaser|card|widget|sidebar)(?:[-_]|$)/i.test(c);

/** Balises <article> de premier niveau (comptées, pas au premier « </article> »), sauf commentaires et articles liés. */
function outerArticles(html: string): string[] {
  const out: string[] = [];
  const tag = /<(\/?)article\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let depth = 0;
  let start = 0;
  let aux = false;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    if (!m[1]) {
      if (depth === 0) {
        start = m.index + m[0].length;
        const attrs = m[2] ?? "";
        const tokens = [...attrs.matchAll(/\b(?:class|id)\s*=\s*["']([^"']*)["']/gi)].flatMap((x) => (x[1] ?? "").split(/\s+/));
        aux = tokens.some((c) => c !== "" && auxToken(c));
      }
      depth++;
    } else if (depth > 0 && --depth === 0 && !aux) {
      out.push(html.slice(start, m.index));
    }
  }
  return out;
}

// fin de l'article : ce qui suit n'en fait plus partie (liens, commentaires)
const ARTICLE_END =
  /^(?:à lire aussi|a lire aussi|lire aussi|sur le même sujet|dans la même rubrique|articles? similaires|vous aimerez aussi|à découvrir aussi|les dernières (?:news|actus|actualités)|commentaires?|\d+ commentaires?|réagir|laisser un commentaire|partager (?:cet|l'|sur)|read more|related articles?|\d+ comments?)(?![\p{L}])/iu;

/**
 * Texte d'un article, ligne par ligne : l'articleBody du JSON-LD, le texte même de l'article (en HTML
 * ou en texte brut), précédé de son titre (headline) ; sinon la balise <article> qui porte le titre h1
 * (à défaut la plus fournie), sans les articles liés qu'elle contient. Jusqu'aux liens et commentaires
 * qui suivent le texte.
 */
export function articleText(html: string): PageLine[] {
  const bodies: Array<{ body: string; headline: string }> = [];
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(collect);
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (typeof o["articleBody"] === "string") bodies.push({ body: o["articleBody"], headline: typeof o["headline"] === "string" ? o["headline"] : "" });
    if (o["@graph"]) collect(o["@graph"]);
  };
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      collect(JSON.parse(m[1] ?? ""));
    } catch {
      // JSON-LD illisible : on prend la balise <article>
    }
  }
  const best = bodies.sort((a, b) => b.body.length - a.body.length)[0];
  const body = best?.body ?? "";
  let lines: PageLine[] = [];
  if (body.length >= 200) {
    lines = pageLines(body);
    const headline = decodeEntities(best?.headline ?? "").replace(/\s+/g, " ").trim();
    if (headline && !lines.some((l) => l.title)) lines.unshift({ text: headline, heading: false, title: true });
  } else {
    const articles = outerArticles(html);
    const main = articles.find((a) => /<h1\b/i.test(a)) ?? articles.sort((a, b) => b.length - a.length)[0];
    if (main) lines = pageLines(main.replace(/<article\b[\s\S]*?<\/article\s*>/gi, "\n"));
  }
  // liens et commentaires : une fois le texte commencé (« 12 commentaires » en tête ne coupe rien)
  let seen = 0;
  const end = lines.findIndex((l) => (seen += l.text.length) > 200 && ARTICLE_END.test(l.text));
  return end >= 0 ? lines.slice(0, end) : lines;
}

/** Expression qui reconnaît ces mots entiers, accents compris (\b ne connaît pas « é »). */
function wordsRe(words: string, flags = "iu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, flags);
}

const MONTHS_FR = "janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre";
const MONTHS_EN = "january|february|march|april|may|june|july|august|september|october|november|december";
const SEASONS_FR = "automne|hiver|été|printemps";

// auteurs, voix, salons, magazines, éditeurs, équipe en anglais
const STAFF_WORDS = wordsRe(
  "voix (?:française|japonaise|originale)|(?:prête|prêtera|prêtent|prêteront|prêtait)(?: \\p{L}+){0,3} (?:sa|leur|leurs) voix|comédien(?:ne)?s? de doublage|doubleu(?:r|se)s?|mangaka|auteure?s?|autrices?|dessinat(?:eur|rice)s?|(?:manga|light novel|roman|webtoon|œuvre originale) (?:de|d'|signée?|original)|magazines?|weekly|hebdomadaire|jump festa|anime ?japan|japan expo|anime expo|festival|convention|salon|comic[- ]?con|panel|voice (?:actress|actor)|(?:is |are |will be )?returning as|returns as|will return as|as (?:the )?(?:director|character designer|composer|scriptwriter|series composer)|character designs?|designing the characters|is (?:designing|composing|directing)|screenplay|illustrator|serialized|serialization|(?:launched|publishes|publishing|published) the manga|published in english|(?:is|are) releasing|describes the (?:story|plot|series|manga|novels?)|licensed the",
);

// Phrases d'annonce, pas d'histoire : plateformes, dates, diffusion, production, édition, voix
// (articles en français ; ceux d'Anime News Network en anglais). Pas les mots qui racontent aussi une
// histoire : « casts a spell », « reveals the truth », « un nouveau chapitre », « Frieren affiche un
// sourire », « à partir de ce jour », « this may be her last chance », « a scheduled execution »,
// « a necromancer animating corpses », « elle reviendra au village », « cet hiver-là ».
const ANNOUNCE = [
  wordsRe("ADN|MANGAS", "u"),
  wordsRe("crunchyroll|netflix|prime video|amazon|disney\\+|disney plus|hbo max|hulu|hidive|wakanim|j-one|game one|youtube|twitch"),
  wordsRe("simulcast|streaming|streamed|vostfr|vf|blu-ray|dvd|précommandes?|coffrets?|bande-annonce|bandes-annonces|trailer|teaser|visuel|key visual"),
  wordsRe(
    `diffus(?:é|ée|és|ées|ion|ions|era|eront|ait|aient|ent|er)|date de sortie|sortira|sortiront|sortie (?:est )?(?:prévue|annoncée|programmée)|disponibles? (?:sur|dès|à partir|le|en)|(?:revient|reviendra|reviendront) (?:enfin|bientôt|pour une|en (?:${MONTHS_FR})|cet (?:${SEASONS_FR}))|(?:saison|suite|série|anime|animé|adaptation)(?: \\d+)?(?: (?:de|du|d') ?[^.,;:!?]{1,40}?)? (?:arrive|arrivera|débarque|débarquera|revient|reviendra)|sur (?:nos|vos|les) écrans`,
  ),
  wordsRe(`\\d{1,2}(?:er)? (?:${MONTHS_FR})|(?:en|dès|début|fin|courant|depuis) (?:${MONTHS_FR})|mi-(?:${MONTHS_FR})|cet (?:${SEASONS_FR})(?!-)|(?:${SEASONS_FR}) (?:prochain|\\d{4})|\\d{1,2} ?h(?: ?\\d{2})?`),
  wordsRe("studios?|réalis(?:é|ée|és|ées|ateur|atrice|ation)|produit par|production|doublage|doublée? par|prête sa voix|seiyuu|opening|ending|générique|chanson|bande originale|compositeur|compositrice|scénar(?:io|iste)|chara-design|character design|épisodes|episodes"),
  wordsRe("tomes?|volumes?|éditions?|éditeur|publiée?s?|prépubli\\p{L}*|annonc\\p{L}*|officialis\\p{L}*|exemplaires"),
  wordsRe("premieres?|premiered|debuts?|debuted|airs|aired|airing|announced|announces|announcement|licensed|acquired|screenings?|box office|theme song|series director|chief director|directed by|release date|million copies|slated|will voice|voiced by|is voiced|voice cast|voice actors?|main cast|cast members|main staff|same staff|staff members|animated by|animation studio|series composition|composed by|music by|soundtrack"),
  wordsRe(`(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.? \\d{1,2}|(?:${MONTHS_EN}) \\d{1,2}|mid-(?:${MONTHS_EN})|in (?:${MONTHS_EN}) \\d{4}`),
  // auteurs, voix, salons, magazines, équipe : des noms propres qui ne sont pas l'histoire (revue v8.6)
  STAFF_WORDS,
  // calendrier et production en anglais, sans prendre « a scheduled execution » ni « animating corpses »
  wordsRe(
    `scheduled (?:for|to) (?:air|premiere|debut|release|be released|stream|open|launch|run|${MONTHS_EN}|spring|summer|fall|autumn|winter|next|this|later|early|late|20\\d{2})|animating (?:the |this |its |a |an )?(?:new |second |third |fourth |upcoming |next |final |\\d+(?:st|nd|rd|th) )?(?:anime|series|season|film|movie|show|adaptation|project|sequel|television|tv)|will animate|(?:spring|summer|fall|autumn|winter) 20\\d{2}|(?:returns?|returning|will return) (?:next|this) (?:spring|summer|fall|autumn|winter|year)`,
  ),
];

// Annonces sur l'équipe, l'édition, les voix, les salons : leurs noms propres (« Viz Media », « Kanehito
// Yamada », « Kelly Marot ») sont des personnes ou des sociétés, pas une autre œuvre (revue v8.6). Pas les
// annonces de date ou de plateforme, où une autre œuvre se nomme (« Kowloon Generic Romance revient aussi… »).
const CREDITS = [
  wordsRe("studios?|réalis(?:é|ée|és|ées|ateur|atrice|ation)|produit par|production|doublage|doublée? par|prête sa voix|seiyuu|opening|ending|générique|chanson|bande originale|compositeur|compositrice|scénar(?:io|iste)|chara-design|character design"),
  wordsRe("tomes?|volumes?|éditions?|éditeur|publiée?s?|prépubli\\p{L}*|exemplaires"),
  STAFF_WORDS,
  wordsRe("theme song|series director|chief director|directed by|will voice|voiced by|is voiced|voice cast|voice actors?|main cast|cast members|main staff|same staff|staff members|animated by|animation studio|series composition|composed by|music by|soundtrack|million copies|licensed|acquired|publish\\p{L}*|releasing|will animate|animating (?:the |this |its )"),
];

// titre de partie, ou intitulé de phrase, qui n'annonce pas une autre œuvre
const SECTION_HEADING =
  /^(?:(?:quel(?:le)? est )?(?:le |la |les |l'|the )?(?:synopsis|résumé|histoire|intrigue|pitch|scénario|prémisse|story|plot|premise|summary)|en résumé|côté (?:histoire|scénario)|de quoi (?:ça|ca|ce|parle)|que raconte|présentation|bande-annonce|trailer|teaser|casting|staff|doublage|date de sortie|sortie|diffusion|où (?:le |la |les )?(?:regarder|voir)|plateformes?|fiche technique|informations?|à savoir|à noter|en bref|bref|pour rappel|rappel|note|attention|précision|source|crédits?|à propos|cast)(?![\p{L}])/iu;
// question d'une partie sur la même œuvre : date, heure, plateforme, épisodes, histoire, bande-annonce
const SECTION_QUESTION =
  /(?<![\p{L}])(?:date|heure|horaire|quand (?:sort|sortira|arrive|arrivera|débarque|commence|reprend|revient)|où (?:le |la |les )?(?:regarder|voir|streamer)|(?:sur )?quelle plateforme|combien d'épisodes|nombre d'épisodes|l'histoire|histoire de|de quoi (?:ça |ca )?parle|que raconte|synopsis|pitch|intrigue|résumé|bande-annonce|trailer|release date|when (?:does|will|is)|where (?:to|can (?:i|you|we)) (?:watch|stream)|how many episodes|what is .{1,40} about)(?![\p{L}])/iu;
const QUESTION_START = /^(?:quel(?:le)?s?|quand|où|combien|comment|pourquoi|qui|que|qu'|de quoi|à quelle|sur quelle|faut-il|est-ce|y a-t-il|et si|what|when|where|how|why|who|which)(?![\p{L}])/iu;
// recommandations, sélections : la fin de la partie sur l'animé (« Et si vous avez aimé Frieren ? »)
const RECO_HEADING =
  /(?<![\p{L}])(?:si (?:vous|tu) (?:avez |as )?(?:aimé|aimez|aimes|adoré|adorez|adores)|vous (?:aimerez|adorerez)|à (?:voir|regarder|découvrir|lire) (?:aussi|également|ensuite)|(?:que|quoi|quels?|quelles?)(?: \p{L}+)? (?:regarder|voir|lire)|dans le même (?:genre|style|esprit|registre)|en attendant|recommand\p{L}*|autres? (?:animes?|animés?|séries|œuvres|mangas?)|similaires?|alternatives?|à ne pas manquer|incontournables?|top \d+|classement|sélection|palmarès|coups? de cœur|nos (?:favoris|choix|conseils)|pour les fans|dans la lignée|à la (?:manière|façon)|if you (?:liked|like|enjoyed|love|loved)|if you're a fan|fans of|in the vein of|similar|more like|what to watch|while you wait|recommend\p{L}*)(?![\p{L}])/iu;
// phrase de recommandation : la suite parle d'autres œuvres
const RECO_SENTENCE =
  /(?<![\p{L}])(?:si (?:vous|tu) (?:avez |as )?(?:aimé|aimez|aimes|adoré|adorez|adores)|vous (?:aimerez|adorerez)|à (?:voir|regarder|découvrir|lire) (?:aussi|également)|dans le même (?:genre|style|esprit|registre)|if you (?:liked|like|enjoyed|love|loved)|you(?:'ll| will) (?:also )?(?:love|like|enjoy))(?![\p{L}])/iu;
// ligne sans texte d'article : signature, crédit, publicité
const NOISE_LINE =
  /^(?:par|by|publié|posted|mis à jour|updated|écrit par|rédigé par|crédits?|photos?|images?|vidéos?|video|source|via|publicité|pub|advertisement|sponsoris\p{L}*|©|partager|share|tweet\p{L}*|commenter|commentaires?|\d+ (?:commentaires?|comments?|réactions?)|temps de lecture|lecture|sommaire|table des matières|abonnez|suivez|newsletter|s'abonner|lire (?:aussi|la suite|plus)|voir (?:aussi|plus)|en savoir plus|read more|related)(?![\p{L}])/iu;
// rubrique seule au-dessus du titre (« Anime », « Actualité »)
const KICKER = /^(?:animes?|animés?|mangas?|actualités?|actus?|news|critiques?|tests?|dossiers?|interviews?|preview|avis|vidéos?|jeux? vidéo|cinéma|séries?|geek|culture|japanimation|exclu(?:sif)?|à la une|en direct|live)$/iu;
const DAYS = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DATE_START = new RegExp(`^(?:le |the |on )?(?:${DAYS}|\\d{1,2}(?:er)?\\s+(?:${MONTHS_FR}|${MONTHS_EN})|(?:${MONTHS_FR}|${MONTHS_EN})\\s+\\d{1,2}|\\d{1,2}[/.]\\d{1,2})(?![\\p{L}])`, "iu");
const PLATFORM_WORDS = new Set(["adn", "mangas", "crunchyroll", "netflix", "prime", "video", "amazon", "disney", "disney+", "hbo", "max", "hulu", "hidive", "youtube", "twitch", "vf", "vostfr", "tf1", "gulli", "j-one"]);
// mots à majuscule qui ne nomment pas une autre œuvre
const GENERIC_CAPS = new Set(
  [...`${MONTHS_FR}|${MONTHS_EN}|${DAYS}`.split("|"), "saison", "season", "episode", "épisode", "partie", "part", "film", "anime", "animé", "manga", "japon", "japan", "france", "europe", "français", "japonais", "studio", "tv", "ova", "ona", "oav", "animation", "source", "english", "japanese", "french", "european", "american", "americans", "north", "south", "east", "west"].map(fold),
);

/** Ligne courte sans point final : un titre de partie, quelle que soit sa balise (« <p><b>Kowloon Generic Romance</b><br></p> », texte brut). */
function titleLike(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && t.length <= 80 && t.split(/\s+/).length <= 10 && /^[\p{Lu}\p{N}«"“(]/u.test(t) && !/[.!…;,]$/.test(t);
}

/** Forme comparable d'un mot de nom : « Gojou » = « Gojo », « Yuuji » = « Yuji ». */
function nameWord(w: string): string {
  return pressKey(w).replace(/ou(?![aeiou])/g, "o").replace(/uu/g, "u").replace(/oo/g, "o");
}

/** Mots connus de l'œuvre : ceux de ses titres et de ses personnages (AniList). */
function knownWords(work: PressWork): Set<string> {
  return new Set([...work.names, ...(work.known ?? [])].flatMap((n) => pressKey(n).split(" ")).filter(Boolean).map(nameWord));
}

/** Mot à majuscule qui n'est ni l'œuvre, ni un de ses personnages, ni un mot courant : un nom venu d'ailleurs. */
function strangeWord(word: string, known: ReadonlySet<string>): boolean {
  const x = word.replace(/^[«"“(\[]+|[»"”),.;:!?…\]]+$/g, "").replace(/^[ldLD]['’](?=\p{Lu})/u, "");
  return (
    x.length > 1 && /^\p{Lu}/u.test(x) && !known.has(nameWord(x)) && !COMMON_CAPITALIZED.has(fold(x)) && !GENERIC_CAPS.has(fold(x)) && !PLATFORM_WORDS.has(x.toLowerCase()) && !KICKER.test(x)
  );
}

/** Un nom propre qui n'est pas celui de l'animé ni d'un de ses personnages (« Où regarder Kowloon Generic Romance ? »). */
function foreignName(text: string, known: ReadonlySet<string>): boolean {
  return text
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((w) => strangeWord(w, known));
}

// mots outils qui ouvrent une phrase : leur majuscule n'en fait pas un nom
const OPENERS = new Set(
  (
    "le la les un une des du de ce cet cette ces son sa ses leur leurs notre nos votre vos mon ma mes il elle ils elles on nous vous je tu " +
    "qui que quand lorsque si mais et ou or donc car puis alors ainsi enfin ensuite pourtant toutefois cependant néanmoins désormais depuis dans " +
    "en au aux à après avant pendant durant dès pour par avec sans sous sur entre contre vers chez comme malgré grâce face selon parmi tandis " +
    "tout toute tous toutes chaque plusieurs certains certaines aucun aucune autre autres même encore déjà aussi bien voici voilà là ici cela " +
    "ceci ça celle celui ceux celles quelques une " +
    "the a an this that these those his her their its our my your he she it they we you i there here in on at after before during while when " +
    "as but and or so then meanwhile however although though despite with without for from to into upon over under between among one some " +
    "many each every all both now later soon still yet also even only just once since until if because not no what which who whose where how why " +
    "ensemble toujours bientôt soudain seul seule seuls seules chemin lui eux celle-ci celui-ci ceux-ci celles-ci peu très trop plus moins tant rien " +
    "personne chacun chacune hélas pire mieux surtout aujourd'hui autrefois jadis longtemps ailleurs partout bref bon " +
    "together along like unlike years decades centuries instead elsewhere nobody nothing everyone someone something little few much more most " +
    "thus hence therefore moreover furthermore besides indeed perhaps maybe within throughout amid against around across through beyond inside behind back"
  ).split(" "),
);
// adverbes et participes en tête de phrase (« Heureusement », « Hantée », « Eventually », « Having »), « Lorsqu'il »
const OPENER_FORM = /^(?:\p{Lu}\p{Ll}{3,}(?:ment|ly|ée|ées|és|ed)|\p{Lu}\p{Ll}{2,}ing|(?:lorsqu|puisqu|jusqu|quoiqu|presqu)['’]\p{Ll}.*)$/iu;
// déterminants : « le Grand Mage », « the Demon King » sont des noms de l'histoire, pas une autre œuvre
const DETERMINERS = new Set("le la les l' un une des du au aux ce cet cette ces son sa ses leur leurs notre nos the a an this that these those his her their its our".split(" "));

/** Mots d'une phrase, et si chacun est un nom venu d'ailleurs ; le premier mot l'est s'il n'est pas un mot outil (« Gachiakuta raconte… »). */
function nameFlags(sentence: string, known: ReadonlySet<string>): Array<{ word: string; strange: boolean }> {
  const words = sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.map((word, i) => {
    const bare = word.replace(/^[«"“(\[]+|[»"”),.;:!?…\]]+$/g, "");
    const opener = i === 0 && (OPENERS.has(bare.toLowerCase()) || /^[ldjcmnst]['’]\p{Ll}|^qu['’]/iu.test(bare) || OPENER_FORM.test(bare));
    return { word, strange: !opener && strangeWord(word, known) };
  });
}

/** Un nom venu d'ailleurs dans une phrase (« …suit Reiko Kujirai », « …à Mononoke », « Gachiakuta raconte… »). */
function strangeIn(sentence: string, known: ReadonlySet<string>): boolean {
  return nameFlags(sentence, known).some((f) => f.strange);
}

/**
 * Deux noms venus d'ailleurs de suite, sans déterminant devant : le nom d'une personne ou d'une autre
 * œuvre (« Reiko Kujirai », « Kowloon Generic Romance ») ; pas « le Grand Mage », « the Demon King ».
 * Une virgule sépare deux noms (« Loid, Yor et Anya »).
 */
function foreignRun(sentence: string, known: ReadonlySet<string>): boolean {
  const flags = nameFlags(sentence, known);
  let run = 0;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const before = i > 0 ? flags[i - 1]!.word.toLowerCase().replace(/^[«"“(\[]+/, "") : "";
    if (f.strange) {
      if (run === 0 && (DETERMINERS.has(before) || /^[ld]['’]$/.test(before))) run = -99; // nom de l'histoire, après un déterminant
      run++;
      if (run >= 2) return true;
    } else {
      run = 0;
    }
    if (/[,;:.!?…»")\]]$/.test(f.word)) run = 0;
  }
  return false;
}

/** Mots des noms des personnages (AniList) : « Frieren », « Fern », « Himmel »… */
function characterWords(work: PressWork): Set<string> {
  return new Set((work.known ?? []).flatMap((n) => pressKey(n).split(" ")).filter((w) => w.length >= 3).map(nameWord));
}

// article-liste, sélection, programme : seule la partie à son nom compte (titre de l'article)
const ROUNDUP =
  /(?<![\p{L}])(?:les autres|et autres|autres (?:animes?|animés?|séries|suites|sorties|nouveautés|films|mangas?)|(?:animes|animés|séries|suites|sorties|nouveautés|films|mangas) (?:de|du|d'|à|qu|pour|les plus)|à suivre|à voir|à ne pas manquer|sélection|top \d+|classement|line-?up|de la semaine|du mois|round-?up|this (?:season|week))(?![\p{L}])/iu;

/**
 * Titre d'article-liste : un marqueur de sélection, ou une autre œuvre coordonnée à l'animé dans la
 * partie du titre qui le nomme (« Frieren saison 2 et Kowloon Generic Romance ») ; pas « signé YOASOBI », « avec Madhouse ».
 */
function roundupTitle(title: string, work: PressWork, known: ReadonlySet<string>): boolean {
  if (ROUNDUP.test(title)) return true;
  const match = workMatcher(work.names, work.others);
  const segment = title.split(/\s*[:|]\s+|\s[–—-]\s/u).find((part) => match(part).ours) ?? title;
  const tokens = segment.split(/\s+/).filter(Boolean);
  return tokens.some((w, i) => i > 0 && strangeWord(w, known) && (/[,&]$/.test(tokens[i - 1]!) || /^(?:et|&|and|vs\.?|ou|or|x)$/i.test(tokens[i - 1]!)));
}

// référence à une œuvre (« comme Frieren », « les fans de Frieren », « like Frieren ») : le nom qui suit ne
// rattache pas la phrase à elle. Sans drapeau « i » : \p{Lu} reconnaîtrait alors les minuscules (« comme toujours »)
const REFERENCE =
  /(?<![\p{L}])(?:[Tt]out comme|[Cc]omme(?: dans| chez)?|[ÀAàa] l['’]instar d(?:e|['’])|[Cc]ontrairement à|[ÀAàa] la manière d(?:e|['’])|(?:[Ll]es |[Aa]ux |[Dd]es )?fans de|[Ff]ans de|[Cc]eux qui ont (?:aimé|adoré|apprécié)|(?:[Qq]ui|[Ss]i vous) (?:a|avez|ont) (?:aimé|adoré|apprécié)|[Jj]ust like|[Ll]ike|[Uu]nlike|[Ss]imilar to|[Ff]ans of|(?:[Ww]ho|[Ii]f you) (?:enjoyed|liked|loved)|[Ii]n the vein of|[Rr]eminiscent of)\s+(?:le |la |les |l['’]|the )?\p{Lu}[\p{L}\p{N}'’:.-]*(?:\s+(?:no|x|de|of|the|to|in|[\p{Lu}\p{N}][\p{L}\p{N}'’:.-]*))*/gu;
// spin-off : jeu vidéo, pièce, comédie musicale (le film et le live-action ont leurs propres mots)
const SPIN_OFF = /(?<![\p{L}])(?:jeux? vidéo|video games?|spin-?off|pièce de théâtre|comédie musicale|stage play|musical)(?![\p{L}])/iu;

// rappel de la saison d'avant, sans numéro (suites seulement) : pas l'histoire de cette saison
const RECAP_HEADING = /^(?:pour rappel|rappel|ce qu'il faut (?:savoir|retenir)|récap\p{L}*|résumé des (?:épisodes|saisons)|previously|recap|ce qui s'est passé|où en (?:est|était)|on fait le point)(?![\p{L}])/iu;
const RECAP_SENTENCE =
  /(?<![\p{L}])(?:saison (?:précédente|passée|dernière)|(?:précédente|dernière) saison|jusqu'ici|jusqu'à présent|précédemment|auparavant|lors de la saison|previous season|last season|so far|previously)(?![\p{L}])/iu;

// petits mots qui ne comptent pas dans la casse d'un titre (« Les Carnets de l'apothicaire »)
const SMALL_WORDS = new Set(["de", "du", "des", "la", "le", "les", "un", "une", "et", "à", "au", "aux", "en", "of", "the", "a", "an", "and", "in", "on", "to", "x", "no", "son", "sa", "ses"]);

/**
 * Ligne qui ressemble au titre d'une œuvre : 7 mots au plus avant un éventuel sous-titre, le premier à
 * majuscule (pas une rubrique), et au moins la moitié des suivants aussi (« Kowloon Generic Romance »,
 * « Spy x Family saison 2 », « Gachiakuta ») ; pas « Voici le synopsis de la saison 2 : », ni « Fern, l'apprentie ».
 */
function workTitleLine(text: string, known: ReadonlySet<string>): boolean {
  const head = text.split(/\s*[:：?]\s*(?=\S|$)|\s[–—-]\s/u)[0] ?? text;
  const words = head
    .split(/\s+/)
    .map((w) => w.replace(/^[«"“(\[]+|[»"”),.;:!?\]]+$/g, ""))
    .filter(Boolean);
  if (words.length === 0 || words.length > 7) return false;
  // pas un personnage de l'œuvre (« Fern et Stark », « Übel » en légende)
  if (!strangeWord(words[0]!, known)) return false;
  const rest = words.slice(1).filter((w) => !SMALL_WORDS.has(w.toLowerCase().replace(/^[ld]['’]/, "")));
  return rest.length === 0 || rest.filter((w) => strangeWord(w, known) || /^\p{N}/u.test(w)).length * 2 >= rest.length;
}

/** Titre qui commence par le nom de l'animé, sans autre nom propre avant son sous-titre (« Frieren saison 2 : Fern et Stark… »). */
function leadsWithOurs(text: string, own: readonly string[], known: ReadonlySet<string>): boolean {
  const head = text.split(/\s*[:：]\s+|\s[–—-]\s/u)[0] ?? text;
  const k = pressKey(head).replace(/^(?:n ?)?\d+ /, ""); // « 1. Frieren », « n°1 Frieren »
  return own.some((o) => k === o || k.startsWith(`${o} `)) && !foreignName(head, known);
}

// « foreign » : une autre œuvre (autre animé, autre saison, film, live-action, recommandations) — fin de la
// partie de l'animé, et rien à prendre dessous ; « end » : fin de la partie seulement (titre sans rapport).
type HeadingRole = "ours" | "section" | "skip" | "end" | "foreign";

/**
 * Rôle d'un titre de partie (h2 à h6, paragraphe en gras) ou d'une ligne courte qui en a l'air :
 * - la partie de l'animé (« ours ») : un titre qui commence par son nom ;
 * - une partie sur la même œuvre (« section » : synopsis, date, où regarder…) ;
 * - rien (« skip ») : signature, date, crédit, rubrique, publicité, et toute ligne courte de texte
 *   (légende, citation, liste, amorce) qui ne ressemble pas au titre d'une autre œuvre ;
 * - « foreign » et « end » : voir HeadingRole.
 */
function headingRole(line: PageLine, work: PressWork, match: (t: string) => { ours: boolean; other: boolean }, own: readonly string[], known: ReadonlySet<string>): HeadingRole {
  const t = line.text.trim();
  const m = match(t);
  if (m.other) return "foreign";
  const season = pressSeason(t);
  if (season !== null && season !== work.season) return "foreign";
  if (LIVE_ACTION.test(t) || RECO_HEADING.test(t) || (work.season > 1 && RECAP_HEADING.test(t))) return "foreign";
  if (NOISE_LINE.test(t) || DATE_START.test(t) || KICKER.test(t)) return "skip";
  const question = /\?\s*$/.test(t) || QUESTION_START.test(t);
  const section = (SECTION_HEADING.test(t) || (question && SECTION_QUESTION.test(t))) && !foreignName(t, known);
  // ligne courte de texte (pas un titre balisé) : elle n'arrête rien, sauf si c'est le titre d'une autre œuvre
  if (!line.heading) return m.ours || section || !workTitleLine(t, known) ? "skip" : "foreign";
  if (!work.film && FILM_WORDS.test(t)) return "foreign";
  if (section) return "section";
  // un titre qui nomme l'animé sans commencer par lui (« La saison 2 de Frieren ») : on le traverse, on n'y commence pas
  if (m.ours) return leadsWithOurs(t, own, known) ? "ours" : "section";
  if (question) return foreignName(t, known) ? "foreign" : "end";
  return workTitleLine(t, known) ? "foreign" : "end";
}

/** « d'Oshi no Ko », « l’Atelier » → « d Oshi no Ko », « l Atelier » : le titre se retrouve tel quel. */
function unElide(s: string): string {
  return s.replace(/(?<![\p{L}])((?:[ldjmnstc]|qu|jusqu|lorsqu|puisqu))['’](?=\p{L})/giu, "$1 ");
}

/** Noms d'un animé dans un texte : titres anglais et d'origine, sans la saison, la série avant les deux-points. */
function workNames(title: string, english: string | null): string[] {
  const en = english?.trim() ?? "";
  const names = [en, title.trim(), ...baseTitles(en), ...baseTitles(title.trim())].filter(Boolean);
  // « Re:ZERO -Starting Life in Another World- Season 3 » : la presse écrit « Re:Zero »
  const short = names.map((n) => n.split(/\s+-(?=\S)/)[0]!.trim()).filter((n) => titleKey(n).replace(/ /g, "").length >= 4);
  return [...new Set([...names, ...short])];
}

/** Clé comparable d'un nom ou d'un texte : sans accents, ponctuation, élision ni possessif (« d'Oshi no Ko », « Frieren's »). */
function pressKey(s: string): string {
  return titleKey(unElide(s).replace(/(?<=\p{L})['’]s(?![\p{L}])/gu, ""));
}

/** Clés des noms d'une œuvre, de 4 lettres au moins. */
function titleKeys(names: readonly string[]): string[] {
  return [...new Set(names.map(pressKey))].filter((k) => k.replace(/ /g, "").length >= 4);
}

/**
 * Œuvres qu'un texte nomme : l'animé (`ours`), un autre animé cité par l'article (`other`). Le nom
 * le plus long l'emporte : « Spy x Family Code: White » est le film, pas la série « Spy x Family ».
 */
export function workMatcher(names: readonly string[], others: readonly string[] = []): (text: string) => { ours: boolean; other: boolean } {
  const own = titleKeys(names);
  const keys = [...own.map((k) => ({ k, ours: true })), ...titleKeys(others).filter((k) => !own.includes(k)).map((k) => ({ k, ours: false }))]
    .sort((a, b) => b.k.length - a.k.length)
    .map(({ k, ours }) => ({ re: new RegExp(`(?<= )${escapeRegExp(k)}(?= )`, "g"), ours }));
  return (text) => {
    let t = ` ${pressKey(text)} `;
    let ours = false;
    let other = false;
    for (const { re, ours: mine } of keys) {
      re.lastIndex = 0;
      if (!re.test(t)) continue;
      if (mine) ours = true;
      else other = true;
      t = t.replace(re, "|"); // pris par ce nom : un nom plus court n'y est plus cherché
    }
    return { ours, other };
  };
}

// début de phrase qui n'est pas le titre d'une œuvre : partie de l'œuvre, signature, date
const PART_LABEL = /^(?:l'|le |la |les |the |an? )?(?:épisode|episode|ep\.?|chapitre|chapter|partie|part|tome|volume|vol\.?|saison|season|arc|cour)(?:\s*#?\s*(?:\d+|[ivx]+))?$/iu;
const BYLINE_LABEL = /^(?:par|by|publié|posted|mis à jour|updated|photo|image|vidéo|video|crédits?|via|source)(?![\p{L}])/iu;
const DATE_LABEL = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:\\d{1,2}(?:er)?\\s+(?:${MONTHS_FR}|${MONTHS_EN})|(?:${MONTHS_FR}|${MONTHS_EN})\\s+\\d{1,2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}|(?:19|20)\\d{2}|\\d{1,2}\\s?h\\s?\\d{2}|\\d{1,2}:\\d{2})(?![\\p{L}\\p{N}])`,
  "iu",
);

/** « Kowloon Generic Romance : Reiko… », « Spy x Family saison 3 – … » : une phrase qui commence par le titre d'une œuvre. */
function workLabel(sentence: string): string | null {
  const label = /^(.{2,60}?)(?:\s*:|\s[–—-])\s+\S/u.exec(sentence)?.[1]?.trim();
  if (!label) return null;
  if (SECTION_HEADING.test(label) || PART_LABEL.test(label) || BYLINE_LABEL.test(label) || DATE_LABEL.test(label)) return null;
  // majuscules comptées après le premier mot (« Bonne nouvelle », « Au programme » : pas des titres)
  const words = label.split(/\s+/);
  const rest = words.slice(1);
  const caps = rest.filter((w) => /^[\p{Lu}\p{N}]/u.test(w)).length;
  const titled =
    words.length <= 7 &&
    (rest.length === 0 ? /^[\p{Lu}\p{N}]/u.test(label) : caps * 2 >= rest.length || /(?<![\p{L}])(?:saison|season|part|partie|film|movie)(?![\p{L}])/iu.test(label));
  return titled ? label : null;
}

// fin de phrase : pas après « Dr. », « M. », « No. », « Vol. » (« Dr. Stone », « Kaiju No. 8 »)
const SENTENCE_END = /(?<=[.!?…])(?<!(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|M|Mme|Mlle|St|No|Vol|Ep|Jr|Sr|vs|Prof)\.)\s+(?=[«"“(]?\p{Lu})/u;

const ORDINAL_SEASON = "premi[eè]re|first|deuxi[eè]me|seconde?|troisi[eè]me|third|quatri[eè]me|fourth|cinqui[eè]me|fifth|sixi[eè]me|sixth";
const ORDINAL_VALUES = [/^(?:premi|first)/i, /^(?:deuxi|second)/i, /^(?:troisi|third)/i, /^(?:quatri|fourth)/i, /^(?:cinqui|fifth)/i, /^(?:sixi|sixth)/i];

/**
 * Numéro de saison cité dans un titre ou une phrase : « saison 2 », « 2e saison », « deuxième
 * saison », « 2nd Season », « Season 2 », « S2 », « Tanya II » ; null sans numéro (« la saison 2026 » non plus).
 */
export function pressSeason(text: string): number | null {
  const n =
    /(?<![\p{L}\p{N}])(?:saison|season)\s*(\d{1,2})(?![\p{L}\p{N}])/iu.exec(text)?.[1] ??
    /(?<![\p{L}\p{N}])(\d{1,2})\s*(?:e|ème|eme|è|re|ère|er|nde?|st|nd|rd|th)\s+(?:saison|season)(?![\p{L}])/iu.exec(text)?.[1] ??
    /(?<![\p{L}\p{N}])S(\d{1,2})(?:E\d{1,4})?(?![\p{L}\p{N}])/u.exec(text)?.[1];
  if (n) return Number(n);
  const w = new RegExp(`(?<![\\p{L}])(${ORDINAL_SEASON})\\s+(?:saison|season)(?![\\p{L}])`, "iu").exec(text)?.[1];
  if (w) return ORDINAL_VALUES.findIndex((re) => re.test(w)) + 1;
  const roman = /\s(II|III|IV|V|VI)(?=\s*(?::|$))/.exec(text)?.[1];
  return roman ? ["", "I", "II", "III", "IV", "V", "VI"].indexOf(roman) : null;
}

const LIVE_ACTION = /(?<![\p{L}])(?:live[- ]action|drama live|série live|prises? de vues? réelles?)(?![\p{L}])/iu;
const FILM_WORDS = /(?<![\p{L}])(?:films?|movies?|long[- ]métrages?)(?![\p{L}])/iu;

/** L'animé tel que la presse le voit : ses noms, sa saison (1 sans numéro), film ou non. */
export interface PressWork {
  names: string[];
  season: number;
  film: boolean;
  others?: readonly string[]; // noms des autres animés que l'article cite
  known?: readonly string[]; // personnages de l'œuvre (AniList) : des noms propres qui ne sont pas une autre œuvre
}

/**
 * Pourquoi un article ne porte pas sur cet animé, d'après son titre (null s'il porte sur lui) : titre
 * qui ne le nomme pas (article-liste, autre sujet), adaptation live-action, film pour une série,
 * autre saison ; pour une suite, le titre doit dire sa saison (« Frieren : le manga… » n'est pas la saison 2).
 */
export function articleMismatch(title: string, work: PressWork): string | null {
  const m = workMatcher(work.names, work.others)(title);
  if (!m.ours) return m.other ? "article sur un autre animé" : "titre sans l'animé";
  if (LIVE_ACTION.test(title)) return "article sur une adaptation live-action";
  if (!work.film && FILM_WORDS.test(title)) return "article sur un film";
  const season = pressSeason(title);
  if (season !== null && season !== work.season) return "article sur une autre saison";
  if (season === null && work.season > 1) return "titre sans numéro de saison";
  return null;
}

/**
 * Passage d'un article sur l'animé, si son titre porte sur lui (articleMismatch). Dans le doute, rien
 * (relectures v8.6) :
 * - début : la partie dont le titre le nomme, ou la première phrase qui le nomme, celle qui vient
 *   d'abord ; s'il n'est nommé que dans le titre de l'article, tout l'article ;
 * - fin : le titre d'une autre partie (balisé, ou ligne courte sans point final), sauf une partie sur
 *   la même œuvre (synopsis, date, où regarder…) ; une phrase qui nomme un autre animé cité par
 *   l'article, qui commence par le titre d'une autre œuvre, ou qui recommande d'autres œuvres ;
 * - écartés : titres, phrases d'annonce, phrases qui citent aussi un autre animé ou une autre saison.
 */
export function pressPassage(lines: readonly PageLine[], work: PressWork, title: string, max = MAX_PRESSE_TEXT): string {
  if (articleMismatch(title, work)) return "";
  const match = workMatcher(work.names, work.others);
  const own = titleKeys(work.names);
  const known = knownWords(work);
  const body = lines.filter((l) => !l.title).slice(0, MAX_PRESSE_SCAN); // une page démesurée ne coûte pas plus
  const roles = body.map((l): HeadingRole | null => (l.heading || titleLike(l.text) ? headingRole(l, work, match, own, known) : null));
  const chars = characterWords(work);
  const roundup = roundupTitle(title, work, known);
  // le texte nomme l'animé, ou un de ses personnages (AniList) ; un mot accentué ne vaut un personnage que
  // s'il porte les mêmes accents (« Série » n'est pas Serie), et une référence (« comme Frieren », « les fans
  // de Frieren », « like Frieren ») ne rattache pas la phrase à l'œuvre (revue v8.6)
  const exact = new Set((work.known ?? []).flatMap((n) => n.normalize("NFC").toLowerCase().split(/\s+/)));
  const plain = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "") === w.normalize("NFD");
  const about = (raw: string) => {
    const text = raw.replace(REFERENCE, " ");
    return (
      match(text).ours ||
      text.split(/\s+/).some((w) => {
        const x = w.replace(/^[«"“(\[]+|[»"”),.;:!?…\]]+$/g, "").replace(/^[ldLD]['’](?=\p{Lu})/u, "");
        return /^\p{Lu}/u.test(x) && chars.has(nameWord(x)) && (plain(x) || exact.has(x.normalize("NFC").toLowerCase()));
      })
    );
  };
  const part = roles.indexOf("ours");
  // texte sous le titre d'une autre œuvre (autre animé, autre saison…) : jamais le début du passage, même
  // s'il nomme l'animé (« Frieren saison 1 : ce qu'il faut retenir » dans un article sur la saison 2)
  let context: HeadingRole | null = null;
  const startable = roles.map((role) => {
    if (role === "ours" || role === "foreign") context = role;
    return role === null && context !== "foreign";
  });
  const found = body.findIndex((l, i) => startable[i] && match(l.text).ours);
  // nommé seulement dans le titre de l'article : tout l'article, s'il ne cite aucun autre animé ni autre œuvre
  if (part < 0 && found < 0 && ((work.others?.length ?? 0) > 0 || roundup)) return "";
  const start = part >= 0 && (found < 0 || part < found) ? part : Math.max(0, found);
  // dans une ligne de texte, le passage commence à la phrase qui nomme l'animé
  let begun = (part >= 0 && start === part) || found < 0;
  // une phrase sans nom (« L'elfe poursuit son voyage… ») n'est gardée qu'à la suite d'une phrase qui nomme
  // l'animé ou un personnage, sans rien d'autre entre les deux ; nommé seulement dans le titre de l'article
  // (« Anime - The Vermilion Mask - Episode #1 »), il faut d'abord une phrase qui nomme un personnage
  let flow = part >= 0 && start === part;
  // intitulé de phrase au nom de l'animé, même abrégé : « Re:Zero : … » pour « Re:Zero - Starting Life… Season 3 »
  const ourLabel = (label: string) => {
    const k = pressKey(label);
    if (match(label).ours || (k.replace(/ /g, "").length >= 4 && own.some((o) => o.startsWith(`${k} `)))) return true;
    // des personnages de l'œuvre (« Himmel : le héros disparu… », « Fern et Stark : … »)
    const names = label.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
    return names.length > 0 && names.every((w) => chars.has(nameWord(w)));
  };
  const announce = (s: string) => ANNOUNCE.some((re) => re.test(s)) || titleKey(s).split(" ").length < 5;
  const kept: string[] = [];
  let size = 0;
  const done = () => clipText(kept.join(" "), max);
  for (let i = start; i < Math.min(body.length, start + MAX_PRESSE_LINES) && size < max; i++) {
    const role = roles[i];
    if (role === "end" || role === "foreign") break; // une autre partie : autre œuvre, autre saison, autre sujet
    if (role !== null) continue; // un titre ne raconte rien
    const text = body[i]!.text.replace(/^(?:synopsis|résumé|l'histoire|histoire|le pitch|pitch|story|plot)\s*:\s*/iu, "");
    const sentences = text.split(SENTENCE_END);
    let strict = false; // paragraphe ouvert par un autre nom : seules ses phrases qui nomment l'œuvre ou un personnage
    if (begun && i > start) {
      // article-liste sans partie à son nom : chaque paragraphe doit nommer l'animé, sans texte sans nom entre deux
      if (roundup && part < 0 && !match(text).ours) return done();
      if (roundup) flow = false;
      // rien sur l'animé ni ses personnages, et une autre œuvre (citée, ou une personne ou une œuvre venue
      // d'ailleurs, hors crédits) : un autre sujet, arrêt
      const firstAbout = sentences.findIndex(about);
      if (firstAbout < 0 && sentences.some((x) => match(x).other || (!CREDITS.some((re) => re.test(x)) && foreignRun(x, known)))) return done();
      // un nom venu d'ailleurs avant le premier nom de l'animé : le texte sans nom n'est pas rattaché d'office
      const firstStrange = sentences.findIndex((x) => match(x).other || (!about(x) && strangeIn(x, known)));
      if (firstStrange >= 0 && (firstAbout < 0 || firstStrange < firstAbout)) {
        flow = false;
        strict = true;
      }
    }
    for (const s of sentences) {
      const who = match(s);
      if (!begun) {
        if (!who.ours) continue; // avant l'animé : l'introduction, ou la partie d'une autre œuvre
        begun = true;
        flow = true;
      }
      if (who.other && !who.ours) return done(); // la partie d'un autre animé
      if (RECO_SENTENCE.test(s)) return done(); // des recommandations : la suite parle d'autres œuvres
      const label = workLabel(s);
      if (label && !ourLabel(label)) return done(); // une autre œuvre (article-liste en texte brut)
      const ours = about(s);
      // une comparaison (deux animés, « Comme Frieren, Reiko Kujirai… »), un film, un live-action, un spin-off,
      // un nom venu d'ailleurs sans l'œuvre, une autre saison : la phrase est écartée, et le texte sans nom qui
      // la suit aussi. Vérifié avant les annonces : « Kowloon Generic Romance revient aussi sur Crunchyroll. Son
      // héroïne… » (revue v8.6). Les noms des crédits (« Viz Media », « Kanehito Yamada ») ne sont pas une autre œuvre
      const credits = CREDITS.some((re) => re.test(s));
      const season = pressSeason(s);
      if (
        who.other ||
        (!work.film && FILM_WORDS.test(s)) ||
        LIVE_ACTION.test(s) ||
        SPIN_OFF.test(s) ||
        (!credits && foreignRun(s, known)) ||
        (!ours && strangeIn(s, known)) ||
        (season !== null && season !== work.season) ||
        (work.season > 1 && RECAP_SENTENCE.test(s))
      ) {
        flow = false;
        continue;
      }
      if (credits || announce(s) || (!ours && (!flow || strict))) continue;
      flow = true;
      kept.push(s);
      size += s.length + 1;
      if (size >= max) break;
    }
  }
  return done();
}

interface PresseArticle {
  url: string;
  source: string; // le site, tel que le module presse le nomme (« Manga-News », « Gameblog », « ANN »)
  titre: string;
  others: number[]; // les autres animés du site que l'article cite (article-liste, comparaison)
}

/**
 * Articles qui citent l'animé, les plus récents d'abord. Dans `presse_articles`, `animes` est la liste
 * des animés cités, séparés par des virgules (« 380 », « 380,465 » ; relevé du 12 octobre).
 */
async function presseArticles(pool: SqlPool, animeId: number): Promise<PresseArticle[]> {
  const rows = rowsOf(
    await pool.query(
      `SELECT url, source, titre, animes FROM presse_articles
       WHERE FIND_IN_SET(?, REPLACE(REPLACE(REPLACE(animes, ' ', ''), '[', ''), ']', '')) > 0
       ORDER BY COALESCE(publie_le, lu_le) DESC LIMIT ?`,
      [String(animeId), MAX_PRESSE_ROWS],
    ),
  );
  return rows.flatMap((r): PresseArticle[] => {
    const o = r as Record<string, unknown>;
    const text = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
    const ids = [...new Set(text("animes").split(/[^0-9]+/).filter(Boolean).map(Number))];
    const url = text("url");
    const titre = decodeEntities(text("titre")).replace(/\s+/g, " ").trim();
    return /^https?:\/\//.test(url) ? [{ url, source: text("source"), titre, others: ids.filter((id) => id !== animeId) }] : [];
  });
}

/** Noms des autres animés cités, pour reconnaître leur partie d'un article ; null si la base ne répond pas. */
async function animeNames(pool: SqlPool, ids: readonly number[]): Promise<Map<number, string[]> | null> {
  const out = new Map<number, string[]>();
  if (ids.length === 0) return out;
  try {
    const rows = rowsOf(await pool.query(`SELECT id, title, title_english FROM anime_items WHERE id IN (${ids.map(() => "?").join(", ")})`, [...ids]));
    for (const r of rows) {
      const o = r as Record<string, unknown>;
      if (typeof o["title"] !== "string") continue;
      out.set(Number(o["id"]), workNames(o["title"], typeof o["title_english"] === "string" ? o["title_english"] : null));
    }
    return out;
  } catch {
    return null;
  }
}

const SPANISH = new Set(["el", "los", "las", "del", "y", "para", "por", "con", "su", "sus", "como", "pero", "más", "está", "también", "temporada"]);
const FRENCH = new Set(["le", "les", "des", "du", "une", "est", "dans", "pour", "sur", "avec", "qui", "pas", "ses", "aux", "au", "cette"]);
const ENGLISH = new Set(["the", "and", "of", "to", "is", "with", "for", "on", "his", "her", "their", "who", "that", "from", "by"]);

/** Langue d'un texte de presse, aux mots outils : la presse lit aussi LevelUp en espagnol. */
export function pressLanguage(text: string): "fr" | "en" | "es" | null {
  const counts = { fr: 0, en: 0, es: 0 };
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (FRENCH.has(w)) counts.fr++;
    if (ENGLISH.has(w)) counts.en++;
    if (SPANISH.has(w)) counts.es++;
  }
  const best = (Object.entries(counts) as Array<["fr" | "en" | "es", number]>).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] >= 3 ? best[0] : null;
}

/**
 * Passages des articles de presse sur l'animé (2 articles au plus, les plus récents qui en disent
 * quelque chose ; 4 pages lues au plus). Un article dont le titre porte sur autre chose n'est pas relu.
 * Ne lève jamais d'erreur.
 */
export async function fetchPresse(
  pool: SqlPool,
  item: ItemRow,
  read: (url: string) => Promise<{ html: string } | { note: string }> = readArticlePage,
  characters: readonly string[] = [],
): Promise<PresseResult> {
  let articles: PresseArticle[];
  try {
    articles = await presseArticles(pool, item.id);
  } catch (err) {
    const msg = errMessage(err).split("\n")[0] ?? "";
    return { entries: [], note: /\b1146\b|doesn't exist/.test(msg) ? "presse : table presse_articles absente" : `presse : table illisible (${msg})` };
  }
  if (articles.length === 0) return { entries: [], note: null };
  const base: PressWork = {
    names: workNames(item.title, item.title_english),
    season: pressSeason(item.title_english ?? "") ?? pressSeason(item.title) ?? 1,
    film: /movie|film/i.test(item.kind ?? ""),
    known: characters,
  };
  const known = await animeNames(pool, [...new Set(articles.flatMap((a) => a.others))]);
  const entries: DossierEntry[] = [];
  const misses: string[] = [];
  // chaque article et son sort, pour l'essai à blanc (essai v8.6 : « titre sans numéro de saison », sans le titre)
  const seen: PresseSeen[] = [];
  let pages = 0;
  for (const a of articles) {
    const site = a.source || hostOf(a.url);
    let shown = a.titre || a.url;
    const mark = (verdict: string): void => void seen.push({ site, titre: shown, verdict });
    if (entries.length >= MAX_PRESSE_ARTICLES) {
      mark(`non lu (${MAX_PRESSE_ARTICLES} passages déjà gardés)`);
      continue;
    }
    if (pages >= MAX_PRESSE_READ) {
      mark(`non lu (${MAX_PRESSE_READ} pages déjà lues)`);
      continue;
    }
    // sans les noms des autres animés cités, impossible de savoir où s'arrête la partie de celui-ci
    if (a.others.length > 0 && known === null) {
      misses.push(`autres animés de l'article illisibles (${site})`);
      mark("autres animés de l'article illisibles");
      continue;
    }
    const work: PressWork = { ...base, others: a.others.flatMap((id) => known?.get(id) ?? []) };
    // le titre noté par la presse : un article sur autre chose n'est même pas relu
    const before = a.titre ? articleMismatch(a.titre, work) : null;
    if (before) {
      misses.push(`${before} (${site})`);
      mark(before);
      continue;
    }
    pages++;
    const page = await read(a.url);
    if ("note" in page) {
      misses.push(page.note);
      mark(page.note);
      continue;
    }
    const lines = articleText(page.html);
    const title = a.titre || (lines.find((l) => l.title)?.text ?? "");
    if (title) shown = title;
    const after = a.titre ? null : articleMismatch(title, work);
    if (after) {
      misses.push(`${after} (${site})`);
      mark(after);
      continue;
    }
    if (pressLanguage(lines.map((l) => l.text).join("\n")) === "es") {
      misses.push(`article en espagnol (${site})`);
      mark("article en espagnol");
      continue;
    }
    // article-liste sans titres de parties : impossible de savoir où s'arrête la partie de l'animé
    if (a.others.length > 0 && !lines.some((l) => l.heading)) {
      misses.push(`article-liste sans titres (${site})`);
      mark("article-liste sans titres de parties");
      continue;
    }
    const text = pressPassage(lines, work, title);
    if (text.length >= MIN_SOURCE) {
      entries.push({ source: `${PRESSE_SOURCE} : ${site}`, text });
      mark(`passage gardé (${[...text].length} car.)`);
    } else {
      misses.push(`rien sur l'animé (${site})`);
      mark("rien sur l'animé");
    }
  }
  const n = articles.length;
  const note = entries.length ? null : `presse : ${n} article${n > 1 ? "s" : ""}, aucun passage (${misses[0] ?? "?"})`;
  return { entries, note, seen };
}

// ─── Site officiel (v9.3) ────────────────────────────────────────────────────
// Rey (13 octobre, 19 h 47) : « Pour le synopsis, je veux que tu récupères puis tu fais un résumé sans
// inventer. » Le code lit la page d'accueil du site officiel (AniList « Official Site », IGDB websites
// type 1), robots.txt respecté, et la met en tête du dossier. Relevé du 13 octobre (23 items) :
// - ce qui sert : la description officielle (JSON-LD, og:description, meta) et, sur un site en anglais,
//   un ou deux paragraphes qui nomment l'œuvre (Replaced, Elementallis, Wistoria) ;
// - les pièges : les sous-pages Story et Character racontent épisode par épisode (Classroom, Tanya, Kirei :
//   spoilers), l'accueil d'un studio décrit d'autres jeux (Bendy: The Cage, Slay the Spire 2), et beaucoup
//   d'actualités, de commentaires de comédiens, de mentions légales : rien de cela n'est lu ;
// - les animés n'ont souvent qu'un site japonais : leur description seule, traduite en français par le
//   modèle avant les notes (Rey, 20 h 30 : « description seule mais en français »).

export const OFFICIAL_SOURCE = "Site officiel";
export const OFFICIAL_JA_SOURCE = "Site officiel (traduit du japonais)";
const MAX_OFFICIAL_LINKS = 2; // adresses essayées par item (l'anglais d'abord)
const MAX_OFFICIAL_TEXT = 700;
const MAX_OFFICIAL_PARAGRAPHS = 2;
const MIN_OFFICIAL_PARAGRAPH = 100;
const MAX_OFFICIAL_PARAGRAPH = 450;
const OFFICIAL_MAX_DELAY_MS = 30_000; // robots.txt : délai accepté pour une ou deux pages par item
const MIN_JA_TEXT = 10; // caractères japonais au moins : en dessous, la description ne dit rien de l'histoire
const MAX_JA_TEXT = 300;
const CJK_PAGE = 0.3; // part de caractères japonais ou chinois au-delà de laquelle la page est en japonais
const TRANSLATE_TOKENS = 350;
const MAX_TRANSLATED_TEXT = 500; // en tête du dossier (2 000 caractères en tout) : la traduction n'y prend pas toute la place

/** Lien vers le site officiel : langue donnée par AniList (« English », « Japanese »), null sinon (IGDB). */
export interface OfficialLink {
  url: string;
  language: string | null;
}

export interface OfficialContext {
  titles: string[]; // titres en lettres latines (titre du site, titre anglais)
  nativeTitle: string | null; // titre japonais (AniList)
  names: string[]; // personnages principaux, en lettres latines
}

/** Ce qu'une page officielle donne, avant le choix de ce qui va au dossier. */
export interface OfficialPage {
  cjk: boolean; // page en japonais (ou chinois)
  descriptions: string[]; // descriptions officielles, phrases publicitaires ou d'actualité retirées
  paragraphs: string[]; // paragraphes de l'accueil qui nomment l'œuvre (pages en lettres latines)
  namesWork: boolean; // le titre de la page ou sa description nomment l'œuvre
  alternates: Array<{ lang: string; url: string }>; // versions de la page dans d'autres langues (hreflang)
}

/** Description japonaise à traduire, avec les noms qu'elle contient et leur forme latine. */
export interface OfficialPending {
  original: string;
  glossary: ReadonlyArray<readonly [string, string]>;
}

export interface OfficialResult {
  url: string | null; // page dont le texte est gardé (ou la dernière essayée)
  entry: DossierEntry | null; // texte en anglais ou en français, pour le dossier
  pending: OfficialPending | null; // texte japonais, à traduire
  note: string | null; // pourquoi rien n'est gardé
}

/** Ce que l'essai à blanc et les journaux montrent du site officiel. */
export interface OfficialSeen {
  url: string | null;
  original?: string; // description japonaise
  text?: string; // texte gardé (traduction comprise)
  note: string | null;
}

const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・々〆]{2,}/u;

/** Part (0 à 1) des lettres d'un texte qui sont japonaises ou chinoises. */
export function cjkShare(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters ? (text.match(CJK_CHARS)?.length ?? 0) / letters : 0;
}

/** Les adresses à essayer : anglais, français, sans langue, puis japonais ; les autres langues ne sont pas lues. */
export function pickOfficialLinks(links: readonly OfficialLink[]): OfficialLink[] {
  const rank = (l: OfficialLink): number => {
    const lang = (l.language ?? "").trim().toLowerCase();
    return lang === "english" ? 0 : lang === "french" ? 1 : lang === "" ? 2 : lang === "japanese" ? 3 : 9;
  };
  const seen = new Set<string>();
  return links
    .filter((l) => /^https?:\/\//i.test(l.url) && rank(l) < 9)
    .sort((a, b) => rank(a) - rank(b))
    .filter((l) => {
      const key = l.url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_OFFICIAL_LINKS);
}

function tagAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function flatText(s: string): string {
  return decodeEntities(decodeEntities(s)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// types JSON-LD dont la description est celle de l'œuvre ou de la page (pas un épisode, un article, un produit, le studio)
const LD_WORK = /^(?:VideoGame|VideoGameSeries|Game|TVSeries|TVSeason|Movie|MovieSeries|CreativeWork|CreativeWorkSeries|BookSeries|ComicSeries|Book|WebPage|WebSite|AboutPage|CollectionPage)$/i;
const MAX_PAGE_DESCRIPTIONS = 6;

/**
 * Descriptions de la page : JSON-LD (nœuds de premier niveau ou du @graph, d'une œuvre ou d'une page ; pas
 * les épisodes ni les articles imbriqués, relecture v9.3 : un résumé d'épisode est un spoiler),
 * og:description, description, twitter:description. Six au plus.
 */
export function pageDescriptions(html: string): string[] {
  const out: string[] = [];
  const take = (x: unknown): void => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return;
    const o = x as Record<string, unknown>;
    const types = (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((t): t is string => typeof t === "string");
    if ((types.length === 0 || types.some((t) => LD_WORK.test(t))) && typeof o["description"] === "string") out.push(o["description"]);
  };
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let json: unknown;
    try {
      json = JSON.parse(m[1] ?? "");
    } catch {
      continue; // JSON-LD illisible : les balises meta suffisent
    }
    for (const node of Array.isArray(json) ? json : [json]) {
      take(node);
      const graph = node && typeof node === "object" ? (node as Record<string, unknown>)["@graph"] : null;
      if (Array.isArray(graph)) for (const g of graph) take(g);
    }
  }
  for (const m of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const key = (tagAttr(m[0], "property") ?? tagAttr(m[0], "name") ?? "").toLowerCase();
    if (key === "og:description" || key === "description" || key === "twitter:description") out.push(tagAttr(m[0], "content") ?? "");
  }
  return [...new Set(out.map(flatText).filter((d) => d.length > 0))].slice(0, MAX_PAGE_DESCRIPTIONS);
}

/** Titre de la page (balise title, og:title). */
function pageTitles(html: string): string {
  const own = /<title\b[^>]*>([\s\S]{0,400}?)<\/title\s*>/i.exec(html)?.[1] ?? "";
  const og = [...html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .filter((m) => /^(?:og|twitter):title$/i.test(tagAttr(m[0], "property") ?? tagAttr(m[0], "name") ?? ""))
    .map((m) => tagAttr(m[0], "content") ?? "");
  return [own, ...og].map(flatText).join(" · ");
}

// phrase publicitaire ou d'actualité (anglais, français) : retirée de la description
const PROMO_SENTENCE =
  /\b(?:out now|play (?:it )?now|available (?:now|today|on|for)|coming (?:soon|to|this|in|on)|pre-?(?:order|purchase)|wishlist|buy (?:it )?now|on sale|free (?:dlc|update|demo)|launch(?:es|ing|ed)? (?:on|in|this|for)|releas(?:es|ing|ed)? (?:on|in|this)|stream(?:ing)? (?:on|now|exclusively)|watch (?:it )?(?:on|now)|official (?:site|website|home)|subscribe|sign up|follow us|join (?:our|the) (?:discord|community)|download (?:it )?(?:now|today|for free)|disponible (?:dès|sur|le|en|maintenant)|bientôt (?:sur|disponible)|précommande|sortie (?:le|prévue)|site officiel|abonnez|rejoignez)\b/i;

// paragraphe sans histoire : mentions légales, cookies, distribution, équipe, configuration, classification
const NOISE_PARAGRAPH =
  /cookie|copyright|©|all rights reserved|trademark|privacy (?:policy|notice)|terms of (?:use|service)|newsletter|\bcv\s*[:：]|voice actors?\b|voiced by|\b(?:main )?staff\s*[:&]|\bcast\s*[:&]|\bdirected by\b|\bdirector\s*:|\bcomposer\s*:|theme song|\besrb\b|\bpegi\b|age rating|system requirements|mentions légales|tous droits réservés|confidentialité/i;

/** Phrases d'un texte en lettres latines, sans les phrases publicitaires ou d'actualité. */
function withoutPromo(text: string): string {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .filter((x) => x.trim().length > 0 && !PROMO_SENTENCE.test(x))
    .join(" ")
    .trim();
}

// phrase japonaise d'actualité ou de fiche technique : diffusion, sortie, ventes, équipe, distribution
const JA_NEWS =
  /放送|配信|公開|発売|決定|突破|公式|開催|予約|上映|放映|ブルーレイ|Blu-?ray|DVD|制作|監督|周年|記念|解禁|累計|刊行|連載|キャスト|主題歌|コラボ|チケット|受賞|特報|予告|スタート|ON ?AIR|オンエア|アニメ化|ロードショー|待望|大ヒット|\d{4}年(?:\d{1,2}月|[春夏秋冬]|より|から|に|内|度)|\d{1,2}月\d{1,2}日|\d{1,2}月(?:より|から|に|、)/i;

/**
 * Description japonaise sans les actualités : les phrases de diffusion, sortie, ventes, équipe sont
 * retirées, ainsi que les crédits en tête de phrase (« 原作：…、 ») et les parenthèses. Vide si ce qui
 * reste est trop court pour dire quelque chose de l'histoire.
 */
/** Phrases japonaises : coupées après 。！？, sauf entre crochets (« 「綺麗にしてもらえますか。」 » est un titre). */
function japaneseSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const chars = [...text];
  chars.forEach((c, i) => {
    current += c;
    if ("「『（(【“".includes(c)) depth++;
    else if ("」』）)】”".includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && "。！？!?".includes(c) && !"。！？!?".includes(chars[i + 1] ?? "")) {
      out.push(current);
      current = "";
    }
  });
  if (current.trim()) out.push(current);
  return out;
}

export function japaneseDescription(text: string): string {
  const kept: string[] = [];
  for (const raw of japaneseSentences(text)) {
    let t = raw.replace(/[（(][^（）()]{0,80}[）)]/gu, "").trim();
    for (let i = 0; i < 3; i++) {
      const next = t.replace(/^[^、。：:]{1,8}[：:][^、。]{0,60}、\s*/u, "");
      if (next === t) break;
      t = next;
    }
    // « ２０２６年７月より » : chiffres et lettres pleine chasse lus comme les autres (relecture v9.3)
    if (t && !JA_NEWS.test(t.normalize("NFKC"))) kept.push(t);
  }
  let out = kept.join("");
  if (out.length > MAX_JA_TEXT) {
    const head = out.slice(0, MAX_JA_TEXT);
    const end = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
    out = end > MAX_JA_TEXT / 3 ? head.slice(0, end + 1) : head;
  }
  return (out.match(CJK_CHARS)?.length ?? 0) >= MIN_JA_TEXT ? out : "";
}

const SEASON_WORD = /^(?:season|saison|part|partie|cour|final|\d+(?:st|nd|rd|th)?)$/;
const SEASON_BEFORE = /^(?:season|saison|part|partie|cour|vol|volume|episode|chapter|chapitre)$/;

/** Mots qui distinguent un titre (sans mots vides, numéros, « season ») : « Bendy: The Cage » → bendy, cage. */
function distinctWords(title: string): string[] {
  return titleKey(title)
    .split(" ")
    .filter((w) => w.length >= 2 && /\p{L}/u.test(w) && !TITLE_STOPWORDS.has(w) && !SEASON_WORD.test(w) && !ROMAN_NUMERAL.test(w));
}

/**
 * Numéros de suite d'un titre (« Nioh 3 », « Grand Theft Auto VI ») : chiffres, chiffres romains de deux
 * lettres et plus, ou d'une lettre en fin de titre ; pas un numéro de saison (« Season 2 »), ni le « x »
 * de « Spy x Family ».
 */
function titleNumbers(title: string): number[] {
  const main = title.split(/\s*[:：]\s*|\s+[-–—]\s+/u)[0] ?? title;
  const words = titleKey(main).split(" ").filter(Boolean);
  return words.flatMap((w, i) => {
    if (SEASON_BEFORE.test(words[i - 1] ?? "")) return [];
    const roman = ROMAN_NUMERAL.test(w);
    if (roman && w.length === 1 && i !== words.length - 1) return [];
    const v = /^\d{1,4}$/.test(w) || roman ? numeralValue(w) : null;
    return v === null ? [] : [v];
  });
}

/** Sous-titre d'un titre (« Resident Evil 9: Requiem » → Requiem) : ses mots, s'il en a. */
function subtitleWords(title: string): string[] {
  const parts = title.split(/\s*[:：]\s*|\s+[-–—]\s+/u);
  return parts.length > 1 ? distinctWords(parts.slice(1).join(" ")) : [];
}

const GENERIC_JA = /^(?:劇場版|映画|TVアニメ|アニメ|総集編|特別編|完全版|新作|続編|第[一二三四五六七八九十\d]+期)$/u;

/** Parties du titre japonais qui le désignent, hors « 劇場版 », « 映画 »… : la première (la série : « 鬼滅の刃 »), puis la plus longue. */
function nativeKeys(nativeTitle: string | null): string[] {
  const runs = ((nativeTitle ?? "").match(new RegExp(CJK_RUN.source, "gu")) ?? []).filter((r) => !GENERIC_JA.test(r));
  const longest = [...runs].sort((a, b) => b.length - a.length)[0];
  return [...new Set([runs[0], longest].filter((r): r is string => Boolean(r)))];
}

function nativeKey(nativeTitle: string | null): string | null {
  return nativeKeys(nativeTitle)[0] ?? null;
}

/**
 * Le texte nomme l'œuvre : tous les mots d'un des titres latins, avec son numéro de suite (ou son sous-titre :
 * « Resident Evil Requiem » pour « Resident Evil 9: Requiem ») ; ou le titre japonais (relecture v9.3 :
 * « Nioh 2 » ne nomme pas Nioh 3, « 劇場版 » seul ne nomme aucun film).
 */
export function namesWork(text: string, ctx: OfficialContext): boolean {
  const words = titleKey(text).split(" ").filter(Boolean);
  const key = ` ${words.join(" ")} `;
  const values = new Set(words.map((w) => (/^\d{1,4}$/.test(w) || ROMAN_NUMERAL.test(w) ? numeralValue(w) : null)).filter((v): v is number => v !== null));
  const named = ctx.titles.some((title) => {
    const ws = distinctWords(title);
    if (ws.length === 0 || !ws.every((w) => key.includes(` ${w} `))) return false;
    const numbers = titleNumbers(title);
    if (numbers.length === 0 || numbers.some((n) => values.has(n))) return true;
    const sub = subtitleWords(title);
    return sub.length > 0 && sub.some((w) => w.length >= 4);
  });
  if (named) return true;
  const flat = text.replace(/\s+/g, "");
  return nativeKeys(ctx.nativeTitle).some((k) => flat.includes(k));
}

/** Nom d'un personnage principal (une partie de 3 lettres au moins, avec sa majuscule) dans le texte. */
function namesCharacter(text: string, names: readonly string[]): boolean {
  return names.some((n) =>
    (n.match(/\p{L}{3,}/gu) ?? []).some((part) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, "u").test(text)),
  );
}

/** Ce que la page d'accueil officielle donne : descriptions, paragraphes qui nomment l'œuvre, langue, versions. */
export function officialPage(html: string, ctx: OfficialContext): OfficialPage {
  const descriptions = pageDescriptions(html);
  const lines = pageLines(html).filter((l) => !l.heading && !l.title);
  const sample = [...descriptions, ...lines.map((l) => l.text)].join(" ");
  const cjk = cjkShare(sample) >= CJK_PAGE || /^(?:ja|zh|ko)\b/i.test(tagAttr(/<html\b[^>]*>/i.exec(html)?.[0] ?? "", "lang") ?? "");
  const alternates: Array<{ lang: string; url: string }> = [];
  for (const m of html.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (!/\balternate\b/i.test(tagAttr(m[0], "rel") ?? "")) continue;
    const lang = (tagAttr(m[0], "hreflang") ?? "").toLowerCase();
    const href = tagAttr(m[0], "href");
    if (lang && href) alternates.push({ lang, url: decodeEntities(href) });
  }
  // une description compte si elle nomme l'œuvre, ou si le titre de la page la nomme (pas l'accueil d'un studio)
  const title = pageTitles(html);
  const titled = namesWork(title, ctx);
  const naming = descriptions.map((d) => titled || namesWork(d, ctx));
  const kept = descriptions
    .map((d) => (cjkShare(d) >= CJK_PAGE ? japaneseDescription(d) : withoutPromo(d)))
    .filter((d, i) => d.length > 0 && naming[i]);
  // sans doublon : une description contenue dans une autre (og:description = meta description, JSON-LD plus long)
  const unique: string[] = [];
  const seenShingles = new Set<string>();
  for (const d of kept.sort((a, b) => b.length - a.length)) {
    if (unique.some((x) => x.includes(d)) || overlap(d, seenShingles) >= NEAR_DUPLICATE) continue;
    unique.push(d);
    for (const x of shingles(d)) seenShingles.add(x);
  }
  // paragraphes : seulement sur une page dont le titre nomme l'œuvre (l'accueil d'un studio décrit d'autres
  // jeux, relevé du 13 octobre : Bendy, Slay the Spire 2) ; chacun nomme l'œuvre ou un personnage principal
  const paragraphs: string[] = [];
  if (!cjk && titled) {
    for (const l of lines) {
      if (paragraphs.length >= MAX_OFFICIAL_PARAGRAPHS) break;
      const t = withoutPromo(l.text);
      if (t.length < MIN_OFFICIAL_PARAGRAPH || cjkShare(t) >= CJK_PAGE || NOISE_PARAGRAPH.test(t)) continue;
      if (!namesWork(t, ctx) && !namesCharacter(t, ctx.names)) continue;
      if ([...unique, ...paragraphs].some((x) => x.includes(t)) || overlap(t, seenShingles) >= NEAR_DUPLICATE) continue;
      const kept = clipText(t, MAX_OFFICIAL_PARAGRAPH);
      paragraphs.push(kept);
      for (const x of shingles(kept)) seenShingles.add(x);
    }
  }
  // l'œuvre est nommée par le titre de la page ou une de ses descriptions (même d'actualité : Steel Ball Run)
  return { cjk, descriptions: unique, paragraphs, namesWork: titled || naming.some(Boolean), alternates };
}

/** Glossaire de traduction : noms japonais (personnages, titre) présents dans le texte, et leur forme latine. */
export function officialGlossary(
  original: string,
  nativeNames: ReadonlyArray<readonly [string, string]>,
  nativeTitle: string | null,
  latinTitle: string,
): Array<readonly [string, string]> {
  const out = new Map<string, string>();
  for (const [native, full] of nativeNames) {
    if (native.length >= 2 && original.includes(native)) {
      out.set(native, full);
      continue;
    }
    // « ウィル・セルフォルト » / « Will Serfort » : chaque partie, quand les deux noms en ont autant. Seulement avec
    // « ・ » (noms en katakana, dans l'ordre occidental) : « 竈門 炭治郎 » met le nom de famille d'abord (relecture v9.3)
    const parts = native.split(/[・･]+/u).filter(Boolean);
    const latin = full.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.length === latin.length) {
      parts.forEach((p, i) => {
        if (p.length >= 2 && original.includes(p) && !out.has(p)) out.set(p, latin[i]!);
      });
    }
  }
  const title = nativeKey(nativeTitle);
  if (title && original.includes(title) && latinTitle) out.set(title, latinTitle);
  return [...out].slice(0, 12);
}

export type ReadPage = (url: string, gapMs?: number, maxDelayMs?: number) => Promise<{ html: string } | { note: string }>;

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "?";
  }
}

/**
 * Site officiel de l'item : la page d'accueil, l'anglais d'abord (puis sa version anglaise ou française si
 * la page est en japonais et en donne une). Texte en lettres latines → entrée du dossier ; description
 * japonaise → à traduire (`pending`). Ne lève jamais d'erreur.
 */
export async function fetchOfficial(
  links: readonly OfficialLink[],
  ctx: OfficialContext,
  glossaryFor: (original: string) => Array<readonly [string, string]>,
  read: ReadPage = readArticlePage,
): Promise<OfficialResult> {
  const notes: string[] = [];
  let last: string | null = null;
  let japanese: { url: string; pending: OfficialPending } | null = null;
  // texte en lettres latines seulement : une description restée en japonais n'entre pas sans traduction ; un titre
  // japonais entre parenthèses est retiré (« Wistoria: Wand and Sword (杖と剣のウィストリア) follows Will… »)
  const latinEntry = (page: OfficialPage): DossierEntry | null => {
    const latin = [...page.descriptions, ...page.paragraphs]
      .map((t) => t.replace(/\s*[（(「『][^（）()「」『』]{0,80}[）)」』]/gu, (m) => (cjkShare(m) > 0 ? "" : m)).replace(/\s+([,.;:])/g, "$1"))
      .filter((t) => cjkShare(t) === 0);
    const text = clipText(latin.join(" "), MAX_OFFICIAL_TEXT);
    return text.length >= MIN_SOURCE ? { source: OFFICIAL_SOURCE, text } : null;
  };
  const resolve = (href: string, base: string): string | null => {
    try {
      const u = new URL(href, base);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  };
  const same = (a: string, b: string) => a.replace(/#.*$/, "").replace(/\/+$/, "") === b.replace(/#.*$/, "").replace(/\/+$/, "");
  for (const link of pickOfficialLinks(links)) {
    last = link.url;
    const got = await read(link.url, PRESSE_GAP_MS, OFFICIAL_MAX_DELAY_MS).catch((err: unknown) => ({ note: `page injoignable : ${errMessage(err)}` }));
    if ("note" in got) {
      notes.push(got.note);
      continue;
    }
    const page = officialPage(got.html, ctx);
    if (page.cjk) {
      // page japonaise : sa version anglaise (ou française) d'abord, si elle en donne une
      const alt = ["en", "en-us", "en-gb", "fr", "fr-fr"]
        .map((l) => page.alternates.find((a) => a.lang === l))
        .map((a) => (a ? resolve(a.url, link.url) : null))
        .find((u): u is string => u !== null && !same(u, link.url));
      if (alt) {
        const other = await read(alt, PRESSE_GAP_MS, OFFICIAL_MAX_DELAY_MS).catch(() => ({ note: "" }));
        if ("html" in other) {
          const altPage = officialPage(other.html, ctx);
          const entry = altPage.cjk || !altPage.namesWork ? null : latinEntry(altPage);
          if (entry) return { url: alt, entry, pending: null, note: null };
        }
      }
    }
    if (!page.namesWork) {
      notes.push(`page qui ne nomme pas l'œuvre (${hostLabel(link.url)})`);
      continue;
    }
    if (!page.cjk) {
      const entry = latinEntry(page);
      if (entry) return { url: link.url, entry, pending: null, note: null };
      notes.push(`rien sur l'histoire (${hostLabel(link.url)})`);
      continue;
    }
    // japonais : la description seule (Rey), gardée si aucune page en anglais ne donne mieux
    const original = page.descriptions.find((d) => cjkShare(d) >= CJK_PAGE) ?? "";
    if (original && !japanese) japanese = { url: link.url, pending: { original, glossary: glossaryFor(original) } };
    else if (!original) notes.push(`description japonaise sans histoire (${hostLabel(link.url)})`);
  }
  if (japanese) return { url: japanese.url, entry: null, pending: japanese.pending, note: null };
  return { url: last, entry: null, pending: null, note: notes.join(" ; ") || "pas de site officiel connu" };
}

// Le titre n'est pas donné au traducteur : il lui ferait ajouter ce qu'il croit savoir de l'œuvre (relecture
// v9.3 : Youjo Senki, « Tanya Degurechaff… se bat contre Être X » ajouté à une phrase de 18 caractères)
export const TRANSLATE_PROMPT = `Tu traduis en français un court texte japonais tiré du site officiel d'une œuvre (animé ou jeu vidéo), pour GameNime, un site français.
- Traduis fidèlement tout le texte, et seulement lui : n'ajoute rien, ne retire rien, n'explique rien, même si tu crois connaître l'œuvre.
- Garde le sens exact : qui fait quoi à qui, sans inverser les rôles.
- Les noms propres du glossaire s'écrivent comme dans le glossaire. Un autre nom propre dont tu n'es pas sûr se remplace par ce qu'il désigne (« un soldat », « la ville »).
- Les nombres s'écrivent en lettres (« mille ans »).
- Réponds seulement par la traduction, sans guillemets, sans titre, sans commentaire.`;

function translateRequest(pending: OfficialPending): string {
  const glossary = pending.glossary.length ? `Glossaire : ${pending.glossary.map(([ja, la]) => `${ja} = ${la}`).join(" ; ")}\n` : "";
  return `${glossary}Texte japonais :\n${pending.original}`;
}

/** Traduction sans en-tête ; des guillemets seulement s'ils l'entourent (cleanOutput). */
export function cleanTranslation(raw: string): string {
  return cleanOutput(raw.replace(/^\s*(?:voici\s+)?(?:la\s+|ma\s+)?traduction(?:\s+(?:en\s+)?français[e]?)?\s*:\s*/i, "")).trim();
}

// mots qui prennent une majuscule en début de phrase sans être des noms propres
const FR_STARTERS = new Set(
  ("le la les l un une des du de d au aux ce cet cette ces c son sa ses leur leurs il elle ils elles on dans après avant avec depuis " +
    "lorsque quand alors cependant tandis pendant sous sur vers chez contre comme tout toute tous toutes ainsi puis enfin déjà jadis " +
    "autrefois aujourd hui plus moins très en à pour par entre parmi sans selon voici voilà là où qui que quoi mais et ou ni car si " +
    "une fois un jour désormais pourtant même face loin près au-delà chaque chacun chacune lorsqu jusqu puisqu quoiqu presqu " +
    "certains certaines plusieurs aucun aucune nul nulle autre autres tel telle tels telles quelques").split(" "),
);

/**
 * Ce qui ne va pas dans une traduction : japonais restant, pas du français, longueur, nom du glossaire
 * absent, nom propre hors du glossaire (les noms du texte japonais) et du texte lui-même, nombre absent
 * du texte japonais. Relecture v9.3 : un traducteur 8B ajoute des noms et des liens (« Stark, le fils de
 * Himmel ») que le texte ne dit pas, et la traduction sert ensuite de preuve ; même un nom connu d'une
 * autre source ne passe pas. Un lieu écrit en kanji (« 熱海 ») est donc refusé : la consigne demande de
 * le remplacer par ce qu'il désigne.
 */
export function translationProblems(text: string, pending: OfficialPending): string[] {
  const problems: string[] = [];
  if (!text) return ["traduction vide"];
  if ((text.match(CJK_CHARS)?.length ?? 0) > 0) problems.push("des caractères japonais sont restés");
  const tokens = text.toLowerCase().match(/[\p{L}'’]+/gu) ?? [];
  const fr = tokens.filter((w) => /^(?:l|d|qu|n|s|j|c|m|t)['’]\p{L}/u.test(w) || FR_WORDS.has(w)).length;
  const en = tokens.filter((w) => EN_WORDS.has(w)).length;
  if (fr < 2 || fr < 3 * en) problems.push("pas en français");
  const n = pending.original.length;
  if (text.length > n * 3 + 40) problems.push("beaucoup plus long que le texte japonais (ajout ?)");
  if (text.length < n * 0.8) problems.push("beaucoup plus court que le texte japonais (oubli ?)");
  const keys = new Set((text.match(/\p{L}+/gu) ?? []).map(romanKey));
  for (const [ja, latin] of pending.glossary) {
    const parts = (latin.match(/\p{L}{3,}/gu) ?? []).map(romanKey);
    if (parts.length && !parts.some((p) => keys.has(p))) problems.push(`« ${ja} » doit s'écrire « ${latin} »`);
  }
  // noms propres : ceux du glossaire, ou écrits en lettres latines dans le texte japonais
  const allowed = new Set([...pending.glossary.map(([, la]) => la), pending.original].flatMap((t) => t.match(/\p{L}+/gu) ?? []).map((w) => romanKey(w)));
  const unknown = new Set<string>();
  // « l'Empire », « d'Atami » : le nom après l'article élidé compte aussi
  for (const m of text.matchAll(/(?<!\p{L})\p{Lu}[\p{L}]*(?:['’-]\p{L}+)*/gu)) {
    // « L'Arcadia » : l'article élidé ne compte pas, le nom qui suit si (relecture v9.3)
    const word = m[0].replace(/^(?:l|d|qu|lorsqu|jusqu|puisqu|quoiqu|presqu|c|s|n|j|m|t)['’](?=\p{L})/iu, "");
    if (!/^\p{Lu}/u.test(word)) continue;
    const bare = word.toLowerCase();
    if (FR_STARTERS.has(bare) || FR_WORDS.has(bare)) continue;
    const parts = word.split(/['’-]/u).filter((x) => x.length > 1);
    if (parts.length && parts.every((x) => allowed.has(romanKey(x)) || FR_STARTERS.has(x.toLowerCase()))) continue;
    unknown.add(word);
  }
  if (unknown.size) problems.push(`nom propre absent du texte japonais et du glossaire : ${[...unknown].slice(0, 4).join(", ")} (remplace-le par ce qu'il désigne)`);
  // un nombre en chiffres doit être dans le texte japonais (« 千年 » s'écrit « mille ans »)
  const digits = (text.match(/\d+/g) ?? []).filter((d) => !pending.original.includes(d));
  if (digits.length) problems.push(`nombre absent du texte japonais : ${digits.slice(0, 3).join(", ")}`);
  return problems;
}

/**
 * Traduit en français la description japonaise du site officiel (une relance si la traduction ne convient
 * pas). Une OllamaError remonte (comme pour les notes) ; sinon ne lève pas d'erreur.
 */
export async function translateOfficial(
  cfg: SynopsisConfig,
  chat: ChatFn,
  pending: OfficialPending,
): Promise<{ entry: DossierEntry | null; text: string | null; note: string | null }> {
  const messages: ChatMessage[] = [
    { role: "system", content: TRANSLATE_PROMPT },
    { role: "user", content: translateRequest(pending) },
  ];
  let raw = await chat(cfg, messages, 0.1, TRANSLATE_TOKENS);
  let text = cleanTranslation(raw);
  let problems = translationProblems(text, pending);
  if (problems.length) {
    const again: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: raw.trim() || "(rien)" },
      { role: "user", content: `Cette traduction ne convient pas : ${problems.join(" ; ")}. Traduis de nouveau tout le texte japonais en français, selon les règles.` },
    ];
    raw = await chat(cfg, again, 0.2, TRANSLATE_TOKENS);
    text = cleanTranslation(raw);
    problems = translationProblems(text, pending);
  }
  if (problems.length) return { entry: null, text: text || null, note: `traduction refusée : ${problems.join(" ; ")}` };
  return { entry: { source: OFFICIAL_JA_SOURCE, text: clipText(text, MAX_TRANSLATED_TEXT) }, text, note: null };
}

/**
 * Faits avec la description japonaise du site officiel traduite et placée en tête du dossier (draftItems,
 * essai de correction). Sans description japonaise, les faits tels quels.
 */
export async function withOfficialTranslation(cfg: SynopsisConfig, chat: ChatFn, raw: FactsResult, item: ItemRow): Promise<FactsResult> {
  const pending = raw.officialPending;
  if (!pending) return raw;
  const tr = await translateOfficial(cfg, chat, pending).catch((err: unknown) => {
    if (err instanceof OllamaError) throw err;
    return { entry: null, text: null, note: `traduction : ${errMessage(err)}` };
  });
  const official: OfficialSeen = { url: raw.official?.url ?? null, original: pending.original, ...(tr.text ? { text: tr.text } : {}), note: tr.note };
  const { officialPending: _done, ...rest } = raw;
  if (!tr.entry) return { ...rest, official };
  const fiche = raw.facts ?? { characters: [], prequel: null, series: null, genres: [], tags: [], dossier: [] };
  const presentation = raw.description ?? item.description;
  return { ...rest, official, facts: { ...fiche, dossier: trimDossier([tr.entry, ...fiche.dossier], presentation) } };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "?";
  }
}

/** Suites de 4 mots d'un texte (minuscules, sans accents ni ponctuation). */
function shingles(text: string): Set<string> {
  const w = titleKey(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(" "));
  return out;
}

/** Part (0 à 1) des suites de 4 mots de `text` déjà présentes dans `seen`. */
function overlap(text: string, seen: ReadonlySet<string>): number {
  const own = shingles(text);
  if (own.size === 0) return 0;
  let n = 0;
  for (const x of own) if (seen.has(x)) n++;
  return n / own.size;
}

/**
 * Dossier sans doublon, dans la limite de taille : un texte qui redit, à quelques mots près,
 * le texte de présentation ou une entrée déjà gardée est écarté (le résumé IGDB et les synopsis
 * AniList, Kitsu et AnimeSchedule se recopient souvent). Lire un doublon coûte du temps pour rien.
 */
export function trimDossier(entries: readonly DossierEntry[], description: string | null): DossierEntry[] {
  const own = titleKey(cleanSource(description)).slice(0, 80);
  const seen = shingles(cleanSource(description));
  const out: DossierEntry[] = [];
  let room = MAX_DOSSIER;
  for (const e of entries) {
    const key = titleKey(e.text).slice(0, 80);
    if (own.length >= 40 && (own.startsWith(key.slice(0, 40)) || key.startsWith(own.slice(0, 40)))) continue;
    if (overlap(e.text, seen) >= NEAR_DUPLICATE) continue;
    if (room < MIN_SOURCE) break;
    const text = clipText(e.text, room);
    out.push({ source: e.source, text });
    room -= text.length;
    for (const x of shingles(text)) seen.add(x);
  }
  return out;
}

/** Clé de rapprochement des romanisations : « Yuuji » = « Yuji », « Chousou » = « Choso », « Gojou » = « Gojo ». */
function romanKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ou/g, "o")
    .replace(/([aeiou])\1/g, "$1");
}

/**
 * Noms de la fiche écrits comme dans le texte : AniList romanise « Yuuji Itadori »,
 * le texte et le public français écrivent « Yuji Itadori ».
 */
export function alignNames(facts: ItemFacts | null, source: string): ItemFacts | null {
  if (!facts) return facts;
  const spelled = new Map<string, string>();
  for (const raw of source.match(/[\p{L}][\p{L}'’-]*/gu) ?? []) {
    const w = raw.replace(/['’]s$/u, ""); // « Itadori’s » → « Itadori »
    if (w.length >= 3 && /^\p{Lu}/u.test(w) && !spelled.has(romanKey(w))) spelled.set(romanKey(w), w);
  }
  const fix = (name: string) => name.split(/\s+/).map((part) => (part.length >= 3 ? spelled.get(romanKey(part)) ?? part : part)).join(" ");
  return { ...facts, characters: facts.characters.map((c) => ({ ...c, name: fix(c.name) })) };
}

export interface FactsSources {
  anilist?: (id: number) => Promise<FactsResult>;
  igdb?: (id: number) => Promise<FactsResult>;
  kitsu?: (ids: { mal: number | null; anilist: number | null }) => Promise<WebResult>;
  animeschedule?: (route: string | null) => Promise<WebResult>;
  ann?: (item: ItemRow, sequel: boolean) => Promise<AnnResult>;
  presse?: (item: ItemRow, characters: readonly string[]) => Promise<PresseResult>;
  wikipedia?: (type: ItemType, item: ItemRow, known: string | null) => Promise<WikiResult>;
  steam?: (item: ItemRow, known: number | null, alias?: string | null) => Promise<WebResult>;
  official?: (links: readonly OfficialLink[], ctx: OfficialContext, glossaryFor: (original: string) => Array<readonly [string, string]>) => Promise<OfficialResult>;
}

function present(e: DossierEntry | null): e is DossierEntry {
  return e !== null;
}

/**
 * Se renseigner sur l'item avant de lire. Le tout réuni en un dossier, du plus sûr au moins sûr
 * (le dossier a une taille limite : ce qui vient en dernier est coupé d'abord).
 * - Animés : fiche et description AniList, synopsis Kitsu et AnimeSchedule, fiche Anime News Network
 *   de la saison, articles de presse ; s'ils ne racontent rien et que c'est une suite, la première
 *   saison sur ANN ; enfin le résumé de l'œuvre précédente.
 * - Jeux : Wikipédia, histoire IGDB, page Steam, résumé IGDB.
 * Ne lève jamais d'erreur ; ce qui manque est noté.
 */
export async function gatherFacts(type: ItemType, item: ItemRow, sources: FactsSources = {}): Promise<FactsResult> {
  const anilist = sources.anilist ?? ((id: number) => fetchAniListFacts(id));
  const igdb = sources.igdb ?? ((id: number) => fetchIgdbFacts(id));
  const kitsu = sources.kitsu ?? ((ids: { mal: number | null; anilist: number | null }) => fetchKitsu(ids));
  const animeschedule = sources.animeschedule ?? ((route: string | null) => fetchAnimeScheduleSynopsis(route));
  const ann = sources.ann ?? ((it: ItemRow, sequel: boolean) => fetchAnn(it, ANN_API, ANN_GAP_MS, sequel));
  // la presse se lit en base (presse_articles) : sans pool (tests, fetchFacts), pas de presse
  const presse = sources.presse ?? (async (): Promise<PresseResult> => ({ entries: [], note: null }));
  const wikipedia = sources.wikipedia ?? ((t: ItemType, it: ItemRow, known: string | null) => fetchWikipedia(t, it, known));
  const steam = sources.steam ?? ((it: ItemRow, known: number | null, alias?: string | null) => fetchSteam(it, known, STEAM_STORE, alias ?? null));
  const officialSite = sources.official ?? fetchOfficial;
  const base: FactsResult = item.ext_id
    ? await (type === "anime" ? anilist(item.ext_id) : igdb(item.ext_id))
    : { facts: null, note: type === "anime" ? "pas d'identifiant AniList" : "pas d'identifiant IGDB" };
  // AniList indisponible pour l'instant : l'item sera remis (draftItems), inutile d'interroger les autres sources
  if (base.retryLater) return { facts: null, note: base.note, retryLater: true };
  const fiche = base.facts ?? { characters: [], prequel: null, series: null, genres: [], tags: [], dossier: [] };
  // animés : la description AniList à jour passe avant celle de la base (qui peut venir de Jikan)
  const presentation = type === "anime" && base.description ? base.description : item.description;
  // v9.3 : le site officiel en tête du dossier (Rey, 13 octobre) ; une description japonaise est traduite
  // plus tard, par le modèle (draftItems), puis placée en tête à son tour
  let official: OfficialResult | null = null;
  if (base.officialLinks?.length) {
    const latinTitle = item.title_english?.trim() || item.title;
    const ctx: OfficialContext = {
      titles: [item.title, item.title_english ?? ""].filter((t) => t.trim().length > 0),
      nativeTitle: base.nativeTitle ?? null,
      names: type === "anime" ? fiche.characters.filter((c) => c.main).map((c) => c.name) : [],
    };
    official = await officialSite(base.officialLinks, ctx, (original) => officialGlossary(original, base.nativeNames ?? [], base.nativeTitle ?? null, latinTitle)).catch(
      (err: unknown): OfficialResult => ({ url: null, entry: null, pending: null, note: `site officiel : ${errMessage(err)}` }),
    );
  }
  const found: DossierEntry[] = official?.entry ? [official.entry] : [];
  const notes: Array<string | null | undefined> = [base.note];
  let press: PresseSeen[] | undefined;
  if (type === "anime") {
    const k = await kitsu({ mal: item.mal_id ?? base.malId ?? null, anilist: item.ext_id });
    const a = await animeschedule(item.as_route);
    const n = await ann(item, Boolean(fiche.prequel));
    const p = await presse(item, fiche.cast ?? fiche.characters.map((c) => c.name));
    found.push(...[k.entry, a.entry, n.entry].filter(present), ...p.entries);
    notes.push(k.note, a.note, n.note, p.note);
    if (p.seen?.length) press = p.seen;
    // AniList, Kitsu, AnimeSchedule, la fiche ANN de la saison et la presse ne racontent rien (« The second season
    // of… », essai v8.3 : Tanya II) : la première saison sur ANN donne la prémisse de la série, si c'est
    // bien une suite (AniList lui connaît une œuvre précédente ; pas un spin-off ni un homonyme).
    // Compté après le tri des doublons, comme le fait ensuite makeNotes
    // La presse ne compte pas : un passage sur le staff ou l'attente ferait tomber la prémisse (revue v8.6)
    const titles = [item.title, item.title_english ?? "", fiche.prequel ?? "", fiche.series ?? ""];
    const own = trimDossier(found, presentation).filter((e) => !e.source.startsWith(PRESSE_SOURCE));
    const told = [cleanSource(presentation), ...own.map((e) => e.text)].reduce((sum, t) => sum + storyWords(t, titles), 0);
    if (told < MIN_STORY_WORDS && fiche.prequel && n.premise) found.push(n.premise);
    // le résumé de l'œuvre précédente sert aux suites décrites en une ligne ; sinon, c'est du texte à lire pour rien
    const rich = cleanSource(presentation).length >= RICH_SOURCE;
    found.push(...fiche.dossier.filter((e) => !(rich && e.source.startsWith(PREQUEL_SOURCE))));
  } else {
    const wiki = await wikipedia(type, item, base.wikiTitle ?? null);
    // sans page indiquée par IGDB, Steam est cherché au titre du site, puis à celui de l'article Wikipédia
    // retenu (essai v8.6 : « Resident Evil 9: Requiem » sur le site, « Resident Evil Requiem » sur Steam)
    const page = await steam(item, base.steamId ?? null, wiki.title ?? null);
    // l'histoire IGDB (souvent juste) avant Steam ; le résumé IGDB, souvent le même texte que Steam, en dernier
    const story = fiche.dossier.filter((e) => e.source === "Histoire (IGDB)");
    const rest = fiche.dossier.filter((e) => e.source !== "Histoire (IGDB)");
    found.push(...[wiki.entry].filter(present), ...story, ...[page.entry].filter(present), ...rest);
    notes.push(wiki.note, page.note);
  }
  const dossier = trimDossier(found, presentation);
  const note = notes.filter((x): x is string => Boolean(x)).join(" · ") || null;
  let seen: OfficialSeen | null = null;
  if (official) {
    const dropped = official.entry !== null && !dossier.some((e) => e.source === OFFICIAL_SOURCE);
    seen = {
      url: official.url,
      ...(official.entry ? { text: official.entry.text } : {}),
      note: dropped ? "lu, mais redit le texte de présentation : écarté du dossier" : official.note,
    };
  }
  return {
    facts: base.facts || dossier.length ? { ...fiche, dossier } : null,
    note,
    ...(type === "anime" && base.description ? { description: base.description } : {}),
    ...(press ? { press } : {}),
    ...(seen ? { official: seen } : {}),
    ...(official?.pending ? { officialPending: official.pending } : {}),
  };
}

/** Fiche et dossier de l'item, sans la presse (elle se lit en base). Ne lève jamais d'erreur. */
export const fetchFacts: FactsFn = (type, item) => gatherFacts(type, item);

/** Fiche et dossier de l'item, avec la presse pour les animés (articles lus en base). Ne lève jamais d'erreur. */
export function factsWithPress(pool: SqlPool): FactsFn {
  return (type, item) => gatherFacts(type, item, { presse: (it, characters) => fetchPresse(pool, it, readArticlePage, characters) });
}

function characterLabel(c: Character): string {
  return c.gender ? `${c.name} (${c.gender})` : c.name;
}

/**
 * Fiche telle que le modèle la lit avant le texte ; null si elle est vide. Sans les thèmes AniList :
 * essai v8.3, Re:Zero Break Time (« The fourth season of… ») écrit d'après « Chibi » et « Maids ».
 * Ils restent dans supportText, pour les contrôles.
 */
export function factsBlock(facts: ItemFacts | null): string | null {
  if (!facts) return null;
  const main = facts.characters.filter((c) => c.main);
  const others = facts.characters.filter((c) => !c.main);
  const lines: string[] = [];
  if (main.length) lines.push(`Personnages principaux : ${main.map(characterLabel).join(", ")}`);
  if (others.length) lines.push(`${main.length ? "Personnages secondaires" : "Personnages"} : ${others.map(characterLabel).join(", ")}`);
  if (facts.prequel) lines.push(`Suite de : ${facts.prequel}`);
  if (facts.series) lines.push(`Série : ${facts.series}`);
  if (facts.genres.length) lines.push(`Genres (IGDB) : ${facts.genres.join(", ")}`);
  return lines.length ? `Fiche (données vérifiées) :\n${lines.join("\n")}` : null;
}

/** Dossier tel que le modèle le lit, entre la fiche et le texte de présentation ; null s'il est vide. */
export function dossierBlock(facts: ItemFacts | null): string | null {
  const entries = facts?.dossier ?? [];
  return entries.length ? `Dossier de recherche :\n${entries.map((e) => `[${e.source}] ${e.text}`).join("\n")}` : null;
}

/**
 * Ce qui peut justifier un genre, un ajout ou une date : le texte, le titre, la série, le
 * dossier, et les genres IGDB s'il y en a (plus sûrs que la colonne genre, remplie par d'autres sources).
 */
export function supportText(item: ItemRow, source: string, facts: ItemFacts | null): string {
  const genres = facts?.genres.length ? facts.genres.join(", ") : (item.genre ?? "");
  return [
    source,
    item.title,
    item.title_english ?? "",
    genres,
    ...(facts?.tags ?? []),
    facts?.series ?? "",
    facts?.prequel ?? "",
    ...(facts?.dossier ?? []).map((e) => e.text),
  ].join("\n");
}

/**
 * Personnages de la fiche cités dans un texte : nom complet, ou élément du nom propre à un seul
 * personnage (« Coco » ; pas « Corvin », nom de famille de Maelis comme d'Aldren).
 */
export function charactersIn(characters: readonly Character[], text: string): Character[] {
  const norm = (s: string) => fold(s).replace(/[’`´]/g, "'"); // « D’Artagnan » = « D'Artagnan »
  const t = norm(text);
  const count = new Map<string, number>();
  for (const c of characters) for (const part of new Set(nameForms(c.name).slice(1).map(norm))) count.set(part, (count.get(part) ?? 0) + 1);
  const has = (form: string) => new RegExp(`(?<!\\p{L})${escapeRegExp(norm(form))}(?!\\p{L})`, "u").test(t);
  return characters.filter((c) => has(c.name) || nameForms(c.name).slice(1).some((part) => count.get(norm(part)) === 1 && has(part)));
}

/**
 * Ligne donnée à l'étape de rédaction, pour les accords ; null si aucun genre n'est connu.
 * Avec les notes : seulement les personnages qu'elles citent (essai v7 : Witch Hat, quatre
 * personnages de la fiche ajoutés au synopsis alors que les notes n'en parlaient pas).
 */
export function gendersLine(facts: ItemFacts | null, notes: readonly string[] | null = null): string | null {
  const all = facts?.characters ?? [];
  const known = (notes ? charactersIn(all, notes.join("\n")) : all).filter((c) => c.gender);
  return known.length ? `Genre des personnages : ${known.map((c) => `${c.name} : ${c.gender}`).join(" ; ")}` : null;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
// Les exemples portent sur des œuvres inventées : un exemple tiré du catalogue
// déteint sur la vraie fiche (essai du 8 octobre : Resident Evil Requiem).
// Les consignes ne citent pas les mots à éviter (« plonger », « MMO », « années
// 1980 ») : un petit modèle les reprend (essai v5). Les contrôles s'en chargent.

export const NOTES_PROMPT = `Tu prépares la fiche d'une œuvre (animé ou jeu vidéo) pour GameNime, un site français.

On te donne parfois une fiche de données vérifiées (personnages et leur genre, œuvre précédente, série, genres) et un dossier de recherche (site officiel, synopsis Kitsu et AnimeSchedule, Anime News Network, articles de presse, Wikipédia, page Steam, IGDB, AniList), puis le texte de présentation de l'œuvre, souvent en anglais. Sers-toi de la fiche et du dossier pour savoir qui est qui et ce qui est vrai.

Réponds par « Notes : » suivi des faits à retenir, en français, tirés du texte et du dossier.
- 2 à 5 notes, une par ligne, chacune commençant par « - ».
- Sous chaque note, une ligne « Preuve : » qui recopie mot pour mot, dans sa langue, le passage du texte de présentation, du dossier ou de la fiche qui dit ce fait : 5 à 20 mots d'un seul tenant. Un fait sans passage qui le dit ne donne pas de note.
- Note le sens, pas les mots, sans l'inverser : « her days are numbered » veut dire qu'elle va bientôt mourir ; « his suspended sentence is revoked », que sa peine, suspendue jusque-là, va s'appliquer ; « a war across five kingdoms » a lieu dans cinq royaumes, pas entre eux. Un slogan ne donne pas de note.
- Style télégraphique : 15 mots au plus par note.
- Seulement le point de départ : personnages principaux, cadre, situation initiale, enjeu. Pour un jeu sans histoire : genre, cadre, série, ce que propose le jeu.
- Le texte de présentation décrit cette œuvre précise (cette saison, ce jeu) : il passe en premier. Le dossier le complète avec des faits vrais, et donne le point de départ si le texte n'en dit presque rien.
- L'œuvre précédente (saison ou film d'avant) raconte ce qui s'est passé avant : ne présente jamais son histoire comme celle de cette œuvre, et ne prends jamais une preuve dans son résumé.
- Pour une suite, le dossier décrit souvent le début de la série : garde le cadre et les héros, mais une situation qui a pu changer depuis ne se note que si le texte de présentation la confirme.
- Si deux sources se contredisent, crois le texte de présentation, puis le site officiel, Anime News Network et Wikipédia ; le site officiel traduit du japonais (une traduction automatique) passe après toutes les autres. Le site officiel décrit souvent toute la série : pour une suite, garde son cadre et ses héros, comme pour le dossier. Un passage qui parle d'une autre œuvre (homonyme, autre saison) ne compte pas. Le site officiel et la page Steam sont écrits par l'éditeur : garde leurs faits, pas leurs formules. Un article de presse ou le site officiel traduit du japonais sont en français : garde leurs faits, jamais leurs phrases.
- Du dossier, garde l'histoire et ce que propose le jeu : ni date de sortie, ni plateformes, ni ventes, ni critiques, ni récompenses, ni studios ou éditeurs.
- Rien qui dévoile la suite de l'histoire : ni rebondissement, ni mort, ni fin.
- Chaque note nomme les personnages dont elle parle, jamais de pronom seul : « Maelis rejoint les contrebandiers », pas « elle les rejoint ». Un personnage que le texte ne nomme pas garde sa description (« le frère aîné ») : ne lui donne pas un nom pris dans la fiche.
- Une action dit qui la fait et à qui : « le conseil efface la mémoire des citoyens », pas « mémoire effacée ». Garde qui fait quoi à qui, sans inverser les rôles ni le sens d'une phrase. Les notes ne se contredisent pas.
- Ne relie pas deux faits que le texte ne relie pas (cause, but, moment). Un souvenir reste un souvenir : « Lena remembers her travels with her late master » veut dire que Lena se souvient de ses voyages avec son maître disparu, pas qu'elle voyage avec lui.
- Le genre d'un personnage est celui de la fiche ; sans fiche, celui des pronoms du texte ou du dossier (« he » = il, « she » = elle). Un « witch » masculin est un sorcier.
- Noms propres : orthographe du texte, sans traduction (personnages, lieux, groupes, écoles, événements, techniques).
- Ne cite que les personnages utiles au point de départ.
- Uniquement ce que disent le texte, la fiche et le dossier : ce qui n'y figure pas ne s'écrit pas, même si tu crois le savoir. Ni formule publicitaire. Une phrase dont le sens n'est pas sûr ne donne pas de note.
- Le genre d'un jeu ne s'écrit que s'il figure dans le texte, les genres ou le dossier.
- Une année ou une époque ne se note que si le texte ou le dossier la donne comme cadre de l'histoire, jamais comme date de sortie.

Si ni le texte ni le dossier ne contiennent de fait sur l'œuvre (seulement des slogans), réponds seulement : Notes : - (rien)`;

/** v9.1 : deuxième demande quand les notes sont venues sans aucune preuve. */
export const NOTES_PROOF_RETRY = `Il manque les preuves. Réécris tes notes au même format : sous chaque note, une ligne « Preuve : » qui recopie mot pour mot le passage du texte, du dossier ou de la fiche qui dit ce fait. Retire une note dont aucun passage ne dit le fait.`;

/** Deuxième demande quand le modèle a répondu « (rien) » sur une source assez longue. */
export const NOTES_RETRY = `Relis le texte : il indique sans doute au moins le genre, le cadre, la série ou ce que propose l'œuvre. Relève ces faits en notes, sans rien inventer. Réponds - (rien) seulement s'il n'y a vraiment aucun fait.`;

export const WRITE_PROMPT = `Tu rédiges les synopsis de GameNime, un site français qui annonce les sorties d'animés et de jeux vidéo.

On te donne le titre d'une œuvre, parfois le genre de ses personnages, des notes numérotées et une longueur. Écris en français le synopsis qui présente le point de départ de l'œuvre : une phrase par note, dans l'ordre des notes, en respectant la longueur demandée.

Règles :
- Chaque phrase dit sa note, et seulement elle : rien d'une autre note, aucun personnage d'une autre note. Deux notes ne font jamais une seule phrase, une note ne fait jamais deux phrases.
- La phrase garde le sujet de sa note. Nomme les personnages comme dans la note ; un pronom (il, elle) seulement pour le sujet de la phrase d'avant.
- N'utilise que les informations des notes. N'ajoute aucun détail, aucune péripétie, aucune émotion qui n'y figure pas.
- Ne crée aucun lien entre deux notes (cause, but, moment) qu'aucune note ne donne : deux faits séparés restent séparés.
- Ne cite que les personnages des notes.
- Pour un jeu, ne décris de ce qu'on y fait que ce que disent les notes.
- Garde les noms propres exactement comme dans les notes, et qui fait quoi à qui.
- Accorde chaque personnage selon le genre indiqué : masculin « un sorcier », féminin « une sorcière ».
- Français correct et naturel : accords en genre et en nombre, pas de calque de l'anglais.
- Commence directement par l'œuvre, son cadre ou son héros ; pour un jeu, « Titre est un jeu… » convient.
- Ton neutre et informatif, comme une notice : pas d'impératif, pas de « vous », pas de superlatif, pas de formule de jaquette.
- Ne mentionne ni la date de sortie ni les plateformes ; une année n'apparaît que si les notes la donnent comme cadre de l'histoire.
- Texte brut : ni titre, ni guillemets, ni astérisques.

Réponds uniquement par les phrases, une par ligne, numérotées comme les notes : « 1. … », « 2. … ».`;

export interface Example {
  header: string;
  facts: ItemFacts | null;
  source: string;
  notes: readonly string[];
  proofs: readonly string[]; // v9.1 : pour chaque note, le passage recopié qui la dit
  synopsis: string; // v9.1 : une phrase par note, dans l'ordre
}

/** Une source riche, une moyenne, une suite décrite en une ligne, une pauvre ; avec et sans fiche. */
export const EXAMPLES: readonly Example[] = [
  {
    header: ["Type : animé (série TV)", "Titre : Ashes of Verlune", "Genres : Fantasy, Drama"].join("\n"),
    facts: {
      characters: [
        { name: "Maelis Corvin", gender: "féminin", main: true },
        { name: "Aldren Corvin", gender: "masculin", main: false },
      ],
      prequel: null,
      series: null,
      genres: [],
      tags: [],
      dossier: [],
    },
    source:
      "In the floating city of Verlune, magic is fueled by the memories of those who cast it. Teenage archivist Maelis Corvin discovers that the city's council has been secretly erasing citizens' memories to keep the city afloat. When her own brother forgets her name, she joins a band of smugglers determined to expose the truth. Experience the most breathtaking fantasy of the season!",
    // chaque lien du synopsis (« quand ») est dans une note : la règle « aucun lien qu'aucune note ne donne »
    // ne doit pas être démentie par l'exemple. Ni « son propre frère » (v8.3) : « propre » n'est dans aucune
    // note. v9.1 : une phrase par note (essai v9.0 : en fusionnant les notes, le modèle collait un fait au
    // mauvais personnage) ; chaque note a sa preuve, recopiée de la source
    notes: [
      "cité flottante de Verlune",
      "magie alimentée par les souvenirs de ceux qui la pratiquent",
      "Maelis Corvin, archiviste adolescente, découvre que le conseil efface en secret la mémoire des citoyens",
      "but du conseil : garder Verlune en l'air",
      "quand son frère oublie le nom de Maelis, Maelis rejoint des contrebandiers décidés à révéler la vérité",
    ],
    proofs: [
      "In the floating city of Verlune",
      "magic is fueled by the memories of those who cast it",
      "Teenage archivist Maelis Corvin discovers that the city's council has been secretly erasing citizens' memories",
      "to keep the city afloat",
      "When her own brother forgets her name, she joins a band of smugglers determined to expose the truth",
    ],
    synopsis:
      "Verlune est une cité flottante. Sa magie est alimentée par les souvenirs de ceux qui la pratiquent. L'archiviste adolescente Maelis Corvin découvre que le conseil efface en secret la mémoire des citoyens. Le but du conseil est de garder Verlune en l'air. Quand son frère oublie le nom de Maelis, elle rejoint des contrebandiers décidés à révéler la vérité.",
  },
  {
    header: ["Type : jeu vidéo", "Titre : Hadal Station", "Genres : Survival"].join("\n"),
    facts: {
      characters: [],
      prequel: null,
      series: null,
      genres: [],
      tags: [],
      dossier: [
        {
          source: "Wikipédia : Hadal Station",
          text: "Hadal Station is a 2025 survival video game developed by Deepwell Studio for Windows and PlayStation 5. Set in a research base 9,000 metres below the Pacific Ocean, it follows the maintenance engineer Mara Okafor after an earthquake floods the station. The game sold one million copies in its first month.",
        },
      ],
    },
    source:
      "HADAL STATION. A tense underwater survival game: play as a maintenance engineer stranded in a flooded research base at the bottom of the ocean. Repair systems, manage your oxygen and escape before the station collapses!",
    notes: [
      "jeu de survie sous-marin",
      "le joueur incarne Mara Okafor, ingénieure de maintenance",
      "Mara Okafor est bloquée dans une base de recherche à 9 000 mètres sous le Pacifique",
      "un séisme a inondé la base",
      "Mara Okafor doit réparer les systèmes, gérer son oxygène et fuir avant l'effondrement",
    ],
    proofs: [
      "A tense underwater survival game",
      "it follows the maintenance engineer Mara Okafor",
      "Set in a research base 9,000 metres below the Pacific Ocean",
      "after an earthquake floods the station",
      "Repair systems, manage your oxygen and escape before the station collapses",
    ],
    synopsis:
      "Hadal Station est un jeu de survie sous-marin. Le joueur incarne Mara Okafor, ingénieure de maintenance. Mara Okafor est bloquée dans une base de recherche à 9 000 mètres sous le Pacifique. Un séisme a inondé la base. Mara Okafor doit réparer les systèmes, gérer son oxygène et fuir avant l'effondrement de la station.",
  },
  {
    // essai v7 : la saison 2 de Tanya, décrite en une ligne, racontée avec l'histoire du film d'avant
    header: ["Type : animé (série TV)", "Titre : Lanterns of Ombrevale Season 2", "Genres : Fantasy, Action"].join("\n"),
    facts: {
      characters: [
        { name: "Sorel Vance", gender: "masculin", main: true },
        { name: "Ilya Marr", gender: "féminin", main: false },
      ],
      prequel: "Lanterns of Ombrevale",
      series: null,
      genres: [],
      tags: [],
      dossier: [
        {
          source: "Wikipédia : Lanterns of Ombrevale",
          text: "Lanterns of Ombrevale is a Japanese light novel series. In Ombrevale, a city where night lasts half the year, the young lamplighter Sorel Vance discovers that he can trap shadows inside his lanterns. He is recruited by the Lantern Watch, an order that protects the city from living shadows.",
        },
        {
          source: "Œuvre précédente (AniList) : Lanterns of Ombrevale",
          text: "Sorel joins the Lantern Watch and, with his partner Ilya Marr, unmasks the traitor who opened the city gates to the shadows.",
        },
      ],
    },
    source: "The second season of Lanterns of Ombrevale.",
    notes: [
      "deuxième saison de Lanterns of Ombrevale",
      "cité d'Ombrevale, où la nuit dure la moitié de l'année",
      "Sorel Vance, jeune allumeur de réverbères, enferme les ombres dans ses lanternes",
      "Sorel Vance sert la Lantern Watch, ordre qui protège la cité des ombres vivantes",
    ],
    // aucune preuve dans le résumé de l'œuvre précédente (Ilya Marr, le traître)
    proofs: [
      "The second season of Lanterns of Ombrevale",
      "In Ombrevale, a city where night lasts half the year",
      "the young lamplighter Sorel Vance discovers that he can trap shadows inside his lanterns",
      "He is recruited by the Lantern Watch, an order that protects the city from living shadows",
    ],
    synopsis:
      "Deuxième saison de Lanterns of Ombrevale. Dans la cité d'Ombrevale, la nuit dure la moitié de l'année. Le jeune allumeur de réverbères Sorel Vance enferme les ombres dans ses lanternes. Il sert la Lantern Watch, un ordre qui protège la cité des ombres vivantes.",
  },
  {
    header: ["Type : jeu vidéo", "Titre : Iron Tide 3", "Genres : Strategy"].join("\n"),
    facts: {
      characters: [{ name: "Isolde Kesh", gender: "féminin", main: false }],
      prequel: null,
      series: "Iron Tide",
      genres: ["Strategy", "Warfare", "Single player"],
      tags: [],
      dossier: [
        {
          source: "Wikipédia : Iron Tide 3",
          text: "Iron Tide 3 is an upcoming naval strategy video game by Halvard Games, scheduled for 2027 on Windows. Its campaign takes place in Norvaal, a frozen archipelago contested by three admiralties.",
        },
      ],
    },
    source:
      "The legend returns! Iron Tide 3, the third chapter of the acclaimed naval strategy saga, sets sail for the frozen seas of Norvaal, bigger, bolder and more beautiful than ever.",
    notes: ["troisième épisode de la série de stratégie navale Iron Tide", "cadre : Norvaal, archipel gelé que se disputent trois amirautés"],
    proofs: ["Iron Tide 3, the third chapter of the acclaimed naval strategy saga", "Norvaal, a frozen archipelago contested by three admiralties"],
    synopsis: "Iron Tide 3 est le troisième épisode de la série de stratégie navale Iron Tide. Il se déroule à Norvaal, un archipel gelé que se disputent trois amirautés.",
  },
];

const ANIME_KINDS: Record<string, string> = {
  TV: "série TV",
  TV_SHORT: "série TV à épisodes courts",
  MOVIE: "film",
  ONA: "série diffusée en ligne",
  OVA: "OVA",
  SPECIAL: "épisode spécial",
  MUSIC: "clip musical",
};

export function kindLabel(type: ItemType, kind: string | null): string {
  if (type === "anime") return `animé (${ANIME_KINDS[(kind ?? "").trim().toUpperCase()] ?? "série"})`;
  const k = (kind ?? "").toLowerCase();
  if (k.includes("remake")) return "jeu vidéo (remake)";
  if (k.includes("remaster")) return "jeu vidéo (remaster)";
  if (k.includes("dlc") || k.includes("expansion")) return "jeu vidéo (extension)";
  return "jeu vidéo";
}

export function itemHeader(type: ItemType, item: ItemRow): string {
  const shown = item.title_english?.trim() || item.title;
  const lines = [`Type : ${kindLabel(type, item.kind)}`, `Titre : ${shown}`];
  if (shown !== item.title) lines.push(`Titre original : ${item.title}`);
  // jeux : pas « Massively Multiplayer » (genre RAWG de la colonne genre), pour la même raison que le mode IGDB
  const genre = (item.genre ?? "")
    .split(/\s*,\s*/)
    .filter((g) => g.trim().length > 0 && !(type === "game" && /massively multiplayer/i.test(g)))
    .join(", ")
    .trim();
  if (genre) lines.push(`Genres : ${genre}`);
  return lines.join("\n");
}

function numbered(lines: readonly string[]): string {
  return lines.map((n, i) => `${i + 1}. ${n}`).join("\n");
}

/** Réponse attendue à l'étape 1 : les notes, chacune suivie de sa preuve (v9.1). */
function notesAnswer(notes: readonly string[], proofs: readonly string[]): string {
  return `Notes :\n${notes.map((n, i) => `- ${n}\n  Preuve : ${proofs[i] ?? ""}`).join("\n")}`;
}

/**
 * Longueur demandée selon le nombre de notes (v9.1) : une phrase par note, 100 caractères environ chacune.
 * Avant la v9.1, 2 ou 3 phrases pour 5 notes : le modèle fusionnait les notes et collait un fait au mauvais
 * personnage (essai v9.0 : RE Requiem, Replaced).
 */
export function lengthHint(noteCount: number): string {
  const n = Math.max(1, noteCount);
  return `${n} phrase${n > 1 ? "s" : ""}, une par note, ${Math.min(520, 100 * n + 20)} caractères au plus en tout`;
}

function notesRequest(header: string, facts: ItemFacts | null, source: string): string {
  return [header, factsBlock(facts), dossierBlock(facts), `Texte de présentation :\n${source || "(aucun : appuie-toi sur le dossier)"}`]
    .filter((p) => p !== null)
    .join("\n");
}

/** Étape 1 : partie fixe (consigne + exemples) en tête, pour qu'Ollama la garde en cache d'un item à l'autre. */
export function buildNotesMessages(type: ItemType, item: ItemRow, source: string, facts: ItemFacts | null = null): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: NOTES_PROMPT }];
  for (const ex of EXAMPLES) {
    messages.push({ role: "user", content: notesRequest(ex.header, ex.facts, ex.source) }, { role: "assistant", content: notesAnswer(ex.notes, ex.proofs) });
  }
  messages.push({ role: "user", content: notesRequest(itemHeader(type, item), facts, source) });
  return messages;
}

function writeRequest(header: string, facts: ItemFacts | null, notes: readonly string[]): string {
  return [header, gendersLine(facts, notes), `Notes :\n${numbered(notes)}`, `Longueur : ${lengthHint(notes.length)}`]
    .filter((p) => p !== null)
    .join("\n");
}

/**
 * Motif de refus suivi de ce qu'il faut faire. Pour « plonge », une tournure à
 * prendre plutôt qu'un mot à éviter : essai v5, le modèle reprenait « plonge »
 * au 2e essai quand on lui disait seulement de ne pas l'écrire.
 */
export function retryAdvice(reason: string, type: ItemType, title: string): string {
  if (reason.startsWith("formule publicitaire")) {
    return `${reason} : ${type === "game" ? `commence par « ${title} est un jeu… » ou « Dans ${title}, … »` : "commence par le cadre ou le personnage principal"}`;
  }
  if (reason.startsWith("trop long pour les notes")) return `${reason} : garde seulement ce que disent les notes`;
  if (reason.startsWith("trop long (")) return `${reason} : raccourcis chaque phrase, toujours une phrase par note`;
  if (reason.startsWith("une phrase par note")) return `${reason} : écris une phrase numérotée pour chaque note, dans l'ordre, ni plus ni moins`;
  if (/^phrase \d+ : /.test(reason)) return `${reason} : cette phrase ne dit que sa note`;
  if (reason.startsWith("ajout absent des sources")) return `${reason} : retire-le`;
  if (reason.startsWith("mentionne les plateformes")) return `${reason} : retire-les`;
  if (reason.startsWith("mentionne l'année de sortie")) return `${reason} : retire-la`;
  if (reason.startsWith("s'adresse au lecteur")) return `${reason} : écris à la troisième personne`;
  return reason;
}

/**
 * Étape 2 : le modèle ne voit que les notes (et le genre des personnages), jamais la source.
 * Après un refus, il reçoit son texte et le motif, et le corrige : corriger un point
 * précis réussit mieux à un petit modèle que tout réécrire.
 */
export function buildWriteMessages(
  type: ItemType,
  item: ItemRow,
  notes: string[],
  refused: string[] = [],
  facts: ItemFacts | null = null,
  previous = "",
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: WRITE_PROMPT }];
  for (const ex of EXAMPLES) {
    messages.push({ role: "user", content: writeRequest(ex.header, ex.facts, ex.notes) }, { role: "assistant", content: numbered(splitSentences(ex.synopsis)) });
  }
  let last = writeRequest(itemHeader(type, item), facts, notes);
  if (refused.length) {
    const title = item.title_english?.trim() || item.title;
    const reasons = refused.map((r) => retryAdvice(r, type, title)).join(" ; ");
    last += previous.trim()
      ? `\n\nTa réponse précédente :\n${previous.trim()}\nElle a été refusée : ${reasons}. Corrige ces points sans rien ajouter d'autre et réponds uniquement par les phrases corrigées, une par note, numérotées.`
      : `\n\nTa réponse précédente a été refusée : ${reasons}. Réécris le synopsis en respectant toutes les règles.`;
  }
  messages.push({ role: "user", content: last });
  return messages;
}

// ─── Nettoyage ───────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#")) {
      const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return lookup(NAMED_ENTITIES, code.toLowerCase()) ?? whole;
  });
}

/** Texte ramené à `max` caractères, coupé à une fin de phrase si possible (dossier). */
export function clipText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const end = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((m) => head.lastIndexOf(m)));
  if (end > max / 3) return head.slice(0, end + 1).trim();
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head.slice(0, max - 1)).trim()}…`;
}

function cutAtSentence(s: string, max: number): string {
  const head = s.slice(0, max);
  const end = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((m) => head.lastIndexOf(m)));
  return end > max / 2 ? head.slice(0, end + 1) : head;
}

/**
 * Texte des sources prêt pour le modèle : sans HTML, entités, balises internes ni mentions de source.
 * `whole` : texte complet par nature (page Steam et ses listes sans point final) ; sinon une fin sans
 * ponctuation est prise pour un texte tronqué en base, et coupée à la dernière phrase complète.
 */
export function cleanSource(raw: string | null, whole = false): string {
  if (!raw) return "";
  const s = decodeEntities(decodeEntities(raw)) // deux passes : certains textes sont échappés deux fois
    .replace(/\[(?:FORMAT|STATUS|SEASON|EPISODES|LENGTH|NEXT_EP)[^\]]*\]/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    // titres, paragraphes, listes et tableaux HTML (page Steam) : un retour à la ligne, pas des mots collés (« The StoryFBI »)
    .replace(/<\/?(?:h[1-6]|p|div|li|ul|ol|table|tr|td|th|hr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[(?:written by|source)[^\]]*\]/gi, "")
    .replace(/\((?:source|sources)\s*:[^)]*\)/gi, "")
    .replace(/^\s*(?:source|sources|notes?)\s*:.*$/gim, "")
    // texte d'attente de MyAnimeList (Jikan) ou d'autres bases : rien sur l'œuvre
    .replace(/no synopsis information has been added to this title\.?|help improve our database by adding a synopsis here\.?/gi, "")
    .replace(/\bno (?:synopsis|description) (?:available|yet)\b[^.!?\n]*[.!?]?/gi, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    // une balise de bloc au milieu d'une phrase (« who<div>discovers ») : la phrase reste d'un seul tenant
    .replace(/(?<![.!?…:;»"”)\]])\n(?=\p{Ll})/gu, " ")
    .trim();
  if (s.length > MAX_SOURCE) return cutAtSentence(s, MAX_SOURCE);
  // texte coupé en plein mot (description tronquée en base) : on garde les phrases complètes
  return whole || /[.!?…»"”')\]]$/.test(s) ? s : cutAtSentence(s, s.length);
}

/** Réponse du modèle débarrassée de l'emballage (mise en forme, « Synopsis : », guillemets englobants). */
export function cleanOutput(raw: string): string {
  const paragraphs = raw.trim().split(/\n\s*\n/);
  // « **Titre** » ou « Synopsis » seul en tête, suivi du texte : on retire cette ligne
  if (paragraphs.length > 1 && paragraphs[0]!.length < 80 && !/[.!?…]\s*$/.test(paragraphs[0]!)) paragraphs.shift();
  let s = paragraphs
    .join("\n\n")
    .replace(/(\*{1,3}|_{1,3})(?=\S)([^*_\n]*?\S)\1/g, "$2") // *italique*, **gras**, _souligné_
    .replace(/\*+/g, "")
    .replace(/^\s*voici\s+(?:le|mon|un)\s+(?:synopsis|texte|résumé)\b[^:\n]{0,40}:\s*/i, "") // « Voici le synopsis corrigé : »
    .replace(/^\s*(?:synopsis|résumé)(?:\s+corrigé)?(?:\s+(?:de|du|des|d['’])\s*[^:\n]{1,80})?\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^["«“]/.test(s) && /["»”]$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}

// Fautes fréquentes du modèle, corrigées sans demander de nouvel essai (un essai coûte environ une minute).
// Calques de l'anglais « grandson », « granddaughter » (essai v8.3 : Nioh 3, « grand-fils de Tokugawa Ieyasu »)
const CALQUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<!\p{L})grand-fils(?!\p{L})/giu, "petit-fils"],
  [/(?<!\p{L})grands-fils(?!\p{L})/giu, "petits-fils"],
  [/(?<!\p{L})grande?-fille(?!\p{L})/giu, "petite-fille"],
  [/(?<!\p{L})grand(?:e?s)?-filles(?!\p{L})/giu, "petites-filles"],
];
// « Quatrième saison de Classroom of the Elite suit les élèves… » (essai v8.3) : il manque l'article.
// Restent tels quels « Deuxième saison de X. » (phrase sans verbe, comme dans l'exemple) et
// « Deuxième saison de X, la série suit… » (apposition correcte) : la recherche du verbe s'arrête
// à la première ponctuation
const SEASON_START =
  /^(Deuxième|Troisième|Quatrième|Cinquième|Sixième|Septième|Huitième|Neuvième|Dixième|Seconde|Nouvelle|Dernière)(\s+(?:saison|partie)\s+(?:de|du|des|d['’])\s*[^.!?,;:]*?\s)(suit|raconte|retrace|met|voit|présente|plonge|retrouve|reprend|poursuit|continue|accompagne|ramène|entraîne|propose|explore|confronte|introduit|marque|conduit|emmène|montre|dévoile|révèle|approfondit|développe|adapte|couvre|débute|commence|mène|s['’]ouvre|s['’]intéresse|se\s+concentre|se\s+déroule|se\s+penche)\b/u;

// Tournures fautives de l'essai v8.6, corrigées seulement là où le sens ne peut pas changer
// Pas de règle pour « un États-Unis » (Replaced) : l'accord dépend du reste de la phrase (adjectifs,
// verbe, « qu'un »), une correction mécanique écrivait « presques », « qu'des », « ses » (revue v8.7).
// Le tiret compte comme une lettre : « remplace le vide-ordures » reste tel quel.
const TURNS: ReadonlyArray<readonly [RegExp, (...m: string[]) => string]> = [
  // « jeu d'action-aventure en troisième personne » (Pragmata, Bendy) : « à la troisième personne »
  [/(?<![\p{L}-])([Ee])n (première|troisième) personne(?![\p{L}-])/gu, (_m, e, rank) => `${e === "E" ? "À" : "à"} la ${rank} personne`],
  // « jeune agent MI6 » (007 First Light) : « agent du MI6 »
  [/(?<![\p{L}-])(agents?|agentes?|espions?|espionnes?|recrues?) (MI[56])(?![\p{L}\p{N}-])/gu, (_m, who, org) => `${who} du ${org}`],
  // « des hommes ambitieux remplacent le vide » (Path of Exile 2) : un vide se comble
  [/(?<![\p{L}-])([Rr])empla(ce|cent|çait|çaient|cer|cé|çant) le vide(?![\p{L}-])/gu, (_m, r, end) => `${r === "R" ? "C" : "c"}ombl${end.slice(1)} le vide`],
  // « un examen spécial appaire les élèves » (Classroom) : « appairer » se dit d'appareils ; des personnes, on les apparie
  [/(?<![\p{L}-])([Aa])ppair(e|es|ent|er|é|ée|és|ées|ait|aient|ant)(?![\p{L}-])/gu, (_m, a, end) => `${a}ppari${end}`],
];

// « la classe de Ayanokouji » (essai de correction v8.9, Classroom) : « de » et « que » s'élident devant un
// nom qui commence par une voyelle (« d'Ayanokouji », « qu'Ichika »). Seulement devant une majuscule suivie
// d'une minuscule : « de A à Z », « de EA », « de huit », « de onze » restent tels quels. « One », « Once »
// se disent « wan » (« de One Piece », « de Once Human »). Pas après un mot à majuscule en milieu de
// phrase : « Ines de Alcantara » est un nom à particule. « lorsque Ayanokouji » reste (« que » isolé seulement)
const ELISION =
  /(?<![\p{L}\p{N}'’-])(?<![\p{L}\p{N}] \p{Lu}[\p{L}'’-]* )([Dd]e|[Qq]ue) (?!On(?:e|ce)(?![\p{L}]))(?=[AEIOUÀÂÄÆÉÈÊËÎÏÔÖŒÙÛÜĀĒĪŌŪ]\p{Ll})/gu;

/**
 * Synopsis corrigé des fautes connues du modèle (calques, tournures fautives, élision, article manquant en tête).
 * `context` : le texte dont on reprend l'apostrophe (une phrase corrigée prend celle du synopsis entier).
 */
export function polishText(text: string, context = text): string {
  let s = text;
  for (const [pattern, by] of CALQUES) s = s.replace(pattern, (found) => (/^\p{Lu}/u.test(found) ? by.charAt(0).toUpperCase() + by.slice(1) : by));
  for (const [pattern, by] of TURNS) s = s.replace(pattern, by);
  // apostrophe du texte : typographique s'il en a déjà une, droite sinon
  const apostrophe = (context.match(/’/g) ?? []).length > (context.match(/'/g) ?? []).length ? "’" : "'";
  s = s.replace(ELISION, (_m, word: string) => `${word.slice(0, -1)}${apostrophe}`);
  return s.replace(SEASON_START, (_all, ordinal: string, middle: string, verb: string) => `La ${ordinal.toLowerCase()}${middle}${verb}`);
}

export interface NotesAnswer {
  sense: string[]; // « Sens : » écrit quand même par le modèle (affichage seulement)
  notes: string[];
  proofs: Array<string | null>; // v9.1 : la preuve recopiée sous chaque note, null si elle manque
}

// v9.1 : « Preuve : … », « - Preuve (Synopsis (Kitsu)) : … », « → Preuve : … », « (Preuve : …) », « **Passage :** … »
// sous une note : le passage qui la dit. « - Preuve de courage : … » ou « faire ses preuves : » n'en sont pas (relecture v9.1)
const NOTE_PROOF = /^\s*[^\p{L}\p{N}]*(?:\d+[.)]\s*)?[*_]*(?:preuve|passage)s?(?:\s*[([](?:[^()[\]\n]|\([^()\n]*\)){0,160}[)\]])?\s*[*_]*\s*:\s*[*_]*\s*(.*)$/iu;
// sur la ligne de la note : « - note (Preuve : « … ») », « - note — Preuve : … ». « faire ses preuves : » n'en est pas une
const INLINE_PROOF = /\s*[(\[—–|]*\s*[*_]*preuve\s*(?:\([^)\n]{0,60}\)|\[[^\]\n]{0,80}\])?\s*[*_]*\s*:\s*/i;

/** Preuve telle que recopiée, sans guillemets englobants ni mise en forme. */
function cleanProof(raw: string): string {
  let p = raw.replace(/[*_]+/g, "").trim();
  // parenthèse ou crochet fermant d'une preuve écrite sur la ligne de la note : « (Preuve : « … ») »
  if (/[)\]]$/.test(p) && !/[([]/.test(p)) p = p.slice(0, -1).trim();
  if (/^[«"“‘']/.test(p) && /[»"”’']$/.test(p)) p = p.slice(1, -1).trim();
  return p.replace(BRACKET_PREFIX, "").replace(/^[«"“]\s*/, "").replace(/\s*[»"”]$/, "").trim();
}

// « Notes : », « **Notes :** », « Notes (en français) : » ; le deux-points est exigé
const NOTES_HEADER = /^\s*[#*_\s]*notes?\b[^:\n]{0,30}:\s*[*_]*\s*$/i;
const SENSE_HEADER = /^\s*[#*_\s]*sens\b[^:\n]{0,30}:\s*[*_]*\s*$/i;
// « --- » entre le sens et les notes (essai v7) : une ligne de séparation, pas une note
const SEPARATOR = /^[\s\-–—_*=~.]+$/;

/** Ligne manifestement anglaise (au moins deux mots outils anglais, aucun français). */
function looksEnglishLine(line: string): boolean {
  let fr = 0;
  let en = 0;
  for (const w of line.toLowerCase().match(/[\p{L}'’]+/gu) ?? []) {
    if (/^(?:l|d|qu|n|s|j|c|m|t)['’]\p{L}/u.test(w) || FR_WORDS.has(w)) fr++;
    else if (EN_WORDS.has(w)) en++;
  }
  return en >= 2 && fr === 0;
}

function bulletLines(lines: readonly string[], max: number): string[] {
  return lines
    .filter((l) => !SEPARATOR.test(l))
    .map((l) => cleanOutput(l).replace(/^(?:[-•–]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0 && !SENSE_HEADER.test(l))
    .slice(0, max)
    .map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
}

/**
 * Réponse de l'étape 1 : « Notes : » ; un « Sens : » écrit quand même avant (habitude des
 * versions précédentes) est mis de côté. Sans titre « Notes », on garde les lignes qui ne sont pas en anglais.
 */
export function parseNotesAnswer(raw: string): NotesAnswer {
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => NOTES_HEADER.test(l));
  if (at === -1) {
    // une preuve est souvent en anglais : gardée, elle
    const kept = lines.filter((l) => NOTE_PROOF.test(l) || (!SENSE_HEADER.test(l) && !looksEnglishLine(l)));
    return { sense: [], ...parseNotesWithProofs(kept.join("\n")) };
  }
  return { sense: bulletLines(lines.slice(0, at), MAX_SENSE), ...parseNotesWithProofs(lines.slice(at + 1).join("\n")) };
}

/**
 * Notes de l'étape 1, chacune avec sa preuve (v9.1) : la ligne « Preuve : » qui suit une note, ou la preuve
 * écrite sur la ligne de la note. Puces retirées ; aucune note si le modèle juge la source trop pauvre.
 */
export function parseNotesWithProofs(raw: string): { notes: string[]; proofs: Array<string | null> } {
  const items: Array<{ note: string; proof: string | null }> = [];
  let waiting: { note: string; proof: string | null } | null = null; // « Preuve : » vide : le passage est sur la ligne suivante
  for (const line of raw.split("\n")) {
    if (SEPARATOR.test(line) || line.trim().length === 0) continue;
    const own = NOTE_PROOF.exec(line);
    if (own) {
      const last = items[items.length - 1];
      const proof = cleanProof(own[1] ?? "");
      if (last && last.proof === null) {
        if (proof) last.proof = proof;
        else waiting = last;
      }
      continue;
    }
    if (waiting && !/^\s*(?:[-•–*]|\d+[.)])\s/.test(line)) {
      waiting.proof = cleanProof(line) || null;
      waiting = null;
      continue;
    }
    waiting = null;
    let text = line;
    let proof: string | null = null;
    const inline = INLINE_PROOF.exec(text);
    if (inline && inline.index > 0) {
      proof = cleanProof(text.slice(inline.index + inline[0].length)) || null;
      text = text.slice(0, inline.index);
    }
    const note = cleanOutput(text).replace(/^(?:[-•–]|\d+[.)])\s*/, "").trim();
    if (note.length === 0 || /^notes?\s*:?$/i.test(note)) continue;
    items.push({ note, proof });
  }
  if (items.length === 0 || items.some((x) => /^\(rien\)|^rien\.?$/i.test(x.note))) return { notes: [], proofs: [] };
  const kept = items
    .flatMap((x) => (x.note.length > NOTE_MAX ? x.note.split(/(?<=[.;])\s+/).map((note) => ({ note, proof: x.proof })) : [x])) // paragraphe au lieu de notes
    .filter((x) => x.note.length > 0)
    .slice(0, MAX_NOTES)
    .map((x) => (x.note.length > NOTE_MAX ? { ...x, note: cutNote(x.note) } : x));
  return { notes: kept.map((x) => x.note), proofs: kept.map((x) => x.proof) };
}

/**
 * Note trop longue coupée à NOTE_MAX caractères, sur une virgule ou un point-virgule s'il y en a un assez
 * loin, sinon entre deux mots (essai v9.2 : Nioh 3, « pour emp… » coupé au milieu d'un mot à 160).
 */
export function cutNote(note: string): string {
  if (note.length <= NOTE_MAX) return note;
  const head = note.slice(0, NOTE_MAX + 1);
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(" : "));
  if (clause >= NOTE_MAX / 2) return head.slice(0, clause).trim();
  const space = head.lastIndexOf(" ");
  return (space > NOTE_MAX / 2 ? head.slice(0, space) : head.slice(0, NOTE_MAX)).replace(/[\s,;:–-]+$/u, "").trim();
}

/** Notes de l'étape 1 seules, sans leurs preuves. */
export function parseNotes(raw: string): string[] {
  return parseNotesWithProofs(raw).notes;
}

// ─── Contrôles ───────────────────────────────────────────────────────────────

const FR_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "est", "dans", "pour", "qui", "que",
  "sur", "au", "aux", "son", "sa", "ses", "elle", "il", "avec", "par", "ne", "pas", "se", "leur",
  "alors", "mais", "où", "ce", "cette", "ces", "lui", "après", "entre", "y",
]);
const EN_WORDS = new Set([
  "the", "and", "is", "of", "to", "in", "with", "his", "her", "she", "he", "that", "for", "are",
  "was", "their", "who", "when", "from", "this", "by", "after", "into",
]);

export function looksFrench(text: string): boolean {
  const tokens = text.toLowerCase().match(/[\p{L}'’]+/gu) ?? [];
  let fr = 0;
  let en = 0;
  for (const w of tokens) {
    if (/^(?:l|d|qu|n|s|j|c|m|t)['’]\p{L}/u.test(w) || FR_WORDS.has(w)) fr++;
    else if (EN_WORDS.has(w)) en++;
  }
  return fr >= 3 && fr >= 3 * en;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(s: string, remove: string[]): string[] {
  // « l’académie » et « l'académie », « é » composé ou non : les mêmes mots (revue v8.6 : copie manquée)
  const same = (x: string) => x.normalize("NFC").toLowerCase().replace(/[’‘`´]/g, "'");
  let t = same(s);
  for (const r of remove) {
    // le titre écrit comme le texte : « Frieren: Beyond Journey’s End » retiré de « … Journey's End… » (revue v8.6)
    const k = same(r.trim());
    if (k.length >= 3) t = t.replace(new RegExp(escapeRegExp(k), "g"), " ");
  }
  return t.match(/[\p{L}\p{N}'’]+/gu) ?? [];
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Mots français ordinaires qui prennent une majuscule : jamais signalés comme noms absents. */
const COMMON_CAPITALIZED = new Set(
  [
    "État", "États", "États-Unis", "Amérique", "Europe", "Asie", "Afrique", "Japon", "Chine", "Corée",
    "France", "Angleterre", "Ouest", "Est", "Nord", "Sud", "Terre", "Lune", "Soleil", "Ciel", "Enfer",
    "Paradis", "Dieu", "Empire", "Royaume", "République", "Église", "Académie", "Université", "Lycée",
    "Collège", "École", "Moyen-Âge", "Antiquité",
  ].map(fold),
);

/**
 * Lieux dont le nom français ne commence pas comme le nom anglais des sources : le rapprochement
 * sur 3 lettres les signalait à tort (essai v8.3 : 007 First Light, « Islande » pour « Iceland »).
 */
const PLACE_NAMES: Readonly<Record<string, readonly string[]>> = {
  islande: ["iceland"],
  allemagne: ["germany", "german"],
  espagne: ["spain", "spanish"],
  ecosse: ["scotland", "scottish"],
  irlande: ["ireland", "irish"],
  suede: ["sweden", "swedish"],
  suisse: ["switzerland", "swiss"],
  "pays-bas": ["netherlands", "dutch", "holland"],
  hongrie: ["hungary", "hungarian"],
  autriche: ["austria", "austrian"],
  danemark: ["denmark", "danish"],
  roumanie: ["romania", "romanian"],
  lettonie: ["latvia", "latvian"],
  tchequie: ["czech"],
  chypre: ["cyprus"],
  groenland: ["greenland"],
  maroc: ["morocco", "moroccan"],
  liban: ["lebanon", "lebanese"],
  "royaume-uni": ["united kingdom", "britain", "british"],
  "grande-bretagne": ["britain", "british"],
  "nouvelle-zelande": ["new zealand"],
  "nouvelle-orleans": ["new orleans"],
  pekin: ["beijing", "peking"],
  varsovie: ["warsaw"],
  bale: ["basel"],
};

/**
 * Noms propres du texte (majuscule hors début de phrase) introuvables dans les données :
 * signe possible d'invention ou de nom traduit. Rapprochement souple sur les 3 premières
 * lettres (« Japon » retrouve « Japan »), donc c'est une alerte, pas un refus.
 */
export function namesAbsent(text: string, reference: string): string[] {
  const ref = fold(reference);
  const known = new Set((ref.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.slice(0, 3)));
  const missing = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?…:])\s+/)) {
    const tokens = sentence.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
    for (const raw of tokens.slice(1)) {
      const name = raw.replace(/^(?:l|d|qu|n|s|j|c|m|t)['’]/iu, "");
      if (name.length < 3 || !/^\p{Lu}/u.test(name) || COMMON_CAPITALIZED.has(fold(name))) continue;
      if (known.has(fold(name).slice(0, 3)) || (lookup(PLACE_NAMES, fold(name)) ?? []).some((en) => ref.includes(en))) continue;
      missing.add(name);
    }
  }
  return [...missing];
}

/** Première suite de `k` mots que le texte partage avec la source (titres exclus), ou null. */
export function sharedRun(text: string, source: string, titles: string[], k = COPY_RUN): string | null {
  const src = words(source, titles);
  const grams = new Set<string>();
  for (let i = 0; i + k <= src.length; i++) grams.add(src.slice(i, i + k).join(" "));
  const out = words(text, titles);
  for (let i = 0; i + k <= out.length; i++) {
    const g = out.slice(i, i + k).join(" ");
    if (grams.has(g)) return g;
  }
  return null;
}

/** Nombres écrits en toutes lettres dans les sources anglaises : « six thousand » couvre « 6 000 ». */
const NUMBER_WORDS: Record<string, string[]> = {
  one: ["1"], two: ["2"], three: ["3"], four: ["4"], five: ["5"], six: ["6"], seven: ["7"], eight: ["8"], nine: ["9"],
  ten: ["10"], eleven: ["11"], twelve: ["12"], thirteen: ["13"], fourteen: ["14"], fifteen: ["15"], sixteen: ["16"],
  seventeen: ["17"], eighteen: ["18"], nineteen: ["19"], twenty: ["20"], thirty: ["30"], forty: ["40"], fifty: ["50"],
  sixty: ["60"], seventy: ["70"], eighty: ["80"], ninety: ["90"], hundred: ["100"], thousand: ["1000", "000"],
  million: ["1000000", "000"], billion: ["1000000000", "000"], first: ["1"], second: ["2"], third: ["3"],
  fourth: ["4"], fifth: ["5"], sixth: ["6"], seventh: ["7"], eighth: ["8"], ninth: ["9"], tenth: ["10"],
};

/** Nombres écrits dans le texte mais absents des données fournies (risque d'invention). */
export function numbersAbsent(text: string, reference: string): string[] {
  const known = new Set(reference.match(/\d+/g) ?? []);
  for (const w of reference.toLowerCase().match(/[a-z]+/g) ?? []) for (const n of lookup(NUMBER_WORDS, w) ?? []) known.add(n);
  for (const m of reference.matchAll(/\b(\d)0['’]?s\b/g)) known.add(`19${m[1]}0`).add(`20${m[1]}0`); // « the 80s » → 1980
  return [...new Set(text.match(/\d+/g) ?? [])].filter((n) => !known.has(n));
}

// Noms de personne dont la forme dit le genre (« une sorcière »), et noms épicènes
// dont seul l'article le dit (« la mage »). Les noms toujours féminins ou toujours
// masculins (« une recrue », « une star », « un témoin ») ne disent rien : ignorés.
const FEMININE_NOUNS = new Set([
  "sorcière", "guerrière", "magicienne", "étudiante", "lycéenne", "collégienne", "héroïne", "princesse", "reine",
  "apprentie", "chasseuse", "voleuse", "aventurière", "combattante", "amie", "sœur", "fille", "mère", "tante",
  "femme", "maîtresse", "déesse", "espionne", "héritière", "orpheline", "compagne", "rivale", "coéquipière", "élue",
  "chevalière", "servante", "gardienne", "prêtresse", "prisonnière", "survivante", "fiancée", "épouse", "cousine",
  "voisine", "patronne", "directrice", "actrice", "chanteuse", "danseuse", "infirmière", "policière", "cheffe",
]);
const MASCULINE_NOUNS = new Set([
  "sorcier", "guerrier", "magicien", "étudiant", "lycéen", "collégien", "héros", "prince", "roi", "apprenti",
  "chasseur", "voleur", "aventurier", "combattant", "ami", "frère", "fils", "père", "oncle", "garçon", "homme",
  "maître", "dieu", "espion", "héritier", "orphelin", "compagnon", "rival", "coéquipier", "élu", "chevalier",
  "serviteur", "gardien", "prêtre", "prisonnier", "survivant", "fiancé", "époux", "cousin", "voisin", "patron",
  "directeur", "acteur", "chanteur", "danseur", "infirmier", "policier",
]);
// pas « jeune » ni « adulte » : souvent adjectifs (« une jeune recrue » pour un homme est correct)
const EPICENE_NOUNS = new Set([
  "mage", "élève", "pilote", "archiviste", "détective", "ninja", "vampire", "androïde", "partenaire", "scientifique",
  "artiste", "camarade", "collègue", "exorciste", "capitaine", "guide", "enfant", "secrétaire", "libraire", "chimiste",
  "mercenaire", "pirate", "otaku",
]);
const FEMININE_ARTICLES = new Set(["une", "la"]);
const MASCULINE_ARTICLES = new Set(["un", "le"]);
const NAME_STOPWORDS = new Set(["le", "la", "les", "de", "du", "des", "von", "van", "the", "of"]);
// « la sœur de Qifrey » : le groupe nominal ne désigne pas Qifrey
const LINK_WORDS = new Set(["de", "du", "des", "à", "au", "aux", "et", "ou", "avec", "pour", "par", "chez", "contre", "sans"]);

/** Formes sous lesquelles un personnage peut apparaître : nom complet, puis chaque élément du nom. */
function nameForms(name: string): string[] {
  const parts = name.split(/\s+/).filter((p) => p.length >= 3 && !NAME_STOPWORDS.has(p.toLowerCase()));
  return [...new Set([name, ...parts])];
}

function impliedGender(article: string | undefined, nouns: Array<string | undefined>): Gender | null {
  for (const raw of nouns) {
    const n = (raw ?? "").toLowerCase();
    if (FEMININE_NOUNS.has(n)) return "féminin";
    if (MASCULINE_NOUNS.has(n)) return "masculin";
  }
  const a = (article ?? "").toLowerCase();
  if (nouns.some((n) => EPICENE_NOUNS.has((n ?? "").toLowerCase()))) {
    if (FEMININE_ARTICLES.has(a)) return "féminin";
    if (MASCULINE_ARTICLES.has(a)) return "masculin";
  }
  return null;
}

/** Extrait cité dans le motif de refus, coupé avant le complément (« Itadori, une élève » de Jujutsu High). */
function excerpt(s: string): string {
  const parts = s.split(/\s+/);
  const cut = parts.findIndex((w, i) => i >= 2 && (LINK_WORDS.has(w.toLowerCase()) || /^(?:qui|que|d['’])/iu.test(w)));
  return (cut === -1 ? parts : parts.slice(0, cut)).join(" ");
}

/**
 * Désaccords de genre avec la fiche, dans les tournures où le genre se lit sans ambiguïté :
 * « Qifrey, une sorcière » ou « la sorcière Qifrey » quand la fiche dit Qifrey masculin.
 */
export function genderMismatches(text: string, characters: readonly Character[]): string[] {
  const found = new Map<string, string>();
  for (const c of characters) {
    if (c.gender !== "masculin" && c.gender !== "féminin") continue;
    for (const form of nameForms(c.name)) {
      const n = escapeRegExp(form);
      const after = new RegExp(`(?<!\\p{L})(${n}),\\s+(?:(un|une|le|la)\\s+)?([\\p{L}-]+)(?:\\s+([\\p{L}-]+))?(?:\\s+([\\p{L}-]+))?`, "gu");
      const before = new RegExp(`(?<!\\p{L})(un|une|le|la)\\s+(?:([\\p{L}-]+)\\s+)?([\\p{L}-]+)\\s+(${n})(?!\\p{L})`, "giu");
      for (const m of text.matchAll(after)) {
        // « Frieren, le guerrier Stark » : énumération, le groupe désigne Stark
        // (« Itadori, une élève de Jujutsu High » reste contrôlé : le nom suit « de »)
        const isName = (w: string | undefined) => w !== undefined && /^\p{Lu}/u.test(w);
        if (isName(m[3]) || isName(m[4]) || (isName(m[5]) && !LINK_WORDS.has((m[4] ?? "").toLowerCase()))) continue;
        const g = impliedGender(m[2], [m[3], m[4]]);
        if (g && g !== c.gender) found.set(c.name, `${c.name} est ${c.gender} (« ${excerpt(m[0])} »)`);
      }
      for (const m of text.matchAll(before)) {
        if ([m[2], m[3]].some((w) => LINK_WORDS.has((w ?? "").toLowerCase()))) continue;
        const g = impliedGender(m[1], [m[3], m[2]]);
        if (g && g !== c.gender) found.set(c.name, `${c.name} est ${c.gender} (« ${excerpt(m[0])} »)`);
      }
    }
  }
  return [...found.values()];
}

const SOURCE_MARKERS = /written by|\bsource\s*:|\brewrite\b|https?:\/\/|[[\]<>]/i;
const META_START = /^(?:voici|bien sûr|en tant que|ce synopsis)/i;
const ADDRESS = /\b(?:vous|votre|vos|plongez|découvrez|vivez|explorez|incarnez|embarquez|rejoignez|affrontez|préparez)\b/i;
const PROMO =
  /incontournable|chef[- ]d['’](?:œ|oe)uvre|époustouflant|à couper le souffle|à ne pas manquer|inoubliable|captivant|palpitant|révolutionnaire|phénoménal|épique|immersi(?:f|ve|on)|haletant|effréné|spectaculaire|grandiose|sans précédent|plus que jamais|ultime/i;
// « Pragmata plonge dans… », « plonge le joueur dans… » : formule de jaquette, refusée. Essai v8.3 :
// « 007 First Light plonge James Bond, 26 ans…, dans une mission » passait. « Plonge » suivi d'un
// déterminant ou d'un nom propre, puis « dans » à 12 mots au plus ; pas « le pays plonge en pleine
// guerre, et Lena se cache dans la forêt » (sensible à la casse, pour le nom propre)
// « Kunimatsu plonge dans les ténèbres » (essai v9.1 : Nioh 3, échec) : un personnage qui sombre, pas une formule
const PLUNGE_STATES =
  "ténèbres|folie|démence|désespoir|chaos|obscurité|coma|sommeil|oubli|guerre|violence|haine|vengeance|mort|silence|deuil|corruption|crise|terreur|abîmes?|noirceur|anarchie|misère";
const PLUNGE = new RegExp(
  "\\b[Pp]longe(?:nt)?\\s+(?:(?:le|la|les|l['’])\\s*(?:joueurs?|joueuses?|spectateurs?|public|participants?|lecteurs?)\\b|" +
    `(?:dans|au cœur)\\b(?!\\s+(?:(?:les?|la|une?|des|sa|son|ses|l['’])\\s*)?(?:${PLUNGE_STATES})\\b)|` +
    "(?:(?:le|la|les|un|une|des|du|son|sa|ses|leur|leurs|ce|cet|cette|ces)\\s+|l['’]|(?=\\p{Lu}))(?:[^\\s.!?;:]+\\s+){0,11}?(?:dans|au cœur)\\b)",
  "u",
);
// Wikipédia les cite en tête d'article ; la fiche du site les affiche déjà
const PLATFORMS = /\b(?:PlayStation|PS[345]|Xbox|Nintendo Switch|Switch 2|Steam Deck|Windows)\b/;
const BUSINESS = /\bexemplaires\b|\bventes\b|\bvendus? à\b|\bcritiques? (?:positives?|élogieuses?|favorables?|dithyrambiques?)\b|\brécompens|\bnominé/i;

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
// « set in October 2026 », « takes place in the year 2026 », « set in the 1920s »
const SETTING_DATE = new RegExp(
  `\\b(?:set|takes? place|taking place|unfolds)\\s+(?:in|during|around)\\s+(?:the\\s+(?:year\\s+)?)?(?:(?:early|late|mid)[- ]?\\s*)?(?:(?:${MONTHS})\\s+)?(\\d{4})(s)?\\b`,
  "gi",
);

/** Années et décennies que les sources donnent comme cadre de l'histoire. */
export function settingDates(sources: string): { years: Set<number>; decades: Set<number> } {
  const years = new Set<number>();
  const decades = new Set<number>();
  for (const m of sources.matchAll(SETTING_DATE)) {
    const n = Number(m[1]);
    if (m[2]) decades.add(n);
    else {
      years.add(n);
      decades.add(Math.floor(n / 10) * 10);
    }
  }
  return { years, decades };
}

/**
 * Année de sortie écrite dans un texte, ou sa décennie, quand les sources ne la donnent
 * pas comme cadre de l'histoire. Essais v4 et v5 : « A new era of survival horror begins
 * in 2026 » (la sortie) ; mais Wikipédia : RE Requiem est « set in October 2026 » (le
 * cadre), et là, 2026 est vrai. Renvoie ce qui est écrit (« 2026 », « années 2020 »), ou null.
 * « années 20 » n'est pas vérifié : en français, ce sont d'abord les années 1920.
 */
export function releaseDateMention(text: string, year: number | null, sources = ""): string | null {
  if (year === null) return null;
  const setting = settingDates(sources);
  if (new RegExp(`(?<!années\\s)\\b${year}\\b`).test(text)) return setting.years.has(year) ? null : String(year);
  const decade = Math.floor(year / 10) * 10;
  const written = new RegExp(`\\bannées\\s+${decade}\\b|\\b${decade}['’]?s\\b`, "i");
  const inSources = new RegExp(`\\b(?:${decade}|${String(decade).slice(2)})['’]?s\\b|\\bannées\\s+${decade}\\b`, "i"); // « 1980s », « 80s », « the 80's »
  return written.test(text) && !inSources.test(sources) && !setting.decades.has(decade) ? `années ${decade}` : null;
}

interface Claim {
  pattern: RegExp; // dans le synopsis ou une note
  support: RegExp; // dans le texte, le titre, la série ou les genres
}

/**
 * Ajouts fréquents du modèle, permis seulement si le texte ou les données les portent.
 * Essais v4 et v5 : « MMORPG » (Path of Exile 2), « course automobile » et « pilotes »
 * (Steel Ball Run), « courses » et « missions » (GTA VI, 007 First Light), « survivre »
 * dans un « environnement hostile » (Pragmata), « morts-vivants » (RE Requiem).
 */
const CLAIMS: readonly Claim[] = [
  // genres de jeu
  { pattern: /\bmmo(?:rpg)?s?\b|massivement multijoueurs?/i, support: /\bmmo|massively|massivement/i },
  { pattern: /\b[aj]?rpgs?\b|\bjeux? de rôles?\b/i, support: /\b[aj]?rpg|role[- ]?playing|jeux? de rôles?/i },
  { pattern: /rogue[- ]?(?:like|lite)s?/i, support: /rogue[- ]?(?:like|lite)/i },
  { pattern: /battle[- ]royales?/i, support: /battle[- ]royale/i },
  { pattern: /monde ouvert|open[- ]world/i, support: /open[- ]world|monde ouvert|sandbox/i },
  { pattern: /\bfps\b|tir à la première personne/i, support: /\bfps\b|first[- ]person|shooter/i },
  { pattern: /metroidvanias?/i, support: /metroidvania/i },
  { pattern: /souls[- ]?like/i, support: /souls/i },
  { pattern: /survival[- ]horror/i, support: /survival[- ]horror|horror|horreur/i },
  // ajouts de contenu
  { pattern: /\bmissions?\b/i, support: /mission|quest|assignment|contract|heist|operation|\bjobs?\b/i },
  { pattern: /\bcourses?\b/i, support: /\brac(?:e|es|er|ers|ing)\b|\brun(?:s|ning|ners?)?\b|marathon|relay|derby|grand prix|rally/i },
  { pattern: /\bautomobiles?\b|\bvoitures?\b|\bbolides?\b/i, support: /\bcars?\b|automobile|motor|\bdriv(?:e|er|ers|ing)\b|supercar|racecar|\bkart/i },
  { pattern: /\bpilotes?\b/i, support: /\bpilot|\bdrivers?\b|\bmecha/i },
  { pattern: /\bsurvi(?:e|es|vre|vent|t|vant|vants|vante|vantes)\b/i, support: /surviv|\balive\b|\bescap/i }, // fuir un danger, c'est survivre
  { pattern: /morts?-vivants?|\bzombies?\b/i, support: /zombie|undead|living dead|walking dead|ghoul/i },
  { pattern: /\bexplor(?:e|es|ent|er|ation|ations|ant)\b/i, support: /explor|journey|travel|venture|roam|wander|discover|adventure|expedition/i },
  { pattern: /multijoueurs?|\bco-?op\b|coopérati(?:f|ve|on)\b/i, support: /multiplayer|multi-player|co-?op|cooperative|online|pvp|massively/i },
  // essai v8.3 : Classroom of the Elite, « hidden foe » ne justifiait pas « intentions hostiles »
  { pattern: /\bhostiles?\b/i, support: /hostile|danger|deadly|perilous|harsh|unforgiving|treacherous|\bfoes?\b|\benem(?:y|ies)\b|threat|\bvillains?\b|antagonist/i },
  { pattern: /\bambiances?\b|\batmosphères?\b/i, support: /atmospher|ambien|mood|\bvibes?\b/i },
  { pattern: /\btribunes?\b|\bgradins?\b/i, support: /\bstands\b|grandstand|bleacher|spectator|audience/i },
];

/** Texte sans les titres de l'œuvre (« Classroom of the Elite » : ni anglais, ni course, ni copie). */
function withoutTitles(text: string, titles: readonly string[]): string {
  let t = text;
  for (const title of titles) if (title.trim().length >= 3) t = t.replace(new RegExp(escapeRegExp(title.trim()), "gi"), " ");
  return t;
}

/**
 * Ajouts du texte que rien ne justifie dans `support` (texte source et données), tels
 * qu'écrits. Les titres sont mis de côté (« Crash Course » n'est pas une course).
 */
export function unsupportedClaims(text: string, support: string, titles: readonly string[] = []): string[] {
  const t = withoutTitles(text, titles);
  const out: string[] = [];
  for (const c of CLAIMS) {
    const m = c.pattern.exec(t);
    if (m && !c.support.test(support)) out.push(m[0]);
  }
  return out;
}

/** Pourquoi une note est retirée avant la rédaction, ou null si elle est gardée. */
export function noteProblem(
  note: string,
  ctx: { releaseYear: number | null; support: string; titles: readonly string[] },
): string | null {
  const date = releaseDateMention(note, ctx.releaseYear, ctx.support);
  if (date) return `année de sortie : ${date}`;
  const added = unsupportedClaims(note, ctx.support, ctx.titles);
  return added.length ? `absent des sources : ${added.join(", ")}` : null;
}

export interface CheckContext {
  source: string; // texte source nettoyé
  data: string; // titres, genres, noms de la fiche : noms et chiffres légitimes
  titles: string[]; // exclus du contrôle de copie
  notes: readonly string[];
  characters: readonly Character[]; // fiche : genre à respecter
  releaseYear?: number | null; // année de sortie : jamais dans le synopsis
  support?: string; // ce qui justifie un genre ou un ajout ; défaut : source + data
}

export interface Verdict {
  errors: string[]; // refus : nouvel essai, puis échec
  warnings: string[]; // accepté, mais à relire
}

export function checkSynopsis(text: string, ctx: CheckContext): Verdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = [...text].length;
  if (n === 0) return { errors: ["réponse vide"], warnings };
  if (n < HARD_MIN) errors.push(`trop court (${n} car.)`);
  if (n > HARD_MAX) errors.push(`trop long (${n} car.)`);
  const noted = [...ctx.notes.join(" ")].length;
  // au-delà, le modèle remplit avec des détails qui ne sont pas dans les notes (essai v4 : GTA VI)
  if (noted > 0 && n <= HARD_MAX && n > 1.6 * noted + 40) errors.push(`trop long pour les notes (${n} car. pour ${noted} car. de notes)`);
  // titre anglais mis de côté : « La quatrième saison de Kana of the Sky suit Kana… » est du français
  if (!looksFrench(withoutTitles(text, ctx.titles))) errors.push("pas en français");
  if (SOURCE_MARKERS.test(text)) errors.push("mention de source ou balise");
  if (!/[.!?…»)]$/.test(text)) errors.push("phrase coupée");
  if (META_START.test(text)) errors.push("formule de présentation");
  const address = ADDRESS.exec(text);
  if (address) errors.push(`s'adresse au lecteur (« ${address[0]} »)`);
  const plunge = PLUNGE.exec(text);
  if (plunge) errors.push(`formule publicitaire (« ${plunge[0]} »)`);
  const support = ctx.support ?? `${ctx.source}\n${ctx.data}`;
  const date = releaseDateMention(text, ctx.releaseYear ?? null, support);
  if (date) errors.push(`mentionne l'année de sortie (${date})`);
  const platform = PLATFORMS.exec(text);
  if (platform) errors.push(`mentionne les plateformes (« ${platform[0]} »)`);
  for (const added of unsupportedClaims(text, support, ctx.titles)) {
    errors.push(`ajout absent des sources (« ${added} »)`);
  }
  // copie : du texte de présentation comme du dossier (un texte déjà en français, par exemple)
  const copied = sharedRun(text, support, ctx.titles);
  if (copied) errors.push(`reprend la source mot pour mot (« ${copied} »)`);
  for (const g of genderMismatches(text, ctx.characters)) errors.push(`genre : ${g}`);

  if (n > SOFT_MAX && n <= HARD_MAX) warnings.push(`longueur ${n} car.`);
  if (PROMO.test(text)) warnings.push("ton promotionnel");
  if (BUSINESS.test(text)) warnings.push("ventes, critiques ou récompenses");
  if (/(?<!années\s)\b(?:19|20)\d{2}\b/.test(text)) warnings.push("mentionne une année"); // « années 1980 » : un cadre, pas une date
  const reference = `${ctx.source} ${ctx.data}`;
  const numbers = numbersAbsent(text, reference);
  if (numbers.length) warnings.push(`chiffre absent des données : ${numbers.join(", ")}`);
  const names = namesAbsent(text, reference);
  if (names.length) warnings.push(`nom absent des données : ${names.join(", ")}`);
  return { errors, warnings };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

/** Panne d'Ollama (injoignable, modèle absent…) : le passage s'arrête, les items restent intacts. */
export class OllamaError extends Error {}

export interface TokenUsage {
  calls: number;
  input: number; // jetons du prompt, selon Ollama
  output: number; // jetons générés
  inputMs: number; // temps de lecture du prompt (court si Ollama réutilise son cache)
  outputMs: number; // temps de génération
}

const usage: TokenUsage = { calls: 0, input: 0, output: 0, inputMs: 0, outputMs: 0 };

/** Appels, jetons et durées depuis le démarrage du processus (mesure de la vitesse). */
export function tokenUsage(): TokenUsage {
  return { ...usage };
}

const OllamaChatResponse = z.object({
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(), // nanosecondes
  eval_duration: z.number().optional(),
});
type OllamaChatResponse = z.infer<typeof OllamaChatResponse>;

/** POST JSON par node:http (sans la limite de 300 s de fetch) ; `timeoutMs` : silence permis avant d'abandonner. */
function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(u, { method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`pas de réponse en ${Math.round(timeoutMs / 60_000)} min`)));
    req.on("error", reject);
    req.end(data);
  });
}

async function postChat(cfg: SynopsisConfig, messages: ChatMessage[], options: Record<string, number>): Promise<OllamaChatResponse> {
  const body = { model: cfg.model, messages, stream: false, keep_alive: "5m", options };
  const res = await postJson(`${cfg.ollamaUrl}/api/chat`, body, OLLAMA_TIMEOUT_MS).catch((err: unknown) => {
    throw new OllamaError(`Ollama injoignable : ${errMessage(err)}`);
  });
  if (res.status < 200 || res.status >= 300) throw new OllamaError(`Ollama HTTP ${res.status} : ${clip(res.text, 200)}`);
  let json: unknown = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    // réponse coupée ou autre chose que du JSON
  }
  const parsed = OllamaChatResponse.safeParse(json);
  if (!parsed.success) throw new OllamaError("réponse d'Ollama illisible");
  return parsed.data;
}

/** Mêmes réglages à chaque appel (num_ctx compris) : Ollama garde le modèle chargé et peut réutiliser son cache. */
function chatOptions(cfg: SynopsisConfig, temperature: number, maxTokens: number): Record<string, number> {
  return { temperature, top_p: 0.9, num_ctx: NUM_CTX, num_predict: maxTokens, num_thread: cfg.threads };
}

export const ollamaChat: ChatFn = async (cfg, messages, temperature, maxTokens = WRITE_TOKENS) => {
  const r = await postChat(cfg, messages, chatOptions(cfg, temperature, maxTokens));
  usage.calls++;
  usage.input += r.prompt_eval_count ?? 0;
  usage.output += r.eval_count ?? 0;
  usage.inputMs += (r.prompt_eval_duration ?? 0) / 1e6;
  usage.outputMs += (r.eval_duration ?? 0) / 1e6;
  return r.message.content;
};

export interface ProbeResult {
  tokens: number; // jetons du prompt annoncés par Ollama
  ms: number; // temps de lecture du prompt
}

/**
 * Sonde du cache : le même prompt envoyé deux fois de suite (une réponse d'un jeton).
 * Si Ollama réutilise son cache, le 2e envoi se lit presque instantanément.
 */
export async function probeCache(cfg: SynopsisConfig, messages: ChatMessage[]): Promise<[ProbeResult, ProbeResult]> {
  const once = async (): Promise<ProbeResult> => {
    const r = await postChat(cfg, messages, chatOptions(cfg, 0, 1));
    return { tokens: r.prompt_eval_count ?? 0, ms: (r.prompt_eval_duration ?? 0) / 1e6 };
  };
  const first = await once();
  return [first, await once()];
}

// ─── Base de données ─────────────────────────────────────────────────────────

const ItemRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  title: z.string(),
  title_english: z.string().nullable(),
  kind: z.string().nullable(),
  genre: z.string().nullable(),
  description: z.string().nullable(),
  pop_rank: z.coerce.number().int().nullable(),
  // anilist_id (animés) ou igdb_id (jeux) ; 0 ou vide = inconnu
  ext_id: z.preprocess((v) => (v === null || v === undefined || !(Number(v) > 0) ? null : Number(v)), z.number().int().nullable()),
  // animés : identifiant MyAnimeList (pour Kitsu) et route AnimeSchedule ; jeux : null
  mal_id: z.preprocess((v) => (v === null || v === undefined || !(Number(v) > 0) ? null : Number(v)), z.number().int().nullable()).default(null),
  as_route: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : null), z.string().nullable()).default(null),
  release_year: z.preprocess((v) => (v === null || v === undefined || !(Number(v) > 0) ? null : Number(v)), z.number().int().nullable()),
});
export type ItemRow = z.infer<typeof ItemRowSchema>;

export interface Job {
  type: ItemType;
  item: ItemRow;
}

/** mysql2 renvoie [lignes, champs] ; le connecteur mariadb renvoie directement les lignes. */
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

/** Items avec pop_rank = rang de popularité dans la fenêtre de 2 ans (NULL hors fenêtre). À compléter par WHERE / ORDER BY. */
function rankedSql(type: ItemType): string {
  const { table, kind, ext, mal, route } = TABLES[type];
  return `
    SELECT id, title, title_english, kind, genre, description, pop_rank, ext_id, mal_id, as_route, release_year
    FROM (
      SELECT id, title, title_english, ${kind} AS kind, genre, description, ${ext} AS ext_id,
             ${mal} AS mal_id, ${route} AS as_route,
             YEAR(release_date) AS release_year, popularity, in_window,
             synopsis_fr, synopsis_status, synopsis_note, synopsis_generated_at,
             CASE WHEN in_window = 1
                  THEN RANK() OVER (PARTITION BY in_window ORDER BY popularity DESC) END AS pop_rank
      FROM (
        SELECT t.*,
               (t.release_date >= MAKEDATE(YEAR(CURDATE()), 1)
                AND t.release_date < MAKEDATE(YEAR(CURDATE()) + 2, 1)) AS in_window
        FROM ${table} t
      ) w
    ) r`;
}

/**
 * Items sans synopsis : fenêtre de 2 ans d'abord, puis par popularité. Un échec est retenté 7 jours plus
 * tard ; une fiche indisponible (AniList en panne ou qui refuse), une heure plus tard, à sa place de
 * popularité (un animé du top retenté après tous les autres attendrait des nuits pendant le remplissage).
 * Deux fiches toujours en échec en tête de file ne coûtent qu'une pause d'AniList (draftItems, 10 min).
 */
async function fetchCandidates(pool: SqlPool, type: ItemType, limit: number): Promise<ItemRow[]> {
  const sql = `${rankedSql(type)}
    WHERE synopsis_fr IS NULL
      AND (synopsis_status IS NULL
           OR (synopsis_status IN ('failed', 'no_source')
               AND synopsis_generated_at < NOW() - INTERVAL ${RETRY_DAYS} DAY)
           OR (synopsis_status = 'failed' AND synopsis_note LIKE '${FACTS_DOWN}%'
               AND synopsis_generated_at < NOW() - INTERVAL ${FACTS_RETRY_MINUTES} MINUTE))
    ORDER BY in_window DESC, popularity DESC, id
    LIMIT ${Math.max(1, Math.floor(limit))}`;
  return ItemRowSchema.array().parse(rowsOf(await pool.query(sql)));
}

export function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x !== undefined) out.push(x);
    if (y !== undefined) out.push(y);
  }
  return out;
}

/** File d'un passage : animés et jeux en alternance, `limit` items au plus. */
export async function fetchQueue(pool: SqlPool, limit: number): Promise<Job[]> {
  const anime = (await fetchCandidates(pool, "anime", limit)).map((item): Job => ({ type: "anime", item }));
  const game = (await fetchCandidates(pool, "game", limit)).map((item): Job => ({ type: "game", item }));
  return interleave(anime, game).slice(0, limit);
}

/** Items précis, dans l'ordre demandé (essai à blanc). Les ids introuvables sont ignorés. */
export async function fetchItemsByIds(pool: SqlPool, type: ItemType, ids: number[]): Promise<ItemRow[]> {
  if (ids.length === 0) return [];
  const rows = ItemRowSchema.array().parse(
    rowsOf(await pool.query(`${rankedSql(type)} WHERE id IN (${ids.map(() => "?").join(", ")})`, ids)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Essai à blanc : items de la fenêtre de 2 ans tirés au hasard parmi ceux qui
 * attendent un synopsis, hors top `skipTop` (relu à la main de toute façon) :
 * un aperçu de ce qui serait publié sans relecture.
 */
export async function fetchSample(pool: SqlPool, limit: number, skipTop: number): Promise<Job[]> {
  const n = Math.max(1, Math.floor(limit));
  const pick = async (type: ItemType): Promise<ItemRow[]> =>
    ItemRowSchema.array().parse(
      rowsOf(
        await pool.query(`${rankedSql(type)}
          WHERE synopsis_fr IS NULL AND in_window = 1 AND pop_rank > ${Math.max(0, Math.floor(skipTop))}
          ORDER BY RAND()
          LIMIT ${n}`),
      ),
    );
  const anime = (await pick("anime")).map((item): Job => ({ type: "anime", item }));
  const game = (await pick("game")).map((item): Job => ({ type: "game", item }));
  return interleave(anime, game).slice(0, n);
}

// ─── v9.5 : versions enregistrées, pour le bloc Synopsis du dashboard ─────────
// Décision A de Rey (13 octobre) : rien ne s'affiche sans sa validation. Le bloc lui montre chaque synopsis
// avec ce qui l'a produit : les sources lues, les notes et leurs preuves, le contrôle phrase par phrase.
// Chaque rédaction et chaque correction devient une ligne de `synopsis_versions` ; l'item pointe sur la
// sienne (`synopsis_version_id`). Rey touche les phrases de la version (`sentences`), jamais un texte
// redécoupé : la correction reçoit exactement ces phrases.

/** Version du module, affichée dans le bloc (« Cron coupé · v9.5 · … ») et gardée avec chaque version. */
export const SYNOPSIS_CODE = "v9.5";

/** Ce que le bloc montre d'une version, rangé en JSON dans `synopsis_versions.data`. */
export interface VersionData {
  sentences: string[]; // le synopsis, phrase par phrase (vide sans texte)
  rows: SentenceRow[]; // une ligne par phrase ; vide si le contrôle n'a pas eu lieu (checkNote dit pourquoi)
  checkNote: string | null;
  notes: Array<{ note: string; label: string | null; passage: string | null; exact: boolean }>;
  dropped: string[]; // notes retirées, avec la raison
  sources: Array<{ label: string; text: string }>; // présentation et dossier, tels que le modèle les a lus
  official: { original: string | null; text: string | null; note: string | null } | null; // site officiel (sans l'adresse : pas de lien)
  press: PresseSeen[];
  factsNote: string | null;
  request?: { from: number; flagged: number[]; marked: Record<string, number[]> }; // correction demandée par Rey
}

/** Demande de correction posée par le bloc (colonne `synopsis_correction`). */
export interface CorrectionRequest {
  version: number; // la version que Rey a lue
  flagged: number[]; // indices dans `sentences`
  marked: Record<string, number[]>; // mots faux touchés, positions dans sentenceWords
  at: string;
}

/** En-tête d'une écriture : le connecteur mariadb le renvoie seul, mysql2 dans [en-tête, champs]. */
function headerOf(result: unknown): { insertId?: unknown; affectedRows?: unknown } {
  const h = Array.isArray(result) ? result[0] : result;
  return h && typeof h === "object" ? (h as { insertId?: unknown; affectedRows?: unknown }) : {};
}
const insertIdOf = (result: unknown): number => Number(headerOf(result).insertId ?? 0);
export const affectedOf = (result: unknown): number => Number(headerOf(result).affectedRows ?? 0);

export function versionDataFromDraft(d: Draft): VersionData {
  const reference = [d.source, ...(d.facts?.dossier ?? []).map((e) => e.text)].join("\n");
  const text = d.outcome.text ?? "";
  const sentences = d.check && d.check.sentences.length ? d.check.sentences : text ? splitSentences(text, reference) : [];
  return {
    sentences,
    rows: d.check && d.check.rows.length === sentences.length ? d.check.rows : [],
    checkNote: d.check ? d.check.note : text ? "pas de contrôle" : null,
    notes: d.notes.map((note, i) => {
      const p = d.proofs?.[i];
      return { note, label: p?.label ?? null, passage: p?.passage ?? null, exact: p?.exact ?? false };
    }),
    dropped: d.dropped,
    sources: [{ label: "Présentation", text: d.source }, ...(d.facts?.dossier ?? []).map((e) => ({ label: e.source, text: e.text }))].filter(
      (x) => x.text.trim().length > 0,
    ),
    official: d.official ? { original: d.official.original ?? null, text: d.official.text ?? null, note: d.official.note } : null,
    press: d.press ?? [],
    factsNote: d.factsNote,
  };
}

const countRows = (rows: readonly SentenceRow[], v: SentenceRow["verdict"], asked = false): number =>
  new Set(rows.filter((r) => r.verdict === v && (r.asked ?? false) === asked)).size; // une ligne partagée par deux phrases compte une fois

async function insertVersion(
  pool: SqlPool,
  type: ItemType,
  id: number,
  v: { origin: "redaction" | "correction"; status: string; text: string | null; note: string | null; model: string | null; data: VersionData; ms: number | null },
): Promise<number> {
  const doubts = countRows(v.data.rows, "à vérifier") + countRows(v.data.rows, "à vérifier", true);
  const fixes = countRows(v.data.rows, "corrigée") + countRows(v.data.rows, "corrigée", true);
  const res = await pool.query(
    `INSERT INTO synopsis_versions (item_type, item_id, num, origin, status, text, note, model, code, data, doubts, fixes, ms)
     SELECT ?, ?, COALESCE(MAX(num), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM synopsis_versions WHERE item_type = ? AND item_id = ?`,
    [type, id, v.origin, v.status, v.text, v.note, v.model, SYNOPSIS_CODE, JSON.stringify(v.data), doubts, fixes, v.ms === null ? null : Math.round(v.ms), type, id],
  );
  return insertIdOf(res);
}

/**
 * Enregistre un item traité : sa version (sauf un échec, retenté plus tard : la note de l'item suffit),
 * puis l'item. N'écrit que si la ligne est toujours vide (une saisie faite entre-temps est préservée) ;
 * sinon la version est effacée.
 */
async function saveDraft(pool: SqlPool, d: Draft, model: string): Promise<void> {
  const outcome = d.outcome;
  if (outcome.status === "postponed") return; // pas un statut de la base : l'item reste à traiter
  const usedModel = outcome.status === "no_source" ? null : model;
  const versionId =
    outcome.status === "failed"
      ? null
      : await insertVersion(pool, d.type, d.item.id, {
          origin: "redaction",
          status: outcome.status,
          text: outcome.text,
          note: outcome.note,
          model: usedModel,
          data: versionDataFromDraft(d),
          ms: d.ms,
        });
  const res = await pool.query(
    `UPDATE ${TABLES[d.type].table}
        SET synopsis_fr = ?, synopsis_status = ?, synopsis_note = ?, synopsis_model = ?,
            synopsis_generated_at = NOW(), synopsis_version_id = COALESCE(?, synopsis_version_id), updated_at = updated_at
      WHERE id = ? AND synopsis_fr IS NULL`,
    [outcome.text, outcome.status, outcome.note, usedModel, versionId, d.item.id],
  );
  if (versionId !== null && affectedOf(res) === 0) await pool.query(`DELETE FROM synopsis_versions WHERE id = ?`, [versionId]);
}

const CorrectionRequestSchema = z.object({
  version: z.coerce.number().int().positive(),
  flagged: z.array(z.number().int().min(0)).min(1),
  marked: z.record(z.array(z.number().int().min(0))).default({}),
  at: z.string().default(""),
});

const VersionRowSchema = z.object({ id: z.coerce.number(), num: z.coerce.number(), status: z.string(), text: z.string().nullable(), data: z.string() });

/** Une demande de correction en attente, avec la version lue par Rey. */
interface PendingCorrection {
  type: ItemType;
  item: ItemRow;
  versionId: number | null; // version actuelle de l'item
  request: CorrectionRequest | null; // null : demande illisible
  version: { id: number; num: number; data: VersionData } | null;
}

/** Il reste des corrections demandées (le remplissage s'interrompt alors entre deux paquets). */
export async function pendingCorrections(pool: SqlPool): Promise<number> {
  let n = 0;
  for (const type of ["anime", "game"] as const) {
    const [row] = rowsOf(await pool.query(`SELECT COUNT(*) AS n FROM ${TABLES[type].table} WHERE synopsis_status = 'correction'`)) as Array<{ n: unknown }>;
    n += Number(row?.n ?? 0);
  }
  return n;
}

async function fetchPendingCorrections(pool: SqlPool, limit: number): Promise<PendingCorrection[]> {
  const out: PendingCorrection[] = [];
  const Row = z.object({ id: z.coerce.number(), synopsis_correction: z.string().nullable(), synopsis_version_id: z.coerce.number().nullable() });
  for (const type of ["anime", "game"] as const) {
    const rows = Row.array().parse(
      rowsOf(
        await pool.query(
          `SELECT id, synopsis_correction, synopsis_version_id FROM ${TABLES[type].table}
            WHERE synopsis_status = 'correction' ORDER BY popularity DESC, id LIMIT ${Math.max(1, Math.floor(limit))}`,
        ),
      ),
    );
    const items = await fetchItemsByIds(pool, type, rows.map((r) => r.id));
    for (const r of rows) {
      const item = items.find((x) => x.id === r.id);
      if (!item) continue;
      let request: CorrectionRequest | null = null;
      try {
        request = CorrectionRequestSchema.parse(JSON.parse(r.synopsis_correction ?? "null"));
      } catch {
        request = null;
      }
      let version: PendingCorrection["version"] = null;
      if (request) {
        const [v] = VersionRowSchema.array().parse(
          rowsOf(await pool.query(`SELECT id, num, status, text, data FROM synopsis_versions WHERE id = ? AND item_type = ? AND item_id = ?`, [request.version, type, r.id])),
        );
        if (v) version = { id: v.id, num: v.num, data: JSON.parse(v.data) as VersionData };
      }
      out.push({ type, item, versionId: r.synopsis_version_id, request, version });
    }
  }
  return out;
}

/** Demande impossible à suivre (illisible, version changée, phrase hors du texte) : l'item revient à relire, avec la raison. */
async function dropRequest(pool: SqlPool, type: ItemType, id: number, why: string): Promise<void> {
  await pool.query(
    `UPDATE ${TABLES[type].table} t
        SET t.synopsis_status = COALESCE((SELECT v.status FROM synopsis_versions v WHERE v.id = t.synopsis_version_id AND v.status IN ('auto', 'to_review')), 'to_review'),
            t.synopsis_note = ?, t.synopsis_correction = NULL, t.updated_at = t.updated_at
      WHERE t.id = ? AND t.synopsis_status = 'correction'`,
    [clip(why, 255), id],
  );
}

export interface CorrectionReport {
  corrected: number;
  failed: number;
  dropped: number; // demandes ignorées : illisibles, sur une version dépassée, phrase hors du texte
  cancelled: number; // v9.5 : demandes annulées par Rey pendant leur correction (rien n'est gardé)
}

/**
 * Corrections demandées par Rey dans le bloc : seules les phrases signalées sont réécrites, d'après les
 * sources relues (correctSentences, v8.8 ; mots faux touchés, v8.9) ; les autres ne changent pas d'une
 * lettre et gardent leur ligne de contrôle. Chaque phrase réécrite est contrôlée contre sa preuve
 * (v9.4) ; NON : « à vérifier ». Le résultat est une nouvelle version, à relire. Une correction en échec
 * rend la version d'avant, à relire, avec la raison. Une OllamaError remonte (passage arrêté, demande gardée).
 */
export async function runCorrections(
  deps: SynopsisDeps,
  cfg: SynopsisConfig,
  chat: ChatFn,
  getFacts: FactsFn,
  keepGoing: () => boolean = () => true,
): Promise<CorrectionReport> {
  const report: CorrectionReport = { corrected: 0, failed: 0, dropped: 0, cancelled: 0 };
  for (const p of await fetchPendingCorrections(deps.pool, cfg.maxPerRun)) {
    if (!keepGoing()) break;
    const { type, item } = p;
    const table = TABLES[type].table;
    const req = p.request;
    const ver = p.version;
    const why = !req
      ? "demande de correction illisible"
      : !ver || ver.id !== p.versionId
        ? "demande de correction ignorée : le synopsis a changé depuis"
        : req.flagged.some((i) => i >= ver.data.sentences.length)
          ? "demande de correction ignorée : phrase hors du synopsis"
          : null;
    if (why || !req || !ver) {
      report.dropped++;
      await dropRequest(deps.pool, type, item.id, why ?? "demande de correction ignorée");
      deps.log.warn({ module: "synopsis", type, id: item.id }, `synopsis : ${why}`);
      continue;
    }
    const sentences = ver.data.sentences;
    const marked: Record<number, number[]> = {};
    for (const [k, v] of Object.entries(req.marked)) {
      const i = Number(k);
      const count = sentenceWords(sentences[i] ?? "").length;
      if (req.flagged.includes(i) && v.length && v.every((x) => x < count)) marked[i] = v;
    }
    const t0 = Date.now();
    const f = await factsFor({ type, item }, getFacts, { cfg, chat });
    const sources = [{ label: "Présentation", text: cleanSource(f.item.description) }, ...(f.facts?.dossier ?? []).map((e) => ({ label: e.source, text: e.text }))];
    const reference = sources.map((x) => x.text).join("\n");
    const out = await correctSentences(cfg, type, f.item, sentences, req.flagged, chat, f.facts, marked).catch((err: unknown): CorrectionOutcome => {
      if (err instanceof OllamaError) throw err;
      return { status: "failed", sentences: [...sentences], text: sentences.join(" "), corrected: [], removed: 0, fixes: [], warnings: [], note: errMessage(err), attempts: [] };
    });
    if (out.status !== "corrected") {
      report.failed++;
      await dropRequest(deps.pool, type, item.id, `correction en échec : ${out.note ?? "?"} ; le synopsis d'avant est gardé`);
      deps.log.warn({ module: "synopsis", type, id: item.id, note: out.note }, "synopsis : correction en échec");
      continue;
    }
    // la nouvelle version : phrases gardées telles quelles (avec leur ligne), phrases réécrites contrôlées contre leur preuve
    const kept: string[] = [];
    const rows: SentenceRow[] = [];
    const fullRows = ver.data.rows.length === sentences.length;
    const notes: string[] = [];
    for (const [i, sentence] of sentences.entries()) {
      if (!req.flagged.includes(i)) {
        kept.push(sentence);
        rows.push(fullRows ? ver.data.rows[i]! : { verdict: "non contrôlée", label: "", passage: "", why: "" });
        continue;
      }
      const fix = out.fixes.find((x) => x.index === i);
      if (!fix || fix.text === null) {
        notes.push(`phrase ${i + 1} supprimée`);
        continue;
      }
      let row: SentenceRow;
      if (fix.found && fix.found.label !== "aucune") {
        const passage = expandPassage(fix.found, sources);
        const again = await checkSentence(cfg, chat, fix.text, passage);
        row = { verdict: again.verdict === "NON" ? "à vérifier" : "corrigée", label: fix.found.label, passage, why: again.verdict === "NON" ? again.why : "", before: sentence, asked: true };
        notes.push(again.verdict === "NON" ? `phrase ${i + 1} réécrite, à vérifier (${clip(again.why || "NON", 60)})` : `phrase ${i + 1} réécrite`);
      } else {
        row = { verdict: "à vérifier", label: "?", passage: fix.proof, why: "preuve introuvable dans les sources", before: sentence, asked: true };
        notes.push(`phrase ${i + 1} réécrite, preuve introuvable`);
      }
      const parts = splitSentences(fix.text, reference);
      for (const part of parts.length ? parts : [fix.text]) {
        kept.push(part);
        rows.push(row);
      }
    }
    const text = kept.join(" ").trim();
    const note = clip(`correction demandée : ${notes.join(" ; ")}${out.warnings.length ? ` · ${out.warnings[0]}` : ""}`, 255);
    const data: VersionData = {
      ...ver.data,
      sentences: kept,
      rows,
      checkNote: fullRows ? ver.data.checkNote : "phrases gardées : pas de contrôle dans la version d'avant",
      sources,
      ...(f.official ? { official: { original: f.official.original ?? null, text: f.official.text ?? null, note: f.official.note } } : {}),
      factsNote: f.note,
      request: { from: ver.id, flagged: req.flagged, marked: Object.fromEntries(Object.entries(marked).map(([k, v]) => [String(k), v])) },
    };
    const versionId = await insertVersion(deps.pool, type, item.id, { origin: "correction", status: "to_review", text, note, model: cfg.model, data, ms: Date.now() - t0 });
    const res = await deps.pool.query(
      `UPDATE ${table}
          SET synopsis_fr = ?, synopsis_status = 'to_review', synopsis_note = ?, synopsis_model = ?, synopsis_version_id = ?,
              synopsis_correction = NULL, synopsis_generated_at = NOW(), updated_at = updated_at
        WHERE id = ? AND synopsis_status = 'correction' AND synopsis_version_id = ?`,
      [text, note, cfg.model, versionId, item.id, ver.id],
    );
    if (affectedOf(res) === 0) {
      // demande annulée entre-temps : la correction n'est pas gardée
      await deps.pool.query(`DELETE FROM synopsis_versions WHERE id = ?`, [versionId]);
      report.cancelled++;
      continue;
    }
    report.corrected++;
    deps.log.info({ module: "synopsis", type, id: item.id, version: versionId, note }, "synopsis : correction faite");
  }
  return report;
}

/** Nombre d'items par statut (jamais_tente = jamais traité), pour les journaux et le futur bloc du dashboard. */
export async function synopsisStats(pool: SqlPool): Promise<Record<ItemType, Record<string, number>>> {
  const out: Record<ItemType, Record<string, number>> = { anime: {}, game: {} };
  const Row = z.object({ status: z.string().nullable(), n: z.coerce.number() });
  for (const type of ["anime", "game"] as const) {
    const rows = Row.array().parse(
      rowsOf(await pool.query(`SELECT synopsis_status AS status, COUNT(*) AS n FROM ${TABLES[type].table} GROUP BY synopsis_status`)),
    );
    for (const r of rows) out[type][r.status ?? "jamais_tente"] = r.n;
  }
  return out;
}

// ─── Traitement ──────────────────────────────────────────────────────────────

export interface NotesStep {
  source: string;
  sense: string[]; // « Sens : » écrit quand même par le modèle (affichage seulement)
  notes: string[]; // notes gardées, seules transmises à la rédaction
  proofs: ProofMatch[]; // v9.1 : pour chaque note gardée, où sa preuve est retrouvée
  dropped: string[]; // notes retirées, avec la raison
  /** Présent si la source est inexploitable : résultat final, pas de rédaction. */
  outcome?: Outcome;
}

// Mots qui ne disent rien de l'histoire : mots outils, formules (« The fourth season of… », « sequel to »),
// annonces et fiches de production (« will premiere », « adaptation of the light novel », « produced by »)
const NOT_STORY = new Set(
  [
    "a an the and or but nor so yet of to in on at by for from with without into onto over under about after before during",
    "between among through across against as than then there here this that these those it its is are was were be been being",
    "am has have had having do does did will would shall should can could may might must not no also only just now still even",
    "again very much many more most all any some each every both few other others such own same he she they them his her hers",
    "their theirs him we us our you your who whom whose which what when where while why how if up out off too",
    "season seasons part parts cour cours arc sequel prequel final new latest upcoming first second third fourth fifth sixth",
    "seventh eighth ninth tenth last next anime series tv television movie movies film films ova ona special specials episode",
    "episodes adaptation adapted adapting based project projects continuation installment instalment entry chapter chapters",
    "volume volumes story premiere premieres premiered airing air airs aired broadcast broadcasting scheduled slated release",
    "released releases releasing date dates announced announcement announces confirmed revealed reveals teaser trailer visual",
    "key staff cast voice actors studio studios produced producing production productions producer directed director directing",
    "animation animated written writer illustrated illustrator author light novel novels manga webtoon web original titled",
    "commemorating celebrating anniversary assistance collaboration cooperation synopsis information added help improve",
    "database adding details coming soon known called",
    "january february march april june july august september october november december",
    "le la les l un une des de du d et ou mais donc ni car en dans sur sous par pour avec sans chez vers entre est sont ete etre",
    "ont avait avaient sera seront ce cet cette ces son sa ses leur leurs qui que qu quoi dont se s ne n pas plus tout tous toute",
    "toutes il elle ils elles on nous vous y au aux aussi deja encore saison saisons partie parties serie series anime animes",
    "suite nouvelle nouveau prochaine prochain premiere premier deuxieme troisieme quatrieme derniere dernier diffusion diffuse",
    "diffusee diffusera sortie sortira annonce annonces annoncee bande date plateforme plateformes realise realisee realisateur",
    "produit produite tome tomes roman romans auteur autrice dessinateur prevue prevu programme programmee fevrier avril mai juin",
    "juillet aout septembre octobre novembre decembre janvier mars",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Mots du texte qui racontent quelque chose de l'œuvre : en minuscule (noms propres, studios, chaînes,
 * auteurs et nombres écartés), hors titres (l'œuvre, la précédente, la série) et hors mots outils,
 * formules et vocabulaire de production. « The second season of Youjo Senki. » : 0 ; « It will premiere
 * in January 2026 on Tokyo MX, produced by Studio Nut. » : 0.
 */
export function storyWords(text: string, titles: readonly string[]): number {
  const known = new Set(titles.flatMap((t) => titleKey(t).split(" ")));
  let n = 0;
  // « l'annonce », « d'octobre », « bande-annonce » : deux mots chacun, comparés un à un (revue v8.6)
  for (const raw of text.replace(/['’]s\b/g, "").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!/^\p{Ll}/u.test(raw)) continue;
    const w = titleKey(raw);
    if (w.length > 1 && !known.has(w) && !NOT_STORY.has(w)) n++;
  }
  return n;
}

/** Étape 1 : sens puis notes tirées de la source, lue à l'aide de la fiche ; notes douteuses retirées. */
export async function makeNotes(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  chat: ChatFn,
  facts: ItemFacts | null = null,
): Promise<NotesStep> {
  const source = cleanSource(item.description);
  const dossier = facts?.dossier ?? [];
  // une suite décrite en une ligne (« The second season of Youjo Senki. ») s'appuie sur le dossier
  const readable = (source.length >= MIN_SOURCE ? source.length : 0) + dossier.reduce((n, e) => n + e.text.length, 0);
  if (readable < MIN_SOURCE) {
    return { source, sense: [], notes: [], proofs: [], dropped: [], outcome: { status: "no_source", text: null, note: "texte source absent ou trop court" } };
  }
  // … mais pas sur le seul résumé de l'œuvre précédente : essai v8.3, Tanya II raconté avec l'histoire du
  // film d'avant, et Re:Zero Break Time (« The fourth season of… », rien d'autre) écrit de mémoire. Kitsu,
  // AnimeSchedule et ANN ont déjà été lus (gatherFacts). Animés seulement : un jeu présenté en une ligne
  // (« la suite du deckbuilder X ») a déjà de quoi faire une phrase
  if (type === "anime") {
    const titles = [item.title, item.title_english ?? "", facts?.prequel ?? "", facts?.series ?? ""];
    // la presse ne compte pas non plus : elle complète les autres sources, elle ne suffit jamais à raconter
    // l'œuvre (un passage pris dans un article-liste ou sur une autre saison ferait le synopsis, revue v8.6)
    const counts = (e: DossierEntry) => !e.source.startsWith(PREQUEL_SOURCE) && !e.source.startsWith(PRESSE_SOURCE);
    const story = [source, ...dossier.filter(counts).map((e) => e.text)].reduce((n, t) => n + storyWords(t, titles), 0);
    if (story < MIN_STORY_WORDS) {
      const note = dossier.some((e) => e.source.startsWith(PREQUEL_SOURCE))
        ? "présentation sans histoire, dossier sur l'œuvre précédente seulement"
        : "présentation sans histoire, rien d'autre sur cette œuvre";
      return { source, sense: [], notes: [], proofs: [], dropped: [], outcome: { status: "no_source", text: null, note } };
    }
  }
  const messages = buildNotesMessages(type, item, source, facts);
  const first = await chat(cfg, messages, 0.1, NOTES_TOKENS);
  let answer = parseNotesAnswer(first);
  let lastAnswer = first;
  let convo = messages; // la conversation à laquelle la dernière réponse répond
  if (answer.notes.length === 0 && readable >= RETRY_NOTES_SOURCE) {
    const again: ChatMessage[] = [...messages, { role: "assistant", content: first.trim() || "- (rien)" }, { role: "user", content: NOTES_RETRY }];
    lastAnswer = await chat(cfg, again, 0.3, NOTES_TOKENS);
    const second = parseNotesAnswer(lastAnswer);
    answer = { sense: second.sense.length ? second.sense : answer.sense, notes: second.notes, proofs: second.proofs };
    convo = again;
  }
  // date de sortie prise pour l'époque, genre ou ajout que ni le texte ni le dossier ne confirment
  const ctx = { releaseYear: item.release_year, support: supportText(item, source, facts), titles: [item.title, item.title_english ?? ""] };
  // v9.1, « ne pas mentir » : chaque note a sa preuve, retrouvée dans la présentation (AniList pour les
  // animés), le dossier (Kitsu, AnimeSchedule, Anime News Network, Wikipédia, Steam, IGDB, presse) ou la
  // fiche ; jamais dans le seul résumé de l'œuvre précédente (essai v9.0 : Tanya II, la mobilisation du film)
  const isPrequel = (e: DossierEntry) => e.source.startsWith(PREQUEL_SOURCE);
  // un nom ne prouve aucun fait de l'histoire : les lignes de personnages ne servent pas de preuve (relecture v9.1)
  const fiche = [itemHeader(type, item), factsBlock(facts) ?? ""]
    .join("\n")
    .split("\n")
    .filter((l) => !/^\s*Personnages\b/i.test(l))
    .join("\n");
  const proofSources = [
    { label: "Présentation", text: source },
    ...dossier.filter((e) => !isPrequel(e)).map((e) => ({ label: e.source, text: e.text })),
    { label: "Fiche", text: fiche },
    ...dossier.filter(isPrequel).map((e) => ({ label: e.source, text: e.text })), // en dernier : trouvée là seulement, la note est retirée
  ];
  const bare = proofLabelStripper(proofSources.map((x) => x.label));
  const namesText = [source, ...dossier.map((e) => e.text)].join("\n");
  const titleWords = new Set(ctx.titles.flatMap((t) => t.match(/\p{L}+/gu) ?? []).map(romanKey));
  const screen = (a: NotesAnswer) => {
    // les noms qui comptent pour otherNamesAround : personnages de la fiche, noms cités par les notes
    const known = new Set([
      ...(facts?.characters ?? []).flatMap((c) => (c.name.match(/\p{L}+/gu) ?? []).filter((x) => x.length >= 3)).map(romanKey),
      ...a.notes.flatMap(capitalWords).map(romanKey),
    ]);
    const genders = new Map<string, Gender | null>();
    for (const c of facts?.characters ?? []) for (const x of (c.name.match(/\p{L}+/gu) ?? []).filter((y) => y.length >= 3)) genders.set(romanKey(x), c.gender);
    const notes: string[] = [];
    const proofs: ProofMatch[] = [];
    const dropped: string[] = [];
    const lost: string[] = []; // preuves absentes ou introuvables de notes gardables : une relance peut les sauver
    let keepable = 0;
    for (const [i, n] of a.notes.entries()) {
      const why = noteProblem(n, ctx);
      if (why) {
        dropped.push(`${n} (${why})`);
        continue;
      }
      const named = ficheOnlyNames(n, facts?.characters ?? [], namesText);
      if (named.length) {
        dropped.push(`${n} (nom pris dans la seule fiche : ${named.join(", ")})`);
        continue;
      }
      keepable++;
      const raw = a.proofs[i];
      if (!raw) {
        dropped.push(`${n} (sans preuve)`);
        lost.push(`note « ${n} » : sans preuve`);
        continue;
      }
      const proof = bare(raw);
      const found = ficheProof(proof, fiche) ?? findProof(proof, proofSources);
      if (!found) {
        dropped.push(`${n} (preuve introuvable : « ${clip(proof, 140)} »)`);
        lost.push(`« ${clip(proof, 140)} »`);
        continue;
      }
      if (found.label.startsWith(PREQUEL_SOURCE)) {
        dropped.push(`${n} (preuve prise dans l'œuvre précédente : « ${clip(found.passage, 140)} »)`);
        continue;
      }
      const other = found.label === "Fiche" ? [] : otherNamesAround(n, found, proofSources, titleWords, known, genders);
      if (other.length) {
        dropped.push(`${n} (la preuve « ${clip(found.passage, 120)} » parle de ${other.join(", ")}, pas des noms de la note)`);
        continue;
      }
      notes.push(n);
      proofs.push(found);
    }
    return { notes, proofs, dropped, lost, keepable };
  };
  let result = screen(answer);
  // v9.1 : preuves oubliées (aucune) ou mal recopiées (deux au moins, ou toutes) : une seule relance.
  // v9.3 : aussi une seule perdue quand il reste moins de 3 notes (essai v9.2 : 007, la note principale
  // retirée pour « a young » au lieu de « a 26-year-old », synopsis de 169 caractères)
  const noProof = (a: NotesAnswer) => a.notes.every((n, i) => noteProblem(n, ctx) !== null || !a.proofs[i]);
  if (result.lost.length > 0 && (result.notes.length < MIN_NOTES_KEPT || result.lost.length >= 2)) {
    const ask = noProof(answer) ? NOTES_PROOF_RETRY : proofFixRequest(result.lost);
    const again: ChatMessage[] = [...convo, { role: "assistant", content: lastAnswer.trim() }, { role: "user", content: ask }];
    const second = parseNotesAnswer(await chat(cfg, again, 0.1, NOTES_TOKENS));
    const retried = screen(second);
    if (second.notes.length > 0 && retried.notes.length >= result.notes.length) {
      answer = { sense: second.sense.length ? second.sense : answer.sense, notes: second.notes, proofs: second.proofs };
      result = retried;
    }
  }
  const { notes, proofs, dropped } = result;
  if (notes.length === 0) {
    // la source n'y est pour rien : échec, nouvel essai plus tard, plutôt que « sans source »
    if (result.keepable > 0 && result.lost.length > 0) {
      const note = noProof(answer) ? "notes sans preuve" : "preuves introuvables";
      return { source, sense: answer.sense, notes, proofs, dropped, outcome: { status: "failed", text: null, note } };
    }
    const note = dropped.length ? "notes retirées (sans preuve retrouvée, non confirmées ou année de sortie)" : "la source ne dit presque rien de l'œuvre";
    return { source, sense: answer.sense, notes, proofs, dropped, outcome: { status: "no_source", text: null, note } };
  }
  return { source, sense: answer.sense, notes, proofs, dropped };
}

/** Relance des notes (v9.1) : les preuves introuvables, à recopier mot pour mot. */
export function proofFixRequest(lost: readonly string[]): string {
  return `Ces preuves ne sont pas dans les sources : ${lost.join(" ; ")}. Recopie chaque preuve mot pour mot, d'un seul tenant, depuis le texte de présentation, le dossier ou la fiche ; si aucun passage ne dit le fait, retire la note. Réponds de nouveau au même format, toutes les notes.`;
}

/**
 * Preuve courte prise dans la fiche (v9.1, relecture) : une ligne entière (« Série : Bendy », « Genres : Strategy »)
 * ou une valeur d'une ligne (« Horror »). Trop courtes pour findProof (4 mots au moins). Seulement le type, la
 * série, l'œuvre précédente et les genres : un titre ou un nom ne prouve aucun fait de l'histoire.
 */
export function ficheProof(proof: string, fiche: string): ProofMatch | null {
  const key = (t: string) => fold(t).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const wanted = key(proof);
  if (!wanted) return null;
  for (const line of fiche.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1 || !/^\s*(?:type|série|suite de|genres?)\b/iu.test(line)) continue;
    if (key(line) === wanted) return { label: "Fiche", exact: true, passage: line.trim() };
    const label = line.slice(0, at).trim();
    for (const value of line.slice(at + 1).split(/[,·;]/).map((v) => v.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean)) {
      if (key(value) === wanted || key(`${label} : ${value}`) === wanted) return { label: "Fiche", exact: true, passage: `${label} : ${value}` };
    }
  }
  return null;
}

/**
 * Noms que la preuve cite à la place de ceux de la note (v9.1, relecture : « Fern devient la meneuse », preuve
 * « his role as the party's frontliner », phrase qui parle de Stark). On lit la phrase du passage et celle
 * d'avant, sans les mots en tête de phrase ; rien si la note ne nomme personne, si l'un des noms de la note
 * y est, ou si ces phrases ne nomment aucun nom connu (`known` : personnages de la fiche, noms des notes).
 * Un studio (« Mega Crit ») ou des capitales (« THE SPIRE AWAKENS ») ne comptent donc pas.
 */
export function otherNamesAround(
  note: string,
  found: ProofMatch,
  sources: ReadonlyArray<{ label: string; text: string }>,
  titleWords: ReadonlySet<string> = new Set(),
  known: ReadonlySet<string> | null = null,
  genders: ReadonlyMap<string, Gender | null> = new Map(),
): string[] {
  const own = new Set(capitalWords(note).map(romanKey).filter((k) => !titleWords.has(k)));
  if (own.size === 0) return [];
  const src = sources.find((x) => x.label === found.label)?.text ?? "";
  const first = found.passage.split(" … ")[0] ?? "";
  const at = src.indexOf(first);
  if (at === -1) return [];
  const ends = [...src.slice(0, at).matchAll(/[.!?…](?:["”’)»])?\s+/g)].map((m) => (m.index ?? 0) + m[0].length);
  const from = ends.length >= 2 ? (ends[ends.length - 2] ?? 0) : 0; // la phrase d'avant
  const here = ends.length >= 1 ? (ends[ends.length - 1] ?? 0) : 0; // la phrase du passage
  const stop = /[.!?…](?:["”’)»])?(?:\s|$)/.exec(src.slice(at + first.length));
  const end = stop ? at + first.length + stop.index + 1 : src.length;
  // les noms : mots à majuscule en début de mot, qui ne commencent pas une phrase, découpés comme ceux de la note
  const namesIn = (t: string) =>
    [...t.matchAll(/(?<![.!?…]["”’)»]?\s*|^\s*)(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*(?:[.-]\p{L}[\p{L}\p{N}]*)*/gu)]
      .map((m) => m[0])
      .filter((w) => capitalWords(w).length > 0 && !titleWords.has(romanKey(w)) && (known === null || known.has(romanKey(w))));
  const span = src.slice(from, end);
  const words = new Set([...(span.match(/\p{L}+/gu) ?? []), ...capitalWords(span)].map(romanKey));
  if (namesIn(span).length === 0 || [...own].some((k) => words.has(k))) return [];
  // un pronom de la phrase du passage peut désigner le personnage de la note (essai v9.1, Wistoria : « he undertakes
  // with Lihanna » pour Will) : un pronom de son genre (inconnu : tout pronom) suffit à garder la note
  const sentence = src.slice(here, end).toLowerCase();
  const masc = /\b(?:he|him|his|himself|il)\b/u.test(sentence);
  const fem = /\b(?:she|her|hers|herself|elle)\b/u.test(sentence);
  const noteGenders = [...own].map((k) => genders.get(k) ?? null);
  const fits = noteGenders.length === 0 || noteGenders.some((g) => (g === "masculin" ? masc : g === "féminin" ? fem : masc || fem));
  if (fits && (masc || fem)) return [];
  const shown = namesIn(src.slice(here, end));
  return [...new Set(shown.length ? shown : namesIn(span))];
}

/**
 * Noms de personnages qu'une note prend dans la seule fiche : ni le texte ni le dossier ne les donnent
 * (essai v9.0 : Kujima, le frère aîné appelé « Masaomi », alors que les sources disent « the eldest son »
 * et que ce frère s'appelle Suguru). Seules comptent les parties propres à un personnage : « Kouda », nom de
 * toute la famille, ne dit pas lequel. « Kiyotaka Ayanokouji » passe : « Ayanokouji » est dans le texte.
 */
export function ficheOnlyNames(note: string, characters: readonly Character[], text: string): string[] {
  const keys = (t: string) => new Set((t.match(/\p{L}+/gu) ?? []).map(romanKey));
  const inNote = keys(note);
  const inText = keys(text);
  const partsOf = (c: Character) => [...new Set((c.name.match(/\p{L}+/gu) ?? []).filter((p) => p.length >= 3))];
  const shared = new Map<string, number>();
  for (const c of characters) for (const p of partsOf(c)) shared.set(romanKey(p), (shared.get(romanKey(p)) ?? 0) + 1);
  const out: string[] = [];
  for (const c of characters) {
    const own = partsOf(c).filter((p) => shared.get(romanKey(p)) === 1);
    const used = own.filter((p) => inNote.has(romanKey(p)));
    if (used.length > 0 && !own.some((p) => inText.has(romanKey(p)))) out.push(...used);
  }
  return [...new Set(out)];
}

/** Ce que les contrôles comparent au synopsis : texte, données de la fiche et du dossier, notes. */
export function checkContextFor(item: ItemRow, source: string, facts: ItemFacts | null, notes: readonly string[]): CheckContext {
  const characters = facts?.characters ?? [];
  return {
    source,
    data: [
      item.title,
      item.title_english ?? "",
      item.genre ?? "",
      ...characters.map((c) => c.name),
      facts?.prequel ?? "",
      facts?.series ?? "",
      ...(facts?.genres ?? []),
      ...(facts?.tags ?? []),
      ...(facts?.dossier ?? []).map((e) => e.text),
    ].join(" "),
    titles: [item.title, item.title_english ?? ""],
    notes,
    characters,
    releaseYear: item.release_year,
    support: supportText(item, source, facts),
  };
}

/**
 * Réponse de la rédaction (v9.1) : une phrase par ligne, « 1. … », « 2. … » ; sans numéros, le texte
 * coupé en phrases. Les numéros ne servent qu'à rattacher chaque phrase à sa note.
 */
export function parseWriteAnswer(raw: string, reference = ""): string[] {
  // « 1. », « 2) », « (3) », « 4 - », « 5 : », « Phrase 1 : », « Note 2 : », numéros en gras
  const NUMBERED = /^\s*[*_#>]*\s*(?:(?:phrase|note)\s*)?\(?(\d{1,2})\s*(?:[.):]|\s[-–])\s*[*_]*\s*(.*)$/i;
  const parts: string[] = [];
  let numbered = false;
  let afterBlank = true;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      afterBlank = true;
      continue;
    }
    const m = NUMBERED.exec(line);
    if (m && (m[2] ?? "").trim()) {
      parts.push(m[2] ?? "");
      numbered = true;
    } else if (numbered && !afterBlank && parts.length > 0) {
      // une phrase coupée sur deux lignes (relecture v9.1) : la précédente ne finit pas, ou la suite commence en minuscule ;
      // sinon c'est un commentaire (« J'ai écrit une phrase par note. »), ignoré
      const prev = parts[parts.length - 1] ?? "";
      if (!/[.!?…»"”)]\s*[*_]*$/.test(prev) || /^\s*\p{Ll}/u.test(line)) parts[parts.length - 1] = `${prev} ${line.trim()}`;
    }
    // sinon : un préambule (« Voici les phrases : ») ou un commentaire après une ligne vide, ignorés
    afterBlank = false;
  }
  // une phrase sans ponctuation finale en prend une : sinon deux phrases se lisent comme une seule
  const ended = (x: string) => (/[.!?…»"”)]$/.test(x) ? x : `${x}.`);
  if (numbered) return parts.map((x) => cleanOutput(x)).filter((x) => x.length > 0).map(ended);
  const text = cleanOutput(raw);
  return text ? splitSentences(text, reference) : [];
}

// mots qui prennent une majuscule en tête de note ou de phrase sans être des noms (et noms communs à majuscule)
const NOT_NAMES = new Set(
  (
    "le la les l un une des du de d dans en au aux à a quand pour après avant avec sur son sa ses leur leurs ce cet cette " +
    "ces il elle ils elles on lors depuis tandis mais et ou où alors puis ensuite pendant chaque tout tous toute toutes " +
    "deux trois quatre cinq premier première deuxième troisième quatrième cinquième nouvelle nouveau but cadre jeu " +
    "série saison film suite partie dernière seconde second ia"
  )
    .split(" ")
    .map(fold),
);

/** Mots à majuscule d'un texte (« Ayanokouji » dans « d'Ayanokouji », « R.E.A.C.H », « DSO »), hors mots courants. */
function capitalWords(text: string): string[] {
  return (text.match(/\p{Lu}[\p{L}\p{N}]*(?:[.-]\p{L}[\p{L}\p{N}]*)*/gu) ?? []).filter(
    (w) => w.length >= 2 && !NOT_NAMES.has(fold(w)) && !COMMON_CAPITALIZED.has(fold(w)),
  );
}

/** Noms d'un texte, mots à majuscule qui se suivent réunis : « Jason Duval », « Leon S. Kennedy ». */
function nameGroups(text: string): Array<Set<string>> {
  return (text.match(/\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*)*/gu) ?? [])
    .map((g) => new Set(capitalWords(g).map(romanKey)))
    .filter((g) => g.size > 0);
}

// une phrase qui commence par un pronom sujet, après au plus une courte apposition (« Orpheline, elle survit »)
const PRONOUN_START = /^(?:[^,.;:!?]{0,40},\s*)?(il|elle|ils|elles|celui-ci|celle-ci)\b/iu;

/**
 * Une phrase par note (v9.1) : autant de phrases que de notes, et chaque phrase ne cite que les noms de sa
 * note (essai v9.0 : RE Requiem, « Grace… est soutenue par Sherry Birkin », alors que la note dit que Sherry
 * soutient Leon ; Replaced, « Warren Marsh, dont les actes… » pour les actes de la Phoenix Corporation).
 * - Un même personnage peut s'écrire autrement : « Jason Duval » pour « Jason » (relecture v9.1, GTA VI, Nioh 3).
 *   Un mot est permis si un nom qui le contient a, dans la note, un mot qui n'appartient qu'à lui : « Kouda »,
 *   nom de toute une famille, ne permet pas « Masaomi ».
 * - Les noms : mots à majuscule des notes et noms de la fiche, hors titre de l'œuvre ; un mot du titre reste
 *   un nom si un personnage y figure en entier (« Frieren », « Kujima », pas « Steel » de Lucy Steel).
 * - Une phrase qui commence par un pronom (« Elle est soutenue par Sherry Birkin ») renvoie au sujet de la
 *   phrase d'avant : refusée si sa note a un autre sujet nommé (relecture v9.1).
 * Renvoie les motifs, vide si tout va.
 */
export function noteMapping(
  sentences: readonly string[],
  notes: readonly string[],
  titles: readonly string[] = [],
  characters: readonly Character[] = [],
): string[] {
  if (sentences.length !== notes.length) {
    const p = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;
    return [`une phrase par note (${p(sentences.length, "phrase")} pour ${p(notes.length, "note")})`];
  }
  const partsOf = (c: Character) => (c.name.match(/\p{L}+/gu) ?? []).filter((x) => x.length >= 3).map(romanKey);
  const titleWords = new Set(titles.flatMap((t) => t.match(/\p{L}+/gu) ?? []).map(romanKey));
  const inTitle = new Set(characters.map(partsOf).filter((ps) => ps.length > 0 && ps.every((x) => titleWords.has(x))).flat());
  const excluded = (k: string) => titleWords.has(k) && !inTitle.has(k);
  const names = new Set([...notes.flatMap(capitalWords).map(romanKey), ...characters.flatMap(partsOf)].filter((k) => !excluded(k)));
  const all = [...notes.flatMap(nameGroups), ...characters.map((c) => new Set(partsOf(c)))]
    .map((g) => new Set([...g].filter((k) => !excluded(k))))
    .filter((g) => g.size > 0);
  // noms entiers seulement (« Jason » est dans « Jason Duval ») ; un mot porté par plusieurs noms ne relie rien
  const groups = all.filter((g, k) => !all.some((h, j) => j !== k && h.size > g.size && [...g].every((x) => h.has(x))));
  const uses = new Map<string, number>();
  for (const g of new Set(groups.map((g) => [...g].sort().join(" ")))) for (const x of g.split(" ")) uses.set(x, (uses.get(x) ?? 0) + 1);
  // sujet nommé en tête de note (« Leon S. Kennedy est soutenu… ») ; « cadre : Norvaal » n'en a pas
  const subject = (note: string): Set<string> | null => {
    const t = note.trim();
    if (!/^\p{Lu}/u.test(t)) return null;
    const first = /^\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*)*/u.exec(t)?.[0] ?? "";
    const g = new Set(capitalWords(first).map(romanKey).filter((k) => !excluded(k)));
    return g.size ? g : null;
  };
  const out: string[] = [];
  sentences.forEach((sentence, i) => {
    // la note, en toute casse (« la tour »), et ses noms entiers : « R.E.A.C.H. », « MI6 » (essai v9.1 : Replaced et 007,
    // refusés à tort parce que la note était lue lettre par lettre)
    const own = new Set([...(notes[i]?.match(/[\p{L}\p{N}]+/gu) ?? []), ...capitalWords(notes[i] ?? "")].map(romanKey));
    const same = (k: string) => own.has(k) || groups.some((g) => g.has(k) && [...g].some((x) => own.has(x) && uses.get(x) === 1));
    const extra = [...new Set(capitalWords(sentence).filter((w) => names.has(romanKey(w)) && !same(romanKey(w))))];
    if (extra.length) {
      out.push(`phrase ${i + 1} : ${extra.map((w) => `« ${w} »`).join(", ")} ${extra.length > 1 ? "ne sont" : "n'est"} pas dans la note ${i + 1}`);
    }
    const pronoun = PRONOUN_START.exec(sentence)?.[1];
    const subj = subject(notes[i] ?? "");
    if (pronoun && subj) {
      const prev = i > 0 ? subject(notes[i - 1] ?? "") : null;
      const named = new Set(capitalWords(sentence).map(romanKey));
      if (!(prev && [...subj].some((x) => prev.has(x))) && ![...subj].some((x) => named.has(x))) {
        const who = /^\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*)*/u.exec((notes[i] ?? "").trim())?.[0] ?? "";
        out.push(`phrase ${i + 1} : « ${pronoun} » ne désigne pas ${who}, sujet de la note ${i + 1}`);
      }
    }
  });
  return out;
}

/**
 * Étape 2 : rédaction à partir des notes, une phrase par note (v9.1), puis contrôles. Un texte refusé par
 * les contrôles ou trop long est corrigé une fois. Si la correction d'un texte seulement trop long est
 * refusée, le premier texte part en relecture humaine plutôt que d'être perdu. Au dernier essai, une phrase
 * qui ne suit pas sa note est signalée au relecteur au lieu de faire échouer l'item.
 */
export async function writeFromNotes(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  source: string,
  notes: string[],
  chat: ChatFn,
  facts: ItemFacts | null = null,
): Promise<Outcome> {
  const ctx = checkContextFor(item, source, facts, notes);
  const attempts: Attempt[] = []; // dans l'ordre ; le texte gardé est le dernier essai qui porte ce texte
  const keep = (text: string, warnings: readonly string[], extra: string[] = []): Outcome => {
    const reasons = [...warnings, ...extra];
    if (item.pop_rank !== null && item.pop_rank <= cfg.reviewTop) reasons.push(`top ${cfg.reviewTop} de popularité`);
    return { status: reasons.length ? "to_review" : "auto", text, note: reasons.length ? clip(reasons.join(" · "), 255) : null, attempts };
  };
  let refused: string[] = [];
  let lastText = "";
  let lastAnswer = ""; // la réponse refusée, numérotée, renvoyée au modèle
  let fallback: { text: string; warnings: string[] } | null = null;
  const reference = `${source}\n${ctx.data}`;
  for (const [i, temperature] of TEMPERATURES.entries()) {
    const last = i === TEMPERATURES.length - 1;
    const raw = await chat(cfg, buildWriteMessages(type, item, notes, refused, facts, lastAnswer), temperature, WRITE_TOKENS);
    const written = parseWriteAnswer(raw, reference);
    const sentences = written.map((x) => polishText(x, written.join(" ")));
    const text = sentences.join(" ");
    const verdict = checkSynopsis(text, ctx);
    // une phrase par note : refus au 1er essai (fusion). Un nom hors de sa note, un pronom : alerte pour le relecteur,
    // jamais un nouvel essai (essai v9.1, Replaced : refusé à tort, le 2e essai a inversé les rôles)
    const mapping = noteMapping(sentences, notes, ctx.titles, ctx.characters);
    const count = mapping.filter((m) => m.startsWith("une phrase par note"));
    verdict.warnings.push(...mapping.filter((m) => !m.startsWith("une phrase par note")));
    if (last) verdict.warnings.push(...count);
    else verdict.errors.push(...count);
    if (verdict.errors.length) {
      attempts.push({ text, refused: verdict.errors });
      refused = verdict.errors;
      lastText = text;
      lastAnswer = numbered(sentences);
      continue;
    }
    const n = [...text].length;
    // trop long : accepté en relecture, mais un essai pour raccourcir vaut mieux (essai v7 : Classroom, 465 car.)
    if (n > SOFT_MAX && !last) {
      refused = [`trop long (${n} car.)`];
      attempts.push({ text, refused });
      fallback = { text, warnings: verdict.warnings };
      lastText = text;
      lastAnswer = numbered(sentences);
      continue;
    }
    attempts.push({ text, refused: [] });
    return keep(text, verdict.warnings);
  }
  // la correction a échoué aux contrôles : le premier texte, seulement trop long, part en relecture humaine
  if (fallback) return keep(fallback.text, fallback.warnings, ["correction refusée"]);
  return { status: "failed", text: null, note: clip(refused.join(" · "), 255), rejected: lastText, attempts };
}

/** Les deux étapes pour un item (fiche fournie par l'appelant). */
export async function processItem(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  chat: ChatFn,
  facts: ItemFacts | null = null,
): Promise<Outcome> {
  const step = await makeNotes(cfg, type, item, chat, facts);
  return step.outcome ?? writeFromNotes(cfg, type, item, step.source, step.notes, chat, facts);
}

/** Où passe le temps d'un item (essai à blanc) : mesuré, pour décider ce qu'il faut alléger. */
export interface DraftTiming {
  factsMs: number; // se renseigner (AniList, Kitsu, AnimeSchedule, ANN / IGDB, Wikipédia, Steam)
  notesMs: number; // étape 1
  writeMs: number; // étape 2, 2e essai compris
  checkMs?: number; // v9.4 : contrôle phrase / preuve, correction comprise
  usage: TokenUsage; // appels et jetons de l'item (0 avec un faux modèle)
}

export interface Draft extends Job {
  facts: ItemFacts | null;
  factsNote: string | null; // pourquoi la fiche manque
  source: string;
  sense: string[];
  notes: string[];
  proofs?: ProofMatch[]; // v9.1 : où la preuve de chaque note est retrouvée
  dropped: string[];
  outcome: Outcome;
  ms: number; // temps de l'item (fiche + notes + rédaction)
  timing?: DraftTiming;
  press?: PresseSeen[]; // articles de presse examinés (essai à blanc)
  official?: OfficialSeen; // v9.3 : site officiel lu (adresse, texte gardé, description japonaise et sa traduction)
  check?: CheckReport; // v9.4 : chaque phrase contre sa preuve ; phrases corrigées ou retirées
}

function usageSince(before: TokenUsage): TokenUsage {
  const now = tokenUsage();
  return {
    calls: now.calls - before.calls,
    input: now.input - before.input,
    output: now.output - before.output,
    inputMs: now.inputMs - before.inputMs,
    outputMs: now.outputMs - before.outputMs,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, inputMs: a.inputMs + b.inputMs, outputMs: a.outputMs + b.outputMs };
}

export interface DraftOptions {
  chunk?: number | undefined; // items par paquet, défaut CHUNK
  keepGoing?: (() => boolean) | undefined; // consulté avant chaque paquet
  // v9.5 : coupé ou mis en pause dans le Pilotage : consulté avant chaque item (notes, puis rédaction) ; le reste du
  // paquet n'est pas enregistré et revient au passage suivant (quelques minutes au plus, plus un paquet entier)
  stopNow?: (() => boolean) | undefined;
  onStep?: ((step: "notes" | "rédaction" | "contrôle", job: Job) => void) | undefined;
  facts?: FactsFn | undefined; // défaut : AniList / IGDB
  clock?: (() => number) | undefined; // horloge (ms), pour les tests de la pause d'AniList ; défaut Date.now
}

/**
 * Erreur propre à un item (donnée inattendue, contrôle qui plante) : l'item échoue et le passage
 * continue. Sans cela, le même item, le plus populaire de la file, plantait chaque passage et
 * bloquait tous les autres (relecture de la v8.4). Une panne d'Ollama, elle, arrête le passage.
 */
function itemFailure(err: unknown): Outcome {
  if (err instanceof OllamaError) throw err;
  return { status: "failed", text: null, note: clip(`erreur interne : ${errMessage(err)}`, 255) };
}

/**
 * Traite les items par paquets : fiche et notes de tout le paquet, puis la rédaction.
 * `onDraft` reçoit chaque item terminé. Renvoie "stopped" si `keepGoing` a dit non.
 * Une OllamaError remonte à l'appelant ; une fiche manquante ou l'erreur d'un item, non.
 */
export async function draftItems(
  cfg: SynopsisConfig,
  jobs: Job[],
  chat: ChatFn,
  onDraft: (draft: Draft) => Promise<void> | void,
  opts: DraftOptions = {},
): Promise<"done" | "stopped"> {
  const size = Math.max(1, opts.chunk ?? CHUNK);
  const getFacts = opts.facts ?? fetchFacts;
  // AniList : échecs de suite (animés qui l'interrogent) ; à ANILIST_BREAKER, c'est une panne et les animés
  // suivants sont remis sans l'interroger ni attendre, pendant ANILIST_COOLDOWN_MS ; ensuite, le prochain
  // animé l'interroge de nouveau. Un seul animé en échec (fiche propre à lui) ne bloque pas les autres :
  // le compte retombe à zéro dès qu'AniList répond (revue v8.7)
  const clock = opts.clock ?? Date.now;
  let anilistFails = 0;
  let anilistDown: { note: string; at: number } | null = null;
  for (let i = 0; i < jobs.length; i += size) {
    if (opts.keepGoing && !opts.keepGoing()) return "stopped";
    const pack = jobs.slice(i, i + size);
    const steps: Array<{
      job: Job;
      item: ItemRow;
      facts: FactsResult;
      step: NotesStep;
      timing: DraftTiming;
      press?: PresseSeen[] | undefined;
      official?: OfficialSeen | undefined;
    }> = [];
    for (const job of pack) {
      if (opts.stopNow?.()) return "stopped";
      opts.onStep?.("notes", job);
      const t0 = Date.now();
      const u0 = tokenUsage();
      const asksAniList = job.type === "anime" && job.item.ext_id !== null; // sans identifiant AniList, il n'est pas interrogé
      const stopped = (outcome: Outcome, note: string | null): void =>
        void steps.push({
          job,
          item: job.item,
          facts: { facts: null, note },
          step: { source: cleanSource(job.item.description), sense: [], notes: [], proofs: [], dropped: [], outcome },
          timing: { factsMs: Date.now() - t0, notesMs: 0, writeMs: 0, usage: usageSince(u0) },
        });
      if (asksAniList && anilistDown !== null && clock() - anilistDown.at < ANILIST_COOLDOWN_MS) {
        // rien n'est écrit : l'item reste en tête de file pour le passage suivant
        stopped(
          { status: "postponed", text: null, note: "AniList indisponible : rien n'est écrit, l'item revient au passage suivant" },
          `AniList indisponible (${ANILIST_BREAKER} échecs de suite, le dernier : ${anilistDown.note}) : pas interrogé pendant ${ANILIST_COOLDOWN_MS / 60_000} min`,
        );
        continue;
      }
      // se renseigner d'abord, même sans texte de présentation : le dossier peut suffire
      const fetched = await getFacts(job.type, job.item).catch((err: unknown): FactsResult => ({ facts: null, note: `fiche : ${errMessage(err)}` }));
      if (fetched.retryLater) {
        // sans fiche, le synopsis perdrait personnages, genre et œuvre précédente (essai v8.6) : échec noté,
        // nouvel essai une heure plus tard au plus tôt (fetchCandidates), sans bloquer la file
        if (asksAniList && ++anilistFails >= ANILIST_BREAKER) anilistDown = { note: fetched.note ?? "?", at: clock() };
        stopped({ status: "failed", text: null, note: clip(`${FACTS_DOWN} : ${fetched.note ?? "?"} ; nouvel essai dans 1 h au plus tôt`, 255) }, fetched.note);
        continue;
      }
      if (asksAniList) {
        // AniList a répondu : ce n'est pas (ou plus) une panne
        anilistFails = 0;
        anilistDown = null;
      }
      // v9.3 : description japonaise du site officiel traduite en français, en tête du dossier
      const raw = await withOfficialTranslation(cfg, chat, fetched, job.item);
      const factsMs = Date.now() - t0;
      // animés : la description AniList à jour devient le texte de présentation (la base peut garder un texte Jikan)
      const item = raw.description ? { ...job.item, description: raw.description } : job.item;
      const spelled = [cleanSource(item.description), ...(raw.facts?.dossier ?? []).map((e) => e.text)].join("\n");
      const facts = { facts: alignNames(raw.facts, spelled), note: raw.note };
      const step = await makeNotes(cfg, job.type, item, chat, facts.facts).catch(
        (err: unknown): NotesStep => ({ source: cleanSource(item.description), sense: [], notes: [], proofs: [], dropped: [], outcome: itemFailure(err) }),
      );
      steps.push({
        job,
        item,
        facts,
        step,
        timing: { factsMs, notesMs: Date.now() - t0 - factsMs, writeMs: 0, usage: usageSince(u0) },
        press: raw.press,
        official: raw.official,
      });
    }
    for (const { job, item, facts, step, timing, press, official } of steps) {
      if (opts.stopNow?.()) return "stopped";
      let outcome = step.outcome;
      let check: CheckReport | null = null;
      if (!outcome) {
        opts.onStep?.("rédaction", job);
        const t0 = Date.now();
        const u0 = tokenUsage();
        outcome = await writeFromNotes(cfg, job.type, item, step.source, step.notes, chat, facts.facts).catch(itemFailure);
        timing.writeMs = Date.now() - t0;
        timing.usage = addUsage(timing.usage, usageSince(u0));
        // v9.4 : chaque phrase contre la preuve de sa note ; une phrase NON est corrigée ou retirée
        if (outcome.text && (outcome.status === "auto" || outcome.status === "to_review")) {
          opts.onStep?.("contrôle", job);
          const t1 = Date.now();
          const u1 = tokenUsage();
          const written: Outcome = outcome;
          const verified = await verifySentences(cfg, job.type, item, written, step.proofs, chat, facts.facts, step.notes).catch(
            (err: unknown): { outcome: Outcome; report: CheckReport | null } => ({ outcome: itemFailure(err), report: null }),
          );
          outcome = verified.outcome;
          check = verified.report;
          timing.checkMs = Date.now() - t1;
          timing.usage = addUsage(timing.usage, usageSince(u1));
        }
      }
      await onDraft({
        ...job,
        facts: facts.facts,
        factsNote: facts.note,
        source: step.source,
        sense: step.sense,
        notes: step.notes,
        proofs: step.proofs,
        dropped: step.dropped,
        outcome,
        ms: timing.factsMs + timing.notesMs + timing.writeMs + (timing.checkMs ?? 0),
        timing,
        ...(press ? { press } : {}),
        ...(official ? { official } : {}),
        ...(check ? { check } : {}),
      });
    }
  }
  return "done";
}

/**
 * Un passage du cron : file d'attente, paquets, enregistrement, jusqu'à la limite, la fin de la fenêtre (vue avant
 * chaque paquet), une panne d'Ollama, ou `keepRunning` qui dit non (v9.5 : coupé ou mis en pause dans le Pilotage),
 * consulté avant chaque correction et chaque item : le synopsis en cours va au bout, le reste attend.
 */
export async function runBatch(
  deps: SynopsisDeps,
  cfg: SynopsisConfig,
  opts: { chat?: ChatFn; now?: () => Date; chunk?: number; facts?: FactsFn; keepRunning?: () => boolean } = {},
): Promise<RunReport> {
  const chat = opts.chat ?? ollamaChat;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const before = tokenUsage();
  const counts = { processed: 0, auto: 0, toReview: 0, failed: 0, noSource: 0, postponed: 0 };
  const corrections: CorrectionReport = { corrected: 0, failed: 0, dropped: 0, cancelled: 0 };

  const save = async (d: Draft): Promise<void> => {
    const { outcome } = d;
    if (outcome.status === "postponed") {
      // rien n'est écrit : la ligne reste vide et repasse en tête de file au passage suivant. Une ligne de
      // journal pour le premier (la raison) ; les suivants sont comptés dans le bilan du passage (postponed)
      counts.postponed++;
      if (counts.postponed === 1) {
        deps.log.info(
          { module: "synopsis", type: d.type, id: d.item.id, status: outcome.status, ...(d.factsNote ? { factsNote: d.factsNote } : {}) },
          "synopsis : item remis au passage suivant",
        );
      }
      return;
    }
    await saveDraft(deps.pool, d, cfg.model);
    counts.processed++;
    if (outcome.status === "auto") counts.auto++;
    else if (outcome.status === "to_review") counts.toReview++;
    else if (outcome.status === "failed") counts.failed++;
    else counts.noSource++;
    // fiche indisponible : en avertissement, pour qu'un échec qui se répète d'heure en heure se voie (revue v8.7)
    const level = outcome.status === "failed" && (outcome.note ?? "").startsWith(FACTS_DOWN) ? "warn" : "info";
    deps.log[level](
      {
        module: "synopsis",
        type: d.type,
        id: d.item.id,
        status: outcome.status,
        ms: d.ms,
        ...(outcome.note ? { note: outcome.note } : {}),
        ...(d.facts ? { characters: d.facts.characters.length } : {}),
        ...(d.factsNote ? { factsNote: d.factsNote } : {}),
        ...(d.facts?.dossier.length ? { dossier: d.facts.dossier.map((e) => e.source) } : {}),
        ...(d.notes.length ? { notes: d.notes } : {}),
        ...(d.dropped.length ? { dropped: d.dropped } : {}),
        ...((outcome.attempts?.length ?? 0) > 1 ? { attempts: outcome.attempts?.length } : {}),
        ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
        // v9.4 : phrases NON du contrôle, leur correction et le texte rédigé d'avant (rien n'est perdu)
        ...(d.check?.checks.some((c) => c.verdict === "NON")
          ? {
              check: d.check.checks.flatMap((c, i) =>
                c.verdict === "NON" ? [{ phrase: i + 1, why: c.why, ...(c.fixed !== undefined ? { fixed: c.fixed } : {}), ...(c.unconfirmed ? { unconfirmed: c.unconfirmed } : {}) }] : [],
              ),
              written: d.check.before,
            }
          : {}),
      },
      "synopsis : item traité",
    );
  };

  let stop: RunReport["stop"] = "done";
  let error: string | null = null;
  const getFacts = opts.facts ?? factsWithPress(deps.pool);
  // coupé ou mis en pause : l'arrêt vaut pour tout le reste du passage, même si on rallume entre-temps
  let halted = false;
  const running = (): boolean => {
    if (!halted && opts.keepRunning && !opts.keepRunning()) halted = true;
    return !halted;
  };
  const open = () => inWindow(parisHour(now()), cfg.window);
  const going = () => open() && running();
  try {
    // v9.5 : les corrections demandées par Rey d'abord ; une demande arrivée pendant le remplissage
    // l'interrompt à la fin du paquet en cours, puis le passage reprend après elle
    for (let round = 0; round < 100; round++) {
      const c = await runCorrections(deps, cfg, chat, getFacts, going);
      corrections.corrected += c.corrected;
      corrections.failed += c.failed;
      corrections.dropped += c.dropped;
      corrections.cancelled += c.cancelled;
      if (!running()) {
        stop = "off";
        break;
      }
      if (!open()) {
        stop = "window";
        break;
      }
      const budget = cfg.maxPerRun - counts.processed - counts.postponed;
      if (budget <= 0) break;
      const jobs = await fetchQueue(deps.pool, budget);
      if (jobs.length === 0) break;
      let pending = false;
      const end = await draftItems(
        cfg,
        jobs,
        chat,
        async (d) => {
          await save(d);
          pending = (await pendingCorrections(deps.pool)) > 0;
        },
        { chunk: opts.chunk, facts: getFacts, keepGoing: () => going() && !pending, stopNow: () => !running() },
      );
      if (end === "done") break;
      if (!running()) {
        stop = "off";
        break;
      }
      if (!pending) {
        stop = "window";
        break;
      }
    }
  } catch (err) {
    if (!(err instanceof OllamaError)) throw err;
    stop = "ollama";
    error = err.message;
  }
  const spent = tokenUsage();
  const report: RunReport = {
    ...counts,
    stop,
    ...(corrections.corrected + corrections.failed + corrections.dropped + corrections.cancelled > 0 ? { corrections } : {}),
    durationS: Math.round((Date.now() - started) / 1000),
    tokens: { input: spent.input - before.input, output: spent.output - before.output },
  };
  if (error) report.error = error;
  return report;
}

// ─── Correction des phrases signalées ────────────────────────────────────────
// Décision de Rey (13 octobre) : aucun synopsis ne s'affiche sans sa validation. Il touche les phrases
// fausses, et seules celles-là sont réécrites : les autres ne changent pas d'une lettre. Les contresens
// viennent de la lecture de l'anglais (étape des notes, essais v8.6 et v8.7) : la correction relit les
// sources elles-mêmes, jamais les notes. Le modèle recopie d'abord le passage qui parle des mêmes faits
// (la preuve, que le code retrouve dans les sources), puis réécrit la phrase d'après ce passage.

const CORRECT_TOKENS_BASE = 80;
const CORRECT_TOKENS_PER_SENTENCE = 170; // « Phrase N », la preuve recopiée, la phrase corrigée
const MIN_PROOF_WORDS = 4; // une preuve plus courte ne prouve rien (« the council »)

// « M. », « Dr. », « av. J.-C. » : pas une fin de phrase (pas « etc. », qui en termine souvent une)
const ABBREVIATION = /^(?:Dr|Mr|Mrs|Ms|M|Mme|Mlle|Mgr|St|Ste|No|Vol|Ep|Jr|Sr|vs|Prof|Cap|Lt|Gen|Col|Sgt|av|apr|env|J\.-C)\.$/;
// mots qui commencent une phrase française : après « la Section D. », « Parmi » ouvre une phrase, « Kennedy » non
const SENTENCE_OPENERS = new Set(
  (
    "à a afin ainsi alors après au aucun aucune aujourd aussi autour aux avant avec bientôt c ça car ce celui celle ceux cependant ces cet cette chacun " +
    "chaque comme d dans de depuis des désormais deux devant donc dès du elle elles en encore enfin ensemble ensuite entre et face hors " +
    "il ils j jusqu l la le les leur leurs lors lorsqu lorsque mais malgré même n ni non nous on or où par parmi partout pendant personne " +
    "peu plus plusieurs pour pourtant puis qu quand que quelques qui rien s sa sans se selon ses seul seule si sinon son sous sur tandis " +
    "tant tous tout toute toutes trois un une vers voici voilà"
  )
    .split(" ")
    .map(fold), // comparés sans accents : « Après » = « apres »
);

/**
 * Synopsis découpé en phrases, comme le relecteur les touche : `splitSentences(t).join(" ")` redonne le
 * texte (espaces ramenés à un seul). Une phrase commence par une majuscule, un chiffre ou un guillemet
 * ouvrant (« Les Faucons… »). Pas de coupure après une abréviation (« M. », « Dr. », « av. J.-C. ») ni
 * après l'initiale d'un nom : « Leon S. Kennedy » (RE Requiem, essai v8.7) reste dans sa phrase, alors
 * que « …la Section D. Parmi eux… » est coupé. Une initiale est suivie d'un nom, pas d'un mot qui ouvre
 * une phrase ; les sources (`reference`) qui écrivent « S. Kennedy » ou « Leon S. » le confirment.
 */
export function splitSentences(text: string, reference = ""): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const ref = reference.replace(/\s+/g, " ");
  const out: string[] = [];
  let start = 0;
  // « ? » » : le guillemet fermant suit la ponctuation, avec ou sans espace (insécable ramenée à une espace)
  for (const m of t.matchAll(/(?<=[.!?…](?: ?[»"”’)])?) (?=[«"“(]? ?[\p{Lu}\p{N}])/gu)) {
    const end = m.index;
    const head = t.slice(start, end);
    const tokens = head.split(" ");
    const last = tokens[tokens.length - 1] ?? "";
    const prev = tokens[tokens.length - 2] ?? "";
    if (ABBREVIATION.test(last)) continue;
    if (/^(?:\p{Lu}\.)+$/u.test(last)) {
      const next = (/^\S+/.exec(t.slice(end + 1))?.[0] ?? "").replace(/[,;:.!?…»"”)]+$/, "");
      const word = fold(next).replace(/['’].*$/, "");
      const named = (prev && ref.includes(`${prev} ${last}`)) || (next && ref.includes(`${last} ${next}`));
      const initial = last.length === 2 && /^\p{Lu}\p{Ll}/u.test(prev) && /^\p{Lu}\p{Ll}/u.test(next) && !SENTENCE_OPENERS.has(word);
      if (named || initial) continue;
    }
    out.push(head);
    start = end + 1;
  }
  out.push(t.slice(start));
  return out;
}

export const CORRECT_PROMPT = `Tu corriges un synopsis de GameNime, un site français qui annonce les sorties d'animés et de jeux vidéo.

Un relecteur a lu le synopsis à côté des sources et a signalé des phrases fausses : elles disent autre chose que les sources (rôle inversé, sens contraire, détail inventé, lien que rien ne donne). Les autres phrases sont justes et ne changent pas.

On te donne la fiche, le dossier de recherche, le texte de présentation (souvent en anglais), puis le synopsis, une phrase par ligne, numérotées, et les numéros des phrases fausses. Souvent, le relecteur a aussi touché les mots faux de la phrase : l'erreur est là.

Pour chaque phrase fausse :
1. Trouve dans le texte de présentation ou le dossier le passage qui parle des mêmes faits, et recopie-le mot pour mot, dans sa langue : c'est la preuve.
2. Compare en silence la phrase à la preuve, point par point (qui, fait quoi, à qui, où, quand, comment) : ce qui diffère est l'erreur ; les mots faux signalés en font partie. N'écris pas cette comparaison.
3. Réécris la phrase en français d'après la preuve : garde ce qui était juste, corrige l'erreur, sans inverser le sens.

Règles de la phrase corrigée :
- Les mots faux signalés n'y sont plus : à leur place, ce que dit la preuve.
- Seulement ce que disent la preuve et la phrase d'origine quand elle était juste : aucun détail de plus.
- Elle s'enchaîne avec les phrases gardées et ne les répète pas.
- Noms propres comme dans les sources, sans traduction ; genre des personnages selon la fiche.
- Français correct et naturel. La phrase reste la tienne : pars de la phrase d'origine et change ce qui est faux, sans traduire la preuve phrase à phrase.
- Ton neutre de notice : pas de « vous », pas de formule publicitaire, ni date de sortie ni plateformes.
- Si aucune source ne parle de ces faits, la phrase est supprimée : écris « Preuve : aucune » et « Correction : supprimer ».

Réponds seulement ainsi, pour chaque phrase fausse, sans rien ajouter (ni explication, ni rappel de la phrase d'origine) :
Phrase N
Preuve : passage recopié
Correction : phrase corrigée`;

// Exemple inventé (règle des prompts) : le synopsis de l'exemple de rédaction, avec le rôle inversé
// (l'archiviste efface la mémoire, alors que c'est le conseil) ; le relecteur a touché « Maelis Corvin efface ».
// La correction part de la phrase d'origine, pas de la preuve : seul ce qui est faux change
const CORRECT_EXAMPLE = {
  example: EXAMPLES[0],
  sentences: [
    "Verlune est une cité flottante.",
    "Sa magie est alimentée par les souvenirs de ceux qui la pratiquent.",
    "L'archiviste adolescente Maelis Corvin efface en secret la mémoire des citoyens.",
    "Le but du conseil est de garder Verlune en l'air.",
    "Quand son frère oublie le nom de Maelis, elle rejoint des contrebandiers décidés à révéler la vérité.",
  ],
  flagged: [2],
  spans: new Map([[2, ["Maelis Corvin efface"]]]),
  answer: [
    "Phrase 3",
    "Preuve : Teenage archivist Maelis Corvin discovers that the city's council has been secretly erasing citizens' memories",
    "Correction : L'archiviste adolescente Maelis Corvin découvre que le conseil efface en secret la mémoire des citoyens.",
  ].join("\n"),
} as const;

function correctionRequest(
  header: string,
  facts: ItemFacts | null,
  source: string,
  sentences: readonly string[],
  flagged: readonly number[],
  spans: ReadonlyMap<number, readonly string[]>,
): string {
  const words = flagged.filter((i) => spans.get(i)?.length).map((i) => `phrase ${i + 1} : ${(spans.get(i) ?? []).map((w) => `« ${w} »`).join(", ")}`);
  return [
    header,
    factsBlock(facts),
    dossierBlock(facts),
    `Texte de présentation :\n${source || "(aucun : appuie-toi sur le dossier)"}`,
    `Synopsis :\n${sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `Phrases fausses : ${flagged.map((i) => i + 1).join(", ")}`,
    words.length ? `Mots faux : ${words.join(" ; ")}` : null,
  ]
    .filter((p) => p !== null)
    .join("\n");
}

/** Mots d'une phrase tels que le relecteur les touche : séparés par une espace, ponctuation comprise. */
export function sentenceWords(sentence: string): string[] {
  return sentence.split(" ").filter((w) => w.length > 0);
}

/**
 * Mots touchés (positions dans `sentenceWords`) regroupés en passages : des mots qui se suivent n'en font
 * qu'un (« lui » + « révèle » → « lui révèle »). Ponctuation retirée aux deux bouts.
 */
export function markedSpans(sentence: string, positions: readonly number[]): string[] {
  const words = sentenceWords(sentence);
  const sorted = [...new Set(positions)].filter((p) => Number.isInteger(p) && p >= 0 && p < words.length).sort((a, b) => a - b);
  const spans: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length) spans.push(run.map((p) => words[p]).join(" ").replace(/^[«"“(\s]+|[,;:.!?…»"”)\s]+$/gu, ""));
    run = [];
  };
  for (const p of sorted) {
    if (run.length && p !== run[run.length - 1]! + 1) flush();
    run.push(p);
  }
  flush();
  return spans.filter((x) => x.length > 0);
}

/** Consigne, exemple, puis l'item ; après un refus, la réponse refusée et les motifs. */
export function buildCorrectionMessages(
  type: ItemType,
  item: ItemRow,
  source: string,
  facts: ItemFacts | null,
  sentences: readonly string[],
  flagged: readonly number[],
  previous: { answer: string; reasons: readonly string[] } | null = null,
  spans: ReadonlyMap<number, readonly string[]> = new Map(),
): ChatMessage[] {
  const ex = CORRECT_EXAMPLE;
  const messages: ChatMessage[] = [{ role: "system", content: CORRECT_PROMPT }];
  if (ex.example) {
    messages.push(
      { role: "user", content: correctionRequest(ex.example.header, ex.example.facts, ex.example.source, ex.sentences, ex.flagged, ex.spans) },
      { role: "assistant", content: ex.answer },
    );
  }
  messages.push({ role: "user", content: correctionRequest(itemHeader(type, item), facts, source, sentences, flagged, spans) });
  if (previous) {
    messages.push(
      { role: "assistant", content: previous.answer.trim() || "(rien)" },
      {
        role: "user",
        content: `Ta réponse a été refusée : ${previous.reasons.join(" ; ")}. Corrige ces points et réponds de nouveau, au même format, pour les phrases ${flagged.map((i) => i + 1).join(", ")}.`,
      },
    );
  }
  return messages;
}

export interface CorrectionBlock {
  proof: string;
  correction: string; // « supprimer » : la phrase est retirée
}

// « Phrase 2 », « **Phrase 2** », « 1. Phrase 2 : … », « Phrase n° 2 (corrigée) : … »
const BLOCK_HEADER = /^\s*(?:\d{1,2}[.)]\s+)?[#*_>\s]*phrase\s*(?:n[°o]\s*)?(\d{1,2})(?!\d)\s*[*_]*\s*(.*)$/i;
// « Preuve : », « Preuve (Présentation) : », « Preuve [Kitsu] : »
// « Preuve [Synopsis (Kitsu)] : » : le libellé du dossier, parenthèses comprises (revue v8.8)
const PROOF_LABEL = /^\s*[-*_\s]*(?:preuve|passage)(?:\s*[([](?:[^()[\]\n]|\([^()\n]*\)){0,160}[)\]])?\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i;
const FIX_LABEL = /^\s*[-*_\s]*(?:correction(?: proposée)?|phrase corrigée|nouvelle phrase|\(?corrigée\)?)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i;
// étiquettes de commentaire (« Explication : », « Version améliorée : ») : elles ferment le champ en cours.
// Une liste, pas « tout mot suivi de deux-points » : « Bendy : The Cage est… », « Frieren: Beyond… »
// ouvrent des phrases justes (revue v8.8)
const META_WORDS =
  "version(?: [\\p{L}]+)?|explications?|comparaisons?|remarques?|notes?|réponses?|résultats?|erreurs?|analyses?|justifications?|raisons?|" +
  "commentaires?|conclusions?|vérifications?|synopsis(?: corrigé| final)?|texte(?: corrigé| final)?|différences?|problèmes?|motifs?|" +
  "ancienne phrase|phrase (?:d'origine|d’origine|originale|fausse|d'avant|d’avant|initiale)|original|avant|après|résumé|ce qui change|changements?|modifications?|bilan";
// « Explication de l'erreur : », « Ce qui diffère : » : un mot de la liste, ou un mot à majuscule suivi de
// mots en minuscules, puis deux-points. Un titre n'a qu'un mot avant (« Bendy : The Cage »), ou des majuscules
const OTHER_LABEL = new RegExp(
  `^\\s*[-*_\\s]*(?:(?:${META_WORDS})(?:[ '’-]+\\p{L}+){0,4}|\\p{Lu}\\p{Ll}*(?:[ '’-]+\\p{Ll}+){1,5})\\s*[*_]*\\s*:(?:\\s|$)`,
  "iu",
);
// début « Quelque chose : » d'une correction : une étiquette, sauf si ce sont des mots du titre ou des sources
const LEAD_LABEL = /^(\p{L}[\p{L} ()'’-]{0,30}?)\s?:\s/u;
const END_OF_LINE_SENTENCE = /[.!?…](?: ?[»"”’)])?[*_]*\s*$/;
// libellé de source recopié devant la preuve : « [Anime News Network : Kujima (TV)] … », « Présentation : … »
// (entre crochets : retiré à la lecture ; sans crochets : par correctSentences, qui connaît les vrais libellés)
const BRACKET_PREFIX = /^\[[^\]\n]{1,160}\]\s*/;
const SOURCE_PREFIX = /^(?:texte de présentation|présentation|dossier(?: de recherche)?|kitsu|animeschedule|anime news network|ann|wikipédia|wikipedia|steam|page steam|igdb|presse)(?![\p{L}])[^:\n]{0,40}:\s*/iu;

function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * Réponse du modèle : pour chaque phrase signalée (indice à partir de 0), sa preuve et sa correction.
 * Un champ s'arrête à une ligne vide ou à une étiquette de commentaire, et la correction dès que sa ligne
 * finit une phrase : un commentaire du modèle (« Explication : … », « J'ai corrigé la phrase 2… ») n'entre
 * jamais dans le synopsis. Une étiquette répétée remplace la précédente ; un en-tête répété ne remplace
 * que ce qu'il apporte (« Phrase 2 corrigée. » en récapitulatif n'efface rien) (revues v8.8).
 */
export function parseCorrectionAnswer(raw: string, flagged: readonly number[]): Map<number, CorrectionBlock> {
  const parts = new Map<number, { proof: string[]; correction: string[] }>();
  let current: number | null = flagged.length === 1 ? (flagged[0] ?? null) : null; // une seule phrase : l'en-tête peut manquer
  let field: "proof" | "correction" | null = null;
  const blockOf = (i: number) => {
    let b = parts.get(i);
    if (!b) parts.set(i, (b = { proof: [], correction: [] }));
    return b;
  };
  const take = (line: string): boolean => {
    if (current === null) return false;
    const p = PROOF_LABEL.exec(line);
    const f = p ? null : FIX_LABEL.exec(line);
    if (p) {
      field = "proof";
      blockOf(current).proof = [p[1] ?? ""];
    } else if (f) {
      blockOf(current).correction = [f[1] ?? ""];
      field = END_OF_LINE_SENTENCE.test(f[1] ?? "") ? null : "correction"; // phrase finie : la suite est un commentaire
    } else return false;
    return true;
  };
  for (const line of raw.split("\n")) {
    const header = BLOCK_HEADER.exec(line);
    if (header) {
      current = Number(header[1]) - 1;
      field = null;
      const rest = (header[2] ?? "").replace(/^[*_\s]*[:.)–-]?\s*/, "").trim();
      // « Phrase 2 : Tout change… » sans étiquette, ou « Phrase 2 : supprimer » ; pas « Phrase 2 : corrigée. »,
      // « Phrase 2 : OK. », ni un rappel « Phrase 2 originale : <phrase fausse> » (qualificatif puis deux-points)
      const qualified = /^\(?[\p{L}'’ -]{1,30}\)?\s?:/u.test(rest);
      if (rest && !take(rest) && !qualified && (wordCount(rest) >= 4 || DELETE.test(rest))) {
        blockOf(current).correction = [rest];
        field = END_OF_LINE_SENTENCE.test(rest) ? null : "correction";
      }
      continue;
    }
    if (current === null) continue;
    if (take(line)) continue;
    if (!line.trim() || OTHER_LABEL.test(line)) {
      field = null;
      continue;
    }
    if (field) {
      blockOf(current)[field].push(line.trim());
      if (field === "correction" && END_OF_LINE_SENTENCE.test(line)) field = null;
    }
  }
  const unquote = (s: string) => s.replace(/^[\s«"“*_]+|[\s»"”*_]+$/g, "").trim();
  const out = new Map<number, CorrectionBlock>();
  for (const [i, b] of parts) {
    if (!flagged.includes(i)) continue;
    const proof = unquote(unquote(b.proof.join(" ")).replace(BRACKET_PREFIX, ""));
    out.set(i, { proof, correction: cleanOutput(b.correction.join(" ")) });
  }
  return out;
}

// « aucune », « (aucune) », « Aucune source ne parle de… » ; pas « None of them know… », vraie preuve (revue v8.8)
const NO_PROOF = /^\(?\s*(?:(?:aucune?|rien|none|néant)\s*\)?[.!]?\s*$|aucune? (?:source|passage|preuve|mention|information|des sources)|rien dans les sources|no (?:source|passage|evidence))/iu;
// « supprimer », « Supprimer cette phrase. », « (supprimée) », « Suppression. », « La phrase doit être supprimée. »
const DELETE = /^\(?\s*(?:(?:la |cette )?phrase (?:est |doit être |à )?)?(?:à\s+)?suppr(?:im|ession)/i;
// un commentaire glissé dans la correction : première personne, preuve, la source citée (pas « sources chaudes »)
const COMMENT =
  /(?<!\p{L})(?:j['’]ai|je |j['’](?=\p{L})|la preuve (?:ne|n['’]|dit|parle|indique|montre)|(?:selon|d['’]après) la preuve|(?:phrase|version) (?:corrigée|d['’]origine|originale)|la source (?:ne|n['’]|dit|parle)|les sources (?:ne|n['’]|disent|parlent)|absente?s? des sources|selon les sources|d['’]après les sources|phrases? (?:n[°o] ?)?\d)/iu;
// un mot de négation perdu ou ajouté inverse le sens : jamais toléré dans une preuve approchée.
// « wasn't » est lu « was not », « cannot » « can not » (tokensOf)
const NEGATIONS = new Set(["not", "no", "never", "nor", "neither", "without", "none", "nothing", "nobody", "nowhere", "unable", "ne", "n", "pas", "jamais", "sans", "ni", "aucun", "aucune", "rien"]);

interface Token {
  w: string; // mot sans accents ni majuscules
  s: number; // position dans le texte d'origine
  e: number;
}

/** Mots d'un texte, avec leur place ; les négations anglaises contractées sont dépliées (« can't » : can, not). */
function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const tok = { w: fold(m[0]), s: m.index, e: m.index + m[0].length };
    const prev = out[out.length - 1];
    if (tok.w === "t" && prev && /^['’]$/.test(text.slice(prev.e, tok.s)) && prev.w.endsWith("n")) {
      // « wasn't », « don't », « can't », « won't » : le « n » appartient à la négation
      if (prev.w === "can") tok.w = "not";
      else if (prev.w === "won") (prev.w = "will"), (tok.w = "not");
      else (prev.w = prev.w.slice(0, -1)), (tok.w = "not");
      out.push(tok);
      continue;
    }
    if (tok.w === "cannot") {
      out.push({ w: "can", s: tok.s, e: tok.e - 3 }, { w: "not", s: tok.e - 3, e: tok.e });
      continue;
    }
    out.push(tok);
  }
  return out;
}

function proofWords(s: string): string[] {
  return tokensOf(s).map((t) => t.w);
}

/** Distance d'édition en mots, ou max + 1 dès qu'elle dépasse `max`. */
function wordDistance(a: readonly string[], b: readonly string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/** Plus petite distance entre `piece` et un passage d'un seul tenant de `words` (jusqu'à `max`), et où. */
function closestWindow(piece: readonly string[], words: readonly string[], max: number): { d: number; at: number; len: number } | null {
  let best: { d: number; at: number; len: number } | null = null;
  for (let len = Math.max(1, piece.length - max); len <= piece.length + max; len++) {
    for (let at = 0; at + len <= words.length; at++) {
      const d = wordDistance(piece, words.slice(at, at + len), best ? Math.min(max, best.d - 1) : max);
      if (d <= max && (!best || d < best.d)) best = { d, at, len };
      if (best?.d === 0) return best;
    }
  }
  return best;
}

function negations(words: readonly string[]): string {
  return words.filter((w) => NEGATIONS.has(w)).sort().join(" ");
}

/**
 * Retire de la preuve le libellé de source que le modèle recopie devant : le libellé exact d'une source
 * (« Anime News Network : Kujima: … (TV) : »), sinon un libellé courant (« Présentation : ») ; jamais le
 * début d'une vraie preuve (« Kitsune spirits… »).
 */
export function proofLabelStripper(sourceLabels: readonly string[]): (proof: string) => string {
  const labels = ["Texte de présentation", ...sourceLabels].sort((a, b) => b.length - a.length);
  return (raw: string) => {
    let proof = raw;
    // « (Synopsis (Kitsu)) » avant ou après la preuve (relecture v9.1)
    for (const label of labels) {
      const around = new RegExp(`^\\s*[[(]\\s*${escapeRegExp(label)}\\s*[\\])]\\s*:?\\s*|\\s*[[(]\\s*${escapeRegExp(label)}\\s*[\\])]\\s*$`, "giu");
      const stripped = proof.replace(around, "").trim();
      if (stripped && stripped !== proof) proof = stripped.replace(/^[«"“]\s*|\s*[»"”]$/g, "").trim();
    }
    for (const label of labels) {
      const m = new RegExp(`^\\s*[[(]?\\s*${escapeRegExp(label)}\\s*[\\])]?\\s*:\\s*`, "iu").exec(proof);
      if (m && m[0].length < proof.length) return proof.slice(m[0].length).trim();
    }
    const m = SOURCE_PREFIX.exec(proof);
    return m && m[0].length < proof.length ? proof.slice(m[0].length).trim() : proof;
  };
}

export interface ProofMatch {
  label: string; // « Présentation », ou le libellé de l'entrée du dossier
  exact: boolean; // recopiée mot pour mot, d'un seul morceau ; sinon le vrai passage s'affiche à côté
  passage: string; // le passage tel qu'il est dans la source
}

/**
 * Où la preuve recopiée par le modèle se trouve dans les sources, ou null. Chaque morceau (séparés par
 * « … », 3 mots au moins) doit correspondre à un passage d'un seul tenant d'une source : mot pour mot
 * (casse, accents, apostrophes, ponctuation et négations contractées mis à part), ou à quelques mots près
 * (1 dès 6 mots, puis 1 par tranche de 12), sans négation perdue ni ajoutée, ni sautée entre deux morceaux.
 * Une preuve recousue de deux endroits ou qui retourne le sens n'est pas retrouvée (revues v8.8).
 */
export function findProof(proof: string, sources: ReadonlyArray<{ label: string; text: string }>): ProofMatch | null {
  const pieces = proof
    .split(/…|\.\.\.|\[\s*…?\s*\]/)
    .map(proofWords)
    .filter((w) => w.length > 0);
  // un morceau de 1 ou 2 mots cache ce qu'il saute (« Coco was … born with a gift »)
  if (pieces.some((w) => w.length < 3) || pieces.reduce((n, w) => n + w.length, 0) < MIN_PROOF_WORDS) return null;
  const keyed = sources.map((src) => ({ ...src, tokens: tokensOf(src.text) })).filter((src) => src.tokens.length > 0);
  const found: Array<{ src: number; at: number; len: number; d: number; size: number }> = [];
  for (const piece of pieces) {
    const max = piece.length < 6 ? 0 : Math.max(1, Math.floor(piece.length / 12));
    const neg = negations(piece);
    let best: { src: number; at: number; len: number; d: number } | null = null;
    keyed.forEach((src, k) => {
      if (best?.d === 0) return;
      const words = src.tokens.map((t) => t.w);
      const hit = closestWindow(piece, words, best ? Math.min(max, best.d - 1) : max);
      if (hit && negations(words.slice(hit.at, hit.at + hit.len)) === neg) best = { src: k, ...hit };
    });
    if (!best) return null;
    found.push({ ...(best as { src: number; at: number; len: number; d: number }), size: piece.length });
  }
  // deux morceaux de la même phrase d'une source : ce que l'ellipse saute ne doit pas porter une négation
  // (un saut par-dessus d'autres phrases ne change pas le sens de celles qu'on cite)
  for (let i = 1; i < found.length; i++) {
    const a = found[i - 1]!;
    const b = found[i]!;
    if (a.src !== b.src || b.at < a.at + a.len) continue;
    const src = keyed[a.src]!;
    const gap = src.text.slice(src.tokens[a.at + a.len - 1]!.e, src.tokens[b.at]!.s);
    if (/[.!?…]/.test(gap)) continue;
    if (negations(src.tokens.slice(a.at + a.len, b.at).map((t) => t.w))) return null;
  }
  const passageOf = (f: { src: number; at: number; len: number }) => {
    const src = keyed[f.src]!;
    const last = src.tokens[f.at + f.len - 1]!;
    // le guillemet fermant qui suit le dernier mot fait partie du passage (« what everybody “knows” »)
    const close = /^[”»"’)]*/.exec(src.text.slice(last.e))?.[0].length ?? 0;
    return src.text.slice(src.tokens[f.at]!.s, last.e + close);
  };
  const main = found.reduce((x, y) => (y.size > x.size ? y : x));
  return {
    label: keyed[main.src]!.label,
    exact: found.length === 1 && main.d === 0,
    passage: found.map(passageOf).join(" … "),
  };
}

/** Une phrase signalée et ce qu'elle est devenue. */
export interface SentenceFix {
  index: number; // dans le synopsis d'avant (à partir de 0)
  proof: string; // passage recopié par le modèle
  found: ProofMatch | null; // où la preuve est retrouvée ; null : introuvable (« Preuve : aucune » d'une suppression : label « aucune »)
  text: string | null; // phrase corrigée ; null : supprimée
}

/** Une réponse du modèle : le texte proposé, ses motifs de refus, et chaque phrase signalée telle qu'il l'a traitée. */
export interface CorrectionAttempt extends Attempt {
  fixes: SentenceFix[];
}

export interface CorrectionOutcome {
  status: "corrected" | "failed";
  sentences: string[]; // le synopsis proposé, phrase par phrase (celui d'avant en cas d'échec)
  text: string;
  corrected: number[]; // indices, dans `sentences`, des phrases réécrites
  removed: number; // phrases supprimées
  fixes: SentenceFix[]; // de l'essai gardé ; [] en cas d'échec (voir attempts)
  warnings: string[]; // alertes des contrôles sur les phrases corrigées, preuve approchée ou non retrouvée
  note: string | null; // motifs de l'échec
  attempts: CorrectionAttempt[];
}

// contrôles qui portent sur le texte entier ; les autres (copie, plateformes, genre, ajouts…) ne regardent
// que les phrases corrigées : une faute d'une phrase gardée n'est ni comptée, ni renvoyée au modèle
const WHOLE_TEXT = /^(?:trop court|trop long|pas en français|phrase coupée)/;
const checkKind = (e: string) => e.replace(/\s*\(.*$/, "");
const END_OF_SENTENCE = /[.!?…](?: ?[»"”’)])?$/;
const MIN_FIX_WORDS = 4; // « OK. », « Corrigée. » ne sont pas des phrases de synopsis

// mots outils : les changer ne change pas ce que dit la phrase. Pas les négations (ne, pas, sans…) :
// « Qifrey ne lui révèle pas » est une vraie correction
const FUNCTION_WORDS = new Set(
  (
    "le la les l un une des de du d au aux a et ou mais donc car en dans sur sous par pour avec chez vers entre que qu qui quoi dont ou " +
    "se s ce c cet cette ces son sa ses leur leurs il elle ils elles on lui y quand lorsqu lorsque comme si tout tous toute toutes " +
    "alors puis ensuite pourtant cependant ainsi meme deja aussi tres bien the an of to in on at by for with and or but as that which who"
  ).split(" "),
);

/**
 * La phrase fausse survit dans la correction : ses mots qui comptent s'y retrouvent tous, à la suite,
 * quels que soient les mots outils changés ou ce qui est ajouté autour (« Pourtant, » + la phrase fausse ;
 * « lorsqu'elle » → « quand elle »). Un mot qui compte changé est une vraie correction : « redoublent » →
 * « retombent », « assassin » → « élève », « Vice City » → « Leonida » (revues v8.8).
 */
function survives(part: readonly string[], wrong: readonly string[]): boolean {
  const content = (w: readonly string[]) => w.filter((x) => !FUNCTION_WORDS.has(x));
  const p = content(part);
  const w = content(wrong);
  if (w.length === 0) return part.join(" ") === wrong.join(" ");
  return closestWindow(w, p, 0) !== null;
}

// terminaisons de flexion seulement : pas « eur », « able », « ation », qui forment d'autres mots (revue v8.9 :
// un préfixe de 5 lettres prenait « redoutables » pour « redouble », « comme » pour « commence », « entre » pour « entrée »)
const ENDINGS = ["issaient", "issait", "issent", "aient", "erons", "eront", "erait", "erai", "erez", "ions", "iez", "ait", "ais", "ant", "ent", "ons", "era", "ees", "es", "ee", "er", "ez", "e", "s", "x"];
const ELIDED = new Set(["l", "d", "j", "m", "n", "s", "t", "c", "qu", "lorsqu", "puisqu", "jusqu"]);

/** Racine d'un mot : la plus longue terminaison de flexion retirée, 3 lettres gardées au moins (« dons » → don). */
function stemOf(word: string): string {
  for (const e of ENDINGS) if (word.endsWith(e) && word.length - e.length >= 3) return word.slice(0, -e.length);
  return word;
}

/**
 * La correction garde un passage que le relecteur a touché comme faux (revues v8.9).
 * - Mots outils seuls (« lui », « qu'il ») ou noms seuls (« Arata », « Vice City ») : pas vérifiés. Un nom
 *   revient dans une correction juste (rôle inversé : « Voyant Kujima affamé, Arata l'invite… »).
 * - Un mot plein (« redoublent », « meneur », « l'aide ») : aucun mot de même racine (« redouble », « aide »).
 * - Plusieurs mots pleins (« mi-oiseau mi-humaine », « libérées par des expériences ») : pas la même suite de
 *   mots pleins, chacun à la racine près, mots outils entre eux ignorés (« par les expériences » aussi).
 * - Un mot plein avec des mots outils (« lui révèle », « Son esprit ») : pas la même suite exacte ; le mot
 *   plein peut revenir autrement (« l'esprit envahi, Henry explore »).
 */
export function keepsSpan(text: string, span: string): boolean {
  const toks = tokensOf(span).map((t) => ({ w: t.w, name: /^\p{Lu}/u.test(span.slice(t.s, t.e)) && !COMMON_CAPITALIZED.has(t.w) }));
  while (toks.length > 1 && ELIDED.has(toks[0]!.w)) toks.shift(); // « l'aide » est un mot touché : aide
  const full = toks.filter((t) => !FUNCTION_WORDS.has(t.w));
  if (full.length === 0 || full.every((t) => t.name)) return false;
  const words = proofWords(text);
  const content = words.filter((w) => !FUNCTION_WORDS.has(w));
  if (toks.length === 1 || full.length >= 2) {
    const want = full.map((t) => stemOf(t.w));
    return content.some((_w, i) => want.every((x, d) => content[i + d] !== undefined && stemOf(content[i + d]!) === x));
  }
  return ` ${words.join(" ")} `.includes(` ${toks.map((t) => t.w).join(" ")} `);
}

/** Mots sans majuscule d'un texte : une reprise se compte sur eux, pas sur les noms (« Advanced Nurturing High School »). */
function commonWords(text: string): string[] {
  return tokensOf(text)
    .filter((t) => !/^\p{Lu}/u.test(text.slice(t.s, t.e)))
    .map((t) => t.w);
}

/** Les deux textes partagent `k` mots sans majuscule à la suite. */
function sharesRun(a: readonly string[], b: readonly string[], k: number): boolean {
  const grams = new Set<string>();
  for (let i = 0; i + k <= b.length; i++) grams.add(b.slice(i, i + k).join(" "));
  for (let i = 0; i + k <= a.length; i++) if (grams.has(a.slice(i, i + k).join(" "))) return true;
  return false;
}

const KEPT_RUN = 6; // essai v8.8 : RE Requiem, « en octobre 2026, 28 ans après la destruction de Raccoon City » repris

/**
 * Réécrit les phrases `flagged` (indices de `sentences`) d'après les sources ; les autres restent telles
 * quelles, à leur place. `marked` : pour une phrase signalée, les mots que le relecteur a touchés comme
 * faux (positions dans `sentenceWords`) ; le modèle les reçoit, et une correction qui les garde est refusée.
 * Refusée et redemandée une fois : correction manquante, trop courte, inchangée (même avec un ajout),
 * qui garde un mot faux, coupée, trop longue, en anglais, commentée, qui se fond avec une phrase voisine,
 * qui reprend une phrase gardée ; suppression qui fond ses voisines, ou que la preuve contredit ; nouvelle
 * erreur des contrôles sur les phrases corrigées ; preuve « aucune » pour une phrase réécrite ; preuve
 * introuvable. Au 2e essai, une preuve introuvable n'empêche plus la correction : elle devient une alerte,
 * le relecteur juge. Après deux refus : échec, le synopsis d'avant rendu tel quel.
 */
export async function correctSentences(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  sentences: readonly string[],
  flagged: readonly number[],
  chat: ChatFn,
  facts: ItemFacts | null = null,
  marked: Readonly<Record<number, readonly number[]>> = {},
): Promise<CorrectionOutcome> {
  const wanted = [...new Set(flagged)].sort((a, b) => a - b);
  if (wanted.length === 0 || wanted.some((i) => !Number.isInteger(i) || i < 0 || i >= sentences.length)) {
    throw new Error(`phrases signalées invalides (${flagged.join(", ")} pour ${sentences.length} phrases)`);
  }
  // mots touchés : seulement dans une phrase signalée, et là où il y a un mot
  const spans = new Map<number, string[]>();
  for (const [at, positions] of Object.entries(marked)) {
    const i = Number(at);
    if (!positions.length) continue;
    const count = sentenceWords(sentences[i] ?? "").length;
    if (!wanted.includes(i) || positions.some((p) => !Number.isInteger(p) || p < 0 || p >= count)) {
      throw new Error(`mots signalés invalides (phrase ${i + 1})`);
    }
    spans.set(i, markedSpans(sentences[i] ?? "", positions));
  }
  const source = cleanSource(item.description);
  const sources = [{ label: "Présentation", text: source }, ...(facts?.dossier ?? []).map((e) => ({ label: e.source, text: e.text }))];
  const reference = sources.map((s) => s.text).join("\n");
  const ctx = checkContextFor(item, source, facts, []);
  const before = checkSynopsis(sentences.join(" "), ctx);
  const key = (s: string) => proofWords(s).join(" ");
  const wrongWords = wanted.map((i) => proofWords(sentences[i] ?? ""));
  const known = ` ${proofWords([...ctx.titles, reference].join(" ")).join(" ")} `;
  // « Bendy : The Cage est… » : « Bendy » est dans le titre ; « Proposition : … », « Originale : … » non
  const labelled = (text: string) => {
    const m = LEAD_LABEL.exec(text);
    if (!m) return false;
    const head = proofWords(m[1] ?? "");
    return head.length === 0 || !known.includes(` ${head.join(" ")} `);
  };
  const bare = proofLabelStripper(sources.map((s) => s.label));
  const chars = (s: string) => [...s].length;
  // une frontière de phrase entre a et b : relu, le texte « a b » se coupe bien entre les deux
  const boundary = (a: string, b: string) => {
    let acc = "";
    for (const p of splitSentences(`${a} ${b}`, reference)) {
      acc = acc ? `${acc} ${p}` : p;
      if (acc === a) return true;
    }
    return false;
  };
  const attempts: CorrectionAttempt[] = [];
  const proven = new Set<number>(); // phrases dont un essai a retrouvé la preuve : plus de suppression permise
  const maxTokens = CORRECT_TOKENS_BASE + CORRECT_TOKENS_PER_SENTENCE * wanted.length;
  let previous: { answer: string; reasons: string[] } | null = null;
  for (const [n, temperature] of TEMPERATURES.entries()) {
    const last = n === TEMPERATURES.length - 1;
    const answer = await chat(cfg, buildCorrectionMessages(type, item, source, facts, sentences, wanted, previous, spans), temperature, maxTokens);
    const blocks = parseCorrectionAnswer(answer, wanted);
    const reasons: string[] = [];
    const lost: number[] = []; // preuve introuvable
    const fixes: SentenceFix[] = [];
    const faulty = new Set<number>(); // phrases déjà refusées pour elles-mêmes
    for (const i of wanted) {
      const b = blocks.get(i);
      const name = `phrase ${i + 1}`;
      const refuse = (why: string) => {
        reasons.push(`${name} ${why}`);
        faulty.add(i);
      };
      if (!b || !b.correction) {
        refuse("sans correction");
        continue;
      }
      b.proof = bare(b.proof);
      const removed = DELETE.test(b.correction);
      let text: string | null = null;
      if (!removed) {
        const written = b.correction.charAt(0).toUpperCase() + b.correction.slice(1);
        text = polishText(written, `${sentences.join(" ")} ${written}`);
        const parts = splitSentences(text, reference);
        const original = sentences[i] ?? "";
        if (NO_PROOF.test(b.proof)) refuse(": preuve « aucune » mais phrase réécrite");
        if (labelled(text)) refuse("commence par une étiquette");
        else if (COMMENT.test(text) || parts.some((p) => /^\(.*\)[.!?…]?$/.test(p))) refuse("contient un commentaire");
        else if (wordCount(text) < MIN_FIX_WORDS) refuse("trop courte");
        else if (parts.some((p) => wrongWords.some((w) => survives(proofWords(p), w)))) refuse("inchangée");
        else if ((spans.get(i) ?? []).some((sp) => keepsSpan(text ?? "", sp))) {
          refuse(`garde ${(spans.get(i) ?? []).filter((sp) => keepsSpan(text ?? "", sp)).map((sp) => `« ${sp} »`).join(", ")}`);
        } else if (!END_OF_SENTENCE.test(text)) refuse("coupée");
        else if (parts.length > 2 || chars(text) > Math.max(2 * chars(original), chars(original) + 150)) refuse("trop longue");
        // la preuve recopiée au lieu d'une phrase française : les phrases gardées, en français, la masqueraient
        // au contrôle de langue du texte entier
        else if (looksEnglishLine(withoutTitles(text, ctx.titles))) refuse("pas en français");
      }
      const found = removed && NO_PROOF.test(b.proof) ? { label: "aucune", exact: true, passage: "" } : findProof(b.proof, sources);
      if (found !== null && found.label !== "aucune") proven.add(i);
      if (removed) {
        // supprimer une phrase en citant un passage qui en parle : la preuve dit qu'elle est juste (essai v8.8 :
        // Classroom, « assassin de la White Room » supprimé avec « one of whom is a White Room assassin »).
        // Une suppression ne vaut qu'avec « Preuve : aucune », et pas après un essai qui a trouvé la preuve
        if (found !== null && found.label !== "aucune") refuse("supprimée alors que la preuve en parle : réécris-la d'après la preuve");
        else if (found === null) refuse("supprimée : la preuve doit être « aucune »");
        else if (proven.has(i)) refuse("supprimée alors que la preuve en parle (essai précédent) : réécris-la d'après la preuve");
      } else if (found === null) lost.push(i);
      fixes.push({ index: i, proof: b.proof, found, text });
    }
    // le synopsis proposé : les phrases gardées telles quelles, les corrigées à leur place
    const proposed: string[] = [];
    const origin: number[] = []; // phrase d'avant dont vient chaque phrase proposée
    const corrected: number[] = [];
    let removedCount = 0;
    sentences.forEach((s, i) => {
      const fix = fixes.find((f) => f.index === i);
      if (!fix) {
        proposed.push(s);
        origin.push(i);
      } else if (fix.text === null) removedCount++;
      else
        for (const part of splitSentences(fix.text, reference)) {
          corrected.push(proposed.length);
          proposed.push(part);
          origin.push(i);
        }
    });
    const text = proposed.join(" ");
    if (proposed.length === 0) reasons.push("plus aucune phrase");
    // une phrase corrigée ne reprend ni une phrase gardée (même en partie : 6 mots de suite), ni une autre corrigée
    corrected.forEach((j, n) => {
      const mine = commonWords(proposed[j] ?? "");
      proposed.forEach((other, k) => {
        if (k === j) return;
        const same = key(other) === key(proposed[j] ?? "");
        if (corrected.includes(k)) {
          if (same && corrected.indexOf(k) < n) reasons.push(`phrase ${(origin[j] ?? 0) + 1} répète une autre phrase corrigée`);
        } else if (same || sharesRun(mine, commonWords(other), KEPT_RUN)) {
          reasons.push(`phrase ${(origin[j] ?? 0) + 1} reprend la phrase gardée ${(origin[k] ?? 0) + 1}`);
        }
      });
    });
    // chaque frontière nouvelle (autour d'une phrase corrigée ou supprimée) doit le rester à la relecture :
    // sinon deux phrases se fondent, et toucher l'une ferait réécrire l'autre
    for (let j = 1; j < proposed.length; j++) {
      const a = origin[j - 1] ?? 0;
      const b = origin[j] ?? 0;
      const touched = corrected.includes(j) || corrected.includes(j - 1);
      if ((!touched && b - a <= 1) || (a === b && touched)) continue;
      if (faulty.has(a) || faulty.has(b)) continue; // déjà refusée pour elle-même : pas de motif en double
      if (!boundary(proposed[j - 1] ?? "", proposed[j] ?? "")) {
        reasons.push(touched ? `phrase ${(corrected.includes(j) ? b : a) + 1} se fond avec sa voisine` : `phrase ${a + 2} supprimée : ses voisines se fondent`);
      }
    }
    const onlyFixed = corrected.map((j) => proposed[j]).join(" ");
    const part = onlyFixed ? checkSynopsis(onlyFixed, ctx) : { errors: [], warnings: [] };
    const whole = checkSynopsis(text, ctx);
    const kindsBefore = new Set(before.errors.filter((e) => WHOLE_TEXT.test(e)).map(checkKind));
    reasons.push(...part.errors.filter((e) => !WHOLE_TEXT.test(e)));
    for (const e of whole.errors) {
      if (!WHOLE_TEXT.test(e) || kindsBefore.has(checkKind(e))) continue;
      if (e === "phrase coupée" && faulty.size > 0) continue; // la phrase corrigée coupée est déjà dite
      // la langue se juge phrase par phrase (pas en français, plus haut) : un texte raccourci par une suppression
      // peut n'avoir plus assez de mots outils pour le contrôle du texte entier, sans être moins français
      if (e === "pas en français") continue;
      // v9.1 : une phrase par note, des textes plus longs ; une correction qui allonge le texte au-delà de
      // HARD_MAX est signalée au relecteur, pas refusée (relecture v9.1 : 596 car. + 75 → refusée deux fois)
      if (checkKind(e) === "trop long") continue;
      reasons.push(e);
    }
    const unique = [...new Set(reasons)];
    const proofReason = lost.length ? `preuve introuvable dans les sources (phrase ${lost.map((i) => i + 1).join(", ")})` : null;
    const refused = proofReason && !last ? [...unique, proofReason] : unique;
    attempts.push({ text, refused, fixes });
    if (refused.length === 0) {
      const warnings = part.warnings.filter((w) => !w.startsWith("longueur"));
      if (whole.warnings.some((w) => w.startsWith("longueur")) && !before.warnings.some((w) => w.startsWith("longueur"))) {
        warnings.push(...whole.warnings.filter((w) => w.startsWith("longueur")));
      }
      if ([...text].length > HARD_MAX) warnings.push(`longueur ${[...text].length} car.`);
      const approx = fixes.filter((f) => f.found && !f.found.exact).map((f) => f.index + 1);
      if (approx.length) warnings.push(`preuve approchée (phrase ${approx.join(", ")})`);
      if (proofReason) warnings.push(proofReason.replace("preuve introuvable", "preuve non retrouvée"));
      return { status: "corrected", sentences: proposed, text, corrected, removed: removedCount, fixes, warnings, note: null, attempts };
    }
    previous = { answer, reasons: refused };
  }
  const reasons = previous?.reasons ?? [];
  return {
    status: "failed",
    sentences: [...sentences],
    text: sentences.join(" "),
    corrected: [],
    removed: 0,
    fixes: [],
    warnings: [],
    note: clip(`correction refusée : ${reasons.join(" · ")}`, 255),
    attempts,
  };
}

/**
 * Fiche et dossier d'un item tels que la rédaction les voit (texte de présentation AniList à jour, noms
 * alignés sur les sources). Pour la correction : elle relit les mêmes sources.
 */
export async function factsFor(
  job: Job,
  getFacts: FactsFn,
  translate: { cfg: SynopsisConfig; chat: ChatFn } | null = null,
): Promise<{ item: ItemRow; facts: ItemFacts | null; note: string | null; retryLater: boolean; press?: PresseSeen[]; official?: OfficialSeen }> {
  const fetched = await getFacts(job.type, job.item).catch((err: unknown): FactsResult => ({ facts: null, note: `fiche : ${errMessage(err)}` }));
  // v9.3 : la description japonaise du site officiel, traduite, comme pour la rédaction (draftItems)
  const raw = translate && !fetched.retryLater ? await withOfficialTranslation(translate.cfg, translate.chat, fetched, job.item) : fetched;
  const item = raw.description ? { ...job.item, description: raw.description } : job.item;
  const spelled = [cleanSource(item.description), ...(raw.facts?.dossier ?? []).map((e) => e.text)].join("\n");
  return {
    item,
    facts: alignNames(raw.facts, spelled),
    note: raw.note,
    retryLater: raw.retryLater === true,
    ...(raw.press ? { press: raw.press } : {}),
    ...(raw.official ? { official: raw.official } : {}),
  };
}

// ─── v9.4 : chaque phrase contrôlée contre la preuve de sa note ──────────────
// Une phrase par note depuis la v9.1, et chaque note a sa preuve : le modèle reçoit la phrase et le passage,
// et dit seulement si la phrase en dit plus (OUI / NON). Banc du 13 octobre (44 phrases des essais v9.1 à
// v9.3, jugées à la main) : un appel par phrase repère 15 phrases fausses sur 17 et signale 2 justes sur 27,
// en 9 s par phrase ; un appel par item, 12 sur 17 et 11 sur 27, avec 5 réponses illisibles.
// Une phrase NON passe par la correction (v8.8) ; la réécriture n'est gardée qu'avec une preuve retrouvée et
// un 2e contrôle OUI. Sinon la phrase reste telle quelle, signalée au relecteur : le juge se trompe parfois
// (2 phrases justes sur 27), et rien ne s'affiche sans la validation de Rey (relecture v9.4 : retirer une
// phrase juste faisait échouer un synopsis court, ou laissait un « Il » sans personnage).

export const CHECK_PROMPT = `Tu relis un synopsis de GameNime, un site français, phrase par phrase. Pour chaque phrase, on te donne le passage de la source (souvent en anglais) qui doit la prouver.

Réponds OUI si la phrase ne dit rien que le passage ne dise : une reformulation, un mot plus simple, moins de détails, le titre de l'œuvre ou le nom complet d'un personnage ajoutés conviennent.
Réponds NON si la phrase dit autre chose que le passage :
- un fait, une cause, un but, un moment ou un sentiment que le passage ne dit pas ;
- qui fait quoi à qui, inversé ;
- un mot qui change le sens : « the city is flooded » ne veut pas dire « la ville est détruite » ; « she spies on the captain » ne veut pas dire « le capitaine lui apprend ».
Lis le passage mot à mot avant de répondre.

Réponds seulement « OUI », ou « NON : » suivi de ce qui est faux.`;

const CHECK_TOKENS = 60;
const MAX_CHECK_PASSAGE = 600; // passage étendu à ses phrases entières : au-delà, le passage cité seul
const MIN_ALIGN = 0.25; // part des mots d'une phrase retrouvés dans une note : en dessous, aucune note ne lui correspond

// mots sans contenu pour rapprocher une phrase de sa note (minuscules, sans accents)
const ALIGN_STOP = new Set(
  ("dans avec pour mais leur leurs elle elles ils sont etre avoir fait faire plus tres tout toute tous toutes cette ceux celle " +
    "celui dont entre apres avant depuis sans sous chez vers comme aussi encore deja alors ainsi meme lors lorsque quand qui que " +
    "quoi est ont son ses sur une des les aux du de la le un et ou ne pas jeu jeux joueur").split(" "),
);

/** Mots qui portent le sens d'un texte, coupés à 5 lettres (« attaquer » = « attaque ») : rapprocher une phrase de sa note. */
function alignKeys(text: string): Set<string> {
  return new Set(
    (fold(text).match(/\p{L}[\p{L}'’-]*/gu) ?? [])
      .map((w) => w.replace(/^(?:l|d|j|m|n|s|t|c|qu)['’]/, ""))
      .filter((w) => w.length >= 4 && !ALIGN_STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

/**
 * La note dont la phrase reprend le plus de mots (à égalité, celle de même rang) ; null si aucune n'atteint
 * MIN_ALIGN. Essai v9.4 : une rédaction qui ajoute une phrase (« Nioh 3 est un jeu d'action ») et en oublie
 * une décalait toutes les autres, et chaque phrase était comparée à la preuve de la note d'à côté.
 */
export function alignSentence(sentence: string, notes: readonly string[], rank: number): number | null {
  const own = alignKeys(sentence);
  if (own.size === 0) return null;
  let best: number | null = null;
  let bestScore = 0;
  notes.forEach((n, j) => {
    const keys = alignKeys(n);
    let common = 0;
    for (const k of own) if (keys.has(k)) common++;
    const score = common / own.size;
    if (score > bestScore || (score === bestScore && score > 0 && j === rank)) {
      best = j;
      bestScore = score;
    }
  });
  return bestScore >= MIN_ALIGN ? best : null;
}

/**
 * Le passage cité, étendu aux phrases entières de sa source (chaque morceau d'une preuve « approchée »).
 * Essai v9.4 : « until the day she meets Qifrey » sans le début de la phrase (« Coco is about to give up on
 * her dream ») faisait juger fausse une phrase juste. Source inconnue (la fiche), passage introuvable ou
 * phrases trop longues : le passage tel quel.
 */
export function expandPassage(proof: ProofMatch, sources: ReadonlyArray<{ label: string; text: string }>): string {
  const src = sources.find((x) => x.label === proof.label)?.text;
  if (!src) return proof.passage;
  const flat = src.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  const ends: number[] = []; // fin de chaque phrase de la source (index juste après le signe et ses guillemets)
  for (const m of flat.matchAll(/[.!?](?:["”»’)]+)?(?=\s+["“«(]?\p{Lu}|\s*$)/gu)) ends.push(m.index + m[0].length);
  const spans: Array<[number, number]> = [];
  for (const piece of proof.passage.split(/\s*…\s*/u).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const at = low.indexOf(piece.toLowerCase());
    if (at < 0) return proof.passage;
    const start = ends.filter((e) => e <= at).pop() ?? 0;
    const end = ends.find((e) => e >= at + piece.length) ?? flat.length;
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  const text = merged.map(([a, b]) => flat.slice(a, b).trim()).join(" … ");
  return text.length <= MAX_CHECK_PASSAGE ? text : proof.passage;
}

export type CheckVerdict = "OUI" | "NON" | "?";

export interface SentenceCheck {
  sentence: string;
  label: string; // v9.5 : source du passage (« Présentation », « Wikipédia : … », « Fiche ») ; « plusieurs sources » sans note correspondante
  passage: string;
  verdict: CheckVerdict; // « ? » : réponse illisible, la phrase est gardée
  why: string; // ce que le modèle dit faux (NON)
  // phrase NON : la correction proposée (`fixed`) ; gardée si confirmée, sinon la phrase reste et `unconfirmed` dit pourquoi
  fixed?: string;
  unconfirmed?: string;
}

/** Ce que le contrôle a fait d'un synopsis (essai à blanc, journaux, bloc du dashboard plus tard). */
export interface CheckReport {
  before: string; // le synopsis rédigé, avant le contrôle
  checks: SentenceCheck[];
  note: string | null; // contrôle impossible, ou correction en échec
  /**
   * v9.5 : le synopsis gardé, phrase par phrase, et pour chacune ce que le bloc du dashboard affiche
   * (verdict, source, passage, raison). `sentences.join(" ")` est le texte enregistré : le relecteur
   * touche exactement ces phrases, et la correction les reçoit telles quelles.
   */
  sentences: string[];
  rows: SentenceRow[];
}

/** Une phrase du synopsis gardé, telle que le bloc du dashboard la montre sous le texte. */
export interface SentenceRow {
  verdict: "confirmée" | "à vérifier" | "corrigée" | "illisible" | "non contrôlée";
  label: string;
  passage: string;
  why: string; // raison du contrôle (NON) ; vide sinon
  before?: string; // corrigée : la phrase d'avant
  rejected?: string; // à vérifier : pourquoi la correction n'a pas été gardée (et ce qu'elle proposait)
  asked?: boolean; // corrigée à la demande de Rey (bloc du dashboard), pas par le contrôle
}

/** Lignes du bloc pour des phrases contrôlées, une par phrase gardée (une correction en deux phrases en donne deux). */
export function rowsFor(checks: readonly SentenceCheck[], kept: readonly string[], reference: string): { sentences: string[]; rows: SentenceRow[] } {
  const sentences: string[] = [];
  const rows: SentenceRow[] = [];
  checks.forEach((c, i) => {
    const text = kept[i] ?? c.sentence;
    const fixed = c.fixed !== undefined && c.unconfirmed === undefined;
    const row: SentenceRow = {
      verdict: fixed ? "corrigée" : c.verdict === "NON" ? "à vérifier" : c.verdict === "?" ? "illisible" : "confirmée",
      label: c.label,
      passage: c.passage,
      why: c.verdict === "NON" ? c.why : "",
      ...(fixed ? { before: c.sentence } : {}),
      ...(c.unconfirmed !== undefined ? { rejected: c.fixed !== undefined ? `${c.unconfirmed} · proposée : ${c.fixed}` : c.unconfirmed } : {}),
    };
    const parts = splitSentences(text, reference);
    for (const part of parts.length ? parts : [text]) {
      sentences.push(part);
      rows.push(row);
    }
  });
  return { sentences, rows };
}

/** « OUI », « **NON** : … », « 1. NON - … » ; sinon « ? ». */
export function parseCheckAnswer(raw: string): { verdict: CheckVerdict; why: string } {
  const line = raw.trim().split("\n")[0] ?? "";
  const m = /^[\s*_«"]*(?:\d+\s*[.):-]\s*)?[\s*_«"]*(OUI|NON)\b[*_»"]*\s*[:,.\-–]?\s*(.*)$/i.exec(line);
  if (!m) return { verdict: "?", why: line.replace(/\s+/g, " ").trim().slice(0, 120) };
  let why = m[2]!.replace(/\s+/g, " ").replace(/[*_"]+$/, "").trim();
  if (why.endsWith("»") && !why.includes("«")) why = why.slice(0, -1).trim(); // « OUI » : le guillemet fermant seul
  return { verdict: m[1]!.toUpperCase() as CheckVerdict, why: why.slice(0, 200) };
}

/** Une phrase contre son passage : un appel, température 0. */
export async function checkSentence(
  cfg: SynopsisConfig,
  chat: ChatFn,
  sentence: string,
  passage: string | readonly string[],
): Promise<{ verdict: CheckVerdict; why: string }> {
  // plusieurs passages : la phrase ne correspond à aucune note (ajout de la rédaction) ; l'un d'eux doit la prouver
  const given = typeof passage === "string" ? `Passage : « ${passage} »` : `Passages (l'un d'eux doit prouver la phrase) :\n${passage.map((p) => `- « ${p} »`).join("\n")}`;
  const raw = await chat(
    cfg,
    [
      { role: "system", content: CHECK_PROMPT },
      { role: "user", content: `${given}\nPhrase : « ${sentence} »` },
    ],
    0,
    CHECK_TOKENS,
  );
  return parseCheckAnswer(raw);
}

/**
 * Contrôle d'un synopsis rédigé : chaque phrase contre la preuve de sa note. Les phrases NON sont corrigées
 * (correctSentences) ; une réécriture n'est gardée qu'avec sa preuve retrouvée et un 2e contrôle OUI. Sinon la
 * phrase reste telle quelle. Une phrase NON : à relire, avec une alerte qui dit laquelle et pourquoi.
 * Une OllamaError remonte ; une autre erreur de la correction laisse les phrases telles quelles, signalées.
 */
export async function verifySentences(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  outcome: Outcome,
  proofs: readonly ProofMatch[],
  chat: ChatFn,
  facts: ItemFacts | null = null,
  notes: readonly string[] = [],
): Promise<{ outcome: Outcome; report: CheckReport | null }> {
  if (!outcome.text || (outcome.status !== "auto" && outcome.status !== "to_review")) return { outcome, report: null };
  const source = cleanSource(item.description);
  const reference = [source, ...(facts?.dossier ?? []).map((e) => e.text)].join("\n");
  const sentences = splitSentences(outcome.text, reference);
  const alert = (o: Outcome, what: string): Outcome => ({ ...o, status: "to_review", note: clip([what, o.note].filter(Boolean).join(" · "), 255) });
  if (sentences.length === 0 || proofs.length === 0) {
    const note = `contrôle phrase / preuve impossible : ${sentences.length} phrase${sentences.length > 1 ? "s" : ""} pour ${proofs.length} note${proofs.length > 1 ? "s" : ""}`;
    return { outcome: alert(outcome, note), report: { before: outcome.text, checks: [], note, sentences, rows: [] } };
  }
  // v9.4.1 : chaque preuve étendue aux phrases entières de sa source ; chaque phrase avec la note qui lui
  // ressemble (sinon toutes les preuves, et la fiche : « Nioh 3 est un jeu d'action »)
  const fiche = [itemHeader(type, item), factsBlock(facts) ?? ""]
    .join("\n")
    .split("\n")
    .filter((l) => l.trim() && !/^\s*Personnages\b/i.test(l) && !/^Fiche\b/.test(l))
    .join(" ; ");
  const sources = [{ label: "Présentation", text: source }, ...(facts?.dossier ?? []).map((e) => ({ label: e.source, text: e.text }))];
  const passages = proofs.map((p) => expandPassage(p, sources));
  const named = notes.length === proofs.length ? notes : [];
  const checks: SentenceCheck[] = [];
  for (const [i, sentence] of sentences.entries()) {
    const j = named.length ? alignSentence(sentence, named, i) : i < passages.length ? i : null;
    const passage: string | string[] = j !== null ? passages[j]! : [...passages, fiche];
    const label = j !== null ? proofs[j]!.label : "plusieurs sources";
    checks.push({ sentence, label, passage: typeof passage === "string" ? passage : passage.join(" / "), ...(await checkSentence(cfg, chat, sentence, passage)) });
  }
  const flagged = checks.flatMap((c, i) => (c.verdict === "NON" ? [i] : []));
  if (flagged.length === 0) return { outcome, report: { before: outcome.text, checks, note: null, ...rowsFor(checks, sentences, reference) } };

  const corr = await correctSentences(cfg, type, item, sentences, flagged, chat, facts).catch((err: unknown) => {
    if (err instanceof OllamaError) throw err;
    return { status: "failed" as const, fixes: [] as SentenceFix[], note: `correction : ${errMessage(err)}` };
  });
  const kept: string[] = [];
  for (const [i, sentence] of sentences.entries()) {
    const c = checks[i]!;
    if (!flagged.includes(i)) {
      kept.push(sentence);
      continue;
    }
    const fix = corr.status === "corrected" ? corr.fixes.find((f) => f.index === i) : undefined;
    // réécriture gardée seulement avec une preuve retrouvée (pas « aucune », pas introuvable) et un 2e contrôle OUI
    if (fix && fix.text !== null && fix.found && fix.found.label !== "aucune") {
      c.fixed = fix.text;
      const again = await checkSentence(cfg, chat, fix.text, expandPassage(fix.found, sources));
      if (again.verdict !== "NON") {
        kept.push(fix.text);
        continue;
      }
      c.unconfirmed = `correction non confirmée : ${again.why || "NON"}`;
    } else if (fix && fix.text !== null) {
      c.fixed = fix.text;
      c.unconfirmed = "correction sans preuve retrouvée";
    } else {
      c.unconfirmed = fix ? "la correction propose de la supprimer" : corr.status === "corrected" ? "la correction ne l'a pas réécrite" : "correction refusée";
    }
    kept.push(sentence); // telle quelle, signalée au relecteur
  }
  const report: CheckReport = { before: outcome.text, checks, note: corr.status === "corrected" ? null : corr.note, ...rowsFor(checks, kept, reference) };
  const fixedIdx = checks.flatMap((c, i) => (c.fixed !== undefined && c.unconfirmed === undefined ? [i + 1] : []));
  const doubtIdx = checks.flatMap((c, i) => (c.unconfirmed !== undefined ? [i + 1] : []));
  const why = (i: number) => clip(checks[i - 1]!.why || "NON", 60);
  const what = [
    fixedIdx.length ? `phrase${fixedIdx.length > 1 ? "s" : ""} ${fixedIdx.join(", ")} corrigée${fixedIdx.length > 1 ? "s" : ""}` : "",
    ...doubtIdx.map((i) => `phrase ${i} non confirmée (${why(i)})`),
    // alertes de la correction sur les phrases gardées (preuve approchée…)
    ...(fixedIdx.length && corr.status === "corrected" ? corr.warnings.slice(0, 1) : []),
  ]
    .filter(Boolean)
    .join(" ; ");
  return { outcome: alert({ ...outcome, text: kept.join(" ").trim() }, `contrôle : ${what}`), report };
}
