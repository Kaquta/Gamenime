/**
 * synopsis-essai.ts — essai à blanc du module synopsis : rien n'est écrit en base.
 *
 * Dans le conteneur content-api, Ollama démarré :
 *   node dist/gamenime/synopsis-essai.js anime:52,57 jeu:149,165   items précis
 *   node dist/gamenime/synopsis-essai.js hasard:12                 12 items de la fenêtre tirés au hasard, hors top relu
 *   node dist/gamenime/synopsis-essai.js suivants:20               les 20 prochains du cron
 * Les trois se combinent : anime:52 jeu:149 hasard:10.
 *   node dist/gamenime/synopsis-essai.js correction < cas.json     corrige les phrases signalées
 * Correction (v8.8, mots faux v8.9) : chaque cas donne un item, son synopsis et ses phrases fausses (copiées telles
 * quelles) ; seules ces phrases sont réécrites, d'après les sources relues. Affiche, pour chaque phrase,
 * la preuve recopiée par le modèle (et la source où elle est retrouvée) et la correction ; puis le
 * synopsis d'après, phrases corrigées marquées. Format des cas :
 *   [{ "type": "anime", "id": 52, "synopsis": "…", "fausses": ["Tout change lorsqu’elle…"] }]
 * Une phrase fausse peut porter les mots faux touchés par le relecteur (comme il les verrait, séparés par
 * des espaces) : { "phrase": "Tout change…", "mots": ["lui", "révèle"] }.
 *
 * v9.4 : CONTRÔLE, chaque phrase contre la preuve de sa note (OUI / NON), et ce que devient une phrase NON.
 * Pour chaque item : fiche (AniList / IGDB), site officiel (v9.3 : adresse, texte gardé ; site japonais :
 * sa description et la traduction faite par le modèle), dossier (animés : Kitsu, AnimeSchedule,
 * Anime News Network, presse ; jeux : Wikipédia, IGDB, Steam ; œuvre précédente), articles de presse
 * examinés et leur sort, source nettoyée (animés : la description AniList à jour), notes gardées (v9.1 :
 * chacune avec la source et le passage qui la prouvent) et retirées, statut et motif, temps passé à chaque
 * étape, essais refaits (et pourquoi), synopsis (v9.1 : une phrase par note). Au
 * début, une sonde dit si Ollama réutilise son cache d'un appel à l'autre.
 * « Sans alerte » : les contrôles (copie, ton, longueur, noms, dates, genre) n'ont rien trouvé.
 * Le sens, eux ne le vérifient pas (essai v8.6 : contresens dans 2 textes sur 8 « sans alerte »).
 * Résultats sur la sortie standard, avancement sur la sortie d'erreur : avec
 * « | tee fichier », le fichier ne garde que les résultats.
 */
import { pathToFileURL } from "node:url";
import * as mariadb from "mariadb";
import { z } from "zod";
import {
  OllamaError,
  buildNotesMessages,
  cleanSource,
  correctSentences,
  draftItems,
  markedSpans,
  sentenceWords,
  factsBlock,
  factsFor,
  factsWithPress,
  fetchItemsByIds,
  fetchQueue,
  fetchSample,
  ollamaChat,
  probeCache,
  readConfig,
  splitSentences,
  tokenUsage,
  type CorrectionOutcome,
  type SentenceFix,
  type Draft,
  type DraftTiming,
  type ItemFacts,
  type ItemType,
  type Job,
  type OfficialSeen,
  type CheckReport,
  type ProbeResult,
  type SqlPool,
  type SynopsisConfig,
  type TokenUsage,
} from "./synopsis.js";

const USAGE = `Usage : node dist/gamenime/synopsis-essai.js anime:52,57 jeu:149,165   (items précis)
        node dist/gamenime/synopsis-essai.js hasard:12                 (au hasard dans la fenêtre, hors top relu)
        node dist/gamenime/synopsis-essai.js suivants:20               (les 20 prochains du cron)
        node dist/gamenime/synopsis-essai.js correction < cas.json     (corrige les phrases signalées)`;

const TYPES: Record<string, ItemType> = { anime: "anime", "animé": "anime", jeu: "game", game: "game" };

const DbEnv = z.object({
  DB_HOST: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASS: z.string(),
  DB_NAME: z.string().min(1),
});

// « auto » : aucune alerte des contrôles ; ce n'est pas une garantie de sens (v8.7, ex « publiable tel quel »).
// « failed » : texte refusé par les contrôles, ou fiche indisponible (AniList), d'où « échec » (ex « refusé »)
const STATUS: Record<string, string> = {
  auto: "sans alerte",
  to_review: "à relire",
  failed: "échec",
  no_source: "pas de source exploitable",
  postponed: "remis au passage suivant",
};

export interface Selection {
  ids: Record<ItemType, number[]>;
  next: number;
  random: number;
}

/** « anime:52,57 jeu:149 », « hasard:12 », « suivants:20 », combinables. Lève une erreur lisible si un argument est faux. */
export function parseArgs(args: string[]): Selection {
  const sel: Selection = { ids: { anime: [], game: [] }, next: 0, random: 0 };
  for (const arg of args) {
    const m = /^([^:]+):(.+)$/.exec(arg.trim());
    const key = m?.[1]?.toLowerCase() ?? "";
    const values = (m?.[2] ?? "").split(",").map((v) => Number(v.trim()));
    if (!m || values.some((v) => !Number.isInteger(v) || v <= 0)) throw new Error(`argument incompris : « ${arg} »`);
    if (key === "suivants" && values.length === 1) sel.next = values[0] ?? 0;
    else if (key === "hasard" && values.length === 1) sel.random = values[0] ?? 0;
    else if (TYPES[key]) sel.ids[TYPES[key]].push(...values);
    else throw new Error(`argument incompris : « ${arg} »`);
  }
  if (sel.next === 0 && sel.random === 0 && sel.ids.anime.length + sel.ids.game.length === 0) throw new Error("aucun item demandé");
  return sel;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function rate(tokens: number, ms: number): string {
  return ms > 0 ? `${Math.round(tokens / (ms / 1000))} jetons/s` : "durée inconnue";
}

/** Vitesse avec une décimale : la génération tourne autour de quelques jetons par seconde. */
function rate1(tokens: number, ms: number): string {
  return ms > 0 ? `${(tokens / (ms / 1000)).toFixed(1).replace(".", ",")} jetons/s` : "durée inconnue";
}

/** Où est passé le temps de l'item, et ce qu'Ollama a lu et généré pour lui. */
export function timingLine(t: DraftTiming): string {
  const parts = [`sources ${duration(t.factsMs)}`, `notes ${duration(t.notesMs)}`];
  if (t.writeMs > 0) parts.push(`rédaction ${duration(t.writeMs)}`);
  if (t.checkMs !== undefined && t.checkMs > 0) parts.push(`contrôle ${duration(t.checkMs)}`);
  const u = t.usage;
  if (u.calls > 0) {
    parts.push(
      `Ollama ${u.calls} appel${u.calls > 1 ? "s" : ""}, ${u.input} jetons lus en ${duration(u.inputMs)}, ` +
        `${u.output} générés en ${duration(u.outputMs)} (${rate1(u.output, u.outputMs)})`,
    );
  }
  return parts.join(" · ");
}

/** Verdict de la sonde : le 2e envoi identique doit se lire bien plus vite si le cache sert. */
export function cacheLine(a: ProbeResult, b: ProbeResult): string {
  const verdict =
    a.ms <= 0
      ? "durées non fournies par Ollama"
      : b.ms < a.ms * 0.25
        ? "cache réutilisé"
        : "cache non réutilisé : chaque appel relit tout le prompt";
  return `Cache d'Ollama : 1er envoi ${a.tokens} jetons lus en ${seconds(a.ms)} · 2e envoi identique ${b.tokens} jetons lus en ${seconds(b.ms)} → ${verdict}`;
}

/** Fiche sur une ligne, suivie de ce qui a manqué (identifiant, article Wikipédia…). */
function factsLine(d: { facts: ItemFacts | null; factsNote: string | null }): string {
  const block = factsBlock(d.facts);
  const shown = block
    ? block.replace(/^Fiche \(données vérifiées\) :\n/, "").split("\n").join(" · ")
    : d.facts
      ? "vide (aucun personnage connu)"
      : "indisponible";
  return d.factsNote ? `${shown} — ${d.factsNote}` : shown;
}

/** Début d'un texte du dossier, pour l'affichage. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}… (${flat.length} car.)` : flat;
}

/** v9.3 : le site officiel, son texte gardé ; pour un site japonais, la description et sa traduction. */
function officialLines(o: OfficialSeen | undefined): string[] {
  if (!o) return ["SITE OFFICIEL : aucun connu (AniList, IGDB)"];
  const lines = [`SITE OFFICIEL : ${o.url ?? "?"}${o.note ? ` — ${o.note}` : ""}`];
  if (o.original) lines.push(`  japonais : ${o.original.replace(/\s+/g, " ").trim()}`);
  if (o.text) lines.push(`  ${o.original ? "traduction" : "texte gardé"} : ${preview(o.text)}`);
  return lines;
}

/** v9.4 : chaque phrase contre sa preuve ; une phrase NON, corrigée ou retirée. */
function checkLines(c: CheckReport | undefined): string[] {
  if (!c) return [];
  if (c.checks.length === 0) return [`CONTRÔLE : ${c.note ?? "aucun"}`];
  const lines = [`CONTRÔLE (chaque phrase contre sa preuve)${c.note ? ` — ${c.note}` : ""} :`];
  c.checks.forEach((k, i) => {
    lines.push(`  ${i + 1}. ${k.verdict}${k.verdict === "NON" && k.why ? ` : ${k.why}` : k.verdict === "?" && k.why ? ` (réponse illisible : ${k.why})` : ""}`);
    if (k.fixed !== undefined) lines.push(`      ${k.unconfirmed === undefined ? "corrigée" : "correction écartée"} : ${k.fixed}`);
    if (k.unconfirmed !== undefined) lines.push(`      NON CONFIRMÉE, gardée telle quelle (${k.unconfirmed})`);
  });
  return lines;
}

/** Titre d'article sur une ligne, coupé s'il est très long. */
function headline(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export function render(d: Draft): string {
  const o = d.outcome;
  const title = d.item.title_english?.trim() || d.item.title;
  const rank = d.item.pop_rank !== null ? ` · rang ${d.item.pop_rank}` : "";
  const lines = [`━━━ ${d.type === "anime" ? "animé" : "jeu"} ${d.item.id} · ${title}${rank} ━━━`, `FICHE : ${factsLine(d)}`, ...officialLines(d.official)];
  if (d.facts?.dossier.length) lines.push("DOSSIER :", ...d.facts.dossier.map((e) => `  - [${e.source}] ${preview(e.text)}`));
  // chaque article de la presse et son sort : un refus se juge sur le titre (essai v8.6 : JJK, « titre sans numéro de saison »)
  if (d.press?.length) lines.push("PRESSE :", ...d.press.map((p) => `  - [${p.site}] « ${headline(p.titre)} » : ${p.verdict}`));
  lines.push(`SOURCE : ${d.source || "(vide)"}`);
  if (d.sense.length) lines.push("SENS :", ...d.sense.map((s) => `  - ${s}`));
  // v9.1 : sous chaque note, la source où sa preuve est retrouvée et le passage, pour juger à la lecture
  const proofLine = (i: number) => {
    const p = d.proofs?.[i];
    return p ? [`      ← ${p.label}${p.exact ? "" : " (approchée)"} : « ${p.passage} »`] : [];
  };
  lines.push("NOTES :", ...(d.notes.length ? d.notes.flatMap((n, i) => [`  ${i + 1}. ${n}`, ...proofLine(i)]) : ["  (aucune)"]));
  if (d.dropped.length) lines.push("NOTES RETIRÉES :", ...d.dropped.map((n) => `  - ${n}`));
  lines.push(...checkLines(d.check));
  lines.push(`RÉSULTAT : ${STATUS[o.status] ?? o.status}${o.note ? ` — ${o.note}` : ""} · ${duration(d.ms)}`);
  if (d.timing) lines.push(`TEMPS : ${timingLine(d.timing)}`);
  // essais écartés, avec la raison (contrôles, longueur) ; le texte gardé est le dernier qui le porte
  const attempts = o.attempts ?? [];
  // v9.4 : le texte rédigé (avant le contrôle phrase / preuve) est celui du dernier essai gardé
  const written = d.check?.before ?? o.text;
  const kept = written === null ? -1 : attempts.map((a) => a.text).lastIndexOf(written);
  attempts.forEach((a, i) => {
    if (i !== kept) lines.push(`ESSAI ${i + 1} ÉCARTÉ (${a.refused.join(" · ")}) : ${a.text}`);
  });
  if (o.text) lines.push(`SYNOPSIS (${[...o.text].length} car.) : ${o.text}`);
  if (o.rejected && attempts.length === 0) lines.push(`DERNIER ESSAI REFUSÉ : ${o.rejected}`);
  return `${lines.join("\n")}\n`;
}

// ─── Correction des phrases signalées (v8.8) ─────────────────────────────────

const CaseSchema = z.object({
  type: z.string().transform((t, ctx) => {
    const type = TYPES[t.trim().toLowerCase()];
    if (!type) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `type inconnu « ${t} » (anime ou jeu)` });
    return type ?? "anime";
  }),
  id: z.number().int().positive(),
  synopsis: z.string().trim().min(1),
  fausses: z
    .array(z.union([z.string().trim().min(1), z.object({ phrase: z.string().trim().min(1), mots: z.array(z.string().trim().min(1)).default([]) })]))
    .min(1),
});
export type CorrectionCase = z.infer<typeof CaseSchema>;

/** Cas de correction lus en JSON (un tableau, ou un seul cas). Lève une erreur lisible. */
export function parseCases(text: string): CorrectionCase[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`cas illisibles (JSON) : ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = z.array(CaseSchema).min(1).safeParse(Array.isArray(json) ? json : [json]);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`cas invalides : ${first ? `${first.path.join(".") || "(racine)"} : ${first.message}` : "?"}`);
  }
  return parsed.data;
}

/** Phrase comparée sans tenir compte des espaces, des apostrophes ni des guillemets typographiques. */
function sentenceKey(s: string): string {
  return s.replace(/[’‘`´]/g, "'").replace(/[“”«»]/g, '"').replace(/\s+/g, " ").trim();
}

/** Mot comparé sans accents, majuscules, apostrophes typographiques ni ponctuation autour. */
function wordKey(w: string): string {
  return w
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/^[«"“(]+|[,;:.!?…»"”)]+$/g, "");
}

export type Flag = string | { phrase: string; mots?: readonly string[] | undefined };

/**
 * Indices des phrases signalées dans le synopsis découpé (une phrase écrite deux fois est signalée
 * aux deux endroits), et positions des mots faux dans chacune (`sentenceWords`) ; `missing` : phrases
 * ou mots introuvables.
 */
export function locateFlagged(
  sentences: readonly string[],
  fausses: readonly Flag[],
): { flagged: number[]; marked: Record<number, number[]>; missing: string[] } {
  const keys = sentences.map(sentenceKey);
  const flagged = new Set<number>();
  const marked: Record<number, number[]> = {};
  const missing: string[] = [];
  for (const f of fausses) {
    const phrase = typeof f === "string" ? f : f.phrase;
    const mots = typeof f === "string" ? [] : (f.mots ?? []);
    const k = sentenceKey(phrase);
    const at = keys.flatMap((x, i) => (x === k ? [i] : []));
    if (at.length === 0) missing.push(phrase);
    for (const i of at) {
      flagged.add(i);
      const words = sentenceWords(sentences[i] ?? "").map(wordKey);
      let from = 0; // mots donnés dans l'ordre de la phrase : chacun cherché après le précédent, sinon depuis le début
      for (const mot of mots) {
        // « lui révèle » : des mots qui se suivent
        const want = mot.split(/\s+/).map(wordKey);
        const at = (start: number) => words.findIndex((_w, p) => p >= start && want.every((x, d) => words[p + d] === x));
        const start = at(from) === -1 ? at(0) : at(from);
        if (start === -1) missing.push(`${mot} (phrase ${i + 1})`);
        else {
          marked[i] = [...new Set([...(marked[i] ?? []), ...want.map((_x, d) => start + d)])].sort((a, b) => a - b);
          from = start + want.length;
        }
      }
    }
  }
  return { flagged: [...flagged].sort((a, b) => a - b), marked, missing };
}

export interface CorrectionDraft extends Job {
  facts: ItemFacts | null;
  factsNote: string | null;
  source: string;
  before: string[]; // le synopsis d'avant, phrase par phrase
  flagged: number[];
  marked?: Record<number, number[]>; // mots faux touchés, par phrase (positions dans sentenceWords)
  outcome: CorrectionOutcome;
  factsMs: number;
  fixMs: number;
  usage: TokenUsage;
  official?: OfficialSeen; // v9.3
}

function chars(s: string): number {
  return [...s].length;
}

/** Preuve et correction d'une phrase signalée ; `indent` : sous un essai écarté. */
function fixLines(f: SentenceFix, indent = ""): string[] {
  const n = `${indent}PHRASE ${f.index + 1}`;
  if (f.text === null) return [`${n} · SUPPRIMÉE (preuve : ${f.proof || "aucune"}${f.found === null ? ", introuvable" : ""})`];
  const lines: string[] = [];
  if (f.found === null) lines.push(`${n} · PREUVE INTROUVABLE : « ${f.proof} »`);
  else {
    // preuve recopiée avec un mot changé, ou en morceaux : le vrai passage à côté, pour juger
    lines.push(`${n} · PREUVE (${f.found.label}${f.found.exact ? "" : ", approchée"}) : « ${f.proof} »`);
    if (!f.found.exact) lines.push(`${n} · DANS LA SOURCE : « ${f.found.passage} »`);
  }
  lines.push(`${n} · CORRECTION : ${f.text}`);
  return lines;
}

export function renderCorrection(c: CorrectionDraft): string {
  const o = c.outcome;
  const title = c.item.title_english?.trim() || c.item.title;
  const rank = c.item.pop_rank !== null ? ` · rang ${c.item.pop_rank}` : "";
  const lines = [`━━━ correction · ${c.type === "anime" ? "animé" : "jeu"} ${c.item.id} · ${title}${rank} ━━━`, `FICHE : ${factsLine(c)}`, ...officialLines(c.official)];
  if (c.facts?.dossier.length) lines.push("DOSSIER :", ...c.facts.dossier.map((e) => `  - [${e.source}] ${preview(e.text)}`));
  lines.push(`SOURCE : ${c.source || "(vide)"}`);
  const wordsOf = (i: number) => markedSpans(c.before[i] ?? "", c.marked?.[i] ?? []);
  lines.push(
    `AVANT (${chars(c.before.join(" "))} car.) :`,
    ...c.before.map((s, i) => {
      const spans = wordsOf(i);
      return `  ${i + 1}. ${c.flagged.includes(i) ? "[FAUSSE] " : ""}${s}${spans.length ? ` — mots faux : ${spans.map((w) => `« ${w} »`).join(", ")}` : ""}`;
    }),
  );
  for (const f of o.fixes) lines.push(...fixLines(f));
  const total = c.factsMs + c.fixMs;
  if (o.status === "corrected") {
    const rewritten = o.fixes.filter((f) => f.text !== null).length;
    const kept = c.before.length - c.flagged.length;
    const parts = [`${rewritten} phrase${rewritten > 1 ? "s" : ""} réécrite${rewritten > 1 ? "s" : ""}`];
    if (o.removed) parts.push(`${o.removed} supprimée${o.removed > 1 ? "s" : ""}`);
    parts.push(`${kept} gardée${kept > 1 ? "s" : ""} à l'identique`);
    lines.push(`RÉSULTAT : corrigé — ${parts.join(", ")}${o.warnings.length ? ` — alertes : ${o.warnings.join(" · ")}` : ""} · ${duration(total)}`);
  } else lines.push(`RÉSULTAT : échec — ${o.note ?? "?"} (le synopsis d'avant reste tel quel) · ${duration(total)}`);
  const u = c.usage;
  const ollama =
    u.calls > 0
      ? ` · Ollama ${u.calls} appel${u.calls > 1 ? "s" : ""}, ${u.input} jetons lus en ${duration(u.inputMs)}, ${u.output} générés en ${duration(u.outputMs)} (${rate1(u.output, u.outputMs)})`
      : "";
  lines.push(`TEMPS : sources ${duration(c.factsMs)} · correction ${duration(c.fixMs)}${ollama}`);
  const keptAttempt = o.status === "corrected" ? o.attempts.length - 1 : -1;
  // chaque essai écarté, avec ses preuves : une preuve inventée se distingue d'une preuve mal retrouvée
  o.attempts.forEach((a, i) => {
    if (i === keptAttempt) return;
    lines.push(`ESSAI ${i + 1} ÉCARTÉ (${a.refused.join(" · ")}) : ${a.text}`);
    for (const f of a.fixes) lines.push(...fixLines(f, "  "));
  });
  if (o.status === "corrected") {
    lines.push(`APRÈS (${chars(o.text)} car.) :`, ...o.sentences.map((s, i) => `  ${i + 1}. ${o.corrected.includes(i) ? "[CORRIGÉE] " : ""}${s}`));
  }
  return `${lines.join("\n")}\n`;
}

function usageDiff(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { calls: b.calls - a.calls, input: b.input - a.input, output: b.output - a.output, inputMs: b.inputMs - a.inputMs, outputMs: b.outputMs - a.outputMs };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

/** Essai de correction : rien n'est écrit en base. */
async function runCorrections(pool: SqlPool, cfg: SynopsisConfig, cases: CorrectionCase[]): Promise<void> {
  console.error(`Essai de correction, rien n'est écrit en base : ${cases.length} cas, modèle ${cfg.model}, ${cfg.threads} cœurs.`);
  console.error("Le premier appel charge le modèle (1 à 2 min).");
  const getFacts = factsWithPress(pool);
  const started = Date.now();
  const tally = { corrected: 0, failed: 0, skipped: 0, rewritten: 0, removed: 0, kept: 0 };
  let done = 0;
  for (const k of cases) {
    const label = `${k.type === "anime" ? "animé" : "jeu"} ${k.id}`;
    const [found] = await fetchItemsByIds(pool, k.type, [k.id]);
    if (!found) {
      tally.skipped++;
      console.log(`━━━ correction · ${label} ━━━\nCAS IGNORÉ : item introuvable en base\n`);
      continue;
    }
    console.error(`  correction : ${found.title_english?.trim() || found.title}`);
    const t0 = Date.now();
    const f = await factsFor({ type: k.type, item: found }, getFacts, { cfg, chat: ollamaChat });
    const factsMs = Date.now() - t0;
    const source = cleanSource(f.item.description);
    const reference = [source, ...(f.facts?.dossier ?? []).map((e) => e.text)].join("\n");
    const before = splitSentences(k.synopsis, reference);
    const { flagged, marked, missing } = locateFlagged(before, k.fausses);
    if (missing.length || flagged.length === 0) {
      tally.skipped++;
      const shown = before.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
      console.log(`━━━ correction · ${label} · ${found.title_english?.trim() || found.title} ━━━\nCAS IGNORÉ : phrase ou mot introuvable dans le synopsis : ${missing.map((m) => `« ${m} »`).join(", ")}\nPHRASES DU SYNOPSIS :\n${shown}\n`);
      continue;
    }
    const u0 = tokenUsage();
    const t1 = Date.now();
    const outcome = await correctSentences(cfg, k.type, f.item, before, flagged, ollamaChat, f.facts, marked);
    const draft: CorrectionDraft = {
      type: k.type,
      item: f.item,
      facts: f.facts,
      factsNote: f.retryLater ? `${f.note ?? "?"} (fiche indisponible : correction sans fiche)` : f.note,
      source,
      before,
      flagged,
      marked,
      outcome,
      factsMs,
      fixMs: Date.now() - t1,
      usage: usageDiff(u0, tokenUsage()),
      ...(f.official ? { official: f.official } : {}),
    };
    console.log(renderCorrection(draft));
    done++;
    if (outcome.status === "corrected") {
      tally.corrected++;
      tally.rewritten += outcome.fixes.filter((x) => x.text !== null).length;
      tally.removed += outcome.removed;
      tally.kept += before.length - flagged.length;
    } else tally.failed++;
    console.error(`… ${done + tally.skipped}/${cases.length} cas en ${duration(Date.now() - started)}`);
  }
  const total = Date.now() - started;
  const t = tokenUsage();
  const parts = [`corrigés ${tally.corrected}`, `échec ${tally.failed}`];
  if (tally.skipped) parts.push(`ignorés ${tally.skipped}`);
  console.log(
    `Bilan : ${cases.length} cas en ${duration(total)} · ${parts.join(" · ")} · phrases réécrites ${tally.rewritten} · supprimées ${tally.removed} · gardées à l'identique ${tally.kept}`,
  );
  console.log("Le sens se juge à la lecture : comparer chaque phrase corrigée à sa preuve et aux sources.");
  console.log(
    `Ollama : ${cfg.model} · ${cfg.threads} cœurs · ${t.calls} appels · ${t.input} jetons lus en ${duration(t.inputMs)} (${rate(t.input, t.inputMs)}) · ` +
      `${t.output} générés en ${duration(t.outputMs)} (${rate(t.output, t.outputMs)})`,
  );
}

async function main(): Promise<void> {
  // lecteur parti (terminal fermé, tee arrêté) : l'essai s'arrête au lieu de continuer pour rien
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
  const args = process.argv.slice(2);
  let cases: CorrectionCase[] | null = null;
  let sel: Selection = { ids: { anime: [], game: [] }, next: 0, random: 0 };
  try {
    if (args[0]?.toLowerCase() === "correction") {
      if (args.length > 1) throw new Error("la correction lit ses cas sur l'entrée : correction < cas.json");
      if (process.stdin.isTTY) throw new Error("aucun cas : donne le fichier sur l'entrée (correction < cas.json)");
      cases = parseCases(await readStdin());
    } else sel = parseArgs(args);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const db = DbEnv.safeParse(process.env);
  if (!db.success) {
    console.error("Variables DB_HOST, DB_USER, DB_PASS, DB_NAME absentes : lance l'essai dans le conteneur content-api.");
    process.exitCode = 2;
    return;
  }
  let cfg: ReturnType<typeof readConfig>;
  try {
    cfg = readConfig({ ...process.env, SYNOPSIS_ENABLED: "1" });
  } catch (err) {
    console.error(`Configuration invalide : ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  if (!cfg) return;
  const pool = mariadb.createPool({
    host: db.data.DB_HOST,
    user: db.data.DB_USER,
    password: db.data.DB_PASS,
    database: db.data.DB_NAME,
    connectionLimit: 2,
  });
  try {
    if (cases) {
      await runCorrections(pool, cfg, cases);
      return;
    }
    const picked: Job[] = [
      ...(await fetchItemsByIds(pool, "anime", sel.ids.anime)).map((item): Job => ({ type: "anime", item })),
      ...(await fetchItemsByIds(pool, "game", sel.ids.game)).map((item): Job => ({ type: "game", item })),
      ...(sel.random > 0 ? await fetchSample(pool, sel.random, cfg.reviewTop) : []),
      ...(sel.next > 0 ? await fetchQueue(pool, sel.next) : []),
    ];
    const seen = new Set<string>();
    const jobs = picked.filter((j) => {
      const key = `${j.type}:${j.item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const asked = sel.ids.anime.length + sel.ids.game.length + sel.random + sel.next;
    console.error(`Essai à blanc, rien n'est écrit en base : ${jobs.length} items sur ${asked} demandés, modèle ${cfg.model}, ${cfg.threads} cœurs.`);
    if (jobs.length === 0) return;
    console.error("Le premier appel charge le modèle (1 à 2 min).");

    const probe = jobs.find((j) => cleanSource(j.item.description).length >= 60);
    if (probe) {
      const [a, b] = await probeCache(cfg, buildNotesMessages(probe.type, probe.item, cleanSource(probe.item.description)));
      console.log(`${cacheLine(a, b)}\n`);
    }

    const started = Date.now();
    const tally: Record<string, number> = {};
    let done = 0;
    let itemsMs = 0;
    await draftItems(
      cfg,
      jobs,
      ollamaChat,
      (d) => {
        done++;
        itemsMs += d.ms;
        tally[d.outcome.status] = (tally[d.outcome.status] ?? 0) + 1;
        console.log(render(d));
        // moyenne du temps par item, pas du temps écoulé : les notes de tout un paquet passent avant
        // sa première rédaction, et le premier item terminé porterait tout ce temps (essai v8.1 : « 7 h 05 »)
        const left = done < jobs.length ? ` · environ ${duration((itemsMs / done) * (jobs.length - done))} restantes` : "";
        console.error(`… ${done}/${jobs.length} terminés en ${duration(Date.now() - started)}${left}`);
      },
      { facts: factsWithPress(pool), onStep: (step, job) => console.error(`  ${step} : ${job.item.title_english?.trim() || job.item.title}`) },
    );
    const total = Date.now() - started;
    const parts = Object.entries(tally).map(([status, n]) => `${STATUS[status] ?? status} ${n}`);
    const t = tokenUsage();
    console.log(`Bilan : ${done} items en ${duration(total)} (${duration(total / Math.max(1, done))} par item) · ${parts.join(" · ")}`);
    if (tally["auto"]) console.log("« Sans alerte » : les contrôles n'ont rien trouvé (copie, ton, longueur, noms, dates, genre) ; le sens n'est pas vérifié.");
    console.log(
      `Ollama : ${cfg.model} · ${cfg.threads} cœurs · ${t.calls} appels · ${t.input} jetons lus en ${duration(t.inputMs)} (${rate(t.input, t.inputMs)}) · ` +
        `${t.output} générés en ${duration(t.outputMs)} (${rate(t.output, t.outputMs)})`,
    );
  } catch (err) {
    if (!(err instanceof OllamaError)) throw err;
    console.error(`Arrêt : ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Lancé directement (pas importé par un test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
