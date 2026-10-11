#!/usr/bin/env python3
"""Independent, non-mutating metric/topology audit for safe parcel GeoJSON."""

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from pyproj import CRS, Transformer
from shapely.geometry import shape
from shapely.ops import transform as transform_geometry
from shapely.strtree import STRtree
from shapely.validation import explain_validity

OVERLAP_THRESHOLD_M2 = 0.01


def _crs_name(value: Any) -> str:
    if isinstance(value, dict):
        properties = value.get("properties") or {}
        value = properties.get("name") or properties.get("href")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("An explicit source CRS is required (--source-crs).")
    return value.strip()


def _is_wgs84(crs: CRS) -> bool:
    return crs.to_epsg() == 4326 or crs.name.upper() in {"WGS 84", "WGS 84 (CRS84)"}


def _validate_metric_crs(value: int) -> CRS:
    if value not in range(32601, 32661) and value not in range(32701, 32761):
        raise ValueError("Metric EPSG must be a UTM zone CRS (32601–32660 or 32701–32760).")
    crs = CRS.from_epsg(value)
    if not crs.is_projected or not crs.axis_info or any(axis.unit_name.lower() not in {"metre", "meter"} for axis in crs.axis_info[:2]):
        raise ValueError("Metric EPSG must use projected metre axes.")
    return crs


def _identifier(feature: dict[str, Any], index: int) -> str:
    properties = feature.get("properties") or {}
    value = properties.get("sourceParcelId")
    if value is None:
        value = feature.get("id", properties.get("id"))
    if value is None or isinstance(value, (dict, list)):
        return f"<missing:{index}>"
    return str(value)


def _coordinate_errors(geometry: Any, source_is_wgs84: bool) -> list[str]:
    errors: list[str] = []
    try:
        coords = geometry.coords
        coordinate_sets = [coords]
    except (AttributeError, NotImplementedError):
        coordinate_sets = []
        if geometry.geom_type == "Polygon":
            coordinate_sets = [geometry.exterior.coords, *(ring.coords for ring in geometry.interiors)]
        elif geometry.geom_type == "MultiPolygon":
            coordinate_sets = [coords for polygon in geometry.geoms
                               for coords in [polygon.exterior.coords, *(ring.coords for ring in polygon.interiors)]]
        elif hasattr(geometry, "geoms"):
            coordinate_sets = [part.coords for part in geometry.geoms if hasattr(part, "coords")]
    for sequence in coordinate_sets:
        for coordinate in sequence:
            if len(coordinate) != 2:
                errors.append("coordinates must be two-dimensional")
                return list(dict.fromkeys(errors))
            if not all(math.isfinite(float(value)) for value in coordinate):
                errors.append("coordinates must be finite")
                return list(dict.fromkeys(errors))
            if source_is_wgs84 and (abs(coordinate[0]) > 180 or abs(coordinate[1]) > 90):
                errors.append("coordinate is outside WGS84 longitude/latitude bounds")
                return list(dict.fromkeys(errors))
    return list(dict.fromkeys(errors))


def _metric_transformer(source_crs: CRS, metric_crs: CRS) -> Transformer | None:
    if source_crs == metric_crs:
        return None
    return Transformer.from_crs(source_crs, metric_crs, always_xy=True)


def _bounds_metrics(geometry: Any) -> dict[str, float | None]:
    min_x, min_y, max_x, max_y = geometry.bounds
    width = max_x - min_x
    height = max_y - min_y
    aspect = max(width, height) / min(width, height) if min(width, height) > 0 else None
    return {
        "minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y,
        "widthM": width, "heightM": height, "aspectRatio": aspect,
    }


def audit_collection(data: dict[str, Any], *, source_crs: str, metric_epsg: int,
                     overlap_threshold_m2: float = OVERLAP_THRESHOLD_M2,
                     input_sha256: str | None = None) -> dict[str, Any]:
    """Return a geometry-free report. Input source CRS must be explicit at call time."""
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ValueError("Input must be a GeoJSON FeatureCollection with a features array.")
    if not math.isfinite(overlap_threshold_m2) or overlap_threshold_m2 < 0:
        raise ValueError("Overlap threshold must be a finite non-negative area in square metres.")

    source_text = _crs_name(source_crs)
    try:
        source = CRS.from_user_input(source_text)
    except Exception as exc:
        raise ValueError(f"Unsupported explicit source CRS: {source_text}") from exc
    metric = _validate_metric_crs(int(metric_epsg))
    source_is_wgs84 = _is_wgs84(source)
    if not source_is_wgs84 and source != metric:
        raise ValueError("Source CRS must be explicit WGS84 or the selected metric EPSG used for projected fixtures.")

    embedded = data.get("crs")
    if embedded is None and isinstance(data.get("metadata"), dict):
        embedded = data["metadata"].get("sourceCrs")
    if embedded is not None:
        try:
            embedded_crs = CRS.from_user_input(_crs_name(embedded))
        except Exception as exc:
            raise ValueError("Embedded GeoJSON CRS is invalid.") from exc
        if embedded_crs != source:
            raise ValueError("Declared --source-crs does not match the input GeoJSON CRS.")

    transformer = _metric_transformer(source, metric)
    identifiers: list[str] = []
    geometries: list[Any | None] = []
    invalid: list[dict[str, Any]] = []
    per_feature: list[dict[str, Any]] = []
    for index, feature in enumerate(data["features"]):
        identifier = _identifier(feature if isinstance(feature, dict) else {}, index)
        identifiers.append(identifier)
        issues: list[str] = []
        if identifier.startswith("<missing:"):
            issues.append("native parcel ID is missing")
        source_geometry = None
        metric_geometry = None
        if not isinstance(feature, dict) or feature.get("type") != "Feature" or not isinstance(feature.get("geometry"), dict):
            issues.append("feature or geometry is missing/malformed")
        else:
            try:
                raw = feature["geometry"]
                polygons = [raw.get("coordinates")] if raw.get("type") == "Polygon" else raw.get("coordinates", [])
                for polygon in polygons:
                    if not isinstance(polygon, list) or not polygon:
                        issues.append("polygon has no rings")
                        continue
                    for ring in polygon:
                        if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                            issues.append("source polygon ring is unclosed or has fewer than four coordinates")
                source_geometry = shape(raw)
                if source_geometry.geom_type not in {"Polygon", "MultiPolygon"}:
                    issues.append(f"unsupported geometry type: {source_geometry.geom_type}")
                issues.extend(_coordinate_errors(source_geometry, source_is_wgs84))
                if source_geometry.is_empty:
                    issues.append("geometry is empty")
                if not source_geometry.is_valid:
                    issues.append(explain_validity(source_geometry))
                if not issues:
                    metric_geometry = transform_geometry(transformer.transform, source_geometry) if transformer else source_geometry
                    if metric_geometry.is_empty or not metric_geometry.is_valid:
                        issues.append("geometry became invalid during CRS transformation")
            except Exception as exc:
                issues.append(f"geometry parse/transform failed: {type(exc).__name__}: {exc}")

        if issues:
            invalid.append({"id": identifier, "reasons": list(dict.fromkeys(issues))})
            geometries.append(None)
            per_feature.append({"id": identifier, "geometrySha256": None, "boundsMetric": None,
                                "areaM2": None, "invalidReasons": list(dict.fromkeys(issues))})
            continue

        raw_geometry = feature["geometry"]
        digest = hashlib.sha256(json.dumps(raw_geometry, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                            allow_nan=False).encode("utf-8")).hexdigest()
        geometries.append(metric_geometry)
        per_feature.append({"id": identifier, "geometrySha256": digest,
                            "boundsMetric": _bounds_metrics(metric_geometry), "areaM2": metric_geometry.area,
                            "invalidReasons": []})

    occurrences: dict[str, list[int]] = {}
    for index, identifier in enumerate(identifiers):
        occurrences.setdefault(identifier, []).append(index)
    duplicate_ids: list[dict[str, Any]] = []
    conflicting_same_id: list[dict[str, Any]] = []
    exact_geometry_duplicates: list[dict[str, Any]] = []
    overlaps: list[dict[str, Any]] = []
    subthreshold: list[dict[str, Any]] = []
    operation_errors: list[dict[str, Any]] = []

    for identifier, indexes in occurrences.items():
        if len(indexes) < 2:
            continue
        duplicate_ids.append({"id": identifier, "featureIndexes": indexes})
        for offset, i in enumerate(indexes):
            for j in indexes[offset + 1:]:
                left, right = geometries[i], geometries[j]
                if left is None or right is None:
                    conflicting_same_id.append({"id": identifier, "featureIndexes": [i, j], "reason": "one or both geometries invalid"})
                    continue
                try:
                    if not left.equals(right):
                        conflicting_same_id.append({"id": identifier, "featureIndexes": [i, j], "reason": "same native ID has different geometry"})
                except Exception as exc:
                    operation_errors.append({"ids": [identifier, identifier], "featureIndexes": [i, j],
                                             "operation": "same-ID geometry equality", "error": f"{type(exc).__name__}: {exc}"})

    valid_indexes = [index for index, geometry in enumerate(geometries) if geometry is not None]
    valid_geometries = [geometries[index] for index in valid_indexes]
    if valid_geometries:
        tree = STRtree(valid_geometries)
        for local_i, left in enumerate(valid_geometries):
            for local_j_raw in tree.query(left):
                local_j = int(local_j_raw)
                if local_j <= local_i:
                    continue
                i, j = valid_indexes[local_i], valid_indexes[local_j]
                id_left, id_right = identifiers[i], identifiers[j]
                try:
                    if id_left != id_right and left.equals(valid_geometries[local_j]):
                        exact_geometry_duplicates.append({"ids": [id_left, id_right], "featureIndexes": [i, j], "areaM2": left.area})
                    intersection_area = left.intersection(valid_geometries[local_j]).area
                    if intersection_area > overlap_threshold_m2:
                        smaller = min(left.area, valid_geometries[local_j].area)
                        overlaps.append({"ids": [id_left, id_right], "featureIndexes": [i, j],
                                         "areaM2": intersection_area,
                                         "fractionOfSmaller": intersection_area / smaller if smaller > 0 else None})
                    elif intersection_area > 0:
                        subthreshold.append({"ids": [id_left, id_right], "featureIndexes": [i, j], "areaM2": intersection_area})
                except Exception as exc:
                    operation_errors.append({"ids": [id_left, id_right], "featureIndexes": [i, j],
                                             "operation": "topological equality/intersection", "error": f"{type(exc).__name__}: {exc}"})

    overlaps.sort(key=lambda row: (-row["areaM2"], row["ids"]))
    subthreshold.sort(key=lambda row: (-row["areaM2"], row["ids"]))
    pass_geometry = bool(identifiers) and not any((invalid, duplicate_ids, conflicting_same_id, exact_geometry_duplicates, overlaps, operation_errors))
    return {
        "schemaVersion": 1,
        "inputSha256": input_sha256,
        "sourceCrs": source.to_string(),
        "metricCrs": metric.to_string(),
        "method": "Shapely/GEOS validity, equality and STRtree candidate-pair intersections after pyproj transform; source geometry is never repaired, clipped or unioned.",
        "featureCount": len(identifiers),
        "validFeatureCount": len(valid_indexes),
        "perFeature": per_feature,
        "invalidCount": len(invalid),
        "invalid": invalid,
        "duplicateIdCount": len(duplicate_ids),
        "duplicateIds": duplicate_ids,
        "conflictingSameIdGeometryCount": len(conflicting_same_id),
        "conflictingSameIdGeometry": conflicting_same_id,
        "exactGeometryDuplicateCount": len(exact_geometry_duplicates),
        "exactGeometryDuplicates": exact_geometry_duplicates,
        "overlapThresholdM2": overlap_threshold_m2,
        "overlapPairCount": len(overlaps),
        "totalMaterialOverlapM2": sum(row["areaM2"] for row in overlaps),
        "maxMaterialOverlapM2": max((row["areaM2"] for row in overlaps), default=0.0),
        "maxOverlapFractionOfSmaller": max((row["fractionOfSmaller"] or 0.0 for row in overlaps), default=0.0),
        "overlaps": overlaps,
        "subthresholdPositiveIntersectionPairCount": len(subthreshold),
        "subthresholdPositiveIntersectionTotalM2": sum(row["areaM2"] for row in subthreshold),
        "subthresholdPositiveIntersections": subthreshold,
        "operationErrorCount": len(operation_errors),
        "operationErrors": operation_errors,
        "geometryChangedOrRepaired": False,
        "geometryPass": pass_geometry,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Full-safe GeoJSON FeatureCollection; kept unchanged")
    parser.add_argument("output", help="Geometry-free JSON report path")
    parser.add_argument("--source-crs", required=True, help="Explicit source CRS: EPSG:4326 (or WGS84), or the chosen metric EPSG for projected test fixtures")
    parser.add_argument("--metric-epsg", required=True, type=int, help="Caller-selected UTM EPSG, e.g. 32630 or 32721")
    parser.add_argument("--overlap-threshold-m2", type=float, default=OVERLAP_THRESHOLD_M2)
    args = parser.parse_args()

    raw = Path(args.input).read_bytes()
    data = json.loads(raw)
    report = audit_collection(data, source_crs=args.source_crs, metric_epsg=args.metric_epsg,
                              overlap_threshold_m2=args.overlap_threshold_m2,
                              input_sha256=hashlib.sha256(raw).hexdigest())
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    summary = {key: value for key, value in report.items()
               if key not in {"perFeature", "invalid", "duplicateIds", "conflictingSameIdGeometry",
                              "exactGeometryDuplicates", "overlaps", "subthresholdPositiveIntersections", "operationErrors"}}
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
