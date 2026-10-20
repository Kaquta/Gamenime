/**
 * plateformes.ts — Les plateformes des animes, tenues propres pour l'Europe.
 *
 * Trois règles pour les animes (les jeux ne sont jamais touchés) :
 *  1. Seules restent les plateformes de la liste blanche (constants.ts), c'est-à-dire
 *     disponibles en Europe : Muse Asia, Bilibili TV, iQ… sont retirées.
 *  2. Les plateformes VÉRIFIÉES pour la France sont ajoutées, jamais retirées :
 *     - les annonces de la presse gardées par la vérification (annonces_fr : France,
 *       Europe ou monde entier) ;
 *     - TMDB (données JustWatch), au niveau de la saison ou du film seulement (pour
 *       une série entière, rien ne dit que CETTE saison y est), et pour un anime déjà
 *       sorti (TMDB ne voit que ce qui est en ligne : avant la sortie, ce qu'il montre
 *       vient d'une autre saison).
 *  3. Un anime qui n'est pas japonais (pays d'origine lu sur AniList : Chine, Corée,
 *     Taïwan…) n'est montré que s'il est sur une de nos plateformes. n8n ne demande à
 *     AniList que les animes japonais : pour les autres, ce module relit leurs plateformes
 *     sur AniList à chaque passage. Sans aucune de nos plateformes, l'anime est MASQUÉ :
 *     les flux publics (routes.ts) ne le montrent plus, mais il reste en base avec sa
 *     fiche, ses favoris et ses votes, et il réapparaît seul dès qu'une de nos plateformes
 *     arrive (AniList, presse, TMDB ou n8n). Masqué = pays_origine connu et pas « JP »,
 *     et platform vide.
 *
 * Écrit platform, pays_origine et pays_anilist_id, sans toucher updated_at ; les plateformes
 * d'abord, le pays ensuite (un anime ne disparaît jamais un instant avant d'avoir reçu ses
 * plateformes). Un anime qui passe de « aucune plateforme » à une plateforme déclenche la
 * notification « Plateforme ajoutée », comme une mise à jour par n8n (sauf pendant le
 * rattrapage, lancé à la main).
 *
 * Films au cinéma en France (10 octobre 2026) : la date de l'annonce « Cinéma » la plus récente
 * (presse ou Tavily) est écrite dans fr_cinema ; les flux publics en font la date du film sur le
 * site, et le montrent même sans plateforme. Abonnés prévenus : « Au cinéma ».
 *
 * Variables : PLATEFORMES_ENABLED « 1 » pour le passage automatique (toutes les 2 h) ;
 * ANILIST_URL seulement pour les tests.
 */
import { setInterval, setTimeout } from "node:timers";
import { mergePlatforms, sanitizePlatform } from "./core.js";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { planifier } from "./pilotage.js";
import type { Journal, SqlPool } from "./presse.js";

const PREMIER_PASSAGE_MS = 30 * 60 * 1000; // après les premiers passages de la presse (3 min) et de TMDB (10 min)
const PASSAGE_MS = 2 * 60 * 60 * 1000;

/** Ce que la notification « Plateforme ajoutée » reçoit, avant et après. */
export interface Fiche {
  id: number;
  title: string;
  cover: string | null;
  platform: string | null;
}
export type Notifier = (avant: Fiche, apres: Fiche) => Promise<void>;

export interface PlateformesDeps {
  pool: SqlPool;
  log: Journal;
  /** Vide le cache des flux de l'API après écriture. */
  rafraichir?: () => void;
  /** Notification « Plateforme ajoutée » (createNotificationsForItemChange). */
  notifier?: Notifier;
  /** Notification « Au cinéma » (date : AAAA-MM-JJ ; texte : « En France le 8 octobre 2026 »). */
  notifierCinema?: NotifierCinema;
}
export type NotifierCinema = (film: Fiche, date: string, texte: string) => Promise<void>;

export interface Ajout {
  nom: string;
  sources: string[];
}
export interface Changement {
  id: number;
  titre: string;
  title: string;
  cover: string | null;
  popularite: number;
  /** La valeur en base, telle quelle. */
  avant: string | null;
  /** La valeur à écrire. */
  apres: string | null;
  /** Plateformes retirées : hors liste blanche. */
  retirees: string[];
  /** Plateformes ajoutées : vérifiées pour la France, ou lues sur AniList pour un anime non japonais. */
  ajoutees: Ajout[];
}
/** Un anime non japonais, avec ce qu'il montrera après le passage. */
export interface NonJaponais {
  id: number;
  titre: string;
  pays: string;
  popularite: number;
  avant: string | null;
  apres: string | null;
  /** Masqué après le passage (aucune de nos plateformes). */
  masque: boolean;
  /** Masqué avant le passage, d'après la base. */
  masqueAvant: boolean;
}
export interface Bilan {
  animes: number;
  annonces: number;
  tmdbPrecis: number;
  /** TMDB précis pour un anime pas encore sorti : jamais appliqué. */
  tmdbPasSorti: number;
  changements: Changement[];
  /** TMDB pour la série entière : jamais appliqué, montré dans l'essai. */
  serieEntiere: Array<{ id: number; titre: string; popularite: number; plateformes: string[] }>;
  /** Les animes non japonais, masqués ou non. */
  nonJaponais: NonJaponais[];
  /** Nombre d'animes dont le pays d'origine est connu. */
  paysConnus: number;
  /** Nombre d'animes par plateforme, avant et après (les masqués ne comptent pas après). */
  avantParPlateforme: Map<string, number>;
  apresParPlateforme: Map<string, number>;
}

export const morceaux = (v: string | null | undefined): string[] =>
  String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
export const vide = (v: string | null | undefined): boolean => v == null || String(v).trim() === "";
/** Compte chaque plateforme une fois par anime, sous son nom de la liste blanche s'il en a un. */
const compter = (m: Map<string, number>, v: string | null | undefined) => {
  for (const p of new Set(morceaux(v).map((x) => nomDuSite(x) ?? x))) m.set(p, (m.get(p) ?? 0) + 1);
};
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nom de la liste blanche pour un nom de la presse, de TMDB ou d'AniList (« Prime Video » → « Amazon Prime Video »), sinon null. */
export function nomDuSite(n: string): string | null {
  const s = sanitizePlatform(n);
  return s && !s.includes(",") ? s : null;
}
/** Pays connu et différent du Japon ("--" : AniList ne connaît pas l'anime). */
export const nonJaponais = (pays: string | null | undefined): boolean => !!pays && pays !== "JP" && pays !== "--";

// ─────────────────────────────────────────────────────────────── AniList
export interface AnilistConfig {
  url: string;
  pauseMs: number;
  parPassage: number;
}
export function configAnilist(env: Record<string, string | undefined> = process.env): AnilistConfig {
  return { url: env["ANILIST_URL"] || "https://graphql.anilist.co", pauseMs: 1500, parPassage: 500 };
}
export interface MediaAnilist {
  id: number;
  pays: string | null;
  /** Ses plateformes de streaming qui sont dans la liste blanche. */
  plateformes: string[];
}

async function pageAnilist(cfg: AnilistConfig, ids: number[]): Promise<MediaAnilist[]> {
  const query = `query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id countryOfOrigin externalLinks { site type } streamingEpisodes { site } } } }`;
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { ids } }),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) throw new Error("AniList : trop de requêtes (repris au prochain passage)");
  if (!r.ok) throw new Error(`AniList : HTTP ${r.status}`);
  const d: any = await r.json();
  if (!Array.isArray(d?.data?.Page?.media)) throw new Error("AniList : réponse illisible");
  return d.data.Page.media.map((m: any) => {
    const liens = (Array.isArray(m?.externalLinks) ? m.externalLinks : []).filter((l: any) => l?.type === "STREAMING" && l?.site).map((l: any) => String(l.site));
    const episodes = (Array.isArray(m?.streamingEpisodes) ? m.streamingEpisodes : []).map((e: any) => e?.site).filter(Boolean).map(String);
    const pays = typeof m?.countryOfOrigin === "string" && /^[A-Za-z]{2}$/.test(m.countryOfOrigin) ? m.countryOfOrigin.toUpperCase() : null;
    const nos = [...new Set([...liens, ...episodes].map(nomDuSite).filter((x): x is string => !!x))];
    return { id: Number(m?.id), pays, plateformes: nos };
  });
}

/**
 * Lit AniList par paquets de 50, avec une pause entre deux. Rend ce qui a été lu, les
 * identifiants effectivement demandés (un absent de la réponse n'existe pas chez AniList)
 * et la première erreur, après laquelle on s'arrête.
 */
export async function lireAnilist(cfg: AnilistConfig, ids: number[]): Promise<{ media: Map<number, MediaAnilist>; demandes: Set<number>; erreur?: string }> {
  const media = new Map<number, MediaAnilist>();
  const demandes = new Set<number>();
  const uniques = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  for (let i = 0; i < uniques.length; i += 50) {
    if (i) await dormir(cfg.pauseMs);
    const paquet = uniques.slice(i, i + 50);
    try {
      for (const m of await pageAnilist(cfg, paquet)) media.set(m.id, m);
      for (const x of paquet) demandes.add(x);
    } catch (e) {
      return { media, demandes, erreur: (e as Error).message };
    }
  }
  return { media, demandes };
}

/** Ce qu'AniList dit d'un anime : son pays, et ses plateformes de la liste blanche s'il n'est pas japonais. */
export interface InfoAnilist {
  anilist: number;
  pays: string;
  plateformes: string[];
  /** Pays à enregistrer (pas encore en base, ou relu). */
  nouveau: boolean;
}
export interface Infos {
  parAnime: Map<number, InfoAnilist>;
  /** Animes demandés à AniList pour leur pays (jamais lu, inconnu « -- », ou anilist_id changé). */
  aLire: number;
  /** Animes non japonais dont les plateformes ont été relues. */
  relus: number;
  erreur?: string;
}

/**
 * Lit sur AniList le pays des animes qui n'en ont pas (ou dont l'anilist_id a changé, ou
 * inconnus d'AniList), et les plateformes de tous les animes non japonais. N'écrit rien.
 */
export async function infosAnilist(pool: SqlPool, cfg: AnilistConfig): Promise<Infos> {
  const aLire: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, CAST(anilist_id AS UNSIGNED) AS anilist
       FROM anime_items
      WHERE anilist_id IS NOT NULL AND anilist_id > 0
        AND (pays_origine IS NULL OR pays_origine = '--' OR pays_anilist_id IS NULL OR pays_anilist_id <> anilist_id)
      ORDER BY (pays_origine IS NULL) DESC, popularity DESC
      LIMIT ${Math.max(1, Math.min(2000, Math.floor(cfg.parPassage)))}`,
  );
  const aRelire: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, CAST(anilist_id AS UNSIGNED) AS anilist, pays_origine AS pays
       FROM anime_items
      WHERE anilist_id IS NOT NULL AND anilist_id > 0 AND pays_anilist_id = anilist_id
        AND pays_origine IS NOT NULL AND pays_origine NOT IN ('JP', '--')`,
  );
  const infos: Infos = { parAnime: new Map(), aLire: aLire.length, relus: 0 };
  const ids = [...aLire, ...aRelire].map((r) => Number(r.anilist));
  if (!ids.length) return infos;
  const { media, demandes, erreur } = await lireAnilist(cfg, ids);
  infos.erreur = erreur;
  for (const r of aLire) {
    const a = Number(r.anilist);
    if (!demandes.has(a)) continue;
    const m = media.get(a);
    const pays = m?.pays ?? "--";
    infos.parAnime.set(Number(r.id), { anilist: a, pays, plateformes: nonJaponais(pays) ? m?.plateformes ?? [] : [], nouveau: true });
  }
  for (const r of aRelire) {
    const a = Number(r.anilist);
    if (!demandes.has(a)) continue;
    const m = media.get(a);
    // Disparu d'AniList depuis : on garde le pays connu, sans plateformes nouvelles.
    infos.parAnime.set(Number(r.id), { anilist: a, pays: String(r.pays), plateformes: m?.plateformes ?? [], nouveau: false });
    infos.relus++;
  }
  return infos;
}

/** Enregistre les pays lus (seulement si l'anilist_id n'a pas changé entre-temps). */
export async function ecrirePays(pool: SqlPool, infos: Infos): Promise<number> {
  let n = 0;
  for (const [id, i] of infos.parAnime) {
    if (!i.nouveau) continue;
    const r: any = await pool.query(
      `UPDATE anime_items SET pays_origine = ?, pays_anilist_id = ?, updated_at = updated_at
        WHERE id = ? AND anilist_id = ? AND NOT (pays_origine <=> ? AND pays_anilist_id <=> ?)`,
      [i.pays, i.anilist, id, i.anilist, i.pays, i.anilist],
    );
    n += Number(r?.affectedRows) || 0;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────── calcul
/**
 * Ce que chaque anime devrait afficher, et ceux qui seront masqués. Lit la base, n'écrit
 * rien. infos : ce qu'AniList vient de dire (pays et plateformes), prioritaire sur la base.
 * Un animé annulé chez AniList (retiré du site, dates-animes.ts) n'est pas regardé : ni plateforme écrite, ni abonné
 * prévenu (20 octobre 2026). Il revient si AniList le relance.
 */
export async function calculer(pool: SqlPool, infos?: Infos): Promise<Bilan> {
  const rows: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titreAnglais, cover, platform,
            IFNULL(popularity, 0) AS popularite, fr_plateformes AS frPlateformes, fr_niveau AS frNiveau,
            (release_date IS NOT NULL AND release_date <= CURDATE()) AS sorti, pays_origine AS pays
       FROM anime_items
      WHERE IFNULL(statut_anilist, '') <> 'CANCELLED'`,
  );
  const annonces: any[] = await pool.query(
    `SELECT CAST(anime_id AS UNSIGNED) AS id, plateforme, source
       FROM annonces_fr
      WHERE pays IN ('FR', 'EUROPE', 'MONDE')`,
  );
  const parAnime = new Map<number, Array<{ plateforme: string; source: string }>>();
  for (const a of annonces) {
    const id = Number(a.id);
    const l = parAnime.get(id) ?? [];
    l.push({ plateforme: String(a.plateforme ?? ""), source: String(a.source ?? "") });
    parAnime.set(id, l);
  }
  const bilan: Bilan = {
    animes: rows.length,
    annonces: annonces.length,
    tmdbPrecis: 0,
    tmdbPasSorti: 0,
    changements: [],
    serieEntiere: [],
    nonJaponais: [],
    paysConnus: 0,
    avantParPlateforme: new Map(),
    apresParPlateforme: new Map(),
  };
  for (const r of rows) {
    const id = Number(r.id);
    const avant: string | null = r.platform == null ? null : String(r.platform);
    const titre = String(r.titreAnglais || r.title || `#${id}`);
    const popularite = Number(r.popularite) || 0;
    const base = sanitizePlatform(avant);
    const dansBase = new Set(morceaux(base));
    const proposees = new Map<string, Set<string>>();
    const proposer = (n: string, source: string) => {
      const s = nomDuSite(n);
      if (!s) return;
      const x = proposees.get(s) ?? new Set<string>();
      x.add(source);
      proposees.set(s, x);
    };
    for (const a of parAnime.get(id) ?? []) proposer(a.plateforme, `presse : ${a.source}`);
    const niveau = String(r.frNiveau ?? "");
    if (!vide(r.frPlateformes)) {
      if ((niveau === "saison" || niveau === "film") && Number(r.sorti) !== 1) {
        bilan.tmdbPasSorti++;
      } else if (niveau === "saison" || niveau === "film") {
        bilan.tmdbPrecis++;
        for (const n of morceaux(r.frPlateformes)) proposer(n, "TMDB");
      } else {
        const nouvelles = [...new Set(morceaux(r.frPlateformes).map(nomDuSite).filter((x): x is string => !!x))].filter((x) => !dansBase.has(x) && !proposees.has(x));
        if (nouvelles.length) bilan.serieEntiere.push({ id, titre, popularite, plateformes: nouvelles });
      }
    }
    const info = infos?.parAnime.get(id);
    const paysBase: string | null = r.pays ? String(r.pays) : null;
    const pays: string | null = info?.pays ?? paysBase;
    // n8n ne suit sur AniList que les animes japonais : pour les autres, ses plateformes relues ici.
    if (nonJaponais(pays)) for (const n of info?.plateformes ?? []) proposer(n, "AniList");
    const apres = mergePlatforms(base, [...proposees.keys()].join(", "));
    if (pays && pays !== "--") bilan.paysConnus++;
    const masque = nonJaponais(pays) && vide(apres);
    compter(bilan.avantParPlateforme, avant);
    if (!masque) compter(bilan.apresParPlateforme, apres);
    if (nonJaponais(pays)) {
      bilan.nonJaponais.push({ id, titre, pays: pays!, popularite, avant, apres, masque, masqueAvant: nonJaponais(paysBase) && vide(avant) });
    }
    if ((vide(avant) && vide(apres)) || avant === apres) continue;
    bilan.changements.push({
      id,
      titre,
      title: String(r.title ?? titre),
      cover: r.cover ? String(r.cover) : null,
      popularite,
      avant,
      apres,
      retirees: [...new Set(morceaux(avant).filter((p) => !nomDuSite(p)))],
      ajoutees: morceaux(apres)
        .filter((p) => !dansBase.has(p))
        .map((p) => ({ nom: p, sources: [...(proposees.get(p) ?? [])] })),
    });
  }
  const ordre = (a: { popularite: number }, b: { popularite: number }) => b.popularite - a.popularite;
  bilan.changements.sort(ordre);
  bilan.serieEntiere.sort(ordre);
  bilan.nonJaponais.sort(ordre);
  return bilan;
}

// ─────────────────────────────────────────────────────────────── écriture
export interface Ecriture {
  ecrits: Changement[];
  /** Changés en base entre la lecture et l'écriture : repris au passage suivant. */
  entreTemps: number;
  notifies: number;
}

/**
 * Écrit les plateformes. Une ligne modifiée entre-temps (par n8n, par exemple) n'est pas
 * écrasée : elle sera reprise au passage suivant. Sans notifier, aucune notification.
 */
export async function appliquer(deps: PlateformesDeps, bilan: Bilan, notifier: Notifier | null): Promise<Ecriture> {
  const res: Ecriture = { ecrits: [], entreTemps: 0, notifies: 0 };
  for (const c of bilan.changements) {
    const r: any = await deps.pool.query("UPDATE anime_items SET platform = ?, updated_at = updated_at WHERE id = ? AND platform <=> ?", [
      c.apres,
      c.id,
      c.avant,
    ]);
    if (!Number(r?.affectedRows)) {
      res.entreTemps++;
      continue;
    }
    res.ecrits.push(c);
    const propre = sanitizePlatform(c.avant);
    if (notifier && vide(propre) && !vide(c.apres)) {
      try {
        await notifier({ id: c.id, title: c.title, cover: c.cover, platform: propre }, { id: c.id, title: c.title, cover: c.cover, platform: c.apres });
        res.notifies++;
      } catch (e) {
        deps.log.warn({ module: "plateformes", id: c.id, err: (e as Error).message }, "plateformes : notification impossible");
      }
    }
  }
  if (res.ecrits.length) deps.rafraichir?.();
  return res;
}

// ─────────────────────────────────────────────────────────────── cinéma
/** Un film dont la date de sortie au cinéma en France change (première annonce, report, ou plus d'annonce). */
export interface FilmCinema {
  id: number;
  titre: string;
  title: string;
  cover: string | null;
  popularite: number;
  /** fr_cinema en base (AAAA-MM-JJ), ou null. */
  avant: string | null;
  /** La date de l'annonce la plus récente, ou null. */
  apres: string | null;
  /** Le site qui l'a annoncée. */
  source: string | null;
}
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** « 8 octobre 2026 » pour « 2026-10-08 ». */
export function dateFr(iso: string): string {
  const [a, m, j] = iso.split("-").map((x) => parseInt(x, 10));
  return `${j} ${MOIS_FR[(m ?? 1) - 1] ?? ""} ${a}`;
}
const jour = (iso: string) => Date.parse(iso + "T00:00:00Z") / 86400000;
const aujourdhui = () => jour(new Date().toISOString().slice(0, 10));
/**
 * Une date au cinéma en France est une sortie, pas une avant-première de festival : au plus 60 jours avant
 * la sortie au Japon. Une date au mois ou à l'année près (rangée au 1er) compte pour la plus tardive
 * possible : la fin du mois, ou le 31 décembre. Sans date au Japon, la date du cinéma est retenue.
 */
export function cinemaRetenu(d: string, sortie: string | null, precision: string | null): boolean {
  if (!sortie) return true;
  const [a, m] = sortie.split("-").map((x) => parseInt(x, 10));
  const tard = precision === "year" ? `${a}-12-31` : precision === "month" ? new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10) : sortie;
  return jour(d) >= jour(tard) - 60;
}

/**
 * Films au cinéma en France (10 octobre 2026, Rey : « une sortie au cinéma doit être alertée dans
 * Derniers sortis » ; « la plus importante c'est EU, Japon va nous servir à rien la date »). Pour chaque
 * film (format MOVIE), la date de l'annonce « Cinéma » la plus récente (presse ou Tavily ; France, Europe
 * ou monde entier ; avec une date) : un report remplace l'ancienne date. Une date de plus de 60 jours
 * avant la sortie au Japon est ignorée (avant-première de festival, pas une sortie ; voir cinemaRetenu).
 * Un film sans date au Japon (« Date à annoncer », dates-animes.ts) garde sa date au cinéma telle quelle : rien ne
 * distingue alors une sortie d'une avant-première ; un film annulé chez AniList n'est pas regardé (20 octobre 2026).
 * Rend les films dont fr_cinema doit changer. Lit la base, n'écrit rien.
 */
export async function calculerCinema(pool: SqlPool): Promise<FilmCinema[]> {
  const films: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titreAnglais, cover, IFNULL(popularity, 0) AS popularite,
            DATE_FORMAT(release_date, '%Y-%m-%d') AS sortie, release_precision AS prec, DATE_FORMAT(fr_cinema, '%Y-%m-%d') AS avant
       FROM anime_items
      WHERE format = 'MOVIE' AND IFNULL(statut_anilist, '') <> 'CANCELLED'`,
  );
  const annonces: any[] = await pool.query(
    `SELECT CAST(anime_id AS UNSIGNED) AS id, DATE_FORMAT(date_dispo, '%Y-%m-%d') AS d, source
       FROM annonces_fr
      WHERE plateforme = 'Cinéma' AND pays IN ('FR', 'EUROPE', 'MONDE') AND date_dispo IS NOT NULL
      ORDER BY publie_le IS NULL, publie_le DESC, cree_le DESC, id DESC`,
  );
  const parFilm = new Map<number, Array<{ d: string; source: string }>>();
  for (const a of annonces) {
    const l = parFilm.get(Number(a.id)) ?? [];
    l.push({ d: String(a.d), source: String(a.source ?? "") });
    parFilm.set(Number(a.id), l);
  }
  const out: FilmCinema[] = [];
  for (const f of films) {
    const sortie: string | null = f.sortie ? String(f.sortie) : null;
    // sans date au Japon, une avant-première de festival passerait pour la sortie : fr_cinema reste tel quel
    if (!sortie) continue;
    const prec: string | null = f.prec ? String(f.prec) : null;
    const choisie = (parFilm.get(Number(f.id)) ?? []).find((a) => cinemaRetenu(a.d, sortie, prec)) ?? null;
    const avant: string | null = f.avant ? String(f.avant) : null;
    const apres = choisie ? choisie.d : null;
    if (avant === apres) continue;
    out.push({
      id: Number(f.id),
      titre: String(f.titreAnglais || f.title || `#${f.id}`),
      title: String(f.title ?? ""),
      cover: f.cover ? String(f.cover) : null,
      popularite: Number(f.popularite) || 0,
      avant,
      apres,
      source: choisie ? choisie.source : null,
    });
  }
  return out.sort((a, b) => b.popularite - a.popularite);
}

export interface EcritureCinema {
  ecrits: FilmCinema[];
  entreTemps: number;
  notifies: number;
  /** Notification impossible : date remise, reprise au passage suivant. */
  reportes: number;
}
/**
 * Écrit fr_cinema (sans toucher updated_at ; une ligne changée entre-temps est reprise au passage
 * suivant). Abonnés prévenus d'une date nouvelle (première annonce ou report), sauf si elle est passée
 * depuis plus de 30 jours (ce n'est plus une nouvelle). Sans notifier, aucune notification. Une
 * notification qui échoue remet l'ancienne date : le passage suivant écrit et prévient de nouveau.
 */
export async function appliquerCinema(deps: PlateformesDeps, films: FilmCinema[], notifier: NotifierCinema | null): Promise<EcritureCinema> {
  const res: EcritureCinema = { ecrits: [], entreTemps: 0, notifies: 0, reportes: 0 };
  for (const f of films) {
    const r: any = await deps.pool.query("UPDATE anime_items SET fr_cinema = ?, updated_at = updated_at WHERE id = ? AND fr_cinema <=> ?", [f.apres, f.id, f.avant]);
    if (!Number(r?.affectedRows)) {
      res.entreTemps++;
      continue;
    }
    if (notifier && f.apres && aujourdhui() - jour(f.apres) <= 30) {
      try {
        await notifier({ id: f.id, title: f.title, cover: f.cover, platform: null }, f.apres, `En France le ${dateFr(f.apres)}`);
        res.notifies++;
      } catch (e) {
        deps.log.warn({ module: "plateformes", id: f.id, err: (e as Error).message }, "plateformes : notification « Au cinéma » impossible, date reprise au passage suivant");
        await deps.pool.query("UPDATE anime_items SET fr_cinema = ?, updated_at = updated_at WHERE id = ? AND fr_cinema <=> ?", [f.avant, f.id, f.apres]);
        res.reportes++;
        continue;
      }
    }
    res.ecrits.push(f);
  }
  if (res.ecrits.length) deps.rafraichir?.();
  return res;
}

// ─────────────────────────────────────────────────────────────── passage
export interface Passage {
  bilan: Bilan;
  ecriture: Ecriture;
  paysEcrits: number;
  cinema: EcritureCinema;
  erreurAnilist?: string;
}

/** Un passage automatique : AniList, calcul, plateformes, pays, notifications, tableau de bord. */
export async function passagePlateformes(deps: PlateformesDeps, cfg: AnilistConfig = configAnilist()): Promise<Passage> {
  const debut = Date.now();
  const infos = await infosAnilist(deps.pool, cfg);
  const bilan = await calculer(deps.pool, infos);
  const ecriture = await appliquer(deps, bilan, deps.notifier ?? null);
  const paysEcrits = await ecrirePays(deps.pool, infos);
  if (paysEcrits) deps.rafraichir?.();
  const cinema = await appliquerCinema(deps, await calculerCinema(deps.pool), deps.notifierCinema ?? null);
  const ajouts = ecriture.ecrits.filter((c) => c.ajoutees.length);
  const retraits = ecriture.ecrits.filter((c) => c.retirees.length);
  const masques = bilan.nonJaponais.filter((x) => x.masque && !x.masqueAvant);
  const reapparus = bilan.nonJaponais.filter((x) => !x.masque && x.masqueAvant);
  const chiffres = {
    animes: bilan.animes,
    ecrits: ecriture.ecrits.length,
    ajouts: ajouts.length,
    retraits: retraits.length,
    notifies: ecriture.notifies,
    entreTemps: ecriture.entreTemps,
    paysLus: infos.aLire,
    paysEcrits,
    masques: bilan.nonJaponais.filter((x) => x.masque).length,
    cinema: cinema.ecrits.length,
    ...(cinema.reportes ? { cinemaReportes: cinema.reportes } : {}),
    ...(infos.erreur ? { anilist: infos.erreur } : {}),
  };
  trackLastRun("plateformes", chiffres, Date.now() - debut);
  if (ecriture.ecrits.length || ecriture.entreTemps || paysEcrits || cinema.ecrits.length || cinema.entreTemps || cinema.reportes || infos.erreur) {
    deps.log[infos.erreur || cinema.reportes ? "warn" : "info"]({ module: "plateformes", ...chiffres }, "plateformes : passage terminé");
  }
  if (ajouts.length) {
    pushActivity({
      type: "plateformes",
      message: `${ajouts.length} anime${ajouts.length > 1 ? "s" : ""} : plateforme ajoutée (vérifiée pour la France, ou AniList pour un anime non japonais)`,
      detail: ajouts.slice(0, 6).map((c) => `${c.titre} (+ ${c.ajoutees.map((a) => a.nom).join(", ")})`).join(" · ").slice(0, 240),
      level: "info",
    });
  }
  if (retraits.length) {
    pushActivity({
      type: "plateformes",
      message: `${retraits.length} anime${retraits.length > 1 ? "s" : ""} : plateforme hors Europe retirée`,
      detail: retraits.slice(0, 6).map((c) => `${c.titre} (− ${c.retirees.join(", ")})`).join(" · ").slice(0, 240),
      level: "info",
    });
  }
  if (masques.length) {
    pushActivity({
      type: "plateformes",
      message: `${masques.length} anime${masques.length > 1 ? "s" : ""} non japonais sans aucune de nos plateformes : masqué${masques.length > 1 ? "s" : ""} du site`,
      detail: masques.slice(0, 6).map((x) => `${x.titre} (${x.pays})`).join(" · ").slice(0, 240),
      level: "info",
    });
  }
  if (reapparus.length) {
    pushActivity({
      type: "plateformes",
      message: `${reapparus.length} anime${reapparus.length > 1 ? "s" : ""} non japonais de nouveau sur le site (une de nos plateformes)`,
      detail: reapparus.slice(0, 6).map((x) => `${x.titre} (${x.apres})`).join(" · ").slice(0, 240),
      level: "info",
    });
  }
  const auCinema = cinema.ecrits.filter((f) => f.apres);
  if (auCinema.length) {
    pushActivity({
      type: "plateformes",
      message: `${auCinema.length} film${auCinema.length > 1 ? "s" : ""} au cinéma en France (date du site : celle du cinéma)`,
      detail: auCinema.slice(0, 6).map((f) => `${f.titre} (${dateFr(f.apres!)}${f.source ? `, ${f.source}` : ""})`).join(" · ").slice(0, 240),
      level: "info",
    });
  }
  if (cinema.reportes) {
    pushActivity({
      type: "plateformes",
      message: `${cinema.reportes} film${cinema.reportes > 1 ? "s" : ""} au cinéma : notification impossible, date reprise au passage suivant`,
      level: "warn",
    });
  }
  return { bilan, ecriture, paysEcrits, cinema, erreurAnilist: infos.erreur };
}

// ─────────────────────────────────────────────────────────────── cron
let enCours = false;

export function startPlateformesCron(deps: PlateformesDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts) : PLATEFORMES_ENABLED ne sert plus qu'à la première mise en route
  const actifParDefaut = env["PLATEFORMES_ENABLED"] === "1";
  deps.log.info({ module: "plateformes", actifParDefaut }, "plateformes : planifié");
  const cfg = configAnilist(env);
  const tick = async (): Promise<void> => {
    if (enCours) return;
    enCours = true;
    const debut = Date.now();
    try {
      await passagePlateformes(deps, cfg);
    } catch (e) {
      deps.log.error({ module: "plateformes", err: (e as Error).message }, "plateformes : passage interrompu");
      trackLastRun("plateformes", { erreur: (e as Error).message }, Date.now() - debut);
    } finally {
      enCours = false;
    }
  };
  planifier({ id: "plateformes", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "plateformes", actifParDefaut, passage: tick });
}
