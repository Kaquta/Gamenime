set -euo pipefail
cd /opt/stack/site
cp src/components/SectionBlock.astro "/opt/stack/backups/SectionBlock.astro.$(date +%Y%m%d-%H%M%S)"

python3 - <<'PY'
import sys, pathlib
p = pathlib.Path("src/components/SectionBlock.astro")
s = p.read_text(encoding="utf-8")
if "avecPage" in s:
    print("deja applique"); sys.exit(0)

paires = [
(
"""// Correspondance STRICTEMENT identique a loadSection() dans le <script>.""",
"""// Les pages de fiches ne sont generees que pour les items dont le synopsis
// atteint 150 caracteres (filtre de /feed/slugs). Un item sans page ne doit
// donc PAS recevoir de lien : l'URL n'existerait pas, et nginx y repond par
// la page d'accueil en 200 — Google indexerait un doublon de l'accueil.
const rSlugs = await fetch(`${API}/feed/slugs?type=all`);
if (!rSlugs.ok) throw new Error(`/feed/slugs a repondu ${rSlugs.status}`);
const avecPage = new Set<string>(
  ((await rSlugs.json()).items || []).map((i: any) => i.slug).filter(Boolean)
);
// renderCard ne pose un lien que si item.slug existe : on le neutralise pour
// les items sans page, et la carte redevient du texte simple.
const lisible = (i: any) => (i.slug && avecPage.has(i.slug) ? i : { ...i, slug: null });

// Correspondance STRICTEMENT identique a loadSection() dans le <script>."""
),
(""".map((i: any) => renderCard(i, source))""",      """.map((i: any) => renderCard(lisible(i), source))"""),
(""".map((i: any) => renderCard(i, dom))""",         """.map((i: any) => renderCard(lisible(i), dom))"""),
(""".map((i: any, k: number) => renderCard(i, dom, k + 1))""", """.map((i: any, k: number) => renderCard(lisible(i), dom, k + 1))"""),
(""".map((i: any) => renderCard(i, i._d))""",        """.map((i: any) => renderCard(lisible(i), i._d))"""),
]
for old, new in paires:
    n = s.count(old)
    if n != 1:
        print(f"STOP : ancre vue {n} fois\n       {old[:64]}"); sys.exit(1)
    s = s.replace(old, new)
tmp = p.with_suffix(".astro.tmp"); tmp.write_text(s, encoding="utf-8"); tmp.replace(p)
print("5 ancres appliquees")
PY

bash /opt/stack/scripts/build-staging.sh
