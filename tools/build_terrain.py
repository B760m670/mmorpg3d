"""
Real terrain for the game: Reine, Moskenesøya, Lofoten (Norway).

Land: Kartverket national height model, digital terrain model (NHM DTM,
EPSG:25833), via the Geonorge WCS. Sea floor: EMODnet Bathymetry digital
terrain model (mean depth, 1/16 arc-minute), via its WCS. Both are open data.

Writes src/assets/terrain/:
  inner.dat        10 m grid over the area you sail in (10 x 11 km)
  outer.dat        64 m grid, 41 x 41 km, for the mountains on the horizon
  expo_inner.dat / expo_outer.dat   how open each point is to the sea
  meta.json        grid geometry, world origin, sources

World frame: x east, z south (north is -Z, as in the game), metres from the
spawn point in open water south-east of Reine. Heights are stored as uint16
in 5 cm steps from -500 m, delta-coded along each row, then gzip.

Run with a Python that has numpy, scipy, tifffile, pyproj:
  python tools/build_terrain.py [cache_dir]
"""

import gzip
import io
import json
import os
import sys
import urllib.request

import numpy as np
import tifffile
from pyproj import Transformer
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "assets", "terrain")
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".terrain_cache")
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

REINE = (419889.0, 7536588.0)          # UTM 33N, the village of Reine
SPAWN = (REINE[0] + 2600.0, REINE[1] - 400.0)
INNER = dict(e0=REINE[0] - 6500, n1=REINE[1] + 8000, res=10.0, w=1000, h=1100)
OUTER = dict(e0=REINE[0] - 1500 - 20480, n1=REINE[1] + 2500 + 20480, res=64.0, w=640, h=640)

DTM_WCS = ("https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&version=1.0.0&request=GetCoverage"
           "&coverage=nhm_dtm_topo_25833&crs=EPSG:25833&bbox={e0},{n0},{e1},{n1}&width={w}&height={h}&format=GeoTIFF")
EMOD_WCS = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
            "&CoverageId=emodnet__mean&subset=Lat({lat0},{lat1})&subset=Long({lon0},{lon1})&format=image/tiff")
TO_LL = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)


def fetch(url, name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("download", name)
        data = urllib.request.urlopen(url, timeout=300).read()
        open(path, "wb").write(data)
    return tifffile.imread(path).astype(np.float64)


def cell_centres(g):
    e = g["e0"] + (np.arange(g["w"]) + 0.5) * g["res"]
    n = g["n1"] - (np.arange(g["h"]) + 0.5) * g["res"]
    return np.meshgrid(e, n)


def bathymetry(g, tag):
    """EMODnet mean depth sampled at the grid's cell centres (bilinear)."""
    E, N = cell_centres(g)
    lon, lat = TO_LL.transform(E, N)
    lon0, lon1 = lon.min() - 0.02, lon.max() + 0.02
    lat0, lat1 = lat.min() - 0.01, lat.max() + 0.01
    em = fetch(EMOD_WCS.format(lat0=lat0, lat1=lat1, lon0=lon0, lon1=lon1), f"emodnet_{tag}.tif")
    # the coverage is snapped to its own 1/16' grid: recover it from the file
    with tifffile.TiffFile(os.path.join(CACHE, f"emodnet_{tag}.tif")) as tf:
        tags = tf.pages[0].tags
        if "ModelTransformationTag" in tags:            # upper-left corner and pixel size
            m = tags["ModelTransformationTag"].value
            sx, sy, lonA, latA = m[0], -m[5], m[3], m[7]
        else:
            sx, sy = tags["ModelPixelScaleTag"].value[:2]
            tp = tags["ModelTiepointTag"].value
            lonA, latA = tp[3], tp[4]
    H, W = em.shape
    fi = (lon - lonA) / sx - 0.5
    fj = (latA - lat) / sy - 0.5
    i0 = np.clip(np.floor(fi).astype(int), 0, W - 2)
    j0 = np.clip(np.floor(fj).astype(int), 0, H - 2)
    ti = np.clip(fi - i0, 0, 1)
    tj = np.clip(fj - j0, 0, 1)
    return (em[j0, i0] * (1 - ti) * (1 - tj) + em[j0, i0 + 1] * ti * (1 - tj)
            + em[j0 + 1, i0] * (1 - ti) * tj + em[j0 + 1, i0 + 1] * ti * tj)


def build(g, tag):
    e1 = g["e0"] + g["w"] * g["res"]
    n0 = g["n1"] - g["h"] * g["res"]
    dtm = fetch(DTM_WCS.format(e0=g["e0"], n0=n0, e1=e1, n1=g["n1"], w=g["w"], h=g["h"]), f"dtm_{tag}.tif")
    assert dtm.shape == (g["h"], g["w"]), dtm.shape
    sea = dtm <= 0.05
    b = bathymetry(g, tag)
    dist = ndimage.distance_transform_edt(sea) * g["res"]          # metres to the nearest land
    # where the coarse sea-floor model still shows land inside the real
    # coastline (narrow sounds, harbours), fall back to a shallow shelf
    z = np.where(b < -2.0, b, -np.minimum(2.0 + 0.25 * dist, 30.0))
    # smooth the 1/16' model's facets, over the sea only
    sig = max(0.6, 40.0 / g["res"])
    m = sea.astype(np.float64)
    z = np.where(sea, ndimage.gaussian_filter(z * m, sig) / np.maximum(ndimage.gaussian_filter(m, sig), 1e-6), z)
    # rock does not drop vertically under water: limit the slope off the shore
    z = np.maximum(z, -(0.8 + 0.75 * dist))
    z = np.minimum(z, -0.8)
    h = np.where(sea, z, dtm)
    print(tag, "land max %.0f m, sea min %.0f m, sea %.0f%%" % (h.max(), h.min(), 100 * sea.mean()))
    return h


def exposure(h, res, w_far):
    """Fraction of 32 bearings with open water, each weighted by fetch up to
    w_far metres: 1 in open sea, ~0 in a closed bay."""
    H, W = h.shape
    land = h > 0
    acc = np.zeros(h.shape)
    jj, ii = np.mgrid[0:H, 0:W].astype(np.float64)
    nstep = int(w_far / res)
    for k in range(32):
        a = 2 * np.pi * k / 32
        dx, dy = np.sin(a), -np.cos(a)
        fetch_ = np.full(h.shape, float(nstep))
        alive = ~land
        for s in range(1, nstep + 1):
            x = np.rint(ii + dx * s).astype(int)
            y = np.rint(jj + dy * s).astype(int)
            out = (x < 0) | (x >= W) | (y < 0) | (y >= H)
            hit = np.zeros(h.shape, bool)
            ok = ~out
            hit[ok] = land[y[ok], x[ok]]
            stop = alive & hit
            fetch_[stop] = s
            alive &= ~hit
            alive &= ~out          # off the map: open sea beyond, keep full fetch
        acc += np.minimum(1.0, fetch_ / nstep) ** 1.5      # long fetches count most
    wet = (~land).astype(np.float64)                    # blur over water only: no ray streaks
    e = ndimage.gaussian_filter(acc / 32 * wet, 2.0) / np.maximum(ndimage.gaussian_filter(wet, 2.0), 1e-6)
    e = np.clip((e - 0.1) / 0.45, 0, 1)
    e[land] = 0
    return e


def pack(h):
    v = np.clip(np.rint((h + 500.0) / 0.05), 0, 65535).astype(np.int64)
    d = np.diff(v, axis=1, prepend=0)          # first column absolute, then steps
    return gzip.compress((d & 0xFFFF).astype("<u2").tobytes(), 9)


def main():
    meta = {"origin_utm33": SPAWN, "reine_utm33": REINE, "heightScale": 0.05, "heightOffset": -500.0,
            "sources": ["Kartverket NHM DTM (Geonorge WCS, CC BY 4.0)", "EMODnet Bathymetry DTM, mean depth"]}
    for tag, g in (("inner", INNER), ("outer", OUTER)):
        h = build(g, tag)
        # world frame: cell (i, j) centre, x east, z south, from the spawn point
        minX = g["e0"] + 0.5 * g["res"] - SPAWN[0]
        minZ = SPAWN[1] - (g["n1"] - 0.5 * g["res"])
        open(os.path.join(OUT, f"{tag}.dat"), "wb").write(pack(h))
        er = 40.0 if tag == "inner" else g["res"]
        f = int(round(er / g["res"]))
        hc = h[: h.shape[0] // f * f, : h.shape[1] // f * f].reshape(h.shape[0] // f, f, h.shape[1] // f, f).max((1, 3))
        ex = exposure(hc, er, 8000.0)
        open(os.path.join(OUT, f"expo_{tag}.dat"), "wb").write(gzip.compress(np.rint(ex * 255).astype(np.uint8).tobytes(), 9))
        meta[tag] = {"nx": g["w"], "nz": g["h"], "spacing": g["res"], "minX": minX, "minZ": minZ,
                     "expo": {"nx": hc.shape[1], "nz": hc.shape[0], "spacing": er,
                              "minX": g["e0"] + 0.5 * er - SPAWN[0], "minZ": SPAWN[1] - (g["n1"] - 0.5 * er)}}
        np.save(os.path.join(CACHE, f"merged_{tag}.npy"), h)
        np.save(os.path.join(CACHE, f"expo_{tag}.npy"), ex)
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KB")


main()
