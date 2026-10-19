"""Small, durable evidence store shared by parcel-pipeline stages."""
from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit


SCHEMA_VERSION = 1
STORE_VERSION = 1
_STATUSES = {"verified", "unverified", "pending", "failed", "disputed"}
_STAGES = {"research", "review", "qualification", "adapter", "admission"}
_SENSITIVE_QUERY_KEYS = re.compile(r"(?:^|_)(?:api_?)?key$|token|secret|password|signature|credential", re.I)
_PRIVATE_PATH = re.compile(r"(?:^|[\s'\"])(?:/Users/|/home/|/root/|~/|file://)")
_MAX_RECORD_BYTES = 16_384
_MAX_EVIDENCE_BYTES = 2 * 1024 * 1024
_EVIDENCE_SUFFIXES = {".json", ".geojson", ".txt", ".log"}
_SECRET_EVIDENCE_NAME = re.compile(r"(?:credential|secret|api[-_]?key|service[-_]?account|^\.env)", re.I)


def _base(root: Path) -> Path:
    return Path(root) / "tmp" / "parcel-shared-learning"


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@contextmanager
def _lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _text(value: Any, label: str, *, required: bool = False, max_length: int = 512) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    result = value.strip()
    if len(result) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    if _PRIVATE_PATH.search(result):
        raise ValueError(f"{label} must not contain a private filesystem path")
    return result


def _safe_path(value: Any, label: str) -> str:
    text = _text(value, label, required=True, max_length=2048)
    assert text is not None
    path = Path(text)
    if path.is_absolute() or ".." in path.parts or text.startswith("~"):
        raise ValueError(f"{label} must be repository-relative")
    return path.as_posix()


def _safe_url(value: Any, label: str) -> str:
    text = _text(value, label, required=True, max_length=4096)
    assert text is not None
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError(f"{label} must be a public HTTP(S) URL")
    if any(_SENSITIVE_QUERY_KEYS.search(key) for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
        raise ValueError(f"{label} must not contain credential-like query parameters")
    return text


def _evidence(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value or len(value) > 8:
        raise ValueError("evidenceRefs must contain 1 to 8 items")
    out = []
    for index, raw in enumerate(value):
        if isinstance(raw, str):
            raw = {"url": raw} if raw.startswith(("http://", "https://")) else {"path": raw}
        if not isinstance(raw, dict) or not ({"url", "path"} & raw.keys()):
            raise ValueError(f"evidenceRefs[{index}] requires url or path")
        if set(raw) - {"url", "path", "sha256", "label"}:
            raise ValueError(f"evidenceRefs[{index}] has unsupported fields")
        item: dict[str, str] = {}
        if "url" in raw:
            item["url"] = _safe_url(raw["url"], f"evidenceRefs[{index}].url")
        if "path" in raw:
            item["path"] = _safe_path(raw["path"], f"evidenceRefs[{index}].path")
        if "sha256" in raw:
            digest = _text(raw["sha256"], f"evidenceRefs[{index}].sha256", required=True)
            if not re.fullmatch(r"[0-9a-f]{64}", digest or ""):
                raise ValueError(f"evidenceRefs[{index}].sha256 must be lowercase SHA-256")
            item["sha256"] = digest
        if "label" in raw:
            item["label"] = _text(raw["label"], f"evidenceRefs[{index}].label", required=True,
                                  max_length=200) or ""
        out.append(item)
    return out


def _scope(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - {"cityCode", "cityName", "iso2", "country", "provider", "adapter"}:
        raise ValueError("scope has unsupported fields")
    out = {key: _text(raw, f"scope.{key}", required=True) for key, raw in value.items()}
    if "iso2" in out:
        if not re.fullmatch(r"[A-Za-z]{2}", out["iso2"] or ""):
            raise ValueError("scope.iso2 must be a two-letter country code")
        out["iso2"] = (out["iso2"] or "").upper()
    return {key: val for key, val in out.items() if val is not None}


def _provenance(value: Any, stage: str) -> dict[str, str]:
    allowed = {"taskId", "stage", "cityCode", "receiptSha256", "runId", "evidenceHash"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError("provenance has unsupported fields")
    out = {key: _text(raw, f"provenance.{key}", required=True) for key, raw in value.items()}
    out.setdefault("stage", stage)
    if out["stage"] != stage:
        raise ValueError("provenance.stage must match stage")
    for key in ("receiptSha256", "evidenceHash"):
        if key in out and not re.fullmatch(r"[0-9a-f]{64}", out[key] or ""):
            raise ValueError(f"provenance.{key} must be lowercase SHA-256")
    if not ({"taskId", "receiptSha256", "evidenceHash"} & out.keys()):
        raise ValueError("provenance requires taskId or a durable evidence digest")
    return {key: val for key, val in out.items() if val is not None}


def _fact_scalar(value: Any) -> str | int | float | bool | None:
    if isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        result = value.strip()
        if result and len(result) <= 200 and not _PRIVATE_PATH.search(result):
            return result
    return None


def _facts(value: Any) -> dict[str, str | int | float | bool]:
    allowed = {"protocol", "crs", "format", "pagination", "idField", "geometryType", "maxRecordCount"}
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - allowed or len(value) > 7:
        raise ValueError("facts has unsupported fields")
    out = {}
    for key, raw in value.items():
        scalar = _fact_scalar(raw)
        if scalar is None:
            raise ValueError(f"facts.{key} must be a bounded scalar")
        out[key] = scalar
    return out


def _normalize(record: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    allowed = {"statement", "category", "stage", "verificationStatus", "scope", "provenance",
               "evidenceRefs", "uncertainty", "observedAt", "generalPattern", "supersedes", "facts"}
    if set(record) - allowed:
        raise ValueError("record has unsupported fields")
    stage = _text(record.get("stage"), "stage", required=True)
    status = _text(record.get("verificationStatus"), "verificationStatus", required=True)
    if stage not in _STAGES:
        raise ValueError(f"stage must be one of {sorted(_STAGES)}")
    if status not in _STATUSES:
        raise ValueError(f"verificationStatus must be one of {sorted(_STATUSES)}")
    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "statement": _text(record.get("statement"), "statement", required=True, max_length=2000),
        "category": _text(record.get("category"), "category", required=True),
        "stage": stage,
        "verificationStatus": status,
        "scope": _scope(record.get("scope")),
        "provenance": _provenance(record.get("provenance"), stage),
        "evidenceRefs": _evidence(record.get("evidenceRefs")),
        "generalPattern": bool(record.get("generalPattern", False)),
        "facts": _facts(record.get("facts")),
    }
    for key in ("uncertainty", "observedAt"):
        if key in record:
            result[key] = _text(record[key], key, required=True,
                                max_length=1000 if key == "uncertainty" else 64)
    if "supersedes" in record:
        if (not isinstance(record["supersedes"], list) or len(record["supersedes"]) > 8
                or not all(isinstance(item, str) and re.fullmatch(r"finding-[0-9a-f]{64}", item)
                           for item in record["supersedes"])):
            raise ValueError("supersedes must contain at most 8 finding IDs")
        result["supersedes"] = sorted(set(record["supersedes"]))
    if result["generalPattern"] and result["scope"]:
        raise ValueError("generalPattern records must have empty scope")
    if len(_canonical(result)) > _MAX_RECORD_BYTES:
        raise ValueError(f"record exceeds {_MAX_RECORD_BYTES} canonical bytes")
    return result


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(_canonical(value) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _copy_evidence(shared_root: Path, source: Path) -> dict[str, str] | None:
    if (source.is_symlink() or not source.is_file() or source.suffix.lower() not in _EVIDENCE_SUFFIXES
            or source.stat().st_size > _MAX_EVIDENCE_BYTES or _SECRET_EVIDENCE_NAME.search(source.name)):
        return None
    payload = source.read_bytes()
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if _PRIVATE_PATH.search(text):
        return None
    digest = _sha(payload)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", source.name)[:120] or "evidence"
    destination = _base(shared_root) / "evidence" / digest / name
    with _lock(_base(shared_root) / "store.lock"):
        if destination.exists():
            if _sha(destination.read_bytes()) != digest:
                raise ValueError("shared-learning evidence integrity failure")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{name}.", dir=destination.parent)
            try:
                with os.fdopen(fd, "wb") as out, source.open("rb") as incoming:
                    while chunk := incoming.read(1024 * 1024):
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                if _sha(Path(temporary).read_bytes()) != digest:
                    raise ValueError("evidence changed while copying")
                os.replace(temporary, destination)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return {"path": destination.relative_to(Path(shared_root).resolve()).as_posix(), "sha256": digest}


def _artifact_values(value: Any, *, depth: int = 0) -> list[str]:
    if depth > 5:
        return []
    found: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            lower = str(key).lower()
            path_key = any(token in lower for token in ("path", "file", "evidence", "artifact"))
            if isinstance(child, str) and path_key:
                found.append(child)
            elif path_key and isinstance(child, (list, tuple)):
                found.extend(item for item in child if isinstance(item, str))
                found.extend(_artifact_values(child, depth=depth + 1))
            elif isinstance(child, (dict, list, tuple)):
                found.extend(_artifact_values(child, depth=depth + 1))
    elif isinstance(value, (list, tuple)):
        for child in value:
            found.extend(_artifact_values(child, depth=depth + 1))
    return found


def _first_named(value: Any, names: set[str], *, depth: int = 0) -> str | None:
    if depth > 5:
        return None
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in names and isinstance(child, (str, int)) and str(child).strip():
                return str(child).strip()
        for child in value.values():
            found = _first_named(child, names, depth=depth + 1)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for child in value:
            found = _first_named(child, names, depth=depth + 1)
            if found:
                return found
    return None


def _public_urls(value: Any, *, depth: int = 0) -> list[str]:
    if depth > 5:
        return []
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            lower = str(key).lower()
            if isinstance(child, str) and child.startswith(("http://", "https://")) and any(
                    token in lower for token in ("url", "endpoint", "service")):
                try:
                    found.append(_safe_url(child, "source URL"))
                except ValueError:
                    pass
            elif isinstance(child, (dict, list, tuple)):
                found.extend(_public_urls(child, depth=depth + 1))
    elif isinstance(value, (list, tuple)):
        for child in value:
            found.extend(_public_urls(child, depth=depth + 1))
    return found


def _structured_facts(value: Any, *, depth: int = 0) -> dict[str, str | int | float | bool]:
    if depth > 7:
        return {}
    aliases = {
        "protocol": "protocol", "serviceprotocol": "protocol", "crs": "crs", "nativecrs": "crs",
        "sourcecrs": "crs", "format": "format", "outputformat": "format",
        "supportspagination": "pagination", "pagination": "pagination", "idfield": "idField",
        "objectidfield": "idField", "objectidfieldname": "idField", "geometrytype": "geometryType",
        "maxrecordcount": "maxRecordCount",
    }
    out: dict[str, str | int | float | bool] = {}
    if isinstance(value, dict):
        spatial = value.get("spatialReference") or value.get("sourceSpatialReference")
        if isinstance(spatial, dict):
            wkid = spatial.get("latestWkid", spatial.get("wkid"))
            safe_wkid = _fact_scalar(wkid)
            if isinstance(safe_wkid, (str, int)) and not isinstance(safe_wkid, bool):
                candidate = _fact_scalar(f"EPSG:{safe_wkid}")
                if candidate is not None:
                    out["crs"] = candidate
        for key, child in value.items():
            target = aliases.get(str(key).replace("_", "").lower())
            scalar = _fact_scalar(child)
            if target and scalar is not None:
                out.setdefault(target, scalar)
            if isinstance(child, (dict, list, tuple)):
                for fact, fact_value in _structured_facts(child, depth=depth + 1).items():
                    out.setdefault(fact, fact_value)
    elif isinstance(value, (list, tuple)):
        for child in value:
            for fact, fact_value in _structured_facts(child, depth=depth + 1).items():
                out.setdefault(fact, fact_value)
    return out


def _file_facts(path: Path) -> dict[str, str | int | float | bool]:
    if path.suffix.lower() not in {".json", ".geojson"} or path.stat().st_size > _MAX_EVIDENCE_BYTES:
        return {}
    try:
        return _structured_facts(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def build_city_finding(root: Path, city: dict[str, Any], lane: str, state: dict[str, Any],
                       shared_root: Path | None = None) -> dict[str, Any] | None:
    """Build one bounded evidence-backed finding from a completed city lane."""
    if lane not in {"research", "review", "qualification", "admission"}:
        raise ValueError("lane must be research, review, qualification, or admission")
    if not isinstance(city, dict) or not isinstance(state, dict):
        raise ValueError("city and state must be objects")
    root = Path(root).resolve()
    shared_root = Path(shared_root or root).resolve()
    code = str(city.get("cityCode", city.get("code", ""))).strip()
    if not code:
        raise ValueError("city requires cityCode")
    qualification = state.get("qualification") if isinstance(state.get("qualification"), dict) else {}
    admission = state.get("admission") if isinstance(state.get("admission"), dict) else {}
    decision = str(state.get("discoveryDecision", "")).strip().lower()
    outcome = str((admission or qualification).get("status") if lane in {"qualification", "admission"}
                  else decision if lane == "review" else state.get("status", "")).strip().lower()
    if not outcome or outcome in {"pending", "running", "research-complete"} and lane != "research":
        return None
    if lane == "research":
        statement = f"Research artifacts were retained for city {code}; independent review is still required."
        category, verification = "research-artifact", "unverified"
    elif lane == "review":
        if outcome in {"candidate", "already-supported", "qualified", "resolved"}:
            statement = f"Review classified city {code} as {outcome} from the retained evidence."
            category, verification = "reviewed-source-fact", "verified"
        else:
            statement = (f"The bounded review for city {code} ended as {outcome}; this records the search "
                         "outcome and does not assert that no parcel source exists.")
            category, verification = "rejected-source-search", "failed"
    else:
        if outcome in {"integrated", "adapter-ready", "technical-qualified"}:
            statement = f"Parcel pipeline outcome for city {code} was {outcome}."
            category, verification = "qualified-source-fact", "verified"
        else:
            statement = f"Parcel pipeline attempt for city {code} ended as {outcome}; the failure remains retained."
            category, verification = "qualification-failure", "failed"
    evidence: list[dict[str, str]] = []
    facts: dict[str, str | int | float | bool] = {}
    for raw in _artifact_values([city, state]):
        if len(evidence) >= 8 or raw.startswith(("http://", "https://")):
            continue
        candidate = Path(raw)
        path = (candidate if candidate.is_absolute() else root / candidate).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        for key, value in _file_facts(path).items():
            facts.setdefault(key, value)
        copied = _copy_evidence(shared_root, path)
        if copied and copied not in evidence:
            evidence.append(copied)
    for url in _public_urls([city, state]):
        ref = {"url": url}
        if len(evidence) < 8 and ref not in evidence:
            evidence.append(ref)
    if not evidence:
        return None
    scope: dict[str, str] = {"cityCode": code}
    for source, target in (("name", "cityName"), ("iso2", "iso2"), ("country", "country")):
        if city.get(source):
            scope[target] = str(city[source])
    provider = _first_named([state, city], {"provider", "providerid", "sourceid"})
    adapter = _first_named([state, city], {"adapter", "adapterid", "adaptertype"})
    if provider:
        scope["provider"] = provider
    if adapter:
        scope["adapter"] = adapter
    if "protocol" not in facts:
        endpoints = [ref["url"].lower() for ref in evidence if "url" in ref]
        if any("/arcgis/rest/" in url for url in endpoints):
            facts["protocol"] = "arcgis-rest"
        elif any("service=wfs" in url or "/wfs" in url for url in endpoints):
            facts["protocol"] = "wfs"
        elif adapter:
            facts["protocol"] = adapter
    evidence_digest = _sha(_canonical(evidence))
    record: dict[str, Any] = {
        "statement": statement, "category": category, "stage": lane,
        "verificationStatus": verification, "scope": scope,
        "provenance": {"taskId": f"city:{code}:{lane}", "stage": lane,
                       "cityCode": code, "evidenceHash": evidence_digest},
        "evidenceRefs": evidence,
    }
    if facts:
        record["facts"] = facts
    if category in {"rejected-source-search", "qualification-failure"}:
        record["uncertainty"] = "This outcome is limited to the retained attempt and evidence."
    return record


def append_finding(root: Path, record: dict[str, Any]) -> str:
    """Append an immutable finding, returning its content-addressed ID."""
    normalized = _normalize(record)
    content_hash = _sha(_canonical(normalized))
    finding_id = f"finding-{content_hash}"
    path = _base(root) / "records" / f"{finding_id}.json"
    with _lock(_base(root) / "store.lock"):
        if path.exists():
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing.get("contentSha256") != content_hash or existing.get("record") != normalized:
                raise ValueError(f"shared-learning record integrity failure: {finding_id}")
            return finding_id
        stored = {"storeVersion": STORE_VERSION, "findingId": finding_id,
                  "contentSha256": content_hash,
                  "storedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "record": normalized}
        _atomic_json(path, stored)
    return finding_id


def _city_context(city: Any) -> dict[str, str]:
    if isinstance(city, str):
        return {"cityCode": city}
    if not isinstance(city, dict):
        raise ValueError("city must be a city code/name string or metadata object")
    aliases = {"name": "cityName", "code": "cityCode"}
    allowed = {"cityCode", "cityName", "name", "code", "iso2", "country", "provider", "adapter"}
    return {aliases.get(key, key): _text(str(value), f"city.{key}", required=True) or ""
            for key, value in city.items() if key in allowed and value is not None and str(value).strip()}


def _matches(scope: dict[str, str], city: dict[str, str]) -> tuple[int, list[str]]:
    score, reasons = 0, []
    weights = {"cityCode": 100, "cityName": 90, "iso2": 40, "country": 35, "provider": 30, "adapter": 25}
    for key, weight in weights.items():
        if key in scope and key in city and scope[key].casefold() == city[key].casefold():
            score += weight
            reasons.append(key)
    return score, reasons


def _read_records(root: Path) -> list[dict[str, Any]]:
    records = []
    directory = _base(root) / "records"
    for path in sorted(directory.glob("finding-*.json")) if directory.exists() else []:
        stored = json.loads(path.read_text(encoding="utf-8"))
        record = stored.get("record")
        digest = _sha(_canonical(record)) if isinstance(record, dict) else ""
        expected_id = f"finding-{digest}"
        if (stored.get("storeVersion") != STORE_VERSION or stored.get("contentSha256") != digest
                or stored.get("findingId") != expected_id or path.stem != expected_id):
            raise ValueError(f"shared-learning record integrity failure: {path.name}")
        records.append(stored)
    return records


def context_for_task(root: Path, city: Any, stage: str, max_records: int = 12) -> dict[str, Any]:
    """Read latest disk state and return bounded, task-relevant structured context."""
    if stage not in _STAGES:
        raise ValueError(f"stage must be one of {sorted(_STAGES)}")
    if not isinstance(max_records, int) or isinstance(max_records, bool) or max_records < 1:
        raise ValueError("max_records must be a positive integer")
    city_context = _city_context(city)
    stored_records = _read_records(root)
    scoped, general, cross_scope = [], [], []
    for stored in stored_records:
        record = stored["record"]
        score, reasons = _matches(record["scope"], city_context)
        selected = {**stored, "relevance": {"score": score + (5 if record["stage"] == stage else 0),
                                              "matches": reasons, "sameStage": record["stage"] == stage}}
        if record["generalPattern"]:
            general.append(selected)
        elif score:
            scoped.append(selected)
        else:
            selected["relevance"] = {"score": 0, "matches": [],
                                     "sameStage": record["stage"] == stage}
            cross_scope.append(selected)
    ordering = lambda item: (item["relevance"]["score"], item["storedAt"], item["findingId"])
    scoped.sort(key=ordering, reverse=True)
    general.sort(key=lambda item: (item["storedAt"], item["findingId"]), reverse=True)
    cross_scope.sort(key=lambda item: (item["storedAt"], item["findingId"]), reverse=True)
    general_limit = min(3, max(1, max_records // 3))
    chosen_general = general[:min(general_limit, max_records)]
    cross_limit = min(2, max_records // 4)
    chosen_cross = cross_scope[:min(cross_limit, max_records - len(chosen_general))]
    chosen = scoped[:max_records - len(chosen_general) - len(chosen_cross)] + chosen_general
    evidence = []
    for item in chosen + chosen_cross:
        for ref in item["record"]["evidenceRefs"]:
            if ref not in evidence:
                evidence.append(ref)
    verified = [item for item in chosen if item["record"]["verificationStatus"] == "verified"]
    superseded = sorted({finding_id for item in chosen for finding_id in item["record"].get("supersedes", [])})
    verified = [item for item in verified if item["findingId"] not in superseded]
    digest_input = [{"findingId": item["findingId"], "contentSha256": item["contentSha256"]}
                    for item in chosen + chosen_cross]
    store_digest_input = [{"findingId": item["findingId"], "contentSha256": item["contentSha256"]}
                          for item in stored_records]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "storeVersion": STORE_VERSION,
        "task": {"city": city_context, "stage": stage},
        "storeDigestSha256": _sha(_canonical(sorted(store_digest_input, key=lambda item: item["findingId"]))),
        "contextDigestSha256": _sha(_canonical(sorted(digest_input, key=lambda item: item["findingId"]))),
        "recordCount": len(chosen) + len(chosen_cross),
        "findings": chosen,
        "crossScopeExamples": chosen_cross,
        "supersededFindingIds": superseded,
        "verifiedSources": verified,
        "evidenceRefs": evidence,
    }
