/**
 * tmdb.ts — Ce qui est réellement disponible en France, selon TMDB (données JustWatch).
 *
 * Pour chaque anime de la fenêtre : la fiche TMDB (liste ouverte Fribb AniList -> TMDB,
 * sinon IMDb, sinon le titre exact à un an près), les plateformes de streaming en
 * France au niveau de la saison (sinon de la série ou du film) et, pour un film,
 * ses dates de sortie en France (cinéma, VOD). Écrit seulement les colonnes tmdb_*
 * et fr_* de anime_items, sans toucher updated_at.
 *
 * Variables :
 *   TMDB_ENABLED   « 1 » pour activer
 *   TMDB_API_KEY   clé v3 ou jeton de lecture v4 (« eyJ… »), jamais écrite dans les journaux
 *   TMDB_URL, TMDB_LISTE_URL : seulement pour les tests
 *
 * Conditions TMDB : gratuit hors usage commercial ; logo et mention TMDB, et
 * JustWatch cité comme source des disponibilités, sur le site.
 */
import { setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { norm, type Journal, type SqlPool } from "./presse.js";

export interface TmdbDeps {
  pool: SqlPool;
  log: Journal;
}
export interface TmdbConfig {
  cle: string;
  base: string;
  liste: string;
  parPassage: number;
}

const PREMIER_PASSAGE_MS = 10 * 60 * 1000;
const PASSAGE_MS = 6 * 60 * 60 * 1000;
const LISTE_DUREE_MS = 24 * 60 * 60 * 1000;
const PAUSE_MS = 60;

export function lireConfigTmdb(env: Record<string, string | undefined> = process.env): TmdbConfig | null {
  if (env["TMDB_ENABLED"] !== "1") return null;
  return configTmdb(env);
}
export function configTmdb(env: Record<string, string | undefined> = process.env): TmdbConfig {
  return {
    cle: String(env["TMDB_API_KEY"] || "").trim().replace(/^["']|["']$/g, ""),
    base: (env["TMDB_URL"] || "https://api.themoviedb.org/3").replace(/\/+$/, ""),
    liste: env["TMDB_LISTE_URL"] || "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
    parPassage: 250,
  };
}

export class CleRefusee extends Error {}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Réponse 404 : la fiche n'existe pas (ou plus) chez TMDB. */
export const ABSENTE = Object.freeze({ absente: true });
/** Dernière erreur passagère (pour les journaux ; jamais la clé). */
export let derniereErreur = "";

/** GET TMDB. ABSENTE si 404 ; null si erreur passagère ; CleRefusee si 401. La clé n'apparaît jamais dans un message. */
export async function tmdb(cfg: TmdbConfig, chemin: string, params: Record<string, string> = {}): Promise<any | null> {
  const bearer = cfg.cle.startsWith("eyJ");
  const q = new URLSearchParams(bearer ? params : { ...params, api_key: cfg.cle });
  const url = cfg.base + chemin + (q.toString() ? "?" + q.toString() : "");
  const entetes: Record<string, string> = { Accept: "application/json", "User-Agent": "GameNime/1.0 (+https://gamenime.fr)" };
  if (bearer) entetes["Authorization"] = "Bearer " + cfg.cle;
  for (let essai = 0; essai < 4; essai++) {
    try {
      const r = await fetch(url, { headers: entetes, signal: AbortSignal.timeout(20000) });
      if (r.status === 401) throw new CleRefusee("clé TMDB refusée (401)");
      if (r.status === 404) return ABSENTE;
      if (r.status === 429 || r.status >= 500) {
        derniereErreur = `HTTP ${r.status} sur ${chemin}`;
        await dormir(1500 + essai * 2000);
        continue;
      }
      if (!r.ok) {
        derniereErreur = `HTTP ${r.status} sur ${chemin}`;
        return null;
      }
      return await r.json();
    } catch (e) {
      if (e instanceof CleRefusee) throw e;
      derniereErreur = `${(e as Error).message} sur ${chemin}`;
      await dormir(1000 + essai * 1000);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────── plateformes
const ALIAS: Record<string, string> = {
  "amazon prime video": "Prime Video", "prime video": "Prime Video", "disney plus": "Disney+", "disney": "Disney+",
  adn: "ADN", "animation digital network": "ADN", "anime digital network": "ADN", "anime digital networks": "ADN",
  crunchyroll: "Crunchyroll", netflix: "Netflix", hidive: "HIDIVE",
};
const ORDRE = ["ADN", "Crunchyroll", "Netflix", "Prime Video", "Disney+"];
export function nomPlateforme(n: string): string {
  let s = String(n || "").trim();
  s = s.replace(/\s+(amazon channel|apple tv channel|roku premium channel)$/i, "");
  s = s.replace(/\s+(basic|standard)?\s*with ads$/i, "").trim();
  return ALIAS[norm(s)] ?? s;
}
/** Plateformes de streaming (abonnement, gratuit, avec pub) en France, dans un ordre stable. */
export function streamingFrance(resultats: any): string[] {
  const fr = resultats?.FR || {};
  const noms = new Set<string>();
  for (const cat of ["flatrate", "free", "ads"]) for (const p of fr[cat] || []) if (p?.provider_name) noms.add(nomPlateforme(p.provider_name));
  const rang = (x: string) => (ORDRE.includes(x) ? ORDRE.indexOf(x) : ORDRE.length);
  return [...noms].sort((a, b) => rang(a) - rang(b) || a.localeCompare(b));
}

// ─────────────────────────────────────────────────────────────── liens AniList -> TMDB
interface Lien {
  tv?: number;
  movie?: number;
  saison?: number;
  imdb?: string;
}
let liste: { charge: number; parAnilist: Map<number, Lien> } | null = null;

export async function chargerListe(cfg: TmdbConfig, force = false): Promise<Map<number, Lien>> {
  if (!force && liste && Date.now() - liste.charge < LISTE_DUREE_MS) return liste.parAnilist;
  const r = await fetch(cfg.liste, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`liste AniList -> TMDB : HTTP ${r.status}`);
  const brut: any[] = await r.json();
  // La saison TMDB de la liste n'est sûre que pour une série (TV, ONA) seule sur son couple
  // (série TMDB, saison) : la liste range souvent les suites sur la saison 1 (Frieren saisons 2
  // et 3, Jujutsu Kaisen…), et un film ou un OAV rangé dans une saison n'est pas cette saison.
  // Sinon : la série entière, qui ne dit rien de CETTE saison.
  const serie = (e: any) => e?.type === "TV" || e?.type === "ONA";
  const saisonDe = (e: any): number | null => {
    const v = e?.season?.tmdb;
    return v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const parCouple = new Map<string, Set<number>>();
  for (const e of brut) {
    const a = Number(e?.anilist_id), tv = Number(e?.themoviedb_id?.tv), s = saisonDe(e);
    if (!a || !tv || s === null || !serie(e)) continue;
    const k = `${tv}|${s}`;
    parCouple.set(k, (parCouple.get(k) ?? new Set<number>()).add(a));
  }
  const parAnilist = new Map<number, Lien>();
  for (const e of brut) {
    const a = Number(e?.anilist_id);
    if (!a) continue;
    const t = e.themoviedb_id || {};
    const lien: Lien = {};
    if (t.tv) lien.tv = Number(t.tv);
    if (Array.isArray(t.movie) && t.movie.length) lien.movie = Number(t.movie[0]);
    const s = saisonDe(e);
    if (lien.tv && s !== null && serie(e) && parCouple.get(`${lien.tv}|${s}`)?.size === 1) lien.saison = s;
    if (Array.isArray(e.imdb_id) && e.imdb_id.length) lien.imdb = String(e.imdb_id[0]);
    const prec = parAnilist.get(a);
    if (!prec || (!prec.tv && !prec.movie && (lien.tv || lien.movie))) parAnilist.set(a, lien);
  }
  liste = { charge: Date.now(), parAnilist };
  return parAnilist;
}

export interface Item {
  id: number;
  anilistId: number;
  titre: string;
  titreAnglais: string | null;
  format: string | null;
  date: string;
  tmdbId: number | null;
  tmdbType: "tv" | "movie" | null;
  tmdbSaison: number | null;
  tmdbLien: string | null;
}
export interface Rattachement {
  type: "tv" | "movie";
  id: number;
  saison: number | null;
  via: "liste" | "imdb" | "titre";
}

const an = (d: string | null | undefined) => parseInt(String(d || "").slice(0, 4), 10) || 0;

export async function rattacher(cfg: TmdbConfig, it: Item, parAnilist: Map<number, Lien>): Promise<Rattachement | null> {
  const film = it.format === "MOVIE";
  const e = it.anilistId ? parAnilist.get(it.anilistId) : undefined;
  if (e && (e.tv || e.movie)) {
    if (film && e.movie) return { type: "movie", id: e.movie, saison: null, via: "liste" };
    if (e.tv) return { type: "tv", id: e.tv, saison: e.saison ?? null, via: "liste" };
    if (e.movie) return { type: "movie", id: e.movie, saison: null, via: "liste" };
  }
  if (e?.imdb) {
    const r = await tmdb(cfg, `/find/${encodeURIComponent(e.imdb)}`, { external_source: "imdb_id" });
    await dormir(PAUSE_MS);
    if (film && r?.movie_results?.length) return { type: "movie", id: Number(r.movie_results[0].id), saison: null, via: "imdb" };
    if (r?.tv_results?.length) return { type: "tv", id: Number(r.tv_results[0].id), saison: null, via: "imdb" };
    if (r?.movie_results?.length) return { type: "movie", id: Number(r.movie_results[0].id), saison: null, via: "imdb" };
  }
  // Titre exact (anglais ou romaji), année à un an près, un seul candidat ; et seulement une animation
  // japonaise, chinoise ou coréenne datée (pas un film en prises de vue réelles du même nom).
  const cibles = new Set([norm(it.titre), norm(it.titreAnglais)].filter(Boolean));
  const y = an(it.date);
  const trouves = new Map<number, any>();
  for (const requete of [it.titreAnglais, it.titre]) {
    if (!requete) continue;
    const r = await tmdb(cfg, film ? "/search/movie" : "/search/tv", { query: requete, include_adult: "false" });
    await dormir(PAUSE_MS);
    for (const x of r?.results || []) {
      const noms = [norm(x.title || x.name), norm(x.original_title || x.original_name)];
      const dx = an(x.release_date || x.first_air_date);
      const anime = ["ja", "zh", "ko"].includes(String(x.original_language || "")) && Array.isArray(x.genre_ids) && x.genre_ids.includes(16);
      if (anime && noms.some((n) => cibles.has(n)) && dx && y && Math.abs(dx - y) <= 1) trouves.set(Number(x.id), x);
    }
    if (trouves.size === 1) break;
  }
  if (trouves.size === 1) return { type: film ? "movie" : "tv", id: [...trouves.keys()][0]!, saison: null, via: "titre" };
  return null;
}

export interface Dispo {
  plateformes: string[];
  niveau: "saison" | "serie" | "film";
  cinema: string | null;
  vod: string | null;
}

/** null : TMDB n'a pas répondu (on ne conclut rien) ; "absente" : la fiche n'existe plus chez TMDB. */
export async function disponibilite(cfg: TmdbConfig, l: Rattachement): Promise<Dispo | null | "absente"> {
  let plateformes: string[] = [];
  let niveau: Dispo["niveau"] = l.type === "movie" ? "film" : "serie";
  let repondu = false;
  if (l.type === "tv" && l.saison && l.saison > 0) {
    const r = await tmdb(cfg, `/tv/${l.id}/season/${l.saison}/watch/providers`);
    await dormir(PAUSE_MS);
    if (r && r !== ABSENTE) repondu = true; // saison inconnue de TMDB : on regarde la série
    plateformes = streamingFrance(r?.results);
    if (plateformes.length) niveau = "saison";
  }
  if (!plateformes.length) {
    const r = await tmdb(cfg, `/${l.type}/${l.id}/watch/providers`);
    await dormir(PAUSE_MS);
    if (r === ABSENTE) return "absente";
    if (r) repondu = true;
    plateformes = streamingFrance(r?.results);
  }
  if (!repondu) return null; // TMDB n'a pas répondu : on ne conclut rien
  let cinema: string | null = null, vod: string | null = null;
  if (l.type === "movie") {
    const r = await tmdb(cfg, `/movie/${l.id}/release_dates`);
    await dormir(PAUSE_MS);
    for (const p of r?.results || []) {
      if (p?.iso_3166_1 !== "FR") continue;
      for (const x of p.release_dates || []) {
        const d = String(x?.release_date || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if ((x.type === 2 || x.type === 3) && (!cinema || d < cinema)) cinema = d;
        if (x.type === 4 && (!vod || d < vod)) vod = d;
      }
    }
  }
  return { plateformes, niveau, cinema, vod };
}

// ─────────────────────────────────────────────────────────────── passage
export async function aVerifier(pool: SqlPool, limite: number): Promise<Item[]> {
  const rows: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, CAST(IFNULL(anilist_id, 0) AS UNSIGNED) AS anilistId, title, title_english AS titreAnglais,
            format, DATE_FORMAT(release_date, '%Y-%m-%d') AS d, tmdb_id AS tmdbId, tmdb_type AS tmdbType,
            tmdb_saison AS tmdbSaison, tmdb_lien AS tmdbLien
       FROM anime_items
      WHERE release_date BETWEEN MAKEDATE(YEAR(CURDATE()), 1) AND MAKEDATE(YEAR(CURDATE()) + 2, 1) - INTERVAL 1 DAY
        AND cover IS NOT NULL AND cover <> '' AND title IS NOT NULL AND title <> ''
        AND (tmdb_verifie_le IS NULL OR tmdb_verifie_le < NOW() - INTERVAL 20 HOUR)
      ORDER BY (tmdb_verifie_le IS NULL) DESC, ABS(DATEDIFF(release_date, CURDATE())) ASC, popularity DESC
      LIMIT ${Math.max(1, Math.min(1000, Math.floor(limite)))}`,
  );
  return rows.map((r) => ({
    id: Number(r.id), anilistId: Number(r.anilistId) || 0, titre: String(r.title), titreAnglais: r.titreAnglais ? String(r.titreAnglais) : null,
    format: r.format ? String(r.format) : null, date: String(r.d || ""), tmdbId: r.tmdbId ? Number(r.tmdbId) : null,
    tmdbType: r.tmdbType === "tv" || r.tmdbType === "movie" ? r.tmdbType : null, tmdbSaison: r.tmdbSaison != null ? Number(r.tmdbSaison) : null,
    tmdbLien: r.tmdbLien ? String(r.tmdbLien) : null,
  }));
}

export interface RapportTmdb {
  verifies: number;
  relies: number;
  nouveauxLiens: number;
  disponiblesFr: number;
  devenusDisponibles: Array<{ id: number; titre: string; plateformes: string[] }>;
  sansReponse: number;
  fichesAbsentes: number;
  premiereErreur?: string;
  arret?: string;
}

/** « ADN, Crunchyroll, … » en 255 caractères au plus, sans couper un nom. */
export function listePlateformes(noms: string[]): string | null {
  const garde: string[] = [];
  for (const n of noms) {
    if ([...garde, n].join(", ").length > 255) break;
    garde.push(n);
  }
  return garde.join(", ") || null;
}

export async function passageTmdb(deps: TmdbDeps, cfg: TmdbConfig, limite = cfg.parPassage): Promise<RapportTmdb> {
  const rapport: RapportTmdb = { verifies: 0, relies: 0, nouveauxLiens: 0, disponiblesFr: 0, devenusDisponibles: [], sansReponse: 0, fichesAbsentes: 0 };
  const items = await aVerifier(deps.pool, limite);
  if (!items.length) return rapport;
  const parAnilist = await chargerListe(cfg);
  const erreur = (it: Item, m: string) => {
    if (!rapport.premiereErreur) rapport.premiereErreur = `${it.titreAnglais || it.titre} (#${it.id}) : ${m}`.slice(0, 300);
  };
  for (const it of items) {
    try {
      // Le lien enregistré, sauf si la liste AniList -> TMDB en connaît un (plus sûr qu'IMDb ou le titre, et à jour).
      const e = it.anilistId ? parAnilist.get(it.anilistId) : undefined;
      const enregistre: Rattachement | null = it.tmdbId && it.tmdbType ? { type: it.tmdbType, id: it.tmdbId, saison: it.tmdbSaison, via: (it.tmdbLien as Rattachement["via"]) || "liste" } : null;
      let l: Rattachement | null = enregistre && !(e && (e.tv || e.movie)) ? enregistre : await rattacher(cfg, it, parAnilist);
      if (!l && enregistre) l = enregistre;
      if (l && (!enregistre || enregistre.id !== l.id || enregistre.type !== l.type || enregistre.saison !== l.saison)) rapport.nouveauxLiens++;
      if (!l) {
        await deps.pool.query("UPDATE anime_items SET tmdb_verifie_le = NOW(), updated_at = updated_at WHERE id = ?", [it.id]);
        rapport.verifies++;
        continue;
      }
      rapport.relies++;
      const d = await disponibilite(cfg, l);
      if (d === "absente") {
        // Fiche disparue chez TMDB : on oublie le lien et ce qu'il disait ; il sera recherché au prochain passage.
        await deps.pool.query(
          `UPDATE anime_items SET tmdb_id = NULL, tmdb_type = NULL, tmdb_saison = NULL, tmdb_lien = NULL,
                  fr_plateformes = NULL, fr_niveau = NULL, fr_cinema = NULL, fr_vod = NULL,
                  tmdb_verifie_le = NOW(), updated_at = updated_at WHERE id = ?`,
          [it.id],
        );
        rapport.fichesAbsentes++;
        erreur(it, `fiche TMDB ${l.type} ${l.id} introuvable (404), lien oublié`);
        continue;
      }
      if (!d) {
        rapport.sansReponse++;
        erreur(it, derniereErreur || "pas de réponse");
        continue; // réessayé au prochain passage
      }
      const plateformes = listePlateformes(d.plateformes);
      // « Disponible depuis » : posé une fois, à la première disponibilité constatée pour CETTE saison
      // (ou ce film) ; jamais pour une série entière (les saisons d'avant ne disent rien de celle-ci).
      const precise = plateformes && d.niveau !== "serie" ? 1 : 0;
      const avant: any[] = await deps.pool.query("SELECT fr_plateformes, fr_niveau FROM anime_items WHERE id = ?", [it.id]);
      await deps.pool.query(
        `UPDATE anime_items
            SET tmdb_id = ?, tmdb_type = ?, tmdb_saison = ?, tmdb_lien = ?,
                fr_plateformes = ?, fr_niveau = ?,
                fr_dispo_depuis = CASE WHEN fr_dispo_depuis IS NOT NULL THEN fr_dispo_depuis WHEN ? = 1 THEN CURDATE() ELSE NULL END,
                fr_cinema = ?, fr_vod = ?, tmdb_verifie_le = NOW(), updated_at = updated_at
          WHERE id = ?`,
        [l.id, l.type, l.saison, l.via, plateformes, plateformes ? d.niveau : null, precise, d.cinema, d.vod, it.id],
      );
      rapport.verifies++;
      if (plateformes) rapport.disponiblesFr++;
      const avantPrecis = !!avant[0]?.fr_plateformes && avant[0]?.fr_niveau !== "serie";
      if (precise && !avantPrecis) {
        rapport.devenusDisponibles.push({ id: it.id, titre: it.titreAnglais || it.titre, plateformes: d.plateformes });
      }
    } catch (e) {
      if (e instanceof CleRefusee) {
        rapport.arret = e.message;
        break;
      }
      rapport.sansReponse++;
      erreur(it, (e as Error).message);
    }
  }
  return rapport;
}

// ─────────────────────────────────────────────────────────────── cron
let enCours = false;

export function startTmdbCron(deps: TmdbDeps, env: Record<string, string | undefined> = process.env): void {
  const cfg = lireConfigTmdb(env);
  if (!cfg) {
    deps.log.info({ module: "tmdb" }, "tmdb : désactivé (TMDB_ENABLED n'est pas à 1)");
    return;
  }
  if (!cfg.cle) {
    deps.log.warn({ module: "tmdb" }, "tmdb : TMDB_API_KEY absente, module arrêté");
    return;
  }
  deps.log.info({ module: "tmdb", parPassage: cfg.parPassage }, "tmdb : actif");
  const tick = async (): Promise<void> => {
    if (enCours) return;
    enCours = true;
    const debut = Date.now();
    try {
      const r = await passageTmdb(deps, cfg);
      const { devenusDisponibles, ...chiffres } = r;
      trackLastRun("tmdb", { ...chiffres, devenusDisponibles: devenusDisponibles.length }, Date.now() - debut);
      if (r.verifies || r.arret || r.sansReponse || r.fichesAbsentes) {
        deps.log[r.arret ? "error" : r.sansReponse ? "warn" : "info"]({ module: "tmdb", ...chiffres, devenusDisponibles: devenusDisponibles.length }, "tmdb : passage terminé");
      }
      if (devenusDisponibles.length) {
        pushActivity({
          type: "tmdb",
          message: `${devenusDisponibles.length} anime${devenusDisponibles.length > 1 ? "s" : ""} disponible${devenusDisponibles.length > 1 ? "s" : ""} en France`,
          detail: devenusDisponibles.slice(0, 6).map((x) => `${x.titre} (${x.plateformes.join(", ")})`).join(" · ").slice(0, 240),
          level: "info",
        });
      }
      if (r.arret) pushActivity({ type: "tmdb", message: "TMDB : clé refusée", detail: "vérifier TMDB_API_KEY dans /opt/stack/.env", level: "error" });
    } catch (e) {
      deps.log.error({ module: "tmdb", err: (e as Error).message }, "tmdb : passage interrompu");
      trackLastRun("tmdb", { erreur: (e as Error).message }, Date.now() - debut);
    } finally {
      enCours = false;
    }
  };
  setTimeout(() => void tick(), PREMIER_PASSAGE_MS).unref();
  setInterval(() => void tick(), PASSAGE_MS).unref();
}
