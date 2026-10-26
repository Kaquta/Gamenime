/**
 * Bascule progressive des synopsis (Rey, 21 octobre 2026 : « Plus rapide si synopsis validé remplace tout de suite »).
 *
 * Dès que Rey valide un synopsis dans le bloc Synopsis du dashboard, le site montre ce synopsis à la place de la
 * description des sources : flux (accueil, Anime, Jeux, À venir, calendrier), recherche, fiche (le modal et la page,
 * rechargée en direct ; au build suivant, le HTML de la page, sa meta, og et JSON-LD). Un item sans synopsis validé
 * garde sa description, telle quelle ; retirer la validation (« Annuler ») la rend.
 *
 * - Les balises de fin de description ([FORMAT:…] [EPISODES:…] [STATUS:…] [SEASON:…] [NEXT_EP:…], posées par n8n)
 *   suivent le synopsis : la fiche y lit le format, les épisodes, le statut et la saison ; les flux les retirent
 *   (stripDisplayTags). Relevé du 21 octobre : 143 descriptions d'animés en portent, toujours à la fin ; aucune de jeu.
 *   Seules ces balises-là sont reprises, en majuscules (la colonne est insensible à la casse : (?-i)).
 * - Rien n'est écrit en base : `description` reste la colonne des sources, que le module synopsis relit. La liste
 *   `/anime/items` et `/games/items` n'est pas touchée : le workflow n8n des bandes-annonces la lit, puis renvoie ses
 *   items à `/bulk` ; un synopsis ne doit jamais revenir dans `description`.
 */

/** Le synopsis, sans blancs autour (TRIM n'enlève que les espaces : retours à la ligne et tabulations aussi) : du premier
 * au dernier caractère qui n'est pas un blanc ('' s'il n'y en a pas) ; (?s) : un retour à la ligne au milieu reste. */
const SYNOPSIS = "REGEXP_SUBSTR(IFNULL(synopsis_fr, ''), '(?s)[^[:space:]](.*[^[:space:]])?')";

/** Le synopsis de l'item est validé par Rey, et pas vide. */
export const SYNOPSIS_VALIDE = `(synopsis_status = 'approved' AND ${SYNOPSIS} <> '')`;

/** Un synopsis validé qui fait une page à lui seul : même seuil que la description (150 caractères), pas de page mince. */
export const SYNOPSIS_PAGE = `(${SYNOPSIS_VALIDE} AND CHAR_LENGTH(${SYNOPSIS}) >= 150)`;

/** Les balises qui terminent la description, sans les blancs de fin ('' s'il n'y en a pas). */
const BALISES_DE_FIN =
  "REGEXP_REPLACE(REGEXP_SUBSTR(IFNULL(description, ''), '(?-i)([[](FORMAT|STATUS|SEASON|EPISODES|LENGTH|NEXT_EP):[^]]*[]][[:space:]]*)+$'), '[[:space:]]+$', '')";

/** La description servie au site : le synopsis validé suivi des balises de fin, sinon la description. */
export const DESCRIPTION_SITE = `IF(${SYNOPSIS_VALIDE}, CONCAT_WS(' ', ${SYNOPSIS}, NULLIF(${BALISES_DE_FIN}, '')), description)`;

/** Date de mise à jour d'une page (sitemap) : la validation de son synopsis compte. */
export const MAJ_SITE = `IF(${SYNOPSIS_VALIDE} AND synopsis_reviewed_at > updated_at, synopsis_reviewed_at, updated_at)`;
