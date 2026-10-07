set -euo pipefail
CONF=/opt/stack/nginx/conf.d/site.conf
cp "$CONF" "/opt/stack/backups/site.conf.$(date +%Y%m%d-%H%M%S)"

python3 - <<'PY'
import sys, pathlib
p = pathlib.Path("/opt/stack/nginx/conf.d/site.conf")
s = p.read_text(encoding="utf-8")
if "soft 404" in s:
    print("deja applique"); sys.exit(0)

old = """  location / {
    try_files $uri $uri/ /index.html;"""
new = """  # Les fiches sont des fichiers reels. Une URL inconnue sous /anime/ ou
  # /games/ doit repondre 404, pas la page d'accueil : sinon Google indexe
  # autant de doublons de l'accueil qu'il existe d'adresses inventees
  # (« soft 404 »). Le motif exige un segment apres le domaine, donc
  # /anime/ et /games/ eux-memes ne sont pas concernes.
  location ~ ^/(anime|games)/[^/]+/ {
    try_files $uri $uri/ =404;
    add_header Cache-Control "no-cache, must-revalidate";
    include /etc/nginx/snippets/security-headers.conf;
  }

  location / {
    try_files $uri $uri/ /index.html;"""

n = s.count(old)
if n not in (1, 2):
    print(f"STOP : ancre vue {n} fois, attendu 1 ou 2"); sys.exit(1)
p.write_text(s.replace(old, new), encoding="utf-8")
print(f"{n} bloc(s) serveur traite(s)")
PY

docker exec web nginx -t && docker exec web nginx -s reload
sleep 2
echo
echo "=========== verification ==========="
printf 'adresse inventee  -> %s  (doit etre 404)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://gamenime.fr/anime/ceci-nexiste-vraiment-pas-999999/')"
printf 'fiche reelle      -> %s  (doit etre 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://gamenime.fr/anime/overgeared-21094/')"
printf 'catalogue /anime/ -> %s  (doit etre 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://gamenime.fr/anime/')"
printf 'accueil           -> %s  (doit etre 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://gamenime.fr/')"
printf 'une page legale   -> %s  (doit etre 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://gamenime.fr/mentions-legales/')"
