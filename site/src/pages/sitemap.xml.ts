/**
 * Sitemap genere au build depuis /feed/slugs.
 *
 * L'ancien etait ecrit a la main dans public/ et ne listait que quatre pages :
 * Google ne pouvait donc pas connaitre les fiches. Ici les 927 URL sont
 * produites a chaque build, avec leur date de mise a jour.
 */
import type { APIRoute } from "astro";

const SITE = "https://gamenime.fr";
const API = "https://gamenime.fr/api";

export const GET: APIRoute = async () => {
  const res = await fetch(`${API}/feed/slugs`);
  if (!res.ok) throw new Error(`/feed/slugs a repondu ${res.status}`);
  const { items } = await res.json();

  const statiques = [
    { loc: `${SITE}/`, freq: "daily", prio: "1.0" },
    { loc: `${SITE}/anime`, freq: "daily", prio: "0.9" },
    { loc: `${SITE}/games`, freq: "daily", prio: "0.9" },
    { loc: `${SITE}/upcoming`, freq: "daily", prio: "0.9" },
  ];

  const fiches = items.map((it: { slug: string; type: string; updatedAt: string }) => ({
    loc: `${SITE}/${it.type === "game" ? "games" : "anime"}/${it.slug}`,
    freq: "weekly",
    prio: "0.7",
    lastmod: it.updatedAt,
  }));

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    [...statiques, ...fiches]
      .map(
        (u: any) =>
          `  <url><loc>${u.loc}</loc>` +
          (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : "") +
          `<changefreq>${u.freq}</changefreq><priority>${u.prio}</priority></url>`
      )
      .join("\n") +
    "\n</urlset>\n";

  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
