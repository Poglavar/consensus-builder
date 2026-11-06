# Extracts the buildings of the 1971 DUP Travno sheet ("Plan visina izgradnje, broja i strukture
# stanova", 1:1000) from the City of Zagreb geoportal into data/buildings.geojson (EPSG:3765), plus the
# plan's official boundary and register entry into data/obuhvat.geojson. The sheet is a georeferenced
# greyscale scan served only as a WMS raster; see README.md for how it is read.
#
# Usage:
#   python3 -I extract-plan.py --fetch      # boundary + register entry, sheet tiles (cached in data/tiles/)
#   python3 -I extract-plan.py --extract    # buildings.geojson from the cached sheet and data/claims.json
#   python3 -I extract-plan.py --all
# Diagnostics (gitignored): data/tiles/, data/sheet-20cm.png, data/overlay.png

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TILES = os.path.join(DATA, "tiles")
GEOPORTAL = "https://geoportal.zagreb.hr/"
CATALOG = GEOPORTAL + "handlers/Catalog/Catalog.ashx?tk=6&node=root"
SHEET_LAYER = "DUP_Travno"            # raster layer of the plan sheet (catalog type 143)
BOUNDARY_LAYER = "PUP_DUP_status"     # vector boundaries of all PUP/DUP plans (catalog id 1806)
PLAN_SHORT_NAME = "DUP Travno"
# The sheet's extent in EPSG:3765, a little wider than its WMS bounding box (460402 5069918 461621 5070509).
EXTENT = (460400.0, 5069915.0, 461625.0, 5070510.0)
MPP = 0.2                              # sampling, m/px; the scan itself is coarser, text stays legible
TILE_PX = 2000
UA = {"User-Agent": "Mozilla/5.0 (restatement extractor)"}

# Segmentation, in pixels at MPP. A double median removes the drawing's lines, dots and text and leaves
# the tinted building masses. Tone is height (plan visina): the dark and mid tones carry the labelled
# height of a tower or slab; the light tone is ground-floor mass, the tone of the buildings labelled "P".
MEDIAN_PX = 11
TONE_HIGH = 205      # below: the labelled height
TONE_ANY = 240       # below: any building mass (paper is ~250)
MIN_PART_M2 = 25.0
SIMPLIFY_M = 0.5


def log(message):
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {message}", flush=True)


def get(url, binary=False):
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read()
    return body if binary else body.decode("utf-8")


def catalog_url(predicate):
    """The geoportal's own proxy URL of a catalog layer (its hashes are issued by the catalog)."""
    found = []

    def walk(node):
        for item in node.get("Katalog") or []:
            if predicate(item):
                found.append(item)
            walk(item)

    walk(json.loads(get(CATALOG)))
    if len(found) != 1:
        raise SystemExit(f"expected one catalog layer, found {len(found)}")
    return GEOPORTAL + found[0]["Url"]


def fetch():
    os.makedirs(TILES, exist_ok=True)
    boundary_url = catalog_url(lambda item: str(item.get("Id")) == "1806")
    query = urllib.parse.urlencode({"SERVICE": "WFS", "VERSION": "1.0.0", "REQUEST": "GetFeature",
                                    "TYPENAME": BOUNDARY_LAYER, "OUTPUTFORMAT": "application/json"})
    boundaries = json.loads(get(f"{boundary_url}&{query}"))
    plan = [f for f in boundaries["features"] if f["properties"].get("naziv_kratki") == PLAN_SHORT_NAME]
    if len(plan) != 1:
        raise SystemExit(f"expected one {PLAN_SHORT_NAME} boundary, found {len(plan)}")
    feature = plan[0]
    feature["properties"]["source"] = f"{GEOPORTAL} WFS {BOUNDARY_LAYER}"
    feature["properties"]["pdf"] = GEOPORTAL + "Temp/" + feature["properties"]["naziv_pdf"]
    with open(os.path.join(DATA, "obuhvat.geojson"), "w", encoding="utf-8") as out:
        json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3765"}},
                   "features": [feature]}, out, ensure_ascii=False, indent=1)
    log(f"boundary: {feature['properties']['naziv']} ({feature['properties']['akti_sggz']})")

    sheet_url = catalog_url(lambda item: item.get("WmsSlojevi") == SHEET_LAYER)
    x0, y0, x1, y1 = EXTENT
    width, height = math.ceil((x1 - x0) / MPP), math.ceil((y1 - y0) / MPP)
    tiles = [(tx, ty) for ty in range(0, height, TILE_PX) for tx in range(0, width, TILE_PX)]
    for index, (tx, ty) in enumerate(tiles, 1):
        path = os.path.join(TILES, f"{SHEET_LAYER}_{MPP}_{tx}_{ty}.png")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            log(f"tile {index}/{len(tiles)} cached")
            continue
        w, h = min(TILE_PX, width - tx), min(TILE_PX, height - ty)
        bx0, by1 = x0 + tx * MPP, y1 - ty * MPP
        bbox = f"{bx0:.3f},{by1 - h * MPP:.3f},{bx0 + w * MPP:.3f},{by1:.3f}"
        query = urllib.parse.urlencode({"SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": SHEET_LAYER,
                                        "STYLES": "", "SRS": "EPSG:3765", "BBOX": bbox, "WIDTH": w, "HEIGHT": h, "FORMAT": "image/png"})
        body = get(f"{sheet_url}&{query}", binary=True)
        if not body.startswith(b"\x89PNG"):
            raise SystemExit(f"tile {tx},{ty}: not a PNG ({len(body)} bytes)")
        with open(path + ".part", "wb") as out:
            out.write(body)
        os.replace(path + ".part", path)
        log(f"tile {index}/{len(tiles)} fetched ({len(body)} bytes)")


def sheet():
    """The stitched sheet on white, as a greyscale array; row 0 is EXTENT's top edge."""
    x0, y0, x1, y1 = EXTENT
    width, height = math.ceil((x1 - x0) / MPP), math.ceil((y1 - y0) / MPP)
    canvas = Image.new("L", (width, height), 255)
    for ty in range(0, height, TILE_PX):
        for tx in range(0, width, TILE_PX):
            path = os.path.join(TILES, f"{SHEET_LAYER}_{MPP}_{tx}_{ty}.png")
            if not os.path.exists(path):
                raise SystemExit(f"missing tile {path}: run --fetch")
            tile = Image.open(path).convert("LA")
            canvas.paste(tile.convert("L"), (tx, ty), mask=tile.getchannel("A"))
    return np.array(canvas)


def to_px(x, y):
    return (x - EXTENT[0]) / MPP, (EXTENT[3] - y) / MPP


def to_crs(px, py):
    return round(EXTENT[0] + px * MPP, 2), round(EXTENT[3] - py * MPP, 2)


def disk(size):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def polygons(mask):
    """Outer rings (with holes) of a binary mask, simplified, as EPSG:3765 polygon coordinate lists."""
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    if hierarchy is None:
        return out
    for index, contour in enumerate(contours):
        if hierarchy[0][index][3] != -1:
            continue
        rings = [contour]
        child = hierarchy[0][index][2]
        while child != -1:
            rings.append(contours[child])
            child = hierarchy[0][child][0]
        coordinates = []
        for ring_index, ring in enumerate(rings):
            simple = cv2.approxPolyDP(ring, SIMPLIFY_M / MPP, True).reshape(-1, 2)
            if len(simple) < 3:
                continue
            # Pixel centres to the pixel edges the mask covers.
            points = [to_crs(px + 0.5, py + 0.5) for px, py in simple]
            area = cv2.contourArea(simple.astype(np.float32)) * MPP * MPP
            if ring_index == 0 and area < MIN_PART_M2:
                break
            if ring_index > 0 and area < MIN_PART_M2:
                continue
            coordinates.append(points + [points[0]])
        if coordinates:
            out.append(coordinates)
    return out


def extract():
    claims = json.load(open(os.path.join(DATA, "claims.json"), encoding="utf-8"))["claims"]
    grey = sheet()
    Image.fromarray(grey).save(os.path.join(DATA, "sheet-20cm.png"))
    smooth = cv2.medianBlur(cv2.medianBlur(grey, MEDIAN_PX), MEDIAN_PX)
    high = cv2.morphologyEx((smooth < TONE_HIGH).astype(np.uint8), cv2.MORPH_OPEN, disk(13))
    mass = cv2.morphologyEx((smooth < TONE_ANY).astype(np.uint8), cv2.MORPH_CLOSE, disk(21))
    mass = cv2.morphologyEx(ndimage.binary_fill_holes(mass).astype(np.uint8), cv2.MORPH_OPEN, disk(25))
    mass = mass | high
    taken = np.zeros_like(mass)
    features = []
    for claim in claims:
        bx0, by0, bx1, by1 = claim["box"]
        c0, r0 = (int(v) for v in to_px(bx0, by1))
        c1, r1 = (int(math.ceil(v)) for v in to_px(bx1, by0))
        inside = np.zeros_like(mass)
        inside[r0:r1, c0:c1] = 1
        own = mass & inside & (1 - taken)
        if claim["kind"] == "residential":
            # A claim may set its own tone limit: Mamutica's mid tones are its low podium, not the slab.
            tone = claim.get("toneHigh")
            top = own & (cv2.morphologyEx((smooth < tone).astype(np.uint8), cv2.MORPH_OPEN, disk(13)) if tone else high)
            # The ground-floor cells around a slab are drawn as a lattice; only solid runs of them are kept.
            low = cv2.morphologyEx(own & (1 - cv2.dilate(top, disk(3))), cv2.MORPH_CLOSE, disk(15))
            low = cv2.morphologyEx(low & (1 - top), cv2.MORPH_OPEN, disk(17))
            parts = [("high", top, claim["heightM"], claim["storeys"]), ("low", low, claim["lowHeightM"], 1)]
        else:
            whole = cv2.morphologyEx(own, cv2.MORPH_CLOSE, disk(9))
            parts = [("whole", whole, claim["heightM"], claim["storeys"])]
        count = 0
        for part, part_mask, height, storeys in parts:
            for index, rings in enumerate(polygons(part_mask)):
                count += 1
                properties = {k: v for k, v in claim.items() if k != "box"}
                properties.update({"part": part, "partIndex": index, "heightM": height, "storeys": storeys})
                features.append({"type": "Feature", "properties": properties, "geometry": {"type": "Polygon", "coordinates": rings}})
        taken |= own
        if not count:
            raise SystemExit(f"claim {claim['key']}: no building mass inside its box")
        area = sum(cv2.contourArea(np.array([to_px(x, y) for x, y in f["geometry"]["coordinates"][0]], np.float32)) * MPP * MPP
                   for f in features if f["properties"]["key"] == claim["key"])
        log(f"{claim['key']:>10}: {count} part(s), {area:.0f} m²")
    with open(os.path.join(DATA, "buildings.geojson"), "w", encoding="utf-8") as out:
        json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3765"}},
                   "features": features}, out, ensure_ascii=False, indent=1)
    overlay(grey, features, claims)
    log(f"wrote {len(features)} building parts of {len(claims)} buildings")


def overlay(grey, features, claims):
    image = Image.fromarray(grey).convert("RGB")
    draw = ImageDraw.Draw(image)
    colours = {"high": (0, 90, 220), "low": (240, 140, 0), "whole": (200, 0, 160)}
    for claim in claims:
        bx0, by0, bx1, by1 = claim["box"]
        draw.rectangle([to_px(bx0, by1), to_px(bx1, by0)], outline=(150, 150, 150), width=2)
        draw.text(to_px(bx0, by1), claim["key"], fill=(200, 0, 0), font_size=48)
    for feature in features:
        for ring in feature["geometry"]["coordinates"]:
            draw.line([to_px(x, y) for x, y in ring], fill=colours[feature["properties"]["part"]], width=4)
    image.resize((image.width // 3, image.height // 3)).save(os.path.join(DATA, "overlay.png"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true", help="fetch the boundary and the sheet tiles")
    parser.add_argument("--extract", action="store_true", help="extract the buildings from the cached sheet")
    parser.add_argument("--all", action="store_true", help="both steps")
    args = parser.parse_args()
    if not (args.fetch or args.extract or args.all):
        parser.print_help()
        sys.exit(1)
    if args.fetch or args.all:
        fetch()
    if args.extract or args.all:
        extract()


if __name__ == "__main__":
    main()
