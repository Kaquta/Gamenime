/**
 * GameNime — Lecture du build et demande de publication.
 *
 * L'API tourne dans un conteneur, le build tourne sur l'hote : elle ne peut pas
 * lancer `astro build`, ce n'est pas sa machine. Elle depose donc un fichier
 * dans /data/publish, une unite systemd.path le voit apparaitre et lance le
 * build dans la seconde. Aucun privilege donne au conteneur, aucun cron.
 *
 * COMMENT ON SAIT QU'UN BUILD TOURNE
 * Pas de drapeau "en cours" a maintenir — un drapeau qu'un crash laisse en
 * place mentirait indefiniment. On lit les deux fichiers que le script ecrit :
 * il vide build.log au debut et ecrit report.json a la fin. Donc
 *   journal plus recent que rapport  -> un build est en cours,
 *   rapport au moins aussi recent    -> le dernier build est termine.
 * Et si le journal n'a pas bouge depuis SILENCE_MAX_S alors que le rapport est
 * plus vieux, le build est mort en route : on le dit, au lieu d'afficher
 * "en cours" pour l'eternite.
 */

import { promises as fs } from "fs";

const DOSSIER_BUILD = "/data/build";
const DOSSIER_FLAGS = "/data/publish";
const JOURNAL = DOSSIER_BUILD + "/build.log";
const RAPPORT = DOSSIER_BUILD + "/report.json";
const FLAG_BUILD = DOSSIER_FLAGS + "/demande-build";
const FLAG_PROMOTE = DOSSIER_FLAGS + "/demande-promote";

// Au-dela, un journal qui n'avance plus sans rapport signifie un build mort.
const SILENCE_MAX_S = 180;

async function dateDe(chemin: string): Promise<number | null> {
  try { return (await fs.stat(chemin)).mtimeMs; } catch { return null; }
}

// Le script ecrit report.json PUIS ajoute deux lignes au journal. Le journal
// est donc TOUJOURS un peu plus recent que le rapport, de quelques dizaines de
// microsecondes. Comparer les deux dates sans tolerance faisait passer un build
// termine pour un build en cours, puis pour un build interrompu au bout de
// trois minutes — un tirage au sort a chaque build, selon que les deux
// ecritures tombaient ou non dans la meme milliseconde.
const TOLERANCE_MS = 3000;

// Second critere, independant du temps : le script finit toujours par ecrire
// "rapport : <chemin>" dans le journal. Si cette ligne est la, le build est
// alle au bout, quelles que soient les dates.
async function journalTermine(): Promise<boolean> {
  try {
    const st = await fs.stat(JOURNAL);
    const debut = Math.max(0, st.size - 400);
    const fh = await fs.open(JOURNAL, "r");
    try {
      const b = Buffer.alloc(st.size - debut);
      await fh.read(b, 0, b.length, debut);
      return b.toString("utf8").indexOf("rapport :") !== -1;
    } finally { await fh.close(); }
  } catch { return false; }
}

async function etatBuild(): Promise<any> {
  const [tJ, tR] = await Promise.all([dateDe(JOURNAL), dateDe(RAPPORT)]);
  if (tJ === null) return { etat: "jamais", journal_ts: null, rapport_ts: tR };

  // Un build en cours ecrit dans le journal en continu, donc un rapport encore
  // valable est au pire a quelques secondes de la derniere ligne. Un rapport
  // perime, lui, a des minutes ou des heures de retard : la tolerance separe
  // proprement les deux cas.
  const dateProche = tR !== null && tR >= tJ - TOLERANCE_MS;
  if (dateProche || (await journalTermine())) {
    return { etat: "termine", journal_ts: tJ, rapport_ts: tR };
  }
  const silence = Math.round((Date.now() - tJ) / 1000);
  return {
    etat: silence > SILENCE_MAX_S ? "interrompu" : "en_cours",
    journal_ts: tJ, rapport_ts: tR, silence_s: silence,
  };
}

export function registerPublication(app: any): void {
  // ── Le rapport du dernier build ────────────────────────────────────────────
  app.get("/admin/build/rapport", async (_req: any, reply: any) => {
    const e = await etatBuild();
    let rapport: any = null;
    let brut: string | null = null;
    try {
      brut = await fs.readFile(RAPPORT, "utf8");
      rapport = JSON.parse(brut);
    } catch (err: any) {
      // Un rapport illisible n'est pas un rapport absent : la nuance compte
      // pour savoir s'il faut relancer ou reparer.
      if (brut !== null) {
        return reply.send({ ok: true, ...e, rapport: null,
          erreur: "rapport illisible : " + (err?.message || "JSON invalide") });
      }
    }
    return reply.send({ ok: true, ...e, rapport });
  });

  // ── Le journal, par morceaux ───────────────────────────────────────────────
  // Le dashboard rappelle avec le decalage qu'on lui rend : il ne relit jamais
  // ce qu'il a deja affiche, et le journal defile comme un terminal.
  app.get("/admin/build/journal", async (req: any, reply: any) => {
    const depuis = Math.max(0, Number(req.query?.depuis ?? 0) || 0);
    let taille = 0;
    try { taille = (await fs.stat(JOURNAL)).size; } catch {
      return reply.send({ ok: true, depuis: 0, taille: 0, texte: "", ...(await etatBuild()) });
    }
    // Le script vide le journal a chaque build : si la taille a diminue, le
    // decalage du client appartient a un build precedent, on repart de zero.
    const debut = depuis > taille ? 0 : depuis;
    let texte = "";
    if (taille > debut) {
      const fh = await fs.open(JOURNAL, "r");
      try {
        const tampon = Buffer.alloc(taille - debut);
        await fh.read(tampon, 0, tampon.length, debut);
        texte = tampon.toString("utf8");
      } finally { await fh.close(); }
    }
    return reply.send({ ok: true, depuis: debut, taille, texte, ...(await etatBuild()) });
  });

  // ── La demande de build ────────────────────────────────────────────────────
  app.post("/admin/build/demande", async (_req: any, reply: any) => {
    const e = await etatBuild();
    if (e.etat === "en_cours") {
      return reply.code(409).send({ ok: false, ...e,
        msg: "Un build est deja en cours. Attendez sa fin." });
    }
    try {
      await fs.writeFile(FLAG_BUILD, new Date().toISOString() + "\n", "utf8");
    } catch (err: any) {
      return reply.code(500).send({ ok: false,
        msg: "Impossible de deposer la demande : " + (err?.message || "erreur") +
             ". Le volume /data/publish est-il monte en ecriture ?" });
    }
    return reply.send({ ok: true, msg: "Demande deposee. systemd lance le build dans la seconde." });
  });

  // ── La promotion ───────────────────────────────────────────────────────────
  // Le refus est decide ici ET repete dans promote.sh : un garde-fou qui ne vit
  // que dans le navigateur n'en est pas un, et le script est lancable a la main.
  app.post("/admin/build/promouvoir", async (_req: any, reply: any) => {
    const e = await etatBuild();
    if (e.etat === "en_cours") {
      return reply.code(409).send({ ok: false, ...e,
        msg: "Un build est en cours : attendez son rapport avant de publier." });
    }
    // Un drapeau deja present signifie une promotion en attente. systemd ne
    // lance jamais deux instances du meme service en parallele, donc le risque
    // n'est pas deux rsync concurrents mais un second rsync inutile juste
    // apres le premier. Autant ne pas le demander.
    try {
      await fs.access(FLAG_PROMOTE);
      return reply.code(409).send({ ok: false, ...e,
        msg: "Une promotion est deja en attente ou en cours." });
    } catch { /* ENOENT : la voie est libre */ }

    let r: any = null;
    try { r = JSON.parse(await fs.readFile(RAPPORT, "utf8")); } catch {
      return reply.code(409).send({ ok: false, ...e,
        msg: "Aucun rapport de build lisible : rien a promouvoir." });
    }
    if (r.promouvable !== true) {
      return reply.code(409).send({ ok: false, ...e, rapport: r,
        msg: "Le dernier build n'est pas promouvable" +
             (Array.isArray(r.alertes) && r.alertes.length
               ? " : " + r.alertes.join(", ") : "") + "." });
    }
    try {
      await fs.writeFile(FLAG_PROMOTE, new Date().toISOString() + "\n", "utf8");
    } catch (err: any) {
      return reply.code(500).send({ ok: false,
        msg: "Impossible de deposer la demande : " + (err?.message || "erreur") });
    }
    return reply.send({ ok: true,
      msg: "Promotion demandee. La production servira " + (r.staging?.sitemap ?? "?") +
           " URLs et " + (r.staging?.liens ?? "?") + " liens." });
  });

  app.log.info("publication: lecture du build et demande de publication actives");
}
