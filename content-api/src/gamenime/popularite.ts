/**
 * popularite.ts — Popularité et note des animes : une seule échelle, celle d'AniList.
 *
 * Constat du 12 octobre 2026 (sans-jikan.sh, étape 9) : trois workflows n8n écrivaient la
 * popularité des animes, chacun à son échelle, et le dernier passé gagnait :
 *   - AniList (membres AniList, vers h:00) ;
 *   - AnimeSchedule (suivis AnimeSchedule, à h:45 : environ 100 fois moins) ;
 *   - Jikan (membres MyAnimeList, à h:25 : figés depuis l'arrêt de Jikan).
 * Sur 434 animes, 100 seulement avaient la valeur d'AniList. Le score du Top (logarithme de
 * la popularité + note) mélangeait donc trois échelles : Daemons of the Shadow Realm avait
 * 1 737 au lieu de 141 775.
 *
 * Deux mesures :
 *  1. /anime/bulk (index.ts) : un envoi sans identifiant AniList ne touche plus la
 *     popularité ni la note d'un anime.
 *  2. Ce module : toutes les 3 h (premier passage 25 min après le démarrage), il relit chez
 *     AniList la popularité et la note moyenne de tous les animes qui ont un identifiant
 *     AniList, par paquets de 50 (une requête par paquet, 2,1 s entre deux : moins de 30
 *     requêtes par minute, la limite actuelle d'AniList). Il n'écrit que ce qui change, sans
 *     toucher updated_at, et vide le cache des flux s'il a changé quelque chose.
 *
 * Partage d'AniList : la Phase B (refetch-cron : à +5 min, puis toutes les heures depuis le
 * démarrage), la Phase C (lookup-cron : à +10 min, puis toutes les heures) et le workflow n8n
 * AniList (vers h:00) l'interrogent aussi. Les passages tombent donc 25 min après ces cycles
 * horaires, et un paquet refusé (429) est réessayé une fois après l'attente demandée par
 * AniList (Retry-After, 90 s au plus ; 60 s s'il ne la donne pas).
 *
 * Popularité AniList à 0 (fiche toute neuve) ou note absente (pas assez de votes) : la valeur
 * en base est gardée. Un anime absent de la réponse (fiche supprimée ou fusionnée chez
 * AniList) n'est pas touché. Une ligne modifiée entre la lecture et l'écriture (envoi n8n au
 * même moment) est laissée telle quelle : elle sera revue au passage suivant. Une écriture
 * refusée par la base (verrou, connexion) est comptée et le passage continue ; après 3 refus
 * de suite (base injoignable), il s'arrête.
 *
 * Variables : POPULARITE_ANILIST_ENABLED (« 0 » pour couper ; actif sinon) ;
 * ANILIST_URL seulement pour les tests.
 */
import { setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { planifier } from "./pilotage.js";
import type { Journal, SqlPool } from "./presse.js";

const PREMIER_PASSAGE_MS = 25 * 60 * 1000;
const PASSAGE_MS = 3 * 60 * 60 * 1000;
const PAQUET = 50;

export interface PopulariteDeps {
  pool: SqlPool;
  log: Journal;
  /** Vide le cache des flux de l'API après écriture. */
  rafraichir?: () => void;
}

export interface PopulariteConfig {
  url: string;
  /** Pause entre deux requêtes. */
  pauseMs: number;
  /** Attente avant de réessayer un paquet refusé (429) quand AniList ne donne pas Retry-After. */
  attente429Ms: number;
}

export function configPopularite(env: Record<string, string | undefined> = process.env): PopulariteConfig {
  return { url: env["ANILIST_URL"] || "https://graphql.anilist.co", pauseMs: 2100, attente429Ms: 60000 };
}

/** AniList refuse la requête (429) : trop de requêtes dans la minute. */
export class TropDeRequetes extends Error {
  /** Attente demandée par AniList (Retry-After, bornée à 90 s), ou null. */
  readonly attenteMs: number | null;
  constructor(attenteMs: number | null) {
    super("AniList : trop de requêtes (repris au prochain passage)");
    this.attenteMs = attenteMs;
  }
}

/** Ce qu'AniList dit d'un anime : popularité (0 si inconnue) et note sur 100 (null si absente). */
export interface ValeursAnilist {
  popularite: number;
  note: number | null;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Popularité et note de 50 animes au plus. Lève une erreur sur un 429, une erreur HTTP ou une réponse illisible. */
export async function pagePopularite(cfg: PopulariteConfig, ids: number[]): Promise<Map<number, ValeursAnilist>> {
  const query = "query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id popularity averageScore } } }";
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { ids } }),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) {
    const s = Number(r.headers.get("retry-after"));
    throw new TropDeRequetes(Number.isFinite(s) && s > 0 ? Math.min(s, 90) * 1000 : null);
  }
  if (!r.ok) throw new Error(`AniList : HTTP ${r.status}`);
  const d: any = await r.json().catch(() => null);
  // GraphQL : AniList peut répondre 200 avec une erreur dans le corps et data vide
  if (!Array.isArray(d?.data?.Page?.media)) {
    const msg = d?.errors?.[0]?.message ? ` (${String(d.errors[0].message).slice(0, 80)})` : "";
    throw new Error("AniList : réponse illisible" + msg);
  }
  const valeurs = new Map<number, ValeursAnilist>();
  for (const m of d.data.Page.media) {
    const id = Number(m?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const pop = Number(m?.popularity);
    const note = m?.averageScore == null ? NaN : Number(m.averageScore);
    valeurs.set(id, {
      popularite: Number.isFinite(pop) && pop > 0 ? Math.round(pop) : 0,
      note: Number.isFinite(note) && note > 0 && note <= 100 ? Math.round(note) : null,
    });
  }
  return valeurs;
}

/** Bilan d'un passage. */
export interface PassagePopularite {
  /** Animes en base avec un identifiant AniList. */
  lus: number;
  /** Identifiants AniList demandés (un paquet en erreur n'est pas compté). */
  demandes: number;
  /** Animes absents de la réponse d'AniList (fiche supprimée ou fusionnée). */
  absents: number;
  /** Popularités et notes écrites. */
  popularites: number;
  notes: number;
  /** Lignes que la base a refusé d'écrire (le passage continue). */
  echecs: number;
  /** Erreur qui a arrêté le passage : AniList, ou la base après 3 refus de suite. */
  erreur?: string;
  /** Première erreur de la base à l'écriture. */
  erreurBase?: string;
}

interface Ligne {
  id: number;
  anilist_id: number;
  popularity: number | null;
  rating_score: number | null;
}

const nombre = (v: unknown): number | null => (v == null ? null : Number(v));

/** Un paquet, réessayé une fois après un 429 (attente demandée par AniList). */
async function paquetPopularite(cfg: PopulariteConfig, ids: number[]): Promise<Map<number, ValeursAnilist>> {
  try {
    return await pagePopularite(cfg, ids);
  } catch (e) {
    if (!(e instanceof TropDeRequetes)) throw e;
    await dormir(e.attenteMs ?? cfg.attente429Ms);
    return pagePopularite(cfg, ids);
  }
}

/**
 * Un passage : relit chez AniList la popularité et la note de tous les animes qui ont un
 * identifiant AniList. `releve`, s'il est donné, reçoit les valeurs lues (contrôle après coup).
 */
export async function passagePopularite(
  deps: PopulariteDeps,
  cfg: PopulariteConfig = configPopularite(),
  releve?: Map<number, ValeursAnilist>
): Promise<PassagePopularite> {
  const lignes: Ligne[] = await deps.pool.query(
    "SELECT id, anilist_id, popularity, rating_score FROM anime_items WHERE anilist_id IS NOT NULL AND anilist_id > 0 ORDER BY popularity DESC"
  );
  // un même identifiant AniList peut être porté par deux lignes (doublon pas encore fusionné)
  const parAnilist = new Map<number, Ligne[]>();
  for (const l of lignes) {
    const a = Number(l.anilist_id);
    if (!Number.isInteger(a) || a <= 0) continue;
    const liste = parAnilist.get(a);
    if (liste) liste.push(l);
    else parAnilist.set(a, [l]);
  }
  const ids = [...parAnilist.keys()];
  const res: PassagePopularite = { lus: lignes.length, demandes: 0, absents: 0, popularites: 0, notes: 0, echecs: 0 };
  let refusDeSuite = 0;
  paquets: for (let i = 0; i < ids.length; i += PAQUET) {
    if (i) await dormir(cfg.pauseMs);
    const paquet = ids.slice(i, i + PAQUET);
    let valeurs: Map<number, ValeursAnilist>;
    try {
      valeurs = await paquetPopularite(cfg, paquet);
    } catch (e) {
      res.erreur = (e as Error).message;
      break;
    }
    res.demandes += paquet.length;
    if (releve) for (const [a, v] of valeurs) releve.set(a, v);
    for (const a of paquet) {
      const v = valeurs.get(a);
      if (!v) {
        res.absents += parAnilist.get(a)!.length;
        continue;
      }
      for (const l of parAnilist.get(a)!) {
        const avantPop = nombre(l.popularity);
        const avantNote = nombre(l.rating_score);
        const pop = v.popularite > 0 && v.popularite !== avantPop ? v.popularite : null;
        const note = v.note != null && v.note !== avantNote ? v.note : null;
        if (pop == null && note == null) continue;
        // écrit seulement si la ligne n'a pas changé depuis la lecture ; updated_at reste tel quel
        let r: any;
        try {
          r = await deps.pool.query(
            "UPDATE anime_items SET popularity = IF(? IS NULL, popularity, ?), rating_score = IF(? IS NULL, rating_score, ?), updated_at = updated_at " +
              "WHERE id = ? AND popularity <=> ? AND rating_score <=> ?",
            [pop, pop, note, note, l.id, avantPop, avantNote]
          );
        } catch (e) {
          // erreur du pilote mariadb : code et texte du serveur (sans la requête ni ses valeurs)
          const err = e as { code?: string; text?: string; message?: string };
          const texte = (err.text ? (err.code ? err.code + " : " : "") + err.text : String(err.message ?? e)).slice(0, 160);
          res.echecs++;
          res.erreurBase ??= texte;
          if (++refusDeSuite >= 3) {
            res.erreur = `base : ${texte} (passage arrêté après 3 refus de suite)`;
            break paquets;
          }
          continue;
        }
        refusDeSuite = 0;
        if (Number(r?.affectedRows ?? 0) > 0) {
          if (pop != null) res.popularites++;
          if (note != null) res.notes++;
        }
      }
    }
  }
  if (res.popularites + res.notes > 0) deps.rafraichir?.();
  return res;
}

let enCours = false;

/** Passage automatique toutes les 3 h (premier passage 25 min après le démarrage, puis 3 h après chacun). */
export function startPopulariteCron(deps: PopulariteDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts) : POPULARITE_ANILIST_ENABLED ne sert plus qu'à la première mise en route
  deps.log.info({ module: "popularite" }, "popularité AniList : planifiée (toutes les 3 h)");
  const cfg = configPopularite(env);
  const tick = async (): Promise<void> => {
    if (enCours) return;
    enCours = true;
    const debut = Date.now();
    try {
      const r = await passagePopularite(deps, cfg);
      trackLastRun("popularite-anilist", { ...r }, Date.now() - debut);
      if (r.erreur || r.echecs) deps.log.warn({ module: "popularite", ...r }, r.erreur ? "popularité AniList : passage interrompu" : "popularité AniList : écritures refusées par la base");
      else deps.log.info({ module: "popularite", ...r }, "popularité AniList : passage terminé");
      if (r.popularites + r.notes > 0 || r.erreur || r.echecs) {
        pushActivity({
          type: "popularite",
          message: `Popularité AniList : ${r.popularites} popularité(s) et ${r.notes} note(s) mises à jour`,
          detail:
            `${r.lus} animes lus` +
            (r.absents ? `, ${r.absents} absents d'AniList` : "") +
            (r.echecs ? `, ${r.echecs} refusés par la base (${r.erreurBase})` : "") +
            (r.erreur ? ` · ${r.erreur}` : ""),
          level: r.erreur || r.echecs ? "warn" : "info",
        });
      }
    } catch (e) {
      deps.log.error({ module: "popularite", err: (e as Error).message }, "popularité AniList : erreur");
      trackLastRun("popularite-anilist", { erreur: (e as Error).message }, Date.now() - debut);
    } finally {
      enCours = false;
    }
  };
  // 25 min après les cycles horaires des Phases B et C (comptés depuis le démarrage), qui interrogent aussi AniList
  planifier({
    id: "popularite", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "popularite-anilist",
    actifParDefaut: env["POPULARITE_ANILIST_ENABLED"] !== "0", passage: tick,
  });
}
