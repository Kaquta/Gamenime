#!/usr/bin/env bash
# Le titre de chaque carte devient un lien vers sa fiche.
# Rien ne change a l'oeil : color inherit, pas de soulignement, grille intacte.
set -euo pipefail

cd /opt/stack/site
S=$(date +%Y%m%d-%H%M%S)
mkdir -p /opt/stack/backups
titre() { printf '\n== %s\n' "$1"; }

titre "Sauvegardes"
for f in src/lib/fiche.ts src/lib/api.ts src/components/SectionBlock.astro src/styles/global.css; do
  cp "$f" "/opt/stack/backups/$(basename $f).$S"
done
echo "/opt/stack/backups/*.$S"

titre "Patch"
python3 - <<'PY'
import sys, pathlib

GABARIT_OLD = "    '<h3>' + displayTitle(item) + '</h3>' +"
GABARIT_NEW = (
  "    // Le titre porte le lien vers la fiche : HTML valide, invisible a l'oeil,\n"
  "    // sans effet sur la grille, et le texte d'ancrage est le titre de l'oeuvre.\n"
  "    // Le coeur et les bandes du trailer restent hors du <a>, donc aucun clic\n"
  "    // sur eux ne peut declencher de navigation.\n"
  "    '<h3>' + (item.slug\n"
  "      ? '<a class=\"item-link\" href=\"/' + (String(domain).indexOf(\"anime\") !== -1 ? 'anime' : 'games') + '/' + item.slug + '/\">' + displayTitle(item) + '</a>'\n"
  "      : displayTitle(item)) + '</h3>' +"
)

CLIC_OLD = '    if ((e.target as HTMLElement).closest(".trailer-band")) return; // bande geree separement'
CLIC_NEW = (
  '    // Le titre est un vrai lien : on annule la navigation AVANT les sorties\n'
  '    // ci-dessous, pour que le modal s\'ouvre au lieu de changer de page.\n'
  '    if ((e.target as HTMLElement).closest("a.item-link")) e.preventDefault();\n'
  + CLIC_OLD
)

TYPE_OLD = "  popularity?: number;\n  screenshots?: string | null;\n}"
TYPE_NEW = "  popularity?: number;\n  screenshots?: string | null;\n  slug?: string | null;\n}"

travaux = [
  ("src/lib/fiche.ts",                   [(GABARIT_OLD, GABARIT_NEW)],                 "item-link"),
  ("src/components/SectionBlock.astro",  [(GABARIT_OLD, GABARIT_NEW), (CLIC_OLD, CLIC_NEW)], "item-link"),
  ("src/lib/api.ts",                     [(TYPE_OLD, TYPE_NEW)],                       "slug?: string | null"),
]

for chemin, paires, deja in travaux:
    p = pathlib.Path(chemin)
    s = p.read_text(encoding="utf-8")
    if deja in s:
        print(f"{chemin:38} deja fait")
        continue
    for old, new in paires:
        n = s.count(old)
        if n != 1:
            print(f"STOP {chemin} : ancre vue {n} fois\n       {old[:70]}")
            sys.exit(1)
        s = s.replace(old, new)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    tmp.replace(p)
    print(f"{chemin:38} ok")

# le style : ajoute en fin de fichier, aucune regle existante touchee
p = pathlib.Path("src/styles/global.css")
s = p.read_text(encoding="utf-8")
if ".item-link" in s:
    print(f"{'src/styles/global.css':38} deja fait")
else:
    s += (
      "\n/* Titre de carte devenu lien vers la fiche : doit rester visuellement\n"
      "   identique au texte qu'il remplace. */\n"
      ".item-body h3 .item-link,\n"
      ".item-link {\n"
      "  color: inherit;\n"
      "  text-decoration: none;\n"
      "}\n"
    )
    p.write_text(s, encoding="utf-8")
    print(f"{'src/styles/global.css':38} ok")
PY

titre "Build staging"
npx astro build --outDir ./dist-staging 2>&1 | tail -4

titre "Verification"
echo "le gabarit est-il identique dans les deux fichiers ?"
diff <(grep -A6 "'<h3>' + (item.slug" src/lib/fiche.ts) \
     <(grep -A6 "'<h3>' + (item.slug" src/components/SectionBlock.astro) \
  && echo "  identiques"

echo
echo "liens dans le JS livre (le gabarit, pas les cartes) :"
grep -ro 'item-link' dist-staging/_astro/*.js 2>/dev/null | wc -l

echo
echo "le catalogue n'a pas change de poids :"
for f in anime games; do
  printf '  %-7s %s o\n' "$f" "$(stat -c%s dist-staging/$f/index.html)"
done
