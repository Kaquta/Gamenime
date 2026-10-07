#!/usr/bin/env bash
# L'URL suit l'item tant que le modal est ouvert, et revient a la page au
# moment de la fermeture. Bouton Retour, copier-coller et rafraichissement
# deviennent coherents.
#
# NB : astro build transpile sans verifier les types. Une erreur de typage
# dans le <script> ne serait pas signalee ici.
set -euo pipefail

cd /opt/stack/site

SRC="src/components/SectionBlock.astro"
BK="/opt/stack/backups/SectionBlock.astro.$(date +%Y%m%d-%H%M%S)"
mkdir -p /opt/stack/backups
cp "$SRC" "$BK"
echo "sauvegarde : $BK"

python3 - <<'PY'
import sys, pathlib

p = pathlib.Path("src/components/SectionBlock.astro")
s = p.read_text(encoding="utf-8")

if "__gnUrlFiche" in s:
    print("deja applique"); sys.exit(0)

paires = [
(
"""  function close() {
    if (!modal || !inner) return;
    inner.innerHTML = "";
    modal.classList.remove("active");
    document.body.style.overflow = "";""",
"""  // URL de la fiche a pousser dans l'historique, posee par le clic sur un titre.
  // Les autres points d'entree (tiroirs favoris/notifs, liens #item- des emails)
  // la laissent nulle : pour eux l'URL ne bouge pas.
  var urlFiche: string | null = null;
  (window as any).__gnUrlFiche = function(u: string | null) { urlFiche = u; };

  // Fermeture reelle du modal, sans toucher a l'historique.
  function fermerModal() {
    if (!modal || !inner) return;
    inner.innerHTML = "";
    modal.classList.remove("active");
    document.body.style.overflow = "";"""
),
(
"""  }

  if (backdrop) backdrop.addEventListener("click", close);""",
"""  }

  // Action utilisateur (fond, croix, Echap). Si une URL de fiche a ete poussee,
  // on revient en arriere et c'est popstate qui fermera — sinon on fermerait
  // deux fois et l'URL resterait bloquee sur la fiche.
  function close() {
    if (!modal || !modal.classList.contains("active")) return;
    if (history.state && (history.state as any).gnModal) history.back();
    else fermerModal();
  }

  // Bouton Retour du navigateur : ferme sans retoucher l'historique.
  window.addEventListener("popstate", function() {
    if (modal && modal.classList.contains("active")) fermerModal();
  });

  if (backdrop) backdrop.addEventListener("click", close);"""
),
(
"""    if (activeCard) killHover(activeCard);
    modal.classList.add("active");""",
"""    if (activeCard) killHover(activeCard);
    // L'URL suit l'item tant que le modal est ouvert. replaceState si un modal
    // etait deja ouvert : passer de fiche en fiche ne doit pas empiler dix
    // entrees d'historique et rendre le bouton Retour inutilisable.
    if (urlFiche && location.pathname !== urlFiche) {
      var dejaOuvert = modal.classList.contains("active") && history.state && (history.state as any).gnModal;
      if (dejaOuvert) history.replaceState({ gnModal: true }, "", urlFiche);
      else history.pushState({ gnModal: true }, "", urlFiche);
    }
    urlFiche = null;
    modal.classList.add("active");"""
),
(
"""    if ((e.target as HTMLElement).closest("a.item-link")) e.preventDefault();""",
"""    var lienFiche = (e.target as HTMLElement).closest("a.item-link") as HTMLAnchorElement | null;
    if (lienFiche) {
      e.preventDefault();
      if (typeof (window as any).__gnUrlFiche === "function") {
        (window as any).__gnUrlFiche(lienFiche.getAttribute("href"));
      }
    }"""
),
]

for old, new in paires:
    n = s.count(old)
    if n != 1:
        print(f"STOP : ancre vue {n} fois, attendu 1")
        print("       " + old.strip().split("\n")[0][:70])
        print("       Rien n'a ete ecrit, le fichier est intact.")
        sys.exit(1)
    s = s.replace(old, new)

tmp = p.with_suffix(".astro.tmp")
tmp.write_text(s, encoding="utf-8")
tmp.replace(p)
print("4 ancres appliquees")
PY

echo
echo "== Structure produite"
for motif in 'function fermerModal' 'function close' 'addEventListener("popstate"' '__gnUrlFiche' 'gnModal'; do
  printf '  %-34s %s\n' "$motif" "$(grep -c "$motif" "$SRC" || true)"
done

echo
echo "== Autres fermetures du modal, hors fermerModal"
echo "   (si une ligne apparait ici, elle fermera le modal SANS restaurer l'URL)"
grep -n 'classList.remove("active")' "$SRC" | grep -v 'fermerModal' || true
grep -n 'detailModal' "$SRC" | grep -iv 'getElementById\|^.*modal =' | head

echo
echo "== Build staging"
if ! npx astro build --outDir ./dist-staging 2>&1 | tail -20; then
  echo
  echo "ECHEC build. Restauration : cp $BK $SRC"
  exit 1
fi
echo "build OK"

echo
echo "== Presence dans le JS livre"
MANQUE=0
for m in gnModal __gnUrlFiche popstate; do
  C=$(grep -ro "$m" dist-staging/_astro/*.js 2>/dev/null | wc -l | tr -d '[:space:]')
  printf '  %-16s %s\n' "$m" "$C"
  [ "$C" -eq 0 ] && MANQUE=1
done
if [ "$MANQUE" -eq 1 ]; then
  echo
  echo "STOP : un marqueur manque dans le bundle — le patch n'a pas abouti."
  echo "       Restauration : cp $BK $SRC"
  exit 1
fi

echo
echo "== Termine"
echo "Sauvegarde : $BK"
