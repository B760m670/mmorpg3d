"""Real materials for the ship: photo-scanned CC0 textures (Poly Haven,
ambientCG) packed for the game.

Each scan becomes three images in public/materials (loaded as separate
files, not inlined into the page):

    <name>_col.webp   colour (sRGB)
    <name>_nrm.webp   normal map, OpenGL (green up)
    <name>_orm.webp   R ambient occlusion, G roughness, B metalness (glTF)

and src/ship/scans.json gives each one's real size in metres
(the game lays the UVs in metres) and its source. All are turned so that
the grain (or the run of the planks) lies along u.

    python3 tools/pack_scans.py <raw dir with scans.json / scans_ph.json>
"""

import json
import os
import sys

import numpy as np
from PIL import Image

RAW = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "materials")
os.makedirs(OUT, exist_ok=True)

meta = {}
for f in ("scans_ph.json", "scans.json"):
    p = os.path.join(RAW, f)
    if os.path.exists(p):
        meta.update(json.load(open(p)))

# our name: (scan, size in metres along u and v, turn the grain to u, pixels, what it is for)
TABLE = {
    "hull_planks": ("weathered_brown_planks", 3.4, False, 2048, "the ship's side: weathered oak planking"),
    "deck_planks": ("old_planks_02", 2.6, True, 2048, "decks: worn, scrubbed planking"),
    "in_planks": ("weathered_planks", 2.4, True, 2048, "below decks: ceiling, deckheads, bulkheads"),
    "timber": ("rough_wood", 0.5, True, 2048, "beams, knees, carriages, bitts, frames"),
    "joinery": ("fine_grained_wood", 0.6, True, 1024, "cabin joinery, rails, furniture"),
    "black_wood": ("black_painted_planks", 1.6, True, 1024, "wales and black-painted work"),
    "red_paint": ("PaintedWood003", 1.5, False, 1024, "red-painted upper works and port lids"),
    "iron": ("rusty_metal_04", 1.0, False, 1024, "wrought and cast iron"),
    "lead": ("metal_plate_02", 2.0, False, 1024, "lead sheathing"),
    "brick": ("castle_brick_02_red", 1.5, False, 1024, "the galley hearth"),
    "bronze": ("Metal013", 1.0, False, 1024, "bronze guns and fittings"),
    "rope": ("Rope001", 0.5, False, 1024, "rope: u along it, v round it"),
    "canvas": ("Fabric045", 0.5, False, 1024, "sailcloth, bundles"),
}


def load(path, mode):
    return Image.open(path).convert(mode)


def turn_normal(im):
    """Rotate a tangent-space normal map by 90 deg (anticlockwise) and turn
    its vectors with it: (nx, ny) -> (-ny, nx)."""
    a = np.asarray(im.rotate(90, expand=True), np.float32) / 255.0
    nx, ny = a[..., 0] * 2 - 1, a[..., 1] * 2 - 1
    out = a.copy()
    out[..., 0] = (-ny) * 0.5 + 0.5
    out[..., 1] = nx * 0.5 + 0.5
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8))


credits = {}
index = {}
for name, (scan, size, turn, px, what) in TABLE.items():
    m = meta[scan]
    fs = m["files"]
    col = load(fs["col"], "RGB")
    nrm = load(fs["nrm"], "RGB")
    if "arm" in fs:
        orm = load(fs["arm"], "RGB")
    else:
        w, h = col.size
        ao = load(fs["ao"], "L").resize((w, h)) if "ao" in fs else Image.new("L", (w, h), 255)
        ro = load(fs["rough"], "L").resize((w, h)) if "rough" in fs else Image.new("L", (w, h), 200)
        me = load(fs["metal"], "L").resize((w, h)) if "metal" in fs else Image.new("L", (w, h), 0)
        orm = Image.merge("RGB", (ao, ro, me))
    if turn:
        col = col.rotate(90, expand=True)
        orm = orm.rotate(90, expand=True)
        nrm = turn_normal(nrm)
    w, h = col.size
    tw, th = px, max(1, round(px * h / w))
    col = col.resize((tw, th), Image.LANCZOS)
    nrm = nrm.resize((tw, th), Image.LANCZOS)
    orm = orm.resize((tw, th), Image.LANCZOS)
    col.save(os.path.join(OUT, f"{name}_col.webp"), quality=86, method=6)
    nrm.save(os.path.join(OUT, f"{name}_nrm.webp"), quality=90, method=6)
    orm.save(os.path.join(OUT, f"{name}_orm.webp"), quality=82, method=6)
    sv = size * th / tw
    index[name] = {"size": [round(size, 4), round(sv, 4)], "px": [tw, th], "for": what, "scan": scan}
    credits[name] = f"{m.get('name', scan)} ({'Poly Haven' if m['src'] == 'polyhaven' else 'ambientCG'}, CC0)"
    print(f"{name:12s} <- {scan:24s} {tw}x{th}  {size} x {sv:.2f} m")

# the index goes with the code (the game imports it); the images stay files
INDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "ship", "scans.json")
json.dump({"materials": index, "credits": credits}, open(INDEX, "w"), indent=1, ensure_ascii=False)
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f"total {total / 1e6:.1f} MB")
