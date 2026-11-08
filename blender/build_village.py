"""
Buildings and boulders for Reine, built procedurally in Blender.

One glTF with low-poly pieces the game instances at the real positions from
Kartverket's building register (see tools/build_landcover.py):

  house     1.5-storey timber house, gable roof, chimney (types 111-159)
  cabin     one-storey holiday cabin (161-163)
  rorbu     fisherman's cabin on posts at the shore, falu red (171, 524, 529)
  naust     boathouse, steep roof, big door in the gable (183, 245)
  shed      garage / outhouse (181, 182)
  sjohus    sea house on the quay, 2.5 storeys (244, 248)
  plant     fish plant / warehouse, low roof, roller doors (2xx, 231-239)
  shop      two-storey shop, office, hotel, public building (3xx, 5xx, 6xx)
  hjell     A-frame stockfish drying rack (not in the register)
  rock0-3   boulders for scree and moraine, 1 m across

Each building is split into parts by material, so the game can colour the
walls per house: <kind>_walls (white, tinted per instance), <kind>_roof,
<kind>_trim (window glass, doors), <kind>_wood (posts, frames), <kind>_base
(stone or concrete foundation reaching down). Origin: middle of the
footprint at floor level; the gable (front) faces -Z.

Run with the bpy module:  python build_village.py -- <out_dir>
"""

import bpy  # noqa: I001
import bmesh
import math
import os
import random
import sys

from mathutils import Vector, noise

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials):
    for item in list(coll):
        coll.remove(item)


def mat(name, color, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    return m


M = {
    "walls": mat("walls", (0.92, 0.92, 0.9), 0.85),          # tinted per instance in the game
    "roof": mat("roof", (0.09, 0.09, 0.1), 0.75),
    "roof_red": mat("roof_red", (0.32, 0.08, 0.05), 0.7),
    "trim": mat("trim", (0.04, 0.05, 0.06), 0.25),            # glass and doors
    "white": mat("white_trim", (0.88, 0.88, 0.86), 0.7),
    "wood": mat("wood", (0.16, 0.11, 0.07), 0.9),
    "base": mat("base", (0.36, 0.36, 0.35), 0.95),
    "rock": mat("rock", (0.55, 0.53, 0.5), 0.95),            # tinted per instance by bedrock
    "fish": mat("fish", (0.42, 0.36, 0.25), 0.9),
}
PARTS = {}


def add(kind, part, bm):
    PARTS.setdefault((kind, part), []).append(bm)


def box(bm, c, s):
    r = bmesh.ops.create_cube(bm, size=1.0)
    for v in r["verts"]:
        v.co = Vector((c[0] + v.co.x * s[0], c[1] + v.co.y * s[1], c[2] + v.co.z * s[2]))
    return r


def prism_roof(bm, w, d, z0, pitch_deg, over=0.35, thick=0.18):
    """Gable roof over a w (x) by d (y) footprint, ridge along y, eaves at z0."""
    h = math.tan(math.radians(pitch_deg)) * (w / 2 + over)
    x0, x1 = -w / 2 - over, w / 2 + over
    y0, y1 = -d / 2 - over * 0.6, d / 2 + over * 0.6
    for sgn in (-1, 1):
        xa = sgn * (w / 2 + over)
        q = [Vector((xa, y0, z0)), Vector((0, y0, z0 + h)), Vector((0, y1, z0 + h)), Vector((xa, y1, z0))]
        top = [bm.verts.new(p) for p in q]
        bot = [bm.verts.new(p - Vector((0, 0, thick))) for p in q]
        bm.faces.new(top if sgn > 0 else list(reversed(top)))
        bm.faces.new(list(reversed(bot)) if sgn > 0 else bot)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new([top[i], top[j], bot[j], bot[i]] if sgn > 0 else [top[j], top[i], bot[i], bot[j]])
    return h


def gable_walls(bm, w, d, hw, roof_h):
    """Walls of a w x d box to height hw, with the two triangular gables."""
    box(bm, (0, 0, hw / 2), (w, d, hw))
    for y in (-d / 2, d / 2):
        vs = [bm.verts.new(p) for p in ((-w / 2, y, hw), (w / 2, y, hw), (0, y, hw + roof_h))]
        f = bm.faces.new(vs if y > 0 else list(reversed(vs)))


def windows(bm, w, d, rows, z_list, size=(1.0, 1.2), gable=True, sides=True):
    """Dark panes just proud of the walls."""
    ww, wh = size
    for z in z_list:
        if sides:
            n = max(1, int(d // 2.6))
            for k in range(n):
                y = -d / 2 + (k + 0.5) * d / n
                for sx in (-1, 1):
                    box(bm, (sx * (w / 2 + 0.03), y, z), (0.05, ww, wh))
        if gable:
            n = max(1, int(w // 2.8))
            for k in range(n):
                x = -w / 2 + (k + 0.5) * w / n
                for sy in (-1, 1):
                    box(bm, (x, sy * (d / 2 + 0.03), z), (ww, 0.05, wh))


def frames(bm, w, d, z_list, size=(1.0, 1.2), gable=True, sides=True):
    """White window frames around the panes."""
    ww, wh = size
    for z in z_list:
        spots = []
        if sides:
            n = max(1, int(d // 2.6))
            spots += [(sx * (w / 2 + 0.02), -d / 2 + (k + 0.5) * d / n, "x") for k in range(n) for sx in (-1, 1)]
        if gable:
            n = max(1, int(w // 2.8))
            spots += [(-w / 2 + (k + 0.5) * w / n, sy * (d / 2 + 0.02), "y") for k in range(n) for sy in (-1, 1)]
        for x, y, ax in spots:
            if ax == "x":
                box(bm, (x, y, z), (0.04, ww + 0.2, wh + 0.2))
            else:
                box(bm, (x, y, z), (ww + 0.2, 0.04, wh + 0.2))


def foundation(kind, w, d, depth=3.0):
    bm = bmesh.new()
    box(bm, (0, 0, -depth / 2 + 0.25), (w + 0.2, d + 0.2, depth + 0.5))
    add(kind, "base", bm)


def building(kind, w, d, hw, pitch, win_z, roof="roof", door_front=True, chimney=False, big_door=None, posts=None,
             base=True):
    roof_h = math.tan(math.radians(pitch)) * (w / 2 + 0.35)
    bm = bmesh.new()
    gable_walls(bm, w, d, hw, roof_h - math.tan(math.radians(pitch)) * 0.35)
    add(kind, "walls", bm)
    bm = bmesh.new()
    prism_roof(bm, w, d, hw, pitch)
    if chimney:
        box(bm, (w * 0.18, d * 0.15, hw + roof_h * 0.75), (0.6, 0.6, roof_h * 0.9))
    add(kind, "roof" if roof == "roof" else "roof_red", bm)
    bm = bmesh.new()
    windows(bm, w, d, 1, win_z)
    if door_front:
        box(bm, (w * 0.25, -d / 2 - 0.04, 1.05), (1.0, 0.06, 2.1))
    if big_door:
        bw, bh = big_door
        box(bm, (0, -d / 2 - 0.04, bh / 2), (bw, 0.06, bh))
    add(kind, "trim", bm)
    bm = bmesh.new()
    frames(bm, w, d, win_z)
    # corner boards and barge boards: white trim on Lofoten houses
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(bm, (sx * (w / 2 + 0.02), sy * (d / 2 + 0.02), hw / 2), (0.14, 0.14, hw))
    add(kind, "white", bm)
    if posts:
        bm = bmesh.new()
        n_x, n_y, length = posts
        for i in range(n_x):
            for j in range(n_y):
                x = -w / 2 + 0.3 + i * (w - 0.6) / max(1, n_x - 1)
                y = -d / 2 + 0.3 + j * (d - 0.6) / max(1, n_y - 1)
                box(bm, (x, y, -length / 2), (0.28, 0.28, length))
        box(bm, (0, 0, -0.15), (w + 0.4, d + 0.4, 0.3))          # deck under the floor
        add(kind, "wood", bm)
    elif base:
        foundation(kind, w, d)


# --- the buildings -------------------------------------------------------
building("house", 8.0, 9.5, 4.6, 38, [1.5, 3.4], chimney=True)
building("cabin", 6.0, 7.5, 2.7, 30, [1.4])
building("rorbu", 6.0, 8.5, 3.3, 35, [1.5], roof="roof_red", posts=(3, 3, 7.0))
building("naust", 5.0, 9.0, 2.2, 50, [1.4], big_door=(2.6, 2.4), door_front=False)
building("shed", 4.0, 6.0, 2.4, 30, [1.4], door_front=False, big_door=(2.4, 2.1))
building("sjohus", 10.0, 18.0, 7.0, 38, [1.6, 4.4], big_door=(3.0, 3.2), posts=(4, 6, 6.0))
building("plant", 18.0, 30.0, 7.5, 12, [5.5], big_door=(5.0, 4.5))
building("shop", 10.0, 16.0, 6.6, 32, [1.6, 4.6], chimney=True)

# --- stockfish rack (hjell): A-frames of poles with rails, 24 m long ---------
bm = bmesh.new()
L, H, W = 24.0, 4.5, 3.4


def pole(bm, a, b, r=0.09):
    a, b = Vector(a), Vector(b)
    d = b - a
    c = (a + b) / 2
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=5, radius1=r, radius2=r, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    for v in res["verts"]:
        v.co = rot @ v.co + c


for k in range(9):
    y = -L / 2 + k * L / 8
    pole(bm, (-W / 2, y, 0), (0, y, H))
    pole(bm, (W / 2, y, 0), (0, y, H))
for z, x in ((H, 0.0), (2.9, 0.62), (2.9, -0.62), (1.5, 1.25), (1.5, -1.25)):
    pole(bm, (x, -L / 2, z), (x, L / 2, z), 0.07)
add("hjell", "wood", bm)
bm = bmesh.new()             # pairs of cod hanging over the rails (Feb - May)
rnd = random.Random(3)
for z, x in ((2.9, 0.62), (2.9, -0.62), (1.5, 1.25), (1.5, -1.25)):
    for k in range(70):
        y = -L / 2 + 0.4 + k * (L - 0.8) / 70
        box(bm, (x + rnd.uniform(-0.04, 0.04), y, z - 0.45), (0.08, 0.14, 0.85))
add("hjell", "fish", bm)

# --- boulders ----------------------------------------------------------------
for k in range(4):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.5)
    off = Vector((k * 7.1, k * 3.3, k * 1.7))
    sq = (1.0, 0.85 + 0.1 * k, 0.55 + 0.1 * (k % 2))
    for v in bm.verts:
        n = noise.noise(v.co * 2.2 + off) * 0.25
        v.co = Vector((v.co.x * sq[0], v.co.y * sq[1], v.co.z * sq[2])) * (1.0 + n)
    # flatten facets a little: blocky, jointed rock rather than pebbles
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(14), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    add(f"rock{k}", "rock", bm)

# --- assemble and export -------------------------------------------------------
part_mat = {"walls": M["walls"], "roof": M["roof"], "roof_red": M["roof_red"], "trim": M["trim"],
            "white": M["white"], "wood": M["wood"], "base": M["base"], "rock": M["rock"], "fish": M["fish"]}
tris = 0
for (kind, part), bms in PARTS.items():
    bm = bmesh.new()
    for b in bms:
        me = bpy.data.meshes.new("tmp")
        b.to_mesh(me)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        b.free()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    tris += len(bm.faces)
    me = bpy.data.meshes.new(f"{kind}_{part}")
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = part == "rock"
    me.materials.append(part_mat[part])
    ob = bpy.data.objects.new(f"{kind}_{part}", me)
    bpy.context.scene.collection.objects.link(ob)
print("pieces", len(PARTS), "triangles", tris)

path = os.path.join(OUT, "village.glb")
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True,
                          export_materials="EXPORT", export_normals=True)
print("wrote", path, os.path.getsize(path) // 1024, "KB")
