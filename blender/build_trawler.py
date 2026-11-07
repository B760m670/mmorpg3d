"""
Procedural Blender model of a 23.95 m Scottish stern trawler.

Principal dimensions follow the published Macduff Ship Design data sheet for
their 23.95 m stern trawler design ("Adventurer" class):
  LOA (hull) 23.95 m, LBP 20.00 m, breadth moulded 9.20 m, depth moulded 4.00 m,
  337 GRT, fish hold 160 m3, crew 10, 1500 hp main engine,
  2700 mm propeller in nozzle, 3 split winches, 4 split net drums, crane.
Arrangement and livery follow the vessel's photo: red hull, white shelter-deck
topsides with green sheer stripe, two-tier white wheelhouse forward of
amidships, stern gantry over the net drums, mast with radars.
Draught is not published; 3.0 m (trimmed by the stern) is assumed.

Run:
  python build_trawler.py -- <out_dir> [--render]

Writes <out_dir>/trawler.glb (Y-up, bow toward -Z, 1 unit = 1 m, waterline at
y = 0, origin amidships) and optional Cycles preview renders.
"""

import math
import os
import sys

import bpy  # noqa: I001  (bpy must be imported before bmesh/mathutils)
import bmesh
import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else os.path.join(os.path.dirname(__file__), "out")
RENDER = "--render" in ARGS
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- dimensions
L = 23.95          # length overall (hull)
B = 9.20           # breadth moulded
HB = B / 2
T = 3.0            # assumed draught amidships
FOREFOOT = 4.6     # horizontal run of the stem from forefoot to stem head


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def Y(s):
    """Station s (metres from transom) -> Blender Y (bow is +Y)."""
    return s - L / 2


# ---------------------------------------------------------------- hull form
def keel_z(s):
    """Underside of the shell on the centreline (excluding box keel)."""
    base = -T - 0.25 * (1 - s / L)          # trim by the stern
    run = smooth(7.5, 0.0, s)                # aft cut-up for the propeller
    return lerp(base, -0.7, run ** 1.3)


def deck_z(s):
    """Shelter (weather) deck at side; sheer rises to a high bow."""
    return 3.1 + 1.7 * smooth(L * 0.5, L, s) ** 1.4


def bulwark_z(s):
    return deck_z(s) + lerp(1.05, 1.15, smooth(L * 0.7, L, s))


def main_deck_z(s):
    # red/white boundary of the livery (the enclosed main deck level)
    return deck_z(s) - 1.15


Z_BOT = keel_z(L)
Z_HEAD = bulwark_z(L)


def stem_s(z):
    """Raked stem with a rounded forefoot."""
    u = clamp((z - Z_BOT) / (Z_HEAD - Z_BOT))
    return L - FOREFOOT * (1 - u) ** 2.2


def wl_half(s):
    return HB * 0.985 * lerp(0.86, 1.0, smooth(0, 6, s))


def section_n(s):
    # superellipse exponent: full round-bilge midship, finer at the ends
    if s < L * 0.5:
        return lerp(2.0, 3.6, smooth(0, 7, s))
    return lerp(3.6, 1.7, smooth(L * 0.5, L * 0.95, s))


def half_breadth(s, z):
    zc = keel_z(s)
    zw = 0.6
    bw = wl_half(s)
    deck_half = HB * lerp(0.9, 1.0, smooth(0, 5, s))
    if z <= zw:
        q = clamp((zw - z) / (zw - zc)) if zw > zc else 0.0
        n = section_n(s)
        y = bw * (1 - q ** n) ** (1 / n)
    else:
        t = (z - zw) / max(0.01, bulwark_z(s) - zw)
        y = lerp(bw, deck_half, t)
    # bow entrance; fuller with height = flare
    d = max(0.0, stem_s(z) - s)
    k = lerp(0.42, 1.35, smooth(-3.0, 5.0, z))
    if y <= 1e-4:
        return 0.0
    return max(0.0, y * math.tanh(k * d / y))


# Stations: denser toward the bow where the shape changes fastest.
N_ST = 96
STATIONS = [L * (0.5 - 0.5 * math.cos(math.pi * (i / (N_ST - 1)) ** 0.85)) for i in range(N_ST)]
STATIONS[0] = 0.0
STATIONS[-1] = L
Z_ROWS = [-3.7 + j * 0.11 for j in range(int((7.0 + 3.7) / 0.11) + 1)]


def section_points(s):
    zc, zt = keel_z(s), bulwark_z(s)
    pts = []
    for zj in Z_ROWS:
        z = clamp(zj, zc, zt)
        y = 0.0 if z <= zc + 1e-6 else half_breadth(s, z)
        pts.append((y, z))
    return pts


# ---------------------------------------------------------------- utilities
for block in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for item in list(block):
        block.remove(item)

BOAT = []  # objects belonging to the boat


def material(name, color, rough=0.5, metal=0.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = emit_strength
    return m


def new_obj(name, bm, mat, smooth_shade=False):
    if smooth_shade:
        for f in bm.faces:
            f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    BOAT.append(ob)
    return ob


def box(name, c, size, mat, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0] + c[0], v.co.y * size[1] + c[1], v.co.z * size[2] + c[2]))
    ob = new_obj(name, bm, mat)
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return ob


def cyl(name, p0, p1, r, mat, seg=10, cap=True, r2=None):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, segments=seg, radius1=r,
                          radius2=r if r2 is None else r2, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    for f in bm.faces:
        f.smooth = len(f.verts) == 4
    return new_obj(name, bm, mat)


def sphere(name, c, r, mat, seg=16):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=r)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return new_obj(name, bm, mat, smooth_shade=True)


def prism(name, bot, top, mat, bevel=0.0):
    """Solid between two polygons with matching vertex order (CCW from above)."""
    bm = bmesh.new()
    vb = [bm.verts.new(p) for p in bot]
    vt = [bm.verts.new(p) for p in top]
    n = len(bot)
    bm.faces.new(list(reversed(vb)))
    bm.faces.new(vt)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat)
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return ob


def panel(name, center, right, up, w, h, mat, depth=0.04):
    """Thin plate (window, hatch, sign) lying in the plane spanned by right/up."""
    center, right, up = Vector(center), Vector(right).normalized(), Vector(up).normalized()
    nrm = right.cross(up).normalized()
    bm = bmesh.new()
    corners = []
    for sd in (-1, 1):
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corners.append(bm.verts.new(center + right * (su * w / 2) + up * (sv * h / 2) + nrm * (sd * depth / 2)))
    b, t = corners[:4], corners[4:]
    bm.faces.new(list(reversed(b)))
    bm.faces.new(t)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([b[i], b[j], t[j], t[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, mat)


def railing(name, pts, h, mat, closed=False, post_gap=1.1, r=0.028):
    """Handrail along points (x, y, z) with posts, mid rail and top rail."""
    pts = [Vector(p) for p in pts]
    if closed:
        pts = pts + [pts[0]]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = (b - a).length
        n = max(1, int(math.ceil(seg / post_gap)))
        for k in range(n + (1 if i == len(pts) - 2 and not closed else 0)):
            p = a.lerp(b, k / n)
            cyl(f"{name}_post", p, p + Vector((0, 0, h)), r, mat, seg=6)
        cyl(f"{name}_top", a + Vector((0, 0, h)), b + Vector((0, 0, h)), r * 1.2, mat, seg=6)
        cyl(f"{name}_mid", a + Vector((0, 0, h * 0.5)), b + Vector((0, 0, h * 0.5)), r * 0.8, mat, seg=6)


# ---------------------------------------------------------------- materials
M = {
    "hull": material("hull_livery", (1, 1, 1), rough=0.42),
    "white": material("paint_white", (0.82, 0.84, 0.83), rough=0.38),
    "deck": material("deck_paint", (0.16, 0.22, 0.19), rough=0.85),
    "orange": material("rail_orange", (0.92, 0.33, 0.04), rough=0.4),
    "glass": material("glass", (0.02, 0.03, 0.04), rough=0.06, metal=0.2),
    "steel": material("steel", (0.42, 0.44, 0.45), rough=0.35, metal=0.8),
    "dark": material("dark_steel", (0.05, 0.05, 0.05), rough=0.6, metal=0.3),
    "net": material("net_green", (0.06, 0.16, 0.09), rough=0.95),
    "antifoul": material("antifouling", (0.32, 0.05, 0.04), rough=0.75),
    "blue": material("drum_blue", (0.05, 0.16, 0.34), rough=0.45),
    "red_light": material("light_red", (0.3, 0.0, 0.0), emit=(1.0, 0.08, 0.05), emit_strength=6.0),
    "green_light": material("light_green", (0.0, 0.3, 0.0), emit=(0.1, 1.0, 0.2), emit_strength=6.0),
    "white_light": material("light_white", (0.6, 0.6, 0.6), emit=(1.0, 0.95, 0.85), emit_strength=6.0),
}


# ---------------------------------------------------------------- livery texture
def build_livery(w=2048, h=1024):
    """Paint the hull: antifouling, red topsides, white shelter deck sides,
    green sheer stripe, portlights, freeing ports and light weathering.
    U runs transom -> stem (s / L); V maps z in [-4, 7]."""
    us = (np.arange(w) + 0.5) / w * L
    zs = (np.arange(h) + 0.5) / h * 11.0 - 4.0
    S, Z = np.meshgrid(us, zs)
    img = np.zeros((h, w, 3), np.float32)

    deck = np.vectorize(deck_z)(us)[None, :]
    bulw = np.vectorize(bulwark_z)(us)[None, :]
    main = deck - 1.15

    red = np.array([0.74, 0.09, 0.06])
    af = np.array([0.38, 0.06, 0.05])
    white = np.array([0.86, 0.88, 0.86])
    green = np.array([0.04, 0.42, 0.22])
    black = np.array([0.05, 0.05, 0.05])

    img[:] = white
    img[Z < main + 0.05] = red
    img[Z < 0.0] = af
    boot = (Z >= -0.06) & (Z < 0.1)
    img[boot] = black

    # green sheer stripe, tapering out toward amidships
    taper = np.clip((S - L * 0.38) / (L * 0.25), 0, 1)
    top = bulw - 0.75
    stripe = (Z < top) & (Z > top - 0.38 * taper) & (taper > 0)
    img[stripe] = green
    thin = (Z < main + 0.22) & (Z > main + 0.12)
    img[thin] = green

    # portlights in the red topsides (accommodation below the shelter deck)
    rng = np.random.default_rng(7)
    for sx in np.arange(8.0, 16.6, 1.45):
        zc = main_deck_z(sx) - 0.5
        m = (np.abs(S - sx) < 0.17) & (np.abs(Z - zc) < 0.17)
        img[m] = black
    # freeing ports along the bulwark foot
    for i, sx in enumerate(np.arange(1.2, L * 0.62, 1.7)):
        zc = deck_z(sx) + 0.18
        m = (np.abs(S - sx) < 0.35) & (np.abs(Z - zc) < 0.12)
        img[m] = black
        if i % 3 != 1:
            continue
        # faint rust streak below some of the freeing ports
        streak = (np.abs(S - sx - rng.uniform(-0.2, 0.2)) < 0.05) & (Z < zc) & (Z > zc - rng.uniform(0.8, 1.8))
        fade = np.clip((Z - (zc - 1.8)) / 1.8, 0, 1)
        rust = np.array([0.42, 0.2, 0.08])
        img[streak] = img[streak] * (1 - 0.3 * fade[streak, None]) + rust * 0.3 * fade[streak, None]

    # draft marks (white ticks) at bow and stern
    for sx in (0.35,):
        for zz in np.arange(-2.6, 0.0, 0.2):
            m = (np.abs(S - sx) < 0.05) & (np.abs(Z - zz) < 0.04)
            img[m] = white

    # subtle weathering: low-frequency grime + fine noise
    grime = rng.normal(0, 1, (h // 32 + 2, w // 32 + 2)).astype(np.float32)
    grime = np.kron(grime, np.ones((32, 32), np.float32))[:h, :w]
    k = np.ones(31, np.float32) / 31
    grime = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, grime)
    grime = np.apply_along_axis(lambda c: np.convolve(c, k, "same"), 0, grime)
    img *= (1.0 - 0.022 * grime[..., None])
    img *= (1.0 + rng.normal(0, 0.008, (h, w, 1)).astype(np.float32))
    img = np.clip(img, 0, 1)

    rgba = np.concatenate([img, np.ones((h, w, 1), np.float32)], axis=2)
    im = bpy.data.images.new("hull_livery", w, h, alpha=False)
    im.pixels.foreach_set(rgba.ravel())
    im.pack()
    return im


def hook_texture(mat, image):
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Linear"
    tex.extension = "EXTEND"  # clamp: no wrap-around between transom and stem
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])


hook_texture(M["hull"], build_livery())


def apply_hull_uv(bm):
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = ((co.y + L / 2) / L, (co.z + 4.0) / 11.0)


# ---------------------------------------------------------------- hull shell
def build_hull():
    bm = bmesh.new()
    grid = []
    for s in STATIONS:
        grid.append([bm.verts.new((y, Y(s), z)) for (y, z) in section_points(s)])
    for i in range(len(grid) - 1):
        for j in range(len(Z_ROWS) - 1):
            a, b, c, d = grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]
            try:
                bm.faces.new([a, b, c, d])
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)
    bmesh.ops.mirror(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], axis="X", merge_dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # make sure normals point outward (+x side faces should face +x)
    probe = [f for f in bm.faces if f.calc_center_median().x > 1.0]
    if probe and sum(f.normal.x for f in probe) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    apply_hull_uv(bm)
    new_obj("hull_shell", bm, M["hull"], smooth_shade=True)

    # transom plate
    pts = []
    for (y, z) in section_points(0.0):
        if not pts or (abs(pts[-1][0] - y) > 1e-4 or abs(pts[-1][1] - z) > 1e-4):
            pts.append((y, z))
    loop = [(y, Y(0.0), z) for (y, z) in pts] + [(-y, Y(0.0), z) for (y, z) in reversed(pts) if y > 1e-4]
    # explicit triangle fan around the centroid (the outline is star-shaped)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in loop]
    cz = sum(p[2] for p in loop) / len(loop)
    vc = bm.verts.new((0.0, Y(0.0), cz))
    for i in range(len(vs)):
        f = bm.faces.new([vc, vs[i], vs[(i + 1) % len(vs)]])
        if f.normal.y > 0:
            f.normal_flip()
    apply_hull_uv(bm)
    new_obj("transom", bm, M["hull"])


def build_deck():
    """Bulwark cap, inner bulwark face and the weather deck surface."""
    t = 0.18
    bm_w = bmesh.new()
    bm_d = bmesh.new()
    rows_w, rows_d = [], []
    for s in STATIONS[:-2]:
        zb, zd = bulwark_z(s), deck_z(s)
        yo = half_breadth(s, zb)
        yi = max(0.0, yo - t)
        ydi = max(0.0, half_breadth(s, zd) - t)
        rows_w.append([bm_w.verts.new((yo, Y(s), zb)), bm_w.verts.new((yi, Y(s), zb)),
                       bm_w.verts.new((ydi, Y(s), zd))])
        camber = 0.12
        rows_d.append([bm_d.verts.new((ydi, Y(s), zd)), bm_d.verts.new((0.0, Y(s), zd + camber))])
    for i in range(len(rows_w) - 1):
        for j in range(2):
            bm_w.faces.new([rows_w[i][j], rows_w[i + 1][j], rows_w[i + 1][j + 1], rows_w[i][j + 1]])
        bm_d.faces.new([rows_d[i][0], rows_d[i + 1][0], rows_d[i + 1][1], rows_d[i][1]])
    for bm in (bm_w, bm_d):
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        bmesh.ops.mirror(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], axis="X", merge_dist=1e-4)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm_d.faces:
        if f.normal.z < 0:
            f.normal_flip()
    new_obj("bulwark", bm_w, M["white"])
    new_obj("deck", bm_d, M["deck"])
    # inner face of the transom bulwark
    s = 0.0
    yi = half_breadth(s, deck_z(s)) - t
    box("transom_bulwark", (0, Y(0.3), (deck_z(s) + bulwark_z(s)) / 2),
        (2 * yi, 0.18, bulwark_z(s) - deck_z(s)), M["white"])
    # stern roller
    cyl("stern_roller", (-1.4, Y(0.15), bulwark_z(0) + 0.05), (1.4, Y(0.15), bulwark_z(0) + 0.05), 0.22, M["steel"], seg=14)


# ---------------------------------------------------------------- appendages
def build_appendages():
    # box keel / skeg running aft into the nozzle
    prof = [(2.2, -3.62), (17.5, -3.32), (17.5, keel_z(17.5) + 0.05), (12, keel_z(12) + 0.05),
            (7.0, keel_z(7.0) + 0.05), (4.5, keel_z(4.5) + 0.05), (2.2, keel_z(2.2) + 0.05)]
    bot = [(0.32, Y(s), z) for s, z in prof]
    top = [(-0.32, Y(s), z) for s, z in prof]
    # prism() expects matching polygons offset vertically; build side plates instead
    bm = bmesh.new()
    a = [bm.verts.new(p) for p in bot]
    b = [bm.verts.new(p) for p in top]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(a)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([a[i], b[i], b[j], a[j]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    new_obj("skeg", bm, M["antifoul"])

    # propeller nozzle (2700 mm propeller in nozzle)
    zc, sc = -1.95, 1.75
    bm = bmesh.new()
    r_in, r_out, ln = 1.40, 1.62, 1.35
    seg = 28
    rings = []
    for (r, dy) in ((r_in, -ln / 2), (r_out, -ln / 2 + 0.25), (r_out, ln / 2), (r_in, ln / 2)):
        ring = []
        for k in range(seg):
            a_ = 2 * math.pi * k / seg
            ring.append(bm.verts.new((r * math.cos(a_), Y(sc) + dy, zc + r * math.sin(a_))))
        rings.append(ring)
    for i in range(4):
        r0, r1 = rings[i], rings[(i + 1) % 4]
        for k in range(seg):
            m_ = (k + 1) % seg
            bm.faces.new([r0[k], r0[m_], r1[m_], r1[k]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    new_obj("nozzle", bm, M["antifoul"], smooth_shade=True)
    # propeller: hub + four blades
    cyl("prop_hub", (0, Y(sc) - 0.45, zc), (0, Y(sc) + 0.45, zc), 0.28, M["steel"], seg=14)
    for k in range(4):
        a_ = math.pi / 4 + k * math.pi / 2
        c = Vector((0.72 * math.cos(a_), Y(sc), zc + 0.72 * math.sin(a_)))
        rgt = Vector((math.cos(a_), 0.0, math.sin(a_)))
        up = Vector((-math.sin(a_), 0.55, math.cos(a_)))
        panel("blade", c, rgt, up, 1.1, 0.7, M["steel"], depth=0.05)
    # rudder
    box("rudder", (0, Y(0.35), -1.95), (0.22, 1.3, 2.9), M["antifoul"], bevel=0.05)
    cyl("rudder_stock", (0, Y(0.35), -0.5), (0, Y(0.35), 0.4), 0.12, M["dark"])
    # bilge keels
    for side in (-1, 1):
        for s in np.linspace(7.5, 15.5, 2):
            pass
        pts = []
        for s in np.linspace(7.0, 16.0, 10):
            y = half_breadth(s, -2.55)
            pts.append(Vector((side * (y + 0.12), Y(s), -2.62)))
        for i in range(len(pts) - 1):
            p0, p1 = pts[i], pts[i + 1]
            mid = (p0 + p1) / 2
            panel("bilge_keel", mid, p1 - p0, Vector((side * 0.7, 0, -0.7)), (p1 - p0).length, 0.35,
                  M["antifoul"], depth=0.04)


# ---------------------------------------------------------------- superstructure
def build_superstructure():
    W = M["white"]
    # lower tier: accommodation casing on the shelter deck
    s0, s1, hw = 9.8, 16.6, 3.75
    z0, z1 = 2.9, 5.65
    bot = [(-hw, Y(s0), z0), (hw, Y(s0), z0), (hw, Y(s1), z0), (-hw, Y(s1), z0)]
    top = [(-hw, Y(s0), z1), (hw, Y(s0), z1), (hw, Y(s1 - 0.25), z1), (-hw, Y(s1 - 0.25), z1)]
    prism("casing", bot, top, W, bevel=0.05)
    # side windows of the casing
    for side in (-1, 1):
        for s in (11.0, 12.6, 14.2):
            panel("casing_win", (side * (hw + 0.01), Y(s), 4.75), (0, 1, 0), (0, 0, 1), 0.85, 0.6, M["glass"], 0.05)
        panel("casing_door", (side * (hw + 0.01), Y(15.6), 4.25), (0, 1, 0), (0, 0, 1), 0.75, 1.75, M["dark"], 0.04)

    # wheelhouse with forward-leaning (inverted) front windows
    s0, s1, hw2 = 10.9, 16.0, 3.35
    z0, z1 = 5.65, 8.05
    lean = 0.45
    bot = [(-hw2, Y(s0), z0), (hw2, Y(s0), z0), (hw2, Y(s1), z0), (-hw2, Y(s1), z0)]
    top = [(-hw2, Y(s0), z1), (hw2, Y(s0), z1), (hw2, Y(s1 + lean), z1), (-hw2, Y(s1 + lean), z1)]
    prism("wheelhouse", bot, top, W, bevel=0.05)
    # roof with brow overhang
    box("wh_roof", (0, Y((s0 + s1 + lean) / 2 + 0.1), z1 + 0.09), (2 * hw2 + 0.5, (s1 + lean - s0) + 0.7, 0.18), W, bevel=0.03)
    # front windows (6), on the leaning face
    fr = Vector((1, 0, 0))
    fu = Vector((0, lean, z1 - z0)).normalized()
    for i in range(6):
        x = -hw2 * 0.8 + i * (hw2 * 1.6 / 5)
        c = Vector((x, Y(s1) + lean * 0.55 + 0.03, z0 + (z1 - z0) * 0.55))
        panel("wh_front_win", c, fr, fu, 0.95, 1.15, M["glass"], 0.06)
    # side and aft windows
    for side in (-1, 1):
        for s in (11.6, 12.8, 14.0, 15.2):
            panel("wh_side_win", (side * (hw2 + 0.02), Y(s), 7.0),
                  (0, 1, 0), (0, 0, 1), 0.95, 1.1, M["glass"], 0.06)
    for x in (-1.9, -0.65, 0.65, 1.9):
        panel("wh_aft_win", (x, Y(s0) - 0.02, 7.0), (1, 0, 0), (0, 0, 1), 1.0, 1.05, M["glass"], 0.06)
    # name board under the windows
    panel("name_board", (0, Y(s1) + 0.08, 6.0), (1, 0, 0), (0, 0, 1), 3.2, 0.32, M["dark"], 0.04)

    # railings: around the casing roof (aft of wheelhouse) and the wheelhouse roof
    rz = z1 + 0.18
    railing("wh_rail", [(-hw2 - 0.2, Y(s0 - 0.3), rz), (hw2 + 0.2, Y(s0 - 0.3), rz),
                        (hw2 + 0.2, Y(s1 + 0.6), rz), (-hw2 - 0.2, Y(s1 + 0.6), rz)], 0.95, M["orange"], closed=True)
    railing("casing_rail", [(-hw + 0.1, Y(10.85), 5.65), (-hw + 0.1, Y(9.95), 5.65),
                            (hw - 0.1, Y(9.95), 5.65), (hw - 0.1, Y(10.85), 5.65)], 0.95, M["white"])

    # navigation lights on the wheelhouse sides
    box("nav_port", (-hw2 - 0.12, Y(15.4), 7.9), (0.12, 0.45, 0.3), M["red_light"])
    box("nav_stbd", (hw2 + 0.12, Y(15.4), 7.9), (0.12, 0.45, 0.3), M["green_light"])
    # liferafts on the casing roof
    for side in (-1, 1):
        cyl("liferaft", (side * 3.1, Y(10.2), 6.0), (side * 3.1, Y(10.2) - 1.2, 6.0), 0.33, W, seg=14)
        cyl("liferaft_cradle", (side * 3.1, Y(10.2) - 0.6, 5.65), (side * 3.1, Y(10.2) - 0.6, 5.8), 0.25, M["steel"], seg=6)

    # mast on the wheelhouse roof: pole, platforms, two radars, radome, whips
    mz0 = z1 + 0.18
    ms = 12.0
    cyl("mast", (0, Y(ms), mz0), (0, Y(ms), mz0 + 5.6), 0.16, W, seg=12)
    for side in (-1, 1):
        cyl("mast_leg", (side * 1.3, Y(ms - 0.6), mz0), (side * 0.15, Y(ms), mz0 + 2.6), 0.08, W, seg=8)
    box("radar_platform", (0, Y(ms), mz0 + 2.2), (2.6, 1.2, 0.12), W)
    box("radar1_base", (0, Y(ms + 0.2), mz0 + 2.45), (0.5, 0.5, 0.4), M["dark"])
    box("radar1", (0, Y(ms + 0.2), mz0 + 2.75), (3.6, 0.28, 0.32), M["white"], bevel=0.04)
    box("radar2_base", (0, Y(ms), mz0 + 3.7), (0.45, 0.45, 0.35), M["dark"])
    box("radar2", (0, Y(ms), mz0 + 4.0), (2.6, 0.25, 0.28), M["white"], bevel=0.04)
    box("yard", (0, Y(ms), mz0 + 4.9), (2.4, 0.12, 0.12), W)
    sphere("radome", (0.9, Y(ms + 1.6), z1 + 0.65), 0.42, W)
    sphere("radome2", (-0.9, Y(ms + 1.6), z1 + 0.55), 0.3, W)
    for x in (-1.1, 1.1):
        cyl("whip", (x, Y(ms), mz0 + 4.9), (x, Y(ms), mz0 + 8.3), 0.025, M["white"], seg=5)
    sphere("masthead_light", (0, Y(ms + 0.15), mz0 + 5.5), 0.14, M["white_light"], seg=10)

    # exhaust stack aft of the wheelhouse
    cyl("exhaust_casing", (1.9, Y(9.6), 5.0), (1.9, Y(9.6), 9.3), 0.42, W, seg=16)
    cyl("exhaust_top", (1.9, Y(9.6), 9.3), (1.9, Y(9.6), 9.75), 0.36, M["dark"], seg=16)

    # foremast with anchor light and a windlass on the forecastle
    fs = 20.6
    cyl("foremast", (0, Y(fs), deck_z(fs)), (0, Y(fs), deck_z(fs) + 4.6), 0.11, W, seg=10)
    sphere("anchor_light", (0, Y(fs), deck_z(fs) + 4.7), 0.12, M["white_light"], seg=10)
    zd = deck_z(21.3)
    box("windlass", (0, Y(21.3), zd + 0.45), (1.6, 0.9, 0.8), M["blue"], bevel=0.04)
    cyl("windlass_drum", (-1.1, Y(21.3), zd + 0.5), (1.1, Y(21.3), zd + 0.5), 0.3, M["steel"], seg=14)
    for side in (-1, 1):
        for s in (19.4, 6.0, 1.2):
            z = deck_z(s)
            x = side * (half_breadth(s, z) - 0.6)
            cyl("bollard", (x, Y(s) - 0.25, z), (x, Y(s) - 0.25, z + 0.55), 0.13, M["dark"], seg=10)
            cyl("bollard", (x, Y(s) + 0.25, z), (x, Y(s) + 0.25, z + 0.55), 0.13, M["dark"], seg=10)


# ---------------------------------------------------------------- fishing gear
def build_gear():
    W = M["white"]
    zd = deck_z(1.5)
    # stern gantry: two plated legs and a crossbeam with a platform
    top = 10.6
    for side in (-1, 1):
        x = side * 3.75
        bot = [(x - 0.35, Y(0.7), zd), (x + 0.35, Y(0.7), zd), (x + 0.35, Y(3.0), zd), (x - 0.35, Y(3.0), zd)]
        tp = [(x - 0.3, Y(1.2), top), (x + 0.3, Y(1.2), top), (x + 0.3, Y(2.2), top), (x - 0.3, Y(2.2), top)]
        prism("gantry_leg", bot, tp, W, bevel=0.04)
        # trawl block hanging from the crossbeam
        cyl("block_pennant", (x * 0.8, Y(1.6), top - 0.3), (x * 0.8, Y(1.6), top - 1.5), 0.03, M["dark"], seg=5)
        cyl("trawl_block", (x * 0.8 - 0.12, Y(1.6), top - 1.75), (x * 0.8 + 0.12, Y(1.6), top - 1.75), 0.32, M["orange"], seg=14)
    box("gantry_beam", (0, Y(1.7), top + 0.3), (8.4, 1.3, 0.7), W, bevel=0.04)
    railing("gantry_rail", [(-4.0, Y(1.1), top + 0.65), (4.0, Y(1.1), top + 0.65),
                            (4.0, Y(2.3), top + 0.65), (-4.0, Y(2.3), top + 0.65)], 0.9, M["orange"], closed=True)
    box("gantry_light", (0, Y(1.0), top + 0.2), (0.25, 0.12, 0.25), M["white_light"])

    # four split net drums in two pairs
    for (s, z) in ((3.6, zd + 1.25), (5.9, zd + 1.25)):
        for side in (-1, 1):
            x0, x1 = side * 0.25, side * 3.0
            cyl("drum_core", (x0, Y(s), z), (x1, Y(s), z), 0.95, M["net"], seg=20)
            cyl("drum_flange", (x0, Y(s), z), (x0 + side * 0.08, Y(s), z), 1.15, M["blue"], seg=20)
            cyl("drum_flange", (x1, Y(s), z), (x1 - side * 0.08, Y(s), z), 1.15, M["blue"], seg=20)
            box("drum_stand", ((x0 + x1) / 2, Y(s), zd + 0.05), (abs(x1 - x0), 0.4, 0.1), M["dark"])
        box("drum_post", (0, Y(s), zd + 0.65), (0.4, 0.5, 1.3), M["blue"])

    # three split trawl winches forward of the drums
    for x in (-2.4, 0.0, 2.4):
        s = 8.3
        z = deck_z(s)
        box("winch_frame", (x, Y(s), z + 0.45), (1.5, 1.1, 0.9), M["blue"], bevel=0.04)
        cyl("winch_drum", (x - 0.55, Y(s), z + 0.75), (x + 0.55, Y(s), z + 0.75), 0.42, M["steel"], seg=16)

    # knuckle-boom discharging crane on the port side
    cx, cs = -3.0, 9.2
    z = deck_z(cs)
    cyl("crane_pedestal", (cx, Y(cs), z), (cx, Y(cs), z + 2.2), 0.35, M["orange"], seg=14)
    j1 = Vector((cx, Y(cs), z + 2.4))
    j2 = j1 + Vector((0.6, -2.8, 2.2))
    j3 = j2 + Vector((0.4, -2.6, -2.4))
    cyl("crane_boom1", j1, j2, 0.2, M["orange"], seg=10)
    cyl("crane_boom2", j2, j3, 0.15, M["orange"], seg=10)
    cyl("crane_hook_line", j3, j3 - Vector((0, 0, 1.2)), 0.02, M["dark"], seg=5)


build_hull()
build_deck()
build_appendages()
build_superstructure()
build_gear()


# ---------------------------------------------------------------- merge + export
def merge_by_material():
    """One mesh per material keeps draw calls low in three.js."""
    dg = bpy.context.evaluated_depsgraph_get()
    groups = {}
    for ob in BOAT:
        groups.setdefault(ob.data.materials[0].name, []).append(ob)
    merged = []
    for name, obs in groups.items():
        bm = bmesh.new()
        for ob in obs:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            me.transform(ob.matrix_world)
            bm.from_mesh(me)
            ev.to_mesh_clear()
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.materials.append(bpy.data.materials[name])
        merged.append(ob)
    for ob in BOAT:
        bpy.data.objects.remove(ob, do_unlink=True)
    return merged


parts = merge_by_material()
root = bpy.data.objects.new("trawler", None)
bpy.context.scene.collection.objects.link(root)
for ob in parts:
    ob.parent = root

tris = 0
for ob in parts:
    ob.data.calc_loop_triangles()
    tris += len(ob.data.loop_triangles)
print("parts", len(parts), "triangles", tris)

for ob in bpy.context.scene.objects:
    ob.select_set(False)
root.select_set(True)
for ob in parts:
    ob.select_set(True)
bpy.context.view_layer.objects.active = root

glb = os.path.join(OUT, "trawler.glb")
bpy.ops.export_scene.gltf(
    filepath=glb,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_image_format="JPEG",
    export_jpeg_quality=88,
)
print("wrote", glb, os.path.getsize(glb) // 1024, "KB")


# ---------------------------------------------------------------- preview renders
if RENDER:
    scene = bpy.context.scene
    world = bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.64, 0.74, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9

    sea = material("sea", (0.01, 0.035, 0.05), rough=0.12)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=400)
    new_sea = bpy.data.meshes.new("sea")
    bm.to_mesh(new_sea)
    bm.free()
    sea_ob = bpy.data.objects.new("sea", new_sea)
    new_sea.materials.append(sea)
    scene.collection.objects.link(sea_ob)

    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = 3.2
    sun_data.angle = math.radians(1.5)
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = (math.radians(52), 0, math.radians(35))
    scene.collection.objects.link(sun)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 40
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    try:
        scene.cycles.use_denoising = True
    except Exception:
        pass
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720

    views = {
        "bow_starboard": ((19.0, 21.0, 6.5), (0.0, 0.5, 3.0)),
        "stern_port": ((-17.0, -20.0, 9.0), (0.0, -2.0, 3.0)),
        "profile": ((34.0, 0.0, 3.0), (0.0, 0.0, 2.5)),
        "stern": ((0.0, -30.0, 4.0), (0.0, 0.0, 2.0)),
    }
    for name, (pos, target) in views.items():
        cam.location = pos
        d = Vector(target) - Vector(pos)
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(OUT, f"render_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", scene.render.filepath)
