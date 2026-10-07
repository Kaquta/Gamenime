#!/usr/bin/env bash
# Promotion : staging -> production.
#
# POURQUOI rsync ET PAS mv
# nginx monte /opt/stack/site/dist en bind, et un bind pointe sur un inode.
# Remplacer le dossier laisserait nginx servir l'ancien contenu pour toujours,
# et sortirait dist-staging de son propre montage. On ecrit donc DANS dist.
#
# CE QUE CA IMPLIQUE
# La bascule n'est pas atomique : pendant la copie, nginx sert un melange des
# deux versions. Acceptable pour un site statique ; l'atomicite demanderait de
# monter le dossier parent et de faire pointer nginx sur un lien symbolique.
#
# --delete EST DANGEREUX
# Toute page presente en prod et absente du staging est effacee. On verifie donc
# AVANT de lancer rsync que le staging est coherent. Un staging ecrit a moitie
# — disque plein, build interrompu — viderait sinon la production.
set -euo pipefail

SITE=/opt/stack/site
RAP=$SITE/.build-report
JSON=$RAP/report.json
LOG=$RAP/promote.log

: > "$LOG"
dire() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

# anime ET games : ne compter qu'un seul des deux laisserait passer
# l'effondrement de l'autre.
compte() { ls -1d "$1"/anime/*/ "$1"/games/*/ 2>/dev/null | wc -l; }

# ── Garde-fou 1 : un rapport, et un rapport promouvable ──────────────────────
[ -f "$JSON" ] || { dire "x aucun rapport de build : rien a promouvoir"; exit 1; }

# Le chemin passe en argv, jamais interpole dans le -c. Et le code est capture
# dans la meme commande : avec set -e, un `case $?` sur la ligne suivante ne
# serait jamais atteint.
VERDICT=0
python3 - "$JSON" <<'PY' || VERDICT=$?
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("rapport illisible :", e, file=sys.stderr); sys.exit(2)
sys.exit(0 if d.get("promouvable") is True else 1)
PY
case "$VERDICT" in
  0) : ;;
  1) dire "x le dernier build n'est pas promouvable : promotion refusee"; exit 1 ;;
  2) dire "x rapport de build illisible : promotion refusee"; exit 1 ;;
  *) dire "x verdict inattendu ($VERDICT) : promotion refusee"; exit 1 ;;
esac

# ── Garde-fou 2 : dist-staging doit etre complet ─────────────────────────────
[ -f "$SITE/dist-staging/index.html" ] \
  || { dire "x dist-staging/index.html absent : build incomplet"; exit 1; }

AV=$(compte "$SITE/dist")
AS=$(compte "$SITE/dist-staging")
dire "avant : prod=$AV fiches, staging=$AS fiches"

if [ "$AV" -gt 0 ] && [ "$AS" -lt $(( AV * 80 / 100 )) ]; then
  dire "x staging n'a que $AS fiches contre $AV en prod — chute de plus de 20%, refus"
  dire "  la production n'a pas ete touchee"
  exit 1
fi

# ── La promotion ─────────────────────────────────────────────────────────────
dire "promotion en cours — rsync staging -> dist"
rsync -a --delete "$SITE/dist-staging/" "$SITE/dist/"
AP=$(compte "$SITE/dist")
dire "v promotion terminee — $AP fiches en production"
