/**
 * Séries en cours très suivies (15 octobre 2026).
 *
 * Rey, à propos de Détective Conan absent de la base : « Oui, c'était déjà censé être le cas ».
 * Le workflow AniList (n8n) ne garde que les animes COMMENCÉS dans la fenêtre (l'année en cours et la suivante) :
 * une série commencée avant (Détective Conan, 1996) n'entre jamais, même diffusée chaque semaine. Ce passage lit sur
 * AniList les séries japonaises EN COURS (TV, ONA), commencées avant la fenêtre et très suivies (popularité de
 * 50 000 ou plus), et envoie à /anime/bulk, sous la même forme que le workflow, celles qui manquent :
 *   - pas encore en base : elles entrent avec les règles d'entrée habituelles (pays d'origine, doublons, plateformes) ;
 *   - en base mais sans aucune plateforme (donc masquées sur le site), quand AniList en donne désormais une des nôtres :
 *     la mise à jour de /anime/bulk ne fait qu'ajouter (rien n'est écrasé).
 * Les autres ne sont pas renvoyées : chaque envoi compte au tableau de bord comme un passage du workflow AniList
 * (dernier envoi), qu'un renvoi toutes les 6 h masquerait. Pour la même raison, une série de la liste de blocage
 * (merge_blocklist, mêmes critères que /anime/bulk) est écartée avant l'envoi au lieu d'être refusée à chaque passage.
 * Plateformes : celles des liens AniList, comme le workflow (AnimeSchedule n'en donne pas : voir mergeSources).
 * Ensuite, le rattachement des routes (refetch-cron) leur donne leur place dans « Cette semaine ».
 *
 * Réglages : SERIES_EN_COURS_ENABLED=0 coupe le passage ; SERIES_EN_COURS_POP_MIN (50 000 par défaut).
 * SERIES_EN_COURS_ANILIST_URL et SERIES_EN_COURS_BULK_URL : seulement pour les essais.
 */
import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { sanitizePlatform } from "./core.js";
import { aniListRefuse, tourAniList } from "./file-anilist.js";

const ANILIST_URL = process.env.SERIES_EN_COURS_ANILIST_URL || "https://graphql.anilist.co";
const BULK_URL = process.env.SERIES_EN_COURS_BULK_URL || `http://127.0.0.1:${process.env.PORT || 3000}/anime/bulk`;

export function configSeriesEnCours(): { actif: boolean; popMin: number } {
  const actif = process.env.SERIES_EN_COURS_ENABLED !== "0";
  const p = Number(process.env.SERIES_EN_COURS_POP_MIN);
  return { actif, popMin: Number.isFinite(p) && p > 0 ? Math.round(p) : 50000 };
}

/** Les champs que lit le workflow AniList (n8n), plus idMal (et le pays et isAdult, pour le contrôle des données). */
export const CHAMPS_MEDIA =
  "id idMal title { romaji english native } coverImage { extraLarge large } genres " +
  "startDate { year month day } nextAiringEpisode { airingAt episode } trailer { id site } externalLinks { site url type } " +
  "streamingEpisodes { site url title } description(asHtml: false) episodes format status season seasonYear " +
  "averageScore popularity countryOfOrigin isAdult";
const REQUETE =
  "query ($avant: FuzzyDateInt, $pop: Int) { Page(page: 1, perPage: 50) { media(type: ANIME, status: RELEASING, " +
  "isAdult: false, countryOfOrigin: \"JP\", format_in: [TV, ONA], startDate_lesser: $avant, popularity_greater: $pop, " +
  `sort: [POPULARITY_DESC]) { ${CHAMPS_MEDIA} } } }`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

function dateEtPrecision(sd: any): { date: string; precision: "day" | "month" | "year" } | null {
  if (!sd || !sd.year) return null;
  if (sd.day && sd.month) return { date: `${sd.year}-${pad2(sd.month)}-${pad2(sd.day)}`, precision: "day" };
  if (sd.month) return { date: `${sd.year}-${pad2(sd.month)}-01`, precision: "month" };
  return { date: `${sd.year}-01-01`, precision: "year" };
}

function prochainEpisode(na: any): string | null {
  if (!na?.airingAt) return null;
  const d = new Date(Number(na.airingAt) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function bandeAnnonce(t: any): string | null {
  if (!t?.id || !t?.site) return null;
  const s = String(t.site).toLowerCase();
  if (s.includes("youtube")) return "https://www.youtube.com/watch?v=" + t.id;
  if (s.includes("dailymotion")) return "https://www.dailymotion.com/video/" + t.id;
  return null;
}

export function plateformes(m: any): string | null {
  const sites: string[] = [];
  for (const l of m?.externalLinks ?? []) if (l?.type === "STREAMING" && l?.site && !sites.includes(l.site)) sites.push(l.site);
  for (const e of m?.streamingEpisodes ?? []) if (e?.site && !sites.includes(e.site)) sites.push(e.site);
  return sites.length ? sites.join(", ") : null;
}

function recente(date: string | null, precision: string): boolean {
  if (!date || precision !== "day") return false;
  const ecart = Math.floor((Date.now() - new Date(date + "T00:00:00Z").getTime()) / 86400000);
  return ecart >= 0 && ecart <= 30;
}

/** Un anime d'AniList sous la forme que /anime/bulk attend, comme « Normalize » du workflow AniList (n8n). */
export function versEnvoi(m: any): Record<string, unknown> | null {
  const titre = m?.title?.romaji ?? m?.title?.native ?? null;
  if (!titre || !Number.isInteger(Number(m?.id))) return null;
  const dp = dateEtPrecision(m.startDate);
  if (!dp) return null;
  let desc = m.description ? String(m.description).replace(/<[^>]*>/g, "") : "";
  const meta: string[] = [];
  if (m.episodes) meta.push(`[EPISODES:${m.episodes}]`);
  if (m.format) meta.push(`[FORMAT:${m.format}]`);
  if (m.status) meta.push(`[STATUS:${m.status}]`);
  if (m.season && m.seasonYear) meta.push(`[SEASON:${m.season} ${m.seasonYear}]`);
  if (m.nextAiringEpisode?.episode) meta.push(`[NEXT_EP:${m.nextAiringEpisode.episode}]`);
  if (meta.length) desc = desc + "\n" + meta.join(" ");
  const note = Number(m.averageScore);
  const envoi: Record<string, unknown> = {
    title: String(titre),
    titleEnglish: m.title?.english ? String(m.title.english).slice(0, 500) : null,
    titleNative: m.title?.native ?? null,
    anilistId: Number(m.id),
    malId: Number.isInteger(Number(m.idMal)) && Number(m.idMal) > 0 ? Number(m.idMal) : null,
    animeScheduleRoute: null,
    cover: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    genre: Array.isArray(m.genres) && m.genres.length ? m.genres.join(", ") : null,
    platform: plateformes(m),
    releaseDate: dp.date,
    releasePrecision: dp.precision,
    isRecentlyReleased: recente(dp.date, dp.precision),
    popularity: Number.isInteger(Number(m.popularity)) ? Number(m.popularity) : 0,
    ratingScore: Number.isInteger(note) && note >= 0 && note <= 100 ? note : null,
    description: desc || null,
  };
  const ba = bandeAnnonce(m.trailer);
  if (ba) envoi.trailerUrl = ba;
  const pe = prochainEpisode(m.nextAiringEpisode);
  if (pe) envoi.releaseDatetime = pe;
  return envoi;
}

export interface BilanSeries {
  lues: number;
  /** en base : pas renvoyées (ou renvoyées pour une plateforme qu'AniList donne enfin, et retrouvées après l'envoi) */
  dejaLa: number;
  /** liste de blocage : écartées avant l'envoi */
  bloquees: number;
  envoyees: number;
  nouvelles: Array<{ id: number; titre: string; plateforme: string }>;
  refusees: string[];
  erreur: string | null;
}

/** « Case Closed [Crunchyroll, Netflix] », ou masquée si elle n'a aucune de nos plateformes. */
export function decrireNouvelle(n: { titre: string; plateforme: string }): string {
  return `${n.titre} [${n.plateforme || "masquee : aucune plateforme europeenne"}]`;
}

export type EnBase = { id: number; titre: string; plateforme: string };

/** Les fiches déjà en base de ces séries, par identifiant AniList (retrouvées par AniList, sinon par MyAnimeList). */
export async function enBase(pool: any, series: Array<Record<string, unknown>>): Promise<Map<number, EnBase>> {
  const res = new Map<number, EnBase>();
  const als = series.map((e) => Number(e.anilistId));
  const mals = series.map((e) => Number(e.malId)).filter((x) => Number.isInteger(x) && x > 0);
  if (!als.length) return res;
  const lignes: any[] = await pool.query(
    "SELECT CAST(id AS UNSIGNED) AS id, CAST(IFNULL(anilist_id, 0) AS UNSIGNED) AS al, CAST(IFNULL(mal_id, 0) AS UNSIGNED) AS mal, " +
      "title, title_english AS te, TRIM(IFNULL(platform, '')) AS p FROM anime_items " +
      `WHERE anilist_id IN (${als.map(() => "?").join(",")})` + (mals.length ? ` OR mal_id IN (${mals.map(() => "?").join(",")})` : "") +
      " ORDER BY id",
    [...als, ...mals]
  );
  const fiche = (l: any): EnBase => ({ id: Number(l.id), titre: String(l.te || l.title || ""), plateforme: String(l.p || "") });
  for (const e of series) {
    const al = Number(e.anilistId);
    const mal = Number(e.malId);
    const l = lignes.find((x) => Number(x.al) === al) ?? (mal > 0 ? lignes.find((x) => Number(x.mal) === mal) : undefined);
    if (l) res.set(al, fiche(l));
  }
  return res;
}

/**
 * Les séries (identifiant AniList) que la liste de blocage arrêterait : la requête même de /anime/bulk (identifiant
 * AniList, MyAnimeList, jaquette ou titre exact), pour un rejet comme pour une redirection vers une fiche gardée.
 */
export async function bloqueesParLaListe(pool: any, series: Array<Record<string, unknown>>): Promise<Set<number>> {
  const res = new Set<number>();
  for (const e of series) {
    const cover = typeof e.cover === "string" && e.cover ? e.cover : null;
    const generique = !cover || /\/(default|placeholder|noimage|no-image|missing)\.(jpg|png)/i.test(cover) || /cover\/(medium|large)\/default/i.test(cover);
    const c = generique ? null : cover;
    const al = Number(e.anilistId) > 0 ? Number(e.anilistId) : null;
    const mal = Number(e.malId) > 0 ? Number(e.malId) : null;
    const l: any[] = await pool.query(
      "SELECT 1 AS x FROM merge_blocklist WHERE item_type = 'anime' AND ((? IS NOT NULL AND blocked_anilist_id = ?) " +
        "OR (? IS NOT NULL AND blocked_mal_id = ?) OR (? IS NOT NULL AND blocked_cover = ?) OR blocked_title = ?) LIMIT 1",
      [al, al, mal, mal, c, c, String(e.title ?? "")]
    );
    if (l.length) res.add(Number(e.anilistId));
  }
  return res;
}

/** L'envoi à /anime/bulk. Dans l'API : app.inject, comme l'ajout des jeux IGDB (/games/bulk) ; hors de l'API
 * (passage lancé à la main) : par le réseau, vers l'API en marche. */
export async function envoyer(app: FastifyInstance, items: Array<Record<string, unknown>>, cle: string): Promise<void> {
  let code = 0;
  let texte = "";
  if (typeof (app as any).inject === "function") {
    const r = await (app as any).inject({ method: "POST", url: "/anime/bulk", headers: { "x-api-key": cle }, payload: { items } });
    code = Number(r.statusCode);
    texte = code >= 200 && code < 300 ? "" : String(r.body ?? "");
  } else {
    const rb = await fetch(BULK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cle },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(120000),
    });
    code = rb.status;
    texte = rb.ok ? "" : await rb.text().catch(() => "");
  }
  if (code < 200 || code >= 300) throw new Error(`/anime/bulk : HTTP ${code} ${texte.replace(/\s+/g, " ").slice(0, 160)}`);
}

/**
 * Un passage : AniList, la base (ce qui manque), puis /anime/bulk pour ce qui manque seulement.
 */
export async function passageSeriesEnCours(app: FastifyInstance): Promise<BilanSeries> {
  const bilan: BilanSeries = { lues: 0, dejaLa: 0, bloquees: 0, envoyees: 0, nouvelles: [], refusees: [], erreur: null };
  // l'interrupteur est au Pilotage (pilotage.ts) : SERIES_EN_COURS_ENABLED ne sert plus qu'à la première mise en route
  const cfg = configSeriesEnCours();
  const debut = Date.now();
  const pool = (app as any).pool;
  try {
    const cle = process.env.ANIME_API_KEY || "";
    if (!cle) throw new Error("ANIME_API_KEY absente : envoi a /anime/bulk impossible");
    if (!pool) throw new Error("base introuvable");
    // 1. AniList : en cours, commencées avant le 1er janvier de l'année en cours, très suivies
    const annee = new Date().getUTCFullYear();
    await tourAniList(); // la file AniList commune (file-anilist.ts)
    const r = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: REQUETE, variables: { avant: annee * 10000 + 101, pop: cfg.popMin - 1 } }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 429) aniListRefuse(r.headers.get("retry-after"));
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !d || (Array.isArray(d.errors) && d.errors.length)) {
      throw new Error(`AniList : ${!r.ok ? "HTTP " + r.status : String(d?.errors?.[0]?.message ?? "reponse illisible").slice(0, 120)}`);
    }
    const media: any[] = Array.isArray(d?.data?.Page?.media) ? d.data.Page.media : [];
    bilan.lues = media.length;
    const series = media.map(versEnvoi).filter((x): x is Record<string, unknown> => x !== null);
    // 2. ce qui manque : pas en base (et pas bloqué), ou en base sans aucune plateforme quand AniList en donne une
    const avant = await enBase(pool, series);
    const bloquees = await bloqueesParLaListe(pool, series.filter((e) => !avant.has(Number(e.anilistId)))).catch((e: any) => {
      app.log.warn({ err: String(e?.message ?? e) }, "series en cours : liste de blocage illisible, /anime/bulk en decidera");
      return new Set<number>();
    });
    const envois: Array<Record<string, unknown>> = [];
    for (const e of series) {
      const l = avant.get(Number(e.anilistId));
      if (l && (l.plateforme || !sanitizePlatform(e.platform == null ? null : String(e.platform)))) bilan.dejaLa++;
      else if (!l && bloquees.has(Number(e.anilistId))) bilan.bloquees++;
      else envois.push(e);
    }
    // 3. l'envoi (50 au plus), seulement s'il manque quelque chose
    if (envois.length) {
      await envoyer(app, envois, cle);
      bilan.envoyees = envois.length;
      const apres = await enBase(pool, envois);
      for (const e of envois) {
        const al = Number(e.anilistId);
        const a = apres.get(al);
        if (!a) bilan.refusees.push(String(e.titleEnglish || e.title));
        else if (avant.has(al)) bilan.dejaLa++;
        else bilan.nouvelles.push(a);
      }
    }
    app.log.info(
      { lues: bilan.lues, dejaLa: bilan.dejaLa, bloquees: bilan.bloquees, envoyees: bilan.envoyees, nouvelles: bilan.nouvelles.map(decrireNouvelle), refusees: bilan.refusees, popMin: cfg.popMin },
      "series en cours : passage termine"
    );
    trackLastRun("series-en-cours", { lues: bilan.lues, dejaLa: bilan.dejaLa, bloquees: bilan.bloquees, envoyees: bilan.envoyees, nouvelles: bilan.nouvelles.length }, Date.now() - debut);
    if (bilan.nouvelles.length) {
      pushActivity({
        type: "push",
        message: `${bilan.nouvelles.length} série${bilan.nouvelles.length > 1 ? "s" : ""} en cours entrée${bilan.nouvelles.length > 1 ? "s" : ""} en base`,
        detail: bilan.nouvelles.map((n) => n.titre).join(", ").slice(0, 200),
        level: "info",
      });
    }
  } catch (e: any) {
    bilan.erreur = String(e?.message ?? e);
    app.log.warn({ err: bilan.erreur }, "series en cours : passage interrompu, reprise au prochain passage");
    trackLastRun("series-en-cours", { lues: bilan.lues, envoyees: bilan.envoyees, error: bilan.erreur }, Date.now() - debut);
  }
  return bilan;
}
