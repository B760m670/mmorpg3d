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
WH0, WH1, WH_LEAN = 12.2, 18.3, 0.5  # wheelhouse (drawing)


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
    d = max(0.0, stem_s(z) - s)
    k = lerp(0.36, 0.78, smooth(-3.0, 5.4, z))  # finer entrance, fuller with height = flare
    if y <= 1e-4:
        return 0.0
    return max(0.0, y * math.tanh(k * d / y))


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


def material(name, color, rough=0.5, metal=0.0, emit=None, grime=0.0):
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
    if grime > 0:
        # Vertical rain streaks + blotches, baked into the atlas later.
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (2.2, 2.2, 0.12)
        streak = nt.nodes.new("ShaderNodeTexNoise")
        streak.inputs["Scale"].default_value = 3.0
        streak.inputs["Detail"].default_value = 4.0
        blot = nt.nodes.new("ShaderNodeTexNoise")
        blot.inputs["Scale"].default_value = 0.9
        blot.inputs["Detail"].default_value = 6.0
        r1 = nt.nodes.new("ShaderNodeMapRange")
        r1.inputs["From Min"].default_value = 0.52
        r1.inputs["From Max"].default_value = 0.75
        r2 = nt.nodes.new("ShaderNodeMapRange")
        r2.inputs["From Min"].default_value = 0.45
        r2.inputs["From Max"].default_value = 0.8
        add = nt.nodes.new("ShaderNodeMath")
        add.operation = "ADD"
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = grime
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.inputs["A"].default_value = (*color, 1.0)
        mix.inputs["B"].default_value = (color[0] * 0.62, color[1] * 0.58, color[2] * 0.5, 1.0)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], streak.inputs["Vector"])
        nt.links.new(tc.outputs["Object"], blot.inputs["Vector"])
        nt.links.new(streak.outputs["Fac"], r1.inputs["Value"])
        nt.links.new(blot.outputs["Fac"], r2.inputs["Value"])
        nt.links.new(r1.outputs["Result"], add.inputs[0])
        nt.links.new(r2.outputs["Result"], add.inputs[1])
        nt.links.new(add.outputs["Value"], mul.inputs[0])
        nt.links.new(mul.outputs["Value"], mix.inputs["Factor"])
        nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
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


# ------------------------------------------------------------------ materials
M = {
    "hull": material("hull_livery", (1, 1, 1), rough=0.38),
    "white": material("paint_white", (0.84, 0.85, 0.83), rough=0.42, grime=0.32),
    "deck": material("deck_paint", (0.17, 0.23, 0.2), rough=0.85, grime=0.5),
    "orange": material("paint_orange", (0.9, 0.33, 0.06), rough=0.45, grime=0.15),
    "rail_white": material("rail_white", (0.86, 0.87, 0.85), rough=0.4),
    "glass": material("glass", (0.025, 0.035, 0.045), rough=0.04, metal=0.3),
    "steel": material("steel", (0.45, 0.46, 0.47), rough=0.38, metal=0.85),
    "dark": material("dark_steel", (0.06, 0.06, 0.065), rough=0.6, metal=0.4),
    "machinery": material("machinery", (0.18, 0.24, 0.3), rough=0.5, grime=0.3),
    "net": material("net_green", (0.08, 0.26, 0.13), rough=0.95),
    "drum": material("drum_grey", (0.62, 0.64, 0.64), rough=0.45, grime=0.25),
    "antifoul": material("antifouling", (0.34, 0.11, 0.07), rough=0.8),
    "red": material("paint_red", (0.48, 0.008, 0.005), rough=0.4),
    "radar": material("radar_black", (0.03, 0.03, 0.03), rough=0.35),
    "yellow": material("searchlight", (0.85, 0.65, 0.08), rough=0.35),
    "flag": material("flag_red", (0.62, 0.05, 0.04), rough=0.8),
    "red_light": material("light_red", (0.4, 0.02, 0.02), emit=(1.0, 0.08, 0.05)),
    "green_light": material("light_green", (0.02, 0.4, 0.05), emit=(0.1, 1.0, 0.2)),
    "white_light": material("light_white", (0.7, 0.7, 0.65), emit=(1.0, 0.95, 0.85)),
}


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


def paint_side(img, cols, side):
    """Paint one side's livery into img[:, cols]; side +1 = starboard."""
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


def paint_transom(img, cols):
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
    img[:, cols] = col


def build_livery():
    img = np.zeros((TEX_H, TEX_W, 3), np.float32)
    paint_side(img, slice(0, SIDE_W), +1)
    paint_side(img, slice(SIDE_W, 2 * SIDE_W), -1)
    paint_transom(img, slice(2 * SIDE_W, TEX_W))
    img = np.clip(img, 0, 1)
    rgba = np.concatenate([img, np.ones((TEX_H, TEX_W, 1), np.float32)], axis=2)
    im = bpy.data.images.new("hull_livery", TEX_W, TEX_H, alpha=False)
    im.pixels.foreach_set(rgba.ravel())
    im.pack()
    return im


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

    surface("working_deck", 0.0, SH0, M["deck"])
    surface("shelter_end", SH0, SH1, M["white"])
    surface("shelter_roof", SH1, L, M["deck"])
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


# ------------------------------------------------------------------ superstructure
def build_superstructure():
    W, O = M["white"], M["orange"]
    zr = top_z(WH0) - 0.15                     # shelter roof under the wheelhouse
    hw = 3.35
    z0, z1 = zr + 0.75, 7.35
    solid("wh_base", [(-hw + 0.2, Y(WH0), zr), (hw - 0.2, Y(WH0), zr), (hw - 0.2, Y(WH1 - 0.2), zr),
                      (-hw + 0.2, Y(WH1 - 0.2), zr)],
          [(-hw + 0.2, Y(WH0), z0), (hw - 0.2, Y(WH0), z0), (hw - 0.2, Y(WH1 - 0.2), z0),
           (-hw + 0.2, Y(WH1 - 0.2), z0)], W, bevel=0.04)
    solid("wheelhouse", [(-hw, Y(WH0), z0), (hw, Y(WH0), z0), (hw, Y(WH1), z0), (-hw, Y(WH1), z0)],
          [(-hw, Y(WH0), z1), (hw, Y(WH0), z1), (hw * 0.97, Y(WH1 + WH_LEAN), z1), (-hw * 0.97, Y(WH1 + WH_LEAN), z1)],
          W, bevel=0.05)
    ov = 0.28
    solid("wh_fascia", [(-hw - ov, Y(WH0 - ov), z1), (hw + ov, Y(WH0 - ov), z1),
                        (hw + ov, Y(WH1 + WH_LEAN + ov), z1), (-hw - ov, Y(WH1 + WH_LEAN + ov), z1)],
          [(-hw - ov, Y(WH0 - ov), z1 + 0.42), (hw + ov, Y(WH0 - ov), z1 + 0.42),
           (hw + ov, Y(WH1 + WH_LEAN + ov + 0.15), z1 + 0.42), (-hw - ov, Y(WH1 + WH_LEAN + ov + 0.15), z1 + 0.42)],
          O, bevel=0.03)
    zt = z1 + 0.42
    fu = Vector((0, WH_LEAN, z1 - z0)).normalized()
    for i in range(5):
        x = -hw * 0.78 + i * (hw * 1.56 / 4)
        c = Vector((x, Y(WH1) + WH_LEAN * 0.56 + 0.035, z0 + (z1 - z0) * 0.56))
        panel("wh_front_win", c, (1, 0, 0), fu, 1.08, 0.95, M["glass"], 0.06)
        if i < 4:
            panel("wh_mullion", c + Vector((hw * 1.56 / 8, 0.0, 0.0)), (1, 0, 0), fu, 0.1, 1.05, W, 0.08)
    for side in (-1, 1):
        for s in (14.9, 15.95, 17.0):
            panel("wh_side_win", (side * (hw + 0.025), Y(s), z0 + 0.72), (0, 1, 0), (0, 0, 1), 0.9, 0.85, M["glass"], 0.06)
        panel("wh_door", (side * (hw + 0.02), Y(13.1), z0 + 0.35), (0, 1, 0), (0, 0, 1), 0.75, 1.5, M["dark"], 0.04)
        panel("wh_door_win", (side * (hw + 0.045), Y(13.1), z0 + 0.8), (0, 1, 0), (0, 0, 1), 0.4, 0.4, M["glass"], 0.03)
        box("nav_screen", (side * (hw + 0.2), Y(17.6), z1 - 0.15), (0.06, 0.6, 0.35), M["dark"])
        box("nav_light", (side * (hw + 0.3), Y(17.75), z1 - 0.15), (0.12, 0.25, 0.22),
            M["green_light"] if side > 0 else M["red_light"])
    for x in (-2.1, -0.7, 0.7, 2.1):
        panel("wh_aft_win", (x, Y(WH0) - 0.025, z0 + 0.72), (1, 0, 0), (0, 0, 1), 1.0, 0.8, M["glass"], 0.06)
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
    cyl("exhaust", (2.0, Y(13.0), zt), (2.0, Y(13.0), zt + 1.1), 0.32, W, seg=14)
    cyl("exhaust_top", (2.0, Y(13.0), zt + 1.1), (2.0, Y(13.0), zt + 1.35), 0.26, M["dark"], seg=14)
    cyl("horn", (-0.8, Y(15.6), zt + 0.25), (-0.8, Y(16.1), zt + 0.32), 0.08, M["steel"], seg=8, r2=0.14)

    for x in (-3.9, 3.9):
        torus("lifebuoy", (x, Y(18.9), zr + 0.65), (1, 0, 0), 0.3, 0.07, O)
    for side in (-1, 1):
        cyl("liferaft", (side * 2.8, Y(12.0), zr + 0.4), (side * 2.8, Y(12.0) + 1.1, zr + 0.4), 0.33, M["rail_white"], seg=16)
        box("liferaft_cradle", (side * 2.8, Y(12.0) + 0.55, zr + 0.06), (0.6, 1.1, 0.12), M["steel"])
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


build_hull()
build_decks()
build_appendages()
build_superstructure()
build_gear()


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
_fit_parts = [o for o in PARTS if o.data.materials[0] != M["hull"]]
HULL = merge(_hull_parts, "hull")
FIT = merge(_fit_parts, "fittings")
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


def use_texture(mat, image, uv_name):
    nt = mat.node_tree
    p = nt.nodes["Principled BSDF"]
    for link in list(p.inputs["Base Color"].links):
        nt.links.remove(link)
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = uv_name
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.extension = "EXTEND"
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])


bake_setup()

# Hull: AO straight into the livery layout (it has no overlaps), so the
# lettering keeps the livery's full resolution.
HULL.data.uv_layers.active = HULL.data.uv_layers["UVMap"]
hull_ao = bake(HULL, "AO", TEX_W, TEX_H, 48, non_color=True)
liv = np.empty(TEX_W * TEX_H * 4, np.float32)
LIVERY.pixels.foreach_get(liv)
hull_rgb = shade_from_ao(liv.reshape(TEX_H, TEX_W, 4)[..., :3], hull_ao[..., :1])
hull_img = to_image("hull_texture", hull_rgb)
use_texture(M["hull"], hull_img, "UVMap")

# Fittings: unwrap into one atlas, bake colour (incl. procedural grime) + AO.
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
atlas = to_image("fittings_atlas", shade_from_ao(fit_col[..., :3], fit_ao[..., :1]))
for m in me.materials:
    use_texture(m, atlas, "bake")
for name in [n.name for n in me.uv_layers if n.name != "bake"]:
    me.uv_layers.remove(me.uv_layers[name])

for im, fname in ((hull_img, "hull_texture.png"), (atlas, "fittings_atlas.png")):
    im.filepath_raw = os.path.join(OUT, fname)
    im.file_format = "PNG"
    im.save()

for ob in bpy.context.scene.objects:
    ob.select_set(ob in (HULL, FIT))
bpy.context.view_layer.objects.active = HULL
glb = os.path.join(OUT, "trawler.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
    export_texcoords=True, export_normals=True, export_materials="EXPORT",
    export_image_format="JPEG", export_jpeg_quality=90,
)
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
