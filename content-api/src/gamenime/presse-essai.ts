/**
 * presse-essai.ts — essai à blanc de la disponibilité en France : rien n'est écrit en base.
 *
 * Dans le conteneur content-api :
 *   node dist/gamenime/presse-essai.js                       presse des 3 derniers jours, 6 articles au plus
 *   node dist/gamenime/presse-essai.js jours:7 max:10       fenêtre et nombre d'articles envoyés à Ollama
 *   node dist/gamenime/presse-essai.js url:https://…        un article précis en plus (Gameblog ou LevelUp)
 *   node dist/gamenime/presse-essai.js tmdb:20 max:0        TMDB seul, sur les 20 premiers animes à vérifier
 *
 * Le même code que les crons, en mode essai : les articles déjà lus sont relus,
 * rien n'est noté ni enregistré.
 */
import { pathToFileURL } from "node:url";
import * as mariadb from "mariadb";
import {
  OllamaIndisponible,
  configEssai,
  coupe,
  jjmmaaaa,
  lireArticles,
  passage,
  usage,
  type Traite,
  type Verdict,
} from "./presse.js";
import { CleRefusee, aVerifier, chargerListe, configTmdb, derniereErreur, disponibilite, rattacher } from "./tmdb.js";

export function lireArgs(args: string[]) {
  const o = { jours: 3, max: 6, urls: [] as string[], tmdb: 0 };
  for (const a of args) {
    const m = /^(jours|max|url|tmdb):(.+)$/.exec(a.trim());
    if (!m) throw new Error(`argument incompris : « ${a} »`);
    if (m[1] === "url") o.urls.push(m[2]!);
    else {
      const n = parseInt(m[2]!, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`argument incompris : « ${a} »`);
      if (m[1] === "jours") o.jours = Math.max(1, Math.min(30, n));
      if (m[1] === "max") o.max = Math.min(40, n);
      if (m[1] === "tmdb") o.tmdb = Math.min(300, n);
    }
  }
  return o;
}

const journal = {
  info: (_o: object, _m?: string) => {},
  warn: (o: object, m?: string) => console.log(`  (avertissement) ${m ?? ""} ${JSON.stringify(o)}`),
  error: (o: object, m?: string) => console.log(`  (erreur) ${m ?? ""} ${JSON.stringify(o)}`),
};

function ligneVerdict(v: Verdict, d: string): string {
  if (v.statut === "rejete") return `   ✗ ${d} : rejeté, ${v.raison}`;
  const quand = [v.date ? jjmmaaaa(v.date) : null, v.heure].filter(Boolean).join(" ") || "sans date";
  const notes = v.notes.length ? ` [${v.notes.join(" ; ")}]` : "";
  const site = v.plateforme!.site ? "" : " (hors plateformes du site)";
  const etiquette = v.statut === "garde" ? "✓" : "·";
  const ligne = `   ${etiquette} ${v.plateforme!.nom} · ${v.pays || "?"} · ${quand} · ${v.anime!.titleEnglish || v.anime!.title}${site}${v.statut === "hors_france" ? " — hors France" : ""}${notes}`;
  return v.statut === "garde" && v.phrase ? `${ligne}\n       « ${coupe(v.phrase, 150)} »` : ligne;
}

function afficher(t: Traite, n: number, total: number): void {
  const a = t.article;
  console.log("");
  console.log(`── ARTICLE ${n}/${total} · ${a.source} · ${jjmmaaaa(a.publie)} · « ${coupe(a.titre, 110)} »`);
  console.log(`   ${a.url}`);
  console.log(`   animes reconnus : ${t.cites.map((c) => `${c.it.titleEnglish || c.it.title} (${c.complet ? "titre complet" : "titre partiel : " + c.forme})`).join(" ; ")}`);
  if (t.ms) console.log(`   Ollama : ${Math.round(t.ms / 1000)} s (lu ${t.lus} jetons, écrit ${t.ecrits}) ; extrait envoyé : ${t.extraitLongueur} caractères`);
  if (t.erreur) {
    console.log(`   ✗ ${t.erreur}`);
    return;
  }
  if (!t.verdicts.length) console.log("   (aucune diffusion annoncée selon Ollama)");
  for (const v of t.verdicts) console.log(ligneVerdict(v, v.demande));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let o: ReturnType<typeof lireArgs>;
  try {
    o = lireArgs(args);
  } catch (e) {
    console.log((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const env = process.env;
  if (!env["DB_HOST"] || !env["DB_USER"] || !env["DB_NAME"]) {
    console.log("ARRÊT : variables de base absentes (DB_HOST, DB_USER, DB_NAME) : lancer dans le conteneur content-api.");
    process.exitCode = 2;
    return;
  }
  const pool = mariadb.createPool({ host: env["DB_HOST"], user: env["DB_USER"], password: env["DB_PASS"], database: env["DB_NAME"], connectionLimit: 2 });
  const debut = Date.now();
  try {
    const cfg = { ...configEssai(env), jours: o.jours };
    console.log(`ESSAI DISPONIBILITÉ FRANCE — à blanc, rien n'est écrit — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
    if (o.max > 0) {
      console.log(`Presse : Gameblog (${o.jours} derniers jours), LevelUp, ADN News, Crunchyroll News, AnimOtaku, Manga-News, ANN (flux RSS) ; ${cfg.modele}, ${cfg.coeurs} cœurs ; au plus ${o.max} articles envoyés`);
      const imposes = o.urls.length ? await lireArticles(o.urls, cfg) : { articles: [], erreurs: [] };
      let r;
      try {
        r = await passage({ pool, log: journal }, cfg, { essai: true, max: o.max, imposes: imposes.articles, suivi: afficher });
      } catch (e) {
        if (e instanceof OllamaIndisponible) {
          console.log(`ARRÊT : ${e.message}`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      const l = r.lecture;
      console.log("");
      console.log(`Gameblog : ${l.gameblogFenetre} articles, ${l.gameblogAdresse} retenus d'après l'adresse, ${l.gameblogLus} pages lues · LevelUp : ${l.levelupFlux} articles dans les flux`);
      for (const [nom, x] of Object.entries(l.sources)) {
        console.log(`${nom} : ${x.flux} articles dans le flux, ${x.nouveaux} récents, ${x.pertinents} citent un anime du site, ${x.pages} pages ouvertes`);
      }
      console.log(`Articles qui citent franchement un anime du site et une plateforme : ${r.retenus} ; envoyés à Ollama : ${r.envoyes}`);
      if (r.arret) console.log(`Arrêt : ${r.arret}`);
      // Bilan : ce qui serait enregistré pour la France.
      const bilan = new Map<number, { titre: string; site: string; lignes: Map<string, { date: string | null; heure: string | null; sources: Set<string> }> }>();
      for (const t of r.traites) {
        for (const v of t.verdicts) {
          if (v.statut !== "garde") continue;
          const b = bilan.get(v.anime!.id) ?? { titre: v.anime!.titleEnglish || v.anime!.title, site: v.anime!.platform || "aucune plateforme", lignes: new Map() };
          const x = b.lignes.get(v.plateforme!.nom) ?? { date: null, heure: null, sources: new Set<string>() };
          x.sources.add(t.article.source);
          x.date = x.date ?? v.date;
          x.heure = x.heure ?? v.heure;
          b.lignes.set(v.plateforme!.nom, x);
          bilan.set(v.anime!.id, b);
        }
      }
      console.log("");
      console.log("══ BILAN : annonces qui seraient enregistrées pour la France");
      if (!bilan.size) console.log("   rien");
      for (const [id, b] of bilan) {
        console.log(`   ${b.titre} (#${id}) — le site affiche : ${b.site}`);
        for (const [nom, x] of b.lignes) console.log(`     ${nom} : ${[x.date ? jjmmaaaa(x.date) : "date non annoncée", x.heure].filter(Boolean).join(" ")} (${[...x.sources].join(", ")})`);
      }
      const moy = usage.appels ? Math.round(usage.ms / usage.appels / 1000) : 0;
      console.log(`Ollama : ${usage.appels} appels, ${Math.round(usage.ms / 1000)} s, ${moy} s par article (premier : ${Math.round(usage.premier / 1000)} s) ; ${usage.lus} jetons lus, ${usage.ecrits} écrits`);
      const erreurs = [...imposes.erreurs, ...l.erreurs];
      if (erreurs.length) {
        console.log(`Erreurs de lecture (${erreurs.length}) :`);
        for (const e of erreurs.slice(0, 8)) console.log(`   ${coupe(e, 150)}`);
      }
    }
    if (o.tmdb > 0) {
      const tc = configTmdb(env);
      console.log("");
      console.log(`══ TMDB : ${o.tmdb} animes à vérifier (les plus proches de leur sortie d'abord)`);
      if (!tc.cle) {
        console.log("   TMDB_API_KEY absente du conteneur : TMDB non essayé.");
      } else {
        const parAnilist = await chargerListe(tc);
        console.log(`   liste AniList -> TMDB : ${parAnilist.size} animes`);
        const items = await aVerifier(pool, o.tmdb);
        let relies = 0, enFrance = 0;
        try {
          for (const it of items) {
            // Comme le cron : la liste AniList -> TMDB d'abord, sinon le lien déjà enregistré, sinon IMDb ou le titre.
            const e = it.anilistId ? parAnilist.get(it.anilistId) : undefined;
            const enregistre = it.tmdbId && it.tmdbType ? { type: it.tmdbType, id: it.tmdbId, saison: it.tmdbSaison, via: (it.tmdbLien || "liste") as "liste" } : null;
            const l = (enregistre && !(e && (e.tv || e.movie)) ? enregistre : await rattacher(tc, it, parAnilist)) ?? enregistre;
            const titre = coupe(it.titreAnglais || it.titre, 55);
            if (!l) {
              console.log(`   ${titre} (#${it.id}) : pas de fiche TMDB`);
              continue;
            }
            relies++;
            const d = await disponibilite(tc, l);
            if (d === "absente") {
              console.log(`   ${titre} (#${it.id}) : fiche TMDB ${l.type} ${l.id} introuvable (404)`);
              continue;
            }
            if (!d) {
              console.log(`   ${titre} (#${it.id}) : TMDB ${l.type} ${l.id} ne répond pas (${derniereErreur || "?"})`);
              continue;
            }
            if (d.plateformes.length) enFrance++;
            const fiche = `${l.type === "tv" ? "série" : "film"} ${l.id}${l.saison ? ` saison ${l.saison}` : ""} (${l.via})`;
            const fr = d.plateformes.length ? `${d.plateformes.join(", ")}${d.niveau === "serie" ? " (série entière)" : ""}` : "rien";
            const films = [d.cinema ? `cinéma ${jjmmaaaa(d.cinema)}` : "", d.vod ? `VOD ${jjmmaaaa(d.vod)}` : ""].filter(Boolean).join(", ");
            console.log(`   ${titre} (#${it.id}) : ${fiche} → France : ${fr}${films ? " ; " + films : ""}`);
          }
        } catch (e) {
          if (e instanceof CleRefusee) console.log(`   ARRÊT : ${e.message}, vérifier TMDB_API_KEY dans /opt/stack/.env`);
          else throw e;
        }
        console.log(`   bilan TMDB : ${relies} reliés sur ${items.length}, ${enFrance} disponibles en France`);
      }
    }
    const s = Math.round((Date.now() - debut) / 1000);
    console.log(`Durée : ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s. Rien n'a été écrit.`);
  } finally {
    await pool.end();
  }
}

// Lancé directement (pas importé par un test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
