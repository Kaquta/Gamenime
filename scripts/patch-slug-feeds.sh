#!/usr/bin/env bash
# Expose le slug dans /feed/anime, /feed/games, /feed/home et /feed/search,
# pour que renderCard puisse construire href="/anime/mon-slug/".
# applyDisplayStripToItems fait un spread : le champ traverse sans autre patch.
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
if grep -q 'AS id, slug, title, title_english AS titleEnglish, cover' "$SRC"; then
  echo "STOP : deja applique."
  exit 0
fi
REQ_AVANT=$(grep -c 'pool.query' "$SRC" || true)
echo "requetes SQL   $REQ_AVANT"
for e in anime games home; do
  printf 'feed/%-6s      %s\n' "$e" "$(curl -s -o /dev/null -w '%{http_code}' "https://gamenime.fr/api/feed/$e?limit=1")"
done

titre "Patch"
python3 - <<'PY'
import sys, pathlib
p = pathlib.Path("src/gamenime/routes.ts")
s = p.read_text(encoding="utf-8")

# Chaque motif doit apparaitre exactement 2 fois : la version anime et la
# version jeux. Les requetes qui s'arretent a "platform," sont volontairement
# exclues par la presence de "description, rating," dans l'ancre.
paires = [
 (2, "SELECT CAST(id AS UNSIGNED) AS id, title, title_english AS titleEnglish, cover, genre, platform, description, rating,",
     "SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish, cover, genre, platform, description, rating,"),
 (2, "SELECT id, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,",
     "SELECT id, slug, title, title_english AS titleEnglish, cover, genre, platform, description, rating, rating_score AS ratingScore, popularity, screenshots,"),
]
for attendu, old, new in paires:
    n = s.count(old)
    if n != attendu:
        print(f"STOP : motif vu {n} fois, attendu {attendu}")
        print("       " + old[:72])
        sys.exit(1)
    s = s.replace(old, new)

tmp = p.with_suffix(".ts.tmp")
tmp.write_text(s, encoding="utf-8")
tmp.replace(p)
print("4 requetes patchees : 2 feeds + 2 recherche")
PY

titre "Controles"
REQ_APRES=$(grep -c 'pool.query' "$SRC" || true)
if [ "$REQ_AVANT" != "$REQ_APRES" ]; then
  echo "STOP : requetes SQL $REQ_AVANT -> $REQ_APRES"; cp "$BK" "$SRC"; echo "       restaure."; exit 1
fi
echo "requetes SQL   $REQ_APRES, inchange"
echo "sosies intacts $(grep -c 'AS id, title, title_english AS titleEnglish, cover, genre, platform,$' "$SRC" || true) requete(s) laissee(s) telle(s) quelle(s)"

titre "TypeScript"
if npx tsc --noEmit; then echo "types OK"; else
  echo; echo "ECHEC. Rien deploye. Restauration :"; echo "  cp $BK $SRC"; exit 1
fi

titre "Deploiement"
cd /opt/stack
docker compose build content-api
docker compose up -d content-api
for i in $(seq 1 20); do
  curl -fsS -o /dev/null 'https://gamenime.fr/api/feed/anime?limit=1' && { echo "API repond apres ${i}s"; break; }
  sleep 1
  [ "$i" = 20 ] && { echo "STOP : API muette. docker compose logs --tail=50 content-api"; exit 1; }
done

titre "Verification"
for q in 'feed/anime?limit=1' 'feed/games?limit=1' 'feed/home' 'feed/search?q=chainsaw&type=all' 'feed/slugs?type=anime'; do
  r=$(curl -s "https://gamenime.fr/api/$q")
  printf '%-34s slug:%s  http:%s\n' "$q" \
    "$(echo "$r" | grep -c '"slug"' | tr -d ' ')" \
    "$(curl -s -o /dev/null -w '%{http_code}' "https://gamenime.fr/api/$q")"
done

titre "Echantillon"
curl -s 'https://gamenime.fr/api/feed/games?limit=1' | head -c 300
echo

titre "Termine"
echo "Sauvegarde : $BK"
