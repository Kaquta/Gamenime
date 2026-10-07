#!/usr/bin/env bash
# Ajoute release_precision a /feed/slugs : 103 fiches ont une date au
# millesime seul stockee en 01-01, qu'il ne faut pas afficher comme un jour.
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
grep -q 'release_precision' "$SRC" || { echo "STOP : release_precision introuvable"; exit 1; }
echo "release_precision  present ailleurs dans le fichier"

if grep -q 'AS releaseDate, release_precision AS releasePrecision,' "$SRC"; then
  echo "STOP : deja applique, rien a faire."
  exit 0
fi
echo "patch              pas encore applique"

REQ_AVANT=$(grep -c 'pool.query' "$SRC" || true)
SLUGS_AVANT=$(curl -fsS 'https://gamenime.fr/api/feed/slugs?type=all' | grep -o '"slug"' | wc -l | tr -d '[:space:]')
echo "requetes SQL       $REQ_AVANT"
echo "slugs servis       $SLUGS_AVANT"

titre "Patch"
python3 - <<'PY'
import sys, pathlib

p = pathlib.Path("src/gamenime/routes.ts")
s = p.read_text(encoding="utf-8")

paires = [
 ("releaseDate: string | null }> = await pool.query(",
  "releaseDate: string | null; releasePrecision: string | null }> = await pool.query("),

 ("SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish,\n"
  "                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate,",
  "SELECT CAST(id AS UNSIGNED) AS id, slug, title, title_english AS titleEnglish,\n"
  "                DATE_FORMAT(release_date, '%Y-%m-%d') AS releaseDate, release_precision AS releasePrecision,"),
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
  echo "STOP : requetes SQL $REQ_AVANT -> $REQ_APRES"
  cp "$BK" "$SRC"; echo "       restaure."
  exit 1
fi
echo "requetes SQL       $REQ_APRES, inchange"

titre "TypeScript"
if npx tsc --noEmit; then
  echo "types OK"
else
  echo; echo "ECHEC TypeScript. Rien deploye. Restauration :"; echo "  cp $BK $SRC"
  exit 1
fi

titre "Deploiement"
cd /opt/stack
docker compose build content-api
docker compose up -d content-api
for i in $(seq 1 20); do
  curl -fsS -o /dev/null 'https://gamenime.fr/api/feed/slugs?type=anime' && { echo "API repond apres ${i}s"; break; }
  sleep 1
  [ "$i" = 20 ] && { echo "STOP : API muette apres 20s — docker compose logs --tail=50 content-api"; exit 1; }
done

titre "Verification"
SLUGS_APRES=$(curl -fsS 'https://gamenime.fr/api/feed/slugs?type=all' | grep -o '"slug"' | wc -l | tr -d '[:space:]')
echo "slugs servis       $SLUGS_AVANT -> $SLUGS_APRES"

curl -fsS 'https://gamenime.fr/api/feed/slugs?type=all' | python3 -c "
import sys, json, collections
d = json.load(sys.stdin)
if 'releasePrecision' not in d['items'][0]:
    print('CHAMP MANQUANT releasePrecision'); sys.exit(1)
c = collections.Counter(it.get('releasePrecision') or 'null' for it in d['items'])
print('repartition des precisions :')
for k, n in c.most_common():
    print(f'  {k:10} {n}')
print()
print('fiches hors fenetre 2026-2027 :')
for it in d['items']:
    rd = it.get('releaseDate') or ''
    if rd[:4] not in ('2026', '2027'):
        print(f\"  {it['type']:5} id={it['id']:<6} {rd}  prec={it.get('releasePrecision')}  {it['title'][:48]}\")
"

titre "Les autres feeds doivent repondre 200"
for q in 'feed/anime?limit=1' 'feed/games?limit=1' 'feed/search?q=chainsaw&type=all'; do
  printf '%-34s %s\n' "$q" "$(curl -s -o /dev/null -w '%{http_code}' "https://gamenime.fr/api/$q")"
done

titre "Termine"
echo "Sauvegarde : $BK"
