/**
 * synopsis.ts — synopsis français rédigés en local par Ollama.
 *
 * `description` garde le texte des sources (AniList, IGDB…) et ne sert plus
 * que d'entrée. Ollama en tire un synopsis original en français, rangé dans
 * `synopsis_fr` (migration 014) : la seule colonne que le site affichera.
 *
 * - Ne remplit que les lignes vides : un synopsis relu ou écrit à la main n'est
 *   jamais régénéré. Pour en refaire un : synopsis_fr = NULL, synopsis_status = NULL.
 * - Ni date ni plateformes dans le texte : elles changent, et la fiche les
 *   affiche déjà (une seule source de vérité).
 * - Tourne dans une fenêtre horaire (heure de Paris), un item à la fois.
 *   Si Ollama ne répond pas, le passage s'arrête sans toucher aux items.
 * - Ne modifie pas `updated_at`.
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
 */
import { setInterval, setTimeout } from "node:timers";
import { z } from "zod";

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

export type ChatFn = (cfg: SynopsisConfig, messages: ChatMessage[], temperature: number) => Promise<string>;

export interface Outcome {
  status: Exclude<SynopsisStatus, "approved">;
  text: string | null;
  note: string | null;
}

export interface RunReport {
  processed: number;
  auto: number;
  toReview: number;
  failed: number;
  noSource: number;
  stop: "done" | "window" | "ollama";
  durationS: number;
  error?: string;
}

// ─── Réglages ────────────────────────────────────────────────────────────────

const FIRST_TICK_MS = 2 * 60_000; // premier passage 2 min après le démarrage
const TICK_MS = 10 * 60_000; // puis vérification toutes les 10 min
const OLLAMA_TIMEOUT_MS = 240_000; // sous les 300 s de fetch (undici)
const RETRY_DAYS = 7; // délai avant de retenter failed / no_source

const MIN_SOURCE = 60; // en dessous : pas de texte exploitable
const SHORT_SOURCE = 300; // en dessous : risque de simple traduction → relecture
const MAX_SOURCE = 1500; // texte source tronqué au-delà
const HARD_MIN = 150; // seuil d'indexation des fiches
const HARD_MAX = 600;
const SOFT_MIN = 200;
const SOFT_MAX = 450;
const COPY_RUN = 6; // 6 mots consécutifs communs avec la source = copie
const TEMPERATURES = [0.1, 0.3] as const; // 1er essai, puis 2e essai après refus

const TABLES: Record<ItemType, { table: string; kind: string }> = {
  anime: { table: "anime_items", kind: "format" },
  game: { table: "game_items", kind: "game_type" },
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

// ─── Prompt ──────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `Tu rédiges les synopsis de GameNime, un site français qui annonce les sorties d'animés et de jeux vidéo.

On te donne la fiche d'une œuvre et un texte de présentation, souvent en anglais. Écris en français le synopsis de l'œuvre : 2 ou 3 phrases, entre 220 et 420 caractères, qui présentent le point de départ de l'histoire. Pour un jeu sans histoire, présente son principe.

Règles :
- Écris avec tes propres mots et ta propre construction. Ne traduis pas le texte fourni phrase par phrase et ne reprends aucune de ses tournures.
- N'utilise que des faits présents dans les données fournies. N'invente rien.
- Ne dévoile rien au-delà du point de départ.
- Garde un ton neutre et informatif : pas de superlatifs ni de formules publicitaires.
- Ne mentionne ni la date de sortie ni les plateformes : la fiche les affiche déjà.
- Garde les noms propres tels quels.

Réponds uniquement par le synopsis : sans titre, sans guillemets, sans commentaire.`;

/** Exemples rédigés pour l'occasion (les textes « source » ne viennent d'aucun site). */
export const EXAMPLES: ReadonlyArray<{ user: string; assistant: string }> = [
  {
    user: [
      "Type : animé (série TV)",
      "Titre : Witch Hat Atelier",
      "Titre original : Tongari Boushi no Atelier",
      "Genres : Fantasy",
      "Texte de présentation :",
      "Coco, the daughter of a village dressmaker, has always been fascinated by magic, an art that only witches are allowed to practice. After secretly watching the witch Qifrey cast a spell by drawing it, she copies the drawing and accidentally causes a disaster at home. Qifrey then takes her on as his apprentice.",
    ].join("\n"),
    assistant:
      "Dans le monde de Coco, fille d'une couturière de village, la magie ne se récite pas : elle se dessine, et seuls les sorciers en connaissent le secret. Après avoir surpris l'un d'eux à l'œuvre, Coco reproduit son dessin et provoque une catastrophe. Le sorcier Qifrey décide alors de la prendre comme apprentie.",
  },
  {
    user: [
      "Type : jeu vidéo",
      "Titre : Resident Evil Requiem",
      "Genres : Action, Horreur",
      "Texte de présentation :",
      "Resident Evil Requiem is the ninth main entry in Capcom's survival horror series. FBI analyst Grace Ashcroft investigates a series of mysterious deaths, an inquiry that leads her back to the hotel where her mother died years ago.",
    ].join("\n"),
    assistant:
      "Neuvième épisode principal de la saga d'horreur de Capcom, Resident Evil Requiem suit Grace Ashcroft, analyste au FBI. Son enquête sur une série de morts inexpliquées la ramène à l'hôtel où sa mère a trouvé la mort, des années plus tôt.",
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

export function buildUserMessage(type: ItemType, item: ItemRow, source: string): string {
  const shown = item.title_english?.trim() || item.title;
  const lines = [`Type : ${kindLabel(type, item.kind)}`, `Titre : ${shown}`];
  if (shown !== item.title) lines.push(`Titre original : ${item.title}`);
  if (item.genre?.trim()) lines.push(`Genres : ${item.genre.trim()}`);
  lines.push("Texte de présentation :", source);
  return lines.join("\n");
}

export function buildMessages(type: ItemType, item: ItemRow, source: string, refused: string[] = []): ChatMessage[] {
  // Partie fixe en tête (système + exemples) : Ollama la garde en cache d'un item à l'autre.
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const ex of EXAMPLES) {
    messages.push({ role: "user", content: ex.user }, { role: "assistant", content: ex.assistant });
  }
  let last = buildUserMessage(type, item, source);
  if (refused.length) {
    last += `\n\nTa réponse précédente a été refusée : ${refused.join(" ; ")}. Réécris le synopsis en respectant toutes les règles.`;
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
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function cutAtSentence(s: string, max: number): string {
  const head = s.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
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
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return s.length > MAX_SOURCE ? cutAtSentence(s, MAX_SOURCE) : s;
}

/** Réponse du modèle débarrassée de l'emballage (gras, « Synopsis : », guillemets englobants). */
export function cleanOutput(raw: string): string {
  let s = raw
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(?:synopsis|résumé)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^["«“]/.test(s) && /["»”]$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}

// ─── Contrôles ───────────────────────────────────────────────────────────────

const FR_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "est", "dans", "pour", "qui", "que",
  "sur", "au", "aux", "son", "sa", "ses", "elle", "il", "avec", "par", "ne", "pas", "se", "leur",
  "alors", "mais", "où", "ce", "cette", "ces", "lui", "après", "entre",
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
  return fr >= 4 && fr >= 3 * en;
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

/**
 * Noms propres du texte (majuscule hors début de phrase) introuvables dans les données :
 * signe possible d'invention. Rapprochement souple sur les 3 premières lettres
 * (« Japon » retrouve « Japan »), donc c'est une alerte, pas un refus.
 */
export function namesAbsent(text: string, reference: string): string[] {
  const known = new Set((fold(reference).match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.slice(0, 3)));
  const missing = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?…:])\s+/)) {
    const tokens = sentence.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
    for (const raw of tokens.slice(1)) {
      const name = raw.replace(/^(?:l|d|qu|n|s|j|c|m|t)['’]/iu, "");
      if (name.length < 3 || !/^\p{Lu}/u.test(name)) continue;
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

/** Nombres écrits dans le texte mais absents des données fournies (risque d'invention). */
export function numbersAbsent(text: string, reference: string): string[] {
  const known = new Set(reference.match(/\d+/g) ?? []);
  return [...new Set(text.match(/\d+/g) ?? [])].filter((n) => !known.has(n));
}

const SOURCE_MARKERS = /written by|\bsource\s*:|\brewrite\b|https?:\/\/|[[\]<>]/i;
const META_START = /^(?:voici|bien sûr|en tant que|ce synopsis)/i;
const PROMO =
  /incontournable|chef[- ]d['’](?:œ|oe)uvre|époustouflant|à couper le souffle|à ne pas manquer|inoubliable|captivant|palpitant|révolutionnaire|phénoménal/i;

export interface Verdict {
  errors: string[]; // refus : nouvel essai, puis échec
  warnings: string[]; // accepté, mais à relire
}

export function checkSynopsis(text: string, source: string, data: string, titles: string[]): Verdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = [...text].length;
  if (n === 0) return { errors: ["réponse vide"], warnings };
  if (n < HARD_MIN) errors.push(`trop court (${n} car.)`);
  if (n > HARD_MAX) errors.push(`trop long (${n} car.)`);
  if (!looksFrench(text)) errors.push("pas en français");
  if (SOURCE_MARKERS.test(text)) errors.push("mention de source ou balise");
  if (!/[.!?…»)]$/.test(text)) errors.push("phrase coupée");
  if (META_START.test(text)) errors.push("formule de présentation");
  const copied = sharedRun(text, source, titles);
  if (copied) errors.push(`reprend la source mot pour mot (« ${copied} »)`);

  if (n >= HARD_MIN && n <= HARD_MAX && (n < SOFT_MIN || n > SOFT_MAX)) warnings.push(`longueur ${n} car.`);
  if (PROMO.test(text)) warnings.push("ton promotionnel");
  if (/\b(?:19|20)\d{2}\b/.test(text)) warnings.push("mentionne une année");
  const reference = `${source} ${data}`;
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

const OllamaChatResponse = z.object({ message: z.object({ content: z.string() }) });

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const ollamaChat: ChatFn = async (cfg, messages, temperature) => {
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: false,
      keep_alive: "5m",
      options: { temperature, top_p: 0.9, num_ctx: 4096, num_predict: 300, num_thread: cfg.threads },
    }),
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
  return parsed.data.message.content;
};

// ─── Base de données ─────────────────────────────────────────────────────────

const ItemRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  title: z.string(),
  title_english: z.string().nullable(),
  kind: z.string().nullable(),
  genre: z.string().nullable(),
  description: z.string().nullable(),
  pop_rank: z.coerce.number().int().nullable(),
});
export type ItemRow = z.infer<typeof ItemRowSchema>;

/** mysql2 renvoie [lignes, champs] ; le connecteur mariadb renvoie directement les lignes. */
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

/** Items sans synopsis : fenêtre de 2 ans d'abord, puis par popularité. pop_rank = rang dans la fenêtre. */
function candidatesSql(type: ItemType, limit: number): string {
  const { table, kind } = TABLES[type];
  return `
    SELECT id, title, title_english, kind, genre, description, pop_rank
    FROM (
      SELECT id, title, title_english, ${kind} AS kind, genre, description, popularity, in_window,
             synopsis_fr, synopsis_status, synopsis_generated_at,
             CASE WHEN in_window = 1
                  THEN RANK() OVER (PARTITION BY in_window ORDER BY popularity DESC) END AS pop_rank
      FROM (
        SELECT t.*,
               (t.release_date >= MAKEDATE(YEAR(CURDATE()), 1)
                AND t.release_date < MAKEDATE(YEAR(CURDATE()) + 2, 1)) AS in_window
        FROM ${table} t
      ) w
    ) r
    WHERE synopsis_fr IS NULL
      AND (synopsis_status IS NULL
           OR (synopsis_status IN ('failed', 'no_source')
               AND synopsis_generated_at < NOW() - INTERVAL ${RETRY_DAYS} DAY))
    ORDER BY in_window DESC, popularity DESC, id
    LIMIT ${Math.max(1, Math.floor(limit))}`;
}

async function fetchCandidates(pool: SqlPool, type: ItemType, limit: number): Promise<ItemRow[]> {
  return ItemRowSchema.array().parse(rowsOf(await pool.query(candidatesSql(type, limit))));
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

/** Nombre d'items par statut (null = jamais tenté), pour les journaux et le futur bloc du dashboard. */
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

export async function processItem(cfg: SynopsisConfig, type: ItemType, item: ItemRow, chat: ChatFn): Promise<Outcome> {
  const source = cleanSource(item.description);
  if (source.length < MIN_SOURCE) return { status: "no_source", text: null, note: "texte source absent ou trop court" };

  const titles = [item.title, item.title_english ?? ""];
  const data = [item.title, item.title_english ?? "", item.genre ?? ""].join(" ");
  let refused: string[] = [];
  for (const temperature of TEMPERATURES) {
    const text = cleanOutput(await chat(cfg, buildMessages(type, item, source, refused), temperature));
    const verdict = checkSynopsis(text, source, data, titles);
    if (verdict.errors.length === 0) {
      const reasons = [...verdict.warnings];
      if (source.length < SHORT_SOURCE) reasons.push("source courte : vérifier que ce n'est pas une traduction");
      if (item.pop_rank !== null && item.pop_rank <= cfg.reviewTop) reasons.push(`top ${cfg.reviewTop} de popularité`);
      return { status: reasons.length ? "to_review" : "auto", text, note: reasons.length ? clip(reasons.join(" · "), 255) : null };
    }
    refused = verdict.errors;
  }
  return { status: "failed", text: null, note: clip(refused.join(" · "), 255) };
}

function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x !== undefined) out.push(x);
    if (y !== undefined) out.push(y);
  }
  return out;
}

/** Un passage : items en attente, animés et jeux en alternance, jusqu'à la limite, la fin de la fenêtre ou une panne d'Ollama. */
export async function runBatch(
  deps: SynopsisDeps,
  cfg: SynopsisConfig,
  opts: { chat?: ChatFn; now?: () => Date } = {},
): Promise<RunReport> {
  const chat = opts.chat ?? ollamaChat;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const counts = { processed: 0, auto: 0, toReview: 0, failed: 0, noSource: 0 };
  const tag = (type: ItemType) => (item: ItemRow) => ({ type, item });
  const queue = interleave(
    (await fetchCandidates(deps.pool, "anime", cfg.maxPerRun)).map(tag("anime")),
    (await fetchCandidates(deps.pool, "game", cfg.maxPerRun)).map(tag("game")),
  ).slice(0, cfg.maxPerRun);

  let stop: RunReport["stop"] = "done";
  let error: string | null = null;
  for (const { type, item } of queue) {
    if (!inWindow(parisHour(now()), cfg.window)) {
      stop = "window";
      break;
    }
    const t0 = Date.now();
    let outcome: Outcome;
    try {
      outcome = await processItem(cfg, type, item, chat);
    } catch (err) {
      if (err instanceof OllamaError) {
        stop = "ollama";
        error = err.message;
        break;
      }
      throw err;
    }
    await saveOutcome(deps.pool, type, item.id, outcome, cfg.model);
    counts.processed++;
    if (outcome.status === "auto") counts.auto++;
    else if (outcome.status === "to_review") counts.toReview++;
    else if (outcome.status === "failed") counts.failed++;
    else counts.noSource++;
    deps.log.info(
      { module: "synopsis", type, id: item.id, status: outcome.status, ms: Date.now() - t0, ...(outcome.note ? { note: outcome.note } : {}) },
      "synopsis : item traité",
    );
  }
  const report: RunReport = { ...counts, stop, durationS: Math.round((Date.now() - started) / 1000) };
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
    { module: "synopsis", model: active.model, window: active.window.join("-"), maxPerRun: active.maxPerRun },
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
