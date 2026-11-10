"""The ship's materials: seamless PBR textures, made from nothing but noise.

Every texture tiles exactly (the noise is made in the frequency domain, so
it is periodic over the tile), at about 2 mm a pixel for the wood seen up
close. Each material gives three images:

    <name>_col.webp   colour (sRGB)
    <name>_nrm.webp   normal map (OpenGL: green up, as glTF and three.js)
    <name>_orm.webp   R occlusion (1), G roughness, B metalness (as glTF)

Run:  python3 tools/make_materials.py [out_dir]   (default src/assets/materials)
"""

import json
import os
import sys

import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "src", "assets", "materials")
os.makedirs(OUT, exist_ok=True)
META = {}


# ------------------------------------------------------------------ noise
def band(h, w, ku, kv, seed):
    """Periodic gaussian-filtered noise, zero mean, unit deviation. ku, kv:
    its scale in cycles over the tile, across u (width) and v (height)."""
    rng = np.random.default_rng(seed)
    F = np.fft.fft2(rng.standard_normal((h, w)))
    fx = np.fft.fftfreq(w) * w
    fy = np.fft.fftfreq(h) * h
    FX, FY = np.meshgrid(fx, fy)
    g = np.exp(-0.5 * ((FX / max(ku, 1e-3)) ** 2 + (FY / max(kv, 1e-3)) ** 2))
    n = np.real(np.fft.ifft2(F * g))
    return (n / (n.std() + 1e-9)).astype(np.float32)


def fbm(h, w, ku, kv, seed, octaves=4, gain=0.5, lac=2.0):
    out = np.zeros((h, w), np.float32)
    a, t = 1.0, 0.0
    for o in range(octaves):
        out += a * band(h, w, ku * lac ** o, kv * lac ** o, seed + 101 * o)
        t += a * a
        a *= gain
    return out / np.sqrt(t)


def u01(x, lo=-2.0, hi=2.0):
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def rgb(c):
    return np.array(c, np.float32)[None, None, :]


def grid(h, w):
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    return np.meshgrid(u, v)


def normal_from_height(H, metres_u, metres_v, strength=1.0):
    """Height in metres -> tangent-space normal, periodic differences."""
    h, w = H.shape
    du = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) / (2 * metres_u / w)
    dv = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) / (2 * metres_v / h)
    # image rows run down, v (and the texture's +Y) runs up: flip dv
    n = np.stack([-du * strength, dv * strength, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def to_srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def save(name, col_lin, H, rough, metal, size_m, strength=1.0, q=88, note=""):
    h, w = H.shape
    Image.fromarray((to_srgb(col_lin) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f"{name}_col.webp"), quality=q, method=6)
    nrm = normal_from_height(H, size_m[0], size_m[1], strength)
    Image.fromarray((nrm * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f"{name}_nrm.webp"), quality=min(95, q + 6), method=6)
    orm = np.stack([np.ones_like(rough), np.clip(rough, 0, 1), np.clip(metal, 0, 1)], -1)
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f"{name}_orm.webp"), quality=q, method=6)
    META[name] = {"size": [size_m[0], size_m[1]], "px": [w, h], "note": note}
    print(f"{name}: {w}x{h} px over {size_m[0]} x {size_m[1]} m")


# ------------------------------------------------------------------ wood
def oak_figure(h, w, su, sv, seed, ring=1.0, plank_h=None):
    """Flat-sawn oak along u. The saw cut runs through the growth rings at a
    slowly changing depth, so the rings show as long streaks that close into
    arches ("cathedrals"); each ring is pale early wood, its big pores first,
    then a band of dense dark late wood. A ring is 2-4 mm. Returns
    (figure 0..1: 1 = late wood, fibres, flecks, pores 0..1)."""
    U, V = grid(h, w)
    pv = plank_h or sv
    vloc = (V * sv) % pv                                   # m across the current plank
    pid = np.floor(V * sv / pv).astype(np.int32)
    rng = np.random.default_rng(seed)
    n = int(sv / pv) + 2
    pith = rng.uniform(-0.35, 0.6, n).astype(np.float32)[pid] * pv          # where the tree's heart was
    d0 = rng.uniform(0.02, 0.12, n).astype(np.float32)[pid]
    k1 = rng.integers(1, 3, n)[pid]
    ph = rng.uniform(0, 6.283, n).astype(np.float32)[pid]
    depth = d0 + 0.035 * np.sin(2 * np.pi * k1 * U + ph) + 0.012 * band(h, w, su * 0.7, sv * 0.4, seed + 1)
    warp = 0.0025 * band(h, w, su * 2.5, sv * 6, seed + 2) + 0.0008 * band(h, w, su * 12, sv * 30, seed + 3)
    r = np.sqrt((vloc - pith) ** 2 + depth ** 2) + warp
    spacing = (0.0028 + 0.0012 * u01(band(h, w, su * 0.5, sv * 1.0, seed + 4))) / max(ring, 0.2)
    p = (r / spacing) % 1.0
    late = sstep(0.55, 0.75, p) * (1 - sstep(0.93, 1.0, p))
    pores = sstep(0.0, 0.05, p) * (1 - sstep(0.06, 0.16, p))
    pores = pores * u01(band(h, w, su * 200, sv * 700, seed + 5), -0.5, 1.5)
    fibres = band(h, w, su * 30, sv * 500, seed + 6)
    fleck = np.clip(band(h, w, su * 45, sv * 160, seed + 7) - 2.3, 0, None)
    return late.astype(np.float32), fibres, fleck, pores.astype(np.float32)


def planking(name, size=(4.0, 2.0), px=(2048, 1024), rows=7, base=(0.16, 0.107, 0.066), grey=(0.19, 0.18, 0.16),
             seam_col=(0.012, 0.01, 0.008), weather=0.45, frames=0.62, seed=1, deck=False):
    """Planks running along u, `rows` strakes over the tile's height, butts
    staggered, treenails in pairs at each frame, seams payed with pitch."""
    W, H = px
    su, sv = size
    U, V = grid(H, W)
    r = np.floor(V * rows).astype(np.int32)                 # strake index
    fv = V * rows - r                                       # 0..1 across the strake
    rng = np.random.default_rng(seed)
    # butts: one or two in a strake within the tile, staggered from the next
    nb = rng.integers(1, 3, rows)
    bpos = [np.sort(rng.random(k)) for k in nb]
    seg = np.zeros((H, W), np.int32)
    dist_butt = np.full((H, W), 9.0, np.float32)
    for k in range(rows):
        m = r == k
        uu = U[m]
        b = bpos[k]
        sidx = np.searchsorted(b, uu) % len(b)
        seg[m] = k * 4 + sidx
        d = np.min(np.abs(((uu[:, None] - b[None, :]) + 0.5) % 1.0 - 0.5), axis=1) * su
        dist_butt[m] = d
    nseg = rows * 4
    tone = rng.uniform(0.78, 1.18, nseg).astype(np.float32)[seg]
    hue = rng.uniform(-1, 1, nseg).astype(np.float32)[seg]
    greyk = rng.uniform(0.0, 1.0, nseg).astype(np.float32)[seg]
    fig, fibres, fleck, pores = oak_figure(H, W, su, sv, seed + 10, plank_h=sv / rows)
    # colour: late wood darker, early wood paler, pores dark, per-plank tone
    # and hue, and a slow change of colour along each plank
    along = band(H, W, su * 0.7, sv * 3, seed + 11)
    c = rgb(base) * (1.12 - 0.38 * fig - 0.22 * pores)[..., None] * tone[..., None] * (1 + 0.07 * along[..., None])
    c = c * (1 + 0.06 * hue[..., None] * rgb((1.0, 0.2, -0.6)))
    c = c * (1 + 0.05 * fibres[..., None])
    c = c + 0.05 * fleck[..., None] * rgb(base)
    # weathering: silver-grey where sun and salt have bleached the surface
    wx = u01(fbm(H, W, su * 0.8, sv * 1.6, seed + 20, 4), -0.6, 1.4) * weather * (0.5 + greyk)
    wx = wx * (1.0 - 0.35 * fig)                            # bleaching takes the soft early wood first
    c = lerp(c, rgb(grey) * (1.05 - 0.3 * fig - 0.2 * pores)[..., None], np.clip(wx, 0, 0.85)[..., None])
    # dark water streaks and grime (vertical on a ship's side, blotches on deck)
    if deck:
        grime = u01(fbm(H, W, su * 1.5, sv * 1.5, seed + 30, 5), 0.3, 2.2)
    else:
        grime = u01(fbm(H, W, su * 6.0, sv * 0.7, seed + 30, 4), 0.2, 2.0)
    c = c * (1 - 0.35 * grime[..., None])
    # rounded plank edges, seams with pitch, butt joints
    edge = np.minimum(fv, 1 - fv) * sv / rows                # m to the plank's edge
    round_ = sstep(0.0, 0.012, edge)                         # 12 mm rounding
    seam = edge < 0.0025
    butt = dist_butt < 0.002
    c = c * (0.55 + 0.45 * round_)[..., None]
    c = np.where((seam | butt)[..., None], rgb(seam_col) * (0.8 + 0.4 * u01(fibres))[..., None], c)
    # treenails: two to a plank at every frame, end grain dark, a little sunk
    fr = U * su / frames
    fu = (fr - np.round(fr)) * frames                        # m from the nearest frame line
    jitter = band(H, W, su * 0.5, sv * 0.5, seed + 40) * 0.01
    tn = np.minimum(np.hypot(fu + jitter, (fv - 0.27) * sv / rows), np.hypot(fu - jitter, (fv - 0.73) * sv / rows))
    nail = tn < 0.0135
    ring = sstep(0.0165, 0.0135, tn)
    tnoise = u01(band(H, W, su * 60, sv * 60, seed + 41))
    c = np.where(nail[..., None], c * (0.68 + 0.2 * tnoise)[..., None], c)
    c = c * (1 - 0.25 * (ring * (1 - nail))[..., None])     # the dark ring of the bored hole
    # checks: a few long, thin splits along the grain, mostly in late wood
    chk = (band(H, W, su * 5, sv * 420, seed + 50) > 2.9) & (band(H, W, su * 1.2, sv * 5, seed + 51) > 0.9)
    c = np.where(chk[..., None], c * 0.4, c)
    # height (m): late wood stands proud of the eroded early wood, rounded
    # edges, seams, nails a little sunk, checks
    Hm = 0.0005 * fig - 0.0003 * pores + 0.00015 * fibres - 0.004 * (1 - round_) - 0.003 * (seam | butt)
    Hm = Hm - 0.0006 * ring * nail - 0.001 * chk + 0.0004 * wx * fig
    rough = 0.78 + 0.06 * u01(fibres) + 0.06 * wx + 0.04 * pores - 0.08 * grime * (0 if deck else 1)
    rough = np.where(seam | butt, 0.55, rough)                # pitch is shinier
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), size, strength=1.0,
         note="planks along u; %d strakes over the height" % rows)


def timber(name, size=(1.0, 1.0), px=(1024, 1024), base=(0.13, 0.088, 0.055), seed=3, knots=3, grey=0.25):
    """Squared oak timber with the grain along u: beams, knees, carriages, rails."""
    W, H = px
    su, sv = size
    U, V = grid(H, W)
    fig, fibres, fleck, pores = oak_figure(H, W, su, sv, seed, ring=0.8, plank_h=0.33)
    c = rgb(base) * (1.12 - 0.4 * fig - 0.22 * pores)[..., None] * (1 + 0.05 * fibres[..., None])
    rng = np.random.default_rng(seed)
    Hm = 0.0005 * fig - 0.0003 * pores + 0.0002 * fibres
    for _ in range(knots):
        ku, kv, kr = rng.random(), rng.random(), rng.uniform(0.008, 0.02)
        du = (((U - ku) + 0.5) % 1 - 0.5) * su
        dv = (((V - kv) + 0.5) % 1 - 0.5) * sv
        d = np.hypot(du * 0.6, dv)
        k = sstep(kr * 1.8, kr * 0.6, d)
        c = c * (1 - 0.55 * k[..., None])
        Hm = Hm - 0.0008 * k
    wx = u01(fbm(H, W, su * 1.2, sv * 2, seed + 7, 4), -0.4, 1.6) * grey
    c = lerp(c, rgb((0.17, 0.16, 0.14)) * (1.05 - 0.3 * fig)[..., None], wx[..., None])
    grime = u01(fbm(H, W, su * 2, sv * 2, seed + 8, 5), 0.4, 2.2)
    c = c * (1 - 0.3 * grime[..., None])
    chk = (band(H, W, su * 6, sv * 200, seed + 9) > 2.5) & (band(H, W, su * 1.5, sv * 4, seed + 10) > 0.3)
    c = np.where(chk[..., None], c * 0.3, c)
    Hm = Hm - 0.0015 * chk
    rough = 0.78 + 0.1 * u01(fibres) + 0.06 * wx
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), size, note="grain along u")


def painted(name, size=(1.0, 1.0), px=(1024, 1024), paint=(0.13, 0.018, 0.011), wood=(0.11, 0.075, 0.047), wear=0.22, seed=5):
    """Oil paint on oak, worn through on the high spots and the edges of the
    grain, brush marks along u, dirt in the hollows."""
    W, H = px
    su, sv = size
    fig, fibres, _, pores = oak_figure(H, W, su, sv, seed, plank_h=0.3)
    woodc = rgb(wood) * (1.1 - 0.4 * fig - 0.2 * pores)[..., None]
    brush = band(H, W, su * 2, sv * 60, seed + 1)
    thick = u01(fbm(H, W, su * 6, sv * 8, seed + 2, 6, 0.6), -1.6, 1.6)
    chip = (thick + 0.25 * (1 - fig) - 0.15 * u01(brush)) < wear
    pc = rgb(paint) * (0.85 + 0.08 * brush[..., None] + 0.12 * thick[..., None])
    fade = u01(fbm(H, W, su * 0.8, sv * 0.8, seed + 3, 3), -1, 2) * 0.3        # sun-faded
    pc = lerp(pc, pc * rgb((1.5, 1.9, 2.0)) + 0.01, fade[..., None])
    c = np.where(chip[..., None], woodc, pc)
    edge = chip ^ np.roll(chip, 1, 0) | chip ^ np.roll(chip, 1, 1)
    c = np.where(edge[..., None], c * 0.6, c)
    grime = u01(fbm(H, W, su * 2, sv * 2, seed + 4, 5), 0.5, 2.3)
    c = c * (1 - 0.3 * grime[..., None])
    Hm = np.where(chip, -0.0002 + 0.0004 * fig, 0.0001 * brush) + 0.0001 * fibres
    rough = np.where(chip, 0.85, 0.55 + 0.1 * u01(brush) + 0.1 * fade) + 0.08 * grime
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), size, note="paint over oak, grain along u")


def tarred(name, size=(1.0, 1.0), px=(1024, 1024), seed=7):
    """Pine spars, tarred and oiled: dark brown, a soft sheen, wide pine rings
    just showing through, the tar thicker in streaks."""
    W, H = px
    su, sv = size
    fig, fibres, _, _ = oak_figure(H, W, su, sv, seed, ring=0.35, plank_h=0.5)
    c = rgb((0.05, 0.034, 0.022)) * (1.15 - 0.4 * fig)[..., None] * (1 + 0.06 * fibres[..., None])
    tar = u01(fbm(H, W, su * 3, sv * 8, seed + 1, 4), -0.8, 1.6)
    c = lerp(c, rgb((0.018, 0.014, 0.011)), (0.45 * tar)[..., None])
    worn = u01(fbm(H, W, su * 6, sv * 3, seed + 2, 4), 1.4, 2.8)
    c = lerp(c, rgb((0.1, 0.07, 0.045)) * (1.1 - 0.4 * fig)[..., None], (0.5 * worn)[..., None])
    Hm = 0.0003 * fig + 0.00015 * fibres - 0.0002 * tar
    rough = 0.62 - 0.18 * tar + 0.15 * worn
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), size, note="grain along u")


# ------------------------------------------------------------------ metal, rope, cloth
def cast_iron(name, size=(0.5, 0.5), px=(1024, 1024), seed=9):
    """Cast iron, blacked and rusting: the sand-cast skin, pitting, rust in
    the pits and running down, worn bright on the edges by handling."""
    W, H = px
    su, sv = size
    skin = fbm(H, W, su * 40, sv * 40, seed, 5, 0.6)
    pits = np.clip(band(H, W, su * 120, sv * 120, seed + 1) - 1.6, 0, None)
    rust_m = u01(fbm(H, W, su * 4, sv * 6, seed + 2, 5), 1.0, 2.6)
    rust = np.clip(0.7 * rust_m + 0.7 * np.minimum(pits, 1.0), 0, 1)
    runs = u01(fbm(H, W, su * 14, sv * 1.5, seed + 3, 3), 1.4, 2.8)
    rust = np.clip(rust + 0.35 * runs, 0, 1)
    black = rgb((0.022, 0.021, 0.02)) * (0.85 + 0.15 * skin[..., None])
    rc = rgb((0.075, 0.033, 0.015)) * (0.7 + 0.5 * u01(fbm(H, W, su * 60, sv * 60, seed + 4, 3)))[..., None]
    c = lerp(black, rc, (0.75 * rust)[..., None])
    Hm = 0.00015 * skin - 0.0006 * np.minimum(pits, 1.0) + 0.0002 * rust
    rough = 0.55 + 0.35 * rust + 0.05 * u01(skin)
    metal = 0.75 * (1 - rust)
    save(name, np.clip(c, 0, 1), Hm, rough, metal, size, note="isotropic")


def bronze(name, size=(0.5, 0.5), px=(1024, 1024), seed=11):
    """Gun metal: warm brown bronze, darkened, a green-brown patina in the
    hollows and in patches, polished where hands and rammers rub."""
    W, H = px
    su, sv = size
    skin = fbm(H, W, su * 30, sv * 30, seed, 5, 0.6)
    pat = u01(fbm(H, W, su * 4, sv * 4, seed + 1, 6, 0.6), 0.2, 2.2)
    spots = np.clip(band(H, W, su * 120, sv * 120, seed + 2) - 1.9, 0, 1)
    pat = np.clip(pat * 0.7 + spots * 0.6, 0, 1)
    metalc = rgb((0.2, 0.12, 0.05)) * (0.85 + 0.15 * skin[..., None])
    patina = rgb((0.045, 0.05, 0.03)) * (0.8 + 0.4 * u01(fbm(H, W, su * 50, sv * 50, seed + 3, 3)))[..., None]
    dark = rgb((0.06, 0.04, 0.022))
    c = lerp(metalc, dark, (0.6 * u01(skin, -1.5, 1.5))[..., None])
    c = lerp(c, patina, (0.8 * pat)[..., None])
    Hm = 0.0001 * skin + 0.0003 * pat
    rough = 0.38 + 0.45 * pat + 0.08 * u01(skin)
    metal = 1.0 - 0.9 * pat
    save(name, np.clip(c, 0, 1), Hm, rough, metal, size, note="isotropic")


def rope(name, size=(0.25, 0.25), px=(512, 512), strands=3, turns=4, base=(0.09, 0.068, 0.042), seed=13):
    """Three-strand rope, hemp, tarred: u along the rope, v round it (the tile
    covers 0.25 m of rope and its whole circumference)."""
    W, H = px
    U, V = grid(H, W)
    # strands as helical ridges: lay angle from the turns along the tile
    ph = (U * turns + V * strands) % 1.0
    ridge = np.sin(np.pi * ph) ** 0.6
    yarn = np.sin(2 * np.pi * ((U * turns * 6 - V * strands * 2.5) % 1.0)) * 0.5 + 0.5
    fib = band(H, W, 80, 40, seed)
    c = rgb(base) * (0.45 + 0.55 * ridge)[..., None] * (0.85 + 0.15 * yarn[..., None]) * (1 + 0.1 * fib[..., None])
    tar = u01(fbm(H, W, 4, 3, seed + 1, 3), 0.0, 2.0)
    c = c * (1 - 0.35 * tar[..., None])
    Hm = 0.004 * ridge + 0.0006 * yarn + 0.0002 * fib
    rough = 0.9 - 0.15 * tar
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), (0.25, 0.25), note="u along the rope, v round it")


def canvas(name, size=(0.5, 0.5), px=(1024, 1024), base=(0.11, 0.095, 0.075), seed=15):
    """Heavy sailcloth: a plain weave of about 1 mm threads, uneven yarns,
    stains."""
    W, H = px
    U, V = grid(H, W)
    n = W // 2                                  # threads across the tile (0.5 m -> ~1 mm)
    wu = np.sin(np.pi * U * n) ** 2
    wv = np.sin(np.pi * V * n) ** 2
    checker = ((np.floor(U * n) + np.floor(V * n)) % 2).astype(np.float32)
    weave = lerp(wu, wv, checker)
    slub = band(H, W, 3, 200, seed) * 0.5 + band(H, W, 200, 3, seed + 1) * 0.5
    c = rgb(base) * (0.75 + 0.25 * weave)[..., None] * (1 + 0.08 * slub[..., None])
    st = u01(fbm(H, W, 3, 3, seed + 2, 5), 0.3, 2.2)
    c = c * (1 - 0.3 * st[..., None])
    Hm = 0.0003 * weave + 0.00005 * slub
    rough = 0.92 + 0.0 * weave
    save(name, np.clip(c, 0, 1), Hm, rough, np.zeros_like(rough), size, note="isotropic weave")


if __name__ == "__main__":
    planking("oak_planks", seed=1)                                               # the ship's side
    planking("deck_planks", rows=8, base=(0.2, 0.16, 0.11), grey=(0.24, 0.22, 0.19), weather=0.6,
             frames=0.9, seed=2, deck=True)                                      # decks
    planking("in_planks", rows=8, base=(0.12, 0.08, 0.05), grey=(0.14, 0.12, 0.1), weather=0.15,
             frames=0.62, seed=4)                                                # ceiling and deckheads below
    timber("oak_timber", seed=3)                                                 # beams, knees, carriages, rails
    painted("red_paint", seed=5)
    tarred("tarred_pine", seed=7)
    cast_iron("cast_iron", seed=9)
    bronze("bronze", seed=11)
    rope("rope", seed=13)
    canvas("canvas", seed=15)
    with open(os.path.join(OUT, "materials.json"), "w") as f:
        json.dump(META, f, indent=1)
