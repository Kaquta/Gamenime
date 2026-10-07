#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
#  GameNime — tache gn-hd : images HD de « Cette semaine » et du coin
#
#  Lancee toutes les heures (minute 23) par la crontab de rey. Fait tourner
#  app/hd.py dans un conteneur jetable (image gn-hd:1) : 3 processeurs et
#  2 Go au plus, priorite basse (le site passe toujours d'abord), systeme de
#  fichiers en lecture seule sauf le dossier des images.
#  Ecrit les images et le manifeste dans /opt/stack/nginx/static/hd, servis
#  par nginx sur /hd/. Ne construit rien, ne promeut rien. Un seul passage a
#  la fois (le suivant attend l'heure d'apres).
#  Journal : /opt/stack/hd/journal.txt (les 2000 dernieres lignes environ).
#
#  A la main :  /opt/stack/hd/gn-hd.sh          puis  tail /opt/stack/hd/journal.txt
#               MAX=3 /opt/stack/hd/gn-hd.sh    (3 nouvelles images au plus)
# ══════════════════════════════════════════════════════════════════════════
set -uo pipefail
H=/opt/stack/hd
O=/opt/stack/nginx/static/hd
J=$H/journal.txt
exec 9>"$H/.verrou"
flock -n 9 || exit 0
N=$(nproc 2>/dev/null || echo 2)
C=$(( N > 4 ? 3 : (N > 1 ? N - 1 : 1) ))
{
  if ! docker image inspect gn-hd:1 >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') image gn-hd:1 absente : reconstruite"
    docker build -q -t gn-hd:1 "$H/image" >/dev/null || { echo "  impossible de reconstruire l'image"; exit 1; }
  fi
  docker run --rm --label gn=hd --cpus="$C" --cpu-shares=256 --memory=2g --pids-limit=256 \
    --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,size=64m \
    -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -e ORT_DISABLE_TELEMETRY=1 -e ESR_THREADS="$C" \
    -e MAX="${MAX:-0}" -e BUDGET="${BUDGET:-2700}" \
    -v /etc/localtime:/etc/localtime:ro -v "$H/app:/app:ro" -v "$H/modeles:/modeles:ro" -v "$O:/sortie" -w /app \
    gn-hd:1 python hd.py
  rc=$?
  [ "$rc" = 0 ] || echo "$(date '+%Y-%m-%d %H:%M:%S') le passage s'est arrete (code $rc)"
} >> "$J" 2>&1
n=$(wc -l < "$J" 2>/dev/null || echo 0)
if [ "$n" -gt 2500 ]; then tail -n 2000 "$J" > "$J.tmp" && mv "$J.tmp" "$J"; fi
exit 0
