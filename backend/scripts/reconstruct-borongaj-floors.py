#!/usr/bin/env python3
"""Extract verified whole-floor PDF insets and register them to the Pionir proposal.

Requires PyMuPDF and Shapely 2.x. Source URLs, checksums, orientation and reviewed
crop rectangles are versioned in floor-plan-sources.json. Wall footprints and
openings follow CAD geometry; vertical dimensions are explicit estimates.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from urllib.request import urlopen
from pionir_floor_architecture import extract_architecture

PROJECT = Path(__file__).resolve().parents[2] / "rekonstrukcije/pionir-paron/borongajska-caviceva"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_file(source, cache, fetch):
    path = cache / (digest(source["url"].encode()) + ".pdf")
    if not path.exists():
        if not fetch:
            raise ValueError(f"Missing cached PDF: {source['url']}; use --fetch")
        with urlopen(source["url"], timeout=45) as response:
            data = response.read()
        if digest(data) != source["sha256"]:
            raise ValueError(f"Source changed; review before updating checksum: {source['url']}")
        temporary = path.with_suffix(".part")
        temporary.write_bytes(data)
        temporary.replace(path)
    if digest(path.read_bytes()) != source["sha256"]:
        raise ValueError(f"Cached PDF checksum mismatch: {source['url']}")
    return path


def clip_segment(a, b, box):
    """Liang-Barsky clipping keeps gardens/annotations outside the building frame out."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    low, high = 0.0, 1.0
    for p, q in [(-dx, a[0] - box[0]), (dx, box[2] - a[0]),
                 (-dy, a[1] - box[1]), (dy, box[3] - a[1])]:
        if abs(p) < 1e-12:
            if q < 0:
                return None
        elif p < 0:
            low = max(low, q / p)
        else:
            high = min(high, q / p)
        if low > high:
            return None
    return (a[0] + low * dx, a[1] + low * dy), (a[0] + high * dx, a[1] + high * dy)


def extract_segments(path, source, gray):
    import pymupdf as pdf

    with pdf.open(path) as document:
        page = document[source["page"] - 1]
        rotation = page.rotation_matrix
        box = source["crop"]
        crop = pdf.Rect(box)
        width, height = box[2] - box[0], box[3] - box[1]
        segments = set()

        def emit(a, b):
            segment = clip_segment(a * rotation, b * rotation, box)
            if segment is None:
                return
            points = [tuple(round(max(0, min(1, value)), 5) for value in
                      ((point[0] - box[0]) / width, (point[1] - box[1]) / height))
                      for point in segment]
            if points[0] != points[1]:
                points.sort()
                segments.add(points[0] + points[1])

        for drawing in page.get_drawings():
            color = drawing["color"]
            # The inset CAD strokes are neutral 39% gray. The apartment highlight
            # and hatch use black fills / lighter strokes, and are not floor geometry.
            if drawing["type"] != "s" or not color or any(abs(channel - gray) > 0.005 for channel in color):
                continue
            rect = drawing["rect"] * rotation
            if rect.x1 < crop.x0 or rect.x0 > crop.x1 or rect.y1 < crop.y0 or rect.y0 > crop.y1:
                continue
            for item in drawing["items"]:
                kind = item[0]
                if kind == "l":
                    emit(item[1], item[2])
                elif kind == "c":
                    a, b, c, d = item[1:]
                    previous = a
                    # Eight chords per cubic preserve doors and fixtures at this inset scale.
                    for step in range(1, 9):
                        t = step / 8
                        point = a * (1 - t) ** 3 + b * (3 * t * (1 - t) ** 2) + c * (3 * t * t * (1 - t)) + d * t ** 3
                        emit(previous, point)
                        previous = point
                elif kind == "re":
                    r = item[1]
                    points = [r.tl, r.tr, r.br, r.bl, r.tl]
                    for a, b in zip(points, points[1:]):
                        emit(a, b)
                elif kind == "qu":
                    q = item[1]
                    points = [q.ul, q.ur, q.lr, q.ll, q.ul]
                    for a, b in zip(points, points[1:]):
                        emit(a, b)
                else:
                    raise ValueError(f"Unsupported PDF primitive {kind}: {source['url']}")
        if len(segments) < 500:
            raise ValueError(f"Incomplete floor inset ({len(segments)} segments): {source['url']}")
        return sorted(segments)


def registration(feature, building):
    """Uniform fit preserves drawing proportions; mismatch remains explicit provenance."""
    if building.get('reviewedRegistration'):
        return json.loads(json.dumps(building['reviewedRegistration']))
    geometry = feature['geometry']
    if geometry['type'] == 'Polygon':
        ring = geometry['coordinates'][0]
    elif geometry['type'] == 'MultiPolygon' and len(geometry['coordinates']) == 1:
        ring = geometry['coordinates'][0][0]
    else:
        raise ValueError('Registration requires one reviewed connected footprint.')
    origin = ring[0]
    lon_scale = 111320 * math.cos(math.radians(origin[1]))
    points = [((p[0] - origin[0]) * lon_scale, (p[1] - origin[1]) * 111320) for p in ring]
    east_edges = []
    for a, b in zip(points, points[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        if abs(dx) > abs(dy):
            if dx < 0:
                dx, dy = -dx, -dy
            east_edges.append((math.hypot(dx, dy), dx, dy))
    length, dx, dy = max(east_edges)
    ax, ay = dx / length, dy / length
    uv = [(x * ax + y * ay, x * ay - y * ax) for x, y in points]
    u0, u1 = min(p[0] for p in uv), max(p[0] for p in uv)
    v0, v1 = min(p[1] for p in uv), max(p[1] for p in uv)
    width, height = u1 - u0, v1 - v0
    reference = next((floor for floor in building['floors']
                      if floor['level'] == building.get('registrationFloorLevel')), building['floors'][0])
    crop = reference['source']['crop']
    paper_w, paper_h = crop[2] - crop[0], crop[3] - crop[1]
    right = building["northInDrawing"] == "right"
    if right:
        paper_w, paper_h = paper_h, paper_w
    scale = (paper_w * width + paper_h * height) / (paper_w ** 2 + paper_h ** 2)
    fit_w, fit_h = paper_w * scale, paper_h * scale
    residual = max(abs(fit_w - width), abs(fit_h - height)) / 2
    if residual > 2:
        raise ValueError(f"{building['id']}: registration residual {residual:.2f} m needs review")
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    u0, u1, v0, v1 = uc - fit_w / 2, uc + fit_w / 2, vc - fit_h / 2, vc + fit_h / 2

    def lnglat(u, v):
        return [round(origin[0] + (u * ax + v * ay) / lon_scale, 9),
                round(origin[1] + (u * ay - v * ax) / 111320, 9)]

    corners = [lnglat(u0, v0), lnglat(u1, v0), lnglat(u1, v1), lnglat(u0, v1)]
    if right:
        corners = [corners[3], corners[0], corners[1], corners[2]]
    return {
        "corners": corners,
        "basis": "Uniform-scale fit to oriented permit footprint, centred on that footprint; catalogue north symbol fixes rotation.",
        "accuracy": "approximate",
        "northInDrawing": building["northInDrawing"],
        **({'permitFeatureId': feature['properties']['sourceFeatureId']}
           if feature['properties'].get('sourceFeatureId') else
           {'sourceBuildingId': str(feature['properties'].get('dguBuildingId') or feature['properties'].get('sourceLayerId'))}),
        "metresPerPdfPoint": round(scale, 6),
        "maxEdgeResidualM": round(residual, 3),
        "note": "This residual measures outline fit, not surveyed positional accuracy. Balconies and later design changes can differ from the permit footprint."
    }


def build_plans(feature, building, cache, fetch):
    layouts, floors, layout_by_digest = [], [], {}
    placement = registration(feature, building)
    for index, floor in enumerate(building["floors"]):
        source = floor["source"]
        path = source_file(source, cache, fetch)
        segments = extract_segments(path, source, building["strokeGray"])
        signature = digest(json.dumps(segments, separators=(",", ":")).encode())
        layout_id = layout_by_digest.get(signature)
        if layout_id is None:
            layout_id = f"{building['id']}-layout-{len(layouts) + 1}"
            layout_by_digest[signature] = layout_id
            architecture = extract_architecture(path, source, building['strokeGray'],
                                                placement['metresPerPdfPoint'], floor.get('storeyHeightM', 3))
            layouts.append({"id": layout_id, "source": source, "sourceVectorSha256": signature,
                            "architecture": architecture})
        floors.append({"id": f"{building['id']}-floor-{floor['level']}",
                       "level": floor["level"], "elevationM": floor["elevationM"],
                       "elevationBasis": floor["elevationBasis"], "layoutId": layout_id,
                       "source": source, "apartments": floor["apartments"]})
        print(f"{building['id']} {index + 1}/{len(building['floors'])} floors: level {floor['level']}, {len(segments)} segments", flush=True)
    return {"schema": "consensus-builder.building-floor-plans.v2",
            "registration": placement, "layouts": layouts, "floors": floors,
            "notes": building.get("notes", ["Published catalogue layout, not an as-built survey.",
                      building.get('elevationNote', 'Elevations are estimated from the existing 3 m display storeys; ground floor is relative z=0.'),
                      "Wall footprints and opening positions come from CAD; opening types, vertical dimensions and railing details are inferred.",
                      "Apartment references cover recovered catalogues, not all units drawn on a floor."])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=PROJECT / "floor-plan-sources.json")
    parser.add_argument("--proposal", type=Path, default=PROJECT / "proposal.geojson")
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--fetch", action="store_true", help="Download missing source PDFs, verifying their checksums")
    parser.add_argument("--write", action="store_true", help="Replace only building floorPlans in the canonical archive")
    if len(sys.argv) == 1:
        parser.print_help()
        return
    args = parser.parse_args()
    manifest = json.loads(args.sources.read_text())
    proposal = json.loads(args.proposal.read_text())
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    buildings = {f["properties"]["name"]: f for f in proposal["features"]
                 if f["properties"].get("consensus:role") == "building"}
    for building in manifest["buildings"]:
        feature = buildings[building["id"]]
        feature["properties"]["floorPlans"] = build_plans(feature, building, args.cache_dir, args.fetch)
    if args.write:
        # Keep polygon points compact so reviewed geometry stays readable.
        import re
        text = json.dumps(proposal, ensure_ascii=False, indent=2) + "\n"
        text = re.sub(r"\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]",
                      r"[\1, \2, \3, \4]", text)
        text = re.sub(r"\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]",
                      r"[\1, \2]", text)
        temporary = args.proposal.with_suffix(".geojson.part")
        temporary.write_text(text)
        temporary.replace(args.proposal)
    print(f"{'Wrote' if args.write else 'Validated'} {sum(len(b['floors']) for b in manifest['buildings'])} floors in {len(manifest['buildings'])} buildings.")


if __name__ == "__main__":
    main()
