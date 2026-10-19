#!/usr/bin/env python3
"""Build a candidate-only HMLR city seed from a sealed release and full WUP 2025."""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

MIN_AUTHORITY_COUNT = 250
MAX_AUTHORITY_COUNT = 500
SOURCE_ID = "gb-hmlr-browser-v1"
ID_PREFIX = "GB-HMLR-BROWSER-v1-"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_manifest(manifest: dict, authority_count: int) -> None:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2:
        raise ValueError("HMLR release manifest schema is invalid")
    authorities = manifest.get("authorities")
    if (not isinstance(authorities, list)
            or (authority_count is None and not MIN_AUTHORITY_COUNT <= len(authorities) <= MAX_AUTHORITY_COUNT)
            or (authority_count is not None and len(authorities) != authority_count)):
        raise ValueError("expected a complete HMLR release with the pinned authority count")
    if not isinstance(manifest.get("sourceDate"), str) or not manifest["sourceDate"]:
        raise ValueError("HMLR release publication date is missing")
    if not isinstance(manifest.get("releaseId"), str) or len(manifest["releaseId"]) != 64:
        raise ValueError("HMLR immutable release ID is invalid")
    core_authorities = []
    for authority in authorities:
        bounds = authority.get("bounds") if isinstance(authority, dict) else None
        if (not isinstance(bounds, list) or len(bounds) != 4
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in bounds)
                or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]
                or not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90)):
            raise ValueError("HMLR authority contains invalid WGS84 screening bounds")
        scope = authority.get("scope")
        if (not isinstance(scope, dict) or not isinstance(scope.get("sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", scope["sha256"])
                or type(scope.get("bytes")) is not int or not 0 < scope["bytes"] <= 16 * 1024 * 1024):
            raise ValueError("HMLR authority contains malformed land-scope metadata")
        try:
            core_authority = {key: authority[key] for key in (
                "name", "endpoint", "etag", "bytes", "archiveSha256", "featureCount", "nativeBounds", "bounds")}
        except KeyError as error:
            raise ValueError("HMLR authority metadata is incomplete") from error
        core_authority["scope"] = {"sha256": scope["sha256"], "bytes": scope["bytes"]}
        core_authorities.append(core_authority)
    # Recreate the builder's release core. URLs are added to scopes and idDirectory only after its
    # content hash is calculated, so they are omitted here by design.
    directory = manifest.get("idDirectory")
    if not isinstance(directory, dict) or not directory:
        raise ValueError("HMLR release has no native-ID directory")
    core_directory = {}
    for bucket, item in directory.items():
        if not isinstance(item, dict) or not isinstance(item.get("sha256"), str) or not isinstance(item.get("bytes"), int):
            raise ValueError("HMLR release contains malformed ID-directory metadata")
        core_directory[bucket] = {"sha256": item["sha256"], "bytes": item["bytes"]}
    core = {"schemaVersion": 2, "sourceDate": manifest["sourceDate"], "policy": manifest["policy"],
            "authorities": core_authorities, "idDirectory": core_directory}
    release_id = hashlib.sha256(json.dumps(core, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if release_id != manifest["releaseId"]:
        raise ValueError("HMLR release ID does not match its immutable metadata core")


def read_wup_gb(source: Path) -> list[dict]:
    rows = []
    seen = set()
    with gzip.open(source, "rt", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            if row.get("Year") != "2025" or row.get("ISO2_Code", "").strip().upper() != "GB":
                continue
            try:
                code = str(int(row["City_Code"]))
                population = float(row["Pop"])
                latitude = float(row["PWCent_Latitude"])
                longitude = float(row["PWCent_Longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if (not code.isdigit() or int(code) <= 0 or code in seen or not row.get("City_Name", "").strip()
                    or not math.isfinite(population) or population <= 0
                    or not math.isfinite(latitude) or not -90 <= latitude <= 90
                    or not math.isfinite(longitude) or not -180 <= longitude <= 180):
                raise ValueError("WUP 2025 GB city identity, population, or point is invalid or duplicated")
            seen.add(code)
            rows.append({"cityCode": code, "name": row["City_Name"].strip(), "country": row.get("Location", "").strip(),
                         "iso2": "GB", "point": [latitude, longitude], "pop2025k": population})
    rows.sort(key=lambda city: (-city["pop2025k"], int(city["cityCode"])))
    for rank, city in enumerate(rows, 1):
        city["rank"] = rank
    return rows


def build_seed(manifest: dict, manifest_sha256: str, wup_source: Path,
               manifest_base_url: str, manifest_evidence_path: str,
               authority_count: int | None = None) -> dict:
    base = urlsplit(manifest_base_url)
    if (base.scheme != "https" or not base.netloc or base.username or base.password or base.query or base.fragment):
        raise ValueError("manifest base URL must be explicit HTTPS without credentials, query, or fragment")
    base_url = manifest_base_url.rstrip("/")
    if not manifest_evidence_path or Path(manifest_evidence_path).is_absolute() or ".." in Path(manifest_evidence_path).parts:
        raise ValueError("manifest evidence path must be repository-relative")
    verify_manifest(manifest, authority_count)
    authorities = manifest["authorities"]
    wup_rows = read_wup_gb(wup_source)
    candidate_rows = []
    outside_rows = []
    for city in wup_rows:
        latitude, longitude = city["point"]
        included = any(bounds[0] <= longitude <= bounds[2] and bounds[1] <= latitude <= bounds[3]
                       for bounds in (authority["bounds"] for authority in authorities))
        (candidate_rows if included else outside_rows).append(city)

    release_id = manifest["releaseId"]
    descriptor = {
        "id": SOURCE_ID,
        "name": "HM Land Registry — England and Wales browser ground",
        "adapter": "hmlr-browser",
        "endpoint": "https://use-land-property-data.service.gov.uk/datasets/inspire/download",
        "idPrefix": ID_PREFIX,
        "idField": "INSPIREID",
        "outFields": ["INSPIREID"],
        "parcelNumberField": "INSPIREID",
        "idType": "string",
        "countryCode": "GB",
        "metricSrid": 27700,
        "cityIds": [],
        "defaultForCity": False,
        "maxFeatures": 5000,
        "maxBboxKm2": 25,
        "geometryKind": "derived-ground",
        "normalizationPolicy": manifest["policy"],
        "scope": "England and Wales registered freehold title-index coverage; deterministic derived ground, not legal title boundaries.",
        "manifestUrl": f"{base_url}/{release_id}/manifest.json",
        "snapshotId": release_id,
    }
    return {
        "schemaVersion": 1,
        "candidateOnly": True,
        "candidateBasis": "WUP 2025 population-weighted city centre falls within at least one sealed HMLR authority WGS84 metadata bound; bounds are screening metadata only, not membership proof or coverage evidence.",
        "sources": {
            "hmlrManifest": {"releaseId": release_id, "sourceDate": manifest["sourceDate"],
                              "manifestSha256": manifest_sha256, "authorityCount": len(authorities),
                              "manifestUrl": descriptor["manifestUrl"]},
            "wup": {"dataset": "UN World Urbanization Prospects 2025 Degree of Urbanization city population surface data",
                    "year": 2025, "sha256": sha256_file(wup_source), "rowsGB": len(wup_rows)},
            "scope": {"intendedCoverage": "England and Wales only", "officialProviderGuidance": "HM Land Registry INSPIRE Index Polygons cover England and Wales; see https://www.gov.uk/guidance/inspire-index-polygons-spatial-data"},
        },
        "scopeAudit": {"gbWupCities2025": len(wup_rows), "authorityBoundCandidates": len(candidate_rows),
                       "outsideAllAuthorityBounds": len(outside_rows),
                       "outsideBoundsWupCityCodes": [city["cityCode"] for city in outside_rows]},
        "providers": [{"descriptor": descriptor, "candidateCityCodes": [city["cityCode"] for city in candidate_rows],
                       "boundCityCodes": [], "candidateOnly": True,
                       "scopeEvidence": ["HM Land Registry INSPIRE Index Polygons guidance states coverage is England and Wales: https://www.gov.uk/guidance/inspire-index-polygons-spatial-data",
                                         "The immutable authority metadata bounds are used only to narrow candidate probes; they do not establish parcel coverage."],
                       "evidenceFiles": [{"path": manifest_evidence_path, "sha256": manifest_sha256}]}],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--wup", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--expected-authority-count", type=int)
    parser.add_argument("--manifest-base-url", required=True)
    parser.add_argument("--manifest-evidence-path", required=True)
    args = parser.parse_args()
    actual_sha = sha256_file(args.manifest)
    if actual_sha != args.expected_manifest_sha256:
        raise SystemExit(f"HMLR manifest SHA-256 mismatch: {actual_sha}")
    manifest = json.loads(args.manifest.read_text())
    result = build_seed(manifest, actual_sha, args.wup, args.manifest_base_url,
                        args.manifest_evidence_path, args.expected_authority_count)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"candidateCount": len(result["providers"][0]["candidateCityCodes"]),
                      "scopeAudit": result["scopeAudit"], "manifestReleaseId": manifest["releaseId"]}))


if __name__ == "__main__":
    main()
