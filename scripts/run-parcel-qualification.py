#!/usr/bin/env python3
"""Direct-first parcel qualification with a separate LLM exception pool; requires --run."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "cityCode": {"type": "string"},
        "status": {"type": "string", "enum": ["technical-qualified", "held", "excluded"]},
        "summary": {"type": "string"},
        "evidenceFiles": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["cityCode", "status", "summary", "evidenceFiles"],
}
sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
from parcel_qualification_policy import POLICY, REQUIRED_CHECKS, initial_qualification_review, usable_parcel_cache
ALL_CHECKS = (*REQUIRED_CHECKS, *POLICY['followUpChecks'])
BLOCKER_FIELDS = ("invalidCount", "duplicateIdCount", "conflictingSameIdGeometryCount",
                  "exactGeometryDuplicateCount", "overlapPairCount", "operationErrorCount")
MAX_CITY_BYTES = 250 * 1024 * 1024
MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
POLL_SECONDS = 1
HEARTBEAT_SECONDS = 10
TERM_GRACE_SECONDS = 10
LLM_DIR = Path(os.environ.get("LLM_COST_DIR", str(Path(__file__).resolve().parents[2] / "agents/lib/llm-cost")))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_relative(base: Path, value: str) -> Path:
    candidate = (base / value).resolve()
    candidate.relative_to(base.resolve())
    return candidate


def load_queue(path: Path, expected_records: int | None = None) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    data = json.loads(raw)
    records = data if isinstance(data, list) else data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise ValueError("queue must be a records array or a top-level array")
    if expected_records is not None and len(records) != expected_records:
        raise ValueError(f"frozen queue must contain {expected_records} records; found {len(records)}")
    codes: set[str] = set()
    required = ("cityCode", "rank", "cityName", "countryCode", "point",
                "serviceReviewRepoRelativePath", "sampleFiles", "sourceAnnotations")
    for index, city in enumerate(records):
        if not isinstance(city, dict) or any(field not in city for field in required):
            raise ValueError(f"queue record {index} is missing a required frozen field")
        code = str(city["cityCode"])
        if not code.isdigit() or code in codes:
            raise ValueError(f"queue cityCode must be unique and numeric: {code}")
        codes.add(code)
        if not isinstance(city["rank"], int) or not isinstance(city["cityName"], str) or not city["cityName"]:
            raise ValueError(f"invalid rank or city name for {code}")
        if not isinstance(city["countryCode"], str) or len(city["countryCode"]) != 2:
            raise ValueError(f"invalid countryCode for {code}")
        point = city["point"]
        if not isinstance(point, (list, tuple)) or len(point) != 2 or not all(isinstance(x, (int, float)) for x in point):
            raise ValueError(f"point for {code} must be [latitude, longitude]")
        if not -90 <= point[0] <= 90 or not -180 <= point[1] <= 180:
            raise ValueError(f"point for {code} is outside latitude/longitude bounds")
        packet_field = "packetRepoRelativePath" if "packetRepoRelativePath" in city else "cityPacketRepoRelativePath"
        if packet_field not in city:
            raise ValueError(f"queue record {code} is missing packetRepoRelativePath")
        for field in (packet_field, "serviceReviewRepoRelativePath"):
            if not isinstance(city[field], str) or Path(city[field]).is_absolute() or ".." in Path(city[field]).parts:
                raise ValueError(f"unsafe repository-relative path for {code}: {field}")
        if not isinstance(city["sampleFiles"], list) or not isinstance(city["sourceAnnotations"], (dict, list)):
            raise ValueError(f"sampleFiles or sourceAnnotations malformed for {code}")
    return records, sha256_bytes(raw)


def _metric_file_path(city_dir: Path, q: dict[str, Any], key: str) -> Path:
    value = q.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"qualification evidence missing {key}")
    return safe_relative(city_dir, value)


def verify_technical_artifacts(artifact_root: Path, code: str) -> tuple[bool, str]:
    """Independently validate worker artifacts; a claimed status alone never qualifies."""
    try:
        candidate_path = artifact_root / "candidate.json"
        qualification_path = artifact_root / "evidence" / "qualification.json"
        q = read_json(qualification_path)
        metric_input_path = _metric_file_path(artifact_root / "evidence", q, "cacheFile")
        candidate_bytes = candidate_path.read_bytes()
        candidate = json.loads(candidate_bytes)
        if str(candidate.get("city", {}).get("code")) != code:
            return False, "candidate city code does not match queue record"
        if q.get("candidateSha256") != sha256_bytes(candidate_bytes):
            return False, "candidate SHA-256 mismatch"
        checks = q.get("checks")
        if not isinstance(checks, dict) or any(
            not isinstance(checks.get(key), dict) or checks[key].get("passed") is not True
            for key in REQUIRED_CHECKS
        ):
            return False, "required independent qualification check is missing or false"
        metric_input_sha = sha256_file(metric_input_path)
        if q.get("cacheSha256") != metric_input_sha:
            return False, "metric input SHA-256 mismatch"
        metric_cache_path = safe_relative(artifact_root / "evidence", q.get("geometryReport") or "metric-report.json")
        metric_bytes = metric_cache_path.read_bytes()
        metric = json.loads(metric_bytes)
        if metric.get("inputSha256") != metric_input_sha:
            return False, "metric cache does not bind to input"
        if q.get("status") != "technical-qualified" or str(q.get("cityCode")) != code:
            return False, "qualification status or identity mismatch"
        if q.get("schemaVersion") not in {1, 2}:
            return False, "recognized qualification evidence schema is required"
        source_id = candidate.get("descriptor", {}).get("id")
        if not isinstance(source_id, str) or not source_id or q.get("sourceId") != source_id:
            return False, "qualification source identity mismatch"
        if metric.get("geometryChangedOrRepaired") is not False or metric.get("sourceCrs") != "EPSG:4326":
            return False, "metric audit lacks unmodified WGS84 input proof"
        cache = read_json(metric_input_path)
        if not usable_parcel_cache(cache, source_id):
            return False, "source cache has no usable geographic parcel polygons"
        feature_count = metric.get("featureCount")
        if not isinstance(feature_count, int) or feature_count <= 0:
            return False, "metric audit has no verified features"
        if cache.get("type") != "FeatureCollection" or len(cache.get("features", [])) != feature_count or q.get("featureCount") != feature_count:
            return False, "full-safe cache feature count mismatch"
        reviewed_checks = {key: dict(value) for key, value in checks.items() if isinstance(value, dict)}
        if metric.get("geometryPass") is not True or metric.get("validFeatureCount") != feature_count or any(metric.get(field) != 0 for field in BLOCKER_FIELDS):
            reviewed_checks['metric'] = {'passed': False, 'reason': 'Detailed geometry audit has unresolved findings; retained for the second pass.'}
        alignment_ok, alignment_reason = verify_alignment_artifacts(artifact_root, candidate, q, metric_input_path)
        if not alignment_ok:
            reviewed_checks['alignment'] = {'passed': False, 'reason': alignment_reason}
        review = initial_qualification_review(reviewed_checks, q.get('failures'))
        review.update(candidateSha256=q['candidateSha256'], cacheSha256=metric_input_sha,
                      qualificationSha256=sha256_file(qualification_path))
        atomic_json(artifact_root / 'evidence/initial-review.json', review)
        return True, "working parcel source verified; unresolved quality findings retained for the second pass"
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        return False, f"qualification artifacts incomplete or invalid: {exc}"


def verify_alignment_artifacts(artifact_root: Path, candidate: dict[str, Any], q: dict[str, Any],
                               cache_path: Path) -> tuple[bool, str]:
    """Recompute the native CRS proof against the saved evidence pack and exact full-safe cache."""
    try:
        checks = q.get("checks", {})
        check = checks.get("alignment", {})
        if check.get("passed") is not True:
            return False, "independent alignment qualification check is missing or false"
        contract_sha = check.get("contractSha256")
        if not isinstance(contract_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", contract_sha):
            return False, "alignment coordinate contract SHA-256 is missing"
        source_id = candidate.get("descriptor", {}).get("id")
        evidence_path = artifact_root / "evidence" / "alignment-evidence.json"
        evidence_bytes = evidence_path.read_bytes()
        evidence = json.loads(evidence_bytes)
        if (evidence.get("sourceId") != source_id or str(evidence.get("cityCode")) != str(q.get("cityCode"))
                or evidence.get("contractSha256") != contract_sha):
            return False, "alignment evidence source, city or contract mismatch"
        if any(key in evidence for key in ("offset", "translation", "fit", "correction", "towgs84")):
            return False, "empirical coordinate corrections are not admissible alignment evidence"

        def bound_file(key: str, hash_key: str) -> tuple[Path, str]:
            value = evidence.get(key)
            if not isinstance(value, str) or not value or Path(value).is_absolute():
                raise ValueError(f"alignment evidence {key} must be relative")
            path = safe_relative(evidence_path.parent, value)
            digest = sha256_file(path)
            if digest != evidence.get(hash_key):
                raise ValueError(f"alignment evidence {key} SHA-256 mismatch")
            return path, digest

        metadata_path, metadata_sha = bound_file("metadataFile", "metadataSha256")
        native_path, native_sha = bound_file("nativeFile", "nativeSha256")
        if not cache_path.is_file():
            return False, "alignment full-safe cache is missing"
        cache_sha = sha256_file(cache_path)
        if q.get("cacheSha256") != cache_sha:
            return False, "alignment cache SHA-256 does not match qualification cache"

        # A manually supplied alignment pack must remain hash-bound to its candidate reference.
        candidate_reference = candidate.get("alignmentEvidence")
        if candidate_reference is not None:
            if not isinstance(candidate_reference, dict) or not isinstance(candidate_reference.get("file"), str):
                return False, "candidate alignmentEvidence reference is malformed"
            original = safe_relative(artifact_root, candidate_reference["file"])
            original_bytes = original.read_bytes()
            if sha256_bytes(original_bytes) != candidate_reference.get("sha256"):
                return False, "candidate alignmentEvidence SHA-256 mismatch"
            original_evidence = json.loads(original_bytes)
            if (original_evidence.get("sourceId") != source_id
                    or str(original_evidence.get("cityCode")) != str(q.get("cityCode"))
                    or original_evidence.get("contractSha256") != contract_sha
                    or original_evidence.get("metadataSha256") != metadata_sha
                    or original_evidence.get("nativeSha256") != native_sha):
                return False, "candidate alignmentEvidence does not bind to copied native evidence"
            for file_key, hash_key in (("metadataFile", "metadataSha256"), ("nativeFile", "nativeSha256")):
                original_file = safe_relative(original.parent, original_evidence.get(file_key, ""))
                if sha256_file(original_file) != original_evidence.get(hash_key):
                    return False, f"candidate alignmentEvidence {file_key} SHA-256 mismatch"

        report_value = q.get("alignmentReport")
        if not isinstance(report_value, str) or not report_value:
            return False, "qualification alignmentReport path is missing"
        saved_report_path = safe_relative(artifact_root / "evidence", report_value)
        saved_report = read_json(saved_report_path)
        independent_path = artifact_root / "evidence" / "independent-alignment-report.json"
        command = [sys.executable, str(Path(__file__).resolve().with_name("parcel-alignment-check.py")),
                   str(evidence_path), str(cache_path), str(independent_path), "--source-id", source_id,
                   "--city-code", str(q.get("cityCode")), "--contract-sha256", contract_sha]
        run = subprocess.run(command, capture_output=True, text=True, timeout=120)
        independent = read_json(independent_path) if independent_path.is_file() else {}
        if run.returncode != 0 or independent.get("passed") is not True:
            return False, "independent recomputation of native CRS alignment failed"
        native_crs = evidence.get("nativeCrs")
        axis_order = evidence.get("nativeAxisOrder")
        for report in (saved_report, independent):
            if (report.get("passed") is not True or report.get("schemaVersion") != 1
                    or report.get("sourceId") != source_id or str(report.get("cityCode")) != str(q.get("cityCode"))
                    or report.get("contractSha256") != contract_sha or report.get("cacheSha256") != cache_sha
                    or report.get("evidenceSha256") != sha256_bytes(evidence_bytes)
                    or report.get("metadataSha256") != metadata_sha or report.get("nativeSha256") != native_sha
                    or report.get("nativeCrs") != native_crs or report.get("nativeAxisOrder") != axis_order
                    or not isinstance(report.get("coordinateOperation"), str) or not report["coordinateOperation"].strip()
                    or not isinstance(report.get("operationPipeline"), str) or not report["operationPipeline"].strip()
                    or report.get("bestOperationAvailable") is not True or report.get("ballparkAllowed") is not False
                    or report.get("sourceGeometryChanged") is not False or report.get("fittedOffsetApplied") is not False):
                return False, "alignment report is incomplete, unbound or uses an inferred transform"
        if not isinstance(native_crs, str) or not re.fullmatch(r"EPSG:\d+", native_crs):
            return False, "alignment evidence lacks an explicit published native CRS"
        if axis_order not in {"east-north", "north-east"}:
            return False, "alignment evidence lacks an explicit native wire axis order"
        return True, "native CRS alignment independently recomputed and artifact hashes verified"
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        return False, f"alignment artifacts incomplete or invalid: {exc}"


def valid_terminal_artifact(city_dir: Path, city: dict[str, Any], state_city: dict[str, Any]) -> bool:
    status = state_city.get("status")
    if status == "technical-qualified":
        artifact_root = Path(state_city.get("currentDir", city_dir))
        try: artifact_root.resolve().relative_to(city_dir.resolve())
        except ValueError: return False
        return verify_technical_artifacts(artifact_root, str(city["cityCode"]))[0]
    if status in {"held", "excluded"}:
        reason = state_city.get("summary")
        evidence = state_city.get("evidenceFiles")
        if not isinstance(reason, str) or not reason.strip() or not isinstance(evidence, list) or not evidence:
            return False
        try:
            return all(safe_relative(city_dir, path).is_file() for path in evidence)
        except (ValueError, OSError):
            return False
    return False


def city_prompt(city: dict[str, Any], source_root: Path, repo_root: Path, city_dir: Path, attempt_dir: Path) -> str:
    packet = safe_relative(source_root, city.get("packetRepoRelativePath", city.get("cityPacketRepoRelativePath")))
    review = safe_relative(source_root, city["serviceReviewRepoRelativePath"])
    samples = [str(safe_relative(source_root, item["repoRelativePath"] if isinstance(item, dict) else item)) for item in city["sampleFiles"]]
    point = [float(city["point"][1]), float(city["point"][0])]
    qualifier = repo_root / "scripts/qualify-parcel-source.mjs"
    metric = repo_root / "scripts/parcel-qualification-metric.py"
    return f"""Qualify one frozen city parcel source for technical review. You may READ the packet/review/sample inputs below and repository scripts, but WRITE only inside `{attempt_dir}`. Never edit source packets, queue, registry/catalog/runtime, or any other path. No credentials, auth, private tokens, owner/address fields, or source bypasses. Stop and report a held actionable issue if a custom adapter would be needed; do not edit production adapter code.

Frozen queue record:
```json
{json.dumps(city, ensure_ascii=False, indent=2)}
```
Read only these source files:
- `{packet}`
- `{review}`
Sample inputs (when present): {json.dumps(samples, ensure_ascii=False)}

Prepare `{attempt_dir / 'candidate.json'}` containing catalog descriptor, `city` as {{"code":"{city['cityCode']}","name":{json.dumps(city['cityName'])},"point":[{point[0]},{point[1]}]}} in longitude/latitude order, safe native or reproducible geometry-derived `sampleIds`, a valid-format absent `absentId`, caller-selected `metricEpsg`, and `sourceClassification` as {{"isParcel":true,"evidence":["first-party source purpose and geographic scope evidence"]}} grounded in the packet. `sampleIds` and `absentId` must use the production descriptor idPrefix and native-ID codec, not raw unprefixed IDs. Descriptor outFields include only native-ID, object-ID and necessary safe filter fields. Use descriptor capabilities accurately. Set cellSizeDegrees to 0.001 unless source contract requires a documented smaller grid. Never repair, clip, simplify, union or drop a bad source polygon. Never treat a zero point hit, login-facing UI, timeout or website text as citywide absence. Inspect official endpoints/schema/downloads. Bound requests and caches; read scripts/qualify-parcel-source.mjs -- or the file -- to understand source-specific unsupported checks. No independent child agents; finish your bounded city in this turn. Do not infer a parcel source from keywords alone: confirm its actual cadastral/registry purpose and city scope from first-party evidence.

Initial qualification uses parcel-availability-v1: establish parcel purpose, working exact parcel reads and a repeatable independent read that returns usable polygon geometry. Native cadastral IDs or documented deterministic geometry-derived references are both acceptable. Missing projection metadata, native CRS/axis/operation proof, detailed geometry audit findings, area completeness, explicit-absence or binding limitations are follow-up notes, not initial qualification blockers. Keep all failed/unrun checks and concrete uncertainties visible in qualification evidence and initial-review.json for the second pass. Do not spend this initial turn pursuing perfect alignment or deep completeness. Never invent a successful check or alter source geometry to make it fit. The qualifier defaults to the initial pass; --deep-review is reserved for a later investigation. If an alignment pack already exists, preserve its real evidence and result; missing or failed alignment does not require held.

Run the existing repository qualifier with output only in this attempt directory:
`node {qualifier} --candidate {attempt_dir / 'candidate.json'} --output {attempt_dir / 'evidence'} --metric-script {metric}`

Return exactly the supplied JSON schema: `cityCode`, `status`, `summary`, `evidenceFiles`. `technical-qualified` is only a recommendation for primary review, never an app integration/admission. Claim it when parcel classification, exactIds and stableGeometry pass and the unchanged hash-bound full-safe cache contains real usable parcel polygons. Include candidate.json, qualification.json, full-safe.geojson, metric-report.json when available, and any existing quality evidence in evidenceFiles. The primary verifier adds its own independently generated review reports. Preserve alignment, geometry, completeness and binding uncertainties as second-pass follow-ups instead of returning held for them. Return held for missing/non-working parcel output or failed core reads. Evidence paths are relative to `{city_dir}` and must exist. Use `excluded` only for a positively evidenced non-parcel source: write `{attempt_dir / 'evidence/exclusion.json'}` as JSON with `parcelPurpose: false`, the first-party `sourceUrl`, a short exact `excerpt`, and the reason the service is not a parcel source; include this file in `evidenceFiles`. Do not claim success from a status label alone."""


def output_schema() -> dict[str, Any]:
    return OUTPUT_SCHEMA


def _strip_api_key_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        if re.search(r"(?:^|_)(?:API_KEY|APIKEY)$", key, re.I):
            env.pop(key, None)
    return env


def _direct_worker_main(request_path: Path, output_path: Path) -> int:
    request = read_json(request_path)
    root, attempt = Path(request["repoRoot"]), request_path.parent
    candidate = attempt / "candidate.json"
    preparation = attempt / "preparation.json"
    with (attempt / "direct.log").open("w") as log:
        prepared = subprocess.run(["node", str(root / "scripts/prepare-parcel-qualification.mjs"),
                                   "--request", str(request_path), "--output", str(candidate)],
                                  stdout=log, stderr=log, timeout=120)
        if prepared.returncode == 0:
            qualified = subprocess.run(["node", str(root / "scripts/qualify-parcel-source.mjs"),
                                        "--candidate", str(candidate), "--output", str(attempt / "evidence"),
                                        "--metric-script", str(root / "scripts/parcel-qualification-metric.py")],
                                       stdout=log, stderr=log)
            ok, reason = verify_technical_artifacts(attempt, request["cityCode"])
            if qualified.returncode == 0 and ok:
                status, summary = "technical-qualified", "Working parcel source passed initial qualification; detailed quality findings remain in the second-pass review."
            else:
                status, summary = "needs-llm", f"Direct qualification needs troubleshooting: {reason}"
        else:
            report = read_json(preparation) if preparation.exists() else {}
            status, summary = "needs-llm", report.get("reason", "No verified descriptor/native-ID candidate could be prepared.")
    prefix = attempt.relative_to(attempt.parent).as_posix() + "/"
    evidence = [prefix + "direct.log"]
    evidence += [prefix + str(p.relative_to(attempt)) for p in (preparation, candidate, attempt / "evidence/qualification.json") if p.is_file()]
    if status == "technical-qualified":
        evidence += [prefix + "evidence/" + name for name in (
            "full-safe.geojson", "alignment-evidence.json", "alignment-metadata.json",
            "alignment-native.json", "alignment-report.json", "independent-alignment-report.json")
            if (attempt / "evidence" / name).is_file()]
    atomic_json(output_path, {"executionMode": "direct", "data": {"cityCode": request["cityCode"],
                "status": status, "summary": summary, "evidenceFiles": evidence}})
    return 0


def _worker_main(request_path: Path, output_path: Path) -> int:
    request = read_json(request_path)
    if request.get("phase") == "direct":
        try:
            return _direct_worker_main(request_path, output_path)
        except Exception as error:
            # A failed preparation or subprocess is an actionable exception, never a
            # claim that the city lacks parcels or a reason to stop the direct queue.
            evidence = request_path.parent / "direct-error.json"
            atomic_json(evidence, {"errorType": type(error).__name__})
            atomic_json(output_path, {"executionMode": "direct", "data": {
                "cityCode": request["cityCode"], "status": "needs-llm",
                "summary": f"Direct worker needs troubleshooting: {type(error).__name__}",
                "evidenceFiles": [str(evidence.relative_to(request_path.parent.parent))]}})
            return 0
    return _llm_worker_main(request_path, output_path)


def _llm_worker_main(request_path: Path, output_path: Path) -> int:
    request = read_json(request_path)
    sys.path.insert(0, str(LLM_DIR))
    from llm_cost import create_cli_llm, record_subscription_run, compute_cost
    llm = create_cli_llm("codex", repo="consensus-builder", script="parcel-qualification", cwd=request["cwd"])
    schema_path = request_path.parent / "output-schema.json"
    last_message = request_path.parent / "last-message.json"
    cli_log = request_path.parent / "codex.jsonl"
    atomic_json(schema_path, OUTPUT_SCHEMA)
    command = ["codex", "--ask-for-approval", "never", "--search", "exec", "--ephemeral",
               "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
               "-m", llm.model]
    if llm.effort:
        command += ["-c", f'model_reasoning_effort="{llm.effort}"']
    command += ["--json", "--output-schema", str(schema_path), "--output-last-message", str(last_message), "-"]
    with cli_log.open("w") as out:
        proc = subprocess.run(command, input=request["system"] + "\n\n" + request["prompt"],
                              cwd=request["cwd"], stdout=out, text=True, env=_strip_api_key_env())
    usage = {"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}
    for line in cli_log.read_text(errors="replace").splitlines():
        try: event = json.loads(line)
        except ValueError: continue
        if event.get("type") == "turn.completed":
            row = event.get("usage", {})
            cached = row.get("cached_input_tokens", 0)
            usage["input_tokens"] += max(0, row.get("input_tokens", 0) - cached)
            usage["cache_read_input_tokens"] += cached
            usage["output_tokens"] += row.get("output_tokens", 0)
    equivalent = None
    if any(usage.values()):
        try: equivalent = compute_cost(llm.model, usage)
        except Exception: pass
        try:
            record_subscription_run("consensus-builder", "parcel-qualification", llm.model, usage,
                                    equivalent_usd=equivalent, engine="codex", role="qualifier",
                                    cityCode=request["cityCode"], attempt=request["attempt"],
                                    effort=llm.effort, exitCode=proc.returncode)
        except Exception as exc:
            print(f"Usage ledger error: {type(exc).__name__}: {exc}", file=sys.stderr)
    data = read_json(last_message) if last_message.is_file() else None
    atomic_json(output_path, {"data":data,"usage":usage,"model":llm.model,"effort":llm.effort,"equivalent_usd":equivalent})
    return proc.returncode


class Runner:
    def __init__(self, args: argparse.Namespace, *, popen: Callable[..., Any] = subprocess.Popen,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 disk_usage: Callable[[Path], Any] = shutil.disk_usage):
        self.args = args
        self.root = Path(args.repo_root).resolve()
        self.source_root = Path(args.source_root or args.repo_root).resolve()
        self.queue_path = Path(args.queue)
        if not self.queue_path.is_absolute():
            self.queue_path = self.root / self.queue_path
        self.queue_path = self.queue_path.resolve()
        self.state_dir = Path(args.state_dir)
        if not self.state_dir.is_absolute():
            self.state_dir = self.root / self.state_dir
        self.state_dir = self.state_dir.resolve()
        self.state_path = self.state_dir / "state.json"
        self.events_path = self.state_dir / "events.jsonl"
        self.lock_path = self.state_dir / "runner.lock"
        self.popen, self.clock, self.sleep, self.disk_usage = popen, clock, sleep, disk_usage
        self.stop_requested = False
        self.active: dict[int, dict[str, Any]] = {}
        self._last_heartbeat = 0.0
        self._lock_stream = None
        self.records: list[dict[str, Any]] = []
        self.queue_hash = ""
        self.state: dict[str, Any] = {}

    def log(self, event: str, **fields: Any) -> None:
        append_jsonl(self.events_path, {"at": utc_now(), "event": event, **fields})
        print(f"[{utc_now()}] {event} " + json.dumps(fields, ensure_ascii=False), flush=True)

    def save(self) -> None:
        self.state["heartbeat"] = utc_now()
        self.state["activePids"] = sorted(self.active)
        atomic_json(self.state_path, self.state)

    def acquire(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._lock_stream = self.lock_path.open("a+")
        try:
            fcntl.flock(self._lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another qualification runner holds the singleton lock") from exc

    def initialize(self) -> None:
        self.records, self.queue_hash = load_queue(self.queue_path)
        if self.state_path.exists():
            self.state = read_json(self.state_path)
            if self.state.get("queueSha256") != self.queue_hash:
                raise RuntimeError("immutable queue SHA-256 changed; refusing to resume")
            self.state["status"] = "running"
            self.state.pop("resourceReason", None)
            cities = self.state.setdefault("cities", {})
        else:
            self.state = {"schemaVersion": 1, "runId": str(uuid.uuid4()), "pid": os.getpid(),
                          "runnerScript": str(Path(__file__).resolve()), "startedAt": utc_now(),
                          "queuePath": str(self.queue_path), "queueSha256": self.queue_hash,
                          "cityCount": len(self.records), "status": "running", "activePids": [], "cities": {}}
            cities = self.state["cities"]
        for city in self.records:
            code = str(city["cityCode"])
            entry = cities.setdefault(code, {"status": "pending", "attempts": 0, "summary": "", "evidenceFiles": []})
            city_dir = self.city_dir(code)
            if entry.get("status") in {"technical-qualified", "held", "excluded"} and not valid_terminal_artifact(city_dir, city, entry):
                entry.update(status="pending", summary="", evidenceFiles=[], artifactRecheck="prior terminal claim lacked verifiable durable artifacts")
            elif entry.get("status") == "resource-held" and self.city_bytes(city_dir) < MAX_CITY_BYTES:
                entry.update(status="pending", summary="", evidenceFiles=[])
            elif entry.get("status") == "needs-llm" and not getattr(self.args, "direct_only", False):
                entry.update(status="pending", phase="llm")
        self.state["pid"] = os.getpid()
        self.state["executionMode"] = "direct-first"
        self.state["directWorkers"] = self.args.workers
        self.state["llmWorkers"] = getattr(self.args, "llm_workers", 1)
        for entry in cities.values():
            if entry.get("status") == "running":
                entry.update(status="pending", pid=None, summary="Interrupted attempt; retry from retained artifacts")
        self.save()

    def city_dir(self, code: str) -> Path:
        return self.state_dir / "cities" / code

    def free_bytes(self) -> int:
        return int(self.disk_usage(self.state_dir).free)

    def city_bytes(self, path: Path) -> int:
        total = 0
        if path.exists():
            for root, _dirs, files in os.walk(path, followlinks=False):
                for name in files:
                    try:
                        item = Path(root) / name
                        if not item.is_symlink(): total += item.stat().st_size
                    except OSError:
                        continue
        return total

    def _start(self, city: dict[str, Any]) -> dict[str, Any]:
        code = str(city["cityCode"])
        entry = self.state["cities"][code]
        attempt = int(entry.get("attempts", 0)) + 1
        city_dir = self.city_dir(code)
        attempt_dir = city_dir / f"attempt-{attempt:02d}"
        attempt_dir.mkdir(parents=True, exist_ok=False)
        phase = entry.get("phase", "direct")
        prompt = city_prompt(city, self.source_root, self.root, city_dir, attempt_dir)
        if phase == "llm" and entry.get("directAttemptDir"):
            prompt += f"\nA deterministic attempt already ran. Read its retained evidence at `{entry['directAttemptDir']}` and address its recorded failed gates; do not repeat discovery or overwrite prior evidence.\n"
        (attempt_dir / "prompt.md").write_text(prompt, encoding="utf-8")
        request_path, answer_path = attempt_dir / "worker-request.json", attempt_dir / "worker-answer.json"
        atomic_json(request_path, {"cityCode": code, "attempt": attempt, "cwd": str(attempt_dir),
                                   "city": city, "phase": phase, "repoRoot": str(self.root), "sourceRoot": str(self.source_root),
                                   "timeoutMs": self.args.max_turn_minutes * 60 * 1000,
                                   "system": "Follow the task exactly. Keep evidence complete, bounded, and safe; never alter the source repository.",
                                   "prompt": prompt})
        stdout_path, stderr_path = attempt_dir / "stdout.jsonl", attempt_dir / "stderr.log"
        out, err = stdout_path.open("w", encoding="utf-8"), stderr_path.open("w", encoding="utf-8")
        command = [sys.executable, str(Path(__file__).resolve()), "--_worker", str(request_path), str(answer_path)]
        process = self.popen(command, cwd=attempt_dir, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                             start_new_session=True, env=_strip_api_key_env())
        entry.update(status="running", attempts=attempt, currentAttempt=attempt,
                     phase=phase, phaseAttempts=int(entry.get("phaseAttempts", 0)) + 1,
                     currentDir=str(attempt_dir), pid=process.pid, startedAt=utc_now())
        item = {"city": city, "process": process, "attempt": attempt, "cityDir": city_dir, "started": self.clock(),
                "attemptDir": attempt_dir, "answerPath": answer_path, "stdout": out, "stderr": err,
                "timedOut": False, "termAt": None, "resourceHeld": False, "phase": phase}
        self.active[process.pid] = item
        self.log("worker-started", cityCode=code, attempt=attempt, phase=phase, pid=process.pid, workdir=str(attempt_dir))
        self.save()
        return item

    def _kill(self, item: dict[str, Any], sig: int) -> None:
        proc = item["process"]
        try: os.killpg(proc.pid, sig)
        except ProcessLookupError: pass

    def request_stop(self, _signum=None, _frame=None) -> None:
        self.stop_requested = True

    def _heartbeat_if_due(self, force: bool = False) -> None:
        now = self.clock()
        if force or now - self._last_heartbeat >= HEARTBEAT_SECONDS:
            self._last_heartbeat = now
            self.save()

    def _verify_worker_answer(self, item: dict[str, Any]) -> dict[str, Any]:
        answer = read_json(item["answerPath"])
        data = answer.get("data")
        code = str(item["city"]["cityCode"])
        if not isinstance(data, dict) or str(data.get("cityCode")) != code:
            raise ValueError("worker returned invalid JSON or wrong cityCode")
        status = data.get("status")
        allowed = {"technical-qualified", "held", "excluded"}
        if answer.get("executionMode") == "direct" and item.get("phase") == "direct":
            allowed.add("needs-llm")
        if status not in allowed or not str(data.get("summary", "")).strip():
            raise ValueError("worker result lacks an allowed status or substantive summary")
        evidence = data.get("evidenceFiles")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("worker result must name existing evidence files")
        evidence = list(evidence)
        for path in evidence:
            if not isinstance(path, str) or not safe_relative(item["cityDir"], path).is_file():
                raise ValueError(f"worker evidence path is missing or outside city workdir: {path}")
        if status == "excluded":
            exclusion_rel = item["attemptDir"].relative_to(item["cityDir"]).as_posix() + "/evidence/exclusion.json"
            exclusion_path = safe_relative(item["cityDir"], exclusion_rel)
            exclusion = read_json(exclusion_path)
            if exclusion.get("parcelPurpose") is not False or not str(exclusion.get("sourceUrl", "")).startswith("https://") or not str(exclusion.get("excerpt", "")).strip():
                raise ValueError("excluded result lacks positive first-party non-parcel evidence")
            if exclusion_rel not in evidence:
                raise ValueError("excluded evidence list must include evidence/exclusion.json")
        if status == "technical-qualified":
            # Recompute geometry QA with the trusted script rather than accept the worker's metric verdict.
            independent = item["attemptDir"] / "evidence" / "independent-metric-report.json"
            candidate = read_json(item["attemptDir"] / "candidate.json")
            q = read_json(item["attemptDir"] / "evidence" / "qualification.json")
            cache_path = safe_relative(item["attemptDir"] / "evidence", q["cacheFile"])
            run = subprocess.run([sys.executable, str(self.root / "scripts/parcel-qualification-metric.py"),
                                  str(cache_path), str(independent), "--source-crs", "EPSG:4326",
                                  "--metric-epsg", str(candidate["metricEpsg"]).removeprefix("EPSG:")],
                                 capture_output=True, text=True, timeout=120)
            audit = read_json(independent) if run.returncode in {0, 2} and independent.exists() else {}
            if audit.get("inputSha256") != sha256_file(cache_path) or audit.get("geometryChangedOrRepaired") is not False:
                raise ValueError("Independent geometry report does not bind to the unchanged parcel cache")
            ok, reason = verify_technical_artifacts(item["attemptDir"], code)
            if not ok:
                raise ValueError(reason)
            candidate = read_json(item["attemptDir"] / "candidate.json")
            candidate_city = candidate.get("city", {})
            expected_point = [float(item["city"]["point"][1]), float(item["city"]["point"][0])]
            actual_point = candidate_city.get("point")
            if candidate_city.get("code") != code or candidate_city.get("name") != item["city"]["cityName"]:
                raise ValueError("candidate city identity does not match frozen queue")
            if not isinstance(actual_point, list) or len(actual_point) != 2 or any(
                not isinstance(actual_point[i], (int, float)) or actual_point[i] != expected_point[i]
                for i in range(2)
            ):
                raise ValueError("candidate point does not match frozen queue [latitude, longitude]")
            prefix = item["attemptDir"].relative_to(item["cityDir"]).as_posix() + "/"
            trusted_reports = [
                prefix + "evidence/independent-metric-report.json",
                prefix + "evidence/initial-review.json",
            ]
            alignment_report = prefix + "evidence/independent-alignment-report.json"
            if safe_relative(item['cityDir'], alignment_report).is_file():
                trusted_reports.append(alignment_report)
            for report in trusted_reports:
                if not safe_relative(item["cityDir"], report).is_file():
                    raise ValueError(f"trusted independent report is missing: {report}")
                if report not in evidence:
                    evidence.append(report)
            required = {prefix + "candidate.json", prefix + "evidence/qualification.json",
                        *(prefix + "evidence/" + name for name in (
                            "full-safe.geojson", "independent-metric-report.json", "initial-review.json"))}
            if not required.issubset(set(evidence)):
                raise ValueError("technical-qualified evidence list must include candidate, full-safe cache, and initial review")
        return {"status": status, "summary": data["summary"], "evidenceFiles": evidence,
                **({'initialQualification': read_json(item['attemptDir'] / 'evidence/initial-review.json')} if status == 'technical-qualified' else {}),
                "model": answer.get("model"), "usage": answer.get("usage"),
                "equivalent_usd": answer.get("equivalent_usd")}

    def _finish_item(self, item: dict[str, Any], error: str | None = None) -> None:
        code = str(item["city"]["cityCode"])
        entry = self.state["cities"][code]
        for key in ("stdout", "stderr"):
            try: item[key].close()
            except Exception: pass
        try:
            if error is None:
                result = self._verify_worker_answer(item)
                # --direct-only leaves troubleshooting to an external worker (see --record-answer).
                direct_only = getattr(self.args, "direct_only", False)
                entry.update(status=("needs-llm" if direct_only else "pending") if result["status"] == "needs-llm" else result["status"], summary=result["summary"], evidenceFiles=result["evidenceFiles"],
                             pid=None, finishedAt=utc_now(), currentAttempt=None)
                if 'initialQualification' in result:
                    entry['initialQualification'] = result['initialQualification']
                if result["status"] == "needs-llm":
                    entry.update(phase="llm", phaseAttempts=0, directAttemptDir=str(item["attemptDir"]))
                self.log("city-finished", cityCode=code, attempt=item["attempt"], status=result["status"], summary=result["summary"])
            else:
                err_path = item["attemptDir"] / "worker-error.txt"
                err_path.write_text(error, encoding="utf-8")
                if entry.get("phaseAttempts", entry["attempts"]) < self.args.max_retries:
                    entry.update(status="pending", summary=error, pid=None, currentAttempt=None,
                                 lastErrorPath=str(err_path.relative_to(item["cityDir"])))
                else:
                    entry.update(status="held", summary=f"Qualification attempt limit reached: {error}", pid=None,
                                 finishedAt=utc_now(), currentAttempt=None,
                                 evidenceFiles=[str(err_path.relative_to(item["cityDir"]))])
                self.log("city-attempt-failed", cityCode=code, attempt=item["attempt"], error=error, status=entry["status"])
        except Exception as exc:
            err_path = item["attemptDir"] / "worker-error.txt"
            err_path.write_text(f"{type(exc).__name__}: {exc}\n", encoding="utf-8")
            if entry.get("phaseAttempts", entry["attempts"]) < self.args.max_retries:
                entry.update(status="pending", summary=str(exc), pid=None, currentAttempt=None,
                             lastErrorPath=str(err_path.relative_to(item["cityDir"])))
            else:
                entry.update(status="held", summary=f"Qualification attempt limit reached: {exc}", pid=None,
                             finishedAt=utc_now(), currentAttempt=None,
                             evidenceFiles=[str(err_path.relative_to(item["cityDir"]))])
            self.log("city-result-rejected", cityCode=code, attempt=item["attempt"], error=f"{type(exc).__name__}: {exc}", status=entry["status"])
        self.active.pop(item["process"].pid, None)
        self.save()

    def _fill_slots(self, launched: list[dict[str, Any]]) -> None:
        pending = [city for city in self.records if self.state["cities"][str(city["cityCode"])].get("status") == "pending"]
        counts = {phase: sum(item.get("phase", "llm") == phase for item in launched) for phase in ("direct", "llm")}
        limits = {"direct": self.args.workers, "llm": getattr(self.args, "llm_workers", 1)}
        for city in pending:
            phase = self.state["cities"][str(city["cityCode"])].get("phase", "direct")
            if counts[phase] >= limits[phase]: continue
            if self.stop_requested: break
            if self.free_bytes() < MIN_FREE_BYTES:
                self.state["status"] = "resource-held"
                self.state["resourceReason"] = "free disk space is below 3 GiB; no new worker launched"
                self.log("resource-held", freeBytes=self.free_bytes(), requiredBytes=MIN_FREE_BYTES)
                self.save()
                return
            city_dir = self.city_dir(str(city["cityCode"]))
            city_dir.mkdir(parents=True, exist_ok=True)
            if self.city_bytes(city_dir) >= MAX_CITY_BYTES:
                entry = self.state["cities"][str(city["cityCode"])]
                entry.update(status="resource-held", summary="City qualification workspace reached the 250 MiB cap.",
                             finishedAt=utc_now(), evidenceFiles=[])
                self.log("city-resource-held", cityCode=str(city["cityCode"]), bytes=self.city_bytes(city_dir))
                self.save()
                continue
            try:
                launched.append(self._start(city))
                counts[phase] += 1
            except Exception as exc:
                entry = self.state["cities"][str(city["cityCode"])]
                entry["attempts"] = int(entry.get("attempts", 0)) + 1
                city_dir = self.city_dir(str(city["cityCode"]))
                city_dir.mkdir(parents=True, exist_ok=True)
                err_path = city_dir / f"start-error-{entry['attempts']:02d}.txt"
                err_path.write_text(str(exc), encoding="utf-8")
                entry.update(status="pending" if entry["attempts"] < self.args.max_retries else "held",
                             summary=f"Worker could not start: {exc}", finishedAt=utc_now(),
                             evidenceFiles=[err_path.name])
                self.log("worker-start-failed", cityCode=str(city["cityCode"]), error=str(exc), status=entry["status"])
                self.save()

    def run_batch(self) -> None:
        launched: list[dict[str, Any]] = []
        self._fill_slots(launched)
        while launched:
            if self.stop_requested:
                for item in launched: self._kill(item, signal.SIGTERM)
                deadline = self.clock() + TERM_GRACE_SECONDS
                while self.clock() < deadline and any(item["process"].poll() is None for item in launched):
                    self.sleep(POLL_SECONDS)
                for item in launched:
                    if item["process"].poll() is None: self._kill(item, signal.SIGKILL)
                for item in launched:
                    self._finish_item(item, "runner interrupted by SIGTERM")
                launched.clear()
                break
            for item in list(launched):
                proc = item["process"]
                code = str(item["city"]["cityCode"])
                bytes_on_disk = self.city_bytes(item["cityDir"])
                if bytes_on_disk > MAX_CITY_BYTES and proc.poll() is None and not item["resourceHeld"]:
                    item["resourceHeld"] = True
                    self._kill(item, signal.SIGTERM)
                    item["termAt"] = self.clock()
                    self.state["cities"][code].update(status="resource-held", summary="City qualification workspace exceeded the 250 MiB cap; files were preserved.")
                    self.log("city-resource-held", cityCode=code, bytes=bytes_on_disk)
                if proc.poll() is None and self.clock() - item["started"] >= self.args.max_turn_minutes * 60:
                    if item["termAt"] is None:
                        item["timedOut"] = True
                        item["termAt"] = self.clock()
                        self._kill(item, signal.SIGTERM)
                        self.log("worker-timeout-term", cityCode=code, pid=proc.pid)
                    elif self.clock() - item["termAt"] >= TERM_GRACE_SECONDS:
                        self._kill(item, signal.SIGKILL)
                if proc.poll() is None and item["termAt"] is not None and self.clock() - item["termAt"] >= TERM_GRACE_SECONDS:
                    self._kill(item, signal.SIGKILL)
                if proc.poll() is not None:
                    launched.remove(item)
                    if item["resourceHeld"]:
                        self._finish_item(item, "city workspace exceeded 250 MiB resource cap")
                        self.state["cities"][code].update(status="resource-held", summary="City workspace exceeded 250 MiB; artifacts preserved for review.")
                        self.save()
                    elif item["timedOut"]:
                        self._finish_item(item, "Codex turn reached the configured time limit")
                    elif proc.returncode != 0:
                        stderr = (item["attemptDir"] / "stderr.log").read_text(errors="replace")
                        self._finish_item(item, f"Codex worker exited {proc.returncode}: {stderr[-1000:]}")
                    else:
                        self._finish_item(item)
            # Each finished city frees its own slot immediately; slow exception work cannot
            # hold the direct queue behind a batch barrier.
            if not self.args.once and self.state.get("status") != "resource-held":
                self._fill_slots(launched)
            self._heartbeat_if_due()
            if launched: self.sleep(POLL_SECONDS)

    def run(self) -> int:
        self.acquire()
        self.initialize()
        previous = signal.signal(signal.SIGTERM, self.request_stop)
        try:
            while True:
                if self.stop_requested:
                    self.state["status"] = "stopped"
                    break
                if self.state.get("status") == "resource-held": break
                pending = [city for city in self.records if self.state["cities"][str(city["cityCode"])].get("status") == "pending"]
                if not pending:
                    resource_held = any(
                        self.state["cities"][str(city["cityCode"])].get("status") == "resource-held"
                        for city in self.records
                    )
                    needs_llm = any(e.get("status") == "needs-llm" for e in self.state["cities"].values())
                    self.state["status"] = "resource-held" if resource_held else ("direct-complete-needs-llm" if needs_llm else "complete-with-holds" if any(e.get("status") == "held" for e in self.state["cities"].values()) else "complete-needs-review")
                    break
                self.state["status"] = "running"
                self.run_batch()
                if self.args.once:
                    pending_after_batch = any(
                        self.state["cities"][str(city["cityCode"])].get("status") == "pending"
                        for city in self.records
                    )
                    resource_held = any(
                        self.state["cities"][str(city["cityCode"])].get("status") == "resource-held"
                        for city in self.records
                    )
                    self.state["status"] = "paused" if pending_after_batch else ("resource-held" if resource_held else "complete")
                    break
            self.save()
            return 2 if self.state["status"] in {"resource-held", "complete-with-holds"} else 0
        finally:
            signal.signal(signal.SIGTERM, previous)
            if self._lock_stream:
                fcntl.flock(self._lock_stream.fileno(), fcntl.LOCK_UN)
                self._lock_stream.close()


def record_answer(args: argparse.Namespace) -> dict[str, Any]:
    """Verify and record an external worker's attempt for a city left at needs-llm.

    The worker writes candidate.json, evidence/ and worker-answer.json ({"data": {cityCode, status,
    summary, evidenceFiles}}) in a new attempt directory under the city's directory. The runner,
    not the worker, decides: technical-qualified is accepted only after its own independent metric
    recomputation and artifact checks.
    """
    runner = Runner(args)
    runner.acquire()
    try:
        runner.records, runner.queue_hash = load_queue(runner.queue_path)
        runner.state = read_json(runner.state_path)
        if runner.state.get("queueSha256") != runner.queue_hash:
            raise RuntimeError("immutable queue SHA-256 changed; refusing to record")
        attempt_dir = Path(args.record_answer).resolve()
        code = attempt_dir.parent.name
        city = next((c for c in runner.records if str(c["cityCode"]) == code), None)
        entry = runner.state["cities"].get(code)
        if city is None or entry is None:
            raise ValueError(f"attempt directory {attempt_dir} does not belong to a queued city")
        if attempt_dir.parent != runner.city_dir(code).resolve() or not attempt_dir.name.startswith("attempt-"):
            raise ValueError("attempt directory must be cities/<code>/attempt-NN inside the state directory")
        if entry.get("status") not in {"needs-llm", "held", "pending"}:
            raise ValueError(f"city {code} is {entry.get('status')}; only needs-llm/held/pending cities take an external answer")
        answer_path = attempt_dir / "worker-answer.json"
        raw = read_json(answer_path)
        atomic_json(answer_path, {"executionMode": "external", "data": raw.get("data", raw),
                                  "model": raw.get("model"), "usage": raw.get("usage")})
        item = {"city": city, "cityDir": runner.city_dir(code).resolve(), "attemptDir": attempt_dir,
                "answerPath": answer_path, "phase": "llm"}
        result = runner._verify_worker_answer(item)
        entry.update(status=result["status"], summary=result["summary"], evidenceFiles=result["evidenceFiles"],
                     currentDir=str(attempt_dir), finishedAt=utc_now(), phase="llm",
                     externalWorker=raw.get("model") or "external")
        if 'initialQualification' in result:
            entry['initialQualification'] = result['initialQualification']
        runner.log("city-finished", cityCode=code, attempt=attempt_dir.name, status=result["status"],
                   summary=result["summary"], worker="external")
        runner.save()
        return {"cityCode": code, "status": result["status"]}
    finally:
        if runner._lock_stream:
            fcntl.flock(runner._lock_stream.fileno(), fcntl.LOCK_UN)
            runner._lock_stream.close()


def status_report(state_dir: Path) -> dict[str, Any]:
    path = state_dir / "state.json"
    if not path.exists(): return {"status": "not-started", "statePath": str(path)}
    state = read_json(path)
    counts: dict[str, int] = {}
    for item in state.get("cities", {}).values():
        status = item.get("status", "unknown")
        counts[status] = counts.get(status, 0) + 1
    pid = state.get("pid")
    alive = False
    identity_verified = False
    if isinstance(pid, int):
        try:
            os.kill(pid, 0)
            alive = True
            command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True,
                                     text=True, timeout=2, check=False).stdout
            identity_verified = alive and state.get("runnerScript") == str(Path(__file__).resolve()) and str(Path(__file__).resolve()) in command
        except (ProcessLookupError, PermissionError): pass
        except (OSError, subprocess.SubprocessError): pass
    heartbeat = state.get("heartbeat")
    age = None
    if heartbeat:
        try: age = max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(heartbeat)).total_seconds()))
        except Exception: pass
    return {"status": state.get("status"), "runId": state.get("runId"), "pid": pid,
            "pidAlive": alive, "pidIdentityVerified": identity_verified,
            "heartbeat": heartbeat, "heartbeatAgeSeconds": age, "queueSha256": state.get("queueSha256"),
            "cityCount": state.get("cityCount"), "counts": counts, "activePids": state.get("activePids", []),
            "statePath": str(path), "resourceReason": state.get("resourceReason"),
            "executionMode": state.get("executionMode"), "directWorkers": state.get("directWorkers"),
            "llmWorkers": state.get("llmWorkers"),
            "pendingByPhase": {phase: sum(e.get("status") == "pending" and e.get("phase", "direct") == phase
                                          for e in state.get("cities", {}).values()) for phase in ("direct", "llm")}}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--record-answer", metavar="ATTEMPT_DIR",
                      help="verify and record an external worker's attempt for a needs-llm city")
    parser.add_argument("--queue")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--source-root")
    parser.add_argument("--state-dir", default="tmp/parcel-qualification")
    parser.add_argument("--workers", type=int, choices=range(1, 4), default=3)
    parser.add_argument("--llm-workers", type=int, choices=range(1, 4), default=1)
    parser.add_argument("--max-turn-minutes", type=int, default=45)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--direct-only", action="store_true",
                        help="stop cities that need troubleshooting at needs-llm instead of launching an LLM worker")
    args = parser.parse_args(argv)
    if (args.run or args.record_answer) and not args.queue: parser.error("--queue is required with --run/--record-answer")
    if args.max_turn_minutes < 1 or args.max_retries < 1: parser.error("time and retry limits must be positive")
    return args


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--_worker":
        if len(argv) != 3: return 2
        return _worker_main(Path(argv[1]), Path(argv[2]))
    args = parse_args(argv)
    if args.status:
        state_dir = Path(args.state_dir)
        if not state_dir.is_absolute(): state_dir = Path(args.repo_root) / state_dir
        print(json.dumps(status_report(state_dir.resolve()), indent=2))
        return 0
    if args.record_answer:
        print(json.dumps(record_answer(args), indent=2))
        return 0
    runner = Runner(args)
    return runner.run()


if __name__ == "__main__":
    raise SystemExit(main())
