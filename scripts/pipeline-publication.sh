#!/usr/bin/env bash
# Pipeline "conteneur -> systemd -> build -> rapport".
# Le conteneur depose un fichier drapeau, systemd le voit apparaitre et lance
# le build. Aucun cron a maintenir, aucun privilege donne au conteneur.
set -euo pipefail

# ── 1. Le dossier des drapeaux ────────────────────────────────────────────────
# Ecrit par DEUX utilisateurs : le conteneur content-api (root dans l'image) et
# l'unite gn-build.service (User=rey). rey:rey en 775, et on verifie ensuite que
# le conteneur peut effectivement y ecrire.
mkdir -p /opt/stack/site/.publish
sudo chown rey:rey /opt/stack/site/.publish
chmod 775 /opt/stack/site/.publish

# ── 2. Les volumes du conteneur ───────────────────────────────────────────────
python3 - <<'PYEOF'
import shutil, sys
f = "/opt/stack/docker-compose.yml"
s = open(f, encoding="utf-8").read()
if "/data/build" in s:
    print("STOP : volumes deja presents"); sys.exit(0)
A = "    depends_on: [mariadb]\n    networks: [internal, public]"
if A not in s:
    print("ERREUR : ancre du service content-api introuvable, rien ecrit"); sys.exit(1)
s = s.replace(A, """    volumes:
      # Le rapport et le journal du build, en lecture seule : l'API les affiche,
      # elle ne les ecrit jamais.
      - /opt/stack/site/.build-report:/data/build:ro
      # Les drapeaux de demande, en ecriture : c'est le seul moyen pour un
      # conteneur de demander quelque chose a l'hote sans privilege.
      - /opt/stack/site/.publish:/data/publish
    depends_on: [mariadb]
    networks: [internal, public]""", 1)
shutil.copy2(f, f + ".bak-publication")
open(f, "w", encoding="utf-8").write(s)
print("docker-compose.yml : deux volumes ajoutes")
PYEOF

# ── 3. Les unites systemd ─────────────────────────────────────────────────────
sudo tee /etc/systemd/system/gn-build.path >/dev/null <<'UNIT'
[Unit]
Description=Surveille la demande de build GameNime

[Path]
# Le conteneur n'a pas de shell sur l'hote : il depose un fichier, systemd le
# voit apparaitre et lance le build dans la seconde. Aucun cron a maintenir,
# aucun privilege donne au conteneur.
PathExists=/opt/stack/site/.publish/demande-build
Unit=gn-build.service

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/gn-build.service >/dev/null <<'UNIT'
[Unit]
Description=Build staging GameNime
After=docker.service

[Service]
Type=oneshot
# rey et pas root : sinon les fichiers du rapport deviendraient root:root et
# un lancement manuel du script ne pourrait plus les reecrire.
User=rey
Group=rey
WorkingDirectory=/opt/stack/site
# Le drapeau est retire AVANT le build, pas apres. Si le build echoue, le
# fichier ne doit pas rester : l'unite .path relancerait en boucle. Et une
# demande arrivee pendant le build recree le fichier, donc systemd relancera
# une fois celui-ci termine — la file d'attente se fait d'elle-meme.
# La forme explicite plutot que `rm -f` : le cas "fichier absent" est traite
# sans masquer quoi que ce soit.
ExecStartPre=/bin/sh -c 'if [ -e /opt/stack/site/.publish/demande-build ]; then rm /opt/stack/site/.publish/demande-build; fi'
ExecStart=/opt/stack/scripts/build-staging.sh
# Large a dessein : mieux vaut un build lent qu'un build tue en plein vol.
TimeoutStartSec=3600
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now gn-build.path

# ── 4. Les unites repondent-elles ─────────────────────────────────────────────
systemctl is-active --quiet gn-build.path \
  || { echo "STOP : gn-build.path inactif. Voir : systemctl status gn-build.path"; exit 1; }
systemctl is-enabled --quiet gn-build.path \
  || { echo "STOP : gn-build.path non enable"; exit 1; }
echo "gn-build.path : actif et enable"

# ── 5. Le conteneur reprend avec ses volumes ──────────────────────────────────
cd /opt/stack
docker compose up -d content-api
sleep 3
echo "— ce que l'API voit maintenant —"
docker exec content-api sh -c 'ls -la /data/build /data/publish 2>&1 | head -12'

# ── 6. Le conteneur peut-il deposer son drapeau ───────────────────────────────
echo "— test d'ecriture conteneur -> .publish —"
if docker exec content-api sh -c 'touch /data/publish/.test-ecriture && rm /data/publish/.test-ecriture'; then
  echo "  oui"
else
  echo "STOP : le conteneur ne peut pas ecrire dans /data/publish."
  echo "       UID du conteneur : docker exec content-api id"
  echo "       Puis ajuster le proprietaire ou le groupe de /opt/stack/site/.publish."
  exit 1
fi

# ── 7. Bout en bout : deposer un drapeau, voir s'il est consomme ──────────────
echo "— test de bout en bout —"
sudo systemctl reset-failed gn-build.service 2>/dev/null || true
touch /opt/stack/site/.publish/demande-build

CONSOMME=0
for i in $(seq 1 15); do
  if [ ! -f /opt/stack/site/.publish/demande-build ]; then
    echo "  drapeau consomme par systemd apres ${i}s"; CONSOMME=1; break
  fi
  sleep 1
done
if [ "$CONSOMME" -ne 1 ]; then
  echo "STOP : le drapeau n'a pas ete consomme apres 15s."
  echo "       systemctl status gn-build.path gn-build.service"
  echo "       journalctl -u gn-build.path -n 30"
  exit 1
fi

# ── 8. Le build lui-meme : attendre la fin et lire le VRAI code de sortie ────
# Un test qui conclut "peut avoir reussi ou echoue" n'est pas un test.
# ExecMainStatus porte le code de sortie du script, donc une reponse ferme.
echo "— attente de la fin du build —"
# is-active ne vaut 0 que pour "active" : un Type=oneshot qui travaille est
# en "activating", donc une boucle fondee sur is-active sort tout de suite.
# ActiveState distingue les deux.
for i in $(seq 1 600); do
  case "$(systemctl show -p ActiveState --value gn-build.service)" in
    inactive|failed) break ;;
  esac
  sleep 1
done
CODE=$(systemctl show -p ExecMainStatus --value gn-build.service 2>/dev/null || echo "?")
case "$CODE" in
  0) echo "  build termine, code 0" ;;
  2) echo "  build refuse : un autre build tenait deja le verrou flock (code 2)" ;;
  "") echo "  ATTENTION : aucun code de sortie remonte, le build n'a peut-etre jamais demarre" ;;
  *) echo "STOP : le build a echoue, code $CODE"
     echo "       journalctl -u gn-build.service -n 40 --no-pager"
     exit 1 ;;
esac

# ── 9. Le rapport a-t-il ete reecrit, et l'API le voit-elle ──────────────────
echo "— le rapport, vu par l'hote —"
ls -l /opt/stack/site/.build-report/report.json
echo "— le rapport, vu par l'API —"
docker exec content-api sh -c 'head -c 400 /data/build/report.json; echo'

echo
echo "OK — pipeline de publication actif"
echo "  Surveille : gn-build.path"
echo "  Build     : gn-build.service"
echo "  Drapeau   : /opt/stack/site/.publish/demande-build"
