/**
 * steam-jeux.ts — Ce que Steam dit des jeux de la fenêtre (14 octobre 2026) : date PC et plateforme PC.
 *
 * Décisions de Rey (13 et 14 octobre, d'après le relevé releve-jeux.sh) :
 *  - Steam apporte la date PC et confirme la plateforme PC ; c'est un enrichissement.
 *  - La date Steam « précise ou avance » celle d'IGDB ; elle ne recule jamais une date au jour (un jeu sort
 *    parfois d'abord sur console), seulement une date floue, mois ou année (un report qu'IGDB n'a pas encore
 *    noté, 14 octobre) ; à un jour près, la date européenne d'IGDB reste (heure de sortie). La règle est dans
 *    igdb-jeux.ts (dateFinale) : seul le passage IGDB écrit la date affichée, à partir de cette table.
 *  - Jamais retenues : la date d'un jeu en accès anticipé (c'est celle de l'accès anticipé, pas de la 1.0) et
 *    une date hors de la fenêtre du site.
 *
 * Toutes les 2 h (35 min après le démarrage la première fois), sous un verrou de la base :
 *  1. identifiants Steam : la page Steam du jeu chez IGDB (external_games ; plusieurs : la plus ancienne, au
 *     titre exact ou à un numéro près, sinon la suivante au passage d'après) ; sinon, avec la clé STEAM_API_KEY, le catalogue Steam
 *     (IStoreService/GetAppList, une fois par jour) au titre exact, s'il n'y en a qu'un, pour les jeux sur PC
 *     (une telle page ne fait que préciser notre date, voir dateFinale « prudent »). Réponse d'IGDB incomplète
 *     (pages pour moitié moins de jeux qu'avant) : rien n'est changé ;
 *  2. pages du magasin (appdetails, sans clé) : au plus 150 par passage, une toutes les 1,6 s (Steam en accepte
 *     environ 200 par 5 min) ; les jamais lues puis les plus anciennes (relues après 22 h), les plus populaires
 *     d'abord ; une page en erreur attend 2 h avant un nouvel essai. 429 ou 403 : une minute d'attente, puis
 *     arrêt jusqu'au passage suivant ;
 *  3. table jeux_steam : statut de la page (ok, absente, pas un jeu, autre titre), date (jour, mois ou année ;
 *     « Coming soon » : aucune), accès anticipé, Windows ;
 *  4. une page valide pour Windows ajoute « PC » aux plateformes s'il manque (updated_at gardé).
 * La clé n'est jamais écrite dans un journal ni dans un message. Interrupteur : STEAM_JEUX_ENABLED « 0 ».
 */
import { setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { planifier, type RetourPassage } from "./pilotage.js";
import { mergePlatforms } from "./core.js";
import { configIgdbJeux, fenetreSite, lireIdsSteam, motsTitre, prendreVerrou, titresProches, type IgdbJeuxDeps } from "./igdb-jeux.js";
import type { Journal } from "./presse.js";

const PREMIER_PASSAGE_MS = 35 * 60 * 1000;
const PASSAGE_MS = 2 * 60 * 60 * 1000;
const VERROU_STEAM = "gamenime_steam_jeux";
const UA = "GameNime/1.0 (https://gamenime.fr)";

export interface SteamJeuxDeps {
  pool: IgdbJeuxDeps["pool"];
  log: Journal;
  /** Vide le cache des flux de l'API (plateforme PC ajoutée). */
  rafraichir?: () => void;
  /** Requêtes IGDB (essais) ; par défaut celles d'igdb-jeux (jeton Twitch partagé). */
  igdb?: IgdbJeuxDeps["igdb"];
  /** fetch des pages Steam (essais) ; par défaut fetch. */
  fetch?: typeof fetch;
  /** Adresses du magasin et de l'API Steam (essais). */
  urlMagasin?: string;
  urlApi?: string;
  /** Clé de l'API Steam ; par défaut STEAM_API_KEY. */
  cle?: string;
}

export interface SteamJeuxConfig {
  pagesMax: number;
  pauseMs: number;
  /** Attente après un 429 ou un 403 avant le seul nouvel essai. */
  attenteMs: number;
  relireApresH: number;
  delaiPageMs: number;
  /** Le catalogue (avec la clé) est relu au plus une fois par période. */
  catalogueH: number;
  pageCatalogue: number;
}

export function configSteamJeux(_env: Record<string, string | undefined> = process.env): SteamJeuxConfig {
  return { pagesMax: 150, pauseMs: 1600, attenteMs: 60000, relireApresH: 22, delaiPageMs: 20000, catalogueH: 24, pageCatalogue: 25000 };
}

export const steamJeuxActif = (env: Record<string, string | undefined> = process.env) => env["STEAM_JEUX_ENABLED"] !== "0";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => String((e as any)?.cause?.code || (e as Error)?.message || e).slice(0, 200);
const aPc = (plateformes: unknown) => /(^|,\s*)PC(\s*,|$)/i.test(String(plateformes ?? ""));

// ── Dates du magasin (texte anglais) : « 18 Feb, 2027 », « Feb 18, 2027 », « Feb 2027 », « Q1 2027 », « 2027 »

const MOIS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const moisDe = (m: string) => {
  const x = String(m).toLowerCase();
  return MOIS[x.slice(0, x.startsWith("sept") ? 4 : 3)] || 0;
};
const p2 = (n: number | string) => String(n).padStart(2, "0");
const jourValide = (a: number, m: number, j: number) => j >= 1 && j <= new Date(Date.UTC(a, m, 0)).getUTCDate();

/** Date du magasin Steam : jour, mois ou année (« Q1 2027 » : l'année) ; null pour « Coming soon », « To be announced »… */
export function dateSteam(texte: unknown): { date: string; precision: "day" | "month" | "year" } | null {
  const t = String(texte ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  let m = t.match(/^(\d{1,2}) ([A-Za-z]+)\.?,? (\d{4})$/);
  if (m && moisDe(m[2]) && jourValide(Number(m[3]), moisDe(m[2]), Number(m[1]))) return { date: `${m[3]}-${p2(moisDe(m[2]))}-${p2(m[1])}`, precision: "day" };
  m = t.match(/^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/);
  if (m && moisDe(m[1]) && jourValide(Number(m[3]), moisDe(m[1]), Number(m[2]))) return { date: `${m[3]}-${p2(moisDe(m[1]))}-${p2(m[2])}`, precision: "day" };
  m = t.match(/^([A-Za-z]+)\.?,? (\d{4})$/);
  if (m && moisDe(m[1])) return { date: `${m[2]}-${p2(moisDe(m[1]))}-01`, precision: "month" };
  m = t.match(/^Q([1-4]),? (\d{4})$/i);
  if (m) return { date: `${m[2]}-01-01`, precision: "year" };
  m = t.match(/^(\d{4})$/);
  if (m) return { date: `${m[1]}-01-01`, precision: "year" };
  return null;
}

// ── Table

const TABLE =
  "CREATE TABLE IF NOT EXISTS jeux_steam (" +
  "game_id INT NOT NULL PRIMARY KEY, " +
  "app_id INT NOT NULL, " +
  "origine VARCHAR(10) NOT NULL, " +
  "statut VARCHAR(12) NULL, " +
  "nom VARCHAR(255) NULL, " +
  "date_texte VARCHAR(40) NULL, " +
  "date_steam DATE NULL, " +
  "precision_steam ENUM('day','month','year') NULL, " +
  "acces_anticipe TINYINT NOT NULL DEFAULT 0, " +
  "windows TINYINT NOT NULL DEFAULT 0, " +
  "lu_le DATETIME NULL, " +
  "essai_le DATETIME NULL, " +
  "KEY app (app_id)" +
  ") CHARACTER SET utf8mb4";

// ── Steam

type Page = { data: any } | { absente: true } | { erreur: string; limite?: boolean };

async function pageSteam(deps: SteamJeuxDeps, cfg: SteamJeuxConfig, appid: number, etat: { lues: number }): Promise<Page> {
  const f = deps.fetch ?? fetch;
  const base = deps.urlMagasin ?? "https://store.steampowered.com";
  for (let essai = 0; essai < 2; essai++) {
    if (etat.lues++) await dormir(cfg.pauseMs);
    let r: Response;
    try {
      r = await f(`${base}/api/appdetails?appids=${appid}&cc=fr&l=english`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(cfg.delaiPageMs) });
    } catch (e) {
      if (essai === 0) continue;
      return { erreur: `injoignable (${message(e)})` };
    }
    if (r.status === 429 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      if (essai === 0) {
        await dormir(cfg.attenteMs);
        continue;
      }
      return { erreur: `Steam limite les lectures (HTTP ${r.status})`, limite: true };
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !d) return { erreur: `HTTP ${r.status}` };
    const e = d[String(appid)];
    if (!e?.success || !e.data) return { absente: true };
    return { data: e.data };
  }
  return { erreur: "sans réponse" };
}

/** Catalogue Steam (avec la clé) : pour chaque titre cherché (mots normalisés), les appid de même titre. */
async function catalogue(deps: SteamJeuxDeps, cfg: SteamJeuxConfig, cle: string, voulus: Set<string>): Promise<{ etat: "lu" | "refuse" | "erreur"; trouves: Map<string, number[]>; detail?: string }> {
  const f = deps.fetch ?? fetch;
  const base = deps.urlApi ?? "https://api.steampowered.com";
  const trouves = new Map<string, number[]>();
  let dernier = 0;
  for (let page = 0; page < 16; page++) {
    if (page) await dormir(1000);
    let r: Response;
    try {
      const u = new URL(`${base}/IStoreService/GetAppList/v1/`);
      u.search = new URLSearchParams({ key: cle, include_games: "true", include_dlc: "false", max_results: String(cfg.pageCatalogue), last_appid: String(dernier) }).toString();
      r = await f(u, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(120000) });
    } catch (e) {
      return { etat: "erreur", trouves, detail: message(e) };
    }
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      return { etat: "refuse", trouves, detail: `HTTP ${r.status}` };
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !d?.response) return { etat: "erreur", trouves, detail: `HTTP ${r.status}` };
    for (const a of Array.isArray(d.response.apps) ? d.response.apps : []) {
      if (!(Number(a?.appid) > 0) || !a?.name) continue;
      const k = motsTitre(a.name).join(" ");
      if (k && voulus.has(k)) trouves.set(k, [...(trouves.get(k) ?? []), Number(a.appid)]);
    }
    const suivant = Number(d.response.last_appid) || 0;
    if (!d.response.have_more_results || suivant <= dernier) break;
    dernier = suivant;
  }
  return { etat: "lu", trouves };
}

// ── Passage

export interface BilanSteam {
  jeux: number;
  avecId: number;
  /** Identifiants trouvés par le catalogue à ce passage. */
  parCatalogue: number;
  /** Lesquels : notre fiche et la page Steam retenue (titre exact, seul de ce titre). */
  trouvesCatalogue: Array<{ id: number; titre: string; appid: number }>;
  catalogue: "lu" | "sans cle" | "refuse" | "erreur" | "pas aujourd'hui" | "rien a chercher";
  lues: number;
  ok: number;
  absentes: number;
  pasUnJeu: number;
  autreTitre: number;
  sansDate: number;
  accesAnticipe: number;
  pcAjoutes: Array<{ id: number; titre: string }>;
  erreurs: number;
  /** Lecture arrêtée : Steam limite les lectures, ou ne répond plus. */
  arret?: string;
  erreur?: string;
  occupe?: boolean;
}

const bilanVide = (): BilanSteam => ({
  jeux: 0, avecId: 0, parCatalogue: 0, trouvesCatalogue: [], catalogue: "pas aujourd'hui", lues: 0, ok: 0, absentes: 0, pasUnJeu: 0, autreTitre: 0, sansDate: 0, accesAnticipe: 0,
  pcAjoutes: [], erreurs: 0,
});

/** Dernière lecture du catalogue (une fois par jour). */
let dernierCatalogue = 0;

/** Un passage Steam, sous son verrou (déjà pris : rien n'est fait, « occupe »). */
export async function passageSteam(deps: SteamJeuxDeps, cfg: SteamJeuxConfig = configSteamJeux(), maintenant: Date = new Date()): Promise<BilanSteam> {
  const liberer = await prendreVerrou(deps.pool, VERROU_STEAM);
  if (!liberer) return { ...bilanVide(), occupe: true };
  try {
    return await passageSousVerrou(deps, cfg, maintenant);
  } finally {
    await liberer();
  }
}

async function passageSousVerrou(deps: SteamJeuxDeps, cfg: SteamJeuxConfig, maintenant: Date): Promise<BilanSteam> {
  const res = bilanVide();
  const q = (sql: string, params?: unknown[]) => deps.pool.query(sql, params);
  try {
    await q(TABLE);
    await q("ALTER TABLE jeux_steam ADD COLUMN IF NOT EXISTS essai_le DATETIME NULL");
    const f = fenetreSite(maintenant);
    // 1. les jeux de la fenêtre et leurs pages Steam chez IGDB
    const jeux: any[] = await q(
      "SELECT id, title, title_english, igdb_id, platform, game_type, popularity FROM game_items WHERE release_date BETWEEN ? AND ?",
      [f.debut, f.fin]
    );
    res.jeux = jeux.length;
    const parId = new Map(jeux.map((j) => [Number(j.id), j]));
    const ids = [...new Set(jeux.map((j) => Number(j.igdb_id)).filter((x) => x > 0))];
    const steamDe = await lireIdsSteam({ pool: deps.pool, log: deps.log, igdb: deps.igdb }, configIgdbJeux(), ids);
    const lignes: any[] = await q("SELECT game_id, app_id, origine, statut, (lu_le IS NULL OR lu_le < NOW() - INTERVAL ? HOUR) AS a_relire FROM jeux_steam", [cfg.relireApresH]);
    const deja = new Map(lignes.map((l) => [Number(l.game_id), l]));
    // réponse d'IGDB incomplète (pages Steam pour moitié moins de jeux qu'au passage précédent) : rien n'est changé
    const avantIgdb = lignes.filter((l) => l.origine === "igdb" && parId.has(Number(l.game_id))).length;
    const maintenantIgdb = jeux.filter((j) => (steamDe.get(Number(j.igdb_id)) ?? []).length > 0).length;
    if (avantIgdb >= 20 && maintenantIgdb < avantIgdb / 2) {
      res.erreur = `réponse IGDB incomplète : pages Steam pour ${maintenantIgdb} jeux (${avantIgdb} au passage précédent)`;
      return res;
    }
    const sansId: any[] = [];
    for (const j of jeux) {
      const id = Number(j.id);
      // plusieurs pages pour un jeu : la plus ancienne d'abord (le jeu ; les suivantes sont souvent prologue, démo,
      // édition) ; si sa page ne convient pas (autre titre, pas un jeu, absente), la suivante quand une relecture
      // est due (22 h) : une page qui ne convient jamais n'est pas relue plus souvent qu'une autre
      const l = deja.get(id);
      const candidats = [...(steamDe.get(Number(j.igdb_id)) ?? [])].sort((a, b) => a - b);
      let appid = candidats[0];
      const actuel = Number(l?.app_id);
      if (l?.origine === "igdb" && candidats.length > 1 && candidats.includes(actuel)) {
        appid = actuel;
        if (Number(l?.a_relire) === 1 && ["autre_titre", "pas_un_jeu", "absente"].includes(String(l?.statut))) appid = candidats[(candidats.indexOf(actuel) + 1) % candidats.length];
      }
      if (appid) {
        // nouvelle page (ou page changée chez IGDB) : à lire
        if (!l || Number(l.app_id) !== appid || l.origine !== "igdb") {
          await q(
            "INSERT INTO jeux_steam (game_id, app_id, origine, statut, lu_le) VALUES (?, ?, 'igdb', NULL, NULL) " +
              "ON DUPLICATE KEY UPDATE app_id = VALUES(app_id), origine = 'igdb', statut = NULL, lu_le = NULL, essai_le = NULL, date_steam = NULL, precision_steam = NULL",
            [id, appid]
          );
        }
      } else if (l?.origine === "igdb") {
        await q("DELETE FROM jeux_steam WHERE game_id = ?", [id]);
        if (aPc(j.platform)) sansId.push(j);
      } else if (!l && aPc(j.platform)) sansId.push(j);
    }
    // jeux sortis de la fenêtre (ou supprimés) : leur ligne part
    for (const l of lignes) if (!parId.has(Number(l.game_id))) await q("DELETE FROM jeux_steam WHERE game_id = ?", [Number(l.game_id)]);

    // 2. le catalogue (avec la clé), une fois par jour, pour les jeux sur PC qu'IGDB ne relie pas à Steam
    const cle = String(deps.cle ?? process.env.STEAM_API_KEY ?? "").trim();
    if (!sansId.length) res.catalogue = "rien a chercher";
    else if (!cle) res.catalogue = "sans cle";
    else if (maintenant.getTime() - dernierCatalogue >= cfg.catalogueH * 3600000) {
      const clesDe = (j: any) => [...new Set([j.title, j.title_english].map((t) => motsTitre(t).join(" ")).filter(Boolean))];
      const cat = await catalogue(deps, cfg, cle, new Set(sansId.flatMap(clesDe)));
      res.catalogue = cat.etat;
      if (cat.etat !== "erreur") dernierCatalogue = maintenant.getTime();
      if (cat.etat === "lu") {
        for (const j of sansId) {
          const appids = [...new Set(clesDe(j).flatMap((k) => cat.trouves.get(k) ?? []))];
          if (appids.length !== 1) continue;
          await q("INSERT INTO jeux_steam (game_id, app_id, origine, statut, lu_le) VALUES (?, ?, 'catalogue', NULL, NULL) ON DUPLICATE KEY UPDATE game_id = game_id", [
            Number(j.id),
            appids[0],
          ]);
          res.parCatalogue++;
          res.trouvesCatalogue.push({ id: Number(j.id), titre: String(j.title ?? ""), appid: appids[0] });
        }
      } else deps.log.warn({ module: "steam-jeux", catalogue: cat.etat, detail: cat.detail }, "Steam : catalogue non lu");
    }

    // 3. les pages à lire : jamais lues, puis lues il y a plus de 22 h ; les plus populaires d'abord
    res.avecId = Number((await q("SELECT COUNT(*) AS n FROM jeux_steam"))[0]?.n ?? 0);
    const aLire: any[] = await q(
      "SELECT s.game_id, s.app_id, s.origine, (s.statut = 'ok' AND s.lu_le >= NOW() - INTERVAL 48 HOUR) AS ok_recent FROM jeux_steam s JOIN game_items g ON g.id = s.game_id " +
        "WHERE (s.lu_le IS NULL OR s.lu_le < NOW() - INTERVAL ? HOUR) AND (s.essai_le IS NULL OR s.essai_le < NOW() - INTERVAL 2 HOUR) " +
        "ORDER BY (s.lu_le IS NULL) DESC, g.popularity DESC, s.game_id LIMIT ?",
      [cfg.relireApresH, cfg.pagesMax]
    );
    const etat = { lues: 0 };
    let erreursDeSuite = 0;
    for (const x of aLire) {
      const j = parId.get(Number(x.game_id));
      if (!j) continue;
      const p = await pageSteam(deps, cfg, Number(x.app_id), etat);
      res.lues++;
      if ("erreur" in p) {
        res.erreurs++;
        if (p.limite) {
          res.arret = p.erreur;
          break;
        }
        // la page attend 2 h avant un nouvel essai : une page toujours en erreur ne bloque pas les autres
        await q("UPDATE jeux_steam SET essai_le = NOW() WHERE game_id = ?", [Number(j.id)]);
        if (++erreursDeSuite >= 10) {
          res.arret = "Steam ne répond plus (10 erreurs de suite)";
          break;
        }
        continue;
      }
      erreursDeSuite = 0;
      if ("absente" in p) {
        res.absentes++;
        // une page valide il y a moins de 48 h qui manque d'un coup : sans doute passager ; ce qu'elle disait reste,
        // nouvel essai dans 2 h (une page qui manque encore 48 h plus tard est notée absente)
        if (Number(x.ok_recent) === 1) await q("UPDATE jeux_steam SET essai_le = NOW() WHERE game_id = ?", [Number(j.id)]);
        else await q("UPDATE jeux_steam SET statut = 'absente', lu_le = NOW(), essai_le = NOW() WHERE game_id = ?", [Number(j.id)]);
        continue;
      }
      const d = p.data;
      const dlc = /dlc/i.test(String(j.game_type ?? ""));
      const titres = [motsTitre(j.title), motsTitre(j.title_english)].filter((m) => m.length);
      const nom = motsTitre(d?.name);
      // titre : proche (comme le rattachement) ; exact ou à un numéro près pour une page choisie parmi plusieurs
      // ou retrouvée par le catalogue
      const strict = x.origine === "catalogue" || (steamDe.get(Number(j.igdb_id)) ?? []).length > 1;
      const degreOk = (t: string[]) => {
        const d = titresProches(t, nom);
        return d > 0 && (!strict || d <= 2);
      };
      let statut = "ok";
      if (d?.type && d.type !== "game" && !(d.type === "dlc" && dlc)) statut = "pas_un_jeu";
      else if (!titres.some(degreOk)) statut = "autre_titre";
      const date = d?.release_date?.coming_soon && !d?.release_date?.date ? null : dateSteam(d?.release_date?.date);
      const ea = Array.isArray(d?.genres) && d.genres.some((g: any) => String(g?.id) === "70" || /early access/i.test(String(g?.description ?? "")));
      const windows = !!d?.platforms?.windows;
      if (statut === "ok") res.ok++;
      else if (statut === "pas_un_jeu") res.pasUnJeu++;
      else res.autreTitre++;
      if (statut === "ok" && !date) res.sansDate++;
      if (statut === "ok" && ea) res.accesAnticipe++;
      await q(
        "UPDATE jeux_steam SET statut = ?, nom = ?, date_texte = ?, date_steam = ?, precision_steam = ?, acces_anticipe = ?, windows = ?, lu_le = NOW(), essai_le = NOW() WHERE game_id = ?",
        [statut, String(d?.name ?? "").slice(0, 255) || null, String(d?.release_date?.date ?? "").slice(0, 40) || null, date?.date ?? null, date?.precision ?? null, ea ? 1 : 0, windows ? 1 : 0, Number(j.id)]
      );
      // 4. la plateforme PC, si Steam la confirme et qu'elle manque
      if (statut === "ok" && windows && !aPc(j.platform)) {
        const plateformes = mergePlatforms(j.platform, "PC");
        if (plateformes && aPc(plateformes)) {
          const u: any = await q("UPDATE game_items SET platform = ?, updated_at = updated_at WHERE id = ? AND (platform <=> ?)", [plateformes, Number(j.id), j.platform ?? null]);
          if (Number(u?.affectedRows ?? 0) > 0) res.pcAjoutes.push({ id: Number(j.id), titre: String(j.title ?? "") });
        }
      }
    }
    if (res.pcAjoutes.length) deps.rafraichir?.();
  } catch (e) {
    res.erreur = message(e);
  }
  return res;
}

// ── Cycle

/** Démarrage : premier passage 35 min après le démarrage, puis toutes les 2 h. */
export function startSteamJeuxCron(deps: SteamJeuxDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts) : STEAM_JEUX_ENABLED ne sert plus qu'à la première mise en route ; arrêté avec les jeux IGDB
  const cfg = configSteamJeux(env);
  deps.log.info({ module: "steam-jeux", catalogue: !!String(env["STEAM_API_KEY"] ?? "").trim(), actifParDefaut: steamJeuxActif(env) }, "Steam : planifié (pages du magasin toutes les 2 h)");
  let enCours = false;
  const tour = async (): Promise<RetourPassage | void> => {
    if (enCours) return;
    enCours = true;
    const debut = Date.now();
    try {
      const b = await passageSteam(deps, cfg);
      if (b.occupe) {
        deps.log.info({ module: "steam-jeux" }, "Steam : un autre passage tient le verrou");
        return { bilan: { occupe: true } };
      }
      trackLastRun("steam-jeux", { ...b, pcAjoutes: b.pcAjoutes.length }, Date.now() - debut);
      const resume = { module: "steam-jeux", lues: b.lues, ok: b.ok, absentes: b.absentes, catalogue: b.catalogue, parCatalogue: b.parCatalogue, pcAjoutes: b.pcAjoutes.length, arret: b.arret };
      if (b.erreur) deps.log.warn({ ...resume, erreur: b.erreur }, "Steam : passage interrompu");
      else deps.log.info(resume, "Steam : passage terminé");
      if (b.erreur || b.arret || b.pcAjoutes.length) {
        pushActivity({
          type: "steam",
          message: b.erreur ? "Steam : passage interrompu" : `Steam : ${b.lues} pages lues`,
          detail: b.erreur ?? b.arret ?? `PC ajouté : ${b.pcAjoutes.slice(0, 5).map((x) => x.titre).join(", ")}`,
          level: b.erreur || b.arret ? "warn" : "info",
        });
      }
    } catch (e) {
      deps.log.error({ module: "steam-jeux", err: message(e) }, "Steam : erreur");
      return { bilan: { erreur: message(e) } };
    } finally {
      enCours = false;
    }
  };
  planifier({
    id: "steam", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "steam-jeux", actifParDefaut: steamJeuxActif(env), dependDe: "igdb-jeux",
    passage: tour,
  });
}

/** Pour les essais : oublie la dernière lecture du catalogue. */
export function oublierCatalogue(): void {
  dernierCatalogue = 0;
}

