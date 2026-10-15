"""Stage-2 qualification for one reviewed parcel source in its owning workspace."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


def _load_script(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load support script: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _support(root: Path) -> tuple[Any, Any]:
    return (_load_script(root / "scripts/run-parcel-qualification.py", "_parcel_stage_qualification"),
            _load_script(root / "scripts/run-parcel-adapter-build.py", "_parcel_stage_adapter_build"))


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(child) for child in value]
    return value


def _safe_input_path(root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, (str, Path)) or not str(value):
        raise ValueError(f"packet is missing {label}")
    path = Path(value)
    resolved = (path if path.is_absolute() else root / path).resolve()
    resolved.relative_to(root.resolve())
    if not resolved.is_file():
        raise ValueError(f"packet {label} is not a file")
    return resolved


def _receipt_evidence_path(root: Path, value: Any, label: str) -> tuple[Path, str]:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty repository-relative path")
    raw = Path(value)
    if raw.is_absolute() or ".." in raw.parts:
        raise ValueError(f"{label} must be a safe repository-relative path")
    path = _safe_input_path(root, raw, label)
    return path, path.relative_to(root.resolve()).as_posix()


@lru_cache(maxsize=1)
def _app_context_files() -> frozenset[str]:
    outcomes = _load_script(Path(__file__).with_name("parcel_discovery_outcomes.py"),
                            "_parcel_stage_discovery_outcomes")
    paths = getattr(outcomes, "APP_CONTEXT_FILES", None)
    if not isinstance(paths, (set, frozenset)) or not all(isinstance(path, str) for path in paths):
        raise RuntimeError("parcel discovery outcomes must define APP_CONTEXT_FILES")
    return frozenset(paths)


def _cohort_sample_path(root: Path, base: Path, value: Any, label: str) -> tuple[Path, str]:
    if not isinstance(value, (str, Path)) or not str(value):
        raise ValueError(f"{label} must be a non-empty sample path")
    raw = Path(value)
    path = (raw if raw.is_absolute() else base / raw).resolve()
    path.relative_to(root.resolve())
    if not path.is_file():
        raise ValueError(f"{label} is not a file: {value}")
    return path, path.relative_to(root.resolve()).as_posix()


def _sample_refs(value: Any, key: str = "") -> set[str]:
    refs: set[str] = set()
    if isinstance(value, dict):
        for k, child in value.items():
            lower = str(k).lower()
            if lower in {"samplefile", "samplefiles", "samplepath", "samplepaths"}:
                refs.update(_path_values(child))
            else:
                refs.update(_sample_refs(child, lower))
    elif isinstance(value, list):
        for child in value:
            refs.update(_sample_refs(child, key))
    return refs


def _path_values(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, list):
        out: set[str] = set()
        for child in value:
            out.update(_path_values(child))
        return out
    if isinstance(value, dict):
        for key in ("repoRelativePath", "path", "file", "filename"):
            if isinstance(value.get(key), str):
                return {value[key]}
    return set()


def _input_hashes(root: Path, city: dict[str, Any], receipt: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any]:
    city_path = _safe_input_path(root, packet.get("cityPath"), "cityPath")
    review_path = _safe_input_path(root, packet.get("reviewPath"), "reviewPath")
    city_sample_refs = _sample_refs(packet.get("city"))
    review_sample_refs = _sample_refs(packet.get("review"))
    queue_sample_refs = _sample_refs(city)
    sample_hashes: dict[str, str] = {}
    for base, refs, label in ((city_path.parent, city_sample_refs, "city packet sample"),
                              (review_path.parent, review_sample_refs, "service-review sample"),
                              (root, queue_sample_refs, "queue sample")):
        for ref in sorted(refs):
            path, rel = _cohort_sample_path(root, base, ref, label)
            sample_hashes[rel] = _sha(path.read_bytes())
    receipt_evidence = receipt.get("evidenceFiles")
    if not isinstance(receipt_evidence, list) or not receipt_evidence:
        raise ValueError("candidate receipt requires evidenceFiles")
    receipt_hashes: dict[str, str] = {}
    app_context_files = _app_context_files()
    for ref in receipt_evidence:
        path, rel = _receipt_evidence_path(root, ref, "receipt evidence file")
        if rel not in app_context_files:
            receipt_hashes[rel] = _sha(path.read_bytes())
    coverage = receipt.get("coverage")
    probes = coverage.get("probes") if isinstance(coverage, dict) else None
    if not isinstance(probes, list) or not probes:
        raise ValueError("candidate coverage requires hash-bound probe evidence files")
    probe_hashes: dict[str, dict[str, str]] = {}
    for index, probe in enumerate(probes):
        if not isinstance(probe, dict):
            raise ValueError(f"coverage probe {index} must be an object")
        path, rel = _receipt_evidence_path(root, probe.get("evidenceFile"), f"coverage probe {index} evidence")
        actual = _sha(path.read_bytes())
        expected = probe.get("evidenceSha256")
        if not isinstance(expected, str) or actual != expected:
            raise ValueError(f"coverage probe {index} evidence SHA-256 mismatch")
        probe_hashes[rel] = {"sha256": actual, "receiptSha256": expected}
    return {
        "receiptCanonicalSha256": _sha(_canonical(receipt)),
        "packetSha256": _sha(city_path.read_bytes()),
        "packetPath": city_path.relative_to(root.resolve()).as_posix(),
        "reviewSha256": _sha(review_path.read_bytes()),
        "reviewPath": review_path.relative_to(root.resolve()).as_posix(),
        "sampleFiles": sample_hashes,
        "receiptEvidenceFiles": receipt_hashes,
        "coverageProbeEvidenceFiles": probe_hashes,
        "cityIdentitySha256": _sha(_canonical({k: city.get(k) for k in ("cityCode", "name", "rank", "iso2", "point")})),
    }


def _validate_inputs(city: dict[str, Any], receipt: dict[str, Any], packet: dict[str, Any]) -> tuple[str, str, str, list[float]]:
    if not isinstance(city, dict) or not isinstance(receipt, dict) or not isinstance(packet, dict):
        raise ValueError("city, receipt, and validated packet must be objects")
    code = str(city.get("cityCode", ""))
    name = city.get("name")
    iso2 = city.get("iso2")
    point = city.get("point")
    if not code.isdigit() or not isinstance(name, str) or not name.strip():
        raise ValueError("city requires numeric cityCode and non-empty name")
    if not isinstance(iso2, str) or not re.fullmatch(r"[A-Za-z]{2}", iso2):
        raise ValueError("city requires a two-letter iso2")
    if (not isinstance(point, (list, tuple)) or len(point) != 2
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in point)
            or not -90 <= point[0] <= 90 or not -180 <= point[1] <= 180):
        raise ValueError("city point must be finite [latitude, longitude]")
    if receipt.get("decision") != "candidate":
        raise ValueError("stage 2 requires receipt.decision == 'candidate'")
    source = receipt.get("source")
    coverage = receipt.get("coverage")
    if not isinstance(source, dict) or not isinstance(source.get("sourceId"), str) or not source["sourceId"].strip():
        raise ValueError("candidate receipt requires source.sourceId")
    endpoint = source.get("endpoint")
    parsed_endpoint = urlsplit(endpoint) if isinstance(endpoint, str) else None
    if not parsed_endpoint or parsed_endpoint.scheme not in {"http", "https"} or not parsed_endpoint.netloc:
        raise ValueError("candidate receipt requires an HTTP(S) source.endpoint")
    if not isinstance(coverage, dict) or coverage.get("scope") not in {"citywide", "substantial-city"}:
        raise ValueError("candidate receipt requires citywide or substantial-city coverage scope")
    if packet.get("valid") is False:
        raise ValueError("research packet validation failed")
    packet_city = packet.get("city")
    if isinstance(packet_city, dict):
        packet_code = packet_city.get("cityCode", packet_city.get("code"))
        if packet_code is not None and str(packet_code) != code:
            raise ValueError("packet city code does not match immutable queue city")
    return code, name, source["sourceId"], [float(point[0]), float(point[1])]


def _next_attempt(city_root: Path) -> tuple[int, Path]:
    city_root.mkdir(parents=True, exist_ok=True)
    attempts = []
    for path in city_root.glob("attempt-*"):
        match = re.fullmatch(r"attempt-(\d+)", path.name)
        if match and path.is_dir():
            attempts.append(int(match.group(1)))
    number = max(attempts, default=0) + 1
    attempt_dir = city_root / f"attempt-{number:02d}"
    attempt_dir.mkdir(parents=True, exist_ok=False)
    return number, attempt_dir


def _worker_prompt(root: Path, city: dict[str, Any], receipt: dict[str, Any], packet: dict[str, Any],
                   city_root: Path, attempt_dir: Path, hashes: dict[str, Any]) -> str:
    qualification = root / "scripts/qualify-parcel-source.mjs"
    metric = root / "scripts/parcel-qualification-metric.py"
    point = [float(city["point"][1]), float(city["point"][0])]
    return f"""Implement and qualify this reviewed parcel-source candidate. This worker may add or adapt production adapter code and focused node:test files, then must run the saved source qualification. Missing adapter code is implementation work, never a source hold.

Immutable city identity (queue point is latitude,longitude; candidate point is longitude,latitude):
```json
{json.dumps(_jsonable(city), ensure_ascii=False, indent=2)}
```
Accepted discovery receipt:
```json
{json.dumps(_jsonable(receipt), ensure_ascii=False, indent=2)}
```
Validated packet summary:
```json
{json.dumps(_jsonable({k: packet.get(k) for k in ("city", "review", "polygonCount", "cityPath", "reviewPath")}), ensure_ascii=False, indent=2)}
```
Input hashes: `{json.dumps(hashes, ensure_ascii=False, sort_keys=True)}`
Repository: `{root}`
City artifact root: `{city_root}`
Attempt directory: `{attempt_dir}`

The receipt scope is a source-discovery claim that must be checked against first-party evidence; it is not proof that the qualification samples cover the whole city. Confirm the source's actual cadastral/registry parcel purpose. Exclude sale listings, development-only proposals, and planning overlays that are not cadastral parcel records. Do not claim citywide completeness from the qualifier's 13 bounded cells.

Write `{attempt_dir / 'candidate.json'}` and all evidence under `{attempt_dir}`. Candidate identity must bind exactly to receipt `source.sourceId` and `source.endpoint`, city code `{city['cityCode']}`, name `{city['name']}`, and point `{point}`. Include full descriptor fields needed by production catalog/runtime, and include `city.currency={{"locale":"...","code":"..."}}` if available from an existing same-country app config or verified public country metadata; do not guess. Keep frozen identity/source fields unchanged.
Use attempt-relative local paths in the candidate, including `alignmentEvidence.file`; keep every referenced local evidence file inside this attempt. The complete attempt must remain verifiable after copying unchanged into the coordinator's qualification state.

Use only safe native IDs and necessary geometry fields. Never request/save owner, address, tax/account, or other personal fields. Preserve source geometry unchanged. Alignment is required: retain first-party native CRS, wire axes, hash-bound native sample and published operation/grid evidence. No offsets, fitting, repair, clipping, simplification, union, guessed CRS, ballpark transforms, credentials, or access-control bypasses. If first-party evidence proves a genuine external limitation, save `{attempt_dir / 'evidence/source-block.json'}` with exact receipt `sourceId` and `endpoint`, a specific `reason`, and `evidenceFiles` as strings relative to this attempt directory (for example `evidence/metric-report.json`). Reference the saved source metadata, `qualification.json`, `metric-report.json`, and/or `alignment-report.json` that demonstrate the limitation. A missing adapter, unsupported local implementation, or incomplete local code is not a source limitation. For positive non-parcel evidence use the qualification runner's `evidence/exclusion.json` contract.

Allowed writes: this attempt directory, `backend/parcels/`, `backend/test/` focused node:test files and fixtures. Do not edit catalogs, city configs, runtime wiring outside adapter code, research inputs, or any unrelated path. Preserve unrelated dirty files.

Run exactly the existing qualifier against the candidate, with output under `{attempt_dir / 'evidence'}`:
`node {qualification} --candidate {attempt_dir / 'candidate.json'} --output {attempt_dir / 'evidence'} --metric-script {metric}`
Save command/exit/result. Return exactly the qualification OUTPUT_SCHEMA: `cityCode`, `status` (`technical-qualified`, `held`, or `excluded`), `summary`, `evidenceFiles`. Evidence paths are relative to `{city_root}`. A technical-qualified claim requires all schema-v2 checks, hashes, full-safe geometry, alignment evidence and independent metric/alignment recomputation to pass. A held result becomes blocked-source only when `source-block.json` and actual first-party evidence establish the limitation; otherwise explain the failed implementation/qualification gate. Include candidate and complete evidence artifacts in `evidenceFiles`.
"""


def _answer(result: dict[str, Any]) -> dict[str, Any]:
    answer = result.get("answer")
    if not isinstance(answer, dict):
        raise ValueError("worker returned no structured answer")
    if set(answer) == {"data"} and isinstance(answer.get("data"), dict):
        answer = answer["data"]
    expected = {"cityCode", "status", "summary", "evidenceFiles"}
    if set(answer) != expected or answer.get("status") not in {"technical-qualified", "held", "excluded"}:
        raise ValueError("worker answer does not match qualification OUTPUT_SCHEMA")
    if not isinstance(answer.get("summary"), str) or not answer["summary"].strip():
        raise ValueError("worker answer summary is empty")
    if not isinstance(answer.get("evidenceFiles"), list) or not answer["evidenceFiles"]:
        raise ValueError("worker answer must include evidence files")
    return answer


def _check_candidate(attempt_dir: Path, city: dict[str, Any], source_id: str, endpoint: str,
                     point_latlon: list[float]) -> tuple[bool, str]:
    path = attempt_dir / "candidate.json"
    if not path.is_file():
        return False, "candidate.json is missing"
    try:
        candidate = json.loads(path.read_text(encoding="utf-8"))
        descriptor = candidate.get("descriptor", {})
        candidate_city = candidate.get("city", {})
        expected_point = [point_latlon[1], point_latlon[0]]
        if (str(candidate_city.get("code")) != str(city["cityCode"])
                or candidate_city.get("name") != city["name"]
                or candidate_city.get("point") != expected_point):
            return False, "candidate city code/name/point does not match immutable queue"
        if descriptor.get("id") != source_id or descriptor.get("endpoint") != endpoint:
            return False, "candidate descriptor source ID or endpoint does not bind receipt"
        if candidate.get("sourceClassification", {}).get("isParcel") is not True:
            return False, "candidate does not positively classify a cadastral parcel source"
        purpose_evidence = candidate.get("sourceClassification", {}).get("evidence")
        if not isinstance(purpose_evidence, list) or not any(isinstance(value, str) and value.strip() for value in purpose_evidence):
            return False, "candidate lacks first-party evidence for its cadastral parcel-purpose classification"
        return True, "candidate identity and source binding verified"
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        return False, f"candidate is invalid: {exc}"


def _source_block_evidence(city_root: Path, attempt_dir: Path, source_id: str,
                           endpoint: str) -> tuple[bool, str, list[str]]:
    rel = "evidence/source-block.json"
    # The worker writes source-block evidence directly under its attempt evidence directory.
    block_path = attempt_dir / rel
    if any(part.is_symlink() for part in (block_path, *block_path.parents) if part != attempt_dir.parent):
        return False, "source-block evidence path uses a symlink", []
    block_path = block_path.resolve()
    block_path.relative_to(attempt_dir.resolve())
    if not block_path.is_file():
        return False, "held result has no source-block.json", []
    try:
        block = json.loads(block_path.read_text(encoding="utf-8"))
        if block.get("sourceId") != source_id or block.get("endpoint") != endpoint:
            return False, "source-block evidence does not bind receipt source", []
        reason = block.get("reason")
        if not isinstance(reason, str) or len(reason.strip()) < 12:
            return False, "source-block evidence has no specific source limitation", []
        refs = block.get("evidenceFiles")
        if not isinstance(refs, list) or not refs:
            return False, "source-block evidence must reference first-party evidence files", []
        verified: list[str] = []
        source_bound = False
        objective_failure = False
        source_host = urlsplit(endpoint).netloc.lower()
        parsed_evidence: list[dict[str, Any]] = []
        for ref in refs:
            if not isinstance(ref, str):
                return False, "source-block evidence path is malformed", []
            value = ref
            if not value or Path(value).is_absolute() or ".." in Path(value).parts:
                return False, "source-block evidence path must be attempt-relative and contained", []
            unresolved = attempt_dir / value
            if any(part.is_symlink() for part in (unresolved, *unresolved.parents) if part != attempt_dir.parent):
                return False, f"source evidence path uses a symlink: {value}", []
            path = unresolved.resolve()
            path.relative_to(attempt_dir.resolve())
            if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
                return False, f"source evidence file is missing or empty: {value}", []
            raw = path.read_bytes()
            try:
                doc = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                doc = None
            if isinstance(doc, dict):
                doc_source_id = doc.get("sourceId")
                source_bound = source_bound or doc_source_id == source_id
                status = doc.get("status", doc.get("httpStatus"))
                objective_failure = objective_failure or (type(status) is int and status in {401, 403, 404, 408, 429, 500, 501, 502, 503, 504})
                request_url = doc.get("request", {}).get("url") if isinstance(doc.get("request"), dict) else None
                evidence_url = request_url or doc.get("url") or doc.get("endpoint")
                if isinstance(evidence_url, str):
                    source_bound = source_bound or urlsplit(evidence_url).netloc.lower() == source_host
                parsed_evidence.append(doc)
            verified.append(path.relative_to(city_root).as_posix())
        qualification_docs = [doc for doc in parsed_evidence if doc.get("sourceId") == source_id]
        objective_failure = objective_failure or any(
            _qualifier_source_failure(doc, source_id, qualification_docs) for doc in parsed_evidence)
        if not source_bound:
            return False, "referenced first-party evidence does not identify the receipt source or endpoint", []
        if not objective_failure:
            return False, "referenced first-party evidence does not show an observable source limitation", []
        return True, str(reason), [block_path.relative_to(city_root).as_posix(), *verified]
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        return False, f"source-block evidence is invalid: {exc}", []


def _qualifier_source_failure(doc: dict[str, Any], source_id: str,
                              qualification_docs: list[dict[str, Any]]) -> bool:
    """Recognize source-bound failures from the qualifier's saved structured reports."""
    # Alignment failures can come from incomplete local evidence or implementation.
    # A failed gate alone does not prove an external source limitation.
    if doc.get("geometryPass") is False:
        overlaps = doc.get("overlaps")
        cache_hash = doc.get("inputSha256")
        bound_cache = (isinstance(cache_hash, str) and re.fullmatch(r"[0-9a-f]{64}", cache_hash)
                       and any(q.get("cacheSha256") == cache_hash
                               and q.get("checks", {}).get("metric", {}).get("passed") is False
                               for q in qualification_docs))
        return (bound_cache and type(doc.get("overlapPairCount")) is int and doc["overlapPairCount"] > 0
                and type(doc.get("featureCount")) is int and doc["featureCount"] > 0
                and isinstance(overlaps, list) and len(overlaps) == doc["overlapPairCount"]
                and all(isinstance(row, dict) and type(row.get("areaM2")) in (float, int)
                        and math.isfinite(row["areaM2"]) and row["areaM2"] > 0 for row in overlaps))
    return False


def _persist_result(attempt_dir: Path, city_root: Path, status: str, summary: str,
                    evidence: list[str], changed: list[str], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    rel_result = (attempt_dir / "result.json").relative_to(city_root).as_posix()
    result = {"status": status, "summary": summary, "artifactRoot": str(attempt_dir),
              "evidenceFiles": sorted(set([*evidence, rel_result])), "changedFiles": changed}
    if extra:
        result.update(extra)
    _json_write(attempt_dir / "result.json", result)
    return result


def _attempt_city_path(city_root: Path, attempt_dir: Path, filename: str) -> str:
    return (attempt_dir / filename).relative_to(city_root).as_posix()


def _artifact_hashes(root: Path, attempt_dir: Path) -> dict[str, dict[str, str]]:
    artifacts: dict[str, str] = {}
    for path in sorted(attempt_dir.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"stage artifact cannot be a symlink: {path}")
        if path.is_file() and path.name != "result.json":
            artifacts[path.relative_to(attempt_dir).as_posix()] = _sha(path.read_bytes())
    adapters: dict[str, str] = {}
    adapter_root = root / "backend/parcels"
    if adapter_root.is_dir():
        for path in sorted(adapter_root.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"backend adapter source cannot be a symlink: {path}")
            if path.is_file() and path.name != "source-catalog.json":
                adapters[path.relative_to(root).as_posix()] = _sha(path.read_bytes())
    return {"artifacts": artifacts, "backendAdapters": adapters}


def _stage_city_root(state_dir: Path, code: str) -> Path:
    return (state_dir / "qualification" / "cities" / code).resolve()


def revalidate_stage(runner: Any, city: dict[str, Any], receipt: dict[str, Any], packet: dict[str, Any],
                     stage_result: dict[str, Any]) -> tuple[bool, str]:
    """Recheck durable qualification inputs, evidence outputs, and adapter source before resume."""
    try:
        if not isinstance(stage_result, dict) or stage_result.get("status") not in {"adapter-ready", "integrated"}:
            return False, "stage result is not adapter-ready or integrated"
        root = Path(runner.root).resolve()
        state_dir = Path(runner.state_dir)
        state_dir = (root / state_dir).resolve() if not state_dir.is_absolute() else state_dir.resolve()
        code = str(city.get("cityCode", ""))
        city_root = _stage_city_root(state_dir, code)
        attempt_dir = Path(stage_result.get("artifactRoot", "")).resolve()
        attempt_dir.relative_to(city_root)
        expected_inputs = stage_result.get("inputHashes")
        if not isinstance(expected_inputs, dict):
            return False, "stage result is missing saved input hashes"
        actual_inputs = _input_hashes(root, city, receipt, packet)
        if actual_inputs != expected_inputs or stage_result.get("inputHashesAfter") != expected_inputs:
            return False, "receipt, packet, review, coverage probe, or sample inputs changed"
        expected_artifacts = stage_result.get("artifactHashes")
        if not isinstance(expected_artifacts, dict):
            return False, "stage result is missing artifact hashes"
        actual_artifacts = _artifact_hashes(root, attempt_dir)
        if actual_artifacts != expected_artifacts:
            return False, "stage qualification artifacts or backend adapter code changed"
        return True, "stage inputs, qualification artifacts, and backend adapter code remain hash-identical"
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return False, f"stage revalidation failed: {exc}"


def run_candidate(runner: Any, city: dict[str, Any], receipt: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any]:
    """Run one source qualification attempt, preserving artifacts and refusing unsupported status claims."""
    root = Path(runner.root).resolve()
    state_dir = Path(runner.state_dir)
    if not state_dir.is_absolute():
        state_dir = (root / state_dir).resolve()
    else:
        state_dir = state_dir.resolve()
    code, name, source_id, point_latlon = _validate_inputs(city, receipt, packet)
    endpoint = receipt["source"]["endpoint"]
    city_root = (state_dir / "qualification" / "cities" / code).resolve()
    reserved_name = getattr(runner, "qualification_attempt_name", None)
    if reserved_name is None:
        _number, attempt_dir = _next_attempt(city_root)
    else:
        if not re.fullmatch(r"attempt-\d+", reserved_name):
            raise ValueError("invalid reserved qualification attempt name")
        attempt_dir = city_root / reserved_name
        attempt_dir.mkdir(parents=True, exist_ok=False)
    hashes_before = _input_hashes(root, city, receipt, packet)
    _json_write(attempt_dir / "inputs.json", hashes_before)
    city_for_verifier = {"cityCode": code, "cityName": name, "point": point_latlon}
    try:
        qualification, build = _support(root)
        before = build.worktree_snapshot(root)
        model = runner._model("review")
        prompt = _worker_prompt(root, city, receipt, packet, city_root, attempt_dir, hashes_before)
        call = runner._call("review", f"source-qualification:{code}", prompt,
                            model["model"], model.get("effort") or "medium")
        call["schema"] = copy.deepcopy(qualification.OUTPUT_SCHEMA)
        calls = runner.run_calls([call])
        if not calls:
            hashes_after = _input_hashes(root, city, receipt, packet)
            changed = build.snapshot_delta(before, build.worktree_snapshot(root))
            unexpected = [path for path in changed if path.endswith("source-catalog.json") or not build.allowed_change(path)]
            if unexpected:
                return _persist_result(attempt_dir, city_root, "failed",
                                       "unattributed worker changes are outside the allowed scope; changes were preserved",
                                       [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed,
                                       {"unexpectedChangedFiles": unexpected, "inputHashes": hashes_before,
                                        "inputHashesAfter": hashes_after})
            test_evidence: list[str] = []
            if any(path.startswith("backend/parcels/") or build.is_backend_test_file(path) for path in changed):
                ok, test_summary, test_path = build.run_focused_tests(root, changed, attempt_dir)
                test_evidence.append(test_path.relative_to(city_root).as_posix())
                if not ok:
                    hashes_after_tests = _input_hashes(root, city, receipt, packet)
                    return _persist_result(attempt_dir, city_root, "failed", test_summary,
                                           [_attempt_city_path(city_root, attempt_dir, "inputs.json"), *test_evidence], changed,
                                           {"inputHashes": hashes_before, "inputHashesAfterWorker": hashes_after,
                                            "inputHashesAfter": hashes_after_tests})
                after_tests = build.worktree_snapshot(root)
                extra_changes = build.snapshot_delta(before, after_tests)
                extra_unexpected = [path for path in extra_changes
                                    if path.endswith("source-catalog.json") or not build.allowed_change(path)]
                if extra_unexpected:
                    hashes_after_tests = _input_hashes(root, city, receipt, packet)
                    return _persist_result(attempt_dir, city_root, "failed",
                                           "focused tests caused out-of-scope changes; changes were preserved",
                                           [_attempt_city_path(city_root, attempt_dir, "inputs.json"), *test_evidence],
                                           extra_changes, {"unexpectedChangedFiles": extra_unexpected,
                                                           "inputHashes": hashes_before,
                                                           "inputHashesAfterWorker": hashes_after,
                                                           "inputHashesAfter": hashes_after_tests})
                changed = extra_changes
                hashes_after = _input_hashes(root, city, receipt, packet)
            changed_inputs = hashes_after != hashes_before
            status = "failed" if changed_inputs else ("interrupted" if getattr(runner, "stop_requested", False) else "failed")
            summary = "inputs changed during qualification" if changed_inputs else "qualification worker did not produce a call result"
            return _persist_result(attempt_dir, city_root, status, summary,
                                   [_attempt_city_path(city_root, attempt_dir, "inputs.json"), *test_evidence], changed,
                                   {"inputHashes": hashes_before, "inputHashesAfter": hashes_after})
        worker = calls[0]
        hashes_after_worker = _input_hashes(root, city, receipt, packet)
        after = build.worktree_snapshot(root)
        changed = build.snapshot_delta(before, after)
        unexpected = [path for path in changed if path.endswith("source-catalog.json") or not build.allowed_change(path)]
        if unexpected:
            return _persist_result(attempt_dir, city_root, "failed",
                                   "worker changed files outside backend/parcels and focused backend/test scope; changes were preserved",
                                   [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed, {"unexpectedChangedFiles": unexpected,
                                                               "inputHashes": hashes_before,
                                                               "inputHashesAfter": hashes_after_worker})
        if hashes_after_worker != hashes_before:
            return _persist_result(attempt_dir, city_root, "failed", "inputs changed during qualification",
                                   [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed,
                                   {"inputHashes": hashes_before, "inputHashesAfter": hashes_after_worker})
        test_evidence: list[str] = []
        if any(path.startswith("backend/parcels/") or build.is_backend_test_file(path) for path in changed):
            ok, test_summary, test_path = build.run_focused_tests(root, changed, attempt_dir)
            test_evidence.append(test_path.relative_to(city_root).as_posix())
            if not ok:
                hashes_after_tests = _input_hashes(root, city, receipt, packet)
                return _persist_result(attempt_dir, city_root, "failed", test_summary,
                                       [_attempt_city_path(city_root, attempt_dir, "inputs.json"), *test_evidence], changed,
                                       {"inputHashes": hashes_before, "inputHashesAfterWorker": hashes_after_worker,
                                        "inputHashesAfter": hashes_after_tests})
            final_snapshot = build.worktree_snapshot(root)
            later_changes = build.snapshot_delta(after, final_snapshot)
            if later_changes:
                hashes_after_tests = _input_hashes(root, city, receipt, packet)
                return _persist_result(attempt_dir, city_root, "failed",
                                       "focused tests changed additional files; changes were preserved",
                                       [_attempt_city_path(city_root, attempt_dir, "inputs.json"), *test_evidence],
                                       sorted(set(changed + later_changes)),
                                       {"unexpectedChangedFiles": later_changes, "inputHashes": hashes_before,
                                        "inputHashesAfterWorker": hashes_after_worker,
                                        "inputHashesAfter": hashes_after_tests})
        if worker.get("interrupted") or worker.get("timedOut"):
            return _persist_result(attempt_dir, city_root, "interrupted", "qualification worker was interrupted or timed out",
                                   [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed, {"inputHashes": hashes_before,
                                                               "inputHashesAfter": hashes_after_worker})
        if worker.get("returncode") != 0:
            return _persist_result(attempt_dir, city_root, "failed",
                                   f"qualification worker exited {worker.get('returncode')}: {worker.get('error') or ''}".strip(),
                                   [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed, {"inputHashes": hashes_before,
                                                               "inputHashesAfter": hashes_after_worker})
        answer = _answer(worker)
        if str(answer["cityCode"]) != code:
            raise ValueError("qualification answer cityCode does not match immutable queue")
        answer_path = attempt_dir / "worker-answer.json"
        _json_write(answer_path, {"data": answer})
        verifier = qualification.Runner.__new__(qualification.Runner)
        verifier.root = root
        item = {"answerPath": answer_path, "city": city_for_verifier, "cityDir": city_root,
                "attemptDir": attempt_dir, "phase": "llm"}
        verified = verifier._verify_worker_answer(item)
        candidate_ok, candidate_reason = _check_candidate(attempt_dir, city, source_id, endpoint, point_latlon)
        if answer["status"] == "technical-qualified":
            if not candidate_ok:
                raise ValueError(candidate_reason)
            status = "adapter-ready"
            summary = verified["summary"]
        elif answer["status"] == "excluded":
            status = "rejected-source"
            summary = verified["summary"]
        else:
            blocked, block_reason, block_evidence = _source_block_evidence(city_root, attempt_dir, source_id, endpoint)
            if blocked:
                status, summary = "blocked-source", block_reason
            else:
                status = "failed"
                summary = f"held result is not proven to be a source limitation: {block_reason}"
        worker_evidence = list(verified.get("evidenceFiles", []))
        all_evidence = [_attempt_city_path(city_root, attempt_dir, "inputs.json"),
                        _attempt_city_path(city_root, attempt_dir, "worker-answer.json"),
                        *worker_evidence, *test_evidence]
        if answer["status"] == "held" and status == "blocked-source":
            all_evidence.extend(block_evidence)
        hashes_after = _input_hashes(root, city, receipt, packet)
        if hashes_after != hashes_before:
            status = "failed"
            summary = "an input receipt, packet, review, or sample changed during qualification"
        extra = {"inputHashes": hashes_before, "inputHashesAfter": hashes_after,
                 "candidateBinding": {"passed": candidate_ok, "summary": candidate_reason}}
        if status in {"adapter-ready", "blocked-source"}:
            extra["artifactHashes"] = _artifact_hashes(root, attempt_dir)
        return _persist_result(attempt_dir, city_root, status, summary, all_evidence, changed, extra)
    except Exception as exc:
        try:
            hashes_after = _input_hashes(root, city, receipt, packet)
        except Exception:
            hashes_after = None
        changed: list[str] = []
        try:
            _qualification, build = _support(root)
            changed = build.snapshot_delta(before, build.worktree_snapshot(root))
        except Exception:
            pass
        return _persist_result(attempt_dir, city_root, "failed", f"{type(exc).__name__}: {exc}",
                               [_attempt_city_path(city_root, attempt_dir, "inputs.json")], changed,
                               {"inputHashes": hashes_before, "inputHashesAfter": hashes_after})
