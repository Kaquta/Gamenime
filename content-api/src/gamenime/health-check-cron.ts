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
import { startControleDonnees } from "./controle-donnees.js";
import { planifier, surveillance } from "./pilotage.js";

type Pool = any;

interface PingResult {
  status: "UP" | "DOWN";
  httpCode: number | null;
  errorMsg: string | null;
  responseMs: number | null;
}

// ── Helper : fetch avec timeout ──

// ── Twitch token pour IGDB (meme flow que refetch-games-cron) ──

// RAWG n'est plus controle : retire au profit d'IGDB (igdb-jeux.ts, 13 octobre 2026).

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

// ── Ping Kitsu (pas de cle) : il remplace Jikan, ferme le 1er octobre 2026 ──
async function pingKitsu(): Promise<PingResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://kitsu.io/api/edge/anime/1", {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "GameNime/1.0 (+https://gamenime.fr)" },
    });
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
    ["igdb", pingIgdb],
    ["anilist", pingAnilist],
    ["kitsu", pingKitsu],
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
// Pilotage (17 octobre 2026) : un cycle coupé, en pause ou arrêté avec celui dont il dépend n'est pas surveillé ; son
// dernier passage vient du Pilotage (gardé en base : il survit aux redémarrages de l'API).
const CYCLES_SURVEILLES: Array<{ module: string; nom: string; toleranceH: number }> = [
  { module: "routes-as", nom: "Routes AnimeSchedule", toleranceH: 48 },
  { module: "phase-b-animes", nom: "Refetch Phase B", toleranceH: 6 },
  // Jeux IGDB (igdb-jeux.ts) : un passage toutes les 3 h
  { module: "igdb-jeux", nom: "Jeux IGDB (listes et notes)", toleranceH: 8 },
  // Steam (steam-jeux.ts, arrêté avec les jeux IGDB) : un passage toutes les 2 h
  { module: "steam", nom: "Steam (dates PC des jeux)", toleranceH: 6 },
  // Contrôle des données des animés (controle-donnees.ts) : chaque jour à 5 h 30 UTC
  { module: "controle-donnees", nom: "Contrôle des données (animés)", toleranceH: 30 },
  // Licences et univers (licences.ts) : chaque jour à 3 h 10 UTC
  { module: "licences", nom: "Licences et univers", toleranceH: 30 },
];

async function verifierCyclesInternes(app: FastifyInstance): Promise<void> {
  const muets: string[] = [];
  for (const c of CYCLES_SURVEILLES) {
    const s = surveillance(c.module);
    if (!s.suivi) continue;
    if (!s.reference) {
      // juste apres un demarrage, un cycle n'a pas encore eu le temps de passer (premiers passages : 50 min au plus)
      if (process.uptime() > 3600) muets.push(`**${c.nom}** — aucun passage enregistré depuis le démarrage`);
      continue;
    }
    const heures = (Date.now() - s.reference) / 3600000;
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
  // Pilotage (17 octobre 2026) : mêmes heures qu'avant (0 h, 6 h, 12 h et 18 h UTC, l'heure du conteneur) ; un créneau
  // manqué pendant un arrêt de l'API est rattrapé 2 min après le démarrage.
  const HEURES = [0, 6, 12, 18];
  // Le contrôle quotidien des données des animés (16 octobre 2026) : lancé ici, avec la surveillance de l'API
  startControleDonnees(app);
  planifier({
    id: "sante", premierMs: 2 * 60 * 1000, heuresUtc: HEURES,
    passage: async () => {
      await runHealthCheck(app, pool);
    },
  });
  app.log.info({ heures: HEURES }, "Health check cron demarre (toutes les 6h)");
  return setTimeout(() => {}, 0);
}
