/**
 * plateformes-essai.ts — Ce que la mise au propre des plateformes des animes change.
 *
 * Dans le conteneur content-api :
 *   node dist/gamenime/plateformes-essai.js             à blanc : rien n'est écrit
 *   node dist/gamenime/plateformes-essai.js rattrapage  écrit (aucune notification) ; lancé par
 *                                                       activer-plateformes.sh après sa copie de la table
 *
 * Le même calcul que le passage automatique (plateformes.ts). À blanc, AniList est lu
 * (pays d'origine, plateformes des animes non japonais) sans que rien ne soit enregistré.
 */
import { pathToFileURL } from "node:url";
import * as mariadb from "mariadb";
import { VALID_PLATFORMS } from "./constants.js";
import { appliquer, calculer, calculerCinema, configAnilist, dateFr, ecrirePays, infosAnilist, morceaux, nomDuSite, vide } from "./plateformes.js";

const journal = {
  info: (_o: object, _m?: string) => {},
  warn: (o: object, m?: string) => console.log(`  (avertissement) ${m ?? ""} ${JSON.stringify(o)}`),
  error: (o: object, m?: string) => console.log(`  (erreur) ${m ?? ""} ${JSON.stringify(o)}`),
};
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const fiche = (c: { titre: string; id: number }) => `${c.titre.length > 70 ? c.titre.slice(0, 69) + "…" : c.titre} (#${c.id})`;
const PAYS: Record<string, string> = { CN: "Chine", KR: "Corée du Sud", TW: "Taïwan", HK: "Hong Kong", JP: "Japon" };
const nomPays = (p: string) => PAYS[p] ?? p;

/** Les noms de streaming de la liste blanche : ceux que la presse ou TMDB peuvent proposer. */
function listeBlancheStreaming(): string[] {
  const jeux = /^(PC|PlayStation|Xbox|Nintendo|Apple Macintosh|Linux|iOS|Android|Web|Steam|Epic Games)\b/;
  return (VALID_PLATFORMS as readonly string[]).filter((p) => !jeux.test(p));
}

/** « presse : ADN News », « presse : ANN », « TMDB » → « presse : ADN News, ANN ; TMDB ». */
function sources(l: string[]): string {
  const presse = l.filter((x) => x.startsWith("presse : ")).map((x) => x.slice(9));
  return [presse.length ? `presse : ${presse.join(", ")}` : "", ...l.filter((x) => !x.startsWith("presse : "))].filter(Boolean).join(" ; ");
}

function lister<T>(l: T[], max: number, ligne: (x: T) => string): void {
  for (const x of l.slice(0, max)) console.log(`     ${ligne(x)}`);
  if (l.length > max) console.log(`     … et ${l.length - max} autres`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  // « appliquer » (premières versions) ne lisait pas AniList ; l'ancien activer-plateformes.sh
  // s'arrête donc ici sans rien écrire.
  if (args.includes("appliquer")) {
    console.log("ARRÊT : « appliquer » a été remplacé par « rattrapage » : utilise le nouveau activer-plateformes.sh, qui copie d'abord la table. Rien n'a été écrit.");
    process.exitCode = 2;
    return;
  }
  const ecrire = args.includes("rattrapage");
  if (args.some((a) => a !== "rattrapage")) {
    console.log(`argument incompris : « ${args.find((a) => a !== "rattrapage")} » (seul « rattrapage » est connu)`);
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
  try {
    const quand = new Date().toISOString().slice(0, 16).replace("T", " ");
    console.log(`PLATEFORMES DES ANIMES — ${ecrire ? "ÉCRITURE (rattrapage, sans notification)" : "à blanc, rien n'est écrit"} — ${quand} UTC`);
    console.log(`Liste blanche du streaming : ${listeBlancheStreaming().join(", ")}`);
    const etat = (v: string | undefined) => (v === "1" ? "allumée" : "éteinte");
    const infos = await infosAnilist(pool, configAnilist(env));
    const b = await calculer(pool, infos);
    console.log(
      `Base : ${pluriel(b.animes, "anime")} ; presse (${etat(env["PRESSE_ENABLED"])}) : ${pluriel(b.annonces, "annonce")} pour la France ; ` +
        `TMDB (${etat(env["TMDB_ENABLED"])}) : ${pluriel(b.tmdbPrecis, "anime")} vérifié${b.tmdbPrecis > 1 ? "s" : ""} au niveau de la saison ou du film`,
    );
    console.log(
      `Pays d'origine (AniList) : ${b.paysConnus} connu${b.paysConnus > 1 ? "s" : ""} sur ${b.animes}, dont ${b.nonJaponais.length} non japonais` +
        (infos.aLire ? ` ; ${infos.aLire} demandé${infos.aLire > 1 ? "s" : ""} à AniList` : "") +
        (infos.relus ? ` ; plateformes de ${infos.relus} non japonais relues` : "") +
        (infos.erreur ? ` ; ${infos.erreur}` : ""),
    );
    const masques = b.nonJaponais.filter((x) => x.masque);
    const masquesIds = new Set(masques.map((x) => x.id));

    // 1. Retraits
    const retraits = b.changements.filter((c) => c.retirees.length);
    const vides = retraits.filter((c) => vide(c.apres) && !masquesIds.has(c.id));
    const gardent = retraits.filter((c) => !vide(c.apres));
    const deviennentMasques = retraits.filter((c) => masquesIds.has(c.id)).length;
    const parNom = new Map<string, number>();
    for (const c of retraits) for (const p of c.retirees) parNom.set(p, (parNom.get(p) ?? 0) + 1);
    console.log("");
    console.log(`══ 1. PLATEFORMES RETIRÉES (hors Europe, fermées ou invalides) : ${pluriel(retraits.length, "anime")}`);
    if (parNom.size) console.log(`   ${[...parNom].sort((x, y) => y[1] - x[1]).map(([n, k]) => `${n} : ${k}`).join(" · ")}`);
    if (vides.length) {
      console.log(`   Plus aucune plateforme : ${vides.length} (à venir : « Aucune plateforme annoncée » sur le site ; déjà sorti : masqué jusqu'à ce qu'une de nos plateformes arrive)`);
      lister(vides, 60, (c) => `${fiche(c)} : ${morceaux(c.avant).join(", ")}`);
    }
    if (deviennentMasques) console.log(`   Plus aucune plateforme et pas japonais : ${deviennentMasques}, voir la partie 4 (masqués)`);
    if (gardent.length) {
      console.log(`   Gardent au moins une plateforme européenne : ${gardent.length} (les plus populaires d'abord)`);
      lister(gardent, 30, (c) => `${fiche(c)} : − ${c.retirees.join(", ")} → ${c.apres}`);
    }

    // 2. Ajouts
    const ajouts = b.changements.filter((c) => c.ajoutees.length);
    console.log("");
    console.log(`══ 2. PLATEFORMES AJOUTÉES (vérifiées pour la France, ou AniList pour un anime non japonais) : ${pluriel(ajouts.length, "anime")}`);
    if (!ajouts.length) {
      const rienDeVerifie = !b.annonces && !b.tmdbPrecis;
      const eteints = env["PRESSE_ENABLED"] !== "1" && env["TMDB_ENABLED"] !== "1";
      console.log(`   rien${rienDeVerifie ? (eteints ? " (presse et TMDB éteints : rien de vérifié pour l'instant)" : " (rien de vérifié pour l'instant)") : " de nouveau : ce qui est vérifié est déjà affiché"}`);
    }
    lister(ajouts, 60, (c) => `${fiche(c)} : ${c.ajoutees.map((a) => `+ ${a.nom} (${sources(a.sources)})`).join(" ; ")}`);
    const premieres = ajouts.filter((c) => vide(c.avant) || morceaux(c.avant).every((p) => !nomDuSite(p)));
    if (premieres.length) {
      console.log(
        `   Dont ${pluriel(premieres.length, "anime")} sans plateforme jusqu'ici : notification « Plateforme ajoutée » aux abonnés` +
          (ecrire ? " — pas pendant ce rattrapage" : " au passage automatique, aucune pendant le rattrapage"),
      );
    }
    if (b.tmdbPasSorti) console.log(`   TMDB non appliqué à ${pluriel(b.tmdbPasSorti, "anime")} pas encore sorti${b.tmdbPasSorti > 1 ? "s" : ""} (ce qu'il montre vient d'une autre saison)`);
    if (b.serieEntiere.length) {
      console.log(`   TMDB pour la série entière, non appliqué (rien ne dit que cette saison y est) : ${b.serieEntiere.length}`);
      lister(b.serieEntiere, 20, (x) => `${fiche(x)} : ${x.plateformes.join(", ")}`);
    }

    // 3. Avant / après
    const autres = b.changements.filter((c) => !c.retirees.length && !c.ajoutees.length);
    console.log("");
    console.log("══ 3. NOMBRE D'ANIMES PAR PLATEFORME, AVANT → APRÈS (sans les masqués)");
    const noms = [...new Set([...b.avantParPlateforme.keys(), ...b.apresParPlateforme.keys()])];
    noms.sort((x, y) => (b.apresParPlateforme.get(y) ?? 0) - (b.apresParPlateforme.get(x) ?? 0) || (b.avantParPlateforme.get(y) ?? 0) - (b.avantParPlateforme.get(x) ?? 0));
    const ligne = noms.map((n) => `${n} ${b.avantParPlateforme.get(n) ?? 0} → ${b.apresParPlateforme.get(n) ?? 0}`);
    for (let i = 0; i < ligne.length; i += 5) console.log(`   ${ligne.slice(i, i + 5).join(" · ")}`);
    if (autres.length) console.log(`   Écriture seulement remise en ordre (même plateformes) : ${pluriel(autres.length, "anime")}`);

    // 4. Animes non japonais
    const gardes = b.nonJaponais.filter((x) => !x.masque);
    console.log("");
    console.log(`══ 4. ANIMES NON JAPONAIS : ${b.nonJaponais.length}`);
    console.log(`   ${ecrire ? "Masqués" : "Seraient masqués"} (aucune de nos plateformes) : ${masques.length}`);
    if (masques.length) {
      console.log("   Absents des flux du site (accueil, catalogue, recherche, semaine, fiches) ; ils restent en base avec leurs favoris,");
      console.log("   et réapparaissent seuls dès qu'une de nos plateformes arrive (AniList, presse, TMDB ou n8n).");
      lister(masques, 60, (x) => `${fiche(x)} · ${nomPays(x.pays)} · avant : ${morceaux(x.avant).join(", ") || "aucune plateforme"}`);
    }
    console.log(`   Gardés (sur une de nos plateformes) : ${gardes.length}`);
    lister(gardes, 30, (x) => `${fiche(x)} · ${nomPays(x.pays)} · ${x.apres}`);

    // 5. Films au cinéma en France (écrits par le passage automatique, jamais par le rattrapage)
    const cine = await calculerCinema(pool);
    const enBase: any[] = await pool.query(
      "SELECT CAST(id AS UNSIGNED) AS id, IFNULL(title_english, title) AS titre, DATE_FORMAT(fr_cinema, '%Y-%m-%d') AS d, TRIM(IFNULL(platform, '')) <> '' AS plateforme FROM anime_items WHERE format = 'MOVIE' AND fr_cinema IS NOT NULL ORDER BY fr_cinema DESC",
    );
    console.log("");
    console.log(`══ 5. FILMS AU CINÉMA EN FRANCE (annonces « Cinéma » de la presse et de Tavily) : ${enBase.length} en base`);
    lister(enBase, 30, (x: any) => `${fiche({ titre: String(x.titre), id: Number(x.id) })} : ${dateFr(String(x.d))}${Number(x.plateforme) ? " (une de nos plateformes aussi : elle s'affiche à la place de « Cinéma »)" : ""}`);
    console.log(`   À mettre à jour au prochain passage automatique : ${cine.length}${cine.length ? " (notification « Au cinéma » aux abonnés d'une date nouvelle)" : ""}`);
    lister(cine, 30, (f) => `${fiche(f)} : ${f.avant ? dateFr(f.avant) : "pas de date"} → ${f.apres ? `${dateFr(f.apres)}${f.source ? ` (${f.source})` : ""}` : "plus d'annonce : date retirée"}`);

    console.log("");
    if (!ecrire) {
      const n = b.changements.length;
      console.log(
        `══ BILAN : ${pluriel(n, "anime")} changerai${n > 1 ? "en" : ""}t de plateformes, ` +
          `${pluriel(masques.length, "anime")} non japonais ${masques.length > 1 ? "seraient masqués" : "serait masqué"}, sur ${b.animes}. Rien n'a été écrit.`,
      );
      return;
    }
    const e = await appliquer({ pool, log: journal }, b, null);
    const paysEcrits = await ecrirePays(pool, infos);
    console.log(`══ ÉCRIT : ${pluriel(e.ecrits.length, "anime")} changé${e.ecrits.length > 1 ? "s" : ""} de plateformes, ${paysEcrits} pays d'origine enregistré${paysEcrits > 1 ? "s" : ""}, ${pluriel(masques.length, "anime")} masqué${masques.length > 1 ? "s" : ""}, sur ${b.animes}, sans notification.`);
    if (e.entreTemps) console.log(`   ${pluriel(e.entreTemps, "anime")} changé${e.entreTemps > 1 ? "s" : ""} entre-temps : non écrasé${e.entreTemps > 1 ? "s" : ""}, repris au prochain passage.`);
    if (infos.erreur) console.log(`   ${infos.erreur} : le reste des pays sera lu au prochain passage.`);
  } finally {
    await pool.end();
  }
}

// Lancé directement (pas importé par un test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
