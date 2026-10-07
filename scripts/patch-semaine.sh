#!/usr/bin/env bash
# Patch : slug dans /feed/week + refonte WeekRadar.
# Le composant est ecrit a part ; ici on verifie qu'il est en place, on patche
# l'API, on reconstruit, puis on demande un build staging et on verifie que le
# rapport a vraiment ete reecrit.
set -euo pipefail

# ═══ 0. Le composant doit etre en place AVANT de reconstruire ═══
C=/opt/stack/site/src/components/WeekRadar.astro
L=$(wc -l < "$C")
grep -q 'sem\[hidden\], .sem \[hidden\]' "$C" && [ "$L" -gt 300 ] \
  || { echo "STOP : WeekRadar.astro n'est pas la version refondue ($L lignes)"; exit 1; }
echo "composant en place : $L lignes"

# ═══ 1. L'API : le slug dans /feed/week ═══
cd /opt/stack/content-api/src/gamenime
python3 - <<'PYEOF'
import shutil, sys
f = "routes.ts"; s = open(f, encoding="utf-8").read()
if "slug: item.slug" in s:
    print("routes.ts : deja patche"); sys.exit(0)

A1 = "        `SELECT id, title, title_english AS titleEnglish, cover, platform,"
if A1 not in s:
    print("ERREUR : le SELECT de /feed/week est introuvable"); sys.exit(1)
s = s.replace(A1, "        `SELECT id, slug, title, title_english AS titleEnglish, cover, platform,", 1)

A2 = """      days[idx].episodes.push({
        id: item.id,
        title: item.title,"""
if A2 not in s:
    print("ERREUR : la construction de l'episode est introuvable"); sys.exit(1)
s = s.replace(A2, """      days[idx].episodes.push({
        id: item.id,
        // Le slug permet un vrai lien vers la fiche depuis l'accueil, au lieu
        // d'ouvrir seulement la modale : autant de liens internes que d'episodes.
        slug: item.slug ?? null,
        title: item.title,""", 1)

shutil.copy2(f, f + ".bak-week-slug")
open(f, "w", encoding="utf-8").write(s)
print("routes.ts : slug ajoute au flux de la semaine")
PYEOF

# ═══ 2. Build API + redemarrage ═══
cd /opt/stack
LOG=/tmp/gn-sem-build.log
if ! docker compose build content-api > "$LOG" 2>&1; then
  tail -20 "$LOG"; echo "STOP : build API echoue"; exit 1
fi
docker compose up -d content-api

PRET=0
for i in $(seq 1 20); do
  if docker exec content-api node -e 'fetch("http://localhost:3000/feed/week").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    echo "API repond (${i}s)"; PRET=1; break
  fi
  sleep 1
done
[ "$PRET" = 1 ] || { echo "STOP : /feed/week muet apres 20s"; docker compose logs --tail=40 content-api; exit 1; }

# ═══ 3. Le slug arrive-t-il vraiment ═══
echo "— le slug dans le flux —"
docker exec content-api node -e '
  fetch("http://localhost:3000/feed/week").then(r => r.json()).then(d => {
    const eps = (d.days || []).flatMap(x => x.episodes || []);
    if (eps.length === 0) { console.log("  AVERTISSEMENT : aucun episode cette semaine"); process.exit(0); }
    const avec = eps.filter(e => e.slug).length;
    console.log("  episodes:", eps.length, "| avec slug:", avec);
    console.log("  exemple :", JSON.stringify({ t: String(eps[0].title || "").slice(0,30), slug: eps[0].slug, ep: eps[0].episodeNumber }));
    if (avec === 0) { console.error("STOP : aucun episode n a de slug, le patch a echoue"); process.exit(1); }
  }).catch(e => { console.error("STOP fetch :", e.message); process.exit(1); });
' || { echo "STOP : verification du slug echouee"; exit 1; }

# ═══ 4. Build staging via le pipeline systemd ═══
echo "— demande de build staging —"
if systemctl is-active --quiet gn-build.service; then
  echo "  un build est deja en cours, on attend sa fin"
  for i in $(seq 1 900); do systemctl is-active --quiet gn-build.service || break; sleep 1; done
  systemctl is-active --quiet gn-build.service && { echo "STOP : build toujours en cours apres 15 min"; exit 1; }
fi

RAP=/opt/stack/site/.build-report/report.json
AVANT=$( [ -f "$RAP" ] && stat -c %Y "$RAP" || echo 0 )

touch /opt/stack/site/.publish/demande-build \
  || { echo "STOP : impossible de deposer le flag (droits sur .publish ?)"; exit 1; }

CONSOMME=0
for i in $(seq 1 900); do
  if [ ! -e /opt/stack/site/.publish/demande-build ]; then
    CONSOMME=1; echo "  flag consomme apres ${i}s"; break
  fi
  sleep 1
done
[ "$CONSOMME" = 1 ] || { echo "STOP : flag non consomme apres 15 min"; journalctl -u gn-build.path -n 30 --no-pager; exit 1; }

for i in $(seq 1 900); do
  case "$(systemctl show -p ActiveState --value gn-build.service)" in
    inactive|failed) [ "$i" -gt 2 ] && break ;;
  esac
  sleep 1
done
R=$(systemctl show -p Result --value gn-build.service)
case "$R" in
  success|"") : ;;
  *) echo "STOP : gn-build.service Result=$R"; journalctl -u gn-build.service -n 50 --no-pager; exit 1 ;;
esac

APRES=$( [ -f "$RAP" ] && stat -c %Y "$RAP" || echo 0 )
[ "$APRES" -gt "$AVANT" ] || { echo "STOP : le rapport n'a pas ete reecrit (mtime inchange)"; exit 1; }

echo
echo "— 14 dernieres lignes du build —"
tail -14 /opt/stack/site/.build-report/build.log

echo
echo "— verdict —"
python3 -c "
import json
d = json.load(open('$RAP'))
print('  promouvable :', d.get('promouvable'))
print('  alertes     :', d.get('alertes') or 'aucune')
print('  staging     :', d.get('staging'))
"
echo
echo "A regarder : https://staging.gamenime.fr/"
