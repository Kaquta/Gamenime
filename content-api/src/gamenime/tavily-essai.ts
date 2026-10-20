/**
 * tavily-essai.ts — Essai du module Tavily. N'écrit jamais rien en base.
 *
 * Dans le conteneur content-api :
 *   node dist/gamenime/tavily-essai.js                clé, sites, file d'attente (aucun crédit)
 *   node dist/gamenime/tavily-essai.js cle            la clé et le forfait (GET /usage, aucun crédit)
 *   node dist/gamenime/tavily-essai.js domaines       robots.txt des sites de confiance (aucun crédit)
 *   node dist/gamenime/tavily-essai.js cibles         la file d'attente et les prochaines recherches (aucun crédit)
 *   node dist/gamenime/tavily-essai.js chercher:3     3 VRAIES recherches (3 crédits) sur les premiers de la file,
 *                                                     pages lues, Ollama et vérification : ce qui serait gardé ; une
 *                                                     page sans texte (Crunchyroll News) est lue par Tavily Extract :
 *                                                     2 crédits de plus au plus par recherche (9 au plus en tout, dans
 *                                                     le forfait ; un essai ne note rien : il repaie ses pages)
 *   node dist/gamenime/tavily-essai.js anime:465      une vraie recherche (1 crédit, 3 au plus avec Tavily Extract)
 */
import { pathToFileURL } from "node:url";
import * as mariadb from "mariadb";
import { coupe, jjmmaaaa, robotsAutorise, usage } from "./presse.js";
import { budget, configEssai, fileAttente, lireForfait, passage, requete, TavilyErreur, type Cible, type Traitement } from "./tavily.js";

const pluriel = (n: number, mot: string, motPluriel = mot + "s") => `${n.toLocaleString("fr-FR")} ${n > 1 ? motPluriel : mot}`;
const titre = (c: Cible) => `${coupe(c.anime.titleEnglish || c.anime.title, 60)} (#${c.anime.id})`;
const MOTIFS: Record<string, string> = { j7: "J-7", sorti: "sorti", avenir: "à venir", cinema: "au cinéma" };
const quand = (c: Cible) => {
  if (!c.sortie) return "";
  const p = c.precision === "day" ? jjmmaaaa(c.sortie) : c.precision === "month" ? `${c.sortie.slice(5, 7)}/${c.sortie.slice(0, 4)}` : c.sortie.slice(0, 4);
  return c.motif === "sorti" ? `sorti le ${p}` : `sortie ${c.precision === "day" ? "le " : ""}${p}`;
};
const ETATS: Record<string, string> = {
  annonces: "lue par Ollama", sans_annonce: "lue par Ollama, rien de gardé", deja_lu: "déjà lue pour cet anime", interdit: "interdite",
  erreur: "erreur", hors_sujet: "écartée", non_envoye: "non envoyée à Ollama", illisible: "illisible", lu: "lue",
};

function afficherTraitement(t: Traitement, n: number): void {
  const c = t.cible;
  console.log("");
  console.log(` ${n}. [${c.motif ? MOTIFS[c.motif] : "demandé"}] ${titre(c)} · ${quand(c)}${c.manque.length ? ` · manque : ${c.manque.join(" et ")}` : ""}`);
  if (t.recherche) {
    console.log(`    « ${t.recherche.requete} »`);
    console.log(`    ${pluriel(t.recherche.resultats.length, "résultat")} en ${(t.recherche.ms / 1000).toFixed(1).replace(".", ",")} s, ${pluriel(t.recherche.credits, "crédit")} ; ${pluriel(t.retenus.length, "page retenue", "pages retenues")} (site de confiance qui nomme l'anime)`);
    const ecartes = t.recherche.resultats.filter((r) => !t.retenus.some((x) => x.url === r.url));
    for (const r of ecartes.slice(0, 3)) console.log(`      (non retenu) ${coupe(r.url, 110)}`);
    if (ecartes.length > 3) console.log(`      (non retenus) … et ${ecartes.length - 3} autres`);
  }
  if (t.extract) console.log(`    Tavily Extract : ${pluriel(t.extract.pages, "page sans texte", "pages sans texte")} demandée${t.extract.pages > 1 ? "s" : ""}, ${t.extract.lues} lue${t.extract.lues > 1 ? "s" : ""} ; ${pluriel(t.extract.credits, "crédit")} (Tavily compte 2 crédits par lot de 5 pages lues)${t.extract.note ? ` — ${t.extract.note}` : ""}`);
  for (const p of t.pages) {
    console.log(`    · ${p.source}${p.publie ? ` · ${jjmmaaaa(p.publie)}` : ""} · ${ETATS[p.etat] ?? p.etat}${p.note ? ` : ${p.note}` : ""}${p.ms ? ` (${Math.round(p.ms / 1000)} s)` : ""}`);
    console.log(`      ${coupe(p.url, 130)}`);
    if (p.lecture) console.log(`      (${p.lecture})`);
    for (const v of p.verdicts.slice(0, 6)) {
      const etat = v.statut === "garde" ? "GARDÉE " : v.statut === "hors_france" ? "hors France" : "rejetée";
      const quoi = [v.plateforme?.nom ?? "?", v.pays || "", v.date ? jjmmaaaa(v.date) : "", v.heure ?? ""].filter(Boolean).join(" · ");
      console.log(`        ${etat} ${v.anime ? coupe(v.anime.titleEnglish || v.anime.title, 40) : v.demande} · ${quoi}${v.statut === "rejete" ? ` — ${v.raison}` : v.phrase ? ` — « ${coupe(v.phrase, 110)} »` : ""}`);
      for (const note of v.notes.slice(0, 2)) console.log(`            (${note})`);
    }
    if (p.verdicts.length > 6) console.log(`        … et ${p.verdicts.length - 6} autres réponses d'Ollama`);
  }
  if (t.arret) console.log(`    ARRÊT : ${t.arret}`);
  else if (t.trouve.length) console.log(`    → TROUVÉ : ${t.trouve.join(", ")} (le module plateformes l'ajouterait à son passage suivant)`);
  else console.log("    → rien de vérifié pour cet anime");
  const autres = t.gardees.filter((v) => v.anime?.id !== c.anime.id);
  if (autres.length) console.log(`    (+ ${pluriel(autres.length, "annonce gardée", "annonces gardées")} pour d'autres animes cités : ${[...new Set(autres.map((v) => v.anime!.titleEnglish || v.anime!.title))].map((x) => coupe(x, 40)).join(", ")})`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const env = process.env;
  const connus = /^(cle|domaines|cibles|chercher(:[1-5])?|anime:\d+(,\d+)*)$/;
  const inconnu = args.find((a) => !connus.test(a));
  if (inconnu) {
    console.log(`argument incompris : « ${inconnu} » (connus : cle, domaines, cibles, chercher:N avec N de 1 à 5, anime:ID)`);
    process.exitCode = 2;
    return;
  }
  const cfg = configEssai(env);
  const chercherN = args.map((a) => /^chercher(?::(\d+))?$/.exec(a)).find(Boolean);
  const ids = [...new Set(args.flatMap((a) => (/^anime:/.test(a) ? a.slice(6).split(",").map(Number) : [])).filter((x) => x > 0))];
  if (ids.length > 5) {
    console.log("ARRÊT : 5 animes au plus par essai (chacun coûte un crédit, trois au plus avec Tavily Extract).");
    process.exitCode = 2;
    return;
  }
  const payant = !!chercherN || ids.length > 0;
  const tout = !args.length;
  const veut = (x: string) => tout || args.includes(x);
  if (!env["DB_HOST"] || !env["DB_USER"] || !env["DB_NAME"]) {
    console.log("ARRÊT : variables de base absentes (DB_HOST, DB_USER, DB_NAME) : lancer dans le conteneur content-api.");
    process.exitCode = 2;
    return;
  }
  const pool = mariadb.createPool({ host: env["DB_HOST"], user: env["DB_USER"], password: env["DB_PASS"], database: env["DB_NAME"], connectionLimit: 2 });
  try {
    const maintenant = new Date().toISOString().slice(0, 16).replace("T", " ");
    console.log(`TAVILY — essai — ${maintenant} UTC — rien n'est écrit en base${payant ? "" : " ; aucune recherche, aucun crédit"}`);
    console.log(`Module : ${env["TAVILY_ENABLED"] === "1" ? "allumé" : "éteint"} (TAVILY_ENABLED) ; ${cfg.maxParJour} recherches par jour et ${cfg.maxParMois} par mois au plus, ${cfg.maxParPassage} par passage (toutes les 2 h)`);
    // Clé et forfait.
    if (veut("cle") || payant) {
      if (!cfg.cle) {
        console.log("Clé : ABSENTE (TAVILY_API_KEY vide dans le conteneur)");
        if (payant) {
          process.exitCode = 1;
          return;
        }
      } else {
        try {
          const f = await lireForfait(cfg);
          console.log(`Clé : acceptée par Tavily — forfait « ${f.plan} » : ${pluriel(f.utilise, "crédit utilisé", "crédits utilisés")}${f.limite !== null ? ` sur ${f.limite.toLocaleString("fr-FR")}` : ""}${f.restant !== null ? ` (${f.restant.toLocaleString("fr-FR")} restants)` : ""}`);
        } catch (e) {
          console.log(`Clé : ${e instanceof TavilyErreur && e.portee === "cle" ? "REFUSÉE" : "non vérifiée"} — ${(e as Error).message}`);
          if (e instanceof TavilyErreur && e.portee === "cle") {
            process.exitCode = 1;
            return;
          }
        }
      }
      const b = await budget(pool, cfg, "jamais");
      console.log(`Dépensé par le module : ${pluriel(b.jour, "crédit")} aujourd'hui, ${pluriel(b.mois, "crédit")} ce mois-ci`);
    }
    // Sites de confiance : robots.txt.
    if (veut("domaines")) {
      console.log("");
      console.log(`══ SITES DE CONFIANCE : ${cfg.domaines.length} (robots.txt lu pour GameNimeBot, aucun crédit)`);
      const ok: string[] = [], non: string[] = [], illisibles: string[] = [];
      for (const d of cfg.domaines) {
        const r = await robotsAutorise(`https://${d.domaine}/`);
        if (r.ok) ok.push(`${d.nom}${r.delaiMs ? ` (une page toutes les ${Math.round(r.delaiMs / 1000)} s)` : ""}`);
        else if (r.raison === "robots.txt illisible") illisibles.push(d.nom);
        else non.push(d.nom);
      }
      console.log(`   lisibles (${ok.length}) : ${ok.join(", ") || "aucun"}`);
      if (non.length) console.log(`   interdits à GameNimeBot (${non.length}) : ${non.join(", ")} — leurs pages ne seront jamais lues`);
      if (illisibles.length) console.log(`   robots.txt illisible (${illisibles.length}) : ${illisibles.join(", ")} — leurs pages sont sautées tant qu'il l'est`);
      console.log("   (chaque page est revérifiée avant d'être lue)");
    }
    // File d'attente.
    if (veut("cibles")) {
      const f = await fileAttente(pool);
      const n = (m: string) => f.cibles.filter((c) => c.motif === m).length;
      const ab = f.cibles.filter((c) => c.abandonne).length;
      console.log("");
      console.log(`══ ANIMES INCOMPLETS : ${f.cibles.length} sur ${f.catalogue.length} (J-7 : ${n("j7")} · sortis sans plateforme : ${n("sorti")}${ab ? `, dont ${ab} abandonné${ab > 1 ? "s" : ""}` : ""} · à venir sans plateforme : ${n("avenir")}${n("cinema") ? ` · films au cinéma, plateforme cherchée chaque mois : ${n("cinema")}` : ""})`);
      const j7 = f.cibles.filter((c) => c.motif === "j7");
      if (j7.length) {
        console.log("   J-7 (en premier : chaque jour si la date est connue au jour près, chaque semaine si elle ne l'est qu'au mois) :");
        for (const c of j7) console.log(`     ${titre(c)} · ${quand(c)} · manque : ${c.manque.join(" et ")} · ${c.raison}`);
      }
      console.log(`   Recherches dues maintenant : ${f.dues.length} ; les 25 premières, dans l'ordre (J-7, puis popularité) :`);
      f.dues.slice(0, 25).forEach((c, k) => console.log(`     ${String(k + 1).padStart(2)}. [${MOTIFS[c.motif!]}] ${titre(c)} · ${quand(c)} · ${c.raison}`));
      if (f.dues.length > 25) console.log(`     … et ${f.dues.length - 25} autres (les jours suivants)`);
      // Rythme de croisière : une fois les premières recherches faites.
      let parJour = 0;
      for (const c of f.cibles) {
        if (c.abandonne) continue;
        if (c.motif === "j7") parJour += c.precision === "day" ? 1 : 1 / 7;
        else if (c.motif === "avenir") parJour += (c.precision === "day" || c.precision === "month") && c.jours <= 60 ? 1 / 7 : 1 / 30;
        else if ((c.joursDepuisSortie ?? 0) < 90) parJour += (c.joursDepuisSortie ?? 0) < 30 ? 1 / 7 : 1 / 30;
      }
      const jamais = f.cibles.filter((c) => c.recherches === 0 && !c.abandonne).length;
      console.log(`   Première recherche de chacun : ${pluriel(jamais, "anime")} (${Math.ceil(jamais / Math.max(1, cfg.maxParJour))} jour${jamais > cfg.maxParJour ? "s" : ""} au plafond de ${cfg.maxParJour}) ; ensuite, environ ${Math.round(parJour)} recherche${Math.round(parJour) > 1 ? "s" : ""} par jour (≈ ${Math.round(parJour * 30)} crédits par mois, avant les nouveaux animes)`);
    }
    // Recherches réelles.
    if (payant) {
      const max = ids.length ? ids.length : Math.max(1, Math.min(5, parseInt(chercherN?.[1] ?? "3", 10)));
      console.log("");
      console.log(`══ RECHERCHES RÉELLES : ${ids.length ? `animes ${ids.join(", ")}` : `les ${max} premières de la file`} — ${pluriel(max, "crédit")} de recherche au plus, plus 2 au plus par recherche pour Tavily Extract (pages sans texte : ${max * 3} crédits au plus en tout, dans le forfait) ; pages lues par GameNime API, Ollama, vérification`);
      const debut = Date.now();
      const r = await passage(pool, cfg, {
        essai: true,
        max,
        ids: ids.length ? ids : undefined,
        suivi: (t, k) => afficherTraitement(t, k),
      });
      if (r.arret) console.log(`\nARRÊT : ${r.arret}`);
      if (!r.recherches.length && !r.arret) console.log(r.budget?.limite ? `   aucune recherche : ${r.budget.limite}` : "   aucune recherche à faire");
      // Pages par site : un site dont les pages sont toutes « illisibles » coûte des crédits pour rien.
      const parSite = new Map<string, Map<string, number>>();
      for (const t of r.recherches) for (const p of t.pages) {
        const m = parSite.get(p.source) ?? new Map<string, number>();
        const e = p.etat === "illisible" && /pas de texte/.test(p.note) ? "sans texte lisible" : ETATS[p.etat] ?? p.etat;
        m.set(e, (m.get(e) ?? 0) + 1);
        parSite.set(p.source, m);
      }
      if (parSite.size) {
        console.log("");
        console.log("══ PAGES PAR SITE");
        for (const [site, m] of parSite) console.log(`   ${site} : ${[...m].map(([e, k]) => `${k} ${e}`).join(", ")}`);
      }
      const trouves = r.recherches.filter((t) => t.trouve.length).length;
      const lus = r.recherches.reduce((s, t) => s + t.ollama, 0);
      console.log("");
      console.log(
        `══ BILAN : ${pluriel(r.credits, "crédit dépensé", "crédits dépensés")} ; ${trouves} anime${trouves > 1 ? "s" : ""} trouvé${trouves > 1 ? "s" : ""} sur ${r.recherches.length} ; ` +
          `${pluriel(lus, "article lu", "articles lus")} par Ollama (${Math.round(usage.ms / 1000)} s) ; ${Math.round((Date.now() - debut) / 1000)} s en tout. Rien n'a été écrit en base.`,
      );
    }
  } finally {
    await pool.end();
  }
}

// Lancé directement (pas importé par un test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
