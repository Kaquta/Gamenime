# -*- coding: utf-8 -*-
"""Agrandissement x4 par IA (Real-ESRGAN, modeles animes), SANS PyTorch.

Les poids officiels (.pth) sont lus directement (zip + pickle), le reseau est
reconstruit en ONNX et execute par onnxruntime sur le processeur. Dependances :
numpy, pillow, onnx, onnxruntime (une vingtaine de Mo, pas de GPU necessaire).

  python3 esr.py <modele.pth> <entree> <sortie> [--tuile 192]

Modeles :
  realesr-animevideov3.pth        reseau compact (SRVGG), rapide
  RealESRGAN_x4plus_anime_6B.pth  RRDB a 6 blocs, plus fin, plus lent
"""
import collections, io, os, pickle, sys, time, zipfile
import numpy as np
from PIL import Image
import onnx
from onnx import helper, TensorProto, numpy_helper
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")   # onnxruntime n'envoie rien a Microsoft (et n'ecrit rien dans ~/.cache)
import onnxruntime as ort

# ── lecture d'un .pth sans torch ────────────────────────────────────────────
DT = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64,
      "LongStorage": np.int64, "IntStorage": np.int32, "ByteStorage": np.uint8}

def charger_pth(chemin):
    zf = zipfile.ZipFile(chemin)
    pkl = [n for n in zf.namelist() if n.endswith("data.pkl")][0]
    prefixe = pkl[: -len("data.pkl")]

    def reconstruire(stockage, decalage, taille, pas, *a):
        it = stockage.itemsize
        vue = np.lib.stride_tricks.as_strided(stockage[decalage:], shape=tuple(taille),
                                              strides=tuple(s * it for s in pas))
        return np.array(vue, dtype=np.float32)

    class U(pickle.Unpickler):
        def find_class(self, mod, nom):
            if mod == "torch._utils" and nom == "_rebuild_tensor_v2":
                return reconstruire
            if mod == "torch" and nom.endswith("Storage"):
                return nom
            if mod == "collections" and nom == "OrderedDict":
                return collections.OrderedDict
            if mod == "torch._utils" and nom == "_rebuild_parameter":
                return lambda t, *a: t
            return super().find_class(mod, nom)

        def persistent_load(self, pid):
            _, styp, cle, _, _ = pid
            styp = styp if isinstance(styp, str) else getattr(styp, "__name__", str(styp))
            return np.frombuffer(zf.read(prefixe + "data/" + cle), dtype=DT[styp])

    d = U(io.BytesIO(zf.read(pkl))).load()
    for k in ("params_ema", "params"):
        if isinstance(d, dict) and k in d:
            return d[k]
    return d

# ── reseaux en ONNX ─────────────────────────────────────────────────────────
class G:
    def __init__(s, poids):
        s.p, s.noeuds, s.init, s.n = poids, [], [], 0
    def nom(s, base):
        s.n += 1; return "%s_%d" % (base, s.n)
    def const(s, val, nom=None):
        nom = nom or s.nom("c"); s.init.append(numpy_helper.from_array(np.asarray(val, np.float32), nom)); return nom
    def conv(s, x, cle):
        w, b = s.const(s.p[cle + ".weight"], cle + ".w"), s.const(s.p[cle + ".bias"], cle + ".b")
        y = s.nom("conv"); k = s.p[cle + ".weight"].shape[-1]
        s.noeuds.append(helper.make_node("Conv", [x, w, b], [y], pads=[k // 2] * 4)); return y
    def op(s, typ, ins, **kw):
        y = s.nom(typ.lower()); s.noeuds.append(helper.make_node(typ, ins, [y], **kw)); return y
    def prelu(s, x, cle):
        return s.op("PRelu", [x, s.const(s.p[cle + ".weight"].reshape(-1, 1, 1), cle + ".a")])
    def lrelu(s, x):
        return s.op("LeakyRelu", [x], alpha=0.2)
    def resize(s, x, f):
        roi = s.const(np.array([], np.float32)); sc = s.const(np.array([1, 1, f, f], np.float32))
        return s.op("Resize", [x, roi, sc], mode="nearest", coordinate_transformation_mode="asymmetric", nearest_mode="floor")
    def modele(s, sortie):
        g = helper.make_graph(s.noeuds, "esr",
                              [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 3, None, None])],
                              [helper.make_tensor_value_info(sortie, TensorProto.FLOAT, [1, 3, None, None])], s.init)
        m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]); m.ir_version = 8
        return m

def srvgg(p):
    """SRVGGNetCompact : conv + PReLU en serie, pixel shuffle x4, + entree agrandie au plus proche"""
    g = G(p); idx = sorted({int(k.split(".")[1]) for k in p if k.startswith("body.")})
    x = "x"
    for i in idx:
        if p["body.%d.weight" % i].ndim == 4: x = g.conv(x, "body.%d" % i)
        else: x = g.prelu(x, "body.%d" % i)
    x = g.op("DepthToSpace", [x], blocksize=4, mode="CRD")
    return g.modele(g.op("Add", [x, g.resize("x", 4)]))

def rrdb(p):
    """RRDBNet (ESRGAN), 6 blocs pour le modele anime_6B"""
    g = G(p); r02 = g.const(np.float32(0.2), "r02")
    nb = len({k.split(".")[1] for k in p if k.startswith("body.")})
    f = g.conv("x", "conv_first"); h = f
    for b in range(nb):
        e = h
        for r in (1, 2, 3):
            base = "body.%d.rdb%d" % (b, r); xs = [e]
            for c in range(1, 5):
                xs.append(g.lrelu(g.conv(g.op("Concat", xs, axis=1) if len(xs) > 1 else xs[0], "%s.conv%d" % (base, c))))
            x5 = g.conv(g.op("Concat", xs, axis=1), base + ".conv5")
            e = g.op("Add", [g.op("Mul", [x5, r02]), e])
        h = g.op("Add", [g.op("Mul", [e, r02]), h])
    f = g.op("Add", [f, g.conv(h, "conv_body")])
    f = g.lrelu(g.conv(g.resize(f, 2), "conv_up1"))
    f = g.lrelu(g.conv(g.resize(f, 2), "conv_up2"))
    return g.modele(g.conv(g.lrelu(g.conv(f, "conv_hr")), "conv_last"))

def session(chemin_pth):
    p = charger_pth(chemin_pth)
    m = srvgg(p) if any(k.startswith("body.0.") for k in p) and "conv_first.weight" not in p else rrdb(p)
    o = ort.SessionOptions(); o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    n = int(os.environ.get("ESR_THREADS", "0") or 0)     # processeurs accordes au conteneur
    if n > 0:
        o.intra_op_num_threads = n; o.inter_op_num_threads = 1
    return ort.InferenceSession(m.SerializeToString(), o, providers=["CPUExecutionProvider"])

# ── agrandissement par tuiles (memoire bornee) ──────────────────────────────
def agrandir(sess, img, tuile=192, marge=12):
    a = np.asarray(img.convert("RGB"), np.float32) / 255.0
    H, W, _ = a.shape; S = 4
    out = np.zeros((H * S, W * S, 3), np.float32)
    for y in range(0, H, tuile):
        for x in range(0, W, tuile):
            y0, x0 = max(0, y - marge), max(0, x - marge)
            y1, x1 = min(H, y + tuile + marge), min(W, x + tuile + marge)
            t = a[y0:y1, x0:x1].transpose(2, 0, 1)[None]
            r = sess.run(None, {"x": t})[0][0].transpose(1, 2, 0)
            yy, xx = (y - y0) * S, (x - x0) * S
            h, w = min(tuile, H - y) * S, min(tuile, W - x) * S
            out[y * S:y * S + h, x * S:x * S + w] = r[yy:yy + h, xx:xx + w]
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8))

if __name__ == "__main__":
    pth, src, dst = sys.argv[1:4]
    tuile = int(sys.argv[sys.argv.index("--tuile") + 1]) if "--tuile" in sys.argv else 192
    t0 = time.time(); s = session(pth); t1 = time.time()
    im = Image.open(src); r = agrandir(s, im, tuile)
    r.save(dst, quality=92)
    print("%s : %dx%d -> %dx%d  (modele %.1fs, calcul %.1fs)" % (dst, im.size[0], im.size[1], r.size[0], r.size[1], t1 - t0, time.time() - t1))
