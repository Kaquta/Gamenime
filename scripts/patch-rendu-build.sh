#!/usr/bin/env bash
# Les cartes sont rendues au build, pour que le HTML livre contienne enfin
# les liens vers les fiches. Le JS continue de recharger ensuite : un radar
# de sorties ne peut pas se figer a la date du build.
set -euo pipefail

cd /opt/stack/site
SRC="src/components/SectionBlock.astro"
BK="/opt/stack/backups/SectionBlock.astro.$(date +%Y%m%d-%H%M%S)"
mkdir -p /opt/stack/backups
cp "$SRC" "$BK"
echo "sauvegarde : $BK"

python3 - <<'PY'
import sys, pathlib
p = pathlib.Path("src/components/SectionBlock.astro")
s = p.read_text(encoding="utf-8")

if "rendu au build" in s:
    print("deja applique"); sys.exit(0)

paires = [
(
"""const { title, source, limit, href, kinds } = Astro.props;""",
"""import { renderCard } from "../lib/fiche";

const { title, source, limit, href, kinds } = Astro.props;

// Les cartes sont rendues ICI, au build, et plus seulement en JavaScript.
// Sans ca le HTML livre ne contient aucun lien vers les fiches : c'est la
// cause pour laquelle 935 pages restaient en « detectee, non indexee ».
// Le script plus bas recharge ensuite les memes zones, donc le catalogue
// reste vivant.
const API = "https://gamenime.fr/api";

async function feed(dom: "anime" | "games", params: Record<string, string>) {
  const r = await fetch(`${API}/feed/${dom}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`/feed/${dom} a repondu ${r.status}`);
  const d = await r.json();
  return Array.isArray(d.items) ? d.items : [];
}

// Correspondance STRICTEMENT identique a loadSection() dans le <script>.
// Toute divergence se verrait a l'oeil : les cartes changeraient au
// chargement de la page.
let cartes = "";
try {
  if (source === "anime" || source === "games") {
    const it = await feed(source, { status: "released", limit: "150", orderBy: "date" });
    cartes = (limit ? it.slice(0, limit) : it).map((i: any) => renderCard(i, source)).join("");
  } else if (source === "anime-upcoming" || source === "games-upcoming") {
    const dom = source === "anime-upcoming" ? "anime" : "games";
    const it = await feed(dom, { status: "upcoming", limit: "300", orderBy: "date" });
    cartes = (limit ? it.slice(0, limit) : it).map((i: any) => renderCard(i, dom)).join("");
  } else if (source === "top-anime" || source === "top-games") {
    const dom = source === "top-anime" ? "anime" : "games";
    const it = await feed(dom, { status: "released", limit: "25" });
    cartes = (limit ? it.slice(0, limit) : it).map((i: any, k: number) => renderCard(i, dom, k + 1)).join("");
  } else {
    const [a, g] = await Promise.all([
      feed("anime", { status: "upcoming", limit: "50", orderBy: "date" }),
      feed("games", { status: "upcoming", limit: "50", orderBy: "date" }),
    ]);
    const tout = [
      ...a.map((i: any) => ({ ...i, _d: "anime" })),
      ...g.map((i: any) => ({ ...i, _d: "games" })),
    ].sort((x: any, y: any) =>
      (x.releaseDate ? new Date(x.releaseDate).getTime() : 0) -
      (y.releaseDate ? new Date(y.releaseDate).getTime() : 0));
    cartes = (limit ? tout.slice(0, limit) : tout).map((i: any) => renderCard(i, i._d)).join("");
  }
} catch (e) {
  // Echec volontaire : construire la page sans ces liens reproduirait
  // silencieusement le bug qu'on corrige.
  throw new Error(`SectionBlock (${source}) : rendu au build impossible — ${e}`);
}"""
),
(
"""  <div class="items-row">
    <p class="section-loading">Chargement…</p>
  </div>""",
"""  <div class="items-row" set:html={cartes || '<p class="section-loading">Chargement…</p>'}></div>"""
),
(
"""  } catch (err) {
    console.error("Erreur " + source + ":", err);
    row.innerHTML = '<p class="section-empty">Impossible de charger les données.</p>';
  }""",
"""  } catch (err) {
    console.error("Erreur " + source + ":", err);
    // Les cartes rendues au build sont deja la : on n'efface que s'il n'y a
    // rien a perdre. Sans ce garde, une API momentanement muette effacerait
    // du contenu parfaitement valide.
    if (!row.querySelector(".item-card")) {
      row.innerHTML = '<p class="section-empty">Impossible de charger les données.</p>';
    }
  }"""
),
]

for old, new in paires:
    n = s.count(old)
    if n != 1:
        print(f"STOP : ancre vue {n} fois, attendu 1")
        print("       " + old.strip().split("\n")[0][:70])
        print("       Rien n'a ete ecrit.")
        sys.exit(1)
    s = s.replace(old, new)

tmp = p.with_suffix(".astro.tmp")
tmp.write_text(s, encoding="utf-8")
tmp.replace(p)
print("3 ancres appliquees")
PY

echo
echo "== Build staging"
if ! npx astro build --outDir ./dist-staging 2>&1 | tail -16; then
  echo; echo "ECHEC build. Restauration : cp $BK $SRC"; exit 1
fi

echo
echo "== LE chiffre : liens vers les fiches dans le HTML livre"
for f in anime games upcoming index; do
  d="dist-staging/$f/index.html"; [ "$f" = index ] && d="dist-staging/index.html"
  a=$(grep -o 'href="/anime/[^"]\+/"' "$d" 2>/dev/null | sort -u | wc -l | tr -d ' ')
  g=$(grep -o 'href="/games/[^"]\+/"' "$d" 2>/dev/null | sort -u | wc -l | tr -d ' ')
  printf '  %-9s anime %4s   jeux %4s   %7s o\n' "$f" "$a" "$g" "$(stat -c%s "$d" 2>/dev/null)"
done
