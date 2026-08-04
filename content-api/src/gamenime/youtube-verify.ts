// ─────────────────────────────────────────────────────────────────────────
// Vérification YouTube : distingue un distributeur officiel (anime complet
// streamé légalement) d'une chaîne promo (PV/trailers).
//
// AniList étiquette "YouTube" sans préciser le distributeur. Jikan, lui, nomme
// correctement ("Muse Asia"). Ce module comble le trou d'AniList : pour un lien
// YouTube, on identifie la chaîne propriétaire via l'API YouTube et on renvoie
// le nom du distributeur officiel, ou null si c'est de la promo.
//
// Critère : une PLAYLIST appartenant à un distributeur whitelisté = vrai stream.
// Une chaîne @promo ou une vidéo unique (pas de playlist) = faux (PV).
// ─────────────────────────────────────────────────────────────────────────

// Distributeurs officiels qui streament l'anime COMPLET légalement sur YouTube.
// Le match est "includes" (insensible aux suffixes type "Asia", "Official").
const DISTRIBUTEURS_OFFICIELS = [
  "Muse Asia",
  "Ani-One Asia",
  "Ani-One",
  "Medialink",
  "MediaLink",
];

// Renvoie le nom du distributeur officiel si le lien YouTube en est un,
// sinon null (promo/PV à retirer).
// Décision B : en cas d'échec API (clé absente, quota, réseau), on renvoie
// "YouTube" tel quel (on ne retire pas sur un doute technique).
export async function resoudreDistributeurYouTube(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  // Décision A : sans playlist (chaîne @xxx ou vidéo unique) = promo = null.
  // Note : les chaînes /channel/UCxxx sans playlist sont aussi traitées ici —
  // on tente quand même de résoudre via la chaîne (voir plus bas).
  const plMatch = url.match(/[?&]list=([\w-]+)/);
  const chMatch = url.match(/\/channel\/([\w-]+)/);

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return "YouTube"; // Décision B : pas de clé -> garder tel quel

  try {
    let channelTitle = "";
    if (plMatch) {
      // Playlist -> chaîne propriétaire
      const r = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${plMatch[1]}&key=${key}`);
      if (!r.ok) return "YouTube"; // Décision B
      const d: any = await r.json();
      channelTitle = d?.items?.[0]?.snippet?.channelTitle || "";
    } else if (chMatch) {
      // Lien direct de chaîne /channel/UCxxx
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${chMatch[1]}&key=${key}`);
      if (!r.ok) return "YouTube"; // Décision B
      const d: any = await r.json();
      channelTitle = d?.items?.[0]?.snippet?.title || "";
    } else {
      // Ni playlist ni /channel/ (ex: /@handle ou /watch?v=) = promo (Décision A)
      return null;
    }

    if (!channelTitle) return null; // chaîne introuvable = on ne peut pas certifier = retirer
    const officiel = DISTRIBUTEURS_OFFICIELS.find(d => channelTitle.includes(d));
    return officiel || null; // nom du distributeur si officiel, sinon null (promo)
  } catch {
    return "YouTube"; // Décision B : erreur réseau -> garder tel quel
  }
}
