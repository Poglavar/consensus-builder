# Extract vector geometry from the UPU "Borovje - zona jug" ArcGIS raster plan sheets
# (buildings from sheet 4, green zones from sheet 1, street corridors from sheet 4)
# plus the vector cadastral-extent parcels, and write WGS84 GeoJSON into data/.
# The plan sheets are published only as georeferenced raster tiles (max LOD 19,
# ~0.30 m/px, Web Mercator), so buildings/zones/roads are segmented by color and
# polygonized; parcels come straight from the FeatureServer.
#
# Usage:
#   python3 extract-plan.py --step all|parcels|buildings|zones|roads
# Outputs (committed): data/parcels.geojson, data/buildings.geojson,
#   data/zones.geojson, data/roads.geojson
# Diagnostics (gitignored): data/overlay-*.png, tile cache in data/tiles/

import argparse
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TILES = os.path.join(DATA, "tiles")

ORIGIN = 20037508.342787
R_EARTH = 6378137.0
LEVEL = 19  # deepest level the hosted tile caches actually contain
RES = (2 * ORIGIN) / 256 / (2 ** LEVEL)  # m/px in Web Mercator at LOD 19

SERVICES = "https://tiles.arcgis.com/tiles/Usi0jGQwMmBUpFjr/arcgis/rest/services"
SHEET1 = f"{SERVICES}/1_Kori%C5%A1tenje_i_namjena_povr%C5%A1ina_UPU_Borovje/MapServer"
SHEET4 = f"{SERVICES}/4_Na%C4%8Din_i_uvjeti_gradnje_UPU_Borovje/MapServer"
SHEET2A = f"{SERVICES}/2a_Prometni_i_komunikacijski_sustav_UPU_Borovje/MapServer"
PARCELS_FS = ("https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/"
              "UPU_Borovje_katastarski_obuhvat/FeatureServer/0/query"
              "?where=1%3D1&outFields=*&f=geojson&outSR=4326")
# Plan sheet full extent in Web Mercator (from the MapServer service roots)
EXT = (1782125.837, 5746056.821, 1782859.630, 5746489.027)

# KO Žitnjak; parcel ids in the app are HR-<maticni_broj_ko>-<broj_cestice>
MATICNI_BROJ_KO = "335550"

# kazeta name -> approximate envelope centroid (lon, lat), read off the labeled
# diagnostic overlay. Used only to NAME extracted components; geometry is extracted.
# PP rules (textual provisions): PP-1 P+3 (4 floors), PP-2 P+4 (5), PP-3 P+8 (9),
# PP-4 P+5 (6). M1-12 [PP-5] is the EXISTING housing row - excluded on purpose.
KAZETE = {
    "M1-1":  {"pp": "PP-1", "floors": 4},
    "M1-2":  {"pp": "PP-1", "floors": 4},
    "M1-3":  {"pp": "PP-1", "floors": 4},
    "M1-4":  {"pp": "PP-1", "floors": 4},
    "M1-5":  {"pp": "PP-1", "floors": 4},
    "M1-6":  {"pp": "PP-2", "floors": 5},
    "M1-7":  {"pp": "PP-2", "floors": 5},
    "M1-8":  {"pp": "PP-2", "floors": 5},
    "M1-9":  {"pp": "PP-3", "floors": 9},
    "M1-10": {"pp": "PP-4", "floors": 6},
    "M1-11": {"pp": "PP-4", "floors": 6},
    "M1-12": {"pp": "PP-5", "floors": 3},
}


def merc_to_wgs(x, y):
    return math.degrees(x / R_EARTH), math.degrees(math.atan(math.sinh(y / R_EARTH)))


def wgs_to_merc(lon, lat):
    return (R_EARTH * math.radians(lon),
            R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


class Grid:
    """Pixel <-> Mercator <-> WGS84 mapping for the stitched LOD-19 image."""

    def __init__(self):
        span = 256 * RES
        self.cmin = int((EXT[0] + ORIGIN) // span)
        self.cmax = int((EXT[2] + ORIGIN) // span)
        self.rmin = int((ORIGIN - EXT[3]) // span)
        self.rmax = int((ORIGIN - EXT[1]) // span)
        self.tlx = self.cmin * span - ORIGIN
        self.tly = ORIGIN - self.rmin * span
        self.w = (self.cmax - self.cmin + 1) * 256
        self.h = (self.rmax - self.rmin + 1) * 256

    def px_to_wgs(self, px, py):
        return merc_to_wgs(self.tlx + px * RES, self.tly - py * RES)

    def wgs_to_px(self, lon, lat):
        x, y = wgs_to_merc(lon, lat)
        return (x - self.tlx) / RES, (self.tly - y) / RES


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30).read()


def stitch(service_url, name, grid):
    """Download + cache tiles and return the stitched RGB image."""
    os.makedirs(TILES, exist_ok=True)
    img = Image.new("RGB", (grid.w, grid.h), (255, 255, 255))
    for r in range(grid.rmin, grid.rmax + 1):
        for c in range(grid.cmin, grid.cmax + 1):
            cache = os.path.join(TILES, f"{name}_{LEVEL}_{r}_{c}.png")
            if not os.path.exists(cache):
                try:
                    with open(cache, "wb") as f:
                        f.write(fetch(f"{service_url}/tile/{LEVEL}/{r}/{c}"))
                except Exception:
                    continue  # tiles outside the crop 404 - that is expected
            try:
                tile = Image.open(cache).convert("RGB")
            except Exception:
                continue
            img.paste(tile, ((c - grid.cmin) * 256, (r - grid.rmin) * 256))
    return img


# ---------------------------------------------------------------- geometry ---

def trace_boundary(mask):
    """Moore-neighbor boundary trace; returns [(y,x), ...] closed contour."""
    ys, xs = np.nonzero(mask)
    order = np.lexsort((xs, ys))
    start = (int(ys[order[0]]), int(xs[order[0]]))
    nbrs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    contour = [start]
    prev_dir = 6
    cur = start
    for _ in range(400000):
        moved = False
        for i in range(8):
            d = (prev_dir + 1 + i) % 8
            ny, nx = cur[0] + nbrs[d][0], cur[1] + nbrs[d][1]
            if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx]:
                contour.append((ny, nx))
                prev_dir = (d + 4) % 8
                cur = (ny, nx)
                moved = True
                break
        if not moved or (cur == start and len(contour) > 2):
            break
    return contour


def rdp(points, eps):
    if len(points) < 3:
        return list(points)
    p0 = np.array(points[0], float)
    p1 = np.array(points[-1], float)
    d = p1 - p0
    n = math.hypot(*d)
    if n == 0:
        dists = [math.hypot(p[0] - p0[0], p[1] - p0[1]) for p in points]
    else:
        dists = [abs(d[0] * (p[1] - p0[1]) - d[1] * (p[0] - p0[0])) / n for p in points]
    imax = int(np.argmax(dists))
    if dists[imax] > eps:
        return rdp(points[:imax + 1], eps)[:-1] + rdp(points[imax:], eps)
    return [list(points[0]), list(points[-1])]


def convex_hull(points):
    pts = sorted(set((float(x), float(y)) for x, y in points))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def min_area_rect(points):
    """Rotating calipers over the convex hull; returns 4 corner points (px)."""
    hull = convex_hull(points)
    if len(hull) < 3:
        return None
    best = None
    for i in range(len(hull)):
        x1, y1 = hull[i]
        x2, y2 = hull[(i + 1) % len(hull)]
        theta = math.atan2(y2 - y1, x2 - x1)
        ct, st = math.cos(-theta), math.sin(-theta)
        xs = [p[0] * ct - p[1] * st for p in hull]
        ys = [p[0] * st + p[1] * ct for p in hull]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        if best is None or area < best[0]:
            best = (area, theta, min(xs), max(xs), min(ys), max(ys))
    _, theta, xmin, xmax, ymin, ymax = best
    ct, st = math.cos(theta), math.sin(theta)
    corners = []
    for (x, y) in [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]:
        corners.append([x * ct - y * st, x * st + y * ct])
    return corners


def moment_rect(mask):
    """Rectangle matched to a component's first and second moments: centroid,
    PCA orientation, and side lengths sqrt(12*eigenvalue). For a rectangular
    mask under boundary noise (hatch jitter, label bleed) this recovers the
    true rectangle, without min-area-rect's inflation around protrusions."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 4:
        return None
    cx, cy = xs.mean(), ys.mean()
    cov = np.cov(np.stack([xs - cx, ys - cy]))
    evals, evecs = np.linalg.eigh(cov)  # ascending
    L = math.sqrt(12 * max(evals[1], 0.0))
    W = math.sqrt(12 * max(evals[0], 0.0))
    u = evecs[:, 1]  # major axis
    v = evecs[:, 0]  # minor axis
    corners = []
    for su, sv in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        corners.append([cx + su * u[0] * L / 2 + sv * v[0] * W / 2,
                        cy + su * u[1] * L / 2 + sv * v[1] * W / 2])
    return corners


def polygon_mask_iou(poly_px, mask):
    """IoU between a pixel polygon and a boolean mask (rasterized comparison)."""
    canvas = Image.new("1", (mask.shape[1], mask.shape[0]), 0)
    ImageDraw.Draw(canvas).polygon([tuple(p) for p in poly_px], fill=1)
    pm = np.asarray(canvas, bool)
    inter = (pm & mask).sum()
    union = (pm | mask).sum()
    return inter / union if union else 0.0


def ring_px_to_wgs(grid, ring_px):
    ring = [list(grid.px_to_wgs(x, y)) for x, y in ring_px]
    if ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    return [[round(lon, 7), round(lat, 7)] for lon, lat in ring]


def ground_area_m2(px_area, lat=45.775):
    k = math.cos(math.radians(lat))  # Mercator linear scale factor
    return px_area * (RES * k) ** 2


def component_features(mask, grid, min_area_m2, rdp_eps_px, try_rect=True):
    """Label mask components and polygonize each into a WGS84 feature dict."""
    lbl, n = ndimage.label(mask)
    feats = []
    for i in range(1, n + 1):
        comp = lbl == i
        a_px = int(comp.sum())
        if ground_area_m2(a_px) < min_area_m2:
            continue
        contour = trace_boundary(comp)
        pts = [(p[1], p[0]) for p in contour]
        poly = rdp(pts, rdp_eps_px)
        if len(poly) < 4:
            continue
        shape = "polygon"
        if try_rect:
            rect = min_area_rect(pts)
            if rect and polygon_mask_iou(rect, comp) >= 0.88:
                poly, shape = rect + [rect[0]], "rectangle"
        cy, cx = ndimage.center_of_mass(comp)
        lon, lat = grid.px_to_wgs(cx, cy)
        feats.append({
            "type": "Feature",
            "properties": {
                "area_m2": round(ground_area_m2(a_px)),
                "shape": shape,
                "centroid": [round(lon, 7), round(lat, 7)],
            },
            "geometry": {"type": "Polygon", "coordinates": [ring_px_to_wgs(grid, poly)]},
        })
    feats.sort(key=lambda f: -f["properties"]["area_m2"])
    return feats


def save_geojson(path, features):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, indent=1)
    print(f"wrote {path} ({len(features)} features)")


def draw_overlay(img, grid, features, path, labels=True):
    ov = img.convert("RGB")
    dr = ImageDraw.Draw(ov)
    for idx, ft in enumerate(features):
        geom = ft["geometry"]
        rings = geom["coordinates"] if geom["type"] == "Polygon" else \
            [r for p in geom["coordinates"] for r in p]
        for ring in rings:
            px = [tuple(grid.wgs_to_px(lon, lat)) for lon, lat in ring]
            dr.line(px + [px[0]], fill=(255, 0, 255), width=4)
        if labels:
            c = ft["properties"].get("centroid")
            name = ft["properties"].get("name", str(idx))
            if c:
                x, y = grid.wgs_to_px(*c)
                dr.text((x - 10, y - 8), str(name), fill=(255, 0, 0))
    ov.save(path)
    print(f"wrote {path}")


# ------------------------------------------------------------------- steps ---

def step_parcels():
    raw = json.loads(fetch(PARCELS_FS))
    for ft in raw["features"]:
        broj = ft["properties"].get("KATASTARSKA_CESTICA", "").strip()
        ft["properties"]["parcelId"] = f"HR-{MATICNI_BROJ_KO}-{broj}"
    # The city's UPU snapshot lags the live cadastre in places (parcel 4304 has
    # since been split). data/parcel-fixes.geojson carries the CURRENT children
    # (exported from our parcel DB); swap the stale features for them so every
    # parentParcelId resolves in the app.
    fixes_path = os.path.join(DATA, "parcel-fixes.geojson")
    feats = raw["features"]
    if os.path.exists(fixes_path):
        fixes = json.load(open(fixes_path))["features"]
        stale = {f["properties"].get("replaces") for f in fixes if f["properties"].get("replaces")}
        feats = [f for f in feats
                 if f["properties"].get("KATASTARSKA_CESTICA", "").strip() not in stale]
        feats.extend(fixes)
        print(f"parcel fixes: replaced {sorted(stale)} with {len(fixes)} current parcels")
    save_geojson(os.path.join(DATA, "parcels.geojson"), feats)


def step_buildings(grid):
    img = stitch(SHEET4, "sheet4", grid)
    a = np.asarray(img).astype(int)
    mx, mn, mean = a.max(2), a.min(2), a.mean(2)
    grey = (mx - mn < 28) & (mean > 130) & (mean < 228)
    st = np.ones((3, 3), bool)
    m = ndimage.binary_closing(grey, st, iterations=4)
    m = ndimage.binary_opening(m, st, iterations=3)
    m = ndimage.binary_fill_holes(m)
    # Plan envelopes are rectangles; the raster carries notches/protrusions from
    # labels and hatch bleed. Emit a clean 4-vertex moment-matched rectangle per
    # component instead of the traced outline.
    lbl, n = ndimage.label(m)
    feats = []
    for i in range(1, n + 1):
        comp = lbl == i
        a_px = int(comp.sum())
        if ground_area_m2(a_px) < 300:
            continue
        rect = moment_rect(comp)
        if not rect:
            continue
        iou = polygon_mask_iou(rect, comp)
        cy, cx = ndimage.center_of_mass(comp)
        lon, lat = grid.px_to_wgs(cx, cy)
        feats.append({
            "type": "Feature",
            "properties": {
                "area_m2": round(ground_area_m2(a_px)),
                "shape": "rectangle",
                "rect_fit_iou": round(float(iou), 3),
                "centroid": [round(lon, 7), round(lat, 7)],
            },
            "geometry": {"type": "Polygon",
                         "coordinates": [ring_px_to_wgs(grid, rect + [rect[0]])]},
        })
    feats.sort(key=lambda f: -f["properties"]["area_m2"])
    # name the kazete by matching component centroids to the KAZETE table once
    # the mapping file exists; first run emits indexes for the labeled overlay
    mapping_path = os.path.join(HERE, "kazete-mapping.json")
    if os.path.exists(mapping_path):
        mapping = json.load(open(mapping_path))
        for ft in feats:
            c = ft["properties"]["centroid"]
            best, best_d = None, 1e9
            for name, (lon, lat) in mapping.items():
                d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2
                if d < best_d:
                    best, best_d = name, d
            ft["properties"]["name"] = best
            ft["properties"].update(KAZETE.get(best, {}))
    save_geojson(os.path.join(DATA, "buildings.geojson"), feats)
    draw_overlay(img, grid, feats, os.path.join(DATA, "overlay-buildings.png"))


def step_zones(grid):
    """Planar partition of sheet 1: zone polygons are the regions enclosed by the
    drawn dark boundary lines; each region is classified by its hatch color
    (sparse green lines = Z1 park, dense green diagonal = R2 recreation)."""
    img = stitch(SHEET1, "sheet1", grid)
    a = np.asarray(img).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mean = a.mean(2)
    greenish = (g > r + 10) & (g > b + 10)
    # boundary lines + text; hatches stay out - including R2's darker green hatch,
    # which would otherwise slice the recreation zone into sub-threshold slivers
    dark = (mean < 110) & ~greenish
    free = ~ndimage.binary_dilation(dark, np.ones((3, 3), bool))
    # confine the partition to the plan area, so zones at the obuhvat edge cannot
    # leak into the outer white margin through the dash-dot boundary's gaps
    canvas = Image.new("1", (grid.w, grid.h), 0)
    dr = ImageDraw.Draw(canvas)
    for ft in json.load(open(os.path.join(DATA, "parcels.geojson")))["features"]:
        geom = ft["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for rings in polys:
            dr.polygon([tuple(grid.wgs_to_px(lon, lat)) for lon, lat in rings[0]], fill=1)
    obuhvat = ndimage.binary_closing(np.asarray(canvas, bool), np.ones((3, 3), bool), iterations=2)
    free &= obuhvat
    lbl, n = ndimage.label(free)
    green = (g > r + 15) & (g > b + 15)
    # accumulate qualifying cells into per-class masks, then polygonize the merged
    # union: zones fragmented by drawn cadastral lines / labels come out whole
    class_masks = {"Z1": np.zeros(free.shape, bool), "R2": np.zeros(free.shape, bool)}
    for i in range(1, n + 1):
        cell = lbl == i
        a_px = int(cell.sum())
        if ground_area_m2(a_px) < 250:
            continue
        gfrac = green[cell].mean()
        if gfrac < 0.02:
            continue  # not a green zone (M1 hatch, road corridor, plain white)
        class_masks["R2" if gfrac > 0.15 else "Z1"] |= cell
    feats = []
    for kind, mask in class_masks.items():
        if not mask.any():
            continue
        # recover the line width eaten by the barrier dilation, absorb text holes
        m = ndimage.binary_dilation(mask, np.ones((3, 3), bool), iterations=3)
        m = ndimage.binary_fill_holes(m)
        for ft in component_features(m, grid, min_area_m2=500, rdp_eps_px=3.5, try_rect=False):
            ft["properties"]["kind"] = kind
            feats.append(ft)
    feats.sort(key=lambda f: -f["properties"]["area_m2"])
    for i, ft in enumerate(feats):
        ft["properties"]["name"] = f"{ft['properties']['kind']}-{i}"
    save_geojson(os.path.join(DATA, "zones.geojson"), feats)
    draw_overlay(img, grid, feats, os.path.join(DATA, "overlay-zones.png"))


def zhang_suen_thin(mask):
    """Vectorized Zhang-Suen thinning; returns a 1px-wide skeleton."""
    img = mask.copy()
    def neighbors(a):
        p2 = np.roll(a, 1, 0); p3 = np.roll(np.roll(a, 1, 0), -1, 1)
        p4 = np.roll(a, -1, 1); p5 = np.roll(np.roll(a, -1, 0), -1, 1)
        p6 = np.roll(a, -1, 0); p7 = np.roll(np.roll(a, -1, 0), 1, 1)
        p8 = np.roll(a, 1, 1); p9 = np.roll(np.roll(a, 1, 0), 1, 1)
        return p2, p3, p4, p5, p6, p7, p8, p9
    while True:
        changed = False
        for phase in (0, 1):
            p2, p3, p4, p5, p6, p7, p8, p9 = neighbors(img)
            seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            b = sum(p.astype(int) for p in (p2, p3, p4, p5, p6, p7, p8, p9))
            a = sum(((~seq[i]) & seq[i + 1]).astype(int) for i in range(8))
            if phase == 0:
                cond = (a == 1) & (b >= 2) & (b <= 6) & ~(p2 & p4 & p6) & ~(p4 & p6 & p8)
            else:
                cond = (a == 1) & (b >= 2) & (b <= 6) & ~(p2 & p4 & p8) & ~(p2 & p6 & p8)
            kill = img & cond
            if kill.any():
                img &= ~kill
                changed = True
        if not changed:
            return img


OFFS8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def diameter_path(skel):
    """Longest shortest-path between skeleton pixels (double BFS). Fallback
    centerline for degenerate components whose skeleton is a mesh of cycles."""
    from collections import deque
    pts = list(zip(*np.nonzero(skel)))
    if len(pts) < 2:
        return []
    px = set(pts)

    def bfs(start):
        dist = {start: 0}
        parent = {start: None}
        q = deque([start])
        far = start
        while q:
            cur = q.popleft()
            for dy, dx in OFFS8:
                nb = (cur[0] + dy, cur[1] + dx)
                if nb in px and nb not in dist:
                    dist[nb] = dist[cur] + 1
                    parent[nb] = cur
                    if dist[nb] > dist[far]:
                        far = nb
                    q.append(nb)
        return far, parent

    a, _ = bfs(pts[0])
    b, parent = bfs(a)
    path = []
    cur = b
    while cur is not None:
        path.append(cur)
        cur = parent[cur]
    return path[::-1]


def smooth_polyline(pts, iterations=3):
    """Neighbor-averaging smoothing; endpoints stay fixed."""
    pts = [tuple(p) for p in pts]
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        out = [pts[0]]
        for i in range(1, len(pts) - 1):
            out.append(((pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
                        (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4))
        out.append(pts[-1])
        pts = out
    return pts


def step_roads(grid):
    """Street network from sheet 2a (Prometni i komunikacijski sustav), which
    draws the roads explicitly: the planned collector is the red-hatched band
    (its centerline = the band's diameter path), and the IS-1 / IS-2 crossings
    are clean orange / pale-yellow cells whose axes are straight PCA lines.
    Everything is joined into ONE noded network: crossing endpoints are inserted
    as junction vertices into the collector polyline."""
    img = stitch(SHEET2A, "sheet2a", grid)
    a = np.asarray(img).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    st = np.ones((3, 3), bool)

    # --- collector: red hatch band -> solid -> skeleton -> diameter path ---
    red = (r > 200) & (g < 150) & (b < 150)
    band = ndimage.binary_closing(red, st, iterations=8)
    band = ndimage.binary_fill_holes(band)
    lbl, n = ndimage.label(band)
    biggest = max(range(1, n + 1), key=lambda i: (lbl == i).sum())
    band = lbl == biggest
    collector = [(p[1], p[0]) for p in diameter_path(zhang_suen_thin(band))]  # (x,y)
    collector = rdp(smooth_polyline(collector, 4), 4.0)

    # --- crossings: orange = IS-1 (kolno-pjesacke), pale yellow = IS-2 ---
    def cells(mask, min_m2):
        m = ndimage.binary_closing(mask, st, iterations=6)
        m = ndimage.binary_fill_holes(m)
        lbl2, n2 = ndimage.label(m)
        out = []
        for i in range(1, n2 + 1):
            comp = lbl2 == i
            if ground_area_m2(int(comp.sum())) < min_m2:
                continue
            ys, xs = np.nonzero(comp)
            out.append({"px": (xs, ys), "centroid": (xs.mean(), ys.mean())})
        return out

    orange = (r > 200) & (g > 150) & (g < 225) & (b < 120)
    pale_yellow = (r > 232) & (g > 232) & (b < 234)
    is1 = cells(orange, 100)
    is2 = [c for c in cells(pale_yellow, 250)
           if not any(abs(c["centroid"][0] - o["centroid"][0]) < 80
                      and abs(c["centroid"][1] - o["centroid"][1]) < 80 for o in is1)]
    if len(is1) != 3 or len(is2) != 2:
        raise SystemExit(f"expected 3 IS-1 + 2 IS-2 cells, got {len(is1)} + {len(is2)}")

    # identify cells by position
    is1.sort(key=lambda c: c["centroid"][0])
    is1_w, is1_e, is1_ne = is1  # west, east, north-east corner
    is2.sort(key=lambda c: c["centroid"][1])
    is2_n, is2_s = is2  # north path, south path

    def pca_line(cell):
        xs, ys = cell["px"]
        cx, cy = xs.mean(), ys.mean()
        cov = np.cov(np.stack([xs - cx, ys - cy]))
        evals, evecs = np.linalg.eigh(cov)
        u = evecs[:, 1]  # major axis direction
        t = (xs - cx) * u[0] + (ys - cy) * u[1]
        return {"c": (cx, cy), "u": (float(u[0]), float(u[1])),
                "tmin": float(t.min()), "tmax": float(t.max())}

    def at(line, t):
        return (line["c"][0] + line["u"][0] * t, line["c"][1] + line["u"][1] * t)

    def seg_intersect(p, q, u, v):
        # infinite line p+t*u vs segment q..v; returns (t, s, point) or None
        d = (u[0] * (v[1] - q[1]) - u[1] * (v[0] - q[0]))
        if abs(d) < 1e-12:
            return None
        s = (u[0] * (p[1] - q[1]) - u[1] * (p[0] - q[0])) / d
        if not (0 <= s <= 1):
            return None
        w = (q[0] + s * (v[0] - q[0]), q[1] + s * (v[1] - q[1]))
        t = (w[0] - p[0]) * u[0] + (w[1] - p[1]) * u[1]
        return (t, s, w)

    junctions = []  # (index into collector list to insert AFTER, s within that span, point)

    def junction_on_collector(line):
        """Intersect a cell's PCA line with the collector polyline; register the
        junction vertex and return it."""
        best = None
        for i in range(len(collector) - 1):
            hit = seg_intersect(line["c"], collector[i], line["u"], collector[i + 1])
            if hit is None:
                continue
            if best is None or abs(hit[0]) < abs(best[0][0]):
                best = (hit, i)
        if best is None:
            raise SystemExit("crossing axis does not meet the collector")
        (t, sfrac, pt), idx = best
        junctions.append((idx, sfrac, pt))
        return pt, t

    def line_intersection(l1, l2):
        p, u = l1["c"], l1["u"]
        q, v = l2["c"], l2["u"]
        d = u[0] * v[1] - u[1] * v[0]
        t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / d
        return (p[0] + u[0] * t, p[1] + u[1] * t)

    l_w, l_e, l_ne = pca_line(is1_w), pca_line(is1_e), pca_line(is1_ne)
    l_n, l_s = pca_line(is2_n), pca_line(is2_s)

    def outer_end(line, sign):
        t = line["tmax"] if sign > 0 else line["tmin"]
        return at(line, t)

    segments = []  # {points(px), kind, name}

    # NS-east road: the IS-2 north path runs S through its cell, jogs along R2's
    # NE corner, and continues through the IS-1 east crossing to the collector.
    # Waypoints are the CELL ends - a straight line between the two PCA axes
    # would cut across the block interior.
    n2a, n2b = at(l_n, l_n["tmin"]), at(l_n, l_n["tmax"])
    n_end, n_sout = (n2a, n2b) if n2a[1] < n2b[1] else (n2b, n2a)
    e1a, e1b = at(l_e, l_e["tmin"]), at(l_e, l_e["tmax"])
    e_north, _e_far = (e1a, e1b) if e1a[1] < e1b[1] else (e1b, e1a)
    j_e, t_e = junction_on_collector(l_e)
    segments.append({"pts": [n_end, n_sout, e_north], "kind": "IS-2", "name": "pjesacka-sjever"})
    segments.append({"pts": [e_north, j_e], "kind": "IS-1", "name": "kolno-pjesacka-istok"})

    # IS-2 south path: from its northern end down to the collector
    j_s, _ = junction_on_collector(l_s)
    s_end = at(l_s, l_s["tmin"]) if at(l_s, l_s["tmin"])[1] < at(l_s, l_s["tmax"])[1] else at(l_s, l_s["tmax"])
    segments.append({"pts": [s_end, j_s], "kind": "IS-2", "name": "pjesacka-jug"})

    # IS-1 west: standalone crossing (does not reach the collector)
    segments.append({"pts": [at(l_w, l_w["tmin"]), at(l_w, l_w["tmax"])],
                     "kind": "IS-1", "name": "kolno-pjesacka-zapad"})

    # IS-1 north-east corner: short link to the collector
    j_ne, t_ne = junction_on_collector(l_ne)
    ne_end = at(l_ne, l_ne["tmin"]) if abs(l_ne["tmin"] - t_ne) > abs(l_ne["tmax"] - t_ne) else at(l_ne, l_ne["tmax"])
    segments.append({"pts": [ne_end, j_ne], "kind": "IS-1", "name": "kolno-pjesacka-sjeveroistok"})

    # insert junction vertices into the collector (ordered), then emit it
    coll = list(collector)
    for idx, sfrac, pt in sorted(junctions, key=lambda j: (j[0], j[1]), reverse=True):
        coll.insert(idx + 1, pt)
    segments.insert(0, {"pts": coll, "kind": "SP", "name": "sabirna-ulica"})

    KIND_WIDTH = {"SP": 19.0, "IS-1": 18.0, "IS-2": 9.0}
    feats = []
    for seg in segments:
        line = [[round(v, 7) for v in grid.px_to_wgs(x, y)] for x, y in seg["pts"]]
        k = math.cos(math.radians(45.775))
        length = sum(
            math.hypot((line[j + 1][0] - line[j][0]) * 111319 * k,
                       (line[j + 1][1] - line[j][1]) * 111319)
            for j in range(len(line) - 1))
        feats.append({
            "type": "Feature",
            "properties": {
                "name": seg["name"],
                "kind": seg["kind"],
                "width_m": KIND_WIDTH[seg["kind"]],
                "length_m": round(length, 1),
            },
            "geometry": {"type": "LineString", "coordinates": line},
        })
    save_geojson(os.path.join(DATA, "streets.geojson"), feats)

    ov = img.convert("RGB")
    dr = ImageDraw.Draw(ov)
    for ft in feats:
        pxs = [tuple(grid.wgs_to_px(lon, lat)) for lon, lat in ft["geometry"]["coordinates"]]
        dr.line(pxs, fill=(255, 0, 255), width=5)
        for p in pxs:
            dr.ellipse([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6], outline=(0, 120, 255), width=3)
    ov.save(os.path.join(DATA, "overlay-roads.png"))
    print(f"wrote overlay-roads.png ({len(feats)} road segments)")


def step_parcelation(grid):
    """The plan's implied land readjustment: partition sheet 1 by the drawn
    boundary lines and emit EVERY cell inside the obuhvat as a new-parcel slice,
    classified by hatch (M1 building parcel / Z1 park / R2 recreation / street).
    The M1-12 area is excluded - the plan keeps its existing parcels (PP-5)."""
    img = stitch(SHEET1, "sheet1", grid)
    a = np.asarray(img).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mean = a.mean(2)
    greenish = (g > r + 10) & (g > b + 10)
    dark = (mean < 110) & ~greenish
    free = ~ndimage.binary_dilation(dark, np.ones((3, 3), bool))
    canvas = Image.new("1", (grid.w, grid.h), 0)
    dr = ImageDraw.Draw(canvas)
    for ft in json.load(open(os.path.join(DATA, "parcels.geojson")))["features"]:
        geom = ft["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for rings in polys:
            dr.polygon([tuple(grid.wgs_to_px(lon, lat)) for lon, lat in rings[0]], fill=1)
    obuhvat = ndimage.binary_closing(np.asarray(canvas, bool), np.ones((3, 3), bool), iterations=2)
    free &= obuhvat
    lbl, n = ndimage.label(free)
    orange = (r > 200) & (g > 110) & (g < 215) & (b < 150) & (r - b > 60)
    green = (g > r + 15) & (g > b + 15)
    class_masks = {"M1": np.zeros(free.shape, bool), "Z1": np.zeros(free.shape, bool),
                   "R2": np.zeros(free.shape, bool), "IS": np.zeros(free.shape, bool)}
    for i in range(1, n + 1):
        cell = lbl == i
        if ground_area_m2(int(cell.sum())) < 30:
            continue
        interior = ndimage.binary_erosion(cell, np.ones((3, 3), bool), iterations=3)
        probe = interior if interior.any() else cell
        ofrac, gfrac = orange[probe].mean(), green[probe].mean()
        if ofrac > 0.02:
            kind = "M1"
        elif gfrac > 0.15:
            kind = "R2"
        elif gfrac > 0.02:
            kind = "Z1"
        else:
            kind = "IS"
        class_masks[kind] |= cell
    # building centroids name the M1 slices (and locate the excluded M1-12 area)
    buildings = json.load(open(os.path.join(DATA, "buildings.geojson")))["features"]
    def building_here(mask_component):
        names = []
        for bf in buildings:
            lon, lat = bf["properties"]["centroid"]
            px, py = grid.wgs_to_px(lon, lat)
            if 0 <= int(py) < mask_component.shape[0] and 0 <= int(px) < mask_component.shape[1] \
                    and mask_component[int(py), int(px)]:
                names.append(bf["properties"]["name"])
        return names
    def building_seed_mask(name):
        for bf in buildings:
            if bf["properties"]["name"] != name:
                continue
            seed = Image.new("1", (grid.w, grid.h), 0)
            ImageDraw.Draw(seed).polygon(
                [tuple(grid.wgs_to_px(lon, lat)) for lon, lat in bf["geometry"]["coordinates"][0]], fill=1)
            return np.asarray(seed, bool)
        return None

    feats = []
    for kind, mask in class_masks.items():
        if not mask.any():
            continue
        m = ndimage.binary_dilation(mask, np.ones((3, 3), bool), iterations=3)
        m = ndimage.binary_fill_holes(m)
        lbl2, n2 = ndimage.label(m)
        for i in range(1, n2 + 1):
            comp = lbl2 == i
            if ground_area_m2(int(comp.sum())) < 300:
                continue
            names = building_here(comp) if kind == "M1" else []
            if names == ["M1-12"]:
                continue  # existing housing keeps its parcels (PP-5)
            # a block holding several kazete has no drawn line between them on
            # sheet 1 - split it by nearest building envelope (the plan gives
            # each building its own gradevna cestica)
            parts = [(comp, names)]
            if len(names) > 1:
                dists = []
                for name in names:
                    seed = building_seed_mask(name)
                    dists.append(ndimage.distance_transform_edt(~seed) if seed is not None else None)
                assign = np.argmin(np.stack([d for d in dists if d is not None]), axis=0)
                parts = []
                for k, name in enumerate(names):
                    if name == "M1-12":
                        continue  # existing housing keeps its parcels (PP-5)
                    part = comp & (assign == k)
                    if ground_area_m2(int(part.sum())) >= 300:
                        parts.append((part, [name]))
            for part, part_names in parts:
                for ft in component_features(part, grid, min_area_m2=300, rdp_eps_px=3.5, try_rect=False):
                    ft["properties"]["kind"] = kind
                    if part_names:
                        ft["properties"]["kazete"] = part_names
                    feats.append(ft)
    feats.sort(key=lambda f: -f["properties"]["area_m2"])
    counters = {}
    for ft in feats:
        kind = ft["properties"]["kind"]
        kazete = ft["properties"].get("kazete", [])
        if kazete:
            ft["properties"]["name"] = "-".join(kazete)
        else:
            counters[kind] = counters.get(kind, 0) + 1
            ft["properties"]["name"] = f"{kind}-{counters[kind]}"
    save_geojson(os.path.join(DATA, "parcelation.geojson"), feats)
    draw_overlay(img, grid, feats, os.path.join(DATA, "overlay-parcelation.png"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step", choices=["all", "parcels", "buildings", "zones", "roads", "parcelation"])
    args = ap.parse_args()
    if not args.step:
        ap.print_help()
        sys.exit(0)
    os.makedirs(DATA, exist_ok=True)
    grid = Grid()
    if args.step in ("all", "parcels"):
        step_parcels()
    if args.step in ("all", "buildings"):
        step_buildings(grid)
    if args.step in ("all", "zones"):
        step_zones(grid)
    if args.step in ("all", "roads"):
        step_roads(grid)
    if args.step in ("all", "parcelation"):
        step_parcelation(grid)


if __name__ == "__main__":
    main()
