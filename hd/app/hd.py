# -*- coding: utf-8 -*-
"""GameNime — images HD de « Cette semaine », du coin du personnage et du Top qui defile (tache gn-hd).

Lancee toutes les heures par gn-hd.sh, dans un conteneur (image gn-hd:1).
  1. lit le flux public de la semaine (les episodes et leurs jaquettes AniList), et
     les images du coin des pages Anime, Jeux et A venir (6 octobre 2026) : le Top 5
     du Top 25 Anime, le Top 5 du Top 25 Jeux, le Top 3 des sorties du mois de chaque
     onglet d'A venir, Animes et Jeux (memes requetes et meme choix que le script du
     coin) ; elles passent en premier ;
  2. pour chaque jaquette qui n'a pas encore d'image HD, la plus populaire d'abord :
     - jeux : pas d'IA (le modele est fait pour l'anime) : la grande jaquette
       (IGDB en 1080p, RAWG en taille d'origine), reduite seulement, sans visage ;
     - agrandissement x4 par IA (Real-ESRGAN x4plus_anime_6B, sans PyTorch) ;
     - visage du personnage (lbpcascade_animeface) : cadrage de la case et du coin ;
     - teinte dominante (meme calcul que la page) : couleur Caméléon ;
     - deux WebP, 960 et 1600 px de large ;
  3. reecrit le manifeste (manifeste.json) apres chaque image terminee, d'un
     seul coup (fichier temporaire puis renommage) : la page ne lit jamais un
     manifeste a moitie ecrit, et une image HD n'y entre qu'une fois ses
     fichiers poses ;
  4. efface les images des jaquettes absentes du flux depuis GARDE jours.

La page lit /hd/manifeste.json : elle prend l'image HD quand elle existe, la
jaquette d'AniList sinon. N'ecrit que dans $SORTIE (servi par nginx sur /hd/)."""
import colorsys, datetime, hashlib, io, json, math, os, re, sys, time, urllib.request
from PIL import Image

SORTIE = os.environ.get("SORTIE", "/sortie")
MODELES = os.environ.get("MODELES", "/modeles")
FLUX = os.environ.get("FLUX", "https://gamenime.fr/api/feed/week")
API = os.environ.get("API", FLUX.rsplit("/", 1)[0] + "/")     # .../api/feed/ : les flux du Top
MAX = int(os.environ.get("MAX", "0") or 0)              # images a fabriquer au plus (0 : toutes)
BUDGET = float(os.environ.get("BUDGET", "2700") or 2700)  # secondes : pas de nouvelle image au-dela
GARDE = int(os.environ.get("GARDE", "21") or 21)         # jours sans apparaitre dans le flux avant effacement
QUALITE = int(os.environ.get("QUALITE", "86") or 86)     # WebP
TUILE = int(os.environ.get("TUILE", "128") or 128)       # tuiles de l'IA (memoire bornee)
LOCAL = os.environ.get("GN_HD_LOCAL") == "1"             # essais hors serveur : chemins de fichiers acceptes
LARGEURS = (960, 1600)
MODELE = "x4plus_anime_6B"
MANIF = os.path.join(SORTIE, "manifeste.json")
UA = {"User-Agent": "Mozilla/5.0 (GameNime gn-hd)"}
T0 = time.time()


def dire(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def maintenant():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


AUJ = datetime.date.today().isoformat()


def get(u, essais=3, limite=25_000_000):
    if not re.match(r"^https?://", u):
        if LOCAL and os.path.isfile(u):
            return open(u, "rb").read()
        raise ValueError("adresse refusee : %s" % u[:80])
    err = None
    for k in range(essais):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30) as f:
                return f.read(limite)
        except Exception as e:          # reseau : on reessaie un peu plus tard
            err = e
            time.sleep(2 * (k + 1))
    raise err


def nom(url):
    """nom de fichier sur, lisible et unique : base de la jaquette + 8 caracteres de son empreinte"""
    base = os.path.splitext(url.split("?")[0].rstrip("/").rsplit("/", 1)[-1])[0]
    base = re.sub(r"[^A-Za-z0-9_-]", "", base)[:40] or "jaquette"
    return base + "-" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]


def chemin(n, l):
    return os.path.join(SORTIE, "%s-%d.webp" % (n, l))


# ── le manifeste ────────────────────────────────────────────────────────────
def charger():
    try:
        with open(MANIF, encoding="utf-8") as f:
            m = json.load(f)
        if isinstance(m, dict) and isinstance(m.get("images"), dict):
            m.setdefault("echecs", {})
            return m
    except FileNotFoundError:
        pass
    except Exception as e:
        dire("manifeste illisible, il est refait :", str(e)[:80])
    return {"v": 1, "images": {}, "echecs": {}}


def ecrire(m):
    m["v"] = 1
    m["maj"] = maintenant()
    m["modele"] = MODELE
    m["largeurs"] = list(LARGEURS)
    t = MANIF + ".tmp"
    with open(t, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    os.chmod(t, 0o644)
    os.replace(t, MANIF)


def ecrire_image(im, p):
    t = p + ".tmp"
    im.save(t, "WEBP", quality=QUALITE, method=6)
    os.chmod(t, 0o644)
    os.replace(t, p)


# ── visage (cadrage) et teinte (couleur Caméléon) ───────────────────────────
try:
    import cv2
    import numpy as np
    CASCADE = cv2.CascadeClassifier(os.path.join(MODELES, "lbpcascade_animeface.xml"))
    if CASCADE.empty():
        raise RuntimeError("detecteur vide")
except Exception as e:
    dire("detection de visage indisponible :", str(e)[:80])
    CASCADE = None


BAS_MAX = 65   # % de la hauteur : un visage plus bas est souvent un personnage secondaire


def _recouvrement(a, b):
    """part commune de deux boites (x, y, l, h) : intersection / union"""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    i = max(0, x2 - x1) * max(0, y2 - y1)
    return i / float(a[2] * a[3] + b[2] * b[3] - i) if i else 0.0


def visages(img):
    """tous les visages trouves, en 4 passes (contraste egalise ou local, image ou miroir) :
    un visage a moitie cache (meche sur un oeil, profil) echappe souvent a une passe mais
    pas aux autres. Les boites qui se recouvrent sont regroupees ; chaque visage garde le
    nombre de passes qui l'ont vu (votes). Retourne [(x, y, l, h, votes)] en pixels."""
    W, H = img.size
    g0 = cv2.cvtColor(np.asarray(img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    boites = []
    for g in (cv2.equalizeHist(g0), cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g0)):
        for miroir in (False, True):
            gg = np.ascontiguousarray(g[:, ::-1]) if miroir else g
            for x, y, w, h in CASCADE.detectMultiScale(gg, scaleFactor=1.05, minNeighbors=4, minSize=(max(24, W // 16),) * 2):
                boites.append((W - x - w if miroir else x, y, w, h))
    groupes = []
    for b in boites:
        for gr in groupes:
            if _recouvrement(gr[0], b) > .3:
                gr.append(b)
                break
        else:
            groupes.append([b])
    out = []
    for gr in groupes:
        n = len(gr)
        out.append((sum(b[0] for b in gr) / n, sum(b[1] for b in gr) / n, sum(b[2] for b in gr) / n, sum(b[3] for b in gr) / n, n))
    return out


def visage(img):
    """centre et largeur du visage du personnage principal, en % de l'image ; None si aucun.
    Parmi les visages vus par au moins 2 passes sur 4 : on ignore ceux dont le centre est
    sous BAS_MAX % de la hauteur (sur une jaquette, le personnage principal est en haut ;
    se caler sur un visage du bas coupait sa tete, BLEACH, 5 octobre), puis on prend le
    plus grand. Sans visage : le cadrage par defaut du site."""
    W, H = img.size
    f = [v for v in visages(img) if v[4] >= 2 and (v[1] + v[3] / 2) / H * 100 <= BAS_MAX]
    if not f:
        return None
    x, y, w, h, n = max(f, key=lambda r: r[2] * r[3])
    return [round(float(x + w / 2) / W * 100, 1), round(float(y + h / 2) / H * 100, 1), round(float(w) / W * 100, 1)]


def teinte(img):
    """meme calcul que le script de la page (fond-coin) : histogramme des teintes
    (24 cases) pondere par la vivacite, fenetre de 45 degres la plus lourde,
    moyenne circulaire ; None pour une image grise"""
    p = img.convert("RGB").resize((48, max(1, round(48 * img.size[1] / img.size[0]))), Image.BILINEAR)
    poids = [0.0] * 24
    sx = [0.0] * 24
    sy = [0.0] * 24
    px = p.get_flattened_data() if hasattr(p, "get_flattened_data") else p.getdata()
    for r, g, b in px:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if v < .2 or s < .18:
            continue
        w = s * v * v
        k = int(h * 24) % 24
        poids[k] += w
        sx[k] += w * math.cos(2 * math.pi * h)
        sy[k] += w * math.sin(2 * math.pi * h)
    k = max(range(24), key=lambda k: poids[k - 1] + poids[k] + poids[(k + 1) % 24])
    if poids[k - 1] + poids[k] + poids[(k + 1) % 24] == 0:
        return None
    ks = [k - 1, k, (k + 1) % 24]
    return round((math.degrees(math.atan2(sum(sy[j] for j in ks), sum(sx[j] for j in ks))) + 360) % 360) % 360


def ouvrir(donnees):
    im = Image.open(io.BytesIO(donnees))
    im.load()
    if im.size[0] < 100 or im.size[1] < 100:
        raise ValueError("image trop petite (%dx%d)" % im.size)
    if im.mode in ("RGBA", "LA", "P"):
        fond = Image.new("RGB", im.size, (0, 0, 0))
        im = im.convert("RGBA")
        fond.paste(im, mask=im.split()[3])
        return fond
    return im.convert("RGB")


# ── le flux ─────────────────────────────────────────────────────────────────
def jaquettes():
    """{adresse de la jaquette: popularite}, de tout le flux de la semaine"""
    flux = json.loads(get(FLUX))
    out = {}
    for d in flux.get("days") or []:
        for e in d.get("episodes") or []:
            c = e.get("cover")
            if isinstance(c, str) and c and len(c) < 400:
                out[c] = max(out.get(c, 0), int(e.get("popularity") or 0))
    return out


TETE = 2_000_000_000          # les images du Top passent avant celles de la semaine


def tops():
    """les images du coin des pages Anime, Jeux et A venir : {jaquette: priorite} et l'ensemble des
    jaquettes de jeux. Memes requetes et meme choix que le script du coin (coin-top.js). Un flux
    illisible est saute (la semaine reste faite)."""
    out, jeux = {}, set()
    def items(q):
        try:
            x = json.loads(get(API + q)).get("items")
            return x if isinstance(x, list) else []
        except Exception as e:
            dire("flux du Top illisible (%s) : %s" % (q.split("?")[0], str(e)[:80]))
            return []
    def prendre(i, prio, jeu):
        c = i.get("cover") if isinstance(i, dict) else None
        if isinstance(c, str) and c and len(c) < 400:
            out[c] = max(out.get(c, 0), prio)
            if jeu:
                jeux.add(c)
    for k, i in enumerate(items("anime?status=released&limit=5")[:5]):
        prendre(i, TETE - k, False)
    for k, i in enumerate(items("games?status=released&limit=5")[:5]):
        prendre(i, TETE - 10 - k, True)
    a = datetime.date.today(); b = a + datetime.timedelta(days=30)
    q = "status=upcoming&orderBy=score&limit=12&releasedAfter=%s&releasedBefore=%s" % (a.isoformat(), b.isoformat())
    for d, jeu, base in (("anime", False, 20), ("games", True, 30)):      # un Top 3 par onglet d'A venir
        t = [i for i in items(d + "?" + q) if isinstance(i, dict) and i.get("releaseDate") and i.get("releasePrecision") not in ("month", "year")]
        t.sort(key=lambda i: -(float(i.get("gameNimeScore") or 0)))
        for k, i in enumerate(t[:3]):
            prendre(i, TETE - base - k, jeu)
    return out, jeux


def source(c, jeu):
    """l'adresse a telecharger : pour un jeu, la grande version de la jaquette"""
    if not jeu:
        return c
    if re.match(r"^https://images\.igdb\.com/", c):
        return re.sub(r"/t_[a-z0-9_]+/", "/t_1080p/", c, count=1)
    if re.match(r"^https://media\.rawg\.io/media/resize/\d+/-/", c):
        return re.sub(r"/media/resize/\d+/-/", "/media/", c, count=1)
    return c


def main():
    os.makedirs(SORTIE, exist_ok=True)
    m = charger()
    imgs, echecs = m["images"], m["echecs"]
    try:
        vus = jaquettes()
    except Exception as e:
        dire("ARRET : flux de la semaine illisible (%s) ; rien n'a change" % str(e)[:100])
        return 1
    top, jeux = tops()
    for c, p in top.items():
        vus[c] = max(vus.get(c, 0), p)
    change = False

    # 1. les jaquettes deja faites : vues aujourd'hui, fichiers toujours la
    for c in list(imgs):
        e = imgs[c]
        n = e.get("n")
        if not isinstance(n, str) or not re.match(r"^[A-Za-z0-9_-]+$", n) or \
                not all(os.path.isfile(chemin(n, l)) for l in (e.get("l") or LARGEURS)):
            del imgs[c]          # incomplete : refaite plus bas si elle est dans le flux
            change = True
            continue
        if c in vus and e.get("vu") != AUJ:
            e["vu"] = AUJ
            change = True

    # 2. les nouvelles, la plus populaire d'abord
    a_faire = sorted((c for c in vus if c not in imgs), key=lambda c: -vus[c])
    def a_retenter(c):
        x = echecs.get(c)
        return not x or x.get("n", 0) < 3 or time.time() - x.get("t", 0) > 86400
    a_faire = [c for c in a_faire if a_retenter(c)]
    if MAX > 0:
        a_faire = a_faire[:MAX]
    sess = None
    faites = ratees = 0
    for c in a_faire:
        if time.time() - T0 > BUDGET:
            dire("temps ecoule : la suite au prochain passage")
            break
        try:
            t = time.time()
            jeu = c in jeux
            src = ouvrir(get(source(c, jeu)))
            W, H = src.size
            larg = [l for l in LARGEURS if l <= (W if jeu else 4 * W)] or [W if jeu else 4 * W]
            if W >= max(larg):                       # deja assez grande (ou un jeu) : pas d'IA
                grand = src
            else:
                if sess is None:
                    import esr
                    sess = esr.session(os.path.join(MODELES, "anime6b.pth"))
                grand = esr.agrandir(sess, src, TUILE)
            n = nom(c)
            for l in larg:
                h = round(grand.size[1] * l / grand.size[0])
                ecrire_image(grand.resize((l, h), Image.LANCZOS), chemin(n, l))
            e = {"n": n, "vu": AUJ, "t": [W, H], "h": teinte(src)}
            if larg != list(LARGEURS):
                e["l"] = larg
            if CASCADE is not None and not jeu:
                e["f"] = visage(src)
            imgs[c] = e
            echecs.pop(c, None)
            ecrire(m)                                # l'image est visible des maintenant
            change = False
            faites += 1
            dire("HD %-44s %dx%d -> %s px | %4.1f s | %s | teinte %s" % (
                n[:44], W, H, "/".join(map(str, larg)), time.time() - t,
                "jeu, sans IA" if jeu else "visage " + (" ".join(map(str, e["f"])) if e.get("f") else "aucun"),
                e["h"] if e["h"] is not None else "-"))
        except Exception as ex:
            x = echecs.setdefault(c, {"n": 0})
            x["n"] = x.get("n", 0) + 1
            x["t"] = int(time.time())
            change = True
            ratees += 1
            dire("ECHEC %s : %s" % (c[-60:], str(ex)[:120]))

    # 3. visage manquant (detecteur indisponible lors d'un passage precedent)
    if CASCADE is not None:
        for c, e in imgs.items():
            if "f" not in e and c in vus and c not in jeux and time.time() - T0 < BUDGET:
                try:
                    e["f"] = visage(ouvrir(get(c)))
                    change = True
                except Exception:
                    pass

    # 4. menage : jaquettes absentes du flux depuis GARDE jours, fichiers orphelins
    limite = (datetime.date.today() - datetime.timedelta(days=GARDE)).isoformat()
    for c in list(imgs):
        if imgs[c].get("vu", "") < limite:
            e = imgs.pop(c)
            change = True
            for l in set(LARGEURS) | set(e.get("l") or ()):
                try:
                    os.remove(chemin(e["n"], l))
                except FileNotFoundError:
                    pass
            dire("efface", e["n"])
    for c in list(echecs):
        if c not in vus:
            del echecs[c]
            change = True
    if change:
        ecrire(m)
    noms = {e["n"] for e in imgs.values()}
    for f in os.listdir(SORTIE):
        p = os.path.join(SORTIE, f)
        if f == "manifeste.json" or not os.path.isfile(p) or time.time() - os.path.getmtime(p) < 86400:
            continue
        base = re.sub(r"-\d+\.webp(\.tmp)?$", "", f)
        if f.endswith(".tmp") or (f.endswith(".webp") and base not in noms):
            os.remove(p)
    reste = len([c for c in vus if c not in imgs])
    dire("bilan : %d jaquette(s) (semaine et Top), %d en HD, %d faite(s), %d echec(s), %d restante(s), %.0f s ; Top du coin : %d/%d en HD" % (
        len(vus), len([c for c in vus if c in imgs]), faites, ratees, reste, time.time() - T0,
        len([c for c in top if c in imgs]), len(top)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
