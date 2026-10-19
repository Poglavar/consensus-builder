#!/usr/bin/env python3
"""Run bounded shard preflights, reconcile them, then optionally apply once."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from datetime import datetime, timezone


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


def partition(codes: list[str], workers: int) -> list[list[str]]:
    if workers < 1 or workers > 4:
        raise ValueError("workers must be between 1 and 4")
    if len(codes) < workers:
        raise ValueError("there must be at least one queued city per worker")
    shards = [[] for _ in range(workers)]
    for index, code in enumerate(codes):
        shards[index % workers].append(code)
    return shards


def reconcile(requested: list[str], plans: list[dict]) -> dict:
    records: dict[str, tuple[str, dict]] = {}
    shard_codes: set[str] = set()
    for plan in plans:
        if not isinstance(plan.get("requestedCodes"), list):
            raise ValueError("plan is missing requestedCodes")
        shard = [str(code) for code in plan["requestedCodes"]]
        if len(shard) != len(set(shard)) or any(code not in requested for code in shard):
            raise ValueError("plan has duplicate or unrequested queue codes")
        if shard_codes.intersection(shard):
            raise ValueError("worker queues overlap")
        shard_codes.update(shard)
        for key, code_key in (("accepted", "cityCode"), ("refused", "code"), ("skipped", "cityCode")):
            rows = plan.get(key)
            if not isinstance(rows, list):
                raise ValueError(f"plan is missing {key} array")
            for row in rows:
                code = str(row.get(code_key, ""))
                if code not in shard:
                    raise ValueError(f"city code is outside this worker's queue: {code}")
                if code in records:
                    raise ValueError(f"city code accounted more than once: {code}")
                records[code] = (key, row)
    missing = sorted(set(requested) - set(records), key=int)
    if missing:
        raise ValueError(f"unaccounted requested city codes: {', '.join(missing)}")
    if len(records) != len(requested):
        raise ValueError("city accounting does not match the frozen queue")
    if shard_codes != set(requested):
        raise ValueError("plan queues do not match the frozen queue")
    return {"accepted": [row for kind, row in records.values() if kind == "accepted"],
            "refused": [row for kind, row in records.values() if kind == "refused"],
            "skipped": [row for kind, row in records.values() if kind == "skipped"]}


def numeric_qualified_codes(state: dict) -> list[str]:
    cities = state.get("cities")
    if not isinstance(cities, dict):
        raise ValueError("state.json has no cities object")
    codes = [str(code) for code, entry in cities.items()
             if isinstance(entry, dict) and entry.get("status") == "technical-qualified" and str(code).isdigit()]
    return sorted(set(codes), key=lambda code: (int(code), code))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="qualification state directory")
    parser.add_argument("--outcomes", type=Path, required=True, help="exported outcomes JSON")
    parser.add_argument("--release", required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    repo = args.repo_root.resolve()
    state_dir = args.state.resolve()
    outcome_path = args.outcomes.resolve()
    work = args.work_dir.resolve()
    state_path = state_dir / "state.json"
    cli = repo / "scripts/admit-qualified-cities.mjs"
    if not state_path.is_file() or not outcome_path.is_file() or not cli.is_file():
        parser.error("repo, state.json, and exported outcomes must exist")
    state_bytes, outcomes_bytes = state_path.read_bytes(), outcome_path.read_bytes()
    codes = numeric_qualified_codes(json.loads(state_bytes))
    shards = partition(codes, args.workers)
    work.mkdir(parents=True, exist_ok=True)
    lock_stream = (work / ".admission.lock").open("a+")
    try:
        fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error("another admission controller holds this work directory")
    manifest_path = work / "manifest.json"
    if manifest_path.exists():
        parser.error("this work directory already has a manifest; refusing to reapply")

    queue_bytes = json.dumps(codes, separators=(",", ":")).encode()
    manifest = {"schemaVersion": 1, "status": "running", "startedAt": datetime.now(timezone.utc).isoformat(),
                "inputStateSha256": digest(state_bytes), "outcomesSha256": digest(outcomes_bytes),
                "queueSha256": digest(queue_bytes), "requestedCodes": codes,
                "workers": [{"worker": i + 1, "codes": shard, "status": "pending"} for i, shard in enumerate(shards)]}
    write_json(manifest_path, manifest)
    mutex = threading.Lock()

    def run_worker(index: int, shard: list[str]) -> tuple[int, dict]:
        prefix = f"worker-{index + 1}"
        plan_path, stdout_path, stderr_path = work / f"{prefix}-plan.json", work / f"{prefix}.stdout.log", work / f"{prefix}.stderr.log"
        cmd = ["node", str(cli), "--state", str(state_dir), "--outcomes", str(outcome_path),
               "--release", args.release, "--codes", ",".join(shard), "--plan-output", str(plan_path)]
        record = {"worker": index + 1, "codes": shard, "command": cmd, "startedAt": datetime.now(timezone.utc).isoformat(), "status": "running"}
        with mutex:
            manifest["workers"][index] = record
            write_json(manifest_path, manifest)
        process = subprocess.Popen(cmd, cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        record["pid"] = process.pid
        with mutex:
            manifest["workers"][index] = record
            write_json(manifest_path, manifest)
        stdout, stderr = process.communicate()
        stdout_path.write_text(stdout, encoding="utf-8")
        stderr_path.write_text(stderr, encoding="utf-8")
        record.update({
                       "finishedAt": datetime.now(timezone.utc).isoformat(), "exitCode": process.returncode,
                       "stdout": stdout_path.name, "stderr": stderr_path.name, "plan": plan_path.name,
                       "status": "complete" if process.returncode == 0 and plan_path.is_file() else "failed"})
        with mutex:
            manifest["workers"][index] = record
            write_json(manifest_path, manifest)
        if record["status"] != "complete":
            raise RuntimeError(f"worker {index + 1} failed with exit code {process.returncode}; see {stderr_path.name}")
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        if plan.get("requestedCodes") != shard:
            raise ValueError(f"worker {index + 1} returned a plan for a different queue")
        return index, plan

    try:
        plans_by_index: dict[int, dict] = {}
        with ThreadPoolExecutor(max_workers=len(shards)) as pool:
            futures = [pool.submit(run_worker, i, shard) for i, shard in enumerate(shards)]
            for future in as_completed(futures):
                index, plan = future.result()
                plans_by_index[index] = plan
        plans = [plans_by_index[i] for i in range(len(shards))]
        totals = reconcile(codes, plans)
        aggregate = {"schemaVersion": 1, "release": args.release, "createdAt": datetime.now(timezone.utc).isoformat(),
                     "requestedCodes": codes, **totals,
                     "counts": {key: len(totals[key]) for key in ("accepted", "refused", "skipped")},
                     "inputStateSha256": manifest["inputStateSha256"], "outcomesSha256": manifest["outcomesSha256"],
                     "queueSha256": manifest["queueSha256"]}
        receipt_path = work / "processing-receipt.json"
        write_json(receipt_path, aggregate)
        manifest["status"] = "preflight-complete"
        manifest["receipt"] = receipt_path.name
        write_json(manifest_path, manifest)
        if args.apply:
            if digest(state_path.read_bytes()) != manifest["inputStateSha256"] or digest(outcome_path.read_bytes()) != manifest["outcomesSha256"]:
                raise ValueError("state or outcomes changed during preflight; --apply not run")
            unified_path = work / "unified-plan.json"
            command = ["node", str(cli), "--state", str(state_dir), "--outcomes", str(outcome_path),
                       "--release", args.release, "--codes", ",".join(codes), "--plan-output", str(unified_path)]
            checked = subprocess.run(command, cwd=repo, text=True, capture_output=True, check=False)
            (work / "unified-preflight.stdout.log").write_text(checked.stdout, encoding="utf-8")
            (work / "unified-preflight.stderr.log").write_text(checked.stderr, encoding="utf-8")
            if checked.returncode:
                raise RuntimeError("unified preflight failed; see unified-preflight.stderr.log")
            unified = json.loads(unified_path.read_text(encoding="utf-8"))
            verified = reconcile(codes, [unified])
            shard_accepted = sorted(str(row.get("cityCode")) for row in totals["accepted"])
            unified_accepted = sorted(str(row.get("cityCode")) for row in verified["accepted"])
            if shard_accepted != unified_accepted:
                raise ValueError("unified accepted set differs from shard preflights; --apply not run")
            if digest(state_path.read_bytes()) != manifest["inputStateSha256"] or digest(outcome_path.read_bytes()) != manifest["outcomesSha256"]:
                raise ValueError("state or outcomes changed before apply; --apply not run")
            apply_cmd = [*command, "--apply"]
            applied = subprocess.run(apply_cmd, cwd=repo, text=True, capture_output=True, check=False)
            (work / "apply.stdout.log").write_text(applied.stdout, encoding="utf-8")
            (work / "apply.stderr.log").write_text(applied.stderr, encoding="utf-8")
            if applied.returncode:
                manifest["status"] = "apply-failed-needs-review"
                write_json(manifest_path, manifest)
                raise RuntimeError("serial apply failed; inspect apply logs and resulting repository state")
            manifest["status"] = "applied-needs-review"
        else:
            manifest["status"] = "preflight-complete"
        write_json(manifest_path, manifest)
        print(json.dumps({"status": manifest["status"], "requested": len(codes),
                          "accepted": len(totals["accepted"]), "refused": len(totals["refused"]),
                          "skipped": len(totals["skipped"]), "receipt": str(receipt_path)}, indent=2))
        return 0
    except Exception as exc:
        manifest["status"] = "failed-needs-review"
        manifest["error"] = str(exc)
        write_json(manifest_path, manifest)
        print(f"admission controller failed: {exc}", file=sys.stderr)
        return 1
    finally:
        lock_stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
