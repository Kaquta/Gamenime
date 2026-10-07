#!/usr/bin/env bash
# Journal des executions sous les boutons de process du dashboard.
# Ajoute : lecture de /admin/runs, "derniere execution" sous chaque bouton,
# bandeau de verrou, distinction 409 / vraie panne, polling adaptatif.
set -euo pipefail

cd /opt/stack/content-api/src/gamenime

python3 - <<'PYEOF'
import shutil, sys
f = "dashboard.html"; src = open(f, encoding="utf-8").read()

if "function gnMajRuns" in src:
    print("STOP : deja applique"); sys.exit(0)

A1 = "  async function lancerProcess(btn, endpoint, label) {"
if A1 not in src:
    print("ERREUR : lancerProcess introuvable"); sys.exit(1)

BLOC = '''  // ═══ Journal des exécutions ═══
  // Un bouton ne disait ni quand il avait tourné, ni ce qu'il avait changé : on
  // cliquait à l'aveugle. La source est /admin/runs, donc exactement ce que la
  // base sait — pas un état reconstitué dans l'onglet, qui serait faux dès
  // qu'un autre onglet agit.
  var gnRunsTimer = null;
  var GN_PROC_FN = { lancerMerge: "merge-duplicates", lancerCleanup: "cleanup-niches" };

  function gnProcessDuBouton(b) {
    var oc = b.getAttribute("onclick") || "";
    var m = /lancerProcess\\(this,\\s*'([a-z0-9-]+)'/.exec(oc);
    if (m) return m[1];
    var fn = /^\\s*([a-zA-Z]+)\\(/.exec(oc);
    return fn && GN_PROC_FN[fn[1]] ? GN_PROC_FN[fn[1]] : null;
  }

  function gnLigneDerniere(d) {
    if (!d) return '<span class="gn-der-rien">jamais lancé</span>';
    var quand = d.debut ? gnDuree(Date.now() - d.debut) : "?";
    if (d.etat === "en_cours") {
      return '<span class="gn-der-run">en cours depuis ' + quand + '</span>';
    }
    if (d.etat === "interrompu") {
      return '<span class="gn-der-ko">il y a ' + quand + " · interrompu par un redémarrage</span>";
    }
    var duree = d.duree_ms == null ? ""
      : (d.duree_ms < 1000 ? d.duree_ms + " ms"
        : (d.duree_ms / 1000).toFixed(d.duree_ms < 10000 ? 1 : 0) + " s");
    var cl = d.etat === "reussi" ? "gn-der-ok" : "gn-der-ko";
    return '<span class="' + cl + '">il y a ' + quand
      + (duree ? " · " + duree : "")
      + (d.resume ? " · " + d.resume : "") + "</span>";
  }

  async function gnMajRuns() {
    try {
      var r = await fetch("/dashboard/admin/runs");
      if (!r.ok) {
        // Replanifier malgre tout : sans ca, une seule reponse en erreur
        // tuerait la boucle de rafraichissement pour de bon.
        if (window.console) console.warn("gnMajRuns : /admin/runs a repondu " + r.status);
        clearTimeout(gnRunsTimer);
        gnRunsTimer = setTimeout(gnMajRuns, 60000);
        return;
      }
      var j = await r.json();
      var verrou = j.verrou || null;
      var lourds = j.process || [];

      document.querySelectorAll("button.proc-launch").forEach(function (b) {
        var p = gnProcessDuBouton(b);
        if (p === null && window.console) {
          console.warn("gnMajRuns : process inconnu pour un bouton", b.getAttribute("onclick"));
        }
        var l = b.nextElementSibling;
        if (!l || !l.classList || !l.classList.contains("gn-der")) {
          l = document.createElement("div");
          l.className = "gn-der";
          b.insertAdjacentElement("afterend", l);
        }
        l.innerHTML = p ? gnLigneDerniere(j.derniers && j.derniers[p]) : "";
        // Le bouton reflete le verrou, il ne le decide pas : c'est la
        // difference avec le disabled d'avant, qui ne tenait que dans l'onglet.
        if (verrou && p && lourds.indexOf(p) !== -1) {
          b.disabled = true;
          b.title = "Verrou pris par " + verrou.process;
        } else if (b.getAttribute("data-gn-en-cours") !== "1") {
          b.disabled = false;
          b.title = "";
        }
      });

      var sec = document.getElementById("sec-process");
      if (sec) {
        var ban = document.getElementById("gn-verrou");
        if (verrou) {
          if (!ban) {
            ban = document.createElement("div");
            ban.id = "gn-verrou"; ban.className = "gn-verrou";
            sec.insertBefore(ban, sec.firstChild);
          }
          ban.innerHTML = "<b>\\u2298 Verrou pris par \\u00ab " + verrou.process + " \\u00bb depuis "
            + (verrou.depuis_s == null ? "?" : verrou.depuis_s + " s")
            + ".</b> <span>Les autres process attendent la fin \\u2014 le verrou est c\\u00f4t\\u00e9 serveur, "
            + "un second onglet ne peut pas passer outre.</span>";
        } else if (ban) {
          ban.remove();
        }
      }

      // Tant qu'un process tourne on suit de pres ; sinon on laisse la machine
      // tranquille. Une requete toutes les 30 s ne coute rien.
      clearTimeout(gnRunsTimer);
      gnRunsTimer = setTimeout(gnMajRuns, verrou ? 3000 : 30000);
    } catch (e) {
      // Le dashboard ne doit pas casser parce que son journal est muet.
      if (window.console) console.warn("gnMajRuns :", e);
      clearTimeout(gnRunsTimer);
      gnRunsTimer = setTimeout(gnMajRuns, 60000);
    }
  }

  // Expose : si le script du dashboard est encapsule, la fonction n'est pas
  // visible depuis le listener de fin de page. JavaScript, pas TypeScript.
  window.gnMajRuns = gnMajRuns;

'''
src = src.replace(A1, BLOC + A1, 1)

A2 = '''    btn.disabled = true;
    btn.textContent = "⏳ En cours...";'''
if A2 not in src:
    print("ERREUR : debut de lancerProcess introuvable"); sys.exit(1)
src = src.replace(A2, '''    btn.disabled = true;
    btn.setAttribute("data-gn-en-cours", "1");
    btn.textContent = "⏳ En cours...";''', 1)

A3 = '''      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!res.ok || data.ok === false) {'''
if A3 not in src:
    print("ERREUR : branche d'erreur de lancerProcess introuvable"); sys.exit(1)
src = src.replace(A3, '''      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      // Un 409 de verrou n'est pas un echec du process : c'est un refus de la
      // machine, qui est occupee. L'afficher en rouge comme une panne
      // apprendrait a ignorer les vraies pannes.
      if (res.status === 409 && data.verrou) {
        consoleLine("  \\u2298 Refus\\u00e9 \\u2014 " + (data.msg || "un autre process occupe la machine"), "info");
        gnMajRuns();
        return;
      }
      if (!res.ok || data.ok === false) {''', 1)

A4 = '''    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }'''
if A4 not in src:
    print("ERREUR : bloc finally introuvable"); sys.exit(1)
src = src.replace(A4, '''    } finally {
      btn.removeAttribute("data-gn-en-cours");
      btn.disabled = false;
      btn.textContent = original;
      gnMajRuns();
    }''', 1)

CSS = """
/* === Journal des executions sous les boutons de process === */
.gn-der{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.7rem;line-height:1.5;
        margin-top:6px;color:#6b6b74}
.gn-der-ok{color:#8a8a92}
.gn-der-ok::before{content:"\\25cf  ";color:#30d16c}
.gn-der-ko{color:#ff7a70}
.gn-der-ko::before{content:"\\25cf  ";color:#ff453a}
.gn-der-run{color:#ffe8c0}
.gn-der-run::before{content:"\\25cf  ";color:#d9a978}
.gn-der-rien{color:#47474f}
.gn-der-rien::before{content:"\\25cb  ";color:#47474f}
.gn-verrou{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 14px;border-radius:12px;
           margin:0 0 13px;background:rgba(217,169,120,.1);border:1px solid rgba(217,169,120,.26);
           font-size:.8rem;line-height:1.5}
.gn-verrou b{color:#ffe8c0;font-weight:650}
.gn-verrou span{color:#9b9ba3}
"""
i = src.rfind("</style>")
if i < 0:
    print("ERREUR : </style> introuvable"); sys.exit(1)
src = src[:i] + CSS + src[i:]

JS = """<script>
/* Premier releve du journal des executions, une fois la page en place. */
window.addEventListener("load", function () {
  if (typeof window.gnMajRuns === "function") setTimeout(window.gnMajRuns, 800);
  else if (window.console) console.warn("gnMajRuns indisponible depuis le load listener");
});
</script>
"""
j = src.rfind("</body>")
if j < 0:
    print("ERREUR : </body> introuvable"); sys.exit(1)
src = src[:j] + JS + src[j:]

shutil.copy2(f, f + ".bak-journal-runs")
open(f, "w", encoding="utf-8").write(src)
print("dashboard.html : journal branche, verrou affiche, 409 distingue")
PYEOF

# ── 2. Marqueurs ─────────────────────────────────────────────────────────────
n=$(grep -c "function gnMajRuns" dashboard.html || true)
[ "$n" -eq 1 ] || { echo "STOP : gnMajRuns vu $n fois, attendu 1"; exit 1; }
n=$(grep -c "window.gnMajRuns" dashboard.html || true)
[ "$n" -ge 2 ] || { echo "STOP : exposition de gnMajRuns incomplete ($n)"; exit 1; }
grep -q "window as any" dashboard.html && { echo "STOP : syntaxe TypeScript dans du HTML"; exit 1; }
echo "marqueurs presents"

# ── 3. Build sans tube : le code de sortie doit etre celui de docker ─────────
cd /opt/stack
LOG=/tmp/gn-build-journal.log
if ! docker compose build content-api > "$LOG" 2>&1; then
  tail -20 "$LOG"
  echo "STOP : build Docker echoue"; exit 1
fi
tail -3 "$LOG"
docker compose up -d content-api

# ── 4. Health check interne : ni Basic Auth, ni nginx dans l'equation ───────
PRET=0
for i in $(seq 1 20); do
  if docker exec content-api node -e 'fetch("http://localhost:3000/admin/runs").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    echo "  /admin/runs repond (${i}s)"; PRET=1; break
  fi
  sleep 1
done
if [ "$PRET" -ne 1 ]; then
  echo "STOP : /admin/runs muet apres 20s"
  docker compose logs --tail=40 content-api
  exit 1
fi

# ── 5. Forme de la reponse ───────────────────────────────────────────────────
docker exec content-api node -e '
fetch("http://localhost:3000/admin/runs").then(r=>r.text()).then(t=>{
  var d=JSON.parse(t);
  if(d.ok!==true) throw new Error("ok != true");
  if(!Array.isArray(d.process)) throw new Error("process absent");
  if(!("derniers" in d)) throw new Error("derniers absent");
  if(!("verrou" in d)) throw new Error("verrou absent");
  console.log("  process surveilles :",d.process.length);
  console.log("  runs enregistres   :",Object.keys(d.derniers).length);
  console.log("  verrou actif       :",d.verrou?d.verrou.process:"aucun");
}).catch(e=>{console.error("  ECHEC :",e.message);process.exit(1)})'

echo
echo "OK — journal des executions actif"
echo "Sauvegarde : dashboard.html.bak-journal-runs"
