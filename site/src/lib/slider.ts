// Fenetre glissante de l'accueil — maquette validee le 3 octobre (session 35).
//
// Une diapositive a la fois, dans les trois rectangles du haut. On avance :
//   - tout seul, et le defilement s'arrete des que la souris est dessus
//   - a la fleche ronde, posee sur le cote de la fenetre
//   - au doigt et au trackpad : defilement natif + aimantation (scroll-snap)
//   - au point, pour la grande case « Cette semaine »
// Il n'y a ni bouton pause ni barre de progression : le defilement se suspend
// deja tout seul au survol, les deux faisaient double emploi.
//
// Les diapositives sont les .item-card du site : le survol bande-annonce, le
// clic vers la modale et les favoris restent geres par les ecouteurs delegues
// de SectionBlock. Ce module ne touche qu'au defilement.
 
const REDUIT = typeof matchMedia === "function"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;
 
// Au doigt il n'y a pas de survol : le point reste un bouton qu'on tape.
const SURVOL_FIN = typeof matchMedia === "function"
  && matchMedia("(hover: hover) and (pointer: fine)").matches;
 
// Toutes les fenetres de la page, pour les suspendre d'un coup quand l'onglet
// passe en arriere-plan.
const TOUTES: any[] = [];
let brancheVisibilite = false;
 
export interface OptionsFenetre {
  duree?: number;          // millisecondes entre deux diapositives
  decal?: number;          // retard au demarrage, pour desynchroniser deux fenetres
  vignettes?: HTMLElement[]; // les points cliquables (Cette semaine)
  actif?: boolean;         // une fenetre masquee (jour non choisi) ne tourne pas
}
 
export function monterFenetre(racine: HTMLElement, opts: OptionsFenetre = {}) {
  const piste = racine.querySelector(".sl-track") as HTMLElement | null;
  if (!piste) return null;
 
  const cpt = racine.querySelector(".sl-cpt") as HTMLElement | null;
  const fg = racine.querySelector(".sl-fl.g") as HTMLElement | null;
  const fd = racine.querySelector(".sl-fl.d") as HTMLElement | null;
 
  const duree = opts.duree || 5000;
  let vignettes = opts.vignettes || null;
  let n = 0, i = 0;
  let survol = false;
  let actif = opts.actif !== false;
  let horloge: any = null;
 
  // On ne compte QUE les cartes : un message « aucun episode » ou tout autre
  // element de la piste ne doit pas passer pour une diapositive, sinon le
  // compteur annonce 26 sur 25.
  const cartes = () =>
    Array.prototype.slice.call(piste.querySelectorAll(":scope > .item-card")) as HTMLElement[];
 
  function enPause() {
    return REDUIT || survol || !actif
      || (typeof document !== "undefined" && document.hidden)
      || n < 2;
  }
 
  function marquer(k: number) {
    i = k;
    if (cpt) cpt.textContent = n ? (k + 1) + " / " + n : "";
    if (vignettes) vignettes.forEach(function (v, j) { v.classList.toggle("on", j === k); });
    // Pas de scrollIntoView : il faisait remonter toute la page a chaque avance
    // automatique quand on lisait plus bas.
  }
 
  function aller(k: number, direct?: boolean) {
    if (!n) return;
    const retour = (k >= n) || (k < 0);
    k = ((k % n) + n) % n;
    if (retour && !direct) {
      // Le retour au debut se fait en fondu : un rembobinage visible a travers
      // vingt-cinq diapositives donnerait le tournis.
      piste.style.opacity = "0";
      setTimeout(function () {
        piste.scrollTo({ left: k * piste.clientWidth, behavior: "auto" });
        piste.style.opacity = "1";
      }, 180);
    } else {
      piste.scrollTo({ left: k * piste.clientWidth, behavior: (direct || REDUIT) ? "auto" : "smooth" });
    }
    marquer(k);
    relancer();
  }
 
  function relancer() {
    clearTimeout(horloge);
    if (enPause()) return;
    horloge = setTimeout(function () { aller(i + 1); }, duree);
  }
 
  if (fg) fg.addEventListener("click", function () { aller(i - 1); });
  if (fd) fd.addEventListener("click", function () { aller(i + 1); });
 
  racine.addEventListener("mouseenter", function () { survol = true; relancer(); });
  racine.addEventListener("mouseleave", function () { survol = false; relancer(); });
  racine.addEventListener("focusin", function () { survol = true; relancer(); });
  racine.addEventListener("focusout", function (e: FocusEvent) {
    if (!racine.contains(e.relatedTarget as Node)) { survol = false; relancer(); }
  });
 
  // Glisse au doigt ou a la molette : on lit la position une fois le mouvement
  // termine, et on se recale dessus.
  let attente: any = null;
  piste.addEventListener("scroll", function () {
    clearTimeout(attente);
    attente = setTimeout(function () {
      if (!piste.clientWidth) return;
      const k = Math.round(piste.scrollLeft / piste.clientWidth);
      if (k !== i) { marquer(k); relancer(); }
    }, 140);
  }, { passive: true });
 
  piste.addEventListener("keydown", function (e: KeyboardEvent) {
    if (e.key === "ArrowRight") { e.preventDefault(); aller(i + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); aller(i - 1); }
  });
 
  // Viser un point de huit pixels puis cliquer, ca fait deux gestes pour une
  // action de confort : le survol suffit. Le piege, c'est que le point actif
  // s'allonge a 54 px et que le groupe, centre, se decale sous le curseur —
  // le pointeur se retrouve sur le point voisin et les diapositives
  // s'enchainent toutes seules. D'ou le temps mort : apres un changement
  // provoque par le survol, on ignore ce que le decalage fait passer sous le
  // curseur, et seul un vrai mouvement du pointeur reprend la main.
  let dernierSurvol = 0;
  let xDernier = -1, yDernier = -1;
 
  function brancherVignettes(liste: HTMLElement[] | null) {
    vignettes = liste;
    if (!liste) return;
    liste.forEach(function (v, k) {
      v.addEventListener("click", function () { aller(k, true); });
      if (!SURVOL_FIN) return;
      v.addEventListener("mouseenter", function (e: MouseEvent) {
        if (k === i) return;
        const bouge = Math.abs(e.clientX - xDernier) > 3 || Math.abs(e.clientY - yDernier) > 3;
        if (!bouge && performance.now() - dernierSurvol < 320) return;
        xDernier = e.clientX; yDernier = e.clientY;
        dernierSurvol = performance.now();
        aller(k, true);
      });
      // Au clavier aussi : tabuler jusqu'a un point doit montrer sa diapositive.
      v.addEventListener("focus", function () { if (k !== i) aller(k, true); });
    });
  }
  brancherVignettes(vignettes);
 
  // Appele a chaque fois que .sl-track est reecrite (loadSection, filtres).
  function recompter(garderPosition?: boolean) {
    const avant = i;
    n = cartes().length;
    if (!piste.hasAttribute("tabindex")) piste.setAttribute("tabindex", "0");
    const k = garderPosition ? Math.max(0, Math.min(n - 1, avant)) : 0;
    marquer(k);
    piste.scrollTo({ left: k * piste.clientWidth, behavior: "auto" });
    relancer();
  }
  recompter(false);
 
  // Le retard ne concerne que la minuterie : la premiere diapositive est
  // affichee tout de suite dans les deux fenetres.
  if (opts.decal) { clearTimeout(horloge); setTimeout(relancer, opts.decal); }
 
  const api = {
    recompter: recompter,
    aller: aller,
    vignettes: brancherVignettes,
    actif: function (v: boolean) { actif = v; relancer(); },
    relancer: relancer,
  };
  TOUTES.push(api);
 
  if (!brancheVisibilite && typeof document !== "undefined") {
    brancheVisibilite = true;
    document.addEventListener("visibilitychange", function () {
      TOUTES.forEach(function (f) { f.relancer(); });
    });
  }
  return api;
}
