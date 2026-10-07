#!/usr/bin/env bash
# Retire les icones inventees par la refonte, supprime le CTA et le lien
# Planning, rend toute la diapo cliquable vers la modale.
set -euo pipefail

F=/opt/stack/site/src/components/WeekRadar.astro
BK="/opt/stack/backups/WeekRadar.astro.$(date +%Y%m%d-%H%M%S)"
mkdir -p /opt/stack/backups
cp "$F" "$BK"; echo "sauvegarde : $BK"

PYRC=0
python3 - "$F" <<'PYEOF' || PYRC=$?
import re, sys

f = sys.argv[1]
s = open(f, encoding="utf-8").read()
faits, rates = [], []

def rm_regle(txt, sel):
    """Supprime une regle CSS entiere par son selecteur, accolades equilibrees."""
    m = re.search(r'^[ \t]*' + re.escape(sel) + r'\s*\{', txt, re.M)
    if not m:
        return txt, False
    i = txt.index("{", m.start()); d = 0; j = i
    while j < len(txt):
        if txt[j] == "{": d += 1
        elif txt[j] == "}":
            d -= 1
            if d == 0: break
        j += 1
    fin = j + 1
    while fin < len(txt) and txt[fin] in " \t": fin += 1
    if fin < len(txt) and txt[fin] == "\n": fin += 1
    return txt[:m.start()] + txt[fin:], True

# ───── 1. le pictogramme calendrier ─────
n = len(s); s = re.sub(r'<span class="sem-em">[^<]*</span>\s*', '', s)
faits.append("picto calendrier retire") if len(s) != n else rates.append("sem-em (deja absent ?)")

# ───── 2. le lien Planning (la page n'existe pas) ─────
lignes = [l for l in s.split("\n") if 'class="sem-voir"' not in l]
if len(lignes) != len(s.split("\n")):
    s = "\n".join(lignes); faits.append("lien Planning retire")
else:
    rates.append("sem-voir (deja absent ?)")

# ───── 3. le bloc actions : CTA + bouton favori ─────
ancre = "'<div class=\"sem-act\">'"
if ancre in s:
    i = s.index(ancre)
    deb = s.rindex("\n", 0, i) + 1
    j = s.index("'</div>'", i)
    fin = s.index("\n", j) + 1
    s = s[:deb] + s[fin:]
    faits.append("bloc actions retire (CTA + favori)")
else:
    rates.append("bloc sem-act introuvable")

# ───── 4. le titre porte le vrai lien ─────
vieux = "'<h3 class=\"sem-t\">' + esc(displayTitle(e)) + '</h3>'"
neuf  = ("'<h3 class=\"sem-t\">' + (lien ? '<a href=\"' + lien + '\">' "
         "+ esc(displayTitle(e)) + '</a>' : esc(displayTitle(e))) + '</h3>'")
if vieux in s:
    s = s.replace(vieux, neuf, 1); faits.append("titre transforme en lien interne")
elif neuf in s:
    faits.append("titre deja en lien")
else:
    rates.append("ligne du titre introuvable")

# ───── 5. toute la diapo ouvre la modale ─────
s = s.replace("  // Secours quand la fiche n'a pas de slug : la modale du catalogue.\n", "")
H = '''  // Un clic n'importe ou sur la diapo ouvre la modale. Le titre reste un vrai
  // lien : clic milieu, ctrl/cmd et les robots suivent la fiche normalement.
  E("semPiste").addEventListener("click", (ev) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const art = ev.target.closest(".sem-ep");
    if (!art) return;
    if (typeof window.__openItemModal !== "function") return;
    ev.preventDefault();
    window.__openItemModal(Number(art.dataset.id), "anime");
  });
'''
s2, k = re.subn(r'  E\("semPiste"\)\.addEventListener\("click",.*?\n  \}\);\n', H, s, count=1, flags=re.S)
if k:
    s = s2; faits.append("diapo entiere cliquable")
else:
    rates.append("gestionnaire de clic introuvable")

# ───── 6. pause/lecture dessinees en CSS ─────
s2, k = re.subn(r'(id="semPP"[^>]*>)</button>', r'\1<i></i></button>', s, count=1)
if k: s = s2; faits.append("bouton pause : <i> ajoute")
s2, k = re.subn(r'[ \t]*E\("semPP"\)\.textContent\s*=[^\n]*\n',
                '  E("semPP").classList.toggle("joue", pauseUtil);\n', s, count=1)
if k: s = s2; faits.append("pause : caracteres remplaces par du CSS")
elif '.classList.toggle("joue"' in s: faits.append("pause deja en CSS")
else: rates.append("ligne textContent du semPP introuvable")

# ───── 7. le CSS devenu mort ─────
for sel in [".sem-em", ".sem-voir", ".sem-voir:hover", ".sem-voir",
            ".sem-act", ".sem-cta", ".sem-cta:hover", ".sem-fav", ".sem-fav:hover"]:
    s, ok = rm_regle(s, sel)
    if ok: faits.append("CSS " + sel + " supprime")

# ───── 8. le CSS a ajouter ─────
AJOUT = """
  /* Le titre porte le lien, la diapo entiere est cliquable. */
  .sem-ep { cursor: pointer; }
  .sem-t a { color: inherit; text-decoration: none; }
  .sem-t a:hover { text-decoration: underline; text-decoration-color: rgba(255, 140, 58, .75); text-underline-offset: 4px; }

  /* Pause et lecture dessinees : aucune nouvelle icone n'entre dans le site. */
  .sem-pp i { display: block; width: 8px; height: 10px; border-left: 3px solid #fff; border-right: 3px solid #fff; }
  .sem-pp.joue i {
    width: 0; height: 0; border: none; margin-left: 2px;
    border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 8px solid #fff;
  }
"""
GARDE = """
  /* [hidden] ne resiste pas a un display explicite : on tranche. */
  .sem[hidden], .sem [hidden] { display: none !important; }
"""
if ".sem-pp i {" not in s:
    s = s.replace("</style>", AJOUT + "</style>", 1); faits.append("CSS du clic et de la pause ajoute")
if ".sem[hidden]" not in s:
    s = s.replace("</style>", GARDE + "</style>", 1); faits.append("garde [hidden] ajoute")

print("— applique —")
for x in faits: print("   ok   " + x)
if rates:
    print("— non applique —")
    for x in rates: print("   RATE " + x)

open(f, "w", encoding="utf-8").write(s)
sys.exit(2 if rates else 0)
PYEOF
if [ "$PYRC" = 2 ]; then
  echo; echo "STOP : au moins une ancre est introuvable, le fichier a ete ecrit mais verifie la liste ci-dessus"
fi

echo
echo "═══ Verification : quels pictogrammes restent ? ═══"
python3 -c "
import sys, unicodedata
for n,l in enumerate(open(sys.argv[1], encoding='utf-8'),1):
    if l.lstrip().startswith(('//','/*','*')): continue
    p=[c for c in l if ord(c)>0x2000 and unicodedata.category(c) in ('So','Sk','Sm') and c not in '═']
    if p: print('   l.%-4d %s   %s' % (n, ''.join(p), l.strip()[:80]))
" "$F"

echo
echo "═══ Verification : les traces mortes ═══"
for m in "Voir la fiche" "Planning" "sem-fav" "sem-cta" "sem-em" "sem-act" "sem-voir" "fav-heart"; do
  printf "   %-16s %s\n" "$m" "$(grep -c -- "$m" "$F" || true)"
done
echo "   lignes totales : $(wc -l < "$F")"

echo
echo
echo "═══════════════ CE QU'IL ME MANQUE POUR LA GRILLE ═══════════════"
cd /opt/stack/site/src

echo "─── index.astro, en entier ───"
cat -n pages/index.astro

echo
echo "─── SectionBlock : ses props et sa source de donnees ───"
sed -n '1,70p' components/SectionBlock.astro

echo
echo "─── ce que lib/api.ts expose ───"
grep -n "^export" lib/api.ts || echo "  (aucun export trouve)"

echo
echo "─── les pictogrammes deja employes par le site ───"
python3 - <<'PYEOF'
import os, unicodedata
PICTO = lambda c: ord(c) > 0x2000 and unicodedata.category(c) in ("So","Sk","Sm")
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in (".astro","node_modules")]
    for fn in sorted(files):
        if not fn.endswith((".astro",".ts",".js",".css")): continue
        p = os.path.join(root, fn); trouve = {}
        for n, l in enumerate(open(p, encoding="utf-8", errors="replace"), 1):
            if l.lstrip().startswith(("//","/*","*")): continue
            for c in l:
                if PICTO(c) and c not in "═─│┌┐└┘": trouve.setdefault(c, []).append(n)
        if trouve:
            print("  " + p)
            for c, lg in trouve.items():
                print("      %-3s U+%04X  x%-3d  l.%s" % (c, ord(c), len(lg), ",".join(map(str, lg[:6]))))
PYEOF

echo
echo "─── le bouton favori tel qu'il existe deja ───"
grep -rn "fav-heart\|data-fav" --include=*.astro --include=*.ts . | head -12 || true
