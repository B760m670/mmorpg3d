"""
Procedural Blender model of a 23.95 m Scottish stern trawler (v2).

Reference data (Macduff Ship Design, "23.95m Fishing Trawler - Adventurer II"):
  * data sheet: LOA (hull) 23.95 m, LBP 20.00 m, breadth moulded 9.20 m,
    depth moulded 4.00 m, 337 GRT, fish hold 160 m3, crew 10, 1500 hp,
    2700 mm propeller in nozzle, 3 split winches, 4 split net drums, crane;
  * general-arrangement profile drawing, from which every height and
    longitudinal position below was measured (44.2 px per metre on the
    drawing, heights above the design waterline);
  * delivery photo, for livery, railings and equipment.
Below-water form (not on the drawing) assumes a 3.0 m draught. Name and
registration are fictional.

Run with the bpy module (Python 3.13, bpy 5.2):
  python build_trawler.py -- <out_dir> [--render] [--atlas 2048]

Writes <out_dir>/trawler.glb (Y-up, bow toward -Z, 1 unit = 1 m, design
waterline at y = 0, origin amidships). Ambient occlusion, grime and the hull
livery are baked into one colour atlas.
"""

import bpy  # noqa: I001  (bpy must be imported before bmesh/mathutils)
import bmesh
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS and not ARGS[0].startswith("--") else os.path.join(os.path.dirname(__file__), "out")
RENDER = "--render" in ARGS
ATLAS = int(ARGS[ARGS.index("--atlas") + 1]) if "--atlas" in ARGS else 2048
NAME = "KESTREL"
PORT = "FRASERBURGH"
REG = "FR.427"
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ data
L = 23.95          # length overall (hull)
B = 9.20           # breadth moulded
HB = B / 2
T = 3.0            # assumed design draught
FF_WL = 21.2       # stem at the design waterline (drawing)
WD_Z = 4.3         # aft working deck (drawing: 1.1 m below bulwark top)
SH0, SH1 = 10.9, 11.95  # sloped aft end of the shelter deck (drawing)
STAIR_X = 3.85          # stair up to the starboard side deck
WH0, WH1, WH_LEAN = 12.2, 18.3, 0.5  # wheelhouse (drawing)
# Below decks. The drawing is an outboard profile only, so the arrangement
# follows how such boats are laid out and how this one works from outside:
#   * the codend is emptied through the hatch in the working deck (s 8.15),
#     so the fish-handling space is the main ('tween) deck right under it,
#     with the side discharge doors for offal and water (drawing);
#   * the fishroom (data sheet: 160 m3) lies under the fish handling, so the
#     washed fish go straight down through the fishroom hatch;
#   * the engine room is aft of it with a short shaft to the propeller, and
#     the steering gear flat is over the rudder, reached by its own hatch;
#   * the casing amidships holds oilskins, washroom, galley and mess (as on
#     UK trawlers of this size, Parkol Marine yard descriptions), with a stair
#     up to the wheelhouse; cabins forward. The exhaust rises from the
#     engine room in a trunk to the funnel on the wheelhouse roof.
TW_Z = 2.15             # 'tween deck floor (main deck)
TW_CEIL = 4.1           # under the working deck; 5.0 under the shelter deck
TW_S0, TW_S1 = 0.7, 20.3
SG_Z, SG_S0, SG_S1 = 0.0, 0.45, 3.0        # steering gear flat
ER_Z, ER_S0, ER_S1 = -1.4, 3.0, 9.4        # engine room floor plates
HOLD_Z, HOLD_S0, HOLD_S1 = -1.5, 9.4, 16.4  # fishroom (about 160 m3 gross)
CASE_S0, CASE_S1 = 11.4, 16.6              # casing: oilskins, washroom, galley, mess
COMP = (2.7, 3.5, 1.2, 3.55)               # working-deck companion: x0, x1, s_bottom, s_top
ER_STAIR = (-3.0, -2.25, 6.2, 3.4)         # 'tween -> engine room: x0, x1, s_bottom, s_top
HOLD_STAIR = (10.5, 11.3, -0.3, 3.7)       # 'tween -> fishroom: s0, s1, x_bottom, x_top
CHUTE = (1.7, 2.4, 9.55, 10.3)             # fish chute hatch from the washer: x0, x1, s0, s1
SG_STAIR = (1.6, 2.4, -2.2, -0.6)          # 'tween -> steering flat: s0, s1, x_bottom, x_top
WH_STAIR = (-3.1, -2.35, 14.0, 16.1)       # wheelhouse -> casing: x0, x1, s_bottom, s_top
WH_HOLE = (-3.1, -2.35, 14.6, 16.1)        # the opening it needs in the wheelhouse floor
HOPPER = (-0.1, 1.3, 7.7, 8.6)             # deck hatch / reception hopper: x0, x1, s0, s1
UPTAKE = (0.95, 1.65)                      # exhaust trunk, x range (funnel at x 1.3)


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def Y(s):
    """Station s (metres from the transom) -> Blender Y (bow is +Y)."""
    return s - L / 2


def top_z(s):   # hull top: bulwark cap aft, shelter deck edge forward
    return 5.4 + 0.12 * smooth(0.75 * L, L, s)


def red_z(s):   # top of the red topsides
    return 3.05 + 0.25 * smooth(0.7 * L, L, s) ** 1.5


def pin_z(s):   # red pinstripe
    return 4.15 + 0.35 * smooth(0.7 * L, L, s) ** 1.5


def deck_z(s):  # walking surface inside the bulwarks
    if s <= SH0:
        return WD_Z
    if s >= SH1:
        return top_z(s) - 0.15
    return lerp(WD_Z, top_z(SH1) - 0.15, (s - SH0) / (SH1 - SH0))


def keel_z(s):
    base = -T - 0.25 * (1 - s / L)          # trimmed by the stern
    run = smooth(7.5, 0.0, s)                # aft cut-up for the propeller
    return lerp(base, -0.7, run ** 1.3)


Z_HEAD = top_z(L)


def stem_s(z):
    """Raked, convex stem (drawing) with a rounded forefoot below water."""
    if z >= 0:
        u = clamp(z / Z_HEAD)
        return FF_WL + (L - FF_WL) * (1 - (1 - u) ** 1.6)
    return FF_WL - 2.8 * clamp(-z / T) ** 1.7


def wl_half(s):
    return HB * 0.985 * lerp(0.86, 1.0, smooth(0, 6, s))


def section_n(s):
    if s < L * 0.5:
        return lerp(2.0, 3.6, smooth(0, 7, s))
    return lerp(3.6, 1.7, smooth(L * 0.5, L * 0.95, s))


def half_breadth(s, z):
    zc = keel_z(s)
    zw = 0.6
    bw = wl_half(s)
    deck_half = HB * lerp(0.92, 1.0, smooth(0, 4, s))
    if z <= zw:
        q = clamp((zw - z) / (zw - zc)) if zw > zc else 0.0
        n = section_n(s)
        y = bw * (1 - q ** n) ** (1 / n)
    else:
        y = lerp(bw, deck_half, clamp((z - zw) / (top_z(s) - zw)))
    # Entrance: the hull keeps full breadth until the last D metres before the
    # stem. Long, fine run at the forefoot; short, full shoulders at the deck
    # (beamy Scottish trawler with a flared bow).
    d = max(0.0, stem_s(z) - s)
    t = smooth(-3.0, 5.4, z)
    D = lerp(10.0, 6.0, t)
    p = lerp(1.6, 2.2, t)
    return max(0.0, y * (1 - (1 - min(1.0, d / D)) ** p))


N_ST = 110
STATIONS = sorted(set(
    [round(L * (0.5 - 0.5 * math.cos(math.pi * (i / (N_ST - 1)) ** 0.85)), 4) for i in range(N_ST)]
))
STATIONS[0], STATIONS[-1] = 0.0, L
Z_ROWS = [-3.7 + j * 0.1 for j in range(int((5.7 + 3.7) / 0.1) + 1)]


def section_points(s):
    zc, zt = keel_z(s), top_z(s)
    pts = []
    for zj in Z_ROWS:
        z = clamp(zj, zc, zt)
        y = 0.0 if z <= zc + 1e-6 else half_breadth(s, z)
        pts.append((0.0 if y < 0.03 else y, z))
    return pts


# ------------------------------------------------------------------ scene helpers
for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for item in list(coll):
        coll.remove(item)

PARTS = []


def _sock(sockets, name, kind):
    return next(x for x in sockets if x.name == name and x.type == kind)


def material(name, color, rough=0.5, metal=0.0, emit=None, grime=0.0, rust=0.0, bump=0.0):
    """Principled material with optional procedural weathering.

    grime: rain streaks and blotches; rust: rusty edges (AO 'inside'), spots
    and run-off streaks; bump: dents and orange-peel relief (metres). All of
    it is baked into colour / normal / roughness maps later.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = 6.0
    if not (grime or rust or bump):
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

    streaks = stretched(2.2, 2.2, 0.12)
    dirt = op("MULTIPLY", op("ADD", mrange(noise(3, 4, streaks), 0.52, 0.75),
                             mrange(noise(0.9, 6), 0.45, 0.8)), grime)
    col = mix(dirt, tuple(color), (color[0] * 0.6, color[1] * 0.56, color[2] * 0.48))
    rmask = None
    if rust:
        spots = mrange(noise(5, 10, r=0.65), 0.64, 0.74)
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.inside = True
        ao.only_local = True
        ao.samples = 8
        ao.inputs["Distance"].default_value = 0.06
        edge = mrange(op("SUBTRACT", 1.0, ao.outputs["AO"]), 0.25, 0.6)
        edge = op("MULTIPLY", edge, mrange(noise(9, 4), 0.4, 0.6))
        runoff = op("MULTIPLY", mrange(noise(4, 3, stretched(3, 3, 0.08)), 0.62, 0.82), 0.6)
        rmask = op("MULTIPLY", op("MAXIMUM", op("MAXIMUM", spots, edge), runoff), rust)
        rust_col = mix(noise(14, 6), (0.16, 0.06, 0.03), (0.46, 0.19, 0.07))
        col = mix(rmask, col, rust_col)
    link(col, p.inputs["Base Color"])

    r_total = op("ADD", rough, op("MULTIPLY", dirt, 0.15))
    if rmask is not None:
        r_total = op("ADD", r_total, op("MULTIPLY", rmask, 0.35))
    link(r_total, p.inputs["Roughness"])

    if bump:
        h = op("ADD", noise(0.7, 2), op("MULTIPLY", noise(30, 2), 0.15))
        if rmask is not None:
            h = op("ADD", h, op("MULTIPLY", rmask, 0.6))
        b = nt.nodes.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = 1.0
        b.inputs["Distance"].default_value = bump
        link(h, b.inputs["Height"])
        link(b.outputs["Normal"], p.inputs["Normal"])
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
    PARTS.append(ob)
    return ob


def _bevel(ob, width):
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.harden_normals = True


def box(name, c, size, mat, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0] + c[0], v.co.y * size[1] + c[1], v.co.z * size[2] + c[2]))
    ob = new_obj(name, bm, mat)
    if bevel:
        _bevel(ob, bevel)
    return ob


def box_hole(name, x0, x1, s0, s1, zc, h, mat, hole=None):
    """Axis-aligned slab over x0..x1, stations s0..s1, thickness h centred at
    zc, with a rectangular opening hole = (hx0, hx1, hs0, hs1)."""
    pieces = [(x0, x1, s0, s1)] if hole is None else [
        (x0, x1, s0, hole[2]), (x0, x1, hole[3], s1), (x0, hole[0], hole[2], hole[3]), (hole[1], x1, hole[2], hole[3])]
    for a0, a1, b0, b1 in pieces:
        if a1 - a0 > 1e-3 and b1 - b0 > 1e-3:
            box(name, ((a0 + a1) / 2, Y((b0 + b1) / 2), zc), (a1 - a0, b1 - b0, h), mat)


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


def sphere(name, c, r, mat, seg=18, squash=1.0):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=r)
    for v in bm.verts:
        v.co.z *= squash
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return new_obj(name, bm, mat, smooth_shade=True)


def torus(name, c, axis, R, r, mat):
    bm = bmesh.new()
    segs, sides = 20, 8
    rings = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        ring = []
        for j in range(sides):
            b = 2 * math.pi * j / sides
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(segs):
        for j in range(sides):
            a, b_ = rings[i], rings[(i + 1) % segs]
            bm.faces.new([a[j], b_[j], b_[(j + 1) % sides], a[(j + 1) % sides]])
    rot = Vector(axis).normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(c)) @ rot, verts=bm.verts)
    return new_obj(name, bm, mat, smooth_shade=True)


def solid(name, bot, top, mat, bevel=0.0):
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
    ob = new_obj(name, bm, mat)
    if bevel:
        _bevel(ob, bevel)
    return ob


def extrude_x(name, profile, x0, x1, mat, bevel=0.0):
    """Plate: a (s, z) profile extruded across the ship from x0 to x1."""
    bot = [(x0, Y(s), z) for s, z in profile]
    top = [(x1, Y(s), z) for s, z in profile]
    return solid(name, bot, top, mat, bevel)


def panel(name, center, right, up, w, h, mat, depth=0.04):
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
    return new_obj(name, bm, mat)


def railing(name, pts, h, post_mat, rail_mat, closed=False, gap=1.25):
    """Ship's handrail: posts, two intermediate courses, coloured top rail."""
    pts = [Vector(p) for p in pts]
    if closed:
        pts = pts + [pts[0]]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        n = max(1, int(math.ceil((b - a).length / gap)))
        last = i == len(pts) - 2 and not closed
        for k in range(n + (1 if last else 0)):
            p = a.lerp(b, k / n)
            cyl(f"{name}_post", p, p + Vector((0, 0, h)), 0.024, post_mat, seg=6)
        up = Vector((0, 0, h))
        cyl(f"{name}_top", a + up, b + up, 0.03, rail_mat, seg=8)
        for f in (0.36, 0.68):
            cyl(f"{name}_mid", a + up * f, b + up * f, 0.012, post_mat, seg=5)


def wall(name, origin, right, up, width, height, openings, mat, glass=None, thick=0.08):
    """Wall in the plane origin + a*right + b*up with rectangular openings
    (a0, a1, b0, b1, is_window). Windows get a glass pane; doors stay open."""
    origin, right, up = Vector(origin), Vector(right).normalized(), Vector(up).normalized()
    xs = sorted(set([0.0, width] + [o[0] for o in openings] + [o[1] for o in openings]))
    ys = sorted(set([0.0, height] + [o[2] for o in openings] + [o[3] for o in openings]))
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            w, h = xs[i + 1] - xs[i], ys[j + 1] - ys[j]
            if w < 1e-4 or h < 1e-4:
                continue
            cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
            hole = next((o for o in openings if o[0] <= cx <= o[1] and o[2] <= cy <= o[3]), None)
            c = origin + right * cx + up * cy
            if hole is None:
                panel(name, c, right, up, w, h, mat, thick)
            elif hole[4] and glass is not None:
                panel(name + "_glass", c, right, up, w, h, glass, 0.012)
    # rubber window frames
    for o in openings:
        if not o[4]:
            continue
        a0, a1, b0, b1 = o[:4]
        for (ca, cb, w, h) in (((a0 + a1) / 2, b0, a1 - a0, 0.04), ((a0 + a1) / 2, b1, a1 - a0, 0.04),
                               (a0, (b0 + b1) / 2, 0.04, b1 - b0), (a1, (b0 + b1) / 2, 0.04, b1 - b0)):
            panel(name + "_frame", origin + right * ca + up * cb, right, up, w, h, M["dark"], thick + 0.02)


def tri_x(name, pts_sz, x0, x1, mat):
    """Triangle/polygon in the (s, z) plane extruded across x."""
    return solid(name, [(x0, Y(sv), zv) for sv, zv in pts_sz], [(x1, Y(sv), zv) for sv, zv in pts_sz], mat)


def plate_y(name, pts_xz, s, t, mat):
    """Polygon in the (x, z) plane at station s, thickness t along the ship."""
    return solid(name, [(xv, Y(s) - t / 2, zv) for xv, zv in pts_xz], [(xv, Y(s) + t / 2, zv) for xv, zv in pts_xz], mat)


def ladder(name, p0, p1, half_width_vec, mat, rung=0.3):
    p0, p1, hv = Vector(p0), Vector(p1), Vector(half_width_vec)
    for sgn in (-1, 1):
        cyl(name + "_rail", p0 + hv * sgn, p1 + hv * sgn, 0.025, mat, seg=6)
    n = max(2, int((p1 - p0).length / rung))
    for k in range(1, n):
        p = p0.lerp(p1, k / n)
        cyl(name + "_rung", p - hv, p + hv, 0.016, mat, seg=5)


# ------------------------------------------------------------------ materials
M = {
    "hull": material("hull_livery", (1, 1, 1), rough=0.45),
    "white": material("paint_white", (0.84, 0.85, 0.83), rough=0.45, grime=0.32, rust=0.35, bump=0.004),
    "deck": material("deck_paint", (0.17, 0.23, 0.2), rough=0.8, grime=0.5, rust=0.55, bump=0.003),
    "orange": material("paint_orange", (0.9, 0.33, 0.06), rough=0.45, grime=0.15, rust=0.3, bump=0.003),
    "rail_white": material("rail_white", (0.86, 0.87, 0.85), rough=0.42, grime=0.1, rust=0.3),
    "glass": material("glass", (0.025, 0.035, 0.045), rough=0.04, metal=0.3),
    "steel": material("steel", (0.45, 0.46, 0.47), rough=0.38, metal=0.85, rust=0.2),
    "dark": material("dark_steel", (0.06, 0.06, 0.065), rough=0.6, metal=0.4, rust=0.4),
    "machinery": material("machinery", (0.18, 0.24, 0.3), rough=0.5, grime=0.3, rust=0.45, bump=0.003),
    "net": material("net_green", (0.08, 0.26, 0.13), rough=0.95, grime=0.2, bump=0.02),
    "drum": material("drum_grey", (0.62, 0.64, 0.64), rough=0.45, grime=0.25, rust=0.35, bump=0.003),
    "antifoul": material("antifouling", (0.34, 0.11, 0.07), rough=0.8, grime=0.3, bump=0.003),
    "red": material("paint_red", (0.48, 0.008, 0.005), rough=0.45, rust=0.3),
    "radar": material("radar_black", (0.03, 0.03, 0.03), rough=0.35),
    "yellow": material("searchlight", (0.85, 0.65, 0.08), rough=0.35, grime=0.2),
    "flag": material("flag_red", (0.62, 0.05, 0.04), rough=0.8),
    "doors": material("trawl_door", (0.07, 0.055, 0.05), rough=0.75, metal=0.3, grime=0.4, rust=0.9, bump=0.006),
    "float": material("float_orange", (0.92, 0.36, 0.03), rough=0.5, grime=0.3),
    "rope": material("rope", (0.5, 0.43, 0.3), rough=0.95, grime=0.4, bump=0.01),
    "box": material("fish_box", (0.03, 0.14, 0.42), rough=0.55, grime=0.35),
    "tyre": material("tyre", (0.025, 0.025, 0.025), rough=0.9, grime=0.2, bump=0.006),
    "floor": material("bridge_floor", (0.12, 0.12, 0.13), rough=0.85, grime=0.2, bump=0.001),
    "console": material("console", (0.1, 0.12, 0.14), rough=0.55),
    "seat": material("seat", (0.03, 0.03, 0.035), rough=0.6),
    "wood": material("chart_table", (0.36, 0.2, 0.09), rough=0.5, grime=0.15),
    "screen": material("light_screen", (0.02, 0.04, 0.05), rough=0.2, emit=(0.05, 0.16, 0.24)),
    "radar_screen": material("light_radar", (0.01, 0.04, 0.02), rough=0.2, emit=(0.06, 0.32, 0.1)),
    "red_light": material("light_red", (0.4, 0.02, 0.02), emit=(1.0, 0.08, 0.05)),
    "green_light": material("light_green", (0.02, 0.4, 0.05), emit=(0.1, 1.0, 0.2)),
    "white_light": material("light_white", (0.7, 0.7, 0.65), emit=(1.0, 0.95, 0.85)),
    "collision": material("collision", (1.0, 0.0, 1.0)),
}
for _k in ("screen", "radar_screen"):
    M[_k].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.2


# ------------------------------------------------------------------ hull livery texture
TEX_W, TEX_H = 4096, 1024   # starboard | port | transom (<= 4096 for phones)
SIDE_W, TR_W = 1664, 768
Z_MIN, Z_SPAN = -4.0, 11.0
FONT = next((p for p in (
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
) if os.path.exists(p)), None)


def text_mask(text, height_px, aspect=1.0):
    """Greyscale mask of text (rows top->bottom), or None without Pillow."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    font = ImageFont.truetype(FONT, int(height_px * 1.38)) if FONT else ImageFont.load_default()
    x0, y0, x1, y1 = font.getbbox(text)
    im = Image.new("L", (x1 - x0 + 4, y1 - y0 + 4), 0)
    ImageDraw.Draw(im).text((2 - x0, 2 - y0), text, fill=255, font=font)
    if aspect != 1.0:
        im = im.resize((max(1, int(im.width * aspect)), im.height), Image.LANCZOS)
    return np.asarray(im, np.float32) / 255.0


def stamp(img, mask, col_c, row_c, color):
    if mask is None:
        return
    m = mask[::-1]  # image rows are bottom-up
    h, w = m.shape
    r0, c0 = int(row_c - h / 2), int(col_c - w / 2)
    r1, c1 = r0 + h, c0 + w
    sub = img[max(r0, 0):r1, max(c0, 0):c1]
    mm = m[max(0, -r0):h - max(0, r1 - img.shape[0]), max(0, -c0):w - max(0, c1 - img.shape[1])][..., None]
    sub[:] = sub * (1 - mm) + np.array(color) * mm


def paint_side(img, hgt, rgh, cols, side):
    """Paint one side's livery, relief (height, m) and roughness; side +1 = starboard."""
    W = cols.stop - cols.start
    c = np.arange(W) + 0.5
    s_line = c / W * L if side > 0 else (1 - c / W) * L
    zs = (np.arange(TEX_H) + 0.5) / TEX_H * Z_SPAN + Z_MIN
    S, Z = np.meshgrid(s_line, zs)
    v = np.vectorize
    red_l, pin_l, top_l = v(red_z)(s_line)[None], v(pin_z)(s_line)[None], v(top_z)(s_line)[None]

    col = np.empty((TEX_H, W, 3), np.float32)
    white = np.array([0.86, 0.87, 0.85])
    red = np.array([0.72, 0.07, 0.05])
    af = np.array([0.36, 0.12, 0.08])
    green = np.array([0.03, 0.4, 0.2])
    black = np.array([0.04, 0.04, 0.045])
    col[:] = white
    col[np.broadcast_to(Z < red_l, Z.shape)] = red
    col[(Z >= -0.02) & (Z < 0.16)] = white          # boot-top
    col[Z < -0.02] = af
    col[(Z >= pin_l) & (Z < pin_l + 0.09)] = red     # pinstripe
    col[np.broadcast_to(Z > top_l - 0.05, Z.shape)] = np.array([0.8, 0.28, 0.08])  # capping edge

    # green: shelter-side parallelogram, bow taper, low aft line (drawing)
    zz = np.clip(Z - 4.45, 0, None)
    g1 = (Z > 4.45) & (Z < 5.18) & (S > 12.6 + zz * 1.4) & (S < 18.9 - zz * 0.8)
    t_bow = (S - 19.9) / 3.4
    g2 = (t_bow > 0) & (t_bow < 1) & (Z < pin_l - 0.12) & (Z > pin_l - 0.12 - 0.42 * (1 - t_bow))
    g3 = (S > 0.15) & (S < 8.1) & (Z > 1.55) & (Z < 1.82)
    col[g1 | g2 | g3] = green

    def rect(s0, s1, z0, z1, color, outline=0.0):
        m = (S > s0) & (S < s1) & (Z > z0) & (Z < z1)
        if outline:
            inner = (S > s0 + outline) & (S < s1 - outline) & (Z > z0 + outline) & (Z < z1 - outline)
            m &= ~inner
            col[m] = col[m] * 0.55
        else:
            col[m] = color

    # portholes (drawing + photo)
    for sp in (8.6, 10.4, 11.9, 14.5):
        d = np.hypot(S - sp, Z - 3.42)
        col[d < 0.2] = np.array([0.55, 0.56, 0.56])
        col[d < 0.15] = np.array([0.06, 0.07, 0.08])
    # discharge door and boarding ladder (drawing)
    rect(7.95, 8.85, 2.3, 4.05, None, outline=0.035)
    for zr in np.arange(0.3, 2.0, 0.3):
        rect(8.15, 8.55, zr, zr + 0.05, black)
    # freeing ports along the working-deck bulwark, with faint rust
    rng = np.random.default_rng(11)
    for i, sp in enumerate(np.arange(1.0, SH0 - 0.5, 1.55)):
        rect(sp - 0.3, sp + 0.3, WD_Z + 0.05, WD_Z + 0.3, black)
        if i % 2 == 0:
            sx = sp + rng.uniform(-0.15, 0.15)
            st = (np.abs(S - sx) < 0.04) & (Z < WD_Z + 0.05) & (Z > WD_Z - rng.uniform(1.0, 2.2))
            fade = np.clip((Z - (WD_Z - 2.2)) / 2.2, 0, 1)[..., None]
            col[st] = col[st] * (1 - 0.35 * fade[st]) + np.array([0.45, 0.22, 0.09]) * 0.35 * fade[st]
    # anchor pocket and mooring fairlead near the bow (photo)
    e = ((S - 21.9) / 0.95) ** 2 + ((Z - 3.72) / 0.3) ** 2
    col[e < 1] = np.array([0.16, 0.16, 0.17])
    col[e < 0.7] = np.array([0.08, 0.08, 0.09])
    anchor = ((np.abs(S - 21.95) < 0.05) & (np.abs(Z - 3.74) < 0.2)) | \
             ((np.abs(Z - 3.56 - 0.25 * (S - 21.95) ** 2) < 0.035) & (np.abs(S - 21.95) < 0.28))
    col[anchor] = np.array([0.3, 0.3, 0.31])
    rect(19.7, 20.35, 3.35, 3.75, np.array([0.1, 0.1, 0.11]))
    # draught marks (white ticks) at stem and stern
    for sp in (0.25, stem_s(-1.0) - 0.15):
        for zr in np.arange(-2.4, 0.0, 0.2):
            rect(sp - 0.06, sp + 0.06, zr, zr + 0.08, white)
    # plate seams and waterline grime
    for sp in np.arange(2.4, L, 2.4):
        seam = (np.abs(S - sp) < 0.012) & np.broadcast_to(Z < top_l, Z.shape)
        col[seam] *= 0.93
    for zr in (1.0, 2.1, 4.75):
        col[np.abs(Z - zr) < 0.01] *= 0.94
    grime_band = np.clip(1 - np.abs(Z - 0.35) / 0.35, 0, 1)
    col *= (1 - 0.12 * grime_band[..., None] * np.array([1.0, 0.9, 1.1]))
    col *= (1 + rng.normal(0, 0.006, (TEX_H, W, 1))).astype(np.float32)

    # ---------------- weathering (photo-real wear of a working hull)
    rng2 = np.random.default_rng(23 if side > 0 else 29)
    RA = np.zeros((TEX_H, W), np.float32)            # rust amount -> roughness
    rust_c = np.array([0.46, 0.2, 0.08])

    def streak(sx, z_top, length, width, strength):
        m = (np.abs(S - sx) < width) & (Z < z_top) & (Z > z_top - length)
        a = strength * np.clip((Z - (z_top - length)) / length, 0, 1) * np.clip(1 - np.abs(S - sx) / width, 0, 1)
        a = np.where(m, a, 0.0)
        col[:] = col * (1 - a[..., None]) + rust_c * a[..., None]
        RA[:] = np.maximum(RA, a)

    for _ in range(6):                                # anchor pocket bleed
        streak(21.9 + rng2.uniform(-0.7, 0.7), 3.45, rng2.uniform(1.4, 3.3), rng2.uniform(0.03, 0.08), 0.6)
    for sp in (8.6, 10.4, 11.9, 14.5):                # portholes
        streak(sp + rng2.uniform(-0.05, 0.05), 3.22, rng2.uniform(0.6, 1.5), 0.03, 0.3)
    for _ in range(34):                               # general run-off
        streak(rng2.uniform(0.4, 21.5), rng2.uniform(1.8, 5.2), rng2.uniform(0.4, 2.0),
               rng2.uniform(0.012, 0.04), rng2.uniform(0.12, 0.35))
    for _ in range(150):                              # rust pits along strakes / boot-top
        s0 = rng2.uniform(0.2, 22.5)
        z0 = rng2.choice([red_z(s0), pin_z(s0) + 0.05, 0.12, top_z(s0) - 0.1]) + rng2.normal(0, 0.04)
        r0 = rng2.uniform(0.015, 0.06)
        d = ((S - s0) ** 2 + ((Z - z0) * 1.6) ** 2) / r0 ** 2
        a = np.clip(1.2 - d, 0, 1) * rng2.uniform(0.5, 0.9)
        col[:] = col * (1 - a[..., None]) + rust_c * 0.8 * a[..., None]
        RA[:] = np.maximum(RA, a)
    for _ in range(90):                               # scrapes from trawl doors / quays
        s0 = rng2.uniform(0.1, 4.5) if rng2.random() < 0.6 else rng2.uniform(16.5, 21.5)
        z0, ln, ang = rng2.uniform(0.5, 4.2), rng2.uniform(0.3, 1.8), rng2.uniform(-0.18, 0.18)
        m = (np.abs((Z - z0) - ang * (S - s0)) < rng2.uniform(0.006, 0.02)) & (S > s0) & (S < s0 + ln)
        col[m] = col[m] * 0.45 + np.array([0.3, 0.28, 0.26]) * 0.55
        RA[m] = np.maximum(RA[m], 0.5)
    # sun-faded, chalky patches on the red
    fade = rng2.normal(0, 1, (TEX_H // 64 + 2, W // 64 + 2)).astype(np.float32)
    fade = np.kron(fade, np.ones((64, 64), np.float32))[:TEX_H, :W]
    kf = np.ones(61, np.float32) / 61
    fade = np.apply_along_axis(lambda r: np.convolve(r, kf, "same"), 1, fade)
    fade = np.apply_along_axis(lambda c: np.convolve(c, kf, "same"), 0, fade)
    redm = np.broadcast_to((Z < red_l) & (Z > 0.16), Z.shape)
    col[redm] *= (1 + 0.1 * np.clip(fade[redm], -1, 1))[:, None]
    # green-brown slime at the waterline
    slime = np.clip(1 - np.abs(Z - 0.05) / 0.22, 0, 1) * (0.55 + 0.45 * np.clip(fade * 2, 0, 1))
    col[:] = col * (1 - 0.35 * slime[..., None]) + np.array([0.18, 0.2, 0.1]) * 0.35 * slime[..., None]

    # ---------------- relief: plating sags between frames ("hungry horse"),
    # weld beads, dents
    fr = np.mod(S / 0.6, 1.0)
    H = -0.008 * (1 - (2 * fr - 1) ** 2)
    lg = np.mod((Z + 0.3) / 1.1, 1.0)
    H += -0.003 * (1 - (2 * lg - 1) ** 2)
    for sp in np.arange(2.4, L, 2.4):
        H += 0.0015 * np.exp(-((S - sp) / 0.012) ** 2)
    for zr in (1.0, 2.1, 4.75):
        H += 0.0015 * np.exp(-((Z - zr) / 0.012) ** 2)
    for _ in range(45):
        s0 = rng2.uniform(0.2, 4.5) if rng2.random() < 0.5 else rng2.uniform(0.2, 22)
        z0, rr, dp = rng2.uniform(0.3, 5.0), rng2.uniform(0.15, 0.6), rng2.uniform(0.004, 0.02)
        H -= dp * np.exp(-((S - s0) ** 2 + (Z - z0) ** 2) / rr ** 2)
    for sp in (8.6, 10.4, 11.9, 14.5):
        dd = np.hypot(S - sp, Z - 3.42)
        H += 0.012 * ((dd < 0.2) & (dd > 0.15)) - 0.01 * (dd <= 0.15)
    R = 0.45 + 0.05 * np.clip(fade, -1, 1)
    R = np.where(Z < -0.02, 0.82, R)
    R = np.clip(R + 0.4 * RA, 0.05, 1.0)
    hgt[:, cols] = H
    rgh[:, cols] = R

    # lettering: registration aft and on the shelter side, name forward
    px_s, px_z = W / L, TEX_H / Z_SPAN
    aspect = px_s / px_z

    def s_col(sv):
        return (sv / L if side > 0 else 1 - sv / L) * W

    def z_row(zv):
        return (zv - Z_MIN) * px_z

    reg = text_mask(REG, 0.5 * px_z, aspect)
    stamp(col, reg, s_col(2.4), z_row(4.85), black)
    stamp(col, reg, s_col(10.0 if side > 0 else 9.4), z_row(4.85), black)
    stamp(col, text_mask(NAME, 0.2 * px_z, aspect), s_col(18.4), z_row(3.75), black)
    img[:, cols] = col


def paint_transom(img, hgt, rgh, cols):
    W = cols.stop - cols.start
    xs = ((np.arange(W) + 0.5) / W - 0.5) * B
    zs = (np.arange(TEX_H) + 0.5) / TEX_H * Z_SPAN + Z_MIN
    X, Z = np.meshgrid(xs, zs)
    col = np.empty((TEX_H, W, 3), np.float32)
    col[:] = (0.86, 0.87, 0.85)
    col[Z < red_z(0)] = (0.72, 0.07, 0.05)
    col[(Z >= -0.02) & (Z < 0.16)] = (0.86, 0.87, 0.85)
    col[Z < -0.02] = (0.36, 0.12, 0.08)
    col[(Z >= pin_z(0)) & (Z < pin_z(0) + 0.09)] = (0.72, 0.07, 0.05)
    col[Z > top_z(0) - 0.05] = (0.8, 0.28, 0.08)
    px_x, px_z = W / B, TEX_H / Z_SPAN
    aspect = px_x / px_z
    stamp(col, text_mask(NAME, 0.42 * px_z, aspect), W / 2, (4.75 - Z_MIN) * px_z, (0.04, 0.04, 0.045))
    stamp(col, text_mask(PORT, 0.24 * px_z, aspect), W / 2, (3.6 - Z_MIN) * px_z, (0.04, 0.04, 0.045))
    rng3 = np.random.default_rng(31)
    for _ in range(14):                                # run-off from the stern rail
        sx = rng3.uniform(-4.0, 4.0)
        ln = rng3.uniform(0.5, 2.2)
        m = (np.abs(X - sx) < 0.03) & (Z < top_z(0)) & (Z > top_z(0) - ln)
        col[m] = col[m] * 0.7 + np.array([0.46, 0.2, 0.08]) * 0.3
    fr = np.mod(X / 0.6, 1.0)
    H = -0.007 * (1 - (2 * fr - 1) ** 2) - 0.003 * (1 - (2 * np.mod(Z / 1.1, 1.0) - 1) ** 2)
    hgt[:, cols] = H
    rgh[:, cols] = np.where(Z < -0.02, 0.82, 0.47)
    img[:, cols] = col


def height_to_normal(Hm, px_u, px_v):
    gx = np.gradient(Hm, axis=1) / px_u
    gy = np.gradient(Hm, axis=0) / px_v
    n = np.stack([-gx, -gy, np.ones_like(Hm)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (n * 0.5 + 0.5).astype(np.float32)


def half_res(a):
    h, w = a.shape[:2]
    return a.reshape(h // 2, 2, w // 2, 2, *a.shape[2:]).mean(axis=(1, 3))


def make_image(name, arr, non_color=False):
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    h, w = arr.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2).astype(np.float32).ravel())
    im.pack()
    return im


def build_livery():
    img = np.zeros((TEX_H, TEX_W, 3), np.float32)
    hgt = np.zeros((TEX_H, TEX_W), np.float32)
    rgh = np.zeros((TEX_H, TEX_W), np.float32)
    paint_side(img, hgt, rgh, slice(0, SIDE_W), +1)
    paint_side(img, hgt, rgh, slice(SIDE_W, 2 * SIDE_W), -1)
    paint_transom(img, hgt, rgh, slice(2 * SIDE_W, TEX_W))
    img = np.clip(img, 0, 1)
    pv = Z_SPAN / TEX_H
    nrm = np.concatenate([
        height_to_normal(hgt[:, :2 * SIDE_W], L / SIDE_W, pv),
        height_to_normal(hgt[:, 2 * SIDE_W:], B / TR_W, pv),
    ], axis=1)
    global HULL_NORMAL, HULL_ROUGH
    HULL_NORMAL = make_image("hull_normal", half_res(nrm), non_color=True)
    HULL_ROUGH = make_image("hull_rough", half_res(rgh), non_color=True)
    return make_image("hull_livery", img)


LIVERY = build_livery()
_nt = M["hull"].node_tree
_tex = _nt.nodes.new("ShaderNodeTexImage")
_tex.image = LIVERY
_tex.extension = "EXTEND"
_uvn = _nt.nodes.new("ShaderNodeUVMap")
_uvn.uv_map = "UVMap"
_nt.links.new(_uvn.outputs["UV"], _tex.inputs["Vector"])
_nt.links.new(_tex.outputs["Color"], _nt.nodes["Principled BSDF"].inputs["Base Color"])


def hull_uv(bm, transom=False):
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        side = 1 if f.calc_center_median().x >= 0 else -1
        for lp in f.loops:
            co = lp.vert.co
            v = (co.z - Z_MIN) / Z_SPAN
            if transom:
                u = (2 * SIDE_W + (co.x / B + 0.5) * TR_W) / TEX_W
            else:
                s = co.y + L / 2
                u = (s / L * SIDE_W) / TEX_W if side > 0 else (SIDE_W + (1 - s / L) * SIDE_W) / TEX_W
            lp[uv].uv = (u, v)


# ------------------------------------------------------------------ hull
def build_hull():
    bm = bmesh.new()
    # Rows run from the transom to the stem at their own height, so every
    # waterline ends exactly on the raked stem (no staircase of slivers).
    def vertex(t, zj):
        s = stem_s(min(zj, Z_HEAD)) * t
        z = clamp(zj, keel_z(s), top_z(s))
        y = 0.0 if z <= keel_z(s) + 1e-6 else half_breadth(s, z)
        return (0.0 if y < 0.03 else y, Y(s), z)

    grid = [[bm.verts.new(vertex(st / L, zj)) for zj in Z_ROWS] for st in STATIONS]
    for i in range(len(grid) - 1):
        for j in range(len(Z_ROWS) - 1):
            try:
                bm.faces.new([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]])
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)
    bmesh.ops.mirror(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], axis="X", merge_dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    probe = [f for f in bm.faces if f.calc_center_median().x > 1.0]
    if probe and sum(f.normal.x for f in probe) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    hull_uv(bm)
    new_obj("hull_shell", bm, M["hull"], smooth_shade=True)

    pts = []
    for (y, z) in section_points(0.0):
        if not pts or abs(pts[-1][0] - y) > 1e-4 or abs(pts[-1][1] - z) > 1e-4:
            pts.append((y, z))
    loop = [(y, Y(0.0), z) for (y, z) in pts] + [(-y, Y(0.0), z) for (y, z) in reversed(pts) if y > 1e-4]
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in loop]
    vc = bm.verts.new((0.0, Y(0.0), sum(p[2] for p in loop) / len(loop)))
    for i in range(len(vs)):
        f = bm.faces.new([vc, vs[i], vs[(i + 1) % len(vs)]])
        if f.normal.y > 0:
            f.normal_flip()
    hull_uv(bm, transom=True)
    new_obj("transom", bm, M["hull"])


def build_decks():
    """Bulwark cap + inner bulwark, aft working deck, sloped shelter end, shelter roof."""
    t = 0.2
    sts = sorted(set([s for s in STATIONS if s < L - 0.05] + [SH0, SH1]))
    bm_w = bmesh.new()
    rows = []
    for s in sts:
        zt, zd = top_z(s), deck_z(s)
        yo = half_breadth(s, zt)
        yi = max(0.0, yo - t)
        ydi = max(0.0, half_breadth(s, zd) - t)
        rows.append([bm_w.verts.new((yo, Y(s), zt)), bm_w.verts.new((yi, Y(s), zt)),
                     bm_w.verts.new((ydi, Y(s), zd))])
    for i in range(len(rows) - 1):
        for j in range(2):
            bm_w.faces.new([rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]])
    bmesh.ops.remove_doubles(bm_w, verts=bm_w.verts, dist=1e-4)
    bmesh.ops.mirror(bm_w, geom=bm_w.verts[:] + bm_w.edges[:] + bm_w.faces[:], axis="X", merge_dist=1e-4)
    bmesh.ops.recalc_face_normals(bm_w, faces=bm_w.faces)
    new_obj("bulwark", bm_w, M["white"])

    def surface(name, s_from, s_to, mat):
        bm = bmesh.new()
        r = []
        for s in [s for s in sts if s_from - 1e-6 <= s <= s_to + 1e-6]:
            zd = deck_z(s)
            yd = max(0.0, half_breadth(s, zd) - t)
            camber = 0.12 if s < SH0 else 0.06
            r.append([bm.verts.new((-yd, Y(s), zd)), bm.verts.new((0.0, Y(s), zd + camber)),
                      bm.verts.new((yd, Y(s), zd))])
        for i in range(len(r) - 1):
            for j in range(2):
                f = bm.faces.new([r[i][j], r[i][j + 1], r[i + 1][j + 1], r[i + 1][j]])
                if f.normal.z < 0:
                    f.normal_flip()
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        return new_obj(name, bm, mat)

    # working deck: cambered plating with the companion opening cut out
    bm = bmesh.new()
    cx0, cx1, cs0, cs1 = COMP
    rows_s = sorted(set([s for s in sts if s <= SH0 + 1e-6] + [cs0, cs1]))

    def zc(x, y):
        return WD_Z + 0.12 * (1 - min(1.0, abs(x) / max(y, 1e-3)))

    for i in range(len(rows_s) - 1):
        sa, sb = rows_s[i], rows_s[i + 1]
        ya = max(0.0, half_breadth(sa, WD_Z) - t)
        yb = max(0.0, half_breadth(sb, WD_Z) - t)
        hole = sa >= cs0 - 1e-6 and sb <= cs1 + 1e-6
        xa = [-ya, 0.0] + ([cx0, cx1] if hole else []) + [ya]
        xb = [-yb, 0.0] + ([cx0, cx1] if hole else []) + [yb]
        for k in range(len(xa) - 1):
            if hole and abs(xa[k] - cx0) < 1e-6:
                continue                                  # the opening
            v = [bm.verts.new((xa[k], Y(sa), zc(xa[k], ya))), bm.verts.new((xa[k + 1], Y(sa), zc(xa[k + 1], ya))),
                 bm.verts.new((xb[k + 1], Y(sb), zc(xb[k + 1], yb))), bm.verts.new((xb[k], Y(sb), zc(xb[k], yb)))]
            f = bm.faces.new(v)
            if f.normal.z < 0:
                f.normal_flip()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    new_obj("working_deck", bm, M["deck"])
    surface("shelter_end", SH0, SH1, M["white"])
    # shelter roof, with the wheelhouse stairwell cut out
    bm = bmesh.new()
    hx0, hx1, hs0, hs1 = WH_HOLE
    rows_s = sorted(set([s for s in sts if s >= SH1 - 1e-6] + [hs0, hs1]))

    def zr_(x, s, yd):
        return deck_z(s) + 0.06 * (1 - min(1.0, abs(x) / max(yd, 1e-3)))

    for i in range(len(rows_s) - 1):
        sa, sb = rows_s[i], rows_s[i + 1]
        ya = max(0.0, half_breadth(sa, deck_z(sa)) - t)
        yb = max(0.0, half_breadth(sb, deck_z(sb)) - t)
        lim = min(ya, yb)
        inner = sorted(set([0.0] + [x for x in (hx0, hx1) if -lim < x < lim]))
        hole = sa >= hs0 - 1e-6 and sb <= hs1 + 1e-6
        xa = [-ya] + inner + [ya]
        xb = [-yb] + inner + [yb]
        for k in range(len(xa) - 1):
            if hole and hx0 - 1e-6 <= (xa[k] + xa[k + 1]) / 2 <= hx1 + 1e-6:
                continue
            v = [bm.verts.new((xa[k], Y(sa), zr_(xa[k], sa, ya))), bm.verts.new((xa[k + 1], Y(sa), zr_(xa[k + 1], sa, ya))),
                 bm.verts.new((xb[k + 1], Y(sb), zr_(xb[k + 1], sb, yb))), bm.verts.new((xb[k], Y(sb), zr_(xb[k], sb, yb)))]
            f = bm.faces.new(v)
            if f.normal.z < 0:
                f.normal_flip()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    new_obj("shelter_roof", bm, M["deck"])
    yi = half_breadth(0.0, WD_Z) - t
    box("transom_bulwark", (0, Y(0.3), (WD_Z + top_z(0)) / 2), (2 * yi, 0.2, top_z(0) - WD_Z), M["white"])
    cyl("stern_roller", (-1.5, Y(0.12), top_z(0) + 0.08), (1.5, Y(0.12), top_z(0) + 0.08), 0.24, M["steel"], seg=16)

    # handrails on top of the bulwark aft and round the shelter deck (photo)
    for side in (-1, 1):
        aft = [(side * (half_breadth(s, top_z(s)) - 0.1), Y(s), top_z(s)) for s in np.linspace(0.35, SH1, 9)]
        railing("rail_aft", aft, 1.0, M["rail_white"], M["orange"])
        fwd = [(side * (half_breadth(s, top_z(s)) - 0.1), Y(s), top_z(s)) for s in np.linspace(SH1, L - 0.6, 14)]
        railing("rail_fwd", fwd, 1.0, M["rail_white"], M["orange"])
    railing("rail_stern", [(-3.7, Y(0.25), top_z(0)), (3.7, Y(0.25), top_z(0))], 1.0, M["rail_white"], M["orange"])


# ------------------------------------------------------------------ appendages
def build_appendages():
    prof = [(2.2, -3.62), (17.5, -3.32), (17.5, keel_z(17.5) + 0.05), (12, keel_z(12) + 0.05),
            (7.0, keel_z(7.0) + 0.05), (4.5, keel_z(4.5) + 0.05), (2.2, keel_z(2.2) + 0.05)]
    extrude_x("skeg", prof, -0.32, 0.32, M["antifoul"])
    zc, sc = -1.95, 1.75
    bm = bmesh.new()
    seg = 32
    rings = []
    for (r, dy) in ((1.40, -0.68), (1.62, -0.43), (1.62, 0.68), (1.40, 0.68)):
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / seg), Y(sc) + dy,
                                    zc + r * math.sin(2 * math.pi * k / seg))) for k in range(seg)])
    for i in range(4):
        r0, r1 = rings[i], rings[(i + 1) % 4]
        for k in range(seg):
            bm.faces.new([r0[k], r0[(k + 1) % seg], r1[(k + 1) % seg], r1[k]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    new_obj("nozzle", bm, M["antifoul"], smooth_shade=True)
    cyl("prop_hub", (0, Y(sc) - 0.45, zc), (0, Y(sc) + 0.45, zc), 0.28, M["steel"], seg=16)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        c = Vector((0.72 * math.cos(a), Y(sc), zc + 0.72 * math.sin(a)))
        panel("blade", c, (math.cos(a), 0.0, math.sin(a)), (-math.sin(a), 0.55, math.cos(a)), 1.1, 0.7,
              M["steel"], depth=0.05)
    box("rudder", (0, Y(0.35), -1.95), (0.22, 1.3, 2.9), M["antifoul"], bevel=0.05)
    for side in (-1, 1):
        pts = [Vector((side * (half_breadth(s, -2.55) + 0.12), Y(s), -2.62)) for s in np.linspace(7.0, 16.0, 10)]
        for i in range(len(pts) - 1):
            p0, p1 = pts[i], pts[i + 1]
            panel("bilge_keel", (p0 + p1) / 2, p1 - p0, (side * 0.7, 0, -0.7), (p1 - p0).length, 0.35,
                  M["antifoul"], depth=0.04)
    # rubbing strakes: half-round steel along the pinstripe and the red line
    for side in (-1, 1):
        for zf, mat in ((pin_z, M["white"]), (red_z, M["red"])):
            s_end = min(stem_s(zf(L)) - 0.6, L - 0.6)
            pts = [Vector((side * (half_breadth(s, zf(s)) + 0.04), Y(s), zf(s) + (0.045 if zf is pin_z else 0.0)))
                   for s in np.linspace(0.05, s_end, 26)]
            for i in range(len(pts) - 1):
                cyl("strake", pts[i], pts[i + 1], 0.06, mat, seg=8)


# ------------------------------------------------------------------ bridge interior
def build_bridge(z0, z1, hw):
    """Wheelhouse interior: forward console with screens, helm chair,
    steering wheel and engine levers, overhead radios, chart table, bench."""
    C = M["console"]
    # forward console under the windows, top sloping up towards the glass
    s_b, s_f = WH1 - 0.8, WH1 - 0.05
    solid("console_fwd", [(-hw + 0.12, Y(s_b), z0), (hw - 0.12, Y(s_b), z0), (hw - 0.12, Y(s_f), z0), (-hw + 0.12, Y(s_f), z0)],
          [(-hw + 0.12, Y(s_b), z0 + 0.82), (hw - 0.12, Y(s_b), z0 + 0.82), (hw - 0.12, Y(s_f), z0 + 0.98),
           (-hw + 0.12, Y(s_f), z0 + 0.98)], C, bevel=0.02)
    tilt = Vector((0, 0.45, 1)).normalized()
    for i, x in enumerate((-2.3, -1.15, 0.0, 1.15, 2.3)):
        c = Vector((x, Y(WH1 - 0.32), z0 + 1.17))
        panel("screen_bezel", c, (1, 0, 0), tilt, 0.62, 0.42, C, 0.05)
        panel("screen", c - Vector((0, 0.03, 0)), (1, 0, 0), tilt, 0.56, 0.36,
              M["radar_screen"] if i == 2 else M["screen"], 0.02)
    # helm: steering wheel on the console, engine levers to starboard
    torus("helm_wheel", (0.0, Y(WH1 - 0.85), z0 + 1.05), (0, 0.6, 0.8), 0.24, 0.022, M["dark"])
    cyl("helm_hub", (0.0, Y(WH1 - 0.85), z0 + 1.05), (0.0, Y(WH1 - 0.7), z0 + 0.95), 0.04, M["steel"], seg=8)
    box("engine_stand", (0.75, Y(WH1 - 1.0), z0 + 0.45), (0.35, 0.35, 0.9), C, bevel=0.02)
    for x in (0.68, 0.82):
        cyl("engine_lever", (x, Y(WH1 - 1.0), z0 + 0.9), (x, Y(WH1 - 0.95), z0 + 1.15), 0.015, M["steel"], seg=5)
        sphere("lever_knob", (x, Y(WH1 - 0.95), z0 + 1.17), 0.035, M["red"], seg=8)
    # helm chair on a pedestal
    for (cx, cs) in ((0.0, WH1 - 1.45), (1.7, WH1 - 1.35)):
        cyl("chair_post", (cx, Y(cs), z0), (cx, Y(cs), z0 + 0.48), 0.06, M["steel"], seg=8)
        cyl("chair_foot", (cx, Y(cs), z0), (cx, Y(cs), z0 + 0.04), 0.3, M["steel"], seg=12)
        box("chair_seat", (cx, Y(cs), z0 + 0.53), (0.55, 0.55, 0.12), M["seat"], bevel=0.03)
        box("chair_back", (cx, Y(cs) - 0.27, z0 + 0.95), (0.52, 0.1, 0.75), M["seat"], bevel=0.03)
        for sx in (-0.3, 0.3):
            box("chair_arm", (cx + sx, Y(cs) + 0.02, z0 + 0.75), (0.07, 0.42, 0.06), M["seat"])
    # overhead console with radios
    box("overhead", (0, Y(WH1 + 0.05), z1 - 0.1), (2 * hw - 1.2, 0.5, 0.18), C, bevel=0.01)
    for i, x in enumerate(np.linspace(-2.2, 2.2, 7)):
        panel("radio_face", (x, Y(WH1 - 0.21), z1 - 0.1), (1, 0, 0), (0, 0, 1), 0.5, 0.12,
              M["radar_screen"] if i % 3 == 0 else M["dark"], 0.02)
    # chart table (port aft) and bench (starboard aft)
    box("chart_table", (-hw + 0.75, Y(WH0 + 0.55), z0 + 0.47), (1.2, 0.9, 0.94), M["wood"], bevel=0.02)
    panel("chart_lamp", (-hw + 0.75, Y(WH0 + 0.55), z0 + 1.5), (1, 0, 0), (0, 1, 0), 0.25, 0.15, M["white_light"], 0.03)
    box("bench_seat", (hw - 0.9, Y(WH0 + 0.4), z0 + 0.23), (1.4, 0.55, 0.46), M["seat"], bevel=0.03)
    box("bench_back", (hw - 0.9, Y(WH0 + 0.15), z0 + 0.7), (1.4, 0.1, 0.5), M["seat"], bevel=0.03)


# ------------------------------------------------------------------ superstructure
def build_superstructure():
    W, O = M["white"], M["orange"]
    zr = top_z(WH0) - 0.15                     # shelter roof under the wheelhouse
    hw = 3.35
    z0, z1 = zr + 0.15, 7.45                   # wheelhouse floor (door sill) and ceiling
    H = z1 - z0
    box_hole("wh_plinth", -hw, hw, WH0, WH1, zr + 0.06, 0.12, W, WH_HOLE)
    box_hole("wh_floor", -hw + 0.05, hw - 0.05, WH0, WH1 + 0.2, z0 - 0.015, 0.03, M["floor"], WH_HOLE)
    wb0, wb1 = 0.95, 1.85                      # window band above the floor (drawing)
    wall("wh_aft", (-hw, Y(WH0), z0), (1, 0, 0), (0, 0, 1), 2 * hw, H,
         [(x + hw - 0.5, x + hw + 0.5, wb0, wb1, True) for x in (-2.1, -0.7, 0.7, 2.1)], W, M["glass"])
    for side in (-1, 1):
        ops = [(12.75 - WH0, 13.5 - WH0, 0.0, 1.95, False)] + \
              [(sv - WH0 - 0.45, sv - WH0 + 0.45, wb0, wb1, True) for sv in (14.9, 15.95, 17.0)]
        wall("wh_side", (side * hw, Y(WH0), z0), (0, 1, 0), (0, 0, 1), WH1 - WH0, H, ops, W, M["glass"])
        tri_x("wh_side_front", [(WH1, z0), (WH1 + WH_LEAN, z1), (WH1, z1)], side * hw - 0.04, side * hw + 0.04, W)
        # door leaf hooked open forward against the wall, with a porthole
        panel("wh_door", (side * (hw + 0.07), Y(13.875), z0 + 0.975), (0, 1, 0), (0, 0, 1), 0.75, 1.95, W, 0.05)
        panel("wh_door_win", (side * (hw + 0.1), Y(13.875), z0 + 1.45), (0, 1, 0), (0, 0, 1), 0.32, 0.38, M["glass"], 0.02)
        for sv in (12.65, 13.6):
            cyl("grab_rail", (side * (hw + 0.09), Y(sv), z0 + 0.4), (side * (hw + 0.09), Y(sv), z0 + 1.7), 0.02, M["steel"], seg=6)
        box("nav_screen", (side * (hw + 0.2), Y(17.6), z1 - 0.15), (0.06, 0.6, 0.35), M["dark"])
        box("nav_light", (side * (hw + 0.3), Y(17.75), z1 - 0.15), (0.12, 0.25, 0.22),
            M["green_light"] if side > 0 else M["red_light"])
    slope_len = math.hypot(WH_LEAN, H)
    up_f = Vector((0, WH_LEAN, H)) / slope_len
    k = slope_len / H
    wins = 5
    ww, gap = 1.15, 0.12
    margin = (2 * hw - wins * ww - (wins - 1) * gap) / 2
    front_ops = [(margin + i * (ww + gap), margin + i * (ww + gap) + ww, wb0 * k, (wb1 + 0.03) * k, True)
                 for i in range(wins)]
    wall("wh_front", (-hw, Y(WH1), z0), (1, 0, 0), up_f, 2 * hw, slope_len, front_ops, W, M["glass"])
    # pantograph wipers on the front windows
    nrm_f = Vector((1, 0, 0)).cross(up_f).normalized()
    for (a0, a1, b0, b1, _) in front_ops:
        base = Vector((-hw + (a0 + a1) / 2, Y(WH1), z0)) + up_f * (b0 + 0.08) - nrm_f * 0.05
        cyl("wiper", base, base + up_f * 0.55 + Vector((0.18, 0, 0)), 0.012, M["dark"], seg=4)
    box("wh_ceiling", (0, Y((WH0 + WH1) / 2 + 0.2), z1 - 0.02), (2 * hw - 0.1, WH1 - WH0 + 0.35, 0.03), M["rail_white"])
    ov = 0.28
    solid("wh_fascia", [(-hw - ov, Y(WH0 - ov), z1), (hw + ov, Y(WH0 - ov), z1),
                        (hw + ov, Y(WH1 + WH_LEAN + ov), z1), (-hw - ov, Y(WH1 + WH_LEAN + ov), z1)],
          [(-hw - ov, Y(WH0 - ov), z1 + 0.42), (hw + ov, Y(WH0 - ov), z1 + 0.42),
           (hw + ov, Y(WH1 + WH_LEAN + ov + 0.15), z1 + 0.42), (-hw - ov, Y(WH1 + WH_LEAN + ov + 0.15), z1 + 0.42)],
          O, bevel=0.03)
    zt = z1 + 0.42
    build_bridge(z0, z1, hw)
    # exhaust trunk from below up to the funnel on the roof (aft, starboard)
    box("uptake_casing", (sum(UPTAKE) / 2, Y(12.925), (z0 + z1) / 2), (UPTAKE[1] - UPTAKE[0], 0.7, z1 - z0),
        M["rail_white"], bevel=0.02)
    railing("wh_rail", [(-hw - 0.15, Y(WH0 - 0.15), zt), (hw + 0.15, Y(WH0 - 0.15), zt),
                        (hw + 0.15, Y(WH1 + WH_LEAN + 0.3), zt), (-hw - 0.15, Y(WH1 + WH_LEAN + 0.3), zt)],
            0.85, M["rail_white"], O, closed=True)

    top = 12.7
    for x in (-0.55, 0.55):
        cyl("mast_fwd", (x, Y(14.9), zt), (x * 0.4, Y(14.15), top), 0.09, W, seg=8)
        cyl("mast_aft", (x, Y(13.3), zt), (x * 0.4, Y(13.85), top), 0.09, W, seg=8)
        for zz in np.arange(zt + 0.9, top - 0.4, 0.9):
            f = (zz - zt) / (top - zt)
            cyl("mast_rung", (x * lerp(1, 0.4, f), Y(lerp(13.3, 13.85, f)), zz),
                (x * lerp(1, 0.4, f), Y(lerp(14.9, 14.15, f)), zz), 0.03, W, seg=5)
    for (zp, s0, s1, w, rlen) in ((8.95, 13.4, 16.1, 1.9, 3.6), (10.35, 13.6, 15.7, 1.6, 2.6)):
        box("radar_platform", (0, Y((s0 + s1) / 2), zp), (w, s1 - s0, 0.14), W)
        box("radar_platform_under", (0, Y((s0 + s1) / 2), zp - 0.12), (w * 0.96, (s1 - s0) * 0.96, 0.12), O)
        railing("plat_rail", [(-w / 2, Y(s0), zp + 0.07), (w / 2, Y(s0), zp + 0.07), (w / 2, Y(s1), zp + 0.07),
                              (-w / 2, Y(s1), zp + 0.07)], 0.75, M["rail_white"], M["rail_white"], closed=True, gap=0.9)
        box("radar_ped", (0, Y(s1 - 0.4), zp + 0.3), (0.45, 0.45, 0.45), M["radar"], bevel=0.03)
        box("radar_array", (0, Y(s1 - 0.4), zp + 0.62), (rlen, 0.3, 0.32), M["radar"], bevel=0.05)
    box("yard", (0, Y(14.0), top - 0.6), (2.6, 0.12, 0.12), W)
    for x in (-1.25, 1.25):
        sphere("yard_light", (x, Y(14.0), top - 0.45), 0.09, M["white_light"], seg=8)
    sphere("masthead_light", (0, Y(14.15), top + 0.12), 0.14, M["white_light"], seg=10)
    cyl("gaff", (0, Y(13.9), top - 1.4), (0, Y(12.6), top - 0.6), 0.04, W, seg=6)
    panel("ensign", (0, Y(12.2), top - 1.05), (0, 1, 0), (0, 0, 1), 0.9, 0.55, M["flag"], 0.01)
    sphere("radome_big", (-1.6, Y(13.0), zt + 0.55), 0.55, W, squash=0.95)
    cyl("radome_big_base", (-1.6, Y(13.0), zt), (-1.6, Y(13.0), zt + 0.3), 0.3, W, seg=12)
    sphere("radome_small", (1.9, Y(17.4), zt + 0.35), 0.32, W)
    for (x, s) in ((2.9, 18.2), (-2.9, 18.2), (2.6, 12.6)):
        cyl("whip", (x, Y(s), zt), (x, Y(s), zt + 4.6), 0.022, M["rail_white"], seg=5)
    cyl("searchlight_stand", (1.0, Y(18.0), zt), (1.0, Y(18.0), zt + 0.5), 0.07, M["dark"], seg=8)
    cyl("searchlight", (1.0, Y(17.8), zt + 0.65), (1.0, Y(18.35), zt + 0.65), 0.22, M["yellow"], seg=14)
    cyl("exhaust", (1.3, Y(12.9), zt), (1.3, Y(12.9), zt + 1.1), 0.32, W, seg=14)
    cyl("exhaust_top", (1.3, Y(12.9), zt + 1.1), (1.3, Y(12.9), zt + 1.35), 0.26, M["dark"], seg=14)
    cyl("horn", (-0.8, Y(15.6), zt + 0.25), (-0.8, Y(16.1), zt + 0.32), 0.08, M["steel"], seg=8, r2=0.14)

    for x in (-3.9, 3.9):
        torus("lifebuoy", (x, Y(18.9), zr + 0.65), (1, 0, 0), 0.3, 0.07, O)
    for side in (-1, 1):
        cyl("liferaft", (side * 2.6, Y(12.45), zt + 0.42), (side * 2.6, Y(13.55), zt + 0.42), 0.33, M["rail_white"], seg=16)
        box("liferaft_cradle", (side * 2.6, Y(13.0), zt + 0.06), (0.6, 1.1, 0.12), M["steel"])
    slope = Vector((0, SH1 - SH0, top_z(SH1) - 0.15 - WD_Z)).normalized()
    for x in (-2.4, 2.4):
        c = Vector((x, Y((SH0 + SH1) / 2) - 0.06, (WD_Z + top_z(SH1) - 0.15) / 2 + 0.05))
        panel("shelter_door", c, (1, 0, 0), slope, 0.8, 1.15, M["dark"], 0.05)
    zf = deck_z(21.0)
    box("windlass", (0, Y(21.0), zf + 0.4), (1.5, 0.9, 0.7), M["machinery"], bevel=0.04)
    cyl("windlass_drum", (-1.05, Y(21.0), zf + 0.45), (1.05, Y(21.0), zf + 0.45), 0.28, M["steel"], seg=16)
    for side in (-1, 1):
        for s in (20.0, 5.0, 0.9):
            z = deck_z(s)
            x = side * (half_breadth(s, top_z(s)) - 0.65)
            for dy in (-0.25, 0.25):
                cyl("bollard", (x, Y(s) + dy, z), (x, Y(s) + dy, z + 0.55), 0.13, M["dark"], seg=12)


# ------------------------------------------------------------------ fishing gear
def build_gear():
    W, O = M["white"], M["orange"]
    head = 8.75
    for side in (-1, 1):
        x = side * 3.7
        prof = [(4.2, WD_Z), (5.45, WD_Z), (2.95, head), (2.3, head)]
        extrude_x("gantry_leg", prof, x - 0.24, x + 0.24, W, bevel=0.04)
        cyl("block_pennant", (side * 2.5, Y(2.6), head - 0.2), (side * 2.5, Y(2.6), head - 1.35), 0.03, M["dark"], seg=5)
        cyl("trawl_block", (side * 2.5 - 0.12, Y(2.6), head - 1.6), (side * 2.5 + 0.12, Y(2.6), head - 1.6), 0.34, M["dark"], seg=16)
    box("gantry_head", (0, Y(2.62), head + 0.2), (8.0, 0.85, 0.5), W, bevel=0.04)
    box("gantry_cap", (0, Y(2.62), head + 0.5), (8.1, 0.95, 0.12), O)
    railing("gantry_rail", [(-3.9, Y(2.2), head + 0.56), (3.9, Y(2.2), head + 0.56),
                            (3.9, Y(3.05), head + 0.56), (-3.9, Y(3.05), head + 0.56)], 0.8, M["rail_white"], O,
            closed=True, gap=1.0)
    for x in (-3.2, 3.2):
        box("gantry_flood", (x, Y(2.2), head + 0.1), (0.3, 0.15, 0.22), M["white_light"])

    zc, R = WD_Z + 1.15, 1.1
    for s in (5.5, 6.95):
        for side in (-1, 1):
            x0, x1 = side * 0.3, side * 2.4
            cyl("drum_core", (x0, Y(s), zc), (x1, Y(s), zc), 0.92, M["net"], seg=24)
            for xf in (x0, x1):
                cyl("drum_flange", (xf - side * 0.04, Y(s), zc), (xf + side * 0.04, Y(s), zc), R, M["drum"], seg=24)
            cyl("drum_shaft", (x0, Y(s), zc), (x1 + side * 0.25, Y(s), zc), 0.12, M["steel"], seg=10)
            box("drum_stand", (x1 + side * 0.25, Y(s), WD_Z + 0.6), (0.3, 0.6, 1.2), M["machinery"])
        box("drum_motor", (0, Y(s), WD_Z + 0.6), (0.6, 0.7, 1.2), M["machinery"], bevel=0.03)

    for x in (-2.6, 0.0, 2.6):
        s = 9.1
        box("winch_frame", (x, Y(s), WD_Z + 0.42), (1.4, 1.0, 0.84), M["machinery"], bevel=0.04)
        cyl("winch_drum", (x - 0.5, Y(s), WD_Z + 0.68), (x + 0.5, Y(s), WD_Z + 0.68), 0.4, M["steel"], seg=18)
    cx, cs = -2.9, 7.85
    cyl("crane_pedestal", (cx, Y(cs), WD_Z), (cx, Y(cs), WD_Z + 2.2), 0.32, W, seg=16)
    cyl("crane_slew", (cx, Y(cs), WD_Z + 2.2), (cx, Y(cs), WD_Z + 2.55), 0.45, O, seg=16)
    j1 = Vector((cx, Y(cs), WD_Z + 2.45))
    j2 = Vector((cx + 0.2, Y(11.6), 6.55))
    j3 = Vector((cx + 0.35, Y(9.4), 6.2))
    cyl("crane_boom", j1, j2, 0.2, W, seg=8)
    cyl("crane_boom", j2, j3, 0.15, W, seg=8)
    cyl("crane_hook", j3, j3 - Vector((0, 0, 0.9)), 0.02, M["dark"], seg=5)
    for side in (-1, 1):
        cyl("warp", (side * 2.6, Y(9.1) - 0.4, WD_Z + 0.9), (side * 2.5, Y(2.6), head - 1.6), 0.018, M["dark"], seg=4)


# ------------------------------------------------------------------ working details
def build_details():
    W, O = M["white"], M["orange"]
    head = 8.75
    zc = WD_Z + 1.15
    rng = np.random.default_rng(5)
    # knees stiffening the working-deck bulwark
    for side in (-1, 1):
        for sv in np.arange(0.75, SH0 - 0.2, 0.6):
            xi = side * (half_breadth(sv, top_z(sv)) - 0.2)
            plate_y("bulwark_knee", [(xi, WD_Z), (xi, top_z(sv) - 0.06), (xi - side * 0.3, WD_Z)], sv, 0.02, W)
    # stair from the working deck up to the shelter deck
    rise = (top_z(SH1) - 0.15 - WD_Z) / 5
    run = (SH1 - (SH0 - 0.6)) / 5
    for kk in range(1, 6):
        s_k = SH0 - 0.6 + run * (kk - 1)
        box("stair_step", (STAIR_X, Y((s_k + SH1) / 2), WD_Z + rise * kk / 2), (0.8, SH1 - s_k, rise * kk), M["machinery"])
    xs = STAIR_X - 0.44
    cyl("stair_rail", (xs, Y(SH0 - 0.6), WD_Z + 1.0), (xs, Y(SH1), top_z(SH1) - 0.15 + 1.0), 0.025, M["rail_white"], seg=6)
    cyl("stair_post", (xs, Y(SH0 - 0.6), WD_Z), (xs, Y(SH0 - 0.6), WD_Z + 1.0), 0.025, M["rail_white"], seg=6)
    # vertical ladders: wheelhouse roof, gantry head
    zr = top_z(WH0) - 0.15
    ladder("wh_ladder", (2.75, Y(WH0) - 0.18, zr), (2.75, Y(WH0) - 0.18, 7.87 + 0.85), (0.2, 0, 0), M["steel"])
    ladder("gantry_ladder", (3.3, Y(5.0), WD_Z + 0.2), (3.3, Y(2.75), head + 0.5), (0, 0.2, 0), M["steel"])
    # hydraulic lines up the gantry legs and along the deck
    for side in (-1, 1):
        for kk in range(3):
            cyl("hyd_pipe", (side * 3.43, Y(5.2) + kk * 0.07, WD_Z + 0.05), (side * 3.43, Y(2.85) + kk * 0.07, head - 0.05),
                0.022, M["dark"], seg=5)
        cyl("deck_pipe", (side * 1.0, Y(8.6), WD_Z + 0.06), (side * 1.0, Y(6.0), WD_Z + 0.06), 0.035, M["dark"], seg=6)
    # trawl doors (otter boards) hanging at the stern quarters
    for side in (-1, 1):
        x = side * (half_breadth(2.4, 5.0) + 0.22)
        box("trawl_door", (x, Y(2.4), 5.35), (0.1, 2.3, 1.3), M["doors"], bevel=0.02)
        box("door_shoe", (x, Y(2.4), 4.68), (0.18, 2.35, 0.14), M["doors"])
        for dy in (-0.7, 0.0, 0.7):
            box("door_bracket", (x + side * 0.12, Y(2.4) + dy, 5.45), (0.14, 0.08, 0.9), M["doors"])
        cyl("door_chain", (x + side * 0.15, Y(2.4), 6.0), (side * 3.6, Y(2.6), head - 0.2), 0.03, M["dark"], seg=5)
    # floats and net bundles on the drums
    for sv in (5.5, 6.95):
        for side in (-1, 1):
            for kk in range(6):
                sphere("trawl_float", (side * (0.55 + kk * 0.33), Y(sv) + rng.uniform(-0.25, 0.25),
                                       zc + 0.95 + rng.uniform(0, 0.05)), 0.11, M["float"], seg=10)
            for kk in range(3):
                sphere("net_bundle", (side * rng.uniform(0.6, 2.1), Y(sv) + rng.uniform(-0.4, 0.4), zc + 0.75),
                       rng.uniform(0.35, 0.55), M["net"], seg=12, squash=0.45)
    # stacked fish boxes by the shelter end
    for side in (-1, 1):
        for kk in range(4):
            box("fish_box", (side * 2.4 + rng.uniform(-0.03, 0.03), Y(10.25) + rng.uniform(-0.03, 0.03),
                             WD_Z + 0.15 + kk * 0.29), (0.55, 0.8, 0.27), M["box"], bevel=0.02)
    # tyre fenders over the side
    for side in (-1, 1):
        for sv in (7.0, 13.5, 17.5):
            zt = top_z(sv)
            x_out = side * (half_breadth(sv, zt - 1.1) + 0.16)
            torus("fender", (x_out, Y(sv), zt - 1.15), (1, 0, 0), 0.36, 0.12, M["tyre"])
            cyl("fender_rope", (side * (half_breadth(sv, zt) - 0.1), Y(sv), zt + 0.05), (x_out, Y(sv), zt - 0.8),
                0.015, M["rope"], seg=4)
    # coiled mooring ropes
    for (sv, side) in ((5.0, -1), (19.4, 1), (1.6, 1)):
        zd = deck_z(sv)
        x = side * (half_breadth(sv, top_z(sv)) - 1.25)
        for kk, rr in enumerate((0.36, 0.31, 0.26)):
            torus("rope_coil", (x, Y(sv), zd + 0.04 + kk * 0.07), (0, 0, 1), rr, 0.04, M["rope"])
    # vents, scuttle and hatches
    zf = top_z(20.0) - 0.15
    for side in (-1, 1):
        cyl("mushroom_vent", (side * 1.7, Y(19.7), zf), (side * 1.7, Y(19.7), zf + 0.5), 0.12, W, seg=12)
        cyl("mushroom_cap", (side * 1.7, Y(19.7), zf + 0.5), (side * 1.7, Y(19.7), zf + 0.6), 0.26, W, seg=14)
        cyl("goose_vent", (side * 3.3, Y(20.6), zf), (side * 3.3, Y(20.6), zf + 0.65), 0.07, W, seg=8)
        cyl("goose_bend", (side * 3.3, Y(20.6), zf + 0.65), (side * 3.3, Y(20.6) - 0.22, zf + 0.5), 0.07, W, seg=8)
        box("fire_box", (side * 3.45, Y(SH0) + 0.05, WD_Z + 0.75), (0.45, 0.22, 0.6), M["red"], bevel=0.02)
        torus("lifebuoy_aft", (side * 3.95, Y(1.2), top_z(1.2) + 0.55), (1, 0, 0), 0.3, 0.07, O)
    box("scuttle", (0, Y(19.0), zf + 0.18), (0.8, 0.8, 0.36), W, bevel=0.03)
    box("hopper_hatch", (0.6, Y(8.15), WD_Z + 0.03), (1.4, 0.9, 0.06), M["dark"])
    for (dx, dy) in ((-0.6, -0.38), (0.6, -0.38), (-0.6, 0.38), (0.6, 0.38)):
        cyl("hatch_dog", (0.6 + dx, Y(8.15) + dy, WD_Z + 0.06), (0.6 + dx, Y(8.15) + dy, WD_Z + 0.14), 0.03, M["steel"], seg=6)
    # anchors in the bow pockets
    for side in (-1, 1):
        xa = side * (half_breadth(21.95, 3.72) + 0.04)
        cyl("anchor_shank", (xa, Y(21.95), 3.5), (xa, Y(21.95), 3.95), 0.05, M["dark"], seg=8)
        for d in (-1, 1):
            box("anchor_fluke", (xa, Y(21.95) + d * 0.16, 3.5), (0.08, 0.3, 0.1), M["dark"])
        torus("anchor_ring", (xa, Y(21.95), 4.0), (1, 0, 0), 0.06, 0.015, M["dark"])
    # mast stays, floodlights and antennas
    zt = 7.87
    for (x, sv) in ((-3.1, 12.4), (3.1, 12.4), (-3.1, 18.4), (3.1, 18.4)):
        cyl("stay", (0, Y(14.0), 12.4), (x, Y(sv), zt + 0.05), 0.01, M["dark"], seg=4)
    for (x, sv, z, face) in ((-0.7, 16.15, 8.75, 1), (0.7, 16.15, 8.75, 1), (-3.0, 12.0, zt + 0.35, -1),
                             (3.0, 12.0, zt + 0.35, -1), (-2.2, 3.1, head - 0.15, 1), (2.2, 3.1, head - 0.15, 1)):
        box("flood_housing", (x, Y(sv), z), (0.32, 0.22, 0.26), M["dark"], bevel=0.02)
        panel("flood_lens", (x, Y(sv) + face * 0.115, z), (1, 0, 0), (0, 0, 1), 0.26, 0.2, M["white_light"], 0.01)
    for (x, sv) in ((2.3, 18.7), (-2.3, 18.7), (0.6, 12.0)):
        cyl("gps_post", (x, Y(sv), zt + 0.85), (x, Y(sv), zt + 1.15), 0.02, M["rail_white"], seg=5)
        sphere("gps_dome", (x, Y(sv), zt + 1.2), 0.09, M["rail_white"], seg=10, squash=0.7)
    # vertical rubbing bars at the transom corners
    for side in (-1, 1):
        x = side * (half_breadth(0.05, 2.5) - 0.02)
        cyl("stern_fender", (x, Y(0.02), 0.6), (x, Y(0.02), top_z(0) - 0.1), 0.08, M["red"], seg=8)


# ------------------------------------------------------------------ collision (walkable decks + walls)

# ------------------------------------------------------------------ below decks
INTERIOR = set()


def plain(name, color, rough=0.6, metal=0.0, emit=None, strength=1.0):
    """Untextured material for the interior (not baked into the atlas)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    INTERIOR.add(m)
    return m


MI = {
    "lining": plain("int_lining", (0.74, 0.76, 0.73), 0.6),
    "er_wall": plain("int_er_wall", (0.5, 0.58, 0.54), 0.55),
    "hold": plain("int_hold", (0.86, 0.88, 0.88), 0.35),
    "ceiling": plain("int_ceiling", (0.82, 0.82, 0.8), 0.7),
    "floor": plain("int_floor_steel", (0.2, 0.25, 0.23), 0.8),
    "plate": plain("int_floor_plate", (0.27, 0.28, 0.29), 0.45, 0.6),
    "lino": plain("int_lino", (0.3, 0.2, 0.13), 0.5),
    "wood": plain("int_wood", (0.52, 0.35, 0.2), 0.5),
    "ss": plain("int_stainless", (0.7, 0.72, 0.73), 0.3, 0.9),
    "engine": plain("int_engine", (0.16, 0.3, 0.24), 0.45, 0.2),
    "cast": plain("int_cast", (0.5, 0.5, 0.52), 0.45, 0.6),
    "black": plain("int_black", (0.035, 0.035, 0.04), 0.6),
    "fabric": plain("int_fabric", (0.1, 0.17, 0.38), 0.9),
    "oilskin": plain("int_oilskin", (0.95, 0.62, 0.04), 0.5),
    "box": plain("int_fishbox", (0.04, 0.16, 0.48), 0.5),
    "box2": plain("int_fishbox_white", (0.85, 0.86, 0.84), 0.5),
    "ice": plain("int_ice", (0.86, 0.93, 0.98), 0.15),
    "white": plain("int_appliance", (0.9, 0.9, 0.88), 0.35),
    "red": plain("int_red", (0.65, 0.05, 0.04), 0.45),
    "yellow": plain("int_safety_yellow", (0.88, 0.66, 0.04), 0.5),
    "blue_pipe": plain("int_pipe_blue", (0.08, 0.25, 0.55), 0.5),
    "net": plain("int_net", (0.06, 0.22, 0.11), 0.95),
    "float": plain("int_float", (0.92, 0.36, 0.03), 0.5),
    "rope": plain("int_rope", (0.5, 0.43, 0.3), 0.95),
    "tube": plain("light_int_tube", (0.9, 0.9, 0.85), 0.5, emit=(1.0, 0.97, 0.9), strength=4.0),
    "porthole": plain("light_int_porthole", (0.6, 0.7, 0.8), 0.1, emit=(0.72, 0.82, 0.95), strength=1.2),
    "led_g": plain("light_int_led_green", (0.1, 0.5, 0.1), 0.4, emit=(0.2, 1.0, 0.3), strength=3.0),
    "led_r": plain("light_int_led_red", (0.5, 0.1, 0.1), 0.4, emit=(1.0, 0.15, 0.1), strength=3.0),
    "tv": plain("light_int_tv", (0.05, 0.08, 0.12), 0.2, emit=(0.15, 0.3, 0.5), strength=1.5),
}
CM = None   # collision material, set in build_interior


def hbi(sv, z, inset=0.12):
    return max(0.0, half_breadth(sv, z) - inset)


def cbox(c, size):
    box("col_int", c, size, CM)


def fbox(name, c, size, mat, col=True, bevel=0.0):
    box(name, c, size, mat, bevel=bevel)
    if col:
        cbox(c, size)


def lining(name, s0, s1, zf, zc, mat, inset=0.12, step=0.4, col=True):
    """The ship's side seen from inside, both sides, facing the centreline."""
    n = max(2, int(math.ceil((s1 - s0) / step)) + 1)
    ss = np.linspace(s0, s1, n)
    zs = np.linspace(zf, zc, 5)
    for side in (-1, 1):
        bm = bmesh.new()
        grid = [[bm.verts.new((side * hbi(sv, zv, inset), Y(sv), zv)) for zv in zs] for sv in ss]
        for i in range(n - 1):
            for k in range(len(zs) - 1):
                f = bm.faces.new([grid[i][k], grid[i + 1][k], grid[i + 1][k + 1], grid[i][k + 1]])
                f.normal_update()
                if f.normal.x * side > 0:
                    f.normal_flip()
        new_obj(name, bm, mat)
        if col:   # walls for walking: at the height of the player's rays
            pts = [(sv, side * (hbi(sv, zf + 1.0, inset) + 0.02)) for sv in ss]
            for (sa, xa), (sb, xb) in zip(pts[:-1], pts[1:]):
                c = Vector(((xa + xb) / 2, Y((sa + sb) / 2), zf + 1.2))
                d = Vector((xb - xa, sb - sa, 0))
                panel("col_lining", c, d, (0, 0, 1), d.length + 0.06, 2.4, CM, 0.2)


def floor_grid(name, s0, s1, z, mat, holes=(), inset=0.12, up=True, step=0.5, zw=None):
    """Deck plating between the sides at height z, with rectangular holes
    (x0, x1, sA, sB). zw: height at which the hull width is taken."""
    zw = z if zw is None else zw
    cuts = set(np.linspace(s0, s1, max(2, int(math.ceil((s1 - s0) / step)) + 1)).tolist())
    for h in holes:
        for sv in (h[2], h[3]):
            if s0 < sv < s1:
                cuts.add(sv)
    ss = sorted(cuts)
    bm = bmesh.new()
    for i in range(len(ss) - 1):
        sa, sb = ss[i], ss[i + 1]
        ya, yb = hbi(sa, zw, inset), hbi(sb, zw, inset)
        if ya < 0.05 and yb < 0.05:
            continue
        act = [h for h in holes if h[2] - 1e-6 <= sa and sb <= h[3] + 1e-6]
        lim = min(ya, yb)
        inner = sorted(set(x for h in act for x in (h[0], h[1]) if -lim < x < lim))
        xa = [-ya] + inner + [ya]
        xb = [-yb] + inner + [yb]
        for k in range(len(xa) - 1):
            xm = (xa[k] + xa[k + 1]) / 2
            if any(h[0] - 1e-6 <= xm <= h[1] + 1e-6 for h in act):
                continue
            v = [bm.verts.new((xa[k], Y(sa), z)), bm.verts.new((xa[k + 1], Y(sa), z)),
                 bm.verts.new((xb[k + 1], Y(sb), z)), bm.verts.new((xb[k], Y(sb), z))]
            f = bm.faces.new(v)
            f.normal_update()
            if (f.normal.z < 0) == up:
                f.normal_flip()
    return new_obj(name, bm, mat)


def bulkhead(name, sv, zf, zc, mat, door=None, inset=0.12, t=0.06, col=True):
    """Transverse bulkhead filling the hull section, with an optional door
    opening (x0, x1, height)."""
    zs = np.linspace(zf, zc, 6)
    left = [(-hbi(sv, z, inset), z) for z in zs]
    right = [(hbi(sv, z, inset), z) for z in zs]
    polys = []
    if door is None:
        polys.append(left + list(reversed(right)))
    else:
        x0, x1, h = door
        polys.append(left + [(x0, zc), (x0, zf)])
        polys.append([(x1, zf), (x1, zc)] + list(reversed(right)))
        polys.append([(x0, zf + h), (x1, zf + h), (x1, zc), (x0, zc)])
        # door frame
        for xx in (x0, x1):
            box(name + "_frame", (xx, Y(sv), zf + h / 2), (0.06, t + 0.06, h), MI["black"])
        box(name + "_frame", ((x0 + x1) / 2, Y(sv), zf + h), (x1 - x0 + 0.06, t + 0.06, 0.06), MI["black"])
    for poly in polys:
        plate_y(name, poly, sv, t, mat)
        if col:
            plate_y("col_bulkhead", poly, sv, 0.24, CM)


def stair(name, top, bot, half_w, col=True, rail=True):
    """Ship's stair (about 42 deg), treads + stringers + handrails, and its
    walking ramp. Axis-aligned along x or along the ship."""
    top, bot = Vector(top), Vector(bot)
    d = top - bot
    run = Vector((d.x, d.y, 0.0))
    rd = run.normalized()
    side = Vector((-rd.y, rd.x, 0.0))
    n = max(3, int(math.ceil(abs(d.z) / 0.21)))
    for k in range(n):
        c = bot + run * ((k + 0.5) / n) + Vector((0, 0, d.z * (k + 1) / n - 0.025))
        sx = abs(rd.x) * run.length / n + abs(side.x) * 2 * half_w
        sy = abs(rd.y) * run.length / n + abs(side.y) * 2 * half_w
        box(name + "_tread", c, (sx + 0.02, sy + 0.02, 0.05), MI["plate"])
    for sg in (-1, 1):
        o = side * (half_w + 0.03) * sg
        cyl(name + "_stringer", bot + o + Vector((0, 0, -0.08)), top + o + Vector((0, 0, -0.08)), 0.05, MI["yellow"], seg=6)
        if rail:
            cyl(name + "_rail", bot + o + Vector((0, 0, 0.9)), top + o + Vector((0, 0, 0.9)), 0.025, MI["yellow"], seg=6)
            for f in (0.08, 0.5, 0.92):
                p = bot.lerp(top, f) + o
                cyl(name + "_post", p, p + Vector((0, 0, 0.9)), 0.02, MI["yellow"], seg=5)
    if col:
        bm = bmesh.new()
        hw = side * (half_w + 0.05)
        vs = [bm.verts.new(p) for p in (bot - hw, bot + hw, top + hw, top - hw)]
        f = bm.faces.new(vs)
        f.normal_update()
        if f.normal.z < 0:
            f.normal_flip()
        new_obj("col_stair", bm, CM)
        # side walls so you cannot step off the stair halfway
        for sg in (-1, 1):
            o = side * (half_w + 0.12) * sg
            mid = (top + bot) / 2 + o + Vector((0, 0, 0.6))
            panel("col_stair_side", mid, d.normalized(), Vector((0, 0, 1)), d.length + 0.2, 1.8, CM, 0.12)


def hole_guard(name, x0, x1, s0, s1, z, open_side, mat_rail):
    """Rails (and walls for walking) round a deck opening, open on one side
    ('s0', 's1', 'x0', 'x1') where the stair starts."""
    edges = {
        "s0": ((x0, s0), (x1, s0)), "s1": ((x0, s1), (x1, s1)),
        "x0": ((x0, s0), (x0, s1)), "x1": ((x1, s0), (x1, s1)),
    }
    for k, ((xa, sa), (xb, sb)) in edges.items():
        # a rim plate down to the deck below's ceiling
        c = Vector(((xa + xb) / 2, Y((sa + sb) / 2), z - 0.08))
        dvec = Vector((xb - xa, sb - sa, 0))
        panel(name + "_rim", c, dvec, (0, 0, 1), dvec.length, 0.18, MI["black"], 0.04)
        if k == open_side:
            continue
        railing(name + "_rail", [(xa, Y(sa), z), (xb, Y(sb), z)], 1.0, MI["yellow"], MI["yellow"], gap=0.9)
        panel("col_guard", Vector(((xa + xb) / 2, Y((sa + sb) / 2), z + 0.6)), dvec, (0, 0, 1),
              dvec.length + 0.1, 1.2, CM, 0.12)


def tube_light(x, sv, z, along_s=True):
    box("int_light", (x, Y(sv), z), (0.16, 1.2, 0.05) if along_s else (1.2, 0.16, 0.05), MI["tube"])


def porthole_in(sv, side):
    z = 3.42
    x = side * (hbi(sv, z) - 0.015)
    cyl("int_porthole_rim", (x - side * 0.01, Y(sv), z), (x - side * 0.05, Y(sv), z), 0.21, MI["black"], seg=16)
    cyl("int_porthole", (x - side * 0.05, Y(sv), z), (x - side * 0.06, Y(sv), z), 0.15, MI["porthole"], seg=16)


def trunk(name, x0, x1, s0, s1, za, zb, mat, t=0.03):
    """Lining round a vertical opening (stair well, hatch) from za up to zb."""
    for (xa, sa), (xb, sb) in (((x0, s0), (x1, s0)), ((x1, s0), (x1, s1)), ((x1, s1), (x0, s1)), ((x0, s1), (x0, s0))):
        c = Vector(((xa + xb) / 2, Y((sa + sb) / 2), (za + zb) / 2))
        d = Vector((xb - xa, sb - sa, 0))
        panel(name, c, d, (0, 0, 1), d.length + t, zb - za, mat, t)


def conveyor(name, x, s0, s1, z0, z1, w=0.5):
    """Belt conveyor along the ship from (s0, z0) to (s1, z1): stainless
    frame, black belt, legs."""
    p0, p1 = Vector((x, Y(s0), z0)), Vector((x, Y(s1), z1))
    d = p1 - p0
    panel(name, (p0 + p1) / 2, d, (1, 0, 0), d.length, w, MI["ss"], 0.1)
    panel(name + "_belt", (p0 + p1) / 2 + Vector((0, 0, 0.055)), d, (1, 0, 0), d.length, w - 0.08, MI["black"], 0.02)
    for sg in (-1, 1):
        panel(name + "_side", (p0 + p1) / 2 + Vector((sg * w / 2, 0, 0.1)), d, (0, 0, 1), d.length, 0.12, MI["ss"], 0.02)
    n = max(2, int(abs(s1 - s0) / 1.8) + 1)
    for k in range(n):
        f = k / (n - 1)
        q = p0.lerp(p1, f)
        for sg in (-1, 1):
            cyl(name + "_leg", (x + sg * (w / 2 - 0.05), q.y, TW_Z), (x + sg * (w / 2 - 0.05), q.y, q.z - 0.05), 0.025,
                MI["ss"], seg=6)


def build_interior():
    global CM
    CM = M["collision"]
    zf = TW_Z
    zc = 5.0                                   # 'tween deckhead under the shelter deck
    cx0, cx1, cs0, cs1 = COMP
    ex0, ex1, esb, est = ER_STAIR
    er_hole = (ex0, ex1, min(esb, est), max(esb, est))
    hs0, hs1, hxb, hxt = HOLD_STAIR
    hold_hole = (min(hxb, hxt), max(hxb, hxt), hs0, hs1)
    gs0, gs1, gxb, gxt = SG_STAIR
    sg_hole = (min(gxb, gxt), max(gxb, gxt), gs0, gs1)
    chute = CHUTE
    hx0, hx1, hp0, hp1 = HOPPER
    ux0, ux1 = UPTAKE

    # ================================================================ main ('tween) deck
    floor_grid("int_tw_floor", TW_S0, CASE_S0, zf, MI["floor"], holes=(er_hole, hold_hole, sg_hole, chute))
    floor_grid("int_tw_floor", CASE_S0, TW_S1, zf, MI["lino"])
    floor_grid("col_tw_floor", TW_S0, TW_S1, zf, CM, holes=(er_hole, hold_hole, sg_hole, chute), inset=0.0)
    floor_grid("int_tw_ceiling", TW_S0, SH1, TW_CEIL, MI["ceiling"], holes=((cx0, cx1, cs0, cs1), HOPPER), up=False)
    floor_grid("int_tw_ceiling", SH1, TW_S1, zc, MI["ceiling"], holes=(WH_HOLE,), up=False)
    bulkhead("int_step", SH1, TW_CEIL, zc, MI["ceiling"], col=False)
    lining("int_tw_side", TW_S0, SH1, zf, TW_CEIL, MI["lining"])
    lining("int_tw_side", SH1, 12.8, zf, zc, MI["lining"])
    lining("int_tw_side", 12.8, TW_S1, zf, zc, MI["wood"])
    bulkhead("int_tw_aft", TW_S0, zf, TW_CEIL, MI["lining"])
    bulkhead("int_tw_bh1", CASE_S0, zf, TW_CEIL, MI["lining"], door=(-1.4, -0.55, 1.9))
    bulkhead("int_tw_bh2", 12.8, zf, zc, MI["wood"], door=(-0.45, 0.45, 1.95))
    bulkhead("int_tw_bh3", CASE_S1, zf, zc, MI["wood"], door=(-0.5, 0.5, 1.95))
    bulkhead("int_tw_fwd", TW_S1, zf, zc, MI["wood"])
    for sp in (8.6, 10.4, 11.9, 14.5):           # the portholes on the drawing
        for side in (-1, 1):
            porthole_in(sp, side)
    for side in (-1, 1):   # side discharge doors (drawing): offal and water go out here
        x = side * (hbi(8.4, 3.2) - 0.03)
        panel("int_discharge_door", (x, Y(8.4), 3.17), (0, 1, 0), (0, 0, 1), 0.9, 1.75, MI["cast"], 0.05)
        cyl("int_door_dog", (x - side * 0.05, Y(8.0), 3.2), (x - side * 0.12, Y(8.0), 3.2), 0.03, MI["red"], seg=6)
    # hydraulic lines along the deckhead to the winches and net drums above
    for k, mat in enumerate((MI["blue_pipe"], MI["yellow"], MI["blue_pipe"])):
        x = 3.35 + k * 0.12
        cyl("int_hyd_line", (x, Y(1.0), TW_CEIL - 0.08), (x, Y(CASE_S0 - 0.1), TW_CEIL - 0.08), 0.022, mat, seg=6)

    # ---------------------------------------------------------------- aft store
    # companion from the working deck, hatches down to the steering flat and
    # the engine room, spare net under the companion, ropes on the bulkhead
    stair("int_comp_stair", ((cx0 + cx1) / 2, Y(cs1), WD_Z), ((cx0 + cx1) / 2, Y(cs0), zf), (cx1 - cx0) / 2 - 0.05)
    sphere("int_net_pile", (3.1, Y(3.0), zf + 0.2), 0.95, MI["net"], seg=14, squash=0.42)
    cbox((3.1, Y(3.05), zf + 0.5), (1.9, 1.7, 1.0))
    for x in (-3.0, -1.9, 1.0):
        for kk, rr in enumerate((0.42, 0.36)):
            torus("int_rope_coil", (x, Y(TW_S0 + 0.1), 3.35 - kk * 0.05), (0, 1, 0), rr, 0.06, MI["rope"])
        cyl("int_hook", (x, Y(TW_S0), 3.82), (x, Y(TW_S0 + 0.15), 3.82), 0.02, MI["cast"], seg=5)
    for k in range(7):
        sphere("int_float", (0.7 + (k % 3) * 0.36, Y(3.4 + (k // 3) * 0.34), zf + 0.18 + (k // 6) * 0.3), 0.18,
               MI["float"], seg=10)
    cbox((1.05, Y(3.75), zf + 0.3), (1.2, 1.1, 0.6))
    hole_guard("int_sg_hole", sg_hole[0], sg_hole[1], gs0, gs1, zf, "x1", None)
    hole_guard("int_er_hole", er_hole[0], er_hole[1], er_hole[2], er_hole[3], zf, "s0", None)
    for sv in (1.6, 3.9):
        for xx in (-1.6, 1.6):
            tube_light(xx, sv, TW_CEIL - 0.03)

    # ---------------------------------------------------------------- fish handling
    # The codend is emptied through the hatch in the working deck into the
    # reception hopper; a conveyor carries the catch aft past the crew, who
    # stand inboard of it to gut; gutted fish go on the second conveyor up into
    # the washer, and from the washer down the chute to the fishroom. Offal
    # runs in the floor gutter to the side discharge door.
    trunk("int_hatch_trunk", hx0, hx1, hp0, hp1, 3.55, TW_CEIL + 0.17, MI["ss"])
    box("int_hatch_lid", ((hx0 + hx1) / 2, Y((hp0 + hp1) / 2), WD_Z - 0.03), (hx1 - hx0, hp1 - hp0, 0.04), MI["cast"])
    solid("int_hopper", [(0.85, Y(7.9), 3.05), (1.45, Y(7.9), 3.05), (1.45, Y(8.45), 3.05), (0.85, Y(8.45), 3.05)],
          [(hx0, Y(hp0), 3.55), (hx1 + 0.15, Y(hp0), 3.55), (hx1 + 0.15, Y(hp1), 3.55), (hx0, Y(hp1), 3.55)], MI["ss"])
    box("int_hopper_fish", ((hx0 + hx1) / 2 + 0.07, Y((hp0 + hp1) / 2), 3.5), (hx1 - hx0 - 0.1, hp1 - hp0 - 0.1, 0.06),
        MI["cast"])
    for xx in (hx0 + 0.05, hx1 + 0.1):
        for sv in (hp0 + 0.05, hp1 - 0.05):
            cyl("int_hopper_leg", (xx, Y(sv), zf), (xx, Y(sv), 3.55), 0.03, MI["ss"], seg=6)
    cbox(((hx0 + hx1 + 0.15) / 2, Y((hp0 + hp1) / 2), zf + 0.7), (hx1 - hx0 + 0.2, hp1 - hp0 + 0.1, 1.4))
    conveyor("int_conv_in", 1.2, 8.45, 4.6, 2.97, 2.97)
    cbox((1.2, Y(6.5), zf + 0.45), (0.55, 3.9, 0.9))
    conveyor("int_conv_gut", 2.05, 4.6, 8.0, 2.97, 2.97)
    conveyor("int_conv_lift", 2.05, 8.0, 8.62, 2.97, 3.5)
    cbox((2.05, Y(6.6), zf + 0.5), (0.55, 4.1, 1.0))
    for sv in np.arange(4.9, 7.8, 0.75):     # rubber mats where the crew stand
        box("int_mat", (0.55, Y(sv), zf + 0.012), (0.7, 0.68, 0.025), MI["black"])
    box("int_offal_gutter", (2.9, Y(8.0), zf + 0.01), (2.9, 0.25, 0.02), MI["black"])
    box("int_offal_gutter", (1.45, Y(7.55), zf + 0.01), (0.25, 0.9, 0.02), MI["black"])
    # washer drum and the chute down to the fishroom
    cyl("int_washer", (2.05, Y(8.6), 3.3), (2.05, Y(9.5), 3.3), 0.45, MI["ss"], seg=16)
    torus("int_washer_ring", (2.05, Y(8.62), 3.3), (0, 1, 0), 0.45, 0.04, MI["cast"])
    cyl("int_washer_pipe", (2.05, Y(9.0), 3.75), (2.05, Y(9.0), TW_CEIL - 0.05), 0.04, MI["blue_pipe"], seg=6)
    for sv in (8.7, 9.4):
        for xx in (1.7, 2.4):
            cyl("int_leg", (xx, Y(sv), zf), (xx, Y(sv), 2.95), 0.03, MI["ss"], seg=6)
    cbox((2.05, Y(9.1), zf + 0.8), (1.05, 1.1, 1.6))
    p0, p1 = Vector((2.05, Y(9.5), 3.0)), Vector((2.05, Y((chute[2] + chute[3]) / 2 + 0.2), zf + 0.15))
    panel("int_fish_chute", (p0 + p1) / 2, p1 - p0, (1, 0, 0), (p1 - p0).length, 0.55, MI["ss"], 0.03)
    hole_guard("int_chute_hole", chute[0], chute[1], chute[2], chute[3], zf, "s0", None)
    # ice machine, its chute down to the ice locker in the fishroom
    fbox("int_ice_machine", (-3.4, Y(10.4), zf + 0.8), (1.0, 1.0, 1.6), MI["white"])
    box("int_ice_panel", (-2.89, Y(10.4), zf + 1.25), (0.02, 0.4, 0.3), MI["black"])
    box("int_ice_led", (-2.88, Y(10.3), zf + 1.3), (0.02, 0.05, 0.05), MI["led_g"])
    cyl("int_ice_chute", (-3.4, Y(10.4), zf + 0.02), (-3.4, Y(10.4), zf - 0.2), 0.12, MI["ss"], seg=10)
    # empty fish boxes
    for k in range(4):
        for j in range(2):
            fbox("int_fishbox", (-1.45, Y(4.55 + j * 0.55), zf + 0.13 + k * 0.26), (0.8, 0.5, 0.25),
                 MI["box"] if (k + j) % 2 else MI["box2"], col=False)
    cbox((-1.45, Y(4.82), zf + 0.6), (0.85, 1.1, 1.2))
    for k in range(3):
        box("int_basket", (0.4 + k * 0.5, Y(9.75), zf + 0.15), (0.42, 0.32, 0.3), MI["yellow"])
    cbox((0.9, Y(9.75), zf + 0.2), (1.45, 0.4, 0.4))
    xr = hbi(6.0, 3.0)
    cyl("int_hose_reel", (xr - 0.05, Y(6.0), zf + 1.0), (xr - 0.3, Y(6.0), zf + 1.0), 0.3, MI["red"], seg=12)
    hole_guard("int_hold_hole", hold_hole[0], hold_hole[1], hs0, hs1, zf, "x1", None)
    for sv in (5.2, 7.2, 9.6):
        for xx in (-1.6, 1.6):
            tube_light(xx, sv, TW_CEIL - 0.03)

    # exhaust: up from the engine room in an insulated trunk on the port side,
    # along the deckhead, across the casing and up through the wheelhouse to
    # the funnel on its roof
    xu = -(hbi(9.3, 3.0) - 0.3)
    box("int_uptake", (xu - 0.05, Y(9.3), (zf + TW_CEIL) / 2), (0.62, 0.6, TW_CEIL - zf), MI["lining"])
    ze = TW_CEIL - 0.25
    cyl("int_exhaust_run", (xu, Y(9.3), ze), (xu, Y(12.45), ze), 0.17, MI["lining"], seg=12)
    cyl("int_exhaust_run", (xu, Y(12.45), ze), (xu, Y(12.45), 4.62), 0.17, MI["lining"], seg=12)
    cyl("int_exhaust_run", (xu, Y(12.45), 4.62), ((ux0 + ux1) / 2, Y(12.45), 4.62), 0.17, MI["lining"], seg=12)
    cyl("int_exhaust_run", ((ux0 + ux1) / 2, Y(12.45), 4.62), ((ux0 + ux1) / 2, Y(13.1), 4.62), 0.17, MI["lining"], seg=12)
    for sv in (10.0, 11.0):
        torus("int_exhaust_band", (xu, Y(sv), ze), (0, 1, 0), 0.175, 0.012, MI["cast"])
    cbox((xu - 0.05, Y(10.9), zf + 0.75), (0.7, 3.8, 1.5))
    fbox("int_uptake", ((ux0 + ux1) / 2, Y(13.1), (zf + zc) / 2), (ux1 - ux0, 0.5, zc - zf), MI["lining"])

    # ---------------------------------------------------------------- casing
    # changing room: lockers, oilskins and boots - the crew come in off the
    # deck here; washroom to starboard
    for k in range(4):
        fbox("int_locker", (-hbi(11.9, 3.0) + 0.3, Y(11.55 + k * 0.3), zf + 0.95), (0.5, 0.28, 1.9), MI["cast"], col=False)
        cyl("int_locker_vent", (-hbi(11.9, 3.0) + 0.56, Y(11.55 + k * 0.3), zf + 1.6),
            (-hbi(11.9, 3.0) + 0.57, Y(11.55 + k * 0.3), zf + 1.6), 0.05, MI["black"], seg=8)
    cbox((-hbi(11.9, 3.0) + 0.3, Y(12.0), zf + 0.95), (0.5, 1.2, 1.9))
    for k in range(5):
        xx = 0.05 + k * 0.3
        box("int_oilskin", (xx, Y(CASE_S0 + 0.12), zf + 1.25), (0.24, 0.12, 1.0), MI["oilskin"])
        box("int_boot", (xx, Y(CASE_S0 + 0.25), zf + 0.18), (0.12, 0.28, 0.36), MI["black"])
    cbox((0.65, Y(CASE_S0 + 0.18), zf + 0.9), (1.5, 0.36, 1.8))
    fbox("int_bench", (-hbi(11.9, 3.0) + 1.05, Y(12.05), zf + 0.22), (0.4, 1.0, 0.44), MI["wood"])
    wd = 1.8
    wall("int_wash_wall", (wd, Y(CASE_S0), zf), (0, 1, 0), (0, 0, 1), 12.8 - CASE_S0, zc - zf,
         [(0.55, 1.25, 0.0, 1.95, False)], MI["white"], thick=0.05)
    cbox((wd, Y(CASE_S0 + 0.275), zf + 1.2), (0.12, 0.55, 2.4))
    cbox((wd, Y(12.725), zf + 1.2), (0.12, 0.15, 2.4))
    xw = hbi(12.0, 2.6)
    fbox("int_wc", (xw - 0.35, Y(11.75), zf + 0.22), (0.4, 0.55, 0.44), MI["white"])
    box("int_wc_tank", (xw - 0.12, Y(11.75), zf + 0.7), (0.18, 0.45, 0.5), MI["white"])
    box("int_wc_seat", (xw - 0.37, Y(11.75), zf + 0.46), (0.42, 0.5, 0.04), MI["black"])
    box("int_shower_tray", (xw - 0.45, Y(12.38), zf + 0.04), (0.8, 0.75, 0.08), MI["white"])
    cyl("int_shower_head", (xw - 0.1, Y(12.38), zf + 1.95), (xw - 0.25, Y(12.38), zf + 1.9), 0.06, MI["ss"], seg=8)
    cyl("int_shower_rail", (xw - 0.85, Y(12.0), zf + 2.05), (xw - 0.85, Y(12.76), zf + 2.05), 0.015, MI["ss"], seg=5)
    panel("int_shower_curtain", (xw - 0.85, Y(12.38), zf + 1.1), (0, 1, 0), (0, 0, 1), 0.7, 1.9, MI["fabric"], 0.01)
    cbox((xw - 0.45, Y(12.38), zf + 1.0), (0.85, 0.8, 2.0))
    box("int_basin", (wd + 0.25, Y(11.62), zf + 0.85), (0.4, 0.35, 0.12), MI["white"])
    box("int_mirror", (wd + 0.04, Y(11.62), zf + 1.35), (0.02, 0.4, 0.5), MI["ss"])
    tube_light(-1.2, 12.1, TW_CEIL - 0.03, along_s=False)
    tube_light(2.9, 12.1, zc - 0.03, along_s=False)

    # galley (starboard) and mess (port), the stair up to the wheelhouse
    wx0, wx1, wsb, wst = WH_STAIR
    stair("int_wh_stair", ((wx0 + wx1) / 2, Y(wst), 5.4), ((wx0 + wx1) / 2, Y(wsb), zf), (wx1 - wx0) / 2 - 0.05)
    wall("int_stair_wall", (wx1 + 0.08, Y(wsb), zf), (0, 1, 0), (0, 0, 1), CASE_S1 - wsb, zc - zf, [], MI["wood"], thick=0.05)
    cbox((wx1 + 0.08, Y((wsb + CASE_S1) / 2), zf + 1.2), (0.1, CASE_S1 - wsb, 2.4))
    xo = -hbi(14.8, 3.0)
    for k in range(4):           # dry stores outboard of the stair
        box("int_cupboard", (xo + 0.33, Y(13.2 + k * 0.8), zf + 1.0), (0.62, 0.76, 2.0), MI["wood"])
    cbox((xo + 0.6, Y(14.4), zf + 1.0), (1.2, 2.6, 2.0))
    cbox(((xo + wx0) / 2, Y(15.6), zf + 1.0), (abs(wx0 - xo), 2.0, 2.0))
    # mess: settee against the stair wall, table, television
    fbox("int_bench_seat", (wx1 + 0.38, Y(15.3), zf + 0.22), (0.5, 2.5, 0.44), MI["fabric"])
    box("int_bench_back", (wx1 + 0.17, Y(15.3), zf + 0.75), (0.1, 2.5, 0.6), MI["fabric"])
    fbox("int_bench_seat", (-1.3, Y(CASE_S1 - 0.28), zf + 0.22), (1.2, 0.5, 0.44), MI["fabric"])
    fbox("int_mess_table", (-1.2, Y(15.1), zf + 0.74), (0.95, 1.8, 0.05), MI["wood"], col=False)
    box("int_table_fiddle", (-1.2, Y(15.1), zf + 0.78), (0.95, 1.8, 0.03), MI["wood"])
    cyl("int_table_leg", (-1.2, Y(15.1), zf), (-1.2, Y(15.1), zf + 0.72), 0.06, MI["ss"], seg=8)
    cbox((-1.2, Y(15.1), zf + 0.37), (0.95, 1.8, 0.74))
    box("int_tv", (-1.0, Y(CASE_S1 - 0.06), zf + 1.85), (0.75, 0.05, 0.45), MI["black"])
    box("int_tv_screen", (-1.0, Y(CASE_S1 - 0.09), zf + 1.85), (0.68, 0.01, 0.38), MI["tv"])
    # galley along the starboard side
    gx = hbi(14.8, 2.6)
    fbox("int_counter", (gx - 0.33, Y(15.05), zf + 0.45), (0.66, 2.9, 0.9), MI["wood"])
    box("int_worktop", (gx - 0.33, Y(15.05), zf + 0.92), (0.7, 2.94, 0.04), MI["ss"])
    box("int_stove", (gx - 0.33, Y(14.2), zf + 0.96), (0.6, 0.62, 0.05), MI["black"])
    for dx, ds in ((-0.13, -0.14), (0.13, -0.14), (-0.13, 0.14), (0.13, 0.14)):
        torus("int_burner", (gx - 0.33 + dx, Y(14.2 + ds), zf + 0.995), (0, 0, 1), 0.07, 0.012, MI["cast"])
    for sg in (-1, 1):      # fiddle rails, so the pans stay on in a seaway
        cyl("int_fiddle", (gx - 0.33 + sg * 0.3, Y(13.9), zf + 1.05), (gx - 0.33 + sg * 0.3, Y(14.5), zf + 1.05), 0.012,
            MI["ss"], seg=5)
    box("int_oven_door", (gx - 0.67, Y(14.2), zf + 0.5), (0.02, 0.55, 0.5), MI["black"])
    box("int_hood", (gx - 0.3, Y(14.2), zf + 1.85), (0.6, 0.7, 0.3), MI["ss"])
    box("int_sink", (gx - 0.33, Y(15.3), zf + 0.9), (0.45, 0.5, 0.06), MI["cast"])
    cyl("int_tap", (gx - 0.12, Y(15.3), zf + 0.94), (gx - 0.12, Y(15.3), zf + 1.2), 0.015, MI["ss"], seg=6)
    box("int_microwave", (gx - 0.3, Y(16.1), zf + 1.1), (0.45, 0.5, 0.3), MI["white"])
    fbox("int_fridge", (gx - 0.38, Y(13.25), zf + 0.9), (0.72, 0.7, 1.8), MI["white"])
    for k in range(3):
        box("int_cupboard", (gx - 0.2, Y(14.65 + k * 0.6), zf + 1.75), (0.38, 0.56, 0.6), MI["wood"])
    for sv in (13.6, 15.4):
        for xx in (-1.6, 1.6):
            tube_light(xx, sv, zc - 0.03)

    # ---------------------------------------------------------------- cabins
    # corridor on the centreline, two cabins each side, two-tier bunks
    for side in (-1, 1):
        xw = side * 0.5
        wall("int_cabin_wall", (xw, Y(CASE_S1), zf), (0, 1, 0), (0, 0, 1), TW_S1 - CASE_S1, zc - zf,
             [(0.8, 1.5, 0.0, 1.95, False), (2.15, 2.85, 0.0, 1.95, False)], MI["wood"], thick=0.05)
        for a0, a1 in ((0.0, 0.8), (1.5, 2.15), (2.85, TW_S1 - CASE_S1)):
            cbox((xw, Y(CASE_S1 + (a0 + a1) / 2), zf + 1.2), (0.12, a1 - a0, 2.4))
        x1 = side * hbi(18.45, zf + 1.0)
        box("int_cabin_split", ((xw + x1) / 2, Y(18.45), (zf + zc) / 2), (abs(x1 - xw), 0.05, zc - zf), MI["wood"])
        cbox(((xw + x1) / 2, Y(18.45), zf + 1.2), (abs(x1 - xw), 0.14, 2.4))
        for c0, c1 in ((16.7, 18.35), (18.55, TW_S1 - 0.1)):
            sm = (c0 + c1) / 2
            xb = side * (hbi(sm, zf + 0.5) - 0.38)
            for zb in (zf + 0.35, zf + 1.45):
                box("int_bunk", (xb, Y(sm), zb), (0.76, c1 - c0, 0.1), MI["wood"])
                box("int_mattress", (xb, Y(sm), zb + 0.1), (0.7, c1 - c0 - 0.06, 0.12), MI["fabric"])
                box("int_reading_lamp", (xb + side * 0.33, Y(c1 - 0.15), zb + 0.55), (0.06, 0.1, 0.06), MI["tube"])
            box("int_bunk_side", (xb - side * 0.37, Y(sm), zf + 1.0), (0.04, c1 - c0, 0.25), MI["wood"])
            panel("int_bunk_curtain", (xb - side * 0.38, Y(sm), zf + 2.1), (0, 1, 0), (0, 0, 1), c1 - c0 - 0.2, 0.5,
                  MI["fabric"], 0.01)
            cbox((xb, Y(sm), zf + 0.9), (0.76, c1 - c0, 1.8))
            box("int_cabin_locker", (side * 0.8, Y(c1 - 0.25), zf + 0.95), (0.5, 0.4, 1.9), MI["wood"])
            tube_light(side * 1.6, sm, zc - 0.03)
    tube_light(0.0, 17.6, zc - 0.03)
    tube_light(0.0, 19.4, zc - 0.03)

    # ================================================================ steering gear flat
    # over the rudder: stock, tiller, two hydraulic rams, power pack,
    # emergency tiller. Reached by its own hatch from the aft store.
    sz, sc = SG_Z, TW_Z - 0.15
    floor_grid("int_sg_floor", SG_S0, SG_S1, sz, MI["plate"])
    floor_grid("col_sg_floor", SG_S0, SG_S1, sz, CM, inset=0.0)
    floor_grid("int_sg_ceiling", SG_S0, SG_S1, sc, MI["ceiling"], holes=(sg_hole,), up=False)
    lining("int_sg_side", SG_S0, SG_S1, sz, sc, MI["er_wall"])
    bulkhead("int_sg_aft", SG_S0, sz, sc, MI["er_wall"])
    stair("int_sg_stair", (gxt, Y((gs0 + gs1) / 2), TW_Z), (gxb, Y((gs0 + gs1) / 2), sz), (gs1 - gs0) / 2 - 0.05)
    st = 0.8                                     # rudder stock (rudder: s 0.35, chord 1.3)
    cyl("int_stock_gland", (0, Y(st), sz), (0, Y(st), sz + 0.15), 0.26, MI["cast"], seg=14)
    cyl("int_rudder_stock", (0, Y(st), sz), (0, Y(st), sz + 0.95), 0.13, MI["cast"], seg=12)
    box("int_tiller", (0, Y(st + 0.3), sz + 0.65), (0.2, 0.7, 0.18), MI["engine"])
    for sg in (-1, 1):
        cyl("int_ram", (sg * 1.65, Y(st + 0.6), sz + 0.65), (sg * 0.55, Y(st + 0.6), sz + 0.65), 0.1, MI["engine"], seg=12)
        cyl("int_ram_rod", (sg * 0.55, Y(st + 0.6), sz + 0.65), (sg * 0.1, Y(st + 0.6), sz + 0.65), 0.04, MI["ss"], seg=8)
        box("int_ram_seat", (sg * 1.75, Y(st + 0.6), sz + 0.4), (0.25, 0.35, 0.8), MI["black"])
        cyl("int_ram_hose", (sg * 1.5, Y(st + 0.6), sz + 0.76), (1.9, Y(2.1), sz + 0.9), 0.02, MI["black"], seg=5)
    cbox((0, Y(1.075), sz + 0.5), (3.8, 0.95, 1.0))
    fbox("int_power_pack", (2.35, Y(2.35), sz + 0.35), (0.9, 0.75, 0.7), MI["engine"])
    for dx in (-0.2, 0.2):
        cyl("int_pp_motor", (2.35 + dx, Y(2.35), sz + 0.7), (2.35 + dx, Y(2.35), sz + 1.1), 0.12, MI["cast"], seg=10)
    cyl("int_emerg_tiller", (-hbi(1.6, 1.2) + 0.08, Y(1.0), sz + 1.3), (-hbi(1.6, 1.2) + 0.08, Y(2.6), sz + 1.3),
        0.035, MI["red"], seg=6)
    box("int_rudder_ind", (0.0, Y(SG_S0 + 0.05), sz + 1.5), (0.3, 0.04, 0.3), MI["black"])
    tube_light(0.0, 1.2, sc - 0.03, along_s=False)
    tube_light(1.0, 2.4, sc - 0.03)

    # ================================================================ engine room
    ez, ec = ER_Z, TW_Z - 0.15
    floor_grid("int_er_floor", ER_S0, ER_S1, ez, MI["plate"])
    floor_grid("col_er_floor", ER_S0, ER_S1, ez, CM, inset=0.0)
    floor_grid("int_er_ceiling", ER_S0, ER_S1, ec, MI["ceiling"], holes=(er_hole,), up=False)
    lining("int_er_side", ER_S0, ER_S1, ez, ec, MI["er_wall"])
    bulkhead("int_er_aft", ER_S0, ez, ec, MI["er_wall"])
    bulkhead("int_er_fwd", ER_S1, HOLD_Z, ec, MI["er_wall"])
    stair("int_er_stair", ((ex0 + ex1) / 2, Y(est), TW_Z), ((ex0 + ex1) / 2, Y(esb), ez), (ex1 - ex0) / 2 - 0.05)
    # main engine (1500 hp, six in line) on its bed; gearbox aft, a short
    # shaft through the stern gland to the propeller
    box("int_engine_bed", (0, Y(5.85), ez + 0.2), (1.8, 5.1, 0.4), MI["black"])
    box("int_gearbox", (0, Y(3.6), ez + 0.75), (1.0, 0.6, 0.9), MI["cast"], bevel=0.03)
    box("int_flywheel", (0, Y(4.15), ez + 1.0), (1.4, 0.5, 1.4), MI["engine"], bevel=0.04)
    box("int_engine_block", (0, Y(6.0), ez + 1.1), (1.3, 3.2, 1.4), MI["engine"], bevel=0.04)
    for k in range(6):
        box("int_cyl_head", (0, Y(4.65 + k * 0.53), ez + 1.95), (0.85, 0.46, 0.32), MI["engine"], bevel=0.03)
        box("int_rocker", (0, Y(4.65 + k * 0.53), ez + 2.16), (0.6, 0.4, 0.12), MI["cast"], bevel=0.02)
        cyl("int_injector_pipe", (-0.45, Y(4.65 + k * 0.53), ez + 1.85), (-0.7, Y(4.65 + k * 0.53), ez + 1.3), 0.012,
            MI["cast"], seg=4)
    cyl("int_manifold", (0.62, Y(4.4), ez + 1.85), (0.62, Y(7.7), ez + 1.85), 0.13, MI["cast"], seg=10)
    cyl("int_turbo", (0.15, Y(7.95), ez + 1.9), (0.85, Y(7.95), ez + 1.9), 0.32, MI["cast"], seg=14)
    cyl("int_damper", (0, Y(7.6), ez + 0.8), (0, Y(7.8), ez + 0.8), 0.36, MI["black"], seg=16)
    box("int_hyd_pump", (0, Y(8.15), ez + 0.75), (0.6, 0.45, 0.6), MI["blue_pipe"], bevel=0.03)
    cyl("int_shaft", (0, Y(ER_S0), ez + 0.45), (0, Y(3.3), ez + 0.45), 0.12, MI["ss"], seg=10)
    cyl("int_coupling", (0, Y(3.15), ez + 0.45), (0, Y(3.25), ez + 0.45), 0.24, MI["cast"], seg=12)
    cyl("int_stern_gland", (0, Y(ER_S0), ez + 0.45), (0, Y(ER_S0 + 0.08), ez + 0.45), 0.3, MI["black"], seg=12)
    cbox((0, Y(5.85), ez + 1.2), (1.9, 5.2, 2.4))
    # exhaust: turbo -> bellows -> along the deckhead -> up the port trunk
    zx = ec - 0.42
    cyl("int_exhaust", (0.5, Y(7.95), ez + 2.2), (0.5, Y(7.95), zx), 0.2, MI["lining"], seg=12)
    cyl("int_exhaust", (0.5, Y(7.95), zx), (0.5, Y(9.0), zx), 0.2, MI["lining"], seg=12)
    cyl("int_exhaust", (0.5, Y(9.0), zx), (xu, Y(9.0), zx), 0.2, MI["lining"], seg=12)
    cyl("int_exhaust", (xu, Y(9.0), zx), (xu, Y(9.0), ec), 0.2, MI["lining"], seg=12)
    # generators (starboard), switchboard, workbench, day tank
    for sv in (5.0, 7.0):
        box("int_genset", (2.7, Y(sv), ez + 0.6), (0.8, 1.5, 1.0), MI["engine"], bevel=0.03)
        box("int_alternator", (2.7, Y(sv - 0.9), ez + 0.6), (0.65, 0.35, 0.75), MI["cast"], bevel=0.03)
        cyl("int_gen_exhaust", (2.7, Y(sv + 0.5), ez + 1.1), (2.7, Y(sv + 0.5), ec), 0.07, MI["lining"], seg=8)
        cbox((2.7, Y(sv - 0.15), ez + 0.6), (0.85, 1.9, 1.2))
    fbox("int_switchboard", (-1.9, Y(ER_S1 - 0.25), ez + 1.0), (2.2, 0.45, 2.0), MI["cast"])
    for k in range(8):
        box("int_led", (-2.8 + k * 0.26, Y(ER_S1 - 0.48), ez + 1.55), (0.06, 0.02, 0.06),
            MI["led_g"] if k % 3 else MI["led_r"])
    for k in range(4):
        box("int_breaker", (-2.6 + k * 0.45, Y(ER_S1 - 0.48), ez + 1.0), (0.3, 0.02, 0.4), MI["black"])
    fbox("int_day_tank", (3.0, Y(8.85), ez + 1.0), (0.9, 0.8, 2.0), MI["cast"])
    box("int_sight_glass", (2.53, Y(8.85), ez + 1.0), (0.03, 0.06, 1.4), MI["porthole"])
    xb_ = -hbi(7.7, -0.6) + 0.4
    fbox("int_workbench", (xb_, Y(7.7), ez + 0.85), (0.7, 1.4, 0.06), MI["wood"], col=False)
    cbox((xb_, Y(7.7), ez + 0.45), (0.7, 1.4, 0.9))
    box("int_vice", (xb_ + 0.15, Y(7.3), ez + 0.95), (0.2, 0.15, 0.15), MI["blue_pipe"])
    box("int_tool_board", (xb_ - 0.33, Y(7.7), ez + 1.5), (0.03, 1.2, 0.7), MI["wood"])
    for side, mat, zz in ((-1, MI["red"], 1.2), (1, MI["blue_pipe"], 1.2), (-1, MI["yellow"], 1.45), (1, MI["red"], 0.4)):
        x = side * (hbi(6.5, zz) - 0.12)
        cyl("int_pipe", (x, Y(ER_S0 + 0.8), zz), (x, Y(ER_S1 - 0.2), zz), 0.055, mat, seg=8)
        for sv in (5.0, 8.0):
            torus("int_valve", (x - side * 0.12, Y(sv), zz), (1, 0, 0), 0.09, 0.015, mat)
            cyl("int_valve_stem", (x, Y(sv), zz), (x - side * 0.12, Y(sv), zz), 0.015, MI["cast"], seg=4)
    for sv in (4.6, 6.8, 8.8):
        for xx in (-1.5, 1.5):
            tube_light(xx, sv, ec - 0.03)

    # ================================================================ fishroom
    # insulated, white; aluminium stanchions and pound boards make pens about
    # 1.5 m long either side of a centre gangway; ice locker aft under the
    # ice machine, refrigeration grids on the deckhead
    hz, hc = HOLD_Z, TW_Z - 0.15
    floor_grid("int_hold_floor", HOLD_S0, HOLD_S1, hz, MI["hold"])
    floor_grid("col_hold_floor", HOLD_S0, HOLD_S1, hz, CM, inset=0.0)
    floor_grid("int_hold_ceiling", HOLD_S0, HOLD_S1, hc, MI["hold"], holes=(hold_hole, chute), up=False)
    lining("int_hold_side", HOLD_S0, HOLD_S1, hz, hc, MI["hold"])
    bulkhead("int_hold_fwd", HOLD_S1, hz, hc, MI["hold"])
    stair("int_hold_stair", (hxt, Y((hs0 + hs1) / 2), TW_Z), (hxb, Y((hs0 + hs1) / 2), hz), (hs1 - hs0) / 2 - 0.05)
    # the fish chute comes down into the receiving pen, starboard aft
    p0 = Vector((2.05, Y((chute[2] + chute[3]) / 2), hc))
    p1 = Vector((2.05, Y(HOLD_S0 + 0.35), hz + 0.9))
    panel("int_hold_chute", (p0 + p1) / 2, p1 - p0, (1, 0, 0), (p1 - p0).length, 0.55, MI["ss"], 0.03)
    for sg in (-1, 1):
        panel("int_hold_chute_side", (p0 + p1) / 2 + Vector((sg * 0.28, 0, 0.1)), p1 - p0, (0, 0, 1),
              (p1 - p0).length, 0.2, MI["ss"], 0.02)
    cbox((2.05, Y((HOLD_S0 + chute[3]) / 2), hz + 1.7), (0.7, chute[3] - HOLD_S0, 1.6))
    sphere("int_ice", (2.6, Y(10.0), hz + 0.05), 0.8, MI["ice"], seg=12, squash=0.3)
    # ice locker
    lx0, lx1, ls0, ls1 = -hbi(10.4, 0.0) + 0.05, -2.0, HOLD_S0 + 0.05, 11.3
    for (xa, sa), (xb, sb), door in (((lx1, ls0), (lx1, ls1), True), ((lx0, ls1), (lx1, ls1), False)):
        dvec = Vector((xb - xa, sb - sa, 0))
        if door:   # door opening in the middle of the inboard wall
            for f0, f1 in ((0.0, 0.3), (0.72, 1.0)):
                c = Vector((xa + (xb - xa) * (f0 + f1) / 2, Y(sa + (sb - sa) * (f0 + f1) / 2), hz + 0.95))
                panel("int_ice_locker", c, dvec, (0, 0, 1), dvec.length * (f1 - f0), 1.9, MI["white"], 0.08)
                cbox((c.x, c.y, hz + 0.95), (0.12, dvec.length * (f1 - f0), 1.9))
        else:
            c = Vector(((xa + xb) / 2, Y((sa + sb) / 2), hz + 0.95))
            panel("int_ice_locker", c, dvec, (0, 0, 1), dvec.length, 1.9, MI["white"], 0.08)
            cbox((c.x, c.y, hz + 0.95), (dvec.length, 0.12, 1.9))
    box("int_ice_locker_top", ((lx0 + lx1) / 2, Y((ls0 + ls1) / 2), hz + 1.92), (lx1 - lx0, ls1 - ls0, 0.06), MI["white"])
    cyl("int_ice_drop", (-3.4, Y(10.4), hc), (-3.4, Y(10.4), hz + 1.95), 0.12, MI["ss"], seg=10)
    sphere("int_ice", (-3.2, Y(10.3), hz + 0.05), 0.85, MI["ice"], seg=12, squash=0.45)
    # stanchions and pound boards
    for sv in (11.9, 13.4, 14.9):
        for side in (-1, 1):
            x0 = side * 0.6
            box("int_stanchion", (x0, Y(sv), (hz + hc) / 2), (0.09, 0.09, hc - hz), MI["ss"])
            x1 = side * hbi(sv, hz + 0.6)
            fbox("int_pound_board", ((x0 + x1) / 2, Y(sv), hz + 0.55), (abs(x1 - x0), 0.05, 1.1), MI["ss"])
            for zz in (hz + 0.3, hz + 0.6, hz + 0.9):
                box("int_board_seam", ((x0 + x1) / 2, Y(sv), zz), (abs(x1 - x0), 0.06, 0.012), MI["cast"])
    for side in (-1, 1):
        box("int_stanchion", (side * 0.6, Y(HOLD_S1 - 0.1), (hz + hc) / 2), (0.09, 0.09, hc - hz), MI["ss"])
    # boxed fish in some pens, bulk ice in others
    for (x, sv, n) in ((-1.6, 12.4, 4), (-2.4, 12.4, 3), (-1.6, 12.95, 4), (1.6, 13.9, 3), (2.4, 13.9, 2),
                       (1.6, 14.45, 3), (-1.5, 15.5, 3), (1.5, 15.6, 2)):
        for k in range(n):
            box("int_hold_box", (x, Y(sv), hz + 0.13 + k * 0.26), (0.75, 0.5, 0.25), MI["box2"] if k % 2 else MI["box"])
            box("int_box_ice", (x, Y(sv), hz + 0.26 + k * 0.26), (0.66, 0.42, 0.01), MI["ice"])
        cbox((x, Y(sv), hz + 0.5), (0.8, 0.55, 1.0))
    sphere("int_ice", (2.3, Y(12.6), hz + 0.05), 0.9, MI["ice"], seg=12, squash=0.35)
    sphere("int_ice", (-2.0, Y(14.1), hz + 0.05), 0.8, MI["ice"], seg=12, squash=0.3)
    for x in (-3.0, -2.6, 2.6, 3.0):           # refrigeration grids
        cyl("int_cool_grid", (x, Y(HOLD_S0 + 1.9), hc - 0.12), (x, Y(HOLD_S1 - 0.4), hc - 0.12), 0.025, MI["ss"], seg=6)
    for sv in (HOLD_S0 + 1.9, HOLD_S1 - 0.4):
        for sg in (-1, 1):
            cyl("int_cool_header", (sg * 2.6, Y(sv), hc - 0.12), (sg * 3.0, Y(sv), hc - 0.12), 0.035, MI["ss"], seg=6)
    box("int_bilge_grate", (0, Y(HOLD_S0 + 0.3), hz + 0.01), (0.5, 0.35, 0.02), MI["black"])
    for sv in (10.0, 12.6, 15.2):
        tube_light(0.0, sv, hc - 0.03)

    # ================================================================ wheelhouse stairwell
    zw = top_z(WH0)
    trunk("int_wh_well", WH_HOLE[0], WH_HOLE[1], WH_HOLE[2], WH_HOLE[3], zc - 0.02, zw, MI["wood"])
    hole_guard("int_wh_hole", WH_HOLE[0], WH_HOLE[1], WH_HOLE[2], WH_HOLE[3], zw, "s1", None)

    # ================================================================ the companion on deck
    zt = WD_Z
    for (xa, sa), (xb, sb) in (((cx0, cs0), (cx0, cs1)), ((cx1, cs0), (cx1, cs1)), ((cx0, cs0), (cx1, cs0))):
        c = Vector(((xa + xb) / 2, Y((sa + sb) / 2), (TW_CEIL + zt + 0.45) / 2))
        dvec = Vector((xb - xa, sb - sa, 0))
        panel("comp_coaming", c, dvec, (0, 0, 1), dvec.length + 0.06, zt + 0.45 - TW_CEIL, M["white"], 0.05)
        panel("col_comp", Vector(((xa + xb) / 2, Y((sa + sb) / 2), zt + 0.6)), dvec, (0, 0, 1), dvec.length + 0.1, 1.2,
              CM, 0.14)
    railing("comp_rail", [(cx0, Y(cs1), zt + 0.45), (cx0, Y(cs0), zt + 0.45), (cx1, Y(cs0), zt + 0.45),
                          (cx1, Y(cs1), zt + 0.45)], 0.6, M["steel"], M["rail_white"], gap=0.8)
    panel("comp_lid", ((cx0 + cx1) / 2, Y(cs0 - 0.05), zt + 0.95), (1, 0, 0), (0, 0, 1), cx1 - cx0 + 0.05, 0.9,
          M["white"], 0.05)


def build_collision():
    """Invisible low-poly shapes the player walks on and bumps into."""
    C = M["collision"]
    zr = top_z(SH1) - 0.15

    def deck_strip(name, s0, s1, zfun, n=14, hole=None):
        bm = bmesh.new()
        ss = sorted(set(np.linspace(s0, s1, n).tolist() + ([hole[2], hole[3]] if hole else [])))
        for sa, sb in zip(ss[:-1], ss[1:]):
            za, zb = zfun(sa), zfun(sb)
            ya = max(0.05, half_breadth(sa, za) + 0.05)     # reach under the bulwarks: no gap at the side
            yb = max(0.05, half_breadth(sb, zb) + 0.05)
            spans = [(-ya, ya, -yb, yb)]
            if hole and sa >= hole[2] - 1e-6 and sb <= hole[3] + 1e-6:
                spans = [(-ya, hole[0], -yb, hole[0]), (hole[1], ya, hole[1], yb)]
            for xa0, xa1, xb0, xb1 in spans:
                f = bm.faces.new([bm.verts.new((xa0, Y(sa), za)), bm.verts.new((xa1, Y(sa), za)),
                                  bm.verts.new((xb1, Y(sb), zb)), bm.verts.new((xb0, Y(sb), zb))])
                f.normal_update()
                if f.normal.z < 0:
                    f.normal_flip()
        new_obj(name, bm, C)

    cx0, cx1, cs0, cs1 = COMP
    floor_grid("col_working_deck", 0.0, SH0, WD_Z, C, holes=((cx0, cx1, cs0, cs1),), inset=-0.05)
    deck_strip("col_shelter_deck", SH1, L - 0.15, lambda sv: top_z(sv) - 0.15, n=20, hole=WH_HOLE)
    # the sloped aft end of the shelter: solid, with the rail along its top
    # edge, open only where the stair comes up
    hb0 = half_breadth(SH1, zr) + 0.05
    for xa, xb in ((-hb0, STAIR_X - 0.45), (STAIR_X + 0.55, hb0)):
        if xb - xa > 0.05:
            box("col_shelter_end", ((xa + xb) / 2, Y((SH0 - 0.05 + SH1 + 0.1) / 2), (WD_Z + zr + 1.1) / 2),
                (xb - xa, SH1 + 0.1 - (SH0 - 0.05), zr + 1.1 - WD_Z), C)
    # stair ramp (33 deg) on the sloped shelter end
    bm = bmesh.new()
    a, b = Y(SH0 - 0.6), Y(SH1)
    x0, x1 = STAIR_X - 0.42, STAIR_X + 0.5
    vs = [bm.verts.new(p) for p in ((x0, a, WD_Z), (x1, a, WD_Z), (x1, b, zr), (x0, b, zr))]
    f = bm.faces.new(vs)
    if f.normal.z < 0:
        f.normal_flip()
    new_obj("col_stair", bm, C)
    # bulwarks + rails (2.2 m tall walls along the hull sides)
    for side in (-1, 1):
        pts = [(sv, side * (half_breadth(sv, top_z(sv)) - 0.08)) for sv in np.linspace(0.0, L - 0.4, 40)]
        for (s_a, x_a), (s_b, x_b) in zip(pts[:-1], pts[1:]):
            zb = deck_z((s_a + s_b) / 2)
            c = Vector(((x_a + x_b) / 2, Y((s_a + s_b) / 2), zb + 1.1))
            d = Vector((x_b - x_a, s_b - s_a, 0))
            panel("col_bulwark", c, d, (0, 0, 1), d.length + 0.05, 2.4, C, 0.16)
    box("col_transom", (0, Y(0.1), WD_Z + 1.1), (2 * half_breadth(0.1, WD_Z), 0.2, 2.4), C)
    # wheelhouse: walls with the two side door gaps, forward console, furniture
    hw = 3.35
    z0 = top_z(WH0)
    box("col_wh_aft", (0, Y(WH0), z0 + 1.0), (2 * hw, 0.14, 2.2), C)
    box("col_wh_front", (0, Y(WH1 + 0.15), z0 + 1.0), (2 * hw, 0.4, 2.2), C)
    for side in (-1, 1):
        box("col_wh_side", (side * hw, Y((WH0 + 12.75) / 2), z0 + 1.0), (0.14, 12.75 - WH0, 2.2), C)
        box("col_wh_side", (side * hw, Y((13.5 + WH1 + 0.3) / 2), z0 + 1.0), (0.14, WH1 + 0.3 - 13.5, 2.2), C)
    box_hole("col_wh_floor", -hw, hw, WH0, WH1, z0 - 0.08, 0.16, C, WH_HOLE)
    box("col_uptake", (sum(UPTAKE) / 2, Y(12.925), z0 + 1.0), (UPTAKE[1] - UPTAKE[0] + 0.1, 0.8, 2.2), C)
    box("col_console", (0, Y(WH1 - 0.42), z0 + 0.5), (2 * hw, 0.85, 1.0), C)
    box("col_chart", (-hw + 0.75, Y(WH0 + 0.55), z0 + 0.5), (1.25, 0.95, 1.0), C)
    box("col_bench", (hw - 0.9, Y(WH0 + 0.4), z0 + 0.25), (1.45, 0.6, 0.5), C)
    # deck machinery
    box("col_drums", (0, Y(6.22), WD_Z + 1.1), (5.4, 3.9, 2.4), C)
    box("col_winches", (0, Y(9.1), WD_Z + 0.5), (6.8, 1.1, 1.0), C)
    for side in (-1, 1):
        box("col_gantry", (side * 3.7, Y(4.8), WD_Z + 1.2), (0.55, 1.4, 2.4), C)
        box("col_boxes", (side * 2.4, Y(10.25), WD_Z + 0.6), (0.6, 0.85, 1.2), C)
    box("col_crane", (-2.9, Y(7.85), WD_Z + 1.2), (0.75, 0.75, 2.4), C)
    box("col_windlass", (0, Y(21.0), top_z(21.0) - 0.15 + 0.4), (1.7, 1.0, 0.8), C)
    box("col_scuttle", (0, Y(19.0), top_z(19.0) - 0.15 + 0.2), (0.85, 0.85, 0.4), C)


build_hull()
build_decks()
build_appendages()
build_superstructure()
build_gear()
build_details()
build_collision()
build_interior()


# ------------------------------------------------------------------ merge
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


_hull_parts = [o for o in PARTS if o.data.materials[0] == M["hull"]]
_col_parts = [o for o in PARTS if o.data.materials[0] == M["collision"]]
_int_parts = [o for o in PARTS if o.data.materials[0] in INTERIOR]
_fit_parts = [o for o in PARTS if o.data.materials[0] not in (M["hull"], M["collision"]) and o.data.materials[0] not in INTERIOR]
HULL = merge(_hull_parts, "hull")
FIT = merge(_fit_parts, "fittings")
COLL = merge(_col_parts, "collision")
INT = merge(_int_parts, "interior")
COLL.hide_render = True        # never occludes bakes or previews; exported for the game
INT.hide_render = True         # below decks: plain materials, not part of the bakes
for o in (HULL, FIT):
    o.data.calc_loop_triangles()
print("triangles", len(HULL.data.loop_triangles) + len(FIT.data.loop_triangles))


# ------------------------------------------------------------------ bake
def bake_setup():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("bake_world")
    sc.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.light_settings.distance = 2.0
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
    shade = 0.34 + 0.66 * occ ** 1.15                        # contact shadows
    dirt = np.array([0.93, 0.89, 0.82], np.float32)         # grime tint in crevices
    return np.clip(rgb * shade * (1 - (1 - dirt) * (1 - occ) * 1.4), 0, 1)


def to_image(name, rgb):
    h, w = rgb.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=False)
    im.pixels.foreach_set(np.concatenate([rgb, np.ones((h, w, 1), np.float32)], axis=2).ravel())
    im.pack()
    return im


def use_maps(mat, uv_name, color=None, normal=None, rough=None):
    nt = mat.node_tree
    p = nt.nodes["Principled BSDF"]

    def tex(image):
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = uv_name
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = image
        t.extension = "EXTEND"
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        return t

    for sock_name, image in (("Base Color", color), ("Roughness", rough)):
        if image is None:
            continue
        for link in list(p.inputs[sock_name].links):
            nt.links.remove(link)
        nt.links.new(tex(image).outputs["Color"], p.inputs[sock_name])
    if normal is not None:
        for link in list(p.inputs["Normal"].links):
            nt.links.remove(link)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = uv_name
        nt.links.new(tex(normal).outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])


bake_setup()

# Hull: AO straight into the livery layout (it has no overlaps), so the
# lettering keeps the livery's full resolution.
HULL.data.uv_layers.active = HULL.data.uv_layers["UVMap"]
hull_ao = bake(HULL, "AO", TEX_W, TEX_H, 48, non_color=True)
liv = np.empty(TEX_W * TEX_H * 4, np.float32)
LIVERY.pixels.foreach_get(liv)
hull_rgb = shade_from_ao(liv.reshape(TEX_H, TEX_W, 4)[..., :3], hull_ao[..., :1])
hull_img = to_image("hull_texture", hull_rgb)
use_maps(M["hull"], "UVMap", color=hull_img, normal=HULL_NORMAL, rough=HULL_ROUGH)

# Fittings: unwrap into one atlas; bake colour (incl. procedural grime and
# rust), AO, tangent-space normals (dents, rust scale) and roughness.
me = FIT.data
uv = me.uv_layers.new(name="bake")
me.uv_layers.active = uv
uv.active_render = True
for o in bpy.context.scene.objects:
    o.select_set(o == FIT)
bpy.context.view_layer.objects.active = FIT
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006, area_weight=0.0,
                         correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")
fit_col = bake(FIT, "DIFFUSE", ATLAS, ATLAS, 4, pass_filter={"COLOR"})
fit_ao = bake(FIT, "AO", ATLAS, ATLAS, 48, non_color=True)
fit_nrm = bake(FIT, "NORMAL", ATLAS, ATLAS, 4, non_color=True)
fit_rgh = bake(FIT, "ROUGHNESS", ATLAS, ATLAS, 4, non_color=True)
atlas = to_image("fittings_atlas", shade_from_ao(fit_col[..., :3], fit_ao[..., :1]))
atlas_n = make_image("fittings_normal", fit_nrm[..., :3], non_color=True)
atlas_r = make_image("fittings_rough", half_res(fit_rgh[..., :3]), non_color=True)
for m in me.materials:
    use_maps(m, "bake", color=atlas, normal=atlas_n, rough=atlas_r)
for name in [n.name for n in me.uv_layers if n.name != "bake"]:
    me.uv_layers.remove(me.uv_layers[name])

for im, fname in ((hull_img, "hull_texture.png"), (atlas, "fittings_atlas.png")):
    im.filepath_raw = os.path.join(OUT, fname)
    im.file_format = "PNG"
    im.save()

for ob in bpy.context.scene.objects:
    ob.select_set(ob in (HULL, FIT, COLL, INT))
bpy.context.view_layer.objects.active = HULL
glb = os.path.join(OUT, "trawler.glb")
common = dict(filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
              export_texcoords=True, export_normals=True, export_tangents=True, export_materials="EXPORT")
try:
    bpy.ops.export_scene.gltf(export_image_format="WEBP", export_image_quality=85, **common)
except TypeError:
    bpy.ops.export_scene.gltf(export_image_format="JPEG", export_jpeg_quality=88, **common)
print("wrote", glb, os.path.getsize(glb) // 1024, "KB")


# ------------------------------------------------------------------ preview renders
def preview():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("preview_world")
    sc.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.66, 0.72, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    sea = material("sea", (0.02, 0.04, 0.05), rough=0.12)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=400)
    me = bpy.data.meshes.new("sea")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(sea)
    so = bpy.data.objects.new("sea", me)
    so.location.z = -0.9      # riding light, as in the delivery photo
    sc.collection.objects.link(so)
    sd = bpy.data.lights.new("sun", "SUN")
    sd.energy = 3.0
    sd.angle = math.radians(2)
    sun = bpy.data.objects.new("sun", sd)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-25))
    sc.collection.objects.link(sun)
    cd = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 860
    views = {
        "photo": ((40.0, 34.0, 2.5), (0.0, 1.2, 4.2), 62),
        "profile": ((46.0, 0.0, 3.0), (0.0, 0.0, 4.0), 42),
        "stern_quarter": ((-20.0, -26.0, 10.0), (0.0, -2.0, 4.0), 40),
        "bow_low": ((16.0, 30.0, 1.5), (0.0, 6.0, 4.0), 40),
    }
    for name, (pos, target, lens) in views.items():
        cd.lens = lens
        cam.location = pos
        cam.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(OUT, f"render_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", sc.render.filepath)


if RENDER:
    preview()
