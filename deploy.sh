#!/usr/bin/env bash
set -euo pipefail

# ─── GameNime Astro — Build & Deploy ───────────────────────
# Usage:  cd /opt/stack/site && ./deploy.sh
# Prérequis : Node.js ≥ 18  (node -v)
#             content-api accessible sur localhost:3000 pendant le build
# ────────────────────────────────────────────────────────────

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SITE_DIR/dist"

echo "══════════════════════════════════════════"
echo "  GameNime — Build Astro (SSG)"
echo "══════════════════════════════════════════"

# 1) Vérifier Node
if ! command -v node &>/dev/null; then
  echo "❌  Node.js introuvable. Installe-le :"
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "    sudo apt-get install -y nodejs"
  exit 1
fi
echo "✓  Node $(node -v)"

# 2) Vérifier que content-api est joignable
API_BASE="${PUBLIC_API_BASE:-http://127.0.0.1:3000}"
echo "→  Test API sur $API_BASE ..."

if ! curl -sf --max-time 5 "$API_BASE/anime/health" >/dev/null 2>&1; then
  echo ""
  echo "⚠  content-api n'est pas joignable sur $API_BASE"
  echo ""
  echo "   Tu dois exposer temporairement le port pendant le build."
  echo "   Ajoute ceci dans docker-compose.yml sous content-api :"
  echo ""
  echo '     ports:'
  echo '       - "127.0.0.1:3000:3000"'
  echo ""
  echo "   Puis :  docker compose up -d content-api"
  echo "   Relance :  ./deploy.sh"
  echo "   Après le build tu peux retirer le port."
  exit 1
fi
echo "✓  content-api OK"

# 3) Install deps
cd "$SITE_DIR"
echo "→  npm install ..."
npm install --prefer-offline 2>&1 | tail -3

# 4) Build
echo "→  astro build ..."
PUBLIC_API_BASE="$API_BASE" npx astro build 2>&1

# 5) Vérifier le résultat
if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "❌  Build échoué — dist/index.html introuvable"
  exit 1
fi

PAGE_COUNT=$(find "$DIST_DIR" -name "*.html" | wc -l)
echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Build OK — $PAGE_COUNT pages générées"
echo "══════════════════════════════════════════"
echo ""
echo "  dist/ est déjà monté dans nginx."
echo "  → docker compose exec web nginx -s reload"
echo "  → Teste : https://staging.gamenime.fr/"
echo ""
