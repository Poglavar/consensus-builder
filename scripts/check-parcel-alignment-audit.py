#!/usr/bin/env python3
"""Independently check durable bounded parcel-audit samples against published EPSG operations.

This consumes saved audit JSON only. It never contacts providers or edits source geometry.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "parcel-alignment-audit-v1"
CHECKER_PATH = ROOT / "scripts" / "parcel-alignment-check.py"

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()

def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.read_bytes() == data:
        return
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_bytes(data)
    temp.replace(path)

def safe_json(root: Path, relative: str) -> tuple[Path, bytes, dict[str, Any]]:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError("audit evidence path must be relative")
    path = (root / relative).resolve()
    path.relative_to(root.resolve())
    data = path.read_bytes()
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("audit evidence JSON must be an object")
    return path, data, value

def record_path(records_dir: Path, source_id: str, city_id: str) -> Path:
    return records_dir / f"{sha((source_id + chr(10) + city_id).encode())}.json"

def load_checker():
    spec = importlib.util.spec_from_file_location("parcel_alignment_check", CHECKER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load independent parcel alignment checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def held(reason: str, source_id: str, city_id: str, contract: str | None) -> dict[str, Any]:
    return {"schemaVersion": 1, "status": "held", "reason": reason,
            "sourceId": source_id, "cityId": city_id, "contractSha256": contract,
            "sourceGeoreferencing": "unverified", "surveyToImageryAlignment": "unverified",
            "sourceGeometryChanged": False, "fittedOffsetApplied": False}

def evidence_pack(record: dict[str, Any], source_meta: dict[str, Any], source_meta_bytes: bytes) -> dict[str, Any]:
    native_sample = record.get("nativeSample")
    if not isinstance(native_sample, dict) or native_sample.get("status") != "sampled":
        raise ValueError("no safe native EPSG geometry sample was recorded")
    canonical_id = native_sample.get("pairedCanonicalId")
    if not isinstance(canonical_id, str) or not canonical_id or native_sample.get("sameNativeIdInBoundedOutput") is not True:
        raise ValueError("native sample is not paired to the exact ID in bounded adapter output")
    geometry = native_sample.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("type") != "EsriRings" or not isinstance(geometry.get("rings"), list):
        raise ValueError("native sample lacks unchanged Esri rings")
    native_crs = native_sample.get("responseCrs")
    if not isinstance(native_crs, str) or not native_crs.startswith("EPSG:") or not native_crs[5:].isdigit():
        raise ValueError("native sample response CRS is not an EPSG code")
    metadata = source_meta.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("fetched") is not True:
        raise ValueError("source first-party CRS metadata was not fetched")
    actual_url = metadata.get("metadataUrl")
    if not isinstance(actual_url, str) or not actual_url.startswith("https://"):
        raise ValueError("source first-party metadata URL is missing")
    if native_sample.get("metadataUrl") != actual_url:
        raise ValueError("native sample metadata URL does not match the source record")
    actual_meta_sha = sha(source_meta_bytes)
    if native_sample.get("metadataSha256") != actual_meta_sha:
        raise ValueError("native sample metadata hash does not match the source record")
    arcgis = metadata.get("arcgis")
    if not isinstance(arcgis, dict):
        raise ValueError("first-party ArcGIS spatial reference metadata is missing")
    published = {key: arcgis.get(key) for key in ("spatialReference", "sourceSpatialReference") if arcgis.get(key)}
    extent_ref = arcgis.get("extentSpatialReference")
    if extent_ref:
        published["extent"] = {"spatialReference": extent_ref}
    if not published:
        raise ValueError("first-party metadata has no published spatial reference")
    metadata_bytes = json_bytes(published)
    sample = next((item for item in record.get("sample", []) if item.get("id") == canonical_id), None)
    if not isinstance(sample, dict) or not isinstance(sample.get("geometry"), dict):
        raise ValueError("paired canonical polygon is absent from the durable output sample")
    cache = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": canonical_id,
             "properties": {}, "geometry": sample["geometry"]}]}
    native = {"type": "NativeParcelSamples", "features": [{"id": canonical_id,
               "geometry": {"type": "EsriRings", "rings": geometry["rings"]}}]}
    evidence = {"schemaVersion": 1, "sourceId": record["sourceId"], "cityCode": str(record["cityId"]),
        "contractSha256": record["sourceDescriptorHash"], "nativeCrs": native_crs,
        "nativeAxisOrder": "east-north",
        "nativeAxisOrderBasis": "Esri REST JSON geometry wire coordinates are x,y; x is easting/longitude and y is northing/latitude for this EPSG response. No axis order was fit or searched.",
        "metadataFile": "metadata.json", "metadataSha256": sha(metadata_bytes), "metadataUrl": actual_url,
        "nativeFile": "native.json", "nativeSha256": sha(json_bytes(native)),
        "sourceMetadataWrapperFile": source_meta.get("metadataFile"),
        "sourceMetadataWrapperSha256": actual_meta_sha}
    return {"evidence": evidence, "evidenceBytes": json_bytes(evidence),
            "metadataBytes": metadata_bytes, "nativeBytes": json_bytes(native), "cacheBytes": json_bytes(cache),
            "sourceMetadataWrapperFile": source_meta.get("metadataFile"),
            "sourceMetadataWrapperSha256": actual_meta_sha}

def check_one(checker: Any, audit_root: Path, out_root: Path, source: dict[str, Any], city_id: str,
              record_file: Path) -> dict[str, Any]:
    source_id = source["sourceId"]
    contract = source["sourceDescriptorHash"]
    try:
        record_bytes = record_file.read_bytes()
        record = json.loads(record_bytes)
        if (record.get("format") != FORMAT or record.get("sourceId") != source_id
                or record.get("cityId") != city_id or record.get("sourceDescriptorHash") != contract):
            raise ValueError("audit record does not match inventory source, city and descriptor hash")
        if record.get("status") in {"unresolved", "not-selected", "pending"}:
            raise ValueError("audit record has no resolved bounded city sample")
        native_sample = record.get("nativeSample")
        if not isinstance(native_sample, dict) or native_sample.get("status") != "sampled":
            raise ValueError("no safe native EPSG geometry sample was recorded")
        metadata_path, metadata_bytes, source_meta = safe_json(audit_root, native_sample["metadataFile"])
        if metadata_path.relative_to(audit_root).parts != ("sources", sha((source_id + chr(10)).encode()) + ".json"):
            raise ValueError("metadata file is not the source-level first-party metadata record")
        pack_name = sha((source_id + chr(10) + city_id).encode())
        pack_dir = out_root / "packs" / pack_name
        pack = evidence_pack(record, source_meta, metadata_bytes)
        artifacts = {"evidence.json": pack["evidenceBytes"], "metadata.json": pack["metadataBytes"],
                     "native.json": pack["nativeBytes"], "cache.json": pack["cacheBytes"]}
        for name, data in artifacts.items():
            atomic_write(pack_dir / name, data)
        helper_sha = sha(CHECKER_PATH.read_bytes())
        input_sha = sha(json_bytes({"record": sha(record_bytes), "sourceMetadata": sha(metadata_bytes),
            "descriptor": contract, "helper": helper_sha, "artifacts": {k: sha(v) for k, v in artifacts.items()}}))
        report_file = out_root / "reports" / f"{pack_name}.json"
        previous = None
        if report_file.is_file():
            try:
                previous = json.loads(report_file.read_bytes())
            except json.JSONDecodeError:
                previous = None
        if isinstance(previous, dict) and previous.get("inputSha256") == input_sha:
            prior_digest = previous.get("reportSha256")
            unhashed = {key: value for key, value in previous.items() if key != "reportSha256"}
            if prior_digest == sha(json_bytes(unhashed)):
                return previous
        result = checker.check_alignment(pack_dir / "evidence.json", pack_dir / "cache.json",
            source_id=source_id, city_code=str(city_id), contract_sha256=contract)
        measured = result.get("maxBoundaryDifferenceM", result.get("maxVertexDifferenceM"))
        if result.get("passed") is True:
            status = "crs-transform-verified"
        elif result.get("operationChoiceUnresolved") is True:
            status = "held"
        elif isinstance(measured, (int, float)) and measured > result.get("toleranceM", checker.TOLERANCE_M):
            status = "crs-transform-mismatch"
        else:
            status = "held"
        report = {**result, "status": status, "inputSha256": input_sha,
            "sourceMetadataWrapperFile": pack["sourceMetadataWrapperFile"],
            "sourceMetadataWrapperSha256": pack["sourceMetadataWrapperSha256"],
            "sourceGeoreferencing": "unverified", "surveyToImageryAlignment": "unverified",
            "sourceGeometryChanged": False, "fittedOffsetApplied": False}
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, RuntimeError) as error:
        report = held(str(error), source_id, city_id, contract)
    report["reportSha256"] = sha(json_bytes(report))
    report_file = out_root / "reports" / f"{sha((source_id + chr(10) + city_id).encode())}.json"
    atomic_write(report_file, json_bytes(report))
    return report

def safe_output(path: Path) -> Path:
    absolute = path.resolve()
    repo_tmp = (ROOT / "tmp").resolve()
    system_tmp = Path(os.environ.get("TMPDIR", "/tmp")).resolve()
    if not ((absolute == repo_tmp or repo_tmp in absolute.parents)
            or (absolute == system_tmp or system_tmp in absolute.parents)
            or absolute == Path("/tmp") or Path("/tmp") in absolute.parents):
        raise ValueError("output must be under the repository tmp directory or system temporary directory")
    return absolute

def run(audit_dir: Path, output_dir: Path | None = None) -> dict[str, Any]:
    audit_root = audit_dir.resolve()
    inventory = json.loads((audit_root / "inventory.json").read_bytes())
    if inventory.get("format") != FORMAT or not isinstance(inventory.get("sources"), list):
        raise ValueError("input is not a parcel alignment audit inventory")
    out_root = safe_output(output_dir or (audit_root / "independent"))
    if out_root == audit_root or out_root in audit_root.parents:
        raise ValueError("output cannot equal or contain the input audit directory")
    out_root.mkdir(parents=True, exist_ok=True)
    checker = load_checker()
    counts: dict[str, int] = {"crs-transform-verified": 0, "crs-transform-mismatch": 0, "held": 0}
    mismatches = []
    binding_count = 0
    records_dir = audit_root / "records"
    for source in inventory["sources"]:
        if not isinstance(source, dict) or not isinstance(source.get("sourceId"), str):
            continue
        source_id = source["sourceId"]
        contract = source.get("sourceDescriptorHash")
        if not isinstance(contract, str) or len(contract) != 64:
            contract = None
        for city_id in source.get("cityIds", []):
            if not isinstance(city_id, str):
                continue
            binding_count += 1
            result = check_one(checker, audit_root, out_root, {**source, "sourceDescriptorHash": contract}, city_id,
                record_path(records_dir, source_id, city_id))
            status = result.get("status", "held")
            counts[status] = counts.get(status, 0) + 1
            if status == "crs-transform-mismatch":
                mismatches.append({"sourceId": source_id, "cityId": city_id,
                    "maxVertexDifferenceM": result.get("maxVertexDifferenceM"),
                    "maxBoundaryDifferenceM": result.get("maxBoundaryDifferenceM"),
                    "nativeCrs": result.get("nativeCrs"), "coordinateOperation": result.get("coordinateOperation")})
    summary = {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceCount": inventory.get("sourceCount"), "cityCount": inventory.get("cityCount"),
        "bindingCount": binding_count, "statusCounts": counts, "mismatches": mismatches,
        "sourceGeoreferencing": "unverified for every source", "surveyToImageryAlignment": "unverified for every source",
        "sourceGeometryChanged": False, "fittedOffsetApplied": False}
    atomic_write(out_root / "summary.json", json_bytes(summary))
    return summary

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="process saved audit records; never makes network requests")
    parser.add_argument("--audit", type=Path, help="directory containing inventory.json and durable audit records")
    parser.add_argument("--output", type=Path, help="ignored tmp output directory; defaults to AUDIT/independent")
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    if not args.audit:
        parser.error("--run requires --audit")
    summary = run(args.audit, args.output)
    print(json.dumps({"bindingCount": summary["bindingCount"], "statusCounts": summary["statusCounts"],
        "mismatchCount": len(summary["mismatches"]), "sourceGeoreferencing": summary["sourceGeoreferencing"],
        "surveyToImageryAlignment": summary["surveyToImageryAlignment"]}, indent=2))

if __name__ == "__main__":
    main()
