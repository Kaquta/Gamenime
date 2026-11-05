/**
 * GameNime Phase B — Cron interne re-fetch des items incomplets
 */

import type { FastifyInstance } from "fastify";
import { trackLastRun, pushActivity } from "./dashboard.js";
import { resoudreDistributeurYouTube } from "./youtube-verify.js";
import { sanitizePlatform, normalizeTitleStrict } from "./core.js";
import { passageSeriesEnCours, configSeriesEnCours } from "./series-en-cours.js";
import { avancer, planifier } from "./pilotage.js";
import { tourAniList, aniListRefuse, verdictDate, precisionDe, planifierDatesAnimes } from "./dates-animes.js";

const REFETCH_INTERVAL_MS = 60 * 60 * 1000;
const REFETCH_BATCH_SIZE = 200;
const REFETCH_DELAY_MS = 800;
/** L'API d'AnimeSchedule (ANIMESCHEDULE_API_URL : seulement pour les essais). */
const AS_API = (process.env.ANIMESCHEDULE_API_URL || "https://animeschedule.net/api/v3").replace(/\/+$/, "");
/** L'adresse d'AniList (ANILIST_URL : seulement pour les essais). */
const ANILIST_URL = process.env.ANILIST_URL || "https://graphql.anilist.co";

interface IncompleteItem {
  id: number;
  title: string;
  anilist_id: number | null;
  mal_id: number | null;
  anime_schedule_route: string | null;
  cover: string | null;
  platform: string | null;
  trailer_url: string | null;
  description: string | null;
  format: string | null;
}

interface SourceData {
  cover?: string | null;
  titleNative?: string | null;   // titre japonais : AniList, Kitsu et AnimeSchedule l'ont tous les trois
  platform?: string | null;
  trailerUrl?: string | null;
  description: string | null;
  format?: string | null;
  releaseDate?: string | null;        // "YYYY-MM-DD" (jour=01 si precision month/year)
  releasePrecision?: "day" | "month" | "year" | null;  // precision reelle selon la source
  statut?: string | null;             // AniList : NOT_YET_RELEASED, RELEASING, FINISHED, CANCELLED, HIATUS
}

export async function fetchAniList(anilistId: number): Promise<SourceData | null> {
  if (!anilistId) return null;

  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { status title { native } format description startDate { year month day } coverImage { extraLarge large } trailer { id site } externalLinks { site type url } streamingEpisodes { site } } }`;

  try {
    // la file AniList commune de l'API (file-anilist.ts : 2,5 s au moins entre deux departs, sous la limite d'AniList) ;
    // un refus (429) suspend les suivantes le temps demande, et la lecture rend null : rien n'est change
    await tourAniList();
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: anilistId } }),
    });

    if (res.status === 429) {
      aniListRefuse(res.headers.get("retry-after"));
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json() as any;
    const media = data?.data?.Media;
    if (!media) return null;

    const cover = media.coverImage?.extraLarge ?? media.coverImage?.large ?? null;
    const titleNative: string | null = media.title?.native ?? null;

    const platforms = new Set<string>();
    if (Array.isArray(media.externalLinks)) {
      for (const link of media.externalLinks) {
        if (link?.type === "STREAMING" && link?.site) {
          if (link.site === "YouTube") {
            // AniList etiquette "YouTube" sans preciser le distributeur.
            // On resout la vraie chaine : distributeur officiel -> son nom
            // (Muse Asia, Ani-One...) ; promo/PV -> retire (null).
            const distributeur = await resoudreDistributeurYouTube(link.url);
            if (distributeur) platforms.add(distributeur);
          } else {
            platforms.add(link.site);
          }
        }
      }
    }
    if (Array.isArray(media.streamingEpisodes)) {
      for (const ep of media.streamingEpisodes) {
        if (ep?.site) platforms.add(ep.site);
      }
    }
    const platform = platforms.size > 0 ? Array.from(platforms).join(", ") : null;

    let trailerUrl: string | null = null;
    if (media.trailer?.site === "youtube" && media.trailer?.id) {
      trailerUrl = "https://www.youtube.com/watch?v=" + media.trailer.id;
    }

    const description = stripDescriptionTags(media.description);
    const format = media.format ?? null;
    // Deduire date + precision reelle depuis startDate AniList (day=null => precision month, month=null => year)
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    const sd = media.startDate;
    if (sd && sd.year) {
      const pad2 = (n: number) => String(n).padStart(2, "0");
      if (sd.month && sd.day) {
        releaseDate = sd.year + "-" + pad2(sd.month) + "-" + pad2(sd.day);
        releasePrecision = "day";
      } else if (sd.month) {
        releaseDate = sd.year + "-" + pad2(sd.month) + "-01";
        releasePrecision = "month";
      } else {
        releaseDate = sd.year + "-01-01";
        releasePrecision = "year";
      }
    }
    const statut: string | null = typeof media.status === "string" ? media.status : null;
    return { cover, titleNative, platform, trailerUrl, description, format, releaseDate, releasePrecision, statut };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Kitsu : remplace Jikan, dont l'API publique a fermé le 1er octobre 2026
// ─────────────────────────────────────────────────────────────────────────
// API publique, sans clé. La fiche est retrouvée par l'identifiant
// MyAnimeList (AniList le donne : idMal), sinon par l'identifiant AniList.
// Kitsu ne comble que deux trous d'AniList : le titre japonais et la
// bande-annonce. Le reste ne vient jamais de lui :
//   - jaquette : celle d'AniList ;
//   - date : Kitsu ne dit pas si elle est connue au jour, au mois ou à
//     l'année près (AniList et AnimeSchedule, si) ;
//   - plateformes : ses listes sont américaines et plus pauvres que les
//     nôtres (relevé du 12 octobre 2026 : 8 animes sur 8) ;
//   - texte : souvent celui de MyAnimeList. Les synopsis affichés seront
//     écrits par Ollama ; Kitsu leur sert de documentation (synopsis.ts).
// Ces deux champs ne sont remplis qu'une fois (jamais remplacés ensuite) :
//   - les appelants ne consultent Kitsu que si AniList a répondu sans les
//     avoir (une panne ou un 429 d'AniList ne doit pas figer la valeur de
//     Kitsu) ;
//   - une bande-annonce de Kitsu n'est gardée que si YouTube la dit encore
//     visible et intégrable (oEmbed, sans clé) : Kitsu garde souvent des
//     vidéos supprimées ou privées.
// Kitsu en panne : après 3 erreurs passagères d'affilée (délai, réseau, 429,
// 502 à 504), plus d'appel pendant 30 min : un passage de la Phase B ne doit
// pas attendre 200 fois le délai. Une erreur propre à une fiche ne compte pas.
// KITSU_API_URL, YOUTUBE_OEMBED_URL : pour les tests seulement (faux serveurs).
const KITSU_API = process.env.KITSU_API_URL || "https://kitsu.io/api/edge";
const YOUTUBE_OEMBED = process.env.YOUTUBE_OEMBED_URL || "https://www.youtube.com/oembed";
const KITSU_TIMEOUT_MS = 10000;
const KITSU_ERREURS_MAX = 3;
const KITSU_PAUSE_MS = 30 * 60 * 1000;
let kitsuErreurs = 0;
let kitsuPauseJusqua = 0;

function kitsuErreur(): null {
  kitsuErreurs++;
  if (kitsuErreurs >= KITSU_ERREURS_MAX) {
    kitsuErreurs = 0;
    kitsuPauseJusqua = Date.now() + KITSU_PAUSE_MS;
  }
  return null;
}

/** La vidéo YouTube est-elle encore publique et intégrable ? (oEmbed : 200 oui ; 401, 403, 404 non). Dans le doute : non. */
export async function videoYouTubeVisible(url: string): Promise<boolean> {
  try {
    const res = await fetch(YOUTUBE_OEMBED + "?format=json&url=" + encodeURIComponent(url), {
      headers: { "User-Agent": "GameNime/1.0 (+https://gamenime.fr)" },
      signal: AbortSignal.timeout(KITSU_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ce que Kitsu apporte d'une fiche (attributs JSON:API d'un « anime »). */
export function kitsuVersSource(a: any): SourceData {
  const ja = typeof a?.titles?.ja_jp === "string" ? a.titles.ja_jp.trim().slice(0, 250) : "";
  const yt = typeof a?.youtubeVideoId === "string" ? a.youtubeVideoId.trim() : "";
  return {
    cover: null,
    titleNative: ja || null,
    platform: null,
    trailerUrl: /^[A-Za-z0-9_-]{11}$/.test(yt) ? "https://www.youtube.com/watch?v=" + yt : null,
    description: null,
    format: null,
    releaseDate: null,
    releasePrecision: null,
  };
}

/**
 * Fiche Kitsu d'un anime ; null si Kitsu ne la connaît pas ou ne répond pas. Ne lève jamais d'erreur.
 * avecBandeAnnonce : false quand la bande-annonce ne servira pas (pas d'appel à YouTube pour rien).
 */
export async function fetchKitsu(malId: number | null, anilistId: number | null, avecBandeAnnonce = true): Promise<SourceData | null> {
  if (Date.now() < kitsuPauseJusqua) return null;
  const essais: Array<[string, number]> = [];
  if (malId) essais.push(["myanimelist/anime", malId]);
  if (anilistId) essais.push(["anilist/anime", anilistId]);
  for (const [site, id] of essais) {
    let res: Response;
    let json: any = null;
    try {
      res = await fetch(
        KITSU_API + "/mappings?filter[externalSite]=" + site + "&filter[externalId]=" + id + "&include=item",
        {
          headers: { Accept: "application/vnd.api+json", "User-Agent": "GameNime/1.0 (+https://gamenime.fr)" },
          signal: AbortSignal.timeout(KITSU_TIMEOUT_MS),
        }
      );
    } catch {
      return kitsuErreur();
    }
    // Kitsu en panne ou qui refuse : inutile d'essayer l'autre identifiant
    if (!res.ok) return [429, 502, 503, 504].includes(res.status) ? kitsuErreur() : null;
    try {
      json = await res.json();
    } catch (e: any) {
      // réponse illisible (propre à cette fiche) ou coupée en route (panne passagère)
      return e?.name === "SyntaxError" ? null : kitsuErreur();
    }
    kitsuErreurs = 0;
    const ref = json?.data?.[0]?.relationships?.item?.data;
    if (!ref || ref.type !== "anime" || ref.id == null) continue;
    const fiche = Array.isArray(json?.included)
      ? json.included.find((x: any) => x?.type === "anime" && String(x?.id) === String(ref.id))
      : null;
    if (!fiche?.attributes) continue;
    const source = kitsuVersSource(fiche.attributes);
    if (!avecBandeAnnonce) source.trailerUrl = null;
    else if (source.trailerUrl && !(await videoYouTubeVisible(source.trailerUrl))) source.trailerUrl = null;
    return source;
  }
  return null;
}

/**
 * Kitsu est-il utile pour cet item ? Seulement si AniList a répondu (ou si l'item
 * n'a pas d'identifiant AniList) et qu'il manque encore le titre japonais ou la
 * bande-annonce demandés. Une panne d'AniList ne doit pas faire écrire, pour
 * toujours, la valeur de Kitsu dans un champ qu'AniList aurait rempli.
 */
export function kitsuUtile(
  item: { anilist_id: number | null; mal_id: number | null },
  aniList: SourceData | null,
  manque: { titreJaponais: boolean; bandeAnnonce: boolean }
): boolean {
  if (!item.mal_id && !item.anilist_id) return false;
  if (item.anilist_id && !aniList) return false;
  return (manque.titreJaponais && !aniList?.titleNative) || (manque.bandeAnnonce && !aniList?.trailerUrl);
}

// ─────────────────────────────────────────────────────────────────────────
// Rattachement des routes AnimeSchedule (session 33)
// ─────────────────────────────────────────────────────────────────────────
// refetch-cron UTILISE anime_schedule_route mais ne la CREE jamais : 243 animes
// sur 392 n'en ont pas, dont 91 avec popularity > 10000 (Frieren S2, Dandadan
// S3, Oshi no Ko S3...). Sans route, impossible de les croiser avec le
// timetable — ils n'apparaissent pas dans le radar hebdo.
// Validation stricte, comme lookupIgdbByTitle : titre normalise identique ET
// annee a plus ou moins 1. Plus d'un candidat -> on n'ecrit rien.
export async function lookupAnimeScheduleRoute(
  titre: string,
  annee: number | null,
  apiToken: string
): Promise<string | null> {
  if (!titre || !apiToken) return null;
  try {
    const url = AS_API + "/anime?q=" + encodeURIComponent(titre);
    const res = await fetch(url, { headers: { Authorization: "Bearer " + apiToken } });
    if (!res.ok) return null;
    const txt = await res.text();
    if (!txt || txt.trim()[0] !== "{" && txt.trim()[0] !== "[") return null;
    const data = JSON.parse(txt) as any;
    const liste: any[] = Array.isArray(data) ? data : (data?.anime || []);
    if (!liste.length) return null;

    const vise = normalizeTitleStrict(titre);
    if (!vise) return null;
    let cands = liste.filter((a) => normalizeTitleStrict(String(a?.title || "")) === vise);
    if (annee) {
      const dansAnnee = cands.filter((a) => {
        const y = Number(a?.year || 0);
        return y > 0 && Math.abs(y - annee) <= 1;
      });
      if (dansAnnee.length > 0) cands = dansAnnee;
    }
    if (cands.length !== 1) return null;
    return String(cands[0].route || "") || null;
  } catch {
    return null;
  }
}

// Discord : silence quand il n'y a rien a signaler. Un message quotidien
// "0 route trouvee" polluerait le salon — on ne parle que si on a rattache
// quelque chose, ou si le cycle a echoue.
async function notifierRoutes(scanned: number, matched: number, erreur: string | null): Promise<void> {
  const url = erreur
    ? process.env.DISCORD_WEBHOOK_ERRORS
    : process.env.DISCORD_WEBHOOK_WORKFLOWS;
  if (!url) return;
  if (!erreur && matched === 0) return;
  const titre = erreur ? "❌ Routes AnimeSchedule" : "✅ Routes AnimeSchedule";
  const desc = erreur
    ? `Échec après ${scanned} anime(s) scanné(s), ${matched} rattaché(s).\n\`${erreur}\``
    : `**${matched}** route(s) rattachée(s) sur **${scanned}** anime(s) sans route.`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: titre,
          description: desc,
          color: erreur ? 15158332 : 3066993,
          footer: { text: "GameNime · Toutes les 6 h" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch {
    /* le suivi ne doit jamais faire echouer le cycle */
  }
}

/**
 * Planchers de popularite par franchise.
 *
 * IGDB compte les clics "je l'attends" sur son site : un public de passionnes
 * ou personne ne declare attendre FIFA. EA Sports FC 27 y pesait 2, derriere
 * 255 autres jeux a venir, quand c'est le premier vendeur europeen chaque
 * annee. Ces planchers corrigent une cecite mesurable de la source, ils
 * n'arbitrent pas les gouts.
 *
 * popularity_source garde toujours la valeur brute d'IGDB : le cycle compare
 * cette colonne au plancher, jamais son propre resultat. Sans elle, un
 * plancher applique une fois deviendrait indistinguable d'une vraie remontee
 * IGDB, et on ecraserait la donnee reelle au passage suivant.
 *
 * Idempotent (n'ecrit que si la valeur change) et reversible : desactiver un
 * plancher et relancer restaure la popularite d'origine.
 */
export async function applyFranchiseFloorsCycle(app: any): Promise<{
  scanned: number;
  raised: number;
  restored: number;
}> {
  const pool = (app as any).pool;
  if (!pool) {
    app.log.warn("Franchise floors: pool absent");
    return { scanned: 0, raised: 0, restored: 0 };
  }
  const debut = Date.now();
  const conn = await pool.getConnection();
  let scanned = 0, raised = 0, restored = 0;
  try {
    // Filet de securite : sans popularity_source, la valeur brute serait
    // perdue des la premiere application.
    await conn.query(
      "UPDATE game_items SET popularity_source = popularity WHERE popularity_source IS NULL"
    );

    const floors: Array<{ pattern: string; floor_value: number }> = await conn.query(
      "SELECT pattern, floor_value FROM franchise_floors WHERE active = 1"
    );

    // Tous les jeux, pas seulement ceux qui correspondent : un plancher
    // desactive doit faire redescendre la popularite a sa valeur d'origine.
    const jeux: Array<{ id: number; title: string; popularity: number; popularity_source: number }> =
      await conn.query(
        "SELECT id, title, popularity, popularity_source FROM game_items WHERE title IS NOT NULL"
      );
    scanned = jeux.length;

    // LIKE de SQL traduit en JS : % en debut ou fin, insensible a la casse
    // et aux accents (Pokemon doit correspondre a Pokémon, comme la collation).
    const correspond = (titre: string, motif: string): boolean => {
      const norm = (v: string) =>
        v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const t = norm(titre);
      const m = norm(motif);
      if (m.startsWith("%") && m.endsWith("%")) return t.includes(m.slice(1, -1));
      if (m.endsWith("%")) return t.startsWith(m.slice(0, -1));
      if (m.startsWith("%")) return t.endsWith(m.slice(1));
      return t === m;
    };

    for (const j of jeux) {
      const source = Number(j.popularity_source ?? 0);
      let cible = source;
      for (const f of floors) {
        if (correspond(j.title, f.pattern) && Number(f.floor_value) > cible) {
          cible = Number(f.floor_value);
        }
      }
      const actuelle = Number(j.popularity ?? 0);
      if (cible === actuelle) continue;   // idempotence

      await conn.query("UPDATE game_items SET popularity = ? WHERE id = ?", [cible, j.id]);
      if (cible > source) {
        raised++;
        app.log.info({ id: j.id, title: j.title, source, plancher: cible }, "plancher applique");
      } else {
        restored++;
        app.log.info({ id: j.id, title: j.title, source }, "popularite restauree");
      }
    }

    app.log.info({ scanned, raised, restored }, "Franchise floors: termine");
    trackLastRun("franchise-floors", { scanned, raised, restored }, Date.now() - debut);
    if (raised > 0 || restored > 0) {
      pushActivity({
        type: "popularity",
        message: `${raised} plancher${raised > 1 ? "s" : ""} appliqué${raised > 1 ? "s" : ""}` +
          (restored > 0 ? `, ${restored} restauré${restored > 1 ? "s" : ""}` : ""),
        detail: `${scanned} jeu${scanned > 1 ? "x" : ""} scanné${scanned > 1 ? "s" : ""}`,
        level: "info",
      });
    }
    return { scanned, raised, restored };
  } catch (e: any) {
    app.log.error({ err: e?.message }, "Franchise floors: erreur");
    trackLastRun("franchise-floors", { scanned, raised, restored, error: e?.message }, Date.now() - debut);
    return { scanned, raised, restored };
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rattachement des routes PAR IDENTIFIANT (15 octobre 2026)
// ─────────────────────────────────────────────────────────────────────────
// « Cette semaine » ne montre un épisode du planning AnimeSchedule que si la route de l'anime est en base. Par le
// titre seul, des séries connues restaient sans route : au relevé du 15 octobre, 10 épisodes de la semaine sur 75
// (JoJo Steel Ball Run 2nd Stage, Overgeared, Link Click 3...). AnimeSchedule cherche aussi par identifiant (filtres
// anilist-ids et mal-ids de /anime) et chaque fiche porte ses liens AniList et MyAnimeList : la route est posée quand
// la fiche porte bien l'identifiant de l'anime, qu'une seule fiche le porte, et que la route n'est portée par aucun
// autre anime. Une route déjà posée n'est jamais remplacée. Le titre ne sert plus qu'aux animes sans identifiant.
const ROUTES_PAR_REQUETE = 18; // une page d'AnimeSchedule
const ROUTES_PAUSE_MS = 400;
const ROUTES_TITRE_MAX = 50;

type Identifiant = "anilist" | "mal";

/** L'identifiant d'un lien de fiche AnimeSchedule : « anilist.co/anime/21 » (AniList), « myanimelist.net/anime/21 » (MAL). */
export function identifiantDuLien(lien: unknown, genre: Identifiant): number | null {
  const re = genre === "anilist" ? /anilist\.co\/anime\/(\d+)/i : /myanimelist\.net\/anime\/(\d+)/i;
  const m = re.exec(String(lien ?? ""));
  return m ? Number(m[1]) : null;
}

async function lireAnimeSchedule(chemin: string, jeton: string): Promise<any> {
  const r = await fetch(AS_API + chemin, {
    headers: { Authorization: "Bearer " + jeton, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  // une recherche sans aucune fiche répond 404 (relevé du 15 octobre) : c'est une liste vide, pas une panne
  if (r.status === 404) return { page: 1, totalAmount: 0, anime: [] };
  if (r.status === 429) throw new Error("AnimeSchedule : trop de requetes (429)");
  if (!r.ok) throw new Error(`AnimeSchedule : HTTP ${r.status}`);
  return r.json();
}

/**
 * Les routes AnimeSchedule d'une liste d'identifiants : identifiant -> routes des fiches qui portent ce lien.
 * 18 identifiants par requête (mt=any : l'un ou l'autre) ; page suivante si AnimeSchedule en annonce davantage.
 * Une erreur (429, panne) arrête la lecture : les lots déjà lus sont rendus avec l'erreur. Un lot à moitié lu (erreur
 * sur sa page 2, ou plus de 3 pages) n'est pas rendu : un identifiant pourrait avoir une 2e fiche dans la page manquante.
 */
export async function routesParIdentifiant(
  genre: Identifiant,
  ids: number[],
  jeton: string,
  pause = ROUTES_PAUSE_MS
): Promise<{ routes: Map<number, string[]>; requetes: number; erreur: string | null }> {
  const param = genre === "anilist" ? "anilist-ids" : "mal-ids";
  const champ = genre === "anilist" ? "aniList" : "mal";
  const routes = new Map<number, string[]>();
  let requetes = 0;
  const uniques = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  for (let i = 0; i < uniques.length; i += ROUTES_PAR_REQUETE) {
    const lot = uniques.slice(i, i + ROUTES_PAR_REQUETE);
    const voulus = new Set(lot);
    const duLot = new Map<number, string[]>();
    let complet = false;
    try {
      for (let page = 1; page <= 3; page++) {
        if (requetes) await new Promise((r) => setTimeout(r, pause));
        requetes++;
        const d = await lireAnimeSchedule(`/anime?mt=any&page=${page}&${lot.map((x) => `${param}=${x}`).join("&")}`, jeton);
        const liste: any[] = Array.isArray(d) ? d : Array.isArray(d?.anime) ? d.anime : [];
        for (const a of liste) {
          const id = identifiantDuLien(a?.websites?.[champ], genre);
          const route = typeof a?.route === "string" ? a.route.trim() : "";
          if (!id || !route || !voulus.has(id)) continue;
          const l = duLot.get(id) ?? [];
          if (!l.includes(route)) l.push(route);
          duLot.set(id, l);
        }
        const total = Number(d?.totalAmount ?? liste.length);
        if (liste.length === 0 || !Number.isFinite(total) || page * ROUTES_PAR_REQUETE >= total) {
          complet = true;
          break;
        }
      }
    } catch (e: any) {
      return { routes, requetes, erreur: String(e?.message ?? e) };
    }
    if (complet) for (const [id, l] of duLot) routes.set(id, l);
  }
  return { routes, requetes, erreur: null };
}

export async function matchAnimeRoutesCycle(app: FastifyInstance): Promise<{
  scanned: number;
  matched: number;
}> {
  const token = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool || !token) {
    app.log.warn("Match routes cycle: pool ou token absent");
    return { scanned: 0, matched: 0 };
  }
  const debut = Date.now();
  const conn = await pool.getConnection();
  let scanned = 0, matched = 0, parId = 0, parTitre = 0, conflits = 0, doubles = 0, requetes = 0;
  let arret: string | null = null;
  try {
    const sans: any[] = await conn.query(
      "SELECT CAST(id AS UNSIGNED) AS id, title, YEAR(release_date) AS annee, " +
      "CAST(IFNULL(anilist_id, 0) AS UNSIGNED) AS al, CAST(IFNULL(mal_id, 0) AS UNSIGNED) AS mal FROM anime_items " +
      "WHERE (anime_schedule_route IS NULL OR anime_schedule_route = '') " +
      "AND title IS NOT NULL AND title != '' " +
      "ORDER BY popularity DESC"
    );
    scanned = sans.length;
    const prises = new Set<string>(
      (await conn.query("SELECT anime_schedule_route AS r FROM anime_items WHERE anime_schedule_route IS NOT NULL AND anime_schedule_route != ''"))
        .map((x: any) => String(x.r))
    );
    // pose la route si personne ne la porte ; jamais par-dessus une route déjà posée (même entre deux lectures).
    // updated_at gardé, comme les autres cycles internes : le tableau de bord y lit le dernier envoi des workflows.
    const poser = async (it: any, route: string, via: string): Promise<boolean> => {
      if (prises.has(route)) {
        conflits++;
        app.log.warn({ id: Number(it.id), title: it.title, route, via }, "route AnimeSchedule deja portee par un autre anime : rien n'est pose");
        return false;
      }
      const r: any = await conn.query(
        "UPDATE anime_items SET anime_schedule_route = ?, updated_at = updated_at WHERE id = ? AND (anime_schedule_route IS NULL OR anime_schedule_route = '')",
        [route, it.id]
      );
      if (Number(r?.affectedRows ?? 0) !== 1) return false;
      prises.add(route);
      matched++;
      app.log.info({ id: Number(it.id), title: it.title, route, via }, "route AnimeSchedule rattachee");
      return true;
    };
    const restants = new Map<number, any>(sans.map((x) => [Number(x.id), x]));

    // 1. par identifiant : AniList, puis MyAnimeList pour ceux qui restent
    for (const genre of ["anilist", "mal"] as const) {
      const col = genre === "anilist" ? "al" : "mal";
      const vises = [...restants.values()].filter((x) => Number(x[col]) > 0);
      if (!vises.length) continue;
      const res = await routesParIdentifiant(genre, vises.map((x) => Number(x[col])), token);
      requetes += res.requetes;
      if (res.erreur) arret = res.erreur;
      for (const it of vises) {
        const rs = res.routes.get(Number(it[col])) ?? [];
        if (rs.length > 1) {
          doubles++;
          restants.delete(Number(it.id));
          app.log.warn({ id: Number(it.id), title: it.title, routes: rs }, "plusieurs fiches AnimeSchedule pour cet identifiant : rien n'est pose");
          continue;
        }
        if (rs.length === 1 && await poser(it, rs[0], genre === "anilist" ? `AniList ${Number(it.al)}` : `MAL ${Number(it.mal)}`)) {
          parId++;
          restants.delete(Number(it.id));
        }
      }
      if (arret) break;
    }

    // 2. par titre (ancienne règle) : seulement les animes sans aucun identifiant
    if (!arret) {
      const sansId = [...restants.values()].filter((x) => !(Number(x.al) > 0) && !(Number(x.mal) > 0)).slice(0, ROUTES_TITRE_MAX);
      for (const it of sansId) {
        if (requetes) await new Promise((r) => setTimeout(r, ROUTES_PAUSE_MS));
        requetes++;
        const route = await lookupAnimeScheduleRoute(it.title, it.annee || null, token);
        if (route && await poser(it, route, "titre")) parTitre++;
      }
    }

    if (arret) app.log.warn({ scanned, matched, err: arret }, "Match routes cycle: interrompu, reprise au prochain passage");
    app.log.info({ scanned, matched, parId, parTitre, conflits, doubles, requetes }, "Match routes cycle: termine");
    trackLastRun("match-anime-routes", { scanned, matched, parId, parTitre, conflits, doubles, requetes, ...(arret ? { error: arret } : {}) }, Date.now() - debut);
    if (matched > 0) {
      pushActivity({
        type: "routes",
        message: `${matched} route${matched > 1 ? "s" : ""} AnimeSchedule rattachée${matched > 1 ? "s" : ""}`,
        detail: `${parId} par identifiant, ${parTitre} par titre ; ${scanned} anime${scanned > 1 ? "s" : ""} sans route`,
        level: "info",
      });
    }
    await notifierRoutes(scanned, matched, null);
  } catch (e: any) {
    app.log.error({ err: e?.message }, "Match routes cycle: erreur");
    trackLastRun("match-anime-routes", { scanned, matched, error: e?.message }, Date.now() - debut);
    pushActivity({
      type: "routes",
      message: "Échec du rattachement des routes",
      detail: e?.message ?? "erreur inconnue",
      level: "error",
    });
    await notifierRoutes(scanned, matched, e?.message ?? "erreur inconnue");
  } finally {
    conn.release();
  }
  return { scanned, matched };
}

export async function fetchAnimeSchedule(route: string, apiToken: string): Promise<SourceData | null> {
  if (!route) return null;

  try {
    const res = await fetch(AS_API + "/anime/" + encodeURIComponent(route), {
      headers: { "Authorization": "Bearer " + apiToken },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data) return null;

    const cover = data.imageVersionRoute
      ? "https://img.animeschedule.net/production/assets/public/img/anime/" + data.imageVersionRoute
      : null;
    const titleNative: string | null = data.names?.native ?? null;

    const platforms: string[] = [];
    if (data.websites?.streams && Array.isArray(data.websites.streams)) {
      for (const s of data.websites.streams) {
        if (s?.name) platforms.push(s.name);
      }
    }
    const platform = platforms.length > 0 ? platforms.join(", ") : null;

    const description = stripDescriptionTags(data.description);
    // AnimeSchedule : champ 'premier' = vraie date de sortie (jour). Les autres
    // (subPremier, jpnTime, subTime...) sont des sentinels 0001-01-01 => ignores.
    let releaseDate: string | null = null;
    let releasePrecision: "day" | "month" | "year" | null = null;
    const premier = data.premier;
    if (typeof premier === "string" && !premier.startsWith("0001-01-01")) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(premier);
      if (m) {
        releaseDate = m[1] + "-" + m[2] + "-" + m[3];
        releasePrecision = "day";  // premier donne toujours le jour
      }
    }
    return { cover, titleNative, platform, trailerUrl: null, description, releaseDate, releasePrecision };
  } catch (e) {
    return null;
  }
}

/**
 * SESSION 12.7+: nettoie une description en retirant :
 *   - les tags AniList workflow [FORMAT:X] [STATUS:X] [SEASON:X] [EPISODES:X] [LENGTH:X]
 *   - les balises HTML communes (<br>, <i>, <b>, <strong>, <em>)
 *   - les whitespace et newlines de fin
 * Retourne null si après nettoyage la description est vide ou trop courte (<10 chars).
 */
export function stripDescriptionTags(desc: string | null | undefined): string | null {
  if (!desc || typeof desc !== "string") return null;
  let cleaned = desc
    .replace(/\s?\[(FORMAT|STATUS|SEASON|EPISODES|LENGTH):[^\]]+\]/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(i|b|strong|em|u)>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length < 10) return null;
  return cleaned;
}

/**
 * SESSION 12.7+: détecte si une cover est sur un domaine hotlink-protected.
 * MAL et AnimeSchedule bloquent les requêtes du navigateur depuis d'autres
 * domaines (Referer check), même si la requête HTTP côté serveur réussit.
 * Ces covers DOIVENT être remplacées par AniList si possible.
 */
export function isHotlinkProtectedCover(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("myanimelist.net") || url.includes("animeschedule.net");
}

/**
 * SESSION 12.7+: détecte si une cover vient d'AniList (= utilisable côté navigateur).
 */
export function isAniListCover(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("anilistcdn") || url.includes("s4.anilist.co");
}

// Une plateforme est "faible" si elle est absente ou reduite au seul YouTube
// (souvent la chaine promo, pas un vrai diffuseur). Definition unique, reutilisee
// par le cron, le refetch unitaire et la fusion des sources.
export function isPlatformWeak(p: string | null | undefined): boolean {
  // Weak si vide, OU si contient "YouTube" brut (seul ou en liste). AniList
  // etiquette "YouTube" sans distributeur ; un re-fetch resout ce YouTube en
  // nom de distributeur (Muse Asia...) ou le retire. Detecter YouTube n'importe
  // ou dans la chaine permet au re-fetch de corriger les 103 animes pollues.
  // Converge : apres resolution, plus de "YouTube" brut -> plus weak.
  if (!p || p.trim() === "") return true;
  return /(^|,\s*)YouTube(\s*,|\s*$)/.test(p.trim());
}
export function mergeSources(
  aniList: SourceData | null,
  kitsu: SourceData | null,
  animeSchedule: SourceData | null
): SourceData {
  const sources = [aniList, kitsu, animeSchedule].filter(s => s !== null) as SourceData[];
  // AnimeSchedule est volontairement limitee a la date et, en dernier recours, a la
  // plateforme : ses covers sont des hotlinks (cf. isHotlinkCover) et son vocabulaire
  // de format n'est pas normalise sur l'enum AniList.
  // Kitsu ne donne que le titre japonais et la bande-annonce (cf. kitsuVersSource) :
  // pour le reste, primary se resume a AniList.
  const primary = [aniList, kitsu].filter(s => s !== null) as SourceData[];
  // Date : preferer la source avec la MEILLEURE precision (day > month > year).
  // AniList prioritaire a precision egale (ordre du tableau : aniList d'abord).
  const precRank: Record<string, number> = { day: 3, month: 2, year: 1 };
  let bestDate: string | null = null;
  let bestPrecision: "day" | "month" | "year" | null = null;
  for (const s of sources) {
    if (s.releaseDate && s.releasePrecision) {
      if (bestPrecision === null || precRank[s.releasePrecision] > precRank[bestPrecision]) {
        bestDate = s.releaseDate;
        bestPrecision = s.releasePrecision;
      }
    }
  }
  // Plateformes : FUSIONNER toutes les sources (pas juste la premiere), en
  // dedupliquant. Depuis le retrait de Jikan, seul AniList en donne ici ; les
  // plateformes francaises viennent des modules presse, plateformes et Tavily.
  const platformSet = new Set<string>();
  const addPlatforms = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const p of raw.split(",").map(x => x.trim()).filter(Boolean)) platformSet.add(p);
  };
  for (const s of primary) addPlatforms(s.platform);
  const mergedPlatform = platformSet.size > 0 ? Array.from(platformSet).join(", ") : null;
  // AnimeSchedule ne contribue PAS aux plateformes : sur un echantillon de 12 items
  // sans plateforme, un seul remontait un stream, et c'etait "YouTube" — donc une
  // valeur deja consideree comme faible, qui aurait masque le libelle "Plateforme EU
  // non annoncee" par un diffuseur ou l'utilisateur ne trouverait rien.
  // Perimetre de cette source : la date de sortie, et elle seule.
  return {
    cover: primary.find(s => s.cover)?.cover ?? null,
    // Premiere source qui repond : AniList, puis Kitsu.
    titleNative: primary.find(s => s.titleNative)?.titleNative ?? null,
    platform: mergedPlatform,
    trailerUrl: primary.find(s => s.trailerUrl)?.trailerUrl ?? null,
    description: primary.find(s => s.description)?.description ?? null,
    format: primary.find(s => s.format)?.format ?? null,
    releaseDate: bestDate,
    releasePrecision: bestPrecision,
  };
}

/**
 * La date d'un anime apres lecture des sources (19 octobre 2026, dates-animes.ts) : AniList fait reference. Sans
 * reponse d'AniList (panne, 429), la date ne change pas ; AnimeSchedule ne fait que preciser le jour dans la periode
 * d'AniList (plus de vieux jour qui passe devant un report). Un anime « Date a annoncer » ou sans date n'est pas
 * touche ici : le passage « Dates des animes » s'en charge (et previent ses abonnes). Sans identifiant AniList : la
 * meilleure precision des sources, comme avant.
 */
function nouvelleDate(item: any, aniList: SourceData | null, animeSchedule: SourceData | null, merged: SourceData): { date: string; precision: "day" | "month" | "year" } | null {
  if (!item.anilist_id) {
    if (!merged.releaseDate || !merged.releasePrecision) return null;
    return merged.releaseDate !== item.release_date || merged.releasePrecision !== item.release_precision
      ? { date: merged.releaseDate, precision: merged.releasePrecision }
      : null;
  }
  if (!aniList || Number(item.date_a_annoncer) === 1 || !item.release_date) return null;
  const v = verdictDate(
    { date: aniList.releaseDate ?? null, precision: aniList.releasePrecision ?? null, statut: aniList.statut ?? null },
    animeSchedule?.releasePrecision === "day" ? animeSchedule.releaseDate ?? null : null,
    { date: item.release_date, precision: precisionDe(item.release_precision) },
    new Date().toISOString().slice(0, 10)
  );
  return v.quoi === "ecrire" ? { date: v.date, precision: v.precision } : null;
}

export async function refetchIncompleteCycle(app: FastifyInstance): Promise<{
  scanned: number;
  enriched: number;
  errors: number;
  changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }>;
}> {
  const animeScheduleToken = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool) {
    app.log.error("Refetch cycle: pool DB introuvable");
    return { scanned: 0, enriched: 0, errors: 0, changes: [] };
  }

  const conn = await pool.getConnection();
  let scanned = 0;
  let enriched = 0;
  let errors = 0;
  const changes: Array<{ id: number; title: string; field: string; oldValue: any; newValue: any }> = [];

  try {
    // « Date à annoncer » : sa précision vide n'est pas un manque (sa date revient par le passage « Dates des animés ») ;
    // un annulé chez AniList (retiré du site) n'est plus relu ; il revient si AniList le relance (20 octobre 2026)
    const items: IncompleteItem[] = await conn.query(
      "SELECT id, title, title_native, anilist_id, mal_id, anime_schedule_route, cover, platform, trailer_url, description, format, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, release_precision, date_a_annoncer FROM anime_items WHERE (platform IS NULL OR platform = '' OR TRIM(platform) = 'YouTube' OR cover IS NULL OR cover = '' OR trailer_url IS NULL OR trailer_url = '' OR description IS NULL OR description = '' OR LENGTH(TRIM(REGEXP_REPLACE(description, '\\[[A-Z]+:[^]]*\\]', ''))) < 150 OR cover LIKE '%myanimelist.net%' OR cover LIKE '%animeschedule.net%' OR format IS NULL OR format = '' OR title_native IS NULL OR title_native = '' OR (release_precision IS NULL AND date_a_annoncer = 0) OR release_precision <> 'day') AND (anilist_id IS NOT NULL OR mal_id IS NOT NULL OR anime_schedule_route IS NOT NULL) AND (release_date >= CURDATE() - INTERVAL 365 DAY OR date_a_annoncer = 1) AND IFNULL(statut_anilist, '') <> 'CANCELLED' ORDER BY popularity DESC LIMIT " + REFETCH_BATCH_SIZE
    );

    scanned = items.length;
    app.log.info({ scanned }, "Refetch cycle: items scannes");

    for (const item of items) {
      try {
        const [aniList, animeSchedule] = await Promise.all([
          item.anilist_id ? fetchAniList(item.anilist_id) : null,
          item.anime_schedule_route && animeScheduleToken
            ? fetchAnimeSchedule(item.anime_schedule_route, animeScheduleToken)
            : null,
        ]);
        // Kitsu ensuite, seulement s'il peut combler un trou qu'AniList a laisse
        const kitsu = kitsuUtile(item, aniList, { titreJaponais: !(item as any).title_native, bandeAnnonce: !item.trailer_url })
          ? await fetchKitsu(item.mal_id, item.anilist_id, !item.trailer_url && !aniList?.trailerUrl)
          : null;

        const merged = mergeSources(aniList, kitsu, animeSchedule);

        const updates: string[] = [];
        const params: any[] = [];
        const itemChanges: Array<{ field: string; oldValue: any; newValue: any }> = [];

        // SESSION 12.7+: cover upgrade en 2 cas:
        //   (1) cover absente ET on a une cover quelconque
        //   (2) cover hotlink-protected (MAL/AS) ET on a une cover AniList (utilisable navigateur)
        const coverIsEmpty = !item.cover || item.cover === "";
        const coverIsHotlinkProtected = isHotlinkProtectedCover(item.cover);
        const newCoverFromAniList = aniList?.cover && isAniListCover(aniList.cover);
        if (coverIsEmpty && merged.cover) {
          updates.push("cover = ?");
          params.push(merged.cover);
          itemChanges.push({ field: "cover", oldValue: item.cover, newValue: merged.cover });
        } else if (coverIsHotlinkProtected && newCoverFromAniList) {
          updates.push("cover = ?");
          params.push(aniList!.cover);
          itemChanges.push({ field: "cover", oldValue: item.cover, newValue: aniList!.cover });
        }
        const platformIsWeak = isPlatformWeak(item.platform);
        const cleanPlatform = sanitizePlatform(merged.platform);
        if (platformIsWeak && cleanPlatform && cleanPlatform !== item.platform) {
          updates.push("platform = ?");
          params.push(cleanPlatform);
          itemChanges.push({ field: "platform", oldValue: item.platform, newValue: cleanPlatform });
        }
        if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
          updates.push("trailer_url = ?");
          params.push(merged.trailerUrl);
          itemChanges.push({ field: "trailer_url", oldValue: item.trailer_url, newValue: merged.trailerUrl });
        }
        // SESSION 12.7+: description (lossless append - on remplit si vide ou trop courte)
        // Longueur du VRAI texte : les balises [FORMAT:] [STATUS:] [SEASON:] posees
    // par n8n gonflaient la mesure — Youjo Senki II affichait 92 caracteres pour
    // 34 de synopsis reel. Seuil a 200 : au-dela ce sont de vrais synopsis (235
    // animes en ont plus de 300), en deca des phrases generiques de suite ("The
    // second season of Sousou no Frieren.", 39 car.) qu'AniList sait remplacer
    // par 880 caracteres. L'ancien seuil de 10 ne les reprenait jamais, et elles
    // restaient hors du sitemap.
    const descTexte = String(item.description ?? "").replace(/\[[A-Z]+:[^\]]*\]/g, "").trim();
    const descIsMissing = descTexte.length < 150;
        if (descIsMissing && merged.description) {
          updates.push("description = ?");
          params.push(merged.description);
          itemChanges.push({ field: "description", oldValue: item.description, newValue: merged.description.substring(0, 80) + "..." });
        }
        // FORMAT (lossless append - on remplit si vide)
        const formatIsMissing = !item.format || item.format === "";
        if (formatIsMissing && merged.format) {
          updates.push("format = ?");
          params.push(merged.format);
          itemChanges.push({ field: "format", oldValue: item.format, newValue: merged.format });
        }

        // TITRE NATIF (lossless append) : AniList dans title.native, Kitsu dans
        // titles.ja_jp. merged applique deja l'ordre de repli, on remplit si la
        // colonne est vide.
        const nativeIsMissing = !(item as any).title_native || (item as any).title_native === "";
        if (nativeIsMissing && merged.titleNative) {
          updates.push("title_native = ?");
          params.push(merged.titleNative);
          itemChanges.push({ field: "title_native", oldValue: (item as any).title_native, newValue: merged.titleNative });
        }
        // DATE (19 octobre 2026) : AniList fait reference (nouvelleDate, dates-animes.ts). Une source qui ne repond pas
        // ne fait plus redescendre une date, et un vieux jour d'AnimeSchedule ne passe plus devant un report.
        const nd = nouvelleDate(item, aniList, animeSchedule, merged);
        if (nd) {
          updates.push("release_date = ?");
          params.push(nd.date);
          updates.push("release_precision = ?");
          params.push(nd.precision);
          itemChanges.push({ field: "release_date", oldValue: (item as any).release_date + " (" + ((item as any).release_precision || "?") + ")", newValue: nd.date + " (" + nd.precision + ")" });
        }

        if (updates.length > 0) {
          params.push(item.id);
          await conn.query(
            "UPDATE anime_items SET " + updates.join(", ") + " WHERE id = ?",
            params
          );
          enriched++;
          for (const ch of itemChanges) {
            changes.push({ id: item.id, title: item.title, ...ch });
          }
          app.log.info({ id: item.id, title: item.title, fields: itemChanges.map(c => c.field) }, "Item enriched");
        }
      } catch (e) {
        errors++;
        app.log.warn({ id: item.id, err: (e as any)?.message }, "Refetch item failed");
      }

      await new Promise(resolve => setTimeout(resolve, REFETCH_DELAY_MS));
    }

    app.log.info({ scanned, enriched, errors, changesCount: changes.length }, "Refetch cycle termine");
    trackLastRun("refetch-cron", { scanned, enriched, errors });
    if (enriched > 0) pushActivity({ type: "refetch", message: `Phase B enriched ${enriched} items`, detail: `${scanned} scanned, ${errors} errors`, level: "info" });
  } finally {
    conn.release();
  }

  return { scanned, enriched, errors, changes };
}

export function startRefetchCron(app: FastifyInstance): NodeJS.Timeout {
  app.log.info({ intervalMs: REFETCH_INTERVAL_MS, batchSize: REFETCH_BATCH_SIZE }, "Refetch cron demarre");
  // Pilotage (pilotage.ts, 17 octobre 2026) : les quatre cycles passent par le planificateur commun (interrupteur,
  // lancement à la main, pause, historique), avec les mêmes délais et les mêmes rythmes qu'avant.
  planifier({
    id: "phase-b-animes", premierMs: 5 * 60 * 1000, rythmeMs: REFETCH_INTERVAL_MS, suivi: "refetch-cron", processAdmin: "refetch-incomplete",
    passage: async () => {
      await refetchIncompleteCycle(app);
    },
  });
  // Dates des animes (dates-animes.ts, 19 octobre 2026) : AniList fait reference ; 40 min apres le demarrage, puis chaque heure
  planifierDatesAnimes(app);

  // « Cette semaine » (15 octobre 2026) : d'abord les séries en cours très suivies (Détective Conan...), puis le
  // rattachement des routes AnimeSchedule, par identifiant (une poignée de requêtes : 18 animes par requête).
  // 1 min et 3 min après le démarrage, puis toutes les 6 h ; une série entrée en base avance le passage des routes.
  const SEMAINE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  planifier({
    id: "series-en-cours", premierMs: 60 * 1000, rythmeMs: SEMAINE_INTERVAL_MS, suivi: "series-en-cours", actifParDefaut: configSeriesEnCours().actif,
    passage: async () => {
      const b = await passageSeriesEnCours(app);
      // comme avant (les deux dans le même passage) : la route AnimeSchedule d'une série nouvelle dans la minute
      if (b.nouvelles.length) avancer("routes-as", 60 * 1000);
    },
  });
  planifier({
    id: "routes-as", premierMs: 3 * 60 * 1000, rythmeMs: SEMAINE_INTERVAL_MS, suivi: "match-anime-routes", processAdmin: "match-anime-routes",
    passage: async () => {
      await matchAnimeRoutesCycle(app);
    },
  });

  // Planchers de franchise : un nouveau Call of Duty entre avec la popularite
  // qu'IGDB lui donne (20 pour le dernier) et resterait invisible jusqu'a un
  // appel manuel. Decale de 18 min pour ne pas concourir avec les autres cycles.
  const PLANCHERS_INTERVAL_MS = 24 * 60 * 60 * 1000;
  planifier({
    id: "planchers", premierMs: 18 * 60 * 1000, rythmeMs: PLANCHERS_INTERVAL_MS, suivi: "franchise-floors", processAdmin: "apply-franchise-floors",
    passage: async () => {
      await applyFranchiseFloorsCycle(app);
    },
  });
  return setTimeout(() => {}, 0);
}

// SESSION 18: Refetch UN seul item anime par ID (pour le bouton "Réparer" admin)
export async function refetchOneAnimeItem(app: FastifyInstance, id: number): Promise<{
  ok: boolean; found: boolean; enriched: boolean; title?: string; fields: string[]; error?: string;
}> {
  const animeScheduleToken = process.env.ANIMESCHEDULE_TOKEN || "";
  const pool = (app as any).pool;
  if (!pool) return { ok: false, found: false, enriched: false, fields: [], error: "pool DB introuvable" };
  const conn = await pool.getConnection();
  try {
    const rows: IncompleteItem[] = await conn.query(
      "SELECT id, title, title_native, anilist_id, mal_id, anime_schedule_route, cover, platform, trailer_url, description, format, DATE_FORMAT(release_date, '%Y-%m-%d') AS release_date, release_precision, date_a_annoncer FROM anime_items WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows || rows.length === 0) {
      return { ok: true, found: false, enriched: false, fields: [] };
    }
    const item = rows[0];
    const [aniList, animeSchedule] = await Promise.all([
      item.anilist_id ? fetchAniList(item.anilist_id) : null,
      item.anime_schedule_route && animeScheduleToken
        ? fetchAnimeSchedule(item.anime_schedule_route, animeScheduleToken)
        : null,
    ]);
    // Ici, Kitsu ne sert qu'a la bande-annonce (ce bouton ne remplit pas le titre japonais)
    const kitsu = kitsuUtile(item, aniList, { titreJaponais: false, bandeAnnonce: !item.trailer_url })
      ? await fetchKitsu(item.mal_id, item.anilist_id)
      : null;
    const merged = mergeSources(aniList, kitsu, animeSchedule);
    const updates: string[] = [];
    const params: any[] = [];
    const fields: string[] = [];
    const coverIsEmpty = !item.cover || item.cover === "";
    const coverIsHotlinkProtected = isHotlinkProtectedCover(item.cover);
    const newCoverFromAniList = aniList?.cover && isAniListCover(aniList.cover);
    if (coverIsEmpty && merged.cover) {
      updates.push("cover = ?"); params.push(merged.cover); fields.push("cover");
    } else if (coverIsHotlinkProtected && newCoverFromAniList) {
      updates.push("cover = ?"); params.push(aniList!.cover); fields.push("cover");
    }
    const platformIsWeakOne = isPlatformWeak(item.platform);
    const cleanPlatformOne = sanitizePlatform(merged.platform);
    if (platformIsWeakOne && cleanPlatformOne && cleanPlatformOne !== item.platform) {
      updates.push("platform = ?"); params.push(cleanPlatformOne); fields.push("plateforme");
    }
    if ((!item.trailer_url || item.trailer_url === "") && merged.trailerUrl) {
      updates.push("trailer_url = ?"); params.push(merged.trailerUrl); fields.push("trailer");
    }
    // Longueur du VRAI texte : les balises [FORMAT:] [STATUS:] [SEASON:] posees
    // par n8n gonflaient la mesure — Youjo Senki II affichait 92 caracteres pour
    // 34 de synopsis reel. Seuil a 200 : au-dela ce sont de vrais synopsis (235
    // animes en ont plus de 300), en deca des phrases generiques de suite ("The
    // second season of Sousou no Frieren.", 39 car.) qu'AniList sait remplacer
    // par 880 caracteres. L'ancien seuil de 10 ne les reprenait jamais, et elles
    // restaient hors du sitemap.
    const descTexte = String(item.description ?? "").replace(/\[[A-Z]+:[^\]]*\]/g, "").trim();
    const descIsMissing = descTexte.length < 150;
    if (descIsMissing && merged.description) {
      updates.push("description = ?"); params.push(merged.description); fields.push("description");
    }
    const formatIsMissing = !item.format || item.format === "";
    if (formatIsMissing && merged.format) {
      updates.push("format = ?"); params.push(merged.format); fields.push("format");
    }
    // DATE (19 octobre 2026) : AniList fait reference (nouvelleDate, dates-animes.ts)
    const nd = nouvelleDate(item, aniList, animeSchedule, merged);
    if (nd) {
      updates.push("release_date = ?"); params.push(nd.date);
      updates.push("release_precision = ?"); params.push(nd.precision);
      fields.push("date:" + nd.date + "(" + nd.precision + ")");
    }
    if (updates.length > 0) {
      params.push(item.id);
      await conn.query("UPDATE anime_items SET " + updates.join(", ") + " WHERE id = ?", params);
      app.log.info({ id: item.id, fields }, "refetchOne anime enriched");
      return { ok: true, found: true, enriched: true, title: item.title, fields };
    }
    return { ok: true, found: true, enriched: false, title: item.title, fields: [] };
  } catch (e) {
    return { ok: false, found: true, enriched: false, fields: [], error: (e as any)?.message || "erreur" };
  } finally {
    conn.release();
  }
}

export async function adminRefetchHandler(app: FastifyInstance, _req: any, reply: any) {
  const result = await refetchIncompleteCycle(app);
  return reply.send({
    ok: true,
    scanned: result.scanned,
    enriched: result.enriched,
    errors: result.errors,
    changes: result.changes.slice(0, 50),
  });
}
