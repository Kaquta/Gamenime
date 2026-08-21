// ════════════════════════════════════════════════════════
// Health Check Cron — GameNime API surveille ses propres sources
// Ping quotidien (00h00) de chaque source externe. Stocke UP/DOWN
// dans la table source_health. Detecte quota epuise (401), rate
// limit (429), API down (timeout) — ce que les workflows n8n
// "avalent" silencieusement.
// ════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { getTwitchToken, fetchWithTimeout, igdbFetch } from "./twitch.js";
import { getLastRun } from "./dashboard.js";

type Pool = any;

interface PingResult {
  status: "UP" | "DOWN";
  httpCode: number | null;
  errorMsg: string | null;
  responseMs: number | null;
}

// ── Helper : fetch avec timeout ──

// ── Twitch token pour IGDB (meme flow que refetch-games-cron) ──

// ── Ping RAWG ──
async function pingRawg(): Promise<PingResult> {
  const key = process.env.RAWG_API_KEY || "";
  const t0 = Date.now();
  if (!key) return { status: "DOWN", httpCode: null, errorMsg: "RAWG_API_KEY absente", responseMs: null };
  try {
    const res = await fetchWithTimeout(`https://api.rawg.io/api/games?key=${key}&page_size=1`);
    const ms = Date.now() - t0;
    if (res.ok) return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
    return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
  } catch (e: any) {
    return { status: "DOWN", httpCode: null, errorMsg: e?.name === "AbortError" ? "timeout" : String(e?.message || e), responseMs: Date.now() - t0 };
  }
}

// ── Ping IGDB (via Twitch) ──
async function pingIgdb(): Promise<PingResult> {
  const t0 = Date.now();
  try {
    // igdbFetch gere token + Client-ID + Authorization, ET le retry sur 401
    // (token revoque avant expiration -> invalide + regenere + rejoue).
    const res = await igdbFetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "fields id; limit 1;",
    });
    const ms = Date.now() - t0;
    if (res.ok) return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
    return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
  } catch (e: any) {
    return { status: "DOWN", httpCode: null, errorMsg: e?.name === "AbortError" ? "timeout" : String(e?.message || e), responseMs: Date.now() - t0 };
  }
}

// ── Ping AniList (GraphQL, pas de cle) ──
async function pingAnilist(): Promise<PingResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: "{ Media(id: 1) { id } }" }),
    });
    const ms = Date.now() - t0;
    if (res.ok) return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
    return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
  } catch (e: any) {
    return { status: "DOWN", httpCode: null, errorMsg: e?.name === "AbortError" ? "timeout" : String(e?.message || e), responseMs: Date.now() - t0 };
  }
}

// ── Ping Jikan (pas de cle) ──
async function pingJikan(): Promise<PingResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.jikan.moe/v4/anime/1");
    const ms = Date.now() - t0;
    if (res.ok) return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
    return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
  } catch (e: any) {
    return { status: "DOWN", httpCode: null, errorMsg: e?.name === "AbortError" ? "timeout" : String(e?.message || e), responseMs: Date.now() - t0 };
  }
}

// ── Ping AnimeSchedule (avec token) ──
async function pingAnimeSchedule(): Promise<PingResult> {
  const token = process.env.ANIMESCHEDULE_TOKEN || "";
  const t0 = Date.now();
  try {
    const headers: any = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchWithTimeout("https://animeschedule.net/api/v3/anime?q=one%20piece", { headers });
    const ms = Date.now() - t0;
    if (res.ok) return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
    return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
  } catch (e: any) {
    return { status: "DOWN", httpCode: null, errorMsg: e?.name === "AbortError" ? "timeout" : String(e?.message || e), responseMs: Date.now() - t0 };
  }
}

// ── Enregistrer un resultat en base ──
async function saveResult(pool: Pool, source: string, r: PingResult) {
  const okClause = r.status === "UP" ? ", last_ok = NOW()" : "";
  await pool.query(
    `UPDATE source_health
     SET status = ?, http_code = ?, error_msg = ?, response_ms = ?, last_check = NOW()${okClause}
     WHERE source = ?`,
    [r.status, r.httpCode, r.errorMsg, r.responseMs, source]
  );
}

// ── Lancer tous les pings ──
export async function runHealthCheck(app: FastifyInstance, pool: Pool, only?: string): Promise<void> {
  const checks: Array<[string, () => Promise<PingResult>]> = [
    ["rawg", pingRawg],
    ["igdb", pingIgdb],
    ["anilist", pingAnilist],
    ["jikan", pingJikan],
    ["animeschedule", pingAnimeSchedule],
  ];
  const list = only ? checks.filter(function(c) { return c[0] === only; }) : checks;
  for (const [source, fn] of list) {
    try {
      const r = await fn();
      await saveResult(pool, source, r);
      app.log.info({ source, status: r.status, httpCode: r.httpCode, ms: r.responseMs }, "Health check source");
    } catch (e: any) {
      app.log.error({ source, err: String(e?.message || e) }, "Health check erreur inattendue");
    }
  }
  if (!only) await verifierCyclesInternes(app);
  app.log.info("Health check cycle termine");
}

// ── Silence radio : on ne parle que si un cycle s'est tu ──────────────
// Un cron mort et un cron sans travail se ressemblent dans les logs.
// trackLastRun est appele a CHAQUE passage, meme a zero rattachement :
// son absence prolongee signale donc un vrai arret, pas une accalmie.
const CYCLES_SURVEILLES: Array<{ cle: string; nom: string; toleranceH: number }> = [
  { cle: "match-anime-routes", nom: "Routes AnimeSchedule", toleranceH: 48 },
  { cle: "refetch-cron", nom: "Refetch Phase B", toleranceH: 6 },
];

async function verifierCyclesInternes(app: FastifyInstance): Promise<void> {
  const muets: string[] = [];
  for (const c of CYCLES_SURVEILLES) {
    const run = getLastRun(c.cle);
    if (!run) {
      muets.push(`**${c.nom}** — aucun passage enregistré depuis le démarrage`);
      continue;
    }
    const heures = (Date.now() - run.ts) / 3600000;
    if (heures > c.toleranceH) {
      muets.push(`**${c.nom}** — silencieux depuis ${Math.round(heures)} h (seuil ${c.toleranceH} h)`);
    }
  }
  if (!muets.length) {
    app.log.info({ cycles: CYCLES_SURVEILLES.length }, "Health check: cycles internes OK");
    return;
  }
  app.log.error({ muets }, "Health check: cycles internes silencieux");
  const url = process.env.DISCORD_WEBHOOK_ERRORS;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "\u26a0\ufe0f Cycle interne silencieux",
          description: muets.join("\n"),
          color: 15158332,
          footer: { text: "GameNime \u00b7 Health check quotidien" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch {
    /* le suivi ne doit jamais faire echouer le health check */
  }
}

// ── Cron : lance a 00h00 chaque jour ──
export function startHealthCheckCron(app: FastifyInstance, pool: Pool): NodeJS.Timeout {
  let lastRunDay = -1;
  app.log.info("Health check cron demarre (00h00 quotidien)");
  // Verifie toutes les minutes si on est a 00h00 et qu'on n'a pas deja tourne aujourd'hui
  return setInterval(async () => {
    const now = new Date();
    const day = now.getDate();
    if (now.getHours() === 0 && lastRunDay !== day) {
      lastRunDay = day;
      app.log.info("Health check declenche (00h00)");
      await runHealthCheck(app, pool);
    }
  }, 60 * 1000);
}
