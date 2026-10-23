#!/usr/bin/env python3
"""Extract city knowledge once, then retire the explicitly selected research artifacts."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from parcel_city_records import extract_failed_urls, record_failed_urls, urls_from_document
from parcel_city_storage import compact_row, export_settings, terminal
from parcel_qualification_workspaces import discard_workspace


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".compact-tmp")
    options = {"indent": 2} if path.name == "city-demographics.json" else {"separators": (",", ":")}
    temporary.write_text(json.dumps(value, ensure_ascii=False, **options) + "\n")
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    temporary.replace(path)
    if read(path) != value:
        raise RuntimeError("compact record readback failed")


def code_for(value, path):
    if not isinstance(value, dict):
        return None
    candidates = [value.get("cityCode"), value.get("wupCityCode"),
                  value.get("city", {}).get("code") if isinstance(value.get("city"), dict) else None]
    for item in candidates:
        if item is not None and str(item).isdigit() and int(item) > 0:
            return str(item)
    for name in (path.name, str(value.get("cityId", "")), str(value.get("cityRecord", "")), str(value.get("taskId", ""))):
        match = re.search(r"(?:city[-_:]|wup2025:)(\d+)(?:\D|$)", name)
        if match:
            return match[1]
    return None


def check_stopped(state):
    for pid in [state.get("pid"), *(item.get("pid") for item in state.get("pipelineActive", [])),
                *(item.get("pid") for item in state.get("activeProcesses", []))]:
        if not isinstance(pid, int) or pid <= 1:
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise RuntimeError("research process is still alive; stop the selected services first")


def adapter_hashes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (root / "backend/parcels").rglob("*")
            if path.is_file() and path.suffix in {".js", ".mjs", ".cjs"}}


def referenced_city_files(repo):
    """Resolve existing explicit registry file references, never city-name guesses."""
    repo = Path(repo)
    registry = read(repo / "world-parcels/registry.json")
    demographics = read(repo / "world-parcels/report/city-demographics.json")
    mapped = {key: str(row["wupCityCode"]) for row in demographics["cities"] if row.get("wupCityCode")
              for key in [*row.get("registryCityIds", []), *row.get("appCityIds", [])]}
    result, ambiguous = {}, set()
    def refs(value):
        if isinstance(value, str) and value.endswith((".json", ".geojson")) and not value.startswith(("http:", "https:")):
            yield value
        elif isinstance(value, dict):
            for child in value.values(): yield from refs(child)
        elif isinstance(value, list):
            for child in value: yield from refs(child)
    for row in registry["cities"]:
        code = str(row.get("wupCityCode") or mapped.get(row.get("cityId")) or mapped.get(row.get("appCityId")) or "")
        if not code.isdigit(): continue
        for value in refs(row):
            target = (repo / value if value.startswith(("world-parcels/", "tmp/")) else repo / "world-parcels" / value).resolve()
            if target in result and result[target] != code: ambiguous.add(target)
            result[target] = code
    return {key: code for key, code in result.items() if key not in ambiguous}


def extract_tree(root, knowledge, *, apply, identities=None, sources=None, code_paths=None):
    counts = Counter()
    for path in root.rglob("*.json"):
        if path.is_symlink() or any(part in {"node_modules", ".git", "pipeline-tasks", "base-snapshots", "history", "input-history"} for part in path.parts):
            continue
        if path.name in {"state.json", "input.json", "result.json", "candidate.json"} or path.stat().st_size > 16 * 2**20:
            continue
        try:
            document = read(path)
        except (ValueError, OSError):
            continue
        # Reduce old failed qualification ledgers to URL lists. Their exact WUP
        # identity remains in the existing app gazetteer, not another history file.
        for row in (document.get("cities") or []) if isinstance(document, dict) else []:
            if not isinstance(row, dict) or row.get("outcome") != "held":
                continue
            code = str(row.get("cityCode", ""))
            if not code.isdigit():
                continue
            point = row.get("point")
            if identities is not None and code not in identities and isinstance(point, list) and len(point) == 2:
                identities[code] = {"id": f"wup2025:{code}", "wupCityCode": int(code),
                    "name": row.get("cityName"), "wupName": row.get("cityName"), "countryCode": row.get("countryCode"),
                    "latitude": point[0], "longitude": point[1], "wupLatitude": point[0], "wupLongitude": point[1],
                    "registryCityIds": [], "appCityIds": [], "population2015": None, "population2025": None}
            urls = [{"url": sources[source_id], "reason": row.get("summary", "qualification did not succeed")}
                    for source_id in (row.get("sourceIds") or []) if sources and source_id in sources]
            if apply:
                record_failed_urls(knowledge, code, urls)
            counts["failedCityChecks"] += 1
        code = code_for(document, path) or (code_paths or {}).get(path.resolve())
        if code is None:
            continue
        rows = extract_failed_urls(document)
        if isinstance(document, dict):
            rows.extend(document.get("failedUrls", []) if isinstance(document.get("failedUrls"), list) else [])
            decision = document.get("decision", document.get("discoveryDecision"))
            negative = (isinstance(decision, str) and decision in {"rejected", "blocked"}) or (document.get("status") == "complete" and document.get("verifiedSample") is not True)
            if negative:
                rows.extend({"url": url} for url in urls_from_document(document))
        if rows:
            if apply:
                record_failed_urls(knowledge, code, rows)
            counts["documents"] += 1
            counts["urlRecords"] += len(rows)
    return dict(counts)


def retire(path):
    path = Path(path)
    if not path.exists():
        return
    if path.is_symlink():
        raise ValueError("retired artifact root must not be a symlink")
    # These explicitly selected trees contain disposable research, not repositories.
    sensitive = re.compile(r"^\.env(?:\.|$)|(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)|\.(?:key|pem|p12|pfx)$", re.I)
    for directory, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [name for name in dirs if name not in {"node_modules", ".git"}]
        for name in files:
            if sensitive.search(name):
                raise RuntimeError(f"private file must be rescued before cleanup: {name}")
    shutil.rmtree(path)


def retire_native_sessions(session_root, job_roots):
    """Remove only noninteractive task transcripts belonging to the selected jobs."""
    count, size = 0, 0
    for path in Path(session_root).rglob("*.jsonl"):
        if path.is_symlink():
            continue
        try:
            with path.open() as stream:
                metadata = json.loads(stream.readline()).get("payload", {})
            cwd = str(metadata.get("cwd", ""))
            if metadata.get("source") != "exec" or not any(
                    cwd == str(root) or cwd.startswith(str(root) + "/")
                    or cwd.startswith(str(root) + "-qualification-") for root in job_roots):
                continue
            size += path.stat().st_size
            path.unlink()
            count += 1
        except (OSError, ValueError):
            continue
    return {"files": count, "bytes": size}


def simplify(shared, jobs, retired, *, apply=False):
    shared = Path(shared).resolve()
    before = adapter_hashes(shared)
    states = []
    for root, state_relative in jobs:
        root = Path(root).resolve()
        state_dir = (root / state_relative).resolve()
        state_dir.relative_to(root / "tmp")
        state_path = state_dir / "state.json"
        state = read(state_path)
        check_stopped(state)
        queue = Path(state["queuePath"])
        queue.relative_to(root / "tmp")
        states.append((root, state_dir, state_path, state, queue))
    if apply:
        export_settings(shared)
        # Every accepted source must survive in its working city settings.
        # An unpublished source may have no current app binding.
        for _, _, _, state, _ in states:
            for code, row in state["cities"].items():
                if (row.get("admission", {}).get("status") == "integrated"
                        and row.get("qualification", {}).get("status") == "integrated"):
                    setting = read(shared / "world-parcels/cities" / code / "settings.json")
                    if not setting.get("sources"):
                        raise RuntimeError("an admitted result is missing its working source settings")
    stats = {"extracted": [], "jobs": []}
    demographics_path = shared / "world-parcels/report/city-demographics.json"
    demographics = read(demographics_path)
    identities = {str(row.get("wupCityCode")): row for row in demographics["cities"]}
    for _, _, _, _, queue in states:
        for row in read(queue)["cities"]:
            code, point = str(row["cityCode"]), row.get("point")
            if code not in identities and isinstance(point, list) and len(point) == 2:
                identities[code] = {"id": f"wup2025:{code}", "wupCityCode": int(code), "name": row.get("name"),
                    "wupName": row.get("name"), "countryCode": row.get("iso2"),
                    "latitude": point[0], "longitude": point[1], "wupLatitude": point[0], "wupLongitude": point[1],
                    "registryCityIds": [], "appCityIds": [], "population2015": None,
                    "population2025": row["pop2025k"] * 1000 if isinstance(row.get("pop2025k"), (int, float)) else None}
    sources = {row["id"]: row["endpoint"] for row in read(shared / "frontend/data/source-catalog.json")["sources"]}
    scan_roots = set()
    code_paths = {}
    for root, _, _, _, _ in states:
        code_paths.update(referenced_city_files(root))
        scan_roots.add(root / "world-parcels/research")
        scan_roots.add(root / "tmp")
        for metadata in (root / "tmp").glob("*/qualification-workspaces/slot-*.json"):
            workspace_root = Path(read(metadata)["root"]).resolve()
            if workspace_root.is_dir(): scan_roots.add(workspace_root / "tmp")
    scan_roots.add(shared / "world-parcels/research")
    code_paths.update(referenced_city_files(shared))
    for extra in retired:
        extra = Path(extra).resolve()
        allowed = (extra.name == "rescue-parcel-research-valhalla-20261012" and extra.parent == Path.home() / "tmp"
                   or extra.name.startswith("parcel-continuous-bootstrap-") and extra.parent == Path("/tmp"))
        if not allowed:
            raise ValueError("retired external tree is outside the named research cleanup scope")
        scan_roots.add(extra)
    if apply:
        artifacts = []
        for directory in scan_roots:
            if not directory.exists(): continue
            for candidate in directory.rglob("candidate.json"):
                if any(part in {"history", "input-history", "pipeline-tasks", "node_modules"} for part in candidate.parts): continue
                evidence = candidate.parent / "evidence" if (candidate.parent / "evidence").is_dir() else candidate.parent
                qualification = evidence / "qualification.json"
                if qualification.is_file() and (evidence / "full-safe.geojson").is_file():
                    artifacts.append((qualification.stat().st_mtime_ns, str(candidate.parent)))
        # Newest verified input wins for an otherwise unconfigured city.
        listing = shared / "tmp/compact-qualified-settings-inputs.json"
        write(listing, [path for _, path in sorted(artifacts, reverse=True)])
        recovered = subprocess.run(["node", str(shared / "scripts/lib/parcel-city-settings.mjs"),
                                   "--root", str(shared), "--recover-qualified-list", str(listing)],
                                  text=True, capture_output=True, cwd=shared, timeout=300)
        if recovered.returncode:
            raise RuntimeError("qualified-source settings recovery failed: " + recovered.stderr[-1000:])
        result = json.loads(recovered.stdout)
        stats["recoveredWorkingSources"] = len(set(result["recovered"]))
        stats["qualificationArtifactsChecked"] = len(artifacts)
        for code in result["recovered"]:
            settings = read(shared / "world-parcels/cities" / code / "settings.json")
            if not settings.get("sources"): raise RuntimeError("working source settings readback failed")
        listing.unlink()
    for directory in sorted(scan_roots):
        if directory.exists():
            stats["extracted"].append({"tree": directory.name, **extract_tree(directory, shared, apply=apply,
                                                                            identities=identities, sources=sources,
                                                                            code_paths=code_paths)})
    if apply:
        known = {str(row.get("wupCityCode")) for row in demographics["cities"]}
        demographics["cities"].extend(row for code, row in identities.items() if code not in known)
        write(demographics_path, demographics)
    for root, state_dir, state_path, state, queue in states:
        # Save source URLs from terminal failed candidates before dropping their packets.
        for code, row in state["cities"].items():
            if not apply:
                continue
            if row.get("status") == "pending" and not row.get("attempts") and not row.get("storageComplete"):
                continue
            urls = []
            if row.get("discoveryDecision") == "candidate" and row.get("qualification", {}).get("status") in {"failed", "blocked-source", "rejected-source", "integration-blocked"}:
                receipt = queue.parent / "root-review-receipts" / f"city_{code}.json"
                if receipt.exists():
                    endpoint = read(receipt).get("source", {}).get("endpoint")
                    if endpoint:
                        urls.append({"url": endpoint, "reason": row.get("qualification", {}).get("summary", "qualification did not succeed")})
            record_failed_urls(shared, code, urls)
        compact = {}
        reset = 0
        for code, row in state["cities"].items():
            if terminal(row):
                compact[code] = compact_row(row)
            else:
                compact[code] = {"wupIdentity": row["wupIdentity"], "status": "pending", "attempts": 0}
                reset += 1
        if apply:
            for metadata_path in (state_dir / "qualification-workspaces").glob("slot-*.json"):
                metadata = read(metadata_path)
                discard_workspace({"root": Path(metadata["root"]), "metadataPath": metadata_path,
                                   "slot": metadata["slot"], "runId": metadata["runId"], "branch": metadata["branch"]})
            queue_doc = read(queue)
            for city in queue_doc["cities"]:
                city.pop("priorEvidence", None)
            write(queue, queue_doc)
            clean_state = {key: state[key] for key in ("schemaVersion", "jobName", "startedAt", "researchPolicy",
                           "rankedRosterSourceSha256", "currentRankStart", "currentRankEnd", "totalRankCount") if key in state}
            clean_state.update(status="stopped-checkpointed", queuePath=str(queue),
                               queueSha256=hashlib.sha256(queue.read_bytes()).hexdigest(), cities=compact,
                               rootReviewTasks={}, pipeline={"schemaVersion": 1, "tasks": {}},
                               activeProcesses=[], pipelineActive=[], lastError=None, systemicFailure=None)
            write(state_path, clean_state)
            # Keep only scheduler inputs, active-state control and dependency code.
            keep_top = {state_dir.name, queue.parent.name, "parcel-shared-runtime", "overnight-cities-2026-10-09"}
            for path in list((root / "tmp").iterdir()):
                if path.name not in keep_top:
                    if path.is_dir(): retire(path)
                    else: path.unlink()
            for path in list(state_dir.iterdir()):
                if path.name not in {"state.json", "runner.lock"}:
                    if path.is_dir(): retire(path)
                    else: path.unlink()
            for path in list(queue.parent.iterdir()):
                if path.name not in {queue.name, "known-sources.json"}:
                    if path.is_dir(): retire(path)
                    else: path.unlink()
            bootstrap = root / "tmp/parcel-shared-runtime/bootstrap-backups"
            if bootstrap.exists(): retire(bootstrap)
        stats["jobs"].append({"job": state.get("jobName"), "completed": sum(row.get("storageComplete", False) for row in compact.values()),
                              "pending": reset, "progressBytes": len(json.dumps(compact).encode())})
    if apply:
        for root in {shared, *(row[0] for row in states)}:
            directory = root / "world-parcels/research"
            if directory.exists(): retire(directory)
            directory.mkdir(parents=True, exist_ok=True)
        for path in retired:
            retire(Path(path))
        stats["nativeTaskSessions"] = retire_native_sessions(Path.home() / ".codex/sessions", [row[0] for row in states])
        if adapter_hashes(shared) != before:
            raise RuntimeError("adapter implementation bytes changed during data cleanup")
        # Failed URL locks are operational; city directories contain only the two records.
        for path in (shared / "world-parcels/cities").rglob("*"):
            if path.is_file() and path.name not in {"settings.json", "failed-urls.json"}:
                raise RuntimeError("unexpected permanent city artifact")
    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shared-root", type=Path, required=True)
    parser.add_argument("--job", nargs=2, action="append", required=True, metavar=("ROOT", "STATE_DIR"))
    parser.add_argument("--retire", type=Path, action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(simplify(args.shared_root, args.job, args.retire, apply=args.apply), indent=2), flush=True)
