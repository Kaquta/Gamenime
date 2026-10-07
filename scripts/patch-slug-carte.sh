#!/usr/bin/env bash
set -euo pipefail
cd /opt/stack/site
S=$(date +%Y%m%d-%H%M%S)
mkdir -p /opt/stack/backups
for f in src/lib/fiche.ts src/components/SectionBlock.astro; do
  cp "$f" "/opt/stack/backups/$(basename $f).$S"
done
echo "sauvegardes : *.$S"

python3 - <<'PY'
import sys, pathlib

CARTE_OLD = """    ' data-id="' + item.id + '" data-domain="' + domain + '"' +"""
CARTE_NEW = """    ' data-id="' + item.id + '" data-domain="' + domain + '"' +
    ' data-slug="' + (item.slug || '') + '"' +"""

CLIC_OLD = """    var lienFiche = (e.target as HTMLElement).closest("a.item-link") as HTMLAnchorElement | null;
    if (lienFiche) {
      e.preventDefault();
      if (typeof (window as any).__gnUrlFiche === "function") {
        (window as any).__gnUrlFiche(lienFiche.getAttribute("href"));
      }
    }"""
CLIC_NEW = """    if ((e.target as HTMLElement).closest("a.item-link")) e.preventDefault();
    // L'URL doit suivre l'item quel que soit l'endroit clique sur la carte : le
    // titre est le seul <a> (pour Google), mais le modal s'ouvre aussi depuis la
    // jaquette. Le slug est donc lu sur la carte, pas sur le lien.
    var carteUrl = (e.target as HTMLElement).closest(".item-card") as HTMLElement | null;
    if (carteUrl && typeof (window as any).__gnUrlFiche === "function") {
      var sl = carteUrl.getAttribute("data-slug");
      var dm = carteUrl.getAttribute("data-domain") || "anime";
      (window as any).__gnUrlFiche(
        sl ? "/" + (dm.indexOf("anime") !== -1 ? "anime" : "games") + "/" + sl + "/" : null
      );
    }"""

travaux = [
  ("src/lib/fiche.ts",                  [(CARTE_OLD, CARTE_NEW)]),
  ("src/components/SectionBlock.astro", [(CARTE_OLD, CARTE_NEW), (CLIC_OLD, CLIC_NEW)]),
]
for chemin, paires in travaux:
    p = pathlib.Path(chemin); s = p.read_text(encoding="utf-8")
    if "data-slug" in s and chemin.endswith("fiche.ts"):
        print(f"{chemin:38} deja fait"); continue
    for old, new in paires:
        n = s.count(old)
        if n != 1:
            print(f"STOP {chemin} : ancre vue {n} fois")
            print("       " + old.strip().split("\n")[0][:70])
            sys.exit(1)
        s = s.replace(old, new)
    tmp = p.with_suffix(p.suffix + ".tmp"); tmp.write_text(s, encoding="utf-8"); tmp.replace(p)
    print(f"{chemin:38} ok")
PY

echo
echo "== Build"
npx astro build --outDir ./dist-staging 2>&1 | tail -3
echo
echo "== Marqueurs dans le bundle"
for m in data-slug gnModal popstate; do
  printf '  %-12s %s\n' "$m" "$(grep -ro "$m" dist-staging/_astro/*.js 2>/dev/null | wc -l | tr -d ' ')"
done
