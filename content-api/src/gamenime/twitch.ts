/**
 * GameNime — Acces Twitch/IGDB centralise.
 *
 * Responsabilite unique : obtenir et mettre en cache le token OAuth Twitch
 * (requis par IGDB), et journaliser les echecs d'appariement IGDB.
 *
 * Pourquoi ce module existe (ETAT CLEAN — une seule source de verite) :
 * le token etait gere en DEUX copies independantes (health-check-cron et
 * refetch-games-cron), chacune avec son propre cache. Elles avaient meme
 * diverge sur l'expiration par defaut (1h cote health-check, 60j cote
 * refetch). Twitch delivre des tokens valides ~60 jours ; le cache a 1h du
 * health-check se croyait expire au bout d'une heure et redemandait un
 * token neuf, ce qui pouvait invalider celui que refetch-games utilisait
 * encore — les fameux faux 401 (incident du 20/07). Un seul cache partage
 * supprime la cause.
 */

// ── Requete avec timeout (etait duplique dans health-check) ──
export async function fetchWithTimeout(url: string, opts: any = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Journal des lookups IGDB (warns remontes dans la carte Surveillance) ──
let igdbWarnPool: any = null;
export function setIgdbWarnPool(pool: any): void { igdbWarnPool = pool; }
export function igdbLog(level: "info" | "warn", event: string, extra?: Record<string, any>): void {
  try {
    const line = { level: level === "warn" ? 40 : 30, time: Date.now(), src: "igdb-lookup", event, ...(extra || {}) };
    process.stdout.write(JSON.stringify(line) + "\n");
  } catch { /* le log ne doit jamais faire echouer un lookup */ }
  // Un warn d'auth/HTTP remonte dans la carte IGDB de la page Surveillance.
  // Colonne dediee : le health-check-cron ne l'ecrase jamais.
  if (level === "warn" && igdbWarnPool) {
    const msg = event + (extra && extra.status ? " (HTTP " + extra.status + ")" : "");
    igdbWarnPool.query(
      "UPDATE source_health SET last_lookup_warn = NOW(), last_lookup_warn_msg = ? WHERE source = 'igdb'",
      [msg.slice(0, 255)]
    ).catch(() => { /* jamais bloquant */ });
  }
}

// ── Token Twitch : cache unique partage par tous les appelants ──
// -- Effacement du warn : l'appariement IGDB refonctionne --
// Le warn etait pose et jamais retire. La colonne restait marquee des mois
// apres la panne, et le dashboard, pour eviter une alerte perpetuelle, ne
// l'affichait que pendant 6 heures -- donc masquait justement les pannes qui
// durent. On efface ici, sur la preuve qu'un appel IGDB authentifie a abouti.
export function igdbLookupOk(): void {
  if (!igdbWarnPool) return;
  igdbWarnPool.query(
    "UPDATE source_health SET last_lookup_warn = NULL, last_lookup_warn_msg = NULL " +
    "WHERE source = 'igdb' AND last_lookup_warn IS NOT NULL"
  ).catch(() => { /* jamais bloquant */ });
}

let TWITCH_TOKEN: { token: string; expiresAt: number } | null = null;
export async function getTwitchToken(): Promise<string | null> {
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) { igdbLog("warn", "twitch_credentials_absentes"); return null; }
  // Token encore valide ? (marge de 60s)
  if (TWITCH_TOKEN && TWITCH_TOKEN.expiresAt > Date.now() + 60000) return TWITCH_TOKEN.token;
  try {
    const res = await fetchWithTimeout(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: "POST" }
    );
    if (!res.ok) { igdbLog("warn", "twitch_token_http", { status: res.status }); return null; }
    const data: any = await res.json();
    if (!data?.access_token) { igdbLog("warn", "twitch_token_sans_access_token"); return null; }
    // Defaut 60 jours (valeur reelle Twitch), pas 1h.
    TWITCH_TOKEN = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 5184000) * 1000 };
    return TWITCH_TOKEN.token;
  } catch (e: any) {
    igdbLog("warn", "twitch_token_exception", { err: e?.message });
    return null;
  }
}

// Invalide le token en cache (a appeler sur 401 IGDB : le token a ete revoque
// cote Twitch AVANT sa date d'expiration calculee). Le prochain getTwitchToken()
// en redemandera un frais. Corrige le bug ou un token mort etait servi jusqu'a
// son expiresAt de 60j, cassant IGDB (health check + enrichissement + appariement)
// jusqu'a un restart manuel.
export function invalidateTwitchToken(): void {
  TWITCH_TOKEN = null;
  igdbLog("info", "twitch_token_invalide_sur_401");
}

// Appel IGDB avec retry automatique sur 401 : si le token en cache est mort,
// on l'invalide, on en regenere un, et on rejoue l'appel UNE fois.
export async function igdbFetch(path: string, init: RequestInit): Promise<Response> {
  const clientId = process.env.TWITCH_CLIENT_ID || "";
  const doFetch = async (): Promise<Response> => {
    const token = await getTwitchToken();
    const headers = {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    };
    return fetchWithTimeout(path, { ...init, headers });
  };
  let res = await doFetch();
  if (res.status === 401) {
    invalidateTwitchToken();
    res = await doFetch(); // un seul retry avec token frais
  }
  // Toute reponse 2xx prouve que le chemin IGDB authentifie fonctionne :
  // c'est le seul endroit qui le sait pour TOUS les appelants (health
  // check, enrichissement, appariement), donc le seul ou l'effacement
  // du warn a sa place.
  if (res.ok) igdbLookupOk();
  return res;
}
