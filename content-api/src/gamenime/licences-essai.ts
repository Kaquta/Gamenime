/**
 * licences-essai.ts — Le calcul des licences, à blanc : ce que le module écrirait, sans rien écrire.
 *
 * Lancé dans l'API (POST /admin/licences/essai, licences.ts ; c'est ce que fait licences-essai.sh) : il partage alors le
 * rythme AniList de l'API (tourAniList), sa suspension après un 429 et le jeton Twitch, comme le passage quotidien.
 * Le rapport (ASCII) est lu par GET /admin/licences/essai ; le détail en JSON est écrit dans /tmp/licences-essai.json du
 * conteneur.
 *
 * Aussi en ligne de commande, pour les essais hors de l'API seulement (il a alors son propre rythme AniList et son propre
 * jeton Twitch, rendu à la fin) : node dist/gamenime/licences-essai.js (LICENCES_ESSAI_JSON, LICENCES_ESSAI_PID).
 *
 * Le même calcul que le passage quotidien (licences.ts, passageLicences), lu sur les vraies sources : les fiches du site
 * par l'API, AniList, IGDB et Wikidata. Comme le passage, il laisse AniList tranquille de h:54 à h:05 (n8n). Aucune
 * table n'est créée ni écrite.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as mariadb from "mariadb";
import { asc, ascLigne, choisirReperes, norm } from "./licences-calcul.js";
import type { Calcul, LicenceCalculee } from "./licences-calcul.js";
import { configLicences, passageLicences } from "./licences.js";
import type { LicencesConfig, LicencesDeps } from "./licences.js";
import { getTwitchToken, igdbFetch } from "./twitch.js";

const journal = {
  info: (_o: object, _m?: string) => {},
  warn: (o: object, m?: string) => console.log(ascLigne(`  (avertissement) ${m ?? ""} ${JSON.stringify(o)}`)),
  error: (o: object, m?: string) => console.log(ascLigne(`  (erreur) ${m ?? ""} ${JSON.stringify(o)}`)),
};
const dire = (l: string) => console.log(ascLigne(l));
const coupe = (s: unknown, n: number) => {
  const t = asc(s);
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
};
const FORMATS: Record<string, string> = { TV: "Serie TV", TV_SHORT: "Court", MOVIE: "Film", SPECIAL: "Special", OVA: "OVA", ONA: "ONA" };
const typeRep = (x: { dom: string; format: string | null }) => (x.dom === "anime" ? FORMATS[String(x.format)] || "anime" : x.format ? `jeu, ${x.format}` : "jeu");

/** Les cas du plan (§ 2.1) : où sont-ils allés ? */
const CAS = [
  ["Bungo Stray Dogs", "avec Bungo Stray Dogs: Wan!"], ["Gate", "avec Gate Season 2"], ["A Certain Magical Index", "avec ITEM"],
  ["Baki Hanma", "avec Baki Dou"], ["Ace of the Diamond", "avec Act II"], ["Date A Bullet", "garde pour Date A Live"],
  ["Initial D", "avec MF Ghost"], ["Lord El-Melloi", "garde pour Fate"], ["Emiya", "garde pour Fate"], ["Lupin", "ecarte de Case Closed"],
  ["Magic Kaito", "ecarte de Case Closed"], ["Toriko", "ecarte de One Piece"], ["MONSTERS", "garde pour One Piece (decision de Rey)"], ["Melty Blood", "a regarder (Fate)"],
] as const;
/** Fiches dont le bloc est montré en exemple. */
const EXEMPLES = ["One Piece: Grand Gourmet", "Pokemon Champions", "Grand Theft Auto VI", "Jujutsu Kaisen", "Ghost of Tsushima", "Fate/strange Fake", "Dragon Ball", "Gundam", "Frieren", "Resident Evil", "Love Live", "MF Ghost"];

function rapport(calc: Calcul, titres: Map<string, string>, dire: (l: string) => void): void {
  const L = calc.licences;
  const nomDe = (l: LicenceCalculee) => coupe(l.nom, 60);
  dire("");
  dire("== 3. Licences");
  const deux = L.filter((l) => l.membres.length + l.reperes.length >= 2);
  const croisees = L.filter((l) => (l.membres.some((m) => m.dom === "anime") || l.reperes.some((r) => r.dom === "anime")) && (l.membres.some((m) => m.dom === "game") || l.reperes.some((r) => r.dom === "game")));
  dire(`  ${L.length} licences ; ${L.filter((l) => l.membres.length >= 2).length} d'au moins 2 fiches du radar ; ${deux.length} de 2 sorties ou plus (radar et repères) ; ${croisees.length} melant animes et jeux`);
  dire(`  ponts par le titre : ${calc.diag.pontsTitre.length} ; par le nom : ${calc.diag.pontsNom.length} ; vers les catalogues : ${calc.diag.pontsCatalogue.filter((p) => !p.ambigu && p.ajoutes).length} (ambigus laisses : ${calc.diag.pontsCatalogue.filter((p) => p.ambigu).length})`);
  for (const p of calc.diag.pontsTitre) dire(`      ${p.dom === "anime" ? "anime" : "jeu  "}  ${coupe(p.titre, 60)}  -> ${coupe(p.licence, 40)}`);
  dire(`  fiches a plusieurs franchises laissees seules : ${calc.diag.multi.length}`);
  for (const x of calc.diag.multi.slice(0, 12)) dire(`      ${coupe(x.titre, 60)} (${coupe(x.franchises.join(", "), 60)})`);
  // la regle des noms (Rey, 22 octobre) : une licence sans franchise prend le nom de son oeuvre principale
  const np = calc.diag.nomsPrincipaux.filter((x) => x.sorties >= 2 && norm(x.avant) !== norm(x.nom)).sort((a, b) => b.pop - a.pop);
  dire(`  licences de 2 sorties ou plus nommees par leur oeuvre principale : ${np.length} (nom de la regle d'avant -> nom)`);
  for (const x of np.slice(0, 40)) dire(`      ${coupe(x.avant, 50)} -> ${coupe(x.nom, 40)}`);
  if (np.length > 40) dire(`      ... et ${np.length - 40} autres`);

  dire("");
  dire("== 4. Le passe");
  const c = calc.comptes;
  dire(`  AniList : ${c.noeuds} animes du passe lus sur ${c.profondeur} niveau(x)${c.arretParcours ? ` ; arret : ${c.arretParcours}, ${c.nonLus} non lus` : ""}`);
  dire(`  IGDB : ${c.jeuxPasse} jeux du passe lus ; Wikidata : ${c.wdAnimes} anime(s) et ${c.wdJeux} jeu(x) ajoutes`);
  dire(`  reperes gardes (seuil bas ou lien direct) : ${L.reduce((n, l) => n + l.reperes.length, 0)}`);
  dire(`  animes d'une autre oeuvre d'origine entres par un lien fort : ${calc.diag.forts.length}`);
  for (const x of [...calc.diag.forts].sort((a, b) => b.pop - a.pop).slice(0, 40)) dire(`      ${coupe(x.titre, 52)} (${x.an ?? "?"}, ${x.pop} membres) : dans ${coupe(x.licence, 34)} (${x.lien})`);
  dire(`  animes ecartes : ${calc.diag.exclus.length}`);
  for (const x of [...calc.diag.exclus].sort((a, b) => b.pop - a.pop).slice(0, 40)) dire(`      ${coupe(x.titre, 52)} (${x.an ?? "?"}, ${x.pop} membres) : pas pour ${coupe(x.licence, 30)} (${asc(x.raison)})`);
  dire(`  a egale distance de deux licences (a aucune) : ${calc.diag.egaux.length} ; revendiques a egalite (a aucune) : ${calc.diag.partages.length} ; jeux croises ecartes : ${new Set(calc.diag.croises.map((x) => x.id)).size}`);
  for (const x of calc.diag.partages.slice(0, 10)) dire(`      ${coupe(x.titre, 52)} : ${coupe(x.licences.join(" / "), 60)}`);

  dire("");
  dire("== 5. Les cas du plan (par. 2)");
  for (const [mot, attendu] of CAS) {
    const n = norm(mot);
    const ou: string[] = [];
    for (const l of L) for (const r of l.reperes) if (norm(r.titre).includes(n)) ou.push(`${coupe(r.titre, 44)} (${r.annee}) -> ${nomDe(l)}`);
    for (const x of calc.diag.exclus) if (norm(x.titre).includes(n)) ou.push(`${coupe(x.titre, 44)} (${x.an ?? "?"}) -> ECARTE de ${coupe(x.licence, 30)} (${asc(x.raison)})`);
    dire(`  ${mot} (attendu : ${attendu}) : ${ou.length ? "" : "introuvable dans le passe lu"}`);
    for (const x of ou.slice(0, 6)) dire(`      ${x}`);
    if (ou.length > 6) dire(`      ... et ${ou.length - 6} autres`);
  }
  dire(`  licences reunies par une franchise Wikidata (commune, ou qui range les leurs) : ${calc.diag.reunies.length}`);
  for (const x of calc.diag.reunies.slice(0, 20)) dire(`      ${coupe(x.noms.join(" + "), 80)} (franchise ${coupe(x.franchise, 30)})`);
  const lr = new Map<string, Set<string>>();
  for (const x of calc.diag.reliees) {
    const k = `${x.a} / ${x.b}`;
    if (!lr.has(k)) lr.set(k, new Set());
    lr.get(k)?.add(x.via);
  }
  dire(`  licences du radar reliees par leur passe, laissees separees : ${lr.size}`);
  for (const [k, v] of [...lr].slice(0, 20)) dire(`      ${coupe(k, 80)} (${[...v].join(", ")})`);
  // regles 7 : les reunions refusees qui tiennent (controle des oeuvres d'origine d'abord ; puis franchises differentes,
  // noms, titres)
  const refusO = calc.diag.refuses.filter((x) => x.origine).length;
  dire(`  reunions refusees : ${calc.diag.refuses.length}, dont ${refusO} par le controle des oeuvres d'origine`);
  for (const x of [...calc.diag.refuses].sort((p, q) => Number(q.origine) - Number(p.origine)).slice(0, 20)) dire(`      ${coupe(`${x.a} / ${x.b}`, 70)} (${coupe(asc(`${x.lien} : ${x.cle}`), 60)})`);
  for (const nom of ["One Piece", "Jujutsu Kaisen", "Fate"]) {
    const l = L.find((x) => norm(x.nom) === norm(nom));
    if (!l) {
      dire(`  ${nom} : licence introuvable`);
      continue;
    }
    const j = l.reperes.filter((r) => r.dom === "game"), a = l.reperes.filter((r) => r.dom === "anime");
    dire(`  ${nom} : ${a.length} anime(s) et ${j.length} jeu(x) dans le passe`);
    if (nom === "Fate") for (const r of [...l.reperes].sort((x, y) => y.pop - x.pop).slice(0, 25)) dire(`      ${coupe(r.titre, 56)} (${typeRep(r)}, ${r.annee}, ${r.pop} ${r.dom === "anime" ? "membres" : "notes"}, ${r.par})`);
  }

  dire("");
  dire("== 6. Exemples de blocs (ce que montrera la fiche)");
  const vusEx = new Set<string>();
  for (const mot of EXEMPLES) {
    const n = norm(mot);
    let trouve: { l: LicenceCalculee; m: LicenceCalculee["membres"][number] } | null = null;
    for (const l of L) for (const m of l.membres) if (!trouve && norm(titres.get(`${m.dom}:${m.id}`) || "").includes(n)) trouve = { l, m };
    if (!trouve) {
      dire(`  ${mot} : pas de fiche`);
      continue;
    }
    const { l, m } = trouve;
    const k = `${m.dom}:${m.id}`;
    if (vusEx.has(k)) continue;
    vusEx.add(k);
    const autres = l.membres.filter((x) => !(x.dom === m.dom && x.id === m.id));
    const d = new Set(l.directs.filter((x) => x.dom === m.dom && x.id === m.id).map((x) => `${x.source}:${x.sourceId}`));
    const rep = choisirReperes(m.dom, l.reperes, d);
    const o = m.dom === "anime" ? m.origine : l.origine;
    dire(`  ${coupe(titres.get(k), 60)} (${m.dom === "anime" ? "anime" : "jeu"}) -> Univers ${nomDe(l)}`);
    dire(`      origine : ${o ? `${o.type}${o.titre ? ", " + coupe(o.titre, 40) : ""}${o.auteurs.length ? ", " + coupe(o.auteurs.join(", "), 40) : ""}` : "aucune"}`);
    dire(`      autres sorties du radar : ${autres.length ? autres.slice(0, 6).map((x) => coupe(titres.get(`${x.dom}:${x.id}`), 40)).join(" ; ") : "aucune"}`);
    if (!rep.length) dire("      reperes : aucun");
    for (const r of rep) dire(`      avant  ${coupe(r.titre, 50)} (${typeRep(r)}, ${r.annee})${r.direct ? " [lien direct]" : ""}`);
  }
}

/**
 * L'essai : le passage à blanc et son rapport (dire, ligne à ligne), puis le détail en JSON (chemin). Rend 0 si le passage
 * irait au bout et écrirait ; 1 s'il n'écrirait rien (source en panne, passage incomplet, garde-fou) ; 2 si un passage
 * des licences tournait déjà (rien n'a été lu, pas de détail JSON).
 */
export async function essaiLicences(deps: LicencesDeps, cfg: LicencesConfig, dire: (l: string) => void, chemin: string): Promise<number> {
  const debut = Date.now();
  const d = (l: string) => dire(ascLigne(l));
  // le détail d'un essai précédent ne doit pas passer pour celui-ci
  try {
    unlinkSync(chemin);
  } catch {
    /* pas de détail précédent */
  }
  d(`ESSAI DES LICENCES -- a blanc, rien n'est ecrit -- ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  d("  (quinze a trente minutes : AniList, IGDB puis Wikidata, a leur rythme ; AniList s'arrete de h:54 a h:05 pour laisser passer n8n)");
  d("");
  d("== 1. Fiches du site et sources");
  const titres = new Map<string, string>();
  const lireFlux = async (chemin: string) => {
    const r: any = await deps.lireFlux(chemin);
    for (const x of Array.isArray(r?.items) ? r.items : []) if (x && x.id) titres.set(`${x.type === "game" || chemin.includes("/games") || chemin.includes("type=game") ? "game" : "anime"}:${Number(x.id)}`, String(x.titleEnglish || x.title || ""));
    return r;
  };
  const r = await passageLicences({ ...deps, lireFlux }, cfg, { ecrire: false, dire: d });
  const b = r.bilan;
  if (b.occupe) {
    d("ARRET : un passage des licences tourne deja (la ligne du Pilotage) : rien n'a ete lu. Relancez quand il sera fini.");
    return 2;
  }
  d("");
  d("== 2. Ce qui a ete lu");
  d(`  ${b.fiches} fiches lues (${b.animes} animes, ${b.jeux} jeux)`);
  for (const x of b.replis) d(`  repli : ${x}`);
  if (r.calc) rapport(r.calc, titres, d);
  d("");
  d("== 7. Ce que le passage changerait en base");
  if (r.plan) {
    const ch = r.plan.changements;
    d(`  ${r.ancienne ? "par rapport aux licences en base" : "base vide : tout serait nouveau"} ; licences nouvelles (2 sorties ou plus) : ${ch.nouvelles.length} ; reunies : ${ch.reunies.length} ; separees : ${ch.separees.length} ; reveillees : ${ch.reveillees.length} ; en sommeil : ${ch.endormies.length} ; renommees : ${ch.renommees.length}`);
    if (r.ancienne) for (const [t, l] of [["reunies", ch.reunies], ["separees", ch.separees], ["renommees", ch.renommees], ["en sommeil", ch.endormies]] as Array<[string, string[]]>) for (const x of l.slice(0, 8)) d(`      ${t} : ${coupe(x, 90)}`);
  }
  if (b.garde) d(`  GARDE-FOU : ${asc(b.garde)} : le passage n'ecrirait rien`);
  d("");
  d("== 8. Bilan");
  if (b.erreur) d(`  ERREUR : ${asc(b.erreur)} : le passage n'ecrirait rien`);
  else if (b.arret) d(`  INCOMPLET : ${asc(b.arret)} : le passage n'ecrirait rien`);
  else d(`  ${b.blocs} fiches sur ${b.fiches} avec un bloc rempli ; ${b.licences2} licences de 2 sorties ou plus ; ${b.croisees} licences melant animes et jeux ; ${b.reperes} reperes`);
  d(`  requetes : AniList ${b.requetes.al}, IGDB ${b.requetes.ig}, Wikidata ${b.requetes.wd} ; ${b.pausesN8n} pause(s) pour n8n ; duree ${Math.round((Date.now() - debut) / 1000)} s`);
  try {
    writeFileSync(chemin, JSON.stringify({ le: new Date().toISOString(), bilan: b, licences: r.calc?.licences ?? [], diag: r.calc?.diag ?? null, changements: r.plan?.changements ?? null }));
    d(`  detail complet ecrit (${chemin} dans le conteneur)`);
  } catch {
    d("  detail complet non ecrit (dossier /tmp du conteneur)");
  }
  return b.erreur || b.arret || b.garde ? 1 : 0;
}

/** En ligne de commande (essais hors de l'API seulement) : sa propre base, ses propres lectures du site par HTTP. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length) {
    console.log(`argument incompris : ${asc(args[0])} (l'essai ne prend aucun argument : il est toujours a blanc)`);
    process.exitCode = 2;
    return;
  }
  const env = process.env;
  if (!env["DB_HOST"] || !env["DB_USER"] || !env["DB_NAME"]) {
    console.log("ARRET : variables de base absentes (DB_HOST, DB_USER, DB_NAME) : lancer dans le conteneur content-api.");
    process.exitCode = 2;
    return;
  }
  const API = String(env["LICENCES_ESSAI_API"] || `http://localhost:${env["PORT"] || 3000}`).replace(/\/+$/, "");
  const pool = mariadb.createPool({ host: env["DB_HOST"], user: env["DB_USER"], password: env["DB_PASS"], database: env["DB_NAME"], connectionLimit: 2 });
  let jetonPris = false;
  const PID = env["LICENCES_ESSAI_PID"];
  const retirerPid = () => {
    if (!PID) return;
    try {
      unlinkSync(PID);
    } catch {
      /* déjà retiré */
    }
  };
  /** Le jeton Twitch de ce processus (le cache de twitch.ts) rendu à Twitch : il ne compte plus dans la limite. */
  const rendreJeton = async () => {
    if (!jetonPris) return;
    jetonPris = false;
    try {
      const t = await getTwitchToken();
      if (t) await fetch("https://id.twitch.tv/oauth2/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env["TWITCH_CLIENT_ID"] || "", token: t }).toString(), signal: AbortSignal.timeout(15000) });
    } catch {
      /* sans importance : le jeton expire seul */
    }
  };
  if (PID) {
    try {
      writeFileSync(PID, String(process.pid));
    } catch {
      /* sans importance */
    }
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      void rendreJeton().finally(() => {
        retirerPid();
        console.log("");
        console.log("ARRET : essai interrompu : rien n'a ete ecrit.");
        process.exit(130);
      });
    });
  }
  try {
    const deps: LicencesDeps = {
      pool: pool as any,
      log: journal,
      lireFlux: async (chemin: string) => {
        const r = await fetch(API + chemin, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`${chemin} : HTTP ${r.status}`);
        return r.json();
      },
      igdb: (url: string, init: RequestInit) => {
        jetonPris = true;
        return igdbFetch(url, init);
      },
    };
    process.exitCode = await essaiLicences(deps, configLicences(env), dire, env["LICENCES_ESSAI_JSON"] || "/tmp/licences-essai.json");
  } catch (e) {
    dire("");
    dire(`ARRET : ${String((e as any)?.message ?? e).split(/\r?\n/)[0].slice(0, 200)} : rien n'a ete ecrit.`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    await rendreJeton();
    retirerPid();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
