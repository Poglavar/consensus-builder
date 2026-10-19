"""Independent durable research, review and qualification lanes with one state owner."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import parcel_discovery_coordination as coordination
import parcel_discovery_outcomes as outcomes


def _write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def _jsonable(value):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def execute_task(runner_class, args):
    """A fresh interpreter and independent checkpoint for every stage invocation."""
    spec_path = Path(args.pipeline_task)
    spec = json.loads(spec_path.read_text())
    task_args = copy.copy(args)
    for key, value in spec["args"].items():
        setattr(task_args, key, value)
    for key in ("repo_root", "state_dir", "queue", "source", "shared_root", "known_sources"):
        if getattr(task_args, key, None) is not None:
            setattr(task_args, key, Path(getattr(task_args, key)))
    task_args.pipeline_task = None
    task_args.pipeline_lane = spec["lane"]
    child = runner_class(task_args)
    control = spec_path.parent
    # Qualification artifacts and persistent workspace slots keep their original identities.
    # Only this task's process/usage checkpoint is private to the subprocess.
    child.state_path, child.events_path = control / "state.json", control / "events.jsonl"
    child.run_dir = control / "runs"
    child.state = copy.deepcopy(spec["state"])
    child.state["activeProcesses"] = []
    child.discovery_claims = spec.get("discoveryClaims", {})
    child._configure_source_novelty(Path(child.state["queuePath"]))
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, child.request_stop)
    cities, lane = spec["cities"], spec["lane"]
    cohort = Path(spec["cohortDir"])
    systemic, error = False, None
    try:
        if lane == "research":
            _, _, systemic = child._record_city_attempts(cities, cohort)
        elif lane == "review":
            items = [{**city, "cityPath": str(child._packet(city, cohort)["cityPath"]),
                      "cohortDir": str(cohort)} for city in cities]
            success, _, systemic = child._complete_review(items, [])
            if not success and not systemic and not child.stop_requested:
                child._skip_unreviewed(items, [], "review did not retain a valid receipt after bounded attempts")
        elif lane == "qualification":
            child._advance_candidate(cities, cohort)
        else:
            raise ValueError(f"Unknown pipeline lane: {lane}")
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        child.stop_children()
        child.save_state()
        _write(control / "result.json", {"lane": lane, "cities": child.state.get("cities", {}),
            "usage": child.state.get("usage", {}), "failedItems": child.state.get("failedItems", {}),
            "validatedStages": sorted(child.validated_stages),
            "adapterStageBlocked": child.state.get("adapterStageBlocked"),
            "systemic": systemic, "error": error, "interrupted": child.stop_requested})
    return 1 if error or systemic else 0


class ContinuousPipeline:
    """Keep bounded stage slots fed; only this coordinator writes the job checkpoint."""

    def __init__(self, runner, cities, cohort, *, popen=subprocess.Popen):
        self.runner, self.cities, self.cohort = runner, cities, Path(cohort)
        self.by_code = {str(city["cityCode"]): city for city in cities}
        self.popen = popen
        self.active = {}
        self.validated = set()
        self.completed = 0
        self.waiting_for_claim = False
        self.pipeline = runner.state.setdefault("pipeline", {"schemaVersion": 1, "tasks": {}})

    def _claimed(self):
        return {code for job in self.active.values() for code in job["spec"]["cityCodes"]}

    def _select(self, lane, count):
        busy = self._claimed()
        selected = []
        ordered = self.cities
        if lane == "qualification":
            # Persistent slots must finish/recover their previous owner before a
            # different city can reuse them, including immediately after restart.
            ordered = sorted(self.cities, key=lambda city: 0 if self.runner._city_entry(city).get(
                "qualification", {}).get("status") in {"running", "ready-isolated"} else 1)
        for city in ordered:
            code = str(city["cityCode"])
            if code in busy:
                continue
            row = self.runner._city_entry(city)
            status = row.get("status", "pending")
            if lane == "research":
                if status not in {"pending", "running"}:
                    continue
                packet = self.runner._packet(city, self.cohort)
                if packet.get("valid"):
                    row["status"] = "research-complete"
                    continue
                if row.get("attempts", 0) >= self.runner.args.max_retries:
                    self.runner._skip_item(f"city:{code}", row, "research", "; ".join(packet.get("errors", [])))
                    continue
                try:
                    self.runner.discovery_claims[code] = coordination.acquire(self.runner.root, code, "web-search")
                except coordination.ClaimBusy:
                    self.waiting_for_claim = True
                    continue
            elif lane == "review":
                if status != "research-complete":
                    continue
                if not self.runner._packet(city, self.cohort).get("valid"):
                    row["status"] = "pending"
                    continue
            else:
                if row.get("discoveryDecision") != "candidate" or status not in outcomes.REVIEWED_STATUSES:
                    continue
                saved = row.get("qualification", {})
                if saved.get("status") in {"failed", "blocked-source", "rejected-source", "integration-blocked"}:
                    continue
                fingerprint = self.runner._qualification_fingerprint(city, saved)
                if saved.get("status") in {"integrated", "adapter-ready"} and (code, fingerprint) in self.validated:
                    continue
                packet = self.runner._packet(city, self.cohort)
                if not self.runner._reviewed_city_receipt(city, packet):
                    row["status"] = "research-complete" if packet.get("valid") else "pending"
                    continue
            selected.append(city)
            if len(selected) >= count:
                break
        return selected

    def _start(self, lane, cities):
        runtime = self.runner._refresh_shared_runtime()
        task_id = f"{lane}-{uuid.uuid4().hex[:16]}"
        directory = self.runner.state_dir / "pipeline-tasks" / task_id
        codes = [str(city["cityCode"]) for city in cities]
        state = {"schemaVersion": 1, "queuePath": str(self.runner._queue_path()),
                 "cities": {code: copy.deepcopy(self.runner.state["cities"][code]) for code in codes},
                 "rootReviewTasks": {}, "usage": {}, "failedItems": {}}
        claims = {code: self.runner.discovery_claims.pop(code) for code in codes
                  if code in self.runner.discovery_claims}
        spec = {"schemaVersion": 1, "lane": lane, "cityCodes": codes, "cities": cities,
                "args": vars(self.runner.args), "state": state, "discoveryClaims": claims,
                "cohortDir": str(self.cohort), "runtimeGeneration": runtime.get("generation"),
                "codeGeneration": runtime.get("codeGeneration")}
        spec = _jsonable(spec)
        spec_path = directory / "input.json"
        _write(spec_path, spec)
        # Record intent first; a restart can recover output even between launch and PID capture.
        metadata = {"lane": lane, "cityCodes": codes, "directory": str(directory),
                    "runtimeGeneration": spec["runtimeGeneration"], "status": "starting"}
        self.pipeline["tasks"][task_id] = metadata
        self.runner.save_state()
        out = (directory / "process.log").open("a")
        try:
            process = self.popen([sys.executable, str(self.runner.root / "scripts/run-valhalla-parcel-research.py"),
                "--pipeline-task", str(spec_path)], cwd=self.runner.root, stdin=subprocess.DEVNULL,
                stdout=out, stderr=subprocess.STDOUT, start_new_session=True,
                env=self.runner._subscription_environment())
        except Exception:
            out.close()
            for code, claim in claims.items():
                coordination.release(self.runner.root, code, claim["token"])
            metadata["status"] = "launch-failed"
            raise
        metadata.update(pid=process.pid, pidStartIdentity=coordination.pid_start_identity(process.pid), status="running")
        self.active[task_id] = {"process": process, "spec": spec, "directory": directory, "out": out}
        self.runner.pipeline_jobs = self.active
        self.runner.log("pipeline task started", lane=lane, taskId=task_id, cityCodes=codes,
                        pid=process.pid, runtimeGeneration=spec["runtimeGeneration"])
        self.runner.save_state()

    def _accept(self, task_id, spec, directory, *, interrupted=False):
        path = directory / "result.json"
        if path.exists():
            result = json.loads(path.read_text())
        else:
            state_path = directory / "state.json"
            saved = json.loads(state_path.read_text()) if state_path.exists() else {}
            result = {"cities": saved.get("cities", {}), "usage": saved.get("usage", {}),
                      "error": "stage stopped without a completed result; saved artifacts retained",
                      "interrupted": True}
        lane = spec["lane"]
        for code in spec["cityCodes"]:
            current = self.runner.state["cities"][code]
            child = result.get("cities", {}).get(code, {})
            if result.get("error") and not result.get("interrupted"):
                failures = current.setdefault("pipelineFailures", {})
                failures[lane] = failures.get(lane, 0) + 1
                if failures[lane] >= self.runner.args.max_retries:
                    if lane == "qualification":
                        child["qualification"] = {**child.get("qualification", {}), "status": "failed",
                            "summary": result["error"]}
                    else:
                        self.runner._skip_item(f"city:{code}", current, lane, result["error"])
                        child["status"] = current["status"]
            if lane == "qualification":
                for key in ("qualification", "qualificationHistory", "admission"):
                    if key in child:
                        current[key] = child[key]
                if current.get("qualification", {}).get("status") in {"running", "ready-isolated"} and result.get("interrupted"):
                    current["qualification"]["status"] = "ready-isolated"
                digest = current.get("qualification", {}).get("receiptSha256")
                if (current.get("qualification", {}).get("status") in {"integrated", "adapter-ready"}
                        and [code, digest] in result.get("validatedStages", [])):
                    self.validated.add((code, self.runner._qualification_fingerprint(self.by_code[code], current["qualification"])))
            else:
                current.update({k: v for k, v in child.items() if k not in
                                {"qualification", "qualificationHistory", "admission", "wupIdentity", "pipelineFailures"}})
                if current.get("status") == "running" or result.get("interrupted") and not child:
                    current["status"] = "pending" if lane == "research" else "research-complete"
            if not result.get("interrupted"):
                self.runner._record_shared_learning(self.by_code[code], lane, current)
        self.runner.state.setdefault("usage", {}).update(result.get("usage", {}))
        self.runner.state.setdefault("failedItems", {}).update(result.get("failedItems", {}))
        if result.get("adapterStageBlocked"):
            self.runner.state["adapterStageBlocked"] = result["adapterStageBlocked"]
        if result.get("systemic"):
            self.runner.state["systemicFailure"] = result.get("error") or "persistent model service failure"
            self.runner.stop_requested = True
        if result.get("error"):
            self.runner.log("pipeline stage retained an error", taskId=task_id, lane=lane, error=result["error"])
        self.pipeline["tasks"][task_id].update(status="interrupted" if result.get("interrupted") else "complete",
                                              error=result.get("error"))
        self.completed += 1
        self.runner.log("pipeline task checkpoint", taskId=task_id, lane=lane,
                        cityCodes=spec["cityCodes"], error=bool(result.get("error")))
        self.runner.save_state()

    def recover(self):
        for task_id, saved in list(self.pipeline["tasks"].items()):
            if saved.get("status") not in {"starting", "running"}:
                continue
            directory = Path(saved["directory"])
            spec = json.loads((directory / "input.json").read_text())
            pid = saved.get("pid")
            if pid and coordination.pid_start_identity(pid) == saved.get("pidStartIdentity"):
                raise RuntimeError("previous pipeline stage is still alive; refusing duplicate execution")
            self._accept(task_id, spec, directory, interrupted=True)

    def run(self):
        self.recover()
        once = bool(getattr(self.runner.args, "once", False))
        try:
            while not self.runner.stop_requested:
                self.waiting_for_claim = False
                for task_id, job in list(self.active.items()):
                    if job["process"].poll() is None:
                        continue
                    job["out"].close()
                    self._accept(task_id, job["spec"], job["directory"])
                    del self.active[task_id]
                if once and self.completed:
                    break
                started = False
                # Review and qualification are independent consumers. A completed researcher
                # leaves its city slot free immediately, even while those consumers are busy.
                for lane, capacity, batch in [("review", 1, 3), ("qualification", 1, self.runner.args.qualification_workers),
                                               ("research", self.runner.args.workers, 1)]:
                    if lane == "qualification" and (not self.runner.args.with_adapters or self.runner.state.get("adapterStageBlocked")):
                        continue
                    used = sum(job["spec"]["lane"] == lane for job in self.active.values())
                    for _ in range(capacity - used):
                        selected = self._select(lane, batch)
                        if selected:
                            self._start(lane, selected)
                            started = True
                if not self.active and not started:
                    if self.waiting_for_claim or any(self.runner._city_entry(city).get("status") ==
                                                     "research-complete" for city in self.cities):
                        self.runner.save_state()
                        time.sleep(min(1.0, self.runner.args.poll_seconds))
                        continue
                    break
                self.runner.save_state()
                time.sleep(min(1.0, self.runner.args.poll_seconds))
        finally:
            for job in self.active.values():
                if job["process"].poll() is None:
                    try:
                        os.killpg(job["process"].pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + self.runner.args.grace_seconds
            while any(job["process"].poll() is None for job in self.active.values()) and time.monotonic() < deadline:
                time.sleep(0.1)
            for task_id, job in list(self.active.items()):
                if job["process"].poll() is None:
                    os.killpg(job["process"].pid, signal.SIGKILL)
                    job["process"].wait()
                job["out"].close()
                self._accept(task_id, job["spec"], job["directory"], interrupted=True)
            self.active.clear()
            self.runner.pipeline_jobs = {}
            self.runner.save_state()
        return not self.runner.state.get("systemicFailure")
