/**
 * synopsis.ts — synopsis français rédigés en local par Ollama (v8.1).
 *
 * `description` garde le texte des sources (AniList, IGDB…) et ne sert plus
 * que d'entrée. Ollama en tire un synopsis original en français, rangé dans
 * `synopsis_fr` (migration 014) : la seule colonne que le site affichera.
 *
 * Quatre temps, pour comprendre l'œuvre, écrire avec nos mots, puis vérifier :
 *   0. se renseigner : le module monte une fiche (personnages, genre, rôle,
 *      œuvre précédente ou série, genres IGDB, thèmes AniList) et un dossier
 *      (Wikipédia, extraits Google via Serper, histoire IGDB, résumé de
 *      l'œuvre précédente). Le modèle
 *      local n'a pas Internet et sa mémoire mélange le vrai et le faux : ce qui
 *      est vrai, c'est ce que le dossier confirme ;
 *   1. sens et notes : le modèle redit d'abord le texte de présentation en
 *      anglais simple, avec ses mots (« Sens »), puis en tire des notes
 *      françaises télégraphiques, personnages nommés, complétées par le
 *      dossier. Comprendre dans la langue du texte évite les contresens de
 *      traduction (essai v5 : « washout student » devenu « étudiant rejeté par
 *      une académie »). Le dossier n'est pas redit : le redire ajoutait des
 *      erreurs (essai v7 : Tanya II) et du temps ;
 *   2. rédaction : il écrit le synopsis à partir des seules notes (et du genre
 *      des personnages qu'elles citent), sans revoir le texte d'origine ;
 *   3. relecture : le synopsis est comparé aux sources, à la recherche d'un rôle
 *      inversé, d'un lien inventé, d'une confusion ou de l'histoire de l'œuvre
 *      précédente (essai v7 : « un empire a déclaré la guerre à la Fédération »,
 *      alors que c'est l'inverse). Une erreur signalée est corrigée une fois ;
 *      si elle reste signalée, le texte part en relecture humaine.
 * Les items passent par paquets : les notes de tout le paquet d'abord (Ollama garde en
 * cache la partie fixe de leur prompt), puis rédaction et relecture item par item. La
 * relecture intercalée oblige Ollama à relire la consigne de rédaction (≈ 1 100 jetons
 * par item) : si la ligne TEMPS de l'essai montre que c'est cher, tout rédiger puis tout relire.
 *
 * - Ne remplit que les lignes vides : un synopsis relu ou écrit à la main n'est
 *   jamais régénéré. Pour en refaire un : synopsis_fr = NULL, synopsis_status = NULL.
 * - Ni date ni plateformes dans le texte : elles changent, et la fiche les
 *   affiche déjà (une seule source de vérité).
 * - Longueur proportionnelle aux notes : une source pauvre donne un synopsis
 *   court, plutôt qu'un texte rallongé de détails inventés.
 * - Fiche indisponible (pas d'identifiant, API en panne) : on continue sans.
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
 *   même chose pour un texte trop long ou signalé par la relecture.
 * - Tourne dans une fenêtre horaire (heure de Paris). Si Ollama ne répond pas,
 *   le passage s'arrête sans toucher aux items.
 * - Ne modifie pas `updated_at`.
 * - Essai à blanc, sans rien écrire en base : synopsis-essai.ts.
 *
 * Branchement (index.ts, à côté du démarrage des autres crons) :
 *   import { startSynopsisCron } from "./gamenime/synopsis.js";
 *   startSynopsisCron({ pool, log: app.log });
 *
 * Variables d'environnement (service content-api) :
 *   SYNOPSIS_ENABLED      "1" pour activer (défaut "0")
 *   OLLAMA_URL            défaut http://ollama:11434
 *   SYNOPSIS_MODEL        défaut ministral-3:8b
 *   SYNOPSIS_WINDOW       heures de Paris « début-fin », défaut 3-7 ; 0-24 = toujours
 *   SYNOPSIS_MAX_PER_RUN  items par passage, défaut 300
 *   SYNOPSIS_REVIEW_TOP   les N plus populaires de la fenêtre de 2 ans passent en relecture, défaut 25
 *   SYNOPSIS_THREADS      cœurs donnés à Ollama, défaut 4 (= « cpus » du service ollama)
 *   TWITCH_CLIENT_ID/SECRET (déjà présents) : accès IGDB pour la fiche des jeux
 *   Wikipédia : API publique sans clé (en.wikipedia.org), joignable depuis le conteneur
 *   SERPER_API_KEY        recherche Google via serper.dev (sans clé : pas de recherche web)
 */
import { setInterval, setTimeout } from "node:timers";
import { z } from "zod";
import { igdbFetch } from "./twitch.js";

// ─── Types et dépendances ────────────────────────────────────────────────────

export type ItemType = "anime" | "game";
export type SynopsisStatus = "auto" | "to_review" | "approved" | "failed" | "no_source";

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
  refused: string[]; // pourquoi il a été refait ou écarté (contrôles, longueur, relecture)
  review: string[] | null; // remarques de la relecture ; [] = rien à redire ; null = pas relu ou pas de réponse
}

export interface Outcome {
  status: Exclude<SynopsisStatus, "approved">;
  text: string | null;
  note: string | null;
  /** Statut failed : dernière réponse refusée (journaux et essai à blanc, jamais enregistrée). */
  rejected?: string;
  /** Essais dans l'ordre ; le texte gardé est le dernier essai qui porte ce texte. */
  attempts?: Attempt[];
  /** Relecture du texte gardé : remarques ([] = rien à redire, null = pas de réponse). */
  review?: string[] | null;
  reviewMs?: number; // temps passé en relecture
}

export interface RunReport {
  processed: number;
  auto: number;
  toReview: number;
  failed: number;
  noSource: number;
  stop: "done" | "window" | "ollama";
  durationS: number;
  tokens: { input: number; output: number };
  error?: string;
}

// ─── Réglages ────────────────────────────────────────────────────────────────

const FIRST_TICK_MS = 2 * 60_000; // premier passage 2 min après le démarrage
const TICK_MS = 10 * 60_000; // puis vérification toutes les 10 min
const OLLAMA_TIMEOUT_MS = 240_000; // sous les 300 s de fetch (undici)
const FACTS_TIMEOUT_MS = 15_000; // AniList, IGDB
const RETRY_DAYS = 7; // délai avant de retenter failed / no_source
const CHUNK = 8; // items par paquet (notes du paquet, puis rédaction)

const MIN_SOURCE = 60; // en dessous : pas de texte exploitable
const RETRY_NOTES_SOURCE = 150; // source « vide » selon le modèle mais au moins aussi longue : notes redemandées
const MAX_SOURCE = 1500; // texte source tronqué au-delà
const MAX_NOTES = 6;
const MAX_MAIN = 4; // personnages principaux dans la fiche
const MAX_OTHERS = 4; // personnages secondaires dans la fiche
const HARD_MIN = 50; // plus court : refusé (une source pauvre donne une phrase, pas rien)
const HARD_MAX = 550;
const SOFT_MAX = 420; // au-delà : relecture
const COPY_RUN = 6; // 6 mots consécutifs communs avec la source = copie
const TEMPERATURES = [0.1, 0.2] as const; // rédaction : 1er essai, puis correction après refus
const NOTES_TOKENS = 500; // étape 1 : sens (4 lignes) + notes (6 lignes)
const WRITE_TOKENS = 300;
const REVIEW_TOKENS = 160; // étape 3 : « OK », ou trois remarques au plus
const MAX_REVIEW = 3;
const MAX_SENSE = 8; // lignes de « Sens » gardées pour l'affichage
// fenêtre du modèle : consigne + exemples (~2 300 jetons), fiche, dossier et texte (~1 300), réponse (500)
const NUM_CTX = 5120;

// Dossier : de quoi se renseigner sans dépasser la fenêtre du modèle (NUM_CTX)
const MIN_TAG_RANK = 60; // thèmes AniList : pertinence minimale (0-100)
const MAX_TAGS = 8;
const MAX_PREQUEL_TEXT = 700; // résumé de l'œuvre précédente (saison ou film)
const MAX_IGDB_TEXT = 700; // histoire ou résumé IGDB
const MAX_WIKI_INTRO = 600; // Wikipédia : début de l'article
const MAX_WIKI_STORY = 800; // Wikipédia : début de l'intrigue, du synopsis ou du cadre
const MAX_WIKI_GAMEPLAY = 400; // Wikipédia : début du gameplay (jeux)
const MAX_WEB_TEXT = 900; // extraits de la recherche Google
const MAX_WEB_RESULTS = 6;
const MAX_DOSSIER = 2400; // tout le dossier
// SYNOPSIS_SERPER_URL : pour les tests (faux serveur) ; la clé vient de SERPER_API_KEY
const SERPER_URL = process.env["SYNOPSIS_SERPER_URL"] || "https://google.serper.dev/search";
// SYNOPSIS_WIKIPEDIA_URL : pour les tests (faux serveur) ; en production, l'API anglaise
const WIKI_API = process.env["SYNOPSIS_WIKIPEDIA_URL"] || "https://en.wikipedia.org/w/api.php";
const WIKI_AGENT = "GameNime/1.0 (https://gamenime.fr; synopsis)"; // règle de Wikimedia : un User-Agent qui identifie l'outil

const TABLES: Record<ItemType, { table: string; kind: string; ext: string }> = {
  anime: { table: "anime_items", kind: "format", ext: "anilist_id" },
  game: { table: "game_items", kind: "game_type", ext: "igdb_id" },
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

/** Config lue dans l'environnement ; null si le module est désactivé. Lève une erreur si une valeur est invalide. */
export function readConfig(env: Record<string, string | undefined>): SynopsisConfig | null {
  const e = EnvSchema.parse(env);
  if (e.SYNOPSIS_ENABLED !== "1") return null;
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
}

/** Fiche, ou pourquoi elle manque (« pas d'identifiant AniList », « IGDB HTTP 401 »…). */
export interface FactsResult {
  facts: ItemFacts | null;
  note: string | null;
  wikiTitle?: string | null; // jeux : article Wikipédia indiqué par IGDB
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

const ANILIST_URL = "https://graphql.anilist.co";

const ANILIST_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    characters(sort: [ROLE, RELEVANCE, ID], perPage: 12) { edges { role node { name { full } gender } } }
    relations { edges { relationType(version: 2) node { type title { romaji english } description(asHtml: false) } } }
    tags { name rank isMediaSpoiler isGeneralSpoiler }
  }
}`;

const AniListFactsResponse = z.object({
  data: z
    .object({
      Media: z
        .object({
          characters: z
            .object({
              edges: z
                .array(
                  z.object({
                    role: z.string().nullish(),
                    node: z.object({ name: z.object({ full: z.string().nullish() }).nullish(), gender: z.string().nullish() }).nullish(),
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
});

export async function fetchAniListFacts(anilistId: number, url = ANILIST_URL): Promise<FactsResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: anilistId } }),
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
  } catch (err) {
    return { facts: null, note: `AniList injoignable : ${errMessage(err)}` };
  }
  if (!res.ok) return { facts: null, note: `AniList HTTP ${res.status}` };
  const parsed = AniListFactsResponse.safeParse(await res.json().catch(() => null));
  const media = parsed.success ? parsed.data.data?.Media : null;
  if (!media) return { facts: null, note: "réponse d'AniList illisible" };

  const main: Character[] = [];
  const others: Character[] = [];
  const seen = new Set<string>();
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
  if (prequelTitle && previous.length >= MIN_SOURCE) dossier.push({ source: `Œuvre précédente (AniList) : ${prequelTitle}`, text: previous });
  return { facts: { characters: [...main, ...others], prequel: prequelTitle, series: null, genres: [], tags, dossier }, note: null };
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
    websites: z.array(z.object({ url: z.string().nullish() })).nullish(),
  }),
);

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
    const gameRes = await post(
      "games",
      `fields collections.name, franchises.name, genres.name, themes.name, game_modes.name, summary, storyline, websites.url; where id = ${igdbId};`,
    );
    if (!gameRes.ok) return { facts: null, note: `IGDB HTTP ${gameRes.status}` };
    const games = IgdbGamesResponse.safeParse(await gameRes.json().catch(() => null));
    const game = games.success ? games.data[0] : undefined;
    const series = game?.collections?.[0]?.name?.trim() || game?.franchises?.[0]?.name?.trim() || null;
    // ce que le jeu est vraiment (essai v5 : Path of Exile 2 présenté comme un « MMORPG »)
    const genres = [
      ...new Set([...(game?.genres ?? []), ...(game?.themes ?? []), ...(game?.game_modes ?? [])].map((g) => g.name?.trim() ?? "").filter(Boolean)),
    ];
    const dossier: DossierEntry[] = [];
    const storyline = clipText(cleanSource(game?.storyline ?? null), MAX_IGDB_TEXT);
    if (storyline.length >= MIN_SOURCE) dossier.push({ source: "Histoire (IGDB)", text: storyline });
    const summary = clipText(cleanSource(game?.summary ?? null), MAX_IGDB_TEXT);
    if (summary.length >= MIN_SOURCE) dossier.push({ source: "Résumé (IGDB)", text: summary });
    const wikiTitle = (game?.websites ?? []).map((w) => wikiTitleFromUrl(w.url ?? "")).find((t) => t !== null) ?? null;

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

/**
 * Article qui correspond le mieux à l'un des titres : identique (3), qui le prolonge (2), qui en contient
 * tous les mots (1). Sans l'article de tête : essai v7, « Saga of Tanya the Evil » tombait sur l'article
 * du film (qui le prolonge) au lieu de « The Saga of Tanya the Evil », la série.
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

/**
 * Ce qu'on garde d'un article : le début (de quoi il s'agit), le début de l'intrigue,
 * du synopsis ou du cadre (le point de départ, pas la fin), et pour un jeu le début du gameplay.
 */
export function wikiDossierText(extract: string, type: ItemType): string {
  const sections: Array<{ heading: string; level: number; lines: string[] }> = [{ heading: "", level: 1, lines: [] }];
  for (const line of extract.split("\n")) {
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
    const text = wikiDossierText(page.extract, type);
    return text.length >= MIN_SOURCE ? { entry: { source: `Wikipédia : ${page.title}`, text }, note: null } : { entry: null, note: "article Wikipédia trop court" };
  } catch (err) {
    return { entry: null, note: `Wikipédia injoignable : ${errMessage(err)}` };
  }
}

// ─── Recherche Google (Serper) ───────────────────────────────────────────────
// Google ne laisse plus un programme interroger son moteur (API fermée aux nouveaux
// inscrits) : Serper renvoie ses résultats. On garde le panneau de connaissances et
// les extraits des premiers résultats, sauf réseaux sociaux et forums, où circulent
// rumeurs et fausses fuites (surtout pour les jeux pas encore sortis).

const WEB_EXCLUDED =
  /(?:^|\.)(?:reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|quora\.com|4chan\.org|4channel\.org|discord\.(?:com|gg)|steamcommunity\.com|resetera\.com|neogaf\.com|tumblr\.com|threads\.net|bsky\.app|gamenime\.fr)$/i;

const SerperResponse = z.object({
  knowledgeGraph: z.object({ title: z.string().nullish(), type: z.string().nullish(), description: z.string().nullish() }).nullish(),
  organic: z.array(z.object({ title: z.string().nullish(), link: z.string().nullish(), snippet: z.string().nullish() })).nullish(),
});

export interface WebResult {
  entry: DossierEntry | null;
  note: string | null; // pourquoi il n'y a pas d'extraits
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Titres qui désignent l'œuvre : la série pour un animé, le titre entier pour un jeu. */
function workTitles(type: ItemType, item: ItemRow): string[] {
  const shown = item.title_english?.trim() || item.title;
  const all = type === "game" ? [shown] : [...baseTitles(shown), ...baseTitles(item.title)];
  return all.filter((x, i) => x.length > 0 && all.findIndex((y) => titleKey(y) === titleKey(x)) === i);
}

/** Un résultat parle de l'œuvre s'il en cite un mot distinctif (4 lettres au moins). */
function aboutWork(text: string, titles: readonly string[]): boolean {
  const words = new Set(titleKey(text).split(" "));
  return titles.some((t) =>
    titleKey(t)
      .split(" ")
      .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w))
      .some((w) => words.has(w)),
  );
}

/** « Apr 17, 2026 — Pragmata is… » → « Pragmata is… » : la date du résultat n'est pas un fait de l'œuvre. */
function cleanSnippet(s: string): string {
  return s
    .replace(/^\s*(?:\d{1,2} [A-Z][a-z]{2,8},? \d{4}|[A-Z][a-z]{2,8} \d{1,2}, \d{4}|\d+ (?:days?|hours?|weeks?|months?) ago)\s*[—–-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Recherche web active : la clé Serper est dans l'environnement du conteneur. */
export function webSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env["SERPER_API_KEY"]?.trim());
}

/** Recherche Google de l'œuvre (via Serper). Sans clé SERPER_API_KEY : rien, sans bruit. Ne lève jamais d'erreur. */
export async function fetchWebSearch(
  type: ItemType,
  item: ItemRow,
  apiKey = process.env["SERPER_API_KEY"] ?? "",
  url = SERPER_URL,
): Promise<WebResult> {
  if (!apiKey.trim()) return { entry: null, note: null };
  const titles = workTitles(type, item);
  const q = `${item.title_english?.trim() || item.title} ${type === "game" ? "video game" : "anime"}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey.trim(), "content-type": "application/json" },
      body: JSON.stringify({ q, gl: "us", hl: "en", num: 10 }),
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!res.ok) return { entry: null, note: `recherche web HTTP ${res.status}` };
    const parsed = SerperResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { entry: null, note: "recherche web illisible" };
    const lines: string[] = [];
    const seen = new Set<string>();
    const add = (label: string, text: string) => {
      const t = cleanSnippet(text);
      const key = titleKey(t).slice(0, 60);
      if (t.length < 40 || seen.has(key)) return;
      seen.add(key);
      lines.push(`[${label}] ${t}`);
    };
    // le panneau de connaissances, seulement s'il porte sur l'œuvre (pas sur un homonyme : « Requiem », œuvre musicale)
    const kg = parsed.data.knowledgeGraph;
    const kindOk = !kg?.type || (type === "game" ? /game/i : /anime|manga|series|animat|novel|film|movie/i).test(kg.type);
    if (kg?.title && kg.description && kindOk && bestWikiTitle([kg.title], titles)) add(kg.type ? `${kg.title}, ${kg.type}` : kg.title, kg.description);
    for (const r of parsed.data.organic ?? []) {
      if (lines.length >= MAX_WEB_RESULTS) break;
      const host = hostOf(r.link ?? "");
      if (!host || WEB_EXCLUDED.test(host) || !r.snippet) continue;
      if (!aboutWork(`${r.title ?? ""} ${r.snippet}`, titles)) continue;
      add(host, r.snippet);
    }
    if (lines.length === 0) return { entry: null, note: "recherche web sans résultat utile" };
    return { entry: { source: "Google (extraits)", text: clipText(lines.join("\n"), MAX_WEB_TEXT) }, note: null };
  } catch (err) {
    return { entry: null, note: `recherche web injoignable : ${errMessage(err)}` };
  }
}

/** Dossier sans doublon du texte de présentation (le résumé IGDB est souvent le même), dans la limite de taille. */
export function trimDossier(entries: readonly DossierEntry[], description: string | null): DossierEntry[] {
  const own = titleKey(cleanSource(description)).slice(0, 80);
  const out: DossierEntry[] = [];
  let room = MAX_DOSSIER;
  for (const e of entries) {
    const key = titleKey(e.text).slice(0, 80);
    if (own.length >= 40 && (own.startsWith(key.slice(0, 40)) || key.startsWith(own.slice(0, 40)))) continue;
    if (room < MIN_SOURCE) break;
    const text = clipText(e.text, room);
    out.push({ source: e.source, text });
    room -= text.length;
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
  wikipedia?: (type: ItemType, item: ItemRow, known: string | null) => Promise<WikiResult>;
  web?: (type: ItemType, item: ItemRow) => Promise<WebResult>;
}

/**
 * Se renseigner sur l'item avant de lire : fiche AniList (animés) ou IGDB (jeux), puis
 * Wikipédia et Google, réunis en un dossier. Ne lève jamais d'erreur ; ce qui manque est noté.
 */
export async function gatherFacts(type: ItemType, item: ItemRow, sources: FactsSources = {}): Promise<FactsResult> {
  const anilist = sources.anilist ?? ((id: number) => fetchAniListFacts(id));
  const igdb = sources.igdb ?? ((id: number) => fetchIgdbFacts(id));
  const wikipedia = sources.wikipedia ?? ((t: ItemType, it: ItemRow, known: string | null) => fetchWikipedia(t, it, known));
  const web = sources.web ?? ((t: ItemType, it: ItemRow) => fetchWebSearch(t, it));
  const base: FactsResult = item.ext_id
    ? await (type === "anime" ? anilist(item.ext_id) : igdb(item.ext_id))
    : { facts: null, note: type === "anime" ? "pas d'identifiant AniList" : "pas d'identifiant IGDB" };
  const wiki = await wikipedia(type, item, base.wikiTitle ?? null);
  const google = await web(type, item);
  const fiche = base.facts ?? { characters: [], prequel: null, series: null, genres: [], tags: [], dossier: [] };
  const found = [...(wiki.entry ? [wiki.entry] : []), ...(google.entry ? [google.entry] : []), ...fiche.dossier];
  const dossier = trimDossier(found, item.description);
  const note = [base.note, wiki.note, google.note].filter((n): n is string => Boolean(n)).join(" · ") || null;
  return { facts: base.facts || dossier.length ? { ...fiche, dossier } : null, note };
}

/** Fiche et dossier de l'item. Ne lève jamais d'erreur. */
export const fetchFacts: FactsFn = (type, item) => gatherFacts(type, item);

function characterLabel(c: Character): string {
  return c.gender ? `${c.name} (${c.gender})` : c.name;
}

/** Fiche telle que le modèle la lit avant le texte ; null si elle est vide. */
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
  if (facts.tags.length) lines.push(`Thèmes (AniList) : ${facts.tags.join(", ")}`);
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

On te donne parfois une fiche de données vérifiées (personnages et leur genre, œuvre précédente, série, genres, thèmes) et un dossier de recherche (Wikipédia, extraits de résultats Google, IGDB, AniList), puis le texte de présentation de l'œuvre, souvent en anglais. Sers-toi de la fiche et du dossier pour savoir qui est qui et ce qui est vrai. Ta réponse a deux parties.

Sens :
Ce que dit le texte de présentation, en anglais simple et avec tes mots : 4 lignes au plus, chacune commençant par « - ». Explique les tournures au lieu de les recopier : « her days are numbered » devient « she will die soon ». Signale les slogans comme tels. Ne redis pas le dossier.

Notes :
Les faits à retenir, en français, tirés du sens et du dossier.
- 2 à 6 notes, une par ligne, chacune commençant par « - ».
- Style télégraphique : 15 mots au plus par note.
- Seulement le point de départ : personnages principaux, cadre, situation initiale, enjeu. Pour un jeu sans histoire : genre, cadre, série, ce que propose le jeu.
- Le texte de présentation décrit cette œuvre précise (cette saison, ce jeu) : il passe en premier. Le dossier le complète avec des faits vrais, et donne le point de départ si le texte n'en dit presque rien.
- L'œuvre précédente (saison ou film d'avant) raconte ce qui s'est passé avant : ne présente jamais son histoire comme celle de cette œuvre.
- Pour une suite, le dossier décrit souvent le début de la série : garde le cadre et les héros, mais une situation qui a pu changer depuis ne se note que si le texte de présentation la confirme.
- Si deux sources se contredisent, crois le texte de présentation et Wikipédia plutôt que les extraits Google. Un extrait qui parle d'une autre œuvre (homonyme, autre saison) ne compte pas.
- Du dossier, garde l'histoire et ce que propose le jeu : ni date de sortie, ni plateformes, ni ventes, ni critiques, ni récompenses, ni studios ou éditeurs.
- Rien qui dévoile la suite de l'histoire : ni rebondissement, ni mort, ni fin.
- Chaque note nomme les personnages dont elle parle, jamais de pronom seul : « Maelis rejoint les contrebandiers », pas « elle les rejoint ».
- Une action dit qui la fait et à qui : « le conseil efface la mémoire des habitants », pas « mémoire effacée ». Garde qui fait quoi à qui, sans inverser les rôles ni le sens d'une phrase. Les notes ne se contredisent pas.
- Le genre d'un personnage est celui de la fiche ; sans fiche, celui des pronoms du texte ou du dossier (« he » = il, « she » = elle). Un « witch » masculin est un sorcier.
- Noms propres : orthographe du texte, sans traduction (personnages, lieux, groupes, écoles, événements, techniques).
- Ne cite que les personnages utiles au point de départ.
- Uniquement ce que disent le texte, la fiche et le dossier : ce qui n'y figure pas ne s'écrit pas, même si tu crois le savoir. Ni formule publicitaire. Une phrase dont le sens n'est pas sûr ne donne pas de note.
- Le genre d'un jeu ne s'écrit que s'il figure dans le texte, les genres ou le dossier.
- Une année ou une époque ne se note que si le texte ou le dossier la donne comme cadre de l'histoire, jamais comme date de sortie.

Si ni le texte ni le dossier ne contiennent de fait sur l'œuvre (seulement des slogans), écris le sens, puis en notes seulement : - (rien)`;

/** Deuxième demande quand le modèle a répondu « (rien) » sur une source assez longue. */
export const NOTES_RETRY = `Relis le texte : il indique sans doute au moins le genre, le cadre, la série ou ce que propose l'œuvre. Relève ces faits en notes, sans rien inventer. Réponds - (rien) seulement s'il n'y a vraiment aucun fait.`;

/**
 * Étape 3 : relecture du synopsis contre les sources. Seulement les erreurs de fond qu'aucun
 * contrôle par mots ne voit (essai v7) : rôle inversé (Tanya II : « un empire a déclaré la guerre
 * à la Fédération », c'est l'inverse), lien inventé (Witch Hat : la mère changée en pierre « après
 * le Day of the Pact »), confusion (Classroom : les nouveaux de première année « rejoignent la
 * classe »), histoire de l'œuvre précédente (le film de Tanya raconté comme la saison 2). Pas les
 * détails absents des sources : un petit modèle signalerait à tort chaque reformulation.
 */
export const REVIEW_PROMPT = `Tu relis un synopsis avant sa publication sur GameNime, un site français d'animés et de jeux vidéo.

On te donne l'œuvre, ses sources (fiche, dossier, texte de présentation, souvent en anglais), puis le synopsis en français. Cherche seulement les erreurs de fond :
- rôles inversés : le synopsis dit qui fait quoi à qui autrement que les sources ;
- lien inventé : le synopsis relie deux faits par une cause, un but ou un moment que les sources ne donnent pas ;
- confusion : un personnage, un lieu ou un groupe pris pour un autre, ou un fait que les sources contredisent ;
- mauvaise œuvre : l'histoire de l'œuvre précédente racontée comme celle de cette œuvre.
Un détail absent des sources, le style, la longueur et les noms laissés en anglais ne sont pas des erreurs de fond. Si les sources se contredisent, le texte de présentation et Wikipédia font foi.

Si le synopsis n'a aucune erreur de fond, réponds seulement : OK
Sinon, une ligne par erreur, trois au plus : - « passage du synopsis » : ce que disent les sources`;

export const WRITE_PROMPT = `Tu rédiges les synopsis de GameNime, un site français qui annonce les sorties d'animés et de jeux vidéo.

On te donne le titre d'une œuvre, parfois le genre de ses personnages, des notes et une longueur. Écris en français un synopsis qui présente le point de départ de l'œuvre, en respectant la longueur demandée.

Règles :
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

Réponds uniquement par le synopsis.`;

export interface Example {
  header: string;
  facts: ItemFacts | null;
  source: string;
  sense: readonly string[]; // étape 1, première partie : le texte redit en anglais simple
  notes: readonly string[];
  synopsis: string;
}

/**
 * Une source riche, une moyenne, une suite décrite en une ligne, une pauvre ; avec et sans fiche.
 * Le sens ne redit que le texte de présentation ; les notes prennent aussi dans le dossier.
 */
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
      tags: ["Magic", "Conspiracy"],
      dossier: [],
    },
    source:
      "In the floating city of Verlune, magic is fueled by the memories of those who cast it. Teenage archivist Maelis Corvin discovers that the city's council has been secretly erasing citizens' memories to keep the city afloat. When her own brother forgets her name, she joins a band of smugglers determined to expose the truth. Experience the most breathtaking fantasy of the season!",
    sense: [
      "Verlune is a city that floats; its magic runs on the memories of the people who use it.",
      "Maelis Corvin, a teenage archivist, finds out that the council secretly wipes people's memories to keep Verlune in the air.",
      "Maelis's brother forgets her name, so Maelis joins smugglers who want to reveal the truth.",
      "The last sentence is an advertising slogan.",
    ],
    // chaque lien du synopsis (« découvre que », « pour », « quand ») est dans une note : la règle
    // « aucun lien qu'aucune note ne donne » ne doit pas être démentie par l'exemple
    notes: [
      "cité flottante de Verlune",
      "magie alimentée par les souvenirs de ceux qui la pratiquent",
      "Maelis Corvin, jeune archiviste",
      "Maelis Corvin découvre que le conseil efface en secret la mémoire des habitants",
      "but du conseil : garder Verlune en l'air",
      "quand son frère oublie son prénom, Maelis rejoint des contrebandiers décidés à révéler la vérité",
    ],
    synopsis:
      "Dans la cité flottante de Verlune, la magie se nourrit des souvenirs de ceux qui la pratiquent. La jeune archiviste Maelis Corvin découvre que le conseil efface en secret la mémoire des habitants pour garder la cité en l'air. Quand son propre frère oublie son prénom, elle rejoint des contrebandiers décidés à révéler la vérité.",
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
    sense: [
      "Hadal Station is a survival game set under the sea; \"tense\" is advertising.",
      "The player is a maintenance engineer stuck in a flooded research base at the bottom of the ocean.",
      "The engineer has to repair the systems, watch the oxygen and get out before the base falls apart.",
    ],
    notes: [
      "jeu de survie sous-marin",
      "le joueur incarne Mara Okafor, ingénieure de maintenance",
      "Mara Okafor est bloquée dans une base de recherche à 9 000 mètres sous le Pacifique",
      "un séisme a inondé la base",
      "Mara Okafor doit réparer les systèmes, gérer son oxygène et fuir avant l'effondrement",
    ],
    synopsis:
      "Hadal Station est un jeu de survie sous-marin. Le joueur incarne Mara Okafor, ingénieure de maintenance bloquée à 9 000 mètres sous le Pacifique dans une base de recherche inondée par un séisme : elle doit réparer les systèmes, gérer son oxygène et fuir avant l'effondrement de la station.",
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
      tags: ["Urban Fantasy", "Monsters"],
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
    sense: ["This is the second season of Lanterns of Ombrevale; the text says nothing else."],
    notes: [
      "deuxième saison de Lanterns of Ombrevale",
      "cité d'Ombrevale, où la nuit dure la moitié de l'année",
      "Sorel Vance, jeune allumeur de réverbères, enferme les ombres dans ses lanternes",
      "Sorel Vance sert la Lantern Watch, ordre qui protège la cité des ombres vivantes",
    ],
    synopsis:
      "Deuxième saison de Lanterns of Ombrevale. Dans la cité d'Ombrevale, où la nuit dure la moitié de l'année, le jeune allumeur de réverbères Sorel Vance enferme les ombres dans ses lanternes et sert la Lantern Watch, l'ordre qui protège la ville des ombres vivantes.",
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
    sense: [
      "\"The legend returns\" is a slogan.",
      "Iron Tide 3 is the third game of Iron Tide, a series of naval strategy games.",
      "It takes place in the frozen seas of Norvaal; \"bigger, bolder, more beautiful\" is advertising.",
    ],
    notes: ["troisième épisode de la série de stratégie navale Iron Tide", "cadre : Norvaal, archipel gelé que se disputent trois amirautés"],
    synopsis: "Iron Tide 3, troisième épisode de la série de stratégie navale Iron Tide, se déroule à Norvaal, un archipel gelé que se disputent trois amirautés.",
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
  if (item.genre?.trim()) lines.push(`Genres : ${item.genre.trim()}`);
  return lines.join("\n");
}

function bullets(notes: readonly string[]): string {
  return notes.map((n) => `- ${n}`).join("\n");
}

/** Réponse attendue à l'étape 1 : le sens en anglais simple, puis les notes. */
function notesAnswer(sense: readonly string[], notes: readonly string[]): string {
  return `Sens :\n${bullets(sense)}\nNotes :\n${bullets(notes)}`;
}

/** Longueur demandée selon le nombre de notes : peu de faits, peu de phrases. */
export function lengthHint(noteCount: number): string {
  if (noteCount <= 2) return "1 phrase, 180 caractères au plus";
  if (noteCount <= 4) return "2 phrases, 280 caractères au plus";
  return "2 ou 3 phrases, 350 caractères au plus";
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
    messages.push({ role: "user", content: notesRequest(ex.header, ex.facts, ex.source) }, { role: "assistant", content: notesAnswer(ex.sense, ex.notes) });
  }
  messages.push({ role: "user", content: notesRequest(itemHeader(type, item), facts, source) });
  return messages;
}

function writeRequest(header: string, facts: ItemFacts | null, notes: readonly string[]): string {
  return [header, gendersLine(facts, notes), `Notes :\n${bullets(notes)}`, `Longueur : ${lengthHint(notes.length)}`]
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
  if (reason.startsWith("trop long (")) return `${reason} : raccourcis-le à 350 caractères au plus en gardant l'essentiel`;
  // le rédacteur ne voit que les notes, et l'erreur peut venir d'une note : la remarque fait foi
  if (reason.startsWith("relecture : ")) return `${reason} (corrige ce passage d'après cette remarque, même si une note dit autrement)`;
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
    messages.push({ role: "user", content: writeRequest(ex.header, ex.facts, ex.notes) }, { role: "assistant", content: ex.synopsis });
  }
  let last = writeRequest(itemHeader(type, item), facts, notes);
  if (refused.length) {
    const title = item.title_english?.trim() || item.title;
    const reasons = refused.map((r) => retryAdvice(r, type, title)).join(" ; ");
    last += previous.trim()
      ? `\n\nTa réponse précédente :\n${previous.trim()}\nElle a été refusée : ${reasons}. Corrige ces points sans rien ajouter d'autre et réponds uniquement par le synopsis corrigé.`
      : `\n\nTa réponse précédente a été refusée : ${reasons}. Réécris le synopsis en respectant toutes les règles.`;
  }
  messages.push({ role: "user", content: last });
  return messages;
}

/** Étape 3 : les sources telles que les notes les ont lues (fiche, dossier, texte), puis le synopsis. */
export function buildReviewMessages(type: ItemType, item: ItemRow, source: string, facts: ItemFacts | null, text: string): ChatMessage[] {
  const sources = [itemHeader(type, item), factsBlock(facts), dossierBlock(facts), `Texte de présentation :\n${source || "(aucun)"}`]
    .filter((p): p is string => p !== null)
    .join("\n");
  return [
    { role: "system", content: REVIEW_PROMPT },
    { role: "user", content: `${sources}\n\nSynopsis à relire :\n${text}` },
  ];
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
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
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

/** Texte des sources prêt pour le modèle : sans HTML, entités, balises internes ni mentions de source. */
export function cleanSource(raw: string | null): string {
  if (!raw) return "";
  const s = decodeEntities(decodeEntities(raw)) // deux passes : certains textes sont échappés deux fois
    .replace(/\[(?:FORMAT|STATUS|SEASON|EPISODES|LENGTH|NEXT_EP)[^\]]*\]/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[(?:written by|source)[^\]]*\]/gi, "")
    .replace(/\((?:source|sources)\s*:[^)]*\)/gi, "")
    .replace(/^\s*(?:source|sources|note)\s*:.*$/gim, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (s.length > MAX_SOURCE) return cutAtSentence(s, MAX_SOURCE);
  // texte coupé en plein mot (description tronquée en base) : on garde les phrases complètes
  return /[.!?…»"”')\]]$/.test(s) ? s : cutAtSentence(s, s.length);
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

export interface NotesAnswer {
  sense: string[]; // le texte redit en anglais simple (affichage, journaux)
  notes: string[];
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
 * Réponse de l'étape 1 : « Sens : » (anglais simple) puis « Notes : ».
 * Sans titre « Notes », on garde les lignes qui ne sont pas en anglais.
 */
export function parseNotesAnswer(raw: string): NotesAnswer {
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => NOTES_HEADER.test(l));
  if (at === -1) {
    return { sense: [], notes: parseNotes(lines.filter((l) => !SENSE_HEADER.test(l) && !looksEnglishLine(l)).join("\n")) };
  }
  return { sense: bulletLines(lines.slice(0, at), MAX_SENSE), notes: parseNotes(lines.slice(at + 1).join("\n")) };
}

/** Notes de l'étape 1 : une par ligne, puces retirées ; [] si le modèle juge la source trop pauvre. */
export function parseNotes(raw: string): string[] {
  const lines = raw
    .split("\n")
    .filter((l) => !SEPARATOR.test(l))
    .map((l) => cleanOutput(l).replace(/^(?:[-•–]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0 && !/^notes?\s*:?$/i.test(l));
  if (lines.length === 0 || lines.some((l) => /^\(rien\)|^rien\.?$/i.test(l))) return [];
  return lines
    .flatMap((l) => (l.length > 160 ? l.split(/(?<=[.;])\s+/) : [l])) // paragraphe au lieu de notes
    .filter((l) => l.length > 0)
    .slice(0, MAX_NOTES)
    .map((l) => (l.length > 160 ? l.slice(0, 160) : l));
}

// Relecture : chaque ligne de la réponse est une remarque, sauf si elle dit que tout va bien.
// Dans le doute, c'est une remarque : une correction de trop coûte moins qu'une erreur publiée.
const REVIEW_BULLET = /^(?:[-•–*]|\d+[.)])\s+/;
const REVIEW_CONTRAST = /\b(?:mais|sauf|cependant|toutefois|néanmoins|pourtant)\b|par contre|en revanche/i;
const REVIEW_FINE =
  /aucune erreur|pas d['’]erreur|rien à (?:signaler|redire)|\bras\b|\bconforme aux sources|\bfidèle aux sources|respecte (?:les|aux) sources|\best (?:[a-zéèêàâùûôîç]+ment\s+)?(?:conforme|fidèle|correcte?|exacte?|juste)\b|^(?:correcte?|exacte?|juste|conforme|fidèle)[.!]?$|ne contredit (?:pas|rien)|n['’](?:invente|inverse|confond) rien|(?:pas de|aucune?)\s[^,.;«]{0,30}(?:invers|invent|confusion|confondu|erreur|contradiction)/i;
// « n'est pas fidèle », « non conforme » : une remarque, malgré le mot rassurant
const REVIEW_NEGATED = /\b(?:n['’]est|ne sont)\s+pas\s+(?:\S+\s+)?(?:conforme|fidèle|correcte?|exacte?|juste)|\bnon conforme|\bpas (?:conforme|fidèle|correcte?|exacte?|juste)\b/i;
const REVIEW_NONE = /^[^«:]{1,40}:\s*(?:aucun|aucune|rien|non|néant|ras)\b[^«]*$/i; // « rôles inversés : aucun »
const REVIEW_HEADER = /^[^«]{1,40}:$/; // « Erreurs : », « Relecture : »

/** « OK », « **OK** », « « OK » », « Réponse : OK », « OK. Le synopsis respecte… ». */
function reviewOk(line: string): boolean {
  const t = line
    .replace(/^[\p{L} ]{1,20}:\s*(?=\S)/u, "")
    .replace(/^[«"“]\s*|\s*[»"”]$/g, "")
    .trim();
  return /^ok\b/i.test(t);
}

/**
 * Réponse de la relecture : [] si rien à redire, les erreurs signalées sinon (trois au plus),
 * null si le modèle n'a rien répondu. Une ligne citée (« passage ») ou nuancée (« mais »,
 * « sauf ») est une remarque, même après un « OK » (« OK, mais « … » n'est pas dans les sources »).
 */
export function parseReview(raw: string): string[] | null {
  // pas cleanOutput : il retirerait les guillemets de « passage » : « ce que disent les sources »
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SEPARATOR.test(l))
    .map((l) =>
      l
        .replace(REVIEW_BULLET, "")
        .replace(/\*\*|__|[`*_]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const remarks = lines.filter((l) => {
    if (l.includes("«") && !reviewOk(l)) return true;
    if (REVIEW_CONTRAST.test(l) || REVIEW_NEGATED.test(l)) return true;
    return !(reviewOk(l) || REVIEW_NONE.test(l) || REVIEW_FINE.test(l) || REVIEW_HEADER.test(l));
  });
  return remarks.slice(0, MAX_REVIEW).map((l) => clip(l, 220));
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
  let t = s.toLowerCase();
  for (const r of remove) {
    if (r.trim().length >= 3) t = t.replace(new RegExp(escapeRegExp(r.trim().toLowerCase()), "g"), " ");
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
 * Noms propres du texte (majuscule hors début de phrase) introuvables dans les données :
 * signe possible d'invention ou de nom traduit. Rapprochement souple sur les 3 premières
 * lettres (« Japon » retrouve « Japan »), donc c'est une alerte, pas un refus.
 */
export function namesAbsent(text: string, reference: string): string[] {
  const known = new Set((fold(reference).match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.slice(0, 3)));
  const missing = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?…:])\s+/)) {
    const tokens = sentence.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
    for (const raw of tokens.slice(1)) {
      const name = raw.replace(/^(?:l|d|qu|n|s|j|c|m|t)['’]/iu, "");
      if (name.length < 3 || !/^\p{Lu}/u.test(name) || COMMON_CAPITALIZED.has(fold(name))) continue;
      if (!known.has(fold(name).slice(0, 3))) missing.add(name);
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
  for (const w of reference.toLowerCase().match(/[a-z]+/g) ?? []) for (const n of NUMBER_WORDS[w] ?? []) known.add(n);
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
// « Pragmata plonge dans… », « plonge le joueur dans… » : formule de jaquette, refusée
const PLUNGE = /\bplonge(?:nt)?\s+(?:(?:le|la|les|l['’])\s*(?:joueurs?|joueuses?|spectateurs?|public|participants?|lecteurs?)\b|dans\b|au cœur\b)/i;
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
  { pattern: /\bhostiles?\b/i, support: /hostile|dangerous|deadly|perilous|harsh|unforgiving|treacherous/i },
  { pattern: /\bambiances?\b|\batmosphères?\b/i, support: /atmospher|ambien|mood|\bvibes?\b/i },
  { pattern: /\btribunes?\b|\bgradins?\b/i, support: /\bstands\b|grandstand|bleacher|spectator|audience/i },
];

/**
 * Ajouts du texte que rien ne justifie dans `support` (texte source et données), tels
 * qu'écrits. Les titres sont mis de côté (« Crash Course » n'est pas une course).
 */
export function unsupportedClaims(text: string, support: string, titles: readonly string[] = []): string[] {
  let t = text;
  for (const title of titles) if (title.trim().length >= 3) t = t.replace(new RegExp(escapeRegExp(title.trim()), "gi"), " ");
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
  if (!looksFrench(text)) errors.push("pas en français");
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
  // copie : du texte de présentation comme du dossier (une page française trouvée sur Google, par exemple)
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

async function postChat(cfg: SynopsisConfig, messages: ChatMessage[], options: Record<string, number>): Promise<OllamaChatResponse> {
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, messages, stream: false, keep_alive: "5m", options }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new OllamaError(`Ollama injoignable : ${errMessage(err)}`);
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OllamaError(`Ollama HTTP ${res.status} : ${clip(body, 200)}`);
  }
  const parsed = OllamaChatResponse.safeParse(await res.json().catch(() => null));
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
  const { table, kind, ext } = TABLES[type];
  return `
    SELECT id, title, title_english, kind, genre, description, pop_rank, ext_id, release_year
    FROM (
      SELECT id, title, title_english, ${kind} AS kind, genre, description, ${ext} AS ext_id,
             YEAR(release_date) AS release_year, popularity, in_window,
             synopsis_fr, synopsis_status, synopsis_generated_at,
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

/** Items sans synopsis : fenêtre de 2 ans d'abord, puis par popularité. */
async function fetchCandidates(pool: SqlPool, type: ItemType, limit: number): Promise<ItemRow[]> {
  const sql = `${rankedSql(type)}
    WHERE synopsis_fr IS NULL
      AND (synopsis_status IS NULL
           OR (synopsis_status IN ('failed', 'no_source')
               AND synopsis_generated_at < NOW() - INTERVAL ${RETRY_DAYS} DAY))
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

/** N'écrit que si la ligne est toujours vide : une saisie manuelle faite entre-temps est préservée. */
async function saveOutcome(pool: SqlPool, type: ItemType, id: number, outcome: Outcome, model: string): Promise<void> {
  await pool.query(
    `UPDATE ${TABLES[type].table}
        SET synopsis_fr = ?, synopsis_status = ?, synopsis_note = ?, synopsis_model = ?,
            synopsis_generated_at = NOW(), updated_at = updated_at
      WHERE id = ? AND synopsis_fr IS NULL`,
    [outcome.text, outcome.status, outcome.note, outcome.status === "no_source" ? null : model, id],
  );
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
  sense: string[]; // le texte redit en anglais simple par le modèle
  notes: string[]; // notes gardées, seules transmises à la rédaction
  dropped: string[]; // notes retirées, avec la raison
  /** Présent si la source est inexploitable : résultat final, pas de rédaction. */
  outcome?: Outcome;
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
  // une suite décrite en une ligne (« The second season of Youjo Senki. ») s'appuie sur le dossier
  const readable = (source.length >= MIN_SOURCE ? source.length : 0) + (facts?.dossier ?? []).reduce((n, e) => n + e.text.length, 0);
  if (readable < MIN_SOURCE) {
    return { source, sense: [], notes: [], dropped: [], outcome: { status: "no_source", text: null, note: "texte source absent ou trop court" } };
  }
  const messages = buildNotesMessages(type, item, source, facts);
  const first = await chat(cfg, messages, 0.1, NOTES_TOKENS);
  let answer = parseNotesAnswer(first);
  if (answer.notes.length === 0 && readable >= RETRY_NOTES_SOURCE) {
    const again: ChatMessage[] = [...messages, { role: "assistant", content: first.trim() || "- (rien)" }, { role: "user", content: NOTES_RETRY }];
    const second = parseNotesAnswer(await chat(cfg, again, 0.3, NOTES_TOKENS));
    answer = { sense: second.sense.length ? second.sense : answer.sense, notes: second.notes };
  }
  // date de sortie prise pour l'époque, genre ou ajout que ni le texte ni le dossier ne confirment
  const ctx = { releaseYear: item.release_year, support: supportText(item, source, facts), titles: [item.title, item.title_english ?? ""] };
  const notes: string[] = [];
  const dropped: string[] = [];
  for (const n of answer.notes) {
    const why = noteProblem(n, ctx);
    if (why) dropped.push(`${n} (${why})`);
    else notes.push(n);
  }
  if (notes.length === 0) {
    const note = dropped.length ? "notes retirées (non confirmées ou année de sortie)" : "la source ne dit presque rien de l'œuvre";
    return { source, sense: answer.sense, notes, dropped, outcome: { status: "no_source", text: null, note } };
  }
  return { source, sense: answer.sense, notes, dropped };
}

/** Étape 3 : relecture d'un synopsis contre les sources ; [] si rien à redire, null si pas de réponse. */
export async function reviewSynopsis(
  cfg: SynopsisConfig,
  type: ItemType,
  item: ItemRow,
  source: string,
  facts: ItemFacts | null,
  text: string,
  chat: ChatFn,
): Promise<string[] | null> {
  return parseReview(await chat(cfg, buildReviewMessages(type, item, source, facts, text), 0, REVIEW_TOKENS));
}

/**
 * Étapes 2 et 3 : rédaction à partir des notes, contrôles, puis relecture contre les sources.
 * Un texte refusé par les contrôles, trop long ou signalé par la relecture est corrigé une fois.
 * Si la correction est refusée par les contrôles, le premier texte (sans erreur de contrôle)
 * part en relecture humaine plutôt que d'être perdu.
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
  const characters = facts?.characters ?? [];
  const ctx: CheckContext = {
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
  const attempts: Attempt[] = []; // dans l'ordre ; le texte gardé est le dernier essai qui porte ce texte
  let reviewMs = 0;
  // motifs courts d'abord : la note est coupée à 255 caractères, les remarques de relecture peuvent être longues
  const keep = (text: string, warnings: readonly string[], review: string[] | null, extra: string[] = []): Outcome => {
    const reasons = [...warnings, ...extra];
    if (item.pop_rank !== null && item.pop_rank <= cfg.reviewTop) reasons.push(`top ${cfg.reviewTop} de popularité`);
    reasons.push(...(review ?? []).map((r) => `relecture : ${r}`));
    return { status: reasons.length ? "to_review" : "auto", text, note: reasons.length ? clip(reasons.join(" · "), 255) : null, attempts, review, reviewMs };
  };
  let refused: string[] = [];
  let lastText = "";
  let fallback: { text: string; warnings: string[]; review: string[] | null } | null = null;
  for (const [i, temperature] of TEMPERATURES.entries()) {
    const last = i === TEMPERATURES.length - 1;
    const text = cleanOutput(await chat(cfg, buildWriteMessages(type, item, notes, refused, facts, lastText), temperature, WRITE_TOKENS));
    const verdict = checkSynopsis(text, ctx);
    if (verdict.errors.length) {
      attempts.push({ text, refused: verdict.errors, review: null });
      refused = verdict.errors;
      lastText = text;
      continue;
    }
    const t0 = Date.now();
    const review = await reviewSynopsis(cfg, type, item, source, facts, text, chat);
    reviewMs += Date.now() - t0;
    const remarks = (review ?? []).map((r) => `relecture : ${r}`);
    // pas de réponse de la relecture : rien de vérifié, donc pas de publication sans relecture humaine
    const warnings = review === null ? [...verdict.warnings, "relecture sans réponse"] : verdict.warnings;
    const n = [...text].length;
    // trop long : accepté en relecture, mais un essai pour raccourcir vaut mieux (essai v7 : Classroom, 465 car.)
    const fixes = [...(n > SOFT_MAX ? [`trop long (${n} car.)`] : []), ...remarks];
    if (fixes.length && !last) {
      attempts.push({ text, refused: fixes, review });
      fallback = { text, warnings, review };
      refused = fixes;
      lastText = text;
      continue;
    }
    // un texte juste mais trop long vaut mieux qu'une version raccourcie que la relecture signale
    if (remarks.length && fallback?.review && fallback.review.length === 0) {
      attempts.push({ text, refused: remarks, review });
      return keep(fallback.text, fallback.warnings, fallback.review);
    }
    attempts.push({ text, refused: [], review });
    return keep(text, warnings, review);
  }
  // la correction a échoué aux contrôles : le premier texte, sans erreur de contrôle, part en relecture humaine
  if (fallback) return keep(fallback.text, fallback.warnings, fallback.review, ["correction refusée"]);
  return { status: "failed", text: null, note: clip(refused.join(" · "), 255), rejected: lastText, attempts, reviewMs };
}

/** Les étapes 1 à 3 pour un item (fiche fournie par l'appelant). */
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
  factsMs: number; // se renseigner (AniList / IGDB, Wikipédia, Google)
  notesMs: number; // étape 1
  writeMs: number; // étapes 2 et 3, relecture comprise
  reviewMs: number; // dont relecture
  usage: TokenUsage; // appels et jetons de l'item (0 avec un faux modèle)
}

export interface Draft extends Job {
  facts: ItemFacts | null;
  factsNote: string | null; // pourquoi la fiche manque
  source: string;
  sense: string[];
  notes: string[];
  dropped: string[];
  outcome: Outcome;
  ms: number; // temps de l'item (fiche + notes + rédaction + relecture)
  timing?: DraftTiming;
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
  onStep?: ((step: "notes" | "rédaction", job: Job) => void) | undefined;
  facts?: FactsFn | undefined; // défaut : AniList / IGDB
}

/**
 * Traite les items par paquets : fiche et notes de tout le paquet, puis la rédaction.
 * `onDraft` reçoit chaque item terminé. Renvoie "stopped" si `keepGoing` a dit non.
 * Une OllamaError remonte à l'appelant ; une fiche manquante, non.
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
  for (let i = 0; i < jobs.length; i += size) {
    if (opts.keepGoing && !opts.keepGoing()) return "stopped";
    const pack = jobs.slice(i, i + size);
    const steps: Array<{ job: Job; facts: FactsResult; step: NotesStep; timing: DraftTiming }> = [];
    for (const job of pack) {
      opts.onStep?.("notes", job);
      const t0 = Date.now();
      const u0 = tokenUsage();
      const source = cleanSource(job.item.description);
      // se renseigner d'abord, même sans texte de présentation : le dossier peut suffire
      const raw = await getFacts(job.type, job.item);
      const factsMs = Date.now() - t0;
      const spelled = [source, ...(raw.facts?.dossier ?? []).map((e) => e.text)].join("\n");
      const facts = { facts: alignNames(raw.facts, spelled), note: raw.note };
      const step = await makeNotes(cfg, job.type, job.item, chat, facts.facts);
      steps.push({ job, facts, step, timing: { factsMs, notesMs: Date.now() - t0 - factsMs, writeMs: 0, reviewMs: 0, usage: usageSince(u0) } });
    }
    for (const { job, facts, step, timing } of steps) {
      let outcome = step.outcome;
      if (!outcome) {
        opts.onStep?.("rédaction", job);
        const t0 = Date.now();
        const u0 = tokenUsage();
        outcome = await writeFromNotes(cfg, job.type, job.item, step.source, step.notes, chat, facts.facts);
        timing.writeMs = Date.now() - t0;
        timing.reviewMs = outcome.reviewMs ?? 0;
        timing.usage = addUsage(timing.usage, usageSince(u0));
      }
      await onDraft({
        ...job,
        facts: facts.facts,
        factsNote: facts.note,
        source: step.source,
        sense: step.sense,
        notes: step.notes,
        dropped: step.dropped,
        outcome,
        ms: timing.factsMs + timing.notesMs + timing.writeMs,
        timing,
      });
    }
  }
  return "done";
}

/** Un passage du cron : file d'attente, paquets, enregistrement, jusqu'à la limite, la fin de la fenêtre ou une panne d'Ollama. */
export async function runBatch(
  deps: SynopsisDeps,
  cfg: SynopsisConfig,
  opts: { chat?: ChatFn; now?: () => Date; chunk?: number; facts?: FactsFn } = {},
): Promise<RunReport> {
  const chat = opts.chat ?? ollamaChat;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const before = tokenUsage();
  const counts = { processed: 0, auto: 0, toReview: 0, failed: 0, noSource: 0 };
  const jobs = await fetchQueue(deps.pool, cfg.maxPerRun);

  const save = async (d: Draft): Promise<void> => {
    const { outcome } = d;
    await saveOutcome(deps.pool, d.type, d.item.id, outcome, cfg.model);
    counts.processed++;
    if (outcome.status === "auto") counts.auto++;
    else if (outcome.status === "to_review") counts.toReview++;
    else if (outcome.status === "failed") counts.failed++;
    else counts.noSource++;
    deps.log.info(
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
        ...(outcome.review?.length ? { review: outcome.review } : {}),
        ...((outcome.attempts?.length ?? 0) > 1 ? { attempts: outcome.attempts?.length } : {}),
        ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
      },
      "synopsis : item traité",
    );
  };

  let stop: RunReport["stop"] = "done";
  let error: string | null = null;
  try {
    const end = await draftItems(cfg, jobs, chat, save, {
      chunk: opts.chunk,
      facts: opts.facts,
      keepGoing: () => inWindow(parisHour(now()), cfg.window),
    });
    if (end === "stopped") stop = "window";
  } catch (err) {
    if (!(err instanceof OllamaError)) throw err;
    stop = "ollama";
    error = err.message;
  }
  const spent = tokenUsage();
  const report: RunReport = {
    ...counts,
    stop,
    durationS: Math.round((Date.now() - started) / 1000),
    tokens: { input: spent.input - before.input, output: spent.output - before.output },
  };
  if (error) report.error = error;
  return report;
}

// ─── Cron ────────────────────────────────────────────────────────────────────

let running = false;

export function startSynopsisCron(deps: SynopsisDeps, env: Record<string, string | undefined> = process.env): void {
  let cfg: SynopsisConfig | null;
  try {
    cfg = readConfig(env);
  } catch (err) {
    deps.log.error({ module: "synopsis", err }, "synopsis : configuration invalide, module arrêté");
    return;
  }
  if (!cfg) {
    deps.log.info({ module: "synopsis" }, "synopsis : désactivé (SYNOPSIS_ENABLED n'est pas à 1)");
    return;
  }
  const active = cfg;
  deps.log.info(
    { module: "synopsis", model: active.model, window: active.window.join("-"), maxPerRun: active.maxPerRun, webSearch: webSearchEnabled(env) },
    "synopsis : actif",
  );

  const tick = async (): Promise<void> => {
    if (running || !inWindow(parisHour(new Date()), active.window)) return;
    running = true;
    try {
      const report = await runBatch(deps, active);
      if (report.processed > 0 || report.stop === "ollama") {
        const level = report.stop === "ollama" ? "warn" : "info";
        deps.log[level]({ module: "synopsis", ...report, stats: await synopsisStats(deps.pool) }, "synopsis : passage terminé");
      }
    } catch (err) {
      deps.log.error({ module: "synopsis", err }, "synopsis : passage interrompu");
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
  setInterval(() => void tick(), TICK_MS).unref();
}
