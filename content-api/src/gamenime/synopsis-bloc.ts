/**
 * synopsis-bloc.ts — API du bloc Synopsis du dashboard (v9.5, maquette v4 validée le 15 octobre 2026).
 *
 * Décision A de Rey (13 octobre) : aucun synopsis ne s'affiche sur le site sans sa validation. Le bloc
 * liste les synopsis, les plus populaires d'abord, avec ce qui les a produits (synopsis_versions) :
 * phrases, contrôle phrase par phrase, notes et preuves, sources, site officiel, presse. Rey valide, ou
 * touche les phrases fausses (et leurs mots faux) : seules celles-là sont réécrites par le cron.
 *
 * Routes (sous /admin, servies au dashboard par nginx sous /dashboard/admin/, clé X-Api-Key) :
 *   GET  /admin/synopsis?filtre=a_valider&type=tous&depuis=0   liste, compteurs, état du cron
 *        (vue=compteurs : compteurs et cron seulement, pour la pastille de l'index)
 *   GET  /admin/synopsis/carte?type=anime&id=52                 une carte (suivi d'une correction)
 *   POST /admin/synopsis/valider          { type, id, version }
 *   POST /admin/synopsis/annuler          { type, id }            (retire la validation)
 *   POST /admin/synopsis/corriger         { type, id, version, phrases: [{ index, texte, mots }] }
 *   POST /admin/synopsis/annuler-demande  { type, id }
 * Chaque action rend la carte à jour. Toute écriture garde updated_at (le site n'est pas concerné
 * avant la bascule) et vérifie que la version lue est toujours celle de l'item.
 *
 * Le cycle (v9.5, 21 octobre) : planifié par le Pilotage du dashboard (ligne « Synopsis ») à la place de ses
 * propres minuteurs : interrupteur à chaud (SYNOPSIS_ENABLED ne sert plus qu'à la première mise en route),
 * ▶ Lancer maintenant, pause générale, historique. Un contrôle toutes les 10 min ; il ne rédige que dans sa
 * fenêtre horaire (SYNOPSIS_WINDOW). Coupé ou mis en pause, un passage s'arrête après l'étape en cours (notes ou
 * rédaction d'un synopsis, ou une correction) ; ce qui n'est pas enregistré revient au passage suivant.
 * Lancé à la main : les corrections demandées (8 au plus), puis un paquet au plus, à toute heure.
 * Branchement (index.ts) : registerSynopsisBloc(app, pool) avec les routes, startSynopsisCron({ pool, log })
 * avec les autres cycles.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { enPause, interrupteur, moduleIndisponible, planifier, type RetourPassage } from "./pilotage.js";
import {
  affectedOf,
  inWindow,
  parisHour,
  runBatch,
  sentenceWords,
  settingsFrom,
  SYNOPSIS_CODE,
  synopsisStats,
  type ChatFn,
  type CorrectionRequest,
  type FactsFn,
  type ItemType,
  type SqlPool,
  type SynopsisConfig,
  type SynopsisDeps,
  type VersionData,
} from "./synopsis.js";

const TABLE: Record<ItemType, string> = { anime: "anime_items", game: "game_items" };
const PAGE = 20;
const TOP = 25; // « top 25 de popularité » : rang dans la fenêtre de 2 ans
const WINDOW = "(release_date >= MAKEDATE(YEAR(CURDATE()), 1) AND release_date < MAKEDATE(YEAR(CURDATE()) + 2, 1))";

export const FILTRES = ["a_valider", "a_verifier", "valides", "correction", "sans_source", "tout"] as const;
export type Filtre = (typeof FILTRES)[number];

const FILTER_SQL: Record<Filtre, string> = {
  a_valider: "r.synopsis_status IN ('auto', 'to_review')",
  a_verifier: "r.synopsis_status IN ('auto', 'to_review') AND COALESCE(v.doubts, 0) > 0",
  valides: "r.synopsis_status = 'approved'",
  correction: "r.synopsis_status = 'correction'",
  sans_source: "r.synopsis_status IN ('no_source', 'failed')",
  tout: "r.synopsis_status IS NOT NULL",
};

export interface Counts {
  a_valider: number;
  a_verifier: number;
  valides: number;
  correction: number;
  sans_source: number;
  pas_traites: number; // fenêtre de 2 ans, jamais traités
  tout: number;
}

export interface Card {
  type: ItemType;
  id: number;
  title: string;
  rank: number | null; // rang de popularité dans la fenêtre de 2 ans
  status: string | null;
  note: string | null;
  reviewedAt: number | null; // secondes depuis 1970 (affichage à l'heure de Paris par le navigateur)
  text: string | null; // synopsis_fr
  alerts: string[];
  correction: { flagged: number[]; marked: Record<string, number[]> } | null; // demande en attente
  version: null | {
    id: number;
    num: number;
    origin: string;
    status: string;
    code: string;
    model: string | null;
    createdAt: number | null; // secondes depuis 1970
    chars: number;
    data: VersionData;
  };
}

export interface BlocState {
  counts: Counts;
  cron: { active: boolean; pause: boolean; code: string; msPerItem: number | null }; // active : allumé dans le Pilotage
  filtre: Filtre;
  type: ItemType | "tous";
  depuis: number;
  total: number;
  items: Card[];
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as Array<Record<string, unknown>>;
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}
const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/** Phrase comparée sans tenir compte des espaces, des apostrophes ni des guillemets typographiques. */
function sentenceKey(s: string): string {
  return s.replace(/[’‘`´]/g, "'").replace(/[“”«»]/g, '"').replace(/\s+/g, " ").trim();
}

/** Lignes d'items classées (rang dans la fenêtre), avec leur version ; filtre et pagination à part. */
function rankedSql(type: ItemType): string {
  return `
    SELECT '${type}' AS type, x.id, COALESCE(NULLIF(TRIM(x.title_english), ''), x.title) AS title, x.popularity, x.in_window,
           CASE WHEN x.in_window = 1 THEN RANK() OVER (PARTITION BY x.in_window ORDER BY x.popularity DESC) END AS rank_,
           x.synopsis_status, x.synopsis_note, x.synopsis_fr, UNIX_TIMESTAMP(x.synopsis_reviewed_at) AS reviewed_ts, x.synopsis_version_id, x.synopsis_correction
      FROM (SELECT t.*, ${WINDOW} AS in_window FROM ${TABLE[type]} t) x`;
}

const ALERT_DROP = /^(?:contrôle|correction demandée|correction en échec|demande de correction)/;

/** Les pastilles de la carte : rang, contrôle, corrections, site officiel japonais, puis les autres alertes de la note. */
export function alertsFor(rank: number | null, note: string | null, data: VersionData | null): string[] {
  const out: string[] = [];
  if (rank !== null && rank <= TOP) out.push(`top ${TOP} de popularité`);
  if (data) {
    const uniq = (pred: (v: string, asked: boolean) => boolean) => new Set(data.rows.filter((r) => pred(r.verdict, r.asked ?? false))).size;
    const doubts = uniq((v) => v === "à vérifier");
    const auto = uniq((v, asked) => v === "corrigée" && !asked);
    const asked = uniq((v, a) => v === "corrigée" && a);
    const pl = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
    if (doubts) out.push(`contrôle : ${pl(doubts, "phrase à vérifier", "phrases à vérifier")}`);
    if (auto) out.push(`${pl(auto, "phrase corrigée", "phrases corrigées")} par le contrôle`);
    if (asked) out.push(`${pl(asked, "phrase corrigée", "phrases corrigées")} à la demande`);
    if (data.official?.original) out.push("site officiel traduit du japonais");
    if (!data.rows.length && data.checkNote && data.sentences.length) out.push(`contrôle impossible : ${data.checkNote}`);
  }
  for (const part of (note ?? "").split(" · ").map((p) => p.trim()).filter(Boolean)) {
    if (ALERT_DROP.test(part) || /^top \d+ de popularité/.test(part)) continue;
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

function parseRequest(raw: unknown): CorrectionRequest | null {
  try {
    const j = JSON.parse(String(raw ?? "null")) as CorrectionRequest | null;
    return j && Array.isArray(j.flagged) ? j : null;
  } catch {
    return null;
  }
}

function cardOf(r: Record<string, unknown>): Card {
  const type = String(r["type"]) as ItemType;
  const rank = r["rank_"] === null || r["rank_"] === undefined ? null : num(r["rank_"]);
  let version: Card["version"] = null;
  if (r["v_id"] !== null && r["v_id"] !== undefined) {
    let data: VersionData | null = null;
    try {
      data = JSON.parse(String(r["v_data"])) as VersionData;
    } catch {
      data = null;
    }
    if (data) {
      version = {
        id: num(r["v_id"]),
        num: num(r["v_num"]),
        origin: String(r["v_origin"]),
        status: String(r["v_status"]),
        code: String(r["v_code"]),
        model: str(r["v_model"]),
        createdAt: r["v_created"] === null || r["v_created"] === undefined ? null : num(r["v_created"]),
        chars: [...String(r["synopsis_fr"] ?? "")].length,
        data,
      };
    }
  }
  const status = str(r["synopsis_status"]);
  const req = status === "correction" ? parseRequest(r["synopsis_correction"]) : null;
  return {
    type,
    id: num(r["id"]),
    title: String(r["title"] ?? ""),
    rank,
    status,
    note: str(r["synopsis_note"]),
    reviewedAt: r["reviewed_ts"] === null || r["reviewed_ts"] === undefined ? null : num(r["reviewed_ts"]),
    text: str(r["synopsis_fr"]),
    alerts: alertsFor(rank, str(r["synopsis_note"]), version?.data ?? null),
    correction: req ? { flagged: req.flagged, marked: req.marked } : null,
    version,
  };
}

const VERSION_COLS = `v.id AS v_id, v.num AS v_num, v.origin AS v_origin, v.status AS v_status, v.code AS v_code, v.model AS v_model,
       UNIX_TIMESTAMP(v.created_at) AS v_created, v.data AS v_data`;

export async function counts(pool: SqlPool): Promise<Counts> {
  const out: Counts = { a_valider: 0, a_verifier: 0, valides: 0, correction: 0, sans_source: 0, pas_traites: 0, tout: 0 };
  for (const type of ["anime", "game"] as const) {
    const [r] = rowsOf(
      await pool.query(
        `SELECT COALESCE(SUM(t.synopsis_status IN ('auto', 'to_review')), 0) AS a_valider,
                COALESCE(SUM(t.synopsis_status IN ('auto', 'to_review') AND COALESCE(v.doubts, 0) > 0), 0) AS a_verifier,
                COALESCE(SUM(t.synopsis_status = 'approved'), 0) AS valides,
                COALESCE(SUM(t.synopsis_status = 'correction'), 0) AS correction,
                COALESCE(SUM(t.synopsis_status IN ('no_source', 'failed')), 0) AS sans_source,
                COALESCE(SUM(t.synopsis_status IS NULL AND ${WINDOW}), 0) AS pas_traites,
                COALESCE(SUM(t.synopsis_status IS NOT NULL), 0) AS tout
           FROM ${TABLE[type]} t LEFT JOIN synopsis_versions v ON v.id = t.synopsis_version_id`,
      ),
    );
    for (const k of Object.keys(out) as Array<keyof Counts>) out[k] += num(r?.[k]);
  }
  return out;
}

/** Temps moyen d'une rédaction (ms), sur les 30 dernières ; null avant la première. */
async function msPerItem(pool: SqlPool): Promise<number | null> {
  const [r] = rowsOf(
    await pool.query(
      `SELECT AVG(ms) AS ms FROM (SELECT ms FROM synopsis_versions WHERE origin = 'redaction' AND ms IS NOT NULL AND text IS NOT NULL ORDER BY id DESC LIMIT 30) last`,
    ),
  );
  return r?.["ms"] === null || r?.["ms"] === undefined ? null : Math.round(num(r["ms"]));
}

/** L'état du cron pour le bloc : son interrupteur et la pause générale du Pilotage. */
async function cronState(pool: SqlPool): Promise<BlocState["cron"]> {
  return { active: planned && interrupteur("synopsis") === true, pause: planned && enPause(), code: SYNOPSIS_CODE, msPerItem: await msPerItem(pool) };
}

export const ListQuerySchema = z.object({
  filtre: z.enum(FILTRES).default("a_valider"),
  type: z.enum(["tous", "anime", "game"]).default("tous"),
  depuis: z.coerce.number().int().min(0).max(100_000).default(0),
  vue: z.enum(["liste", "compteurs"]).default("liste"),
});
export const CarteQuerySchema = z.object({ type: z.enum(["anime", "game"]), id: z.coerce.number().int().positive() });

export async function listState(pool: SqlPool, q: z.infer<typeof ListQuerySchema>): Promise<BlocState> {
  if (q.vue === "compteurs") return { counts: await counts(pool), cron: await cronState(pool), filtre: q.filtre, type: q.type, depuis: 0, total: 0, items: [] };
  const types: ItemType[] = q.type === "tous" ? ["anime", "game"] : [q.type];
  const where = FILTER_SQL[q.filtre];
  const union = types.map((t) => `SELECT r.*, ${VERSION_COLS} FROM (${rankedSql(t)}) r LEFT JOIN synopsis_versions v ON v.id = r.synopsis_version_id WHERE ${where}`).join(" UNION ALL ");
  const [tot] = rowsOf(await pool.query(`SELECT COUNT(*) AS n FROM (${union}) u`));
  const items = rowsOf(await pool.query(`SELECT * FROM (${union}) u ORDER BY u.in_window DESC, u.popularity DESC, u.type, u.id LIMIT ${PAGE} OFFSET ${q.depuis}`)).map(cardOf);
  return { counts: await counts(pool), cron: await cronState(pool), filtre: q.filtre, type: q.type, depuis: q.depuis, total: num(tot?.["n"]), items };
}

/** La carte d'un item, à jour (après une action). */
export async function cardFor(pool: SqlPool, type: ItemType, id: number): Promise<Card | null> {
  const [r] = rowsOf(
    await pool.query(`SELECT r.*, ${VERSION_COLS} FROM (${rankedSql(type)}) r LEFT JOIN synopsis_versions v ON v.id = r.synopsis_version_id WHERE r.id = ?`, [id]),
  );
  return r ? cardOf(r) : null;
}

export type ActionResult = { ok: true; carte: Card } | { ok: false; code: 400 | 404 | 409; msg: string; carte?: Card | null };

const Target = z.object({ type: z.enum(["anime", "game"]), id: z.coerce.number().int().positive() });
// version 0 : un synopsis sans version (écrit avant la v9.5, ou à la main), validé tel quel
export const ValiderSchema = Target.extend({ version: z.coerce.number().int().min(0) });
export const AnnulerSchema = Target;
export const CorrigerSchema = Target.extend({
  version: z.coerce.number().int().positive(),
  phrases: z
    .array(z.object({ index: z.number().int().min(0).max(200), texte: z.string().min(1).max(2000), mots: z.array(z.number().int().min(0).max(500)).max(100).default([]) }))
    .min(1)
    .max(30),
});

async function after(pool: SqlPool, type: ItemType, id: number, res: unknown, conflict: string): Promise<ActionResult> {
  const carte = await cardFor(pool, type, id);
  if (!carte) return { ok: false, code: 404, msg: "item introuvable" };
  return affectedOf(res) > 0 ? { ok: true, carte } : { ok: false, code: 409, msg: conflict, carte };
}

/** Valider : la version lue par Rey, si elle est toujours celle de l'item et à valider (0 : un texte sans version). */
export async function valider(pool: SqlPool, b: z.infer<typeof ValiderSchema>): Promise<ActionResult> {
  const res = await pool.query(
    `UPDATE ${TABLE[b.type]} SET synopsis_status = 'approved', synopsis_reviewed_at = NOW(), updated_at = updated_at
      WHERE id = ? AND ${b.version === 0 ? "synopsis_version_id IS NULL AND ?" : "synopsis_version_id = ?"} AND synopsis_fr IS NOT NULL
        AND synopsis_status IN ('auto', 'to_review')`,
    [b.id, b.version === 0 ? 1 : b.version],
  );
  return after(pool, b.type, b.id, res, "le synopsis a changé ou n'est plus à valider : la carte est rechargée");
}

/** Annuler une validation : l'item reprend le statut de sa version (à relire par défaut). */
export async function annuler(pool: SqlPool, b: z.infer<typeof AnnulerSchema>): Promise<ActionResult> {
  const res = await pool.query(
    `UPDATE ${TABLE[b.type]} t
        SET t.synopsis_status = COALESCE((SELECT v.status FROM synopsis_versions v WHERE v.id = t.synopsis_version_id AND v.status IN ('auto', 'to_review')), 'to_review'),
            t.synopsis_reviewed_at = NULL, t.updated_at = t.updated_at
      WHERE t.id = ? AND t.synopsis_status = 'approved' AND t.synopsis_fr IS NOT NULL`,
    [b.id],
  );
  return after(pool, b.type, b.id, res, "ce synopsis n'est pas validé");
}

/**
 * Corriger : les phrases signalées (index et texte, vérifiés contre la version) et leurs mots faux
 * (positions dans sentenceWords). La demande est posée ; le cron la traite à son prochain passage.
 */
export async function corriger(pool: SqlPool, b: z.infer<typeof CorrigerSchema>): Promise<ActionResult> {
  const carte = await cardFor(pool, b.type, b.id);
  if (!carte) return { ok: false, code: 404, msg: "item introuvable" };
  if (!carte.version || carte.version.id !== b.version || (carte.status !== "auto" && carte.status !== "to_review")) {
    return { ok: false, code: 409, msg: "le synopsis a changé ou n'est plus à valider : la carte est rechargée", carte };
  }
  const sentences = carte.version.data.sentences;
  const flagged: number[] = [];
  const marked: Record<string, number[]> = {};
  for (const p of b.phrases) {
    const s = sentences[p.index];
    if (s === undefined || sentenceKey(s) !== sentenceKey(p.texte)) return { ok: false, code: 409, msg: `phrase ${p.index + 1} introuvable dans cette version`, carte };
    const count = sentenceWords(s).length;
    if (p.mots.some((m) => m >= count)) return { ok: false, code: 400, msg: `mot hors de la phrase ${p.index + 1}` };
    if (!flagged.includes(p.index)) flagged.push(p.index);
    if (p.mots.length) marked[String(p.index)] = [...new Set([...(marked[String(p.index)] ?? []), ...p.mots])].sort((x, y) => x - y);
  }
  flagged.sort((x, y) => x - y);
  const request: CorrectionRequest = { version: b.version, flagged, marked, at: new Date().toISOString() };
  const res = await pool.query(
    `UPDATE ${TABLE[b.type]} SET synopsis_status = 'correction', synopsis_correction = ?, updated_at = updated_at
      WHERE id = ? AND synopsis_version_id = ? AND synopsis_status IN ('auto', 'to_review')`,
    [JSON.stringify(request), b.id, b.version],
  );
  return after(pool, b.type, b.id, res, "le synopsis a changé ou n'est plus à valider : la carte est rechargée");
}

/** Annuler une demande de correction pas encore traitée : l'item reprend le statut de sa version. */
export async function annulerDemande(pool: SqlPool, b: z.infer<typeof AnnulerSchema>): Promise<ActionResult> {
  const res = await pool.query(
    `UPDATE ${TABLE[b.type]} t
        SET t.synopsis_status = COALESCE((SELECT v.status FROM synopsis_versions v WHERE v.id = t.synopsis_version_id AND v.status IN ('auto', 'to_review')), 'to_review'),
            t.synopsis_correction = NULL, t.updated_at = t.updated_at
      WHERE t.id = ? AND t.synopsis_status = 'correction'`,
    [b.id],
  );
  return after(pool, b.type, b.id, res, "plus de demande en attente (déjà traitée ?) : la carte est rechargée");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

interface Reply {
  code(n: number): Reply;
  send(body: unknown): unknown;
}
interface Req {
  headers: Record<string, unknown>;
  query?: unknown;
  body?: unknown;
}
interface App {
  get(path: string, handler: (req: Req, reply: Reply) => Promise<unknown>): unknown;
  post(path: string, handler: (req: Req, reply: Reply) => Promise<unknown>): unknown;
  log: { error(obj: object, msg?: string): void };
}

/** Même clé que les autres routes /admin (requireApiKey d'index.ts), comparée à temps constant comme le Pilotage. */
function keyProblem(env: Record<string, string | undefined>, provided: unknown): { code: number; msg: string } | null {
  const expected = env["ADMIN_API_KEY"] || env["ANIME_API_KEY"] || env["GAMES_API_KEY"];
  if (!expected) return { code: 500, msg: "API key not configured" };
  if (typeof provided !== "string") return { code: 401, msg: "Unauthorized" };
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { code: 401, msg: "Unauthorized" };
  return null;
}

export function registerSynopsisBloc(app: App, pool: SqlPool, env: Record<string, string | undefined> = process.env): void {
  const guarded =
    <S extends z.ZodTypeAny>(schema: S, from: "query" | "body", run: (input: z.infer<S>) => Promise<unknown>) =>
    async (req: Req, reply: Reply): Promise<unknown> => {
      const bad = keyProblem(env, req.headers["x-api-key"]);
      if (bad) return reply.code(bad.code).send({ ok: false, msg: bad.msg });
      const parsed = schema.safeParse((from === "query" ? req.query : req.body) ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return reply.code(400).send({ ok: false, msg: `requête invalide : ${first ? `${first.path.join(".") || "(racine)"} : ${first.message}` : "?"}` });
      }
      try {
        const out = (await run(parsed.data)) as ActionResult | BlocState;
        if ("ok" in out && out.ok === false) return reply.code(out.code).send(out);
        return reply.send("ok" in out ? out : { ok: true, ...out });
      } catch (err) {
        app.log.error({ module: "synopsis-bloc", err }, "bloc synopsis : erreur");
        return reply.code(500).send({ ok: false, msg: err instanceof Error ? err.message : String(err) });
      }
    };
  app.get("/admin/synopsis", guarded(ListQuerySchema, "query", (q) => listState(pool, q)));
  app.get(
    "/admin/synopsis/carte",
    guarded(CarteQuerySchema, "query", async (q): Promise<ActionResult> => {
      const carte = await cardFor(pool, q.type, q.id);
      return carte ? { ok: true, carte } : { ok: false, code: 404, msg: "item introuvable" };
    }),
  );
  app.post("/admin/synopsis/valider", guarded(ValiderSchema, "body", (b) => valider(pool, b)));
  app.post("/admin/synopsis/annuler", guarded(AnnulerSchema, "body", (b) => annuler(pool, b)));
  app.post("/admin/synopsis/corriger", guarded(CorrigerSchema, "body", (b) => corriger(pool, b)));
  app.post("/admin/synopsis/annuler-demande", guarded(AnnulerSchema, "body", (b) => annulerDemande(pool, b)));
}

// ─── Le cycle, planifié par le Pilotage ──────────────────────────────────────

const PREMIER_MS = 2 * 60_000; // premier contrôle 2 min après le démarrage de l'API
const RYTHME_MS = 10 * 60_000; // puis un contrôle toutes les 10 min ; il ne rédige que dans sa fenêtre horaire
const PAR_LANCEMENT = 8; // lancé à la main : 8 corrections demandées au plus, puis un paquet au plus (8 synopsis)
let planned = false; // vrai une fois le cycle confié au Pilotage (le bloc montre alors son interrupteur)

/** « en continu, 10 synopsis au plus par passage », « chaque jour de 3 h à 7 h (heure de Paris), … ». */
export function rhythmText(cfg: SynopsisConfig): string {
  const [start, end] = cfg.window;
  const lot = `${cfg.maxPerRun} synopsis au plus par passage`;
  return start === 0 && end === 24 ? `en continu, ${lot}` : `chaque jour de ${start} h à ${end} h (heure de Paris), ${lot}`;
}

/** L'heure où la fenêtre horaire s'ouvre (ms) ; null si elle est ouverte maintenant. Paris est à une heure pile d'UTC. */
export function nextOpening(window: readonly [number, number], now: Date = new Date()): number | null {
  if (inWindow(parisHour(now), window)) return null;
  const HOUR = 3_600_000;
  for (let t = Math.floor(now.getTime() / HOUR) * HOUR + HOUR, k = 0; k < 48; k++, t += HOUR) {
    if (inWindow(parisHour(new Date(t)), window)) return t;
  }
  return null;
}

/** Les chiffres vivants de la ligne du Pilotage (relus au plus toutes les 30 s par le Pilotage). */
export async function pilotageInfos(pool: SqlPool, cfg: SynopsisConfig, now: Date = new Date()): Promise<Record<string, unknown>> {
  const k = await counts(pool);
  return {
    aValider: k.a_valider,
    valides: k.valides,
    correction: k.correction,
    sansSource: k.sans_source,
    pasTraites: k.pas_traites,
    rythme: rhythmText(cfg),
    ouverture: nextOpening(cfg.window, now),
    parLancement: Math.min(cfg.maxPerRun, PAR_LANCEMENT),
    msParItem: await msPerItem(pool),
  };
}

export interface PassageOptions {
  chat?: ChatFn;
  facts?: FactsFn;
  now?: () => Date;
  chunk?: number;
}

/**
 * Le dernier passage noté au Pilotage était-il en erreur ou incomplet (Ollama, AniList, API redémarrée) ? Lu en base
 * une fois après le démarrage, puis tenu à jour : un passage sans travail qui suit un tel passage est noté (« plus rien
 * à rédiger »), pour que la ligne du Pilotage quitte l'erreur (sinon elle y resterait jusqu'au prochain synopsis).
 */
let lastBad: boolean | null = null;
async function lastWasBad(pool: SqlPool): Promise<boolean> {
  if (lastBad === null) {
    try {
      const [r] = rowsOf(await pool.query("SELECT niveau FROM pilotage_passages WHERE module = 'synopsis' AND fin IS NOT NULL ORDER BY debut DESC, id DESC LIMIT 1"));
      lastBad = r ? ["k", "m"].includes(String(r["niveau"])) : false;
    } catch {
      lastBad = false;
    }
  }
  return lastBad;
}

/**
 * Un passage pour le Pilotage. Automatique : seulement s'il est allumé, hors pause, dans la fenêtre horaire (sinon
 * « rien », pas noté) ; il s'arrête après l'étape en cours si on le coupe ou si on met tout en pause. Lancé à la main :
 * à toute heure, les corrections (8 au plus) puis 8 synopsis au plus ; seul un changement pendant le passage l'arrête
 * (lancé pendant la pause, ou alors qu'il était coupé, il va jusqu'au bout).
 */
export async function synopsisPassage(deps: SynopsisDeps, cfg: SynopsisConfig, manual: boolean, opts: PassageOptions = {}): Promise<RetourPassage> {
  const now = opts.now ?? (() => new Date());
  if (!manual && (interrupteur("synopsis") !== true || enPause() || !inWindow(parisHour(now()), cfg.window))) return { rien: true };
  const offAtStart = manual && interrupteur("synopsis") !== true;
  const pausedAtStart = manual && enPause();
  const keepRunning = (): boolean => (pausedAtStart || !enPause()) && (offAtStart || interrupteur("synopsis") === true);
  const run: SynopsisConfig = manual ? { ...cfg, window: [0, 24] as const, maxPerRun: Math.min(cfg.maxPerRun, PAR_LANCEMENT) } : cfg;
  let r;
  try {
    r = await runBatch(deps, run, {
      keepRunning,
      ...(opts.chat ? { chat: opts.chat } : {}),
      ...(opts.facts ? { facts: opts.facts } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.chunk ? { chunk: opts.chunk } : {}),
    });
  } catch (err) {
    lastBad = true;
    deps.log.error({ module: "synopsis", err }, "synopsis : passage interrompu");
    throw err;
  }
  // un passage lancé à la main est toujours noté, même arrêté tout de suite ; un passage automatique sans travail ne
  // l'est que s'il suit un passage en erreur ou incomplet (la ligne du Pilotage revient alors à la normale)
  const worked = r.processed > 0 || r.postponed > 0 || r.corrections !== undefined || r.stop === "ollama" || (manual && r.stop === "off");
  if (worked) {
    const stats = await synopsisStats(deps.pool).catch(() => null);
    deps.log[r.stop === "ollama" ? "warn" : "info"]({ module: "synopsis", manual, ...r, stats }, "synopsis : passage terminé");
  } else if (r.stop === "off" || !(await lastWasBad(deps.pool))) {
    return { rien: true };
  }
  lastBad = r.stop === "ollama" || r.postponed > 0;
  const fin =
    r.stop === "ollama" ? "ollama" : r.stop === "off" ? "coupe" : r.stop === "window" ? "fenetre" : r.processed + r.postponed >= run.maxPerRun ? "limite" : "vide";
  return {
    bilan: {
      code: SYNOPSIS_CODE,
      manuel: manual,
      rediges: r.processed,
      auto: r.auto,
      aRelire: r.toReview,
      sansSource: r.noSource,
      echecs: r.failed,
      remis: r.postponed,
      corriges: r.corrections?.corrected ?? 0,
      correctionsEchec: r.corrections?.failed ?? 0,
      demandesIgnorees: r.corrections?.dropped ?? 0,
      demandesAnnulees: r.corrections?.cancelled ?? 0,
      fin,
      ollama: r.stop === "ollama" ? (r.error ?? "ne répond pas") : null,
      dureeS: r.durationS,
      jetons: r.tokens,
    },
  };
}

/**
 * Confie le cycle au Pilotage (à appeler une fois, avec les autres cycles). SYNOPSIS_ENABLED ne compte qu'à la
 * première mise en route ; une configuration invalide est montrée sur la ligne du Pilotage. `essai` : les essais
 * seulement (faux modèle, fausses sources).
 */
export function startSynopsisCron(deps: SynopsisDeps, env: Record<string, string | undefined> = process.env, essai: PassageOptions = {}): void {
  let cfg: SynopsisConfig;
  try {
    cfg = settingsFrom(env);
  } catch (err) {
    deps.log.error({ module: "synopsis", err }, "synopsis : configuration invalide, module arrêté");
    moduleIndisponible("synopsis", `configuration invalide : ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const actifParDefaut = env["SYNOPSIS_ENABLED"] === "1";
  const active = cfg;
  deps.log.info(
    { module: "synopsis", model: active.model, window: active.window.join("-"), maxPerRun: active.maxPerRun, actifParDefaut },
    "synopsis : planifié par le Pilotage",
  );
  planifier({
    id: "synopsis",
    premierMs: PREMIER_MS,
    rythmeMs: RYTHME_MS,
    actifParDefaut,
    passage: ({ manuel }) => synopsisPassage(deps, active, manuel, essai),
    infos: () => pilotageInfos(deps.pool, active),
  });
  planned = true;
}

/** Les essais seulement : le cycle oublié (avec _oublierPourEssais du Pilotage). */
export function _forgetForTests(): void {
  planned = false;
  lastBad = null;
}
