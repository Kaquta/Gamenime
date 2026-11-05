"""apercu.py : la vitre animee de l'apercu du lien gamenime.fr dans Discord (tache gn-apercu, 29 octobre 2026).
Lance par /opt/stack/apercu/apercu.sh dans un conteneur jetable (image gn-apercu:1).
  1. photographie l'accueil en ligne : Chromium sans ecran, gamenime.fr dirige vers nginx sur ce serveur (sans
     Cloudflare) ; aucune visite comptee (/api/track et toute requete autre que GET ou HEAD bloques) ; seules les
     images peuvent venir d'ailleurs (les jaquettes) ; carrousels figes ;
  2. compose les images comme la maquette validee le 29 octobre (images.py) : le logo dans la vitre 1,6 s, un fondu,
     l'accueil qui defile 5 s derriere le verre, le retour au logo ;
  3. encode le GIF comme la maquette (encoder.sh) : 800 x 420, le logo sans perte, le defile avec perte et limite a
     la vitre ; plus de perte si le fichier depasse la limite ;
  4. rend le GIF sur sa sortie (entre GIF-DEBUT et GIF-FIN, en base64) : le conteneur n'ecrit rien sur le serveur.
     La tache, hors du conteneur, le verifie, le met en service et fait la page du robot de Discord.
Usage : python apercu.py
Entrees en lecture seule : /app (ce programme et calques/), /dist (le site en ligne). Ecriture : /tmp (en memoire).
La derniere ligne dit le resultat : RESULTAT {json}. Codes : 0 fait ; 2 contenu incomplet ; 3 le site a change
pendant le passage (a refaire) ; 4 echec.
"""
import base64
import datetime
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import time

APP = os.environ.get("APERCU_APP", "/app")
CALQUES = os.path.join(APP, "calques")
DIST = os.environ.get("APERCU_DIST", "/dist")
TMP = os.environ.get("APERCU_TMP", "/tmp/apercu")
SITE = os.environ.get("APERCU_SITE", "https://gamenime.fr")
BANC = os.environ.get("APERCU_BANC") == "1"          # banc d'essai seulement : certificat du banc
GIFSICLE = os.environ.get("APERCU_GIFSICLE", "gifsicle")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 GameNime-apercu"
LIMITE = 6 * 1024 * 1024                             # taille au plus du GIF
PERTES = (60, 90, 130)                               # la maquette : 60 ; plus si le fichier est trop lourd
FPS = 12                                             # la maquette : 12 images par seconde
DEFIL = 640                                          # la maquette : 640 px de defilement (dans l image 1200 x 630)
LARGEUR = 800                                        # la maquette : 800 x 420
DEBUT = time.time()


def journal(s):
    print("%s %s" % (datetime.datetime.now().strftime("%H:%M:%S"), s), flush=True)


def resultat(code, **k):
    k["code"] = code
    k["duree_s"] = round(time.time() - DEBUT, 1)
    print("RESULTAT " + json.dumps(k, ensure_ascii=True, sort_keys=True), flush=True)
    sys.exit(code)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def lire_accueil():
    with open(os.path.join(DIST, "index.html"), "rb") as f:
        return f.read()


# ------------------------------------------------------------------ 1. la photo de l'accueil (capt3.py de la maquette)
GELER = """() => {
  document.querySelectorAll('.sl, .sl-track, [class*="carousel"]').forEach((s) => s.dispatchEvent(new Event('mouseenter')));
  document.querySelectorAll('.sl-track').forEach((t) => t.scrollTo({ left: 0, behavior: 'auto' }));
  const st = document.createElement('style');
  st.textContent = '*{scroll-behavior:auto !important} .gc-box *, .gc-box{transition:none !important}';
  document.head.appendChild(st);
}"""
# les images de la partie montree (le haut de la page) : chargees, et combien
IMAGES = """async (limite) => {
  // seulement les images dans la largeur de la fenetre : les diapositives cachees a droite des carrousels ne comptent pas
  const vues = Array.from(document.images).filter((i) => { const r = i.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left < window.innerWidth && r.right > 0 && r.top + window.scrollY < limite; });
  const attente = vues.map((i) => i.complete ? null : new Promise((ok) => { i.addEventListener('load', ok, { once: true }); i.addEventListener('error', ok, { once: true }); }));
  await Promise.race([Promise.all(attente), new Promise((ok) => setTimeout(ok, 20000))]);
  return { vues: vues.length, chargees: vues.filter((i) => i.complete && i.naturalWidth > 0).length };
}"""
SEMAINE = """() => { const z = document.querySelector('.wr-zone'); return z ? z.querySelectorAll('.item-card, .section-empty').length : -1; }"""


def photographier(ech):
    import numpy as np
    from PIL import Image, ImageChops
    from playwright.sync_api import sync_playwright
    hote = SITE.split("://", 1)[1].split("/")[0]
    bloquees = {"n": 0}

    def filtre(route):
        r = route.request
        u = r.url
        if r.method not in ("GET", "HEAD"):
            bloquees["n"] += 1
            return route.abort()
        if u.startswith(SITE + "/api/track"):
            bloquees["n"] += 1
            return route.abort()
        if u.startswith(SITE + "/") or u.startswith("data:") or u.startswith("blob:"):
            return route.continue_()
        if r.resource_type == "image" and u.startswith("https://"):
            return route.continue_()
        bloquees["n"] += 1
        return route.abort()

    with sync_playwright() as p:
        b = p.chromium.launch(args=["--disable-dev-shm-usage"])
        try:
            ctx = b.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2, locale="fr-FR",
                                timezone_id="Europe/Paris", user_agent=UA, ignore_https_errors=BANC)
            pg = ctx.new_page()
            erreurs = []
            pg.on("pageerror", lambda e: erreurs.append(str(e)[:160]))
            pg.route("**/*", filtre)
            pg.goto(SITE + "/", wait_until="networkidle", timeout=60000)
            pg.evaluate("document.fonts.ready")
            pg.wait_for_timeout(2500)
            pg.evaluate(GELER)
            # la partie montree : le defilement et la hauteur de la vitre, en pixels de la page (CSS)
            limite = int((DEFIL + 400) / ech / 2) + 200
            # les images paresseuses du bas de cette partie : la page descend puis remonte
            for y in range(0, limite, 600):
                pg.evaluate("(y) => window.scrollTo(0, y)", y)
                pg.wait_for_timeout(150)
            pg.evaluate("() => window.scrollTo(0, 0)")
            try:
                pg.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            im = pg.evaluate(IMAGES, limite)
            semaine = pg.evaluate(SEMAINE)
            pg.wait_for_timeout(2500)
            pg.evaluate(GELER)
            avant = None
            png = None
            for essai in range(14):
                png = pg.screenshot(full_page=True)
                cur = Image.open(io.BytesIO(png)).convert("L").resize((128, 200))
                if avant is not None and cur.size == avant.size and int(np.asarray(ImageChops.difference(cur, avant), dtype=np.int64).sum()) / 25600 < 0.15:
                    break
                avant = cur
                pg.wait_for_timeout(600)
            hauteur = pg.evaluate("document.documentElement.scrollHeight")
        finally:
            b.close()
    return png, {"images_vues": im["vues"], "images_chargees": im["chargees"], "semaine": semaine, "hauteur_page": hauteur,
                 "requetes_bloquees": bloquees["n"], "erreurs_js": erreurs[:3], "hote": hote}


# ------------------------------------------------------------------ 2. les images (images.py de la maquette)
class Vitre:
    def __init__(self, site_png):
        from PIL import Image, ImageDraw
        self.Image = Image
        # les calques de la maquette, sans perte : le logo dans la vitre (A), le cadre et ses reflets ; le fond (la vitre
        # sans le logo) est A hors de la vitre, plus le lisere du bord (les pixels que le defile ne recouvre pas en entier)
        self.A = Image.open(os.path.join(CALQUES, "A.webp")).convert("RGB")
        self.CADRE = Image.open(os.path.join(CALQUES, "cadre.webp")).convert("RGBA")
        g = json.load(open(os.path.join(CALQUES, "geo.json")))
        self.x0, self.y0 = g["x"] + g["bord"], g["y"] + g["bord"]
        self.w, self.h = g["w"] - 2 * g["bord"], g["h"] - 2 * g["bord"]
        r = g["r"] - g["bord"]
        self.X0, self.Y0 = math.floor(self.x0), math.floor(self.y0)
        self.W, self.H = math.ceil(self.x0 + self.w) - self.X0, math.ceil(self.y0 + self.h) - self.Y0
        Z = 4
        m = Image.new("L", (self.W * Z, self.H * Z), 0)
        ImageDraw.Draw(m).rounded_rectangle(((self.x0 - self.X0) * Z, (self.y0 - self.Y0) * Z, (self.x0 - self.X0 + self.w) * Z,
                                             (self.y0 - self.Y0 + self.h) * Z), radius=r * Z, fill=255)
        self.MASQUE = m.resize((self.W, self.H), Image.LANCZOS)
        bord = Image.open(os.path.join(CALQUES, "fond-bord.png")).convert("RGBA")
        self.FOND = self.A.copy()
        self.FOND.paste(bord.convert("RGB"), (self.X0, self.Y0), bord.split()[3])
        self.SITE = None
        if site_png is not None:
            self.SITE = Image.open(io.BytesIO(site_png)).convert("RGB") if isinstance(site_png, bytes) else site_png.convert("RGB")
            ech = self.w / self.SITE.width
            self.SITE_E = self.SITE.resize((round(self.SITE.width * ech), round(self.SITE.height * ech)), Image.LANCZOS)
            # une page plus courte que la maquette : le defilement s'arrete en bas de la page
            self.defil = max(0, min(DEFIL, self.SITE_E.height - self.H))

    @staticmethod
    def echelle():
        g = json.load(open(os.path.join(CALQUES, "geo.json")))
        return (g["w"] - 2 * g["bord"]) / 2560.0

    def vitre(self, dy):
        im = self.FOND.copy()
        ox = round(self.x0 - self.X0)
        morceau = self.SITE_E.crop((0, round(dy), self.W, round(dy) + self.H))
        calque = self.Image.new("RGB", (self.W, self.H))
        calque.paste(morceau, (ox, round(self.y0 - self.Y0)))
        im.paste(calque, (self.X0, self.Y0), self.MASQUE)
        im = im.convert("RGBA")
        im.alpha_composite(self.CADRE)
        return im.convert("RGB")

    def sequence(self):
        def doux(t):
            return t * t * (3 - 2 * t)

        def fondu(a, b, t):
            return self.Image.blend(a, b, doux(t))
        out = []
        n = lambda s: max(1, round(s * FPS))
        d = round(1000 / FPS)
        out.append((self.A, 1600))
        B0 = self.vitre(0)
        k = n(.5)
        for i in range(1, k + 1):
            out.append((fondu(self.A, B0, i / k), d))
        out.append((B0, 500))
        k = n(5.0)
        for i in range(1, k + 1):
            out.append((self.vitre(self.defil * doux(i / k)), d))
        Bf = self.vitre(self.defil)
        out.append((Bf, 400))
        k = n(.5)
        for i in range(1, k):
            out.append((fondu(Bf, self.A, i / k), d))
        return out


def ecrire_images(seq, dossier):
    """Les images et les trois listes de la maquette : le logo seul, le reste, le reste precede du logo."""
    os.makedirs(dossier, exist_ok=True)

    def liste(nom, morceau, debut):
        lignes = []
        for i, (im, ms) in enumerate(morceau, debut):
            p = os.path.join(dossier, "f%04d.png" % i)
            if not os.path.exists(p):
                im.save(p)
            lignes.append("file '%s'\nduration %.3f" % (p, ms / 1000))
        lignes.append("file '%s'" % os.path.join(dossier, "f%04d.png" % (debut + len(morceau) - 1)))
        open(os.path.join(dossier, nom), "w").write("\n".join(lignes) + "\n")
    liste("liste1.txt", seq[:1], 0)
    liste("liste2.txt", seq[1:], 1)
    lignes = ["file '%s'\nduration 0.080" % os.path.join(dossier, "f0000.png")]
    lignes += [l for l in open(os.path.join(dossier, "liste2.txt")).read().splitlines()]
    open(os.path.join(dossier, "liste2a.txt"), "w").write("\n".join(lignes) + "\n")


# ------------------------------------------------------------------ 3. le GIF (encoder.sh de la maquette)
def lancer(argv):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if r.returncode != 0:
        raise RuntimeError("%s : code %d : %s" % (os.path.basename(argv[0]), r.returncode, r.stderr.decode("utf-8", "replace")[-300:]))


def encoder(dossier, perte, sortie):
    W = str(LARGEUR)
    j = lambda n: os.path.join(dossier, n)
    lancer(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", j("liste1.txt"), "-vf",
            "scale=%s:-1:flags=lanczos,palettegen=stats_mode=full:max_colors=256" % W, "-update", "1", j("p1.png")])
    lancer(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", j("liste1.txt"), "-i", j("p1.png"), "-lavfi",
            "[0:v]scale=%s:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" % W, "-frames:v", "1", "-loop", "0", j("m1.gif")])
    lancer(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", j("liste2.txt"), "-vf",
            "scale=%s:-1:flags=lanczos,palettegen=stats_mode=full:max_colors=256" % W, "-update", "1", j("p2.png")])
    lancer(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", j("liste2a.txt"), "-i", j("p2.png"), "-lavfi",
            "[0:v]scale=%s:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" % W, "-loop", "0", j("m2.gif")])
    if perte:
        lancer([GIFSICLE, "--no-warnings", "-O3", "--lossy=%d" % perte, j("m2.gif"), "-o", j("m2l.gif")])
    else:
        shutil.copy(j("m2.gif"), j("m2l.gif"))
    lancer([GIFSICLE, "--no-warnings", j("m2l.gif"), "--delete", "#0", "-o", j("m2s.gif")])
    lancer([GIFSICLE, "--no-warnings", "-d160", j("m1.gif"), "-o", j("m1d.gif")])
    lancer([GIFSICLE, "--no-warnings", "-O3", "--loopcount=forever", j("m1d.gif"), j("m2s.gif"), "-o", sortie])


def verifier_gif(p, A):
    from PIL import Image
    import numpy as np
    g = Image.open(p)
    n, d = 0, 0
    try:
        while True:
            d += g.info.get("duration", 0)
            n += 1
            g.seek(g.tell() + 1)
    except EOFError:
        pass
    g.seek(0)
    premiere = np.asarray(g.convert("RGB"), dtype=float)
    logo = np.asarray(A.resize(g.size, Image.LANCZOS), dtype=float)
    ecart = float(np.abs(premiere - logo).mean())
    return {"largeur": g.size[0], "hauteur": g.size[1], "images": n, "duree_ms": d, "ecart_logo": round(ecart, 2)}


def main():
    try:
        accueil = lire_accueil()
    except OSError as e:
        resultat(4, erreur="accueil du site illisible (%s)" % type(e).__name__)
    s0 = sha(accueil)
    journal("accueil en ligne : %d octets, empreinte %s" % (len(accueil), s0[:12]))
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)
    try:
        png, info = photographier(Vitre.echelle())
    except Exception as e:
        resultat(4, erreur="photo de l'accueil impossible (%s : %s)" % (type(e).__name__, str(e).replace("\n", " ")[:200]))
    journal("photo : page de %d px ; images de la partie montree : %d sur %d ; Cette semaine : %d ; requetes bloquees : %d"
            % (info["hauteur_page"], info["images_chargees"], info["images_vues"], info["semaine"], info["requetes_bloquees"]))
    # le contenu : la page doit etre complete, sinon on garde le GIF d'avant
    manque = []
    if info["images_vues"] < 10 or info["images_chargees"] < 0.9 * info["images_vues"]:
        manque.append("jaquettes chargees : %d sur %d" % (info["images_chargees"], info["images_vues"]))
    if info["semaine"] < 1:
        manque.append("Cette semaine vide")
    if manque:
        resultat(2, erreur="accueil incomplet (%s)" % " ; ".join(manque), **info)
    try:
        v = Vitre(png)
        seq = v.sequence()
        ecrire_images(seq, os.path.join(TMP, "img"))
        journal("images : %d (defilement %d px)" % (len(seq), v.defil))
        gif = os.path.join(TMP, "vitre.gif")
        for perte in PERTES:
            encoder(os.path.join(TMP, "img"), perte, gif)
            if os.path.getsize(gif) <= LIMITE:
                break
            journal("GIF de %d octets avec la perte %d : trop lourd" % (os.path.getsize(gif), perte))
        else:
            resultat(4, erreur="GIF trop lourd meme avec la perte %d (%d octets)" % (PERTES[-1], os.path.getsize(gif)), **info)
        ctl = verifier_gif(gif, v.A)
    except Exception as e:
        resultat(4, erreur="GIF impossible (%s : %s)" % (type(e).__name__, str(e).replace("\n", " ")[:300]), **info)
    b = open(gif, "rb").read()
    journal("GIF : %d octets, %d images, %.1f s, perte %d, ecart du logo %.2f" % (len(b), ctl["images"], ctl["duree_ms"] / 1000, perte, ctl["ecart_logo"]))
    if ctl["largeur"] != LARGEUR or ctl["images"] < 40 or not (7000 <= ctl["duree_ms"] <= 10000) or ctl["ecart_logo"] > 6:
        resultat(4, erreur="GIF non conforme", **dict(info, **ctl))
    # un passage pendant une publication : rien n'est ecrit, le suivant le refera
    try:
        s1 = sha(lire_accueil())
    except OSError:
        s1 = ""
    if s1 != s0:
        resultat(3, erreur="l'accueil a change pendant le passage (publication ?)", **info)
    shutil.rmtree(TMP, ignore_errors=True)
    # le GIF, sur la sortie : la tache le lit, le verifie et le met en service
    t = base64.b64encode(b).decode("ascii")
    sys.stdout.write("GIF-DEBUT %d %s\n" % (len(b), sha(b)))
    sys.stdout.write("".join(t[i:i + 76] + "\n" for i in range(0, len(t), 76)))
    sys.stdout.write("GIF-FIN\n")
    sys.stdout.flush()
    resultat(0, sha=sha(b), octets=len(b), accueil=s0, perte=perte, **dict(info, **ctl))


if __name__ == "__main__":
    main()
