"""tache.py : la tache gn-apercu, cote serveur (lancee par apercu.sh, sous verrou). 29 octobre 2026.
Decide s'il faut refaire la vitre animee de l'apercu Discord et lance le conteneur jetable (image gn-apercu:1) qui fait
le GIF. Le conteneur n'ecrit rien sur le serveur : il rend le GIF sur sa sortie (lue ici, 10 Mo au plus). Puis, ici,
hors du conteneur : verifie ce GIF, le met en service avec la page du robot de Discord (nginx/static/apercu) et verifie
ce que nginx sert. Ne touche ni au site, ni a nginx, ni a l'API.
Modes :
  auto        (crontab, toutes les 10 minutes) : apres une publication, ou si le GIF a plus d'un jour ;
              avant la premiere publication qui suit l'installation : rien ;
  essai       un apercu d'essai dans nginx/static/apercu-essai (pour Rey, sur le staging) ;
  maintenant  refaire le GIF de Discord tout de suite ;
  arret       Discord revient a l'image fixe (discord.html retire) ; la tache ne fait plus rien ;
  marche      remet la tache en marche et refait le GIF ;
  etat        ce qui est en service ; resume : un mot (attente, actif, relance, arret) ;
  attente     (installation) : la premiere fois, la tache attend la prochaine publication ; ensuite rien ne change.
"""
import base64
import binascii
import datetime
import hashlib
import html
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

ST = os.environ.get("GN_ST", "/opt/stack")
H = os.path.join(ST, "apercu")
O = os.path.join(ST, "nginx", "static", "apercu")
OE = os.path.join(ST, "nginx", "static", "apercu-essai")
SITECONF = os.path.join(ST, "nginx", "conf.d", "site.conf")
DIST = os.path.join(ST, "site", "dist")
RAP = os.path.join(ST, "site", ".build-report")
PUB = os.path.join(ST, "site", ".publish")
ETAT = os.path.join(H, "etat.json")
IMAGE = "gn-apercu:1"
CONTENEUR = "gn-apercu"
SITE = "https://gamenime.fr"
HOTE = "gamenime.fr"
UA_DIS = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"
UA_NAV = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
CALME = 120             # secondes sans publication avant un passage
JOUR = 86400 - 300      # un GIF de plus d'un jour est refait (Cette semaine)
PAUSE_ECHEC = 1800      # apres un echec : 30 minutes, le double a chaque echec de suite, 6 heures au plus ;
PAUSE_MAX = 6 * 3600    # une nouvelle publication fait reessayer tout de suite
DUREE_MAX = 900         # un passage dure au plus 15 minutes
GARDER_JOURS = 30       # un GIF reste en ligne 30 jours apres son dernier usage (les anciens messages de Discord le citent)
LIMITE = 6 * 1024 * 1024            # le GIF : 6 Mo au plus
SORTIE_MAX = 10 * 1024 * 1024       # la sortie du conteneur lue ici : 10 Mo au plus (le GIF en base64 et le journal)
LIGNES_MAX = 100        # lignes du conteneur recopiees dans le journal, au plus, par passage
BLOQUE_MAX = 3600       # une publication qui empeche les passages plus d'une heure : dit une fois dans le journal
LARGEUR, HAUTEUR = 800, 420
NOM_GIF = re.compile(r"vitre-[0-9a-f]{12}\.gif")
PAGE = os.path.join(O, "discord.html")


def maintenant():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def net(s, n=220):
    """Un texte venu du conteneur ou d'un programme : une ligne, caracteres imprimables seulement."""
    return re.sub(r"[^\x20-\x7e]", "?", str(s))[:n]


def dire(s):
    print("%s %s" % (maintenant(), s), flush=True)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def lire(p):
    with open(p, "rb") as f:
        return f.read()


def sha_fichier(p):
    try:
        return sha(lire(p))
    except OSError:
        return ""


def mtime(p):
    try:
        return os.stat(p).st_mtime
    except OSError:
        return 0


def retirer(p):
    try:
        os.remove(p)
    except OSError:
        pass


def toucher(p):
    try:
        os.utime(p)
    except OSError:
        pass


def entier(r, k):
    """Un nombre du resultat du conteneur (ou de l'etat) : 0 s'il n'est pas un nombre fini."""
    try:
        x = float(r.get(k) or 0)
        return int(x) if math.isfinite(x) else 0
    except (TypeError, ValueError, OverflowError, AttributeError):
        return 0


def nombre(r, k):
    try:
        x = float(r.get(k) or 0)
        return x if math.isfinite(x) else 0.0
    except (TypeError, ValueError, OverflowError, AttributeError):
        return 0.0


def lire_etat():
    try:
        with open(ETAT, encoding="utf-8") as f:
            e = json.load(f)
        return e if isinstance(e, dict) else {}
    except (OSError, ValueError):
        return {}


def ecrire_atomique(p, b, mode=0o644):
    fd, t = tempfile.mkstemp(prefix=".gn-apercu.", dir=os.path.dirname(p))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(b)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(t, mode)
        os.replace(t, p)
    except BaseException:
        retirer(t)
        raise


def ecrire_etat(e):
    ecrire_atomique(ETAT, json.dumps(e, ensure_ascii=True, sort_keys=True, indent=1).encode("ascii"))


def accueil_sha():
    return sha_fichier(os.path.join(DIST, "index.html"))


# ------------------------------------------------------------------ les balises de partage de l'accueil
META = re.compile(r"<meta\b[^>]*>", re.I)
ATTR = re.compile(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


def balises(t):
    """Les balises meta de la page : (debut, fin, nom (property ou name), contenu, attribut du nom)."""
    out = []
    for m in META.finditer(t):
        a = {}
        for x in ATTR.finditer(m.group(0)):
            a[x.group(1).lower()] = x.group(2) if x.group(2) is not None else x.group(3)
        cle = "property" if "property" in a else "name"
        out.append((m.start(), m.end(), (a.get(cle) or "").strip().lower(), html.unescape(a.get("content") or ""), cle))
    return out


def og_image(corps):
    l = [c for _, _, n, c, _ in balises(corps if isinstance(corps, str) else corps.decode("utf-8", "replace")) if n == "og:image"]
    return l[0] if l else ""


def balise_texte(t, nom):
    l = [c for _, _, n, c, _ in balises(t) if n == nom]
    return l[0] if l else ""


def page_discord(accueil, url_gif):
    """L'accueil en ligne, octet pour octet, sauf l'image de partage : og:image et twitter:image citent le GIF ; les
    balises de taille et de type de l'image fixe (og:image:width, height, type, url, secure_url) sont remplacees par
    celles du GIF."""
    t = accueil.decode("utf-8")
    u = html.escape(url_gif, quote=True)
    b = balises(t)
    og = [x for x in b if x[2] == "og:image"]
    tw = [x for x in b if x[2] in ("twitter:image", "twitter:image:src")]
    autres = [x for x in b if x[2] in ("og:image:width", "og:image:height", "og:image:type", "og:image:url", "og:image:secure_url")]
    if len(og) != 1 or len(tw) > 1:
        raise ValueError("balises de partage inattendues dans l'accueil (og:image %d, twitter:image %d)" % (len(og), len(tw)))
    rempl = {(og[0][0], og[0][1]): '<meta property="og:image" content="%s"><meta property="og:image:type" content="image/gif">'
             '<meta property="og:image:width" content="%d"><meta property="og:image:height" content="%d">' % (u, LARGEUR, HAUTEUR)}
    for d, f, n, _, cle in tw:
        rempl[(d, f)] = '<meta %s="%s" content="%s">' % (cle, n, u)
    for d, f, _, _, _ in autres:
        rempl[(d, f)] = ""
    for (d, f), s in sorted(rempl.items(), reverse=True):
        t = t[:d] + s + t[f:]
    return t.encode("utf-8")


def gif_en_service():
    """Le nom du GIF cite par la page du robot ('' sans page)."""
    try:
        g = os.path.basename(og_image(lire(PAGE)))
    except OSError:
        return ""
    return g if NOM_GIF.fullmatch(g) else ""


# ------------------------------------------------------------------ quand passer
def signature():
    """L'accueil en ligne et la derniere copie en production : change a chaque publication."""
    return "%s|%d" % (accueil_sha(), int(mtime(os.path.join(RAP, "report-production.json"))))


def verrou_tenu(p):
    """Le verrou de la publication (flock) est-il tenu ? Lu dans /proc/locks, sans le prendre."""
    try:
        st = os.stat(p)
        cle = "%02x:%02x:%d" % (os.major(st.st_dev), os.minor(st.st_dev), st.st_ino)
        with open("/proc/locks") as f:
            return any(cle in l.split() for l in f)
    except OSError:
        return False


def calme():
    """Aucune publication en cours ni demandee, une production complete, et rien de copie depuis deux minutes."""
    if verrou_tenu(os.path.join(RAP, ".publication.lock")):
        return False
    rp = os.path.join(RAP, "report-production.json")
    if not os.path.exists(rp):          # retire par la copie le temps de rsync : copie en cours, ou coupee
        return False
    t = time.time()
    for p in (os.path.join(RAP, "publication.json"), rp, os.path.join(DIST, "index.html")):
        if t - mtime(p) < CALME:
            return False
    try:
        if [n for n in os.listdir(PUB) if not n.startswith(".")]:
            return False
    except OSError:
        pass
    return True


def regles_nginx():
    """site.conf porte les blocs APERCU-DISCORD (sinon la page du robot ne servirait a rien) ; rien n'en est affiche."""
    try:
        return b"APERCU-DISCORD-DEBUT" in lire(SITECONF)
    except OSError:
        return False


def page_perimee(e):
    """La page du robot n'est plus la copie de l'accueil en ligne (publication), ou nginx n'a plus ses blocs : retiree,
    Discord a l'image fixe jusqu'au GIF suivant. Rend True si elle a ete retiree."""
    if not os.path.exists(PAGE):
        return False
    d = e.get("derniere") or {}
    if accueil_sha() == d.get("accueil") and regles_nginx():
        return False
    retirer(PAGE)
    e["actif"] = False
    return True


# ------------------------------------------------------------------ le conteneur
def docker(*a, timeout=60):
    try:
        r = subprocess.run(["docker"] + list(a), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return 124, "", type(e).__name__


def image_absente():
    """'' si l'image est la ; sinon pourquoi (elle n'est jamais construite ici : relancer le patch la reconstruit)."""
    c, o, e = docker("image", "inspect", IMAGE, "-f", "{{.Id}}")
    if c == 0:
        return ""
    if "no such image" in e.lower():
        return "image %s absente (supprimee par un nettoyage de docker ?) : relancer le patch apercu-discord la reconstruit" % IMAGE
    return "docker injoignable (%s)" % net((e.strip().splitlines() or ["?"])[-1], 160)


def nettoyer_conteneur():
    c, o, e = docker("inspect", "-f", '{{index .Config.Labels "gn"}}', CONTENEUR)
    if c == 0 and o.strip() == "apercu":
        docker("rm", "-f", CONTENEUR)


def gif_valide(b):
    """'' si b est un GIF complet de 800 x 420 et de 6 Mo au plus ; sinon pourquoi."""
    if len(b) < 10000 or len(b) > LIMITE:
        return "%d octets" % len(b)
    if b[:6] != b"GIF89a" or b[-1:] != b"\x3b":
        return "pas un GIF complet"
    w, h = b[6] | b[7] << 8, b[8] | b[9] << 8
    if (w, h) != (LARGEUR, HAUTEUR):
        return "%d x %d au lieu de %d x %d" % (w, h, LARGEUR, HAUTEUR)
    return ""


def lancer():
    """Le conteneur jetable ; renvoie (code, resultat, GIF). Sa sortie est lue ici, 10 Mo au plus ; au-dela, ou apres
    16 minutes, il est arrete et supprime."""
    pb = image_absente()
    if pb:
        return 4, {"erreur": pb}, None
    nettoyer_conteneur()
    argv = ["timeout", str(DUREE_MAX), "docker", "run", "--rm", "--init", "--name", CONTENEUR, "--label", "gn=apercu",
            "--cpus", "2", "--cpu-shares", "256", "--memory", "1536m", "--memory-swap", "1536m", "--pids-limit", "512",
            "--shm-size", "256m", "--user", "%d:%d" % (os.getuid(), os.getgid()), "--read-only",
            "--tmpfs", "/tmp:rw,size=768m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "-e", "HOME=/tmp", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "APERCU_SITE=" + SITE,
            "--add-host", "%s:host-gateway" % HOTE,
            "-v", "%s/app:/app:ro" % H, "-v", "%s:/dist:ro" % DIST, "-w", "/app",
            IMAGE, "python", "apercu.py"]
    debut = time.time()
    try:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as x:
        return 4, {"erreur": "docker impossible a lancer (%s)" % type(x).__name__}, None
    arrete = {"pourquoi": ""}

    def arreter(pourquoi):
        if not arrete["pourquoi"]:
            arrete["pourquoi"] = pourquoi
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass

    minuterie = threading.Timer(DUREE_MAX + 60, arreter, ("trop long",))
    minuterie.daemon = True
    minuterie.start()
    res, morceaux, entete, dans_gif, lus, lignes = {}, [], None, False, 0, 0
    try:
        while True:
            brut = p.stdout.readline(65536)
            if not brut:
                break
            lus += len(brut)
            if lus > SORTIE_MAX:
                arreter("sortie de plus de %d Mo" % (SORTIE_MAX // 1048576))
                break
            l = brut.decode("ascii", "replace").rstrip("\r\n")
            if dans_gif:
                if l == "GIF-FIN":
                    dans_gif = False
                else:
                    morceaux.append(l)
            elif l.startswith("GIF-DEBUT ") and entete is None:
                entete = l.split()[1:3]
                dans_gif = True
            elif l.startswith("RESULTAT "):
                try:
                    x = json.loads(l[9:])
                    res = x if isinstance(x, dict) else {}
                except ValueError:
                    res = {}
            elif l.strip():
                lignes += 1
                if lignes <= LIGNES_MAX:
                    dire("  | " + net(l))
    finally:
        if lignes > LIGNES_MAX:
            dire("  | (%d lignes de plus, non recopiees)" % (lignes - LIGNES_MAX))
        minuterie.cancel()
        try:
            p.stdout.close()
        except OSError:
            pass
        try:
            code = p.wait(timeout=60)
        except subprocess.TimeoutExpired:
            arreter("ne s'arrete pas")
            code = 124
    if arrete["pourquoi"] or code == 124:
        nettoyer_conteneur()
    duree = round(time.time() - debut, 1)
    if arrete["pourquoi"]:
        return 4, {"erreur": "conteneur arrete (%s)" % arrete["pourquoi"], "duree_s": duree}, None
    c = entier(res, "code") if "code" in res else (4 if code == 0 else code)
    if not res:
        return (c or 4), {"erreur": "le conteneur n'a pas rendu de resultat (code %d%s)" % (code, ", trop long" if code == 124 else ""),
                          "duree_s": duree}, None
    res["duree_s"] = duree
    if c != 0:
        return c, res, None
    if code != 0:
        return 4, dict(res, erreur="le conteneur dit fait, mais finit en code %d" % code), None
    try:
        gif = base64.b64decode("".join(morceaux), validate=True)
    except (binascii.Error, ValueError):
        return 4, dict(res, erreur="GIF du conteneur refuse (base64 illisible)"), None
    if not entete or len(entete) != 2 or entete[0] != str(len(gif)) or entete[1] != sha(gif):
        return 4, dict(res, erreur="GIF du conteneur refuse (incomplet)"), None
    pb = gif_valide(gif)
    if pb:
        return 4, dict(res, erreur="GIF du conteneur refuse (%s)" % pb), None
    return 0, res, gif


# ------------------------------------------------------------------ la mise en service
def mettre_en_service(r, gif, acc0):
    """Production : le GIF sous le nom tire de son contenu, puis la page du robot (faite ici, depuis l'accueil en ligne).
    Rien n'est ecrit si quelque chose manque. acc0 : l'empreinte de l'accueil au debut du passage."""
    try:
        acc = lire(os.path.join(DIST, "index.html"))
    except OSError:
        return 4, {"erreur": "accueil du site illisible"}
    if sha(acc) != r.get("accueil"):
        if sha(acc) == acc0:            # l'accueil n'a pas change : le conteneur n'a pas photographie l'accueil en ligne
            return 4, {"erreur": "le conteneur n'a pas photographie l'accueil en ligne"}
        return 3, {"erreur": "l'accueil a change pendant le passage (publication ?)"}
    nom = "vitre-%s.gif" % sha(gif)[:12]
    try:
        page = page_discord(acc, "%s/apercu/%s" % (SITE, nom))
    except (ValueError, UnicodeDecodeError) as x:
        return 4, {"erreur": net(x, 200)}
    os.makedirs(O, exist_ok=True)
    p = os.path.join(O, nom)
    if sha_fichier(p) == sha(gif):
        toucher(p)                          # deja la : sa date dit son dernier usage (menage)
    else:
        ecrire_atomique(p, gif)
    ancien = gif_en_service()
    if ancien:
        toucher(os.path.join(O, ancien))    # quitte le service maintenant : ses 30 jours partent d'ici
    ecrire_atomique(PAGE, page)
    r.update(gif=nom, octets=len(gif))
    return 0, r


PAGE_ESSAI = """<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>GameNime - apercu Discord (essai)</title>
<style>
@font-face { font-family: "GN Inter"; font-weight: 400; src: url("/fonts/inter-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "GN Inter"; font-weight: 600; src: url("/fonts/inter-latin-600-normal.woff2") format("woff2"); }
* { box-sizing: border-box; }
body { margin: 0; background: #0d0d10; color: #e6e7ea; font: 400 15px/1.45 "GN Inter", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font: 600 24px/1.2 "GN Inter", system-ui, sans-serif; margin: 0 0 6px; color: #fff; }
p { margin: 0 0 18px; color: #a2a4ac; }
.msg { background: #313338; border-radius: 14px; padding: 18px 20px; color: #dbdee1; display: flex; gap: 12px; }
.av { flex: none; width: 40px; height: 40px; border-radius: 50%%; background: #5865f2; display: grid; place-items: center; color: #fff; font-weight: 600; }
.nom { color: #f2f3f5; font-weight: 600; } .h { color: #949ba4; font-size: 12px; margin-left: 4px; }
.lien { color: #00a8fc; }
.emb { margin-top: 4px; max-width: 432px; background: #2b2d31; border-left: 4px solid #ff9c4c; border-radius: 4px; padding: 10px 16px 16px 12px; }
.site { font-size: 12px; margin-top: 4px; } .tit { color: #00a8fc; font-weight: 600; font-size: 16px; margin-top: 6px; }
.desc { margin-top: 6px; font-size: 14px; }
.emb img { display: block; width: 100%%; max-width: 400px; height: auto; margin-top: 14px; border-radius: 4px; }
.fiche { margin-top: 26px; font-size: 13.5px; color: #8d8f97; }
.grand { margin-top: 26px; } .grand img { display: block; width: 100%%; height: auto; border-radius: 10px; }
</style></head><body><main>
<h1>Apercu Discord : la vitre qui defile (essai)</h1>
<p>Fait le %(quand)s a partir de l'accueil en ligne. Discord ne recoit ce GIF qu'apres la publication suivante.</p>
<div class="msg"><div class="av">V</div><div style="min-width:0">
<div><span class="nom">Vous</span><span class="h">aujourd'hui</span></div><div class="lien">https://gamenime.fr</div>
<div class="emb"><div class="site">GameNime</div><div class="tit">%(titre)s</div><div class="desc">%(desc)s</div>
<img src="essai.gif?%(cle)s" alt="Apercu anime"></div></div></div>
<div class="grand"><img src="essai.gif?%(cle)s" alt="Le GIF en grand"></div>
<div class="fiche">%(fiche)s</div>
</main></body></html>
"""


def heure_de_paris():
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo("Europe/Paris")).strftime("%d/%m/%Y a %H:%M (heure de Paris)")
    except Exception:
        return datetime.datetime.now(datetime.timezone.utc).strftime("%d/%m/%Y a %H:%M UTC")


def mettre_en_essai(r, gif):
    """Essai : le GIF et sa page dans nginx/static/apercu-essai ; la page du robot est calculee aussi (comme en
    production), pour s'assurer que l'accueil en ligne s'y prete."""
    try:
        acc = lire(os.path.join(DIST, "index.html"))
        page_discord(acc, "%s/apercu/vitre-%s.gif" % (SITE, sha(gif)[:12]))
    except OSError:
        return 4, {"erreur": "accueil du site illisible"}
    except (ValueError, UnicodeDecodeError) as x:
        return 4, {"erreur": net(x, 200)}
    t = acc.decode("utf-8", "replace")
    fiche = ("%d octets ; %d x %d ; %d images ; %.1f s en boucle ; perte %d ; jaquettes chargees %d sur %d ; accueil %s"
             % (len(gif), LARGEUR, HAUTEUR, entier(r, "images"), nombre(r, "duree_ms") / 1000, entier(r, "perte"),
                entier(r, "images_chargees"), entier(r, "images_vues"), sha(acc)[:12]))
    page = PAGE_ESSAI % {"quand": html.escape(heure_de_paris()), "cle": sha(gif)[:12], "fiche": html.escape(fiche),
                         "titre": html.escape(balise_texte(t, "og:title") or "GameNime"),
                         "desc": html.escape(balise_texte(t, "og:description"))}
    os.makedirs(OE, exist_ok=True)
    ecrire_atomique(os.path.join(OE, "essai.gif"), gif)
    ecrire_atomique(os.path.join(OE, "essai.html"), page.encode("utf-8"))
    r.update(octets=len(gif))
    return 0, r


def menage():
    """Les GIF : celui de la page du robot (sa date est rafraichie : il sert encore), les trois plus recents et tous
    ceux qui ont servi il y a moins de 30 jours restent ; les fichiers d'une ecriture coupee partent apres une heure."""
    garder = gif_en_service()
    if garder:
        toucher(os.path.join(O, garder))
    t = time.time()
    for d in (O, OE):
        try:
            noms = os.listdir(d)
        except OSError:
            continue
        gifs = sorted((mtime(os.path.join(d, n)), n) for n in noms if NOM_GIF.fullmatch(n))
        recents = {n for _, n in gifs[-3:]} | {garder}
        for m, n in gifs:
            if n not in recents and t - m > GARDER_JOURS * 86400:
                retirer(os.path.join(d, n))
        for n in noms:
            if n.startswith(".gn-apercu.") and t - mtime(os.path.join(d, n)) > 3600:
                retirer(os.path.join(d, n))


def curl(ua, chemin="/", tete=False):
    argv = ["curl", "-sS", "-m", "20", "--resolve", "%s:443:127.0.0.1" % HOTE, "-A", ua, "-o", "-", "-w", "\n@@%{http_code} %{content_type}"]
    if tete:
        argv[1:1] = ["-I"]
    try:
        r = subprocess.run(argv + [SITE + chemin], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
        t = r.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return "000", "", ""
    corps, _, fin = t.rpartition("\n@@")
    p = fin.split(" ", 1)
    return p[0], (p[1] if len(p) > 1 else ""), corps


def verifier(gif):
    """Ce que nginx sert : le robot de Discord a le GIF, un navigateur l'accueil normal, le GIF repond."""
    url = "%s/apercu/%s" % (SITE, gif)
    c1, t1, b1 = curl(UA_DIS)
    c2, t2, b2 = curl(UA_NAV)
    c3, t3, b3 = curl(UA_DIS, "/apercu/" + gif, tete=True)
    i1, i2 = og_image(b1), og_image(b2)
    bon = c1 == "200" and i1 == url and c2 == "200" and i2 and "/apercu/" not in i2 and c3 == "200" and t3.startswith("image/gif")
    return bon, "robot de Discord %s (%s) ; navigateur %s (%s) ; GIF %s %s" % (c1, net(i1[-40:]), c2, net(i2[-30:]), c3, net(t3, 40))


# ------------------------------------------------------------------ les passages
def echec(e, acc):
    e.update(echecs=entier(e, "echecs") + 1, echec_quand=time.time(), echec_accueil=acc)


def produire(e, raison):
    dire("passage (%s) : le GIF de Discord" % raison)
    e["tentative"] = time.time()
    e.pop("attente", None)              # la publication attendue a eu lieu (ou passage demande a la main)
    acc = accueil_sha()
    # la page du robot ne reste en service pendant le passage que si l'accueil n'a pas change
    if page_perimee(e):
        dire("  --  l'accueil a change : Discord a l'image fixe le temps du passage")
    ecrire_etat(e)
    if not regles_nginx():
        echec(e, acc)
        dire("  KO  site.conf n'a pas les blocs APERCU-DISCORD : rien a servir (relancer le patch apercu-discord)")
        ecrire_etat(e)
        return 1
    try:
        code = passage_production(e, acc)
    except Exception as x:              # jamais de trace ; compte comme un echec (pause avant le suivant)
        code = 4
        echec(e, acc)
        e["actif"] = en_service(e)
        dire("  KO  passage interrompu : %s %s" % (type(x).__name__, net(x, 160)))
    try:
        menage()
    except Exception:
        pass
    ecrire_etat(e)
    return 0 if code in (0, 3) else 1


def passage_production(e, acc):
    code, r, gif = lancer()
    if code == 3 and accueil_sha() == acc:
        # le conteneur dit que l'accueil a change pendant le passage, mais il n'a pas change : un echec
        code, r = 4, dict(r, erreur="le conteneur dit que l'accueil a change, ce n'est pas le cas")
    if code == 0:
        code, r2 = mettre_en_service(r, gif, acc)
        r = dict(r, **r2) if code == 0 else dict(r2, duree_s=r.get("duree_s"))
    if code == 0:
        bon, detail = verifier(r["gif"])
        if bon:
            e.update(actif=True, echecs=0, echec_quand=0, echec_accueil="",
                     derniere={"quand": time.time(), "accueil": r.get("accueil"), "gif": r["gif"], "octets": r.get("octets"),
                               "images": entier(r, "images"), "duree_s": r.get("duree_s")})
            dire("  OK  %s en service pour Discord (%d octets, %d images, %s s) ; %s"
                 % (r["gif"], r.get("octets", 0), entier(r, "images"), r.get("duree_s"), detail))
            return 0
        # nginx ne sert pas ce qu'il faut : Discord revient a l'accueil normal (image fixe)
        try:
            os.replace(PAGE, PAGE + ".ko")
        except OSError:
            pass
        e["actif"] = False
        echec(e, acc)
        dire("  KO  nginx ne sert pas le GIF comme prevu : Discord garde l'image fixe (%s)" % detail)
        return 4
    if code == 3:
        dire("  --  %s : refait au passage suivant" % net(r.get("erreur")))
        return 3
    echec(e, acc)
    e["actif"] = en_service(e)
    dire("  KO  %s (code %d) : %s" % (net(r.get("erreur")), code, "le GIF d'avant reste en service" if os.path.exists(PAGE)
                                      else "Discord garde l'image fixe (aucun GIF en service)"))
    return code


def pause(e):
    return min(PAUSE_ECHEC * 2 ** max(0, entier(e, "echecs") - 1), PAUSE_MAX)


def auto():
    e = lire_etat()
    # d'abord, a chaque passage de la crontab : jamais de page du robot perimee (publication, ou blocs de nginx retires)
    if page_perimee(e):
        dire("l'accueil a change (ou site.conf n'a plus les blocs APERCU-DISCORD) : Discord a l'image fixe jusqu'au GIF suivant")
        ecrire_etat(e)
    if not e.get("marche"):
        return 0
    if not regles_nginx():
        return 0                        # rien a servir : relancer le patch remet les blocs
    if e.get("attente") and signature() == e["attente"]:
        return 0                        # avant la premiere publication qui suit l'installation
    if not calme():
        t = time.time()
        if not e.get("bloque_depuis"):
            e["bloque_depuis"] = t
            ecrire_etat(e)
        elif t - float(e["bloque_depuis"]) > BLOQUE_MAX and not e.get("bloque_dit"):
            dire("la tache attend la fin d'une publication depuis plus d'une heure (verrou de la publication tenu, rapport de "
                 "la copie absent ou demande en attente) : aucun passage en attendant")
            e["bloque_dit"] = True
            ecrire_etat(e)
        return 0
    if e.get("bloque_depuis"):
        e.pop("bloque_depuis", None)
        e.pop("bloque_dit", None)
        ecrire_etat(e)
    acc = accueil_sha()
    if not acc:
        return 0
    # apres un echec, une pause (sauf si une publication a change l'accueil depuis)
    if e.get("echec_quand") and acc == e.get("echec_accueil") and time.time() - nombre(e, "echec_quand") < pause(e):
        return 0
    d = e.get("derniere") or {}
    if e.get("attente"):
        return produire(e, "publication : premier GIF pour Discord")
    if acc != d.get("accueil"):
        return produire(e, "publication")
    if not os.path.exists(PAGE):
        return produire(e, "page du robot absente")
    if time.time() - nombre(d, "quand") >= JOUR:
        return produire(e, "chaque jour")
    return 0


def essai():
    dire("passage (essai) : apercu pour le staging")
    code, r, gif = lancer()
    if code == 0:
        code, r2 = mettre_en_essai(r, gif)
        r = dict(r, **r2) if code == 0 else dict(r2, duree_s=r.get("duree_s"))
    if code == 0:
        dire("  OK  essai.gif : %d octets, %d images, %.1f s en boucle ; jaquettes %d sur %d ; fait en %s s"
             % (r.get("octets", 0), entier(r, "images"), nombre(r, "duree_ms") / 1000, entier(r, "images_chargees"),
                entier(r, "images_vues"), r.get("duree_s")))
        dire("      a regarder : https://staging.gamenime.fr/apercu-essai/essai.html (mot de passe du staging)")
    else:
        dire("  KO  %s (code %d)" % (net(r.get("erreur")), code))
    print("RESULTAT " + json.dumps({"code": code, "duree_s": r.get("duree_s"), "octets": r.get("octets", 0)}, sort_keys=True), flush=True)
    return 0 if code == 0 else 1


def arret():
    e = lire_etat()
    retirer(PAGE)
    e.update(marche=False, actif=False)
    ecrire_etat(e)
    dire("arret : Discord revient a l'image fixe ; la tache ne fait plus rien (pour la remettre : apercu.sh marche)")
    return 0


def marche():
    e = lire_etat()
    e.update(marche=True, echecs=0, echec_quand=0, echec_accueil="")
    ecrire_etat(e)
    return produire(e, "remise en marche")


def maintenant_():
    e = lire_etat()
    if not e.get("marche"):
        dire("la tache est a l'arret : apercu.sh marche pour la remettre")
        return 1
    return produire(e, "a la main")


def en_service(e):
    return bool(e.get("actif")) and os.path.exists(PAGE)


def resume():
    e = lire_etat()
    print("arret" if not e.get("marche") else "actif" if en_service(e) else "attente" if e.get("attente") else "relance")
    return 0


def etat():
    e = lire_etat()
    d = e.get("derniere") or {}
    dire("tache en marche : %s ; GIF servi a Discord : %s" % ("oui" if e.get("marche") else "non",
         ("oui, " + net(d.get("gif"))) if en_service(e) else "non"))
    if d.get("quand"):
        dire("dernier GIF : %s, %d octets, le %s" % (net(d.get("gif")), entier(d, "octets"),
             datetime.datetime.fromtimestamp(nombre(d, "quand")).strftime("%Y-%m-%d %H:%M")))
    if e.get("marche") and e.get("attente"):
        dire("en attente : le premier GIF pour Discord sera fait apres la prochaine publication")
    elif e.get("marche") and not en_service(e):
        dire("pas de GIF en service pour l'instant : la tache le refait a son prochain passage (voir journal.txt)")
    if e.get("echecs"):
        dire("echecs de suite : %d (voir journal.txt)" % entier(e, "echecs"))
    if not regles_nginx():
        dire("ATTENTION site.conf n'a pas les blocs APERCU-DISCORD : la tache ne fait rien (relancer le patch apercu-discord)")
    pb = image_absente()
    if pb:
        dire("ATTENTION " + pb)
    return 0


def attente():
    e = lire_etat()
    if e.get("installe"):
        # deja installee (patch relance) : la tache garde son etat (en marche ou a l'arret, attente comprise)
        e["actif"] = en_service(e)
    else:
        retirer(PAGE)                   # premiere installation : aucune page du robot d'avant
        e = {"marche": True, "actif": False, "installe": time.time(), "attente": signature()}
    ecrire_etat(e)
    return 0


if __name__ == "__main__":
    m = sys.argv[1] if len(sys.argv) > 1 else "auto"
    f = {"auto": auto, "essai": essai, "maintenant": maintenant_, "arret": arret, "marche": marche, "etat": etat,
         "resume": resume, "attente": attente}.get(m)
    if f is None:
        print("usage : apercu.sh [auto|essai|maintenant|arret|marche|etat]")
        sys.exit(2)
    try:
        sys.exit(f())
    except KeyboardInterrupt:
        sys.exit(1)
    except Exception as x:  # jamais de trace : une ligne dans le journal
        dire("KO tache interrompue : %s %s" % (type(x).__name__, net(x, 200)))
        sys.exit(1)
