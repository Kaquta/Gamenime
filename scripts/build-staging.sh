#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-staging.sh — construit le site dans dist-staging, mesure, et ecrit
# un journal lisible en direct plus un rapport JSON.
#
# Le journal s'ecrit ligne par ligne, le rapport seulement a la fin : un
# journal plus recent que le rapport signifie donc « build en cours », et le
# dashboard n'a besoin de rien d'autre pour le savoir.
#
# Codes de sortie : 0 succes · 1 echec · 2 un build tourne deja.
# ---------------------------------------------------------------------------
set -uo pipefail

SITE=/opt/stack/site
RAP=$SITE/.build-report
LOG=$RAP/build.log
JSON=$RAP/report.json
DEBUT=$(date +%s)

mkdir -p "$RAP"

# Un seul build a la fois. Le cron de nuit et le bouton du dashboard peuvent
# se declencher ensemble : deux astro build dans le meme dossier produiraient
# un resultat incoherent, et c'est lui qui serait promu.
exec 9>"$RAP/.lock"
if ! flock -n 9; then
  echo "un build est deja en cours — rien a faire"
  exit 2
fi

: > "$LOG"

TMP_PAGES=""; TMP_LIENS=""
nettoyer() { [ -n "$TMP_PAGES" ] && rm -f "$TMP_PAGES"; [ -n "$TMP_LIENS" ] && rm -f "$TMP_LIENS"; }
trap nettoyer EXIT

dire() { printf '%s\n' "$*" | tee -a "$LOG"; }
cmd()  { dire "\$ $*"; }

# ---------------------------------------------------------- mesures communes
compte_pages() { ls -1d "$1"/anime/*/ 2>/dev/null | wc -l; }
compte_jeux()  { ls -1d "$1"/games/*/ 2>/dev/null | wc -l; }

# grep -c affiche 0 ET sort en code 1 quand il ne trouve rien : un `|| echo 0`
# ecrirait donc un second zero. awk donne un entier fiable dans tous les cas.
compte_sitemap() {
  local f="$1/sitemap.xml"
  [ -f "$f" ] || { echo 0; return; }
  awk '/<url>/{n++} END{print n+0}' "$f"
}

liens_uniques() {
  cat "$1/anime/index.html" "$1/games/index.html" \
      "$1/upcoming/index.html" "$1/index.html" 2>/dev/null \
    | grep -o 'href="/\(anime\|games\)/[^"]\+/"' \
    | grep -vE 'href="/(anime|games)/"' | sort -u | wc -l
}

orphelines() {
  local d=$1
  TMP_PAGES=$(mktemp); TMP_LIENS=$(mktemp)
  { ls -1d "$d"/anime/*/ 2>/dev/null | sed 's|.*/anime/|anime/|; s|/$||'
    ls -1d "$d"/games/*/ 2>/dev/null | sed 's|.*/games/|games/|; s|/$||'; } | sort -u > "$TMP_PAGES"
  cat "$d/anime/index.html" "$d/games/index.html" "$d/upcoming/index.html" "$d/index.html" 2>/dev/null \
    | grep -o 'href="/\(anime\|games\)/[^"]\+/"' \
    | sed 's|href="/||; s|/"$||' | sort -u > "$TMP_LIENS"
  comm -23 "$TMP_PAGES" "$TMP_LIENS" | wc -l
}

echouer() {
  dire "x $1"
  printf '{"ok":false,"erreur":"%s","fini":"%s"}\n' "$2" "$(date -Is)" > "$JSON"
  exit 1
}

# ------------------------------------------------------------------ etape 1
dire "== slugs"
# Les endpoints d'administration ne sont pas exposes par nginx — volontairement.
# On passe donc par le conteneur, ou l'API ecoute en local et ou la cle est
# deja dans l'environnement : rien ne transite par le reseau public.
cmd "generate-slugs (dans content-api)"
SLUGS=$(docker exec content-api node -e '
  const k = process.env.ADMIN_API_KEY || process.env.ANIME_API_KEY || process.env.GAMES_API_KEY;
  fetch("http://localhost:3000/admin/generate-slugs", { method: "POST", headers: { "x-api-key": k } })
    .then(r => r.text()).then(t => process.stdout.write(t))
    .catch(e => process.stdout.write(JSON.stringify({ ok: false, erreur: String(e) })));
' 2>/dev/null || echo '{"ok":false}')
case "$SLUGS" in '{'*) ;; *) SLUGS='{"ok":false}' ;; esac
dire "  $SLUGS"

# ------------------------------------------------------------------ etape 2
dire ""
dire "== build"
cmd "astro build --outDir ./dist-staging"
cd "$SITE" || echouer "impossible d'entrer dans $SITE" "cd"

npx astro build --outDir ./dist-staging 2>&1 \
  | grep -E 'generating static routes|page\(s\) built|Completed in|[Ee]rror|warn' \
  | sed 's/^/  /' | tee -a "$LOG"
ASTRO=${PIPESTATUS[0]}

# Le code de sortie d'Astro, et non la presence du fichier : apres un echec,
# le index.html du build precedent est toujours la et ferait croire au succes.
[ "$ASTRO" -eq 0 ] || echouer "astro build a echoue (code $ASTRO)" "build"
[ -f "$SITE/dist-staging/index.html" ] || echouer "dist-staging/index.html absent" "sortie"

# ------------------------------------------------------------------ etape 3
dire ""
dire "== maillage"
SA=$(compte_pages "$SITE/dist-staging"); SG=$(compte_jeux "$SITE/dist-staging")
SS=$(compte_sitemap "$SITE/dist-staging"); SL=$(liens_uniques "$SITE/dist-staging")
SO=$(orphelines "$SITE/dist-staging")
dire "  fiches anime   $SA"
dire "  fiches jeux    $SG"
dire "  URLs sitemap   $SS"
dire "  liens internes $SL"
if [ "$SO" -gt 0 ]; then dire "! fiches orphelines $SO"; else dire "  fiches orphelines 0"; fi

PA=$(compte_pages "$SITE/dist"); PG=$(compte_jeux "$SITE/dist")
PS=$(compte_sitemap "$SITE/dist"); PL=$(liens_uniques "$SITE/dist")

# ------------------------------------------------------------------ etape 4
dire ""
dire "== verdict"
ALERTES=()
[ "$SL" -eq 0 ] && ALERTES+=("aucun lien interne vers les fiches")
[ "$SA" -lt $(( PA * 80 / 100 )) ] && ALERTES+=("fiches anime en forte baisse ($PA -> $SA)")
[ "$SG" -lt $(( PG * 80 / 100 )) ] && ALERTES+=("fiches jeux en forte baisse ($PG -> $SG)")
[ "$SS" -lt $(( PS * 80 / 100 )) ] && ALERTES+=("sitemap en forte baisse ($PS -> $SS)")

DUREE=$(( $(date +%s) - DEBUT ))
if [ ${#ALERTES[@]} -eq 0 ]; then
  dire "v build termine en ${DUREE}s — promouvable"
  PROMOUVABLE=true
else
  for a in "${ALERTES[@]}"; do dire "x $a"; done
  dire "x promotion bloquee"
  PROMOUVABLE=false
fi

json_liste() { local s=""; for e in "$@"; do s="$s\"$(printf '%s' "$e" | sed 's/"/\\"/g')\","; done; printf '[%s]' "${s%,}"; }

cat > "$JSON" <<JSONFIN
{
  "ok": true,
  "fini": "$(date -Is)",
  "duree_s": $DUREE,
  "promouvable": $PROMOUVABLE,
  "alertes": $(json_liste "${ALERTES[@]+"${ALERTES[@]}"}"),
  "slugs": $SLUGS,
  "staging": { "anime": $SA, "jeux": $SG, "sitemap": $SS, "liens": $SL, "orphelines": $SO },
  "prod":    { "anime": $PA, "jeux": $PG, "sitemap": $PS, "liens": $PL }
}
JSONFIN
dire ""
dire "rapport : $JSON"
