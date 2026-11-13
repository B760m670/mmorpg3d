"""
What covers the ground, who lives there, and the tide - for the Reine area.

Writes src/assets/terrain/:
  cover.dat      uint8 per 10 m cell of the inner grid (same cells as
                 inner.dat): low 4 bits = loose deposit class, high 4 bits =
                 bedrock class. gzip.
  buildings.json every registered building: world x, z (m) and the building
                 type code, from Kartverket's Matrikkelen register.
  tide.json      predicted high and low waters at Reine (Kartverket), for the
                 game to interpolate the water level at the current time.

Sources (open data):
  NGU superficial deposits map (WMS LosmasserWMS2, layer Losmasse_flate)
  NGU bedrock map 1:250 000 (WMS BerggrunnWMS3, Berggrunn_regional_hovedbergarter)
  Kartverket Matrikkelen building points (WFS)
  Kartverket tide predictions (vannstand.kartverket.no tide API), Reine is
  predicted from Bodø, +10 min, height factor 1.01

Run with a Python that has numpy and pillow:
  python tools/build_landcover.py [cache_dir]
"""

import gzip
import io
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "assets", "terrain")
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".terrain_cache")
os.makedirs(CACHE, exist_ok=True)

meta = json.load(open(os.path.join(OUT, "meta.json")))
SPAWN = meta["origin_utm33"]
G = meta["inner"]
# the inner grid's outer edges in UTM 33 (cells are 10 m, centres at min + 5)
E0 = SPAWN[0] + G["minX"] - G["spacing"] / 2
N1 = SPAWN[1] - G["minZ"] + G["spacing"] / 2
E1 = E0 + G["nx"] * G["spacing"]
N0 = N1 - G["nz"] * G["spacing"]

# loose deposits: NGU legend colour -> class (0 = bare rock, the default)
DEPOSITS = {
    (255, 240, 240): 0,   # 130 bare rock
    (255, 97, 97): 1,     # 081 scree / rockfall material, continuous
    (135, 255, 97): 2,    # 011 moraine, continuous
    (191, 255, 135): 3,   # 012 moraine, thin or patchy
    (0, 255, 51): 4,      # 015 end moraine
    (64, 153, 255): 5,    # 042 marine beach deposit
    (212, 217, 66): 6,    # 060 wind-blown sand (dunes)
    (232, 194, 255): 7,   # 070 weathered material
}
# bedrock: NGU colour -> class
BEDROCK = {
    (255, 204, 204): 0,   # quartz monzonite to granite, locally gneissic (1880-1770 Ma)
    (250, 224, 255): 1,   # gneiss, fine-grained, migmatitic (2800-1770 Ma)
    (176, 117, 110): 2,   # gabbro, ferrogabbro
    (224, 255, 222): 3,   # sedimentary rock, Lower Triassic (under Vestfjorden)
}


def get(url, name, binary=True):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("download", name)
        open(path, "wb").write(urllib.request.urlopen(url, timeout=300).read())
    return open(path, "rb").read()


def wms(service, layer, name):
    url = (f"https://geo.ngu.no/mapserver/{service}?service=WMS&version=1.3.0&request=GetMap&layers={layer}"
           f"&styles=&crs=EPSG:25833&bbox={E0},{N0},{E1},{N1}&width={G['nx']}&height={G['nz']}"
           "&format=image/png&transparent=true")
    img = Image.open(io.BytesIO(get(url, name))).convert("RGBA")
    a = np.asarray(img).astype(np.int32)
    assert a.shape[:2] == (G["nz"], G["nx"]), a.shape
    return a


def classify(a, table, default):
    """Nearest legend colour per pixel (anti-aliased edges included)."""
    cols = np.array(list(table.keys()), np.int32)
    ids = np.array(list(table.values()), np.uint8)
    d = ((a[..., None, :3] - cols[None, None]) ** 2).sum(-1)
    k = d.argmin(-1)
    out = ids[k]
    out[(d.min(-1) > 60 ** 2) | (a[..., 3] < 128)] = default
    return out


def inner_heights():
    raw = gzip.decompress(open(os.path.join(OUT, "inner.dat"), "rb").read())
    d = np.frombuffer(raw, "<u2").reshape(G["nz"], G["nx"]).astype(np.int64)
    v = np.cumsum(d, axis=1) & 0xFFFF                      # rows are delta-coded
    return v * meta["heightScale"] + meta["heightOffset"]


def lakes(h):
    """Lakes: the height model has their surfaces dead flat. Connected flat
    cells above the sea, at least 0.3 ha."""
    from scipy import ndimage
    flat = (ndimage.maximum_filter(h, 3) - ndimage.minimum_filter(h, 3)) < 0.06
    flat &= h > 1.0
    lab, n = ndimage.label(flat)
    sizes = ndimage.sum(np.ones_like(h), lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= 30
    m = keep[lab]
    return ndimage.binary_dilation(m, iterations=1) & (h > 0.5)


def cover():
    dep = classify(wms("LosmasserWMS2", "Losmasse_flate", "ngu_losmasse_inner.png"), DEPOSITS, 0)
    lk = lakes(inner_heights())
    dep[lk] = 8                                          # 8: lake (fresh water)
    bed = classify(wms("BerggrunnWMS3", "Berggrunn_regional_hovedbergarter", "ngu_berggrunn_inner.png"), BEDROCK, 0)
    names = ["bare rock", "scree", "moraine", "thin moraine", "end moraine", "beach", "dunes", "weathered", "lake"]
    for k, n in enumerate(names):
        print(f"  {n:13s} {100 * (dep == k).mean():5.1f} %")
    packed = (dep & 15) | ((bed & 15) << 4)
    open(os.path.join(OUT, "cover.dat"), "wb").write(gzip.compress(packed.astype(np.uint8).tobytes(), 9))


def buildings():
    url = ("https://wfs.geonorge.no/skwms1/wfs.matrikkelen-bygningspunkt?service=WFS&version=2.0.0&request=GetFeature"
           f"&typeNames=app:Bygning&srsName=EPSG:25833&bbox={E0},{N0},{E1},{N1},EPSG:25833&count=10000")
    t = get(url, "matrikkel_inner.xml").decode("utf-8", "replace")
    out = []
    keep = {"TB", "FA", "MB", "MF", "IP"}          # standing; not planned, demolished or cancelled
    for m in re.finditer(r"<app:Bygning\b.*?</app:Bygning>", t, re.S):
        b = m.group(0)
        st = re.search(r"<app:bygningsstatus>(\w+)<", b)
        if st and st.group(1) not in keep:
            continue
        pos = re.search(r"<gml:pos>([\d.]+) ([\d.]+)</gml:pos>", b)
        typ = re.search(r"<app:bygningstype>(\d+)<", b)
        if not pos or not typ:
            continue
        e, n = float(pos.group(1)), float(pos.group(2))
        out.append([round(e - SPAWN[0], 1), round(SPAWN[1] - n, 1), int(typ.group(1))])
    json.dump({"source": "Kartverket Matrikkelen, bygningspunkt", "x_z_type": out},
              open(os.path.join(OUT, "buildings.json"), "w"), separators=(",", ":"))
    print("  buildings", len(out))


def tide():
    url = ("https://vannstand.kartverket.no/tideapi.php?tide_request=locationdata&lat=67.933&lon=13.089&datatype=tab"
           "&refcode=cd&fromtime=2026-11-01T00:00&totime=2028-01-01T00:00&interval=60&lang=en&dst=0&tzone=0")
    t = get(url, "tide_reine.xml").decode("utf-8")
    ex = re.findall(r'<waterlevel value="([\d.\-]+)" time="([^"]+)" flag="(high|low)"', t)
    t0 = None
    rows = []
    for v, ts, _ in ex:
        tm = int(datetime.fromisoformat(ts).astimezone(timezone.utc).timestamp() // 60)
        t0 = tm if t0 is None else t0
        rows.append([tm - t0, round(float(v))])
    json.dump({"source": "Kartverket tide predictions (Bodø +10 min, x1.01) for Reine",
               "unit": "cm above chart datum", "msl": 170.5, "mhws": 289.5, "mlws": 51.5,
               "t0_unix_min": t0, "extremes_min_cm": rows},
              open(os.path.join(OUT, "tide.json"), "w"), separators=(",", ":"))
    print("  tide extremes", len(rows))


cover()
buildings()
tide()
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KB")
