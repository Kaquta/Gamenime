/**
 * GameNime Dashboard — Observabilité temps réel (enrichi mockup-compliant)
 */
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
export async function collectMetrics(pool: any) {
  const [system, catalog, workflows] = await Promise.all([
    readSystemMetrics(), readCatalogMetrics(pool), readWorkflowMetrics(pool)
  ]);
  return {
    ts: Date.now(), system, catalog, workflows,
    crons: LAST_RUNS,
    cache: { hits: CACHE_HITS, misses: CACHE_MISSES, hit_rate: getCacheHitRate() },
    requests_per_min: getRequestsPerMinute(),
    sse_active: SSE_ACTIVE,
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

  app.get("/admin/dashboard/snapshot", async (_req, reply) => {
    const m = await collectMetrics(pool);
    return reply.send(m);
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
