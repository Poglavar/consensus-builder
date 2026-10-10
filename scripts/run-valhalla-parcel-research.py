#!/usr/bin/env python3
"""Resumable, reviewed WUP parcel-research loop for the Valhalla worker host.

Nothing runs unless --run is supplied. State and raw Codex JSONL logs live under
tmp/valhalla-parcel-research; per-city research workers only own their city packet.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parent
DEFAULT_QUEUE = Path("world-parcels/research/overnight-next-1201-1300-2026-10-09/pending-queue.json")
DEFAULT_SOURCE = Path("tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz")
HANDOFF = Path("world-parcels/research/valhalla-handoff-2026-10-09.md")
DEFAULT_STATE = Path("tmp/valhalla-parcel-research")
RESEARCH_MODEL = "gpt-5.6-luna"
REVIEW_MODEL = "gpt-6-sol"
MAX_RETRIES = 3
MAX_WORKERS = 3
TURN_TIMEOUT_SECONDS = 90 * 60
POLL_SECONDS = 1.0
TERM_GRACE_SECONDS = 15
ROOT_REVIEW_TASKS = [
    ("legacy:25", "Review old root-pending WUP city code 25 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:780", "Review old root-pending WUP city code 780 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:3976", "Review old root-pending WUP city code 3976 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:4121", "Review old root-pending WUP city code 4121 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:4148", "Review old root-pending WUP city code 4148 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:5699", "Review old root-pending WUP city code 5699 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:6034", "Review old root-pending WUP city code 6034 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:7534", "Review old root-pending WUP city code 7534 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:7651", "Review old root-pending WUP city code 7651 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:8558", "Review old root-pending WUP city code 8558 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:8993", "Review old root-pending WUP city code 8993 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:9965", "Review old root-pending WUP city code 9965 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:10619", "Review old root-pending WUP city code 10619 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("legacy:11147", "Review old root-pending WUP city code 11147 and its paired packet; preserve hold unless every acceptance gate is proven."),
    ("packet:9127", "Root-review existing complete Haldwani packet; completeness alone is not integration."),
    ("packet:5646", "Root-review existing complete West Valley City packet; keep held pending adapter, binding, and headed-detail gates."),
    ("packet:10624", "Root-review existing complete Yuhu packet; completeness alone is not integration."),
    ("packet:11162", "Root-review existing complete Yanji packet; completeness alone is not integration."),
    ("root:west-valley-followthrough", "Continue West Valley City/Utah root qualification from the handoff; keep held until every required test and headed-detail verification passes."),
    ("root:macapa-followthrough", "Continue Macapá distinct-ID/identical-join-rows root qualification from the handoff; keep held until adapter, full qualification, and headed-detail gates pass."),
    ("root:finland-followthrough", "Review Finland/CP follow-through from the handoff; preserve held state until live adapter and all required evidence pass."),
    ("root:norway-followthrough", "Review Norway/TEIG follow-through from the handoff; preserve held state until live adapter and all required evidence pass."),
    ("root:iceland-followthrough", "Review Iceland/Landeign follow-through from the handoff; preserve held state until live adapter and all required evidence pass."),
]
ROOT_TASK_PROMPTS = dict(ROOT_REVIEW_TASKS)
ENGLISH_PRIMARY_COUNTRIES = {"US", "GB", "IE", "CA", "AU", "NZ"}
SAFE_SAMPLE_ID_KEYS = {
    "id", "fid", "objectid", "parcelid", "parcel_id", "parid", "lotid", "lot_id", "loteid",
    "idlote", "lote", "parcelno", "parcelnumber", "parcel_ref", "refcat", "refcadastral",
    "nationalcadastralref", "localid", "identifier", "gid", "globalid",
}
SENSITIVE_KEY = re.compile(r"owner|titular|address|street|cpf|email|phone|person|birth|tax|account|titleholder|surveyornam", re.I)
SYSTEMIC_ERROR = re.compile(r"\b(?:401|403|429)\b|rate.?limit|too many requests|unauthori[sz]ed|authentication|not logged in|token expired|account quota|billing quota", re.I)
REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "reviewedIds": {"type": "array", "items": {"type": "string"}},
        "heldIds": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
        "systemicFailure": {"type": "boolean"},
    },
    "required": ["reviewedIds", "heldIds", "summary", "systemicFailure"],
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def process_start_identity(pid: int) -> str | None:
    """Return kernel process start identity where available, preventing PID-reuse claims."""
    stat_path = Path(f"/proc/{pid}/stat")
    try:
        raw = stat_path.read_text(encoding="utf-8")
        tail = raw[raw.rfind(")") + 2:].split()
        return tail[19]  # field 22 (starttime); tail begins at field 3
    except (OSError, IndexError, ValueError):
        return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def city_code_of(record: dict[str, Any]) -> str | None:
    value = record.get("wupCityCode", record.get("cityCode"))
    if value is None:
        match = re.fullmatch(r"wup2025:(\d+)", str(record.get("cityId", "")))
        value = match.group(1) if match else None
    return str(value) if value is not None else None


def _has_polygon(value: Any) -> bool:
    return isinstance(value, dict) and value.get("type") in {"Polygon", "MultiPolygon"} and isinstance(value.get("coordinates"), list)


def _inline_polygons(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if _has_polygon(value):
            found.append(value)
        for child in value.values():
            found.extend(_inline_polygons(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_inline_polygons(child))
    return found


def _sample_paths(value: Any) -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if re.search(r"sample.?files?$", key, re.I):
                values = child if isinstance(child, list) else [child]
                paths.extend(str(item) for item in values if isinstance(item, str))
            paths.extend(_sample_paths(child))
    elif isinstance(value, list):
        for child in value:
            paths.extend(_sample_paths(child))
    return list(dict.fromkeys(paths))


def _feature_collection_polygons(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict) and value.get("type") == "FeatureCollection":
        return [feature.get("geometry") for feature in value.get("features", [])
                if isinstance(feature, dict) and _has_polygon(feature.get("geometry"))]
    return _inline_polygons(value)


def validate_sample_file(path: Path) -> tuple[int, list[str]]:
    value = json_read(path)
    polygons = _feature_collection_polygons(value)
    errors: list[str] = []
    if not isinstance(value, dict) or value.get("type") != "FeatureCollection":
        return len(polygons), [f"sample file is not GeoJSON FeatureCollection: {path}"]
    for index, feature in enumerate(value.get("features", [])):
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if not _has_polygon(geometry):
            errors.append(f"sample feature {index} lacks full polygon geometry: {path}")
            continue
        props = feature.get("properties") or {}
        if not isinstance(props, dict) or not props:
            errors.append(f"sample feature {index} lacks a safe native ID: {path}")
            continue
        keys = set()
        for key, val in props.items():
            normalized = re.sub(r"[^a-z0-9_]", "", str(key).lower())
            keys.add(normalized)
            if SENSITIVE_KEY.search(str(key)) or normalized not in SAFE_SAMPLE_ID_KEYS:
                errors.append(f"sample feature {index} contains non-ID or sensitive attribute {key!r}: {path}")
            if isinstance(val, str) and SENSITIVE_KEY.search(val):
                errors.append(f"sample feature {index} has a sensitive-looking value in {key!r}: {path}")
        if not keys:
            errors.append(f"sample feature {index} has no safe ID field: {path}")
    return len(polygons), errors


def validate_packet(root: Path, queue_city: dict[str, Any], cohort_dir: Path) -> dict[str, Any]:
    """Validate the paired packet against immutable WUP identity and safe samples."""
    code = str(queue_city.get("cityCode", ""))
    errors: list[str] = []
    city_matches = sorted(cohort_dir.glob(f"city-{code}-*.json"))
    if len(city_matches) != 1:
        return {"valid": False, "errors": [f"expected one city-{code}-*.json, found {len(city_matches)}"], "cityPath": None}
    city_path = city_matches[0]
    try:
        city = json_read(city_path)
    except Exception as exc:
        return {"valid": False, "errors": [f"invalid city JSON: {exc}"], "cityPath": city_path}
    reviews = []
    for review_path in cohort_dir.glob("*service-review.json"):
        try:
            review = json_read(review_path)
        except Exception:
            continue
        if Path(str(review.get("cityRecord", ""))).name == city_path.name:
            reviews.append((review_path, review))
    if len(reviews) != 1:
        errors.append(f"expected one paired service-review for {city_path.name}, found {len(reviews)}")
    review_path, review = reviews[0] if len(reviews) == 1 else (None, {})

    if str(city_code_of(city) or "") != code:
        errors.append("cityCode does not match immutable queue cityCode")
    expected_rank = queue_city.get("rank")
    rank = city.get("queueRank", city.get("rank"))
    if rank != expected_rank:
        errors.append(f"rank mismatch: expected {expected_rank}, found {rank}")
    expected_iso = str(queue_city.get("iso2", "")).upper()
    actual_iso = str(city.get("countryCode", city.get("iso2", ""))).upper()
    if actual_iso != expected_iso:
        errors.append(f"country code mismatch: expected {expected_iso}, found {actual_iso}")
    if str(city.get("country", "")).strip() != str(queue_city.get("country", "")).strip():
        errors.append("country name differs from immutable queue record")
    if city.get("point", city.get("centerLatLon")) != queue_city.get("point"):
        errors.append("WUP point changed from immutable queue coordinates")
    expected_thousands = _number(queue_city.get("pop2025k"))
    expected_persons = None if expected_thousands is None else expected_thousands * 1000
    actual_persons = _number(city.get("population2025"))
    population_matches = (city.get("populationUnit") == "persons" and expected_persons is not None
                          and actual_persons is not None and math.isclose(actual_persons, expected_persons, rel_tol=0, abs_tol=1e-6))
    if not population_matches:
        errors.append(f"population persons mismatch: expected {expected_persons}, found {city.get('population2025')} {city.get('populationUnit')}")
    if city.get("status") != "complete":
        errors.append("city packet status is not complete")
    if city.get("registryFound") is False:
        errors.append("registryFound=false is not permitted for research packets; use true only with local evidence, otherwise null")

    fresh = city.get("freshResearch") if isinstance(city.get("freshResearch"), dict) else {}
    queries = fresh.get("queries") if isinstance(fresh.get("queries"), list) else []
    executable = [q for q in queries if isinstance(q, dict) and isinstance(q.get("query"), str) and q["query"].strip()
                  and isinstance(q.get("result"), str) and q["result"].strip()
                  and isinstance(q.get("actualResultUrls"), list) and q["actualResultUrls"]]
    unique_queries = {q["query"].strip().casefold() for q in executable}
    languages = [str(q.get("language", "")).strip().casefold() for q in executable]
    has_english = any(lang.startswith("english") for lang in languages)
    has_native = expected_iso in ENGLISH_PRIMARY_COUNTRIES or any(lang and not lang.startswith("english") for lang in languages)
    if len(unique_queries) < 2 or not has_english or not has_native:
        errors.append("requires at least two executed English/native-language queries with result URLs and outcomes")

    if review and Path(str(review.get("cityRecord", ""))).name != city_path.name:
        errors.append("service-review points to a different city record")
    if review and review.get("registryFound") is False:
        errors.append("service-review registryFound=false is not permitted; unresolved local custody must remain null")
    scope_limits = review.get("scopeLimits") if isinstance(review.get("scopeLimits"), dict) else {}
    if review and scope_limits.get("maxFullPolygonsRetainedInRepository", 3) > 3:
        errors.append("service-review permits more than three retained full polygons")
    if city.get("verifiedSample") is True and not _sample_paths(city):
        errors.append("verifiedSample is true but no sample file is referenced")

    polygon_count = len(_inline_polygons(city)) + len(_inline_polygons(review))
    sample_files: list[Path] = []
    for relative in _sample_paths(city) + _sample_paths(review):
        sample_path = Path(relative)
        sample_path = (cohort_dir / sample_path).resolve() if not sample_path.is_absolute() else sample_path.resolve()
        try:
            sample_path.relative_to(root.resolve())
        except ValueError:
            errors.append(f"sample path escapes repository: {relative}")
            continue
        if sample_path not in sample_files:
            sample_files.append(sample_path)
    for sample_path in sample_files:
        if not sample_path.exists():
            errors.append(f"referenced sample is missing: {sample_path}")
            continue
        try:
            count, sample_errors = validate_sample_file(sample_path)
            polygon_count += count
            errors.extend(sample_errors)
        except Exception as exc:
            errors.append(f"cannot read sample {sample_path}: {exc}")
    if polygon_count > 3:
        errors.append(f"packet retains {polygon_count} full polygons; maximum is three")

    return {"valid": not errors, "errors": errors, "cityPath": city_path,
            "reviewPath": review_path, "city": city, "review": review, "polygonCount": polygon_count}


def city_slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return value or "city"


def new_state(job_name: str, queue_path: str, queue_hash: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1, "jobName": job_name, "status": "starting", "pid": os.getpid(),
        "startedAt": utc_now(), "heartbeat": utc_now(), "queuePath": queue_path,
        "queueSha256": queue_hash, "cities": {}, "rootReviewTasks": {}, "activeProcesses": [],
        "eventsPath": "events.jsonl", "currentRankStart": None, "currentRankEnd": None,
        "lastError": None, "systemicFailure": None, "completedCount": 0, "heldCount": 0,
    }


class Runner:
    def __init__(self, args: argparse.Namespace, *, popen_factory=subprocess.Popen, sleep=time.sleep,
                 clock=time.monotonic):
        self.args = args
        self.root = args.repo_root.resolve()
        self.state_dir = (self.root / args.state_dir).resolve() if not args.state_dir.is_absolute() else args.state_dir.resolve()
        self.run_dir = self.state_dir / "runs"
        self.state_path = self.state_dir / "state.json"
        self.events_path = self.state_dir / "events.jsonl"
        self.popen_factory = popen_factory
        self.sleep = sleep
        self.clock = clock
        self.stop_requested = False
        self.lock_stream = None
        self.active_processes: dict[int, dict[str, Any]] = {}
        self.codex = args.codex or "codex"
        self.state: dict[str, Any] = {}

    def log(self, message: str, **fields: Any) -> None:
        event = {"at": utc_now(), "message": message, **fields}
        append_jsonl(self.events_path, event)
        print(f"[{event['at']}] {message}", flush=True)

    def save_state(self) -> None:
        self.state["heartbeat"] = utc_now()
        self.state["pid"] = os.getpid()
        self.state["pidStartIdentity"] = process_start_identity(os.getpid())
        self.state["activeProcesses"] = [
            {"pid": item["process"].pid, "role": item["call"]["role"], "taskId": item["call"].get("taskId"),
             "startedAt": item["startedAt"], "callId": item["call"]["callId"]}
            for item in self.active_processes.values()
        ]
        atomic_json(self.state_path, self.state)

    def acquire_lock(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.lock_stream = (self.state_dir / "runner.lock").open("a+")
        try:
            fcntl.flock(self.lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(f"another {self.args.job_name} process holds {self.state_dir / 'runner.lock'}") from exc

    def load_state(self, queue_path: Path) -> None:
        digest = sha256_file(queue_path)
        if self.state_path.exists():
            self.state = json_read(self.state_path)
            if self.state.get("schemaVersion") != 1:
                raise RuntimeError("unsupported persistent state schema; preserve the existing state and inspect it")
            old_queue = self.state.get("queuePath")
            old_hash = self.state.get("queueSha256")
            if old_queue and Path(old_queue).resolve() != queue_path.resolve():
                raise RuntimeError(f"persisted queue {old_queue} differs from selected queue {queue_path}; refusing to silently change cohorts")
            if old_hash and old_hash != digest:
                raise RuntimeError(f"persisted queue hash changed for {queue_path}; refusing to overwrite prior queue identity")
            self.state["queuePath"] = str(queue_path)
            self.state["queueSha256"] = digest
            for city_state in self.state.setdefault("cities", {}).values():
                if city_state.get("status") == "running":
                    city_state["status"] = "pending"
                    city_state["lastError"] = "previous runner stopped before recording an outcome; retry will be bounded"
            for task in self.state.setdefault("rootReviewTasks", {}).values():
                if task.get("status") == "running":
                    task["status"] = "pending"
            self.state["status"] = "resuming"
            self.state["lastError"] = None
            self.state["systemicFailure"] = None
            self.log("resumed from durable state; prior logs and artifacts are preserved", queueSha256=digest)
        else:
            self.state = new_state(self.args.job_name, str(queue_path), digest)
            self.log("created durable run state", queueSha256=digest)
        self.state["jobName"] = self.args.job_name
        self.state["pid"] = os.getpid()
        self.save_state()

    def request_stop(self, _signum: int | None = None, _frame: Any = None) -> None:
        self.stop_requested = True
        self.state["status"] = "stopping"
        self.state["lastError"] = "SIGTERM received; active Codex process groups will be stopped and checkpoints retained"
        self.save_state()

    def stop_children(self) -> None:
        for item in list(self.active_processes.values()):
            proc = item["process"]
            if proc.poll() is not None:
                continue
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
            deadline = self.clock() + self.args.grace_seconds
            while proc.poll() is None and self.clock() < deadline:
                self.sleep(0.1)
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def _command(self, call: dict[str, Any], schema_path: Path, answer_path: Path) -> list[str]:
        return [self.codex, "--ask-for-approval", "never", "--search", "exec",
                "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
                "-m", call["model"], "-c", f'model_reasoning_effort="{call["effort"]}"',
                "--json", "--output-schema", str(schema_path), "--output-last-message", str(answer_path), "-"]

    def _start_call(self, call: dict[str, Any]) -> dict[str, Any]:
        call_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
        call["callId"] = call_id
        call_dir = self.run_dir / call_id
        call_dir.mkdir(parents=True, exist_ok=False)
        prompt_path = call_dir / "prompt.md"
        schema_path = call_dir / "output-schema.json"
        answer_path = call_dir / "last-message.json"
        stdout_path = call_dir / "stdout.jsonl"
        stderr_path = call_dir / "stderr.log"
        prompt_path.write_text(call["prompt"], encoding="utf-8")
        atomic_json(schema_path, REVIEW_SCHEMA)
        out_stream = stdout_path.open("w", encoding="utf-8")
        err_stream = stderr_path.open("w", encoding="utf-8")
        try:
            proc = self.popen_factory(self._command(call, schema_path, answer_path), cwd=self.root,
                                      stdin=subprocess.PIPE, stdout=out_stream, stderr=err_stream,
                                      text=True, start_new_session=True)
            try:
                proc.stdin.write(call["prompt"])
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        except Exception:
            out_stream.close()
            err_stream.close()
            raise
        return {"call": call, "process": proc, "started": self.clock(), "startedAt": utc_now(),
                "termSentAt": None, "timedOut": False, "interrupted": False,
                "out": out_stream, "err": err_stream, "answerPath": answer_path,
                "stdoutPath": stdout_path, "stderrPath": stderr_path, "callDir": call_dir}

    def run_calls(self, calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Run one bounded group concurrently; persist PID/heartbeat and kill exact groups on stop."""
        launched: list[dict[str, Any]] = []
        try:
            for call in calls:
                if self.stop_requested:
                    break
                try:
                    item = self._start_call(call)
                    launched.append(item)
                    self.active_processes[item["process"].pid] = item
                    self.log("started Codex task", role=call["role"], taskId=call.get("taskId"),
                             model=call["model"], effort=call["effort"], pid=item["process"].pid)
                    self.save_state()
                except Exception as exc:
                    launched.append({"call": call, "process": None, "error": str(exc), "started": self.clock(),
                                     "startedAt": utc_now(), "timedOut": False, "interrupted": False})
            while any(item.get("process") is not None and item["process"].poll() is None for item in launched):
                now = self.clock()
                if self.stop_requested:
                    self.stop_children()
                    for item in launched:
                        if item.get("process") and item["process"].poll() is None:
                            item["interrupted"] = True
                    break
                for item in launched:
                    proc = item.get("process")
                    if proc is None or proc.poll() is not None:
                        continue
                    elapsed = now - item["started"]
                    if item["termSentAt"] is None and elapsed >= self.args.timeout_seconds:
                        item["timedOut"] = True
                        item["termSentAt"] = now
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        self.log("Codex turn reached its timeout; sent SIGTERM to its process group",
                                 role=item["call"]["role"], taskId=item["call"].get("taskId"), pid=proc.pid)
                    elif item["termSentAt"] is not None and now - item["termSentAt"] >= self.args.grace_seconds:
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        item["termSentAt"] = now + 10**9
                self.save_state()
                self.sleep(self.args.poll_seconds)
            results = []
            for item in launched:
                proc = item.get("process")
                for stream_key in ("out", "err"):
                    if item.get(stream_key):
                        item[stream_key].close()
                returncode = proc.poll() if proc else 127
                if item.get("interrupted") and returncode is None:
                    returncode = -signal.SIGTERM
                answer = None
                if item.get("answerPath") and item["answerPath"].exists():
                    try:
                        answer = json_read(item["answerPath"])
                    except Exception as exc:
                        item["error"] = f"invalid last-message JSON: {exc}"
                stderr_text = item.get("stderrPath").read_text(errors="replace") if item.get("stderrPath") and item["stderrPath"].exists() else item.get("error", "")
                stdout_text = item.get("stdoutPath").read_text(errors="replace") if item.get("stdoutPath") and item["stdoutPath"].exists() else ""
                systemic = bool(returncode and SYSTEMIC_ERROR.search(stderr_text + "\n" + stdout_text))
                result = {"call": item["call"], "returncode": returncode, "answer": answer,
                          "stdoutPath": str(item.get("stdoutPath", "")), "stderrPath": str(item.get("stderrPath", "")),
                          "answerPath": str(item.get("answerPath", "")), "timedOut": item.get("timedOut", False),
                          "interrupted": item.get("interrupted", False), "systemic": systemic,
                          "error": item.get("error"), "elapsedSeconds": max(0, round(self.clock() - item.get("started", self.clock()), 2))}
                results.append(result)
                if proc:
                    self.active_processes.pop(proc.pid, None)
                self.log("Codex task ended", role=item["call"]["role"], taskId=item["call"].get("taskId"),
                         exitCode=returncode, timeout=result["timedOut"], interrupted=result["interrupted"],
                         systemic=result["systemic"], elapsedSeconds=result["elapsedSeconds"])
            self.save_state()
            return results
        finally:
            for item in launched:
                if item.get("process") and item["process"].poll() is None and self.stop_requested:
                    self.stop_children()

    def _city_entry(self, queue_city: dict[str, Any]) -> dict[str, Any]:
        code = str(queue_city["cityCode"])
        existing = self.state.setdefault("cities", {}).get(code)
        basis = {"cityCode": code, "rank": queue_city.get("rank"), "country": queue_city.get("country"),
                 "iso2": queue_city.get("iso2"), "point": queue_city.get("point"), "pop2025k": queue_city.get("pop2025k")}
        if existing and existing.get("wupIdentity") != basis:
            raise RuntimeError(f"immutable WUP identity changed for city code {code}; state preserved, run blocked")
        if existing is None:
            existing = {"wupIdentity": basis, "attempts": 0, "status": "pending", "lastError": None}
            self.state["cities"][code] = existing
        return existing

    def _build_research_prompt(self, city: dict[str, Any], cohort_dir: Path, attempt: int) -> str:
        code = city["cityCode"]
        slug = city_slug(city["name"])
        city_file = f"city-{code}-{slug}.json"
        review_file = f"{slug}-service-review.json"
        return f"""You are one of three parallel anonymous cadastral-source researchers in a resumable WUP city queue.

Your single immutable WUP queue record is:
```json
{json.dumps(city, ensure_ascii=False, indent=2)}
```
Attempt {attempt} of {self.args.max_retries}. Cohort directory: `{cohort_dir.relative_to(self.root)}`.

Write only `{city_file}`, `{review_file}`, and at most one sample GeoJSON containing no more than three full parcel polygons in this cohort directory. Scratch/request caches and temporary qualification evidence belong under `tmp/valhalla-parcel-research/` (ignored); never clear prior logs or artifacts. Do not edit registry/catalog/runtime city config, global/generated reports, queue/identity ledgers, or another city's files. Do not commit, push, deploy, email, or contact anyone.

Preserve `cityCode={code}`, rank {city.get('rank')}, country `{city.get('country')}` / `{city.get('iso2')}`, exact WUP point `{city.get('point')}` in latitude/longitude order, `population2025={round(float(city.get('pop2025k')) * 1000)}` persons, `population2025k={city.get('pop2025k')}`, and `populationUnit="persons"`. Do not shift a coordinate to force a parcel hit. A zero exact-point hit, map extent miss, timeout, login wall, or unusable UI is not evidence of citywide absence.

Required city JSON core schema example (include these fields with accurate evidence; additional established packet fields are welcome):
```json
{{"cityCode": {code}, "queueRank": {city.get('rank')}, "country": {json.dumps(city.get('country'))}, "countryCode": {json.dumps(city.get('iso2'))}, "point": {json.dumps(city.get('point'))}, "population2025": {round(float(city.get('pop2025k')) * 1000)}, "population2025k": {city.get('pop2025k')}, "populationUnit": "persons", "status": "complete", "freshResearch": {{"queries": [{{"language": "English", "query": "...", "result": "...", "actualResultUrls": ["https://..."]}}, {{"language": "native/local", "query": "...", "result": "...", "actualResultUrls": ["https://..."]}}]}}, "registryFound": null}}
```

Perform separate first-party discovery queries in English and the country's local/native language; record the actual query text, search outcome, and URLs in `freshResearch.queries`. Follow the official viewer's current JavaScript/configuration to the public map/API service, inspect schema/CRS and a bounded anonymous ID+geometry response when available. Ordinary public GET/POST is allowed. Never log in, use credentials/private tokens, defeat CAPTCHA/Cloudflare, or request owner, address, contact, titleholder, personal, tax/account, or other unsafe fields. TLS verification is the default; only use a narrow, source-specific certificate exception when the user has already authorized that exact exception, and record its host, reason, and request. Never disable TLS verification globally. Retain full unchanged native geometry only with safe parcel IDs, at most three polygons total; keep larger raw evidence in ignored `tmp/`.

Record every attempted route/request and distinguish a city/local registry custodian from general national agency prose. Use `registryFound=true` only when a local registry/cadastre/map/procedure is actually evidenced; otherwise use `null` (never `false`). Do not present packet completion as source integration/admission. Keep `runtimeReadiness` held unless the serial reviewer qualifies a real adapter independently.

The paired service review MUST contain `"cityRecord": "{city_file}"` at the top level. Write and reread both named JSON files before returning. This report must document query and request outcomes, scope limits, safe field allowlist, and uncertainty. Mark the packet complete only after accurately recording all executed attempts. Never invent a successful query, registry, or geometry. End with a short machine-readable completion summary in your final response."""

    def _build_review_prompt(self, city_items: list[dict[str, Any]], root_task_ids: list[str], identity_items: list[dict[str, Any]] | None = None) -> str:
        identities = identity_items or []
        task_text = "\n".join(f"- `{task_id}`: {ROOT_TASK_PROMPTS.get(task_id, 'Review the specified legacy packet using the Valhalla handoff and preserve evidence limits.') }" for task_id in root_task_ids)
        city_text = "\n".join(f"- `city:{item['cityCode']}` — {item['name']}, rank {item['rank']}, packet {item.get('cityPath', 'to be inspected')}; review this batch even if held." for item in city_items)
        identity_text = "\n".join(f"- `identity:{item['cityCode']}` — resolve this held identity before any work on the next rank range." for item in identities)
        handoff = (self.root / HANDOFF).as_posix()
        receipt_dir = self._receipt_dir().relative_to(self.root).as_posix()
        return f"""You are the one serial root reviewer for the persistent WUP parcel-research job. You own root review decisions and are the ONLY agent authorized in this job to edit `world-parcels/registry.json`, `backend/parcels/source-catalog.json`, `frontend/js/city-config.js`, and generated coverage/report artifacts. Research workers own only their named city packet/review/sample files. Do not commit, push, deploy, or contact anyone. Preserve the user's paused local-research goal and remote-job authorization; do not start any separate investigation outside these named tasks.

Review at most three pending legacy/root items listed below in this turn, plus the new city batch. For each task, inspect the paired evidence and add only its exact ID to `reviewedIds` after a completed review; a hold is a completed review but must remain visibly held. Do not mark unreviewed tasks done. Use the handoff file when present: `{handoff}`.

For every ID you place in `reviewedIds`, first write a durable receipt at `{receipt_dir}/<ID with every non-alphanumeric/dot/underscore/hyphen replaced by underscore>.json`. Its JSON must contain `taskId` (exact ID), `decision` (`held`, `qualified`, `resolved`, or `reviewed`), nonempty `evidenceFiles` (repository-relative paths you actually opened or wrote; each must exist), and `checkedAt` (ISO timestamp). Write and reread the receipt before returning your answer. Never list an ID as reviewed if its receipt or evidence files are missing. Keep a hold decision explicit in both `heldIds` and the receipt decision.

Root review tasks:
{task_text or '- (none)'}

New city batch:
{city_text or '- (none)'}

Identity holds (unresolved cities stay excluded while other cities continue):
{identity_text or '- (none)'}

For each city, revalidate the immutable queue identity (city code/rank/country/point/population persons), bilingual executed searches, and no more than three full polygons with safe ID attributes. Packet completeness alone never means integrated or admitted. Enable a city only after independent live adapter qualification proves fresh native-ID reads, forced paging, 13 bounded cells, metric GEOS validity/overlap checks, source binding, and headed details-panel verification. If any gate is missing or not independently evidenced, leave it held and do not edit runtime/catalog/report state to imply admission. A point-zero, timeout, login/anti-bot wall, or unavailable viewer is not citywide absence.

Review acceptance metrics from original first-party response/cache artifacts, not a worker's success label. For the four existing cohort packets, root follow-through tasks, and 14 legacy codes, rely on the exact source paths in the handoff; keep every `true` or `null` custody value grounded, never turn unresolved into false absence. For identity holds, write a reasoned decision with first-party evidence into the cohort's root identity decision overlay and update its pending queue/identity-review artifacts consistently; a held identity must not silently disappear. Verify all changed artifacts after writing.

Output MUST be a single JSON object satisfying the supplied schema: `reviewedIds` (only task IDs fully reviewed), `heldIds` (reviewed items that remain held), `summary`, and `systemicFailure`. The allowed IDs are exactly the IDs listed above. Do not claim a review task completed if you did not inspect and record it."""

    def _call(self, role: str, task_id: str, prompt: str, model: str, effort: str) -> dict[str, Any]:
        return {"role": role, "taskId": task_id, "prompt": prompt, "model": model, "effort": effort}

    def _queue_path(self) -> Path:
        if self.state_path.exists():
            persisted = json_read(self.state_path).get("queuePath")
            if persisted:
                path = Path(persisted)
                return path.resolve() if path.is_absolute() else (self.root / path).resolve()
        p = Path(self.args.queue)
        return p.resolve() if p.is_absolute() else (self.root / p).resolve()

    def _load_queue(self, queue_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if not queue_path.exists():
            raise FileNotFoundError(f"queue file is missing: {queue_path}")
        data = json_read(queue_path)
        cities = data.get("cities") if isinstance(data, dict) else None
        if not isinstance(cities, list):
            raise ValueError(f"queue does not contain a cities array: {queue_path}")
        codes = [str(city.get("cityCode")) for city in cities]
        if not all(code.isdigit() for code in codes) or len(set(codes)) != len(codes):
            raise ValueError("queue city codes must be unique numeric WUP City_Code values")
        return data, cities

    def _activate_queue(self, queue_path: Path) -> None:
        document, _cities = self._load_queue(queue_path)
        roster_path = queue_path.parent / str(document.get("sourceRoster", "ranked-population.json"))
        source_hash = None
        if roster_path.exists():
            source_hash = json_read(roster_path).get("source", {}).get("localSourceSha256")
        saved_source_hash = self.state.get("rankedRosterSourceSha256")
        if saved_source_hash and source_hash and saved_source_hash != source_hash:
            raise RuntimeError(f"immutable WUP ranked source SHA changed: expected {saved_source_hash}, found {source_hash}")
        if source_hash:
            self.state["rankedRosterSourceSha256"] = source_hash
        self.state["queuePath"] = str(queue_path.resolve())
        self.state["queueSha256"] = sha256_file(queue_path)
        self.save_state()

    def _packet(self, queue_city: dict[str, Any], cohort_dir: Path) -> dict[str, Any]:
        return validate_packet(self.root, queue_city, cohort_dir)

    def _ensure_root_tasks(self, cohort_dir: Path, cities: list[dict[str, Any]]) -> None:
        tasks = self.state.setdefault("rootReviewTasks", {})
        for task_id, description in ROOT_REVIEW_TASKS:
            tasks.setdefault(task_id, {"status": "pending", "description": description, "attempts": 0})
        # City review owns packet review. Reuse its proof instead of adding a second task.
        reused = []
        for city in cities:
            code = str(city["cityCode"])
            packet = self._packet(city, cohort_dir)
            proof = self._reviewed_city_receipt(city, packet)
            task = tasks.get(f"packet:{code}")
            if proof is not None and task and task.get("status") in {"pending", "running"}:
                task.update(status="done", reviewedAt=proof["checkedAt"],
                            receiptPath=str(self._receipt_path(f"city:{code}")),
                            satisfiedBy=f"city:{code}")
                reused.append(code)
        if reused:
            self.log("reused saved city reviews; duplicate packet tasks retired", cityCodes=reused,
                     reusedCount=len(reused))
            self.save_state()

    def _reviewed_city_receipt(self, city: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any] | None:
        """Trust a completed review only with valid, still-current paired evidence."""
        entry = self._city_entry(city)
        if not packet.get("valid") or entry.get("status") not in {"reviewed", "reviewed-held"}:
            return None
        receipt = self._review_receipt(f"city:{city['cityCode']}")
        if receipt is None or ((entry["status"] == "reviewed-held") != (receipt["decision"] == "held")):
            return None
        evidence = [(self.root / raw).resolve() for raw in receipt["evidenceFiles"]]
        paired = [packet.get("cityPath"), packet.get("reviewPath")]
        if any(path is None or path.resolve() not in evidence for path in paired):
            return None
        checked = datetime.fromisoformat(receipt["checkedAt"].replace("Z", "+00:00"))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        # Receipts use whole seconds; allow only that timestamp's fractional second.
        if any(path.stat().st_mtime >= checked.timestamp() + 1 for path in evidence):
            return None
        return receipt

    def _skip_item(self, task_id: str, entry: dict[str, Any], phase: str, reason: str) -> None:
        """Retain failure evidence without claiming successful research or review."""
        if entry.get("status") == "failed-skipped":
            return
        entry.update(status="failed-skipped", failedPhase=phase, skippedAt=utc_now(), lastError=reason)
        failure = {"taskId": task_id, "phase": phase, "reason": reason,
                   "attempts": entry.get("attempts", 0), "at": entry["skippedAt"],
                   "queuePath": self.state.get("queuePath"), "wupIdentity": entry.get("wupIdentity")}
        self.state.setdefault("failedItems", {})[task_id] = failure
        append_jsonl(self.state_dir / "failed-items.jsonl", failure)
        self.log("item failed after bounded attempts; retained for follow-up and skipped", **failure)
        self.save_state()

    def _skip_unreviewed(self, cities: list[dict[str, Any]], root_ids: list[str], reason: str) -> None:
        for city in cities:
            entry = self._city_entry(city)
            if entry.get("status") not in {"reviewed", "reviewed-held", "failed-skipped"}:
                self._skip_item(f"city:{city['cityCode']}", entry, "review", reason)
        for task_id in root_ids:
            entry = self.state["rootReviewTasks"][task_id]
            if entry.get("status") != "done":
                self._skip_item(task_id, entry, "review", reason)

    def _next_root_tasks(self, limit: int = 3) -> list[str]:
        return [task_id for task_id, task in self.state.get("rootReviewTasks", {}).items()
                if task.get("status") not in {"done", "failed-skipped"}][:limit]

    def _select_batch(self, cities: list[dict[str, Any]], cohort_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        research: list[dict[str, Any]] = []
        review_only: list[dict[str, Any]] = []
        for city in cities:
            entry = self._city_entry(city)
            if entry.get("status") == "failed-skipped":
                continue
            packet = self._packet(city, cohort_dir)
            if self._reviewed_city_receipt(city, packet) is not None:
                continue
            if packet.get("valid"):
                if len(review_only) < 3:
                    review_only.append({**city, "cityPath": str(packet["cityPath"]), "cohortDir": str(cohort_dir)})
            elif entry.get("attempts", 0) >= self.args.max_retries:
                self._skip_item(f"city:{city['cityCode']}", entry, "research",
                                "; ".join(packet.get("errors", [])))
            else:
                research.append(city)
            if len(research) >= self.args.workers:
                break
        # Keep research-first order while allowing pre-existing complete packets in reviewer batch.
        return research, review_only

    def _review_call(self, city_items: list[dict[str, Any]], root_task_ids: list[str], identities: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        task_id = "review:" + ",".join([f"city:{item['cityCode']}" for item in city_items]
                                        + root_task_ids + [f"identity:{item['cityCode']}" for item in (identities or [])])
        return self._call("reviewer", task_id, self._build_review_prompt(city_items, root_task_ids, identities), REVIEW_MODEL, "high")

    def _record_city_attempts(self, cities: list[dict[str, Any]], cohort_dir: Path,
                              parallel_reviewer: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any] | None, bool]:
        pending = list(cities)
        review_result = None
        systemic_seen = False
        for attempt_round in range(self.args.max_retries):
            if not pending or self.stop_requested:
                break
            calls: list[dict[str, Any]] = []
            for city in pending:
                code = str(city["cityCode"])
                entry = self._city_entry(city)
                entry["attempts"] = int(entry.get("attempts", 0)) + 1
                entry["status"] = "running"
                entry["lastAttemptAt"] = utc_now()
                entry["lastError"] = None
                calls.append(self._call("research", f"city:{code}", self._build_research_prompt(city, cohort_dir, entry["attempts"]), RESEARCH_MODEL, "low"))
            if parallel_reviewer is not None and attempt_round == 0:
                calls.append(parallel_reviewer)
            self.save_state()
            results = self.run_calls(calls)
            next_pending = []
            for result in results:
                if result["call"]["role"] == "reviewer":
                    review_result = result
                    continue
                city_code = result["call"]["taskId"].split(":", 1)[1]
                city = next(item for item in pending if str(item["cityCode"]) == city_code)
                entry = self._city_entry(city)
                packet = self._packet(city, cohort_dir)
                okay = result["returncode"] == 0 and packet.get("valid")
                if okay:
                    entry["status"] = "research-complete"
                    entry["packetPath"] = str(packet["cityPath"])
                    entry["reviewPath"] = str(packet["reviewPath"])
                    entry["lastError"] = None
                    entry["lastResearchAt"] = utc_now()
                    self.state["completedCount"] = int(self.state.get("completedCount", 0)) + 1
                else:
                    error = result.get("error") or (
                        f"Codex exit {result['returncode']}" if result["returncode"] != 0
                        else "packet validation: " + "; ".join(packet.get("errors", [])))
                    entry["lastError"] = error
                    entry["lastAttemptAt"] = utc_now()
                    entry["systemicFailure"] = result.get("systemic", False)
                    systemic_seen = systemic_seen or bool(result.get("systemic"))
                    if entry["attempts"] < self.args.max_retries:
                        entry["status"] = "pending"
                        next_pending.append(city)
                    else:
                        if result.get("systemic"):
                            entry["status"] = "blocked"
                            entry["blockedAt"] = utc_now()
                        else:
                            self._skip_item(f"city:{city_code}", entry, "research", error)
                    self.log("city attempt did not produce a valid packet", cityCode=city_code,
                             attempt=entry["attempts"], maxRetries=self.args.max_retries, error=error,
                             systemic=result.get("systemic", False))
                self.save_state()
            pending = next_pending
            if systemic_seen and not pending:
                break
        if self.stop_requested:
            for city in pending:
                entry = self._city_entry(city)
                entry["status"] = "pending"
                entry["lastError"] = "SIGTERM interrupted the worker; durable attempt count retained"
            self.save_state()
        return pending, review_result, systemic_seen

    def _read_review_answer(self, result: dict[str, Any]) -> dict[str, Any] | None:
        if result is None or result.get("returncode") != 0 or not isinstance(result.get("answer"), dict):
            return None
        answer = result["answer"]
        if not isinstance(answer.get("reviewedIds"), list) or not isinstance(answer.get("heldIds"), list):
            return None
        if any(not isinstance(task_id, str) for task_id in answer["reviewedIds"] + answer["heldIds"]):
            return None
        if len(answer["reviewedIds"]) != len(set(answer["reviewedIds"])) or len(answer["heldIds"]) != len(set(answer["heldIds"])):
            return None
        if not set(answer["heldIds"]) <= set(answer["reviewedIds"]):
            return None
        return answer

    def _complete_review(self, city_items: list[dict[str, Any]], root_task_ids: list[str],
                         identities: list[dict[str, Any]] | None = None,
                         first_result: dict[str, Any] | None = None) -> tuple[bool, dict[str, Any] | None, bool]:
        identity_ids = [f"identity:{item['cityCode']}" for item in (identities or [])]
        city_ids = [f"city:{item['cityCode']}" for item in city_items]
        required = set(city_ids + root_task_ids + identity_ids)
        if not required:
            return True, {"reviewedIds": [], "heldIds": [], "summary": "no review tasks", "systemicFailure": False}, False
        result = first_result
        systemic = False
        accepted: set[str] = set()
        held_accepted: set[str] = set()
        call_cities = list(city_items)
        call_roots = list(root_task_ids)
        call_identities = list(identities or [])
        last_answer = None
        for attempt in range(self.args.max_retries):
            if result is None:
                for task_id in call_roots:
                    self.state.setdefault("rootReviewTasks", {}).setdefault(task_id, {"status": "pending", "attempts": 0})["attempts"] += 1
                call = self._review_call(call_cities, call_roots, call_identities)
                self.save_state()
                result = self.run_calls([call])[0]
            answer = self._read_review_answer(result) if result else None
            if result:
                systemic = systemic or bool(result.get("systemic"))
            if answer:
                systemic = systemic or bool(answer.get("systemicFailure"))
            reviewed = set(answer.get("reviewedIds", [])) if answer else set()
            held_ids = set(answer.get("heldIds", [])) if answer else set()
            if answer and not (set(answer.get("reviewedIds", [])) <= required):
                answer = None
                reviewed = set()
                held_ids = set()
            if answer:
                last_answer = answer
            newly_accepted: set[str] = set()
            for task_id in reviewed & required:
                if answer is None or task_id in held_ids and task_id not in reviewed:
                    continue
                receipt = self._review_receipt(task_id)
                if receipt is None or ((task_id in held_ids) != (receipt.get("decision") == "held")):
                    self.log("reviewer self-report lacks a valid persisted receipt; task remains pending", taskId=task_id)
                    continue
                newly_accepted.add(task_id)
            accepted.update(newly_accepted)
            held_accepted.update(newly_accepted & held_ids)
            reviewed = newly_accepted
            for task_id in reviewed & set(root_task_ids):
                self.state["rootReviewTasks"].setdefault(task_id, {})["status"] = "done"
                self.state["rootReviewTasks"][task_id]["reviewedAt"] = utc_now()
                self.state["rootReviewTasks"][task_id]["receiptPath"] = str(self._receipt_path(task_id))
            for task_id in reviewed & set(city_ids):
                code = task_id.split(":", 1)[1]
                city = next(item for item in city_items if str(item["cityCode"]) == code)
                entry = self._city_entry(city)
                packet = self._packet(city, Path(city.get("cohortDir", self._queue_path().parent)))
                if packet.get("valid"):
                    previously_held = entry.get("status") == "reviewed-held"
                    entry["status"] = "reviewed-held" if task_id in held_ids else "reviewed"
                    entry["reviewedAt"] = utc_now()
                    entry["reviewPath"] = str(packet.get("reviewPath"))
                    entry["receiptPath"] = str(self._receipt_path(task_id))
                    if entry["status"] == "reviewed-held" and not previously_held:
                        self.state["heldCount"] = int(self.state.get("heldCount", 0)) + 1
                else:
                    self._skip_item(f"city:{code}", entry, "review",
                                    "reviewed but paired packet failed structural validation: " + "; ".join(packet.get("errors", [])))
            for task_id in reviewed & set(identity_ids):
                self.state.setdefault("identityReviews", {})[task_id] = {"status": "done", "reviewedAt": utc_now(), "receiptPath": str(self._receipt_path(task_id))}
            self.save_state()
            if required <= accepted:
                merged_answer = {"reviewedIds": sorted(accepted), "heldIds": sorted(held_accepted),
                                 "summary": (last_answer or {}).get("summary", ""), "systemicFailure": systemic}
                self.log("serial review completed with persisted receipts", reviewedIds=merged_answer["reviewedIds"],
                         heldIds=merged_answer["heldIds"], summary=merged_answer["summary"])
                return True, merged_answer, systemic
            if self.stop_requested:
                return False, last_answer, systemic
            missing = sorted(required - accepted)
            self.log("review incomplete; retrying only unreviewed task IDs", missing=missing, attempt=attempt + 1)
            if attempt + 1 >= self.args.max_retries:
                break
            call_cities = [item for item in city_items if f"city:{item['cityCode']}" in missing]
            call_roots = [task for task in root_task_ids if task in missing]
            call_identities = [item for item in (identities or []) if f"identity:{item['cityCode']}" in missing]
            result = None
        return False, last_answer, systemic

    def _receipt_dir(self) -> Path:
        queue_path = Path(self.state.get("queuePath", self.args.queue))
        if not queue_path.is_absolute():
            queue_path = self.root / queue_path
        return (queue_path.parent / "root-review-receipts").resolve()

    def _receipt_path(self, task_id: str) -> Path:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", task_id)
        return self._receipt_dir() / f"{safe_id}.json"

    def _review_receipt(self, task_id: str) -> dict[str, Any] | None:
        path = self._receipt_path(task_id)
        try:
            receipt = json_read(path)
        except (OSError, ValueError, TypeError):
            return None
        if receipt.get("taskId") != task_id or receipt.get("decision") not in {"held", "qualified", "resolved", "reviewed"}:
            return None
        try:
            datetime.fromisoformat(str(receipt.get("checkedAt", "")).replace("Z", "+00:00"))
        except ValueError:
            return None
        evidence = receipt.get("evidenceFiles")
        if not isinstance(evidence, list) or not evidence:
            return None
        for raw in evidence:
            target = Path(raw)
            target = target if target.is_absolute() else self.root / target
            if not target.exists() or not target.is_file():
                return None
            try:
                target.resolve().relative_to(self.root.resolve())
            except ValueError:
                return None
        return receipt

    def _write_queue_builder(self, start_rank: int, end_rank: int) -> Path:
        output = self.root / "world-parcels" / "research" / f"overnight-next-{start_rank}-{end_rank}-{datetime.now(timezone.utc).date().isoformat()}"
        queue_path = output / "pending-queue.json"
        if output.exists():
            if not queue_path.exists():
                raise RuntimeError(f"refusing to overwrite existing range folder without pending queue: {output}")
            self.log("reusing existing range queue; no artifacts are cleared", output=str(output))
            return queue_path
        source = self.root / self.args.source
        if not source.exists():
            raise FileNotFoundError(f"cannot advance ranks without the WUP source file: {source}")
        expected_source_hash = None
        current_queue = Path(self.state.get("queuePath", ""))
        if not current_queue.is_absolute():
            current_queue = self.root / current_queue
        if current_queue.exists():
            current_document = json_read(current_queue)
            roster_path = current_queue.parent / str(current_document.get("sourceRoster", "ranked-population.json"))
            if roster_path.exists():
                expected_source_hash = json_read(roster_path).get("source", {}).get("localSourceSha256")
        actual_source_hash = sha256_file(source)
        expected_source_hash = expected_source_hash or self.state.get("rankedRosterSourceSha256")
        if expected_source_hash and actual_source_hash != expected_source_hash:
            raise RuntimeError(f"WUP bulk source SHA-256 mismatch: expected {expected_source_hash}, found {actual_source_hash}; refusing to build a new queue")
        free_bytes = shutil.disk_usage(self.root).free
        if free_bytes < 2 * 1024**3:
            raise RuntimeError(f"only {free_bytes} bytes free; refusing to build a new queue below the 2 GiB safety floor")
        command = ["node", str(self.root / "scripts/build-overnight-city-queue.mjs"), "--run",
                   "--start-rank", str(start_rank), "--end-rank", str(end_rank),
                   "--source", str(source), "--output", str(output)]
        self.log("building next ranked queue", startRank=start_rank, endRank=end_rank, output=str(output))
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True,
                                timeout=min(self.args.timeout_seconds, 900), check=False)
        run_id = f"queue-{start_rank}-{end_rank}-{uuid.uuid4().hex[:6]}"
        run_dir = self.run_dir / run_id
        run_dir.mkdir(parents=True, exist_ok=False)
        (run_dir / "stdout.log").write_text(result.stdout, encoding="utf-8")
        (run_dir / "stderr.log").write_text(result.stderr, encoding="utf-8")
        if result.returncode != 0 or not queue_path.exists():
            raise RuntimeError(f"queue builder failed or did not write pending queue; see {run_dir}")
        self.log("range queue built", startRank=start_rank, endRank=end_rank, output=str(output),
                 queueSummary=result.stdout.strip()[-1000:])
        return queue_path

    def _resolve_identity_holds(self, queue_path: Path) -> bool:
        cohort_dir = queue_path.parent
        review_path = cohort_dir / "identity-review.json"
        if not review_path.exists():
            return True
        document = json_read(review_path)
        held = document.get("cities", []) if isinstance(document, dict) else []
        if not held:
            self.state["queuePath"] = str(queue_path.resolve())
            self.state["queueSha256"] = sha256_file(queue_path)
            self.save_state()
            return True
        if not isinstance(held, list):
            raise ValueError(f"identity-review cities field is malformed: {review_path}")
        held = [item for item in held if self.state.get("identityReviews", {}).get(
            f"identity:{item['cityCode']}", {}).get("status") != "failed-skipped"]
        for start in range(0, len(held), 3):
            batch = held[start:start + 3]
            identities = [{"cityCode": str(item["cityCode"]), "name": item.get("name"), "rank": item.get("rank")}
                          for item in batch]
            task_ids = [f"identity:{item['cityCode']}" for item in identities]
            call = self._review_call([], [], identities)
            result = self.run_calls([call])[0]
            success, answer, systemic = self._complete_review([], [], identities, result)
            if systemic or self.stop_requested:
                self.state["status"] = "blocked" if systemic else "stopping"
                self.state["lastError"] = f"identity review interrupted or persistent Codex service failure: {task_ids}"
                self.save_state()
                return False
            updated = json_read(review_path)
            unresolved = {str(item.get("cityCode")) for item in updated.get("cities", [])}
            decisions = {str(item.get("cityCode", item.get("wupCityCode"))): item.get("decision")
                         for item in updated.get("resolvedDecisions", []) if isinstance(item, dict)}
            overlay_path = cohort_dir / "root-identity-decision-overlay.json"
            if overlay_path.exists():
                overlay = json_read(overlay_path)
                decisions.update({str(item.get("wupCityCode")): item.get("decision")
                                  for item in overlay.get("decisions", []) if isinstance(item, dict)})
            accepted = set((answer or {}).get("reviewedIds", []))
            for item in identities:
                code = item["cityCode"]
                task_id = f"identity:{code}"
                if task_id not in accepted or code in unresolved or decisions.get(code) not in {"confirmed_attempt", "different_settlement"}:
                    entry = self.state.setdefault("identityReviews", {}).setdefault(task_id, {})
                    self._skip_item(task_id, entry, "identity",
                                    "identity review unresolved after bounded attempts; city remains excluded from the eligible queue")
            self.log("identity review checkpoint; unresolved identities remain excluded", cityCodes=[item["cityCode"] for item in identities])
        self.state["queuePath"] = str(queue_path.resolve())
        self.state["queueSha256"] = sha256_file(queue_path)
        self.save_state()
        return True

    def _process_queue(self, queue_path: Path, *, once: bool) -> tuple[bool, int | None]:
        document, cities = self._load_queue(queue_path)
        cohort_dir = queue_path.parent
        self._ensure_root_tasks(cohort_dir, cities)
        roster_path = cohort_dir / str(document.get("sourceRoster", "ranked-population.json"))
        total_rank_count = 12138
        start_rank = min((int(city["rank"]) for city in cities), default=1)
        end_rank = max((int(city["rank"]) for city in cities), default=0)
        if roster_path.exists():
            try:
                counts = json_read(roster_path).get("counts", {})
                total_rank_count = int(counts.get("full2025CityRows", total_rank_count))
                roster = json_read(roster_path).get("roster", [])
                if roster:
                    start_rank = min(int(row["rank"]) for row in roster)
                    end_rank = max(int(row["rank"]) for row in roster)
            except (ValueError, TypeError, KeyError):
                pass
        self.state["queuePath"] = str(queue_path)
        self.state["queueSha256"] = sha256_file(queue_path)
        self.state["currentRankStart"] = start_rank
        self.state["currentRankEnd"] = end_rank
        self.state["totalRankCount"] = total_rank_count
        self.save_state()
        validated_done = 0
        for city in cities:
            entry = self._city_entry(city)
            packet = self._packet(city, cohort_dir)
            if packet.get("valid") and entry.get("status") in {"reviewed", "reviewed-held"}:
                validated_done += 1
        self.log("queue loaded", count=len(cities), rankStart=start_rank, rankEnd=end_rank,
                 validatedReviewedOnResume=validated_done, workers=self.args.workers)

        batch_number = 0
        while not self.stop_requested:
            research, review_only = self._select_batch(cities, cohort_dir)
            if not research and not review_only and not self._next_root_tasks(3):
                break
            batch_number += 1
            root_tasks = self._next_root_tasks(3)
            preexisting_review_items = review_only
            for item in preexisting_review_items:
                item["cohortDir"] = str(cohort_dir)
            reviewer_call = self._review_call(preexisting_review_items, root_tasks) if preexisting_review_items or root_tasks else None
            self.log(f"batch {batch_number}: starting research and serial review", progressCityCount=validated_done,
                     total=len(cities), researchCodes=[str(city["cityCode"]) for city in research],
                     reviewCodes=[str(city["cityCode"]) for city in preexisting_review_items], rootReviewCount=len(root_tasks))
            pending, review_result, systemic = self._record_city_attempts(research, cohort_dir, reviewer_call)
            if reviewer_call is not None and not preexisting_review_items and not research:
                review_results = self.run_calls([reviewer_call])
                review_result = review_results[0]
            success = True
            if preexisting_review_items or root_tasks:
                success, _answer, review_systemic = self._complete_review(preexisting_review_items, root_tasks, first_result=review_result)
                systemic = systemic or review_systemic
            if not success:
                if systemic or self.stop_requested:
                    self.state["status"] = "blocked" if systemic else "stopping"
                    self.state["lastError"] = "serial review interrupted or persistent Codex service failure"
                    self.save_state()
                    return False, None
                self._skip_unreviewed(preexisting_review_items, root_tasks,
                                      "serial reviewer did not persist a valid review receipt after bounded retries")
            new_review_items = []
            for city in research:
                packet = self._packet(city, cohort_dir)
                if packet.get("valid") and self._city_entry(city).get("status") == "research-complete":
                    new_review_items.append({**city, "cityPath": str(packet["cityPath"]), "cohortDir": str(cohort_dir)})
            if new_review_items:
                new_reviewer = self._review_call(new_review_items, [])
                result = self.run_calls([new_reviewer])[0]
                success, _answer, review_systemic = self._complete_review(new_review_items, [], first_result=result)
                systemic = systemic or review_systemic
                if not success:
                    if systemic or self.stop_requested:
                        self.state["status"] = "blocked" if systemic else "stopping"
                        self.state["lastError"] = "serial review interrupted or persistent Codex service failure"
                        self.save_state()
                        return False, None
                    self._skip_unreviewed(new_review_items, [],
                                          "serial reviewer did not persist a valid review receipt after bounded retries")
            self.save_state()
            if systemic:
                self.state["status"] = "blocked"
                self.state["systemicFailure"] = "persistent authentication/rate-limit/systemic failure after bounded retries"
                self.state["lastError"] = self.state["systemicFailure"]
                self.save_state()
                self.log("stopping because a systemic failure persisted after bounded retries", details=self.state["systemicFailure"])
                return False, None
            if once:
                return True, end_rank
            self.log("batch checkpoint", batch=batch_number, reviewedCount=sum(
                1 for code in self.state["cities"] if self.state["cities"][code].get("status") in {"reviewed", "reviewed-held"}),
                failedSkippedCount=sum(1 for code in self.state["cities"] if self.state["cities"][code].get("status") == "failed-skipped"))
            if self.stop_requested:
                return False, None

        skipped = [str(city["cityCode"]) for city in cities
                   if self._city_entry(city).get("status") == "failed-skipped"]
        if skipped:
            self.log("rank range finished with recorded city failures; advancing remaining queue",
                     failedCityCodes=skipped, rankEnd=end_rank)
        if self._next_root_tasks(1):
            self.state["status"] = "blocked"
            self.state["lastError"] = "root review tasks remain after queue completion; refusing rank advancement"
            self.save_state()
            return False, None
        return True, end_rank

    def run(self) -> int:
        if not self.args.run:
            print("Use --run to start the persistent Valhalla parcel-research job. No work was started.")
            return 0
        if not (1 <= self.args.workers <= MAX_WORKERS):
            raise ValueError("--workers must be between 1 and 3")
        if not (1 <= self.args.max_retries <= MAX_RETRIES):
            raise ValueError("--max-retries must be between 1 and 3")
        self.acquire_lock()
        queue_path = self._queue_path()
        self.load_state(queue_path)
        previous_handlers = {}
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[sig] = signal.signal(sig, self.request_stop)
        self.state["status"] = "running"
        self.save_state()
        self.log("job loop started", jobName=self.args.job_name, statePath=str(self.state_path), queuePath=str(queue_path),
                 maxTurnMinutes=round(self.args.timeout_seconds / 60), retryLimit=self.args.max_retries,
                 noAutoCommit=True, noAutoDeploy=True)
        try:
            current_queue = queue_path
            self._activate_queue(current_queue)
            while not self.stop_requested:
                if not self._resolve_identity_holds(current_queue):
                    return 2
                okay, range_end = self._process_queue(current_queue, once=self.args.once)
                if not okay:
                    return 2
                if self.args.once:
                    self.state["status"] = "paused-checkpointed"
                    self.save_state()
                    return 0
                if range_end is None:
                    range_end = self.state.get("currentRankEnd") or 0
                if range_end >= int(self.state.get("totalRankCount", 12138)):
                    self.state["status"] = "complete-with-failures" if self.state.get("failedItems") else "complete"
                    self.state["completedAt"] = utc_now()
                    self.save_state()
                    self.log("all ranked WUP city research ranges exhausted", totalRankCount=range_end)
                    return 0
                start_rank = int(range_end) + 1
                end_rank = min(start_rank + self.args.range_size - 1, int(self.state.get("totalRankCount", 12138)))
                current_queue = self._write_queue_builder(start_rank, end_rank)
                self._activate_queue(current_queue)
                if not self._resolve_identity_holds(current_queue):
                    return 2
            self.state["status"] = "stopped-checkpointed"
            self.save_state()
            return 0
        except Exception as exc:
            self.state["status"] = "blocked"
            self.state["lastError"] = str(exc)
            self.save_state()
            self.log("job stopped with a recorded error", error=str(exc))
            return 2
        finally:
            if self.stop_requested:
                self.stop_children()
                self.state["status"] = "stopped-checkpointed"
                self.save_state()
                self.log("stopped after process-group shutdown; checkpoints and logs retained")
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)
            if self.lock_stream:
                fcntl.flock(self.lock_stream.fileno(), fcntl.LOCK_UN)
                self.lock_stream.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="start the persistent resumable job")
    parser.add_argument("--status", action="store_true", help="report persisted state, actual PID identity, active children, and heartbeat")
    parser.add_argument("--stop", action="store_true", help="send SIGTERM to this runner only; it checkpoints and stops its owned Codex groups")
    parser.add_argument("--once", action="store_true", help="checkpoint after one batch (one to three city workers plus one review)")
    parser.add_argument("--workers", type=int, default=3, help="parallel city research workers (1-3; default 3)")
    parser.add_argument("--job-name", default="valhalla-parcel-research", help="persistent state/log job name")
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--queue", type=Path, default=DEFAULT_QUEUE)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="official local WUP 2025 gzip source for later ranges")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--codex", help="Codex CLI executable (default: codex from PATH)")
    parser.add_argument("--max-turn-minutes", type=int, default=90, help="per Codex turn timeout, capped at 90 minutes")
    parser.add_argument("--max-retries", type=int, default=3, help="per-city/per-review retry cap (maximum 3)")
    parser.add_argument("--range-size", type=int, default=100, help="rank range generated after the first fixed queue")
    parser.add_argument("--total-ranks", type=int, default=12138, help="safety ceiling; normally read from WUP source roster")
    parser.add_argument("--poll-seconds", type=float, default=POLL_SECONDS, help=argparse.SUPPRESS)
    parser.add_argument("--grace-seconds", type=float, default=TERM_GRACE_SECONDS, help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.status or args.stop:
        root = args.repo_root.resolve()
        state_dir = (root / args.state_dir).resolve() if not args.state_dir.is_absolute() else args.state_dir.resolve()
        state_path = state_dir / "state.json"
        if not state_path.exists():
            print(json.dumps({"status": "missing", "statePath": str(state_path), "pid": None, "pidAlive": False,
                              "pidIdentityVerified": False, "activeProcesses": [], "heartbeat": None}, indent=2))
            return 2 if args.stop else 0
        try:
            state = json_read(state_path)
        except Exception as exc:
            print(json.dumps({"status": "invalid-state", "statePath": str(state_path), "error": str(exc)}, indent=2))
            return 2
        pid = state.get("pid")
        pid_alive = False
        if isinstance(pid, int) and pid > 1:
            try:
                os.kill(pid, 0)
                pid_alive = True
            except (ProcessLookupError, PermissionError):
                pid_alive = False
        command_line = ""
        if pid_alive:
            proc_cmd = Path(f"/proc/{pid}/cmdline")
            if proc_cmd.exists():
                command_line = proc_cmd.read_bytes().replace(b"\0", b" ").decode(errors="replace")
            else:
                try:
                    command_line = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=3).stdout.strip()
                except Exception:
                    command_line = ""
        identity_verified = bool(pid_alive and str(Path(__file__).resolve()) in command_line)
        saved_start_identity = state.get("pidStartIdentity")
        current_start_identity = process_start_identity(pid) if pid_alive else None
        if saved_start_identity is not None:
            identity_verified = identity_verified and current_start_identity == saved_start_identity
        active = []
        for child in state.get("activeProcesses", []):
            child_pid = child.get("pid")
            alive = False
            if isinstance(child_pid, int) and child_pid > 1:
                try:
                    os.kill(child_pid, 0)
                    alive = True
                except (ProcessLookupError, PermissionError):
                    pass
            active.append({**child, "pidAlive": alive})
        heartbeat_age = None
        try:
            heartbeat = datetime.fromisoformat(str(state.get("heartbeat")).replace("Z", "+00:00"))
            heartbeat_age = max(0, int((datetime.now(timezone.utc) - heartbeat).total_seconds()))
        except (ValueError, TypeError):
            heartbeat = None
        if args.stop:
            if not identity_verified:
                print(json.dumps({"stopped": False, "reason": "runner PID is not live with this exact script path", "pid": pid,
                                  "pidAlive": pid_alive, "pidIdentityVerified": False, "statePath": str(state_path)}, indent=2))
                return 2
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                    still_alive = True
                except (ProcessLookupError, PermissionError):
                    still_alive = False
                current_identity = process_start_identity(pid) if still_alive else None
                if not still_alive or (saved_start_identity is not None and current_identity != saved_start_identity):
                    print(json.dumps({"stopped": True, "stopRequested": True, "signal": "SIGTERM", "pid": pid,
                                      "pidIdentityVerified": True, "message": "runner process exited after checkpoint and owned child shutdown"}, indent=2))
                    return 0
                time.sleep(0.5)
            print(json.dumps({"stopped": False, "stopRequested": True, "signal": "SIGTERM", "pid": pid,
                              "pidIdentityVerified": True, "message": "stop requested; check --status for observed shutdown"}, indent=2))
            return 0
        print(json.dumps({"jobName": state.get("jobName"), "status": state.get("status"), "statePath": str(state_path),
                          "pid": pid, "pidAlive": pid_alive, "pidIdentityVerified": identity_verified,
                          "runnerCommandLine": command_line if pid_alive else None,
                          "heartbeat": state.get("heartbeat"), "heartbeatAgeSeconds": heartbeat_age,
                          "queuePath": state.get("queuePath"), "currentRankStart": state.get("currentRankStart"),
                          "currentRankEnd": state.get("currentRankEnd"), "activeProcesses": active,
                          "failedSkippedCount": len(state.get("failedItems", {})),
                          "lastError": state.get("lastError")}, indent=2))
        return 0
    if not args.run:
        parser.print_help()
        return 0
    if not 1 <= args.max_turn_minutes <= 90:
        parser.error("--max-turn-minutes must be between 1 and 90")
    if not 1 <= args.max_retries <= MAX_RETRIES:
        parser.error("--max-retries must be between 1 and 3")
    if not 1 <= args.range_size <= 100:
        parser.error("--range-size must be between 1 and 100")
    if args.total_ranks < 1:
        parser.error("--total-ranks must be positive")
    args.timeout_seconds = args.max_turn_minutes * 60
    try:
        return Runner(args).run()
    except Exception as exc:
        print(f"[{utc_now()}] runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
