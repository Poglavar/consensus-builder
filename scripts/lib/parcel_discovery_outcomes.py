"""Discovery decisions and the evidence needed before spending time on an adapter.

A rejected search means no actionable source was found in the recorded search. It
does not assert that the city has no cadastre. Access failures remain separate.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

DECISIONS = {"candidate", "blocked", "rejected", "already-supported"}
REVIEWED_STATUSES = {"reviewed", "reviewed-held", *("reviewed-" + value for value in DECISIONS)}
SEARCH_LEVELS = {"municipal", "regional", "national", "web"}


def https_url(value):
    return isinstance(value, str) and urlparse(value).scheme in {"https", "http"} and bool(urlparse(value).netloc)


def evidence_urls(value):
    return isinstance(value, list) and bool(value) and all(https_url(url) for url in value)


def evidence_file(root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        raise ValueError("discovery evidence paths must be repository relative")
    target = (root / path).resolve()
    target.relative_to(root.resolve())
    if not target.is_file():
        raise ValueError("discovery evidence file is missing")
    return target


def validate_receipt(root: Path, receipt: dict) -> list[str]:
    """Validate the handoff contract, without guessing a verdict from prose/keywords."""
    errors = []
    decision = receipt.get("decision")
    if receipt.get("schemaVersion") != 2 or decision not in DECISIONS:
        return ["a version 2 discovery decision is required"]
    if not str(receipt.get("reason", "")).strip():
        errors.append("a substantive discovery reason is required")
    searches = receipt.get("searchCoverage")
    if not isinstance(searches, dict) or set(searches) != SEARCH_LEVELS:
        errors.append("municipal, regional, national and web search coverage must be recorded")
    else:
        for level, row in searches.items():
            if not isinstance(row, dict) or row.get("status") not in {"checked", "not-applicable"} or not str(row.get("reason", "")).strip():
                errors.append(f"{level} search assessment is incomplete")
            elif row["status"] == "checked" and not (isinstance(row.get("evidenceUrls"), list) and any(https_url(u) for u in row["evidenceUrls"])):
                errors.append(f"{level} search requires actual evidence URLs")
            elif row["status"] == "not-applicable" and level != "regional":
                errors.append(f"{level} search cannot be omitted")
    source = receipt.get("source")
    if decision in {"candidate", "blocked", "already-supported"}:
        if not isinstance(source, dict) or not https_url(source.get("endpoint")) or not str(source.get("sourceId", "")).strip():
            errors.append("a concrete source ID and endpoint are required")
    if decision == "rejected":
        if not str(receipt.get("rejectionReason", "")).strip():
            errors.append("a rejected search needs its specific rejection reason")
        if receipt.get("nextAction") not in (None, ""):
            errors.append("rejected searches must not silently remain in the qualification queue")
    if decision == "blocked":
        if not str(receipt.get("blocker", "")).strip() or not str(receipt.get("nextAction", "")).strip():
            errors.append("blocked sources need a specific blocker and a concrete retry action")
    if decision == "already-supported" and not (isinstance(receipt.get("appCityIds"), list) and receipt["appCityIds"] and all(isinstance(value, str) and value for value in receipt["appCityIds"])):
        errors.append("already-supported requires existing app city bindings")
    if decision == "candidate":
        if not isinstance(source, dict) or source.get("purpose") != "cadastral-parcels" or not evidence_urls(source.get("purposeEvidenceUrls")):
            errors.append("candidate requires evidenced cadastral parcel semantics")
        if not str(receipt.get("nextAction", "")).strip():
            errors.append("candidate requires a concrete adapter/qualification action")
        coverage = receipt.get("coverage")
        if not isinstance(coverage, dict):
            errors.append("candidate requires coverage evidence")
        else:
            if coverage.get("scope") not in {"citywide", "substantial-city"} or not str(coverage.get("basis", "")).strip() or not evidence_urls(coverage.get("evidenceUrls")):
                errors.append("candidate must establish a systematic city parcel dataset, not isolated offerings")
            probes = coverage.get("probes")
            if not isinstance(probes, list) or not 3 <= len(probes) <= 20:
                errors.append("candidate requires three to twenty distributed city probes")
            else:
                boxes, positives, identities = [], [], set()
                for probe in probes:
                    if not isinstance(probe, dict):
                        errors.append("coverage probe must be an object")
                        continue
                    box = probe.get("bbox")
                    if (not isinstance(box, list) or len(box) != 4 or
                            not all(isinstance(n, (float, int)) and not isinstance(n, bool) and math.isfinite(n) for n in box) or
                            not (-180 <= box[0] < box[2] <= 180 and -90 <= box[1] < box[3] <= 90)):
                        errors.append("coverage probe requires a valid WGS84 bbox")
                        continue
                    boxes.append(box)
                    count = probe.get("featureCount")
                    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                        errors.append("coverage probe requires an observed feature count")
                    elif count > 0:
                        ids = probe.get("sampleIds")
                        if (probe.get("geometryType") not in {"Polygon", "MultiPolygon"} or not isinstance(ids, list) or not ids
                                or not all(type(value) in (str, int) and str(value).strip() for value in ids)):
                            errors.append("positive probes need parcel polygons and safe sample IDs")
                        else:
                            positives.append(box)
                            identities.update(str(i) for i in probe["sampleIds"])
                    try:
                        path = evidence_file(root, probe.get("evidenceFile", ""))
                        if probe.get("evidenceFile") not in receipt.get("evidenceFiles", []):
                            errors.append("coverage probe must be included in receipt evidenceFiles")
                        if hashlib.sha256(path.read_bytes()).hexdigest() != probe.get("evidenceSha256"):
                            errors.append("coverage probe evidence hash differs")
                    except (OSError, ValueError, TypeError):
                        errors.append("coverage probe evidence is missing or unsafe")
                # Adjacent micro-cells around one parcel are not evidence across a city.
                separate = lambda a, b: a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1]
                if len(boxes) != len(probes) or not any(all(separate(a, b) for a, b in ((boxes[i], boxes[j]), (boxes[i], boxes[k]), (boxes[j], boxes[k]))) for i in range(len(boxes)) for j in range(i + 1, len(boxes)) for k in range(j + 1, len(boxes))):
                    errors.append("coverage needs three distinct non-overlapping probe areas")
                if len(positives) < 2 or len(identities) < 4:
                    errors.append("coverage needs multiple parcels in at least two city areas")
                if coverage.get("distributedAcrossCity") is not True or not str(coverage.get("distributionBasis", "")).strip():
                    errors.append("coverage must explain how probes span the actual city")
    return errors


def counts(state: dict) -> dict:
    cities = list(state.get("cities", {}).values())
    disposition = Counter(row.get("discoveryDecision", "unclassified") for row in cities
                          if row.get("status") in REVIEWED_STATUSES)
    stages = Counter(row.get("qualification", {}).get("status", "pending") for row in cities
                     if row.get("discoveryDecision") == "candidate")
    return {"reviewed": sum(disposition.values()),
            "candidate": disposition["candidate"], "blocked": disposition["blocked"],
            "rejected": disposition["rejected"], "alreadySupported": disposition["already-supported"],
            "unclassified": disposition["unclassified"], "qualification": dict(stages),
            "pendingResearch": sum(row.get("status") == "pending" for row in cities),
            "researchRunning": sum(row.get("status") == "running" for row in cities),
            "failed": sum(row.get("status") == "failed-skipped" for row in cities)}
