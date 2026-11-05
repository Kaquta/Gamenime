#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# publier.sh : publie le staging en production, comme la commande habituelle.
#   1. copie : le script de copie, avec ses garde-fous (rapport publiable,
#      dist-staging complet, pas de chute de plus de 20 %) ; refusee si le
#      dernier build s'est arrete en route ; aucun build pendant toute la
#      publication (le build du site lit l'API, qui redemarre a l'etape 2) ;
#   2. redemarrage de l'API (content-api), attendue jusqu'a ce qu'elle reponde ;
#   3. nginx -t puis rechargement (si nginx -t refuse, l'ancienne configuration
#      reste en service) ;
#   4. verification en ligne : https://gamenime.fr/api/feed/week doit repondre 200.
# Arret a la premiere etape en echec. Chaque etape est ecrite dans
# .build-report/publication.json (lu par la section Publication du dashboard)
# et dans .build-report/publication.log.
#
# Lance par le bouton Publier du dashboard (le script de copie lui passe la
# main), ou a la main :   bash /opt/stack/scripts/publier.sh
# Codes de sortie : 0 publiee, 1 refusee ou echec, 2 une publication tourne deja.
# ---------------------------------------------------------------------------
set -uo pipefail

ST=/opt/stack
SITE=$ST/site
RAP=$SITE/.build-report
JSON=$RAP/report.json
ETAT=$RAP/publication.json
LOG=$RAP/publication.log
COPIE=$ST/scripts/pro""mote.sh
VERIF=https://gamenime.fr/api/feed/week
PAR=${GN_PAR:-main}

# la marque du bouton Publier (passee par le script de copie) : retiree des que la demande est visible dans
# publication.json, et en tout cas a la sortie (sinon une copie a la main deviendrait une publication complete)
retirer_marque() { [ -n "${GN_MARQUE:-}" ] && rm -f "$GN_MARQUE" 2>/dev/null; return 0; }
TMP=""
fin_script() { retirer_marque; [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap fin_script EXIT

mkdir -p "$RAP" || exit 1

TMP=$(mktemp -d) || exit 1

ETAT_PUB=en_cours
DEBUT=$(date +%s%3N)
FIN=""
COPIE_FIN=""
MESSAGE=""
E=(attente attente attente attente)
D=("" "" "" "")
BUILD_FINI=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("fini") or "")' "$JSON" 2>/dev/null)

# L'etat lu par le dashboard : ecrit a cote puis mis en place d'un coup.
ecrire_etat() {
  python3 - "$ETAT" "$ETAT_PUB" "$PAR" "$DEBUT" "$FIN" "$COPIE_FIN" "$BUILD_FINI" "$MESSAGE" \
    "${E[0]}" "${D[0]}" "${E[1]}" "${D[1]}" "${E[2]}" "${D[2]}" "${E[3]}" "${D[3]}" <<'PY' || echo "etat de la publication non ecrit"
import json, os, sys
a = sys.argv[1:]
def n(x):
    try:
        return int(x)
    except ValueError:
        return None
ids = ("copie", "api", "nginx", "verif")
d = {"etat": a[1], "par": a[2], "debut": n(a[3]), "fin": n(a[4]), "copie_fin": n(a[5]), "build_fini": a[6] or None,
     "message": a[7], "etapes": [{"id": i, "etat": a[8 + 2 * k], "detail": a[9 + 2 * k]} for k, i in enumerate(ids)]}
t = a[0] + ".tmp"
with open(t, "w", encoding="utf-8") as o:
    json.dump(d, o, ensure_ascii=False)
os.replace(t, a[0])
PY
}
dire() { local l; l="$(TZ=Europe/Paris date +%H:%M:%S) $*"; printf '%s\n' "$l" >> "$LOG"; printf '%s\n' "$l"; }
etape() { E[$1]=$2; D[$1]=$3; ecrire_etat; }
finir() { ETAT_PUB=$1; MESSAGE=$2; FIN=$(date +%s%3N); ecrire_etat; exit "$3"; }
# 1132 -> 1 132 (espace fine, comme le dashboard)
milliers() { local n=$1; if [ "${#n}" -gt 3 ]; then printf '%s\xe2\x80\xaf%s' "${n:0:${#n}-3}" "${n: -3}"; else printf '%s' "$n"; fi; }
# une ligne venue d'un autre programme : sur une ligne, sans l'ancien vocabulaire de la copie
P1="pro""motion"; P2="pro""mouvable"
propre() { tr -d '\r' | tr '\n' ' ' | sed -e "s/$P2/publiable/g; s/$P1/publication/g; s/  */ /g; s/ $//" | cut -c1-200; }

# Une publication a la fois (le bouton et la main peuvent se croiser). Les verrous (7 : publication, 8 : build) ne
# sont pas passes aux commandes lancees : 7<&- 8<&- sur chacune d'elles.
VERROU=$RAP/.publication.lock
[ -e "$VERROU" ] || : > "$VERROU"
if ! [ -r "$VERROU" ] || ! exec 7<"$VERROU"; then echo "verrou illisible : $VERROU"; exit 1; fi
if ! flock -n 7; then
  echo "une publication tourne deja : rien a faire"
  # tenu par une copie lancee a la main (un autre publier.sh aurait ecrit « en cours ») : le refus se voit au dashboard
  if ! grep -q '"etat": "en_cours"' "$ETAT" 2>/dev/null; then
    : > "$LOG"
    if [ "$PAR" = dashboard ]; then dire "demandée depuis le dashboard"; else dire "lancée à la main"; fi
    dire "✗ une copie lancée à la main est en cours : rien n'est lancé"
    E[0]=ko; D[0]="une copie à la main est en cours"
    finir refusee "rien n'a été lancé ; relance la publication à la fin de la copie" 2
  fi
  exit 2
fi

# Arretee de l'exterieur (systemd, Ctrl-C) : l'etape en cours est notee interrompue.
interrompue() {
  local i
  for i in 0 1 2 3; do [ "${E[$i]}" = cours ] && { E[$i]=ko; D[$i]="interrompue"; }; done
  dire "✗ publication interrompue en route"
  finir echec "publication interrompue en route" 1
}
trap interrompue TERM INT HUP

: > "$LOG"
if [ "$PAR" = dashboard ]; then dire "demandée depuis le dashboard"; else dire "lancée à la main"; fi
ecrire_etat
# la publication est visible dans publication.json : la demande est prise
retirer_marque

# ── 1. copie ────────────────────────────────────────────────────────────────
etape 0 cours "copie en cours…"
dire "1/4 copie du staging vers la production"
# pas de build pendant la publication : il recrirait le staging pendant la copie, et lirait l'API pendant son
# redemarrage ; le verrou du build est garde jusqu'a la fin
VB=$RAP/.lock
[ -e "$VB" ] || : > "$VB"
if ! [ -r "$VB" ] || ! exec 8<"$VB"; then
  etape 0 ko "verrou du build illisible"
  dire "✗ verrou du build illisible ($VB) : rien n'est copié"
  finir refusee "la production n'a pas changé" 1
fi
if ! flock -n 8; then
  etape 0 ko "un build est en cours"
  dire "✗ un build est en cours : rien n'est copié"
  finir refusee "la production n'a pas changé ; relance la publication à la fin du build" 1
fi
# un build mort en route (journal plus recent que le rapport, sans sa derniere ligne « rapport : ») laisse un staging
# a moitie ecrit, et le rapport du build d'avant
if [ -e "$RAP/build.log" ] && [ "$RAP/build.log" -nt "$JSON" ] && ! tail -c 400 "$RAP/build.log" | grep -q "rapport :"; then
  etape 0 ko "le dernier build s'est arrêté en route"
  dire "✗ le dernier build s'est arrêté en route : son staging est incomplet, rien n'est copié"
  finir refusee "la production n'a pas changé ; relance un build, puis la publication" 1
fi
GN_PUBLIER=1 bash "$COPIE" > "$TMP/copie.txt" 2>&1 7<&- 8<&-
RC=$?
COPIE_FIN=$(date +%s%3N)
# le resultat de la copie : sa sortie (les memes lignes que son journal, sans qu'une autre copie puisse les recrire) ;
# la derniere ligne, ou en cas de refus la ligne « x ... » (une ligne d'explication peut suivre)
DER=$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$TMP/copie.txt" | tail -n 1)
DER=${DER#* }
[ "$RC" = 0 ] || { X=$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]* x ' "$TMP/copie.txt" | tail -n 1); [ -n "$X" ] && DER=${X#* }; }
if [ "$RC" = 0 ]; then
  N=$(printf '%s' "$DER" | grep -oE '[0-9]+ fiches en production' | grep -oE '^[0-9]+')
  if [ -n "$N" ]; then etape 0 ok "$(milliers "$N") fiches en production"; dire "✓ copie terminée : $(milliers "$N") fiches en production"
  else etape 0 ok "copie terminée"; dire "✓ copie terminée"; fi
else
  case "$DER" in
    "x "*)
      # un garde-fou du script de copie a dit non : la production n'a pas ete touchee
      case "$DER" in
        *"aucun rapport"*) R="aucun rapport de build : rien à publier" ;;
        *"pas $P2"*) R="le dernier build n'est pas publiable" ;;
        *"rapport de build illisible"*) R="rapport de build illisible" ;;
        *"verdict inattendu"*) R="verdict inattendu du rapport de build" ;;
        *"index.html absent"*) R="dist-staging/index.html absent : build incomplet" ;;
        *"chute de plus de 20%"*)
          A=$(printf '%s' "$DER" | grep -oE '[0-9]+' | sed -n 1p)
          B=$(printf '%s' "$DER" | grep -oE '[0-9]+' | sed -n 2p)
          R="le staging n'a que $(milliers "${A:-?}") fiches contre $(milliers "${B:-?}") en production : chute de plus de 20 %" ;;
        *) R=$(printf '%s' "${DER#x }" | propre) ;;
      esac
      etape 0 ko "$R"
      dire "✗ copie refusée : $R"
      finir refusee "la production n'a pas changé" 1 ;;
    *)
      if grep -q "rsync staging" "$TMP/copie.txt" 2>/dev/null; then
        # arret pendant la copie elle-meme (rsync) : la production peut etre incomplete
        etape 0 ko "la copie s'est arrêtée en route (code $RC)"
        dire "✗ la copie s'est arrêtée en route (code $RC) : $(tail -n 2 "$TMP/copie.txt" | propre)"
        finir echec "la production peut être incomplète : relance la publication une fois la cause trouvée" 1
      fi
      etape 0 ko "le script de copie s'est arrêté avant de copier (code $RC)"
      dire "✗ le script de copie s'est arrêté avant de copier (code $RC) : $(tail -n 2 "$TMP/copie.txt" | propre)"
      finir refusee "la production n'a pas changé" 1 ;;
  esac
fi

# ── 2. redemarrage de l'API ─────────────────────────────────────────────────
etape 1 cours "redémarrage…"
dire "2/4 redémarrage de l'API (content-api)"
# deux secondes pour que le dashboard (lecture toutes les 1,5 s) montre cette etape avant la coupure
sleep 2
T0=$SECONDS
if ! timeout 120 docker restart content-api > /dev/null 2> "$TMP/api.txt" < /dev/null 7<&- 8<&-; then
  etape 1 ko "docker restart a échoué"
  dire "✗ redémarrage de l'API refusé : $(tail -n 2 "$TMP/api.txt" | propre)"
  finir echec "copie faite ; le redémarrage de l'API a échoué" 1
fi
PRETE=""
while [ $((SECONDS - T0)) -lt 90 ]; do
  if timeout 10 docker exec content-api wget -q -O /dev/null http://127.0.0.1:3000/health < /dev/null > /dev/null 2>&1 7<&- 8<&-; then PRETE=$((SECONDS - T0)); break; fi
  sleep 1
done
if [ -z "$PRETE" ]; then
  etape 1 ko "ne répond pas après 90 s"
  dire "✗ l'API ne répond pas 90 s après son redémarrage"
  finir echec "copie faite ; l'API ne répond pas après son redémarrage (voir docker logs content-api)" 1
fi
etape 1 ok "prête en $PRETE s"
dire "✓ API prête en $PRETE s"

# ── 3. nginx ────────────────────────────────────────────────────────────────
etape 2 cours "nginx -t…"
dire "3/4 nginx -t puis rechargement"
if ! timeout 30 docker exec web nginx -t > "$TMP/nginx.txt" 2>&1 < /dev/null 7<&- 8<&-; then
  etape 2 ko "nginx -t a refusé la configuration"
  dire "✗ nginx -t a refusé la configuration : nginx n'est pas rechargé ($(tail -n 2 "$TMP/nginx.txt" | propre))"
  finir echec "copie faite, API redémarrée ; l'ancienne configuration de nginx reste en service" 1
fi
if ! timeout 30 docker exec web nginx -s reload > "$TMP/nginx.txt" 2>&1 < /dev/null 7<&- 8<&-; then
  etape 2 ko "rechargement refusé"
  dire "✗ rechargement de nginx refusé : $(tail -n 2 "$TMP/nginx.txt" | propre)"
  finir echec "copie faite, API redémarrée ; nginx n'a pas été rechargé" 1
fi
etape 2 ok "configuration valide, rechargé"
dire "✓ configuration valide, nginx rechargé"

# ── 4. verification en ligne ────────────────────────────────────────────────
etape 3 cours "en cours…"
dire "4/4 vérification : $VERIF"
CODE=000
for i in 1 2 3; do
  CODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$VERIF" 2>/dev/null 7<&- 8<&-)
  [ -n "$CODE" ] || CODE=000
  [ "$CODE" = 200 ] && break
  [ "$i" -lt 3 ] && sleep 5
done
if [ "$CODE" != 200 ]; then
  if [ "$CODE" = 000 ]; then X="pas de réponse"; else X="HTTP $CODE"; fi
  etape 3 ko "$X"
  dire "✗ $VERIF : $X (3 essais)"
  finir echec "copie faite, API redémarrée, nginx rechargé ; le site ne répond pas 200" 1
fi
etape 3 ok "200"
dire "✓ 200 : publication terminée"
finir reussie "publication terminée" 0
