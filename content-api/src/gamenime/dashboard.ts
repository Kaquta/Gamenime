/**
 * GameNime Dashboard — Observabilité temps réel (enrichi mockup-compliant)
 */
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as tls from "node:tls";

const __dirname_esm = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════
// Ring buffers : activity + requests
// ════════════════════════════════════════════════════════
interface ActivityEvent {
  ts: number;
  type: string;
  message: string;
  detail?: string;
  level?: "info" | "warn" | "error";
}
const ACTIVITY_BUFFER: ActivityEvent[] = [];
const ACTIVITY_MAX = 50;
export function pushActivity(event: Omit<ActivityEvent, "ts">) {
  ACTIVITY_BUFFER.unshift({ ts: Date.now(), ...event });
  if (ACTIVITY_BUFFER.length > ACTIVITY_MAX) ACTIVITY_BUFFER.length = ACTIVITY_MAX;
}

interface LastRun { ts: number; duration_ms?: number; details?: Record<string, any>; }
const LAST_RUNS: Record<string, LastRun> = {};
export function getLastRun(name: string): LastRun | undefined {
  return LAST_RUNS[name];
}
export function trackLastRun(name: string, details?: Record<string, any>, duration_ms?: number) {
  LAST_RUNS[name] = { ts: Date.now(), duration_ms, details };
}

// Cache hit/miss
let CACHE_HITS = 0, CACHE_MISSES = 0;
export function trackCacheHit() { CACHE_HITS++; }
export function trackCacheMiss() { CACHE_MISSES++; }
function getCacheHitRate(): number {
  const t = CACHE_HITS + CACHE_MISSES;
  return t === 0 ? 0 : Math.round((CACHE_HITS / t) * 100);
}

// Request counter (rolling 60s)
const REQUEST_TIMESTAMPS: number[] = [];
export function trackRequest() {
  const now = Date.now();
  REQUEST_TIMESTAMPS.push(now);
  // Garder seulement dernière minute
  while (REQUEST_TIMESTAMPS.length > 0 && REQUEST_TIMESTAMPS[0] < now - 60000) {
    REQUEST_TIMESTAMPS.shift();
  }
}
function getRequestsPerMinute(): number { return REQUEST_TIMESTAMPS.length; }

// ════════════════════════════════════════════════════════
// Tracking visiteurs (trafic du site) — 24h glissantes
// ════════════════════════════════════════════════════════
interface Visit { ts: number; path: string; source: string; vid: string; }
const VISITS: Visit[] = [];
const VISITS_MAX = 50000;
const LIVE_PINGS = new Map<string, number>();

// Pool DB pour persistance des stats (mois/année)
let STATS_POOL: any = null;
export function setStatsPool(pool: any) { STATS_POOL = pool; }

// Suivi des visiteurs uniques du jour (reset auto à minuit)
let TODAY_VISITORS = new Set<string>();
let TODAY_DATE = new Date().toDateString();
function isNewVisitorToday(vid: string): boolean {
  const now = new Date().toDateString();
  if (now !== TODAY_DATE) { TODAY_VISITORS.clear(); TODAY_DATE = now; }
  if (TODAY_VISITORS.has(vid)) return false;
  TODAY_VISITORS.add(vid);
  return true;
}

// Enregistre la visite en DB (daily_stats) — fire-and-forget
function recordVisitDB(source: string, isNewVisitor: boolean) {
  if (!STATS_POOL) return;
  const today = new Date().toISOString().split("T")[0];
  STATS_POOL.query(
    `INSERT INTO daily_stats (stat_date, source, visits, unique_visitors, page_views)
     VALUES (?, ?, 1, ?, 1)
     ON DUPLICATE KEY UPDATE visits = visits + 1, page_views = page_views + 1, unique_visitors = unique_visitors + ?`,
    [today, source, isNewVisitor ? 1 : 0, isNewVisitor ? 1 : 0]
  ).catch(() => {});
}

// Stats agrégées par période (mois/année) — requêtes dynamiques
async function getPeriodStats() {
  if (!STATS_POOL) return { month: [], year: [], month_total: 0, year_total: 0 };
  try {
    const monthRows: any = await STATS_POOL.query(
      `SELECT source, SUM(visits) AS visits, SUM(unique_visitors) AS uniques
       FROM daily_stats WHERE stat_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
       GROUP BY source ORDER BY visits DESC`
    );
    const yearRows: any = await STATS_POOL.query(
      `SELECT source, SUM(visits) AS visits, SUM(unique_visitors) AS uniques
       FROM daily_stats WHERE stat_date >= DATE_FORMAT(CURDATE(), '%Y-01-01')
       GROUP BY source ORDER BY visits DESC`
    );
    const mTotal = monthRows.reduce((s: number, r: any) => s + Number(r.visits), 0);
    const yTotal = yearRows.reduce((s: number, r: any) => s + Number(r.visits), 0);
    return {
      month: monthRows.map((r: any) => [r.source, Number(r.visits)]),
      year: yearRows.map((r: any) => [r.source, Number(r.visits)]),
      month_total: mTotal,
      year_total: yTotal,
    };
  } catch {
    return { month: [], year: [], month_total: 0, year_total: 0 };
  }
}

function purgeOldVisits() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  while (VISITS.length > 0 && VISITS[0].ts < cutoff) VISITS.shift();
}

function parseSource(ref: string): string {
  if (!ref) return "Direct";
  try {
    const h = new URL(ref).hostname.replace(/^www\./, "");
    if (h.includes("tiktok")) return "TikTok";
    if (h.includes("discord")) return "Discord";
    if (h.includes("google")) return "Google";
    if (h.includes("youtube")) return "YouTube";
    if (h.includes("twitter") || h === "t.co" || h.includes("x.com")) return "Twitter/X";
    if (h.includes("reddit")) return "Reddit";
    if (h.includes("instagram")) return "Instagram";
    if (h.includes("teams.") || h.includes("microsoft")) return "Teams";
    if (h.includes("facebook") || h === "fb.com" || h.includes("fb.me")) return "Facebook";
    if (h.includes("linkedin") || h === "lnkd.in") return "LinkedIn";
    if (h.includes("twitch")) return "Twitch";
    if (h.includes("bing")) return "Bing";
    if (h.includes("gamenime.fr")) return "Direct";
    return h;
  } catch { return "Direct"; }
}

export function trackVisit(path: string, ref: string, vid: string) {
  const now = Date.now();
  LIVE_PINGS.set(vid, now);
  const source = parseSource(ref);
  VISITS.push({ ts: now, path: path || "/", source, vid });
  if (VISITS.length > VISITS_MAX) VISITS.shift();
  // Persistance DB (mois/année)
  recordVisitDB(source, isNewVisitorToday(vid));
}

export function trackPing(vid: string) {
  LIVE_PINGS.set(vid, Date.now());
}

async function getTrafficMetrics() {
  purgeOldVisits();
  const now = Date.now();
  let live = 0;
  for (const [vid, ts] of LIVE_PINGS) {
    if (ts > now - 60000) live++;
    else LIVE_PINGS.delete(vid);
  }
  const uniqueVids = new Set<string>();
  const sources: Record<string, number> = {};
  const pages: Record<string, number> = {};
  for (const v of VISITS) {
    uniqueVids.add(v.vid);
    sources[v.source] = (sources[v.source] || 0) + 1;
    pages[v.path] = (pages[v.path] || 0) + 1;
  }
  const topSources = Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topPages = Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const periods = await getPeriodStats();
  return {
    live,
    visits_24h: VISITS.length,
    unique_24h: uniqueVids.size,
    sources: topSources,
    top_pages: topPages,
    month: periods.month,
    year: periods.year,
    month_total: periods.month_total,
    year_total: periods.year_total,
  };
}

// SSE actifs counter
let SSE_ACTIVE = 0;

// ════════════════════════════════════════════════════════
// Réseau : delta /proc/net/dev
// ════════════════════════════════════════════════════════
let NET_PREV: { ts: number; rx: number; tx: number } | null = null;
async function readNetwork() {
  try {
    const data = await fs.readFile("/proc/net/dev", "utf-8");
    let rx = 0, tx = 0;
    for (const line of data.split("\n")) {
      const m = line.trim().match(/^(\S+):\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/);
      if (m && m[1] !== "lo") { rx += parseInt(m[2]); tx += parseInt(m[3]); }
    }
    const now = Date.now();
    let rx_per_sec = 0, tx_per_sec = 0;
    if (NET_PREV) {
      const dt = (now - NET_PREV.ts) / 1000;
      if (dt > 0) {
        rx_per_sec = Math.max(0, (rx - NET_PREV.rx) / dt);
        tx_per_sec = Math.max(0, (tx - NET_PREV.tx) / dt);
      }
    }
    NET_PREV = { ts: now, rx, tx };
    return { rx_per_sec: Math.round(rx_per_sec), tx_per_sec: Math.round(tx_per_sec) };
  } catch { return { rx_per_sec: 0, tx_per_sec: 0 }; }
}

// ════════════════════════════════════════════════════════
// System
// ════════════════════════════════════════════════════════
async function readSystemMetrics() {
  try {
    const loadavg = (await fs.readFile("/proc/loadavg", "utf-8")).trim().split(/\s+/);
    const meminfo = await fs.readFile("/proc/meminfo", "utf-8");
    const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? "0") * 1024;
    const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? "0") * 1024;
    const memUsed = memTotal - memAvailable;
    const uptimeRaw = (await fs.readFile("/proc/uptime", "utf-8")).trim().split(/\s+/);
    const uptimeSeconds = Math.floor(parseFloat(uptimeRaw[0]));
    let diskTotal = 0, diskUsed = 0;
    try {
      const stat: any = await (fs as any).statfs("/");
      diskTotal = Number(stat.blocks) * Number(stat.bsize);
      diskUsed = (Number(stat.blocks) - Number(stat.bavail)) * Number(stat.bsize);
    } catch {}
    const net = await readNetwork();
    return {
      load: { "1min": parseFloat(loadavg[0]), "5min": parseFloat(loadavg[1]), "15min": parseFloat(loadavg[2]) },
      mem: { total: memTotal, used: memUsed, percent: Math.round((memUsed / memTotal) * 100) },
      disk: { total: diskTotal, used: diskUsed, percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0 },
      uptime: uptimeSeconds,
      net,
    };
  } catch (e: any) { return { error: e?.message ?? "fail" }; }
}

// ════════════════════════════════════════════════════════
// Catalog + DB
// ════════════════════════════════════════════════════════
async function readCatalogMetrics(pool: any) {
  const t0 = Date.now();
  try {
    const a: any = await pool.query(`SELECT COUNT(*) AS total, SUM(cover IS NULL OR cover='') AS no_cover, SUM(cover LIKE '%myanimelist.net%' OR cover LIKE '%animeschedule.net%') AS hotlink, SUM(platform IS NULL OR platform='') AS no_platform, SUM(trailer_url IS NULL OR trailer_url='') AS no_trailer FROM anime_items`);
    const g: any = await pool.query(`SELECT COUNT(*) AS total, SUM(cover IS NULL OR cover='') AS no_cover FROM game_items`);
    const bl: any = await pool.query(`SELECT COUNT(*) AS total FROM merge_blocklist`);
    const u: any = await pool.query(`SELECT COUNT(*) AS total, SUM(is_premium=1 AND (premium_expires_at IS NULL OR premium_expires_at > NOW())) AS premium, SUM(email_verified_at IS NOT NULL) AS verified FROM users`);
    const f: any = await pool.query(`SELECT COUNT(*) AS total FROM favorites`);
    const n: any = await pool.query(`SELECT COUNT(*) AS unread FROM user_notifications WHERE read_at IS NULL`);
    const r: any = await pool.query(`SELECT COUNT(*) AS sent FROM reminder_log WHERE email_sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
    // DB size + connections
    const dbSize: any = await pool.query(`SELECT SUM(data_length + index_length) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()`);
    const dbConn: any = await pool.query(`SHOW STATUS LIKE 'Threads_connected'`);
    return {
      anime: { total: Number(a[0].total||0), no_cover: Number(a[0].no_cover||0), hotlink: Number(a[0].hotlink||0), no_platform: Number(a[0].no_platform||0), no_trailer: Number(a[0].no_trailer||0) },
      games: { total: Number(g[0].total||0), no_cover: Number(g[0].no_cover||0) },
      blocklist: Number(bl[0].total||0),
      users: { total: Number(u[0].total||0), premium: Number(u[0].premium||0), verified: Number(u[0].verified||0) },
      favorites: Number(f[0].total||0),
      notif_unread: Number(n[0].unread||0),
      reminders_24h: Number(r[0].sent||0),
      db: {
        latency_ms: Date.now() - t0,
        size_bytes: Number(dbSize[0]?.bytes || 0),
        connections: Number(dbConn[0]?.Value || 0),
      },
    };
  } catch (e: any) { return { error: e?.message ?? "fail", db: { latency_ms: Date.now() - t0 } }; }
}

// ════════════════════════════════════════════════════════
// Workflows : last push par source
// ════════════════════════════════════════════════════════
async function readWorkflowMetrics(pool: any) {
  try {
    const anilist: any = await pool.query(`SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS lp FROM anime_items WHERE cover LIKE '%anilistcdn%' OR cover LIKE '%s4.anilist%'`);
    const jikan: any = await pool.query(`SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS lp FROM anime_items WHERE mal_id IS NOT NULL`);
    const animsched: any = await pool.query(`SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS lp FROM anime_items WHERE anime_schedule_route IS NOT NULL`);
    const rawg: any = await pool.query(`SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS lp FROM game_items WHERE cover LIKE '%rawg.io%' OR cover LIKE '%igdb%'`);
    // Intervals (en ms) pour calculer prochain run
    const INTERVALS = { anilist: 3*3600000, jikan: 3*3600000, animeschedule: 3*3600000, rawg: 2.5*3600000 };
    function buildEntry(key: string, ts: any) {
      // ts = UNIX_TIMESTAMP() en secondes UTC (independant du TZ MariaDB)
      const tsMs = ts && Number(ts) > 0 ? Number(ts) * 1000 : null;
      const tsIso = tsMs ? new Date(tsMs).toISOString() : null;
      const trackerKey = key === "rawg" ? "push-games-rawg" : `push-anime-${key}`;
      const run = LAST_RUNS[trackerKey];
      const items_pushed = run?.details?.total ?? null;
      const next_run = tsMs ? tsMs + INTERVALS[key as keyof typeof INTERVALS] : null;
      return { last_push: tsIso, items_pushed, next_run };
    }
    return {
      anilist: buildEntry("anilist", anilist[0]?.lp),
      jikan: buildEntry("jikan", jikan[0]?.lp),
      animeschedule: buildEntry("animeschedule", animsched[0]?.lp),
      rawg: buildEntry("rawg", rawg[0]?.lp),
    };
  } catch (e: any) { return { error: e?.message ?? "fail" }; }
}

// ════════════════════════════════════════════════════════
// Snapshot
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// Vérification SSL (certificat) — cache 1h
// ════════════════════════════════════════════════════════
let SSL_CACHE: { daysLeft: number | null; validTo: string | null; checkedAt: number } = { daysLeft: null, validTo: null, checkedAt: 0 };

function checkSSL(): Promise<{ daysLeft: number | null; validTo: string | null }> {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect(443, "gamenime.fr", { servername: "gamenime.fr", timeout: 5000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (cert && cert.valid_to) {
          const expiry = new Date(cert.valid_to).getTime();
          const daysLeft = Math.floor((expiry - Date.now()) / (1000 * 3600 * 24));
          resolve({ daysLeft, validTo: cert.valid_to });
        } else {
          resolve({ daysLeft: null, validTo: null });
        }
      });
      socket.on("error", () => resolve({ daysLeft: null, validTo: null }));
      socket.on("timeout", () => { socket.destroy(); resolve({ daysLeft: null, validTo: null }); });
    } catch {
      resolve({ daysLeft: null, validTo: null });
    }
  });
}

async function getSSLStatus(): Promise<{ daysLeft: number | null; validTo: string | null }> {
  const now = Date.now();
  if (now - SSL_CACHE.checkedAt < 3600000 && SSL_CACHE.checkedAt > 0) {
    return { daysLeft: SSL_CACHE.daysLeft, validTo: SSL_CACHE.validTo };
  }
  const result = await checkSSL();
  SSL_CACHE = { ...result, checkedAt: now };
  return result;
}

async function readSourceHealth(pool: any) {
  try {
    const rows: any = await pool.query(
      "SELECT source, status, http_code, response_ms, error_msg, " +
      "UNIX_TIMESTAMP(last_check) AS last_check_ts, UNIX_TIMESTAMP(last_ok) AS last_ok_ts, " +
      "UNIX_TIMESTAMP(last_lookup_warn) AS last_lookup_warn_ts, last_lookup_warn_msg " +
      "FROM source_health ORDER BY source"
    );
    return rows.map((r: any) => ({
      source: r.source,
      status: r.status,
      httpCode: r.http_code,
      responseMs: r.response_ms,
      errorMsg: r.error_msg,
      lastCheck: r.last_check_ts ? Number(r.last_check_ts) * 1000 : null,
      lastOk: r.last_ok_ts ? Number(r.last_ok_ts) * 1000 : null,
      lookupWarn: r.last_lookup_warn_ts ? Number(r.last_lookup_warn_ts) * 1000 : null,
      lookupWarnMsg: r.last_lookup_warn_msg || null,
    }));
  } catch (e: any) {
    return [];
  }
}

export async function collectMetrics(pool: any) {
  const [system, catalog, workflows, sourceHealth] = await Promise.all([
    readSystemMetrics(), readCatalogMetrics(pool), readWorkflowMetrics(pool), readSourceHealth(pool)
  ]);
  return {
    ts: Date.now(), system, catalog, workflows, sourceHealth,
    crons: LAST_RUNS,
    cache: { hits: CACHE_HITS, misses: CACHE_MISSES, hit_rate: getCacheHitRate() },
    requests_per_min: getRequestsPerMinute(),
    sse_active: SSE_ACTIVE,
    traffic: await getTrafficMetrics(),
    ssl: await getSSLStatus(),
    activity: ACTIVITY_BUFFER.slice(0, 20),
  };
}

// ════════════════════════════════════════════════════════
// SSE Stream + page HTML
// ════════════════════════════════════════════════════════
export function startDashboard(app: FastifyInstance, pool: any) {
  // Hook global pour compter les requests
  app.addHook("onRequest", async () => { trackRequest(); });

  app.get("/admin/dashboard/stream", async (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    reply.raw.write(`: connected\n\n`);
    SSE_ACTIVE++;

    let alive = true;
    const send = async () => {
      if (!alive) return;
      try {
        const m = await collectMetrics(pool);
        reply.raw.write(`event: metrics\ndata: ${JSON.stringify(m)}\n\n`);
      } catch (e: any) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: e?.message })}\n\n`);
      }
    };
    await send();
    const interval = setInterval(send, 2000);
    const ping = setInterval(() => { try { reply.raw.write(`: ping\n\n`); } catch {} }, 15000);
    req.raw.on("close", () => {
      alive = false; SSE_ACTIVE = Math.max(0, SSE_ACTIVE - 1);
      clearInterval(interval); clearInterval(ping);
      try { reply.raw.end(); } catch {}
    });
  });

  // Historique des stats par periode (LECTURE SEULE - que des SELECT).
  // Fenetre 2 ans glissante (24 derniers mois). Ne modifie jamais daily_stats.
  app.get("/admin/history", async (req: any, reply) => {
    const period = req.query?.period === "year" ? "year" : "month";
    const value = String(req.query?.value || "");
    if (!STATS_POOL) return { total: 0, uniques: 0, sources: [], available: [] };
    try {
      let available: string[] = [];
      if (period === "month") {
        const av: any = await STATS_POOL.query(
          `SELECT DISTINCT DATE_FORMAT(stat_date, '%Y-%m') AS p
           FROM daily_stats
           WHERE stat_date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 23 MONTH)
           ORDER BY p DESC`
        );
        available = av.map((r: any) => r.p);
      } else {
        const av: any = await STATS_POOL.query(
          `SELECT DISTINCT YEAR(stat_date) AS p
           FROM daily_stats
           WHERE stat_date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-01-01'), INTERVAL 1 YEAR)
           ORDER BY p DESC`
        );
        available = av.map((r: any) => String(r.p));
      }
      const target = value || available[0] || "";
      if (!target) return { total: 0, uniques: 0, sources: [], available, period, value: "" };
      let where = "";
      let params: any[] = [];
      if (period === "month") {
        where = "DATE_FORMAT(stat_date, '%Y-%m') = ?";
        params = [target];
      } else {
        where = "YEAR(stat_date) = ?";
        params = [target];
      }
      const rows: any = await STATS_POOL.query(
        `SELECT source, SUM(visits) AS visits, SUM(unique_visitors) AS uniques
         FROM daily_stats WHERE ${where}
         GROUP BY source ORDER BY visits DESC`,
        params
      );
      const total = rows.reduce((s: number, r: any) => s + Number(r.visits), 0);
      const uniques = rows.reduce((s: number, r: any) => s + Number(r.uniques), 0);
      return {
        period, value: target, total, uniques,
        sources: rows.map((r: any) => [r.source, Number(r.visits)]),
        available,
      };
    } catch (e: any) {
      return { total: 0, uniques: 0, sources: [], available: [], error: e?.message };
    }
  });

  app.get("/admin/dashboard/snapshot", async (_req, reply) => {
    const m = await collectMetrics(pool);
    return reply.send(m);
  });

  // PWA : manifest (permet l'installation sur ecran d'accueil)
  app.get("/admin/dashboard/manifest.json", async (_req, reply) => {
    const manifest = {
      name: "GameNime Admin",
      short_name: "GameNime",
      description: "Dashboard de monitoring GameNime",
      start_url: "/dashboard",
      scope: "/dashboard",
      display: "standalone",
      orientation: "portrait",
      background_color: "#000000",
      theme_color: "#d9a978",
      icons: [
        { src: "https://gamenime.fr/favicon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
        { src: "https://gamenime.fr/favicon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "https://gamenime.fr/favicon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
      ]
    };
    reply.type("application/manifest+json").send(JSON.stringify(manifest));
  });

  // PWA : service worker minimal (obligatoire pour rendre l'app installable)
  app.get("/admin/dashboard/sw.js", async (_req, reply) => {
    const sw = `
// Service worker minimal GameNime Admin
self.addEventListener("install", function(e) { self.skipWaiting(); });
self.addEventListener("activate", function(e) { self.clients.claim(); });
// Pas de cache offline : le dashboard a besoin des donnees live.
self.addEventListener("fetch", function(e) { /* passthrough reseau */ });
`.trim();
    reply.type("application/javascript").send(sw);
  });

  app.get("/admin/dashboard", async (_req, reply) => {
    const htmlPath = path.join(__dirname_esm, "dashboard.html");
    try {
      const html = await fs.readFile(htmlPath, "utf-8");
      reply.type("text/html; charset=utf-8").send(html);
    } catch (e: any) {
      reply.code(500).send({ error: "dashboard.html not found", path: htmlPath });
    }
  });

  app.log.info("GameNime Dashboard ready: /admin/dashboard");
}
