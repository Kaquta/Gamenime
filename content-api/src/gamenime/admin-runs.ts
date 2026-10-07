/**
 * GameNime — Journal et verrou des process d'administration.
 *
 * POURQUOI CE MODULE EXISTE
 * Les process etaient lances par un simple fetch depuis le dashboard, et rien
 * d'autre. Aucune trace cote serveur. Trois consequences, toutes constatees :
 *
 *  1. Un process plus long que le timeout de la passerelle rendait une erreur
 *     au navigateur alors qu'il continuait de tourner. « Trailers des sortis »
 *     portait un echec « timeout apres 60 s » : le process avait peut-etre
 *     abouti, personne ne pouvait le savoir.
 *  2. Les boutons etaient desactives cote navigateur SEULEMENT. Un second
 *     onglet relancait le meme process par-dessus le premier — deux ecritures
 *     concurrentes sur les memes lignes.
 *  3. Aucun historique. Le bouton ne disait ni quand le process avait tourne,
 *     ni ce qu'il avait change. On cliquait a l'aveugle.
 *
 * LE REMEDE
 * `admin_runs` garde une ligne par execution, `admin_lock` une seule ligne qui
 * dit qui occupe la machine. Deux hooks Fastify font le travail : aucun des
 * handlers existants n'est touche, donc rien de ce qui marche ne peut casser.
 *
 * Le verrou se libere seul au bout de LIMITE_VERROU_MIN minutes : si l'API
 * meurt en plein process, la machine n'est pas bloquee pour toujours. Et au
 * demarrage, toute execution restee « en_cours » passe a « interrompu » — un
 * process tue par un redeploiement ne doit pas rester eternellement en cours.
 *
 * CE QUE CE MODULE NE FAIT PAS
 *  - Il n'interrompt rien. Un bouton « Interrompre » ne pourra que liberer le
 *    verrou et marquer l'execution « interrompu » : le travail en cours, lui,
 *    continuera jusqu'a son terme cote serveur. Interrompre pour de vrai
 *    demanderait que chaque handler verifie un drapeau d'annulation.
 *  - `generate-slugs` fait partie des process verrouilles, et build-staging.sh
 *    l'appelle. Si un process occupe la machine, l'etape slugs du build recevra
 *    un 409 et le script le signalera. C'est voulu : mieux vaut un build qui
 *    dit non qu'un build qui ecrit par-dessus un autre process.
 *
 * Hypothese assumee : une seule instance d'API. La liberation du verrou au
 * demarrage serait fausse en cluster ; il faudrait alors une election de
 * leader, ou supprimer ce reset et laisser le timeout faire le travail.
 */

// Les process lourds : ceux qui ecrivent beaucoup ou qui durent. Les actions
// rapides et interactives (refetch-one depuis une fiche, test-email,
// run-health-check) ne sont volontairement pas de la liste : les bloquer
// pendant un gros process generait sans rien proteger.
export const PROCESS_LOURDS: string[] = [
  "refetch-incomplete",
  "refetch-incomplete-games",
  "refetch-youtube-released",
  "lookup-anilist-ids",
  "quality-check-j7",
  "match-orphan-games",
  "merge-duplicates",
  "cleanup-niches",
  "sanitize-platforms",
  "link-igdb-by-slug",
  "retag-dlc",
  "match-anime-routes",
  "apply-franchise-floors",
  "generate-slugs",
];

const LIMITE_VERROU_MIN = 30;

// Taille maximale du JSON de resultat conserve, en OCTETS et non en
// caracteres : MEDIUMTEXT se compte en octets, et un caractere accentue en
// utf8mb4 en vaut jusqu'a quatre. Tronquer par caracteres pouvait donc faire
// echouer l'INSERT en mode strict — et perdre precisement la trace qu'on
// cherche a conserver. (VARCHAR, lui, se compte en caracteres : `resume` n'a
// pas ce probleme.)
const RESULTAT_MAX_OCTETS = 200000;

// Tronque une chaine utf8 a une frontiere de caractere, sans jamais couper un
// caractere multi-octets au milieu.
function tronquerOctets(s: string | null, max: number): string | null {
  if (s == null) return null;
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let fin = max;
  // On recule tant que l'octet exclu est une continuation (10xxxxxx) : on
  // s'arrete donc juste avant un octet de tete.
  while (fin > 0) {
    const octet = buf[fin];
    if (octet === undefined || (octet & 0xc0) !== 0x80) break;
    fin--;
  }
  return buf.subarray(0, fin).toString("utf8");
}

function nomProcess(req: any): string | null {
  if (req.method !== "POST") return null;
  const chemin = String(req.url || "").split("?")[0].replace(/\/+$/, "");
  const m = /^\/admin\/([a-z0-9-]+)$/.exec(chemin);
  if (!m) return null;
  const nom = m[1];
  if (!nom) return null;
  return PROCESS_LOURDS.indexOf(nom) !== -1 ? nom : null;
}

// Resume lisible tire de la reponse du process. Le dashboard affichera cette
// ligne sous le bouton : « il y a 3 j · 41 s · 12 completes, 4 erreurs ».
function resumer(brut: string | null, ok: boolean, code: number): string {
  if (!ok) {
    try {
      const j = JSON.parse(brut || "{}");
      const m = j.msg || j.error || j.message;
      return "echec HTTP " + code + (m ? " : " + String(m).slice(0, 180) : "");
    } catch {
      return "echec HTTP " + code;
    }
  }
  try {
    const j = JSON.parse(brut || "{}");
    const paires: Array<[string, string]> = [
      ["scanned", "examines"], ["enriched", "completes"], ["updated", "mis a jour"],
      ["matched", "apparies"], ["merged", "fusionnes"], ["deleted", "supprimes"],
      ["signales", "signales"], ["found", "trouves"], ["total", "total"],
      ["errors", "erreurs"],
    ];
    const bouts: string[] = [];
    for (const [cle, mot] of paires) {
      if (typeof j[cle] === "number") bouts.push(j[cle] + " " + mot);
    }
    if (j.anime_items && typeof j.anime_items.generes === "number") {
      bouts.push(j.anime_items.generes + " slugs anime");
    }
    if (j.game_items && typeof j.game_items.generes === "number") {
      bouts.push(j.game_items.generes + " slugs jeux");
    }
    if (Array.isArray(j.changes)) bouts.push(j.changes.length + " changements");
    return bouts.length ? bouts.join(", ") : "termine";
  } catch {
    return "termine";
  }
}

export async function registerAdminRuns(app: any, pool: any): Promise<void> {
  // ── 1. Les tables ────────────────────────────────────────────────────────
  await pool.query(
    "CREATE TABLE IF NOT EXISTS admin_runs (" +
    "  id INT UNSIGNED NOT NULL AUTO_INCREMENT," +
    "  process VARCHAR(64) NOT NULL," +
    "  etat ENUM('en_cours','reussi','echoue','interrompu') NOT NULL DEFAULT 'en_cours'," +
    "  debut DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
    "  fin DATETIME NULL DEFAULT NULL," +
    "  duree_ms INT UNSIGNED NULL DEFAULT NULL," +
    "  code_http SMALLINT UNSIGNED NULL DEFAULT NULL," +
    "  resume VARCHAR(255) NULL DEFAULT NULL," +
    "  resultat MEDIUMTEXT NULL DEFAULT NULL," +
    "  PRIMARY KEY (id)," +
    "  KEY k_process_debut (process, debut)," +
    "  KEY k_etat (etat)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS admin_lock (" +
    "  id TINYINT UNSIGNED NOT NULL," +
    "  process VARCHAR(64) NULL DEFAULT NULL," +
    "  run_id INT UNSIGNED NULL DEFAULT NULL," +
    "  pris_a DATETIME NULL DEFAULT NULL," +
    "  PRIMARY KEY (id)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  );
  await pool.query("INSERT IGNORE INTO admin_lock (id) VALUES (1)");

  // ── 2. Les executions orphelines d'un redemarrage ────────────────────────
  // LEAST : duree_ms est un INT UNSIGNED, soit 49,7 jours en millisecondes.
  // Une ligne restee « en_cours » plus longtemps ferait deborder la colonne,
  // l'UPDATE echouerait en bloc et les laisserait toutes « en_cours ».
  const orph = await pool.query(
    "UPDATE admin_runs SET etat = 'interrompu', fin = NOW()," +
    " duree_ms = LEAST(TIMESTAMPDIFF(SECOND, debut, NOW()), 4294967) * 1000," +
    " resume = 'interrompu : API redemarree pendant l execution'" +
    " WHERE etat = 'en_cours'"
  );
  const nOrph = orph && orph.affectedRows ? Number(orph.affectedRows) : 0;
  if (nOrph > 0) app.log.warn({ nOrph }, "admin-runs: executions orphelines marquees interrompues");
  await pool.query("UPDATE admin_lock SET process = NULL, run_id = NULL, pris_a = NULL WHERE id = 1");

  // ── 3. Prise du verrou et ouverture de la ligne ──────────────────────────
  app.addHook("preHandler", async (req: any, reply: any) => {
    const nom = nomProcess(req);
    if (!nom) return;

    // Un seul UPDATE conditionnel : la prise est atomique, deux requetes
    // simultanees ne peuvent pas l'obtenir toutes les deux.
    const pris = await pool.query(
      "UPDATE admin_lock SET process = ?, run_id = NULL, pris_a = NOW()" +
      " WHERE id = 1 AND (process IS NULL OR pris_a < NOW() - INTERVAL " + LIMITE_VERROU_MIN + " MINUTE)",
      [nom]
    );
    if (!pris || Number(pris.affectedRows) !== 1) {
      const lignes = await pool.query(
        "SELECT process, TIMESTAMPDIFF(SECOND, pris_a, NOW()) AS depuis_s FROM admin_lock WHERE id = 1"
      );
      const t = (lignes && lignes[0]) || {};
      return reply.code(409).send({
        ok: false,
        verrou: true,
        detenu_par: t.process || null,
        depuis_s: t.depuis_s == null ? null : Number(t.depuis_s),
        msg: "Un autre process occupe la machine : " + (t.process || "inconnu") +
             ", depuis " + (t.depuis_s == null ? "?" : Number(t.depuis_s)) + " s. Reessayez a la fin.",
      });
    }

    const ins = await pool.query("INSERT INTO admin_runs (process) VALUES (?)", [nom]);
    const runId = ins && ins.insertId != null ? Number(ins.insertId) : null;
    if (runId) await pool.query("UPDATE admin_lock SET run_id = ? WHERE id = 1", [runId]);
    req.gnRun = { id: runId, process: nom, t0: Date.now() };
  });

  // ── 4. Fermeture de la ligne et liberation ───────────────────────────────
  // onSend et non onResponse : c'est le seul hook qui voit la reponse, donc le
  // seul qui peut en tirer un resume. Il tourne meme si le client a raccroche,
  // ce qui est precisement le cas qu'on veut couvrir.
  app.addHook("onSend", async (req: any, reply: any, payload: any) => {
    const run = req.gnRun;
    if (!run) return payload;
    req.gnRun = null;
    const code = Number(reply.statusCode) || 0;
    const ok = code >= 200 && code < 300;
    const brut = typeof payload === "string" ? payload : null;
    try {
      if (run.id) {
        await pool.query(
          "UPDATE admin_runs SET etat = ?, fin = NOW(), duree_ms = ?, code_http = ?, resume = ?, resultat = ?" +
          " WHERE id = ?",
          [ok ? "reussi" : "echoue", Date.now() - run.t0, code,
           resumer(brut, ok, code).slice(0, 255),
           tronquerOctets(brut, RESULTAT_MAX_OCTETS),
           run.id]
        );
      }
    } catch (e: any) {
      app.log.error({ err: e?.message }, "admin-runs: fermeture de la ligne impossible");
    }
    try {
      await pool.query(
        "UPDATE admin_lock SET process = NULL, run_id = NULL, pris_a = NULL WHERE id = 1" +
        (run.id ? " AND run_id = " + Number(run.id) : "")
      );
    } catch (e: any) {
      app.log.error({ err: e?.message }, "admin-runs: liberation du verrou impossible");
    }
    return payload;
  });

  // ── 5. Lecture : derniere execution de chaque process, et le verrou ──────
  app.get("/admin/runs", async (_req: any, reply: any) => {
    const lignes = await pool.query(
      "SELECT r.process, r.etat, r.code_http, r.resume, r.duree_ms," +
      " UNIX_TIMESTAMP(r.debut) AS debut_ts, UNIX_TIMESTAMP(r.fin) AS fin_ts" +
      " FROM admin_runs r" +
      " JOIN (SELECT process, MAX(id) AS id FROM admin_runs GROUP BY process) d ON d.id = r.id"
    );
    const derniers: any = {};
    for (const r of lignes || []) {
      derniers[r.process] = {
        etat: r.etat,
        code: r.code_http == null ? null : Number(r.code_http),
        resume: r.resume || null,
        duree_ms: r.duree_ms == null ? null : Number(r.duree_ms),
        debut: r.debut_ts == null ? null : Number(r.debut_ts) * 1000,
        fin: r.fin_ts == null ? null : Number(r.fin_ts) * 1000,
      };
    }
    const vl = await pool.query(
      "SELECT process, run_id, UNIX_TIMESTAMP(pris_a) AS pris_ts," +
      " TIMESTAMPDIFF(SECOND, pris_a, NOW()) AS depuis_s FROM admin_lock WHERE id = 1"
    );
    const v = (vl && vl[0]) || {};
    return reply.send({
      ok: true,
      process: PROCESS_LOURDS,
      derniers,
      verrou: v.process ? {
        process: v.process,
        run_id: v.run_id == null ? null : Number(v.run_id),
        pris_a: v.pris_ts == null ? null : Number(v.pris_ts) * 1000,
        depuis_s: v.depuis_s == null ? null : Number(v.depuis_s),
      } : null,
    });
  });

  app.log.info({ process: PROCESS_LOURDS.length, mono_instance: true },
    "admin-runs: journal et verrou actifs (verrou valable pour une seule instance d API)");
}
