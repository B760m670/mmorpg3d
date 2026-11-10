"""
Procedural Blender model of a large sailing ship of the 1620s, built after
the Swedish royal ship Vasa (1628), the one ship of that age that survives
whole (raised 1961, Vasa Museum, Stockholm).

Reference data (Vasa Museum; Hocker, "Vasa: a Swedish warship", 2011;
Bengtsson/Hocker et al., "Vasa II. Rigging and sailing a Swedish warship of
1628", 2021):
  * length between perpendiculars 47.5 m, beam 11.7 m, draught 4.8 m,
    displacement 1210 t; 69 m with the bowsprit; 52.5 m from the keel to the
    main truck;
  * Dutch "bottom-first" oak hull, carvel planked, heavy wales; strong
    tumblehome above the greatest breadth (at the lower gundeck);
  * decks: hold, orlop, lower and upper gundeck (two tiers of ports), half
    deck and poop aft, forecastle forward; flat transom (square tuck) under a
    counter, high stern with an open gallery and quarter galleries, three
    stern lanterns; beakhead with a lion figurehead;
  * steering by whipstaff and tiller, rudder hung on the sternpost, 23 deg;
  * rig: bowsprit with spritsail and sprit topsail; fore and main mast with
    course, topsail, topgallant; mizzen with lateen and mizzen topsail; round
    tops, shrouds set up with deadeyes on channels.
The ship is not Vasa herself: she carries both guns and cargo, her ports are
closed, and her carvings are plain. The emblem on her stern is her own.

Run with the bpy module (Python 3.13, bpy 5.2):
  python build_galleon.py -- <out_dir> [--atlas 2048] [--quick] [--render]

Writes <out_dir>/galleon.glb (Y-up, bow toward -Z, 1 unit = 1 m, design
waterline at y = 0, origin amidships) and src/ship/galleon_rig.json (yards,
sail corners, lanterns, rudder; in the glTF's own coordinates) for the game,
which builds the sails and flags itself so they can fill, flog and be furled.
"""

import bpy  # noqa: I001  (bpy must be imported before bmesh/mathutils)
import bmesh
import json
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector
from PIL import Image

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS and not ARGS[0].startswith("--") else os.path.join(os.path.dirname(__file__), "out")
RENDER = "--render" in ARGS
QUICK = "--quick" in ARGS
SHAPE = "--shape" in ARGS       # geometry check: previews with procedural materials, no bake/export
ATLAS = int(ARGS[ARGS.index("--atlas") + 1]) if "--atlas" in ARGS else 4096
HERE = os.path.dirname(os.path.abspath(__file__))
RIG_JSON = os.path.join(HERE, "..", "src", "ship", "galleon_rig.json")
os.makedirs(OUT, exist_ok=True)


# ------------------------------------------------------------------ math
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def frange(a, b, step):
    n = max(1, int(math.ceil((b - a) / step - 1e-9)))
    return [a + (b - a) * k / n for k in range(n + 1)]


# ------------------------------------------------------------------ data
# Proportions checked against the photogrammetry of Vasa herself (Swedish
# National Maritime Museums, Sketchfab): a high side, strong tumblehome, a
# tall narrow stern in tiers, two tiers of ports between heavy wales.
LPP = 47.5            # between perpendiculars: aft perpendicular s = 0 at the sternpost
HB = 5.85             # half the greatest breadth (11.7 m)
S_MID = 24.0          # origin amidships
Z_KEEL = -4.8         # keel bottom (draught 4.8 m)
Z_RAB = -4.4          # rabbet: planking meets the keel
KEEL_HW = 0.22
Z_MB = 1.0            # height of greatest breadth (lower gundeck)
Z_WT = 4.0            # wing transom: top of the flat tuck, over the stern chasers
Z_CTR = 6.6           # top of the counter, foot of the stern galleries
Z_STEMHEAD = 5.2      # stem head, foot of the beakhead bulkhead
Z_TOP_STERN = 13.4    # top of the stern panel (the crest stands above it)
S_MIN, S_MAX = -3.4, 52.0   # extent of the hull texture along the ship

# decks, amidships, above the waterline (sheer added along the ship)
D_HOLD, D_ORLOP, D_LGD, D_UGD = -3.4, -1.3, 1.0, 3.4
D_QD, D_FC, D_POOP, D_ROYAL = 5.75, 5.9, 8.0, 10.2
BRK_ROYAL, BRK_POOP, BRK_QD, BRK_FC = 3.0, 9.2, 23.0, 38.0     # deck breaks (stations)
WAIST_H = 2.2         # the waist bulwark stands high over the upper gundeck
CASTLE_H = 1.0        # solid side of the castles; an open rail stands on it

# masts: station, and heights of lower masthead / top / topmast head /
# topmast crosstrees / topgallant head (m above the waterline)
MASTS = {
    "fore":   dict(s=41.2, r0=0.48, top=20.2, head=22.4, tm=34.0, ct=32.0, tg=42.0, rtop=1.7),
    "main":   dict(s=24.4, r0=0.53, top=22.0, head=24.4, tm=37.4, ct=35.0, tg=46.8, rtop=1.95),
    "mizzen": dict(s=10.8, r0=0.33, top=17.4, head=19.4, tm=28.0, ct=None, tg=None, rtop=1.2),
}


def Y(s):
    """Station s (metres forward of the aft perpendicular) -> Blender Y."""
    return s - S_MID


def sheer(s):
    """Sheer: 1.5 m at the sternpost, 1.0 m at the stem."""
    if s < 26.0:
        return 1.5 * ((26.0 - s) / 26.0) ** 2
    return 1.0 * ((s - 26.0) / 25.0) ** 2


def deck_level(s):
    if s < BRK_ROYAL:
        d = D_ROYAL
    elif s < BRK_POOP:
        d = D_POOP
    elif s < BRK_QD:
        d = D_QD
    elif s < BRK_FC:
        d = D_UGD
    else:
        d = D_FC
    return d + sheer(s)


def rail_top(s):
    """Top of the solid side: stepped at the deck breaks, rising aft to the
    top of the stern."""
    z = D_ROYAL + CASTLE_H
    z = lerp(z, D_POOP + CASTLE_H, smooth(BRK_ROYAL - 0.15, BRK_ROYAL + 0.15, s))
    z = lerp(z, D_QD + CASTLE_H, smooth(BRK_POOP - 0.15, BRK_POOP + 0.15, s))
    z = lerp(z, D_UGD + WAIST_H, smooth(BRK_QD - 0.15, BRK_QD + 0.15, s))
    z = lerp(z, D_FC + CASTLE_H, smooth(BRK_FC - 0.15, BRK_FC + 0.15, s))
    z += sheer(s)
    return z + (Z_TOP_STERN - z) * (1 - smooth(-1.8, 0.6, s))


def s_aft(z):
    """After boundary of the hull: the raked sternpost up to the wing
    transom, the counter curving aft, then the upper stern, raked."""
    if z <= Z_WT:
        return lerp(1.2, -0.45, (z - Z_RAB) / (Z_WT - Z_RAB))
    if z <= Z_CTR:
        return -0.45 - 1.45 * math.sin(0.5 * math.pi * (z - Z_WT) / (Z_CTR - Z_WT))
    return -1.9 - 0.08 * (z - Z_CTR)


def W_aft(z):
    """Half width of the stern: the flat tuck from just above the water, the
    counter, the tall upper stern narrowing with the tumblehome."""
    if z <= 0.6:
        return 0.0
    if z <= Z_WT:
        return 3.5 * ((z - 0.6) / (Z_WT - 0.6)) ** 0.62
    if z <= Z_CTR:
        return lerp(3.5, 3.9, smooth(Z_WT, Z_CTR, z))
    return lerp(3.9, 2.3, (z - Z_CTR) / (Z_TOP_STERN - Z_CTR))


def s_fwd(z):
    """Fore boundary: the stem, raked forward in a long curve, then the
    beakhead bulkhead."""
    if z <= Z_STEMHEAD:
        u = clamp((z - Z_RAB) / (Z_STEMHEAD - Z_RAB))
        return 41.5 + 9.5 * (1 - (1 - u) ** 1.8)
    return s_fwd(Z_STEMHEAD) - 0.12 * (z - Z_STEMHEAD)


def W_fwd(z):
    if z <= Z_STEMHEAD:
        return 0.0
    return min(3.2, 3.2 * ((z - Z_STEMHEAD) / 1.2) ** 0.5)


def Y0(z):
    """Midship section: flat floor, hard round bilge, greatest breadth at the
    lower gundeck, sides falling in steadily above it."""
    if z <= Z_MB:
        q = clamp((Z_MB - z) / (Z_MB - Z_RAB))
        n = 2.6
        return KEEL_HW + (HB - KEEL_HW) * (1 - q ** n) ** (1 / n)
    d = z - Z_MB
    return HB - 0.2374 * d - 0.000362 * d * d


def half_breadth(s, z):
    y0 = Y0(z)
    sa, sf = s_aft(z), s_fwd(z)
    wa, wf = W_aft(z), W_fwd(z)
    ta = smooth(Z_RAB, 4.0, z)
    da, Da, pa = max(0.0, s - sa), lerp(20.0, 11.0, ta), lerp(1.9, 2.4, ta)
    y = wa + (y0 - wa) * (1 - (1 - min(1.0, da / Da)) ** pa)
    tf = smooth(Z_RAB, 4.5, z)
    df, Df, pf = max(0.0, sf - s), lerp(16.0, 8.0, tf), lerp(1.8, 2.3, tf)
    y = wf + (y - wf) * (1 - (1 - min(1.0, df / Df)) ** pf)
    return max(0.0, y)


def hull_frame(s, z):
    """Point on the starboard side and its outward normal and tangents."""
    y = half_breadth(s, z)
    e = 0.04
    dyds = (half_breadth(s + e, z) - half_breadth(s - e, z)) / (2 * e)
    dydz = (half_breadth(s, z + e) - half_breadth(s, z - e)) / (2 * e)
    n = Vector((1.0, -dyds, -dydz)).normalized()
    ts = Vector((dyds, 1.0, 0.0)).normalized()
    tz = Vector((dydz, 0.0, 1.0)).normalized()
    return Vector((y, Y(s), z)), n, ts, tz


# hull grid: columns run from the stern to the stem at a fixed fraction of
# the length of each waterline (so the ends follow the sternpost, counter
# and stem exactly); rows run from the rabbet to the top of the side.
SA6, SF6 = s_aft(6.0), s_fwd(6.0)


def col_s(u, z):
    return lerp(s_aft(z), s_fwd(z), u)


def _columns():
    pts = set()
    s = SA6
    while s < SF6:
        pts.add(round(s, 3))
        e = min(s - SA6, SF6 - s)
        s += 0.16 if e < 2.5 else 0.3 if e < 8 else 0.42
    for a in (BRK_ROYAL, BRK_POOP, BRK_QD, BRK_FC):
        for d in (-0.21, -0.15, -0.05, 0.05, 0.15, 0.21):
            pts.add(round(a + d, 3))
    pts.add(SF6)
    return sorted((p - SA6) / (SF6 - SA6) for p in pts if SA6 <= p <= SF6)


U = _columns()
ZTOP = [rail_top(col_s(u, 6.0)) for u in U]
LANTERNS = [(-1.7, ZTOP[0] + 0.85, 0.31), (0.0, ZTOP[0] + 1.7, 0.41), (1.7, ZTOP[0] + 0.85, 0.31)]
NV = 96


# ------------------------------------------------------------------ scene helpers
for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for item in list(coll):
        coll.remove(item)

PARTS = []      # everything that is merged by material group
SIDE = set()    # starboard-only parts, mirrored to port before merging


def _sock(sockets, name, kind):
    return next(x for x in sockets if x.name == name and x.type == kind)


def material(name, color, rough=0.5, metal=0.0, emit=None, grime=0.0, bump=0.0, grain=None, carve=0.0):
    """Principled material with procedural weathering, baked later.

    grime: rain streaks and blotches; bump: relief (metres); grain: wood
    grain along 'x', 'y' or 'z' of the object; carve: carved relief."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = 1.0
    if not (grime or bump or grain or carve):
        return m
    link = nt.links.new
    tc = nt.nodes.new("ShaderNodeTexCoord")

    def noise(scale, detail, vec=None, r=0.5):
        n = nt.nodes.new("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = r
        link(vec if vec is not None else tc.outputs["Object"], n.inputs["Vector"])
        return n.outputs["Fac"]

    def mrange(sock, a, b):
        n = nt.nodes.new("ShaderNodeMapRange")
        n.inputs["From Min"].default_value = a
        n.inputs["From Max"].default_value = b
        link(sock, n.inputs["Value"])
        return n.outputs["Result"]

    def op(kind, a, b):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = kind
        n.use_clamp = kind in ("ADD", "MULTIPLY", "MAXIMUM")
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                link(v, n.inputs[i])
        return n.outputs["Value"]

    def stretched(sx, sy, sz):
        n = nt.nodes.new("ShaderNodeMapping")
        n.inputs["Scale"].default_value = (sx, sy, sz)
        link(tc.outputs["Object"], n.inputs["Vector"])
        return n.outputs["Vector"]

    def mix(fac, a, b):
        n = nt.nodes.new("ShaderNodeMix")
        n.data_type = "RGBA"
        link(fac, _sock(n.inputs, "Factor", "VALUE"))
        for nm, v in (("A", a), ("B", b)):
            sk = _sock(n.inputs, nm, "RGBA")
            if isinstance(v, tuple):
                sk.default_value = (*v, 1.0)
            else:
                link(v, sk)
        return _sock(n.outputs, "Result", "RGBA")

    col = tuple(color)
    height = None
    if grain:
        sc = {"x": (0.35, 9, 9), "y": (9, 0.35, 9), "z": (9, 9, 0.35)}[grain]
        g = noise(6, 8, stretched(*sc), r=0.6)
        col = mix(mrange(g, 0.3, 0.75), (color[0] * 0.72, color[1] * 0.68, color[2] * 0.62),
                  (color[0] * 1.15, color[1] * 1.1, color[2] * 1.05))
        height = op("MULTIPLY", g, 0.4)
    if carve:
        # carved foliage: swirled noise in relief, the raised parts catching gilt
        n = nt.nodes.new("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = 4.0
        n.inputs["Detail"].default_value = 6.0
        n.inputs["Distortion"].default_value = 3.0
        link(tc.outputs["Object"], n.inputs["Vector"])
        rel = op("ADD", mrange(n.outputs["Fac"], 0.35, 0.7), op("MULTIPLY", noise(18, 4), 0.35))
        high = mrange(rel, 0.75, 1.1)
        col = mix(op("MULTIPLY", high, carve), col if isinstance(col, tuple) else col, (0.5, 0.36, 0.12))
        height = rel if height is None else op("ADD", height, rel)
    if grime:
        streaks = stretched(2.2, 2.2, 0.12)
        dirt = op("MULTIPLY", op("ADD", mrange(noise(3, 4, streaks), 0.52, 0.75),
                                 mrange(noise(0.9, 6), 0.45, 0.8)), grime)
        col = mix(dirt, col, (color[0] * 0.5, color[1] * 0.46, color[2] * 0.4))
        link(op("ADD", rough, op("MULTIPLY", dirt, 0.12)), p.inputs["Roughness"])
    if isinstance(col, tuple):
        p.inputs["Base Color"].default_value = (*col, 1.0)
    else:
        link(col, p.inputs["Base Color"])
    if bump or height is not None:
        h = height if height is not None else noise(0.7, 2)
        if bump:
            h = op("ADD", h, op("MULTIPLY", noise(30, 2), 0.15))
        b = nt.nodes.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = 1.0
        b.inputs["Distance"].default_value = bump or 0.01
        link(h, b.inputs["Height"])
        link(b.outputs["Normal"], p.inputs["Normal"])
    return m


def new_obj(name, bm, mat, smooth_shade=False, side=False):
    if smooth_shade:
        for f in bm.faces:
            f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    PARTS.append(ob)
    if side:
        SIDE.add(ob)
    return ob


def box(name, c, size, mat, side=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0] + c[0], v.co.y * size[1] + c[1], v.co.z * size[2] + c[2]))
    return new_obj(name, bm, mat, side=side)


def cyl(name, p0, p1, r, mat, seg=10, cap=True, r2=None, side=False):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    if d.length < 1e-4:
        return None
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, segments=seg, radius1=r,
                          radius2=r if r2 is None else r2, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    for f in bm.faces:
        f.smooth = len(f.verts) == 4
    return new_obj(name, bm, mat, side=side)


def sphere(name, c, r, mat, seg=14, scale=(1, 1, 1), side=False, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r)
    for v in bm.verts:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
    if rot is not None:
        bmesh.ops.transform(bm, matrix=rot.to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return new_obj(name, bm, mat, smooth_shade=True, side=side)


def solid(name, bot, top, mat, side=False):
    """Solid between two polygons with matching vertex order."""
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
    return new_obj(name, bm, mat, side=side)


def extrude_x(name, profile, x0, x1, mat, side=False):
    """Plate: a (s, z) profile extruded across the ship from x0 to x1."""
    return solid(name, [(x0, Y(s), z) for s, z in profile], [(x1, Y(s), z) for s, z in profile], mat, side)


def plate_y(name, pts_xz, s, t, mat, side=False):
    """Polygon in the (x, z) plane at station s, thickness t along the ship."""
    return solid(name, [(x, Y(s) - t / 2, z) for x, z in pts_xz], [(x, Y(s) + t / 2, z) for x, z in pts_xz], mat, side)


def panel(name, center, right, up, w, h, mat, depth=0.04, side=False):
    center, right, up = Vector(center), Vector(right).normalized(), Vector(up).normalized()
    nrm = right.cross(up).normalized()
    bm = bmesh.new()
    vs = []
    for sd in (-1, 1):
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            vs.append(bm.verts.new(center + right * (su * w / 2) + up * (sv * h / 2) + nrm * (sd * depth / 2)))
    b, t = vs[:4], vs[4:]
    bm.faces.new(list(reversed(b)))
    bm.faces.new(t)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([b[i], b[j], t[j], t[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, mat, side=side)


def tube(name, c, r, h, t, mat, seg=28):
    """Open ring wall (the rim of a top)."""
    bm = bmesh.new()
    rings = []
    for rr, zz in ((r, 0), (r, h), (r - t, h), (r - t, 0)):
        rings.append([bm.verts.new((c[0] + rr * math.cos(2 * math.pi * k / seg), c[1] + rr * math.sin(2 * math.pi * k / seg), c[2] + zz))
                      for k in range(seg)])
    for a in range(4):
        ra, rb = rings[a], rings[(a + 1) % 4]
        for k in range(seg):
            k2 = (k + 1) % seg
            bm.faces.new([ra[k], ra[k2], rb[k2], rb[k]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, mat, smooth_shade=True)


def curve_pts(p0, p1, p2, n=10):
    p0, p1, p2 = Vector(p0), Vector(p1), Vector(p2)
    return [(1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2 for t in (k / n for k in range(n + 1))]


def rod(name, pts, r, mat, seg=8, side=False):
    for a, b in zip(pts[:-1], pts[1:]):
        cyl(name, a, b, r, mat, seg=seg, side=side)


def baluster_row(name, a, b, h, mat, rail_mat, gap=0.32, side=False):
    a, b = Vector(a), Vector(b)
    n = max(1, int(round((a - b).length / gap)))
    for k in range(n + 1):
        p = a.lerp(b, k / n)
        cyl(name, p, p + Vector((0, 0, h * 0.82)), 0.04, mat, seg=6, side=side)
        sphere(name, p + Vector((0, 0, h * 0.42)), 0.065, mat, seg=6, side=side)
    up = Vector((0, 0, h))
    d = (b - a).normalized()
    box(name + "_rail", (a + b) / 2 + up * 0.92, (abs(b.x - a.x) + 0.12 if abs(d.x) > 0.5 else 0.14,
                                                 abs(b.y - a.y) + 0.12 if abs(d.y) > 0.5 else 0.14, 0.1), rail_mat, side=side)
    box(name + "_sill", (a + b) / 2 + Vector((0, 0, 0.04)), (abs(b.x - a.x) + 0.1 if abs(d.x) > 0.5 else 0.12,
                                                            abs(b.y - a.y) + 0.1 if abs(d.y) > 0.5 else 0.12, 0.08), rail_mat, side=side)


# ------------------------------------------------------------------ materials
M = {
    "hull": material("hull_livery", (1, 1, 1), rough=0.8),
    "stern": material("stern_carved", (0.14, 0.095, 0.06), rough=0.72, grime=0.5, carve=0.16, bump=0.03),
    "red": material("paint_red", (0.2, 0.052, 0.034), rough=0.74, grime=0.45, grain="y", bump=0.003),
    "red_z": material("paint_red_vertical", (0.2, 0.052, 0.034), rough=0.74, grime=0.45, grain="z", bump=0.003),
    "oak": material("oak", (0.14, 0.092, 0.056), rough=0.8, grime=0.5, grain="y", bump=0.004),
    "oak_x": material("oak_across", (0.14, 0.092, 0.056), rough=0.8, grime=0.5, grain="x", bump=0.004),
    "oak_z": material("oak_vertical", (0.14, 0.092, 0.056), rough=0.8, grime=0.5, grain="z", bump=0.004),
    "dark": material("dark_wood", (0.055, 0.04, 0.03), rough=0.75, grime=0.3, grain="y", bump=0.004),
    "dark_z": material("dark_wood_vertical", (0.055, 0.04, 0.03), rough=0.75, grime=0.3, grain="z", bump=0.004),
    "gold": material("gilt", (0.4, 0.29, 0.1), rough=0.48, metal=0.6, grime=0.6, carve=0.15, bump=0.01),
    "carved": material("carved_dark", (0.15, 0.1, 0.064), rough=0.72, grime=0.45, carve=0.2, bump=0.03),
    "figure": material("carved_figure", (0.17, 0.115, 0.072), rough=0.7, grime=0.45, bump=0.004),
    "iron": material("iron", (0.07, 0.068, 0.066), rough=0.62, metal=0.55),
    "grating": material("grating", (0.16, 0.11, 0.07), rough=0.85, grime=0.5, grain="x", bump=0.004),
    "hold": material("hold_dark", (0.01, 0.008, 0.006), rough=1.0),
    "deck": material("deck_planks", (1, 1, 1), rough=0.85),
    "spar": material("spar", (0.16, 0.11, 0.075), rough=0.75),
    "rope": material("rope", (0.05, 0.042, 0.032), rough=0.95),
    "deadeye": material("deadeye", (0.09, 0.06, 0.04), rough=0.8),
    "window": material("light_window", (0.02, 0.022, 0.024), rough=0.12, metal=0.3, emit=(0.12, 0.06, 0.025)),
    "lantern": material("light_lantern", (0.16, 0.13, 0.09), rough=0.15, metal=0.2, emit=(0.14, 0.08, 0.035)),
}
PLAIN = {M["spar"], M["rope"], M["deadeye"], M["iron"]}       # the rig: no bake
LIGHTS = {M["window"], M["lantern"]}


# ------------------------------------------------------------------ hull
def build_hull():
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    grid = []
    for i, u in enumerate(U):
        col = []
        for j in range(NV + 1):
            z = Z_RAB + (ZTOP[i] - Z_RAB) * j / NV
            s = col_s(u, z)
            col.append(bm.verts.new((half_breadth(s, z), Y(s), z)))
        grid.append(col)
    for i in range(len(U) - 1):
        for j in range(NV):
            f = bm.faces.new([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]])
            for lp in f.loops:
                co = lp.vert.co
                lp[uvl].uv = ((co.y + S_MID - S_MIN) / (S_MAX - S_MIN), (co.z - Z_RAB) / (Z_TOP_STERN - Z_RAB))
    ob = new_obj("hull_side", bm, M["hull"], smooth_shade=True, side=True)
    ob.data.set_sharp_from_angle(angle=math.radians(35))

    def end_face(name, col_i, sfn, wfn, outward, mat, zmin=-99.0, zmax=99.0):
        bm = bmesh.new()
        prev = None
        js = [j for j in range(NV + 1) if zmin - 1e-6 <= Z_RAB + (ZTOP[col_i] - Z_RAB) * j / NV <= zmax + 1e-6]
        js = sorted(set(js + [min(range(NV + 1), key=lambda j: abs(Z_RAB + (ZTOP[col_i] - Z_RAB) * j / NV - zz)) for zz in (zmin, zmax)
                              if -50 < zz < 50]))
        for j in js:
            z = Z_RAB + (ZTOP[col_i] - Z_RAB) * j / NV
            w = wfn(z)
            if w < 0.01:
                prev = None
                continue
            cur = [bm.verts.new((lerp(-w, w, k / 8), Y(sfn(z)), z)) for k in range(9)]
            if prev:
                for k in range(8):
                    if outward < 0:
                        bm.faces.new([prev[k], prev[k + 1], cur[k + 1], cur[k]])
                    else:
                        bm.faces.new([prev[k], cur[k], cur[k + 1], prev[k + 1]])
            prev = cur
        return new_obj(name, bm, mat)

    j_wt = min(range(NV + 1), key=lambda j: abs(Z_RAB + (ZTOP[0] - Z_RAB) * j / NV - Z_WT))
    z_wt = Z_RAB + (ZTOP[0] - Z_RAB) * j_wt / NV
    end_face("transom_tuck", 0, s_aft, W_aft, -1, M["oak_x"], zmax=z_wt)
    end_face("transom", 0, s_aft, W_aft, -1, M["stern"], zmin=z_wt)
    end_face("bow_bulkhead", len(U) - 1, s_fwd, W_fwd, +1, M["red_z"])

    # keel, stem, sternpost
    box("keel", (0, Y((1.0 + 41.6) / 2), (Z_KEEL + Z_RAB + 0.06) / 2), (2 * KEEL_HW, 41.6 - 1.0, Z_RAB + 0.06 - Z_KEEL), M["dark"])
    zs = frange(Z_KEEL, Z_STEMHEAD + 0.55, 0.3)
    outer = [(s_fwd(max(z, Z_RAB)) + 0.3 + 0.6 * max(0.0, Z_RAB - z), z) for z in zs]
    inner = [(s_fwd(max(z, Z_RAB)) - 0.35, z) for z in reversed(zs)]
    extrude_x("stem", outer + inner, -0.21, 0.21, M["dark"])
    zs = frange(Z_KEEL, Z_WT + 0.45, 0.4)
    outer = [(s_aft(min(z, Z_WT)) - 0.38, z) for z in zs]
    inner = [(s_aft(min(z, Z_WT)) + 0.25, z) for z in reversed(zs)]
    extrude_x("sternpost", outer + inner, -0.23, 0.23, M["dark"])


# heavy wales, as counted on the scan: two by the waterline, one under and one
# over the lower ports, one under and one over the upper ports
WALES = [(-0.35, 0.32), (0.45, 0.30), (1.15, 0.28), (2.55, 0.30), (3.35, 0.26), (4.95, 0.28)]


def build_wales():
    for zc0, h in WALES:
        zc = lambda s, zc0=zc0: zc0 + sheer(s)  # noqa: E731
        za = zc(-1.0)
        s0 = max(s_aft(za - h / 2), s_aft(za + h / 2)) + 0.03
        zf = zc(50.0)
        s1 = min(s_fwd(zf - h / 2), s_fwd(zf + h / 2)) - 0.03
        ss = sorted(set(frange(s0, s0 + 1.5, 0.08) + frange(s0 + 1.5, s1 - 1.5, 0.3) + frange(s1 - 1.5, s1, 0.08)))
        bm = bmesh.new()
        rings = []
        t = 0.2
        for s in ss:
            zl, zh = zc(s) - h / 2, zc(s) + h / 2
            yl, yh = half_breadth(s, zl), half_breadth(s, zh)
            rings.append([bm.verts.new(p) for p in ((yl - 0.03, Y(s), zl), (yl + t * 0.8, Y(s), zl + 0.03),
                                                    (yh + t, Y(s), zh - 0.05), (yh - 0.03, Y(s), zh))])
        for a, b in zip(rings[:-1], rings[1:]):
            for k in range(4):
                k2 = (k + 1) % 4
                bm.faces.new([a[k], b[k], b[k2], a[k2]])
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        new_obj("wale", bm, M["dark"], side=True)


PORTS = []      # (s, zc, w, h): painted into the hull texture, lids as geometry
for _k in range(12):                       # lower gundeck, the 24-pounders
    _s = 7.6 + _k * 2.95
    PORTS.append((_s, D_LGD + 0.75 + sheer(_s), 0.95, 0.86))
for _k in range(12):                       # upper gundeck, staggered
    _s = 9.0 + _k * 2.95
    PORTS.append((_s, D_UGD + 0.75 + sheer(_s), 0.82, 0.74))
for _s in (11.8, 14.7, 17.6, 20.5):        # half deck
    PORTS.append((_s, D_QD + 0.55 + sheer(_s), 0.55, 0.5))
for _s in (40.0, 43.4):                    # forecastle
    PORTS.append((_s, D_FC + 0.55 + sheer(_s), 0.55, 0.5))
for _s in (4.8, 7.6):                      # cabins under the poop
    PORTS.append((_s, D_POOP + 0.55 + sheer(_s), 0.45, 0.42))


def build_ports():
    for s, zc, w, h in PORTS:
        p, n, ts, tz = hull_frame(s, zc)
        panel("port_lid", p + n * 0.035, ts, tz, w, h, M["oak"], depth=0.07, side=True)
        for f in (0.25, 0.75):      # hinge straps down the lid from its top
            panel("port_hinge", p + n * 0.075 + tz * (h * 0.06) + ts * (w * (f - 0.5)), ts, tz, 0.055, h * 0.8, M["iron"], 0.02, side=True)
        panel("port_ring", p + n * 0.075 - tz * (h * 0.3), ts, tz, 0.05, 0.05, M["iron"], 0.04, side=True)


# ------------------------------------------------------------------ decks
def deck_strip(name, s0, s1, zf, inset=0.2, step=0.4):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    prev = None
    for s in frange(s0, s1, step):
        z = zf(s)
        w = max(0.05, half_breadth(s, z) - inset)
        cur = [bm.verts.new((lerp(-w, w, k / 6), Y(s), z)) for k in range(7)]
        if prev:
            for k in range(6):
                f = bm.faces.new([prev[k], prev[k + 1], cur[k + 1], cur[k]])
                for lp in f.loops:
                    lp[uv].uv = (lp.vert.co.x / 4.0 + 0.5, (lp.vert.co.y + S_MID) / 4.0)
        prev = cur
    return new_obj(name, bm, M["deck"])


def build_decks():
    zp = lambda s: D_POOP + sheer(s)   # noqa: E731
    zq = lambda s: D_QD + sheer(s)     # noqa: E731
    zu = lambda s: D_UGD + sheer(s)    # noqa: E731
    zfc = lambda s: D_FC + sheer(s)    # noqa: E731
    zr = lambda s: D_ROYAL + sheer(s)  # noqa: E731
    deck_strip("deck_royal", s_aft(zr(-2)) + 0.22, BRK_ROYAL, zr)
    deck_strip("deck_poop", BRK_ROYAL, BRK_POOP, zp)
    deck_strip("deck_quarter", BRK_POOP, BRK_QD, zq)
    deck_strip("deck_waist", BRK_QD, BRK_FC, zu)
    deck_strip("deck_fore", BRK_FC, s_fwd(zfc(50.0)) - 0.22, zfc)

    # inside of the bulwarks, red as on Vasa, and the rail cap on top
    bm = bmesh.new()
    cols = []
    for i, u in enumerate(U):
        sref = col_s(u, 6.0)
        zd, zt = deck_level(sref) - 0.03, ZTOP[i]
        col = []
        for k in range(7):
            z = lerp(zd, zt, k / 6)
            s = col_s(u, z)
            col.append(bm.verts.new((max(0.05, half_breadth(s, z) - 0.2), Y(s), z)))
        cols.append(col)
    for a, b in zip(cols[:-1], cols[1:]):
        for k in range(6):
            bm.faces.new([a[k], a[k + 1], b[k + 1], b[k]])
    new_obj("bulwark_in", bm, M["red"], side=True)

    bm = bmesh.new()
    rings = []
    for i, u in enumerate(U):
        zt = ZTOP[i]
        s = col_s(u, zt)
        y = half_breadth(s, zt)
        rings.append([bm.verts.new(p) for p in ((y + 0.06, Y(s), zt - 0.06), (y + 0.06, Y(s), zt + 0.07),
                                                (y - 0.26, Y(s), zt + 0.07), (y - 0.26, Y(s), zt - 0.06))])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new([a[k], b[k], b[k2], a[k2]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    new_obj("rail_cap", bm, M["dark"], side=True)

    # stern and beakhead bulkhead from the inside, with their caps
    def inner_end(name, sfn, wfn, z0, z1, ds, mat, facing):
        bm = bmesh.new()
        prev = None
        for z in frange(z0, z1, 0.25):
            w = max(0.05, wfn(z) - 0.2)
            cur = [bm.verts.new((lerp(-w, w, k / 6), Y(sfn(z) + ds), z)) for k in range(7)]
            if prev:
                for k in range(6):
                    if facing > 0:
                        bm.faces.new([prev[k], cur[k], cur[k + 1], prev[k + 1]])
                    else:
                        bm.faces.new([prev[k], prev[k + 1], cur[k + 1], cur[k]])
            prev = cur
        new_obj(name, bm, mat)

    inner_end("transom_in", s_aft, W_aft, deck_level(-2.0) - 0.03, ZTOP[0], 0.2, M["red_z"], +1)
    inner_end("bulkhead_in", s_fwd, W_fwd, deck_level(50.0) - 0.03, ZTOP[-1], -0.2, M["red_z"], -1)
    zt = ZTOP[0]
    box("transom_cap", (0, Y(s_aft(zt) + 0.06), zt + 0.005), (2 * W_aft(zt) + 0.14, 0.34, 0.13), M["dark"])
    zt = ZTOP[-1]
    box("bulkhead_cap", (0, Y(s_fwd(zt) - 0.06), zt + 0.005), (2 * W_fwd(zt) + 0.14, 0.34, 0.13), M["dark"])

    # bulkheads at the deck breaks, with doors, pilasters and a balustrade
    for s, lo, hi, face in ((BRK_ROYAL, D_POOP, D_ROYAL, +1), (BRK_POOP, D_QD, D_POOP, +1), (BRK_QD, D_UGD, D_QD, +1), (BRK_FC, D_UGD, D_FC, -1)):
        z0, z1 = lo + sheer(s) - 0.03, hi + sheer(s)
        w0, w1 = half_breadth(s, z0) - 0.2, half_breadth(s, z1) - 0.2
        plate_y("break_wall", [(-w0, z0), (w0, z0), (w1, z1), (-w1, z1)], s, 0.14, M["red_z"])
        fy = Y(s) + face * 0.08
        for x in (-0.38 * w0, 0.38 * w0):       # doors
            box("break_door", (x, fy, z0 + 0.95), (0.85, 0.05, 1.8), M["hold"])
            box("break_doorframe", (x, fy + face * 0.02, z0 + 1.9), (1.05, 0.08, 0.12), M["gold"])
            for dx in (-0.48, 0.48):
                box("break_doorframe", (x + dx, fy + face * 0.02, z0 + 0.95), (0.1, 0.08, 1.9), M["carved"])
        for x in frange(-w1 + 0.4, w1 - 0.4, (2 * w1 - 0.8) / 6):   # pilasters
            if min(abs(x - 0.38 * w0), abs(x + 0.38 * w0)) > 0.6:
                box("break_pilaster", (x, fy + face * 0.03, (z0 + z1) / 2), (0.16, 0.08, z1 - z0 - 0.1), M["carved"])
        box("break_cornice", (0, Y(s) + face * 0.06, z1 - 0.05), (2 * w1, 0.2, 0.12), M["gold"])
        # balustrade along the edge of the upper deck, a gap at each ladder
        zb = z1 + 0.0
        ls = s - face * 0.12
        wl = half_breadth(s, zb) - 0.3
        for xa, xb in ((-wl, -wl + 0.5), (-wl + 1.5, wl - 1.5), (wl - 0.5, wl)):
            baluster_row("balustrade", (xa, Y(ls), zb), (xb, Y(ls), zb), 0.9, M["oak_z"], M["dark"])
        # ladders down to the lower deck, one each side
        for sgn in (-1, 1):
            x = sgn * (wl - 1.0)
            run = 1.6
            sb = s + face * run
            n = 6
            for k in range(1, n + 1):
                t = k / (n + 1)
                box("ladder_step", (x, Y(lerp(sb, s, t)), lerp(z0, z1, t)), (0.75, 0.24, 0.05), M["oak_x"])
            for dx in (-0.4, 0.4):
                cyl("ladder_side", (x + dx, Y(sb), z0), (x + dx, Y(s), z1), 0.05, M["oak"], seg=6)


# ------------------------------------------------------------------ carved figures
PERSON = os.path.join(HERE, "..", "public", "models", "person.glb")
FIGURE = None


def figure_template(tris=1700):
    """A standing man for the carvings: the Rocketbox person of the game
    (MIT), posed, frozen, decimated, height 1, feet at 0, facing +Y."""
    global FIGURE
    if FIGURE is not None:
        return FIGURE
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=PERSON)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    meshes = [o for o in new if o.type == "MESH" and o.parent == arm]
    act = bpy.data.actions.get("idle")
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    ad = arm.animation_data
    if hasattr(ad, "action_slot") and ad.action_slot is None and len(act.slots):
        ad.action_slot = act.slots[0]
    bpy.context.scene.frame_set(6)
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        ev.to_mesh_clear()
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.scene.frame_set(0)
    zs = [v.co.z for v in bm.verts]
    z0, z1 = min(zs), max(zs)
    hgt = z1 - z0
    cx = sum(v.co.x for v in bm.verts) / len(bm.verts)
    cy = sum(v.co.y for v in bm.verts) / len(bm.verts)
    for v in bm.verts:
        v.co = Vector(((v.co.x - cx) / hgt, (v.co.y - cy) / hgt, (v.co.z - z0) / hgt))
    # which way does he face? the toes stand out ahead of the heels
    feet = [v.co for v in bm.verts if v.co.z < 0.04]
    hips = [v.co for v in bm.verts if 0.45 < v.co.z < 0.55]
    fx = sum(c.x for c in feet) / len(feet) - sum(c.x for c in hips) / len(hips)
    fy = sum(c.y for c in feet) / len(feet) - sum(c.y for c in hips) / len(hips)
    ang = math.atan2(fx, fy)          # rotate so that he faces +Y
    bmesh.ops.transform(bm, matrix=Matrix.Rotation(ang, 4, "Z"), verts=bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    me = bpy.data.meshes.new("figure_full")
    bm.to_mesh(me)
    n_tris = sum(len(f.verts) - 2 for f in bm.faces)
    bm.free()
    tmp = bpy.data.objects.new("figure_tmp", me)
    bpy.context.scene.collection.objects.link(tmp)
    mod = tmp.modifiers.new("dec", "DECIMATE")
    mod.ratio = min(1.0, tris / max(1, n_tris))
    dg = bpy.context.evaluated_depsgraph_get()
    FIGURE = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    print("figure template", n_tris, "->", len(FIGURE.polygons), "faces")
    return FIGURE


def figure(name, foot, height, facing, mat=None, side=False, lean=0.0, girth=1.15):
    """A carved figure standing at foot, facing the angle about Z (0 = +Y,
    i.e. forward; pi = aft). Carvings are stockier than life: girth."""
    bm = bmesh.new()
    bm.from_mesh(figure_template())
    m = (Matrix.Translation(Vector(foot)) @ Matrix.Rotation(facing, 4, "Z") @ Matrix.Rotation(lean, 4, "X")
         @ Matrix.Diagonal((height * girth, height * girth, height, 1.0)))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return new_obj(name, bm, mat or M["figure"], smooth_shade=True, side=side)


def carved_post(name, p0, p1, r, mat, side=False, knobs=6):
    """A turned and carved post: a shaft with collars and knops along it."""
    p0, p1 = Vector(p0), Vector(p1)
    cyl(name, p0, p1, r, mat, seg=8, side=side)
    for k in range(1, knobs):
        p = p0.lerp(p1, k / knobs)
        sphere(name + "_knop", p, r * 1.6, mat, seg=8, scale=(1, 1, 0.7), side=side)


# ------------------------------------------------------------------ stern
def build_stern():
    """The stern as on Vasa, from the water up: planked tuck with the stern
    chasers, the counter, a cornice on carved brackets, the great cabin's
    gallery fronted by standing figures, a second cornice, the upper gallery
    as an arcade, the arms in a carved frame between two supporters, the
    crest, and tall carved posts at the corners; quarter galleries round the
    sides with fluted domes."""
    zt = ZTOP[0]
    zq = D_QD + sheer(-1.0)          # great cabin floor at the stern
    zp = D_POOP + sheer(-1.0)        # poop deck over it
    zr0 = D_ROYAL + sheer(-1.0)      # poop royal over the upper cabin

    def at(x, z, ds=0.0):
        return Vector((x, Y(s_aft(z) + ds), z))

    def cornice(name, z, h, proj, n_brackets=0, mat=None):
        w = W_aft(z)
        s = s_aft(z)
        box(name, (0, Y(s - proj / 2 + 0.03), z), (2 * w + 0.2, proj, h), mat or M["carved"])
        box(name + "_lip", (0, Y(s - proj + 0.03), z + h / 2 - 0.04), (2 * w + 0.28, 0.1, 0.1), M["gold"])
        if n_brackets:
            for x in frange(-w + 0.2, w - 0.2, (2 * w - 0.4) / (n_brackets - 1)):
                box(name + "_bracket", (x, Y(s - proj * 0.45), z - h / 2 - 0.2), (0.14, proj * 0.8, 0.4), M["carved"])
                sphere(name + "_bracket_head", (x, Y(s - proj * 0.85), z - h / 2 - 0.3), 0.11, M["carved"], seg=8)

    def windows(name, zc, h, n, wfrac, ww):
        w = W_aft(zc)
        for x in frange(-w * wfrac, w * wfrac, 2 * w * wfrac / (n - 1)):
            p = at(x, zc, -0.02)
            up = (0, -0.08, 1)
            panel(name, p, (1, 0, 0), up, ww, h, M["window"], 0.03)
            for dz in (-h / 2 - 0.03, h / 2 + 0.03):
                panel(name + "_frame", p + Vector((0, -0.02, dz)), (1, 0, 0), up, ww + 0.16, 0.09, M["dark"], 0.06)
            for dx in (-ww / 2 - 0.04, 0.0, ww / 2 + 0.04):
                panel(name + "_frame", p + Vector((dx, -0.02, 0)), (1, 0, 0), up, 0.08 if dx else 0.04, h + 0.1, M["dark"], 0.06)
            panel(name + "_bar", p + Vector((0, -0.025, 0)), (1, 0, 0), up, ww, 0.035, M["dark"], 0.05)

    # tuck: stern chasers either side of the post; counter: upper gundeck
    # ports, the helm port, mouldings
    z = D_LGD + 0.75 + sheer(-0.3)
    for x in (-1.6, 1.6):
        panel("stern_port", at(x, z, -0.03), (1, 0, 0), (0, -0.19, 1), 0.66, 0.62, M["oak"], 0.07)
    z = D_UGD + 0.75 + sheer(-1.0)
    for x in (-1.75, 1.75):
        panel("stern_port", at(x, z, -0.04), (1, 0, 0), (0, -0.45, 1), 0.62, 0.55, M["oak"], 0.07)
    box("helm_port", (0, Y(s_aft(Z_WT + 0.35) - 0.03), Z_WT + 0.35), (0.9, 0.08, 0.5), M["hold"])
    for z in (Z_WT, Z_WT + 1.2, Z_CTR - 0.15):
        w = W_aft(z)
        rod("counter_moulding", [at(x, z, -0.05) for x in frange(-w, w, w / 5)], 0.08, M["dark"], seg=6)

    # cornice over the counter: the floor of the great cabin's gallery
    cornice("stern_cornice", zq - 0.12, 0.3, 1.05, n_brackets=11)
    sg = s_aft(zq)
    w1 = W_aft(zq) - 0.05
    xs = frange(-w1 + 0.15, w1 - 0.15, (2 * w1 - 0.3) / 8)
    for x in xs:                      # standing figures carry the roof
        box("gallery_plinth", (x, Y(sg - 0.88), zq + 0.08), (0.42, 0.42, 0.16), M["carved"])
        figure("gallery_figure", (x, Y(sg - 0.88), zq + 0.16), (zp - 0.32) - (zq + 0.16) - 0.16, math.pi, girth=1.3)
        box("gallery_capital", (x, Y(sg - 0.88), zp - 0.4), (0.46, 0.46, 0.16), M["carved"])
    for a, b in zip(xs[:-1], xs[1:]):  # low balustrade between them
        baluster_row("gallery_balustrade", (a + 0.25, Y(sg - 0.9), zq + 0.03), (b - 0.25, Y(sg - 0.9), zq + 0.03),
                     0.6, M["oak_z"], M["dark"], gap=0.22)
    windows("stern_window", zq + 1.05, 0.95, 5, 0.7, 0.55)
    cornice("stern_cornice", zp - 0.18, 0.3, 1.15, n_brackets=9)

    # upper gallery: an arcade standing out from the upper cabin's windows
    za, zb = zp + 0.05, zr0 - 0.45
    w2 = W_aft(za) - 0.08
    box("arcade_floor", (0, Y(s_aft(za) - 0.36), za - 0.05), (2 * w2, 0.75, 0.12), M["carved"])
    xs = frange(-w2, w2, 2 * w2 / 6)
    sa = s_aft(za) - 0.7
    for x in xs:
        carved_post("arcade_pillar", (x, Y(sa), za), (x, Y(sa), zb - 0.35), 0.075, M["carved"], knobs=3)
    for a, b in zip(xs[:-1], xs[1:]):
        r = (b - a) / 2
        arc = [Vector(((a + b) / 2 - r * math.cos(math.pi * k / 8), Y(sa), zb - 0.35 + r * 0.75 * math.sin(math.pi * k / 8))) for k in range(9)]
        rod("arcade_arch", arc, 0.07, M["carved"], seg=6)
        baluster_row("arcade_balustrade", (a + 0.1, Y(sa), za), (b - 0.1, Y(sa), za), 0.55, M["oak_z"], M["dark"], gap=0.2)
    box("arcade_head", (0, Y(sa + 0.02), zb + 0.1), (2 * w2 + 0.1, 0.2, 0.5), M["carved"])
    windows("upper_window", zp + 0.95, 0.75, 5, 0.66, 0.48)
    cornice("stern_cornice", zr0 - 0.2, 0.26, 0.6)

    # the arms: our emblem in a carved oval frame, a supporter either side
    zc = (zr0 + zt) / 2 + 0.05
    sc = s_aft(zc)
    ell = []
    for k in range(25):
        a = 2 * math.pi * k / 24
        ell.append((1.05 * math.cos(a), zc + 0.68 * math.sin(a)))
    plate_y("arms_field", ell, sc - 0.06, 0.08, M["red_z"])
    rod("arms_frame", [Vector((x, Y(sc - 0.11), z)) for x, z in ell], 0.08, M["gold"], seg=6)
    rr = 0.5
    ring = [Vector((rr * math.cos(2 * math.pi * k / 32), Y(sc - 0.13), zc + 0.05 + rr * math.sin(2 * math.pi * k / 32))) for k in range(33)]
    rod("emblem_ring", ring, 0.045, M["gold"], seg=6)
    star = []
    for k in range(16):
        a = math.pi / 2 + 2 * math.pi * k / 16
        r = rr * (0.86 if k % 4 == 0 else 0.55 if k % 2 == 0 else 0.24)
        star.append((r * math.cos(a), zc + 0.05 + r * math.sin(a)))
    plate_y("emblem_star", star, sc - 0.15, 0.06, M["gold"])
    wave = [Vector((rr * (-1 + 2 * k / 12), Y(sc - 0.15), zc + 0.05 - rr - 0.1 + 0.06 * math.sin(k * math.pi / 3))) for k in range(13)]
    rod("emblem_wave", wave, 0.04, M["gold"], seg=6)
    for k in range(5):                 # a coronet over the frame
        a = math.pi * (0.25 + 0.125 * k)
        sphere("arms_coronet", (0.6 * math.cos(a) * 1.2, Y(sc - 0.12), zc + 0.68 + 0.18 * math.sin(a)), 0.08, M["gold"], seg=6)
    for sx in (-1, 1):
        x = sx * 1.55
        figure("arms_supporter", (x, Y(s_aft(zr0) - 0.35), zr0 + 0.02), zt - zr0 - 0.12, math.pi - sx * 0.35)

    # crest over the top: an arched board with a little arcade, a carved crown
    pts = []
    wt = W_aft(zt) + 0.05
    for k in range(17):
        a = -1 + 2 * k / 16
        pts.append((a * wt, zt + 0.02 + 1.0 * math.cos(0.5 * math.pi * a) ** 0.8))
    pts += [(wt, zt - 0.12), (-wt, zt - 0.12)]
    plate_y("stern_crest", pts, s_aft(zt) + 0.02, 0.2, M["carved"])
    rod("stern_crest_trim", [Vector((x, Y(s_aft(zt) - 0.09), z)) for x, z in pts[:17]], 0.06, M["gold"], seg=6)
    xs = frange(-wt * 0.7, wt * 0.7, wt * 1.4 / 5)
    for a, b in zip(xs[:-1], xs[1:]):
        r = (b - a) / 2
        arc = [Vector(((a + b) / 2 - r * math.cos(math.pi * k / 6), Y(s_aft(zt) - 0.1), zt + 0.12 + r * math.sin(math.pi * k / 6))) for k in range(7)]
        rod("crest_arcade", arc, 0.04, M["carved"], seg=5)
    sphere("crest_crown", (0, Y(s_aft(zt)), zt + 1.15), 0.28, M["gold"], seg=10, scale=(1.3, 0.6, 1))

    # tall carved posts at the corners of the stern
    for sx in (-1, 1):
        zs = frange(zq - 0.1, zt + 1.3, 0.5)
        pts = [Vector((sx * (W_aft(min(z, zt)) + 0.06), Y(s_aft(min(z, zt)) - 0.12), z)) for z in zs]
        rod("corner_post", pts, 0.13, M["carved"], seg=8)
        for p in pts[1:-1:2]:
            sphere("corner_post_knop", p, 0.2, M["carved"], seg=8, scale=(1, 1, 0.7))
        sphere("corner_finial", pts[-1] + Vector((0, 0, 0.25)), 0.26, M["gold"], seg=10, scale=(1, 1, 1.4))

    # lanterns over the crest: the middle one larger
    for x, z, r in LANTERNS:
        s = s_aft(zt) - 0.75
        cyl("lantern_bracket", (x, Y(s_aft(zt) + 0.05), z - 0.6), (x, Y(s), z - 0.15), 0.06, M["iron"], seg=6)
        cyl("lantern_base", (x, Y(s), z - 0.28), (x, Y(s), z), r * 0.45, M["gold"], seg=10, r2=r * 1.05)
        cyl("lantern_glass", (x, Y(s), z), (x, Y(s), z + r * 2.4), r, M["lantern"], seg=8, r2=r * 1.15)
        for k in range(8):
            a = 2 * math.pi * (k + 0.5) / 8
            p0 = Vector((x + r * 1.01 * math.cos(a), Y(s) + r * 1.01 * math.sin(a), z))
            p1 = Vector((x + r * 1.17 * math.cos(a), Y(s) + r * 1.17 * math.sin(a), z + r * 2.4))
            cyl("lantern_frame", p0, p1, 0.022, M["iron"], seg=4)
        cyl("lantern_roof", (x, Y(s), z + r * 2.4), (x, Y(s), z + r * 3.5), r * 1.3, M["gold"], seg=10, r2=0.02)
        sphere("lantern_finial", (x, Y(s), z + r * 3.6), r * 0.22, M["gold"], seg=8)

    # quarter galleries: a round bay of two tiers on each quarter (one built,
    # mirrored), a fluted bulb below, a fluted dome above
    sc_, rs, rx = 0.15, 2.25, 1.15
    z_d0, z_lo, z_hi, z_top = zq - 1.9, zq - 0.1, zr0 - 0.2, zr0 + 1.05
    NP = 41

    def ring(z, f, flute):
        out = []
        for k in range(NP):
            ph = -0.5 * math.pi + math.pi * k / (NP - 1)
            s = sc_ + rs * math.sin(ph) * (0.8 + 0.2 * min(f, 1.0))
            rib = 1 + flute * (abs(math.cos(8 * ph)) ** 0.5 - 0.6)
            x = half_breadth(s, z) - 0.06 + rx * math.cos(ph) * f * rib
            out.append((x, Y(s), z))
        return out

    rows = []
    for k in range(9):                                 # the fluted bulb under it
        t_ = k / 8
        rows.append(ring(lerp(z_d0, z_lo, t_), math.sin(0.5 * math.pi * t_) ** 0.7, 0.14))
    rows.append(ring(z_lo + 0.1, 1.0, 0.03))           # lower tier
    rows.append(ring(zp - 0.35, 1.0, 0.03))
    for k in range(7):                                 # a fluted hood over it
        t_ = k / 6
        rows.append(ring(lerp(zp - 0.3, zp + 0.3, t_), 1.0 + 0.2 * math.sin(math.pi * t_) - 0.12 * t_, 0.14))
    rows.append(ring(zp + 0.36, 0.88, 0.03))           # upper tier, smaller
    rows.append(ring(z_hi, 0.88, 0.03))
    for k in range(1, 9):                              # the fluted dome
        t_ = k / 8
        rows.append(ring(lerp(z_hi, z_top, t_), max(0.02, 0.92 * math.cos(0.5 * math.pi * t_) ** 0.7), 0.14))
    bm = bmesh.new()
    vrows = [[bm.verts.new(p) for p in r] for r in rows]
    for a, b in zip(vrows[:-1], vrows[1:]):
        for k in range(NP - 1):
            bm.faces.new([a[k], a[k + 1], b[k + 1], b[k]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if sum(f.normal.x for f in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    ob = new_obj("quarter_gallery", bm, M["stern"], smooth_shade=True, side=True)
    ob.data.set_sharp_from_angle(angle=math.radians(55))
    top = rows[-1][NP // 2]
    sphere("quarter_gallery_finial", (top[0], top[1], top[2] + 0.15), 0.16, M["gold"], seg=8, scale=(1, 1, 1.5), side=True)
    for z, f in ((z_lo + 0.1, 1.0), (zp - 0.33, 1.0), (zp + 0.38, 0.88), (z_hi - 0.02, 0.88)):
        r = ring(z, f, 0.0)
        rod("quarter_gallery_band", [Vector((p[0] + 0.03, p[1], p[2])) for p in r[3:-3]], 0.055, M["gold"], seg=6, side=True)
    for zc_, h, f in ((zq + 0.9, 0.95, 1.0), (zp + 0.95, 0.8, 0.88)):
        r = ring(zc_, f, 0.0)
        for k in (12, 20, 28):
            p, q = Vector(r[k - 2]), Vector(r[k + 2])
            c = Vector(r[k]) + Vector((0.03, 0, 0))
            d = (q - p).normalized()
            panel("quarter_window", c, d, (0, 0, 1), 0.45, h, M["window"], 0.03, side=True)
            panel("quarter_window_frame", c + Vector((0.01, 0, 0)), d, (0, 0, 1), 0.55, 0.06, M["dark"], 0.05, side=True)
            panel("quarter_window_frame", c + Vector((0.01, 0, 0)), d, (0, 0, 1), 0.05, h + 0.06, M["dark"], 0.05, side=True)
        for k in (8, 16, 24, 32):
            p = Vector(r[k]) + Vector((0.05, 0, 0))
            cyl("quarter_gallery_rib", p - Vector((0, 0, h / 2 + 0.1)), p + Vector((0, 0, h / 2 + 0.1)), 0.06, M["carved"], seg=6, side=True)


# ------------------------------------------------------------------ the sides above the decks
def build_upper_works():
    """Open rails on the castles' sides (turned balusters on the half deck
    and forecastle, posts and rails on the poop and poop royal, as on the
    scan), carved brackets on the waist between the upper ports."""
    def side_x(s, z):
        return half_breadth(s, z) - 0.1

    def run(s0, s1, kind):
        ss = frange(s0, s1, {"baluster": 0.3, "timber": 0.55}.get(kind, 0.85))
        top = []
        for s in ss:
            zt = rail_top(s) + 0.07
            x = side_x(s, zt)
            if kind == "timber":
                box("side_timber", (x, Y(s), zt + 0.5), (0.15, 0.15, 1.0), M["carved"], side=True)
                sphere("side_timber_head", (x + 0.05, Y(s), zt + 0.86), 0.11, M["carved"], seg=8, side=True)
            elif kind == "baluster":
                cyl("side_baluster", (x, Y(s), zt), (x, Y(s), zt + 0.78), 0.035, M["oak_z"], seg=6, side=True)
                sphere("side_baluster_knop", (x, Y(s), zt + 0.4), 0.06, M["oak_z"], seg=6, side=True)
            else:
                box("side_post", (x, Y(s), zt + 0.42), (0.12, 0.12, 0.84), M["dark_z"], side=True)
            top.append(Vector((x, Y(s), zt + 0.86)))
        rod("side_rail", top, 0.06, M["dark"], seg=6, side=True)
        if kind != "baluster":
            rod("side_rail_mid", [p - Vector((0, 0, 0.42)) for p in top], 0.04, M["dark"], seg=5, side=True)

    run(s_aft(rail_top(-1.0)) + 0.55, BRK_ROYAL - 0.1, "post")
    run(BRK_ROYAL + 0.1, BRK_POOP - 0.1, "post")
    run(BRK_POOP + 0.15, BRK_QD - 0.15, "timber")
    run(BRK_FC + 0.15, s_fwd(rail_top(49.0)) - 0.6, "timber")
    # carved brackets up the waist's high side, between the upper ports
    for k in range(12):
        s = 9.0 + k * 2.95 + 1.475
        if not (BRK_QD + 0.4 < s < BRK_FC - 0.4):
            continue
        z0 = WALES[-1][0] + sheer(s) + 0.16
        z1 = rail_top(s) - 0.05
        p, n, ts, tz = hull_frame(s, (z0 + z1) / 2)
        panel("waist_bracket", p + n * 0.1, ts, tz, 0.2, z1 - z0, M["carved"], 0.2, side=True)
        sphere("waist_bracket_head", p + n * 0.22 + tz * ((z1 - z0) / 2 - 0.15), 0.12, M["carved"], seg=8, side=True)
        sphere("waist_bracket_scroll", p + n * 0.2 - tz * ((z1 - z0) / 2 - 0.12), 0.1, M["carved"], seg=8, side=True)


# ------------------------------------------------------------------ head
def build_head():
    zh = Z_STEMHEAD
    zs = frange(-1.6, zh - 0.1, 0.4)
    prof = [(s_fwd(z) + 0.2, z) for z in zs]
    prof += [(53.8, zh - 0.12), (56.4, zh - 0.25), (57.2, zh - 0.7), (56.7, zh - 1.6), (55.0, zh - 2.7), (53.0, zh - 4.0),
             (51.4, -0.5), (s_fwd(-1.6) + 0.4, -1.75)]
    extrude_x("head_knee", prof, -0.2, 0.2, M["dark"])
    for sgn in (1,):
        up = curve_pts((half_breadth(47.0, 6.4) + 0.05, Y(47.0), 6.4), (2.4, Y(52.4), 5.5), (0.3, Y(56.3), 5.5), 12)
        lo = curve_pts((half_breadth(48.0, 4.7) + 0.05, Y(48.0), 4.7), (1.8, Y(52.2), 4.0), (0.28, Y(55.9), 4.4), 12)
        rod("head_rail", up, 0.1, M["red"], seg=8, side=True)
        rod("head_rail", lo, 0.09, M["red"], seg=8, side=True)
        for k in (3, 6, 9):
            cyl("head_timber", lo[k], up[k], 0.07, M["carved"], seg=6, side=True)
        for k in (2, 5, 8):           # small figures on the head rails, as on Vasa's beak
            p = up[k]
            figure("head_figure", (p.x - 0.05, p.y, p.z + 0.05), 0.85, -0.5 * math.pi + 0.3, side=True)
        sc, zc = 46.6, D_FC + sheer(46.6) + 0.45
        p0 = Vector((half_breadth(sc, zc) - 0.3, Y(sc - 0.4), zc))
        p1 = Vector((half_breadth(sc, zc) + 1.5, Y(sc + 0.8), zc + 0.15))
        cyl("cathead", p0, p1, 0.17, M["dark"], seg=8, side=True)
        sphere("cathead_end", p1 + Vector((0.12, 0.08, 0)), 0.2, M["gold"], seg=8, side=True)
        xa = half_breadth(46.0, 3.8) + 0.55
        top, crown = Vector((xa, Y(46.3), zc - 0.4)), Vector((xa, Y(46.3), zc - 4.3))
        cyl("anchor_shank", top, crown, 0.11, M["iron"], seg=8, side=True)
        box("anchor_stock", (xa, Y(46.3), top.z - 0.25), (0.22, 3.2, 0.22), M["dark"], side=True)
        for d in (-1, 1):
            tip = Vector((xa + 0.12, Y(46.3 + d * 1.25), crown.z + 1.15))
            cyl("anchor_arm", crown, tip, 0.1, M["iron"], seg=8, side=True)
            panel("anchor_fluke", tip + Vector((0.0, -d * 0.12, -0.2)), (0, d, 0.45), (0, -0.45, 1), 0.55, 0.6, M["iron"], 0.05, side=True)
        cyl("anchor_ring", top + Vector((0, 0, 0.1)), top + Vector((0, 0, 0.45)), 0.16, M["iron"], seg=8, cap=False, side=True)
        rod("anchor_cable", [p1 + Vector((0, 0, -0.1)), top + Vector((0, 0, 0.4))], 0.045, M["rope"], seg=5, side=True)
    # beakhead grating between the rails
    bm = bmesh.new()
    zg = zh + 0.08
    prev = None
    for s in frange(s_fwd(zg) - 0.05, 55.4, 0.35):
        w = lerp(2.1, 0.35, (s - 51.0) / 4.4)
        cur = [bm.verts.new((lerp(-w, w, k / 4), Y(s), zg)) for k in range(5)]
        if prev:
            for k in range(4):
                bm.faces.new([prev[k], prev[k + 1], cur[k + 1], cur[k]])
        prev = cur
    new_obj("beak_grating", bm, M["grating"])
    build_lion((0.0, 56.9, zh - 0.15))
    for x in (-0.6, 0.6):           # knightheads either side of the bowsprit
        box("knighthead", (x, Y(50.3), D_FC + sheer(50.3) + 1.2), (0.3, 0.35, 2.5), M["carved"])
    box("bowsprit_bitts", (0, Y(39.4), D_FC + sheer(39.4) + 0.55), (1.6, 0.35, 0.3), M["oak_x"])
    for x in (-0.65, 0.65):
        box("bowsprit_bitt", (x, Y(39.4), D_FC + sheer(39.4) + 0.45), (0.3, 0.3, 1.0), M["oak_z"])
    # figures on the beakhead bulkhead, between its doors
    zb = Z_STEMHEAD + 0.1
    for x in (-1.6, -0.55, 0.55, 1.6):
        figure("bulkhead_figure", (x, Y(s_fwd(zb + 1) + 0.25), zb), 1.25, 0.0)


def build_lion(base):
    """The figurehead, a leaping lion 3.2 m long, modelled in metaballs so the
    body, mane and limbs run into one another like carving."""
    bx, bs, bz = base
    mb = bpy.data.metaballs.new("lion")
    mb.resolution = 0.07
    mb.threshold = 0.6

    def el(s, z, r, kind="BALL", size=(1, 1, 1), rot=None, x=0.0):
        e = mb.elements.new()
        e.type = kind
        e.co = (bx + x, Y(bs + s), bz + z)
        e.radius = r
        if kind != "BALL":
            e.size_x, e.size_y, e.size_z = size
        if rot is not None:
            e.rotation = rot.to_quaternion()
        return e

    up = Matrix.Rotation(math.radians(28), 3, "X")
    el(-0.9, 0.95, 0.75, "ELLIPSOID", (0.55, 1.15, 0.6), up)          # body, rising forward
    el(0.15, 1.45, 0.7, "ELLIPSOID", (0.8, 0.75, 0.85))               # chest under the mane
    el(0.45, 1.95, 0.72, "ELLIPSOID", (1.05, 0.8, 1.05))              # mane
    el(0.85, 2.05, 0.46, "ELLIPSOID", (0.85, 1.0, 0.9))               # head
    el(1.2, 1.88, 0.26, "ELLIPSOID", (0.8, 1.1, 0.7))                 # muzzle
    for sx in (-1, 1):
        el(0.95, 1.1, 0.22, "CAPSULE", (0.55, 1, 1), Matrix.Rotation(math.radians(55), 3, "Y") @ Matrix.Rotation(math.radians(-60), 3, "X"), x=sx * 0.3)
        el(1.25, 0.65, 0.2, x=sx * 0.32)                                 # forepaws, reaching
        el(-1.5, 0.45, 0.24, "CAPSULE", (0.45, 1, 1), Matrix.Rotation(math.radians(80), 3, "Y"), x=sx * 0.32)
        el(-1.25, 0.1, 0.19, x=sx * 0.34)                                # hind paws on the knee
        el(0.75, 2.45, 0.13, x=sx * 0.28)                                # ears
    for k in range(6):                                                   # tail curling up
        a = k / 5
        el(-1.75 - 0.25 * math.sin(a * 2), 0.9 + a * 1.1, 0.1 - 0.008 * k)
    ob = bpy.data.objects.new("lion_mb", mb)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True)
    bm = bmesh.new()
    bm.from_mesh(me)
    print("lion", len(bm.faces), "faces")
    new_obj("lion", bm, M["gold"], smooth_shade=True)


# ------------------------------------------------------------------ deck fittings
def build_deck_fittings():
    zu = lambda s: D_UGD + sheer(s)  # noqa: E731
    # capstan in the waist, abaft the mainmast
    s = 26.2
    z = zu(s)
    cyl("capstan_barrel", (0, Y(s), z), (0, Y(s), z + 0.95), 0.36, M["oak_z"], seg=12, r2=0.3)
    cyl("capstan_head", (0, Y(s), z + 0.95), (0, Y(s), z + 1.25), 0.6, M["dark"], seg=14)
    for k in range(8):
        a = 2 * math.pi * k / 8
        box("capstan_whelp", (0.36 * math.cos(a), Y(s) + 0.36 * math.sin(a), z + 0.45), (0.12, 0.12, 0.8), M["oak_z"])
    # hatches with gratings
    for s0, s1, hw in ((28.8, 31.4, 1.25), (33.6, 35.2, 0.85), (13.2, 14.6, 0.75)):
        zz = (D_QD if s1 < BRK_QD else D_UGD) + sheer((s0 + s1) / 2)
        box("hatch_hold", (0, Y((s0 + s1) / 2), zz - 0.5), (2 * hw - 0.1, s1 - s0 - 0.1, 1.0), M["hold"])
        for x0, x1, a0, a1 in ((-hw, hw, s0, s0 + 0.18), (-hw, hw, s1 - 0.18, s1), (-hw, -hw + 0.18, s0, s1), (hw - 0.18, hw, s0, s1)):
            box("hatch_coaming", ((x0 + x1) / 2, Y((a0 + a1) / 2), zz + 0.17), (x1 - x0, a1 - a0, 0.34), M["dark"])
        for x in frange(-hw + 0.25, hw - 0.25, 0.17):
            box("hatch_grating", (x, Y((s0 + s1) / 2), zz + 0.3), (0.06, s1 - s0 - 0.36, 0.05), M["grating"])
        for a in frange(s0 + 0.25, s1 - 0.25, 0.17):
            box("hatch_grating", (0, Y(a), zz + 0.33), (2 * hw - 0.36, 0.06, 0.03), M["grating"])
    # belfry at the forecastle break
    s, z = BRK_FC + 0.6, D_FC + sheer(BRK_FC)
    for x in (-0.45, 0.45):
        box("belfry_post", (x, Y(s), z + 0.7), (0.14, 0.14, 1.4), M["carved"])
    box("belfry_roof", (0, Y(s), z + 1.48), (1.2, 0.5, 0.16), M["dark"])
    cyl("bell", (0, Y(s), z + 1.4), (0, Y(s), z + 0.95), 0.08, M["gold"], seg=10, r2=0.22)
    # pin rails and cleats by the masts
    for name, mast in MASTS.items():
        sm = mast["s"]
        zd = deck_level(sm)
        for ds in (-0.9, 0.9):
            box("fife_rail", (0, Y(sm + ds), zd + 0.75), (1.9, 0.14, 0.12), M["oak_x"])
            for x in (-0.85, 0.85):
                box("fife_post", (x, Y(sm + ds), zd + 0.38), (0.14, 0.14, 0.76), M["oak_z"])


# ------------------------------------------------------------------ spars
YARDS = []      # separate nodes, braced by the game


def mast_r(m, z):
    """Lower mast radius at height z (tapering above the deck)."""
    return lerp(m["r0"], m["r0"] * 0.72, clamp((z - deck_level(m["s"])) / (m["head"] - deck_level(m["s"]))))


def make_yard(name, center, length, r, rot=None):
    """A yard as its own object, origin at its middle: two tapering halves,
    cleats at the slings and yardarms."""
    bm = bmesh.new()
    for sgn in (-1, 1):
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=r, radius2=r * 0.38, depth=length / 2)
        half = Matrix.Rotation(sgn * math.pi / 2, 4, "Y")
        bmesh.ops.transform(bm, matrix=Matrix.Translation((sgn * length / 4, 0, 0)) @ half, verts=res["verts"])
    for sgn in (-1, 1):
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=r * 1.25, radius2=r * 1.25, depth=0.25)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((sgn * r * 1.6, 0, 0)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), verts=res["verts"])
    if rot is not None:
        bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    for f in bm.faces:
        f.smooth = len(f.verts) == 4
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M["spar"])
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    bpy.context.scene.collection.objects.link(ob)
    YARDS.append(ob)
    return ob


RIG = {"masts": {}, "sails": [], "sprit": {}, "stays": []}


def g(v):
    """Blender (x, y, z) -> glTF/three (x, z, -y)."""
    return [round(v[0], 3), round(v[2], 3), round(-v[1], 3)]


def build_spars():
    for name, m in MASTS.items():
        s = m["s"]
        z0 = deck_level(s) - 0.3
        cyl(f"mast_{name}", (0, Y(s), z0), (0, Y(s), m["head"]), m["r0"], M["spar"], seg=16, r2=m["r0"] * 0.72)
        for z in frange(z0 + 2.2, m["top"] - 1.5, 1.1):          # wooldings
            cyl("woolding", (0, Y(s), z), (0, Y(s), z + 0.16), mast_r(m, z) + 0.035, M["rope"], seg=16, cap=False)
        # the top: trestle- and crosstrees, platform, rim
        tz = m["top"]
        for dx in (-0.45, 0.45):
            box("trestletree", (dx, Y(s + 0.25), tz - 0.22), (0.2, 2.6 * m["rtop"] / 1.95, 0.3), M["dark"])
        for ds in (-0.8, 0.0, 0.8):
            box("crosstree", (0, Y(s + 0.25 + ds), tz - 0.12), (2 * m["rtop"] - 0.2, 0.18, 0.18), M["dark"])
        cyl("top_platform", (0, Y(s + 0.25), tz), (0, Y(s + 0.25), tz + 0.14), m["rtop"], M["oak_x"], seg=28)
        tube("top_rim", (0, Y(s + 0.25), tz + 0.1), m["rtop"], 0.55, 0.07, M["stern"])
        cyl("top_rim_band", (0, Y(s + 0.25), tz + 0.6), (0, Y(s + 0.25), tz + 0.7), m["rtop"] + 0.03, M["gold"], seg=28, cap=False)
        # topmast, forward of the lower masthead, held by the cap
        rt = m["r0"] * 0.55
        st = s + m["r0"] * 0.72 + rt + 0.12
        cyl("mast_cap", (0, Y((s + st) / 2), m["head"] - 0.05), (0, Y((s + st) / 2), m["head"] + 0.4), 0.1, M["dark"], seg=4)
        box("mast_cap", (0, Y((s + st) / 2), m["head"] + 0.18), (rt * 2.6, st - s + 1.1, 0.42), M["dark"])
        cyl(f"topmast_{name}", (0, Y(st), tz - 0.2), (0, Y(st), m["tm"]), rt, M["spar"], seg=12, r2=rt * 0.6)
        mast = {"x": 0.0, "z": round(-Y(s), 3), "deck": round(deck_level(s), 3), "yards": []}
        if m["ct"]:
            ct = m["ct"]
            for dx in (-0.22, 0.22):
                box("tm_trestle", (dx, Y(st), ct), (0.12, 1.0, 0.16), M["dark"])
            box("tm_crosstree", (0, Y(st - 0.15), ct + 0.08), (2.4, 0.12, 0.12), M["dark"])
            box("tm_crosstree", (0, Y(st + 0.25), ct + 0.08), (2.4, 0.12, 0.12), M["dark"])
            rg = rt * 0.5
            sg = st + rt * 0.6 + rg + 0.08
            box("tm_cap", (0, Y((st + sg) / 2), m["tm"] - 0.1), (rg * 2.6, sg - st + 0.6, 0.3), M["dark"])
            cyl(f"topgallant_{name}", (0, Y(sg), ct - 0.1), (0, Y(sg), m["tg"]), rg, M["spar"], seg=10, r2=0.07)
            sphere("truck", (0, Y(sg), m["tg"] + 0.05), 0.12, M["dark"], seg=8)
            mast["tg"] = {"s": sg, "head": m["tg"]}
        mast["tm"] = {"s": st, "head": m["tm"]}
        RIG["masts"][name] = mast
        m["st"] = st
        m["sg"] = st + rt * 0.6 + rt * 0.5 + 0.08 if m["ct"] else None

    # yards (hoisted) and their sails: (mast, yard height, length, radius,
    # which spar it crosses); sails from the yard to the yard below or to the
    # clews over the deck
    def yard(mast, idx, z, length, r, spar_s, sail=None):
        sy = spar_s + 0.32 + r
        nm = f"yard_{mast}_{idx}"
        make_yard(nm, (0, Y(sy), z), length, r)
        y = {"node": nm, "y": round(z, 3), "fwd": round(sy - MASTS[mast]["s"], 3), "len": length, "r": r}
        RIG["masts"][mast]["yards"].append(y)
        return y

    mm, mf, mz = MASTS["main"], MASTS["fore"], MASTS["mizzen"]
    m0 = yard("main", 0, mm["top"] - 0.75, 25.0, 0.29, mm["s"])
    m1 = yard("main", 1, mm["ct"] - 0.9, 14.6, 0.2, mm["st"])
    m2 = yard("main", 2, mm["tg"] - 5.2, 7.4, 0.11, mm["sg"])
    f0 = yard("fore", 0, mf["top"] - 0.7, 21.5, 0.26, mf["s"])
    f1 = yard("fore", 1, mf["ct"] - 0.85, 12.4, 0.18, mf["st"])
    f2 = yard("fore", 2, mf["tg"] - 4.6, 6.4, 0.1, mf["sg"])
    z1 = yard("mizzen", 1, mz["top"] - 0.6, 11.5, 0.15, mz["s"])          # crossjack: sheets the topsail
    z2 = yard("mizzen", 2, mz["tm"] - 2.6, 7.0, 0.11, mz["st"])

    def sq(name, mast, head, foot, foot_y=None, foot_w=None, emblem=False):
        sail = {"name": name, "mast": mast, "type": "square", "emblem": emblem,
                "head": {"y": round(head["y"] - head["r"] - 0.05, 3), "w": round(head["len"] * 0.94, 3), "fwd": round(head["fwd"] + 0.08, 3)}}
        if foot is not None:
            sail["foot"] = {"y": round(foot["y"] + foot["r"] + 0.05, 3), "w": round(foot["len"] * 0.94, 3), "fwd": round(foot["fwd"] + 0.08, 3)}
        else:
            sail["foot"] = {"y": round(foot_y, 3), "w": round(foot_w, 3), "fwd": round(head["fwd"] + 0.3, 3)}
        RIG["sails"].append(sail)

    sq("main_course", "main", m0, None, foot_y=deck_level(mm["s"]) + 3.6, foot_w=23.0, emblem=True)
    sq("main_topsail", "main", m1, m0, emblem=True)
    sq("main_topgallant", "main", m2, m1)
    sq("fore_course", "fore", f0, None, foot_y=deck_level(mf["s"]) + 3.2, foot_w=19.5, emblem=True)
    sq("fore_topsail", "fore", f1, f0, emblem=True)
    sq("fore_topgallant", "fore", f2, f1)
    sq("mizzen_topsail", "mizzen", z2, z1)

    # mizzen lateen yard, slung forward of the mast, peak aft
    a = math.radians(38)
    L = 19.0
    sl = mz["s"] + 0.25 + mz["r0"]
    zl = 14.8
    dvec = Vector((0, -math.cos(a), math.sin(a)))       # aft and up
    # built along X, turned into the centre plane: aft and up at 38 deg
    make_yard("yard_mizzen_0", (0, Y(sl), zl), L, 0.2,
              rot=Matrix.Rotation(-a, 4, "X") @ Matrix.Rotation(-math.pi / 2, 4, "Z"))
    RIG["masts"]["mizzen"]["yards"].insert(0, {"node": "yard_mizzen_0", "y": zl, "fwd": round(sl - mz["s"], 3), "len": L, "r": 0.2, "lateen": True})
    # the yard object is centred on the mast; its ends:
    tack = Vector((0, Y(sl), zl)) - dvec * (L / 2)
    peak = Vector((0, Y(sl), zl)) + dvec * (L / 2)
    clew = Vector((0, Y(-1.6), ZTOP[0] + 0.6))
    RIG["sails"].append({"name": "mizzen", "mast": "mizzen", "type": "lateen", "tack": g(tack + Vector((0, 0, -0.25))),
                         "peak": g(peak + Vector((0, 0, -0.2))), "clew": g(clew), "pivot": g(Vector((0, Y(mz["s"]), 0)))})

    # bowsprit with its sprit topmast; spritsail yards hang under it
    heel = Vector((0, Y(42.3), D_UGD + sheer(42.3) + 0.6))
    a = math.radians(24)
    d = Vector((0, math.cos(a), math.sin(a)))
    Lb = 24.0
    tip = heel + d * Lb
    cyl("bowsprit", heel, tip, 0.42, M["spar"], seg=14, r2=0.2)
    for t in (0.4, 0.58, 0.8):
        p = heel + d * (Lb * t)
        cyl("bowsprit_band", p - d * 0.06, p + d * 0.06, 0.4 - 0.14 * t, M["iron"], seg=14, cap=False)
    for k in range(3):          # gammoning: lashed down to the knee of the head
        p = heel + d * (Lb * (0.44 + 0.012 * k))
        cyl("gammoning", p, Vector((0, Y(53.0 + 0.12 * k), 4.6)), 0.04, M["rope"], seg=5)
    st_base = tip - d * 1.2
    cyl("sprit_top", st_base + Vector((0, 0, 0.15)), st_base + Vector((0, 0, 0.3)), 0.65, M["oak_x"], seg=16)
    tube("sprit_top_rim", st_base + Vector((0, 0, 0.25)), 0.65, 0.35, 0.05, M["stern"])
    sprit_tm_top = st_base + Vector((0, 0, 6.5))
    cyl("sprit_topmast", st_base - Vector((0, 0, 0.4)), sprit_tm_top, 0.17, M["spar"], seg=10, r2=0.08)
    p_sy = heel + d * (Lb * 0.75) - Vector((0, 0, 1.0))
    make_yard("yard_sprit_0", tuple(p_sy), 13.0, 0.17)
    p_sty = sprit_tm_top - Vector((0, 0, 0.6)) + Vector((0, 0.3, 0))
    make_yard("yard_sprit_1", tuple(p_sty), 6.2, 0.09)
    RIG["sprit"] = {"heel": g(heel), "tip": g(tip), "topmast": g(sprit_tm_top)}
    RIG["sails"].append({"name": "spritsail", "type": "sprit", "head": g(p_sy - Vector((0, 0, 0.2))), "w": 12.2,
                         "foot": g(p_sy - Vector((0, 2.6, 4.2))), "fw": 11.5})
    RIG["sails"].append({"name": "sprit_topsail", "type": "sprit", "head": g(p_sty - Vector((0, 0, 0.12))), "w": 5.8,
                         "foot": g(st_base + Vector((0, 0.2, 0.9))), "fw": 8.0})
    MASTS["_bowsprit"] = dict(heel=heel, d=d, L=Lb, tip=tip, top=sprit_tm_top, base=st_base)

    # ensign staff on the crest
    zt = ZTOP[0]
    p0 = Vector((0, Y(s_aft(zt) + 0.4), zt - 0.8))
    p1 = Vector((0, Y(s_aft(zt) - 2.2), zt + 6.6))
    cyl("ensign_staff", p0, p1, 0.08, M["spar"], seg=8, r2=0.045)
    RIG["ensign"] = {"base": g(p0.lerp(p1, 0.62)), "tip": g(p1)}
    RIG["pennants"] = [g((0, Y(MASTS[n]["sg"] if MASTS[n]["sg"] else MASTS[n]["st"]), (MASTS[n]["tg"] or MASTS[n]["tm"]) + 0.1)) for n in ("fore", "main", "mizzen")]


# ------------------------------------------------------------------ standing rigging
def build_rigging():
    rope, dead, iron = M["rope"], M["deadeye"], M["iron"]
    zch = {"fore": 5.3, "main": 5.3, "mizzen": 7.9}
    chan = {"fore": (35.6, 42.0, 8), "main": (18.4, 25.4, 9), "mizzen": (5.2, 9.0, 5)}
    for name, m in MASTS.items():
        if name.startswith("_"):
            continue
        s0, s1, n = chan[name]
        # channel (chainwale): a plank standing out from the side
        bm = bmesh.new()
        rings = []
        for s in frange(s0 - 0.3, s1 + 0.3, 0.3):
            z = zch[name] + sheer(s)
            y = half_breadth(s, z)
            rings.append([bm.verts.new(p) for p in ((y - 0.05, Y(s), z - 0.07), (y + 0.82, Y(s), z - 0.07),
                                                    (y + 0.82, Y(s), z + 0.07), (y - 0.05, Y(s), z + 0.07))])
        for a, b in zip(rings[:-1], rings[1:]):
            for k in range(4):
                bm.faces.new([a[k], b[k], b[(k + 1) % 4], a[(k + 1) % 4]])
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        new_obj("channel", bm, M["dark"], side=True)
        head = Vector((0, Y(m["s"]), m["top"] - 0.45))
        shrouds = []
        for k in range(n):
            s = lerp(s0, s1, k / (n - 1))
            z = zch[name] + sheer(s)
            y = half_breadth(s, z) + 0.72
            lo = Vector((y, Y(s), z + 0.42))
            hi = lo + (head - lo).normalized() * 1.05
            dd = (head - lo).normalized()
            for p in (lo, hi):
                cyl("deadeye", p - Vector((0.06, 0, 0)), p + Vector((0.06, 0, 0)), 0.17, dead, seg=10, side=True)
            for dx in (-0.08, 0.0, 0.08):
                cyl("lanyard", lo + Vector((0, dx, 0.1)), hi + Vector((0, dx, -0.1)), 0.018, rope, seg=4, side=True)
            ys, zs = half_breadth(s, z - 1.35) + 0.04, z - 1.35
            cyl("chainplate", lo - Vector((0, 0, 0.15)), Vector((ys, Y(s), zs)), 0.04, iron, seg=5, side=True)
            top = Vector((mast_r(m, head.z) + 0.06, Y(m["s"] + lerp(0.35, -0.45, k / (n - 1))), head.z))
            cyl("shroud", hi + dd * 0.15, top, 0.065, rope, seg=5, side=True)
            shrouds.append((hi + dd * 0.15, top))
        ratlines(shrouds, zch[name] + 2.4, m["top"] - 1.1)
        # futtock shrouds, topmast shrouds with their ratlines, topgallant shrouds
        r_top = m["rtop"]
        tm_head = Vector((0.0, Y(m["st"]), (m["ct"] or m["tm"] - 1.2) - 0.3))
        tshrouds = []
        nt = 4 if name != "mizzen" else 3
        for k in range(nt):
            sa = m["s"] + 0.25 + lerp(0.6, -1.0, k / (nt - 1)) * r_top / 1.95
            xa = math.sqrt(max(0.05, r_top ** 2 - ((sa - m["s"] - 0.25)) ** 2)) - 0.05
            base = Vector((xa, Y(sa), m["top"] + 0.35))
            cyl("deadeye", base - Vector((0.05, 0, 0)), base + Vector((0.05, 0, 0)), 0.12, dead, seg=8, side=True)
            cyl("futtock", base, Vector((mast_r(m, m["top"] - 2.4) + 0.05, Y(m["s"]), m["top"] - 2.4)), 0.035, iron, seg=4, side=True)
            top = Vector((0.24, Y(m["st"] + lerp(0.2, -0.2, k / (nt - 1))), tm_head.z))
            cyl("tm_shroud", base + Vector((0, 0, 0.15)), top, 0.05, rope, seg=5, side=True)
            tshrouds.append((base + Vector((0, 0, 0.15)), top))
        ratlines(tshrouds, m["top"] + 1.0, tm_head.z - 1.0)
        if m["ct"]:
            for k, ds in enumerate((0.25, -0.25)):
                base = Vector((1.15, Y(m["st"] + ds - 0.0), m["ct"] + 0.1))
                cyl("tg_shroud", base, Vector((0.12, Y(m["sg"]), m["tg"] - 4.6)), 0.025, rope, seg=4, side=True)

    # stays, on the centreline, and backstays
    def stay(a, b, r):
        cyl("stay", a, b, r, rope, seg=6)
        RIG["stays"].append([g(a), g(b)])
    mf, mm, mz, bs = MASTS["fore"], MASTS["main"], MASTS["mizzen"], MASTS["_bowsprit"]

    def on_bs(t):
        return bs["heel"] + bs["d"] * (bs["L"] * t)

    stay(Vector((0, Y(mm["s"] + 0.4), mm["top"] - 0.5)), Vector((0, Y(mf["s"] - 0.7), D_FC + sheer(mf["s"]) + 1.0)), 0.09)
    stay(Vector((0, Y(mm["st"] + 0.25), mm["ct"] - 0.35)), Vector((0, Y(mf["s"] - 0.3), mf["top"] + 0.4)), 0.065)
    stay(Vector((0, Y(mm["sg"] + 0.12), mm["tg"] - 4.4)), Vector((0, Y(mf["st"] - 0.1), mf["ct"] + 0.2)), 0.035)
    stay(Vector((0, Y(mf["s"] + 0.4), mf["top"] - 0.5)), on_bs(0.36), 0.085)
    stay(Vector((0, Y(mf["st"] + 0.25), mf["ct"] - 0.35)), on_bs(0.86), 0.06)
    stay(Vector((0, Y(mf["sg"] + 0.12), mf["tg"] - 3.9)), bs["top"] - Vector((0, 0, 0.3)), 0.035)
    stay(Vector((0, Y(mz["s"] + 0.3), mz["top"] - 0.4)), Vector((0, Y(mm["s"] - 0.6), 9.4)), 0.06)
    stay(Vector((0, Y(mz["st"] + 0.2), mz["tm"] - 1.6)), Vector((0, Y(mm["s"]), mm["top"] + 0.4)), 0.04)
    for name, aft in (("fore", (34.0, 34.8)), ("main", (16.8, 17.6)), ("mizzen", (4.2,))):
        m = MASTS[name]
        tz = (m["ct"] or m["tm"] - 1.2) - 0.25
        for s in aft:
            z = zch[name] + sheer(s)
            lo = Vector((half_breadth(s, z) + 0.6, Y(s), z + 0.45))
            cyl("deadeye", lo - Vector((0.06, 0, 0)), lo + Vector((0.06, 0, 0)), 0.15, dead, seg=10, side=True)
            cyl("backstay", lo, Vector((0.2, Y(m["st"]), tz)), 0.04, rope, seg=5, side=True)
            box("backstay_stool", (half_breadth(s, z) + 0.3, Y(s), z), (0.75, 0.5, 0.12), M["dark"], side=True)
    # bobstay and the sprit topmast's backstays
    cyl("bobstay", on_bs(0.45), Vector((0, Y(53.6), 2.4)), 0.06, rope, seg=6)
    for x in (-1.0, 1.0):
        cyl("sprit_backstay", bs["top"] - Vector((0, 0, 0.6)), on_bs(0.55) + Vector((x, 0, 0)), 0.025, rope, seg=4)


def ratlines(shrouds, z0, z1, step=0.42):
    for z in frange(z0, z1, step):
        pts = []
        for a, b in shrouds:
            if not (min(a.z, b.z) < z < max(a.z, b.z)):
                break
            pts.append(a.lerp(b, (z - a.z) / (b.z - a.z)))
        else:
            for p, q in zip(pts[:-1], pts[1:]):
                cyl("ratline", p, q, 0.02, M["rope"], seg=3, side=True)


# ------------------------------------------------------------------ rudder
def build_rudder():
    """Rudder on the sternpost: its own node under a pivot whose local up is
    the hinge line, so the game turns it about that line."""
    zb, zh = Z_KEEL + 0.15, Z_WT + 0.85

    def s_post(z):
        return lerp(1.2, -0.3, (z - Z_RAB) / (Z_WT - Z_RAB)) - 0.4
    pa = Vector((0, Y(s_post(zb)), zb))
    pb = Vector((0, Y(s_post(zh)), zh))
    axis = (pb - pa).normalized()
    pivot = bpy.data.objects.new("rudder_post", None)
    bpy.context.scene.collection.objects.link(pivot)
    ax_x = Vector((1, 0, 0))
    ax_y = axis.cross(ax_x)
    rot = Matrix((ax_x, ax_y, axis)).transposed()
    pivot.matrix_world = Matrix.Translation(pa) @ rot.to_4x4()
    length = (pb - pa).length
    bm = bmesh.new()
    # local frame: z up the hinge, -y aft, x across
    prof = [(0.0, 0.0), (-1.95, 0.0), (-1.95, 0.25), (-1.1, length * 0.62), (-0.55, length * 0.9), (-0.35, length), (0.0, length)]
    bot = [(-(0.22 if yy > -0.6 else 0.14), yy, zz) for yy, zz in prof]
    top = [(0.22 if yy > -0.6 else 0.14, yy, zz) for yy, zz in prof]
    vb = [bm.verts.new(p) for p in bot]
    vt = [bm.verts.new(p) for p in top]
    n = len(prof)
    bm.faces.new(list(reversed(vb)))
    bm.faces.new(vt)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for k in range(5):           # pintle straps
        zz = 0.6 + k * (length - 1.4) / 4
        res = bmesh.ops.create_cube(bm, size=1.0)
        for v in res["verts"]:
            v.co = Vector((v.co.x * 0.5, v.co.y * 0.9 - 0.4, v.co.z * 0.1 + zz))
    me = bpy.data.meshes.new("rudder")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M["dark"])
    rud = bpy.data.objects.new("rudder", me)
    bpy.context.scene.collection.objects.link(rud)
    rud.parent = pivot
    rud.matrix_parent_inverse = Matrix.Identity(4)
    RIG["rudder"] = {"node": "rudder", "max": 23}
    return pivot, rud


# ------------------------------------------------------------------ build
build_hull()
build_wales()
build_ports()
build_decks()
build_stern()
build_upper_works()
build_head()
build_deck_fittings()
build_spars()
build_rigging()
RUDDER_PIVOT, RUDDER = build_rudder()


def mirror(ob):
    me = ob.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o2 = bpy.data.objects.new(ob.name + "_port", me)
    bpy.context.scene.collection.objects.link(o2)
    return o2


for _ob in list(SIDE):
    PARTS.append(mirror(_ob))


def merge(parts, name):
    """Join parts into one object, one material slot per distinct material."""
    dg = bpy.context.evaluated_depsgraph_get()
    mats = []
    bm = bmesh.new()
    for ob in parts:
        mat = ob.data.materials[0]
        if mat not in mats:
            mats.append(mat)
        idx = mats.index(mat)
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        me.transform(ob.matrix_world)
        n0 = len(bm.faces)
        bm.from_mesh(me)
        ev.to_mesh_clear()
        bm.faces.ensure_lookup_table()
        for k in range(n0, len(bm.faces)):
            bm.faces[k].material_index = idx
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    for ob in parts:
        bpy.data.objects.remove(ob, do_unlink=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _mat(o):
    return o.data.materials[0]


_groups = {"hull": [], "decks": [], "rig": [], "lights": [], "fittings": []}
for _o in PARTS:
    _m = _mat(_o)
    _groups["hull" if _m == M["hull"] else "decks" if _m == M["deck"] else "rig" if _m in PLAIN
            else "lights" if _m in LIGHTS else "fittings"].append(_o)
HULL, DECK, RIGM, LITE, FIT = (merge(_groups[k], k) for k in ("hull", "decks", "rig", "lights", "fittings"))
for o in (HULL, FIT, RIGM, DECK, LITE):
    o.data.calc_loop_triangles()
print("triangles", {o.name: len(o.data.loop_triangles) for o in (HULL, FIT, RIGM, DECK, LITE)})


# ------------------------------------------------------------------ textures
def fnoise(h, w, lo_h, lo_w, seed):
    r = np.random.default_rng(seed).random((lo_h, lo_w)).astype(np.float32)
    return np.asarray(Image.fromarray(r, mode="F").resize((w, h), Image.BICUBIC), np.float32)


def height_to_normal(Hm, px_u, px_v):
    gy, gx = np.gradient(Hm)
    n = np.stack([-gx / px_u, -gy / px_v, np.ones_like(Hm)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def make_image(name, arr, non_color=False):
    h, w = arr.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(np.concatenate([arr.astype(np.float32), np.ones((h, w, 1), np.float32)], axis=2).ravel())
    im.pack()
    return im


TEX_W, TEX_H = (2048, 1024) if QUICK else (4096, 2048)


def paint_hull():
    """The ship's side as a picture: oak strakes along the sheer with seams
    and butts, tarred bottom with weed at the waterline, red upper works with
    gilt mouldings, outlines of the port lids, rain streaks."""
    W, H = TEX_W, TEX_H
    s = S_MIN + (np.arange(W) + 0.5) / W * (S_MAX - S_MIN)
    z = Z_RAB + (np.arange(H) + 0.5) / H * (Z_TOP_STERN - Z_RAB)
    S, Zg = np.meshgrid(s.astype(np.float32), z.astype(np.float32))
    sh = 1.15 * ((S - 26) / 26) ** 2
    zr = Zg - sh
    pw = 0.27
    idx = np.floor(zr / pw)
    fz = zr / pw - idx
    off = (idx * 2.37) % 6.6
    segp = (S + off) / 6.6
    seg = np.floor(segp)
    h1 = np.sin(idx * 12.9898 + seg * 78.233) * 43758.5453
    tone = 0.72 + 0.55 * (h1 - np.floor(h1))
    grain = fnoise(H, W, H // 6, W // 160, 1) * 0.6 + fnoise(H, W, H // 2, W // 24, 2) * 0.4
    big = fnoise(H, W, 12, 48, 3)
    oak = np.array([0.17, 0.114, 0.07], np.float32)
    col = oak[None, None, :] * (tone * (0.7 + 0.6 * grain) * (0.8 + 0.4 * big))[..., None]
    # weathering: pale bleached streaks running down, dark wet streaks
    pale = np.clip(fnoise(H, W, 10, W // 5, 21) * 2.2 - 1.2, 0, 1) * 0.5
    col = col * (1 - pale[..., None]) + np.array([0.2, 0.18, 0.15]) * pale[..., None]
    seam = (fz < 0.055) | ((segp - seg) < 0.003)
    worn = np.clip((fz - 0.78) / 0.2, 0, 1) * (0.6 + 0.4 * grain)
    rough = np.full((H, W), 0.82, np.float32)
    height = grain * 0.25
    # tarred bottom, weed at the waterline, salt above it
    wl = -0.25 + 0.06 * fnoise(H, W, 4, 90, 4)
    tar = np.array([0.07, 0.056, 0.042], np.float32)
    k = np.clip((wl - Zg) / 0.12, 0, 1)
    col = col * (1 - k[..., None]) + (tar * (0.85 + 0.3 * grain)[..., None]) * k[..., None]
    weed = np.clip(1 - np.abs(Zg + 0.32) / 0.32, 0, 1) * np.clip(fnoise(H, W, 30, 400, 5) * 1.6 - 0.4, 0, 1)
    col = col * (1 - 0.7 * weed[..., None]) + np.array([0.09, 0.1, 0.05]) * 0.7 * weed[..., None]
    salt = np.clip(1 - np.abs(Zg - 0.25) / 0.45, 0, 1) * fnoise(H, W, 40, 300, 6) * 0.35
    col = col * (1 - salt[..., None]) + np.array([0.42, 0.4, 0.36]) * salt[..., None]
    rough = np.where(Zg < wl, 0.55, rough)
    # red upper works above the top wale, framed panels, gilt mouldings
    rt = np.vectorize(rail_top, otypes=[np.float32])(s)[None, :].repeat(H, 0)
    red_on = zr > WALES[-1][0] + WALES[-1][1] / 2
    red = np.array([0.13, 0.062, 0.04], np.float32) * (0.85 + 0.3 * grain)[..., None] * (0.9 + 0.2 * big)[..., None]
    col = np.where(red_on[..., None], red, col)
    rough = np.where(red_on, 0.66, rough)
    pil = (np.abs(((S + 0.6) % 1.3) - 0.65) < 0.05) & red_on & (Zg < rt - 0.18)
    col = np.where(pil[..., None], np.array([0.09, 0.05, 0.035]), col)
    gilt = np.array([0.4, 0.29, 0.11], np.float32)
    for line in ((np.abs(zr - (WALES[-1][0] + 0.32)) < 0.03) & red_on, (np.abs(Zg - (rt - 0.16)) < 0.028) & (Zg < rt),
                 red_on & (np.abs(zr - (D_QD + 0.18)) < 0.025)):
        col = np.where(line[..., None], gilt * (0.8 + 0.4 * grain)[..., None], col)
        rough = np.where(line, 0.4, rough)
        height = height + line * 0.6
    # wales painted black under their timbers
    for zc0, hh in WALES:
        on = np.abs(Zg - (zc0 + sh)) < hh / 2 + 0.02
        col = np.where(on[..., None], np.array([0.05, 0.036, 0.026]), col)
    # port lids: a dark gap round each, streaks running down from it
    texel_s, texel_z = (S_MAX - S_MIN) / W, (Z_TOP_STERN - Z_RAB) / H
    streak = fnoise(H, W, 6, W // 6, 7)
    for (ps, pz, w, h) in PORTS:
        i0, i1 = int((ps - w / 2 - 0.05 - S_MIN) / texel_s), int((ps + w / 2 + 0.05 - S_MIN) / texel_s)
        j0, j1 = int((pz - h / 2 - 0.05 - Z_RAB) / texel_z), int((pz + h / 2 + 0.05 - Z_RAB) / texel_z)
        col[j0:j1, i0:i1] = [0.025, 0.018, 0.013]
        height[j0:j1, i0:i1] -= 0.6
        jd = max(0, j0 - int(1.3 / texel_z))
        fade = np.linspace(0, 1, j0 - jd, dtype=np.float32)[:, None]
        col[jd:j0, i0 + 3:i1 - 3] *= (1 - 0.35 * fade * streak[jd:j0, i0 + 3:i1 - 3])[..., None]
    col = col * (1 + 0.35 * worn[..., None])
    # seams last, rain streaks and grime over all
    col = np.where(seam[..., None], col * 0.35, col)
    height = height - seam * 1.0
    rain = np.clip(fnoise(H, W, 8, W // 3, 8) * 1.5 - 0.5, 0, 1) * np.clip((Zg + 0.2) / 3.0, 0, 1)
    col = col * (1 - 0.3 * rain[..., None])
    return np.clip(col, 0, 1), height, rough


def paint_deck():
    """Deck planks, 4 x 4 m tile: 25 cm planks fore and aft, butts staggered,
    worn grey oak, pitch in the seams."""
    N = 1024
    x = (np.arange(N) + 0.5) / N * 4.0
    yv = (np.arange(N) + 0.5) / N * 4.0
    X, Yv = np.meshgrid(x, yv)
    pidx = np.floor(X / 0.25)
    fx = X / 0.25 - pidx
    off = (pidx * 1.37) % 4.0
    segp = (Yv + off) / 4.0
    seg = np.floor(segp)
    h1 = np.sin(pidx * 12.9898 + seg * 78.233) * 43758.5453
    tone = 0.82 + 0.3 * (h1 - np.floor(h1))
    grain = fnoise(N, N, N // 4, 24, 11) * 0.6 + fnoise(N, N, N, 96, 12) * 0.4
    wear = fnoise(N, N, 6, 6, 13)
    base = np.array([0.3, 0.25, 0.19], np.float32)
    col = base * (tone * (0.82 + 0.36 * grain) * (0.9 + 0.2 * wear))[..., None]
    seam = (fx < 0.04) | ((segp - seg) < 0.004)
    col = np.where(seam[..., None], np.array([0.03, 0.025, 0.02]), col)
    height = grain * 0.3 - seam * 1.0
    return np.clip(col.astype(np.float32), 0, 1), height.astype(np.float32)


hull_col, hull_h, hull_r = paint_hull()
HULL_NORMAL = make_image("hull_normal", height_to_normal(hull_h, 0.35, 0.35).astype(np.float32), non_color=True)
HULL_ROUGH = make_image("hull_rough", np.repeat(hull_r[..., None], 3, 2).astype(np.float32), non_color=True)
deck_col, deck_h = paint_deck()
DECK_COL = make_image("deck_color", deck_col)
DECK_NRM = make_image("deck_normal", height_to_normal(deck_h, 0.5, 0.5).astype(np.float32), non_color=True)


# ------------------------------------------------------------------ bake
def bake_setup():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("bake_world")
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.light_settings.distance = 2.5
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.render.bake.margin_type = "EXTEND"


def bake(ob, kind, w, h, samples, non_color=False, **kw):
    sc = bpy.context.scene
    for o in sc.objects:
        o.select_set(o == ob)
    bpy.context.view_layer.objects.active = ob
    img = bpy.data.images.new(f"bake_{ob.name}_{kind}", w, h, alpha=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    for m in ob.data.materials:
        nt = m.node_tree
        n = nt.nodes.new("ShaderNodeTexImage")
        n.name = "BAKE_TARGET"
        n.image = img
        for x in nt.nodes:
            x.select = False
        n.select = True
        nt.nodes.active = n
    sc.cycles.samples = samples
    bpy.ops.object.bake(type=kind, margin=16, use_clear=True, **kw)
    for m in ob.data.materials:
        m.node_tree.nodes.remove(m.node_tree.nodes["BAKE_TARGET"])
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def shade_from_ao(rgb, occ):
    shade = 0.3 + 0.7 * occ ** 1.15
    dirt = np.array([0.92, 0.88, 0.8], np.float32)
    return np.clip(rgb * shade * (1 - (1 - dirt) * (1 - occ) * 1.4), 0, 1)


def use_maps(mat, uv_name, color=None, normal=None, rough=None):
    nt = mat.node_tree
    p = nt.nodes["Principled BSDF"]

    def tex(image):
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = uv_name
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = image
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        return t

    for sock_name, image in (("Base Color", color), ("Roughness", rough)):
        if image is None:
            continue
        for lk in list(p.inputs[sock_name].links):
            nt.links.remove(lk)
        nt.links.new(tex(image).outputs["Color"], p.inputs[sock_name])
    if normal is not None:
        for lk in list(p.inputs["Normal"].links):
            nt.links.remove(lk)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = uv_name
        nt.links.new(tex(normal).outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])


use_maps(M["deck"], "UVMap", color=DECK_COL, normal=DECK_NRM)
bake_setup()
if SHAPE:
    use_maps(M["hull"], "UVMap", color=make_image("hull_texture", hull_col), normal=HULL_NORMAL, rough=HULL_ROUGH)
    QUICK = True
for o in (RIGM, LITE):
    o.hide_render = False

if not SHAPE:
    HULL.data.uv_layers.active = HULL.data.uv_layers["UVMap"]
    if QUICK:
        hull_img = make_image("hull_texture", hull_col)
    else:
        hull_ao = bake(HULL, "AO", TEX_W, TEX_H, 40, non_color=True)
        hull_img = make_image("hull_texture", shade_from_ao(hull_col, hull_ao[..., :1]))
    use_maps(M["hull"], "UVMap", color=hull_img, normal=HULL_NORMAL, rough=HULL_ROUGH)

    me = FIT.data
    uv = me.uv_layers.new(name="bake")
    me.uv_layers.active = uv
    uv.active_render = True
    for o in bpy.context.scene.objects:
        o.select_set(o == FIT)
    bpy.context.view_layer.objects.active = FIT
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    A = 1024 if QUICK else ATLAS
    fit_col = bake(FIT, "DIFFUSE", A, A, 4, pass_filter={"COLOR"})
    fit_ao = bake(FIT, "AO", A, A, 8 if QUICK else 40, non_color=True)
    fit_nrm = bake(FIT, "NORMAL", A, A, 4, non_color=True)
    fit_rgh = bake(FIT, "ROUGHNESS", A, A, 4, non_color=True)
    atlas = make_image("fittings_atlas", shade_from_ao(fit_col[..., :3], fit_ao[..., :1]))
    atlas_n = make_image("fittings_normal", fit_nrm[..., :3], non_color=True)
    atlas_r = make_image("fittings_rough", fit_rgh[..., :3], non_color=True)
    for m in me.materials:
        use_maps(m, "bake", color=atlas, normal=atlas_n, rough=atlas_r)
    for nm in [n.name for n in me.uv_layers if n.name != "bake"]:
        me.uv_layers.remove(me.uv_layers[nm])

    for im, fname in ((hull_img, "hull_texture.png"), (atlas, "fittings_atlas.png")):
        im.filepath_raw = os.path.join(OUT, fname)
        im.file_format = "PNG"
        im.save()

    # ------------------------------------------------------------------ export
    sel = [HULL, FIT, RIGM, DECK, LITE, RUDDER_PIVOT, RUDDER] + YARDS
    for ob in bpy.context.scene.objects:
        ob.select_set(ob in sel)
    bpy.context.view_layer.objects.active = HULL
    glb = os.path.join(OUT, "galleon.glb")
    common = dict(filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
                  export_texcoords=True, export_normals=True, export_tangents=False, export_materials="EXPORT")
    try:
        bpy.ops.export_scene.gltf(export_image_format="WEBP", export_image_quality=82, **common)
    except TypeError:
        bpy.ops.export_scene.gltf(export_image_format="JPEG", export_jpeg_quality=86, **common)
    print("wrote", glb, os.path.getsize(glb) // 1024, "KB")

    RIG.update({
        "length": round(S_MAX - S_MIN, 2), "lpp": LPP, "beam": 2 * HB, "draught": -Z_KEEL,
        "lanterns": [g((x, Y(s_aft(ZTOP[0]) - 0.75), z)) for x, z in ((-2.25, ZTOP[0] + 0.7), (0.0, ZTOP[0] + 1.75), (2.25, ZTOP[0] + 0.7))],
        "sternWindows": g((0, Y(s_aft(7.1) - 1.5), 7.1)),
        "stern": g((0, Y(s_aft(6.0)), 6.0)), "bow": g((0, Y(57.9), 5.8)),
        "decks": {"waist": round(D_UGD + sheer(30), 3), "quarter": round(D_QD + sheer(15), 3), "poop": round(D_POOP + sheer(6), 3),
              "royal": round(D_ROYAL + sheer(0), 3), "fore": round(D_FC + sheer(44), 3)},
    })
    with open(RIG_JSON, "w") as f:
        json.dump(RIG, f, indent=1)
    print("wrote", RIG_JSON)


# ------------------------------------------------------------------ preview renders
def preview():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("preview_world")
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.5, 0.42, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    sea = material("sea", (0.02, 0.025, 0.025), rough=0.15)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=600)
    mesh = bpy.data.meshes.new("sea")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(sea)
    so = bpy.data.objects.new("sea", mesh)
    so.location.z = 0.0
    sc.collection.objects.link(so)
    sd = bpy.data.lights.new("sun", "SUN")
    sd.energy = 3.2
    sd.angle = math.radians(3)
    sun = bpy.data.objects.new("sun", sd)
    sun.rotation_euler = (math.radians(55), 0, math.radians(-35))
    sc.collection.objects.link(sun)
    cd = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.cycles.samples = 24
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 800
    views = {         # the first two from where the scans of Vasa were looked at
        "ref_side": ((-36.0, Y(30.0), 0.4), (0.0, Y(22.0), 7.5), 18),
        "ref_stern": ((-17.0, Y(-30.0), 3.5), (0.0, Y(-1.0), 9.0), 32),
        "profile": ((-125.0, 3.0, 15.0), (0.0, 3.0, 16.0), 42),
        "bow": ((34.0, Y(75.0), 7.0), (0.0, Y(40.0), 10.0), 30),
        "deck": ((24.0, -45.0, 30.0), (0.0, 2.0, 6.0), 28),
    }
    for name, (pos, target, lens) in views.items():
        cd.lens = lens
        cam.location = pos
        cam.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(OUT, f"render_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", sc.render.filepath)


print("YARDS", [(o.name, tuple(round(c, 2) for c in o.location), o.hide_render, len(o.data.vertices), o.name in bpy.context.scene.objects) for o in YARDS])
if RENDER or SHAPE:
    preview()
