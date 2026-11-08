"""
A crewman for the trawler: a North-Norwegian fisherman, 1.80 m, in orange
PVC bib-and-brace oilskin trousers over a dark wool sweater, rubber boots,
a knitted cap, a beard. Built procedurally: a skeleton of joints with radii
is skinned into a body (Skin modifier) and smoothed; the clothes are regions
of that surface with their own materials; cap, nose, ears and eyes are
small extra parts. Rigged with 16 bones, weighted by distance to the bones,
and animated: idle, walk, run, helm (hands on the controls), haul (working
on deck).

Materials are named so the game can dress each man differently:
  skin, beard, knit (sweater), oilskin (trousers / bib), boots, gloves, cap, eye.

Output: crew.glb in the given directory (glTF Y-up, the man faces +Z).
Run with the bpy module:  python build_crew.py -- <out_dir>
"""

import bpy  # noqa: I001
import bmesh
import math
import os
import sys

from mathutils import Vector, Matrix, Quaternion

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)
RENDER = "--render" in ARGS

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- skeleton
# Blender coordinates: the man faces -Y, +X is his left, Z up, feet at 0.
J = {
    "root": (0, 0.0, 0.98), "spine": (0, 0.006, 1.13), "chest": (0, 0.0, 1.33),
    "neck": (0, 0.012, 1.50), "jaw": (0, 0.0, 1.585),
}
SIDE = {
    "clav": (0.07, 0.008, 1.455), "shoulder": (0.195, 0.012, 1.445), "elbow": (0.245, 0.03, 1.17),
    "wrist": (0.27, 0.0, 0.935), "hand": (0.272, -0.012, 0.85), "thumb": (0.25, -0.05, 0.895),
    "hip": (0.098, 0.0, 0.94), "knee": (0.104, -0.012, 0.52), "ankle": (0.104, 0.028, 0.095), "toe": (0.104, -0.135, 0.045),
}
for k, (x, y, z) in SIDE.items():
    J[f"{k}.L"] = (x, y, z)
    J[f"{k}.R"] = (-x, y, z)
# radii (across, front-back), m: the clothes' bulk is in them
R = {
    "root": (0.185, 0.13), "spine": (0.165, 0.118), "chest": (0.19, 0.125), "neck": (0.06, 0.062),
    "jaw": (0.052, 0.055),
    "clav": (0.075, 0.07), "shoulder": (0.07, 0.07), "elbow": (0.052, 0.052), "wrist": (0.04, 0.033),
    "hand": (0.036, 0.02), "thumb": (0.017, 0.017), "hip": (0.095, 0.095), "knee": (0.074, 0.074),
    "ankle": (0.066, 0.068), "toe": (0.048, 0.04),
}
EDGES = [("root", "spine"), ("spine", "chest"), ("chest", "neck"), ("neck", "jaw")]
J["crown"] = (0, 0.0, 1.79)              # for the head bone only
for s in ("L", "R"):
    EDGES += [("chest", f"clav.{s}"), (f"clav.{s}", f"shoulder.{s}"), (f"shoulder.{s}", f"elbow.{s}"),
              (f"elbow.{s}", f"wrist.{s}"), (f"wrist.{s}", f"hand.{s}"), (f"wrist.{s}", f"thumb.{s}"),
              ("root", f"hip.{s}"), (f"hip.{s}", f"knee.{s}"), (f"knee.{s}", f"ankle.{s}"), (f"ankle.{s}", f"toe.{s}")]

names = [n for n in J if n != "crown"]
me = bpy.data.meshes.new("skel")
me.from_pydata([J[n] for n in names], [(names.index(a), names.index(b)) for a, b in EDGES], [])
body = bpy.data.objects.new("body", me)
bpy.context.collection.objects.link(body)
sk = body.modifiers.new("skin", "SKIN")
sk.branch_smoothing = 0.6
sk.use_smooth_shade = True
for i, n in enumerate(names):
    v = me.skin_vertices[0].data[i]
    v.radius = R[n.split(".")[0]]
    v.use_root = n == "root"
sub = body.modifiers.new("sub", "SUBSURF")
sub.levels = 2
sub.render_levels = 2
bpy.context.view_layer.objects.active = body
body.select_set(True)
bpy.ops.object.modifier_apply(modifier="skin")
bpy.ops.object.modifier_apply(modifier="sub")
bpy.ops.object.shade_smooth()


def mat(name, col, rough, metal=0.0, spec=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m


M = {
    "skin": mat("skin", (0.5, 0.27, 0.18), 0.55),           # weathered, fair
    "beard": mat("beard", (0.16, 0.1, 0.06), 0.9),
    "knit": mat("knit", (0.06, 0.08, 0.14), 0.95),
    "oilskin": mat("oilskin", (0.85, 0.24, 0.03), 0.38),
    "boots": mat("boots", (0.025, 0.025, 0.028), 0.45),
    "gloves": mat("gloves", (0.5, 0.27, 0.18), 0.55),
    "lips": mat("lips", (0.32, 0.12, 0.09), 0.5),
    "cap": mat("cap", (0.45, 0.06, 0.05), 0.95),
    "eye": mat("eye", (0.03, 0.03, 0.035), 0.2),
}
ORDER = list(M)
for m in M.values():
    body.data.materials.append(m)


def seg_dist(p, a, b):
    a, b = Vector(a), Vector(b)
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


# clothes and skin by region of the surface
bm = bmesh.new()
bm.from_mesh(body.data)
for f in bm.faces:
    c = f.calc_center_median()
    x, y, z = c
    ax = abs(x)
    hand = min(seg_dist(c, J["wrist.L"], J["hand.L"]), seg_dist(c, J["wrist.R"], J["hand.R"]),
               seg_dist(c, J["wrist.L"], J["thumb.L"]), seg_dist(c, J["wrist.R"], J["thumb.R"]))
    arm = min(seg_dist(c, J["shoulder.L"], J["wrist.L"]), seg_dist(c, J["shoulder.R"], J["wrist.R"]))
    torso = seg_dist(c, J["root"], J["neck"])
    name = "knit"
    if z > 1.555:
        name = "skin"                                       # the neck above the collar
    elif hand < 0.05 and z < 0.99:
        name = "gloves"
    elif z < 0.39 and arm > 0.08:
        name = "boots"
    elif arm < torso and arm < 0.09 and z > 0.9:
        name = "knit"                                       # sleeves
    elif z < 1.17:
        name = "oilskin"                                    # trousers
    elif z < 1.37 and y < -0.02 and ax < 0.125:
        name = "oilskin"                                    # the bib in front
    elif 0.065 < ax < 0.115 and z < 1.47 and torso < 0.2:
        name = "oilskin"                                    # braces over the shoulders
    f.material_index = ORDER.index(name)
bm.to_mesh(body.data)
bm.free()


def add_part(name, matname, build):
    bm = bmesh.new()
    build(bm)
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m)
    bm.free()
    o = bpy.data.objects.new(name, m)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(M[matname])
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def sphere(bm, c, r, sc=(1, 1, 1), seg=16, rings=10):
    g = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    for v in g["verts"]:
        v.co = Vector((v.co.x * sc[0], v.co.y * sc[1], v.co.z * sc[2])) + Vector(c)
    return g["verts"]


parts = []


def head(bm):
    """A head: an egg-shaped cranium, the face below it narrowing to the jaw
    and chin, brow ridge and eye sockets, cheekbones, the back of the skull."""
    c = Vector((0, -0.006, 1.672))
    g = bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=22, radius=1.0)
    for v in g["verts"]:
        x, y, z = v.co                       # unit sphere; y < 0 is the face
        hx, hy, hz = 0.078, 0.098, 0.112
        # jaw narrows below the cheekbones, chin forward
        low = max(0.0, -z - 0.12)
        sx = 1.0 - 0.3 * min(1.0, low * 1.5) ** 1.5
        sy = 1.0 - 0.16 * min(1.0, low * 1.4)
        fy = y * hy * sy
        if y < 0:
            fy -= 0.012 * max(0.0, -z - 0.55) * 3 * max(0.0, -y)       # chin
            fy *= 1.0 - 0.1 * max(0.0, z - 0.45)                      # sloping forehead
        if y > 0 and -0.2 < z < 0.5:
            fy += 0.008 * y                                           # back of the skull
        p = Vector((x * hx * sx, fy, z * hz))
        # eye sockets and the brow over them
        for ex in (-0.33, 0.33):
            d2 = (x - ex) ** 2 * 6 + (z - 0.18) ** 2 * 9
            if y < -0.6:
                p.y += 0.007 * math.exp(-d2 * 3.5)
                p.y -= 0.004 * math.exp(-((x - ex) ** 2 * 6 + (z - 0.33) ** 2 * 30) * 2)
        # cheekbones
        if y < -0.3:
            for ex in (-0.55, 0.55):
                p.x += math.copysign(0.004, ex) * math.exp(-((x - ex) ** 2 + (z - 0.02) ** 2) * 18)
        v.co = c + p
    return g["verts"]


hd = add_part("head", "skin", head)
hd.data.materials.append(M["beard"])
hd.data.materials.append(M["lips"])
# a short beard along the jaw and chin, a moustache, the mouth between
for poly in hd.data.polygons:
    x, y, z = poly.center
    ax = abs(x)
    mouth = 1.626 < z < 1.634 and ax < 0.02 and y < -0.07
    beard = z < 1.645 and y < 0.035 and (y > -0.04 or z < 1.638 or ax < 0.035)
    if mouth:
        poly.material_index = 2
    elif beard:
        poly.material_index = 1
parts.append(hd)
# knitted cap: a dome over the crown with a turned-up cuff
def cap(bm):
    vs = sphere(bm, (0, 0.0, 1.70), 0.083, (1.0, 1.22, 1.22), 20, 12)
    for v in vs:
        if v.co.z < 1.718:
            v.co.z = 1.718 + (v.co.z - 1.718) * 0.08
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(v.co.z < 1.72 for v in f.verts)], context="FACES")
    g = bmesh.ops.create_cone(bm, cap_ends=False, segments=20, radius1=0.086, radius2=0.084, depth=0.035)
    for v in g["verts"]:
        v.co = Vector((v.co.x, v.co.y * 1.18, v.co.z + 1.728))
parts.append(add_part("cap", "cap", cap))
def nose(bm):
    vs = sphere(bm, (0, -0.0985, 1.668), 0.017, (0.7, 1.0, 1.5), 12, 8)
    for v in vs:
        t = (v.co.z - 1.643) / 0.05                    # bridge narrow at the top, tip and wings below
        v.co.y -= 0.008 * max(0.0, 1 - abs(t - 0.35) * 2)
        v.co.x *= 1.0 + 0.4 * max(0.0, 0.4 - t)
parts.append(add_part("nose", "skin", nose))
parts.append(add_part("ears", "skin", lambda bm: (sphere(bm, (0.077, 0.004, 1.67), 0.02, (0.4, 0.85, 1.4), 10, 8),
                                                 sphere(bm, (-0.077, 0.004, 1.67), 0.02, (0.4, 0.85, 1.4), 10, 8))))
parts.append(add_part("eyes", "eye", lambda bm: (sphere(bm, (0.03, -0.087, 1.69), 0.0075, (1, 0.55, 0.8), 8, 6),
                                                sphere(bm, (-0.03, -0.087, 1.69), 0.0075, (1, 0.55, 0.8), 8, 6))))
parts.append(add_part("brows", "beard", lambda bm: (sphere(bm, (0.031, -0.091, 1.703), 0.015, (1.25, 0.32, 0.26), 8, 6),
                                                   sphere(bm, (-0.031, -0.091, 1.703), 0.015, (1.25, 0.32, 0.26), 8, 6))))
# boot soles: a slightly wider dark rim at the ground
parts.append(add_part("soles", "boots", lambda bm: (sphere(bm, (0.104, -0.045, 0.02), 0.075, (0.95, 1.85, 0.3), 14, 6),
                                                   sphere(bm, (-0.104, -0.045, 0.02), 0.075, (0.95, 1.85, 0.3), 14, 6))))
bpy.ops.object.select_all(action="DESELECT")
for o in parts + [body]:
    o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()

# ---------------------------------------------------------------- armature
BONES = [  # name, head joint, tail joint, parent
    ("hips", "root", "spine", None), ("spine", "spine", "chest", "hips"), ("chest", "chest", "neck", "spine"),
    ("neck", "neck", "jaw", "chest"), ("head", "jaw", "crown", "neck"),
]
for s in ("L", "R"):
    BONES += [(f"clav.{s}", "chest", f"shoulder.{s}", "chest"), (f"upperarm.{s}", f"shoulder.{s}", f"elbow.{s}", f"clav.{s}"),
              (f"forearm.{s}", f"elbow.{s}", f"wrist.{s}", f"upperarm.{s}"), (f"hand.{s}", f"wrist.{s}", f"hand.{s}", f"forearm.{s}"),
              (f"thigh.{s}", f"hip.{s}", f"knee.{s}", "hips"), (f"shin.{s}", f"knee.{s}", f"ankle.{s}", f"thigh.{s}"),
              (f"foot.{s}", f"ankle.{s}", f"toe.{s}", f"shin.{s}")]
arm_d = bpy.data.armatures.new("rig")
rig = bpy.data.objects.new("crewman", arm_d)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
for n, h, t, p in BONES:
    b = arm_d.edit_bones.new(n)
    b.head = J[h]
    b.tail = J[t]
    if n == "hips":
        b.tail = (0, 0.006, 1.13)
    if p:
        b.parent = arm_d.edit_bones[p]
        b.use_connect = False
bpy.ops.object.mode_set(mode="OBJECT")

# weights: by distance to each bone, sharpened; the head parts go to the head
body = bpy.data.objects["body"]
segs = {n: (Vector(J[h]), Vector(J[t])) for n, h, t, _ in BONES}
groups = {n: body.vertex_groups.new(name=n) for n, *_ in BONES}
for v in body.data.vertices:
    p = v.co
    if p.z > 1.585:
        groups["head"].add([v.index], 1.0, "REPLACE")
        continue
    d = {n: max(1e-4, seg_dist(p, a, b)) for n, (a, b) in segs.items()}
    # keep the legs off the arms and each other
    if p.z < 0.9:
        for n in list(d):
            if n.startswith(("upperarm", "forearm", "hand", "clav")) and abs(p.x) < 0.2:
                d[n] *= 4
    dmin = min(d.values())
    w = {n: (dmin / dd) ** 6 for n, dd in d.items() if dd < dmin * 1.8}
    tot = sum(w.values())
    for n, ww in w.items():
        groups[n].add([v.index], ww / tot, "REPLACE")
body.parent = rig
mod = body.modifiers.new("rig", "ARMATURE")
mod.object = rig

# ---------------------------------------------------------------- animation
FPS = 30
bpy.context.scene.render.fps = FPS
rest = {b.name: b.matrix_local.to_3x3() for b in arm_d.bones}


def qworld(bone, axis, deg):
    """A rotation about a world axis, as the bone's local (basis) rotation."""
    r = Matrix.Rotation(math.radians(deg), 3, axis)
    m = rest[bone]
    return (m.inverted() @ r @ m).to_quaternion()


def pose(fr, rots, loc=None):
    for b in arm_d.bones:
        pb = rig.pose.bones[b.name]
        pb.rotation_mode = "QUATERNION"
        q = Quaternion()
        for axis, deg in rots.get(b.name, []):
            q = qworld(b.name, axis, deg) @ q
        pb.rotation_quaternion = q
        pb.keyframe_insert("rotation_quaternion", frame=fr)
    hb = rig.pose.bones["hips"]
    hb.location = loc or (0, 0, 0)
    hb.keyframe_insert("location", frame=fr)


rig.animation_data_create()


def action(name, frames, fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data.action = act
    for i in range(frames + 1):
        rots, loc = fn(i / frames)
        pose(i, rots, loc)
    return act


S = math.sin
TAU = math.pi * 2
# forward swing of a limb is a negative rotation about X here (front is -Y)


def walk_fn(speed):
    def fn(p):
        a = TAU * p
        sw, kn, ar = (24, 55, 16) if speed == "walk" else (38, 85, 40)
        rots = {}
        for s, ph in (("L", 0.0), ("R", math.pi)):
            leg = S(a + ph)
            rots[f"thigh.{s}"] = [("X", -sw * leg)]
            # the knee bends in the swing (leg going forward) and a little at heel strike
            bend = max(0.0, S(a + ph + 1.1)) * kn + 6
            rots[f"shin.{s}"] = [("X", bend)]
            rots[f"foot.{s}"] = [("X", -8 * S(a + ph + 0.5))]
            rots[f"upperarm.{s}"] = [("X", sw * 0.7 * leg if speed == "walk" else ar * leg), ("Y", 5 if s == "L" else -5)]
            rots[f"forearm.{s}"] = [("X", -(14 if speed == "walk" else 70) - 8 * max(0, -leg))]
        rots["hips"] = [("Z", 5 * S(a))]
        rots["spine"] = [("Z", -4 * S(a)), ("X", -2 if speed == "walk" else -10)]
        rots["chest"] = [("Z", -3 * S(a))]
        bob = (0.018 if speed == "walk" else 0.04) * (0.5 + 0.5 * math.cos(2 * a))
        return rots, (0, bob, 0)
    return fn


def idle_fn(p):
    a = TAU * p
    return {
        "chest": [("X", 1.2 * S(a * 2))],                      # breathing
        "head": [("Z", 9 * S(a)), ("X", 3 * S(a * 2 + 1))],    # looking about
        "hips": [("Y", 1.5 * S(a))],
        "upperarm.L": [("Y", -4)], "upperarm.R": [("Y", 4)],
        "forearm.L": [("X", -10)], "forearm.R": [("X", -10)],
        "spine": [("X", 1 * S(a * 2))],
    }, (0.0, 0.0, 0.0)


def helm_fn(p):
    # standing at the controls: hands forward on the wheel / joystick, the
    # body riding the ship's motion
    a = TAU * p
    return {
        "upperarm.L": [("X", -38), ("Z", -10)], "upperarm.R": [("X", -38), ("Z", 10)],
        "forearm.L": [("X", -62 + 4 * S(a))], "forearm.R": [("X", -62 - 4 * S(a))],
        "hand.L": [("Y", 20)], "hand.R": [("Y", -20)],
        "spine": [("X", -4), ("Y", 2 * S(a))],
        "head": [("X", -4 + 2 * S(a * 2)), ("Z", 6 * S(a * 0.5 * 2))],
        "thigh.L": [("Y", 3)], "thigh.R": [("Y", -3)],
    }, (0, 0, 0)


def haul_fn(p):
    # hauling on a rope / working gear: bend, reach, pull back
    a = TAU * p
    pull = 0.5 - 0.5 * math.cos(a)
    return {
        "spine": [("X", -18 + 14 * pull)], "chest": [("X", -10 + 8 * pull)],
        "hips": [("X", -8 + 6 * pull)],
        "upperarm.L": [("X", -70 + 55 * pull)], "upperarm.R": [("X", -75 + 55 * pull)],
        "forearm.L": [("X", -20 - 60 * pull)], "forearm.R": [("X", -25 - 60 * pull)],
        "thigh.L": [("X", -20 + 10 * pull)], "thigh.R": [("X", 10 - 6 * pull)],
        "shin.L": [("X", 25 - 10 * pull)], "shin.R": [("X", 12)],
        "head": [("X", 8 - 6 * pull)],
    }, (0, -0.06 + 0.04 * pull, 0)


acts = [action("idle", 120, idle_fn), action("walk", 33, walk_fn("walk")), action("run", 21, walk_fn("run")),
        action("helm", 150, helm_fn), action("haul", 60, haul_fn)]
for act in acts:
    tr = rig.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, 0, act)
rig.animation_data.action = None

# ---------------------------------------------------------------- export
bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
body.select_set(True)
path = os.path.join(OUT, "crew.glb")
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                          export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
                          export_apply=False, export_force_sampling=True, export_frame_range=False)
print("wrote", path, os.path.getsize(path) // 1024, "KB", "tris", sum(len(p.vertices) - 2 for p in body.data.polygons))

if RENDER:
    # a preview: three-quarter view, studio light
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 24
    scn.render.resolution_x, scn.render.resolution_y = 640, 800
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scn.collection.objects.link(cam)
    cam.location = (1.6, -2.6, 1.35)
    cam.rotation_euler = (math.radians(86), 0, math.radians(32))
    scn.camera = cam
    for loc, e in (((2, -2, 3), 260), ((-2, -1, 2), 90), ((0, 2, 2.5), 140)):
        L = bpy.data.objects.new("l", bpy.data.lights.new("l", "AREA"))
        L.data.energy = e
        L.data.size = 2
        L.location = loc
        L.rotation_euler = (Vector((0, 0, 0.9)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scn.collection.objects.link(L)
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.5, 0.55, 0.6, 1)
    scn.world = w
    for tr in rig.animation_data.nla_tracks:
        tr.mute = True
    for name, act, fr in (("rest", "idle", 0), ("walk", "walk", 8), ("helm", "helm", 20), ("face", "idle", 0)):
        rig.animation_data.action = bpy.data.actions[act] if act else None
        if name == "face":
            cam.location = (0.25, -0.62, 1.68)
            cam.rotation_euler = (math.radians(90), 0, math.radians(22))
            cam.data.lens = 70
        for tr in rig.animation_data.nla_tracks:
            tr.mute = True
        scn.frame_set(fr)
        scn.render.filepath = os.path.join(OUT, f"crew_{name}.png")
        bpy.ops.render.render(write_still=True)
