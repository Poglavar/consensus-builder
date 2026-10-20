#!/usr/bin/env python3
"""Prepare a small browser-only parcel heuristic demo bundle from reviewed imagery candidates.

This packages three RGB crops and nearby OSM context only. It does not include cadastral
boundaries, evaluation labels, model outputs, or predictions. OSM geometry is kept as
image-edge coordinates so a browser can rasterize it without a GIS library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon, box, shape
from shapely.ops import polygonize, transform, unary_union

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "heuristic-demo-v1"
REVIEW = ROOT / "annotations" / "target-review-v1.json"
SIZE = 1024
QUERY_MARGIN_M = 30.0
CLIP_MARGIN_PX = 128.0
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
)
TRANSIENT_HTTP = {408, 425, 429, 500, 502, 503, 504}

TARGETS = (
    {"id": "magoanine-c-west-houses", "review_id": "magoanine-c-west-houses", "region": "Mozambique", "title": "Magoanine C west houses"},
    {"id": "baniyataar-houses-and-fields", "review_id": "baniyataar-houses-and-fields", "region": "Nepal", "title": "Baniyataar houses and fields"},
    {"id": "zadar-tile-2582-31827", "region": "Croatia", "title": "Zadar"},
)
VENDOR_FILES = (
    (ROOT.parent.parent / "frontend/vendor/proj4-2.22.0/proj4.js", "vendor/proj4.js"),
    (ROOT.parent.parent / "backend/node_modules/proj4/LICENSE.md", "vendor/proj4-LICENSE.md"),
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_sources() -> list[dict[str, Any]]:
    review = json.loads(REVIEW.read_text())
    review_by_id = {s["id"]: s for s in review["samples"]}
    out = []
    for target in TARGETS:
        if target["id"] == "zadar-tile-2582-31827":
            dataset = ROOT / "output/city/zadar/dataset"
            manifest = json.loads((dataset / "manifest.json").read_text())
            sample = next(s for s in manifest["samples"] if s["id"] == "tile_2582_31827")
            image = dataset / sample["image"]
            sidecar = dataset / sample["osm_input"]
            out.append({
                **target, "image_path": image, "bbox": sample["bbox"], "crs": manifest["crs"],
                "expected_image_sha256": sample["sha256"]["image"], "source_url": manifest["provenance"]["wms"],
                "attribution": "Državna geodetska uprava (DGU), DOF 2023/24",
                "license": "Not specified in the local manifest; verify DGU WMS terms before redistribution.",
                "acquired_at": manifest.get("imagery_date"), "sidecar": sidecar,
                "source_metadata": {"native_gsd_m": manifest["provenance"].get("native_gsd_m"),
                                    "imagery": manifest["provenance"].get("imagery")},
            })
        else:
            sample = review_by_id[target["review_id"]]
            image = ROOT / "output/target-review-v1" / sample["image"]
            out.append({
                **target, "image_path": image, "bbox": sample["bbox"], "crs": sample["crs"],
                "expected_image_sha256": sample["image_sha256"], "source_url": sample["item_url"],
                "attribution": "Open Imagery Network contributors (HOTOSM)", "license": sample["license"],
                "acquired_at": sample["acquisition_start"], "sidecar": None,
                "source_metadata": {"source_gsd_m": sample["source_gsd_m"],
                                    "output_pixel_spacing_m": sample["output_pixel_spacing_m"]},
            })
        out[-1]["image_sha256"] = out[-1]["expected_image_sha256"]
        if not out[-1]["image_path"].is_file():
            raise FileNotFoundError(out[-1]["image_path"])
        actual = sha256(out[-1]["image_path"])
        if actual != out[-1]["expected_image_sha256"]:
            raise ValueError(f"source image hash mismatch for {target['id']}: {actual}")
        out[-1]["image_sha256"] = actual
    return out


def bbox_to_lonlat(bounds: list[float], crs: str, margin_m: float) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = bounds
    expanded = box(minx - margin_m, miny - margin_m, maxx + margin_m, maxy + margin_m)
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    geom = transform(to_wgs84.transform, expanded)
    return tuple(float(v) for v in geom.bounds)


def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    west, south, east, north = bbox
    boxtext = f"{south:.7f},{west:.7f},{north:.7f},{east:.7f}"
    selectors = []
    for element in ("way", "relation"):
        selectors.extend((
            f'{element}["building"]({boxtext});',
            f'{element}["natural"="water"]({boxtext});',
            f'{element}["waterway"]({boxtext});',
            f'{element}["highway"]({boxtext});',
        ))
    return "[out:json][timeout:25][maxsize:16777216];(\n" + "\n".join(selectors) + "\n);out geom;"


def request_overpass(query: str, cache: Path, *, retry_failed: bool = False):
    if cache.exists():
        data = json.loads(cache.read_text())
        if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
            raise ValueError(f"invalid cached Overpass response: {cache}")
        return data, "cached", sha256(cache), []
    failure_cache = cache.with_suffix(".failure.json")
    if failure_cache.exists() and not retry_failed:
        failure = json.loads(failure_cache.read_text())
        return None, "unavailable", None, list(failure.get("warnings", []))
    body = urllib.parse.urlencode({"data": query}).encode()
    warnings: list[str] = []
    last_error: Exception | None = None
    for index, endpoint in enumerate(ENDPOINTS):
        req = urllib.request.Request(endpoint, data=body, headers={
            "User-Agent": "parcel-bench-heuristic-demo/1.0 (small bounded public OSM request)",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=32) as response:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
                if len(payload) > MAX_RESPONSE_BYTES:
                    raise ValueError("Overpass response exceeded 16 MiB bound")
                data = json.loads(payload)
            if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
                raise ValueError("Overpass returned an unexpected JSON shape")
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(payload)
            return data, endpoint, hashlib.sha256(payload).hexdigest(), warnings
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in TRANSIENT_HTTP:
                raise RuntimeError(f"Overpass endpoint rejected bounded request (HTTP {exc.code})") from exc
            warnings.append(f"Overpass endpoint {index + 1} transient HTTP {exc.code}; tried next endpoint.")
        except (TimeoutError, OSError, urllib.error.URLError) as exc:
            last_error = exc
            warnings.append(f"Overpass endpoint {index + 1} transient transport error; tried next endpoint.")
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            raise RuntimeError(f"Overpass response invalid: {exc}") from exc
        if index < len(ENDPOINTS) - 1:
            time.sleep(1.0)
    warnings.append(f"OSM features unavailable: all {len(ENDPOINTS)} public Overpass endpoints failed transiently ({type(last_error).__name__ if last_error else 'unknown'}). No OSM geometry was fabricated.")
    failure_cache.parent.mkdir(parents=True, exist_ok=True)
    failure_cache.write_text(json.dumps({"status": "transient-failure", "warnings": warnings,
                                         "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
                                        separators=(",", ":")) + "\n")
    return None, "unavailable", None, warnings


def element_tags(element: dict[str, Any]) -> dict[str, Any]:
    return element.get("tags") or {}


def lonlat_coords(element: dict[str, Any]) -> list[tuple[float, float]]:
    return [(float(p["lon"]), float(p["lat"])) for p in element.get("geometry", []) if "lon" in p and "lat" in p]


def relation_geometry(relation: dict[str, Any], elements_by_id: dict[tuple[str, int], dict[str, Any]], project: Transformer):
    role_lines: dict[str, list[LineString]] = {"outer": [], "inner": []}
    for member in relation.get("members", []):
        if member.get("type") != "way" or member.get("role") not in role_lines:
            continue
        coords = []
        way = elements_by_id.get(("way", member.get("ref")))
        if way:
            coords = lonlat_coords(way)
        if not coords:
            coords = [(float(p["lon"]), float(p["lat"])) for p in member.get("geometry", []) if "lon" in p and "lat" in p]
        if len(coords) >= 2:
            role_lines[member["role"]].append(LineString([project.transform(*point) for point in coords]))
    if not role_lines["outer"]:
        return None

    def polygons(lines: list[LineString]) -> list[Polygon]:
        if not lines:
            return []
        return list(polygonize(unary_union(lines)))

    outers = polygons(role_lines["outer"])
    inners = polygons(role_lines["inner"])
    if not outers:
        return None
    geom = unary_union(outers)
    if inners:
        geom = geom.difference(unary_union(inners))
    return geom


def polygonal(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        return [part for part in geom.geoms if isinstance(part, Polygon)]
    return []


def lineal(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        return [part for part in geom.geoms if isinstance(part, LineString)]
    return []


def image_geometry(geom, bounds: list[float]):
    minx, miny, maxx, maxy = bounds
    sx, sy = SIZE / (maxx - minx), SIZE / (maxy - miny)
    return transform(lambda x, y, z=None: ((x - minx) * sx, (maxy - y) * sy), geom)


def ring_coords(coords) -> list[list[float]]:
    return [[round(float(x), 3), round(float(y), 3)] for x, y in coords]


def polygon_features(geom, ident: str, bounds: list[float], clipper, warnings: list[str]) -> list[dict[str, Any]]:
    result = []
    if geom is not None and not geom.intersects(clipper):
        return result
    for part_index, part in enumerate(polygonal(geom)):
        if not part.is_valid:
            part = part.buffer(0)
        for repaired in polygonal(part):
            clipped = repaired.intersection(clipper)
            for component_index, polygon in enumerate(polygonal(clipped)):
                coords = [ring_coords(polygon.exterior.coords)] + [ring_coords(r.coords) for r in polygon.interiors]
                if len(coords[0]) < 4:
                    continue
                suffix = f":part{part_index + 1}.{component_index + 1}" if len(polygonal(geom)) > 1 or component_index else ""
                result.append({"id": ident + suffix, "rings": coords})
    if not result and geom is not None and not geom.is_empty:
        warnings.append(f"Omitted non-polygonal or unassemblable polygon feature {ident}.")
    return result


def line_features(geom, ident: str, bounds: list[float], clipper) -> list[tuple[str, list[list[float]]]]:
    result = []
    for part_index, part in enumerate(lineal(geom)):
        clipped = part.intersection(clipper)
        for component_index, line in enumerate(lineal(clipped)):
            coords = ring_coords(line.coords)
            if len(coords) >= 2:
                suffix = f":part{part_index + 1}.{component_index + 1}" if len(lineal(geom)) > 1 or component_index else ""
                result.append((ident + suffix, coords))
    return result


def normalize_overpass(data: dict[str, Any], sample: dict[str, Any], fetched_at: str, warnings: list[str]) -> dict[str, Any]:
    bounds = sample["bbox"]
    minx, miny, maxx, maxy = bounds
    crs = sample["crs"]
    to_metric = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    query_bounds = bbox_to_lonlat(bounds, crs, QUERY_MARGIN_M)
    clip = box(-CLIP_MARGIN_PX, -CLIP_MARGIN_PX, SIZE + CLIP_MARGIN_PX, SIZE + CLIP_MARGIN_PX)
    elements = data.get("elements", [])
    by_id = {(e.get("type"), e.get("id")): e for e in elements if e.get("type") == "way"}
    features = {"buildings": [], "roads": [], "water": [], "waterways": []}
    omitted_relations = 0
    for element in elements:
        kind = element.get("type")
        ident = f"{kind}/{element.get('id')}"
        tags = element_tags(element)
        geom = None
        is_closed = kind == "way" and len(lonlat_coords(element)) >= 4 and lonlat_coords(element)[0] == lonlat_coords(element)[-1]
        if kind == "relation":
            geom = relation_geometry(element, by_id, to_metric)
            if geom is None:
                omitted_relations += 1
                continue
        elif kind == "way":
            coords = lonlat_coords(element)
            if len(coords) < 2:
                warnings.append(f"OSM feature {ident} lacked usable geometry.")
                continue
            projected = [to_metric.transform(*point) for point in coords]
            geom = Polygon(projected) if is_closed and ("building" in tags or tags.get("natural") == "water" or "water" in tags or tags.get("waterway") == "riverbank") else LineString(projected)
        else:
            continue
        geom_px = image_geometry(geom, bounds)
        # Polygonal buildings and water bodies; waterway-area polygons remain water.
        is_building = "building" in tags
        is_water_area = tags.get("natural") == "water" or "water" in tags or tags.get("waterway") == "riverbank"
        if is_building:
            features["buildings"].extend(polygon_features(geom_px, ident, bounds, clip, warnings))
        elif is_water_area:
            features["water"].extend(polygon_features(geom_px, ident, bounds, clip, warnings))
        elif "highway" in tags:
            for part_id, points in line_features(geom_px, ident, bounds, clip):
                features["roads"].append({"id": part_id, "points": points,
                    "width_m": safe_float(tags.get("width")), "highway": str(tags.get("highway")),
                    "bridge": tag_bool(tags.get("bridge")), "tunnel": tag_bool(tags.get("tunnel"))})
        elif "waterway" in tags:
            for part_id, points in line_features(geom_px, ident, bounds, clip):
                features["waterways"].append({"id": part_id, "points": points,
                    "width_m": safe_float(tags.get("width"))})
        elif kind == "relation":
            omitted_relations += 1
    if omitted_relations:
        warnings.append(f"Omitted {omitted_relations} OSM relations that had no assemblable outer polygon geometry.")
    return {"features": features, "query_bbox_wgs84": [round(v, 7) for v in query_bounds], "osm_fetched_at": fetched_at}


def safe_float(value):
    try:
        number = float(str(value).replace("m", "").strip())
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def tag_bool(value):
    return str(value).lower() in {"yes", "true", "1"}


def normalize_sidecar(sample: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    data = json.loads(sample["sidecar"].read_text())
    if data.get("tile", {}).get("crs") != sample["crs"] or data.get("tile", {}).get("bbox") != sample["bbox"]:
        raise ValueError("Zadar OSM sidecar tile metadata does not match image source.")
    clip = box(-CLIP_MARGIN_PX, -CLIP_MARGIN_PX, SIZE + CLIP_MARGIN_PX, SIZE + CLIP_MARGIN_PX)
    features = {"buildings": [], "roads": [], "water": [], "waterways": []}
    for key, source_key in (("buildings", "buildings"), ("roads", "roads"), ("water", "water")):
        for feature in data.get(source_key, []):
            props = feature.get("properties") or {}
            ident = str(props.get("osm_id", props.get("id", f"{key}/unknown")))
            geom = shape(feature["geometry"])
            geom_px = image_geometry(geom, sample["bbox"])
            if key in ("buildings", "water"):
                features[key].extend(polygon_features(geom_px, ident, sample["bbox"], clip, warnings))
            else:
                for part_id, points in line_features(geom_px, ident, sample["bbox"], clip):
                    features["roads"].append({"id": part_id, "points": points,
                        "width_m": safe_float(props.get("width_meters")), "highway": str(props.get("highway", "")),
                        "bridge": False, "tunnel": False})
    return {"features": features, "query_bbox_wgs84": None, "osm_fetched_at": None}


def sample_record(sample: dict[str, Any], run: bool, retry_overpass: bool = False) -> dict[str, Any]:
    image_rel = f"images/{sample['id']}.jpg"
    warnings: list[str] = []
    if sample["sidecar"]:
        osm = normalize_sidecar(sample, warnings)
        sidecar_sha = sha256(sample["sidecar"])
        source_osm_url = "local cached sidecar from the Croatian geodata Overture/OSM export"
    else:
        bbox_ll = bbox_to_lonlat(sample["bbox"], sample["crs"], QUERY_MARGIN_M)
        query = overpass_query(bbox_ll)
        cache = OUT / "cache" / f"{sample['id']}.overpass.json"
        img = OUT / image_rel
        if run:
            img.parent.mkdir(parents=True, exist_ok=True)
            if not img.exists() or sha256(img) != sample["image_sha256"]:
                shutil.copyfile(sample["image_path"], img)
            if sha256(img) != sample["image_sha256"]:
                raise ValueError(f"copied image hash mismatch: {img}")
        if run:
            data, endpoint, sidecar_sha, request_warnings = request_overpass(query, cache, retry_failed=retry_overpass)
            warnings.extend(request_warnings)
            if data is None:
                osm = {"features": {"buildings": [], "roads": [], "water": [], "waterways": []},
                       "query_bbox_wgs84": [round(v, 7) for v in bbox_ll], "osm_fetched_at": None}
            else:
                fetched = datetime.now(timezone.utc).isoformat(timespec="seconds") if endpoint != "cached" else None
                osm = normalize_overpass(data, sample, fetched, warnings)
                osm["osm_snapshot_at"] = data.get("osm3s", {}).get("timestamp_osm_base")
            source_osm_url = endpoint
        else:
            osm = {"features": {"buildings": [], "roads": [], "water": [], "waterways": []},
                   "query_bbox_wgs84": [round(v, 7) for v in bbox_ll], "osm_fetched_at": None}
            sidecar_sha = None
            source_osm_url = ENDPOINTS[0]
    img = OUT / image_rel
    if run:
        img.parent.mkdir(parents=True, exist_ok=True)
        if not img.exists() or sha256(img) != sample["image_sha256"]:
            shutil.copyfile(sample["image_path"], img)
        if sha256(img) != sample["image_sha256"]:
            raise ValueError(f"copied image hash mismatch: {img}")
    record = {
        "id": sample["id"], "title": sample["title"], "region": sample["region"],
        "image": image_rel, "image_sha256": sample["image_sha256"], "width": SIZE, "height": SIZE,
        "bbox": sample["bbox"], "crs": sample["crs"], "source_url": sample["source_url"],
        "attribution": sample["attribution"], "license": sample["license"], "acquired_at": sample["acquired_at"],
        "osm_attribution": "© OpenStreetMap contributors; some cached Croatian layers also include Overture data",
        "osm_license": "OpenStreetMap data is available under ODbL 1.0; verify separate Overture terms for derived layers.",
        "osm_fetched_at": osm["osm_fetched_at"], "osm_snapshot_at": osm.get("osm_snapshot_at"), "features": osm["features"], "warnings": warnings,
        "provenance": {"osm_source": source_osm_url, "osm_cache_sha256": sidecar_sha,
                       "query_bbox_wgs84": osm["query_bbox_wgs84"], "query_margin_m": QUERY_MARGIN_M,
                       "clip_margin_px": CLIP_MARGIN_PX, "image_source_sha256": sample["expected_image_sha256"],
                       **sample["source_metadata"]},
    }
    return record


def copy_vendor() -> list[dict[str, str]]:
    receipt = []
    for source, relative in VENDOR_FILES:
        if not source.is_file():
            raise FileNotFoundError(f"required local vendor input is missing: {source}")
        target = OUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        receipt.append({"path": relative, "sha256": sha256(target)})
    return receipt


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="fetch/cache OSM, copy images, and write the demo bundle")
    parser.add_argument("--retry-overpass", action="store_true", help="retry a target with a saved transient-failure receipt")
    args = parser.parse_args(argv)
    sources = load_sources()
    if not args.run:
        print("Dry run: will prepare 3 crops (Mozambique, Nepal, Croatia), reuse Zadar's OSM sidecar, and request two small Overpass bboxes.")
        print("Pass --run to fetch the bounded OSM responses and write ignored output/heuristic-demo-v1/ files.")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    vendor_receipt = copy_vendor()
    records = [sample_record(sample, True, args.retry_overpass) for sample in sources]
    bundle = {"schema": "heuristic-demo-bundle-v1", "purpose": "Browser-only RGB edge-cost parcel heuristic demo; features are context, not labels or parcel truth.",
              "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "vendor": vendor_receipt, "samples": records}
    path = OUT / "bundle.json"
    path.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {path}")
    for sample in records:
        counts = {key: len(sample["features"][key]) for key in ("buildings", "roads", "water", "waterways")}
        print(f"{sample['id']}: {counts}; warnings={len(sample['warnings'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
