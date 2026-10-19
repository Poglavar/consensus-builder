#!/usr/bin/env python3
"""Serial, resumable Codex worker for parcel adapter implementation and live qualification.

The queue is immutable for a run. Adapter workers may change only backend/parcels code and
backend/test focused tests in the dedicated adapter worktree. Qualification seeds are read-only;
worker output and durable state live under --state-dir (default: tmp/parcel-adapter-build-20261011).
"""
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
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).resolve()
DEFAULT_STATE = Path("tmp/parcel-adapter-build-20261011")
MAX_TURN_SECONDS = 45 * 60
MAX_ATTEMPTS = 2
MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
HEARTBEAT_SECONDS = 10
TERM_GRACE_SECONDS = 10
POLL_SECONDS = 1
OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "taskId": {"type": "string"},
        "status": {"type": "string", "enum": ["built", "blocked-source"]},
        "changedFiles": {"type": "array", "items": {"type": "string"}},
        "testEvidence": {"type": "array", "items": {"type": "string"}},
        "qualificationEvidence": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["taskId", "status", "changedFiles", "testEvidence", "qualificationEvidence", "summary"],
}
ALLOWED_CHANGE_ROOTS = ("backend/parcels/", "backend/test/")
sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
from parcel_qualification_policy import REQUIRED_CHECKS as REQUIRED_QUALIFICATION_CHECKS
BLOCKED_ADAPTER_RE = re.compile(
    r"\b(?:(?:adapter|protocol|implementation)\s+(?:is\s+)?(?:missing|unsupported|not supported|unimplemented|not implemented)|"
    r"(?:missing|no|unsupported|not supported|unimplemented|not implemented)\s+(?:the\s+)?(?:production\s+)?(?:adapter|implementation))\b", re.I)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip_api_key_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """Do not pass API-key variables to a subscription CLI worker."""
    result = dict(os.environ if env is None else env)
    for key in list(result):
        if re.search(r"(?:^|_)(?:API_KEY|APIKEY)$", key, re.I):
            result.pop(key, None)
    return result


def llm_cost_module(repo_root: Path | None = None):
    configured = os.environ.get("LLM_COST_DIR")
    root = (repo_root or Path.cwd()).resolve()
    candidates = [Path(configured)] if configured else []
    candidates.extend(parent / "agents/lib/llm-cost" for parent in [root, *root.parents])
    candidates.extend(parent / "agents/lib/llm-cost" for parent in [Path.cwd().resolve(), *Path.cwd().resolve().parents])
    llm_dir = next((p.resolve() for p in candidates if (p / "llm_cost.py").is_file()), None)
    if llm_dir is None:
        raise FileNotFoundError("shared agents/lib/llm-cost/llm_cost.py was not found relative to the repo root")
    if str(llm_dir) not in sys.path:
        sys.path.insert(0, str(llm_dir))
    import llm_cost  # type: ignore[import-not-found]
    return llm_cost


def codex_usage(stream: str) -> dict[str, int] | None:
    total = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
             "cache_creation_input_tokens": 0}
    seen = False
    for line in stream.splitlines():
        try:
            event = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(event, dict) or event.get("type") != "turn.completed":
            continue
        use = event.get("usage")
        if not isinstance(use, dict):
            continue
        seen = True
        cached = int(use.get("cached_input_tokens") or 0)
        total["input_tokens"] += max(0, int(use.get("input_tokens") or 0) - cached)
        total["cache_read_input_tokens"] += cached
        total["cache_creation_input_tokens"] += int(use.get("cache_write_input_tokens") or 0)
        total["output_tokens"] += int(use.get("output_tokens") or 0)
    return total if seen else None


def load_queue(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    doc = json.loads(raw)
    tasks = doc.get("tasks") if isinstance(doc, dict) else None
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("queue must contain a non-empty top-level tasks array")
    ids: set[str] = set()
    for i, task in enumerate(tasks):
        if not isinstance(task, dict):
            raise ValueError(f"task {i} must be an object")
        for key in ("taskId", "sourceId", "protocol", "requiredBehavior"):
            if not isinstance(task.get(key), str) or not task[key].strip():
                raise ValueError(f"task {i} requires non-empty string {key}")
        if task["taskId"] in ids:
            raise ValueError(f"duplicate taskId: {task['taskId']}")
        ids.add(task["taskId"])
        seeds = task.get("qualificationSeeds")
        if not isinstance(seeds, list) or not seeds:
            raise ValueError(f"task {task['taskId']} requires qualificationSeeds")
        for j, seed in enumerate(seeds):
            if not isinstance(seed, dict) or not str(seed.get("cityCode", "")).strip():
                raise ValueError(f"task {task['taskId']} seed {j} requires cityCode")
            if not isinstance(seed.get("candidatePath"), str) or not seed["candidatePath"].strip():
                raise ValueError(f"task {task['taskId']} seed {j} requires candidatePath")
            digest = seed.get("candidateSha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError(f"task {task['taskId']} seed {j} requires candidateSha256")
        if not isinstance(task.get("sourceEvidence"), (str, list, dict)) or not task["sourceEvidence"]:
            raise ValueError(f"task {task['taskId']} requires sourceEvidence")
    return tasks, hashlib.sha256(raw).hexdigest()


def safe_under(root: Path, path_value: str) -> Path:
    path = Path(path_value)
    resolved = path.resolve() if path.is_absolute() else (root / path).resolve()
    resolved.relative_to(root.resolve())
    return resolved


def is_backend_test_file(path: str) -> bool:
    return path.startswith("backend/test/") and bool(re.search(r"\.test\.(?:js|mjs|cjs)$", path, re.I))


def is_backend_test_fixture(path: str) -> bool:
    return path.startswith("backend/test/fixtures/") and not path.endswith("/")


def allowed_change(path: str) -> bool:
    return path.startswith("backend/parcels/") or is_backend_test_file(path) or is_backend_test_fixture(path)


def worker_prompt(task: dict[str, Any], repo: Path, qual_root: Path, attempt_dir: Path) -> str:
    seed_rows = [{"cityCode": seed["cityCode"], "candidatePath": str(safe_under(qual_root, seed["candidatePath"])),
                  "candidateSha256": seed["candidateSha256"]} for seed in task["qualificationSeeds"]]
    qualifier = find_qualifier(repo, qual_root)
    return f"""Implement and prove the missing parcel adapter for this frozen task. Do not stop merely because the requested adapter does not exist yet: implement it in production code, add focused tests, then run a saved live qualification against the source candidate(s). Return blocked-source only for a genuine, evidenced source limitation (for example a stable public endpoint denial, malformed publisher data, or no source feature for every bounded probe after the adapter is working), never because adapter code is missing.

Task:
```json
{json.dumps(task, ensure_ascii=False, indent=2)}
```

Read-only qualification seed candidates (do not modify):
{json.dumps(seed_rows, ensure_ascii=False, indent=2)}
Repository root: `{repo}`
Existing qualification worktree (read-only inputs): `{qual_root}`
Attempt/evidence directory: `{attempt_dir}`

Ownership and safety:
- Write production changes only under `backend/parcels/`; write tests only under `backend/test/` using node:test so the independent headless runner can execute them. Do not install into or mutate a shared node_modules symlink. Keep personal names and home paths out of committable code.
- Never edit city configs, source catalog, research packets, app/runtime files, or anything under the qualification worktree.
- Preserve existing adapter behavior. Use schema/metadata-first inspection and safe native ID plus geometry fields only; never request or save owner, address, tax/account, or other personal fields.
- Initial qualification uses parcel-availability-v1: confirm parcel purpose, working exact reads and repeatable usable polygon output. Native CRS/axis/operation/grid uncertainty, detailed geometry findings, absence/completeness and binding limitations are recorded second-pass follow-ups. Preserve source geometry and every actual check result. Do not require perfect projection proof or perform a deep review before qualifying an otherwise working source.
- Bound live queries and downloads. Do not bypass authentication, CAPTCHA, throttles, or access controls. Do not repair, simplify, clip, union, or silently drop source geometry.
- Add unit tests for protocol parsing, safe identity, paging/limits, errors, and any source-specific edge case. Run focused tests and report exact commands/results.
- Verify every source seed SHA-256 before and after use. Keep each seed candidate read-only. When the new adapter or verified source profile needs descriptor changes, derive a candidate under `{attempt_dir}/qualification/<cityCode>/candidate-derived.json`, changing only the adapter-specific descriptor fields needed by the new implementation. Preserve all frozen source/city/identity fields. Save a sibling `candidate-provenance.json` with seed path/hash, derived path/hash, sourceId and the exact descriptor changes. Never edit the seed.
- For every seed candidate, run the repository qualifier below using the newly implemented adapter from this worktree, writing output only below `{attempt_dir}/qualification/<cityCode>/evidence/`. Use the derived candidate when descriptor changes are needed; otherwise use the frozen seed:
  `node {qualifier} --candidate <candidate path> --output {attempt_dir}/qualification/<cityCode>/evidence --metric-script {repo / "scripts/parcel-qualification-metric.py"}`
- Save the command, exit code, and live result. Create `{attempt_dir}/qualification-manifest.json` with `requiredChecks` exactly `classification`, `exactIds`, `stableGeometry`, and one entry per seed: `cityCode`, `seedPath`, `seedSha256`, `candidateUsedPath`, `candidateUsedSha256`, `qualificationPath`, `qualifierExitCode`, `qualificationStatus`. Include that manifest, each qualification JSON, and each available alignment evidence pack, metadata, native sample, and report in `qualificationEvidence`. A `built` result requires the three core parcel-availability checks and usable hash-bound polygons. Preserve quality findings and missing alignment as follow-up notes. If a source is genuinely blocked, retain bounded request/response/error and failed qualification output. Do not label an adapter missing-code error as blocked-source.
- Do not commit, push, deploy, or alter unrelated existing edits. Report every file changed by this task, including any files changed by an earlier retry.

Return exactly JSON matching the provided schema. `built` requires actual adapter implementation, passing tests, and saved live source qualification evidence. `blocked-source` requires source-grounded evidence of a genuine block and must explain why adapter implementation alone cannot resolve it.
"""


def find_qualifier(repo: Path, qual_root: Path) -> Path:
    candidates = [repo / "scripts/qualify-parcel-source.mjs",
                  qual_root / "scripts/qualify-parcel-source.mjs",
                  repo / "scripts/qualify-source.mjs",
                  qual_root / "scripts/qualify-source.mjs"]
    return next((path.resolve() for path in candidates if path.is_file()), candidates[0].resolve())


def verify_saved_alignment(qualification: dict[str, Any], candidate: dict[str, Any], candidate_path: Path,
                          qualification_path: Path, task: dict[str, Any],
                          seed: dict[str, Any]) -> tuple[bool, str]:
    """Hash-check saved native evidence, then recompute its published CRS operation independently."""
    try:
        evidence_dir = qualification_path.parent
        evidence_path = evidence_dir / "alignment-evidence.json"
        evidence_bytes = evidence_path.read_bytes()
        evidence = json.loads(evidence_bytes)
        check = qualification.get("checks", {}).get("alignment", {})
        contract_sha = check.get("contractSha256")
        source_id = task["sourceId"]
        city_code = str(seed["cityCode"])
        if (evidence.get("sourceId") != source_id or str(evidence.get("cityCode")) != city_code
                or not isinstance(contract_sha, str) or evidence.get("contractSha256") != contract_sha):
            return False, "evidence source/city/coordinate contract mismatch"
        if any(key in evidence for key in ("offset", "translation", "fit", "correction", "towgs84")):
            return False, "empirical coordinate correction is present"

        def verify_input(file_key: str, hash_key: str) -> tuple[Path, str]:
            value = evidence.get(file_key)
            if not isinstance(value, str) or Path(value).is_absolute():
                raise ValueError(f"{file_key} must be a relative evidence path")
            path = safe_under(evidence_dir, value)
            digest = file_sha256(path)
            if digest != evidence.get(hash_key):
                raise ValueError(f"{file_key} SHA-256 mismatch")
            return path, digest

        _, metadata_sha = verify_input("metadataFile", "metadataSha256")
        _, native_sha = verify_input("nativeFile", "nativeSha256")
        if not evidence.get("metadataUrl", "").startswith("https://"):
            return False, "first-party metadata URL is missing"
        cache_value = qualification.get("cacheFile")
        if not isinstance(cache_value, str):
            return False, "qualification cache path is missing"
        cache_path = safe_under(evidence_dir, cache_value)
        cache_sha = file_sha256(cache_path)
        if cache_sha != qualification.get("cacheSha256"):
            return False, "full-safe cache SHA-256 mismatch"

        reference = candidate.get("alignmentEvidence")
        if reference is not None:
            if not isinstance(reference, dict) or not isinstance(reference.get("file"), str):
                return False, "candidate alignmentEvidence reference is malformed"
            original_path = safe_under(candidate_path.parent, reference["file"])
            original_bytes = original_path.read_bytes()
            original = json.loads(original_bytes)
            if (hashlib.sha256(original_bytes).hexdigest() != reference.get("sha256")
                    or original.get("sourceId") != source_id or str(original.get("cityCode")) != city_code
                    or original.get("contractSha256") != contract_sha
                    or original.get("metadataSha256") != metadata_sha
                    or original.get("nativeSha256") != native_sha):
                return False, "candidate hash-bound native evidence differs from saved qualification pack"
            for file_key, hash_key in (("metadataFile", "metadataSha256"), ("nativeFile", "nativeSha256")):
                original_input = safe_under(original_path.parent, original.get(file_key, ""))
                if file_sha256(original_input) != original.get(hash_key):
                    return False, f"candidate {file_key} SHA-256 mismatch"

        report_value = qualification.get("alignmentReport")
        if not isinstance(report_value, str) or not report_value:
            return False, "qualification alignmentReport path is missing"
        saved_report = json.loads(safe_under(evidence_dir, report_value).read_text())
        with tempfile.TemporaryDirectory(prefix="parcel-alignment-check-") as temp_dir:
            independent_path = Path(temp_dir) / "independent-alignment-report.json"
            command = [sys.executable, str(SCRIPT.with_name("parcel-alignment-check.py")), str(evidence_path),
                       str(cache_path), str(independent_path), "--source-id", source_id,
                       "--city-code", city_code, "--contract-sha256", contract_sha]
            run = subprocess.run(command, capture_output=True, text=True, timeout=120)
            independent = json.loads(independent_path.read_text()) if independent_path.is_file() else {}
        if run.returncode != 0 or independent.get("passed") is not True:
            return False, "independent coordinate-operation recomputation failed"
        native_crs, axis_order = evidence.get("nativeCrs"), evidence.get("nativeAxisOrder")
        for report in (saved_report, independent):
            if (report.get("passed") is not True or report.get("sourceId") != source_id
                    or str(report.get("cityCode")) != city_code or report.get("contractSha256") != contract_sha
                    or report.get("evidenceSha256") != hashlib.sha256(evidence_bytes).hexdigest()
                    or report.get("metadataSha256") != metadata_sha or report.get("nativeSha256") != native_sha
                    or report.get("cacheSha256") != cache_sha or report.get("nativeCrs") != native_crs
                    or report.get("nativeAxisOrder") != axis_order
                    or not isinstance(report.get("coordinateOperation"), str)
                    or not report["coordinateOperation"].strip()
                    or not isinstance(report.get("operationPipeline"), str)
                    or not report["operationPipeline"].strip()
                    or report.get("bestOperationAvailable") is not True or report.get("ballparkAllowed") is not False
                    or report.get("sourceGeometryChanged") is not False or report.get("fittedOffsetApplied") is not False):
                return False, "alignment report is incomplete, unbound, or uses an inferred transform"
        if not re.fullmatch(r"EPSG:\d+", native_crs or "") or axis_order not in {"east-north", "north-east"}:
            return False, "explicit native CRS or wire axis order is missing"
        if check.get("passed") is not True:
            return False, "qualification alignment gate did not pass"
        return True, "alignment evidence hashes and coordinate operation independently verified"
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def output_is_valid(value: Any, task_id: str, attempt_dir: Path) -> tuple[bool, str]:
    if not isinstance(value, dict) or set(value) != set(OUTPUT_SCHEMA["required"]):
        return False, "worker output does not match the required JSON schema"
    if value.get("taskId") != task_id or value.get("status") not in {"built", "blocked-source"}:
        return False, "worker task identity or status is invalid"
    if not isinstance(value.get("summary"), str) or not value["summary"].strip():
        return False, "worker summary is empty"
    for key in ("changedFiles", "testEvidence", "qualificationEvidence"):
        if not isinstance(value.get(key), list) or not all(isinstance(x, str) and x.strip() for x in value[key]):
            return False, f"{key} must be an array of non-empty strings"
    if value["status"] == "built":
        if not any(path.startswith("backend/parcels/") for path in value["changedFiles"]):
            return False, "built result must include an adapter implementation file"
        if not any(is_backend_test_file(path) for path in value["changedFiles"]):
            return False, "built result must include focused tests"
        if not value["testEvidence"] or not value["qualificationEvidence"]:
            return False, "built result requires test and live qualification evidence"
        if not any(re.search(r"qualification|acceptance", path, re.I)
                   for path in value["qualificationEvidence"]):
            return False, "built result must include saved live qualification evidence"
    else:
        if BLOCKED_ADAPTER_RE.search(value["summary"]):
            return False, "blocked-source cannot mean the adapter implementation is missing"
        if not value["qualificationEvidence"]:
            return False, "blocked-source requires saved source/qualification evidence"
    for path in value["changedFiles"]:
        if Path(path).is_absolute() or ".." in Path(path).parts or not allowed_change(path):
            return False, f"out-of-scope changed file: {path}"
    for path in value["testEvidence"] + value["qualificationEvidence"]:
        try:
            if not safe_under(attempt_dir, path).is_file():
                return False, f"evidence file is missing: {path}"
        except (ValueError, OSError):
            return False, f"evidence path escapes attempt directory: {path}"
    if value["status"] == "blocked-source":
        request_failure = re.compile(
            r"(?:https?://|request\s+url).{0,500}(?:http\s*\d{3}|timeout|denied|error|empty|no features|zero features)",
            re.I | re.S)
        publisher_failure = re.compile(
            r"(?:http\s*[45]\d{2}|dns.{0,30}fail|tls.{0,30}fail|certificate.{0,30}fail|connection refused|"
            r"timed?\s*out|empty featurecollection|no features returned|zero features returned)", re.I | re.S)
        external_evidence = False
        for evidence_path in value["qualificationEvidence"]:
            evidence_file = safe_under(attempt_dir, evidence_path)
            if evidence_file.stat().st_size > 2 * 1024 * 1024:
                continue
            body = evidence_file.read_text(errors="replace")
            try:
                metric = json.loads(body)
                if metric.get("geometryPass") is False and any(metric.get(k, 0) > 0 for k in
                        ("invalidCount", "duplicateIdCount", "conflictingSameIdGeometryCount", "exactGeometryDuplicateCount", "overlapPairCount", "operationErrorCount")):
                    external_evidence = True
                    break
            except (ValueError, TypeError, AttributeError):
                pass
            if request_failure.search(body) or publisher_failure.search(body):
                external_evidence = True
                break
        if not external_evidence:
            return False, "blocked-source requires bounded publisher request/response failure evidence"
    return True, "ok"


def verify_qualification_manifest(value: dict[str, Any], task: dict[str, Any], attempt_dir: Path,
                                 qual_root: Path) -> tuple[bool, str, list[str]]:
    manifests = [p for p in value["qualificationEvidence"] if Path(p).name == "qualification-manifest.json"]
    if len(manifests) != 1:
        return False, "exactly one qualification-manifest.json is required", []
    try:
        manifest_path = safe_under(attempt_dir, manifests[0])
        manifest = json.loads(manifest_path.read_text())
        rows = manifest.get("seeds") if isinstance(manifest, dict) else None
        if manifest.get("taskId") != task["taskId"] or manifest.get("sourceId") != task["sourceId"]:
            return False, "qualification manifest task/source identity mismatch", []
        if not set(REQUIRED_QUALIFICATION_CHECKS).issubset(manifest.get("requiredChecks") or []):
            return False, "qualification manifest omits required parcel-availability checks", []
        if not isinstance(rows, list) or len(rows) != len(task["qualificationSeeds"]):
            return False, "qualification manifest does not cover every frozen seed", []
        qualification_statuses = []
        by_city = {str(row.get("cityCode")): row for row in rows if isinstance(row, dict)}
        if len(by_city) != len(rows):
            return False, "duplicate or malformed seed rows in qualification manifest", []
        for seed in task["qualificationSeeds"]:
            row = by_city.get(str(seed["cityCode"]))
            if row is None:
                return False, f"qualification manifest omits city {seed['cityCode']}", []
            seed_path = safe_under(qual_root, seed["candidatePath"])
            seed_sha = file_sha256(seed_path)
            if seed_sha != seed["candidateSha256"] or row.get("seedSha256") != seed_sha:
                return False, f"frozen seed hash mismatch for city {seed['cityCode']}", []
            if row.get("seedPath") not in {seed["candidatePath"], str(seed_path)}:
                return False, f"seed path mismatch for city {seed['cityCode']}", []
            used_path_value = row.get("candidateUsedPath")
            used_sha = row.get("candidateUsedSha256")
            if not isinstance(used_path_value, str) or not isinstance(used_sha, str):
                return False, f"candidate used is missing for city {seed['cityCode']}", []
            if Path(used_path_value).is_absolute():
                used_path = Path(used_path_value).resolve()
                if used_path != seed_path and not used_path.is_relative_to(attempt_dir.resolve()):
                    return False, "derived candidate path must be inside the attempt directory", []
            else:
                used_path = safe_under(attempt_dir, used_path_value)
            if not used_path.is_file() or file_sha256(used_path) != used_sha:
                return False, f"candidate-used hash mismatch for city {seed['cityCode']}", []
            used_candidate = json.loads(used_path.read_text())
            seed_candidate = json.loads(seed_path.read_text())
            if used_path != seed_path:
                for key in ("city", "sampleIds", "absentId", "metricEpsg", "cellSizeDegrees"):
                    if used_candidate.get(key) != seed_candidate.get(key):
                        return False, f"derived candidate changed frozen {key}", []
                for key in ("id", "idPrefix", "endpoint", "countryCode"):
                    if used_candidate.get("descriptor", {}).get(key) != seed_candidate.get("descriptor", {}).get(key):
                        return False, f"derived candidate changed source identity {key}", []
                provenance_path = used_path.with_name("candidate-provenance.json")
                if not provenance_path.is_file():
                    return False, f"derived candidate provenance missing for city {seed['cityCode']}", []
                provenance = json.loads(provenance_path.read_text())
                if (provenance.get("seedSha256") != seed_sha or provenance.get("derivedCandidateSha256") != used_sha
                        or provenance.get("sourceId") != task["sourceId"]):
                    return False, f"derived candidate provenance mismatch for city {seed['cityCode']}", []
            qpath_value = row.get("qualificationPath")
            if not isinstance(qpath_value, str):
                return False, f"qualification JSON path missing for city {seed['cityCode']}", []
            qpath = safe_under(attempt_dir, qpath_value)
            qualification = json.loads(qpath.read_text())
            if (qualification.get("cityCode") != str(seed["cityCode"])
                    or qualification.get("sourceId") != used_candidate["descriptor"]["id"]
                    or qualification.get("candidateSha256") != used_sha
                    or not isinstance(qualification.get("checks"), dict)
                or not isinstance(qualification.get("requestCount"), int)
                    or qualification.get("requestCount", 0) < 1):
                return False, f"saved live qualification does not bind to candidate/source/requests for city {seed['cityCode']}", []
            if qualification.get("schemaVersion") != 2:
                return False, f"saved live qualification schemaVersion 2 is required for city {seed['cityCode']}", []
            if row.get("qualificationStatus") != qualification.get("status"):
                return False, f"qualification manifest status mismatch for city {seed['cityCode']}", []
            checks = qualification["checks"]
            if value["status"] == "built" and any(
                    not isinstance(checks.get(key), dict) or checks[key].get("passed") is not True
                    for key in REQUIRED_QUALIFICATION_CHECKS):
                return False, f"built result requires working parcel classification and repeatable reads for city {seed['cityCode']}", []
            if value["status"] == "built":
                cache_path = safe_under(qpath.parent, qualification.get("cacheFile", ""))
                if hashlib.sha256(cache_path.read_bytes()).hexdigest() != qualification.get("cacheSha256"):
                    return False, "qualification cache SHA-256 mismatch", []
                from parcel_qualification_policy import usable_parcel_cache
                if not usable_parcel_cache(json.loads(cache_path.read_text())):
                    return False, "qualification cache has no usable parcel polygons", []
            if row.get("qualifierExitCode") not in {0, 1, 2}:
                return False, f"qualifier exit code missing for city {seed['cityCode']}", []
            qualification_statuses.append(str(qualification.get("status", "unknown")))
            if value["status"] == "built" and (row.get("qualifierExitCode") != 0
                    or qualification.get("status") != "technical-qualified"):
                return False, f"built result requires a passing technical qualification for city {seed['cityCode']}", []
        return True, "live qualifications independently bind to frozen/derived candidates", qualification_statuses
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return False, f"qualification artifact validation failed: {type(exc).__name__}: {exc}", []


def run_focused_tests(repo: Path, changed_files: list[str], attempt_dir: Path) -> tuple[bool, str, Path]:
    tests = [p for p in changed_files if is_backend_test_file(p)]
    log_path = attempt_dir / "runner-independent-tests.log"
    if not tests:
        log_path.write_text("No runnable changed backend/test node:test file was found.\n", encoding="utf-8")
        return False, "no runnable changed backend/test node:test file", log_path
    command = ["node", "--test", *tests]
    try:
        proc = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=600,
                              env=strip_api_key_env())
        content = "COMMAND: " + json.dumps(command) + "\nEXIT: " + str(proc.returncode) + "\n\n" + proc.stdout + proc.stderr
        log_path.write_text(content, encoding="utf-8")
        return proc.returncode == 0, f"independent focused tests exited {proc.returncode}", log_path
    except subprocess.TimeoutExpired as exc:
        log_path.write_text("COMMAND: " + json.dumps(command) + "\nTIMEOUT after 600 seconds\n" +
                            str(exc.stdout or "") + str(exc.stderr or ""), encoding="utf-8")
        return False, "independent focused tests timed out", log_path


def git_paths(root: Path) -> set[str]:
    raw = subprocess.run(["git", "status", "--short", "--untracked-files=all"], cwd=root,
                         capture_output=True, text=True, check=True).stdout
    paths: set[str] = set()
    for line in raw.splitlines():
        if len(line) >= 4:
            name = line[3:].split(" -> ")[-1]
            paths.add(name)
    return paths


def worktree_snapshot(root: Path) -> dict[str, str | None]:
    """Hash tracked and non-ignored untracked files; ignored caches are intentionally excluded."""
    raw = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                         cwd=root, capture_output=True, check=True).stdout
    snapshot: dict[str, str | None] = {}
    for item in raw.split(b"\0"):
        if not item:
            continue
        rel = item.decode("utf-8", "surrogateescape")
        path = root / rel
        try:
            if path.is_dir():
                # Gitlinks are directories on disk, not regular tracked files.
                payload = subprocess.run(["git", "ls-files", "--stage", "--", rel], cwd=root,
                                         capture_output=True, check=True).stdout
            else:
                payload = os.readlink(path).encode("utf-8", "surrogateescape") if path.is_symlink() else path.read_bytes()
            snapshot[rel] = hashlib.sha256(payload).hexdigest()
        except FileNotFoundError:
            snapshot[rel] = None
    return snapshot


def snapshot_delta(before: dict[str, str | None], after: dict[str, str | None]) -> list[str]:
    return sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Runner:
    def __init__(self, queue: Path, repo_root: Path, qualification_root: Path, state_dir: Path,
                 *, popen=subprocess.Popen, disk_usage=shutil.disk_usage, clock=time.monotonic,
                 sleep=time.sleep):
        self.queue_path = queue.resolve()
        self.repo = repo_root.resolve()
        self.qual = qualification_root.resolve()
        self.state_dir = (self.repo / state_dir).resolve() if not state_dir.is_absolute() else state_dir.resolve()
        self.state_path = self.state_dir / "state.json"
        self.events_path = self.state_dir / "events.jsonl"
        self.popen, self.disk_usage, self.clock, self.sleep = popen, disk_usage, clock, sleep
        self.stop_requested = False
        self.active = None
        self.lock_stream = None
        self._last_heartbeat = 0.0
        self.tasks, self.queue_sha = load_queue(self.queue_path)

    def log(self, event: str, **data: Any) -> None:
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": utc_now(), "event": event, **data}, ensure_ascii=False) + "\n")
            f.flush(); os.fsync(f.fileno())

    def save(self) -> None:
        json_write(self.state_path, self.state)

    def resolve_model_defaults(self) -> None:
        if self.state.get("model"):
            return
        llm = llm_cost_module(self.repo).create_cli_llm(
            "codex", repo="consensus-builder", script="parcel-adapter-build", cwd=self.repo)
        self.state["model"] = llm.model
        self.state["effort"] = llm.effort
        self.save()

    def verify_seed_hashes(self, task: dict[str, Any]) -> None:
        for seed in task["qualificationSeeds"]:
            path = safe_under(self.qual, seed["candidatePath"])
            if sha256_file(path) != seed["candidateSha256"]:
                raise RuntimeError(f"qualification seed changed after queue freeze: {path}")

    def initialize(self) -> None:
        if not self.repo.is_dir() or not (self.repo / ".git").exists():
            raise ValueError("--repo-root must be a git worktree dedicated to parcel adapter changes")
        if not self.qual.is_dir() or self.repo == self.qual:
            raise ValueError("--qualification-root must be an existing, separate qualified worktree")
        for task in self.tasks:
            for seed in task["qualificationSeeds"]:
                candidate = safe_under(self.qual, seed["candidatePath"])
                if not candidate.is_file():
                    raise ValueError(f"qualification seed candidate is missing: {candidate}")
                if sha256_file(candidate) != seed["candidateSha256"]:
                    raise RuntimeError(f"qualification seed SHA-256 mismatch: {candidate}")
        current_snapshot = worktree_snapshot(self.repo)
        self.initial_snapshot = current_snapshot
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.lock_stream = (self.state_dir / "runner.lock").open("a+")
        try:
            fcntl.flock(self.lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another adapter build runner holds this state directory") from exc
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text())
            if self.state.get("queueSha256") != self.queue_sha:
                raise RuntimeError("immutable queue SHA-256 changed; refusing resume")
            if self.state.get("repoRoot") != str(self.repo) or self.state.get("qualificationRoot") != str(self.qual):
                raise RuntimeError("state belongs to a different worktree pair")
            previous_snapshot = self.state.get("worktreeSnapshot", current_snapshot)
            drift = snapshot_delta(previous_snapshot, current_snapshot)
            interrupted = any(v.get("status") in {"running", "retryable"}
                              for v in self.state.get("tasks", {}).values())
            if drift and (not interrupted or any(not allowed_change(p) for p in drift)):
                raise RuntimeError("worktree changed outside a recorded adapter attempt: " + ", ".join(drift[:10]))
            if drift:
                self.state["worktreeSnapshot"] = current_snapshot
        else:
            self.state = {"schemaVersion": 1, "runId": str(uuid.uuid4()), "status": "ready",
                          "startedAt": utc_now(), "updatedAt": utc_now(), "queuePath": str(self.queue_path),
                          "queueSha256": self.queue_sha, "repoRoot": str(self.repo),
                          "qualificationRoot": str(self.qual), "taskCount": len(self.tasks),
                          "worktreeSnapshot": current_snapshot,
                          "tasks": {t["taskId"]: {"status": "pending", "attempts": 0} for t in self.tasks}}
        self.state.update(status="running", pid=os.getpid(), updatedAt=utc_now())
        self.save()

    def heartbeat(self) -> None:
        now = self.clock()
        if now - self._last_heartbeat < HEARTBEAT_SECONDS:
            return
        self._last_heartbeat = now
        self.state["updatedAt"] = utc_now()
        self.state["heartbeatAt"] = self.state["updatedAt"]
        if self.active:
            entry = self.state["tasks"][self.active["task"]["taskId"]]
            entry["heartbeatAt"] = self.state["heartbeatAt"]
            entry["workerPid"] = self.active["proc"].pid
        self.save()

    def start_task(self, task: dict[str, Any], attempt: int) -> dict[str, Any]:
        before_snapshot = worktree_snapshot(self.repo)
        ident = hashlib.sha256(task["taskId"].encode()).hexdigest()[:16]
        adir = self.state_dir / "tasks" / ident / f"attempt-{attempt:02d}"
        adir.mkdir(parents=True, exist_ok=False)
        schema_path, answer_path = adir / "output-schema.json", adir / "last-message.json"
        json_write(schema_path, OUTPUT_SCHEMA)
        prompt = worker_prompt(task, self.repo, self.qual, adir)
        (adir / "prompt.md").write_text(prompt, encoding="utf-8")
        request = {"taskId": task["taskId"], "attempt": attempt, "cwd": str(self.repo),
                   "prompt": prompt, "schemaPath": str(schema_path), "answerPath": str(answer_path),
                   "logPath": str(adir / "codex.jsonl"), "stderrPath": str(adir / "codex.stderr.log"),
                   "timeoutMs": MAX_TURN_SECONDS * 1000, "model": self.state["model"],
                   "effort": self.state.get("effort")}
        req_path = adir / "worker-request.json"
        json_write(req_path, request)
        out = (adir / "worker.stdout.log").open("w", encoding="utf-8")
        err = (adir / "worker.stderr.log").open("w", encoding="utf-8")
        proc = self.popen([sys.executable, str(SCRIPT), "--_worker", str(req_path)], cwd=self.repo,
                          stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True,
                          env=strip_api_key_env())
        return {"task": task, "attempt": attempt, "dir": adir, "proc": proc, "out": out, "err": err,
                "started": self.clock(), "termAt": None, "timedOut": False, "answerPath": answer_path,
                "beforeSnapshot": before_snapshot}

    def stop_child(self) -> None:
        if not self.active:
            return
        proc = self.active["proc"]
        if proc.poll() is not None:
            return
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: return
        end = self.clock() + TERM_GRACE_SECONDS
        while proc.poll() is None and self.clock() < end:
            self.sleep(0.2)
        if proc.poll() is None:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass

    def request_stop(self, _sig=None, _frame=None) -> None:
        self.stop_requested = True
        self.state["status"] = "stopping"
        self.state["updatedAt"] = utc_now()
        self.save()
        self.stop_child()

    def disk_ok(self) -> bool:
        return int(self.disk_usage(self.state_dir).free) >= MIN_FREE_BYTES

    def run_one(self, task: dict[str, Any]) -> None:
        entry = self.state["tasks"][task["taskId"]]
        if entry.get("status") in {"built", "blocked-source"}:
            return
        self.verify_seed_hashes(task)
        if "taskBaseSnapshot" not in entry:
            entry["taskBaseSnapshot"] = worktree_snapshot(self.repo)
        while int(entry.get("attempts", 0)) < MAX_ATTEMPTS and not self.stop_requested:
            self.verify_seed_hashes(task)
            if not self.disk_ok():
                self.state.update(status="paused-disk-floor", updatedAt=utc_now())
                entry.update(status="pending", summary="Paused before worker start: free disk below 3 GiB")
                self.save(); return
            attempt = int(entry.get("attemptSerial", entry.get("attempts", 0))) + 1
            self.state.update(status="running", updatedAt=utc_now())
            entry.update(status="running", attempts=int(entry.get("attempts", 0)) + 1,
                         attemptSerial=attempt, startedAt=utc_now())
            entry["attemptBaseSnapshot"] = worktree_snapshot(self.repo)
            self.state["worktreeSnapshot"] = entry["attemptBaseSnapshot"]
            self.active = self.start_task(task, attempt)
            entry["workerPid"] = self.active["proc"].pid
            self.log("worker-started", taskId=task["taskId"], attempt=attempt, pid=self.active["proc"].pid)
            self.save()
            while self.active["proc"].poll() is None and not self.stop_requested:
                elapsed = self.clock() - self.active["started"]
                if elapsed >= MAX_TURN_SECONDS and self.active["termAt"] is None:
                    self.active.update(timedOut=True, termAt=self.clock())
                    self.log("timeout-sigterm", taskId=task["taskId"], pid=self.active["proc"].pid)
                    try: os.killpg(self.active["proc"].pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                elif self.active["termAt"] is not None and self.clock() - self.active["termAt"] >= TERM_GRACE_SECONDS:
                    try: os.killpg(self.active["proc"].pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    self.active["termAt"] = self.clock() + 1e9
                self.heartbeat(); self.sleep(POLL_SECONDS)
            proc = self.active["proc"]
            rc = proc.poll()
            self.active["out"].close(); self.active["err"].close()
            transport_error = transport_startup_failure(
                rc, (self.active["dir"] / "codex.jsonl").read_text(errors="replace")
                if (self.active["dir"] / "codex.jsonl").exists() else "",
                (self.active["dir"] / "codex.stderr.log").read_text(errors="replace")
                if (self.active["dir"] / "codex.stderr.log").exists() else "")
            if transport_error:
                entry.update(status="pending", attempts=max(0, int(entry["attempts"]) - 1),
                             transportFailures=int(entry.get("transportFailures", 0)) + 1,
                             lastFailure=transport_error, workerReturnCode=rc, completedAt=utc_now())
                self.state.update(status="failed-transport", updatedAt=utc_now(),
                                  worktreeSnapshot=worktree_snapshot(self.repo))
                self.log("transport-startup-failed", taskId=task["taskId"], reason=transport_error)
                self.active = None
                self.save()
                return
            worker_result = None
            if rc == 0 and self.active["answerPath"].is_file():
                try: worker_result = json.loads(self.active["answerPath"].read_text())
                except Exception: worker_result = None
            valid, why = output_is_valid(worker_result, task["taskId"], self.active["dir"])
            current_snapshot = worktree_snapshot(self.repo)
            changed = snapshot_delta(entry["taskBaseSnapshot"], current_snapshot)
            attempt_delta = snapshot_delta(entry["attemptBaseSnapshot"], current_snapshot)
            out_scope = [p for p in attempt_delta if not allowed_change(p)]
            reported = sorted(worker_result.get("changedFiles", [])) if valid else []
            qualification_statuses: list[str] = []
            if valid:
                qvalid, qwhy, qualification_statuses = verify_qualification_manifest(
                    worker_result, task, self.active["dir"], self.qual)
                if not qvalid:
                    valid, why = False, qwhy
            if valid and any(p.startswith("backend/parcels/") for p in changed):
                test_ok, test_summary, test_log = run_focused_tests(self.repo, changed, self.active["dir"])
                worker_result["testEvidence"].append(str(test_log.relative_to(self.active["dir"])))
                if not test_ok:
                    valid, why = False, test_summary
            if not out_scope and valid and set(reported) == set(changed):
                entry.update(status=worker_result["status"], result=worker_result,
                             summary=worker_result["summary"], changedFiles=changed,
                             completedAt=utc_now(), workerReturnCode=rc)
                if worker_result["status"] == "built":
                    entry["reviewStage"] = "ready-for-review"
                    entry["qualificationStatuses"] = qualification_statuses
                result_path = self.active["dir"] / "result.json"
                json_write(result_path, worker_result)
                entry["resultPath"] = str(result_path)
                self.state["worktreeSnapshot"] = current_snapshot
                self.log("worker-complete", taskId=task["taskId"], status=worker_result["status"],
                         changedFiles=changed)
                self.active = None
                return
            entry.update(status="retryable", lastFailure=("out-of-scope edits: " + ", ".join(out_scope)
                          if out_scope else why if not valid else "reported changes do not match worktree diff"),
                         workerReturnCode=rc, completedAt=utc_now())
            self.state["worktreeSnapshot"] = current_snapshot
            self.log("worker-attempt-failed", taskId=task["taskId"], attempt=attempt,
                     reason=entry["lastFailure"], returnCode=rc)
            self.active = None
            self.save()
        if entry.get("status") == "retryable":
            entry["status"] = "failed"
            entry["summary"] = entry.get("lastFailure", "worker did not produce a valid result")
        if self.stop_requested:
            entry["status"] = "pending"
        self.save()

    def run(self) -> dict[str, Any]:
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        self.initialize()
        self.resolve_model_defaults()
        self.log("runner-started", queueSha256=self.queue_sha, taskCount=len(self.tasks))
        for task in self.tasks:
            if self.stop_requested or self.state.get("status") in {"paused-disk-floor", "failed-transport"}: break
            self.run_one(task)
        self.state["status"] = "stopped" if self.stop_requested else self.state.get("status", "complete")
        if self.state["status"] == "running":
            self.state["status"] = "complete" if all(v.get("status") in {"built", "blocked-source"}
                                                        for v in self.state["tasks"].values()) else "incomplete"
        self.state["updatedAt"] = utc_now(); self.save()
        return self.state

    def status(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"status": "not-started", "queueSha256": self.queue_sha,
                    "taskCount": len(self.tasks), "tasks": {}}
        state = json.loads(self.state_path.read_text())
        if state.get("queueSha256") != self.queue_sha:
            raise RuntimeError("immutable queue SHA-256 changed; status refused")
        return state


def transport_startup_failure(returncode: int | None, stream: str, stderr: str) -> str | None:
    """A CLI failure before a model turn is infrastructure, never a source verdict."""
    if returncode in (0, None):
        return None
    for line in stream.splitlines():
        try:
            if json.loads(line).get("type") in {"turn.started", "turn.completed", "item.started", "item.completed"}:
                return None
        except (ValueError, AttributeError):
            continue
    return "Codex failed before starting an adapter turn: " + (stderr.strip()[:1000] or f"exit {returncode}")


def codex_command(request: dict[str, Any]) -> list[str]:
    model, effort = request["model"], request.get("effort")
    cmd = ["codex", "--search", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
           "--approve-for-me", "--add-dir", str(Path(request["answerPath"]).parent),
           "-m", model, "-c", 'forced_login_method="chatgpt"',
           "-c", "sandbox_workspace_write.network_access=true"]
    if effort:
        cmd += ["-c", f"model_reasoning_effort={json.dumps(effort)}"]
    cmd += ["--json", "--color", "never", "--output-schema", request["schemaPath"], "--output-last-message",
            request["answerPath"], "-"]
    return cmd


def qualification_worker_main(request_path: Path) -> int:
    """Codex transport used by the serial runner; model/effort come from shared llm-cost defaults."""
    request = json.loads(request_path.read_text())
    llm_cost = llm_cost_module(Path(request["cwd"]))
    model, effort = request["model"], request.get("effort")
    cmd = codex_command(request)
    env = strip_api_key_env()
    with Path(request["logPath"]).open("w", encoding="utf-8") as stdout, Path(request["stderrPath"]).open("w", encoding="utf-8") as stderr:
        proc = subprocess.run(cmd, input=request["prompt"], cwd=request["cwd"], stdout=stdout,
                              stderr=stderr, text=True, env=env)
    usage = codex_usage(Path(request["logPath"]).read_text(errors="replace"))
    if usage:
        try:
            try: equivalent = llm_cost.compute_cost(model, usage)
            except Exception: equivalent = None
            llm_cost.record_subscription_run("consensus-builder", "parcel-adapter-build", model,
                                             usage, equivalent_usd=equivalent, engine="codex",
                                             role="adapter-worker", taskId=request["taskId"],
                                             attempt=request["attempt"], effort=effort,
                                             exitCode=proc.returncode)
        except Exception as exc:
            print(f"llm-cost ledger write failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    return proc.returncode


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--status", action="store_true")
    p.add_argument("--queue", required=True, type=Path)
    p.add_argument("--repo-root", required=True, type=Path)
    p.add_argument("--qualification-root", required=True, type=Path)
    p.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    queue = args.queue if args.queue.is_absolute() else args.repo_root / args.queue
    runner = Runner(queue, args.repo_root, args.qualification_root, args.state_dir)
    if args.status:
        print(json.dumps(runner.status(), ensure_ascii=False, indent=2)); return 0
    try:
        state = runner.run()
    except Exception as exc:
        print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr)
        return 2
    print(json.dumps(state, ensure_ascii=False, indent=2))
    return 0 if state.get("status") in {"complete", "stopped", "paused-disk-floor"} else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--_worker":
        raise SystemExit(qualification_worker_main(Path(sys.argv[2])))
    raise SystemExit(main())
