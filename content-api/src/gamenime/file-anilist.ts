/**
 * GameNime — la file AniList commune (30 octobre 2026).
 *
 * AniList limite le nombre de requêtes par minute et par serveur : 30 depuis qu'il est en mode dégradé (90
 * d'habitude ; la limite est annoncée dans x-ratelimit-limit). Au-delà, il refuse tout pendant une minute
 * (HTTP 429). Chaque module de l'API gardait son propre rythme, sous la limite tout seul, mais à deux ou trois en
 * même temps on passait au-dessus (Phase B et Phase C se chevauchaient à l'heure pile, et le contrôle de santé tombait
 * dans la minute de refus).
 *
 * Toutes les requêtes AniList de l'API attendent donc leur tour ici :
 *  - premier arrivé, premier servi : les tours sont donnés dans l'ordre des demandes (un module qui enchaîne ses
 *    requêtes ne passe pas devant les autres, même après un refus) ;
 *  - 2,5 s au moins entre deux départs, quel que soit le module : 24 par minute au plus, ce qui laisse de la marge au
 *    workflow AniList de n8n et au synopsis, qui interrogent aussi AniList hors de cette file ;
 *  - après un refus (429), plus aucun départ avant la fin de l'attente demandée par AniList (Retry-After, en secondes
 *    ou en date ; 90 s au plus, 60 s sans), pour tous les modules.
 * Passent par la file : Phase B (fetchAniList), dates des animés, contrôle J-7, Phase C, popularité, Top du moment,
 * bonus Europe, contrôle des données, séries en cours, plateformes, licences et le contrôle de santé planifié. Le
 * synopsis garde son propre rythme (une requête par fiche, entre deux rédactions, et il réessaie seul après un refus).
 *
 * Les échéances suivent une horloge qui ne recule jamais (performance.now) : un réglage de l'heure du serveur ne
 * bloque pas la file.
 *
 * Variable, pour les essais seulement : ANILIST_PAS_MS (pas entre deux départs, en ms ; toute autre valeur qu'un
 * nombre entier garde 2 500).
 */

const PAS_DEFAUT_MS = 2500;
const PAS_ANILIST_MS = /^\s*\d+\s*$/.test(process.env.ANILIST_PAS_MS ?? "") ? Number(process.env.ANILIST_PAS_MS) : PAS_DEFAUT_MS;
const ATTENTE_MAX_S = 90;
const ATTENTE_SANS_S = 60;
let prochainTour = 0;
let suspenduJusqua = 0;
let chaine: Promise<void> = Promise.resolve();
const maintenant = () => performance.now();
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Le tour du premier de la file : le pas depuis le départ précédent, et rien pendant une suspension (relue après
 * chaque attente : un refus arrivé entre-temps la prolonge). */
async function attendre(): Promise<void> {
  for (;;) {
    const t = maintenant();
    const depart = Math.max(prochainTour, suspenduJusqua);
    if (depart <= t) {
      prochainTour = t + PAS_ANILIST_MS;
      return;
    }
    await dormir(depart - t);
  }
}

/** Attend son tour avant une requête AniList, dans l'ordre des demandes. */
export function tourAniList(): Promise<void> {
  const tour = chaine.then(attendre);
  chaine = tour.catch(() => {});
  return tour;
}

/** L'attente demandée par AniList, en secondes : un nombre, ou une date HTTP ; null si illisible ou absente. */
function secondesDemandees(retryAfter: string | null): number | null {
  const v = String(retryAfter ?? "").trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, (d - Date.now()) / 1000) : null;
}

/** AniList refuse (429) : plus aucun départ avant la fin de l'attente demandée (1 s au moins, 90 s au plus ; 60 s sans
 * attente lisible). Rend l'attente retenue, en millisecondes. */
export function aniListRefuse(retryAfter: string | null): number {
  const s = secondesDemandees(retryAfter);
  const attente = (s === null ? ATTENTE_SANS_S : Math.min(Math.max(s, 1), ATTENTE_MAX_S)) * 1000;
  suspenduJusqua = Math.max(suspenduJusqua, maintenant() + attente);
  return attente;
}

/** Ce qui reste de la suspension demandée par AniList, en millisecondes (0 : pas de suspension). */
export function suspensionRestante(): number {
  return Math.max(0, suspenduJusqua - maintenant());
}

/** Attente avant un contrôle planifié : de h:56 à h:04 (UTC), le workflow AniList de n8n interroge AniList ; le contrôle
 * attend h:04. 0 en dehors de ce créneau. (Même créneau que le Top du moment, du-moment.ts.) */
export function attenteCreneauN8n(d: Date): number {
  const mn = d.getUTCMinutes();
  if (mn >= 4 && mn < 56) return 0;
  const fin = new Date(d.getTime());
  if (mn >= 56) fin.setUTCHours(d.getUTCHours() + 1, 4, 0, 0);
  else fin.setUTCMinutes(4, 0, 0);
  return fin.getTime() - d.getTime();
}
