/**
 * GameNime — Pilotage des modules automatiques (section « Pilotage » du dashboard, patch du 17 octobre 2026).
 *
 * Demande de Rey (17 octobre 2026) : « je veux avoir le contrôle sur tout dorénavant via le dashboard ».
 * Ce module :
 *  - tient le registre des 33 lignes du Pilotage : 27 cycles de l'API, 4 tâches de n8n, les images HD (tâche de
 *    l'hôte) et le synopsis (piloté par son propre travail) ;
 *  - planifie les cycles de l'API à la place de leurs setTimeout/setInterval : interrupteur à chaud (en base : plus
 *    besoin de .env ni de redémarrage), lancement immédiat, pause générale, un seul passage à la fois par module
 *    (le cycle automatique et le lancement à la main prennent le même verrou) ;
 *  - garde les passages (pilotage_passages) et le journal (pilotage_journal) : ils survivent aux redémarrages ;
 *  - note ce que n8n envoie à l'API (envois d'animés et de jeux, rappels, alertes, recherche des doublons) ;
 *  - sert GET /admin/pilotage et les gestes POST /admin/pilotage/{basculer,lancer,pause}, avec un contrôle de clé
 *    dans l'API (nginx ajoute la clé sur /dashboard/admin/, derrière le mot de passe du staging).
 *
 * Les interrupteurs de .env ne servent plus qu'à la première mise en route : leur valeur est recopiée en base au
 * premier démarrage, puis seul le Pilotage les change.
 * Les instants sont gardés en millisecondes (BIGINT) : l'API tourne en UTC, la base à l'heure de Paris ; aucune
 * conversion de fuseau n'entre en jeu. Les textes montrés sont à l'heure de Paris.
 * Une panne de la base ne coupe aucun cycle : le Pilotage garde son état en mémoire et réessaie d'écrire.
 */
import type { FastifyInstance } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getLastRun } from "./dashboard.js";

// ─────────────────────────────────────────────────────────────── types

/** Ce qu'un passage peut rendre au planificateur. */
export interface RetourPassage {
  /** Le bilan du passage, quand le module ne le donne pas par trackLastRun (clé « suivi »). */
  bilan?: Record<string, any>;
  /** Contrôle sans travail (« passage récent ») : rien n'est noté dans l'historique. */
  rien?: boolean;
  /** Le prochain passage automatique plus tôt que prévu (nouvel essai après un échec, verrou pris). */
  reessayerDansMs?: number;
}

/** La définition d'un cycle de l'API, donnée par son module au démarrage. */
export interface DefModule {
  id: string;
  /** Délai du premier passage après le démarrage (null : pas de rattrapage, heures fixes seulement). */
  premierMs: number | null;
  /** Rythme : un passage toutes les rythmeMs… */
  rythmeMs?: number;
  /** … ou à heures fixes, en heures UTC décimales (5.5 = 5 h 30 UTC). */
  heuresUtc?: number[];
  /** Valeur de l'interrupteur à la première mise en route (lue dans .env par le module). */
  actifParDefaut?: boolean;
  /** Clé trackLastRun du module : le bilan du passage y est lu. */
  suivi?: string;
  /** Le process d'administration qui fait le même travail (ancienne route POST /admin/<process>). */
  processAdmin?: string;
  /** Le module ne passe que si celui-ci est allumé. */
  dependDe?: string;
  passage: (ctx: { manuel: boolean }) => Promise<RetourPassage | void>;
  quandCoupe?: () => Promise<void> | void;
  quandRallume?: () => Promise<void> | void;
  /** Chiffres vivants pour l'affichage (crédits Tavily…), relus au plus toutes les 30 s. */
  infos?: () => Promise<Record<string, any>> | Record<string, any>;
}

type Niveau = "o" | "m" | "k" | "n";
type Declencheur = "auto" | "manuel" | "n8n";

interface Passage {
  id: number;
  module: string;
  declencheur: Declencheur;
  debut: number;
  fin: number | null;
  duree: number | null;
  niveau: Niveau;
  resume: string;
  bilan: Record<string, any> | null;
}

interface Etat {
  def: DefModule;
  minuteur: ReturnType<typeof setTimeout> | null;
  prochain: number | null;
  occupe: { debut: number; declencheur: Declencheur; ligne: number | null } | null;
  /** Repère de la surveillance (santé) : dernière remise en route (interrupteur, fin de pause). */
  reprisLe: number;
  attente: string | null;
  infos: { le: number; v: Record<string, any> } | null;
  /** Le premier passage prévu après le démarrage de l'API (surveillance : pas d'alerte avant qu'il ait eu lieu). */
  premierDu: number | null;
}

interface Presentation {
  res: string;
  nv: Niveau;
  details?: Array<[string, string]>;
  chiffre?: { v: string; l: string } | null;
  alerte?: string | null;
  jauges?: Array<{ l: string; v: number; max: number }>;
  donnees?: { t: string; l: Array<[string, string, string]> } | null;
  notable?: { nv: "ok" | "info" | "warn"; texte: string; detail?: string } | null;
}

interface Fiche {
  id: string;
  fam: string;
  nom: string;
  role: string;
  src: "api" | "n8n" | "hote";
  coupe?: string;
  rallume?: string;
  /** Rythme montré quand il ne vient pas de la définition (n8n, hôte, synopsis). */
  rythme?: string;
  /** Rythme montré à la place du rythme du planificateur (bonus Europe : un contrôle par heure, un passage par jour). */
  rythmeTexte?: string;
  lancerLib?: string;
  lancerNote?: (infos: Record<string, any> | null) => string;
  confirmer?: { titre: string; texte: string; action: string };
  pilote?: { t: string; d: string };
  sansLancer?: string;
  presenter?: (b: Record<string, any>, ctx: { infos: Record<string, any> | null }) => Presentation;
}

// ─────────────────────────────────────────────────────────────── petits outils

const N = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fr = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pl = (n: number, un: string, plusieurs: string): string => `${fr(n)} ${Math.abs(n) > 1 ? plusieurs : un}`;
const coupe = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
// une erreur de la base, sans le numéro de connexion ni la requête : « Unknown column 'x' in 'SELECT' »
const message = (e: unknown): string =>
  coupe(String((e as any)?.message ?? e).split(/\r?\nsql:/)[0].replace(/^\(conn:[^)]*\)\s*/, ""), 200);
const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const HEURE_PARIS = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const heureParis = (t: number): string => HEURE_PARIS.format(new Date(t));
const iso = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString() : null);
/**
 * L'heure d'un DATETIME écrit par NOW() : la base les écrit à l'heure de Paris et le connecteur les relit comme des
 * heures UTC (l'API tourne en UTC) ; les chiffres de l'heure sont donc ceux de Paris, lus tels quels.
 */
const heureMur = (v: unknown): string => {
  if (v instanceof Date && Number.isFinite(v.getTime())) return `${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}`;
  const m = /\b(\d{2}):(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[1]}:${m[2]}` : "";
};
const MIN = 60 * 1000;
const H = 60 * MIN;
/** Essais seulement : les délais du planificateur divisés par PILOTAGE_ESSAI_ECHELLE (absent de docker-compose). */
const ECHELLE = Math.min(10000, Math.max(1, Number(process.env.PILOTAGE_ESSAI_ECHELLE) || 1));
const ms = (x: number): number => Math.max(1, Math.round(x / ECHELLE));

/** « AnimeSchedule : HTTP 503 », sans répéter le nom du service quand l'erreur le donne déjà. */
const prefixe = (nom: string, e: string): string => (e.toLowerCase().startsWith(nom.toLowerCase()) ? e : `${nom} : ${e}`);

/** Le bilan rendu par un module peut porter son erreur sous plusieurs noms. */
const erreurDe = (b: Record<string, any>): string | null => {
  const e = b.erreur ?? b.error;
  return e ? coupe(e, 160) : null;
};

// ─────────────────────────────────────────────────────────────── le registre

const FAMILLES = [
  { id: "entree", nom: "Entrée du catalogue", sous: "Comment les titres arrivent et se complètent." },
  { id: "plateformes", nom: "Plateformes et sorties en France", sous: "Ce qui fait apparaître un titre sur le site." },
  { id: "classements", nom: "Popularité et classements", sous: "Top 25, Top 150, bonus Europe." },
  { id: "contenus", nom: "Contenus", sous: "Textes et images." },
  { id: "univers", nom: "Univers", sous: "Licences et alertes d'univers." },
  { id: "surveillance", nom: "Surveillance et comptes", sous: "Alertes, rappels, épisodes et dates des favoris, notifications sur l'appareil, sessions." },
];

const presenterLot = (quoi: string): Fiche["presenter"] => (b) => {
  const lus = N(b.scanned), ok = N(b.enriched), err = N(b.errors);
  return {
    res: `${pl(lus, "lu", "lus")} · ${pl(ok, "complété", "complétés")}` + (err ? ` · ${pl(err, "erreur", "erreurs")}` : ""),
    nv: lus === 0 ? "n" : err >= lus ? "k" : err ? "m" : "o",
    details: [[quoi, fr(lus)], ["Complétés", fr(ok)], ["Erreurs", fr(err)]],
    chiffre: { v: fr(ok), l: ok > 1 ? "complétés au dernier passage" : "complété au dernier passage" },
  };
};

const presenterEnvois = (b: Record<string, any>): Presentation => {
  const total = N(b.total), filtres = N(b.filtres), sources: Record<string, number> = b.sources || {};
  const noms: Record<string, string> = { anilist: "AniList", animeschedule: "AnimeSchedule", igdb: "IGDB", rawg: "RAWG", unknown: "Autre" };
  const details: Array<[string, string]> = Object.keys(sources).sort().map((s) => [noms[s] || s, pl(N(sources[s]), "reçu", "reçus")]);
  details.push(["Filtrés", fr(filtres)], ["Envois", fr(N(b.appels))]);
  return {
    res: `${pl(total, "reçu", "reçus")} · ${pl(filtres, "filtré", "filtrés")}`,
    nv: N(b.code) >= 400 ? "k" : "o",
    details,
    chiffre: { v: fr(total), l: total > 1 ? "reçus au dernier envoi" : "reçu au dernier envoi" },
    alerte: N(b.code) >= 400 ? `Dernier envoi refusé par l'API (HTTP ${N(b.code)}).` : null,
  };
};

/**
 * Synopsis (v9.5) : ce qu'a fait le dernier passage (détails), et les chiffres du bloc Synopsis relus en direct (infos),
 * montrés à part. Un passage enregistré porte toujours « code » (la version du module) ; sans lui, seuls les chiffres.
 */
const presenterSynopsis = (b: Record<string, any>, ctx: { infos: Record<string, any> | null }): Presentation => {
  const i = ctx.infos || {}, e = erreurDe(b), passe = b.code !== undefined && b.code !== null;
  // une demande ignorée (version dépassée, illisible) compte avec les échecs : la carte du bloc en dit la raison
  const red = N(b.rediges), cor = N(b.corriges), ech = N(b.correctionsEchec) + N(b.demandesIgnorees), remis = N(b.remis), av = N(i.aValider);
  const ol = b.ollama ? coupe(b.ollama, 120) : null;
  const fins: Record<string, string> = {
    vide: "plus rien à rédiger", limite: "limite du passage atteinte", fenetre: "fin de la fenêtre horaire",
    coupe: "coupé ou mis en pause", ollama: "Ollama ne répond pas",
  };
  const details: Array<[string, string]> = [];
  if (passe) {
    details.push(["Rédigés", fr(red)], ["Corrections", fr(cor + ech) + (ech ? ` (${fr(ech)} en échec)` : "")]);
    if (N(b.sansSource) + N(b.echecs)) details.push(["Sans source · échecs", `${fr(N(b.sansSource))} · ${fr(N(b.echecs))}`]);
    if (remis) details.push(["Remis au passage suivant", fr(remis)]);
    if (N(b.demandesAnnulees)) details.push(["Demandes annulées en route", fr(N(b.demandesAnnulees))]);
    if (b.fin && fins[String(b.fin)]) details.push(["Arrêt", fins[String(b.fin)] as string]);
  }
  const parts = [red || !(cor + ech) ? pl(red, "rédigé", "rédigés") : "", cor ? pl(cor, "corrigé", "corrigés") : "", ech ? `${fr(ech)} correction${ech > 1 ? "s" : ""} en échec` : "", ol ? "Ollama en attente" : ""];
  const bloc: Array<[string, string, string]> = [
    ["", "À valider", fr(av)], ["", "Validés", fr(N(i.valides))], ["", "En correction", fr(N(i.correction))],
    ["", "Sans source", fr(N(i.sansSource))], ["", "Pas encore traités", fr(N(i.pasTraites))],
  ];
  return {
    res: e ? `erreur : ${e}` : parts.filter(Boolean).join(" · "),
    nv: e ? "k" : ol || remis ? "m" : red + cor + ech === 0 ? "n" : "o",
    ...(details.length ? { details } : {}),
    chiffre: { v: fr(av), l: "synopsis à valider" },
    donnees: ctx.infos ? { t: "Dans le bloc Synopsis", l: bloc } : null,
    alerte: ol ? `Ollama ne répond pas : ${ol} (reprise au prochain passage).` : remis ? `AniList indisponible : ${fr(remis)} synopsis remis au passage suivant.` : null,
    notable: cor + ech ? { nv: ech ? "warn" : "ok", texte: `${pl(cor, "correction faite", "corrections faites")}` + (ech ? `, ${fr(ech)} en échec` : ""), detail: "à relire dans le bloc Synopsis" } : null,
  };
};

const FICHES: Fiche[] = [
  // ── entrée du catalogue
  {
    id: "n8n-animes", fam: "entree", nom: "Envois n8n · animés", src: "n8n",
    role: "AniList et AnimeSchedule envoient les nouveaux animés ; l'API filtre, bloque les doublons connus et ajoute sans écraser",
    rythme: "environ toutes les 3 h (réglé dans n8n)",
    presenter: presenterEnvois,
  },
  {
    id: "n8n-jeux", fam: "entree", nom: "Envois n8n · jeux", src: "n8n",
    role: "IGDB envoie les nouveaux jeux ; mêmes filtres et même blocage des doublons",
    rythme: "environ toutes les 2 h (réglé dans n8n)",
    presenter: presenterEnvois,
  },
  {
    id: "series-en-cours", fam: "entree", nom: "Séries en cours", src: "api",
    role: "Fait entrer les séries japonaises en cours, suivies par 50 000 personnes ou plus, qui manquent au site",
    coupe: "Les longues séries en cours (Détective Conan…) n'entrent plus d'elles-mêmes ; celles déjà au site restent.",
    presenter: (b) => {
      const e = erreurDe(b), nouv = N(b.nouvelles);
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.lues), "lue", "lues")} · ${pl(nouv, "nouvelle", "nouvelles")}`,
        nv: e ? "k" : "o",
        details: [["Séries lues", fr(N(b.lues))], ["Déjà au site", fr(N(b.dejaLa))], ["Bloquées", fr(N(b.bloquees))], ["Envoyées", fr(N(b.envoyees))], ["Nouvelles", fr(nouv)]],
        chiffre: { v: fr(nouv), l: nouv > 1 ? "nouvelles au dernier passage" : "nouvelle au dernier passage" },
        notable: nouv ? { nv: "ok", texte: `${pl(nouv, "nouvelle série", "nouvelles séries")} en cours` } : null,
      };
    },
  },
  {
    id: "igdb-jeux", fam: "entree", nom: "Jeux IGDB", src: "api",
    role: "Rattache les jeux à IGDB, fusionne les doublons, met à jour popularité, note, jaquette et dates",
    coupe: "Les envois de n8n reprennent la main sur la popularité des jeux ; Steam et la découverte s'arrêtent aussi.",
    presenter: (b) => {
      const e = erreurDe(b), fusions = Array.isArray(b.fusions) ? b.fusions : [];
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.avecIgdb), "rattaché", "rattachés")} · ${pl(fusions.length, "fusion", "fusions")}`,
        nv: e ? "k" : "o",
        details: [
          ["Jeux", fr(N(b.jeux))], ["Rattachés à IGDB", fr(N(b.avecIgdb))], ["Popularités écrites", fr(N(b.popularites))], ["Notes écrites", fr(N(b.notes))],
          ["Jaquettes", fr(N(b.jaquettes))], ["Dates corrigées", fr(N(b.dates))], ["Fusions de doublons", fr(fusions.length)], ["Rattachements à vérifier", fr(N(b.douteux))],
        ],
        chiffre: { v: fr(N(b.avecIgdb)), l: "jeux rattachés" },
        alerte: e ? `${prefixe("IGDB", e)} (nouvel essai dans 1 h).` : null,
        notable: fusions.length ? { nv: "info", texte: `${pl(fusions.length, "doublon fusionné", "doublons fusionnés")}`, detail: coupe(fusions.slice(0, 3).join(", "), 200) } : null,
      };
    },
  },
  {
    id: "igdb-decouverte", fam: "entree", nom: "Découverte IGDB", src: "api",
    role: "Ajoute les jeux de la fenêtre que les listes IGDB placeraient dans le Top 150",
    coupe: "Plus aucun jeu n'entre par IGDB ; n8n continue d'envoyer les siens.",
    presenter: (b) => {
      const e = erreurDe(b), aj = Array.isArray(b.ajoutes) ? b.ajoutes : [], sig = Array.isArray(b.signales) ? b.signales : [];
      const ec = b.ecartes || {};
      return {
        res: e ? `erreur : ${e}` : `${pl(aj.length, "ajouté", "ajoutés")} · ${fr(sig.length)} à vérifier`,
        nv: e ? "k" : "o",
        details: [
          ["Candidats", fr(N(b.candidats))], ["Ajoutés", fr(aj.length)], ["À vérifier (pas ajoutés)", fr(sig.length)],
          ["Écartés : sous le seuil", fr(N(ec.sousSeuil))], ["Écartés : hors de la fenêtre", fr(N(ec.horsFenetre))], ["Écartés : sans jaquette", fr(N(ec.sansJaquette))],
        ],
        chiffre: { v: fr(aj.length), l: aj.length > 1 ? "jeux ajoutés au dernier passage" : "jeu ajouté au dernier passage" },
        donnees: aj.length ? { t: "Jeux ajoutés au dernier passage", l: aj.slice(0, 10).map((x: any) => ["", coupe(x?.titre, 80), x?.statut === "sorti" ? "sorti" : "à venir"]) } : null,
        notable: aj.length ? { nv: "ok", texte: `${pl(aj.length, "jeu ajouté", "jeux ajoutés")}`, detail: coupe(aj.slice(0, 5).map((x: any) => x?.titre).join(", "), 200) } : null,
      };
    },
  },
  {
    id: "phase-b-animes", fam: "entree", nom: "Phase B · animés", src: "api",
    role: "Complète jaquette, plateforme, bande-annonce et description des 200 animés incomplets les plus suivis",
    coupe: "Les animés incomplets restent incomplets jusqu'au prochain envoi de n8n.",
    presenter: presenterLot("Animés lus"),
  },
  {
    id: "dates-animes", fam: "entree", nom: "Dates des animés", src: "api",
    role: "Relit chaque heure sur AniList la date et le statut des animés : AniList fait référence ; reporté sans date : « Date à annoncer » ; annulé : retiré du site",
    coupe: "Les dates des animés ne sont plus remises à jour (la Phase B ne relit que les incomplets) ; « Date à annoncer » et « annulé » restent en l'état.",
    presenter: (b) => {
      const e = erreurDe(b), ch = N(b.changees), aa = N(b.aAnnoncer), an = N(b.annules), rl = N(b.relances);
      const sig = Array.isArray(b.signales) ? b.signales : [], chg = Array.isArray(b.changements) ? b.changements : [];
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.lus), "lu", "lus")} · ${pl(ch, "date changée", "dates changées")}` + (aa ? ` · ${fr(aa)} à annoncer` : "") + (an ? ` · ${pl(an, "annulé", "annulés")}` : ""),
        nv: e ? "k" : N(b.echecs) || N(b.absents) || N(b.partiels) || N(b.erreursAS) || N(b.introuvablesAS) >= 2 ? "m" : "o",
        details: [
          ["Animés relus", fr(N(b.lus))], ["Requêtes AniList · AnimeSchedule", `${fr(N(b.requetes))} · ${fr(N(b.requetesAS))}` + (N(b.erreursAS) ? ` (${fr(N(b.erreursAS))} en erreur)` : "") + (N(b.introuvablesAS) ? ` (${fr(N(b.introuvablesAS))} introuvable(s))` : "")], ["Dates changées", fr(ch)], ["Date à annoncer (nouveaux)", fr(aa)], ["Sans date chez AniList, à confirmer", fr(N(b.sansDate))],
          ["Jours confirmés par AnimeSchedule", fr(N(b.confirmes))], ["Jours remplacés par AniList", fr(N(b.nonConfirmes))],
          ["Dates annoncées", fr(N(b.annoncees))], ["Abonnés prévenus", fr(N(b.prevenus))], ["Annulés (retirés)", fr(an)], ["Relancés", fr(rl)],
          ["AniList se contredit", fr(N(b.incoherents))], ["Identifiant douteux", fr(N(b.douteux) + N(b.partages))], ["Absents d'AniList", fr(N(b.absents))], ["Refus de la base", fr(N(b.echecs))],
        ],
        chiffre: { v: fr(ch), l: ch > 1 ? "dates changées au dernier passage" : "date changée au dernier passage" },
        alerte: e ? `${/^base\b/i.test(e) ? `Base de données : ${e.replace(/^base : /, "")}` : prefixe("AniList", e)} (nouvel essai dans 1 h).` : N(b.echecs) && b.erreurBase ? `La base a refusé ${fr(N(b.echecs))} écriture(s) : ${coupe(b.erreurBase, 120)}.` : N(b.partiels) ? `AniList : ${fr(N(b.partiels))} paquet(s) d'animés en réponse partielle, pas relus à ce passage (nouvel essai dans 1 h ; si cela dure, ces animés ne sont plus mis à jour).` : N(b.erreursAS) ? `AnimeSchedule : ${fr(N(b.erreursAS))} fiche(s) en erreur (panne ou jeton refusé ?) ; les jours à confirmer restent tels quels.` : N(b.introuvablesAS) >= 2 ? `AnimeSchedule : ${fr(N(b.introuvablesAS))} fiches introuvables (404) dans ce passage ; leurs jours sont remplacés par la date d'AniList (adresse de l'API changée ?).` : null,
        donnees: chg.length || sig.length
          ? { t: "Au dernier passage", l: [...chg.slice(0, 10).map((x: any) => ["", coupe(x?.titre, 70), `${coupe(x?.avant, 30)} → ${coupe(x?.apres, 30)}`]), ...sig.slice(0, 6).map((x: any) => ["", coupe(x?.titre, 70), coupe(x?.raison, 90)])] as Array<[string, string, string]> }
          : null,
        notable: ch + aa + an + rl ? { nv: "info", texte: `${pl(ch, "date d'animé changée", "dates d'animés changées")}` + (aa ? `, ${fr(aa)} à annoncer` : "") + (an ? `, ${pl(an, "annulé", "annulés")}` : "") + (rl ? `, ${pl(rl, "relancé", "relancés")}` : ""), detail: coupe(chg.slice(0, 4).map((x: any) => `${x?.titre} : ${x?.apres}`).join(", "), 200) } : null,
      };
    },
  },
  {
    id: "phase-b-jeux", fam: "entree", nom: "Phase B · jeux", src: "api",
    role: "Complète jaquette, plateforme et description des jeux incomplets depuis IGDB",
    coupe: "Les jeux incomplets restent incomplets.",
    presenter: presenterLot("Jeux lus"),
  },
  {
    id: "phase-c", fam: "entree", nom: "Phase C · identifiants AniList", src: "api",
    role: "Retrouve l'identifiant AniList des animés qui n'en ont pas, par titre",
    coupe: "Les animés sans identifiant n'ont plus ni popularité ni Top du moment.",
    presenter: (b) => {
      const lus = N(b.scanned), ok = N(b.matched), err = N(b.errors);
      return {
        res: `${pl(lus, "lu", "lus")} · ${pl(ok, "trouvé", "trouvés")}` + (err ? ` · ${pl(err, "erreur", "erreurs")}` : ""),
        nv: lus === 0 ? "n" : err >= lus ? "k" : err ? "m" : "o",
        details: [["Animés lus", fr(lus)], ["Trouvés", fr(ok)], ["Sans réponse", fr(N(b.no_match))], ["Erreurs", fr(err)]],
        chiffre: { v: fr(ok), l: ok > 1 ? "trouvés au dernier passage" : "trouvé au dernier passage" },
      };
    },
  },
  {
    id: "quality-j7", fam: "entree", nom: "Contrôle J-7", src: "api",
    role: "Reprend avec insistance les animés incomplets qui sortent dans les 7 jours",
    coupe: "Les sorties imminentes ne sont plus reprises en priorité.",
    presenter: (b) => {
      const lus = N(b.scanned), ok = N(b.enriched), inc = N(b.still_incomplete);
      return {
        res: `${pl(lus, "lu", "lus")} · ${pl(ok, "complété", "complétés")}` + (inc ? ` · ${fr(inc)} encore incomplet${inc > 1 ? "s" : ""}` : ""),
        nv: lus === 0 ? "n" : inc ? "m" : "o",
        details: [["Animés lus", fr(lus)], ["Complétés", fr(ok)], ["Encore incomplets", fr(inc)]],
        chiffre: { v: fr(inc), l: inc > 1 ? "sorties encore incomplètes" : "sortie encore incomplète" },
        notable: inc ? { nv: "warn", texte: `${pl(inc, "sortie encore incomplète", "sorties encore incomplètes")}` } : null,
      };
    },
  },
  {
    id: "routes-as", fam: "entree", nom: "Routes AnimeSchedule", src: "api",
    role: "Relie les animés à leur fiche AnimeSchedule ; « Cette semaine » en a besoin",
    coupe: "Un nouvel animé sans route n'apparaît pas dans « Cette semaine ».",
    presenter: (b) => {
      const e = erreurDe(b), ok = N(b.matched);
      return {
        res: e ? `erreur : ${e}` : `${pl(ok, "route posée", "routes posées")} · ${pl(N(b.conflits), "conflit", "conflits")}`,
        nv: e ? "k" : N(b.scanned) === 0 ? "n" : "o",
        details: [
          ["Animés sans route", fr(N(b.scanned))], ["Routes posées", fr(ok)], ["Par identifiant · par titre", `${fr(N(b.parId))} · ${fr(N(b.parTitre))}`],
          ["Conflits", fr(N(b.conflits))], ["Requêtes AnimeSchedule", fr(N(b.requetes))],
        ],
        chiffre: { v: fr(ok), l: ok > 1 ? "routes posées" : "route posée" },
        alerte: e ? `${prefixe("AnimeSchedule", e)}.` : null,
      };
    },
  },
  {
    id: "controle-donnees", fam: "entree", nom: "Contrôle des données", src: "api",
    role: "Chaque matin : « Cette semaine », fenêtre du site, problèmes signalés sur Discord",
    coupe: "Plus de vérification quotidienne ni d'alerte « Données à vérifier ».",
    presenter: (b) => {
      const e = erreurDe(b), erreurs = Array.isArray(b.erreurs) ? b.erreurs : [], pb = N(b.problemes), sig = N(b.signales);
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.entrees), "entrée", "entrées")} · ${pl(N(b.routes), "route", "routes")} · ${pl(pb, "problème", "problèmes")}`,
        nv: e ? "k" : erreurs.length ? "m" : "o",
        details: [
          ["Entrées", fr(N(b.entrees))], ["Routes", fr(N(b.routes))], ["Plateformes", fr(N(b.plateformes))], ["Problèmes ouverts", fr(pb)],
          ["Signalés sur Discord", fr(sig)], ["Conflits", fr(N(b.conflits))],
        ],
        chiffre: { v: fr(pb), l: pb > 1 ? "problèmes ouverts" : "problème ouvert" },
        alerte: e ? `Contrôle interrompu : ${e}.` : erreurs.length ? coupe([...new Set(erreurs.map(String))].join(" · "), 200) : null,
        notable: sig ? { nv: "warn", texte: `${pl(sig, "signalement", "signalements")} sur Discord` } : null,
      };
    },
  },
  {
    id: "doublons", fam: "entree", nom: "Doublons", src: "api",
    role: "Regroupe et fusionne les doublons : le gagnant garde tout, le perdant est supprimé puis bloqué",
    coupe: "Plus de fusion automatique ; n8n continue de chercher les doublons à blanc.",
    rallume: "Il fusionne les doublons trouvés à chaque passage (toutes les heures) : le perdant de chaque groupe est supprimé et bloqué.",
    confirmer: {
      titre: "Fusionner les doublons maintenant ?",
      texte: "Le perdant de chaque groupe est supprimé, puis bloqué : il ne revient plus par n8n.",
      action: "Fusionner",
    },
    lancerLib: "Fusionner maintenant",
    presenter: (b) => {
      const e = erreurDe(b), g = N(b.totalGroups), m = N(b.itemsMerged);
      return {
        res: e ? `erreur : ${e}` : `${pl(g, "groupe", "groupes")} · ${pl(m, "fusionné", "fusionnés")}`,
        nv: e ? "k" : g === 0 ? "n" : "o",
        details: [["Groupes", fr(g)], ["Fusionnés", fr(m)], ["Supprimés", fr(N(b.itemsDeleted))], ["Relations déplacées", fr(N(b.relationsMigrated))]],
        chiffre: { v: fr(m), l: m > 1 ? "fusionnés au dernier passage" : "fusionné au dernier passage" },
        notable: m ? { nv: "ok", texte: `${pl(m, "doublon fusionné", "doublons fusionnés")}` } : null,
      };
    },
  },
  // ── plateformes et sorties en France
  {
    id: "presse", fam: "plateformes", nom: "Presse", src: "api",
    role: "Lit Gameblog, ADN News, AnimOtaku, Manga-News… ; Ollama relève les diffusions annoncées en France",
    coupe: "Les annonces de la presse n'alimentent plus les plateformes.",
    presenter: (b) => {
      const e = erreurDe(b), lus = N(b.articlesLus), ann = N(b.annonces), arret = b.arret ? coupe(b.arret, 150) : null;
      return {
        res: e ? `erreur : ${e}` : `${pl(lus, "article lu", "articles lus")} · ${pl(ann, "annonce", "annonces")}` + (arret ? " · en attente" : ""),
        nv: e ? "k" : arret || N(b.erreurs) ? "m" : lus === 0 ? "n" : "o",
        details: [["Articles lus", fr(lus)], ["Retenus", fr(N(b.retenus))], ["Envoyés à Ollama", fr(N(b.envoyes))], ["Annonces", fr(ann)], ["Sources en erreur", fr(N(b.erreurs))]],
        chiffre: { v: fr(ann), l: ann > 1 ? "annonces retenues" : "annonce retenue" },
        alerte: arret ? `En attente : ${arret}.` : N(b.erreurs) ? `${pl(N(b.erreurs), "source illisible", "sources illisibles")} à ce passage (reprise au suivant).` : null,
        notable: ann ? { nv: "ok", texte: `${pl(ann, "annonce France lue", "annonces France lues")} dans la presse` } : null,
      };
    },
  },
  {
    id: "tavily", fam: "plateformes", nom: "Tavily", src: "api",
    role: "Recherche web sur 16 sites de confiance pour les animés encore sans plateforme (1 crédit par recherche)",
    coupe: "Plus aucune recherche web : aucun crédit dépensé.",
    rallume: "Il repart au prochain passage (dans 2 h au plus) sans jamais dépasser ses plafonds de crédits (jour, mois, forfait Tavily).",
    lancerNote: (i) => `Il dépense au plus ${fr(N(i?.maxParPassage) || 3)} crédits, dans la limite des plafonds du jour et du mois.`,
    presenter: (b, ctx) => {
      const e = erreurDe(b), i = ctx.infos || {}, rech = N(b.recherches), ann = N(b.annonces), arret = b.arret ? coupe(b.arret, 150) : null;
      const mois = i.mois != null ? N(i.mois) : N(b.creditsMois), jour = i.jour != null ? N(i.jour) : N(b.creditsJour);
      const maxMois = N(i.maxParMois) || 900, maxJour = N(i.maxParJour) || 25;
      const fo = /^(\d+)\/(\d+)$/.exec(String(b.forfait ?? ""));
      const details: Array<[string, string]> = [["Crédits ce mois", `${fr(mois)} sur ${fr(maxMois)}`], ["Crédits aujourd'hui", `${fr(jour)} sur ${fr(maxJour)}`]];
      const jauges = [{ l: "Ce mois", v: mois, max: maxMois }];
      if (fo) {
        const u = N(fo[1]), l = N(fo[2]);
        details.push(["Forfait Tavily", `${fr(Math.max(0, l - u))} restants sur ${fr(l)}`]);
        jauges.push({ l: "Forfait Tavily (reste)", v: Math.max(0, l - u), max: l || 1 });
      }
      details.push(["Animés en attente", fr(N(b.file))], ["dont sorties dans 7 jours", fr(N(b.j7))]);
      return {
        res: e ? `erreur : ${e}` : `${pl(rech, "recherche", "recherches")} · ${pl(ann, "annonce", "annonces")}` + (arret ? " · arrêt" : ""),
        nv: e ? "k" : arret ? "m" : rech === 0 && N(b.repris) === 0 ? "n" : "o",
        details,
        jauges,
        chiffre: fo ? { v: fr(Math.max(0, N(fo[2]) - N(fo[1]))), l: "crédits restants au forfait" } : { v: fr(mois), l: "crédits dépensés ce mois" },
        alerte: arret ? `Arrêt : ${arret}.` : null,
        notable: N(b.trouves) ? { nv: "ok", texte: `plateforme annoncée trouvée pour ${pl(N(b.trouves), "animé", "animés")}` } : null,
      };
    },
  },
  {
    id: "plateformes", fam: "plateformes", nom: "Plateformes", src: "api",
    role: "Ajoute les plateformes vérifiées pour la France, masque ce qui n'est pas chez nous, dates de cinéma",
    coupe: "Ce que trouvent la presse et Tavily n'arrive plus sur le site ; les abonnés ne sont plus prévenus.",
    presenter: (b) => {
      const e = erreurDe(b), aj = N(b.ajouts), ci = N(b.cinema), al = b.anilist ? coupe(b.anilist, 140) : null;
      return {
        res: e ? `erreur : ${e}` : `${aj ? "+" : ""}${pl(aj, "plateforme", "plateformes")}` + (N(b.retraits) ? ` · −${fr(N(b.retraits))}` : "") + (ci ? ` · ${fr(ci)} au cinéma` : ""),
        nv: e ? "k" : al || N(b.cinemaReportes) ? "m" : "o",
        details: [
          ["Animés vérifiés", fr(N(b.animes))], ["Plateformes ajoutées", fr(aj)], ["Retirées", fr(N(b.retraits))], ["Masqués (pas chez nous)", fr(N(b.masques))],
          ["Au cinéma", fr(ci)], ["Abonnés prévenus", fr(N(b.notifies))],
        ],
        chiffre: { v: (aj ? "+" : "") + fr(aj), l: aj > 1 ? "plateformes ajoutées" : "plateforme ajoutée" },
        alerte: al ? `AniList : ${al} (pays d'origine non relus).` : N(b.cinemaReportes) ? "Une notification « Au cinéma » n'a pas pu partir : nouvel essai au prochain passage." : null,
        notable: aj ? { nv: "ok", texte: `+${pl(aj, "plateforme", "plateformes")}` } : null,
      };
    },
  },
  {
    id: "steam", fam: "plateformes", nom: "Steam · pages du magasin", src: "api",
    role: "Date et plateforme PC des jeux, lues sur les pages du magasin Steam",
    coupe: "Les dates PC ne sont plus relues ; « PC » n'est plus ajouté aux jeux.",
    presenter: (b) => {
      const e = erreurDe(b), lues = N(b.lues), pc = N(b.pcAjoutes), arret = b.arret ? coupe(b.arret, 150) : null;
      return {
        res: e ? `erreur : ${e}` : `${pl(lues, "page lue", "pages lues")}` + (pc ? ` · PC ajouté à ${fr(pc)}` : "") + (arret ? " · arrêt" : ""),
        nv: e ? "k" : arret ? "m" : lues === 0 ? "n" : "o",
        details: [["Pages lues", fr(lues)], ["Lisibles", fr(N(b.ok))], ["Absentes du magasin", fr(N(b.absentes))], ["PC ajouté", fr(pc)], ["Catalogue Steam", String(b.catalogue ?? "—")]],
        chiffre: { v: fr(lues), l: lues > 1 ? "pages lues" : "page lue" },
        alerte: arret ? `${arret} : reprise au prochain passage.` : e ? `${prefixe("Steam", e)}.` : null,
      };
    },
  },
  // ── popularité et classements
  {
    id: "popularite", fam: "classements", nom: "Popularité AniList", src: "api",
    role: "Relit la popularité et la note de tous les animés ; n'écrit que ce qui a changé",
    coupe: "Popularités et notes des animés figées ; le Top 150 ne bouge plus.",
    presenter: (b) => {
      const e = erreurDe(b), pop = N(b.popularites), no = N(b.notes);
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.lus), "lu", "lus")} · ${pl(pop + no, "changée", "changées")}`,
        nv: e ? "k" : N(b.echecs) ? "m" : "o",
        details: [["Animés lus", fr(N(b.lus))], ["Popularités changées", fr(pop)], ["Notes changées", fr(no)], ["Absents chez AniList", fr(N(b.absents))], ["Refus de la base", fr(N(b.echecs))]],
        chiffre: { v: fr(pop), l: pop > 1 ? "popularités changées" : "popularité changée" },
        alerte: N(b.echecs) && b.erreurBase ? `La base a refusé ${fr(N(b.echecs))} écriture(s) : ${coupe(b.erreurBase, 120)}.` : null,
      };
    },
  },
  {
    id: "europe-animes", fam: "classements", nom: "Bonus Europe · animés", src: "api",
    role: "Lecteurs européens de Wikipédia (fr, de, it, es) : un bonus ajouté au score des classements",
    coupe: "Le bonus est retiré : les classements des animés reviennent à la popularité seule.",
    rallume: "Le bonus est recalculé tout de suite depuis les vues déjà relevées ; le passage suivant les relit.",
    rythmeTexte: "chaque jour (contrôle toutes les heures)",
    presenter: (b) => {
      const e = erreurDe(b), arret = b.arret ? coupe(b.arret, 140) : null;
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.ecrits), "animé relu", "animés relus")} · ${pl(N(b.bonusChanges), "bonus changé", "bonus changés")}` + (arret ? " · lecture arrêtée" : ""),
        nv: e ? "k" : arret || b.plafond || N(b.erreursArticles) ? "m" : "o",
        details: [["Animés lus", fr(N(b.animes))], ["Avec un article", fr(N(b.avecArticle))], ["Articles lus", fr(N(b.articles))], ["Articles illisibles", fr(N(b.erreursArticles))], ["Bonus changés", fr(N(b.bonusChanges))]],
        chiffre: { v: fr(N(b.avecArticle)), l: "animés avec un article" },
        alerte: arret ? `Lecture arrêtée : ${arret} (nouvel essai dans 6 h).` : b.plafond ? "Plafond d'articles atteint : les animés les moins populaires gardent leurs valeurs." : null,
      };
    },
  },
  {
    id: "europe-jeux", fam: "classements", nom: "Bonus Europe · jeux", src: "api",
    role: "Même bonus pour les jeux, à partir d'IGDB, Wikidata et Wikipédia",
    coupe: "Le bonus des jeux est retiré ; celui des animés reste.",
    rallume: "Le bonus des jeux est recalculé tout de suite depuis les vues déjà relevées ; le passage suivant les relit.",
    rythmeTexte: "chaque jour (contrôle toutes les heures)",
    presenter: (b) => {
      const e = erreurDe(b), arret = b.arret ? coupe(b.arret, 140) : null;
      return {
        res: e ? `erreur : ${e}` : `${pl(N(b.ecrits), "jeu relu", "jeux relus")} · ${pl(N(b.bonusChanges), "bonus changé", "bonus changés")}` + (arret ? " · lecture arrêtée" : ""),
        nv: e ? "k" : arret || N(b.erreursArticles) ? "m" : "o",
        details: [["Jeux lus", fr(N(b.jeux))], ["Avec une fiche Wikidata", fr(N(b.avecFiche))], ["Avec un article", fr(N(b.avecArticle))], ["Articles lus", fr(N(b.articles))], ["Bonus changés", fr(N(b.bonusChanges))]],
        chiffre: { v: fr(N(b.avecArticle)), l: "jeux avec un article" },
        alerte: arret ? `Lecture arrêtée : ${arret} (nouvel essai dans 6 h).` : null,
      };
    },
  },
  {
    id: "planchers", fam: "classements", nom: "Planchers de franchise", src: "api",
    role: "Garde une popularité minimale aux grandes franchises de jeux (table des planchers)",
    coupe: "Les jeux des grandes franchises gardent leur popularité IGDB brute.",
    presenter: (b) => {
      const e = erreurDe(b), r = N(b.raised);
      return {
        res: e ? `erreur : ${e}` : `${pl(r, "relevé", "relevés")} · ${pl(N(b.restored), "rétabli", "rétablis")}`,
        nv: e ? "k" : "o",
        details: [["Jeux examinés", fr(N(b.scanned))], ["Relevés", fr(r)], ["Rétablis", fr(N(b.restored))]],
        chiffre: { v: fr(r), l: r > 1 ? "jeux relevés" : "jeu relevé" },
      };
    },
  },
  {
    id: "moment-animes", fam: "classements", nom: "Top du moment · animés", src: "api",
    role: "Activité AniList des 7 derniers jours (+ bonus Europe) pour le Top 25 et le bandeau",
    coupe: "Le Top 25 des animés reprend aussitôt le classement d'avant (popularité cumulée).",
    presenter: (b) => {
      const e = erreurDe(b), ec = N(b.ecrits);
      return {
        res: e && !ec ? `erreur : ${e}` : `${fr(ec)} mesurés sur ${fr(N(b.animes))}`,
        nv: e ? (ec ? "m" : "k") : N(b.animes) === 0 ? "n" : "o",
        details: [["Animés mesurés", `${fr(ec)} sur ${fr(N(b.animes))}`], ["Requêtes AniList", fr(N(b.requetes))], ["Absents chez AniList", fr(N(b.absents))]],
        chiffre: { v: fr(ec), l: "animés mesurés" },
        alerte: e ? `${prefixe("AniList", e)}${ec ? "" : " (nouvel essai dans 1 h)"}.` : null,
      };
    },
  },
  {
    id: "moment-jeux", fam: "classements", nom: "Top du moment · jeux", src: "api",
    role: "Spectateurs Twitch, joueurs Steam et visites IGDB, moyennés sur 24 h, pour le Top 25 et le bandeau",
    coupe: "Le Top 25 des jeux reprend aussitôt le classement d'avant. Les relevés Twitch et Steam s'arrêtent : la moyenne sur 24 h repartira de zéro.",
    presenter: (b) => {
      const e = erreurDe(b), erreurs: string[] = Array.isArray(b.erreurs) ? b.erreurs : [], cl = N(b.classes), jeux = N(b.jeux);
      return {
        res: e ? `erreur : ${e}` : `${fr(cl)} classés sur ${fr(jeux)}`,
        nv: e || (jeux && !cl) ? "k" : erreurs.length ? "m" : "o",
        details: [
          ["Jeux classés", `${fr(cl)} sur ${fr(jeux)}`],
          ["Twitch", b.twitchOk ? `${fr(N(b.categories))} catégories · ${fr(N(b.diffuses))} diffusés · ${fr(N(b.spectateurs))} spectateurs` : "indisponible"],
          ["Steam", `${fr(N(b.steamLus))} lus sur ${fr(N(b.surSteam))}` + (b.steamArret ? " · arrêt" : "")],
          ["Visites IGDB", b.visites === null || b.visites === undefined ? "pas à ce passage" : `${fr(N(b.visites))} jeux`],
        ],
        chiffre: { v: fr(cl), l: "jeux classés" },
        alerte: e ? `${e}.` : erreurs.length ? coupe([...new Set(erreurs.map(String))].join(" · "), 200) : null,
      };
    },
  },
  // ── contenus
  {
    id: "synopsis", fam: "contenus", nom: "Synopsis", src: "api",
    role: "Ollama rédige les synopsis en français ; rien ne s'affiche sans ta validation",
    coupe: "Plus aucun synopsis n'est rédigé ni corrigé (un passage en cours s'arrête après l'étape en cours, quelques minutes au plus) ; ceux déjà rédigés restent à valider dans le bloc Synopsis.",
    rallume: "Rallumé, il repart dans les 10 minutes, dans sa fenêtre horaire : les corrections que tu as demandées d'abord, puis les plus populaires.",
    lancerNote: (i) => `Il fait les corrections demandées (${fr(N(i?.parLancement) || 8)} au plus), puis ${fr(N(i?.parLancement) || 8)} synopsis au plus, même hors de sa fenêtre horaire` +
      (N(i?.msParItem) ? ` (environ ${fr(Math.max(1, Math.round(N(i?.msParItem) / MIN)))} min chacun).` : "."),
    presenter: presenterSynopsis,
  },
  {
    id: "images-hd", fam: "contenus", nom: "Images HD", src: "hote",
    role: "Agrandit les jaquettes du bandeau et de « Cette semaine » (sur le serveur, à chaque heure et 23)",
    rythme: "toutes les heures, à h:23 (tâche du serveur)",
    pilote: { t: "Tâche du serveur.", d: "Elle tourne par la crontab, à chaque heure et 23 ; ici, son dernier résultat." },
    sansLancer: "Se lance sur le serveur",
  },
  // ── univers
  {
    id: "licences", fam: "univers", nom: "Licences et univers", src: "api",
    role: "Range chaque fiche du site dans sa licence et retrouve le passé de la licence (repères) pour le bloc Univers",
    coupe: "Le calcul s'arrête. Les licences déjà calculées restent affichées.",
    rallume: "Un passage part dans la minute si celui du jour a été manqué.",
    presenter: (b) => {
      const e = erreurDe(b), arret = b.arret ? coupe(b.arret, 160) : null, garde = b.garde ? coupe(b.garde, 160) : null;
      const req = b.requetes || {}, ch = b.changements || {};
      const liste = (k: string): string[] => (Array.isArray(ch[k]) ? ch[k].map(String) : []);
      // les listes du bilan sont plafonnées à 30 : le compte de chaque sorte est à part
      const nb = (k: string): number => (ch.comptes && Number.isFinite(Number(ch.comptes[k])) ? Number(ch.comptes[k]) : liste(k).length);
      const nouv = liste("nouvelles"), reun = liste("reunies"), sep = liste("separees"), rev = liste("reveillees"), ren = liste("renommees");
      const morceaux = [
        nb("nouvelles") ? pl(nb("nouvelles"), "licence nouvelle", "licences nouvelles") : "",
        nb("reunies") ? pl(nb("reunies"), "réunie", "réunies") : "",
        nb("separees") ? pl(nb("separees"), "séparée", "séparées") : "",
        nb("reveillees") ? pl(nb("reveillees"), "réveillée", "réveillées") : "",
      ].filter(Boolean);
      const lignes: Array<[string, string, string]> = [
        ...nouv.slice(0, 5).map((x): [string, string, string] => ["", coupe(x, 80), "nouvelle"]),
        ...reun.slice(0, 3).map((x): [string, string, string] => ["", coupe(x, 80), "réunie"]),
        ...sep.slice(0, 3).map((x): [string, string, string] => ["", coupe(x, 80), "séparée"]),
        ...rev.slice(0, 3).map((x): [string, string, string] => ["", coupe(x, 80), "réveillée"]),
        ...ren.slice(0, 3).map((x): [string, string, string] => ["", coupe(x, 80), "renommée"]),
      ];
      return {
        res: e ? `erreur : ${e}` : arret ? `rien d'écrit : ${arret}` : garde ? `rien d'écrit : ${garde}` : `${fr(N(b.blocs))} blocs remplis sur ${fr(N(b.fiches))} fiches · ${pl(N(b.croisees), "licence animés et jeux", "licences animés et jeux")}`,
        nv: e ? "k" : arret || garde ? "m" : N(b.fiches) === 0 ? "n" : "o",
        details: [
          ["Fiches du site", `${fr(N(b.fiches))} (${fr(N(b.animes))} animés, ${fr(N(b.jeux))} jeux)`],
          ["Licences", fr(N(b.licences))],
          ["Licences de 2 sorties ou plus", fr(N(b.licences2))],
          ["Mêlant animés et jeux", fr(N(b.croisees))],
          ["Repères (sorties d'avant)", fr(N(b.reperes))],
          ["Ponts par le titre · le nom · les catalogues", `${fr(N(b.pontsTitre))} · ${fr(N(b.pontsNom))} · ${fr(N(b.pontsCatalogue))}`],
          ["Requêtes AniList · IGDB · Wikidata", `${fr(N(req.al))} · ${fr(N(req.ig))} · ${fr(N(req.wd))}`],
          ["Écrit", b.ecrit ? "oui" : "non"],
        ],
        chiffre: { v: fr(N(b.blocs)), l: "blocs remplis" },
        alerte: e
          ? `${prefixe("Licences", e)} : rien n'est écrit, les licences d'avant restent affichées.`
          : arret
            ? `Passage incomplet (${arret}) : rien n'est écrit, les licences d'avant restent affichées.`
            : garde
              ? `Garde-fou, ${garde} : rien n'est écrit, les licences d'avant restent affichées (si elle se confirme 18 h plus tard, elle est écrite).`
              : null,
        donnees: lignes.length ? { t: "Changements au dernier passage", l: lignes } : null,
        notable: morceaux.length ? { nv: "info", texte: `Licences : ${morceaux.join(", ")}`, detail: coupe([...nouv, ...reun, ...sep, ...rev].slice(0, 5).join(", "), 200) } : null,
      };
    },
  },
  // ── surveillance et comptes
  {
    id: "sante", fam: "surveillance", nom: "Santé des sources", src: "api",
    role: "Vérifie IGDB, AniList, Kitsu et AnimeSchedule ; alerte Discord si l'un tombe ou si un module se tait",
    coupe: "Plus d'alerte Discord si une source tombe ou si un module se tait.",
    presenter: (b) => {
      const s: any[] = Array.isArray(b.sources) ? b.sources : [];
      // AniList qui limite les requêtes (429, file-anilist.ts) : il répond, ce n'est pas une panne
      const lim = s.filter((x) => x.limite);
      const ko = s.filter((x) => x.status !== "UP" && !x.limite);
      const noms: Record<string, string> = { igdb: "IGDB", anilist: "AniList", kitsu: "Kitsu", animeschedule: "AnimeSchedule" };
      return {
        res: ko.length ? `${pl(ko.length, "source en panne", "sources en panne")}`
          : lim.length ? `${lim.map((x) => noms[x.source] || x.source).join(", ")} limité (429)` : `${fr(s.length)} sources OK`,
        nv: s.length === 0 ? "n" : ko.length || lim.length ? "m" : "o",
        details: s.map((x) => [noms[x.source] || String(x.source), x.status === "UP" ? `OK · ${fr(N(x.ms))} ms`
          : x.limite ? "LIMITÉ · HTTP 429, trop de requêtes" : `PANNE${x.err ? " · " + coupe(x.err, 80) : ""}`] as [string, string]),
        chiffre: { v: `${s.length - ko.length - lim.length}/${s.length}`, l: "sources OK" },
        alerte: ko.length ? `${ko.map((x) => noms[x.source] || x.source).join(", ")} ne répond pas.` : null,
      };
    },
  },
  {
    id: "rappels", fam: "surveillance", nom: "Rappels de sortie", src: "n8n",
    role: "Rappels J-7 et jour J des favoris, par e-mail et notification",
    rythme: "chaque jour (réglé dans n8n)",
    presenter: (b) => ({
      res: `${pl(N(b.created), "rappel", "rappels")}`,
      nv: N(b.code) >= 400 ? "k" : "o",
      details: [["Rappels", fr(N(b.created))], ["Déjà envoyés (sautés)", fr(N(b.skipped))]],
      chiffre: { v: fr(N(b.created)), l: N(b.created) > 1 ? "rappels au dernier passage" : "rappel au dernier passage" },
    }),
  },
  {
    id: "alertes", fam: "surveillance", nom: "Alertes", src: "n8n",
    role: "Prévient les abonnés quand un titre correspond à leurs genres et plateformes",
    rythme: "toutes les 3 h (réglé dans n8n)",
    presenter: (b) => ({
      res: `${pl(N(b.created), "alerte", "alertes")}`,
      nv: N(b.code) >= 400 ? "k" : "o",
      details: [["Alertes", fr(N(b.created))]],
      chiffre: { v: fr(N(b.created)), l: N(b.created) > 1 ? "alertes au dernier passage" : "alerte au dernier passage" },
    }),
  },
  // épisodes et dates des favoris (suivi-favoris.ts, 30 octobre 2026) : le relevé, puis l'envoi (coupé au départ)
  {
    id: "suivi-favoris", fam: "surveillance", nom: "Épisodes et dates des favoris", src: "api",
    role: "Relève les épisodes sortis des animés suivis sur nos plateformes EU (horaires de « Cette semaine ») et les changements de date des titres suivis ; n'envoie rien : l'envoi est la ligne « Envoi aux abonnés »",
    coupe: "Plus aucun épisode ni changement de date n'est relevé ; rien n'est envoyé.",
    rallume: "Il repart dans les 10 minutes : les épisodes sortis depuis moins de 12 h sont relevés, les dates reprennent là où elles étaient.",
    presenter: (b, ctx) => {
      const e = erreurDe(b), ep = N(b.episodes), dt = N(b.dates), ret = N(b.retenus), envoi = b.envoi === true;
      const i = ctx.infos || {}, cpt = i.comptes || {};
      const statuts: Record<string, string> = { attente: envoi ? "à envoyer" : "à blanc, en attente", envoi: "envoi en cours", envoye: "envoyé", blanc: "à blanc (pas envoyé)", trop_tard: "trop tard (pas envoyé)", retenu: "retenu (garde-fou)", annule: "annulé (plus vrai à l'envoi)" };
      const quand = (t: number): string => {
        const d = new Date(t);
        const jour = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short" }).format(d);
        return `${jour} ${heureParis(t)}`;
      };
      const recents: any[] = Array.isArray(i.recents) ? i.recents : [];
      const parts = [pl(ep, "épisode", "épisodes"), pl(dt, "date changée", "dates changées")];
      return {
        res: e ? `erreur : ${e}` : parts.join(" · ") + (envoi ? "" : " · à blanc"),
        nv: e ? "k" : ret ? "m" : ep + dt ? "o" : "n",
        details: [
          ["Envoi aux abonnés", envoi ? "allumé" : "coupé : tout est relevé à blanc"],
          ["Animés suivis avec un épisode ces 12 h", fr(N(b.animesSuivis))],
          ["Épisodes en retard (pas annoncés)", fr(N(b.retardes))],
          ["Pas encore dits sortis (repris au passage suivant)", fr(N(b.pasEncore))],
          ["Horaire japonais seulement (pas annoncés)", fr(N(b.bruts))],
          ["Sur aucune de nos plateformes EU (pas annoncés)", fr(N(b.sansPlateforme))],
          ["Titres suivis (dates)", fr(N(b.titresSuivis))],
          ["Changements en observation (6 h)", fr(N(b.observation))],
          ["En attente d'envoi", fr(N(b.enAttente))],
          ["Sur 7 jours : envoyés · à blanc · trop tard · annulés", `${fr(N(cpt.envoye))} · ${fr(N(cpt.blanc))} · ${fr(N(cpt.trop_tard))} · ${fr(N(cpt.annule))}`],
        ],
        chiffre: { v: fr(ep + dt), l: ep + dt > 1 ? "relevés au dernier passage" : "relevé au dernier passage" },
        alerte: e
          ? `${e} (nouvel essai dans 10 min).`
          : ret
            ? `Garde-fou, ${coupe(b.garde, 120)} : rien de ce passage n'est envoyé (à vérifier : une source a-t-elle changé d'un coup ?).`
            : null,
        donnees: recents.length
          ? { t: "Derniers relevés", l: recents.slice(0, 10).map((x: any): [string, string, string] => [quand(N(x.quand)), coupe(x.titre, 60), `${coupe(x.texte, 70)} · ${statuts[x.statut] || x.statut}${x.abonnes ? ` (${pl(N(x.abonnes), "abonné", "abonnés")})` : ""}`]) }
          : null,
        notable: ret ? { nv: "warn", texte: `Garde-fou : ${coupe(b.garde, 120)}`, detail: "rien de ce passage n'est envoyé aux abonnés" } : null,
      };
    },
  },
  {
    id: "envoi-favoris", fam: "surveillance", nom: "Envoi aux abonnés", src: "api",
    role: "Envoie à la cloche des abonnés ce que relève « Épisodes et dates des favoris » : un épisode sorti depuis moins de 12 h, une date changée depuis moins de 48 h, revérifiés juste avant l'envoi",
    coupe: "Rien n'est envoyé : les épisodes et les dates sont relevés à blanc (ligne « Épisodes et dates des favoris »).",
    rallume: "Ce qui est relevé et encore frais (un épisode sorti depuis moins de 12 h, une date changée depuis moins de 48 h) part dans la cloche des abonnés dans les 10 minutes, puis chaque nouveauté dans la minute.",
    confirmer: {
      titre: "Envoyer maintenant aux abonnés ?",
      texte: "Ce qui est relevé et encore frais (un épisode sorti depuis moins de 12 h, une date changée depuis moins de 48 h) part dans la cloche des abonnés.",
      action: "Envoyer",
    },
    presenter: (b) => {
      const e = erreurDe(b), env = N(b.envoyes), abo = N(b.abonnes), tard = N(b.tard), ann = N(b.annules);
      const liste: any[] = Array.isArray(b.liste) ? b.liste : [];
      return {
        res: e ? `erreur : ${e}` : `${pl(env, "envoyé", "envoyés")} · ${pl(abo, "abonné prévenu", "abonnés prévenus")}` + (tard ? ` · ${fr(tard)} trop tard` : "") + (ann ? ` · ${pl(ann, "annulé", "annulés")}` : ""),
        nv: e ? "k" : (tard || ann) && !env ? "m" : env ? "o" : "n",
        details: [["Envoyés", fr(env)], ["Abonnés prévenus", fr(abo)], ["Trop tard (pas envoyés)", fr(tard)], ["Annulés (plus vrais à l'envoi : épisode retardé, date changée)", fr(ann)]],
        chiffre: { v: fr(env), l: env > 1 ? "envoyés au dernier passage" : "envoyé au dernier passage" },
        alerte: e ? `${prefixe("Envoi", e)} : ce qui reste est repris au passage suivant, tant que c'est frais.` : null,
        donnees: liste.length ? { t: "Envoyés au dernier passage", l: liste.slice(0, 10).map((x: any): [string, string, string] => ["", coupe(x.titre, 60), `${coupe(x.texte, 70)} · ${pl(N(x.abonnes), "abonné", "abonnés")}`]) } : null,
        notable: env ? { nv: "ok", texte: `${pl(env, "notification envoyée", "notifications envoyées")} aux abonnés`, detail: coupe(liste.slice(0, 4).map((x: any) => `${x.titre} : ${x.texte}`).join(", "), 200) } : null,
      };
    },
  },
  // notifications sur l'appareil (push.ts, 31 octobre 2026)
  {
    id: "push", fam: "surveillance", nom: "Notifications sur l'appareil", src: "api",
    role: "Envoie aux appareils activés (téléphone, ordinateur) les notifications de la cloche des favoris, à toute heure : ni les alertes ni les images",
    coupe: "Plus rien n'est envoyé sur les appareils ; la cloche du site continue. Ce qui a moins de 24 h part au rallumage.",
    rallume: "Ce qui est arrivé dans la cloche depuis moins de 24 h (et pas encore lu) part dans la minute.",
    presenter: (b, ctx) => {
      const e = erreurDe(b), env = N(b.envoyes), exp = N(b.expires), ref = N(b.refuses), re = N(b.reessais), reg = N(b.regroupes), err = N(b.erreurs);
      const i = ctx.infos || {}, j = i.jour || {};
      return {
        res: e ? `erreur : ${e}` : `${pl(env, "envoyée", "envoyées")} · ${pl(N(b.appareils), "appareil", "appareils")}` + (exp ? ` · ${pl(exp, "appareil désabonné", "appareils désabonnés")}` : "") + (re ? ` · ${fr(re)} à refaire` : "") + (err ? ` · ${pl(err, "appareil en erreur", "appareils en erreur")}` : ""),
        nv: e || (err && !env) ? "k" : ref || re || err ? "m" : env ? "o" : "n",
        details: [
          ["Appareils activés · comptes", `${fr(N(i.appareils))} · ${fr(N(i.comptes))}`],
          ["Envoyées sur 24 h (regroupées comprises)", fr(N(j.envoye) + N(j.groupe))],
          ["Regroupées au dernier passage", fr(reg)],
          ["Remplacées par une plus récente du même titre", fr(N(b.remplaces))],
          ["Refusées par le service · à refaire", `${fr(ref)} · ${fr(re)}`],
          ["Appareils en attente après une panne de leur service", fr(N(i.auRepos))],
        ],
        chiffre: { v: fr(N(i.appareils)), l: N(i.appareils) > 1 ? "appareils activés" : "appareil activé" },
        alerte: e
          ? `${prefixe("Notifications", e)} : nouvel essai dans la minute.`
          : err
            ? `${pl(err, "appareil en erreur", "appareils en erreur")} au dernier passage (voir le journal de l'API) : nouvel essai dans la minute.`
            : ref
              ? `${pl(ref, "notification refusée", "notifications refusées")} par le service du navigateur (clé ou contenu ?).`
              : null,
      };
    },
  },
  {
    id: "sessions", fam: "surveillance", nom: "Purge des sessions", src: "api",
    role: "Retire les sessions de connexion expirées",
    coupe: "Les sessions expirées restent en base (les comptes ne sont pas touchés).",
    presenter: (b) => {
      const e = erreurDe(b), r = N(b.retirees);
      return {
        res: e ? `erreur : ${e}` : pl(r, "session retirée", "sessions retirées"),
        nv: e ? "k" : r ? "o" : "n",
        details: [["Sessions retirées", fr(r)]],
        chiffre: { v: fr(r), l: r > 1 ? "sessions retirées" : "session retirée" },
      };
    },
  },
];
const FICHE = new Map(FICHES.map((f) => [f.id, f]));

// les anciennes routes des process lourds qui font le travail d'un cycle (admin-runs.ts, PROCESS_LOURDS)
const PROCESS_MODULE: Record<string, string> = {
  "refetch-incomplete": "phase-b-animes",
  "refetch-incomplete-games": "phase-b-jeux",
  "lookup-anilist-ids": "phase-c",
  "quality-check-j7": "quality-j7",
  "match-anime-routes": "routes-as",
  "apply-franchise-floors": "planchers",
  "merge-duplicates": "doublons",
};

// ─────────────────────────────────────────────────────────────── état

const ETATS = new Map<string, Etat>();
/** Les modules qui n'ont pas pu démarrer (configuration incomplète) : la raison est montrée. */
const ABSENTS = new Map<string, string>();
const INTERRUPTEURS = new Map<string, boolean>();
const DERNIERS = new Map<string, Passage>();
/** Le début du dernier passage allé au bout (ni coupé par un redémarrage, ni de n8n) : le prochain se cale dessus. */
const COMPLETS = new Map<string, number>();
const HISTOS = new Map<string, Array<{ nv: Niveau; duree: number | null; debut: number }>>();
let POOL: any = null;
let LOG: any = console;
let APP: FastifyInstance | null = null;
let PRET = false;
let PAUSE: { depuis: number; par: string } | null = null;
let DEMARRE_LE = Date.now();
const JETON = randomBytes(18).toString("hex");
const HISTO_MAX = 24;

/** L'interrupteur d'un module (null : le Pilotage ne le connaît pas encore). */
export function interrupteur(id: string): boolean | null {
  if (INTERRUPTEURS.has(id)) return INTERRUPTEURS.get(id) as boolean;
  const e = ETATS.get(id);
  return e ? e.def.actifParDefaut !== false : null;
}

export function enPause(): boolean {
  return PAUSE !== null;
}

/** Pour la santé : faut-il surveiller ce cycle, et depuis quand doit-il avoir donné signe de vie ? */
export function surveillance(id: string): { suivi: boolean; reference: number | null } {
  const e = ETATS.get(id);
  if (!e) return { suivi: false, reference: null };
  const dep = e.def.dependDe;
  const d = DERNIERS.get(id);
  const ref = Math.max(d?.fin ?? d?.debut ?? 0, e.reprisLe, e.occupe?.debut ?? 0);
  // après un arrêt de l'API, l'ancienneté d'avant le démarrage ne compte pas tant que le premier passage prévu depuis
  // le démarrage n'a pas eu le temps de se faire (30 min de marge) : pas de fausse alerte après une maintenance
  const pasEncore = ref < DEMARRE_LE && e.premierDu !== null && Date.now() < e.premierDu + ms(30 * MIN);
  const suivi = interrupteur(id) === true && !PAUSE && (!dep || interrupteur(dep) === true) && !pasEncore;
  return { suivi, reference: ref || null };
}

/** Un module qui n'a pas pu démarrer (clé absente…) : sa ligne le dit. */
export function moduleIndisponible(id: string, raison: string): void {
  ABSENTS.set(id, coupe(raison, 160));
}

// ─────────────────────────────────────────────────────────────── base

async function sql(q: string, p: any[] = []): Promise<any> {
  if (!POOL) throw new Error("base introuvable");
  return POOL.query(q, p);
}

async function creerTables(): Promise<void> {
  await sql(
    "CREATE TABLE IF NOT EXISTS pilotage_reglages (" +
      "module VARCHAR(40) NOT NULL, cle VARCHAR(40) NOT NULL, valeur VARCHAR(255) NULL, le BIGINT NOT NULL, " +
      "PRIMARY KEY (module, cle)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  await sql(
    "CREATE TABLE IF NOT EXISTS pilotage_passages (" +
      "id INT UNSIGNED NOT NULL AUTO_INCREMENT, module VARCHAR(40) NOT NULL, declencheur VARCHAR(10) NOT NULL, " +
      "debut BIGINT NOT NULL, fin BIGINT NULL, duree_ms INT UNSIGNED NULL, niveau CHAR(1) NOT NULL DEFAULT 'o', " +
      "resume VARCHAR(255) NULL, bilan MEDIUMTEXT NULL, PRIMARY KEY (id), KEY k_module_debut (module, debut)) " +
      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  await sql(
    "CREATE TABLE IF NOT EXISTS pilotage_journal (" +
      "id INT UNSIGNED NOT NULL AUTO_INCREMENT, le BIGINT NOT NULL, qui VARCHAR(10) NOT NULL, niveau VARCHAR(5) NOT NULL, " +
      "module VARCHAR(40) NULL, texte VARCHAR(300) NOT NULL, detail VARCHAR(300) NULL, PRIMARY KEY (id), KEY k_le (le)) " +
      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
}

const BILAN_MAX = 60000;
function bilanTexte(b: Record<string, any> | null): string | null {
  if (!b) return null;
  try {
    const t = JSON.stringify(b);
    return t.length > BILAN_MAX ? JSON.stringify({ tronque: true, apercu: t.slice(0, 2000) }) : t;
  } catch {
    return null;
  }
}

function ligneVersPassage(r: any): Passage {
  let bilan: Record<string, any> | null = null;
  if (r.bilan) {
    try {
      bilan = JSON.parse(String(r.bilan));
    } catch {
      bilan = null;
    }
  }
  return {
    id: N(r.id), module: String(r.module), declencheur: String(r.declencheur) as Declencheur, debut: N(r.debut),
    fin: r.fin == null ? null : N(r.fin), duree: r.duree_ms == null ? null : N(r.duree_ms), niveau: (String(r.niveau || "o") as Niveau),
    resume: String(r.resume ?? ""), bilan,
  };
}

async function noter(qui: "rey" | "auto" | "patch", niveau: "info" | "ok" | "warn" | "err", module: string | null, texte: string, detail?: string | null): Promise<void> {
  try {
    await sql("INSERT INTO pilotage_journal (le, qui, niveau, module, texte, detail) VALUES (?, ?, ?, ?, ?, ?)", [
      Date.now(), qui, niveau, module, coupe(texte, 300), detail ? coupe(detail, 300) : null,
    ]);
  } catch (e) {
    LOG.warn?.({ module: "pilotage", err: message(e) }, "pilotage : journal non écrit");
  }
}

async function ecrireReglage(module: string, cle: string, valeur: string | null): Promise<void> {
  await sql("INSERT INTO pilotage_reglages (module, cle, valeur, le) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur), le = VALUES(le)", [
    module, cle, valeur, Date.now(),
  ]);
}

function retenirPassage(p: Passage): void {
  DERNIERS.set(p.module, p);
  if (p.declencheur !== "n8n" && p.duree != null) COMPLETS.set(p.module, Math.max(COMPLETS.get(p.module) ?? 0, p.debut));
  const h = HISTOS.get(p.module) ?? [];
  const i = h.findIndex((x) => x.debut === p.debut);
  const v = { nv: p.niveau, duree: p.duree == null ? null : Math.max(1, Math.round(p.duree / 1000)), debut: p.debut };
  if (i >= 0) h[i] = v;
  else h.push(v);
  h.sort((a, b) => a.debut - b.debut);
  while (h.length > HISTO_MAX) h.shift();
  HISTOS.set(p.module, h);
}

async function chargerEtat(): Promise<void> {
  for (const r of await sql("SELECT module, cle, valeur, le FROM pilotage_reglages")) {
    if (r.cle === "actif") INTERRUPTEURS.set(String(r.module), r.valeur === "1");
    if (r.module === "*" && r.cle === "pause" && r.valeur) PAUSE = { depuis: N(r.le), par: String(r.valeur) };
  }
  // passages coupés par un redémarrage (ou une panne) : notés interrompus
  const coupes = await sql("SELECT id, debut FROM pilotage_passages WHERE fin IS NULL");
  for (const r of coupes) {
    await sql("UPDATE pilotage_passages SET fin = ?, duree_ms = NULL, niveau = 'm', resume = ? WHERE id = ? AND fin IS NULL", [
      N(r.debut), "interrompu : API redémarrée pendant le passage", N(r.id),
    ]).catch(() => {});
  }
  const histo = await sql(
    "SELECT module, debut, duree_ms, niveau FROM (SELECT module, debut, duree_ms, niveau, " +
      "ROW_NUMBER() OVER (PARTITION BY module ORDER BY debut DESC, id DESC) AS rn FROM pilotage_passages) x WHERE rn <= ? ORDER BY debut",
    [HISTO_MAX],
  );
  for (const r of histo) {
    const h = HISTOS.get(String(r.module)) ?? [];
    h.push({ nv: String(r.niveau || "o") as Niveau, duree: r.duree_ms == null ? null : Math.max(1, Math.round(N(r.duree_ms) / 1000)), debut: N(r.debut) });
    HISTOS.set(String(r.module), h);
  }
  const derniers = await sql(
    "SELECT * FROM (SELECT p.*, ROW_NUMBER() OVER (PARTITION BY module ORDER BY debut DESC, id DESC) AS rn FROM pilotage_passages p) x WHERE rn = 1",
  );
  for (const r of derniers) DERNIERS.set(String(r.module), ligneVersPassage(r));
  // un passage coupé par un redémarrage ne compte pas : le cycle repart comme s'il n'avait pas eu lieu
  const complets = await sql("SELECT module, MAX(debut) AS debut FROM pilotage_passages WHERE duree_ms IS NOT NULL AND declencheur <> 'n8n' GROUP BY module");
  for (const r of complets) COMPLETS.set(String(r.module), N(r.debut));
}

async function menage(): Promise<void> {
  try {
    const avant = Date.now() - 90 * 24 * H;
    await sql("DELETE FROM pilotage_passages WHERE debut < ?", [avant]);
    // au plus 400 passages par module (n8n cherche les doublons toutes les 5 min)
    await sql(
      "DELETE p FROM pilotage_passages p JOIN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY module ORDER BY debut DESC, id DESC) AS rn " +
        "FROM pilotage_passages) x WHERE rn > 400) y ON y.id = p.id",
    );
    await sql("DELETE FROM pilotage_journal WHERE le < ?", [Date.now() - 180 * 24 * H]);
  } catch (e) {
    LOG.warn?.({ module: "pilotage", err: message(e) }, "pilotage : ménage des tables impossible");
  }
}

// ─────────────────────────────────────────────────────────────── le planificateur

/** Instant (ms) du créneau suivant à heures fixes UTC, strictement après t. */
function creneauSuivant(t: number, heures: number[]): number {
  const d = new Date(t);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let meilleur = Infinity;
  for (const jour of [0, 1, 2]) {
    for (const h of heures) {
      const c = base + jour * 24 * H + Math.round(h * H);
      if (c > t + 1000 && c < meilleur) meilleur = c;
    }
  }
  return meilleur;
}

/** Instant (ms) du créneau précédent (≤ t). */
function creneauPrecedent(t: number, heures: number[]): number {
  const d = new Date(t);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let meilleur = -Infinity;
  for (const jour of [0, -1, -2]) {
    for (const h of heures) {
      const c = base + jour * 24 * H + Math.round(h * H);
      if (c <= t && c > meilleur) meilleur = c;
    }
  }
  return meilleur;
}

function dernierDebut(id: string): number | null {
  return COMPLETS.get(id) ?? null;
}

/** Le prochain passage automatique d'un module. */
function calculerProchain(e: Etat, cas: "demarrage" | "apres" | "rallume" | "reprise", debutPassage?: number): number {
  const now = Date.now(), d = e.def, dernier = dernierDebut(d.id);
  if (d.heuresUtc && d.heuresUtc.length) {
    // un créneau manqué (API arrêtée, module coupé ou en pause) est rattrapé : peu après le démarrage, ou dans la
    // minute qui suit la remise en route
    const manque = dernier == null || dernier < creneauPrecedent(now, d.heuresUtc) - MIN;
    if (cas === "demarrage" && d.premierMs != null && manque) return now + ms(d.premierMs);
    if ((cas === "rallume" || cas === "reprise") && d.premierMs != null && manque) return now + ms(MIN);
    return creneauSuivant(now, d.heuresUtc);
  }
  const r = ms(d.rythmeMs ?? H);
  if (cas === "demarrage") {
    const p = now + ms(d.premierMs ?? MIN);
    return dernier == null ? p : Math.max(p, dernier + r);
  }
  if (cas === "apres") return Math.max(now + ms(1000), (debutPassage ?? now) + r);
  // rallumé, ou fin de pause : au prochain passage normal, au plus tôt dans 1 min, au plus tard dans un rythme
  const normal = dernier == null ? now + ms(MIN) : dernier + r;
  return Math.min(Math.max(normal, now + ms(MIN)), now + r);
}

function armer(e: Etat, quand: number | null): void {
  if (e.minuteur) clearTimeout(e.minuteur);
  e.minuteur = null;
  e.prochain = null;
  if (quand === null || PAUSE || interrupteur(e.def.id) !== true) return;
  e.prochain = quand;
  const t = setTimeout(() => void tic(e), Math.max(0, Math.min(quand - Date.now(), 2147000000)));
  (t as any).unref?.();
  e.minuteur = t;
}

async function adminLockPris(process: string): Promise<boolean> {
  try {
    const r = await sql("SELECT process FROM admin_lock WHERE id = 1 AND process = ? AND pris_a > NOW() - INTERVAL 30 MINUTE", [process]);
    return Array.isArray(r) && r.length > 0;
  } catch {
    return false;
  }
}

/** Le passage automatique peut-il partir ? Sinon, le minuteur est réarmé s'il le faut. */
function peutPartir(e: Etat): boolean {
  const d = e.def;
  if (PAUSE || interrupteur(d.id) !== true) {
    e.prochain = null;
    return false;
  }
  // réarmé entre-temps (rallumé, fin de pause) : c'est ce minuteur-là qui fera le passage
  if (e.minuteur) return false;
  if (d.dependDe && interrupteur(d.dependDe) !== true) {
    e.attente = `arrêté avec « ${FICHE.get(d.dependDe)?.nom ?? d.dependDe} »`;
    armer(e, calculerProchain(e, "apres", Date.now()));
    return false;
  }
  if (e.occupe) {
    // un passage lancé à la main tourne : il compte comme celui-ci
    e.attente = null;
    armer(e, calculerProchain(e, "apres", Date.now()));
    return false;
  }
  return true;
}

async function tic(e: Etat): Promise<void> {
  e.minuteur = null;
  if (!peutPartir(e)) return;
  e.attente = null;
  const d = e.def;
  if (d.processAdmin && (await adminLockPris(d.processAdmin))) {
    e.attente = "lancé ailleurs (Process), nouvel essai dans 5 min";
    armer(e, Date.now() + ms(5 * MIN));
    return;
  }
  // l'état a pu changer pendant la lecture du verrou (lancé à la main, coupé, pause)
  if (!peutPartir(e)) return;
  await executer(e, "auto");
}

/** Un passage, automatique ou à la main ; le verrou du module est tenu jusqu'au bout. */
async function executer(e: Etat, declencheur: "auto" | "manuel"): Promise<void> {
  const d = e.def, debut = Date.now();
  e.occupe = { debut, declencheur, ligne: null };
  e.attente = null;
  try {
    const ins = await sql("INSERT INTO pilotage_passages (module, declencheur, debut, niveau) VALUES (?, ?, ?, 'o')", [d.id, declencheur, debut]);
    e.occupe.ligne = N(ins?.insertId) || null;
  } catch (x) {
    LOG.warn?.({ module: "pilotage", id: d.id, err: message(x) }, "pilotage : passage non noté au départ");
  }
  let retour: RetourPassage | void = undefined;
  let erreur: string | null = null;
  try {
    retour = await d.passage({ manuel: declencheur === "manuel" });
  } catch (x) {
    erreur = message(x);
    LOG.error?.({ module: "pilotage", id: d.id, err: erreur }, "pilotage : passage en erreur");
  }
  const fin = Date.now();
  const ligne = e.occupe?.ligne ?? null;
  try {
    await conclure(e, declencheur, debut, fin, ligne, retour || {}, erreur);
  } catch (x) {
    LOG.warn?.({ module: "pilotage", id: d.id, err: message(x) }, "pilotage : fin de passage non notée");
  } finally {
    e.occupe = null;
    // ce que la ligne montre est relu tout de suite (crédits Tavily, dernier passage du bonus Europe)
    e.infos = null;
    if (d.id === "europe-animes") caches.delete("europe-le-anime_items");
    if (d.id === "europe-jeux") caches.delete("europe-le-game_items");
    if (declencheur === "auto") {
      let p = calculerProchain(e, "apres", debut);
      const r = (retour || {}) as RetourPassage;
      if (r.reessayerDansMs && r.reessayerDansMs > 0) p = Math.min(p, fin + ms(r.reessayerDansMs));
      armer(e, p);
    }
  }
}

async function conclure(e: Etat, declencheur: "auto" | "manuel", debut: number, fin: number, ligne: number | null, retour: RetourPassage, erreur: string | null): Promise<void> {
  const d = e.def, f = FICHE.get(d.id);
  let bilan: Record<string, any> | null = retour.bilan ?? null;
  if (!bilan && d.suivi) {
    const run = getLastRun(d.suivi);
    if (run && run.ts >= debut - 5) bilan = { ...(run.details || {}) };
  }
  if (!bilan && d.id === "sante") bilan = await lireSante();
  // le module n'a rien noté de ce passage (sauté : verrou de la base pris, rien à faire) : rien n'est noté ici non plus,
  // et la santé voit le silence comme avant
  const saute = !bilan && !!d.suivi && !erreur;
  if (erreur) bilan = { ...(bilan || {}), erreur };
  // un autre passage tenait le verrou du module (ailleurs) : rien de fait, rien de noté
  const occupeAilleurs = !!bilan?.occupe;
  if ((retour.rien || occupeAilleurs || saute) && !erreur) {
    if (ligne) await sql("DELETE FROM pilotage_passages WHERE id = ?", [ligne]).catch(() => {});
    if (declencheur === "manuel") {
      await noter("auto", "info", d.id, occupeAilleurs ? "un autre passage tenait déjà le verrou : rien de fait" : saute ? "passage sauté par le module : rien de fait" : "rien à faire pour l'instant");
    }
    return;
  }
  const pres = f?.presenter ? f.presenter(bilan || {}, { infos: e.infos?.v ?? null }) : { res: erreur ? `erreur : ${erreur}` : "terminé", nv: (erreur ? "k" : "o") as Niveau };
  const avant = DERNIERS.get(d.id);
  const p: Passage = {
    id: ligne ?? 0, module: d.id, declencheur, debut, fin, duree: fin - debut, niveau: erreur ? "k" : pres.nv, resume: coupe(pres.res, 250), bilan,
  };
  if (ligne) {
    await sql("UPDATE pilotage_passages SET fin = ?, duree_ms = ?, niveau = ?, resume = ?, bilan = ? WHERE id = ?", [
      fin, Math.min(fin - debut, 4294967295), p.niveau, p.resume, bilanTexte(bilan), ligne,
    ]).catch((x: unknown) => LOG.warn?.({ module: "pilotage", id: d.id, err: message(x) }, "pilotage : fin de passage non écrite en base"));
  } else {
    const ins = await sql("INSERT INTO pilotage_passages (module, declencheur, debut, fin, duree_ms, niveau, resume, bilan) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      d.id, declencheur, debut, fin, Math.min(fin - debut, 4294967295), p.niveau, p.resume, bilanTexte(bilan),
    ]).catch(() => null);
    p.id = N(ins?.insertId);
  }
  retenirPassage(p);
  // journal : les erreurs, le retour à la normale, les résultats qui comptent, et chaque passage lancé à la main
  // une erreur qui se répète à chaque passage n'est notée qu'une fois (la ligne du module la montre)
  if (p.niveau === "k") {
    if (declencheur === "manuel" || avant?.niveau !== "k" || avant.resume !== p.resume) await noter("auto", "err", d.id, "en erreur", pres.res.replace(/^erreur : /, ""));
  }
  else if (avant?.niveau === "k" && declencheur === "auto") await noter("auto", "ok", d.id, "de nouveau en marche", pres.res);
  else if (declencheur === "manuel") await noter("auto", p.niveau === "m" ? "warn" : "ok", d.id, "passage lancé à la main terminé", pres.res);
  else if (pres.notable) await noter("auto", pres.notable.nv === "warn" ? "warn" : pres.notable.nv === "ok" ? "ok" : "info", d.id, pres.notable.texte, pres.notable.detail);
}

/** Déclaré par chaque module au démarrage, à la place de ses setTimeout/setInterval. */
export function planifier(def: DefModule): void {
  if (ETATS.has(def.id)) {
    LOG.warn?.({ module: "pilotage", id: def.id }, "pilotage : module déjà planifié, déclaration ignorée");
    return;
  }
  const e: Etat = { def, minuteur: null, prochain: null, occupe: null, reprisLe: 0, attente: null, infos: null, premierDu: null };
  ETATS.set(def.id, e);
  ABSENTS.delete(def.id);
  if (!INTERRUPTEURS.has(def.id)) {
    // première mise en route : la valeur de .env est recopiée en base, le Pilotage la garde ensuite
    const v = def.actifParDefaut !== false;
    INTERRUPTEURS.set(def.id, v);
    if (PRET && POOL) {
      sql("INSERT IGNORE INTO pilotage_reglages (module, cle, valeur, le) VALUES (?, 'actif', ?, ?)", [def.id, v ? "1" : "0", Date.now()]).catch(() => {});
    }
  }
  e.premierDu = calculerProchain(e, "demarrage");
  armer(e, e.premierDu);
}

/** Avance le prochain passage automatique d'un module allumé (les routes AnimeSchedule après une nouvelle série). */
export function avancer(id: string, dansMs: number): void {
  const e = ETATS.get(id);
  if (!e || e.occupe || PAUSE || interrupteur(id) !== true) return;
  const quand = Date.now() + ms(dansMs);
  if (e.prochain !== null && e.prochain <= quand) return;
  armer(e, quand);
}

// ─────────────────────────────────────────────────────────────── gestes

class Refus extends Error {
  constructor(public code: number, msg: string) {
    super(msg);
  }
}

async function basculer(id: string, actif: boolean): Promise<void> {
  const e = ETATS.get(id), f = FICHE.get(id);
  if (!f) throw new Refus(404, "module inconnu");
  if (!e) throw new Refus(409, ABSENTS.get(id) ? `« ${f.nom} » n'a pas démarré : ${ABSENTS.get(id)}` : `« ${f.nom} » ne se pilote pas d'ici`);
  if (interrupteur(id) === actif) return;
  await ecrireReglage(id, "actif", actif ? "1" : "0");
  INTERRUPTEURS.set(id, actif);
  await noter("rey", "info", id, actif ? "rallumé" : "coupé");
  try {
    if (actif) await e.def.quandRallume?.();
    else await e.def.quandCoupe?.();
  } catch (x) {
    await noter("auto", "warn", id, actif ? "rallumé, mais la remise en route a échoué" : "coupé, mais le retrait a échoué", message(x));
  }
  if (actif) {
    e.reprisLe = Date.now();
    armer(e, calculerProchain(e, "rallume"));
  } else armer(e, null);
  // rallumé : les modules qui en dépendent (Steam, découverte) repartent eux aussi à leur prochain passage normal
  if (actif) {
    for (const a of ETATS.values()) {
      if (a.def.dependDe !== id) continue;
      a.reprisLe = Date.now();
      if (a.occupe || interrupteur(a.def.id) !== true) continue;
      a.attente = null;
      armer(a, calculerProchain(a, "rallume"));
    }
  }
}

async function lancer(id: string): Promise<void> {
  const e = ETATS.get(id), f = FICHE.get(id);
  if (!f) throw new Refus(404, "module inconnu");
  if (!e) throw new Refus(409, ABSENTS.get(id) ? `« ${f.nom} » n'a pas démarré : ${ABSENTS.get(id)}` : `« ${f.nom} » ne se lance pas d'ici`);
  const libre = (): void => {
    if (e.occupe) throw new Refus(409, `« ${f.nom} » est déjà en cours depuis ${heureParis(e.occupe.debut)}`);
  };
  libre();
  // le même travail lancé depuis Process (ancienne route, verrou admin_lock) : pas de second passage en même temps
  if (e.def.processAdmin && (await adminLockPris(e.def.processAdmin))) throw new Refus(409, `« ${f.nom} » tourne déjà, lancé depuis Process : réessaie à la fin`);
  libre();
  void noter("rey", "info", id, "lancé à la main");
  void executer(e, "manuel");
}

async function mettrePause(oui: boolean): Promise<void> {
  if (oui === !!PAUSE) return;
  // en base d'abord : une écriture refusée ne change rien (erreur montrée, le geste peut être refait)
  await ecrireReglage("*", "pause", oui ? "rey" : null);
  if (oui) {
    PAUSE = { depuis: Date.now(), par: "rey" };
    for (const e of ETATS.values()) armer(e, null);
    await noter("rey", "info", null, "Pause générale");
    return;
  }
  PAUSE = null;
  void noter("rey", "info", null, "Reprise de tous les modules");
  // les passages dus pendant la pause repartent un par un, à 45 s d'écart (AniList et la base sont partagés)
  let rang = 0;
  const now = Date.now();
  for (const e of ETATS.values()) {
    if (interrupteur(e.def.id) !== true) continue;
    e.reprisLe = now;
    let p = calculerProchain(e, "reprise");
    if (p <= now + ms(MIN) + 1000) p = now + ms(MIN) + ms(rang++ * 45000);
    armer(e, p);
  }
}

// ─────────────────────────────────────────────────────────────── ce que n8n envoie

const MODULES_N8N: Array<{ methode: string; chemin: string; module: string; interneExclu: boolean }> = [
  { methode: "POST", chemin: "/anime/bulk", module: "n8n-animes", interneExclu: true },
  { methode: "POST", chemin: "/games/bulk", module: "n8n-jeux", interneExclu: true },
  { methode: "POST", chemin: "/premium/generate-reminders", module: "rappels", interneExclu: false },
  { methode: "POST", chemin: "/premium/generate-alerts", module: "alertes", interneExclu: false },
  { methode: "GET", chemin: "/admin/find-duplicates", module: "doublons-n8n", interneExclu: true },
];
const SOURCES_PUSH = ["anilist", "animeschedule", "igdb", "rawg", "unknown"];
const IP_LOCALES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const ENVOIS_REGROUPES_MS = 3 * MIN;

async function noterN8n(module: string, t0: number, code: number, corps: any): Promise<void> {
  const fin = Date.now(), domaine = module === "n8n-animes" ? "anime" : module === "n8n-jeux" ? "games" : null;
  let bilan: Record<string, any>;
  if (domaine) {
    const sources: Record<string, number> = {};
    for (const s of SOURCES_PUSH) {
      const run = getLastRun(`push-${domaine}-${s}`);
      if (run && run.ts >= t0 - 5) sources[s] = N(run.details?.total);
    }
    bilan = { total: N(corps?.total), filtres: N(corps?.filtered), sources, appels: 1, code };
  } else if (module === "doublons-n8n") {
    const groupes = Array.isArray(corps?.groups) ? corps.groups.length : N(corps?.totalGroups ?? corps?.count ?? corps?.total);
    bilan = { groupes, code };
  } else {
    bilan = { created: N(corps?.created), skipped: N(corps?.skipped), code };
  }
  const avant = DERNIERS.get(module);
  // un workflow envoie ses animés en plusieurs fois : les envois à moins de 3 min d'écart n'en font qu'un
  if (domaine && avant && avant.declencheur === "n8n" && avant.fin && t0 - avant.fin < ENVOIS_REGROUPES_MS && avant.bilan) {
    const b = avant.bilan, s: Record<string, number> = { ...(b.sources || {}) };
    for (const [k, v] of Object.entries(bilan.sources as Record<string, number>)) s[k] = N(s[k]) + v;
    bilan = { total: N(b.total) + bilan.total, filtres: N(b.filtres) + bilan.filtres, sources: s, appels: N(b.appels) + 1, code: Math.max(N(b.code), code) };
    const pres = (FICHE.get(module)?.presenter ?? presenterEnvois)(bilan, { infos: null });
    const p: Passage = { ...avant, fin, duree: fin - avant.debut, niveau: pres.nv, resume: coupe(pres.res, 250), bilan };
    retenirPassage(p);
    if (p.id) {
      await sql("UPDATE pilotage_passages SET fin = ?, duree_ms = ?, niveau = ?, resume = ?, bilan = ? WHERE id = ?", [
        fin, Math.min(fin - avant.debut, 4294967295), p.niveau, p.resume, bilanTexte(bilan), p.id,
      ]).catch(() => {});
    }
    return;
  }
  const f = FICHE.get(module);
  const pres = f?.presenter ? f.presenter(bilan, { infos: null }) : { res: `${fr(N(bilan.groupes))} groupe(s)`, nv: (code >= 400 ? "k" : "o") as Niveau };
  const p: Passage = { id: 0, module, declencheur: "n8n", debut: t0, fin, duree: fin - t0, niveau: pres.nv, resume: coupe(pres.res, 250), bilan };
  retenirPassage(p);
  try {
    const ins = await sql("INSERT INTO pilotage_passages (module, declencheur, debut, fin, duree_ms, niveau, resume, bilan) VALUES (?, 'n8n', ?, ?, ?, ?, ?, ?)", [
      module, t0, fin, Math.min(fin - t0, 4294967295), p.niveau, p.resume, bilanTexte(bilan),
    ]);
    p.id = N(ins?.insertId);
  } catch {
    /* la base reviendra : le passage reste en mémoire */
  }
  if (p.niveau === "k" && avant?.niveau !== "k" && module !== "doublons-n8n") await noter("auto", "err", module, "envoi refusé par l'API", pres.res);
}

// ─────────────────────────────────────────────────────────────── lectures pour l'affichage

async function lireSante(): Promise<Record<string, any>> {
  try {
    const r = await sql("SELECT source, status, http_code, response_ms, error_msg FROM source_health ORDER BY source");
    return { sources: (r || []).map((x: any) => ({ source: String(x.source), status: String(x.status), ms: N(x.response_ms), err: x.error_msg ? String(x.error_msg) : null,
      limite: String(x.source) === "anilist" && String(x.status) === "DOWN" && N(x.http_code) === 429 })) };
  } catch {
    return { sources: [] };
  }
}

const caches = new Map<string, { le: number; v: any }>();
async function enCache<T>(cle: string, validite: number, f: () => Promise<T>): Promise<T> {
  const c = caches.get(cle);
  if (c && Date.now() - c.le < validite) return c.v as T;
  const v = await f();
  caches.set(cle, { le: Date.now(), v });
  return v;
}

async function lireSourceHealth(): Promise<Record<string, any>> {
  return enCache("source_health", 20000, async () => {
    try {
      const r = await sql("SELECT source, status, http_code, response_ms, error_msg, last_check, last_lookup_warn_msg, TIMESTAMPDIFF(HOUR, last_ok, NOW()) AS ok_h FROM source_health");
      const m: Record<string, any> = {};
      for (const x of r || []) m[String(x.source)] = x;
      return m;
    } catch {
      return {};
    }
  });
}

async function lireHd(): Promise<{ images: number; echecs: number; maj: number | null; erreur?: string }> {
  return enCache("hd", 5 * MIN, async () => {
    try {
      const r = await fetch(process.env.PILOTAGE_HD_URL || "https://gamenime.fr/hd/manifeste.json", { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { images: 0, echecs: 0, maj: null, erreur: `HTTP ${r.status}` };
      const j: any = await r.json();
      const maj = Date.parse(String(j?.maj ?? ""));
      return { images: Object.keys(j?.images || {}).length, echecs: Object.keys(j?.echecs || {}).length, maj: Number.isFinite(maj) ? maj : null };
    } catch (e) {
      return { images: 0, echecs: 0, maj: null, erreur: message(e) };
    }
  });
}

/** Le dernier passage du bonus européen d'une table, d'après la base (europe_le, écrit par NOW() : heure de la base). */
async function europeLe(table: "anime_items" | "game_items"): Promise<number | null> {
  return enCache("europe-le-" + table, 5 * MIN, async () => {
    try {
      const r = await sql(`SELECT UNIX_TIMESTAMP(MAX(europe_le)) AS t FROM ${table}`);
      const t = N(r?.[0]?.t);
      return t > 0 ? t * 1000 : null;
    } catch {
      return null;
    }
  });
}

async function lireOllama(): Promise<{ ok: boolean; modeles: string[]; charges: string[]; erreur?: string }> {
  return enCache("ollama", MIN, async () => {
    const base = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/+$/, "");
    try {
      const [t, p] = await Promise.all([
        fetch(base + "/api/tags", { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)),
        fetch(base + "/api/ps", { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!t) return { ok: false, modeles: [], charges: [], erreur: "ne répond pas" };
      const noms = (x: any) => (Array.isArray(x?.models) ? x.models.map((m: any) => String(m?.name ?? "")).filter(Boolean) : []);
      return { ok: true, modeles: [...new Set<string>(noms(t))], charges: noms(p) };
    } catch (e) {
      return { ok: false, modeles: [], charges: [], erreur: message(e) };
    }
  });
}

/** Le Top 10 du moment et la place qu'il aurait dans le classement d'avant (popularité cumulée et bonus). */
async function lireTop(domaine: "anime" | "games"): Promise<Array<[string, string, string]> | null> {
  return enCache("top-" + domaine, 5 * MIN, async () => {
    if (!APP) return null;
    try {
      const r = await APP.inject({ method: "GET", url: `/feed/${domaine}?status=released&limit=150` });
      if (r.statusCode !== 200) return null;
      const items: any[] = (r.json() as any)?.items || [];
      const avant = [...items].sort((a, b) => N(b.gameNimeScore) - N(a.gameNimeScore) || N(b.popularity) - N(a.popularity) || N(a.id) - N(b.id));
      const place = new Map(avant.map((x, k) => [N(x.id), k + 1]));
      return items.slice(0, 10).map((x, k) => {
        const p = place.get(N(x.id)) ?? 0;
        return [String(k + 1), coupe(x.titleEnglish || x.title, 80), p === 1 ? "1er" : p ? `${p}e` : "—"] as [string, string, string];
      });
    } catch {
      return null;
    }
  });
}

async function infosDe(e: Etat): Promise<Record<string, any> | null> {
  if (!e.def.infos) return null;
  if (e.infos && Date.now() - e.infos.le < 30000) return e.infos.v;
  try {
    const v = await e.def.infos();
    e.infos = { le: Date.now(), v: v || {} };
  } catch {
    e.infos = { le: Date.now(), v: e.infos?.v ?? {} };
  }
  return e.infos.v;
}

function texteRythme(f: Fiche, e: Etat | undefined): string {
  if (f.rythmeTexte) return f.rythmeTexte;
  if (!e) return f.rythme ?? "—";
  const d = e.def;
  if (d.heuresUtc && d.heuresUtc.length) {
    const auj = new Date();
    const base = Date.UTC(auj.getUTCFullYear(), auj.getUTCMonth(), auj.getUTCDate());
    const heures = d.heuresUtc.map((h) => heureParis(base + Math.round(h * H)));
    if (heures.length === 1) return `chaque jour à ${heures[0]}`;
    const courtes = heures.map((h) => (h.endsWith(":00") ? `${Number(h.slice(0, 2))} h` : h));
    return `${heures.length} fois par jour (${courtes.join(", ")})`;
  }
  const r = d.rythmeMs ?? H;
  if (r === H) return "toutes les heures";
  if (r === 24 * H) return "chaque jour";
  if (r % H === 0) return `toutes les ${r / H} h`;
  return `toutes les ${Math.round(r / MIN)} min`;
}

const PROCHAIN_N8N: Record<string, number> = { "n8n-animes": 3 * H, "n8n-jeux": 2 * H, rappels: 24 * H, alertes: 3 * H, "doublons-n8n": 5 * MIN };

async function ligneModule(f: Fiche): Promise<Record<string, any>> {
  const e = ETATS.get(f.id);
  const dernier = DERNIERS.get(f.id) ?? null;
  const histo = (HISTOS.get(f.id) ?? []).map((x) => ({ nv: x.nv, duree: x.duree }));
  const m: Record<string, any> = {
    id: f.id, fam: f.fam, nom: f.nom, role: f.role, src: f.src, coupe: f.coupe ?? null, rallume: f.rallume ?? null,
    lancerLib: f.lancerLib ?? null, confirmer: f.confirmer ?? null, pilote: f.pilote ?? null, sansLancer: f.sansLancer ?? null,
    reglages: [], histo, alerte: null, chiffre: null, details: null, jauges: null, donnees: null, etatTexte: null, encours: null, prochain: null,
    pausable: false, lancerNote: null,
  };
  const pres = (b: Record<string, any> | null, infos: Record<string, any> | null) => (f.presenter && b ? f.presenter(b, { infos }) : null);
  const dern = (p: Passage | null) => (p ? { fin: iso(p.fin ?? p.debut), duree: p.duree == null ? null : Math.max(1, Math.round(p.duree / 1000)), res: p.resume, nv: p.niveau } : null);

  if (e) {
    // un cycle de l'API
    const actif = interrupteur(f.id) === true;
    const infos = await infosDe(e);
    const pr = pres(dernier?.bilan ?? null, infos);
    m.sw = actif;
    m.lancer = true;
    m.pausable = true;
    m.rythme = texteRythme(f, e);
    m.dernier = dern(dernier);
    m.prochain = iso(e.prochain);
    if (f.id === "europe-animes" || f.id === "europe-jeux") {
      // un contrôle toutes les heures, mais un passage seulement 23 h après le dernier (d'après la base), ou 6 h après
      // un échec ou une lecture arrêtée en route : le contrôle qui fera le prochain passage réel. Avant le premier
      // passage noté par le Pilotage, le dernier est celui que la base connaît.
      const le = await europeLe(f.id === "europe-animes" ? "anime_items" : "game_items");
      if (e.prochain) {
        const seuil = Math.max(N(infos?.prochainEssai), infos?.incomplet || !le ? 0 : le + 23 * H);
        const pas = ms(e.def.rythmeMs ?? H);
        let p = e.prochain;
        while (p < seuil) p += pas;
        m.prochain = iso(p);
      }
      if (!dernier && le) m.dernier = { fin: iso(le), duree: null, res: "passage d'avant le Pilotage", nv: "o" };
    }
    if (pr) Object.assign(m, { chiffre: pr.chiffre ?? null, details: pr.details ?? null, jauges: pr.jauges ?? null, donnees: pr.donnees ?? null, alerte: pr.alerte ?? null });
    if (f.id === "synopsis") {
      // ses chiffres (à valider, validés…) se lisent en direct, même avant son premier passage ; il contrôle toutes
      // les 10 min mais ne rédige que dans sa fenêtre horaire : la ligne montre la fenêtre et le vrai prochain passage
      if (!pr && infos) {
        const p0 = presenterSynopsis({}, { infos });
        Object.assign(m, { chiffre: p0.chiffre ?? null, donnees: p0.donnees ?? null });
      }
      if (infos?.rythme) m.rythme = String(infos.rythme);
      const ouverture = N(infos?.ouverture);
      if (e.prochain && ouverture > e.prochain) {
        const pas = ms(e.def.rythmeMs ?? H);
        let p = e.prochain;
        while (p < ouverture) p += pas;
        m.prochain = iso(p);
      }
      m.lien = { h: "#page-synopsis", l: "Ouvrir le bloc Synopsis" };
    }
    if (dernier?.niveau === "k" && !m.alerte) m.alerte = dernier.resume.replace(/^erreur : /, "Erreur : ");
    if (dernier?.niveau !== "k" && dernier?.niveau !== "m") m.alerte = null;
    if (f.id === "moment-animes" || f.id === "moment-jeux") {
      const top = await lireTop(f.id === "moment-animes" ? "anime" : "games");
      if (top && top.length) m.donnees = { t: "Top 10 du moment (place d'avant)", l: top };
    }
    if (f.lancerNote) m.lancerNote = f.lancerNote(infos);
    if (f.id === "doublons") {
      // ce que n8n cherche de son côté, à blanc, toutes les 5 min
      const n = DERNIERS.get("doublons-n8n");
      if (n) {
        m.details = [...(m.details ?? []), ["Recherche n8n (à blanc)", `à ${heureParis(n.fin ?? n.debut)} · ${pl(N(n.bilan?.groupes), "groupe", "groupes")}`]];
      }
    }
    if (e.occupe) {
      m.etat = "run";
      m.encours = { depuis: iso(e.occupe.debut), avance: e.occupe.declencheur === "manuel" ? "lancé à la main" : null };
    } else if (!actif) m.etat = "off";
    else if (e.def.dependDe && interrupteur(e.def.dependDe) !== true) {
      m.etat = "wait";
      m.etatTexte = `arrêté avec « ${FICHE.get(e.def.dependDe)?.nom ?? e.def.dependDe} »`;
      m.prochain = null;
    } else if (e.attente) {
      m.etat = "wait";
      m.etatTexte = e.attente;
    } else if (dernier?.niveau === "k") m.etat = "err";
    else m.etat = "ok";
    return m;
  }

  m.sw = null;
  m.lancer = false;
  m.rythme = f.rythme ?? "—";
  if (f.src === "n8n") {
    m.etat = "ext";
    m.dernier = dern(dernier);
    const pr = pres(dernier?.bilan ?? null, null);
    if (pr) Object.assign(m, { chiffre: pr.chiffre ?? null, details: pr.details ?? null, alerte: pr.alerte ?? null });
    if (dernier?.fin && PROCHAIN_N8N[f.id]) {
      let p = dernier.debut + PROCHAIN_N8N[f.id];
      while (p < Date.now() - 5 * MIN) p += PROCHAIN_N8N[f.id];
      m.prochain = iso(p);
    }
    if (!dernier) m.etatTexte = "aucun envoi reçu depuis la mise en place";
    return m;
  }
  if (f.id === "images-hd") {
    const hd = await lireHd();
    m.etat = hd.erreur ? "wait" : "ok";
    m.etatTexte = hd.erreur ? "manifeste illisible" : null;
    m.dernier = hd.maj ? { fin: iso(hd.maj), duree: null, res: `${pl(hd.images, "jaquette en HD", "jaquettes en HD")}`, nv: "o" } : null;
    m.chiffre = { v: fr(hd.images), l: "jaquettes en HD" };
    m.details = [["Jaquettes en HD", fr(hd.images)], ["Échecs", fr(hd.echecs)], ["Dernière nouveauté", hd.maj ? heureParis(hd.maj) : "—"]];
    if (hd.erreur) m.alerte = `Manifeste des images HD illisible : ${hd.erreur}.`;
    m.prochain = iso(creneauSuivant(Date.now(), Array.from({ length: 24 }, (_, h) => h + 23 / 60)));
    return m;
  }
  // un cycle de l'API qui n'a pas démarré (configuration incomplète)
  m.etat = "wait";
  m.etatTexte = ABSENTS.has(f.id) ? "pas démarré" : "pas démarré avec l'API";
  m.alerte = ABSENTS.get(f.id) ?? null;
  m.pilote = { t: "Pas démarré.", d: ABSENTS.get(f.id) ?? "Ce module n'a pas démarré avec l'API." };
  m.sansLancer = "Pas démarré";
  m.dernier = dern(dernier);
  return m;
}

async function services(): Promise<Array<Record<string, any>>> {
  const sh = await lireSourceHealth();
  const sv: Array<Record<string, any>> = [];
  const source = (nom: string, cle: string, extra?: string) => {
    const x = sh[cle];
    if (!x) return { nom, etat: "warn", detail: "Pas encore vérifié" };
    const up = String(x.status) === "UP";
    const quand = heureMur(x.last_check) ? ` · vérifié à ${heureMur(x.last_check)}` : "";
    // AniList qui limite les requêtes (429) : « limité », pas « panne » ; rouge si aucun contrôle réussi depuis 24 h
    if (cle === "anilist" && String(x.status) === "DOWN" && N(x.http_code) === 429) {
      const vieux = x.ok_h == null || N(x.ok_h) >= 24;
      return { nom, etat: vieux ? "crit" : "warn", detail: `Limité (HTTP 429, trop de requêtes)${vieux ? " depuis plus de 24 h" : ""}${quand}` };
    }
    return {
      nom, etat: up ? (extra ? "warn" : "ok") : "crit",
      detail: up ? `Répond · ${fr(N(x.response_ms))} ms${quand}${extra ? " · " + extra : ""}` : `Ne répond pas${x.error_msg ? " : " + coupe(x.error_msg, 90) : ""}${quand}`,
    };
  };
  sv.push(source("AniList", "anilist"));
  sv.push(source("IGDB · Twitch", "igdb", sh.igdb?.last_lookup_warn_msg ? coupe(sh.igdb.last_lookup_warn_msg, 80) : undefined));
  // Steam : son dernier passage
  const st = DERNIERS.get("steam");
  const stb = st?.bilan || {};
  sv.push(
    !st ? { nom: "Steam", etat: "warn", detail: "Pas encore de passage" }
      : stb.erreur ? { nom: "Steam", etat: "crit", detail: `Dernier passage en erreur : ${coupe(stb.erreur, 90)}` }
      : stb.arret ? { nom: "Steam", etat: "warn", detail: `${coupe(stb.arret, 90)} à ${heureParis(st.fin ?? st.debut)} · reprise au prochain passage` }
      : { nom: "Steam", etat: "ok", detail: `Dernier passage à ${heureParis(st.fin ?? st.debut)} · ${pl(N(stb.lues), "page lue", "pages lues")}` },
  );
  // Tavily : crédits du mois (comptés par le module) et forfait
  const te = ETATS.get("tavily");
  if (te) {
    const i = (await infosDe(te)) || {};
    const tb = DERNIERS.get("tavily")?.bilan || {};
    const fo = /^(\d+)\/(\d+)$/.exec(String(tb.forfait ?? ""));
    const reste = fo ? ` · ${fr(Math.max(0, N(fo[2]) - N(fo[1])))} crédits restants au forfait` : "";
    const maxMois = N(i.maxParMois) || 900;
    sv.push({
      nom: "Tavily", etat: interrupteur("tavily") === true ? "ok" : "off",
      detail: (interrupteur("tavily") === true ? `${fr(N(i.jour))} crédits aujourd'hui sur ${fr(N(i.maxParJour) || 25)}` : "Coupé") + reste,
      jauge: { v: N(i.mois), max: maxMois, l: `crédits ce mois, sur ${fr(maxMois)}` },
    });
  } else sv.push({ nom: "Tavily", etat: "off", detail: ABSENTS.get("tavily") ?? "Pas démarré" });
  const ol = await lireOllama();
  const modele = process.env.SYNOPSIS_MODEL || "ministral-3:8b";
  sv.push(
    ol.ok
      ? { nom: "Ollama", etat: ol.modeles.includes(modele) ? "ok" : "warn", detail: `${modele}${ol.modeles.includes(modele) ? "" : " absent"} · ${ol.charges.length ? "en train de travailler" : "libre"}` }
      : { nom: "Ollama", etat: "crit", detail: `Ne répond pas${ol.erreur ? " : " + coupe(ol.erreur, 80) : ""}` },
  );
  // Wikipédia · Wikidata : les deux passages du bonus européen
  const reel = (p: Passage | undefined) => (p && p.bilan ? p : undefined);
  const ea = reel(DERNIERS.get("europe-animes")), ej = reel(DERNIERS.get("europe-jeux"));
  const pire = [ea, ej].filter(Boolean).find((p) => p!.niveau === "k" || p!.niveau === "m");
  const recent = [ea, ej].filter(Boolean).sort((a, b) => (b!.fin ?? 0) - (a!.fin ?? 0))[0];
  sv.push(
    !recent ? { nom: "Wikipédia · Wikidata", etat: "warn", detail: "Pas encore de passage" }
      : pire ? { nom: "Wikipédia · Wikidata", etat: pire.niveau === "k" ? "crit" : "warn", detail: coupe(pire.resume, 110) }
      : { nom: "Wikipédia · Wikidata", etat: "ok", detail: `Dernier passage à ${heureParis(recent.fin ?? recent.debut)} · 0 erreur` },
  );
  sv.push(
    process.env.YOUTUBE_API_KEY
      ? { nom: "YouTube", etat: "ok", detail: "Clé présente : la chaîne de chaque lien YouTube d'AniList est vérifiée" }
      : { nom: "YouTube", etat: "off", detail: "Clé absente du conteneur : les liens YouTube d'AniList sont gardés sans vérifier la chaîne" },
  );
  sv.push(source("AnimeSchedule", "animeschedule"));
  sv.push(source("Kitsu", "kitsu"));
  const hooks = ["DISCORD_WEBHOOK_ERRORS", "DISCORD_WEBHOOK_WORKFLOWS"].filter((k) => !!process.env[k]);
  sv.push({ nom: "Discord", etat: hooks.length === 2 ? "ok" : hooks.length ? "warn" : "off", detail: hooks.length === 2 ? "Alertes et réparations : les deux canaux sont branchés" : hooks.length ? "Un seul canal branché" : "Aucun canal branché" });
  return sv;
}

async function journal(): Promise<Array<Record<string, any>>> {
  try {
    const r = await sql("SELECT le, qui, niveau, module, texte, detail FROM pilotage_journal ORDER BY le DESC, id DESC LIMIT 80");
    return (r || []).map((x: any) => {
      const id = x.module ? String(x.module) : null;
      const nom = id ? FICHE.get(id)?.nom ?? (id === "doublons-n8n" ? "Doublons (n8n)" : id) : null;
      // « Tavily coupé » pour tes gestes ; « Steam : en erreur » pour ce que font les modules
      const txt = (nom ? `<b>${esc(nom)}</b>${x.qui === "rey" ? " " : " : "}${esc(x.texte)}` : `<b>${esc(x.texte)}</b>`) +
        (x.detail ? ` · <span>${esc(x.detail)}</span>` : "");
      return { t: iso(N(x.le)), qui: x.qui === "rey" ? "Rey" : String(x.qui), nv: String(x.niveau), txt };
    });
  } catch {
    return [];
  }
}

async function lireTout(): Promise<Record<string, any>> {
  const modules = await Promise.all(FICHES.map((f) => ligneModule(f)));
  return {
    maintenant: new Date().toISOString(),
    pause: PAUSE ? { depuis: iso(PAUSE.depuis), par: "Rey" } : null,
    familles: FAMILLES,
    modules,
    services: await services(),
    journal: await journal(),
    demarre: iso(DEMARRE_LE),
  };
}

// ─────────────────────────────────────────────────────────────── routes et crochets

function cleAttendue(): string {
  return process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY || "";
}
function cleBonne(fournie: unknown): boolean {
  const attendue = cleAttendue();
  if (!attendue || typeof fournie !== "string") return false;
  const a = Buffer.from(attendue), b = Buffer.from(fournie);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Les deux sortes de modules du Pilotage absents d'un module à part : la purge des sessions et les doublons. */
function planifierInternes(app: FastifyInstance): void {
  planifier({
    id: "sessions", premierMs: 12 * MIN, rythmeMs: 24 * H, actifParDefaut: true,
    passage: async () => {
      // expires_at est écrit en UTC (l'API tourne en UTC, la connexion le vérifie en UTC) ; NOW() est l'heure de Paris
      const r: any = await sql("DELETE FROM user_sessions WHERE expires_at < UTC_TIMESTAMP()");
      return { bilan: { retirees: N(r?.affectedRows) } };
    },
  });
  planifier({
    id: "doublons", premierMs: 28 * MIN, rythmeMs: H, actifParDefaut: false,
    passage: async () => {
      const r = await app.inject({
        method: "POST", url: "/admin/merge-duplicates?dryRun=false&type=all",
        headers: { "x-api-key": process.env.ANIME_API_KEY || "", "x-gn-pilotage": JETON },
      });
      const j: any = (() => {
        try {
          return r.json();
        } catch {
          return null;
        }
      })();
      if (r.statusCode === 409) return { bilan: { occupe: true }, reessayerDansMs: 10 * MIN };
      if (r.statusCode !== 200 || !j) throw new Error(`fusion refusée (HTTP ${r.statusCode}${j?.msg || j?.error ? " : " + coupe(j.msg || j.error, 100) : ""})`);
      return { bilan: { totalGroups: N(j.totalGroups), itemsMerged: N(j.itemsMerged), itemsDeleted: N(j.itemsDeleted), relationsMigrated: N(j.relationsMigrated) } };
    },
  });
}

/**
 * Branché dans index.ts, juste après admin-runs : les crochets doivent exister avant les routes qu'ils regardent.
 * Crée les tables, relit les interrupteurs, la pause et les derniers passages, puis sert les routes.
 */
export async function registerPilotage(app: FastifyInstance, pool: any): Promise<void> {
  POOL = pool;
  APP = app;
  LOG = app.log;
  DEMARRE_LE = Date.now();
  try {
    await creerTables();
    await chargerEtat();
  } catch (e) {
    app.log.error({ module: "pilotage", err: message(e) }, "pilotage : état non relu (base) : les modules partent avec les valeurs de .env");
  }
  PRET = true;
  // les modules déjà déclarés (aucun d'ordinaire : index.ts appelle ceci avant eux) gardent leur valeur de .env
  for (const e of ETATS.values()) {
    e.premierDu = calculerProchain(e, "demarrage");
    armer(e, e.premierDu);
  }

  // ── crochets : départ des requêtes qui intéressent le Pilotage, refus des doubles lancements
  app.addHook("onRequest", async (req: any, reply: any) => {
    const chemin = String(req.url || "").split("?")[0].replace(/\/+$/, "");
    const n8n = MODULES_N8N.find((x) => x.methode === req.method && x.chemin === chemin);
    if (n8n && !(n8n.interneExclu && IP_LOCALES.has(String(req.ip)))) req.gnPilotage = { t0: Date.now(), module: n8n.module };
    if (req.method !== "POST" || req.headers["x-gn-pilotage"] === JETON) return;
    const m = /^\/admin\/([a-z0-9-]+)$/.exec(chemin);
    const id = m ? PROCESS_MODULE[m[1] as string] : undefined;
    const e = id ? ETATS.get(id) : undefined;
    if (e?.occupe) {
      return reply.code(409).send({
        ok: false, verrou: true, detenu_par: id,
        msg: `Le passage de « ${FICHE.get(id as string)?.nom ?? id} » tourne déjà (depuis ${heureParis(e.occupe.debut)}). Réessaie à la fin.`,
      });
    }
  });
  app.addHook("onSend", (req: any, reply: any, payload: any, done: (err: Error | null, p?: any) => void) => {
    const g = req.gnPilotage;
    if (g) {
      req.gnPilotage = null;
      let corps: any = null;
      try {
        corps = typeof payload === "string" ? JSON.parse(payload) : null;
      } catch {
        corps = null;
      }
      void noterN8n(g.module, g.t0, Number(reply.statusCode) || 0, corps).catch(() => {});
    }
    done(null, payload);
  });

  // ── routes (clé vérifiée ici, pas seulement par nginx)
  const garde = async (req: any, reply: any): Promise<boolean> => {
    if (!cleAttendue()) {
      reply.code(500).send({ ok: false, msg: "clé d'administration non configurée" });
      return false;
    }
    if (!cleBonne(req.headers["x-api-key"])) {
      reply.code(401).send({ ok: false, msg: "non autorisé" });
      return false;
    }
    return true;
  };
  const refus = (reply: any, e: unknown) => {
    if (e instanceof Refus) return reply.code(e.code).send({ ok: false, msg: e.message });
    LOG.error?.({ module: "pilotage", err: message(e) }, "pilotage : geste en erreur");
    return reply.code(500).send({ ok: false, msg: message(e) });
  };
  const idDe = (b: any): string => (typeof b?.id === "string" && /^[a-z0-9-]{2,40}$/.test(b.id) ? b.id : "");

  app.get("/admin/pilotage", async (req: any, reply: any) => {
    if (!(await garde(req, reply))) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.send(await lireTout());
  });
  app.post("/admin/pilotage/basculer", async (req: any, reply: any) => {
    if (!(await garde(req, reply))) return reply;
    const id = idDe(req.body);
    if (!id || typeof req.body?.actif !== "boolean") return reply.code(400).send({ ok: false, msg: "id et actif (vrai ou faux) attendus" });
    try {
      await basculer(id, req.body.actif);
      return reply.send({ ok: true });
    } catch (e) {
      return refus(reply, e);
    }
  });
  app.post("/admin/pilotage/lancer", async (req: any, reply: any) => {
    if (!(await garde(req, reply))) return reply;
    const id = idDe(req.body);
    if (!id) return reply.code(400).send({ ok: false, msg: "id attendu" });
    try {
      await lancer(id);
      return reply.code(202).send({ ok: true, lance: true });
    } catch (e) {
      return refus(reply, e);
    }
  });
  app.post("/admin/pilotage/pause", async (req: any, reply: any) => {
    if (!(await garde(req, reply))) return reply;
    if (typeof req.body?.oui !== "boolean") return reply.code(400).send({ ok: false, msg: "oui (vrai ou faux) attendu" });
    try {
      await mettrePause(req.body.oui);
      return reply.send({ ok: true });
    } catch (e) {
      return refus(reply, e);
    }
  });

  planifierInternes(app);
  void menage();
  const m = setInterval(() => void menage(), 6 * H);
  (m as any).unref?.();
  void noter("auto", "info", null, "API démarrée", PAUSE ? "pause générale toujours en cours" : null);
  app.log.info({ module: "pilotage", pause: !!PAUSE, interrupteurs: INTERRUPTEURS.size }, "pilotage : actif");
}

/** Pour les essais seulement : remet le Pilotage à zéro (minuteurs arrêtés). */
export function _oublierPourEssais(): void {
  for (const e of ETATS.values()) if (e.minuteur) clearTimeout(e.minuteur);
  ETATS.clear();
  ABSENTS.clear();
  INTERRUPTEURS.clear();
  DERNIERS.clear();
  COMPLETS.clear();
  HISTOS.clear();
  caches.clear();
  PAUSE = null;
  PRET = false;
}
