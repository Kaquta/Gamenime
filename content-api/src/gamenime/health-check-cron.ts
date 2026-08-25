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
    if (!res.ok) return { status: "DOWN", httpCode: res.status, errorMsg: `HTTP ${res.status}`, responseMs: ms };
    // GraphQL repond 200 meme en cas d'erreur : le vrai statut est DANS le corps.
    // AniList coupe son API en renvoyant { errors:[{ message, status:403 }], data:null }
    // avec un HTTP 200 — un simple res.ok concluait donc a tort que tout allait bien.
    const corps = await res.json().catch(() => null) as any;
    if (!corps || corps.errors || corps.data == null) {
      const msg = corps?.errors?.[0]?.message || "reponse GraphQL sans data";
      const code = corps?.errors?.[0]?.status ?? res.status;
      return { status: "DOWN", httpCode: code, errorMsg: String(msg).slice(0, 200), responseMs: ms };
    }
    return { status: "UP", httpCode: res.status, errorMsg: null, responseMs: ms };
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
  const tombees: Array<{ source: string; code: number | null; msg: string }> = [];
  for (const [source, fn] of list) {
    try {
      const r = await fn();
      await saveResult(pool, source, r);
      app.log.info({ source, status: r.status, httpCode: r.httpCode, ms: r.responseMs }, "Health check source");
      if (r.status === "DOWN") {
        tombees.push({ source, code: r.httpCode, msg: r.errorMsg || "sans detail" });
      }
    } catch (e: any) {
      app.log.error({ source, err: String(e?.message || e) }, "Health check erreur inattendue");
      tombees.push({ source, code: null, msg: String(e?.message || e).slice(0, 120) });
    }
  }
  if (tombees.length) await alerterSources(app, pool, tombees);
  if (!only) await verifierCyclesInternes(app);
  app.log.info("Health check cycle termine");
}

// ── Alerte Discord quand une source externe tombe ────────────────────
// On ne repete pas l'alerte a chaque passage : une source coupee plusieurs
// jours enverrait 4 messages quotidiens. On ne parle qu'a la BASCULE,
// c'est-a-dire quand la source etait encore OK au controle precedent.
async function alerterSources(
  app: FastifyInstance,
  pool: Pool,
  tombees: Array<{ source: string; code: number | null; msg: string }>
): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_ERRORS;
  if (!url) return;

  const nouvelles: typeof tombees = [];
  for (const t of tombees) {
    try {
      const rows: any = await pool.query(
        "SELECT last_ok, last_check FROM source_health WHERE source = ?",
        [t.source]
      );
      const r = rows?.[0];
      // Bascule = le dernier OK date de moins de 7h (donc du controle precedent).
      // Au-dela, la source est deja signalee comme tombee : on se tait.
      const okMs = r?.last_ok ? new Date(r.last_ok).getTime() : 0;
      if (!okMs || Date.now() - okMs < 7 * 3600000) nouvelles.push(t);
    } catch {
      nouvelles.push(t);
    }
  }
  if (!nouvelles.length) {
    app.log.info({ tombees: tombees.length }, "Health check: sources deja signalees, pas de nouvelle alerte");
    return;
  }

  const lignes = nouvelles.map(
    (t) => `**${t.source}** \u2014 ${t.code ? "HTTP " + t.code : "injoignable"} \u00b7 ${t.msg}`
  );
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "\ud83d\udd34 Source de donn\u00e9es indisponible",
          description: lignes.join("\n"),
          color: 15158332,
          footer: { text: "GameNime \u00b7 Health check" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch {
    /* le suivi ne doit jamais faire echouer le health check */
  }
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
  // Session 33 : passage de 1x/jour a 4x/jour. Avec un seul controle a minuit,
  // une source tombee a 3h restait affichee "UP" pendant vingt heures — c'est
  // exactement ce qui s'est passe avec la coupure de l'API AniList.
  const HEURES = [0, 6, 12, 18];
  let dernierCreneau = -1;
  app.log.info({ heures: HEURES }, "Health check cron demarre (toutes les 6h)");
  return setInterval(async () => {
    const now = new Date();
    const h = now.getHours();
    const creneau = now.getDate() * 100 + h;
    if (HEURES.indexOf(h) !== -1 && dernierCreneau !== creneau) {
      dernierCreneau = creneau;
      app.log.info({ heure: h }, "Health check declenche");
      await runHealthCheck(app, pool);
    }
  }, 60 * 1000);
}
