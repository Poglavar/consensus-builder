"""Keep city knowledge small; stage evidence exists only until its result is accepted."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from contextlib import nullcontext
from pathlib import Path

from parcel_city_records import extract_failed_urls, record_failed_urls, urls_from_document

TERMINAL_QUALIFICATIONS = {"integrated", "failed", "blocked-source", "rejected-source", "integration-blocked"}
MAX_PROBE_SCRATCH_BYTES = 64 * 1024 * 1024


def download_policy():
    return """DOWNLOAD STORAGE POLICY: Fetch only when a live check needs data. Prefer bbox/ID filters,
feature limits, HTTP ranges or streaming reads; stop after the required parcel samples.
Keep at most three unchanged parcel polygons as research proof. Never download a national
dataset, extract a whole archive, or keep duplicate raw/transformed datasets just to prove a source.
Cap every streamed download at 16 MiB and all downloads/extractions at 64 MiB per active city;
check actual streamed/extracted bytes, not just Content-Length. Extract only the needed member.
If no bounded read is possible, record the specific limitation and try another source route.
All raw downloads and extraction scratch belong under tmp/valhalla-parcel-research/<cityCode>/
or the provided TMPDIR. Delete them immediately after the check, including on failure.
Only compact, safe request/result metadata and the required unchanged sample polygons belong
in the stage's evidence directory. Never reference scratch files as qualification inputs or
runtime dependencies: scratch is deleted after every model turn and stage, even on interruption.
Missing old scratch is expected; fetch only the small input needed for the current check.
Working settings, failed URLs and adapter code preserve the result, never downloaded datasets.
"""


def city_download_path(root, code):
    code = str(code)
    if not code.isascii() or not code.isdigit():
        raise ValueError("download cleanup requires a numeric city code")
    base = Path(root) / "tmp/valhalla-parcel-research"
    if base.is_symlink() or (Path(root) / "tmp").is_symlink():
        raise ValueError("download cleanup refuses a symlink namespace")
    return base / code


def clear_city_downloads(root, codes):
    for code in codes:
        path = city_download_path(root, code)
        if path.exists() or path.is_symlink():
            remove_owned(path, path.parent)


def download_limit_error(root, codes, temporary=None, outputs=()):
    paths = [city_download_path(root, code) for code in codes]
    if temporary is not None:
        paths.append(Path(temporary))
    for output in outputs:
        path = Path(output).resolve()
        path.relative_to(Path(root).resolve())
        if path == Path(root).resolve():
            raise ValueError("probe output must be a child directory")
        paths.append(path)
    # Bound the entire call, including implicit tempfile downloads. A reviewer
    # may inspect multiple cities, but never gets a larger download allowance.
    size = 0
    for path in paths:
        if path.is_symlink():
            return "probe scratch must not be a symlink"
        for directory, dirs, files in os.walk(path, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
            for name in files:
                try:
                    size += (Path(directory) / name).lstat().st_size
                except FileNotFoundError:
                    continue
                if size > MAX_PROBE_SCRATCH_BYTES:
                    return "probe downloads exceeded 64 MiB; use bounded/streaming reads and delete raw data"
    return None


def knowledge_root(runner):
    return Path(getattr(runner.args, "shared_root", None) or runner.root).resolve()


def forget_histories(cities):
    """Past attempts are represented by failed URLs, never copied into later tasks."""
    for row in cities.values():
        for key in ("qualificationHistory", "reviewHistory", "attemptHistory", "sharedFindings"):
            row.pop(key, None)


def city_documents(runner, city, cohort):
    packet = runner._packet(city, cohort)
    paths = [packet.get("cityPath"), packet.get("reviewPath")]
    receipt_path = runner._receipt_path(f"city:{city['cityCode']}")
    paths.append(receipt_path)
    documents = []
    for value in paths:
        if not value:
            continue
        path = Path(value)
        if not path.is_absolute():
            path = runner.root / path
        path.resolve().relative_to(runner.root.resolve())
        if path.is_file() and not path.is_symlink():
            document = json.loads(path.read_text())
            documents.append((path, document))
    return documents


def record_attempts(runner, city, cohort):
    rows = []
    for _, document in city_documents(runner, city, cohort):
        rows.extend(extract_failed_urls(document))
        if isinstance(document, dict):
            rows.extend(document.get("failedUrls", []))
    return record_failed_urls(knowledge_root(runner), city["cityCode"], rows)


def terminal(row):
    if row.get("storageComplete"):
        return True
    if (row.get("admission", {}).get("status") == "integrated"
            and row.get("qualification", {}).get("status") not in {"failed", "integration-blocked"}):
        return True
    if row.get("status") == "failed-skipped":
        return True
    if row.get("discoveryDecision") in {"rejected", "blocked", "already-supported"}:
        return True
    return (row.get("discoveryDecision") == "candidate"
            and row.get("qualification", {}).get("status") in TERMINAL_QUALIFICATIONS)


def compact_row(row):
    """Operational progress has no evidence, snapshots, manifests, or copied settings."""
    result = {key: row[key] for key in ("wupIdentity", "status", "attempts", "discoveryDecision", "lastError")
              if key in row}
    reason = failure_reason(row)
    if reason and row.get("qualification", {}).get("status") != "integrated":
        result["lastError"] = reason[:2000]
    for key in ("qualification", "admission"):
        if key == "admission" and row.get("qualification", {}).get("status") in {"failed", "integration-blocked"}:
            continue
        if row.get(key):
            result[key] = {"status": row[key].get("status")}
    if result.get("admission", {}).get("status") == "integrated":
        result["qualification"] = {"status": "integrated"}
    result["storageComplete"] = True
    return result


def failure_reason(row):
    qualification = row.get("qualification", {})
    admission = row.get("admission", {})
    nested_admission = qualification.get("admission", {})
    return (admission.get("summary")
            or nested_admission.get("summary")
            or qualification.get("summary")
            or row.get("lastError"))


def export_settings(root, codes=None):
    command = ["node", str(Path(root) / "scripts/lib/parcel-city-settings.mjs"), "--root", str(root)]
    if codes:
        command.extend(map(str, codes))
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f"city settings export failed: {result.stderr[-1000:]}")
    rebuilt = subprocess.run([*command, "--apply"], cwd=root, text=True, capture_output=True, timeout=90)
    if rebuilt.returncode:
        raise RuntimeError(f"city settings regeneration failed: {rebuilt.stderr[-1000:]}")
    for code in codes or []:
        file = Path(root) / "world-parcels/cities" / str(code) / "settings.json"
        saved = json.loads(file.read_text())
        if str(saved.get("cityCode")) != str(code):
            raise RuntimeError("city settings readback has the wrong WUP identity")


def remove_owned(path, base):
    """Never follow an evidence reference into another city or an external directory."""
    path, base = Path(path), Path(base).resolve()
    if path.is_symlink():
        raise ValueError("temporary research cleanup refuses symlinks")
    resolved = path.resolve()
    resolved.relative_to(base)
    if resolved == base:
        raise ValueError("temporary research cleanup requires a child path")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def recover_qualified_settings(runner, code, artifact_root):
    """Preserve a hash-verified technical qualification before its temporary workspace is removed."""
    root = Path(runner.root).resolve()
    artifact_root = Path(artifact_root)
    artifact_root = artifact_root if artifact_root.is_absolute() else root / artifact_root
    artifact_root = artifact_root.resolve()
    artifact_root.relative_to(root)
    candidate = artifact_root / "candidate.json"
    if not candidate.is_file() or candidate.is_symlink():
        return False
    temp_dir = root / "tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    listing = temp_dir / f"qualified-settings-{uuid.uuid4().hex}.json"
    listing.write_text(json.dumps([str(artifact_root)]) + "\n")
    command = ["node", str(root / "scripts/lib/parcel-city-settings.mjs"), "--root", str(root),
               "--recover-qualified-list", str(listing)]
    writer = getattr(runner, "_shared_write", None)
    try:
        with writer() if callable(writer) else nullcontext():
            result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=90)
            if result.returncode:
                raise RuntimeError(f"qualified-source settings recovery failed: {result.stderr[-1000:]}")
            try:
                answer = json.loads(result.stdout)
            except (ValueError, TypeError) as exc:
                raise RuntimeError("qualified-source settings recovery returned invalid output") from exc
            recovered = str(code) in {str(value) for value in answer.get("recovered", [])}
    finally:
        listing.unlink(missing_ok=True)
    return recovered


def finish_city(runner, city, cohort):
    row = runner._city_entry(city)
    if row.get("qualification", {}).get("workspaceDiscardError"):
        raise RuntimeError(row["qualification"]["workspaceDiscardError"])
    if row.get("storageComplete") or not terminal(row):
        return False
    documents = city_documents(runner, city, cohort)
    manifest = row.get("admission", {}).get("manifestFile")
    failed = []
    reason = failure_reason(row)
    negative = row.get("discoveryDecision") in {"blocked", "rejected"}
    for _, document in documents:
        failed.extend(extract_failed_urls(document))
        if isinstance(document, dict):
            failed.extend(document.get("failedUrls", []))
        if negative:
            failed.extend({"url": url, **({"reason": reason} if reason else {})}
                          for url in urls_from_document(document))
    if (row.get("discoveryDecision") == "candidate"
            and row.get("qualification", {}).get("status") in {"blocked-source", "rejected-source"}):
        for _, document in documents:
            source = document.get("source") if isinstance(document, dict) else None
            endpoint = source.get("endpoint") if isinstance(source, dict) else None
            if endpoint:
                failed.append({"url": endpoint, **({"reason": reason} if reason else {})})
    record_failed_urls(knowledge_root(runner), city["cityCode"], failed)
    if (row.get("admission", {}).get("status") == "integrated"
            and row.get("qualification", {}).get("status") not in {"failed", "integration-blocked"}
            or row.get("discoveryDecision") == "already-supported"):
        writer = getattr(runner, "_shared_write", None)
        with writer() if callable(writer) else nullcontext():
            export_settings(runner.root, [city["cityCode"]])
    elif row.get("discoveryDecision") == "candidate":
        artifact_root = row.get("qualification", {}).get("artifactRoot")
        if artifact_root:
            recover_qualified_settings(runner, city["cityCode"], artifact_root)
    # Commit the compact progress marker before discarding temporary inputs.
    compact = compact_row(row)
    row.clear()
    row.update(compact)
    runner.save_state()
    for path, _ in documents:
        # Source packets and receipts are pipeline-owned temporary files. Shared app
        # configuration and independent runtime datasets are never cleanup targets.
        if Path(cohort).resolve() in path.resolve().parents:
            remove_owned(path, cohort)
    for _, document in documents:
        for sample in _sample_paths(document):
            path = Path(sample)
            path = path if path.is_absolute() else Path(cohort) / path
            if Path(cohort).resolve() in path.resolve().parents and path.suffix.lower() in {".json", ".geojson"}:
                remove_owned(path, cohort)
    for path, base in ((runner.state_dir / "qualification/cities" / str(city["cityCode"]), runner.state_dir),
                       (runner.root / "tmp/valhalla-parcel-research" / str(city["cityCode"]), runner.root / "tmp/valhalla-parcel-research"),
                       (Path(cohort) / "source-evidence" / str(city["cityCode"]), cohort),
                       (Path(cohort) / "retry-source-evidence" / str(city["cityCode"]), cohort),
                       (runner._receipt_path(f"city:{city['cityCode']}").parent / "source-evidence" / str(city["cityCode"]),
                        runner._receipt_path(f"city:{city['cityCode']}").parent)):
        if path.exists():
            remove_owned(path, base)
    if manifest:
        archive = runner.root / manifest
        research = runner.root / "world-parcels/research"
        archive.resolve().relative_to(research.resolve())
        if not archive.name.startswith("qualification-admission-"):
            raise ValueError("admission cleanup requires an owned qualification manifest")
        release = archive.name.removeprefix("qualification-admission-").removesuffix(".json")
        evidence = research / f"qualification-{release}" / str(city["cityCode"])
        if evidence.exists():
            remove_owned(evidence, research)
        remove_owned(archive, research)
    return True


def _sample_paths(value):
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in {"samplefile", "samplefiles", "samplepath", "samplepaths"}:
                found.extend([child] if isinstance(child, str) else [v for v in child if isinstance(v, str)]
                             if isinstance(child, list) else [])
            else:
                found.extend(_sample_paths(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_sample_paths(child))
    return found


def task_finished(runner, directory, task_id):
    """Only live tasks have disk records; completed calls live in shared accounting."""
    runner.state.get("pipeline", {}).get("tasks", {}).pop(task_id, None)
    runner.save_state()
    remove_owned(directory, runner.state_dir)


def clear_qualification_scratch(runner):
    """One serialized qualification task owns these directories within each job."""
    rows = runner.state.get("cities", {}).values()
    if any(row.get("qualification", {}).get("status") in {"running", "ready-isolated"}
           or row.get("qualification", {}).get("workspaceDiscardError") for row in rows):
        return
    for name in ("qualification", "qualification-import-tests", "qualification-workers", "admission-bridge"):
        directory = runner.state_dir / name
        if directory.exists():
            remove_owned(directory, runner.state_dir)
