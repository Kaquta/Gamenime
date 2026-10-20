/**
 * tavily.ts — Recherche ciblée des plateformes annoncées pour la France, anime par anime.
 *
 * La presse (presse.ts) lit ce qui vient de paraître ; AniList ne connaît pas ADN. Ce module
 * cherche, pour chaque anime INCOMPLET du site, l'article qui annonce où il est diffusé en France :
 * une recherche Tavily (1 crédit, sur des sites de confiance seulement), puis les pages sont lues
 * par GameNime API elle-même (robots.txt respecté, sans crédit), et la même chaîne que la presse
 * fait le reste : Ollama extrait, le code VÉRIFIE chaque réponse contre le texte (presse.ts :
 * verifier). Dans le doute, rien n'est gardé. Les annonces gardées vont dans annonces_fr ; le
 * module plateformes les ajoute aux animes (et prévient les abonnés), comme pour la presse.
 *
 * Animes cherchés (fenêtre du site, animes seulement) :
 *   - J-7 : sortie dans 0 à 7 jours (date au jour près) et sans plateforme : en premier, une fois par
 *     jour ; sortie connue au mois près, dans le mois qui commence ou en cours, sans plateforme ou sans
 *     date : une fois par semaine ;
 *   - sortis sans plateforme (masqués du site) : chaque semaine le premier mois après la sortie,
 *     puis chaque mois ; abandonnés 3 mois après la sortie (un anime sorti depuis plus longtemps est
 *     cherché une fois) ;
 *   - à venir sans plateforme : chaque semaine si la sortie est dans moins de 2 mois, sinon (ou si elle
 *     n'est connue qu'à l'année) chaque mois.
 *   - film au cinéma en France (annonce « Cinéma » avec sa date, au plus 60 jours avant la sortie au
 *     Japon : sinon c'est une avant-première de festival) : le cinéma vaut « trouvé » (J-7, sorti,
 *     à venir) ; ensuite, chaque mois, sa plateforme est cherchée (motif « cinema »), sans abandon,
 *     tant que la date du cinéma est dans la fenêtre du site.
 *   Ordre : J-7, puis du plus populaire au moins populaire. Un anime trouvé (une de nos plateformes
 *   annoncée pour la France, et la date si J-7) n'est plus cherché.
 * Budget : TAVILY_MAX_PAR_JOUR (25) et TAVILY_MAX_PAR_MOIS (900) crédits (une recherche « basic » : 1 ; Tavily Extract : 2) ;
 * avant chaque passage, le forfait est relu chez Tavily (/usage, gratuit) : on s'arrête avant sa
 * limite, et sans forfait lisible on ne cherche pas (jamais de dépassement payant). Chaque recherche
 * est comptée AVANT d'être envoyée. Si Ollama tombe après une recherche, ses pages sont reprises au
 * passage suivant sans nouvelle recherche.
 * Contre les faux positifs (en plus de la vérification de la presse) : seule la date de publication
 * de la page compte ; texte pris dans le JSON-LD ou le premier <article>, sans commentaires, « à lire
 * aussi » ni boutons de partage ; une suite (saison 2…) doit être nommée avec sa saison dans la
 * phrase ; les adaptations en prises de vues réelles sont écartées.
 * Lecture des pages (17 octobre 2026, d'après le diagnostic du 10) :
 *   - pages lues jusqu'à 3 Mo ; scripts, styles et dessins retirés avant d'en tirer le texte, balises
 *     jamais refermées neutralisées (sinon des minutes de calcul, l'API attendant) ;
 *   - page sans texte chez nous (Crunchyroll News, dessinée par le navigateur) : le texte que Tavily en
 *     a lu (include_raw_content, même prix), réduit aux lignes qui nomment l'anime et aux deux suivantes
 *     (sur une page-liste : ses passages) ; date de la page, sinon celle de son adresse (« /2026/7/31/ ») ;
 *   - page sans texte chez nous ni dans la recherche (Crunchyroll News : Tavily n'en donne rien) : lue par Tavily Extract
 *     « advanced » (2 crédits pour 5 pages lues, rien pour une page qui échoue), autant qu'Ollama en lira, si les plafonds
 *     et le forfait le permettent ; jamais une page que la presse a déjà lue (le flux de Crunchyroll News) ; le texte lu
 *     est gardé avec la recherche (une reprise ne paie pas deux fois) et contrôlé comme le texte de Tavily ;
 *   - page-liste (3 autres animes du catalogue dans des intertitres) : Ollama ne lit que les passages de
 *     l'anime cherché (l'intertitre consacré à lui et ce qui suit, jusqu'à la prochaine limite) ;
 *   - page lue par passages (page-liste, texte de Tavily) : une annonce n'est gardée que si sa phrase nomme
 *     l'anime par un titre complet, ou fait partie de son entrée (sous l'intertitre qui lui est consacré : ses
 *     rubriques de diffusion « Date de sortie : … », « Plateforme : … », et avant elles ses seules phrases
 *     d'annonce sans autre nom propre, « L'anime sera diffusé sur ADN… », « Crunchyroll will stream the
 *     series… »), sans nommer d'autre anime ni se trouver sous l'intertitre d'un autre, avec la plateforme
 *     dans la phrase même : jamais d'après le voisinage (l'entrée suivante, la conclusion) ;
 *   - partout : une phrase qui parle d'une autre œuvre (comparaison, « si X vous plaît », « la série », « les
 *     films d'avant », un film pour une série) ne donne à un film que sa sortie au cinéma, et seulement s'il
 *     en est le sujet ; rien quand elle compare l'anime à une autre œuvre (« les fans de X » : seulement si X
 *     n'est pas l'anime) ; l'incise « Le film X, suite de la série, arrivera sur… » ne compte pas ;
 *   - film : une plateforme n'est gardée que dans une phrase qui ne parle ni des salles, ni d'un distributeur
 *     (« … au cinéma le 22 octobre, distribué par Crunchyroll », « Crunchyroll sortira le film… » : rien), ni de
 *     l'histoire d'avant (« L'histoire est disponible sur ADN ; le film la prolonge… ») ; le cinéma, seulement pour
 *     la sortie en France (pas une avant-première, une séance d'un soir, une sélection de salles ou le Japon) ;
 *   - l'anime cherché est toujours le premier nommé ; titre « X: Y » reconnu écrit « X - … - Y » ; un
 *     « ! » dans un titre (« BanG Dream! ») ne coupe plus la phrase ; un titre court qui est le titre complet
 *     d'un autre anime (la série, pour le film) ne désigne pas l'anime ; l'annonce doit nommer l'anime
 *     vraiment, pas seulement dans le titre plus long d'un autre (attribution) ; un film n'est jamais
 *     désigné par son titre court (celui de la série, souvent hors du catalogue), et une phrase sur la
 *     série ne lui est pas attribuée d'après les phrases d'avant.
 *
 * Tables : tavily_recherches (une ligne par recherche) ; presse_articles et annonces_fr comme la presse.
 *
 * Variables :
 *   TAVILY_ENABLED       « 1 » pour le passage automatique (toutes les 2 h ; premier 45 min après le démarrage)
 *   TAVILY_API_KEY       la clé (jamais écrite dans un journal)
 *   TAVILY_MAX_PAR_JOUR, TAVILY_MAX_PAR_MOIS, TAVILY_MAX_PAR_PASSAGE (3)
 *   OLLAMA_URL, SYNOPSIS_MODEL, SYNOPSIS_THREADS : les mêmes que la presse
 *   TAVILY_URL, TAVILY_DOMAINES : seulement pour les tests
 */
import { setInterval, setTimeout } from "node:timers";
import { pushActivity, trackLastRun } from "./dashboard.js";
import { planifier, moduleIndisponible, type RetourPassage } from "./pilotage.js";
import { cinemaRetenu, nomDuSite, vide } from "./plateformes.js";
import {
  alias,
  animesCites,
  articleJsonLd,
  AUTRES_SAISONS,
  configEssai as configPresse,
  contient,
  coupe,
  dateDansTexte,
  decoder,
  decouperPhrases,
  EDITEUR_CR,
  EDITION,
  empreinte,
  enregistrerAnnonce,
  jjmmaaaa,
  JEU_SUJET,
  LIVRE_SUJET,
  lireJson,
  meilleures,
  messages,
  norm,
  numeroSaison,
  ollama,
  OllamaIndisponible,
  parleDePlateforme,
  PLATEFORMES,
  PRISES_REELLES,
  robotsAutorise,
  saisonsCitees,
  texteDePage,
  verifier,
  verifierOllama,
  type Alias,
  type AnimeCat,
  type Article,
  type Cite,
  type Journal,
  type PresseConfig,
  type SqlPool,
  type Verdict,
} from "./presse.js";

// ─────────────────────────────────────────────────────────────── réglages
const AGENT = "GameNimeBot/1.0 (+https://gamenime.fr)";
const PREMIER_PASSAGE_MS = 45 * 60 * 1000; // après la presse (3 min) et le module plateformes (30 min)
const PASSAGE_MS = 2 * 60 * 60 * 1000;
const RESULTATS_DEMANDES = 8; // le nombre de résultats ne change pas le prix d'une recherche
const TAILLE_BRUT = 300_000; // texte d'une page lu par Tavily : gardé jusqu'à 300 000 caractères, avant réduction
// Tavily Extract « advanced » : 2 crédits par lot de 5 pages lues (une demande de 1 à 5 pages ne coûte jamais plus de 2).
const EXTRACT_COUT = 2;
const MARGE_FORFAIT = 10; // crédits laissés de côté avant la limite du forfait Tavily
const SANS_TRAITEMENT_H = 72; // recherche dont les pages n'ont pas pu être lues en 3 jours : abandonnée
const JOURS_ABANDON = 90;
const JOURS_PREMIER_MOIS = 30;
const JOURS_PROCHE = 60; // « à venir » : chaque semaine si la sortie est dans moins de 2 mois

export interface Domaine {
  domaine: string;
  nom: string; // 20 caractères au plus (colonne source)
  officiel: boolean; // site de la plateforme : lu en premier
  langue?: Article["langue"]; // langue par défaut, si la page ne la dit pas
}
/** Sites de confiance : presse anime française, plateformes, ANN. Leur robots.txt est respecté page par page. */
export const DOMAINES: Domaine[] = [
  { domaine: "animationdigitalnetwork.com", nom: "ADN News", officiel: true, langue: "fr" },
  { domaine: "crunchyroll.com", nom: "Crunchyroll News", officiel: true, langue: "en" },
  { domaine: "adala-news.fr", nom: "Adala News", officiel: false },
  { domaine: "animotaku.fr", nom: "AnimOtaku", officiel: false },
  { domaine: "manga-news.com", nom: "Manga-News", officiel: false, langue: "fr" },
  { domaine: "animeland.fr", nom: "AnimeLand", officiel: false },
  { domaine: "journaldujapon.com", nom: "Journal du Japon", officiel: false, langue: "fr" },
  { domaine: "gameblog.fr", nom: "Gameblog", officiel: false },
  { domaine: "dexerto.fr", nom: "Dexerto", officiel: false },
  { domaine: "jeuxvideo.com", nom: "Jeuxvideo.com", officiel: false, langue: "fr" },
  { domaine: "numerama.com", nom: "Numerama", officiel: false, langue: "fr" },
  { domaine: "journaldugeek.com", nom: "Journal du Geek", officiel: false, langue: "fr" },
  { domaine: "fr.ign.com", nom: "IGN France", officiel: false, langue: "fr" },
  { domaine: "hitek.fr", nom: "Hitek", officiel: false },
  { domaine: "allocine.fr", nom: "AlloCiné", officiel: false },
  { domaine: "animenewsnetwork.com", nom: "ANN", officiel: false, langue: "en" },
];

export interface TavilyConfig {
  cle: string;
  url: string;
  maxParJour: number;
  maxParMois: number;
  maxParPassage: number;
  pagesParAnime: number; // pages lues au plus par recherche
  articlesParAnime: number; // articles envoyés à Ollama au plus par recherche
  domaines: Domaine[];
  presse: PresseConfig; // Ollama
}

export function lireConfig(env: Record<string, string | undefined> = process.env): TavilyConfig | null {
  if (env["TAVILY_ENABLED"] !== "1") return null;
  return configEssai(env);
}
export function configEssai(env: Record<string, string | undefined> = process.env): TavilyConfig {
  const entier = (v: string | undefined, def: number, min: number, max: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  // Tests : « hote=Nom,hote2=Nom 2 » (sites de test en langue française).
  const test = String(env["TAVILY_DOMAINES"] || "").trim();
  const domaines = test
    ? test.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
        const [d, n] = x.split("=");
        return { domaine: String(d).trim().toLowerCase(), nom: coupe(String(n || d).trim(), 20), officiel: /officiel/i.test(String(n || "")), langue: "fr" as const };
      })
    : DOMAINES;
  return {
    cle: String(env["TAVILY_API_KEY"] || "").trim(),
    url: (env["TAVILY_URL"] || "https://api.tavily.com").replace(/\/+$/, ""),
    maxParJour: entier(env["TAVILY_MAX_PAR_JOUR"], 25, 0, 200),
    maxParMois: entier(env["TAVILY_MAX_PAR_MOIS"], 900, 0, 5000),
    maxParPassage: entier(env["TAVILY_MAX_PAR_PASSAGE"], 3, 1, 10),
    pagesParAnime: 4,
    articlesParAnime: 2,
    domaines,
    presse: configPresse(env),
  };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pluriel = (n: number, mot: string, motPluriel = mot + "s") => `${n} ${n > 1 ? motPluriel : mot}`;

// ─────────────────────────────────────────────────────────────── file d'attente
export type Motif = "j7" | "sorti" | "avenir" | "cinema";
export interface Cible {
  anime: AnimeCat;
  motif: Motif | null; // null : complet, pas cherché
  manque: Array<"plateforme" | "date">;
  sortie: string; // AAAA-MM-JJ (le 1er du mois ou de l'année si la date n'est pas au jour près)
  precision: string | null;
  jours: number; // jusqu'à la sortie (le début du mois ou de l'année si imprécise), négatif si passée
  joursDepuisSortie: number | null; // sorti : jours depuis la sortie (la fin du mois si date au mois près)
  recherches: number;
  heuresDepuisDerniere: number | null;
  joursDepuisDerniere: number | null; // jours de calendrier
  attente: boolean; // une recherche en cours, ou dont les pages attendent Ollama
  due: boolean;
  abandonne: boolean;
  raison: string;
  rang: number; // 0 J-7 au jour près, 1 J-7 au mois près, 2 les autres, 9 pas dû
}
export interface File {
  catalogue: AnimeCat[];
  toutes: Map<number, Cible>; // tous les animes de la fenêtre (motif nul : complet)
  cibles: Cible[]; // incomplets (motif non nul), dans l'ordre de passage (les dus d'abord)
  dues: Cible[];
}

/** Date de début de recherche : un an avant la sortie (ou aujourd'hui si elle est plus loin). */
export function depuisPour(c: { sortie: string; jours: number }, aujourdhui: string): string {
  const ref = c.jours < 0 ? c.sortie : aujourdhui;
  const t = Date.parse(ref + "T12:00:00Z") - 365 * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Les animes incomplets du site, avec ce qu'il leur manque, et ceux dont la recherche est due. Lit la base, n'écrit rien. */
export async function fileAttente(pool: SqlPool): Promise<File> {
  const rows: any[] = await pool.query(
    `SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, platform,
            CAST(IFNULL(popularity, 0) AS SIGNED) AS popularity, format,
            DATE_FORMAT(release_date, '%Y-%m-%d') AS sortie, release_precision AS prec,
            DATEDIFF(release_date, CURDATE()) AS jours,
            DATEDIFF(LAST_DAY(release_date), CURDATE()) AS joursFinMois,
            IFNULL(statut_anilist, '') = 'CANCELLED' AS annule
       FROM anime_items
      WHERE release_date IS NOT NULL
        AND IF(format = 'MOVIE' AND fr_cinema IS NOT NULL, fr_cinema, release_date) BETWEEN MAKEDATE(YEAR(CURDATE()), 1) AND MAKEDATE(YEAR(CURDATE()) + 2, 1) - INTERVAL 1 DAY
        AND cover IS NOT NULL AND cover <> '' AND title IS NOT NULL AND title <> ''
      ORDER BY popularity DESC
      LIMIT 600`,
  );
  const histo: any[] = await pool.query(
    `SELECT CAST(anime_id AS UNSIGNED) AS id, COUNT(*) AS n,
            TIMESTAMPDIFF(HOUR, MAX(cherche_le), NOW()) AS heures,
            DATEDIFF(CURDATE(), DATE(MAX(cherche_le))) AS joursCal,
            DATEDIFF(CURDATE(), DATE(MAX(CASE WHEN statut IN ('trouve', 'rien', 'a_lire') THEN cherche_le END))) AS joursReussie,
            SUM(statut IN ('a_lire', 'envoi')) AS attente
       FROM tavily_recherches
      WHERE credits > 0
      GROUP BY anime_id`,
  );
  const annonces: any[] = await pool.query(
    `SELECT CAST(anime_id AS UNSIGNED) AS id, plateforme, date_dispo IS NOT NULL AS avecDate,
            DATE_FORMAT(date_dispo, '%Y-%m-%d') AS d
       FROM annonces_fr
      WHERE pays IN ('FR', 'EUROPE', 'MONDE')`,
  );
  const parHisto = new Map<number, any>(histo.map((h) => [Number(h.id), h]));
  const annonce = new Map<number, { plateforme: boolean; date: boolean; cinema: string[] }>();
  for (const a of annonces) {
    const id = Number(a.id);
    const site = nomDuSite(String(a.plateforme ?? ""));
    // Le cinéma (avec sa date) compte pour un film, plus bas ; la télé n'est pas une de nos plateformes.
    const cinema = !site && String(a.plateforme ?? "").trim() === "Cinéma" && Number(a.avecDate) === 1;
    if (!site && !cinema) continue;
    const x = annonce.get(id) ?? { plateforme: false, date: false, cinema: [] };
    if (cinema) x.cinema.push(String(a.d));
    else {
      x.plateforme = true;
      if (Number(a.avecDate) === 1) x.date = true;
    }
    annonce.set(id, x);
  }
  const catalogue: AnimeCat[] = [];
  const toutes = new Map<number, Cible>();
  const cibles: Cible[] = [];
  for (const r of rows) {
    const saison = numeroSaison([r.titleEnglish, r.title]);
    const it: AnimeCat = {
      id: Number(r.id), title: String(r.title), titleEnglish: r.titleEnglish ? String(r.titleEnglish) : null,
      platform: r.platform ? String(r.platform) : null, popularity: Number(r.popularity) || 0,
      format: r.format ? String(r.format) : null, saison, alias: alias([r.titleEnglish, r.title], saison),
    };
    catalogue.push(it);
    const prec: string | null = r.prec ? String(r.prec) : null;
    const jours = Number(r.jours);
    const finMois = Number(r.joursFinMois);
    const an = annonce.get(it.id);
    const aPlateforme = !vide(it.platform) || !!an?.plateforme;
    // Film au cinéma en France (annonce « Cinéma » datée, au plus 60 jours avant la sortie au Japon : une
    // avant-première de festival n'est pas une sortie) : le module plateformes en fait sa date sur le site.
    // Il reste dans la file tant que cette date est dans la fenêtre du site, même si celle du Japon en sort.
    const auCinema = it.format === "MOVIE" && (an?.cinema ?? []).some((d) => cinemaRetenu(d, String(r.sortie), prec));
    const datePrecise = prec === "day" || !!an?.date || auCinema;
    // Sorti : date au jour près passée (le jour de la sortie compte encore comme J-7), ou mois terminé.
    const sorti = (prec === "day" && jours < 0) || (prec === "month" && finMois < 0);
    const joursDepuisSortie = !sorti ? null : prec === "day" ? -jours : -finMois;
    // J-7 : sortie dans 0 à 7 jours (date au jour près) ; ou date au mois près, mois qui commence dans
    // 7 jours au plus ou en cours.
    const j7Jour = prec === "day" && jours >= 0 && jours <= 7;
    const j7Mois = prec === "month" && jours <= 7 && finMois >= 0;
    const manque: Cible["manque"] = [];
    if (!aPlateforme && !auCinema) manque.push("plateforme");
    if (j7Mois && !datePrecise) manque.push("date");
    let motif: Motif | null = null;
    if ((j7Jour && !aPlateforme && !auCinema) || (j7Mois && manque.length)) motif = "j7";
    else if (auCinema && !aPlateforme) motif = "cinema";
    else if (!aPlateforme) motif = sorti ? "sorti" : "avenir";
    const h = parHisto.get(it.id);
    const recherches = h ? Number(h.n) || 0 : 0;
    const heures = h ? Number(h.heures) : null;
    const joursCal = h ? Number(h.joursCal) : null; // jours de calendrier depuis la dernière recherche (comptée)
    const joursReussie = h && h.joursReussie !== null && h.joursReussie !== undefined ? Number(h.joursReussie) : null; // … aboutie
    const attente = !!h && Number(h.attente) > 0;
    const c: Cible = {
      anime: it, motif, manque, sortie: String(r.sortie), precision: prec, jours, joursDepuisSortie,
      recherches, heuresDepuisDerniere: heures, joursDepuisDerniere: joursCal, attente,
      due: false, abandonne: false, raison: "", rang: 9,
    };
    const depuisQuand = () => (heures === null ? "jamais cherché" : `cherché il y a ${heures < 48 ? `${heures} h` : `${Math.floor(heures / 24)} j`}`);
    const rythme = (jours: 1 | 7 | 30) => {
      // Une fois par jour de calendrier ; chaque semaine ou chaque mois à 4 h près.
      c.due = heures === null || (jours === 1 ? (joursCal ?? 0) >= 1 : heures >= jours * 24 - 4);
      c.raison = `${depuisQuand()} (${jours === 1 ? "chaque jour" : jours === 7 ? "chaque semaine" : "chaque mois"})`;
    };
    toutes.set(it.id, c);
    if (!motif) {
      c.raison = "complet";
      continue;
    }
    // annulé chez AniList (retiré du site, dates-animes.ts) : aucune recherche, aucun crédit (20 octobre 2026). Il reste au
    // catalogue : une page qui le nomme ne sera pas prise pour celle d'un autre animé. Il revient si AniList le relance.
    if (Number(r.annule) === 1) {
      c.raison = "annulé chez AniList : pas de recherche";
      continue;
    }
    if (attente) {
      c.raison = "recherche en cours ou pages en attente d'Ollama (reprises sans nouvelle recherche)";
    } else if (motif === "j7") {
      rythme(j7Jour ? 1 : 7);
    } else if (motif === "avenir") {
      rythme((prec === "day" || prec === "month") && jours <= JOURS_PROCHE ? 7 : 30);
    } else if (motif === "cinema") {
      // Au cinéma en France : sa plateforme arrive des mois plus tard ; chaque mois, sans abandon.
      rythme(30);
    } else {
      // Sorti : abandonné 3 mois après la sortie, une fois cherché depuis la sortie.
      const chercheDepuisSortie = joursReussie !== null && joursReussie <= (joursDepuisSortie ?? 0);
      if ((joursDepuisSortie ?? 0) >= JOURS_ABANDON && chercheDepuisSortie) {
        c.abandonne = true;
        c.raison = `abandonné : sorti depuis plus de 3 mois, ${pluriel(recherches, "recherche")} sans résultat`;
      } else {
        rythme((joursDepuisSortie ?? 0) < JOURS_PREMIER_MOIS ? 7 : 30);
      }
    }
    // Ordre : J-7 (date au jour près d'abord, la plus proche en premier), puis la popularité.
    if (c.due) c.rang = motif === "j7" ? (j7Jour ? 0 : 1) : 2;
    cibles.push(c);
  }
  cibles.sort((a, b) => a.rang - b.rang || (a.rang === 0 ? a.jours - b.jours : 0) || b.anime.popularity - a.anime.popularity);
  return { catalogue, toutes, cibles, dues: cibles.filter((c) => c.due) };
}

// ─────────────────────────────────────────────────────────────── budget
export interface Forfait {
  plan: string;
  utilise: number;
  limite: number | null;
  restant: number | null; // avant la limite du forfait (et de la clé), sans la marge
}
export interface Budget {
  jour: number; // crédits dépensés aujourd'hui par le module
  mois: number; // ce mois-ci
  forfait: Forfait | null; // lu chez Tavily (null : illisible)
  forfaitErreur?: string;
  restantForfait: number | null; // avant la limite du forfait, marge comprise (null : inconnu)
  restant: number; // recherches encore permises maintenant (plafonds du module et forfait)
  limite?: string; // ce qui bloque, quand plus rien n'est permis
}

export class TavilyErreur extends Error {
  constructor(message: string, public statut: number, public portee: "passage" | "jour" | "cle") {
    super(message);
  }
}
/** Jamais de clé dans un message (au cas où une réponse la recopierait). */
const sansCle = (s: string) => s.replace(/tvly-[A-Za-z0-9_-]+/g, "tvly-…");
const detailErreur = (texte: string) => {
  try {
    const j = JSON.parse(texte);
    const d = j?.detail?.error ?? j?.detail ?? j?.error ?? j?.message;
    return sansCle(coupe(String(typeof d === "string" ? d : JSON.stringify(d)).replace(/\s+/g, " "), 160));
  } catch {
    return sansCle(coupe(String(texte || "").replace(/\s+/g, " "), 160));
  }
};
function erreurHttp(statut: number, texte: string): TavilyErreur {
  const d = detailErreur(texte);
  if (statut === 401 || statut === 403) return new TavilyErreur(`Tavily refuse la clé (HTTP ${statut}) : ${d}`, statut, "cle");
  if (statut === 432) return new TavilyErreur(`limite du forfait Tavily atteinte (HTTP 432) : ${d}`, statut, "jour");
  if (statut === 433) return new TavilyErreur(`limite du paiement à l'usage atteinte (HTTP 433) : ${d}`, statut, "jour");
  if (statut === 429) return new TavilyErreur("Tavily : trop de requêtes (HTTP 429), repris au prochain passage", statut, "passage");
  return new TavilyErreur(`Tavily : HTTP ${statut} : ${d}`, statut, "passage");
}

/** Le forfait du compte (GET /usage : ne coûte aucun crédit). */
export async function lireForfait(cfg: TavilyConfig): Promise<Forfait> {
  if (!cfg.cle) throw new TavilyErreur("clé Tavily absente (TAVILY_API_KEY)", 0, "cle");
  let r: Response;
  try {
    r = await fetch(`${cfg.url}/usage`, { headers: { Authorization: `Bearer ${cfg.cle}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new TavilyErreur(`Tavily injoignable (${sansCle((e as Error).message)})`, 0, "passage");
  }
  const texte = await r.text();
  if (!r.ok) throw erreurHttp(r.status, texte);
  let j: any;
  try {
    j = JSON.parse(texte);
  } catch {
    throw new TavilyErreur("réponse de Tavily (/usage) illisible", r.status, "passage");
  }
  const nombre = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  const compte = j?.account ?? {};
  const cle = j?.key ?? {};
  const utilise = nombre(compte.plan_usage) ?? nombre(cle.usage) ?? 0;
  const limite = nombre(compte.plan_limit);
  const restes: number[] = [];
  if (limite !== null) restes.push(limite - utilise);
  const limiteCle = nombre(cle.limit), usageCle = nombre(cle.usage);
  if (limiteCle !== null && usageCle !== null) restes.push(limiteCle - usageCle);
  return { plan: String(compte.current_plan ?? "?"), utilise, limite, restant: restes.length ? Math.min(...restes) : null };
}

/**
 * Crédits dépensés par le module (aujourd'hui, ce mois-ci) et recherches encore permises.
 * forfait : « toujours » relit le forfait chez Tavily ; « si_besoin » seulement si les plafonds du module
 * permettent encore une recherche ; « jamais ».
 */
export async function budget(pool: SqlPool | null, cfg: TavilyConfig, forfait: "toujours" | "si_besoin" | "jamais" = "si_besoin"): Promise<Budget> {
  let jour = 0, mois = 0;
  if (pool) {
    const r: any[] = await pool.query(
      `SELECT IFNULL(SUM(CASE WHEN cherche_le >= CURDATE() THEN credits ELSE 0 END), 0) AS jour, IFNULL(SUM(credits), 0) AS mois
         FROM tavily_recherches
        WHERE cherche_le >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    );
    jour = Number(r[0]?.jour) || 0;
    mois = Number(r[0]?.mois) || 0;
  }
  const b: Budget = { jour, mois, forfait: null, restantForfait: null, restant: Math.max(0, Math.min(cfg.maxParJour - jour, cfg.maxParMois - mois)) };
  if (jour >= cfg.maxParJour) b.limite = `plafond du jour atteint (${cfg.maxParJour} crédits)`;
  else if (mois >= cfg.maxParMois) b.limite = `plafond du mois atteint (${cfg.maxParMois} crédits)`;
  if (forfait === "toujours" || (forfait === "si_besoin" && b.restant > 0)) {
    try {
      b.forfait = await lireForfait(cfg);
    } catch (e) {
      if (e instanceof TavilyErreur && e.portee === "cle") throw e;
      b.forfaitErreur = (e as Error).message;
    }
    // Sans forfait lisible (ou sans limite connue), aucune recherche : jamais de dépassement payant.
    if (b.forfait?.restant === null || b.forfait?.restant === undefined) {
      b.restantForfait = 0;
      b.restant = 0;
      if (!b.limite) b.limite = `forfait Tavily illisible (${b.forfaitErreur ?? "limite inconnue"}) : aucune recherche`;
    } else {
      // (relecture 3) au moins ce qu'un passage peut dépenser (3 crédits par recherche avec Tavily Extract) : un essai lancé en
      // même temps qu'un passage ne fait jamais dépasser le forfait, même avec TAVILY_MAX_PAR_PASSAGE au-delà de 3
      b.restantForfait = Math.max(0, b.forfait.restant - Math.max(MARGE_FORFAIT, (1 + EXTRACT_COUT) * cfg.maxParPassage));
      if (b.restantForfait < b.restant) b.restant = b.restantForfait;
      if (b.restantForfait <= 0 && !b.limite) b.limite = `forfait Tavily presque épuisé (${b.forfait.utilise} crédits utilisés sur ${b.forfait.limite ?? "?"})`;
    }
  }
  return b;
}

// ─────────────────────────────────────────────────────────────── recherche
export interface Resultat {
  url: string;
  titre: string;
  contenu: string;
  publie: string | null;
  // Le texte de la page lu par Tavily (markdown) ; une fois la page retenue, réduit à ce qui en sera lu (blocs,
  // reduireBrut ; liste : page-liste) : il ne sert que si la page n'a pas de texte lisible chez nous.
  brut?: string;
  blocs?: Bloc[];
  liste?: boolean;
  extrait?: boolean; // déjà demandée à Tavily Extract (lue ou non) : jamais redemandée, même à la reprise
}
export interface Recherche {
  requete: string;
  depuis: string;
  resultats: Resultat[];
  credits: number;
  ms: number;
}

/**
 * Texte de la recherche : le titre (anglais d'abord, plus le titre d'origine s'il est court et différent) et
 * ce qu'on cherche, en peu de mots (essai du 10 octobre : 0 résultat avec le long titre japonais de Rascal).
 */
export function requete(c: Cible): string {
  const a = c.anime;
  const principal = (a.titleEnglish || a.title).trim();
  const autre = a.titleEnglish && norm(a.title) !== norm(a.titleEnglish) && a.title.trim().length <= 30 ? a.title.trim() : "";
  const quoi = a.format === "MOVIE"
    ? c.motif === "cinema" ? "film anime streaming France" : "film anime sortie France cinéma streaming"
    : c.manque.includes("plateforme") ? "anime diffusion France streaming" : "anime date diffusion France";
  return coupe(`${principal}${autre ? ` (${autre})` : ""} ${quoi}`, 300);
}

/**
 * Une recherche Tavily « basic » (1 crédit), sur les seuls sites de confiance. Le texte des pages est demandé
 * (include_raw_content) : le prix d'une recherche ne dépend que de search_depth.
 */
export async function chercher(cfg: TavilyConfig, texte: string, depuis: string): Promise<Recherche> {
  if (!cfg.cle) throw new TavilyErreur("clé Tavily absente (TAVILY_API_KEY)", 0, "cle");
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(`${cfg.url}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${cfg.cle}` },
      body: JSON.stringify({
        query: texte,
        search_depth: "basic",
        topic: "general",
        max_results: RESULTATS_DEMANDES,
        include_domains: cfg.domaines.map((d) => d.domaine),
        start_date: depuis,
        include_published_date: true,
        include_usage: true,
        include_answer: false,
        include_raw_content: "markdown",
        include_images: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new TavilyErreur(`Tavily injoignable (${sansCle((e as Error).message)})`, 0, "passage");
  }
  const brut = await r.text();
  if (!r.ok) throw erreurHttp(r.status, brut);
  let j: any;
  try {
    j = JSON.parse(brut);
  } catch {
    throw new TavilyErreur("réponse de Tavily illisible", r.status, "passage");
  }
  const resultats: Resultat[] = (Array.isArray(j?.results) ? j.results : [])
    .filter((x: any) => x && typeof x.url === "string")
    .map((x: any) => ({
      url: String(x.url),
      titre: decoder(String(x.title ?? "")).trim(),
      contenu: String(x.content ?? ""),
      publie: typeof x.published_date === "string" && Number.isFinite(Date.parse(x.published_date)) ? new Date(Date.parse(x.published_date)).toISOString() : null,
      ...(typeof x.raw_content === "string" && x.raw_content.trim() ? { brut: x.raw_content.slice(0, TAILLE_BRUT) } : {}),
    }));
  const credits = Number(j?.usage?.credits);
  return { requete: texte, depuis, resultats, credits: Number.isFinite(credits) && credits >= 1 ? credits : 1, ms: Date.now() - t0 };
}

/**
 * Tavily Extract « advanced » : le texte (markdown) de pages dessinées par le navigateur (Crunchyroll News), que ni notre
 * lecture ni la recherche n'ont pu lire. 2 crédits par lot de 5 pages lues, rien pour une page qui échoue ; Tavily compte
 * par lots (« usage.credits » peut valoir 0 tant que le lot n'est pas plein). Sans « usage » lisible : 2 crédits dès qu'une
 * page est lue (jamais moins que le prix).
 */
export async function extraire(cfg: TavilyConfig, urls: string[]): Promise<{ textes: Map<string, string>; credits: number; ms: number }> {
  if (!cfg.cle) throw new TavilyErreur("clé Tavily absente (TAVILY_API_KEY)", 0, "cle");
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(`${cfg.url}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${cfg.cle}` },
      body: JSON.stringify({ urls, extract_depth: "advanced", format: "markdown", include_images: false, include_usage: true, timeout: 60 }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new TavilyErreur(`Tavily Extract injoignable (${sansCle((e as Error).message)})`, 0, "passage");
  }
  const brut = await r.text();
  if (!r.ok) throw erreurHttp(r.status, brut);
  let j: any;
  try {
    j = JSON.parse(brut);
  } catch {
    throw new TavilyErreur("réponse de Tavily Extract illisible", r.status, "passage");
  }
  // (l'adresse rendue peut différer de la demandée : « www. », barre finale, « ?utm_… », « #… »)
  const cle = (u: string) => u.replace(/[?#].*$/, "").replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
  const demandees = new Map(urls.map((u) => [cle(u), u]));
  const resultats: any[] = Array.isArray(j?.results) ? j.results : [];
  const textes = new Map<string, string>();
  for (const x of resultats) {
    const u = demandees.get(cle(String(x?.url ?? "")));
    if (u && typeof x.raw_content === "string" && x.raw_content.trim()) textes.set(u, x.raw_content.slice(0, TAILLE_BRUT));
  }
  // « usage.credits » seulement s'il est un nombre (ou un nombre écrit) ; sinon le prix dès qu'une page est lue, ou si la
  // réponse n'a pas la forme attendue (elle a peut-être été facturée)
  const u = j?.usage?.credits;
  const facture = typeof u === "number" ? u : typeof u === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(u) ? Number(u) : NaN;
  const credits = Number.isFinite(facture) && facture >= 0 ? Math.ceil(facture) : resultats.length || !Array.isArray(j?.results) ? EXTRACT_COUT : 0;
  return { textes, credits, ms: Date.now() - t0 };
}

/** Le site de confiance d'une adresse (le domaine ou un de ses sous-domaines), sinon null. */
export function domaineDe(url: string, domaines: Domaine[]): Domaine | null {
  let h = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    h = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  return domaines.find((d) => h === d.domaine || h.endsWith("." + d.domaine)) ?? null;
}

/**
 * Les résultats qui valent d'être lus : un site de confiance, et l'anime nommé dans le titre, le résumé ou
 * l'adresse. Lus d'abord ceux qui le nomment dans leur adresse ou leur titre (titre complet, puis partiel),
 * ensuite ceux qui ne le citent que dans le résumé (listes, encadrés « à lire aussi ») : à l'essai du
 * 10 octobre, ces derniers prenaient les 4 places avant les vrais articles. Le titre peut y être écrit
 * « X - … - Y » (viser).
 */
export function retenir(resultats: Resultat[], c: Cible, cfg: TavilyConfig): Resultat[] {
  const vus = new Set<string>();
  const candidats: Array<{ r: Resultat; rang: number; k: number }> = [];
  resultats.forEach((r, k) => {
    if (!domaineDe(r.url, cfg.domaines)) return;
    const cle = r.url.replace(/#.*$/, "");
    if (vus.has(cle)) return;
    let chemin = "";
    try {
      chemin = decodeURIComponent(new URL(r.url).pathname);
    } catch { /* adresse illisible */ }
    const formes = viser(c.anime, `${r.titre}\n${r.contenu}\n${chemin}`).alias;
    const tete = norm(`${r.titre}\n${chemin}`);
    const n = norm(`${r.titre}\n${r.contenu}\n${chemin}`);
    const rang = formes.some((al) => al.complet && contient(tete, al.forme)) ? 0
      : formes.some((al) => contient(tete, al.forme)) ? 1
      : formes.some((al) => contient(n, al.forme)) ? 2
      : -1;
    if (rang < 0) return;
    vus.add(cle);
    candidats.push({ r, rang, k });
  });
  return candidats.sort((a, b) => a.rang - b.rang || a.k - b.k).slice(0, cfg.pagesParAnime).map((x) => x.r);
}

// ─────────────────────────────────────────────────────────────── pages
/**
 * Lit une page d'un site de confiance. Les redirections sont suivies à la main (3 au plus) : chacune doit
 * rester sur le même site de confiance et être permise par son robots.txt, AVANT d'être demandée.
 */
async function lirePage(url: string, d: Domaine, domaines: Domaine[]): Promise<string> {
  let adresse = url;
  for (let saut = 0; saut <= 3; saut++) {
    const r = await fetch(adresse, {
      headers: { "User-Agent": AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6" },
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc || saut === 3) throw new Error(`HTTP ${r.status}${loc ? " (trop de redirections)" : ""}`);
      let suite: string;
      try {
        suite = new URL(loc, adresse).toString();
      } catch {
        throw new Error("redirection illisible");
      }
      if (domaineDe(suite, domaines)?.domaine !== d.domaine) throw new Error("redirigée vers un autre site");
      const rb = await robotsAutorise(suite);
      if (!rb.ok) throw new Error(`redirigée vers une page ${rb.raison ?? "interdite"}`);
      await dormir(Math.max(500, rb.delaiMs));
      adresse = suite;
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = String(r.headers.get("content-type") || "");
    if (type && !/html|xml/i.test(type)) throw new Error(`pas une page (${coupe(type, 40)})`);
    return await corpsLimite(r, TAILLE_PAGE);
  }
  throw new Error("trop de redirections");
}

/** Le corps d'une réponse, lu jusqu'à `max` octets : au-delà, la lecture s'arrête (la page est coupée là). */
export async function corpsLimite(r: Response, max: number): Promise<string> {
  if (!r.body) return "";
  const lecteur = r.body.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done || !value) break;
    if (total + value.length >= max) {
      morceaux.push(value.subarray(0, max - total));
      total = max;
      void lecteur.cancel().catch(() => undefined);
      break;
    }
    morceaux.push(value);
    total += value.length;
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(morceaux));
}

/** La date écrite dans l'adresse d'un article (« /2026/7/31/ », « /2026/07/31/ ») ; null sinon, ou si elle est à venir. */
export function dateDansAdresse(url: string): string | null {
  let chemin = "";
  try {
    chemin = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/((?:19|20)\d{2})\/(\d{1,2})\/(\d{1,2})(?=\/|$)/.exec(chemin);
  if (!m) return null;
  const [an, mois, jour] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(an, mois - 1, jour, 12));
  if (d.getUTCFullYear() !== an || d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null; // « /2026/2/31/ »
  return d.getTime() > Date.now() + 86400000 ? null : d.toISOString();
}

const meta = (html: string, re: RegExp) => decoder((re.exec(html) || [])[1] || "").trim();
/** Date de publication : JSON-LD (datePublished), sinon les balises meta de l'article. */
export function datePublication(html: string): string | null {
  const essais: string[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j: any;
    try {
      j = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const objets: any[] = (Array.isArray(j) ? j : [j]).flatMap((o: any) => (o && Array.isArray(o["@graph"]) ? o["@graph"] : [o]));
    for (const o of objets) {
      const type = ([] as string[]).concat(o?.["@type"] || []).join(" ");
      if (/Article|BlogPosting|Report/.test(type) && o?.datePublished) essais.push(String(o.datePublished));
    }
  }
  essais.push(
    meta(html, /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i),
    meta(html, /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']article:published_time["']/i),
    meta(html, /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']*)["']/i),
    meta(html, /<meta[^>]+name=["'](?:date|pubdate|publish-date|dc\.date\.issued)["'][^>]+content=["']([^"']*)["']/i),
  );
  // ISO seulement (« 2026-10-05T… ») : « 05/10/2026 » serait lu le 10 mai.
  for (const e of essais) {
    const t = /^\d{4}-\d{2}-\d{2}/.test(e) ? Date.parse(e) : NaN;
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** La langue de la page (« fr », « en », « es »), sinon celle du site ; null si autre (l'allemand n'est pas vérifiable). */
export function langueDe(html: string, url: string, d: Domaine): Article["langue"] | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z]{2})\b/i.exec(html);
  const l = m ? m[1]!.toLowerCase() : /\/fr(?:[/-]|$)/i.test(new URL(url).pathname) ? "fr" : d.langue ?? (/\.fr$/.test(d.domaine) ? "fr" : "en");
  return l === "fr" || l === "en" || l === "es" ? l : null;
}

// Page lue jusqu'à 3 Mo (diagnostic du 10 octobre : la liste de l'automne d'AnimOtaku fait 1,29 Mo, et BanG Dream y
// était après la coupure à 1 Mo). Scripts, styles et dessins (le gros d'une page lourde) sont retirés avant l'extraction.
const TAILLE_PAGE = 3_000_000; // octets
const TAILLE_ZONE = 3_000_000;
// Au-delà, le texte d'un article n'est lu que par passages : c'est une liste, et la vérification relit tout le texte.
const TEXTE_LONG = 60_000;
// Texte d'une page : un million de caractères au plus ; lu en entier (article d'un seul anime) : 300 000 au plus.
const TEXTE_MAX = 1_000_000;
const TEXTE_ARTICLE = 300_000;
/**
 * Chaque « < » qui ouvre une balise (« <x », « </x », « <! », « <? ») a son « > » avant le « < » suivant ; sinon il est
 * neutralisé (une espace) : ouvert dans une autre balise, ou jamais refermé (page coupée, balisage cassé), comme le lit
 * un navigateur. Les recherches « <x[^>]*> » ne relisent alors jamais la suite de la page : sans cela, une page qui finit
 * par des milliers de « <x » demandait des minutes de calcul, l'API attendant. Le contenu d'un <script> ou d'un <style>
 * est laissé tel quel, sauf celui du JSON-LD (le texte de l'article, assaini lui aussi) ; un <script> ou un <style>
 * jamais refermé : la page s'arrête là (pour un navigateur, la suite n'est que son contenu).
 */
export function balisesSaines(page: string): string {
  const z = String(page || "");
  const neutres: number[] = [];
  const jsonld: Array<[number, number]> = [];
  let ouvert = -1, brut = "", fin = z.length;
  for (let i = 0; i < z.length; i++) {
    const c = z.charCodeAt(i);
    if (c === 62) {
      if (ouvert >= 0 && brut) {
        const re = new RegExp(`<\\/${brut}\\b`, "gi");
        re.lastIndex = i + 1;
        const m = re.exec(z);
        if (!m) {
          fin = ouvert;
          ouvert = -1;
          break;
        }
        if (brut === "script" && /ld\+json/i.test(z.slice(ouvert, i))) jsonld.push([i + 1, m.index]);
        ouvert = -1;
        brut = "";
        i = m.index - 1;
        continue;
      }
      ouvert = -1;
    } else if (c === 60) {
      const s = z.charCodeAt(i + 1);
      if (!((s >= 97 && s <= 122) || (s >= 65 && s <= 90) || s === 47 || s === 33 || s === 63)) continue;
      if (ouvert >= 0) {
        neutres.push(i);
        continue;
      }
      ouvert = i;
      brut = (s | 32) === 115 ? (/^(script|style)(?![\w-])/i.exec(z.slice(i + 1, i + 8))?.[1]?.toLowerCase() ?? "") : "";
    }
  }
  if (ouvert >= 0) {
    // la dernière balise ouverte ne se referme jamais : neutralisée aussi (avant celles qu'elle contenait)
    let k = neutres.length;
    while (k > 0 && neutres[k - 1]! > ouvert) k--;
    neutres.splice(k, 0, ouvert);
  }
  if (!neutres.length && !jsonld.length && fin === z.length) return z;
  // les morceaux, dans l'ordre : « < » neutralisés hors des scripts, contenus de JSON-LD assainis
  const evts: Array<[number, number, string]> = [
    ...neutres.filter((p) => p < fin).map((p): [number, number, string] => [p, p + 1, " "]),
    ...jsonld.map(([a, b]): [number, number, string] => [a, b, jsonldSain(z.slice(a, b))]),
  ].sort((x, y) => x[0] - y[0]);
  const morceaux: string[] = [];
  let curseur = 0;
  for (const [a, b, t] of evts) {
    morceaux.push(z.slice(curseur, a), t);
    curseur = b;
  }
  morceaux.push(z.slice(curseur, fin));
  return morceaux.join("");
}
/**
 * Le texte d'un JSON-LD (articleBody, du HTML) tel que presse.ts (enTexte) le lira vite : figures, vidéos, scripts et
 * styles jamais refermés retirés, scripts et styles complets retirés, balises assainies, et tout « < » après le dernier
 * « > » neutralisé (sinon enTexte relit toute la suite pour chacun : « a < b » répété des milliers de fois).
 */
function texteSain(t: string): string {
  let s = sansOrphelines(fermetures(t), ["script", "style", "figure", "iframe"]).replace(/<(script|style)\b[^<>]*>[\s\S]*?<\/\1>/gi, " ");
  s = balisesSaines(s.replace(/<(\/?)(script|style)\b/gi, " $1$2").replace(/<\/?(?:script|style|figure|iframe)[\w-][^<>]*>/gi, " "));
  const k = s.lastIndexOf(">");
  return k < 0 ? s.replace(/</g, " ") : s.slice(0, k + 1) + s.slice(k + 1).replace(/</g, " ");
}
/**
 * Le contenu d'un JSON-LD, ses textes assainis APRÈS décodage (un « < » peut y être écrit « \u003c », un « / » « \/ ») ;
 * réécrit sans « </ » (le script ne se refermerait pas là). JSON illisible : le texte brut assaini (presse.ts ne le lira
 * pas non plus).
 */
function jsonldSain(c: string): string {
  try {
    const sain = (o: any): any => (Array.isArray(o) ? o.map(sain) : o && typeof o === "object"
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? (v.includes("<") ? texteSain(v) : v) : sain(v)]))
      : o);
    return JSON.stringify(sain(JSON.parse(c))).replace(/<\//g, "<\\/");
  } catch {
    return texteSain(c);
  }
}
/** « </p > », « </P\n> » : écrits « </p> », comme les cherchent les extractions (presse.ts : texteDePage). */
const fermetures = (z: string) => z.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s+>/g, "</$1>");
const LOURDS = /<(script|style|noscript|svg)\b([^>]*)>[\s\S]*?<\/\1>/gi;
/** La page sans scripts (sauf le JSON-LD), styles, dessins ni <noscript>. */
function alleger(html: string): string {
  const z = sansOrphelines(fermetures(html), ["script", "style", "noscript", "svg"])
    .replace(LOURDS, (m: string, nom: string, attributs: string) => (nom.toLowerCase() === "script" && /ld\+json/i.test(attributs) ? m : " "));
  return z.length > TAILLE_ZONE ? z.slice(0, TAILLE_ZONE) : z;
}
// Balises que l'extraction cherche par paires (presse.ts : texteDePage ; blocsDe).
const PAIRES = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "noscript", "figure", "iframe", "aside", "nav", "form", "footer"];
/**
 * Retire les balises ouvrantes de ces noms ouvertes après la dernière fermeture du même nom : elles ne sont jamais
 * refermées (HTML qui omet les </p> et </li>, page coupée), et chaque recherche de leur fin parcourrait toute la
 * suite de la page (des dizaines de secondes sur 3 Mo, l'API attendant). Le texte extrait ne change pas.
 */
function sansOrphelines(z: string, noms: string[]): string {
  const derniere = new Map<string, number>();
  for (const m of z.matchAll(new RegExp(`<\\/(${noms.join("|")})>`, "gi"))) derniere.set(m[1]!.toLowerCase(), m.index!);
  return z.replace(new RegExp(`<(${noms.join("|")})\\b[^>]*>`, "gi"), (m: string, nom: string, pos: number) => (pos > (derniere.get(nom.toLowerCase()) ?? -1) ? " " : m));
}
// Éléments à retirer, reconnus à un MOT de leur classe ou de leur id (« comments-area », « post-share »,
// « related-posts ») : commentaires, articles liés, « à lire aussi », partage, publicité. Jamais une classe
// d'état ou de mise en page (« has-sidebar », « right-sidebar » ne sont pas visés).
const MOTS_PARASITES = new Set([
  "comment", "comments", "commentaire", "commentaires", "disqus", "respond", "related", "similaire", "similaires",
  "share", "sharing", "partage", "partager", "newsletter", "outbrain", "taboola", "recommandation", "recommandations",
  "recommendation", "recommendations", "recommended", "stories",
]);
const SUITES_PARASITES = /(?:^|[-_])(?:lire[-_]aussi|a[-_]lire|voir[-_]aussi|articles?[-_]lies|meme[-_]sujet|read[-_]also|read[-_]more|you[-_]may[-_]like|more[-_](?:news|articles?|posts?|from|stories|links|reads?))(?:$|[-_])/;
const VIDES = new Set(["img", "br", "hr", "input", "meta", "link", "source", "use", "path", "wbr", "col", "embed", "param", "track", "area", "base"]);
function estParasite(attributs: string): boolean {
  const valeurs: string[] = [];
  for (const m of attributs.matchAll(/\b(?:id|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) valeurs.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const t of valeurs.join(" ").toLowerCase().split(/\s+/).filter(Boolean)) {
    if (/^(?:has|with|no|is|enable|show|hide)[-_]/.test(t) || /[-_](?:open|closed|enabled|disabled|on|off|active|visible|hidden|count|number)$/.test(t)) continue;
    const n = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (n.split(/[-_]+/).some((x) => MOTS_PARASITES.has(x)) || SUITES_PARASITES.test(n)) return true;
  }
  return false;
}
/**
 * Fin de l'élément ouvert en `debut` (balise `nom`, imbrications comprises), ou -1 s'il n'est jamais refermé. Les balises
 * de chaque nom sont relevées une fois par zone : une page de 3 Mo n'est pas relue pour chaque élément cherché.
 */
function finsDe(zone: string): (debut: number, nom: string) => number {
  const index = new Map<string, Array<{ i: number; l: number; ferme: boolean; seule: boolean }>>();
  return (debut, nom) => {
    let b = index.get(nom);
    if (!b) {
      b = [];
      for (const m of zone.matchAll(new RegExp(`<(/?)${nom}\\b[^>]*>`, "gi"))) b.push({ i: m.index!, l: m[0].length, ferme: !!m[1], seule: !m[1] && /\/>$/.test(m[0]) });
      index.set(nom, b);
    }
    let bas = 0, haut = b.length;
    while (bas < haut) {
      const milieu = (bas + haut) >> 1;
      if (b[milieu]!.i < debut) bas = milieu + 1;
      else haut = milieu;
    }
    if (bas >= b.length || b[bas]!.i !== debut) return -1;
    if (b[bas]!.seule) return debut + b[bas]!.l; // <x … /> : rien à l'intérieur
    let prof = 0;
    for (let k = bas; k < b.length; k++) {
      const x = b[k]!;
      if (x.seule) continue;
      prof += x.ferme ? -1 : 1;
      if (prof === 0) return x.i + x.l;
    }
    return -1;
  };
}
/** Retire les éléments parasites ; un élément vide, auto-fermant ou jamais refermé : seulement sa balise. */
function nettoyer(zone: string): string {
  const fin = finsDe(zone);
  const balise = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  const morceaux: string[] = [];
  let curseur = 0;
  let m: RegExpExecArray | null;
  for (let n = 0; n < 200 && (m = balise.exec(zone)); ) {
    const nom = m[1]!.toLowerCase();
    if (nom === "html" || nom === "body" || nom === "main" || (nom === "article" && m.index === 0)) continue;
    if (!/\b(?:id|class)\s*=/i.test(m[2]!) || !estParasite(m[2]!)) continue;
    const f = VIDES.has(nom) ? -1 : fin(m.index, nom);
    const bout = f > 0 ? f : m.index + m[0].length;
    morceaux.push(zone.slice(curseur, m.index), " ");
    curseur = bout;
    balise.lastIndex = bout;
    n++;
  }
  morceaux.push(zone.slice(curseur));
  return morceaux.join("");
}
// Lignes « À lire aussi : … », « Voir aussi », « Sur le même sujet » : le titre d'un autre article.
const LIGNE_RENVOI = /^(?:•\s*)?(?:a lire aussi|lire aussi|a lire egalement|lire egalement|a voir aussi|voir aussi|voir egalement|sur le meme sujet|a decouvrir aussi|read also|related)\b/;
const sansRenvois = (texte: string) => texte.split("\n").filter((l) => !LIGNE_RENVOI.test(norm(l))).join("\n");
/** Les éléments <article> de premier niveau, dans l'ordre, sauf ceux qui sont eux-mêmes des parasites (commentaire, aperçu lié). */
function articles(html: string): string[] {
  const fin = finsDe(html);
  const out: string[] = [];
  const re = /<article\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 30) {
    const f = fin(m.index, "article");
    if (!estParasite(m[1] ?? "")) out.push(html.slice(m.index, f > 0 ? f : undefined));
    if (f < 0) break;
    re.lastIndex = f;
  }
  return out;
}
/**
 * Texte de l'article : le JSON-LD (articleBody) s'il y en a un ; sinon le premier élément <article> (les
 * cartes « à lire aussi » et les commentaires viennent après) — ou, s'il ne contient presque rien (menu
 * d'aperçus en tête de page), l'élément <article> le plus fourni —, sans commentaires, articles liés ni
 * boutons de partage ; puis ses paragraphes, listes et intertitres (presse.ts : texteDePage), sans les
 * lignes « À lire aussi ».
 */
export function texteArticle(html: string): string {
  return lireArticle(html).texte;
}
/** La zone de l'article (premier <article>, celui du <h1>, ou la page sans <article>), nettoyée, et son texte. */
function zoneArticle(page: string): { zone: string; texte: string } | null {
  const de = (zone: string) => {
    const z = sansOrphelines(nettoyer(zone), PAIRES);
    return { zone: z, texte: sansRenvois(texteDePage(z)) };
  };
  const liste = articles(page);
  if (!liste.length) return /<article\b/i.test(page) ? null : de(page);
  const premier = de(liste[0]!);
  if (premier.texte.length >= 200 || liste.length === 1) return premier;
  // Premier <article> presque vide (aperçus en tête de page) : celui qui porte le titre (<h1>), s'il y en a un.
  const titre = liste.slice(1).find((a) => /<h1\b/i.test(a));
  return titre ? de(titre) : premier;
}
/** Le texte de l'article (texteArticle) et sa zone dans la page. */
function lireArticle(page: string): { texte: string; zone: () => string | null } {
  const html = balisesSaines(page);
  let z: { zone: string; texte: string } | null | undefined;
  const calcul = () => (z === undefined ? (z = zoneArticle(alleger(html))) : z);
  const jl = articleJsonLd(html);
  if (jl && jl.texte.length > 300) return { texte: sansRenvois(jl.texte), zone: () => calcul()?.zone ?? null };
  return { texte: calcul()?.texte ?? "", zone: () => calcul()?.zone ?? null };
}

// ─────────────────────────────────────────────────────────────── blocs (pages-listes, texte de Tavily)
/**
 * Un bloc de l'article : son texte (« • … » pour une ligne de liste) et h : 1 à 6 un intertitre, 7 un paragraphe tout
 * en gras (titre d'une entrée de liste), 8 une image, 9 une limite qui n'est pas du texte de l'article (lien seul,
 * renvoi « À lire aussi », texte hors des paragraphes, ligne courte qui n'est pas une phrase : le titre d'une entrée
 * qu'on n'a pas su lire), 0 sinon. lien : intertitre qui n'est qu'un lien vers une autre page.
 */
export interface Bloc {
  t: string;
  h: number;
  lien?: boolean;
}
const ENVELOPPES = /<\/?(?:a|span|em|i|u|font|mark|small|big|sup|sub)\b[^>]*>/gi;
const LIMITE = "\u2063"; // (séparateur invisible) le texte d'une limite qui n'en a pas : encadré, menu, formulaire retirés
const LIEN_AILLEURS = /<a\b[^>]*\bhref\s*=\s*["']?(?!["'#\s>])/i; // un lien vers une autre page (pas une ancre « # »)
/** Le texte d'un morceau de HTML, sans balises, entités décodées, sans espaces ni ponctuation. */
const resteDe = (html: string) => decoder(html.replace(/<[^>]+>/g, " ")).replace(/[\s:：\-–—|·•.,;()]+/g, "");
/** Une phrase finie (point, point d'exclamation ou d'interrogation, points de suspension, guillemet ou parenthèse après). */
const finDePhrase = (t: string) => /[.!?…]["»”’)\]]*$/.test(t);
// Premier mot des libellés de rubriques qui ne sont pas de diffusion (« Studio : … », « Auteur du manga : … »).
const AUTRES_RUBRIQUES = new Set([
  "studio", "studios", "auteur", "auteurs", "autrice", "genre", "genres", "synopsis", "resume", "realisation", "realisateur",
  "realisatrice", "mangaka", "scenario", "scenariste", "musique", "compositeur", "format", "episode", "episodes", "nombre",
  "duree", "titre", "titres", "adaptation", "editeur", "editeurs", "distributeur", "distribution", "casting", "doublage",
  "saison", "annee", "pays", "origine", "chara", "character", "opening", "ending", "note", "public", "classification",
  "source", "type", "statut", "production", "producteur", "author", "director", "music", "original", "animation", "cast",
  "staff", "anime", "manga", "light", "roman", "seiyuu", "voix", "studios", "creator", "creators", "genre", "theme", "themes",
  // libellés courants des fiches françaises (« Œuvre » donne « uvre » : norm retire le « œ »)
  "uvre", "oeuvre", "version", "versions", "langue", "langues", "sous", "age", "saisons", "licencie", "licenciee", "prix", "volumes", "tomes",
]);
/**
 * Le libellé (normalisé, sans ce qui est entre parenthèses) d'une ligne « Libellé : valeur » d'une entrée de liste
 * (« • Plateforme : ADN », « Où le voir ? Sur ADN », « Studio : … ») : une rubrique de diffusion, ou une autre rubrique
 * connue ; sinon null (« BanG Dream! Ave Mujica: prima aurora » est un titre, pas une rubrique).
 */
function libelle(t: string): string | null {
  const m = /^(?:•\s*)?([^:：?\n]{2,40}?)\s*[:：?]\s*\S/u.exec(t);
  if (!m) return null;
  const lab = norm(m[1]!.replace(/\([^)]*\)/g, " "));
  const mots = lab.split(" ").filter(Boolean);
  if (!mots.length || mots.length > 6) return null;
  return estDiffusion(lab) || AUTRES_RUBRIQUES.has(mots[0]!) ? lab : null;
}
// Rubriques de diffusion d'une entrée de liste, par sorte (la date, la diffusion, l'horaire, la plateforme) : leur
// valeur est à l'anime de l'entrée. Les autres (« Studio », « Auteur », « Distributeur », « Où voir les films
// précédents ») ne lui donnent rien.
const EN_FRANCE = "(?: (?:en|in) (?:france|europe))?";
const RUBRIQUE_DATE = new RegExp(`^(?:dates?(?: de (?:sortie|premiere|premiere diffusion|lancement))?|sorties?|sortie (?:en salles?|au cinema)|release(?: date)?|premiere date|air(?:ing)? date|premiere|cinema|au cinema|en salles?)${EN_FRANCE}$`);
const RUBRIQUE_DIFFUSION = new RegExp(`^(?:diffusion|date de diffusion|(?:debut|lancement) (?:de (?:la )?)?diffusion|premiere diffusion|jours? de diffusion|diffusion (?:vf|vostfr|tv|francaise)|diffusee? (?:sur|le|a partir du|des le))${EN_FRANCE}$`);
const RUBRIQUE_HORAIRE = /^(?:horaires?|heure(?: de diffusion)?|jours?)$/;
const RUBRIQUE_PLATEFORME = new RegExp(`^(?:plateformes?(?: de (?:streaming|diffusion))?|streaming|en streaming(?: sur)?|simulcast|disponible sur|disponibilite|diffuseur|chaine|licence|vostfr|vf|vostfr et vf|vf et vostfr|ou (?:le |la |les |l )?(?:voir|regarder|trouver)(?: (?:le film|l anime|la serie|en streaming|en france))?|where to (?:watch|stream)|platforms?|available on|streaming on|watch on|plateformes? francaises?|simulcast sur|diffusee? par|ou (?:le |la |les |l )?(?:voir|regarder|trouver) en (?:vf|vostfr))${EN_FRANCE}(?: (?:vf|vostfr)(?: et (?:vf|vostfr))?)?$`);
const estDiffusion = (lab: string) => RUBRIQUE_DATE.test(lab) || RUBRIQUE_DIFFUSION.test(lab) || RUBRIQUE_HORAIRE.test(lab) || RUBRIQUE_PLATEFORME.test(lab);
/**
 * La sorte d'une rubrique de diffusion, ou null. Pour un film, « Où voir l'anime », « Diffusion TV » parlent de la série ;
 * pour une série, « Où voir le film » parle du film.
 */
function sorteRubrique(lab: string, film: boolean): string | null {
  if (film && /\b(?:l anime|la serie|tv)\b/.test(lab)) return null;
  if (film && /^diffusee? par\b/.test(lab)) return null; // (pour un film, souvent le distributeur en salles)
  if (!film && /\ble film\b/.test(lab)) return null;
  return RUBRIQUE_DATE.test(lab) ? "date" : RUBRIQUE_DIFFUSION.test(lab) ? "diffusion" : RUBRIQUE_HORAIRE.test(lab) ? "horaire" : RUBRIQUE_PLATEFORME.test(lab) ? "plateforme" : null;
}
/** Les blocs d'une zone d'article : les lignes de texteDePage (presse.ts), avec les intertitres et les titres d'entrées. */
export function blocsDe(zone: string): Bloc[] {
  let z = sansOrphelines(fermetures(balisesSaines(String(zone || ""))), PAIRES);
  const a = z.search(/<article\b/i), b = z.lastIndexOf("</article>");
  if (a >= 0 && b > a) z = z.slice(a, b);
  // retirés, mais pas sans trace : une figure ou une vidéo (sa légende peut être le titre de l'entrée suivante) devient
  // une image, un encadré, un menu ou un formulaire une limite
  z = z.replace(/<(script|style|noscript|figure|iframe|aside|nav|form|footer)\b[\s\S]*?<\/\1>/gi, (m: string, nom: string) =>
    /^(?:figure|iframe)$/i.test(nom) ? " <p><img></p> " : /^(?:aside|nav|form|footer)$/i.test(nom) ? ` <p>${LIMITE}</p> ` : " ");
  const out: Bloc[] = [];
  const pousser = (t: string, h: number, lien = false) => {
    const der = out[out.length - 1];
    if (der && der.t === t && der.h === h) return;
    out.push(lien ? { t, h, lien } : { t, h });
  };
  let fin = 0;
  for (const m of z.matchAll(/<(p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    // du texte entre deux blocs, hors paragraphe (<div>, <figcaption>, <td>…) : une limite (le titre d'une entrée ?)
    const brutEntre = z.slice(fin, m.index);
    const entre = decoder(brutEntre.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (out.length && /[\p{L}\p{N}]{2}/u.test(entre)) pousser(coupe(entre, 200), 9);
    else if (out.length && /<img\b/i.test(brutEntre)) pousser("", 8); // une image hors paragraphe (dans un <div>, un lien)
    fin = m.index! + m[0].length;
    const balise = m[1]!.toLowerCase();
    const dedans = m[2]!;
    const t = decoder(dedans.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    let h = balise[0] === "h" ? Number(balise[1]) : 0;
    let lien = false;
    const sansLiens = () => dedans.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ");
    if (h) {
      if (!t) continue;
      lien = LIEN_AILLEURS.test(dedans) && !resteDe(sansLiens());
    } else if (balise === "p") {
      if (!t) {
        if (/<img\b/i.test(dedans)) pousser("", 8); // image seule
        continue;
      }
      if (t.length <= 150) {
        const nu = dedans.replace(ENVELOPPES, "");
        const gras = /<(strong|b)\b/i.test(nu) && !resteDe(nu.replace(/<(strong|b)\b[^>]*>[\s\S]*?<\/\1>/gi, " "));
        const lienSeul = /<a\b/i.test(dedans) && !resteDe(sansLiens());
        // tout en gras (« <p><strong>Titre</strong></p> ») : le titre d'une entrée ; en gras et lien vers une autre
        // page : aussi, mais il ne lui sera consacré que s'il n'est que son titre ; lien seul : une limite
        // (une rubrique toute en gras, « <strong>Date de sortie : 16 octobre</strong> », reste une rubrique)
        if (gras && !libelle(t)) {
          h = 7;
          lien = LIEN_AILLEURS.test(dedans);
        } else if (lienSeul && !gras) h = 9;
      }
      if (!h && t.length < 30) {
        // ligne courte qui n'est ni une phrase ni « Libellé : valeur » : le titre d'une entrée mal balisé, une limite
        if (!finDePhrase(t) && !libelle(t)) {
          pousser(t, 9);
          continue;
        }
        if (t.length < 6) continue;
      }
    } else if (t.length < 12 && !libelle(t)) {
      // <li> court : un titre d'entrée (« 86 »), une limite
      pousser(t, 9);
      continue;
    }
    if ((t.match(/[»›]/g) || []).length >= 2) continue; // fil d'Ariane
    const ligne = balise === "li" ? "• " + t : t;
    if (LIGNE_RENVOI.test(norm(ligne))) {
      h = 9;
      lien = false;
    }
    pousser(ligne, h, lien);
  }
  return out;
}
// Intertitres qui ouvrent ce qui n'est plus l'article : commentaires, mots-clés (l'intertitre entier), articles liés.
const FIN_ARTICLE = new RegExp(
  "^(?:(?:\\d+ )?(?:commentaires?|comments?)(?: \\d+)?|laisser un commentaire|leave a (?:comment|reply)|reagir|tags?|mots cles|etiquettes|" +
    "tendances?|a la une|les plus lus|les plus populaires|recommandee?s?|a ne pas manquer|trending(?: now)?|most (?:read|popular)|popular(?: now| news| stories)?|" +
    // (relecture 3) un intertitre court (trois mots de plus au plus) : « Ne manquez pas la première de X » ou un TITRE
    // « Ne manquez pas les simulcasts de l'hiver sur Crunchyroll » sont l'article
    "(?:ne manquez pas|recommandations?|tendances du moment|populaires? en ce moment|voir plus)(?: [a-z0-9]+){0,3})$" +
    "|^(?:(?:articles?|actualites|actus?|news) (?:lies|similaires|recommandes|recommandees|connexes)|a lire (?:aussi|egalement|ensuite)|" +
    "(?:les )?(?:dernieres?|autres?) (?:news|actus?|actualites|articles)|plus de crunchyroll news|sur le meme theme|" +
    "lire (?:aussi|egalement)|a voir aussi|voir aussi|" +
    "sur le meme sujet|vous aimerez aussi|vous pourriez aimer|dans la meme categorie|plus de? (?:articles|actus?|actualites|news)|" +
    "dernieres? (?:news|actus?|actualites|articles)|related(?: articles?| news| posts?| stories| content)?|read (?:also|more|next)|" +
    "more (?:news|stories|from)|you (?:may|might) (?:also )?like|recommended(?: for you)?)\\b",
);
const LIEN_MD = /!?\[([^\]\n]{0,300})\]\([^)\s]{0,2000}\)/g;
const IMAGES_MD = /^(?:!\[[^\]\n]{0,300}\]\([^)\s]{0,2000}\)\s*)+$/;
/** Les lignes d'un texte, une ligne de plus de 5 000 caractères coupée en morceaux de phrases (2 000 au plus). */
function lignesBornees(texte: string): string[] {
  const out: string[] = [];
  for (const ligne of texte.split("\n")) {
    if (ligne.length <= 5000) {
      out.push(ligne);
      continue;
    }
    let morceau = "";
    for (const p of decouperPhrases(ligne)) {
      for (let k = 0; k < p.length; k += 2000) {
        const x = p.slice(k, k + 2000);
        if (morceau && morceau.length + 1 + x.length > 2000) {
          out.push(morceau);
          morceau = "";
        }
        morceau = morceau ? `${morceau} ${x}` : x;
      }
    }
    if (morceau) out.push(morceau);
  }
  return out;
}
const sansDiesesFinaux = (s: string) => {
  const t = s.trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === "#") k--;
  return k < t.length && (k === 0 || /\s/.test(t[k - 1]!)) ? t.slice(0, k).trimEnd() : t;
};
/**
 * Les blocs du texte qu'a lu Tavily (markdown) : intertitres (#), titres d'entrées (ligne tout en gras), lignes de
 * liste, paragraphes, images ; sans liens. Une ligne qui n'est que des liens (menu, articles liés) est une limite, une
 * ligne courte qui n'est pas une phrase aussi. Après un intertitre de commentaires ou d'articles liés (ou une ligne en
 * gras qui en est un), rien n'est lu jusqu'au prochain vrai intertitre (#) de même niveau ou plus haut : le pseudo d'un
 * lecteur, en gras, ne rouvre pas l'article.
 */
export function blocsMarkdown(md: string, titre = ""): Bloc[] {
  const out: Bloc[] = [];
  const pousser = (t: string, h: number, lien = false) => {
    const der = out[out.length - 1];
    if (der && der.t === t && der.h === h) return;
    out.push(lien ? { t, h, lien } : { t, h });
  };
  let horsArticle = 0; // niveau de l'intertitre « commentaires », « articles liés » en cours (0 : dans l'article)
  for (const brute of lignesBornees(String(md || "").replace(/\r/g, ""))) {
    let l = brute.trim().replace(/^(?:>\s*)+/, "");
    if (!l || /^(?:[-*_]\s*){3,}$/.test(l) || l.startsWith("|")) continue; // filets, tableaux
    let h = 0, liste = false, lien = false;
    const mh = /^(#{1,6})[ \t]+(.*)$/.exec(l);
    const ml = mh ? null : /^(?:[-*+•]|\d{1,3}[.)])[ \t]+(.*)$/.exec(l);
    if (mh) {
      h = mh[1]!.length;
      l = sansDiesesFinaux(mh[2]!);
    } else if (ml) {
      liste = true;
      l = ml[1]!;
    }
    if (/\]\(/.test(l) && !l.replace(LIEN_MD, " ").replace(/[\s|·•>*#_\-–—:,.()]+/g, "")) {
      // rien que des liens : des images (8), un intertitre qui est un lien, un titre d'entrée en gras qui est un lien
      // (« **[X](…)** », « [**X**](…) » : 7), sinon une limite (menu, liens)
      if (IMAGES_MD.test(l)) {
        if (!h && !liste) h = 8;
      } else if (h) lien = true;
      else if (/^(?:\*\*|__)\[|^\[(?:\*\*|__)/.test(l)) {
        h = 7;
        lien = true;
      } else h = 9;
    } else if (!h && !liste && /^(\*\*|__)(?:(?!\1).)+\1$/.test(l) && !libelle(l.replace(/\*\*|__/g, ""))) h = 7;
    l = l.replace(LIEN_MD, (m: string, texte: string) => (m.startsWith("!") ? " " : texte)).replace(/<https?:\/\/[^>\s]*>/g, " ");
    l = decoder(l.replace(/\*\*|__|`/g, "").replace(/(^|[\s(])[*_](?=\S)/g, "$1").replace(/(\S)[*_](?=[\s).,;:!?]|$)/g, "$1")).replace(/\s+/g, " ").trim();
    if (h >= 1 && h <= 6 && horsArticle && h <= horsArticle) horsArticle = 0;
    const niveau = h >= 1 && h <= 6 ? h : h === 7 ? 2 : 0;
    if (niveau && FIN_ARTICLE.test(norm(l))) {
      horsArticle = horsArticle ? Math.min(horsArticle, niveau) : niveau;
      continue;
    }
    if (horsArticle) continue;
    if (h === 8) {
      pousser("", 8);
      continue;
    }
    if (h) {
      if (l.length < 3 && h !== 9) continue;
    } else if (liste) {
      if (l.length < 12 && !libelle(l)) {
        pousser("• " + l, 9);
        continue;
      }
    } else if (l.length < 30) {
      if (l && !finDePhrase(l) && !libelle(l)) {
        pousser(l, 9); // ligne courte qui n'est ni une phrase ni une rubrique : le titre d'une entrée, une limite
        continue;
      }
      if (l.length < 6) continue;
    }
    if ((l.match(/[»›]/g) || []).length >= 2) continue;
    const t = liste ? "• " + l : l;
    if (LIGNE_RENVOI.test(norm(t))) {
      h = 9;
      lien = false;
    }
    pousser(t, h, lien);
  }
  // plusieurs « # » : le titre de la page, les autres des entrées (comme « ## »)
  // titres de la page : les « # » de tête (avant la première ligne de texte) qui reprennent le titre donné
  // par Tavily (« Crunchyroll News », puis le titre de l'article : « … | Crunchyroll News ») ; à défaut, le premier « # ».
  const titres = titresDePage(out, titre);
  for (const [i, b] of out.entries()) if (b.h === 1 && !titres.has(i)) b.h = 2;
  return out;
}
/** Les h1 qui sont le titre de la page (voir blocsMarkdown) : le premier h1 ; et, quand celui-ci n'est ni le
 * titre ni son morceau principal (un en-tête de site : « # Crunchyroll News » pour « Titre | Crunchyroll News », un logo en
 * <h1>), le h1 de tête suivant qui reprend le titre ou l'un de ses deux morceaux (coupé au dernier « | », « - », « – »). */
function titresDePage(blocs: Bloc[], titre: string): Set<number> {
  const out = new Set<number>();
  const premier = blocs.findIndex((b) => b.h === 1);
  if (premier < 0) return out;
  out.add(premier);
  const tN = norm(titre);
  const sep = [...titre.matchAll(/\s[|–—-]\s/g)].pop();
  const morceaux = [titre, ...(sep ? [titre.slice(0, sep.index), titre.slice(sep.index! + sep[0].length)] : [])].map((x) => norm(x)).filter(Boolean);
  const principal = morceaux.filter((x) => x !== tN).sort((x, y) => y.length - x.length)[0] ?? tN;
  const p0 = norm(blocs[premier]!.t.slice(0, 300));
  if (!tN || p0 === tN || p0 === principal) return out;
  const texte = blocs.findIndex((b) => !b.h);
  blocs.forEach((b, i) => {
    if (i > premier && b.h === 1 && (texte < 0 || i < texte) && morceaux.includes(norm(b.t.slice(0, 300)))) out.add(i);
  });
  return out;
}
/** Un bloc de texte de plus de 2 000 caractères (un texte d'un seul tenant) : coupé en morceaux de phrases (1 000 au plus). */
function decouperBlocs(blocs: Bloc[]): Bloc[] {
  const out: Bloc[] = [];
  for (const b of blocs) {
    if (b.h || b.t.length <= 2000) {
      out.push(b);
      continue;
    }
    for (const t of lignesBornees(b.t.replace(/\n/g, " ")).flatMap((x) => {
      const r: string[] = [];
      let morceau = "";
      for (const p of decouperPhrases(x)) {
        for (let k = 0; k < p.length; k += 1000) {
          const y = p.slice(k, k + 1000);
          if (morceau && morceau.length + 1 + y.length > 1000) {
            r.push(morceau);
            morceau = "";
          }
          morceau = morceau ? `${morceau} ${y}` : y;
        }
      }
      if (morceau) r.push(morceau);
      return r;
    })) out.push({ t, h: 0 });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── titre de l'anime dans la page
// Séparateurs d'un titre « X: Y » (les mêmes que presse.ts : alias).
const SEPARATEURS = /\s*[:：]\s+|\s+[-–~]\s*|\s*[-–~]\s+/;
// Mots qui ne suffisent pas à reconnaître un titre (« The Movie », « Season 2 ») et, entre X et Y, une saison ou un
// numéro qui en ferait un autre titre (« Frieren saison 2 : … »).
const MOTS_VIDES = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "le", "la", "les", "l", "de", "du", "des", "d", "un", "une", "et", "el", "los",
  "movie", "film", "films", "season", "saison", "temporada", "part", "partie", "cour", "final", "finale", "chapter", "chapitre",
  "arc", "special", "ova", "oav", "tv", "series", "serie", "anime", "gekijouban", "new", "nouveau", "nouvelle", "edition",
]);
const NUMERO = /^(?:\d+|ii|iii|iv|v|vi|\d+(?:st|nd|rd|th|e|eme|er|a|o)|saison|season|temporada|part|partie|cour|movie|film|gekijouban|ova|oav|special)$/;
// Entre X et Y : pas de plateforme (« Ave Mujica - Netflix - prima aurora » n'est pas un titre).
const MOT_PLATEFORME = /^(?:adn|crunchyroll|netflix|prime|amazon|disney|hidive|hulu|hbo|wakanim|cinema|simulcast|vostfr)$/;
/** Une forme assez distinctive : un mot de 4 lettres au moins qui n'est pas un mot vide, et 6 caractères en tout. */
const distinctive = (mots: string[]) => mots.join(" ").length >= 6 && mots.some((m) => m.length >= 4 && !MOTS_VIDES.has(m) && !/^\d+$/.test(m));
/** Les couples X, Y d'un titre « X: Y » ; X aussi sans ce qui précède un « ! » (« BanG Dream! Ave Mujica » → « Ave Mujica »). */
function couples(a: AnimeCat): Array<[string[], string[]]> {
  const out: Array<[string[], string[]]> = [];
  const vus = new Set<string>();
  for (const t of [a.titleEnglish, a.title]) {
    if (!t) continue;
    const morceaux = String(t).split(SEPARATEURS).map((x) => x.trim()).filter(Boolean);
    if (morceaux.length < 2) continue;
    const y = norm(morceaux[morceaux.length - 1]).split(" ").filter(Boolean);
    const coupes = morceaux[0]!.split(/[!！]+\s+/);
    for (const xt of coupes.length > 1 ? [morceaux[0]!, coupes[coupes.length - 1]!] : [morceaux[0]!]) {
      const x = norm(xt).split(" ").filter(Boolean);
      const cle = `${x.join(" ")}|${y.join(" ")}`;
      if (!x.length || !distinctive(x) || !distinctive(y) || vus.has(cle)) continue;
      vus.add(cle);
      out.push([x, y]);
    }
  }
  return out;
}
const indexMots = (mots: string[], motif: string[], depuis: number, jusqua = Infinity) => {
  for (let i = depuis; i + motif.length <= mots.length && i <= jusqua; i++) if (motif.every((m, k) => mots[i + k] === m)) return i;
  return -1;
};
// Séparateur d'un sous-titre dans une ligne : tiret entre espaces ou collé à un seul mot (« -prima aurora- »), deux-points,
// tilde, barre, guillemets, parenthèses. Remplacé par un mot repère, que norm garde.
const SOUS_TITRE = /\s[-–—~]+\s|\s[-–—~]+(?=\S)|(?<=\S)[-–—~]+(?=\s|$)|\s?[:：|«»"“”()]\s?/gu;
const REPERE = "zzsepzz";
const motsEtSeparateurs = (ligne: string) => norm(ligne.replace(SOUS_TITRE, ` ${REPERE} `)).split(" ").filter(Boolean);
/**
 * L'anime avec, en plus de ses formes, son titre « X: Y » tel que le texte l'écrit « X - … - Y » (forme complète) : sur
 * une même ligne, X puis un séparateur de sous-titre, puis Y, ou au plus 6 mots suivis d'un séparateur puis Y ; entre
 * les deux, ni saison, ni numéro, ni plateforme (« Après Ave Mujica sur ADN, prima aurora… » n'est pas le titre).
 */
export function viser(a: AnimeCat, texte: string): AnimeCat {
  const paires = couples(a);
  if (!paires.length) return a;
  const ajouts = new Set<string>();
  // (une ligne très longue, texte d'un seul tenant, est lue phrase par phrase : le titre tient dans une phrase)
  const morceaux = String(texte || "").split("\n").flatMap((l) => (l.length > 2000 ? decouperPhrases(l) : [l]));
  for (const ligne of morceaux) {
    if (!/[-–—~:：|«»"“”()]/.test(ligne)) continue;
    const n = norm(ligne);
    if (!paires.some(([x, y]) => contient(n, x.join(" ")) && contient(n, y[0]!))) continue;
    const mots = motsEtSeparateurs(ligne);
    for (const [x, y] of paires) {
      for (let i = indexMots(mots, x, 0); i >= 0; i = indexMots(mots, x, i + 1)) {
        let j = i + x.length;
        if (mots[j] !== REPERE) continue;
        while (mots[j] === REPERE) j++;
        let k = j;
        if (indexMots(mots, y, j, j) !== j) {
          while (k < mots.length && mots[k] !== REPERE && k - j <= 6) k++;
          const milieu = mots.slice(j, k);
          if (!milieu.length || milieu.length > 6 || mots[k] !== REPERE || milieu.some((m) => NUMERO.test(m) || MOT_PLATEFORME.test(m))) continue;
          while (mots[k] === REPERE) k++;
          if (indexMots(mots, y, k, k) !== k) continue;
        }
        ajouts.add([...x, ...mots.slice(j, k).filter((m) => m !== REPERE), ...y].join(" "));
      }
    }
  }
  const neuves = [...ajouts].filter((f) => !a.alias.some((al) => al.forme === f));
  return neuves.length ? { ...a, alias: [...a.alias, ...neuves.map((forme) => ({ forme, complet: true }))] } : a;
}
/**
 * Les formes de chaque anime du catalogue, rangées par leurs deux premiers mots (le premier seul pour une forme d'un
 * mot) ; nommes() : les animes nommés dans un texte (une forme y est écrite d'un tenant, comme contient). Un seul
 * passage sur le texte, quel que soit le catalogue.
 */
function indexFormes(cat: AnimeCat[]): Map<string, Array<{ id: number; mots: string[] }>> {
  const idx = new Map<string, Array<{ id: number; mots: string[] }>>();
  for (const it of cat) {
    for (const al of it.alias) {
      const mots = al.forme.split(" ");
      const cle = mots.length > 1 ? `${mots[0]} ${mots[1]}` : mots[0]!;
      const l = idx.get(cle) ?? [];
      l.push({ id: it.id, mots });
      idx.set(cle, l);
    }
  }
  return idx;
}
function nommes(texteNorm: string, idx: ReturnType<typeof indexFormes>): Set<number> {
  const mots = texteNorm.split(" ");
  const out = new Set<number>();
  for (let i = 0; i < mots.length; i++) {
    for (const cle of i + 1 < mots.length ? [mots[i]!, `${mots[i]} ${mots[i + 1]}`] : [mots[i]!]) {
      for (const f of idx.get(cle) ?? []) if (!out.has(f.id) && f.mots.every((m, k) => mots[i + k] === m)) out.add(f.id);
    }
  }
  return out;
}
/**
 * La ligne (normalisée) nomme-t-elle l'anime ? Pas quand la forme trouvée n'y est qu'une partie du titre plus long
 * d'un autre anime du catalogue, écrit là aussi (« BanG Dream! Ave Mujica » dans « BanG Dream! Ave Mujica: prima aurora »),
 * y compris tel que le texte l'écrit (« … - The Die is Cast - prima aurora ») ; ni quand ce n'est qu'un titre court de
 * l'anime, qui est le titre complet d'un autre (le film « BanG Dream! Ave Mujica: prima aurora » et la série « BanG Dream! Ave Mujica »).
 */
export function nommePar(vise: AnimeCat, cat: AnimeCat[], texte = ""): (texteNorm: string) => boolean {
  const couvre = (r: string, x: Alias) => (r.length > x.forme.length && contient(r, x.forme)) || (r === x.forme && !x.complet);
  const rivaux: string[] = [];
  for (const it of cat) {
    if (it.id === vise.id || !it.alias.some((al) => al.complet && vise.alias.some((x) => couvre(al.forme, x)))) continue;
    for (const al of (texte ? viser(it, texte) : it).alias) if (al.complet && vise.alias.some((x) => couvre(al.forme, x))) rivaux.push(al.forme);
  }
  return (t: string) => vise.alias.some((al) => contient(t, al.forme) && !rivaux.some((r) => couvre(r, al) && contient(t, r)));
}
/** L'anime sans ses titres courts qui sont le titre complet d'un autre anime du catalogue (ambigus : ils ne le désignent pas). */
function sansTitresDautrui(a: AnimeCat, cat: AnimeCat[]): AnimeCat {
  const autres = new Set<string>();
  for (const it of cat) if (it.id !== a.id) for (const al of it.alias) if (al.complet) autres.add(al.forme);
  const alias = a.alias.filter((al) => al.complet || !autres.has(al.forme));
  return alias.length === a.alias.length ? a : { ...a, alias };
}
/** L'anime réduit à ses titres complets (et à ceux que le texte écrit « X - … - Y ») : ce qui le nomme sans doute possible. */
const titresComplets = (a: AnimeCat): AnimeCat => ({ ...a, alias: a.alias.filter((al) => al.complet) });
/**
 * Une phrase (normalisée) nomme-t-elle l'anime par un titre complet (pas dans le titre plus long d'un autre, nommePar) ?
 * Pour une suite, son titre court suivi de sa saison suffit aussi (« la saison 2 de Frieren »).
 */
function nommeFortPar(it: AnimeCat, cat: AnimeCat[], texte: string): (texteNorm: string) => boolean {
  const forts = titresComplets(it);
  const fort = forts.alias.length ? nommePar(forts, cat, texte) : () => false;
  const tous = nommePar(it, cat, texte);
  return (n) => fort(n) || (it.saison >= 2 && tous(n) && saisonsCitees(n).numeros.has(it.saison));
}
// Films, épisodes spéciaux, OAV, clips : leur titre court (« BanG Dream! Ave Mujica » pour le film « … : prima aurora »,
// « Chainsaw Man » pour « Chainsaw Man – The Movie: Reze Arc ») est celui de la série ou de la franchise, souvent hors du
// catalogue (la série sortie avant la fenêtre du site) : il ne désigne pas le film.
const FORMATS_FILM = new Set(["MOVIE", "SPECIAL", "OVA", "MUSIC"]);
const estFilm = (it: AnimeCat) => FORMATS_FILM.has(String(it.format || "").toUpperCase());
// Une phrase qui parle d'une autre œuvre que l'anime.
//   - Pour un film : la série (« l'anime », la saison, la diffusion TV, le simulcast, chaque mardi), les films d'avant, la
//     franchise ; seul le cinéma peut alors lui revenir, et seulement si la phrase a le film pour sujet, sans
//     projection d'épisodes, avant-première, festival ni autre film (sinon c'est une date qui n'est pas la sienne).
//   - Pour une série : un film, dans une phrase qui ne la nomme pas (sauf en tête : « Après le film, l'anime arrive… »).
//   - Partout : une comparaison avec une autre œuvre (« Comme Chainsaw Man… », « Si X vous plaît, foncez sur… », « Dans
//     la lignée du très populaire X »), et « les fans de X » ou « après X » quand X n'est pas l'anime.
const AUTRE_POUR_FILM = /\b(?:series?|saisons?|seasons?|episodes?|l anime|anime tv|tv anime|television|televisee?|tv|simulcast|chaque (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine)|every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|weekly|anime original|precedente?s?|previous|prior|franchise|saga|volets?|trilogie|premiers? films?|first film|deux films|trois films|autres films|other films|films precedents|avant le film|apres le film)\b/;
const PAS_EPISODES = /\b(?:saisons?|seasons?|series?|l anime|anime tv|tv anime|television|televisee?|tv|simulcast|chaque (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine)|every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|weekly|anime original|precedente?s?|previous|prior|franchise|saga|volets?|trilogie|premiers? films?|first film|deux films|trois films|autres films|other films|films precedents|avant le film|apres le film)\b/;
const CINE_AUTRE = /\b(?:projetee?s?|projections?|avant premieres?|festival|precedente?s?|previous|prior|premier film|first film|autres films|other films|deux films|franchise|saga|volets?|trilogie|au japon|in japan)\b/;
// Cinéma : un autre film, toujours écarté ; un autre événement (projection, avant-première, festival, Japon), seulement
// dans la proposition de la date, ou avec deux dates dans la phrase (« Après son triomphe au Japon, X sortira au cinéma
// en France le … » reste la sortie du film).
const CINE_AUTRE_FILM = /\b(?:precedente?s?|previous|prior|premier film|first film|autres films|other films|deux films|trilogie)\b/;
// les séances et présentations d'un jour, Annecy, le Grand Rex, Japan Expo sont des événements.
// + les soirées et ciné-événements ; UN_SOIR : une séance d'un soir, au singulier (« pour une seule
// soirée », « un soir seulement », « en ciné-événement »), aussi dans une proposition suivante sans date.
const UN_SOIR = "une seule (?:seance|soiree|journee|nuit|projection)|un seul soir|un soir seulement|pour un soir|(?:deux|trois|2|3) (?:jours|soirs|soirees) seulement|(?:lors d une|pour une) (?:seance|soiree) (?:speciale|unique|exceptionnelle|evenement)|le temps d une (?:seance|soiree|journee|nuit)|en seance (?:speciale|unique|exceptionnelle|evenement)|en cine evenement"
  // + deux séances, une semaine, un week-end seulement ; « uniquement le 4 octobre » (« pour une semaine
  // seulement » : pas « une semaine seulement après le Japon »)
  + "|(?:deux|trois|2|3) seances seulement|pour (?:deux|trois|2|3) seances|pour une semaine seulement|le temps d un week end|pour un week end|uniquement le \\d{1,2}(?: ?er)?|seulement le \\d{1,2}(?: ?er)?";
const EVENEMENT_LOCAL = `projections?|avant premieres?|festival|seances? (?:speciales?|uniques?|exceptionnelles?|evenements?)|soirees? (?:speciales?|uniques?|exceptionnelles?|evenements?)|cine evenements?|${UN_SOIR}|presentee?s? (?:a|lors|en ouverture|en avant premiere|en competition|au festival|au grand rex)|en ouverture|annecy|grand rex|japan expo|anime expo`;
const UN_SOIR_N = new RegExp(`\\b(?:${UN_SOIR})\\b`);
const AUTRE_EVENEMENT = /\b(?:avant premieres?|festival|grand rex|japan expo|anime expo|annecy|en ouverture|presentee?s? (?:a|lors|en ouverture|en avant premiere|en competition|au festival|au grand rex))\b/;
// « projeté » : la phrase est examinée (comme en v6) ; dans la proposition de la date, c'est la sortie
// seulement s'il est suivi (12 mots au plus) du début d'une exploitation : « à partir du », « à compter du », « dès le »,
// « dès ce / cette » (« projeté au cinéma en France à partir du 22 octobre ») ; sinon une séance (« projeté le 4 octobre
// dans une vingtaine de cinémas », « projeté au cinéma le 4 octobre dans toute la France lors d'une soirée spéciale »).
// Pas « des » seul (l'article : « dans des salles partenaires ») ni « dans toute la France » (les ciné-événements aussi).
const PROJETE_SEANCE = "projetee?s?(?!(?: [a-z0-9]+){0,12}? (?:a partir du|a compter du|des le|des ce|des cette)\\b)";
const CINE_EVENEMENT = new RegExp(`\\b(?:projetee?s?|${EVENEMENT_LOCAL}|au japon|in japan)\\b`);
const CINE_EVENEMENT_LOCAL = new RegExp(`\\b(?:${PROJETE_SEANCE}|${EVENEMENT_LOCAL})\\b`);
const JAPON_N = /\b(?:au japon|in japan)\b/;
// « Au Japon, le film sortira au cinéma le 19 septembre ; en France, … » : le Japon seul, en tête de la proposition de la date
const JAPON_SEUL = /^(?:(?:d abord|deja|uniquement|seulement|first|only) )?(?:au japon|in japan)(?: (?:d abord|deja|uniquement|seulement|first|only))?$/;
const FRANCE_N = /\b(?:france|francais|francaise|francaises|french|vf|vostfr)\b/;
// Film : une plateforme (pas le cinéma) dans une phrase qui parle aussi des salles n'est jamais gardée pour lui : c'est
// trop souvent la plateforme de la série (« Disponible sur ADN depuis janvier, l'histoire se poursuit au cinéma… »,
// « Netflix propose déjà l'histoire… ») ou le distributeur (« … au cinéma le 22 octobre, distribué par Crunchyroll »).
// Huit relectures ont montré qu'aucune règle « ensuite » ne les sépare sans rouvrir de faux positif : le prix est la
// phrase « Sorti au cinéma en octobre, X arrive sur Crunchyroll le 20 décembre », perdue (une phrase sans les salles,
// « X arrive sur Crunchyroll le 20 décembre », reste lue). Le distributeur n'est jamais une plateforme.
const CINE_MOT = /\b(?:cinema|cinemas|au cine|en salles?|salles|theaters?|theatres?|theatrical|box office)\b/;
const DISTRIBUE = /\b(?:distribue(?:e|s|es)? (?:par|en)|distribuera|distribueront|distribuer|distributeur|distributed by|distributes|distributor|grace a|courtesy of|en partenariat avec|in partnership with)\b/;
const MARQUE_FILM_PLUS = /\b(?:integrale|fin de (?:la|sa) diffusion)\b/;
// Le distributeur sans le mot : la plateforme sujet de « sortir / présenter / release / bring »
// (« Crunchyroll sortira le film en France le 22 octobre », « Crunchyroll et Sony Pictures présentent X le 22 octobre »,
// « Crunchyroll will release / brings X to France on October 22 », « présenté par Crunchyroll »)
const PF_DISTRIBUE = /\b(?:adn|crunchyroll|netflix|prime video|amazon|disney|hidive|hulu|hbo max|wakanim)(?: (?:et|and) [a-z]+(?: [a-z]+)?)? (?:(?:aussi|egalement|also) )?(?:sortira|sortiront|sort|sortent|presente|presentent|presentera|presenteront|presents|will present|releases|will release|is releasing|to release)\b|\b(?:presentee?s? par|presented by)\b|\b(?:brings|will bring|is bringing) (?:[a-z0-9]+ ){1,10}?to (?:france|french theaters|french theatres|theaters|theatres|cinemas)\b/;
// L'histoire d'avant (la série sans le mot « série ») dans une phrase sans les salles : « L'histoire est
// disponible sur ADN depuis janvier ; le film la prolonge », « Netflix propose déjà l'histoire… », « Le premier arc est
// disponible sur Crunchyroll », « The story so far is streaming on Crunchyroll », « Fans can catch up on the story on… »
const HISTOIRE_AVANT = /\b(?:l histoire|le recit|l intrigue|la premiere partie|premiere partie|le premier arc|premier arc|the story|story so far|the first part|first part|the first arc|first arc|the plot|rattraper|catch up)\b/;
const SORTIE_SALLES = /\b(?:sort|sortira|sortent|sortiront|sortir|sortie|arrive|arrivera|arrivent|arriveront|debarque|debarquera|en salles?|au cinema|dans les salles|dans les cinemas|salles francaises|a l affiche|in theaters|in theatres|hits theaters|theaters|theatres|opens|releases?)\b/;
// la proposition de la date : sans événement, avec la sortie ; si la phrase parle du Japon, la France y est
// écrite (« Le film sortira en salles le 27 février, au Japon, puis en France à l'automne » : pas la date française).
// La date seule est jointe à la proposition d'avant seulement après une virgule (« …en France, le 22
// octobre, avec… ») ; après « ; », « et », « puis » elle ouvre la suivante (« … le 22 octobre ; le 4 octobre, il sera
// projeté en avant-première… »). Deux dates dans la proposition de la date (un report : « passe du 15 au 22 octobre »,
// une avant-première jointe) : rejet, comme en v6. Japon : la France dans la proposition de la date, ou en tête de phrase
// (« En France, … »), ou dans la proposition qui suit (« …, distribué en France par … »), sans le Japon.
const DATE_SEULE = /^(?:(?:le|des le|a partir du|du|au|on|from) )?\d{1,2}(?: ?er)? [a-z]+(?: \d{4})?$|^(?:on |from )?[a-z]+ \d{1,2}(?: \d{4})?$/;
// « avant sa sortie nationale le 22 octobre », « before its wide release on October 22 », « puis dans toute la France le 22 octobre »
// (pas la sortie d'un autre pays : « …en France le 22 octobre, avant sa sortie nationale aux États-Unis le 5 décembre », « avant sa
// sortie en Belgique le 29 octobre »)
const AUTRE_PAYS_SORTIE = /\b(?:etats unis|amerique|japon|japan|allemagne|espagne|italie|royaume uni|canada|coree|chine|us|usa|uk|united states|germany|spain|italy|belgique|suisse|quebec|luxembourg|belgium|switzerland)\b/;
const PARTOUT_FRANCE = /^(?:(?:en|au) (?:cinema|salles?) )?(?:dans toute la france|partout en france|dans toutes les salles|dans toutes les salles de france|sur tout le territoire|en sortie nationale|nationwide|across france)\b/;
const AVANT_SORTIE = /^(?:sa|la|leur|its|the) (?:sortie|release) (?:nationale|officielle|generale|en salles|au cinema|dans les salles|francaise|en france|dans toute la france|wide|national|nationwide|theatrical)\b|^(?:its|the) (?:wide|national|nationwide|theatrical) release\b/;
function evenementPresDeLaDate(v: Verdict, brut: string, n: string): boolean {
  if (!v.date) return true;
  const parts = brut.split(/([,;]|\s(?:puis|avant|après|apres|et|and|then|before|after)\s)/);
  const segs = parts.filter((_, k) => k % 2 === 0), seps = parts.filter((_, k) => k % 2 === 1);
  const j = segs.findIndex((x) => dateDansTexte(v.date!, norm(x), x));
  if (j < 0) return true;
  let ns = norm(segs[j]);
  if (DATE_SEULE.test(ns)) ns = j > 0 && seps[j - 1] === "," ? `${norm(segs[j - 1])} ${ns}` : `${ns} ${norm(segs[j + 1] ?? "")}`;
  if ((ns.match(DATES_RUBRIQUE) || []).length > 1) return true;
  if (CINE_EVENEMENT_LOCAL.test(ns) || !SORTIE_SALLES.test(ns)) return true;
  // une séance d'un soir dans une proposition suivante sans date, avant le prochain « ; » (« …le 4 octobre,
  // pour une seule soirée ») ; une date seule après une virgule appartient à la proposition d'avant (« …, le 18 octobre »)
  const suivantes: string[] = [];
  for (let k = j + 1; k < segs.length && seps[k - 1] !== ";"; k++) {
    const x = norm(segs[k]);
    if (DATE_SEULE.test(x) && seps[k - 1] === "," && suivantes.length) suivantes[suivantes.length - 1] += ` ${x}`;
    else suivantes.push(x);
  }
  // (pas quand la proposition nomme un autre événement : « …le 22 octobre et sera projeté pour une seule soirée au Grand Rex »)
  if (suivantes.some((x) => UN_SOIR_N.test(x) && !UNE_DATE_RUBRIQUE.test(x) && !AUTRE_EVENEMENT.test(x))) return true;
  // « …dès le 4 octobre dans une sélection de salles, avant sa sortie nationale le 22 octobre » : la date
  // d'avant la sortie nationale (proposition suivante introduite par « avant ») n'est pas la sortie
  for (let k = j + 1, avant = false, puis = false; k < segs.length; k++) {
    avant = avant || /avant|before/.test(seps[k - 1] ?? "");
    puis = puis || /puis|then/.test(seps[k - 1] ?? "");
    const x = norm(segs[k]);
    if (!x) continue;
    if (avant && AVANT_SORTIE.test(x) && UNE_DATE_RUBRIQUE.test(x) && !AUTRE_PAYS_SORTIE.test(x)) return true;
    // « …le 4 octobre dans quelques salles, puis dans toute la France le 22 octobre » : la date d'une sortie limitée
    if (puis && PARTOUT_FRANCE.test(x) && UNE_DATE_RUBRIQUE.test(x) && !AUTRE_PAYS_SORTIE.test(x)) return true;
    break;
  }
  if (!JAPON_N.test(n) || FRANCE_N.test(ns)) return false;
  if (JAPON_N.test(ns)) return true;
  // « …le 19 septembre, au Japon, … » : le Japon de la proposition qui suit la date (sans date ni France)
  // est encore celui de la date (« En France, il faudra patienter : le film sortira au cinéma le 19 septembre, au Japon »)
  const apresDate = norm(segs[j + 1] ?? "");
  // (aussi après « et » : « …le 19 septembre et au Japon seulement »)
  if ((seps[j] === "," || /^\s(?:et|and)\s$/.test(seps[j] ?? "")) && JAPON_N.test(apresDate) && !UNE_DATE_RUBRIQUE.test(apresDate) && !FRANCE_N.test(apresDate)) return true;
  // « Au Japon, le film sortira au cinéma le 19 septembre ; en France, … » : le Japon seul en tête de la
  // proposition de la date (jusqu'au « ; » d'avant)
  for (let k = j - 1; k >= 0 && seps[k] !== ";"; k--) if (JAPON_SEUL.test(norm(segs[k]))) return true;
  const france = (t: string) => FRANCE_N.test(t) && !JAPON_N.test(t);
  // la France de la proposition qui suit seulement après une virgule (« …, distribué en France par … ») :
  // pas après « ; » (« … le 19 septembre ; en France, la date reste inconnue »)
  const tete = j > 0 ? norm(segs[0]) : "", suite = seps[j] === "," ? norm(segs[j + 1] ?? "") : "";
  return !(france(tete) || (france(suite) && !(suite.match(DATES_RUBRIQUE) || []).length));
}
const SUJET_FILM = /\b(?:le film|ce film|ce long metrage|le long metrage|the film|the movie|this film|le nouveau film|ce nouveau film|le dernier film|the new film|the latest film)\b/;
const AUTRE_POUR_SERIE = /\b(?:films?|movies?|long metrage|gekijouban)\b/;
// Comparaisons (texte brut) : le marqueur, au plus trois mots en minuscules (« du très populaire »), un nom propre.
const MARQUE_TOUJOURS = "[Cc]omme|[Àà] l['’]image d(?:e|u|es|['’])|[Àà] l['’]instar d(?:e|u|es|['’])|[Dd]ans la lignée d(?:e|u|es|['’])|[Dd]ans le sillage d(?:e|u|es|['’])|[Aa]près|[Aa]vant|[Ii]nspirée? d(?:e|u|es|['’])|[Ll]ike|[Aa]fter|[Bb]efore";
const MARQUE_AUTRE = "[Ll]es fans d(?:e|u|es|['’])|[Ff]ans d(?:e|u|es|['’])|[Ff]ans of";
// Mots permis entre le marqueur et le nom propre : articles, « très », adjectifs, « succès de »… (pas « annoncé par »,
// « en », « la sortie de » : « Comme annoncé par Kadokawa », « en France comme en Belgique » ne comparent rien).
const MOT_INTERCALE = "(?:(?:l|d)['’])?(?:le|la|les|un|une|du|des|de|tres|très|plus|excellente?|célèbre|celebre|populaire|mythique|culte|incontournable|géniale?|geniale?|formidable|sublime|fameuse|fameux|regrettée?|grande?|petite?|nouvel|nouveau|nouvelle|immense|phénomène|phenomene|succès|succes|carton|triomphe|the|its|their|hit|popular|acclaimed|beloved|smash|success|of)";
const SUITE_MARQUE = `(?:\\s+${MOT_INTERCALE}|\\s*(?:l|d)['’]${MOT_INTERCALE}?){0,3}\\s*[«"“]?(\\p{Lu}[\\p{L}\\p{N}!'’.:/-]*(?:\\s+[\\p{L}\\p{N}!'’.:/-]+){0,6})`;
// après un marqueur de comparaison (pas « Après », « Avant ») : aussi les possessifs, d'autres adjectifs,
// et les noms de catégorie (« Comme la série X », « Comme l'anime X », « Dans la lignée du manga X », « le shōnen X »),
// et « pour » (« Comme pour Oshi no Ko, disponible sur ADN depuis le 7 octobre, … »).
const MOT_COMP = "(?:(?:l|d)['’])?(?:le|la|les|un|une|du|des|de|pour|son|sa|ses|leur|leurs|tres|très|plus|excellente?s?|célèbres?|celebres?|populaires?|mythiques?|cultes?|incontournables?|géniale?s?|geniale?s?|géniaux|geniaux|formidables?|sublimes?|fameuse?s?|fameux|regrettée?s?|grande?s?|petite?s?|nouvel|nouveaux?|nouvelles?|immenses?|phénomène|phenomene|succès|succes|carton|triomphe|derniers?|dernières?|dernieres?|premiers?|premières?|premieres?|récente?s?|recente?s?|attendue?s?|incroyables?|magnifiques?|légendaires?|legendaires?|aînée?|ainee?|prédécesseur|predecesseur|séries?|series?|animes?|animé|mangas?|films?|long-métrage|long métrage|shōnen|shonen|seinen|shōjo|shojo|josei|isekai|romans?|light novel|jeux?|franchise|saga|licence|œuvre|oeuvre|adaptation|webtoon|manhwa|the|its|their|this|hit|popular|acclaimed|beloved|smash|fellow|series|anime|show|movie|success|of)";
const SUITE_COMP = `(?:\\s+${MOT_COMP}|\\s*(?:l|d)['’]${MOT_COMP}?){0,4}\\s*[«"“]?(\\p{Lu}[\\p{L}\\p{N}!'’.:/-]*(?:\\s+[\\p{L}\\p{N}!'’.:/-]+){0,6})`;
const MARQUE_COMP = "[Cc]omme|[Àà] l['’]image d(?:e|u|es|['’])|[Àà] l['’]instar d(?:e|u|es|['’])|[Dd]ans la lignée d(?:e|u|es|['’])|[Dd]ans le sillage d(?:e|u|es|['’])|[Ii]nspirée? d(?:e|u|es|['’])|[Ll]ike";
const MARQUE_TEMPS = "[Aa]près|[Aa]vant|[Aa]fter|[Bb]efore";
const COMPARAISON = new RegExp(`(?:^|[\\s,;:(«"“])(?:(?:${MARQUE_COMP})${SUITE_COMP}|(?:${MARQUE_TEMPS})${SUITE_MARQUE})`, "u");
const COMPARAISON_G = new RegExp(COMPARAISON.source, "gu");
// la proposition principale d'une suite commence par la saison (suiteDeLui) ; « de / du / of » : la saison
// d'une autre œuvre (« la suite d'une autre saga ») ; « des » seulement l'article (« dès le » s'écrit « des le »)
const SUITE_EN_TETE = /^(?:(?:et|alors|enfin|desormais|and) )?(?:(?:c est au tour de|place a|voici|retour de|retour pour) )?(?:(?:la|sa|cette|une|the|its|a) )?(?:(?:nouvelle|deuxieme|troisieme|quatrieme|cinquieme|second|third|fourth|fifth|new|tres|tant|si|attendue|esperee|fameuse|highly|anticipated|long|awaited) )*(?:saison(?: \d+)?|season(?: \d+)?|suite|sequel|\d+(?:e|eme|nd|rd|th) (?:saison|season))\b(?! (?:de|d|du|of)\b| des (?!le\b|ce\b|cette\b|maintenant\b|aujourd))/;
const PF_SAISON = /^(?:adn|crunchyroll|netflix|prime video|amazon|disney|hidive|hulu|hbo max|wakanim) (?:[a-z]+ ){1,2}(?:(?:la|sa|the|its) )?(?:(?:nouvelle|new) )?(?:saison|season) \d+\b(?! (?:de|d|du|of)\b| des (?!le\b|ce\b|cette\b|maintenant\b|aujourd))/;
const MARQUE_SEULE = new RegExp(`^[\\s,;:(«"“]?(?:${MARQUE_COMP}|${MARQUE_TEMPS})\\s*[«"“]?$`, "u");
// « Comme Kadokawa l'a annoncé », « Comme Crunchyroll le précise » : un rapport, pas une comparaison
const RAPPORT = /^(?:[a-z0-9]+ ){1,4}?(?:l (?:a|avait|ont|avaient) (?:annonce|confirme|revele|indique|precise|explique|dit|affirme|promis|evoque|devoile|officialise|assure)|l (?:esperait|espere|annoncait|affirmait|affirme|disait|dit|promettait|prevoyait|indiquait|revelait|indique|explique|annonce)|le (?:precise|rapporte|confirme|revele|souligne|dit|disait|prevoyait|laissait entendre|pense|annonce))\b/;
const COMPARAISON_AUTRE = new RegExp(`(?:^|[\\s,;:(«"“])(?:${MARQUE_AUTRE})${SUITE_MARQUE}`, "u");
const SI_PLAIT = /(?:^|[\s,;:(«"“])[Ss]i\s+(?:vous avez aimé\s+)?[«"“]?\p{Lu}[^.,;?]{0,100}?\s(?:vous (?:plaît|plait|a plu|avez plu)|vous a séduite?s?)|[Ii]f you (?:liked|enjoyed|love|loved)\s/u;
// « Si vous avez aimé X, … », « Si vous aimez X », « Si vous êtes fan de X »
const SI_AIME = new RegExp(`(?:^|[\\s,;:(«"“])[Ss]i\\s+vous\\s+(?:avez\\s+(?:aimé|adoré|apprécié)|aimez|adorez|(êtes\\s+fans?\\s+d(?:e|u|es|['’])))${SUITE_COMP}`, "u"); // « la série X » aussi
const MOTS_NON_OEUVRE_LISTE = "adn|crunchyroll|netflix|prime|amazon|disney|hidive|hulu|wakanim|cinema|cinemas|paris|lyon|france|japon|japan|europe|noel|toho|kaze|eurozoom|aniplex|mappa|ufotable|toei|sony|pathe|gaumont|ugc|kana|pika|glenat|kurokawa|ki oon|anime digital network|grand rex|belgique|suisse|luxembourg|monaco|canada|quebec|allemagne|espagne|italie|royaume uni|etats unis|amerique|asie|afrique|tokyo|osaka|kyoto|annecy|halloween|paques|jump festa|anime japan|animejapan|anime expo|japan expo|comic con|paris manga|kadokawa|shueisha|kodansha|shogakukan|square enix|bandai|pony canyon|sunrise|bones|madhouse|wit studio|cloverworks|trigger|science saru|kyoto animation|doga kobo|lerche|shaft|natalie|oricon|ann|dexerto|crunchyroll news|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
// Comparé au nom propre ENTIER qui suit le marqueur (« Tokyo Revengers », « Japan Sinks » sont des œuvres ; « Jump Festa »,
// « Kadokawa », « Crunchyroll » non).
const MOTS_NON_OEUVRE_MOTS = new Set([...MOTS_NON_OEUVRE_LISTE.split("|"), "video", "plus", "news", "animation", "studio", "studios", "pictures", "entertainment", "prime video", "amazon prime", "disney plus", "hbo max", "studio ghibli", "ghibli",
  // (nationalités : « Comme les Japonais, les spectateurs français… »)
  ..."francais francaise francaises japonais japonaise japonaises europeens europeennes americains belges suisses quebecois canadiens allemands espagnols italiens anglais britanniques coreens chinois".split(" ")]);
// Adjectifs anglais et versions : pas dans MOTS_NON_OEUVRE (ils ouvrent le nom d'une autre œuvre : « la VF
// d'Overlord », « the English dub of "Oshi no Ko" », « the Japanese smash hit series, Oshi no Ko, … ») ; seul le nom ENTIER
// « <adjectif(s)> <version / diffusion> » ou « VF » n'est pas une œuvre (« After its Japanese premiere, … », « Like the English
// dub, … », « Comme la VF, la VOSTFR de X… »), avec au plus une date anglaise (« After its Japanese premiere in July, … »).
const ADJ_VERSION = "japanese|english|french|german|spanish|italian|portuguese|european|american|north|south|latin|korean|chinese|british|western|asian";
const VERSION_SEULE = new RegExp(`^(?:(?:${ADJ_VERSION}) ){1,2}(?:premiere|broadcast|version|dub|release|debut|airing|run|simulcast|launch)(?: (?:on|in) (?:january|february|march|april|may|june|july|august|september|october|november|december)(?: \\d{1,2})?(?: \\d{4})?)?$|^(?:vf|vo|vostfr|vost)$`);
// l'année d'un événement ne compte pas (« Japan Expo 2026 », « AnimeJapan 2026 »)
const MOTS_NON_OEUVRE = { has: (run: string) => { const r = run.replace(/(?: (?:19|20)\d\d)+$/, ""); return !!r && (MOTS_NON_OEUVRE_MOTS.has(r) || r.split(" ").every((w) => MOTS_NON_OEUVRE_MOTS.has(w))); } };
const CONNECTEURS = new Set(["no", "x", "de", "du", "des", "la", "le", "les", "of", "the", "and", "to", "in", "on", "wo", "ga", "ni", "na"]);
// Le nom entier « Japanese premiere », « English dub », « VF » n'est pas une œuvre. Le nom en tête n'est pas une œuvre
// (« Crunchyroll », « Kadokawa ») mais un nom propre le suit de près, qui en est une (« Comme Crunchyroll l'a fait pour Oshi no
// Ko ») : c'est encore une comparaison.
function pasUneOeuvre(nom: string): boolean {
  if (VERSION_SEULE.test(norm(nom))) return true;
  const tete = nomEnTete(nom);
  if (!MOTS_NON_OEUVRE.has(tete)) return false;
  const suite = nom.split(/\s+/).slice(tete.split(" ").length, tete.split(" ").length + 4);
  // (aussi après une élision ou une apostrophe : « pour l'Attaque des Titans », « 'Overlord' »)
  return !suite.some((w) => /^[«"“(‘']?(?:[dlDL]['’])?\p{Lu}/u.test(w) && !MOTS_NON_OEUVRE.has(norm(w)));
}
function nomEnTete(s: string): string {
  const out: string[] = [];
  for (const w of s.split(/\s+/)) {
    const nu = w.replace(/^[«"“(]+/, "").replace(/[»”")]+$/, "");
    const mot = nu.replace(/[,;:.!?]+$/, "").replace(/(?<=\p{L})['’]s$/u, ""); // (« Crunchyroll's »)
    if (!mot || !(/^[\p{Lu}\p{N}]/u.test(mot) || (out.length && CONNECTEURS.has(norm(mot))))) break;
    out.push(mot);
    if (mot !== nu) break;
  }
  while (out.length > 1 && CONNECTEURS.has(norm(out[out.length - 1]))) out.pop(); // (« Crunchyroll le précise »)
  return norm(out.join(" "));
}
// « Le film X, suite directe de la série, arrivera sur Crunchyroll… » : l'incise qui suit le titre parle de la série, la
// phrase parle du film. Retirée seulement si le début n'est que le titre complet (après « le film », « l'OVA »…), si
// l'incise ne nomme ni la plateforme ni un mois, et si la suite commence par un verbe, nomme la plateforme et porte la
// date. Sinon la phrase entière.
const PREFIXE_FILM = /^(?:(?:le|ce|son|leur|the|this|its) (?:(?:nouveau|dernier|new|latest) )?(?:film|long metrage|movie|ova|oav|special|clip)|l (?:ova|oav|episode special)) /;
const VERBE_SUITE = /^(?:est|sera|seront|sont|serait|arrive|arrivera|arrivent|arriveront|debarque|debarquera|sort|sortira|sortent|sortiront|rejoint|rejoindra|fera|aura|devrait|va|pourra|reste|restera|is|was|will|arrives|hits|lands|comes|streams|premieres|debuts|has|opens)\b/;
const UN_MOIS = new RegExp(`\\b(?:${"janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december"})\\b`);
function sansIncise(it: AnimeCat, v: Verdict, b: string, n: string, fortDe: (t: string) => boolean): string {
  const pf = v.plateforme;
  const m = /^([^,()]+),([^,()]+),(.+)$/s.exec(b) ?? /^([^,()]+)\(([^()]+)\)(.+)$/s.exec(b);
  if (!pf || !m) return n;
  const debut = norm(m[1]), incise = norm(m[2]), suite = norm(m[3]);
  const titre = debut.replace(PREFIXE_FILM, "");
  if (!it.alias.some((al) => al.complet && al.forme === titre) || !fortDe(debut)) return n;
  if (pf.re.test(" " + incise + " ") || UN_MOIS.test(incise)) return n;
  if (!VERBE_SUITE.test(suite) || !pf.re.test(" " + suite + " ") || (v.date && !dateDansTexte(v.date, suite, m[3]))) return n;
  return `${debut} ${suite}`;
}
// « Après le film sorti au Japon, l'anime arrive sur ADN… » : pour une série, la tête de phrase (avant la première
// virgule) qui ne nomme ni la plateforme ni un mois est retirée si la suite commence par « l'anime », « la série », « la
// saison »…, nomme la plateforme et porte la date. Sinon la phrase entière.
const SUJET_SERIE = /^(?:l anime|la serie|cette serie|cet anime|la saison(?: \d+)?|cette saison|la nouvelle saison|la suite|the series|the anime|the show|the new season|season \d+|saison \d+)\b/;
function sansTete(v: Verdict, b: string, n: string): string {
  const pf = v.plateforme;
  const m = /^([^,()]+),(.+)$/s.exec(b);
  if (!pf || !m) return n;
  const tete = norm(m[1]), suite = norm(m[2]);
  if (pf.re.test(" " + tete + " ") || UN_MOIS.test(tete) || !SUJET_SERIE.test(suite)) return n;
  if (!pf.re.test(" " + suite + " ") || (v.date && !dateDansTexte(v.date, suite, m[2]))) return n;
  return suite;
}
/** Pourquoi la phrase (brute et normalisée) parle d'une autre œuvre que l'anime ; null : rien de tel. */
function autreOeuvre(it: AnimeCat, v: Verdict, brut: string, n: string, nommeIci: boolean, fortDe: (t: string) => boolean): string | null {
  const b = brut.split(GLU).join(" ");
  const cinema = v.plateforme?.nom === "Cinéma";
  const film = estFilm(it);
  // le nom propre qui suit le marqueur est-il l'anime lui-même ? Pour un film, seulement un titre complet
  // (son titre court est celui de la série), sauf pour sa sortie au cinéma ; pour une série, aussi le premier mot d'un de
  // ses titres (« Frieren », « Dandadan ») quand il est seul (le mot suivant n'a pas de majuscule).
  const premiers = new Set([it.title, it.titleEnglish].filter(Boolean).map((t) => norm(t).split(" ")[0]!).filter((w) => w.length >= 5 && !MOTS_VIDES.has(w)));
  // seulement pour « les fans de X », « si vous êtes fan de X » (le public de l'anime) : « Comme X, … »,
  // « Avant X, … », « Si vous avez aimé X, … » parlent d'une autre œuvre que X. Le premier mot d'un titre : écrit seul
  // (pas « Kaguya-hime »), sans autre majuscule après lui (« Tensei shitara Dainana Ouji » n'est pas « Tensei shitara Slime »).
  const lui = (nom: string) => {
    const x = norm(nom);
    if (it.alias.some((al) => (al.complet || !film || cinema) && (x === al.forme || x.startsWith(al.forme + " ")))) return true;
    const mots = nom.split(/\s+/);
    const w = x.split(" ")[0]!;
    const suite: string[] = []; // les mots qui suivent, jusqu'à la ponctuation (« Dandadan vont être ravis : Dan Da Dan… »)
    for (const m of mots.slice(1)) {
      if (/^[:;,.!?»"”)]+$/.test(m)) break;
      suite.push(m);
      if (/[:;,.!?]$/.test(m)) break;
    }
    return !film && premiers.has(w) && norm(mots[0]) === w && !suite.some((m) => /^\p{Lu}/u.test(m) && !MOTS_NON_OEUVRE.has(norm(m)));
  };
  if (SI_PLAIT.test(b)) return "la phrase recommande une autre œuvre (« si … vous plaît »)";
  const si = SI_AIME.exec(b);
  if (si && !pasUneOeuvre(si[2]!) && !(si[1] && lui(si[2]!))) return "la phrase recommande une autre œuvre (« si vous avez aimé … »)";
  // tous les marqueurs de la phrase (un rapport en tête ne cache plus une comparaison plus loin) ; pour une
  // suite (saison 2 ou plus), l'anime lui-même quand la proposition principale (après la virgule) nomme sa saison ou « la
  // suite » : « Après le succès de Frieren, la saison 2 arrive… », « Comme Frieren l'an dernier, la saison 2… ».
  const suiteDeLui = (m: RegExpMatchArray, nom: string) => {
    if (it.saison < 2 || !lui(nom)) return false;
    const apres = b.slice(m.index! + m[0].length - nom.length);
    const k = apres.indexOf(",");
    // (300 caractères au plus : une phrase de 300 000 caractères aux marqueurs répétés resterait linéaire)
    const brutP = k >= 0 ? apres.slice(k + 1, k + 301) : apres.slice(0, 300).split(/\s+/).slice(nomEnTete(nom).split(" ").length).join(" ");
    const principale = norm(brutP);
    // la principale COMMENCE par la saison ou la suite (« la saison 2 arrive… »), ou par la plateforme qui la
    // propose (« Netflix proposera la saison 3… ») : pas « dont la saison 3 arrive en janvier, cette autre série… », ni « la
    // suite d'une autre saga »
    if (!SUITE_EN_TETE.test(principale) && !PF_SAISON.test(principale)) return false;
    // « place à la saison 2 de Blue Lock », « la saison 2 d'Oshi no Ko » : la saison d'une autre œuvre
    // (SUITE_EN_TETE retombe sur « la saison » seule devant « 2 de ») ; pas « de débarquer », « de l'anime »
    if (/\b(?:saisons?|seasons?)\s+\d+\s+(?:(?:de|du|des|of)\s+(?:(?:la|le|les|the)\s+|l['’])?|d['’])[«"“]?[\p{Lu}\p{N}]/u.test(brutP.slice(0, 120))) return false;
    return saisonsCitees(principale).numeros.has(it.saison) || /\b(?:la suite|sa suite|the sequel)\b/.test(principale);
  };
  for (const mc of b.matchAll(COMPARAISON_G)) {
    let nc = (mc[1] ?? mc[2])!;
    // « Like Crunchyroll's own Witch Hat Atelier » : l'œuvre est le nom qui suit le possessif (« Crunchyroll's other
    // simulcasts », « Crunchyroll's announcement at Anime Expo » : pas d'œuvre, ou un nom de MOTS_NON_OEUVRE)
    // (seulement après une plateforme, un studio… : « After Witch Hat Atelier's premiere at Anime Expo » compare avec l'œuvre)
    const poss = /^([\p{Lu}\p{N}][\p{L}\p{N}.:!-]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}.:!-]*)*)['’]s\s+(?:\p{Ll}+\s+){0,3}(\p{Lu}.*)$/u.exec(nc);
    if (poss && MOTS_NON_OEUVRE.has(norm(poss[1]))) nc = poss[2]!;
    // « Comme le manga de Reiji Miyajima », « Inspiré du roman de … » : le nom est celui de l'auteur, pas d'une œuvre
    // sans « film(s) de », « œuvre de » : « les films de Demon Slayer », « le film de Jujutsu Kaisen » sont des œuvres
    if (/(?:mangas?|romans?|light novel|webtoon|manhwa)\s+(?:de|du|d['’])\s*[«"“]?$/u.test(mc[0].slice(0, mc[0].length - nc.length))) continue;
    // un rapport (« Comme Kadokawa l'a confirmé ») : le nom juste après le marqueur (pas « Comme le succès de X le confirme »)
    const direct = MARQUE_SEULE.test(mc[0].slice(0, mc[0].length - nc.length));
    // (pas l'anime lui-même : « Comme Witch Hat Atelier l'a confirmé, la fantasy a la cote : cette autre adaptation… »)
    if (!pasUneOeuvre(nc) && !(direct && RAPPORT.test(norm(nc)) && !lui(nc)) && !suiteDeLui(mc, nc)) return `la phrase compare avec une autre œuvre (« ${coupe(nc, 30)} »)`;
  }
  const ma = COMPARAISON_AUTRE.exec(b);
  if (ma && !pasUneOeuvre(ma[1]!) && !lui(ma[1]!)) return `la phrase compare avec une autre œuvre (« ${coupe(ma[1]!, 30)} »)`;
  if (film) {
    // un épisode spécial, un OAV, un clip : des épisodes eux-mêmes
    const marques = String(it.format || "").toUpperCase() === "MOVIE" ? AUTRE_POUR_FILM : PAS_EPISODES;
    const sans = sansIncise(it, v, b, n, fortDe);
    if (!cinema && (marques.test(sans) || MARQUE_FILM_PLUS.test(sans))) return "la phrase parle aussi d'une autre œuvre (la série ?) : pour un film, seul le cinéma est gardé";
    if (!cinema && HISTOIRE_AVANT.test(sans)) return "la phrase parle aussi de l'histoire d'avant (la série ?) : pour un film, seul le cinéma est gardé";
    if (!cinema && DISTRIBUE.test(n)) return "la phrase parle du distributeur du film : pas de sa plateforme";
    if (!cinema && PF_DISTRIBUE.test(n)) return "la phrase parle du distributeur du film (« Crunchyroll sortira / présente le film ») : pas de sa plateforme";
    if (!cinema && CINE_MOT.test(n)) return "la phrase parle aussi de la sortie au cinéma : pour un film, une plateforme n'est gardée que dans une phrase qui ne parle pas des salles";
    if (cinema && CINE_AUTRE_FILM.test(n)) return "la phrase parle d'un autre film : pas de la sortie du film";
    if (cinema && (CINE_EVENEMENT.test(n) || (n.match(DATES_RUBRIQUE) || []).length > 1) && evenementPresDeLaDate(v, b, n)) return "la phrase parle d'une projection, d'une avant-première ou du Japon : pas de la sortie du film en France";
    if (cinema && marques.test(n) && !nommeIci && !SUJET_FILM.test(n)) return "la phrase parle de la série, pas du film";
  } else if (!nommeIci && AUTRE_POUR_SERIE.test(sansTete(v, b, n))) return "la phrase parle d'un film, pas de la série";
  return null;
}
/**
 * La phrase (normalisée) écrit-elle aussi un titre court de l'anime hors de ses titres complets ? Pour un film : « …
 * prima aurora, suite de la série BanG Dream! Ave Mujica (sur ADN)… » nomme aussi la série, et sa plateforme peut être
 * la sienne. Pas « les fans de Chainsaw Man » : le public de la franchise, pas une autre œuvre.
 */
const FANS = new Set(["fans de", "fans du", "fans des", "fans d", "fans of", "fan de", "fan du", "fan d", "fan of"]);
function courtEnPlus(it: AnimeCat, n: string, fans = true): boolean {
  const mots = n.split(" ");
  const couvert = new Array<boolean>(mots.length).fill(false);
  for (const x of it.alias) {
    if (!x.complet) continue;
    const f = x.forme.split(" ");
    for (let i = indexMots(mots, f, 0); i >= 0; i = indexMots(mots, f, i + 1)) for (let k = i; k < i + f.length; k++) couvert[k] = true;
  }
  return it.alias.some((c) => {
    if (c.complet) return false;
    const f = c.forme.split(" ");
    for (let i = indexMots(mots, f, 0); i >= 0; i = indexMots(mots, f, i + 1)) if (!couvert[i] && !(fans && i >= 2 && FANS.has(`${mots[i - 2]} ${mots[i - 1]}`))) return true;
    return false;
  });
}
// « BanG Dream! Ave Mujica » : l'espace qui suit le « ! » d'un titre devient un gluon (U+2060, sans largeur), pour que la
// vérification (presse.ts, phrase par phrase) ne coupe pas la phrase là ; il redevient une espace dans la phrase gardée.
// Jamais à travers un saut de ligne.
export const GLU = "\u2060";
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function souder(texte: string, animes: AnimeCat[]): string {
  let t = texte;
  const vus = new Set<string>();
  for (const it of animes) {
    for (const titre of [it.titleEnglish, it.title]) {
      const s = String(titre ?? "");
      for (const m of s.matchAll(/[!！]+(?=\s+[^\s!！])/g)) {
        // le titre jusqu'à ce « ! » (depuis son début ou le dernier séparateur) et le mot qui suit, mots entiers
        const avant = s.slice(0, m.index! + m[0].length).split(SEPARATEURS).pop()!.trim();
        const apres = /^\s+([^\s!！:：,;.]+)/.exec(s.slice(m.index! + m[0].length))?.[1];
        if (!avant || !apres || vus.has(`${avant}|${apres}`)) continue;
        vus.add(`${avant}|${apres}`);
        const motif = avant.split(/\s+/).map(echapper).join("(?:[^\\S\\n]|\\u2060)+");
        t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${motif})[^\\S\\n]+(?=${echapper(apres)}(?![\\p{L}\\p{N}]))`, "giu"), `$1${GLU}`);
      }
    }
  }
  return t;
}
/** Les blocs, leurs titres soudés (un bloc tient sur une ligne : le texte est soudé d'un coup). */
function souderBlocs(blocs: Bloc[], animes: AnimeCat[]): Bloc[] {
  if (!blocs.length) return blocs;
  const lignes = souder(blocs.map((b) => b.t).join("\n"), animes).split("\n");
  return lignes.length === blocs.length ? blocs.map((b, i) => (lignes[i] === b.t ? b : { ...b, t: lignes[i]! })) : blocs;
}
/** Les blocs gardés, dans l'ordre de la page, jusqu'à `max` caractères ; entre deux morceaux éloignés, une limite. */
function limiter(blocs: Bloc[], garde: Set<number>, max: number): Bloc[] {
  const out: Bloc[] = [];
  let taille = 0, avant = -1;
  for (const k of [...garde].sort((x, y) => x - y)) {
    taille += blocs[k]!.t.length + 1;
    if (taille > max) break;
    if (avant >= 0 && k !== avant + 1) out.push({ t: "", h: 9 });
    out.push(blocs[k]!);
    avant = k;
  }
  return out;
}
/** Chaque bloc gardé avec l'intertitre sous lequel il se trouve (pour Ollama, et pour savoir de quel anime il parle). */
function avecIntertitres(blocs: Bloc[], garde: Set<number>): Set<number> {
  // (un seul passage : chercher l'intertitre vers l'arrière pour chaque bloc était quadratique)
  const out = new Set(garde);
  let dernier = -1;
  for (let i = 0; i < blocs.length; i++) {
    if (garde.has(i) && dernier >= 0) out.add(dernier);
    if (blocs[i]!.h >= 1 && blocs[i]!.h <= 7) dernier = i;
  }
  return out;
}
/**
 * Article : les lignes qui nomment l'anime et les deux suivantes (une image juste après est passée), sans passer un
 * intertitre ni une limite, avec leur intertitre (6 000 caractères au plus).
 */
function mentions(blocs: Bloc[], nomme: (t: string) => boolean): Bloc[] {
  const garde = new Set<number>();
  blocs.forEach((b, i) => {
    if (b.h >= 8 || !nomme(norm(b.t))) return;
    garde.add(i);
    let n = 0;
    for (let k = i + 1; k < blocs.length && n < 2; k++) {
      if (blocs[k]!.h === 8 && !n) {
        garde.add(k); // (gardée : pas de trou entre l'intertitre et la ligne qui suit)
        continue;
      }
      if (blocs[k]!.h) break;
      garde.add(k);
      n++;
    }
  });
  return limiter(blocs, avecIntertitres(blocs, garde), 6000);
}
// Ce qui peut précéder le titre dans un intertitre consacré à l'anime : une date (calendrier), un numéro, « le film »…
// (comparé avec et sans : « The Too-Perfect Saint », « No Longer Allowed… », « 86 » commencent ainsi).
const MOIS = "janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december";
const ENTETE = new RegExp(`^(?:(?:le )?\\d{1,2}(?:er)? (?:${MOIS})(?: \\d{4})? )?(?:(?:n|no|numero|top) )?(?:\\d{1,3} )?(?:(?:le|la|les|l|un|une|film|anime|serie|saison|the|movie|series|season|gekijouban) ){0,2}`);
// Ce qui peut suivre le titre dans un intertitre consacré à l'anime (entre parenthèses, tout est permis) : une date, la
// plateforme, le format. Pas une phrase (« … : où voir l'histoire avant le film », « … : notre critique »).
const APRES_TITRE = new RegExp(`^(?:\\d{1,4}|1er|${MOIS}|le|la|les|l|du|des|de|d|au|aux|en|sur|a|the|on|in|at|et|and|adn|crunchyroll|netflix|prime|video|amazon|disney|plus|hidive|cinema|salles?|simulcast|streaming|vostfr|vf|tv|anime|film|movie|serie|series|saison|season|ova|special|japon|france)$`);
// Mots de format qui font d'un intertitre celui d'une autre œuvre : un film pour une série, une saison pour un film.
const FORMAT_FILM = /\b(?:film|movie|gekijouban|ova|oav|special|le film|the movie)\b/;
const FORMAT_SERIE = /\b(?:saison|season|serie|series|tv)\b/;
/**
 * Un intertitre (ou titre d'entrée) consacré à l'anime : il commence par l'un de ses titres complets, suivi au plus de
 * quelques mots de date, de plateforme ou de format ; il ne nomme aucun autre anime du catalogue ; ce n'est ni le titre
 * de la page (h1) ni une question ; un film n'y est pas suivi d'une saison ou de « la série », une série pas de « le
 * film », ni d'une autre saison que la sienne. Un intertitre qui n'est qu'un lien vers une autre page doit être ce
 * titre, rien de plus (« … : notre critique du film » est un autre article, glissé dans l'entrée d'un autre anime).
 */
function consacreA(forts: AnimeCat, fort: (t: string) => boolean, autreNomme: (t: string) => boolean, titreN: string): (b: Bloc) => boolean {
  const film = estFilm(forts);
  return (b) => {
    const t = b.t.slice(0, 300);
    if (b.h < 2 || b.h > 7 || t.includes("?")) return false;
    const n = norm(t);
    if (!n || n === titreN || !fort(n) || autreNomme(n)) return false;
    const sans = norm(t.replace(/\([^()]*\)|\[[^[\]]*\]/g, " "));
    for (const [debut, avant] of [[sans, ""], [sans.replace(ENTETE, ""), sans.slice(0, sans.length - sans.replace(ENTETE, "").length)]]) {
      for (const al of forts.alias) {
        if (debut !== al.forme && !debut.startsWith(al.forme + " ")) continue;
        const reste = debut.slice(al.forme.length).split(" ").filter(Boolean);
        if (b.lien && reste.length) continue;
        if (reste.length > 6 || !reste.every((m) => APRES_TITRE.test(m))) continue;
        // ce qui est entre parenthèses compte aussi pour le format et la saison (« X (film) », « X (saison 2) »)
        const entre = norm((t.match(/\([^()]*\)|\[[^[\]]*\]/g) || []).join(" "));
        const autour = `${avant} ${reste.join(" ")} ${entre}`;
        if (film ? FORMAT_SERIE.test(autour) : FORMAT_FILM.test(autour)) continue;
        if (reste.some((m, k) => (m === "saison" || m === "season") && /^\d+$/.test(reste[k + 1] ?? "") && Number(reste[k + 1]) !== forts.saison)) continue;
        if ([...autour.matchAll(/\b(?:saison|season|partie|part|cour)\s+(\d+)\b/g)].some((x) => Number(x[1]) !== forts.saison)) continue;
        // « X 2 » : un numéro seul juste après le titre (pas une date) est une suite
        if (/^\d{1,2}$/.test(reste[0] ?? "") && Number(reste[0]) >= 2 && Number(reste[0]) !== forts.saison && !new RegExp(`^(?:${MOIS}|er)$`).test(reste[1] ?? "")) continue;
        return true;
      }
    }
    return false;
  };
}
/**
 * Page-liste : chaque intertitre (ou titre d'entrée en gras) consacré à l'anime, avec ce qui le suit jusqu'au prochain
 * intertitre, titre d'entrée ou limite (2 500 caractères au plus ; une image juste sous l'intertitre est passée) ; sans
 * intertitre consacré, les seules lignes qui le nomment. 6 000 caractères au plus.
 */
function passagesListe(blocs: Bloc[], dedie: (b: Bloc) => boolean, nomme: (t: string) => boolean): { blocs: Bloc[]; n: number } {
  const garde = new Set<number>();
  let n = 0;
  blocs.forEach((b, i) => {
    if (!dedie(b)) return;
    n++;
    garde.add(i);
    let taille = 0, contenu = false;
    for (let k = i + 1; k < blocs.length; k++) {
      const x = blocs[k]!;
      if (x.h === 8 && !contenu) {
        garde.add(k); // (gardée : pas de trou entre l'intertitre et son entrée)
        continue;
      }
      if (x.h) break;
      taille += x.t.length + 1;
      if (taille > 2500) break;
      garde.add(k);
      contenu = true;
    }
  });
  if (!garde.size) {
    blocs.forEach((b, i) => {
      if (b.h < 8 && nomme(norm(b.t))) {
        garde.add(i);
        n++;
      }
    });
    return { blocs: limiter(blocs, avecIntertitres(blocs, garde), 6000), n };
  }
  return { blocs: limiter(blocs, garde, 6000), n };
}
// Une phrase d'annonce de l'entrée, sans le titre (« Crunchyroll will stream the series as it airs in Japan in North
// America… », « L'anime sera diffusé sur ADN dès le 7 octobre. ») : elle commence par une plateforme, par « l'anime »,
// « la série », « elle » (« le film », « il » pour un film), par « disponible », « diffusé »… ; elle a une date au plus,
// aucun numéro d'une autre saison, et aucun autre mot à majuscule qu'une plateforme, un pays ou une région, un mois, un
// jour, un sigle de format. Pas de question. (« Dans la lignée d'Oshi no Ko… », « Après le succès de l'anime… », « La
// première saison… » n'en sont pas.)
const PLATEFORMES_DEBUT = "adn|crunchyroll|netflix|prime video|amazon prime video|amazon|disney|hidive|hulu|hbo max|wakanim";
const DEBUT_ANNONCE = new RegExp(`^(?:(?:(?:des le|a partir du|starting|from|en exclusivite|exclusivement|en simulcast|en streaming|disponible|diffusee?s?|available|streaming|simulcast) )?(?:sur|on|via|chez) )?(?:${PLATEFORMES_DEBUT})\\b|^(?:disponible|diffusee?s?|available|streaming|en streaming|en simulcast|simulcast)\\b`);
const DEBUT_SERIE = /^(?:l anime|la serie|cette serie|cet anime|la saison|cette saison|la suite|elle|il|the series|the anime|the show|this series|this anime|the new season|it|season \d+|saison \d+)\b/;
// Pour une saison 1, « la suite », « la saison » sans numéro, « cette saison », « the new season » : c'est la suite ; « il »,
// « elle » : seulement dans la première ligne de l'entrée (plus loin, c'est souvent l'auteur) ; ni « il » impersonnel, ni
// un ensemble (« tous ces animes » : la conclusion de la page), ni deux plateformes, ni une autre série ou partie.
const DEBUT_SUITE = /^(?:la saison(?! \d)|cette saison|la suite|the new season)\b/;
const PRONOM = /^(?:elle|il|it)\b/;
const JOURS_FR = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";
const TETE_DATE = new RegExp(`^(?:(?:des le|des|a partir du|a compter du|le|du) (?:\\d{1,2}(?:er)?|1er)(?: (?:${MOIS}))?(?: \\d{4})? |chaque (?:${JOURS_FR}|semaine) |tous les (?:${JOURS_FR})s? |(?:starting|from|beginning) (?:on )?(?:${MOIS}) \\d{1,2}(?: \\d{4})? |every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week) )+`);
const IL_IMPERSONNEL = /^(?:il (?:ne vous reste|vous reste|reste|faut|faudra|y a|y aura|est temps|est possible|suffit|s agit)|it s time|it is time)\b/;
// un ensemble (la conclusion d'une liste), une autre œuvre sans titre
const ENSEMBLE = /\b(?:ces (?:animes?|series|titres|nouveautes|films|simulcasts|oeuvres|programmes)|tous ces|toutes ces|plusieurs (?:de ces )?(?:titres|animes|series)|le reste|d autres (?:titres|animes|series)|all (?:of )?(?:these|them|the)|these (?:titles|shows|series|anime)|the following|other titles|the rest|precedente?s? series?|autres? series?|nouvelle serie|serie derivee|spin off|previous series|another series|other series)\b/;
// pour une saison 1, la suite dite autrement (« L'anime reviendra… avec de nouveaux épisodes », « aura
// droit à une suite », « second cycle », « saison finale ») ; « il / elle » qui parle d'une autre œuvre (l'auteur, le
// réalisateur : « Il a déjà signé une série disponible sur Netflix ») ; après une date en tête, une plateforme en tête de
// phrase doit parler de l'anime (« Le 7 janvier, Netflix lancera aussi sa grosse nouveauté » n'en parle pas).
// Sans « nouveaux épisodes », « new episodes » (les épisodes de la semaine : « avec de nouveaux épisodes
// chaque mardi », « with new episodes every Tuesday ») ; « il / elle » : l'autre œuvre ou l'auteur AVANT la plateforme
// (« Il a déjà signé une série disponible sur Netflix », « Il travaille aussi pour Netflix ») — pas « Elle sera diffusée
// sur ADN, comme les autres simulcasts » ; après une date en tête, la plateforme SUJET (« Le 7 janvier, Netflix lancera… »),
// pas « Dès le 7 octobre sur ADN » ; « les épisodes de sa nouveauté », « Netflix lancera aussi… » ne parlent pas de lui.
const SUITE_S1 = /\b(?:revient|reviendra|reviennent|reviendront|retour|une suite|sa suite|la suite de|nouvelle saison|saison suivante|prochaine saison|saison finale|derniere saison|second cycle|seconde moitie|second cour|seconde partie|deuxieme partie|partie 2|part 2|cour 2|returns?|returning|sequel|next season|final season|second half|new season)\b/;
// « de nouveaux épisodes dès le 7 janvier » (saison 1) : la suite ; pas « chaque mardi », « every Tuesday »
const NOUVEAUX_EPISODES = /\b(?:nouveaux episodes|new episodes)\b(?!(?: [a-z0-9]+){0,3} (?:chaque|tous|toutes|every|each|weekly|hebdomadaires?|semaine|week|lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b)/;
// « il / elle » : le pronom suivi d'un verbe de sortie (« Il développe aussi un projet pour Netflix… », « Elle a
// lancé… » : la personne)
// « It's » et « It'll » (= « it is », « it will », déjà acceptés), « It joins », « Elle fera ses débuts »
const PRONOM_SORTIE = /^(?:(?:elle|il|it) (?:(?:aussi|egalement|enfin|deja|desormais|bientot|also|now|finally|soon) )*(?:sera|seront|est|arrivera|arrive|debarquera|debarque|reviendra|commencera|commence|demarrera|demarre|debutera|debute|sortira|sort|rejoindra|rejoint|fera son arrivee|fera ses debuts|aura droit|streams?|will|is|arrives|premieres|debuts|lands|hits|returns|joins)|it (?:s|ll))\b/;
// + la personne avec « sera / est » (« Il sera aussi aux commandes d'un projet pour Netflix », « Il est aussi
// derrière un projet… », « Elle sera aussi la scénariste d'un projet Netflix »)
const AUTRE_OEUVRE_PRONOM = /\b(?:series?|films?|mangas?|romans?|oeuvres?|adaptations?|autres?|precedente?s?|signe|realise|ecrit|dessine|travaille|publie|prepare|dirige|projets?|projects?|commandes|derriere|realisateur|realisatrice|scenariste|auteur|autrice|mangaka|compositeur|compositrice|director|writer|creator)\b/;
const UNE_PLATEFORME = /\b(?:adn|crunchyroll|netflix|prime video|amazon|disney|hidive|hulu|hbo max|wakanim)\b/;
const DEBUT_PLATEFORME = new RegExp(`^(?:${"adn|crunchyroll|netflix|prime video|amazon prime video|amazon|disney|hidive|hulu|hbo max|wakanim"})\\b`);
// « cette / cet » + un nom d'œuvre (liste fermée, un adjectif permis : pas « cette rentrée », « à cette occasion »)
const PARLE_DE_LUI = /\b(?:l anime|la serie|le film|cette serie|cet anime|ce film|l adaptation|cette adaptation|it|the series|the anime|the show|the film|the movie)\b|\bepisodes?\b(?! (?:de|d|du|des|of)\b)|\b(?:cette|cet) (?:[a-z]+ )?(?:comedie|romcom|rom com|nouveaute|production|oeuvre|histoire|aventure|romance|fantasy|creation|pepite|perle|saga|franchise|isekai|epopee|tranche de vie|nouvelle serie|nouvelle adaptation)\b|\b(?:le|la|l|les) (?:diffuse|diffusera|diffuseront|propose|proposera|proposeront|aura|mettra|lancera|ajoutera|offrira|accueillera|accueille)\b/;
// « Dès le 7 octobre sur ADN, chaque mardi à 17 h » : une ligne de diffusion (pas « Le 7 janvier sur Netflix : la grosse nouveauté… »)
const SUR_PLATEFORME = /^(?:sur|on|via|chez) (?:adn|crunchyroll|netflix|prime video|amazon prime video|amazon|disney plus|disney|hidive|hulu|hbo max|wakanim)\b/;
const MOTS_DISPO = new Set(`chaque tous les toutes semaine semaines jour jours lundi mardi mercredi jeudi vendredi samedi dimanche lundis mardis mercredis jeudis vendredis samedis dimanches
  a h heure heures heure de paris en simulcast vostfr vf vo et puis des le la l du au aux partir compter premium abonnes france europe belgique suisse luxembourg monaco canada quebec
  janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre january february march april may june july august september october november december
  every week weekly on in at and from starting the pm am new episode episodes nouvel nouveaux episode episodes streaming`.split(/\s+/).filter(Boolean));
const PLATEFORME_AUSSI = /^[a-z]+(?: video| plus| max)? (?!(?:le|la|l|les) )[a-z]+ (?:aussi|egalement|also)\b/;
const DEBUT_FILM = /^(?:le film|ce film|le long metrage|ce long metrage|the film|the movie|this film|it|il)\b/;
const MOTS_ANNONCE = new Set(`crunchyroll adn animation digital network netflix prime video amazon disney hidive hulu hbo max wakanim
  france francais francaise belgique suisse luxembourg monaco canada quebec europe european europeen europeenne japon japan japanese japonais japonaise
  amerique america americas north south central latin latine nord sud africa afrique oceania oceanie asia asie southeast middle east moyen orient cis
  india inde uk united kingdom royaume uni australia australie new zealand nouvelle zelande ireland irlande germany allemagne spain espagne italy italie
  portugal brazil bresil mexico mexique us usa states etats unis emea apac latam
  janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre january february march april may june july august september
  october november december lundi mardi mercredi jeudi vendredi samedi dimanche monday tuesday wednesday thursday friday saturday sunday
  vostfr vf vo vost tv simulcast dub sub pt et cet cest jst utc gmt am pm saison season part partie cour episode episodes ep
  paris heure premium mega fan french english german spanish italian portuguese arabic russian hindi`.split(/\s+/).filter(Boolean));
// Une autre partie de la saison (« la seconde partie dès le 10 janvier », « la partie 2 de la saison 3 ») :
// sa date n'est pas celle de l'anime, sauf si l'anime est cette partie (« X Season 3 Part 2 »)
const PARTIE_N = /\b(?:(?:partie|part|cour) (\d)|(second cour|seconde partie|deuxieme partie|second half|seconde moitie|second part|2nd cour|2nd part))\b/;
function numeroPartie(it: AnimeCat): number {
  for (const t of [it.titleEnglish, it.title]) {
    const m = /\b(?:part|partie|cour)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+(?:part|cour)\b/.exec(norm(t));
    if (m) return Number(m[1] ?? m[2]);
  }
  return 1;
}
function annonceSansTitre(p: string, film: boolean, saison: number, premiere = true, partie = 1): boolean {
  if (p.length < 20 || p.includes("?")) return false;
  const n0 = norm(p);
  // la date ou le jour en tête (« Dès le 7 octobre, l'anime… », « Chaque mardi, ADN… ») est passé
  const n = n0.replace(TETE_DATE, "");
  if (!DEBUT_ANNONCE.test(n) && !(film ? DEBUT_FILM : DEBUT_SERIE).test(n)) return false;
  if (!film && saison <= 1 && (DEBUT_SUITE.test(n) || SUITE_S1.test(n) || NOUVEAUX_EPISODES.test(n))) return false;
  const avantPf = n.slice(0, Math.max(0, n.search(UNE_PLATEFORME))) || n;
  if (IL_IMPERSONNEL.test(n) || (PRONOM.test(n) && (!premiere || !PRONOM_SORTIE.test(n) || AUTRE_OEUVRE_PRONOM.test(avantPf)))) return false;
  if (n !== n0 && DEBUT_PLATEFORME.test(n) && (!PARLE_DE_LUI.test(n) || PLATEFORME_AUSSI.test(n))) return false;
  if (n !== n0 && SUR_PLATEFORME.test(n) && !PARLE_DE_LUI.test(n) && !n.replace(SUR_PLATEFORME, "").split(" ").filter(Boolean).every((w) => MOTS_DISPO.has(w) || /^\d+$/.test(w))) return false;
  if (ENSEMBLE.test(n) || PLATEFORMES.filter((x) => x.nom !== "Cinéma" && x.re.test(" " + n + " ")).length > 1) return false;
  const propDate = norm(p.split(/[,;:]|\s(?:et|puis|avant|après|apres|mais)\s/).find((x) => UNE_DATE_RUBRIQUE.test(norm(x))) ?? "");
  const pa = PARTIE_N.exec(propDate);
  if (pa && (pa[1] ? Number(pa[1]) : 2) !== partie && (pa[1] ? Number(pa[1]) : 2) >= 2) return false;
  if ((n0.match(DATES_RUBRIQUE) || []).length > 1 || [...saisonsExplicites(n0)].some((x) => x !== saison)) return false;
  const debut = p.search(/[\p{L}\p{N}]/u);
  for (const m of p.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*/gu)) if (m.index !== debut && !MOTS_ANNONCE.has(norm(m[0]))) return false;
  return true;
}
/**
 * L'entrée de l'anime, sous chaque intertitre qui lui est consacré (une image juste dessous est passée) :
 *   - ses rubriques de diffusion (« Date de sortie : … », « Diffusion : … », « Plateforme : … », « Où le voir ? Sur … »),
 *     la première phrase de chacune (la réponse, après une question) ; une rubrique qui donne deux dates (une
 *     avant-première, le Japon) n'en est pas ; les autres lignes « Libellé : valeur » (« Studio », « Auteur »,
 *     « Distributeur ») sont passées sans rien lui donner ;
 *   - avant toute rubrique, deux lignes de texte au plus (le synopsis), et dans celles-ci les seules phrases d'annonce
 *     sans le titre (annonceSansTitre).
 * L'entrée s'arrête à une ligne de texte après une rubrique, à une limite, à la même sorte de rubrique une seconde fois
 * (c'est déjà l'entrée suivante, dont le titre n'a pas été vu) ; 10 lignes au plus. Sur une page lue par passages,
 * seules ces phrases peuvent annoncer l'anime sans le nommer.
 */
const SEPARATEUR = /^(?:•\s*)?[^:：?\n]{2,40}?\s*([:：?])/u;
function entreeDe(blocs: Bloc[], dedie: (b: Bloc) => boolean, film: boolean, saison: number, partie = 1): Set<string> {
  const out = new Set<string>();
  blocs.forEach((b, i) => {
    if (!dedie(b)) return;
    const vues = new Set<string>();
    let lignes = 0, taille = 0, textes = 0, rubriques = 0;
    for (let k = i + 1; k < blocs.length && lignes < 10; k++) {
      const x = blocs[k]!;
      if (x.h === 8 && !lignes) continue;
      if (x.h) break;
      taille += x.t.length;
      if (taille > 2000) break;
      lignes++;
      const lab = libelle(x.t);
      if (!lab) {
        if (rubriques || ++textes > 2) break;
        for (const p of decouperPhrases(x.t).slice(0, 4)) if (annonceSansTitre(p, film, saison, textes === 1, partie)) out.add(norm(p));
        continue;
      }
      rubriques++;
      const sorte = sorteRubrique(lab, film);
      if (!sorte) continue; // une autre rubrique (« Studio : … ») : passée
      if (vues.has(sorte)) break;
      vues.add(sorte);
      const ps = decouperPhrases(x.t);
      const p = SEPARATEUR.exec(x.t)?.[1] === "?" ? ps[1] : ps[0];
      if (p && (norm(p).match(DATES_RUBRIQUE) || []).length <= 1) out.add(norm(p));
    }
  });
  return out;
}
// Dates d'une rubrique (texte normalisé) : « 16 octobre », « 16 10 2026 », « october 16 ».
const DATES_RUBRIQUE = new RegExp(`\\b\\d{1,2}(?: ?er)? (?:${"janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre"})\\b|\\b(?:${"january|february|march|april|may|june|july|august|september|october|november|december"}) \\d{1,2}\\b|\\b\\d{1,2} \\d{1,2} \\d{4}\\b`, "g");
const UNE_DATE_RUBRIQUE = new RegExp(DATES_RUBRIQUE.source); // (sans « g » : test() sans état)
/**
 * Nombre d'autres animes du catalogue vraiment nommés (nommePar) dans des intertitres ou des titres d'entrées suivis d'un
 * texte (une carte d'article nue n'est pas une entrée), compté jusqu'à 3 : une page-liste.
 */
function entrees(blocs: Bloc[], quiNomme: (n: string) => number[], id: number): number {
  const vus = new Set<number>();
  blocs.forEach((b, i) => {
    if (vus.size >= 3 || b.h < 1 || b.h > 7) return;
    let k = i + 1;
    while (k < blocs.length && blocs[k]!.h === 8) k++;
    if (k >= blocs.length || blocs[k]!.h || blocs[k]!.t.length < 20) return;
    for (const x of quiNomme(norm(b.t.slice(0, 200)))) if (x !== id) vus.add(x);
  });
  return Math.min(3, vus.size);
}
/**
 * L'anime tel qu'il est cherché dans ce texte, les animes du catalogue que le texte nomme, et les règles : « nomme
 * l'anime » (tout titre), « le nomme par un titre complet » (fort), « consacré à l'anime » (intertitre), « nomme un
 * autre anime », et « le titre de la page ne nomme que lui » (un article sur lui, pas une liste).
 */
function preparer(anime: AnimeCat, cat: AnimeCat[], texte: string, titre: string) {
  const idx = indexFormes(cat);
  const ids = nommes(norm(texte), idx);
  const vise = sansTitresDautrui(viser(anime, texte), cat);
  // seuls les animes que le texte nomme peuvent y être cités : le reste du catalogue n'est pas relu (pages de 3 Mo)
  const catF = [vise, ...cat.filter((x) => x.id !== anime.id && ids.has(x.id))];
  const parId = new Map(catF.map((x) => [x.id, x]));
  const regles = new Map<number, (t: string) => boolean>();
  const nommeDe = (it: AnimeCat) => {
    let f = regles.get(it.id);
    if (!f) regles.set(it.id, (f = nommePar(it.id === anime.id ? vise : it, catF, texte)));
    return f;
  };
  const forts = new Map<number, (t: string) => boolean>();
  const fortDe = (it: AnimeCat) => {
    let f = forts.get(it.id);
    if (!f) forts.set(it.id, (f = nommeFortPar(it.id === anime.id ? vise : viser(it, texte), catF, texte)));
    return f;
  };
  const fort = fortDe(vise);
  const autreNomme = (n: string) => [...nommes(n, idx)].some((id) => id !== anime.id && parId.has(id) && nommeDe(parId.get(id)!)(n));
  // les animes du catalogue que la phrase nomme vraiment (nommePar), l'anime cherché compris
  const quiNomme = (n: string) => [...nommes(n, idx)].filter((id) => parId.has(id) && nommeDe(parId.get(id)!)(n));
  const titreN = norm(titre);
  return {
    vise, catF, idx, nommeDe, fortDe, fort, autreNomme, quiNomme,
    nomme: nommeDe(vise),
    dedie: consacreA(titresComplets(vise), fort, autreNomme, titreN),
    seulAuTitre: fort(titreN) && !autreNomme(titreN),
  };
}
/**
 * Page-liste : 3 autres animes du catalogue nommés dans des intertitres (même si le titre de la page ne nomme que
 * l'anime : « Le film X en tête des sorties d'octobre »), ou un texte très long dont le titre ne nomme pas que l'anime.
 */
const estListe = (p: ReturnType<typeof preparer>, blocs: Bloc[], longueur: number, id: number) =>
  entrees(blocs, p.quiNomme, id) >= 3 || (!p.seulAuTitre && longueur > TEXTE_LONG);
/**
 * Le texte de Tavily d'une page retenue, réduit à ce qui en sera lu : sur une page-liste, les passages de l'anime
 * cherché ; sinon les lignes qui le nomment et les deux suivantes.
 */
export function reduireBrut(r: Resultat, anime: AnimeCat, cat: AnimeCat[]): { blocs: Bloc[]; liste: boolean } {
  // (l'intertitre qui répète le titre de l'article est retiré : la vérification y trouverait la phrase citée)
  const bruts = blocsMarkdown(r.brut ?? "", r.titre).filter((x) => !(x.h && norm(x.t) === norm(r.titre)));
  const texte = [r.titre, ...bruts.map((b) => b.t)].join("\n");
  const p = preparer(anime, cat, texte, r.titre);
  const tous = decouperBlocs(souderBlocs(bruts, p.catF));
  const liste = estListe(p, tous, texte.length, anime.id);
  return { blocs: liste ? passagesListe(tous, p.dedie, p.nomme).blocs : mentions(tous, p.nomme), liste };
}

/** La langue d'après l'adresse (« /fr/ ») ou le site, sans la page (texte de Tavily : la coquille ne dit pas sa langue à lui). */
const langueAdresse = (url: string, d: Domaine): Article["langue"] => (/\/fr(?:[/-]|$)/i.test(new URL(url).pathname) ? "fr" : d.langue ?? (/\.fr$/.test(d.domaine) ? "fr" : "en"));
/**
 * L'article d'une page : texte (JSON-LD articleBody, sinon paragraphes), titre, date de publication, langue.
 * Page sans texte lisible chez nous (Crunchyroll News, dessinée par le navigateur) : le texte que Tavily en a lu, déjà
 * réduit (r.blocs, reduireBrut), le titre que donne Tavily (celui de la coquille est souvent celui de l'accueil du site),
 * la langue de l'adresse, et la date de la page ou, à défaut, celle de son adresse.
 * Date : celle de la page (la date de Tavily n'est qu'une estimation, parfois plus récente que la vraie).
 */
export function articleDePage(
  page: string,
  url: string,
  d: Domaine,
  r?: Resultat,
): { article?: Article; raison?: string; origine?: "page" | "tavily"; blocs?: () => Bloc[]; liste?: boolean } {
  const html = balisesSaines(page);
  let langue = langueDe(html, url, d);
  if (!langue) return { raison: "page dans une autre langue que le français, l'anglais ou l'espagnol" };
  const jl = articleJsonLd(html);
  const lu = lireArticle(html);
  // (un texte de plus d'un million de caractères, JSON-LD d'un seul tenant, est coupé là : sa lecture bloquerait l'API)
  let texte = lu.texte.length > TEXTE_MAX ? lu.texte.slice(0, TEXTE_MAX) : lu.texte;
  let titre = (jl?.titre || meta(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || meta(html, /<title[^>]*>([^<]*)<\/title>/i) || r?.titre || "").trim();
  let origine: "page" | "tavily" = "page";
  let blocs = () => blocsDe(lu.zone() ?? "");
  if (texte.length < 200) {
    const b = r?.blocs ?? [];
    const tb = sansRenvois(b.filter((x) => x.h < 8).map((x) => x.t).join("\n"));
    if (tb.length < 30) return { raison: r?.blocs === undefined ? "pas de texte d'article lisible" : "pas de texte d'article lisible (et le texte lu par Tavily ne nomme pas l'anime)" };
    texte = tb;
    titre = (r?.titre || titre).trim();
    langue = langueAdresse(url, d);
    origine = "tavily";
    blocs = () => b;
  }
  const publie = datePublication(html) ?? (origine === "tavily" ? dateDansAdresse(url) : null);
  if (!publie) return { raison: "date de publication introuvable" };
  return { article: { url, source: coupe(d.nom, 20), langue, titre, texte, publie, officielle: d.officiel }, origine, blocs, liste: origine === "tavily" ? !!r?.liste : undefined };
}

export interface Lecture {
  a: Article; // ce qu'Ollama lit : l'article, ou les passages de l'anime cherché
  cites: Cite[]; // l'anime cherché d'abord (seul, sur une page lue par passages)
  ids: number[]; // animes pour lesquels la page compte comme lue
  mode: string; // comment la page a été lue (vide : article entier)
  controle: (v: Verdict) => Verdict; // contrôles de plus sur les annonces (attribution, page lue par passages)
}
/** Les premiers blocs, jusqu'à `max` caractères (le texte de la page est coupé de même). */
function jusquA(blocs: Bloc[], max: number): Bloc[] {
  let taille = 0;
  const k = blocs.findIndex((b) => (taille += b.t.length + 1) > max);
  return k < 0 ? blocs : blocs.slice(0, k);
}
/** Les phrases de l'article, comme les découpe la vérification (presse.ts : verifier), avec leur forme normalisée. */
const phrasesDe = (a: Article) =>
  (a.titre + "\n" + a.texte).split("\n").flatMap((l) => decouperPhrases(l)).map((brut) => ({ brut, n: norm(brut) })).filter((p) => p.n);
/**
 * Ce qu'Ollama lit d'une page, pour l'anime cherché :
 *   - texte de Tavily : ce qu'en a gardé reduireBrut ;
 *   - page-liste (3 autres animes du catalogue nommés dans des intertitres ou des titres d'entrées, ou texte de plus de
 *     60 000 caractères ; jamais une page dont le titre ne nomme que l'anime) : les passages de l'anime (intertitre
 *     consacré à lui et sa suite), ou ses seules lignes ;
 *   - sinon l'article entier.
 * L'anime cherché est toujours le premier cité, et le seul sur une page lue par passages. Ses titres courts qui sont le
 * titre complet d'un autre anime du catalogue ne le désignent pas.
 * Contrôles des annonces (en plus de presse.ts : verifier) :
 *   - page lue par passages (page-liste, texte de Tavily) : la phrase citée nomme l'anime par un titre complet, ou est
 *     dans son entrée (entreeDe) ; elle ne nomme aucun autre anime, et la plateforme y est écrite ;
 *   - article entier : la phrase qui fait attribuer l'annonce nomme vraiment l'anime (attribution).
 */
export function lecture(a0: Article, origine: "page" | "tavily", blocs: () => Bloc[], anime: AnimeCat, cat: AnimeCat[], listeTavily = false): Lecture | { raison: string } {
  const texte0 = `${a0.titre}\n${a0.texte}`;
  const p = preparer(anime, cat, texte0, a0.titre);
  const { vise, catF, nomme } = p;
  let a = a0;
  let mode = "";
  let parPassages: Bloc[] | null = null; // les blocs lus, sur une page lue par passages
  if (origine === "tavily") {
    const bs = souderBlocs(blocs(), catF);
    const lus = bs.filter((b) => b.h < 8);
    if (!lus.some((b) => nomme(norm(b.t)))) return { raison: "texte lu par Tavily : l'anime n'y est pas nommé" };
    a = { ...a0, texte: sansRenvois(lus.map((b) => b.t).join("\n")) };
    mode = `page sans texte chez nous : texte lu par Tavily${listeTavily ? " (page-liste)" : ""}, ${lus.length} ligne${lus.length > 1 ? "s" : ""} sur l'anime`;
    parPassages = bs;
  } else {
    const bl = decouperBlocs(souderBlocs(jusquA(blocs(), TEXTE_MAX), catF));
    if (estListe(p, bl, a0.texte.length, anime.id)) {
      const base = bl.length ? bl : decouperBlocs(souderBlocs(a0.texte.split("\n").map((t) => ({ t, h: 0 })), catF));
      const s = passagesListe(base, p.dedie, nomme);
      const lus = s.blocs.filter((b) => b.h < 8);
      if (!lus.length) return { raison: "page-liste : l'anime n'y est pas nommé" };
      a = { ...a0, texte: sansRenvois(lus.map((b) => b.t).join("\n")) };
      mode = `page-liste : ${s.n} passage${s.n > 1 ? "s" : ""} sur l'anime (${a.texte.length} car.)`;
      parPassages = base;
    } else if (a0.texte.length > TEXTE_ARTICLE) a = { ...a0, texte: a0.texte.slice(0, TEXTE_ARTICLE) };
  }
  let cites = animesCites(a, catF);
  let lui = cites.find((x) => x.it.id === anime.id);
  if (!lui) {
    const seul = animesCites(a, [vise])[0];
    if (parPassages) {
      if (seul) lui = seul;
      else {
        const corps = norm(a.titre + "\n" + a.texte);
        const al = vise.alias.filter((x) => contient(corps, x.forme)).sort((x, y) => Number(y.complet) - Number(x.complet) || y.forme.length - x.forme.length)[0];
        if (al) lui = { it: vise, forme: al.forme, complet: al.complet };
      }
    } else {
      // L'anime cherché est cité même si l'article en cite d'autres, sauf si son titre court n'est qu'une partie du
      // titre complet d'un autre anime cité.
      const couvert = !!seul && !seul.complet && cites.some((x) => x.complet && x.forme.includes(seul.forme));
      if (seul && !couvert) lui = seul;
    }
  }
  if (!lui) return { raison: "l'anime n'y est pas cité franchement" };
  cites = parPassages ? [lui] : [lui, ...cites.filter((x) => x.it.id !== anime.id)].slice(0, 4);
  a = { ...a, titre: souder(a.titre, cites.map((x) => x.it)), texte: souder(a.texte, cites.map((x) => x.it)) };
  const final = a;
  if (!parPassages) return { a: final, cites, mode, ids: cites.map((x) => x.it.id), controle: (v) => attribution(v, final, p) };
  const entree = entreeDe(parPassages, p.dedie, estFilm(vise), vise.saison, numeroPartie(vise));
  // les phrases placées sous l'intertitre d'un autre anime du catalogue (qui ne nomme pas celui-ci) : son entrée à lui
  const ailleurs = new Set<string>();
  let sous: string | null = null;
  // le titre de la page (le premier h1, ou un h1 de tête qui reprend le titre : titresDePage) est passé ; les autres h1
  // sont des entrées (texte de Tavily, page à un <h1> par entrée)
  const titresH1 = titresDePage(parPassages, a0.titre);
  for (const [i, b] of parPassages.entries()) {
    if (b.h >= 1 && b.h <= 7) {
      const n = norm(b.t.slice(0, 300));
      sous = (b.h >= 2 || !titresH1.has(i)) && p.autreNomme(n) && !nomme(n) ? n : null;
    } else if (!b.h && sous) for (const x of decouperPhrases(b.t)) ailleurs.add(norm(x));
  }
  for (const x of entree) ailleurs.delete(x); // (la même ligne dans l'entrée de l'anime : la sienne)
  if (entree.size) mode += ` ; entrée de l'anime : ${entree.size} phrase${entree.size > 1 ? "s" : ""}`;
  const quoi = origine === "tavily" ? "texte lu par Tavily" : "page lue par passages";
  return {
    a: final, cites, mode, ids: [anime.id],
    controle: (v: Verdict) => {
      if (v.statut !== "garde" || !v.anime) return v;
      const rejet = (raison: string): Verdict => ({ ...v, statut: "rejete", raison: `${quoi} : ${raison}` });
      if (v.anime.id !== anime.id) return rejet("annonce d'un autre anime");
      if (v.notes.some((x) => x.includes("nommé dans une phrase précédente"))) return rejet("la plateforme n'est pas dans la phrase citée");
      const ph = phrasesDe(final);
      const i = ph.findIndex((x) => coupe(x.brut, 250) === v.phrase);
      if (i < 0) return rejet("phrase citée introuvable");
      const n = ph[i]!.n;
      if (p.autreNomme(n)) return rejet("la phrase nomme aussi un autre anime");
      if (ailleurs.has(n)) return rejet("la phrase est dans l'entrée d'un autre anime");
      if (estFilm(vise) && courtEnPlus(vise, n, v.plateforme?.nom === "Cinéma")) return rejet("la phrase nomme aussi le titre court du film (la série ?)");
      const fort = p.fort(n);
      if (!fort) {
        if (!entree.has(n)) return rejet("la phrase ne nomme pas l'anime par son titre et n'est pas dans son entrée");
        if (estFilm(vise) && nomme(n)) return rejet("la phrase ne nomme le film que par son titre court (la série ou la franchise ?)");
      }
      const autre = autreOeuvre(vise, v, ph[i]!.brut, n, fort, p.fort);
      return autre ? rejet(autre) : v;
    },
  };
}
/**
 * Article entier : la phrase qui a fait attribuer l'annonce doit nommer l'anime vraiment. C'est la phrase citée si elle
 * le nomme ; sinon, la plus proche des 4 d'avant qui nomme un anime du catalogue, et ce doit être lui ; sinon le titre de
 * l'article, comme presse.ts (verifier). Pas seulement dans le titre plus long d'un autre anime (nommePar). Pour un film,
 * par un titre complet : son titre court est celui de la série, et une phrase qui l'écrit aussi parle de la série. La
 * phrase citée ne doit pas parler d'une autre œuvre (autreOeuvre).
 */
function attribution(v: Verdict, a: Article, p: ReturnType<typeof preparer>): Verdict {
  if (v.statut !== "garde" || !v.anime) return v;
  const it = v.anime;
  const ph = phrasesDe(a);
  const i = ph.findIndex((x) => coupe(x.brut, 250) === v.phrase);
  if (i < 0) return v;
  const film = estFilm(it);
  const rejet = (raison: string): Verdict => ({ ...v, statut: "rejete", raison });
  const juge = (n: string): Verdict => {
    if (!p.nommeDe(it)(n)) return rejet("l'anime n'y est nommé que dans le titre plus long d'un autre anime");
    if (film && !p.fortDe(it)(n)) return rejet("le film n'y est nommé que par son titre court (la série ou la franchise ?)");
    if (film && courtEnPlus(it, n, v.plateforme?.nom === "Cinéma")) return rejet("la phrase nomme aussi le titre court du film (la série ?)");
    return v;
  };
  const ici = ph[i]!.n;
  const nommeIci = it.alias.some((al) => contient(ici, al.forme));
  const autre = autreOeuvre(it, v, ph[i]!.brut, ici, nommeIci && p.nommeDe(it)(ici), p.fortDe(it));
  if (autre) return rejet(autre);
  if (nommeIci) return juge(ici);
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    const n = ph[k]!.n;
    if (it.alias.some((al) => contient(n, al.forme))) return juge(n);
    // la plus proche qui nomme un anime du catalogue en nomme un autre : l'annonce est peut-être la sienne
    if (p.quiNomme(n).some((id) => id !== it.id)) return rejet("les phrases d'avant parlent d'un autre anime");
  }
  return juge(norm(a.titre));
}

// ─────────────────────────────────────────────────────────────── traitement d'une recherche
export interface Page {
  url: string;
  source: string;
  publie: string | null;
  etat: "lu" | "deja_lu" | "interdit" | "erreur" | "hors_sujet" | "non_envoye" | "annonces" | "sans_annonce" | "illisible";
  note: string;
  lecture?: string; // page lue autrement qu'en entier : texte de Tavily, page-liste (lecture)
  verdicts: Verdict[];
  ms: number;
}
export interface Traitement {
  cible: Cible;
  rechercheId: number | null;
  recherche: Recherche | null; // null : pages reprises d'une recherche précédente
  retenus: Resultat[];
  pages: Page[];
  gardees: Verdict[]; // annonces gardées (tous animes cités)
  trouve: string[]; // pour l'anime cherché : nos plateformes annoncées (avec la date s'il y en a une)
  dateTrouvee: boolean;
  ollama: number; // articles envoyés à Ollama
  arret?: string; // Ollama tombé : les pages seront reprises
  extract?: { pages: number; lues: number; credits: number; note?: string }; // Tavily Extract pour les pages sans texte
  stop?: { message: string; portee: TavilyErreur["portee"] }; // Tavily Extract refusé (clé, forfait) : plus de recherche ce passage
}

const versDatetime = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace("T", " ") : null;
};
/**
 * Note une page lue dans presse_articles (comme la presse), mais SANS effacer les animes pour lesquels
 * elle avait déjà été lue : la liste est fusionnée (l'anime cherché d'abord), « annonces » reste
 * « annonces », et le compteur d'essais ne dépasse pas 100 (colonne TINYINT).
 */
export async function noterLecture(pool: SqlPool, a: Article, statut: string, ids: number[], note: string): Promise<void> {
  const h = empreinte(a.url);
  const r: any[] = await pool.query("SELECT statut, animes FROM presse_articles WHERE url_hash = ?", [h]);
  const ancien = r.length ? String(r[0].statut || "") : "";
  // Réponse d'Ollama illisible : rien n'est noté sur une page déjà lue (elle reste lisible pour tous les animes,
  // et cet anime pourra la relire) ; une page nouvelle est notée « erreur » comme le fait la presse.
  if (statut === "erreur" && r.length && ancien !== "erreur") return;
  const avant = r.length ? String(r[0].animes || "").split(",").map(Number).filter((x) => x > 0) : [];
  const liste = statut === "erreur" ? avant.length ? avant : ids : [...new Set([...ids, ...avant])];
  while (liste.length > 1 && liste.join(",").length > 255) liste.pop();
  const st = r.length && String(r[0].statut) === "annonces" ? "annonces" : statut;
  await pool.query(
    `INSERT INTO presse_articles (url_hash, url, source, titre, publie_le, statut, animes, note, essais)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE statut = VALUES(statut), animes = VALUES(animes), note = VALUES(note),
                             essais = LEAST(essais + 1, 100), lu_le = CURRENT_TIMESTAMP`,
    [h, a.url.slice(0, 600), coupe(a.source, 20), coupe(a.titre, 300), versDatetime(a.publie), st, liste.join(",").slice(0, 255) || null, coupe(note, 255) || null],
  );
}

const STATUTS_FINIS = new Set(["annonces", "sans_annonce", "hors_sujet", "interdit", "tronque"]);
/** Page déjà lue pour cet anime (par la presse ou une recherche précédente) ? */
async function dejaLuePour(pool: SqlPool, url: string, id: number): Promise<boolean> {
  const r: any[] = await pool.query("SELECT statut, animes, essais FROM presse_articles WHERE url_hash = ?", [empreinte(url)]);
  if (!r.length) return false;
  const statut = String(r[0].statut || "");
  const animes = String(r[0].animes || "").split(",").map((x) => Number(x));
  if (statut === "erreur") return Number(r[0].essais) >= 3;
  return STATUTS_FINIS.has(statut) && animes.includes(id);
}

/**
 * Page déjà passée par la presse (le flux de Crunchyroll News donne le texte complet) : Tavily Extract n'y ajouterait rien.
 * (Une page notée par Tavily après Tavily Extract porte « Tavily Extract » dans sa note : la presse ne l'a pas lue.)
 */
async function lueParLaPresse(pool: SqlPool, url: string): Promise<boolean> {
  const r: any[] = await pool.query("SELECT note FROM presse_articles WHERE url_hash = ?", [empreinte(url)]);
  return r.length > 0 && !String(r[0].note ?? "").includes("Tavily Extract");
}
/**
 * Pages déjà demandées à Tavily Extract (marque « x » de tavily_recherches.urls) par une recherche des 90 derniers jours,
 * lues ou non, pour cet anime ou un autre : elles ne sont jamais redemandées (une page écartée avant Ollama n'est notée
 * nulle part ailleurs). Une seule requête par recherche ; seules les lignes qui contiennent une de ces adresses sont lues.
 */
async function dejaExtraites(pool: SqlPool, urls: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const voulues = new Set(urls);
  if (!voulues.size) return out;
  // l'adresse telle qu'elle est écrite dans le JSON (« "u":"https://…" », clé écrite en premier par urlsJson)
  const motifs = [...voulues].map((u) => `%${JSON.stringify({ u }).slice(1, -1).replace(/[\\%_]/g, "\\$&")}%`);
  const rows: any[] = await pool.query(
    `SELECT urls FROM tavily_recherches WHERE cherche_le >= NOW() - INTERVAL 90 DAY AND (${motifs.map(() => "urls LIKE ?").join(" OR ")})`,
    motifs,
  );
  for (const r of rows) {
    let liste: any[] = [];
    try {
      liste = JSON.parse(String(r.urls || "[]"));
    } catch {
      continue;
    }
    if (!Array.isArray(liste)) continue;
    for (const x of liste) if (x && x.x === 1 && typeof x.u === "string" && voulues.has(x.u)) out.add(x.u);
  }
  return out;
}
/** Une écriture en base qui échoue est notée sur la page, sans arrêter le passage. */
async function ecrire(f: () => Promise<void>, page: Page): Promise<void> {
  try {
    await f();
  } catch (e) {
    page.note = coupe(`${page.note} (écriture en base impossible : ${(e as Error).message})`, 240);
  }
}
// (PRISES_REELLES : les adaptations en prises de vues réelles, dans presse.ts, pour la presse aussi)
const ROMAINS = ["", "", "ii", "iii", "iv", "v"];
/** Numéros de saison écrits avec « saison / season / temporada » (pas « part » ni « cour ») : « saison 2 », « 2nd season », « première saison ». */
function saisonsExplicites(texteNorm: string): Set<number> {
  const out = new Set<number>();
  const mots: Record<string, number> = { premiere: 1, first: 1, primera: 1, second: 2, deuxieme: 2, segunda: 2, third: 3, troisieme: 3, tercera: 3, fourth: 4, quatrieme: 4, cuarta: 4, fifth: 5, cinquieme: 5, quinta: 5, deux: 2, two: 2, dos: 2, trois: 3, three: 3, tres: 3, quatre: 4, four: 4, cuatro: 4, cinq: 5, five: 5, cinco: 5 };
  // (les nombres espagnols après « temporada » seulement : « une saison très attendue » n'est pas une saison 3)
  for (const m of texteNorm.matchAll(/\b(?:(saison|season)\s+(\d+|deux|trois|quatre|cinq|two|three|four|five)|(temporada)\s+(\d+|dos|tres|cuatro|cinco))\b/g)) {
    const x = (m[2] ?? m[4])!;
    out.add(/^\d+$/.test(x) ? parseInt(x, 10) : mots[x] ?? 0);
  }
  for (const m of texteNorm.matchAll(/\b(\d+)(?:e|eme|er|nd|rd|th|st|a|o|era|da)?\s+(?:saison|season|temporada)\b/g)) out.add(parseInt(m[1]!, 10));
  for (const m of texteNorm.matchAll(/\b(premiere|first|primera|second|deuxieme|segunda|third|troisieme|tercera|fourth|quatrieme|cuarta|fifth|cinquieme|quinta)\s+(?:saison|season|temporada)\b/g)) out.add(mots[m[1]!] ?? 0);
  for (const n of [...out]) if (n < 1 || n > 20) out.delete(n);
  return out;
}
/** La forme nomme-t-elle la saison s (« saison 2 », « 2nd season », « part 2 », « … ii ») ? */
const nommeSaison = (forme: string, s: number) => {
  const c = saisonsCitees(forme);
  return c.numeros.has(s) || (!!ROMAINS[s] && new RegExp(`\\b${ROMAINS[s]}$`).test(forme));
};
const CRUNCHYROLL_HOTE = /(?:^|\.)crunchyroll\.com$/i;
/**
 * Une date de cinéma lue dans une page de Crunchyroll News, ou dans un texte de Tavily Extract, n'est jamais gardée, comme dans
 * la presse : Crunchyroll y est le distributeur des films en France, et ses news mêlent la date du Japon, les reports, les
 * avant-premières et les suites. Les autres sites donnent ces dates.
 */
export function cinemaCrunchyroll(v: Verdict, a: Article, extrait: boolean): Verdict {
  if (v.statut !== "garde" || v.plateforme?.nom !== "Cinéma") return v;
  let hote = "";
  try {
    hote = new URL(a.url).hostname;
  } catch {
    hote = "";
  }
  if (!extrait && !CRUNCHYROLL_HOTE.test(hote)) return v;
  return { ...v, statut: "rejete", raison: "date de cinéma de Crunchyroll News (ou lue par Tavily Extract) : jamais gardée (date du Japon, reports, avant-premières)" };
}
/**
 * Contrôles propres à Tavily (articles jusqu'à un an en arrière) sur une annonce gardée par la vérification
 * de la presse : une adaptation en prises de vues réelles est écartée ; pour une suite (saison 2 ou plus),
 * la phrase elle-même doit nommer cette saison (« saison 2 », ou le titre complet avec la saison).
 */
export function controlesTavily(v: Verdict, a?: Article): Verdict {
  if (v.statut !== "garde" || !v.anime) return v;
  const anime = v.anime;
  // « le 31 septembre » : une date impossible (Date.parse la fait glisser au 1er octobre) est retirée.
  if (v.date && (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Number.isFinite(Date.parse(v.date + "T00:00:00Z")) || new Date(v.date + "T00:00:00Z").toISOString().slice(0, 10) !== v.date)) {
    v = { ...v, date: null, heure: null, notes: [...v.notes, `date impossible (${v.date}), retirée`] };
  }
  // (relecture 2) la phrase citée entière : celle du verdict est coupée à 250 caractères (coupe), et la fin d'une phrase
  // longue (« … les saisons précédentes restent sur ADN », « … dans un coffret Blu-ray ») doit être lue aussi
  const entiere = v.phrase.endsWith("…") && a
    ? (a.titre + "\n" + a.texte).split("\n").flatMap((l) => decouperPhrases(l)).find((x) => coupe(x, 250) === v.phrase)
    : undefined;
  const ph = norm(entiere ?? v.phrase);
  // Le titre de l'article, la phrase et les paragraphes autour : « la série live-action … » peut être dit avant.
  let contexte = ph;
  if (a) {
    const paras = a.texte.split("\n").map((x) => norm(x));
    const debut = ph.split(" ").slice(0, 8).join(" ");
    const i = paras.findIndex((x) => x.includes(debut));
    contexte = [norm(a.titre), ...(i >= 0 ? paras.slice(Math.max(0, i - 1), i + 2) : []), ph].join(" ");
  }
  if (PRISES_REELLES.test(" " + contexte + " ")) return { ...v, statut: "rejete", raison: "adaptation en prises de vues réelles (live-action, drama)" };
  // « Le tome 12 sortira le 5 novembre chez Crunchyroll », « Le coffret Blu-ray… », « Le jeu X arrive sur Netflix… »
  // (relecture 2) le nom du site en fin de titre (« … | Crunchyroll News ») n'est pas une marque citée par la phrase
  if (EDITION.test(" " + ph.replace(/(?:^| )crunchyroll news$/, "") + " ") || JEU_SUJET.test(ph + " ") || (v.plateforme?.nom === "Crunchyroll" && (LIVRE_SUJET.test(ph + " ") || EDITEUR_CR.test(" " + ph + " ")))) return { ...v, statut: "rejete", raison: "tome, coffret, livre, jeu, récompense ou marque : pas une diffusion" };
  const s = anime.saison;
  if (s >= 2) {
    const c = saisonsCitees(ph);
    const titreAvecSaison = anime.alias.some((al) => al.complet && contient(ph, al.forme) && nommeSaison(al.forme, s));
    if (!c.numeros.has(s) && c.jusqua < s && !titreAvecSaison) return { ...v, statut: "rejete", raison: `suite : la saison ${s} n'est pas nommée dans la phrase` };
    // « … une saison 2, après une première saison diffusée sur ADN » : la plateforme peut être celle d'une autre saison.
    // (Les numéros du titre complet de l'anime ne comptent pas : « Season 3 Part 2 ».)
    let reste = " " + ph + " ";
    for (const al of anime.alias) if (al.complet) reste = reste.split(" " + al.forme + " ").join(" ");
    if ([...saisonsExplicites(reste)].some((n) => n !== s) || AUTRES_SAISONS.test(reste)) return { ...v, statut: "rejete", raison: "suite : la phrase parle aussi d'une autre saison" };
  }
  return v;
}

/**
 * Lit les pages retenues d'une recherche, envoie les meilleures à Ollama et vérifie ses réponses.
 * Hors essai : note chaque page lue (presse_articles) et enregistre les annonces gardées (annonces_fr).
 */
export async function traiter(
  pool: SqlPool,
  cfg: TavilyConfig,
  catalogue: AnimeCat[],
  c: Cible,
  retenus: Resultat[],
  // creditsPermis : ce que Tavily Extract peut encore dépenser (0 : rien, comme à la reprise) ; payer : chaque dépense,
  // notée tout de suite (avec le texte lu, gardé pour une reprise)
  opts: { essai: boolean; ollamaVerifie: { fait: boolean }; creditsPermis?: number; payer?: (credits: number) => Promise<void> },
): Promise<Traitement> {
  const t: Traitement = { cible: c, rechercheId: null, recherche: null, retenus, pages: [], gardees: [], trouve: [], dateTrouvee: false, ollama: 0 };
  const depuis = depuisPour(c, new Date().toISOString().slice(0, 10));
  const limite = Date.parse(depuis + "T00:00:00Z") - 3 * 86400000;
  const cat = catalogue.some((x) => x.id === c.anime.id) ? catalogue : [c.anime, ...catalogue];
  const candidats: Array<{ a: Article; lu: Article; cites: Cite[]; ids: number[]; controle: Lecture["controle"]; page: Page; extrait: boolean }> = [];
  // Une page lue : sa date, ce qu'Ollama lira (l'article, ou les passages de l'anime cherché) et les animes cités, l'anime
  // cherché d'abord ; une plateforme nommée.
  const suite = (p: ReturnType<typeof articleDePage>, page: Page, extrait: boolean): void => {
    const ecarter = (etat: Page["etat"], note: string) => {
      page.etat = etat;
      page.note = extrait ? `${note} (texte lu par Tavily Extract)` : note;
    };
    const lu = p.article!;
    page.publie = lu.publie;
    if (Date.parse(lu.publie) < limite) return ecarter("hors_sujet", `article du ${jjmmaaaa(lu.publie)}, plus d'un an avant la sortie`);
    const l = lecture(lu, p.origine ?? "page", p.blocs ?? (() => []), c.anime, cat, !!p.liste);
    if ("raison" in l) return ecarter("hors_sujet", l.raison);
    if (l.mode) page.lecture = extrait ? l.mode.replace("texte lu par Tavily", "texte lu par Tavily Extract") : l.mode;
    if (!parleDePlateforme(l.a)) return ecarter("hors_sujet", "aucune plateforme nommée");
    candidats.push({ a: l.a, lu, cites: l.cites, ids: l.ids, controle: l.controle, page, extrait });
  };
  // Pages sans texte chez nous ni dans la recherche : pour Tavily Extract, après la boucle.
  const sansTexte: Array<{ r: Resultat; d: Domaine; html: string; page: Page }> = [];
  // Les pages écartées avant Ollama ne sont pas notées dans presse_articles (la presse doit pouvoir les lire
  // pour d'autres animes) : seules le sont les pages interdites par robots.txt et celles lues par Ollama.
  for (const r of retenus) {
    const d = domaineDe(r.url, cfg.domaines);
    const page: Page = { url: r.url, source: d?.nom ?? "?", publie: r.publie, etat: "lu", note: "", verdicts: [], ms: 0 };
    t.pages.push(page);
    const ecarter = (etat: Page["etat"], note: string) => {
      page.etat = etat;
      page.note = note;
    };
    if (!d) {
      ecarter("hors_sujet", "site hors de la liste de confiance");
      continue;
    }
    // La date donnée par Tavily n'est jamais plus ancienne que la vraie : déjà trop ancienne, la page n'est pas lue.
    if (r.publie && Date.parse(r.publie) < limite) {
      ecarter("hors_sujet", `article du ${jjmmaaaa(r.publie)}, plus d'un an avant la sortie`);
      continue;
    }
    if (await dejaLuePour(pool, r.url, c.anime.id)) {
      ecarter("deja_lu", "déjà lue pour cet anime");
      continue;
    }
    const rb = await robotsAutorise(r.url);
    if (!rb.ok) {
      ecarter(rb.raison === "robots.txt illisible" ? "erreur" : "interdit", rb.raison ?? "interdit");
      if (!opts.essai && page.etat === "interdit") await ecrire(() => noterLecture(pool, { url: r.url, source: page.source, langue: "fr", titre: r.titre, texte: "", publie: r.publie ?? "" }, "interdit", [c.anime.id], "page interdite par le robots.txt du site"), page);
      continue;
    }
    await dormir(Math.max(1000, rb.delaiMs)); // jamais deux requêtes collées sur un site
    let html: string;
    try {
      html = await lirePage(r.url, d, cfg.domaines);
    } catch (e) {
      ecarter("erreur", coupe((e as Error).message, 120));
      continue;
    }
    if (r.brut !== undefined && !r.blocs) Object.assign(r, reduireBrut(r, c.anime, cat));
    const p = articleDePage(html, r.url, d, r);
    if (!p.article) {
      ecarter("illisible", p.raison ?? "illisible");
      // (site d'une plateforme ; ni texte chez nous, ni texte de Tavily, jamais demandée à Tavily Extract)
      if (d.officiel && r.blocs === undefined && !r.extrait && p.raison === "pas de texte d'article lisible") sansTexte.push({ r, d, html, page });
      continue;
    }
    suite(p, page, false);
  }
  // Pages sans texte d'un site de plateforme (Crunchyroll News) : lues par Tavily Extract « advanced », en une demande,
  // autant qu'Ollama en lira (la plus récente d'abord), si le budget le permet encore. Jamais une page que la presse a déjà
  // lue (son flux, texte complet), ni une page déjà demandée par une recherche des 90 derniers jours, pour cet anime ou un
  // autre, lue ou non (jamais payée deux fois). Ce qui est dépensé est noté tout de suite, avec le texte lu (gardé pour
  // une reprise).
  if (sansTexte.length) {
    sansTexte.sort((x, y) => Number(y.d.officiel) - Number(x.d.officiel) || String(y.r.publie ?? "").localeCompare(String(x.r.publie ?? "")));
    const choix: typeof sansTexte = [];
    const deja = await dejaExtraites(pool, sansTexte.map((x) => x.r.url));
    for (const x of sansTexte) {
      // (relecture 2) la marque d'une page déjà demandée est recopiée même au-delà des pages choisies (sinon elle se perd
      // quand la ligne d'origine sort des 90 jours)
      if (deja.has(x.r.url)) {
        x.r.extrait = true;
        x.page.note = "pas de texte d'article lisible ; déjà demandée à Tavily Extract par une recherche précédente";
        continue;
      }
      if (choix.length >= cfg.articlesParAnime) continue;
      if (await lueParLaPresse(pool, x.r.url)) x.page.note = "pas de texte d'article lisible ; déjà lue par la presse (son flux) : pas de Tavily Extract";
      else choix.push(x);
    }
    // (la marque est recopiée dans la ligne de cette recherche, sans crédit : la page reste « demandée » tant qu'elle revient)
    if (sansTexte.some((x) => deja.has(x.r.url))) await opts.payer?.(0);
    const permis = opts.creditsPermis ?? 0;
    if (choix.length && permis < EXTRACT_COUT) {
      for (const x of choix) x.page.note = `pas de texte d'article lisible ; Tavily Extract : budget insuffisant (${permis} crédit${permis > 1 ? "s" : ""} permis)`;
    } else if (choix.length) {
      const ex = { pages: choix.length, lues: 0, credits: 0 } as NonNullable<Traitement["extract"]>;
      t.extract = ex;
      // (relecture 2) le prix est compté AVANT la demande, comme une recherche (reserverRecherche) : une base qui ne répond
      // plus, ou un arrêt de l'API, après la réponse de Tavily ne fait jamais sortir la dépense des plafonds ; l'écart (refus,
      // lot pas encore plein) est rendu ensuite
      // (relecture 3) la marque est écrite AVEC la réservation : une panne après la réponse ne fait jamais repayer la page ;
      // un refus la retire ensuite (la page pourra être redemandée)
      for (const x of choix) x.r.extrait = true;
      await opts.payer?.(EXTRACT_COUT);
      let res: Awaited<ReturnType<typeof extraire>> | null = null;
      try {
        res = await extraire(cfg, choix.map((x) => x.r.url));
      } catch (e) {
        // refus (HTTP 4xx) : rien n'est facturé, une recherche suivante pourra la redemander ; sans réponse, réponse illisible
        // ou erreur du serveur (5xx) : peut-être facturé, jamais redemandée
        ex.credits = refuseeExtract(e) ? 0 : EXTRACT_COUT;
        ex.note = coupe((e as Error).message, 160);
        for (const x of choix) {
          if (!ex.credits) delete x.r.extrait;
          x.page.note = `pas de texte d'article lisible ; Tavily Extract impossible (${coupe((e as Error).message, 90)})`;
        }
        // (trop de requêtes, 429, ou serveur en panne, 5xx : le passage s'arrête aussi, les recherches suivantes ne pourraient
        // pas lire leurs pages)
        if (e instanceof TavilyErreur && (e.portee === "cle" || e.portee === "jour" || e.statut === 429 || e.statut >= 500)) t.stop = { message: e.message, portee: e.portee };
        await opts.payer?.(ex.credits - EXTRACT_COUT);
      }
      if (res) {
        ex.credits = res.credits;
        const illisibles = new Set<string>();
        for (const x of choix) {
          x.r.extrait = true;
          const texte = res.textes.get(x.r.url);
          if (!texte) continue;
          // (une réduction qui échoue ne fait pas perdre le compte des crédits dépensés : la page reste sans texte)
          try {
            x.r.brut = texte;
            Object.assign(x.r, reduireBrut(x.r, c.anime, cat));
          } catch {
            x.r.blocs = [];
            illisibles.add(x.r.url);
          } finally {
            delete x.r.brut;
          }
        }
        await opts.payer?.(res.credits - EXTRACT_COUT);
        for (const x of choix) {
          if (!res.textes.has(x.r.url)) {
            x.page.note = "pas de texte d'article lisible ; Tavily Extract ne l'a pas lue non plus";
            continue;
          }
          ex.lues++;
          if (illisibles.has(x.r.url)) {
            x.page.note = "pas de texte d'article lisible ; texte de Tavily Extract illisible";
            continue;
          }
          const p = articleDePage(x.html, x.r.url, x.d, x.r);
          if (!p.article) {
            x.page.note = `${p.raison ?? "illisible"} (texte lu par Tavily Extract)`;
            continue;
          }
          x.page.etat = "lu";
          x.page.note = "";
          suite(p, x.page, true);
        }
      }
    }
  }
  // Ordre : site de la plateforme, sites français, titre complet de l'anime cherché, plus récent.
  const complet = (x: { cites: Cite[] }) => x.cites.some((y) => y.it.id === c.anime.id && y.complet);
  candidats.sort((x, y) => Number(!!y.a.officielle) - Number(!!x.a.officielle)
    || Number(y.a.langue === "fr") - Number(x.a.langue === "fr")
    || Number(complet(y)) - Number(complet(x))
    || String(y.a.publie).localeCompare(String(x.a.publie)));
  const noteDe = (note: string, extrait: boolean) => (extrait ? coupe(`${note} (Tavily Extract)`, 255) : note);
  for (const { a, lu, cites, ids, controle, page, extrait } of candidats) {
    if (t.ollama >= cfg.articlesParAnime || (t.trouve.length && (t.dateTrouvee || !c.manque.includes("date")))) {
      page.etat = "non_envoye";
      page.note = t.trouve.length ? "anime déjà trouvé dans un autre article" : `au-delà de ${cfg.articlesParAnime} articles par recherche`;
      continue;
    }
    if (!opts.ollamaVerifie.fait) {
      try {
        await verifierOllama(cfg.presse);
        opts.ollamaVerifie.fait = true;
      } catch (e) {
        t.arret = (e as Error).message;
        page.etat = "non_envoye";
        page.note = t.arret;
        break;
      }
    }
    let r;
    try {
      r = await ollama(cfg.presse, messages(a, cites));
    } catch (e) {
      // Ollama tombé : on s'arrête là ; la recherche reste « en attente » et ses pages seront relues.
      t.arret = (e as Error).message;
      page.etat = "non_envoye";
      page.note = t.arret;
      break;
    }
    t.ollama++;
    page.ms = r.ms;
    const j = lireJson(r.contenu);
    const diffusions: any[] | null = j && Array.isArray(j.diffusions) ? j.diffusions : null;
    if (!diffusions) {
      page.etat = "erreur";
      page.note = r.coupee ? "réponse d'Ollama trop longue, coupée" : "réponse d'Ollama illisible";
      if (!opts.essai) await ecrire(() => noterLecture(pool, lu, r.coupee ? "tronque" : "erreur", ids, noteDe(page.note, extrait)), page);
      continue;
    }
    page.verdicts = diffusions.map((d) => {
      const v = cinemaCrunchyroll(controle(controlesTavily(verifier(a, cites, d), a)), a, extrait);
      return v.phrase.includes(GLU) ? { ...v, phrase: v.phrase.split(GLU).join(" ") } : v;
    });
    const gardes = meilleures(page.verdicts);
    t.gardees.push(...gardes);
    page.etat = gardes.length ? "annonces" : "sans_annonce";
    page.note = diffusions.length ? `${gardes.length} gardée${gardes.length > 1 ? "s" : ""} sur ${diffusions.length}` : "aucune diffusion annoncée dans l'article";
    if (!opts.essai) {
      // Une annonce qui ne s'écrit pas : la page n'est pas notée et la recherche reste en attente (relue plus tard).
      let panne = false;
      for (const v of [...gardes]) {
        try {
          await enregistrerAnnonce(pool, a, v);
        } catch (e) {
          // Donnée refusée par la base (SQLSTATE 22…) : cette annonce est sautée, le reste continue.
          // Autre erreur (base indisponible…) : arrêt ; la page n'est pas notée et la recherche sera reprise.
          if (String((e as any)?.sqlState ?? "").startsWith("22")) {
            page.note = coupe(`${page.note} (annonce ${v.plateforme?.nom ?? "?"} refusée par la base : ${(e as Error).message})`, 240);
            t.gardees = t.gardees.filter((g) => g !== v);
            gardes.splice(gardes.indexOf(v), 1);
            continue;
          }
          t.arret = `écriture d'une annonce impossible : ${(e as Error).message}`;
          page.note = coupe(`${page.note} (${t.arret})`, 240);
          t.gardees = t.gardees.filter((g) => !gardes.includes(g));
          panne = true;
          break;
        }
      }
      if (panne) break;
      if (!gardes.length && page.etat === "annonces") page.etat = "sans_annonce"; // toutes refusées par la base
      await ecrire(() => noterLecture(pool, lu, page.etat, ids, noteDe(page.note, extrait)), page);
    }
    for (const v of gardes) {
      if (v.anime?.id !== c.anime.id || !v.plateforme) continue;
      const site = nomDuSite(v.plateforme.nom);
      // Film : le cinéma en France, avec sa date, suffit — sauf quand on cherche justement sa plateforme,
      // et sauf une avant-première de festival (que le module plateformes ignore aussi).
      const cinema = !site && c.anime.format === "MOVIE" && c.motif !== "cinema" && v.plateforme.nom === "Cinéma" && !!v.date && cinemaRetenu(v.date, c.sortie, c.precision);
      if (!site && !cinema) continue;
      t.trouve.push(`${site ?? "Cinéma"}${v.date ? ` le ${jjmmaaaa(v.date)}` : ""}`);
      if (v.date) t.dateTrouvee = true;
    }
  }
  t.trouve = [...new Set(t.trouve)];
  return t;
}

// ─────────────────────────────────────────────────────────────── base
/** La recherche est comptée AVANT d'être envoyée (1 crédit) : une réponse perdue reste comptée. */
async function reserverRecherche(pool: SqlPool, c: Cible, texte: string, depuis: string): Promise<number> {
  const x: any = await pool.query(
    `INSERT INTO tavily_recherches (anime_id, motif, requete, depuis, credits, statut, note) VALUES (?, ?, ?, ?, 1, 'envoi', 'recherche envoyée')`,
    [c.anime.id, c.motif ?? "demande", coupe(texte, 300), depuis],
  );
  const id = Number(x?.insertId) || 0;
  if (!id) throw new Error("recherche non enregistrée (insertId absent)");
  return id;
}
async function completerRecherche(pool: SqlPool, id: number, r: Recherche, retenus: Resultat[]): Promise<void> {
  await pool.query(
    "UPDATE tavily_recherches SET credits = ?, resultats = ?, urls = ?, statut = 'a_lire', note = ? WHERE id = ?",
    [Math.min(127, r.credits), Math.min(127, r.resultats.length), urlsJson(retenus),
      coupe(`${r.resultats.length} résultat(s), ${retenus.length} retenu(s)`, 255), id],
  );
}
/**
 * Les pages retenues, pour une reprise sans nouvelle recherche : adresse, titre, date et le texte de Tavily réduit
 * (« b »), tant que le tout tient dans la colonne (TEXT, 65 535 octets : 60 000 au plus ici ; sinon les plus longs
 * textes de Tavily sont laissés de côté, et leur page serait reprise sans eux).
 */
export function urlsJson(retenus: Resultat[]): string {
  const liste: Array<{ u: string; t: string; d: string | null; b?: Array<Array<number | string>>; l?: number; x?: number }> = retenus.map((x) => ({
    u: x.url, t: coupe(x.titre, 200), d: x.publie,
    ...(x.blocs?.length ? { b: x.blocs.map((y) => (y.lien ? [y.h, y.t, 1] : [y.h, y.t])), l: x.liste ? 1 : 0 } : {}),
    ...(x.extrait ? { x: 1 } : {}),
  }));
  const taille = (x: (typeof liste)[number]) => JSON.stringify(x.b ?? []).length;
  let s = JSON.stringify(liste);
  while (Buffer.byteLength(s) > 60000) {
    let k = -1;
    liste.forEach((x, i) => {
      if (x.b && (k < 0 || taille(x) > taille(liste[k]!))) k = i;
    });
    if (k < 0) break;
    delete liste[k]!.b;
    delete liste[k]!.l;
    s = JSON.stringify(liste);
  }
  return s;
}
/** Refus de Tavily (HTTP 400 et plus : pas facturé) ; sans réponse ou réponse illisible : peut-être facturée, reste comptée. */
const refusee = (e: unknown) => e instanceof TavilyErreur && e.statut >= 400;
/** (relecture 3) Tavily Extract : un refus (4xx) n'est pas facturé ; une erreur du serveur (5xx) l'a peut-être été. */
const refuseeExtract = (e: unknown) => e instanceof TavilyErreur && e.statut >= 400 && e.statut < 500;
async function echecRecherche(pool: SqlPool, id: number, e: unknown): Promise<void> {
  const facturee = !refusee(e);
  await pool.query("UPDATE tavily_recherches SET statut = 'erreur', credits = ?, note = ?, traite_le = NOW() WHERE id = ?", [
    facturee ? 1 : 0, coupe(`${(e as Error).message}${facturee ? " (comptée : peut-être facturée)" : ""}`, 255), id,
  ]);
}
async function terminerRecherche(pool: SqlPool, id: number, t: Traitement): Promise<void> {
  const statut = t.trouve.length ? "trouve" : "rien";
  const compte = (e: Page["etat"]) => t.pages.filter((p) => p.etat === e).length;
  const morceaux = [
    t.trouve.length ? `trouvé : ${t.trouve.join(", ")}` : "rien de vérifié",
    t.retenus.length ? `${t.retenus.length} page(s) retenue(s)` : "aucun article de site de confiance ne nomme l'anime",
    compte("interdit") ? `${compte("interdit")} interdite(s) par robots.txt` : "",
    t.ollama ? `${t.ollama} lue(s) par Ollama` : "",
    t.gardees.length ? `${t.gardees.length} annonce(s) gardée(s)` : "",
    t.extract ? `Tavily Extract : ${t.extract.lues} lue(s) sur ${t.extract.pages}, ${t.extract.credits} crédit(s)` : "",
  ].filter(Boolean);
  await pool.query("UPDATE tavily_recherches SET statut = ?, note = ?, traite_le = NOW() WHERE id = ?", [statut, coupe(morceaux.join(" ; "), 255), id]);
}

// ─────────────────────────────────────────────────────────────── passage
export interface RapportTavily {
  budget: Budget | null;
  file: { total: number; dues: number; j7: number; sortis: number; avenir: number; abandonnes: number; attente: number };
  repris: Traitement[];
  recherches: Traitement[];
  credits: number;
  arret?: string;
  portee?: TavilyErreur["portee"];
}

/**
 * Un passage. Hors essai : reprend d'abord les recherches dont les pages attendent Ollama, puis
 * cherche les animes dus (dans le budget), enregistre chaque recherche, les pages lues et les annonces
 * gardées. En essai : n'écrit rien en base ; `ids` impose les animes cherchés.
 */
export async function passage(
  pool: SqlPool,
  cfg: TavilyConfig,
  opts: { essai: boolean; max?: number; ids?: number[]; suivi?: (t: Traitement, n: number, total: number) => void },
): Promise<RapportTavily> {
  const file = await fileAttente(pool);
  const rap: RapportTavily = {
    budget: null,
    file: {
      total: file.cibles.length, dues: file.dues.length,
      j7: file.cibles.filter((c) => c.motif === "j7").length,
      sortis: file.cibles.filter((c) => c.motif === "sorti").length,
      avenir: file.cibles.filter((c) => c.motif === "avenir").length,
      abandonnes: file.cibles.filter((c) => c.abandonne).length,
      attente: file.cibles.filter((c) => c.attente).length,
    },
    repris: [],
    recherches: [],
    credits: 0,
  };
  const ollamaVerifie = { fait: false };
  // 1. Pages en attente d'Ollama (hors essai) : sans nouvelle recherche, donc sans crédit.
  if (!opts.essai) {
    // Envoi interrompu (arrêt de l'API pendant la recherche) : la recherche reste comptée.
    await pool.query("UPDATE tavily_recherches SET statut = 'erreur', note = 'recherche interrompue (comptée)', traite_le = NOW() WHERE statut = 'envoi' AND cherche_le < NOW() - INTERVAL 1 HOUR");
    const attente: any[] = await pool.query(
      `SELECT id, CAST(anime_id AS UNSIGNED) AS anime, urls, TIMESTAMPDIFF(HOUR, cherche_le, NOW()) AS heures
         FROM tavily_recherches WHERE statut = 'a_lire' ORDER BY id LIMIT 10`,
    );
    for (const x of attente) {
      const id = Number(x.id);
      const c = file.cibles.find((y) => y.anime.id === Number(x.anime));
      if (!c) {
        await pool.query("UPDATE tavily_recherches SET statut = 'rien', note = ?, traite_le = NOW() WHERE id = ?", ["anime complet (ou hors de la fenêtre) entre-temps : pages non relues", id]);
        continue;
      }
      if (Number(x.heures) > SANS_TRAITEMENT_H) {
        await pool.query("UPDATE tavily_recherches SET statut = 'erreur', note = ?, traite_le = NOW() WHERE id = ?", ["pages non lues en 3 jours (Ollama indisponible ?)", id]);
        continue;
      }
      let retenus: Resultat[] = [];
      try {
        retenus = (JSON.parse(String(x.urls || "[]")) as any[]).map((u) => ({
          url: String(u.u), titre: String(u.t || ""), contenu: "", publie: u.d ? String(u.d) : null,
          ...(u.x === 1 ? { extrait: true } : {}),
          ...(Array.isArray(u.b) && u.b.length
            ? { blocs: (u.b as any[]).filter((y) => Array.isArray(y) && typeof y[1] === "string").map((y) => ({ h: Number(y[0]) || 0, t: String(y[1]), ...(y[2] === 1 ? { lien: true } : {}) })), liste: u.l === 1 }
            : {}),
        }));
      } catch { /* liste illisible : rien à relire */ }
      let t: Traitement;
      try {
        t = await traiter(pool, cfg, file.catalogue, c, retenus, { essai: false, ollamaVerifie });
      } catch (e) {
        // Erreur imprévue : la recherche est close, pour ne pas bloquer les suivantes.
        await pool.query("UPDATE tavily_recherches SET statut = 'erreur', note = ?, traite_le = NOW() WHERE id = ?", [coupe(`lecture impossible : ${(e as Error).message}`, 255), id]);
        rap.arret = `lecture des pages impossible : ${(e as Error).message}`;
        rap.portee = "passage";
        return rap;
      }
      t.rechercheId = id;
      rap.repris.push(t);
      opts.suivi?.(t, rap.repris.length, attente.length);
      if (t.arret) {
        rap.arret = t.arret;
        return rap;
      }
      await terminerRecherche(pool, id, t);
    }
  }
  // 2. Budget (et forfait chez Tavily, lu seulement s'il y a à chercher) ; Ollama doit répondre avant
  //    de dépenser un crédit.
  const liste: Cible[] = opts.ids?.length ? opts.ids.map((id) => file.toutes.get(id)).filter((c): c is Cible => !!c) : file.dues;
  if (!liste.length || (opts.max ?? 1) <= 0) return rap;
  try {
    rap.budget = await budget(pool, cfg, opts.essai ? "toujours" : "si_besoin");
  } catch (e) {
    rap.arret = (e as Error).message;
    rap.portee = e instanceof TavilyErreur ? e.portee : "passage";
    return rap;
  }
  // L'essai ne compte pas dans les plafonds du module, mais jamais au-delà du forfait.
  const permis = opts.essai ? rap.budget.restantForfait ?? 0 : rap.budget.restant;
  const n = Math.min(opts.max ?? cfg.maxParPassage, permis, liste.length);
  if (n <= 0) return rap;
  try {
    await verifierOllama(cfg.presse);
    ollamaVerifie.fait = true;
  } catch (e) {
    rap.arret = `${(e as Error).message} : aucune recherche lancée`;
    rap.portee = "passage";
    return rap;
  }
  // 3. Recherches. Jamais plus de crédits que permis : une recherche facturée plus d'un crédit (ce que Tavily ne fait
  //    pas pour une « basic ») compte pour ce qu'elle a coûté, et la suivante n'est lancée que si elle tient encore.
  let cout = 1;
  for (let k = 0; k < n; k++) {
    if (rap.credits + cout > permis) break;
    const c = liste[k]!;
    const texte = requete(c);
    const depuis = depuisPour(c, new Date().toISOString().slice(0, 10));
    const id = opts.essai ? 0 : await reserverRecherche(pool, c, texte, depuis);
    let r: Recherche;
    try {
      r = await chercher(cfg, texte, depuis);
    } catch (e) {
      if (id) await echecRecherche(pool, id, e);
      rap.arret = (e as Error).message;
      rap.portee = e instanceof TavilyErreur ? e.portee : "passage";
      if (!refusee(e)) rap.credits += 1; // sans réponse ou réponse illisible : peut-être facturée
      break;
    }
    rap.credits += r.credits;
    cout = Math.max(cout, r.credits);
    const retenus = retenir(r.resultats, c, cfg);
    // Le texte de Tavily des pages retenues, réduit à ce qui en sera lu : gardé pour leur lecture (et une reprise).
    for (const x of retenus) {
      if (x.brut === undefined) continue;
      Object.assign(x, reduireBrut(x, c.anime, file.catalogue));
      delete x.brut;
    }
    if (id) await completerRecherche(pool, id, r, retenus);
    // (relecture 3) les crédits de la ligne, écrits en valeur (pas « credits + ? ») : une réponse perdue après l'écriture,
    // puis le réessai, ne comptent jamais deux fois l'écart (−2 rendu deux fois sous-compterait les plafonds)
    let creditsLigne = Math.min(127, r.credits);
    let t: Traitement;
    try {
      t = await traiter(pool, cfg, file.catalogue, c, retenus, {
        essai: opts.essai,
        ollamaVerifie,
        creditsPermis: permis - rap.credits,
        // Tavily Extract : compté tout de suite dans les plafonds, et le texte lu gardé avec la recherche (une reprise
        // ne paie pas deux fois)
        payer: async (k) => {
          rap.credits += k;
          creditsLigne = Math.max(0, Math.min(127, creditsLigne + k));
          if (!id) return;
          const total = creditsLigne, urls = urlsJson(retenus);
          const noter = () => pool.query("UPDATE tavily_recherches SET credits = ?, urls = ? WHERE id = ?", [total, urls, id]);
          // (une seconde fois si la base n'a pas répondu : les plafonds se calculent sur ces crédits)
          await noter().catch(() => dormir(2000).then(noter));
        },
      });
    } catch (e) {
      if (id) await pool.query("UPDATE tavily_recherches SET statut = 'erreur', note = ?, traite_le = NOW() WHERE id = ?", [coupe(`lecture impossible : ${(e as Error).message}`, 255), id]);
      rap.arret = `lecture des pages impossible : ${(e as Error).message}`;
      rap.portee = "passage";
      break;
    }
    t.recherche = r;
    t.rechercheId = id || null;
    rap.recherches.push(t);
    opts.suivi?.(t, k + 1, n);
    if (t.arret) {
      rap.arret = t.arret; // la recherche reste « en attente » : ses pages seront relues au prochain passage
      rap.portee = "passage";
      break;
    }
    if (id) await terminerRecherche(pool, id, t);
    if (t.stop) {
      rap.arret = `Tavily Extract : ${t.stop.message}`;
      rap.portee = t.stop.portee;
      break;
    }
  }
  return rap;
}

// ─────────────────────────────────────────────────────────────── cron
export interface TavilyDeps {
  pool: SqlPool;
  log: Journal;
}
let enCours = false;
let dernierAvertissement = 0;
let arretJusquA = 0; // forfait épuisé ou clé refusée : plus de recherche avant cette heure

export function startTavilyCron(deps: TavilyDeps, env: Record<string, string | undefined> = process.env): void {
  // Pilotage (pilotage.ts) : TAVILY_ENABLED ne sert plus qu'à la première mise en route ; sans clé, rien ne démarre.
  const cfg = configEssai(env);
  const actifParDefaut = env["TAVILY_ENABLED"] === "1";
  if (!cfg.cle) {
    deps.log.warn({ module: "tavily" }, "tavily : clé absente (TAVILY_API_KEY) : rien ne sera cherché");
    moduleIndisponible("tavily", "clé TAVILY_API_KEY absente de l'API");
    return;
  }
  deps.log.info({ module: "tavily", maxParJour: cfg.maxParJour, maxParMois: cfg.maxParMois, maxParPassage: cfg.maxParPassage }, "tavily : actif");
  const avertir = (message: string, detail: string) => {
    if (Date.now() - dernierAvertissement < 24 * 3600 * 1000) return;
    dernierAvertissement = Date.now();
    pushActivity({ type: "tavily", message, detail: coupe(detail, 240), level: "warn" });
  };
  const tick = async (): Promise<RetourPassage | void> => {
    if (enCours) return;
    if (Date.now() < arretJusquA) {
      const h = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(arretJusquA);
      return { bilan: { recherches: 0, annonces: 0, arret: `recherches arrêtées jusqu'à ${h} (clé refusée ou forfait atteint)` } };
    }
    enCours = true;
    const debut = Date.now();
    try {
      const r = await passage(deps.pool, cfg, { essai: false });
      const tous = [...r.repris, ...r.recherches];
      const trouves = tous.filter((t) => t.trouve.length);
      const details = {
        recherches: r.recherches.length, credits: r.credits,
        creditsJour: (r.budget?.jour ?? 0) + r.credits, creditsMois: (r.budget?.mois ?? 0) + r.credits,
        forfait: r.budget?.forfait ? `${r.budget.forfait.utilise}/${r.budget.forfait.limite ?? "?"}` : null,
        repris: r.repris.length, file: r.file.total, dues: r.file.dues, j7: r.file.j7,
        trouves: trouves.length, annonces: tous.reduce((s, t) => s + t.gardees.length, 0),
        ollama: tous.reduce((s, t) => s + t.ollama, 0), arret: r.arret ?? null,
      };
      trackLastRun("tavily", details, Date.now() - debut);
      if (r.recherches.length || r.repris.length || r.arret) deps.log[r.arret ? "warn" : "info"]({ module: "tavily", ...details }, "tavily : passage terminé");
      if (trouves.length) {
        pushActivity({
          type: "tavily",
          message: `Tavily : plateforme annoncée pour la France trouvée pour ${pluriel(trouves.length, "anime")}`,
          detail: coupe(trouves.map((t) => `${t.cible.anime.titleEnglish || t.cible.anime.title} (${t.trouve.join(", ")})`).join(" · "), 240),
          level: "info",
        });
      }
      if (r.arret && r.portee === "cle") {
        arretJusquA = Date.now() + 6 * 3600 * 1000;
        avertir("Tavily : clé refusée, recherches arrêtées", r.arret);
      } else if (r.arret && r.portee === "jour") {
        arretJusquA = Date.now() + 12 * 3600 * 1000;
        avertir("Tavily : limite du forfait atteinte, recherches arrêtées", r.arret);
      } else if (r.arret) {
        avertir("Tavily en attente (Ollama ou Tavily indisponible)", r.arret);
      }
    } catch (e) {
      deps.log.error({ module: "tavily", err: (e as Error).message }, "tavily : passage interrompu");
      trackLastRun("tavily", { erreur: (e as Error).message }, Date.now() - debut);
    } finally {
      enCours = false;
    }
  };
  planifier({
    id: "tavily", premierMs: PREMIER_PASSAGE_MS, rythmeMs: PASSAGE_MS, suivi: "tavily", actifParDefaut, passage: tick,
    // les crédits du jour et du mois, comptés par le module (sans appel à Tavily), pour le tableau de bord
    infos: async () => ({ ...(await budget(deps.pool, cfg, "jamais")), maxParJour: cfg.maxParJour, maxParMois: cfg.maxParMois, maxParPassage: cfg.maxParPassage }),
  });
}
