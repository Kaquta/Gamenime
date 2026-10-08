/**
 * synopsis-essai.ts — essai à blanc du module synopsis : rien n'est écrit en base.
 *
 * Dans le conteneur content-api, Ollama démarré :
 *   node dist/gamenime/synopsis-essai.js anime:52,57 jeu:149,165   items précis
 *   node dist/gamenime/synopsis-essai.js hasard:12                 12 items de la fenêtre tirés au hasard, hors top relu
 *   node dist/gamenime/synopsis-essai.js suivants:20               les 20 prochains du cron
 * Les trois se combinent : anime:52 jeu:149 hasard:10.
 *
 * Pour chaque item : fiche (AniList / IGDB), dossier (Wikipédia, Google, IGDB,
 * œuvre précédente), source nettoyée, sens (le texte redit en anglais simple), notes
 * gardées et retirées, statut et motif, temps passé à chaque étape, essais refaits
 * (et pourquoi), synopsis et avis de la relecture. Au
 * début, une sonde dit si Ollama réutilise son cache d'un appel à l'autre.
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
  draftItems,
  factsBlock,
  fetchItemsByIds,
  fetchQueue,
  fetchSample,
  ollamaChat,
  probeCache,
  readConfig,
  tokenUsage,
  webSearchEnabled,
  type Draft,
  type DraftTiming,
  type ItemType,
  type Job,
  type ProbeResult,
} from "./synopsis.js";

const USAGE = `Usage : node dist/gamenime/synopsis-essai.js anime:52,57 jeu:149,165   (items précis)
        node dist/gamenime/synopsis-essai.js hasard:12                 (au hasard dans la fenêtre, hors top relu)
        node dist/gamenime/synopsis-essai.js suivants:20               (les 20 prochains du cron)`;

const TYPES: Record<string, ItemType> = { anime: "anime", "animé": "anime", jeu: "game", game: "game" };

const DbEnv = z.object({
  DB_HOST: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASS: z.string(),
  DB_NAME: z.string().min(1),
});

const STATUS: Record<string, string> = {
  auto: "publiable tel quel",
  to_review: "à relire",
  failed: "refusé",
  no_source: "pas de source exploitable",
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
  if (t.writeMs > 0) parts.push(`rédaction ${duration(t.writeMs - t.reviewMs)}`);
  if (t.reviewMs > 0) parts.push(`relecture ${duration(t.reviewMs)}`);
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
function factsLine(d: Draft): string {
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

export function render(d: Draft): string {
  const o = d.outcome;
  const title = d.item.title_english?.trim() || d.item.title;
  const rank = d.item.pop_rank !== null ? ` · rang ${d.item.pop_rank}` : "";
  const lines = [`━━━ ${d.type === "anime" ? "animé" : "jeu"} ${d.item.id} · ${title}${rank} ━━━`, `FICHE : ${factsLine(d)}`];
  if (d.facts?.dossier.length) lines.push("DOSSIER :", ...d.facts.dossier.map((e) => `  - [${e.source}] ${preview(e.text)}`));
  lines.push(`SOURCE : ${d.source || "(vide)"}`);
  if (d.sense.length) lines.push("SENS :", ...d.sense.map((s) => `  - ${s}`));
  lines.push("NOTES :", ...(d.notes.length ? d.notes.map((n) => `  - ${n}`) : ["  (aucune)"]));
  if (d.dropped.length) lines.push("NOTES RETIRÉES :", ...d.dropped.map((n) => `  - ${n}`));
  lines.push(`RÉSULTAT : ${STATUS[o.status] ?? o.status}${o.note ? ` — ${o.note}` : ""} · ${duration(d.ms)}`);
  if (d.timing) lines.push(`TEMPS : ${timingLine(d.timing)}`);
  // essais écartés, avec la raison (contrôles, longueur, relecture) ; le texte gardé est le dernier qui le porte
  const attempts = o.attempts ?? [];
  const kept = o.text === null ? -1 : attempts.map((a) => a.text).lastIndexOf(o.text);
  attempts.forEach((a, i) => {
    if (i !== kept) lines.push(`ESSAI ${i + 1} ÉCARTÉ (${a.refused.join(" · ")}) : ${a.text}`);
  });
  if (o.text) lines.push(`SYNOPSIS (${[...o.text].length} car.) : ${o.text}`);
  if (o.text && o.review !== undefined) {
    lines.push(`RELECTURE : ${o.review === null ? "sans réponse" : o.review.length ? o.review.join(" | ") : "rien à redire"}`);
  }
  if (o.rejected && attempts.length === 0) lines.push(`DERNIER ESSAI REFUSÉ : ${o.rejected}`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  // lecteur parti (terminal fermé, tee arrêté) : l'essai s'arrête au lieu de continuer pour rien
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
  let sel: Selection;
  try {
    sel = parseArgs(process.argv.slice(2));
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
    console.error(`Essai à blanc, rien n'est écrit en base : ${jobs.length} items sur ${asked} demandés, modèle ${cfg.model}.`);
    if (jobs.length === 0) return;
    console.error("Le premier appel charge le modèle (1 à 2 min).");
    console.log(webSearchEnabled() ? "Recherche web : Google, via Serper" : "Recherche web : désactivée (SERPER_API_KEY absente du conteneur)");

    const probe = jobs.find((j) => cleanSource(j.item.description).length >= 60);
    if (probe) {
      const [a, b] = await probeCache(cfg, buildNotesMessages(probe.type, probe.item, cleanSource(probe.item.description)));
      console.log(`${cacheLine(a, b)}\n`);
    }

    const started = Date.now();
    const tally: Record<string, number> = {};
    let done = 0;
    await draftItems(
      cfg,
      jobs,
      ollamaChat,
      (d) => {
        done++;
        tally[d.outcome.status] = (tally[d.outcome.status] ?? 0) + 1;
        console.log(render(d));
        const spent = Date.now() - started;
        const left = done < jobs.length ? ` · environ ${duration((spent / done) * (jobs.length - done))} restantes` : "";
        console.error(`… ${done}/${jobs.length} terminés en ${duration(spent)}${left}`);
      },
      { onStep: (step, job) => console.error(`  ${step} : ${job.item.title_english?.trim() || job.item.title}`) },
    );
    const total = Date.now() - started;
    const parts = Object.entries(tally).map(([status, n]) => `${STATUS[status] ?? status} ${n}`);
    const t = tokenUsage();
    console.log(`Bilan : ${done} items en ${duration(total)} (${duration(total / Math.max(1, done))} par item) · ${parts.join(" · ")}`);
    console.log(
      `Ollama : ${cfg.model} · ${t.calls} appels · ${t.input} jetons lus en ${duration(t.inputMs)} (${rate(t.input, t.inputMs)}) · ` +
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
