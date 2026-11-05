#!/usr/bin/env bash
# ==========================================================================
#  GameNime - tache gn-apercu : la vitre animee de l'apercu du lien dans Discord
#
#  Lancee toutes les 10 minutes par la crontab de rey. La plupart du temps elle
#  ne fait rien (elle lit quelques dates). Elle refait le GIF apres chaque
#  publication et une fois par jour (Cette semaine), dans un conteneur jetable
#  (image gn-apercu:1) : 2 processeurs et 1,5 Go au plus, priorite basse (le
#  site passe toujours d'abord), systeme de fichiers en lecture seule : il
#  n'ecrit rien sur le serveur et rend le GIF sur sa sortie. Un passage dure
#  environ une minute. Le GIF est ensuite verifie ici, hors du conteneur, puis mis dans
#  /opt/stack/nginx/static/apercu avec la page du robot de Discord
#  (discord.html, faite ici a partir de l'accueil en ligne). nginx ne sert de ce
#  dossier que les GIF ; le robot de Discord recoit discord.html a la place de
#  l'accueil (regle de site.conf) ; sans discord.html, il recoit l'accueil
#  normal et son image fixe.
#  Ne touche ni au site, ni a nginx, ni a l'API. Un seul passage a la fois.
#  Journal : /opt/stack/apercu/journal.txt (les 2000 dernieres lignes environ).
#
#  A la main :  /opt/stack/apercu/apercu.sh etat         ce qui est en service
#               /opt/stack/apercu/apercu.sh essai        un apercu d'essai, sur le staging
#               /opt/stack/apercu/apercu.sh maintenant   refaire le GIF de Discord tout de suite
#               /opt/stack/apercu/apercu.sh arret        Discord revient a l'image fixe
#               /opt/stack/apercu/apercu.sh marche       remettre la tache en marche
# ==========================================================================
set -uo pipefail
# la crontab lance avec un PATH reduit : les dossiers habituels, en plus
export PATH="${PATH:-/usr/bin:/bin}:/usr/local/bin:/usr/bin:/bin"
H=${GN_ST:-/opt/stack}/apercu
J=$H/journal.txt
M=${1:-auto}
# lecture seule : sans attendre le verrou
case "$M" in
  etat|resume) exec python3 -I "$H/tache.py" "$M" ;;
esac
exec 9>"$H/.verrou"
if [ "$M" = auto ]; then
  flock -n 9 || exit 0
elif ! flock -n 9; then
  # a la main : attendre la fin du passage en cours (15 minutes au plus)
  echo "Un passage tourne deja : attente de sa fin (15 minutes au plus)..."
  flock -w 900 9 || { echo "Toujours occupe apres 15 minutes : relance plus tard."; exit 1; }
fi
if [ "$M" = auto ]; then
  python3 -I "$H/tache.py" auto >> "$J" 2>&1
  rc=$?
else
  python3 -I "$H/tache.py" "$M" 2>&1 | tee -a "$J"
  rc=${PIPESTATUS[0]}
fi
n=$(wc -l < "$J" 2>/dev/null || echo 0)
if [ "$n" -gt 2500 ]; then tail -n 2000 "$J" > "$J.tmp" && mv "$J.tmp" "$J"; fi
exit "$rc"
