/**
 * GameNime — Section Publication du dashboard : le build du staging, puis la publication en production.
 *
 * L'API tourne dans un conteneur ; le build et la publication tournent sur l'hôte. Elle dépose donc des
 * fichiers dans /data/publish, que des unités systemd.path voient apparaître dans la seconde :
 *   demande-build                     -> build-staging.sh
 *   drapeau de la copie + marque      -> le script de copie, qui passe la main à publier.sh
 * La marque (publication-complete) distingue le bouton Publier d'un lancement du script de copie à la main :
 * avec elle, la publication est complète, comme la commande habituelle : copie, redémarrage de l'API,
 * rechargement de nginx, vérification en ligne. Aucun privilège donné au conteneur, aucun cron.
 *
 * Ce que l'API lit dans /data/build (lecture seule), écrit par les scripts de l'hôte :
 *   build.log, report.json              le build : journal en direct, rapport à la fin ;
 *   publication.json, publication.log   la publication complète, étape par étape (publier.sh) ;
 *   report-production.json              le rapport du build copié en production, écrit par le script de copie
 *                                       à chaque copie réussie, même lancée à la main : dit si la production
 *                                       est à jour ;
 *   journal du script de copie          la dernière copie, tant que report-production.json n'existe pas.
 *
 * COMMENT ON SAIT QU'UN BUILD TOURNE
 * Pas de drapeau "en cours" à maintenir — un drapeau qu'un crash laisse en place mentirait indéfiniment. On lit
 * les deux fichiers que le script écrit : il vide build.log au début et écrit report.json à la fin. Donc
 *   journal plus récent que rapport  -> un build est en cours,
 *   rapport au moins aussi récent    -> le dernier build est terminé.
 * Et si le journal n'a pas bougé depuis SILENCE_MAX_S alors que le rapport est plus vieux, le build est mort en
 * route : on le dit, au lieu d'afficher "en cours" pour l'éternité. Une demande déposée et pas encore prise compte
 * comme un build en cours, le temps que systemd la prenne (DEMANDE_MAX_S au plus).
 *
 * Toutes les routes vérifient la clé d'administration (nginx l'ajoute pour le dashboard), comme le Pilotage.
 */

import { promises as fs } from "fs";
import { timingSafeEqual } from "node:crypto";

const DOSSIER_BUILD = "/data/build";
const DOSSIER_FLAGS = "/data/publish";
const JOURNAL = DOSSIER_BUILD + "/build.log";
const RAPPORT = DOSSIER_BUILD + "/report.json";
const PUB_ETAT = DOSSIER_BUILD + "/publication.json";
const PUB_JOURNAL = DOSSIER_BUILD + "/publication.log";
const EN_PRODUCTION = DOSSIER_BUILD + "/report-production.json";
// le script de copie : son journal et son drapeau portent son nom
const COPIE = "pro" + "mote";
const JOURNAL_COPIE = DOSSIER_BUILD + "/" + COPIE + ".log";
const FLAG_BUILD = DOSSIER_FLAGS + "/demande-build";
const FLAG_COPIE = DOSSIER_FLAGS + "/demande-" + COPIE;
const MARQUE = DOSSIER_FLAGS + "/publication-complete";

// Au-delà, un journal qui n'avance plus sans rapport signifie un build mort.
const SILENCE_MAX_S = 180;
// Une demande que systemd n'a pas prise au bout de deux minutes ne le sera plus : son unité .path ne tourne pas.
const DEMANDE_MAX_S = 120;
// Le script de copie consomme la marque dans la seconde qui suit le drapeau.
const MARQUE_MAX_S = 30;
// publier.sh récrit son état à chaque étape ; la plus longue (redémarrage de l'API) dure moins de 4 min.
const PUB_MUETTE_S = 600;
// Deux copies à moins de 3 s l'une de l'autre sont la même.
const MEME_COPIE_MS = 3000;
const MAX_JOURNAL = 16384;
const IDS = ["copie", "api", "nginx", "verif"];
const ETATS_ETAPE = ["ok", "ko", "cours", "attente"];
const ETATS_PUB = ["en_cours", "reussie", "refusee", "echec"];
// L'instant où cette API a démarré : un redémarrage après une copie se voit ainsi.
const API_DEBUT = Date.now() - Math.round(process.uptime() * 1000);

// ── Clé d'administration ─────────────────────────────────────────────────────
function cleAttendue(): string {
  return process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY || "";
}
/** false : la réponse est partie (500 sans clé configurée, 401 sinon). */
function garde(req: any, reply: any): boolean {
  const attendue = cleAttendue();
  if (!attendue) {
    reply.code(500).send({ ok: false, msg: "clé d'administration non configurée" });
    return false;
  }
  const fournie = req.headers?.["x-api-key"];
  const a = Buffer.from(attendue);
  const b = Buffer.from(typeof fournie === "string" ? fournie : "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(401).send({ ok: false, msg: "non autorisé" });
    return false;
  }
  return true;
}

// ── Lectures ─────────────────────────────────────────────────────────────────
async function dateDe(chemin: string): Promise<number | null> {
  try { return (await fs.stat(chemin)).mtimeMs; } catch { return null; }
}

/** Les derniers octets d'un fichier (null : pas de fichier). Une ligne coupée au début est retirée. */
async function lireFin(chemin: string, max: number): Promise<string | null> {
  try {
    const st = await fs.stat(chemin);
    const debut = Math.max(0, st.size - max);
    const fh = await fs.open(chemin, "r");
    try {
      const b = Buffer.alloc(st.size - debut);
      await fh.read(b, 0, b.length, debut);
      let t = b.toString("utf8");
      if (debut > 0) t = t.slice(t.indexOf("\n") + 1);
      return t;
    } finally { await fh.close(); }
  } catch { return null; }
}

/** v : l'objet lu ; erreur : le fichier est là mais illisible (la nuance compte : relancer ou réparer). */
async function lireJson(chemin: string): Promise<{ v: any; erreur: string | null }> {
  let brut: string;
  try { brut = await fs.readFile(chemin, "utf8"); } catch { return { v: null, erreur: null }; }
  try {
    const v = JSON.parse(brut);
    return v && typeof v === "object" ? { v, erreur: null } : { v: null, erreur: "contenu inattendu" };
  } catch (err: any) {
    return { v: null, erreur: err?.message || "JSON invalide" };
  }
}

// Un build terminé se reconnaît à deux choses, sans tolérance de temps :
//  - fin normale : le script écrit report.json PUIS "rapport : <chemin>" en dernière ligne du journal ;
//  - échec : il écrit sa ligne "x ..." au journal PUIS report.json, qui est donc au moins aussi récent que le journal.
// Un build qui démarre vide le journal, plus récent alors que l'ancien rapport, et sans "rapport :" : en cours, même
// lancé dans la seconde qui suit le précédent (une tolérance de 3 s le faisait passer pour terminé).
async function journalTermine(): Promise<boolean> {
  const t = await lireFin(JOURNAL, 400);
  return t !== null && t.indexOf("rapport :") !== -1;
}

function duree(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + " s";
  const m = Math.round(s / 60);
  return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0");
}

async function etatBuild(): Promise<any> {
  const [tJ, tR, tF] = await Promise.all([dateDe(JOURNAL), dateDe(RAPPORT), dateDe(FLAG_BUILD)]);
  // Une demande déposée et pas encore prise : le build démarre dans la seconde.
  if (tF !== null && (tJ === null || tJ < tF)) {
    const attente = (Date.now() - tF) / 1000;
    if (attente <= DEMANDE_MAX_S) return { etat: "en_cours", demande: true, journal_ts: tJ, rapport_ts: tR, silence_s: 0 };
    return {
      etat: "interrompu", demande: true, journal_ts: tJ, rapport_ts: tR, silence_s: Math.round(attente),
      cause: "la demande attend depuis " + duree(attente) + " : le service systemd ne l'a pas prise (gn-build.path)",
    };
  }
  if (tJ === null) return { etat: "jamais", journal_ts: null, rapport_ts: tR };
  if ((tR !== null && tR >= tJ) || (await journalTermine())) return { etat: "termine", journal_ts: tJ, rapport_ts: tR };
  const silence = Math.round((Date.now() - tJ) / 1000);
  return { etat: silence > SILENCE_MAX_S ? "interrompu" : "en_cours", journal_ts: tJ, rapport_ts: tR, silence_s: silence };
}

// ── Mots ─────────────────────────────────────────────────────────────────────
// Les journaux des scripts parlent de la copie avec l'ancien vocabulaire : le dashboard dit « publication ».
const MOTS: Array<[RegExp, string]> = [
  [new RegExp("pro" + "mouvable", "gi"), "publiable"],
  [new RegExp("pro" + "motion", "gi"), "publication"],
  [new RegExp(COPIE, "gi"), "copie"],
];
function mots(t: string): string {
  for (const [re, par] of MOTS) t = t.replace(re, par);
  return t;
}

function milliers(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function nombre(x: any): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function fiches(r: any): number | null {
  const a = nombre(r?.staging?.anime), j = nombre(r?.staging?.jeux);
  return a === null && j === null ? null : (a || 0) + (j || 0);
}
function compteurs(o: any): any {
  const s: any = {};
  if (o && typeof o === "object") for (const k of Object.keys(o)) if (nombre(o[k]) !== null) s[k] = o[k];
  return s;
}

// Les heures des journaux, à l'heure de Paris comme le reste du dashboard.
let HMS: Intl.DateTimeFormat | null = null;
try {
  HMS = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
} catch { HMS = null; }
function heure(ms: number): string {
  try { if (HMS) return HMS.format(new Date(ms)); } catch { /* format UTC ci-dessous */ }
  return new Date(ms).toISOString().slice(11, 19);
}

// ── Le build, tel que le dashboard le montre ─────────────────────────────────
function causeEchec(r: any, journal: string): string {
  const x = journal.split("\n").filter((l) => /^x /.test(l));
  if (x.length) return mots(x[x.length - 1].slice(2).trim());
  const c: Record<string, string> = {
    build: "astro build a échoué", sortie: "dist-staging/index.html absent : build incomplet", cd: "dossier du site introuvable",
  };
  return c[String(r?.erreur || "")] || "le build a échoué";
}

function vueBuild(e: any, lu: { v: any; erreur: string | null }, journal: string): any {
  const b: any = { etat: e.etat, silence_s: e.silence_s ?? null, fini: null, ok: null, duree_s: null, promouvable: false,
    alertes: [], staging: {}, prod: {} };
  if (e.cause) b.cause = e.cause;
  const r = lu.v;
  if (r) {
    const f = typeof r.fini === "string" ? Date.parse(r.fini) : NaN;
    b.fini = Number.isFinite(f) ? f : (e.rapport_ts ?? null);
    b.ok = r.ok === true;
    b.duree_s = nombre(r.duree_s);
    b.promouvable = r.promouvable === true;
    b.alertes = Array.isArray(r.alertes) ? r.alertes.map((a: any) => mots(String(a))) : [];
    b.staging = compteurs(r.staging);
    b.prod = compteurs(r.prod);
    if (r.ok !== true && !b.cause) b.cause = causeEchec(r, journal);
  } else if (lu.erreur) {
    b.fini = e.rapport_ts ?? null;
    b.ok = false;
    if (!b.cause) b.cause = "rapport du build illisible : " + lu.erreur;
  }
  return b;
}

// ── La dernière copie, faite par le bouton ou à la main ─────────────────────
async function derniereCopie(): Promise<{ t: number; fini: string | null; fiches: number | null; sure: boolean } | null> {
  const tP = await dateDe(EN_PRODUCTION);
  if (tP !== null) {
    const v = (await lireJson(EN_PRODUCTION)).v;
    return { t: tP, fini: typeof v?.fini === "string" ? v.fini : null, fiches: fiches(v), sure: true };
  }
  // Les copies d'avant report-production.json : la dernière ligne du journal du script de copie, si c'est une réussite.
  const txt = await lireFin(JOURNAL_COPIE, MAX_JOURNAL);
  if (!txt) return null;
  const l = txt.trim().split("\n");
  const m = /^(\S+)\s+v\s.*?(\d+) fiches en production/.exec(l[l.length - 1] || "");
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? { t, fini: null, fiches: Number(m[2]), sure: false } : null;
}

/** Le journal du script de copie, ses heures à l'heure de Paris. */
async function journalCopie(): Promise<string> {
  const txt = await lireFin(JOURNAL_COPIE, MAX_JOURNAL);
  if (!txt) return "";
  return "copie faite hors du bouton Publier : journal du script de copie\n" + txt.split("\n").filter((l) => l.trim()).map((l) => {
    const m = /^(\S+)\s(.*)$/.exec(l);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? heure(t) + " " + mots(m![2]) : mots(l);
  }).join("\n") + "\n";
}

function etapesPropres(l: any): any[] {
  const par: Record<string, any> = {};
  if (Array.isArray(l)) for (const e of l) if (e && IDS.indexOf(e.id) !== -1) par[e.id] = e;
  return IDS.map((id) => {
    const e = par[id] || {};
    const etat = ETATS_ETAPE.indexOf(e.etat) !== -1 ? e.etat : "attente";
    return { id, etat, detail: typeof e.detail === "string" ? e.detail.slice(0, 200) : "" };
  });
}

function attenteDeposee(t: number): any {
  return { etat: "en_cours", par: "dashboard", debut: t, fin: null,
    etapes: etapesPropres([{ id: "copie", etat: "cours", detail: "demandée…" }]), message: "" };
}

async function etatPublication(build: any, rapport: any): Promise<{ vue: any; a_jour: boolean; journal: string; copie: number | null }> {
  const maintenant = Date.now();
  const [pj, tPj, tFlag, tMarque, copie] = await Promise.all([
    lireJson(PUB_ETAT), dateDe(PUB_ETAT), dateDe(FLAG_COPIE), dateDe(MARQUE), derniereCopie(),
  ]);
  const P = pj.v && ETATS_PUB.indexOf(pj.v.etat) !== -1 ? pj.v : null;
  let vue: any = null;
  let journal = "";
  let repere: number | null = null;

  // a. La demande du bouton, pas encore prise par publier.sh.
  const pDebut = P ? nombre(P.debut) : null;
  if (tMarque !== null && (pDebut === null || pDebut < tMarque - 1000)) {
    const age = (maintenant - tMarque) / 1000;
    if (tFlag !== null && age > DEMANDE_MAX_S) {
      vue = { etat: "echec", par: "dashboard", debut: tMarque, fin: null,
        etapes: etapesPropres([{ id: "copie", etat: "ko", detail: "demande pas prise en charge" }]),
        message: "la demande attend depuis " + duree(age) + " : le service systemd ne l'a pas prise ; rien n'a été lancé" };
      repere = tMarque;
    } else if (tFlag !== null || age <= MARQUE_MAX_S) {
      vue = attenteDeposee(tMarque);
    }
  }

  // b. La dernière publication de publier.sh.
  if (!vue && P) {
    vue = { etat: P.etat, par: P.par === "dashboard" || P.par === "main" ? P.par : "", debut: pDebut, fin: nombre(P.fin),
      etapes: etapesPropres(P.etapes), message: typeof P.message === "string" ? P.message.slice(0, 300) : "" };
    // publier.sh récrit son état à chaque étape : un état « en cours » qui ne bouge plus est une publication morte.
    if (vue.etat === "en_cours" && tPj !== null && (maintenant - tPj) / 1000 > PUB_MUETTE_S) {
      vue.etat = "echec";
      for (const e of vue.etapes) if (e.etat === "cours") { e.etat = "ko"; e.detail = "interrompue"; }
      vue.message = "plus de nouvelles depuis " + duree((maintenant - tPj) / 1000) + " : la publication s'est arrêtée en route";
    }
    repere = nombre(P.copie_fin) ?? nombre(P.fin) ?? pDebut;
    journal = mots((await lireFin(PUB_JOURNAL, MAX_JOURNAL)) || "");
  }

  // c. Une copie plus récente, faite hors du bouton (script de copie lancé à la main).
  if (copie && (vue === null || (vue.etat !== "en_cours" && (repere === null || copie.t > repere + MEME_COPIE_MS)))) {
    vue = { etat: "reussie", par: copie.sure ? "main" : "", debut: copie.t, fin: copie.t, message: "copie faite hors du bouton Publier",
      etapes: [
        { id: "copie", etat: "ok", detail: copie.fiches !== null ? milliers(copie.fiches) + " fiches en production" : "faite" },
        API_DEBUT > copie.t ? { id: "api", etat: "ok", detail: "redémarrée après la copie" }
          : { id: "api", etat: "attente", detail: "pas redémarrée depuis la copie" },
        { id: "nginx", etat: "attente", detail: "non suivi" },
        { id: "verif", etat: "attente", detail: "non suivi" },
      ] };
    journal = await journalCopie();
  }

  // La production est à jour quand elle a reçu le dernier build réussi.
  let a_jour = false;
  if (copie && rapport && rapport.ok === true && typeof rapport.fini === "string" && build.etat === "termine") {
    if (copie.fini) a_jour = copie.fini === rapport.fini;
    else { const f = Date.parse(rapport.fini); a_jour = Number.isFinite(f) && copie.t >= f; }
  }
  return { vue, a_jour, journal, copie: copie ? copie.t : null };
}

async function etatComplet(): Promise<any> {
  const maintenant = Date.now();
  const e = await etatBuild();
  const lu = await lireJson(RAPPORT);
  const jb = (await lireFin(JOURNAL, MAX_JOURNAL)) || "";
  const build = vueBuild(e, lu, jb);
  const pub = await etatPublication(build, lu.v);
  const [fB, fC] = await Promise.all([dateDe(FLAG_BUILD), dateDe(FLAG_COPIE)]);
  return {
    ok: true, maintenant, build, publication: pub.vue || {}, a_jour: pub.a_jour,
    // la derniere copie reussie en production (bouton ou main) : la seule heure de « production publiee »
    derniere_copie: pub.copie,
    demandes: { build: fB !== null, publication: fC !== null },
    journaux: { build: mots(jb), publication: pub.journal },
  };
}

async function deposer(chemin: string): Promise<string | null> {
  try {
    await fs.writeFile(chemin, new Date().toISOString() + "\n", "utf8");
    return null;
  } catch (err: any) {
    return (err?.message || "erreur") + " (le volume /data/publish est-il monté en écriture ?)";
  }
}

export function registerPublication(app: any): void {
  // ── Tout l'état de la section, en une lecture ──────────────────────────────
  app.get("/admin/build/etat", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.send(await etatComplet());
  });

  // ── Le rapport du dernier build (lecture d'avant, gardée) ──────────────────
  app.get("/admin/build/rapport", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    const e = await etatBuild();
    const lu = await lireJson(RAPPORT);
    if (lu.erreur) return reply.send({ ok: true, ...e, rapport: null, erreur: "rapport illisible : " + lu.erreur });
    return reply.send({ ok: true, ...e, rapport: lu.v });
  });

  // ── Le journal du build, par morceaux (lecture d'avant, gardée) ────────────
  app.get("/admin/build/journal", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    const depuis = Math.max(0, Number(req.query?.depuis ?? 0) || 0);
    let taille = 0;
    try { taille = (await fs.stat(JOURNAL)).size; } catch {
      return reply.send({ ok: true, depuis: 0, taille: 0, texte: "", ...(await etatBuild()) });
    }
    // Le script vide le journal à chaque build : si la taille a diminué, on repart de zéro.
    const debut = depuis > taille ? 0 : depuis;
    let texte = "";
    if (taille > debut) {
      const fh = await fs.open(JOURNAL, "r");
      try {
        const tampon = Buffer.alloc(taille - debut);
        await fh.read(tampon, 0, tampon.length, debut);
        texte = mots(tampon.toString("utf8"));
      } finally { await fh.close(); }
    }
    return reply.send({ ok: true, depuis: debut, taille, texte, ...(await etatBuild()) });
  });

  // ── La demande de build ────────────────────────────────────────────────────
  app.post("/admin/build/demande", async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    const e = await etatBuild();
    if (e.etat === "en_cours") return reply.code(409).send({ ok: false, msg: "Un build est déjà en cours : attends sa fin." });
    // Un build pendant une publication récrirait le staging en pleine copie.
    const p = await etatPublication({ etat: e.etat }, null);
    const tFlag = await dateDe(FLAG_COPIE);
    if ((p.vue && p.vue.etat === "en_cours") || (tFlag !== null && (Date.now() - tFlag) / 1000 <= DEMANDE_MAX_S)) {
      return reply.code(409).send({ ok: false, msg: "Une publication est en cours : attends sa fin avant de lancer un build." });
    }
    const err = await deposer(FLAG_BUILD);
    if (err) return reply.code(500).send({ ok: false, msg: "Impossible de déposer la demande : " + err });
    return reply.send({ ok: true, msg: "Build demandé : il démarre dans la seconde." });
  });

  // ── La publication complète ────────────────────────────────────────────────
  // Les refus sont décidés ici ET répétés par le script de copie : un garde-fou qui ne vit que dans le navigateur
  // n'en est pas un, et le script se lance aussi à la main.
  const publier = async (req: any, reply: any) => {
    if (!garde(req, reply)) return reply;
    const e = await etatBuild();
    if (e.etat === "en_cours") {
      return reply.code(409).send({ ok: false, msg: "Un build est en cours : attends son rapport avant de publier." });
    }
    // Un build mort en route laisse un staging à moitié écrit, et le rapport du build d'avant : rien à publier.
    if (e.etat !== "termine") {
      return reply.code(409).send({ ok: false, msg: e.etat === "jamais" ? "Aucun build : rien à publier."
        : e.cause ? "Le build demandé n'a pas démarré (" + e.cause + ") : rien n'a été lancé."
        : "Le dernier build s'est arrêté en route : relance un build avant de publier." });
    }
    const tFlag = await dateDe(FLAG_COPIE);
    if (tFlag !== null) {
      const age = (Date.now() - tFlag) / 1000;
      return reply.code(409).send({ ok: false, msg: age <= DEMANDE_MAX_S
        ? "Une demande de publication vient d'être déposée : elle démarre dans la seconde."
        : "Une demande de publication attend depuis " + duree(age) + " : le service systemd ne l'a pas prise. Rien n'a été lancé." });
    }
    const p = await etatPublication({ etat: e.etat }, null);
    if (p.vue && p.vue.etat === "en_cours") {
      return reply.code(409).send({ ok: false, msg: "Une publication est déjà en cours : attends sa fin." });
    }
    const lu = await lireJson(RAPPORT);
    const r = lu.v;
    if (!r) return reply.code(409).send({ ok: false, msg: "Aucun rapport de build lisible : rien à publier." });
    if (r.ok !== true) return reply.code(409).send({ ok: false, msg: "Le dernier build a échoué : rien à publier." });
    if (r.promouvable !== true) {
      return reply.code(409).send({ ok: false, msg: "Le dernier build n'est pas publiable" +
        (Array.isArray(r.alertes) && r.alertes.length ? " : " + r.alertes.map((a: any) => mots(String(a))).join(", ") : "") + "." });
    }
    // La marque d'abord : le script de copie la cherche dès que le drapeau apparaît.
    const err = await deposer(MARQUE);
    if (err) return reply.code(500).send({ ok: false, msg: "Impossible de déposer la demande : " + err });
    const err2 = await deposer(FLAG_COPIE);
    if (err2) {
      await fs.rm(MARQUE, { force: true }).catch(() => undefined);
      return reply.code(500).send({ ok: false, msg: "Impossible de déposer la demande : " + err2 });
    }
    return reply.send({ ok: true, msg: "Publication demandée : copie, redémarrage de l'API, rechargement de nginx, vérification en ligne." });
  };
  app.post("/admin/build/publier", publier);
  // L'ancien nom du geste : une page restée ouverte avant ce patch fait aussi la publication complète.
  app.post("/admin/build/promouvoir", publier);

  app.log.info("publication: lecture du build, demandes de build et de publication complète actives");
}
