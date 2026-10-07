#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# patch-feed-slugs.sh
# Ajoute title, title_english et release_date au SELECT de /feed/slugs.
# Purement additif : sitemap.xml.ts et [slug].astro ne lisent que id, slug
# et updatedAt, et ignorent les champs supplementaires.
# ---------------------------------------------------------------------------
set -euo pipefail

API=/opt/stack/content-api
SRC="$API/src/gamenime/routes.ts"
BK="/opt/stack/backups/routes.ts.$(date +%Y%m%d-%H%M%S)"

titre() { printf '\n== %s\n' "$1"; }

cd "$API"

titre "Sauvegarde"
mkdir -p /opt/stack/backups
cp "$SRC" "$BK"
echo "$BK"

titre "Garde-fous"
if ! grep -q 'release_date' "$SRC"; then
  echo "STOP : la colonne release_date est introuvable dans routes.ts."
  echo "       Elle s'appelle peut-etre autrement — le SQL casserait a l'execution."
  exit 1
fi
echo "release_date  present"

if grep -q 'AS id, slug, title, title_english AS titleEnglish,' "$SRC"; then
  echo "STOP : le patch est deja applique, rien a faire."
  exit 0
fi
echo "patch         pas encore applique"

REQ_AVANT=$(grep -c 'pool.query' "$SRC" || true)
echo "requetes SQL  $REQ_AVANT avant patch"

SLUGS_AVANT=$(curl -fsS 'https://gamenime.fr/api/feed/slugs?type=all' \
  | grep -o '"slug"' | wc -l | tr -d '[:space:]')
echo "slugs servis  $SLUGS_AVANT avant patch"

titre "Patch"
python3 - <<'PY'
import sys, pathlib

p = pathlib.Path("src/gamenime/routes.ts")
s = p.read_text(encoding="utf-8")

paires = [
 ("const rows: Array<{ id: number; slug: string; updatedAt: string }> = await pool.query(",
  "const rows: Array<{ id: number; slug: string; updatedAt: string; title: string; titleEnglish: string | null; releaseDate: string | null }> = await pool.query("),

 ("SELECT CAST(id AS UNSIGNED) AS id, slug, DATE_FORMAT(updated_at, '%Y-%m-%d') AS updatedAt",
  "SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish,\n"
  "                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,\n"
  "                DATE_FORMAT(updated_at, '%Y-%m-%d') AS updatedAt"),
]

for old, new in paires:
    n = s.count(old)
    if n != 1:
        print(f"STOP : motif trouve {n} fois, attendu exactement 1")
        print("       " + old[:72])
        sys.exit(1)
    s = s.replace(old, new)

tmp = p.with_suffix(".ts.tmp")
tmp.write_text(s, encoding="utf-8")
tmp.replace(p)
print("2 remplacements appliques")
PY

titre "Controles"
REQ_APRES=$(grep -c 'pool.query' "$SRC" || true)
if [ "$REQ_AVANT" != "$REQ_APRES" ]; then
  echo "STOP : le nombre de requetes SQL a change ($REQ_AVANT -> $REQ_APRES)."
  cp "$BK" "$SRC"
  echo "       routes.ts restaure depuis la sauvegarde."
  exit 1
fi
echo "requetes SQL  $REQ_APRES, inchange"
echo "colonnes      $(grep -c 'AS id, slug, title, title_english AS titleEnglish,' "$SRC") occurrence(s) ajoutee(s)"

titre "TypeScript"
if npx tsc --noEmit; then
  echo "types OK"
else
  echo
  echo "ECHEC TypeScript. Rien n'a ete deploye. Pour revenir en arriere :"
  echo "  cp $BK $SRC"
  exit 1
fi

titre "Deploiement"
cd /opt/stack
docker compose build content-api
docker compose up -d content-api

echo "attente du demarrage…"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null 'https://gamenime.fr/api/feed/slugs?type=anime'; then
    echo "API repond apres ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = 20 ]; then
    echo "STOP : l'API ne repond plus apres 20s."
    echo "       docker compose logs --tail=50 content-api"
    exit 1
  fi
done

titre "Verification"
SLUGS_APRES=$(curl -fsS 'https://gamenime.fr/api/feed/slugs?type=all' \
  | grep -o '"slug"' | wc -l | tr -d '[:space:]')
echo "slugs servis  $SLUGS_AVANT avant  ->  $SLUGS_APRES apres"
if [ "$SLUGS_AVANT" != "$SLUGS_APRES" ]; then
  echo "ATTENTION : le nombre de fiches a change. Le filtre a peut-etre bouge."
fi

for champ in '"title"' '"titleEnglish"' '"releaseDate"' '"slug"' '"updatedAt"'; do
  if curl -fsS 'https://gamenime.fr/api/feed/slugs?type=anime' | grep -q "$champ"; then
    echo "champ present $champ"
  else
    echo "CHAMP MANQUANT $champ"
  fi
done

titre "Echantillon"
curl -fsS 'https://gamenime.fr/api/feed/slugs?type=anime' | head -c 460
echo
echo

titre "Les autres feeds doivent repondre 200"
for u in anime games search; do
  case "$u" in
    search) q='https://gamenime.fr/api/feed/search?q=chainsaw&type=all' ;;
    *)      q="https://gamenime.fr/api/feed/$u?limit=1" ;;
  esac
  printf '%-8s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$q")"
done

titre "Termine"
echo "Sauvegarde conservee : $BK"
