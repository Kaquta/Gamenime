// ════════════════════════════════════════════════════════
// Health Check Cron — GameNime API surveille ses propres sources
// Ping quotidien (00h00) de chaque source externe. Stocke UP/DOWN
// dans la table source_health. Detecte quota epuise (401), rate
// limit (429), API down (timeout) — ce que les workflows n8n
// "avalent" silencieusement.
// ════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";

type Pool = any;

interface PingResult {
  status: "UP" | "DOWN";
  httpCode: number | null;
  errorMsg: string | null;
  responseMs: number | null;
}

// ── Helper : fetch avec timeout ──
async function fetchWithTimeout(url: string, opts: any = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Twitch token pour IGDB (meme flow que refetch-games-cron) ──
let TWITCH_TOKEN: { token: string; expiresAt: number } | null = null;
async function getTwitchToken(): Promise<string | null> {
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  if (TWITCH_TOKEN && TWITCH_TOKEN.expiresAt > Date.now() + 60000) return TWITCH_TOKEN.token;
  try {
    const res = await fetchWithTimeout(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: "POST" }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!data.access_token) return null;
    TWITCH_TOKEN = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return TWITCH_TOKEN.token;
  } catch {
    return null;
  }
}

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
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  const t0 = Date.now();
  const token = await getTwitchToken();
  if (!token || !clientId) return { status: "DOWN", httpCode: 401, errorMsg: "Twitch auth echouee", responseMs: Date.now() - t0 };
  try {
    const res = await fetchWithTimeout("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
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
    const res = await fetchWithTimeout("https://animeschedule.net/api/v3/anime?mt=all&page=1", { headers });
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
export async function runHealthCheck(app: FastifyInstance, pool: Pool): Promise<void> {
  const checks: Array<[string, () => Promise<PingResult>]> = [
    ["rawg", pingRawg],
    ["igdb", pingIgdb],
    ["anilist", pingAnilist],
    ["jikan", pingJikan],
    ["animeschedule", pingAnimeSchedule],
  ];
  for (const [source, fn] of checks) {
    try {
      const r = await fn();
      await saveResult(pool, source, r);
      app.log.info({ source, status: r.status, httpCode: r.httpCode, ms: r.responseMs }, "Health check source");
    } catch (e: any) {
      app.log.error({ source, err: String(e?.message || e) }, "Health check erreur inattendue");
    }
  }
  app.log.info("Health check cycle termine");
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
