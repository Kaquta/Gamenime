#!/usr/bin/env bash
# Pipeline de promotion staging -> production.
set -euo pipefail

command -v rsync >/dev/null || { echo "rsync absent : sudo apt install rsync"; exit 1; }

# ── 1. promote.sh ─────────────────────────────────────────────────────────────
cat > /opt/stack/scripts/promote.sh <<'PROMO'
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
PROMO
chmod +x /opt/stack/scripts/promote.sh

# ── 2. Les unites systemd ─────────────────────────────────────────────────────
sudo tee /etc/systemd/system/gn-promote.path >/dev/null <<'UNIT'
[Unit]
Description=Surveille la demande de promotion GameNime

[Path]
PathExists=/opt/stack/site/.publish/demande-promote
Unit=gn-promote.service

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/gn-promote.service >/dev/null <<'UNIT'
[Unit]
Description=Promotion staging vers production GameNime
After=docker.service

[Service]
Type=oneshot
User=rey
Group=rey
WorkingDirectory=/opt/stack/site
ExecStartPre=/bin/sh -c 'if [ -e /opt/stack/site/.publish/demande-promote ]; then rm /opt/stack/site/.publish/demande-promote; fi'
ExecStart=/opt/stack/scripts/promote.sh
# 10 min : un rsync de site statique prend des secondes. La marge couvre un
# disque lent ; au-dela, il se passe autre chose et on veut le savoir.
TimeoutStartSec=600
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now gn-promote.path
systemctl is-active --quiet gn-promote.path \
  || { echo "STOP : gn-promote.path inactif"; systemctl status gn-promote.path --no-pager; exit 1; }
systemctl is-enabled --quiet gn-promote.path \
  || { echo "STOP : gn-promote.path non enable"; exit 1; }
echo "gn-promote.path : actif et enable"

# ── 3. L'endpoint ─────────────────────────────────────────────────────────────
python3 - <<'PYEOF'
import shutil, sys
f = "/opt/stack/content-api/src/gamenime/publication.ts"
s = open(f, encoding="utf-8").read()
if "FLAG_PROMOTE" in s:
    print("deja fait"); sys.exit(0)

s = s.replace(
  'const FLAG_BUILD = DOSSIER_FLAGS + "/demande-build";',
  'const FLAG_BUILD = DOSSIER_FLAGS + "/demande-build";\n'
  'const FLAG_PROMOTE = DOSSIER_FLAGS + "/demande-promote";', 1)

VIEUX = '''  // ── La promotion : pas encore de script, donc pas de bouton menteur ───────
  app.post("/admin/build/promouvoir", async (_req: any, reply: any) => {
    return reply.code(501).send({
      ok: false,
      msg: "La promotion n'est pas encore automatisee : aucun script de promotion " +
           "n'existe sur l'hote. Elle reste manuelle.",
    });
  });'''
NEUF = '''  // ── La promotion ───────────────────────────────────────────────────────────
  // Le refus est decide ici ET repete dans promote.sh : un garde-fou qui ne vit
  // que dans le navigateur n'en est pas un, et le script est lancable a la main.
  app.post("/admin/build/promouvoir", async (_req: any, reply: any) => {
    const e = await etatBuild();
    if (e.etat === "en_cours") {
      return reply.code(409).send({ ok: false, ...e,
        msg: "Un build est en cours : attendez son rapport avant de publier." });
    }
    // Un drapeau deja present signifie une promotion en attente. systemd ne
    // lance jamais deux instances du meme service en parallele, donc le risque
    // n'est pas deux rsync concurrents mais un second rsync inutile juste
    // apres le premier. Autant ne pas le demander.
    try {
      await fs.access(FLAG_PROMOTE);
      return reply.code(409).send({ ok: false, ...e,
        msg: "Une promotion est deja en attente ou en cours." });
    } catch { /* ENOENT : la voie est libre */ }

    let r: any = null;
    try { r = JSON.parse(await fs.readFile(RAPPORT, "utf8")); } catch {
      return reply.code(409).send({ ok: false, ...e,
        msg: "Aucun rapport de build lisible : rien a promouvoir." });
    }
    if (r.promouvable !== true) {
      return reply.code(409).send({ ok: false, ...e, rapport: r,
        msg: "Le dernier build n'est pas promouvable" +
             (Array.isArray(r.alertes) && r.alertes.length
               ? " : " + r.alertes.join(", ") : "") + "." });
    }
    try {
      await fs.writeFile(FLAG_PROMOTE, new Date().toISOString() + "\\n", "utf8");
    } catch (err: any) {
      return reply.code(500).send({ ok: false,
        msg: "Impossible de deposer la demande : " + (err?.message || "erreur") });
    }
    return reply.send({ ok: true,
      msg: "Promotion demandee. La production servira " + (r.staging?.sitemap ?? "?") +
           " URLs et " + (r.staging?.liens ?? "?") + " liens." });
  });'''
if VIEUX not in s:
    print("ERREUR : l'endpoint 501 est introuvable"); sys.exit(1)
s = s.replace(VIEUX, NEUF, 1)
shutil.copy2(f, f + ".bak-promote")
open(f, "w", encoding="utf-8").write(s)
print("publication.ts : promotion branchee")
PYEOF

# ── 4. Build + redemarrage ────────────────────────────────────────────────────
cd /opt/stack
JOURNAL_BUILD=/tmp/gn-build-prom.log
if ! docker compose build content-api > "$JOURNAL_BUILD" 2>&1; then
  tail -20 "$JOURNAL_BUILD"; echo "STOP : build echoue"; exit 1
fi
docker compose up -d content-api

# ── 5. Health check INTERNE : gamenime.fr renvoie 404 sur /dashboard, et
#       staging est derriere Basic Auth. On interroge l'API directement.
PRET=0
for i in $(seq 1 20); do
  if docker exec content-api node -e 'fetch("http://localhost:3000/admin/build/rapport").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    echo "API repond (${i}s)"; PRET=1; break
  fi
  sleep 1
done
[ "$PRET" -eq 1 ] || { echo "STOP : API muette apres 20s"; docker compose logs --tail=40 content-api; exit 1; }

# ── 6. Test fonctionnel ───────────────────────────────────────────────────────
echo "— test de l'endpoint de promotion —"
REPONSE=$(docker exec content-api node -e '
  fetch("http://localhost:3000/admin/build/promouvoir",{method:"POST"})
    .then(async r => console.log(JSON.stringify({code:r.status, body:(await r.text()).slice(0,300)})))
' | tail -1)
echo "  $REPONSE"
CODE=$(printf '%s' "$REPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('code',0))")

case "$CODE" in
  200)
    echo "  demande acceptee — attente de la promotion"
    FINI=0
    for i in $(seq 1 30); do
      if grep -q "promotion terminee" /opt/stack/site/.build-report/promote.log 2>/dev/null; then
        echo "  promotion terminee apres ${i}s"; FINI=1; break
      fi
      sleep 1
    done
    if [ "$FINI" -ne 1 ]; then
      echo "STOP : promotion inachevee apres 30s"
      journalctl -u gn-promote.service -n 30 --no-pager || true
      tail -10 /opt/stack/site/.build-report/promote.log 2>/dev/null || true
      exit 1
    fi
    ;;
  409) echo "  refus coherent — voir le message ci-dessus" ;;
  500) echo "STOP : erreur serveur"; docker compose logs --tail=40 content-api; exit 1 ;;
  *)   echo "STOP : code HTTP inattendu : $CODE"; exit 1 ;;
esac

# ── 7. Etat de l'unite, lu sur ActiveState et non sur is-active ──────────────
for i in $(seq 1 60); do
  case "$(systemctl show -p ActiveState --value gn-promote.service)" in
    inactive|failed) break ;;
  esac
  sleep 1
done
echo "— journal de promotion —"
cat /opt/stack/site/.build-report/promote.log 2>/dev/null || echo "  aucun"

echo
echo "OK — pipeline de promotion actif"
echo "  Surveille : gn-promote.path"
echo "  Journal   : /opt/stack/site/.build-report/promote.log"
