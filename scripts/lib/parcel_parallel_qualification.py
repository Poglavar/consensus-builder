"""Two isolated qualification workers, followed by guarded serial imports/admission."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import parcel_source_stage as stage
from parcel_source_admission import admit_candidate
from parcel_city_knowledge import sync_failed_urls
from parcel_city_integration import run_city_task, verify_in_app, verify_baseline, rebuild_browser_adapters as _rebuild_and_validate_browser_adapters
from parcel_qualification_workspaces import prepare_workspace, finish_workspace, discard_workspace, reopen_workspace


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(stage._jsonable(value), ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def _restore(value):
    value = copy.deepcopy(value)
    for key in ("root", "stateDir", "metadataPath"):
        value[key] = Path(value[key]).resolve()
    return value


def _shared_write(runner):
    shared_root = getattr(getattr(runner, "args", None), "shared_root", None)
    if not shared_root:
        return nullcontext({})
    writer = getattr(runner, "_shared_write", None)
    return writer() if callable(writer) else nullcontext({})


def _path_hashes(root, paths):
    return {rel: hashlib.sha256((Path(root) / rel).read_bytes()).hexdigest()
            if (Path(root) / rel).is_file() and not (Path(root) / rel).is_symlink() else None
            for rel in paths}


def _admit(runner, city, receipt, result, digest):
    entry = runner._city_entry(city)
    before = None
    try:
        shared = getattr(runner.args, "shared_root", None)
        if shared:
            sync_failed_urls(shared, runner.root)
        before = runner._candidate_workspace_snapshot()
        # A previously integrated stage has just passed the same hash checks;
        # admission expects the verified input status before it checks app bindings.
        admission = admit_candidate(runner, city, receipt, {**result, "status": "adapter-ready"})
    except Exception as exc:
        admission = {"status": "failed", "summary": f"Admission error: {type(exc).__name__}: {exc}"}
    entry["admission"] = admission
    entry["qualification"] = {**result, "status": admission["status"], "admission": admission,
                              "summary": admission.get("summary") or result.get("summary"),
                              "receiptSha256": digest, "finishedAt": now()}
    if admission["status"] == "integrated":
        _rebuild_and_validate_browser_adapters(runner.root)
        app = verify_in_app(runner.root, city, Path(result["artifactRoot"]), admission)
        entry["qualification"]["appVerification"] = app
        runner.validated_stages.add((str(city["cityCode"]), digest))
    elif admission["status"] == "failed" and (before is None or runner._candidate_workspace_snapshot() != before):
        runner.state["adapterStageBlocked"] = {"cityCode": str(city["cityCode"]),
                                                "reason": admission["summary"], "at": now()}
    runner.save_state()


def _worker(child, workspace, result_path, *, feedback=None, turns_used=0):
    try:
        result = run_city_task(child, workspace, feedback=feedback, turns_used=turns_used)
    except Exception as exc:
        result = {"status": "failed", "summary": f"Isolated workflow error: {type(exc).__name__}: {exc}",
                  "implementationTurns": turns_used + 1}
    finally:
        if child.stop_requested:
            child.stop_children()
    # Both successes and failures retain their own changed code and logs before slot reuse.
    finish_workspace(workspace)
    document = {"result": result, "usage": child.state.get("usage", {}), "finishedAt": now()}
    _write(result_path, document)
    return document


def _import_result(runner, city, receipt, packet, isolation, document):
    """Verify the worker's exact code/evidence before importing any production bytes."""
    workspace = _restore(isolation["workspace"])
    result = copy.deepcopy(document["result"])
    worker_root = workspace["root"]
    _qualification, build = stage._support(runner.root)
    changed = build.snapshot_delta(workspace["baseSnapshot"], build.worktree_snapshot(worker_root))
    result["workerChangedFiles"] = changed
    result["changedFiles"] = []
    result["isolation"] = isolation
    source = Path(result.get("artifactRoot", ""))
    destination = Path(isolation["parentAttempt"])
    if not source.is_absolute() or not source.is_dir():
        return {**result, "status": result.get("status") if result.get("status") == "integration-blocked" else "failed",
                "summary": result.get("summary") or "isolated worker did not retain an artifact directory"}
    source.resolve().relative_to(workspace["stateDir"] / "qualification/cities" / str(city["cityCode"]))
    destination.resolve().relative_to((runner.state_dir / "qualification/cities" / str(city["cityCode"])).resolve())
    if source.name != destination.name:
        raise ValueError("isolated attempt name must survive import unchanged")
    worker_hashes = stage._artifact_hashes(worker_root, source)
    if result.get("status") == "adapter-ready":
        valid, reason = stage.revalidate_stage(SimpleNamespace(root=worker_root, state_dir=workspace["stateDir"]),
                                               workspace["city"], receipt, workspace["packet"], result)
        if not valid:
            return {**result, "status": "failed", "summary": reason}
        if stage._input_hashes(runner.root, city, receipt, packet) != result["inputHashes"]:
            return {**result, "status": "pending", "summary": "source inputs changed; retry against current receipt"}
    # Preserve every byte, including worker-answer paths and hash-bound native samples.
    # An interrupted import may already have copied a prefix of these same files.
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("isolated artifacts cannot contain symlinks")
        if not path.is_file():
            continue
        target = destination / path.relative_to(source)
        if target.exists() and target.read_bytes() != path.read_bytes():
            # Only result.json is runner metadata, excluded from the evidence hashes.
            if target.name != "result.json":
                raise ValueError(f"parent artifact differs from isolated evidence: {target.name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    result["artifactRoot"] = str(destination)
    result["workerArtifactHashes"] = worker_hashes
    if result.get("status") != "adapter-ready":
        return result
    unexpected = [p for p in changed if not build.allowed_change(p) or p.endswith("source-catalog.json")]
    if unexpected:
        return {**result, "status": "failed", "summary": "isolated worker changed files outside adapter/test scope: " + ", ".join(unexpected),
                "unexpectedChangedFiles": unexpected}
    relevant = set(worker_hashes["backendAdapters"])
    parent_backend = _path_hashes(runner.root, relevant)
    base_backend = isolation["baseBackendAdapters"]
    incompatible = [path for path in relevant
                    if parent_backend.get(path) not in (base_backend.get(path), worker_hashes["backendAdapters"].get(path))]
    if incompatible:
        if runner._city_entry(city).get("qualification", {}).get("importStartedAt"):
            raise RuntimeError("adapter code changed outside the interrupted import; inspection required")
        else:
            return {**result, "status": "pending", "summary": "another candidate changed adapter code; retry against updated adapters"}
    parent_snapshot = build.worktree_snapshot(runner.root)
    worker_snapshot = build.worktree_snapshot(worker_root)
    for rel in changed:
        if parent_snapshot.get(rel) not in (workspace["baseSnapshot"].get(rel), worker_snapshot.get(rel)):
            return {**result, "status": "pending", "summary": f"concurrent change to {rel}; isolated work preserved for retry"}
        target, origin = runner.root / rel, worker_root / rel
        target.resolve().relative_to(runner.root.resolve())
        origin.resolve().relative_to(worker_root)
        if target.is_symlink() or origin.is_symlink():
            raise ValueError("adapter import cannot replace or follow symlinks")
    # Durable intent makes a crash during this serial write visible on resume.
    runner._city_entry(city)["qualification"]["importStartedAt"] = now()
    runner.save_state()
    for rel in changed:
        target, origin = runner.root / rel, worker_root / rel
        if origin.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origin, target)
        elif target.is_file():
            target.unlink()
    result["changedFiles"] = changed
    # Keep original worker logs byte-identical; parent tests get a separate directory.
    if changed:
        tests_dir = runner.state_dir / "qualification-import-tests" / isolation["runId"]
        tests_dir.mkdir(parents=True, exist_ok=True)
        ok, summary, log = build.run_focused_tests(runner.root, changed, tests_dir)
        result["importTestLog"] = str(log)
        if not ok:
            raise RuntimeError(summary)
    actual = stage._artifact_hashes(runner.root, destination)
    if actual["backendAdapters"] != worker_hashes["backendAdapters"]:
        raise RuntimeError("imported adapters differ from the independently qualified worker code")
    result["artifactHashes"] = actual
    valid, reason = stage.revalidate_stage(runner, city, receipt, packet, result)
    if not valid:
        raise RuntimeError(reason)
    _write(destination / "result.json", result)
    return result


def _collect_once(runner, city, receipt, packet, digest, isolation, document):
    entry = runner._city_entry(city)
    runner.state.setdefault("usage", {}).update(document.get("usage", {}))
    before = None
    try:
        write_context = (_shared_write(runner) if document.get("result", {}).get("status") == "adapter-ready"
                         else nullcontext({}))
        with write_context:
            before = runner._candidate_workspace_snapshot()
            result = _import_result(runner, city, receipt, packet, isolation, document)
            result.update(receiptSha256=digest, finishedAt=now())
            entry["qualification"] = result
            if (result["status"] == "adapter-ready" and not runner.stop_requested
                    and not runner.state.get("adapterStageBlocked")):
                _admit(runner, city, receipt, result, digest)
                result = entry["qualification"]
                blocked = runner.state.get("adapterStageBlocked")
                if blocked and blocked.get("cityCode") == str(city["cityCode"]):
                    raise RuntimeError(blocked.get("reason") or "admission changed files before failing")
    except Exception as exc:
        result = {"status": "failed", "summary": f"Isolated import error: {type(exc).__name__}: {exc}",
                  "isolation": isolation}
        rolled_back = bool(getattr(runner, "shared_write_rolled_back", False))
        blocked = runner.state.get("adapterStageBlocked")
        if rolled_back:
            entry.pop("admission", None)
            result["workspaceUnchangedAfterFailure"] = True
            if isinstance(blocked, dict) and blocked.get("cityCode") == str(city["cityCode"]):
                runner.state.pop("adapterStageBlocked", None)
        elif entry.get("qualification", {}).get("importStartedAt") or before is None or runner._candidate_workspace_snapshot() != before:
            runner.state["adapterStageBlocked"] = {"cityCode": str(city["cityCode"]),
                                                    "reason": result["summary"], "at": now()}
    result.update(receiptSha256=digest, finishedAt=now())
    if (result["status"] in {"pending", "failed", "interrupted"}
            and entry.get("qualification", {}).get("importStartedAt")
            and not result.get("workspaceUnchangedAfterFailure")):
        result["status"] = "failed"
        runner.state["adapterStageBlocked"] = {"cityCode": str(city["cityCode"]),
                                                "reason": result["summary"], "at": now()}
    if result["status"] in {"pending", "interrupted"}:
        historical = dict(result)
        historical.pop("isolation", None)
        entry.setdefault("qualificationHistory", []).append(historical)
        result = {"status": "pending", "receiptSha256": digest, "summary": result["summary"]}
    entry["qualification"] = result
    runner.save_state()


def _collect(runner, city, receipt, packet, digest, isolation, document):
    from parcel_city_integration import MAX_IMPLEMENTATION_TURNS
    from parcel_source_admission import ADMISSION_FILES
    workspace = _restore(isolation["workspace"])
    while True:
        _collect_once(runner, city, receipt, packet, digest, isolation, document)
        result = runner._city_entry(city)["qualification"]
        turns = document.get("result", {}).get("implementationTurns", 1)
        if runner.stop_requested or result.get("status") not in {"failed", "integration-blocked"}:
            break
        if runner.state.get("adapterStageBlocked"):
            result.update(status="pending", isolation=isolation)
            runner.save_state()
            return
        if turns >= MAX_IMPLEMENTATION_TURNS:
            result["status"] = "integration-blocked"
            break
        # The shared write was rolled back. Give the city worker the failure and
        # current app context, outside the shared lock, instead of discarding it.
        reopen_workspace(workspace)
        for relative in ADMISSION_FILES:
            origin, target = runner.root / relative, workspace["root"] / relative
            if origin.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(origin, target)
                workspace["baseSnapshot"][relative] = hashlib.sha256(target.read_bytes()).hexdigest()
        isolation["workspace"] = stage._jsonable(workspace)
        args = copy.copy(runner.args)
        args.repo_root, args.state_dir = workspace["root"], workspace["stateDir"]
        child = type(runner)(args)
        child.models, child.codex_env = copy.deepcopy(runner.models), dict(runner.codex_env)
        child.qualification_attempt_name = Path(isolation["parentAttempt"]).name
        runner.qualification_runners = [child]
        try:
            document = _worker(child, workspace, Path(isolation["resultPath"]),
                               feedback=result.get("summary"), turns_used=turns)
        finally:
            runner.qualification_runners = []
        # Previous import copies are owned temporary files, and the source copy
        # remains intact in the worker. A repair replaces its own prior attempt.
        target = Path(isolation["parentAttempt"])
        target.resolve().relative_to((runner.state_dir / "qualification/cities" / str(city["cityCode"])).resolve())
        if target.exists():
            shutil.rmtree(target)
    if not runner.stop_requested and result.get("status") not in {"running", "ready-isolated"}:
        try:
            discard_workspace(workspace)
        except Exception as exc:
            result = {**result, "status": "failed",
                      "summary": f"Qualification workspace discard error: {type(exc).__name__}: {exc}",
                      "workspaceDiscardError": f"{type(exc).__name__}: {exc}",
                      "isolation": isolation}
        else:
            result.pop("isolation", None)
    runner._city_entry(city)["qualification"] = result
    runner.save_state()
    runner.log("isolated qualification checkpoint", cityCode=str(city["cityCode"]),
               status=result["status"], summary=result.get("summary"))


def _recover_interrupted(workspace):
    worker_state = workspace["stateDir"] / "state.json"
    if worker_state.is_file():
        for process in json.loads(worker_state.read_text()).get("activeProcesses", []):
            try:
                os.kill(int(process["pid"]), 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                pass
            raise RuntimeError("previous qualification worker PID is still alive; refusing slot reuse")
    finish_workspace(workspace)


def advance_candidates(runner, cities, cohort_dir):
    selected = []
    progressed = False
    # Recover every outstanding slot before selecting fresh work that could reuse it.
    ordered = sorted(cities, key=lambda city: 0 if runner._city_entry(city).get("qualification", {}).get("status")
                     in {"running", "ready-isolated"} else 1)
    for city in ordered:
        if runner.stop_requested or runner.state.get("adapterStageBlocked"):
            break
        entry = runner._city_entry(city)
        if entry.get("discoveryDecision") != "candidate":
            continue
        packet = runner._packet(city, cohort_dir)
        receipt = runner._reviewed_city_receipt(city, packet)
        if receipt is None:
            continue
        digest = stage._sha(runner._receipt_path(f"city:{city['cityCode']}").read_bytes())
        current = entry.get("qualification", {})
        if current.get("receiptSha256") and current["receiptSha256"] != digest:
            entry.setdefault("qualificationHistory", []).append(current)
            current = {}
        isolation = current.get("isolation")
        if current.get("status") in {"running", "ready-isolated"} and isolation:
            result_path = Path(isolation["resultPath"])
            if result_path.is_file():
                _collect(runner, city, receipt, packet, digest, isolation, json.loads(result_path.read_text()))
                progressed = True
                continue
            _recover_interrupted(_restore(isolation["workspace"]))
            entry.setdefault("qualificationHistory", []).append({**current, "status": "interrupted"})
            current = {}
        if current.get("status") in {"integrated", "adapter-ready"}:
            key = (str(city["cityCode"]), digest)
            if key in runner.validated_stages:
                continue
            valid, reason = stage.revalidate_stage(runner, city, receipt, packet, current)
            if valid:
                with _shared_write(runner):
                    still_valid, locked_reason = stage.revalidate_stage(runner, city, receipt, packet, current)
                    if still_valid:
                        _admit(runner, city, receipt, current, digest)
                        blocked = runner.state.get("adapterStageBlocked")
                        if blocked and blocked.get("cityCode") == str(city["cityCode"]):
                            raise RuntimeError(blocked.get("reason") or "admission changed files before failing")
                    else:
                        entry.setdefault("qualificationHistory", []).append(
                            {**current, "invalidationReason": locked_reason})
                        entry["qualification"] = {"status": "pending", "receiptSha256": digest,
                                                  "summary": "shared runtime changed qualification dependencies; retry against current adapters"}
                        runner.save_state()
                progressed = True
                continue
            entry.setdefault("qualificationHistory", []).append({**current, "invalidationReason": reason})
            current = {}
        if current.get("status") not in {None, "pending", "pending-inputs", "running", "interrupted"}:
            continue
        input_error = stage.qualification_input_error(runner.root, city, receipt, packet)
        if input_error:
            entry["qualification"] = {"status": "pending-inputs", "receiptSha256": digest,
                                      "summary": input_error}
            runner.log("city qualification deferred; required evidence unavailable",
                       cityCode=str(city["cityCode"]), reason=input_error)
            runner.save_state()
            progressed = True
            continue
        selected.append((city, receipt, packet, digest))
        if len(selected) == 2:
            break
    if not selected or runner.stop_requested or runner.state.get("adapterStageBlocked"):
        return progressed
    workspace_options = {}
    shared_root = getattr(runner.args, "shared_root", None)
    if shared_root:
        try:
            with _shared_write(runner):
                verify_baseline(runner.root, shared_root)
        except Exception as error:
            runner.state["adapterStageBlocked"] = {"reason": f"Shared integration baseline failed: {error}", "at": now()}
            runner.save_state()
            return False
        workspace_options["base_revision"] = subprocess.check_output(
            ["git", "-C", str(shared_root), "rev-parse", "HEAD"], text=True).strip()
    runner._model("review")
    runner._subscription_environment()
    jobs = []
    prepared = []
    try:
        for slot, (city, receipt, packet, digest) in enumerate(selected, 1):
            workspace = prepare_workspace(runner.root, runner.state_dir, slot, city, receipt, packet, **workspace_options)
            prepared.append((city, digest, workspace))
            _, parent_attempt = stage._next_attempt(stage._stage_city_root(runner.state_dir, str(city["cityCode"])))
            args = copy.copy(runner.args)
            args.repo_root, args.state_dir = workspace["root"], workspace["stateDir"]
            child = type(runner)(args)
            child.models, child.codex_env = copy.deepcopy(runner.models), dict(runner.codex_env)
            child.qualification_attempt_name = parent_attempt.name
            result_path = runner.state_dir / "qualification-workers" / f"{workspace['runId']}.json"
            isolation = {"workspace": stage._jsonable(workspace), "runId": workspace["runId"],
                         "parentAttempt": str(parent_attempt), "resultPath": str(result_path),
                         "baseBackendAdapters": stage._artifact_hashes(workspace["root"], parent_attempt)["backendAdapters"]}
            runner._city_entry(city)["qualification"] = {"status": "running", "startedAt": now(),
                                                         "receiptSha256": digest, "isolation": isolation}
            jobs.append((child, city, receipt, packet, digest, workspace, isolation))
            runner.save_state()
    except Exception as exc:
        # No model workers have started. Release every slot this batch prepared;
        # an infrastructure failure must not become a failed source qualification.
        runner.state["adapterStageBlocked"] = {"cityCode": str(city["cityCode"]),
            "reason": f"Qualification workspace preparation failed: {type(exc).__name__}: {exc}", "at": now()}
        cleanup_errors = []
        for prepared_city, digest, workspace in prepared:
            runner._city_entry(prepared_city)["qualification"] = {"status": "pending", "receiptSha256": digest}
            try:
                finish_workspace(workspace)
                discard_workspace(workspace)
            except Exception as cleanup_error:
                cleanup_errors.append(f"slot {workspace['slot']}: {type(cleanup_error).__name__}: {cleanup_error}")
        if cleanup_errors:
            runner.state["adapterStageBlocked"]["workspaceCleanupErrors"] = cleanup_errors
        runner.save_state()
        raise
    runner.qualification_runners = [job[0] for job in jobs]
    runner.state["qualificationWorkers"] = [{"cityCode": str(job[1]["cityCode"]), "slot": index,
                                               "worktree": str(job[0].root)} for index, job in enumerate(jobs, 1)]
    runner.log("starting parallel isolated qualification", cityCodes=[str(job[1]["cityCode"]) for job in jobs], workers=len(jobs))
    try:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="parcel-qualification") as pool:
            futures = {pool.submit(_worker, child, workspace, isolation["resultPath"]): job
                       for job in jobs for child, city, receipt, packet, digest, workspace, isolation in [job]}
            pending = set(futures)
            while pending:
                if runner.stop_requested:
                    for child in runner.qualification_runners:
                        child.stop_requested = True
                completed, pending = wait(pending, timeout=1)
                for future in completed:
                    child, city, receipt, packet, digest, workspace, isolation = futures[future]
                    try:
                        future.result()
                    except Exception as exc:
                        runner.log("isolated worker finalization failed; evidence retained", cityCode=str(city["cityCode"]), error=str(exc))
                    runner._city_entry(city)["qualification"]["status"] = "ready-isolated"
                runner.save_state()
        # No worker can see another city's imports or app writes while it qualifies.
        for child, city, receipt, packet, digest, workspace, isolation in jobs:
            if runner.stop_requested or runner.state.get("adapterStageBlocked"):
                break
            result_path = Path(isolation["resultPath"])
            if result_path.is_file():
                _collect(runner, city, receipt, packet, digest, isolation, json.loads(result_path.read_text()))
    finally:
        runner.qualification_runners = []
        runner.state["qualificationWorkers"] = []
        runner.save_state()
    return True
