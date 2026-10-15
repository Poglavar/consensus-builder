#!/usr/bin/env python3
"""Verify adapter coordinates against declared native CRS with independent PROJ transforms.

This checks coordinate handling, not cadastral survey accuracy or agreement with a basemap.
It never estimates a translation, changes the source geometry, or substitutes a guessed CRS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from pyproj import CRS, Geod, Transformer, datadir
from pyproj.transformer import TransformerGroup
from shapely.geometry import MultiLineString

TOLERANCE_M = 0.25
GEOD = Geod(ellps="WGS84")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def local_file(root: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError("alignment input paths must be relative to their evidence directory")
    file = (root / value).resolve()
    file.relative_to(root.resolve())
    return file


def verified_json(root: Path, file: Any, expected_hash: Any) -> tuple[Any, str]:
    data = local_file(root, file).read_bytes()
    sha = digest(data)
    if not isinstance(expected_hash, str) or sha != expected_hash:
        raise ValueError("alignment evidence SHA-256 mismatch")
    return json.loads(data), sha


def points(geometry: Any) -> list[tuple[float, float]]:
    if not isinstance(geometry, dict) or (geometry.get("type") not in {"Polygon", "MultiPolygon"}
                                         and not isinstance(geometry.get("rings"), list)):
        raise ValueError("alignment requires unchanged polygon geometry")
    result: list[tuple[float, float]] = []

    def visit(value: Any) -> None:
        if isinstance(value, list) and len(value) >= 2 and all(type(x) in {int, float} for x in value[:2]):
            x, y = value[:2]
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("non-finite source coordinate")
            result.append((x, y))
        elif isinstance(value, list) and value:
            for child in value:
                visit(child)
        else:
            raise ValueError("malformed source coordinates")

    visit(geometry.get("coordinates", geometry.get("rings")))
    if len(result) > 5000:
        raise ValueError("native alignment sample exceeds the bounded vertex limit")
    if len(set(result)) < 3:
        raise ValueError("at least three distinct native vertices are required")
    return result


def rings(geometry: Any) -> list[list]:
    if isinstance(geometry.get("rings"), list):
        return geometry["rings"]
    if geometry.get("type") == "Polygon":
        return geometry["coordinates"]
    return [ring for polygon in geometry["coordinates"] for ring in polygon]


def boundary_difference(native_geometry: dict, output_geometry: dict, transform: Any,
                        axis_order: str, output_points: list) -> float:
    # Servers can densify the same boundary differently in different output projections.
    # Compare every boundary segment, not only nearest vertices: collinear extra vertices
    # do not imply an offset, while a dropped corner or moved edge still fails.
    center_lon = sum(point[0] for point in output_points) / len(output_points)
    center_lat = sum(point[1] for point in output_points) / len(output_points)
    metric = Transformer.from_crs("EPSG:4326", CRS.from_proj4(
        f"+proj=aeqd +lat_0={center_lat} +lon_0={center_lon} +datum=WGS84 +units=m"), always_xy=True)
    expected = []
    for ring in rings(native_geometry):
        projected = []
        for point in ring:
            first, second = point[:2]
            x, y = (first, second) if axis_order == "east-north" else (second, first)
            projected.append(metric.transform(*transform.transform(x, y, errcheck=True), errcheck=True))
        expected.append(projected)
    actual = [[metric.transform(*point[:2], errcheck=True) for point in ring] for ring in rings(output_geometry)]
    value = MultiLineString(expected).hausdorff_distance(MultiLineString(actual))
    if not math.isfinite(value):
        raise ValueError("boundary comparison produced a non-finite distance")
    return value


def reference_codes(metadata: Any) -> set[int]:
    """Read published ArcGIS layer spatial references, or a named native CRS in a profile.

    WFS/GML profiles retain their verified capabilities CRS as `nativeCrs`; their original
    metadata hash and first-party URL remain in the evidence pack. Output/metric CRS fields
    deliberately do not count as a native CRS declaration.
    """
    codes: set[int] = set()
    if not isinstance(metadata, dict):
        return codes
    extent = metadata.get("extent") if isinstance(metadata.get("extent"), dict) else {}
    # A map service can expose projected geometry while its stored parcels use another datum.
    # When storage CRS is published, service/extent CRS alone cannot prove native conversion.
    refs = (metadata["sourceSpatialReference"],) if metadata.get("sourceSpatialReference") else (
        metadata.get("spatialReference"), extent.get("spatialReference"))
    for ref in refs:
        if isinstance(ref, dict):
            for key in ("wkid", "latestWkid"):
                if type(ref.get(key)) is int:
                    codes.add(ref[key])
    value = metadata.get("nativeCrs")
    if not metadata.get("sourceSpatialReference") and isinstance(value, str) and value.startswith("EPSG:") and value[5:].isdigit():
        codes.add(int(value[5:]))
    return codes


def feature_id(feature: Any) -> str:
    value = feature.get("id") or feature.get("properties", {}).get("parcelId")
    if not isinstance(value, str) or not value:
        raise ValueError("alignment sample lacks canonical parcel ID")
    return value


def check_alignment(evidence_path: Path, cache_path: Path, *, source_id: str,
                    city_code: str, contract_sha256: str) -> dict[str, Any]:
    evidence_bytes = evidence_path.read_bytes()
    evidence = json.loads(evidence_bytes)
    root = evidence_path.parent
    if (evidence.get("schemaVersion") != 1 or evidence.get("sourceId") != source_id
            or str(evidence.get("cityCode")) != city_code
            or evidence.get("contractSha256") != contract_sha256):
        raise ValueError("alignment evidence does not bind to source, city and coordinate contract")
    # A CRS definition/operation is evidence. A manually fitted displacement is not one.
    if any(key in evidence for key in ("offset", "translation", "fit", "correction", "towgs84")):
        raise ValueError("empirical coordinate corrections are not admissible alignment evidence")
    native_crs = evidence.get("nativeCrs")
    if not isinstance(native_crs, str) or not native_crs.startswith("EPSG:") or not native_crs[5:].isdigit():
        raise ValueError("native CRS must be a published EPSG code")
    metadata, metadata_sha = verified_json(root, evidence.get("metadataFile"), evidence.get("metadataSha256"))
    if int(native_crs[5:]) not in reference_codes(metadata):
        raise ValueError("native CRS differs from published metadata")
    metadata_url = evidence.get("metadataUrl")
    if not isinstance(metadata_url, str) or not metadata_url.startswith("https://"):
        raise ValueError("first-party CRS metadata URL is required")
    axis_order = evidence.get("nativeAxisOrder")
    if axis_order not in {"east-north", "north-east"}:
        raise ValueError("native wire axis order must be explicit")
    native, native_sha = verified_json(root, evidence.get("nativeFile"), evidence.get("nativeSha256"))
    if native.get("type") not in {"FeatureCollection", "NativeParcelSamples"} or not isinstance(native.get("features"), list) or not native["features"]:
        raise ValueError("native parcel sample is missing")
    if len(native["features"]) > 5:
        raise ValueError("alignment retains at most five full native polygons")
    cache_bytes = cache_path.read_bytes()
    cache = json.loads(cache_bytes)
    if cache.get("type") != "FeatureCollection" or not isinstance(cache.get("features"), list):
        raise ValueError("adapter output cache is not a FeatureCollection")
    by_id = {feature_id(feature): feature for feature in cache["features"]}
    if len(by_id) != len(cache["features"]):
        raise ValueError("adapter output repeats a parcel ID")
    source = CRS.from_user_input(native_crs)
    grid_sha = None
    if native_crs == "EPSG:27700":
        grid_dir = Path(__file__).resolve().parents[1] / "backend/parcels/grids/ostn15"
        grid = grid_dir / "OSTN15_NTv2_OSGBtoETRS.gsb"
        grid_sha = digest(grid.read_bytes())
        if grid_sha != "bcb9c6b3b2760e2740fd80e2182fd2eec4e79038165bac703a9415ed1813dee2":
            raise ValueError("official OSTN15 grid integrity check failed")
        datadir.append_data_dir(str(grid_dir))
    group = TransformerGroup(source, CRS.from_epsg(4326), always_xy=True, allow_ballpark=False)
    if not group.best_available or not group.transformers:
        raise ValueError("best published coordinate operation requires an unavailable grid or has no non-ballpark transform")
    transform = group.transformers[0]
    pairs = []
    seen: set[str] = set()
    for feature in native["features"]:
        parcel_id = feature_id(feature)
        if parcel_id in seen or parcel_id not in by_id:
            raise ValueError("native sample ID is duplicated or missing from actual adapter output")
        seen.add(parcel_id)
        raw_points = points(feature.get("geometry"))
        expected = []
        for first, second in raw_points:
            x, y = (first, second) if axis_order == "east-north" else (second, first)
            lon, lat = transform.transform(x, y, errcheck=True)
            if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
                raise ValueError("published native CRS produced invalid WGS84 coordinates")
            expected.append((lon, lat))
        actual = points(by_id[parcel_id].get("geometry"))
        if any(not -180 <= lon <= 180 or not -90 <= lat <= 90 for lon, lat in actual):
            raise ValueError("adapter output is not longitude/latitude WGS84")
        # Ring orientation, closure and multipart ordering are serialization details. Test every
        # vertex in both directions so a dropped point or a shifted/changed shape cannot pass.
        def maximum_nearest(a: list, b: list) -> float:
            return max(min(abs(GEOD.inv(*p, *q)[2]) for q in b) for p in a)
        delta = max(maximum_nearest(expected, actual), maximum_nearest(actual, expected))
        boundary_delta = boundary_difference(feature["geometry"], by_id[parcel_id]["geometry"], transform, axis_order, actual)
        pairs.append({"parcelId": parcel_id, "nativeVertexCount": len(raw_points),
                      "adapterVertexCount": len(actual), "maxVertexDifferenceM": delta,
                      "maxBoundaryDifferenceM": boundary_delta})
    maximum = max(pair["maxVertexDifferenceM"] for pair in pairs)
    maximum_boundary = max(pair["maxBoundaryDifferenceM"] for pair in pairs)
    operation_choice_unresolved = (maximum_boundary > TOLERANCE_M and transform.accuracy > TOLERANCE_M)
    return {"schemaVersion": 1, "passed": maximum_boundary <= TOLERANCE_M,
            "sourceId": source_id, "cityCode": city_code, "contractSha256": contract_sha256,
            "evidenceSha256": digest(evidence_bytes), "metadataSha256": metadata_sha,
            "nativeSha256": native_sha, "cacheSha256": digest(cache_bytes),
            "nativeCrs": native_crs, "nativeAxisOrder": axis_order, "outputCrs": "EPSG:4326",
            "coordinateOperation": transform.description, "operationPipeline": transform.definition,
            "operationAccuracyM": transform.accuracy if transform.accuracy >= 0 else None,
            "bestOperationAvailable": True, "ballparkAllowed": False, "toleranceM": TOLERANCE_M,
            "maxVertexDifferenceM": maximum, "featureCount": len(pairs), "samples": pairs,
            "maxBoundaryDifferenceM": maximum_boundary,
            "boundaryComparison": "Bidirectional boundary Hausdorff distance in a local WGS84 azimuthal equidistant frame; no clipping, simplification, repair or fitted displacement.",
            "operationChoiceUnresolved": operation_choice_unresolved,
            **({"reason": "Provider output does not reproduce the selected PROJ operation, whose published geodetic accuracy exceeds the check tolerance. The publisher's operation and reference-frame realization must be established before inferring a defect or correction."}
               if operation_choice_unresolved else {}),
            **({"gridSha256": grid_sha} if grid_sha else {}),
            "sourceGeometryChanged": False, "fittedOffsetApplied": False,
            "sourceGeoreferencing": "unverified",
            "limitations": ["CRS handling is checked independently; source survey accuracy and basemap accuracy are not established.",
                            "WGS84 is an ensemble: no observation epoch is inferred from an EPSG code."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("cache", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--city-code", required=True)
    parser.add_argument("--contract-sha256", required=True)
    args = parser.parse_args()
    try:
        result = check_alignment(args.evidence, args.cache, source_id=args.source_id,
                                 city_code=args.city_code, contract_sha256=args.contract_sha256)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as error:
        result = {"schemaVersion": 1, "passed": False, "reason": str(error),
                  "sourceGeometryChanged": False, "fittedOffsetApplied": False,
                  "sourceGeoreferencing": "unverified"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"passed": result["passed"], "reason": result.get("reason"),
                      "maxVertexDifferenceM": result.get("maxVertexDifferenceM")}))
    raise SystemExit(0 if result["passed"] else 2)


if __name__ == "__main__":
    main()
