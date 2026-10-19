#!/usr/bin/env python3
"""Offline, scratch-only requalification of saved UK97 and four pilot artifacts."""
from __future__ import annotations

import copy
import csv
import gzip
import hashlib
import importlib.util
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = (Path.home() / "code/consensus-builder-colosseum-worlds-fair").resolve()
BASE = REPO / "tmp/parcel-initial-policy-20261019"
UK_QUEUE_PATH = Path("/var/tmp/cb-hmlr-reconcile-20261019/uk-97-initial-policy-queue.json")
UK_MANIFEST_PATH = Path("/var/tmp/cb-hmlr-reconcile-20261019/uk-qualified-reconciliation.json")
PILOT_BASE = REPO / "tmp/parcel-resume-20261018"
PILOTS = {
    "10301": ("india-pilot-qualification", "india-qualification-queue.json"),
    "9499": ("india-pilot-qualification", "india-qualification-queue.json"),
    "10677": ("india-pilot-qualification", "india-qualification-queue.json"),
    "3589": ("modesto-qualification", "modesto-qualification-queue.json"),
}
SOURCE_RELEASE = "44a56028732ae4895442909dfcb048e34dffd1f0b2714f4d0f50901d7544cd90"
CURRENTNESS_NOTE = (
    "This result reuses saved candidate, qualification, metric and parcel-cache artifacts without "
    "network requests. Verify present-day source availability, snapshot/release currentness and "
    "runtime binding/query contract in the second pass."
)
PILOT_SOURCE_NOTE = (
    "This is an offline re-evaluation of saved source evidence; live freshness, jurisdictional "
    "coverage and production binding were not rechecked. Verify them in the second pass."
)
REQUIRED = ("classification", "exactIds", "stableGeometry")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def safe_descendant(root: Path, path: Path) -> Path:
    result = path.resolve()
    result.relative_to(root.resolve())
    return result


def read_gb_roster():
    source = REPO / "tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz"
    rows = []
    with gzip.open(source, "rt", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Year") != "2025" or row.get("ISO2_Code", "").strip().upper() != "GB":
                continue
            code = str(int(row["City_Code"]))
            rows.append({
                "cityCode": code,
                "cityName": row["City_Name"].strip(),
                "countryCode": "GB",
                "point": [float(row["PWCent_Latitude"]), float(row["PWCent_Longitude"])],
                "population2025k": float(row["Pop"]),
            })
    rows.sort(key=lambda r: (-r["population2025k"], int(r["cityCode"])))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    return {row["cityCode"]: row for row in rows}, source


def pilot_records():
    records = {}
    for code, (run, queue_name) in PILOTS.items():
        queue_path = PILOT_BASE / queue_name
        state_path = PILOT_BASE / run / "state.json"
        queue = load_json(queue_path)
        state = load_json(state_path)
        if sha(queue_path) != state.get("queueSha256"):
            raise ValueError(f"frozen pilot queue hash mismatch for {code}")
        queue_rows = [r for r in queue["records"] if str(r["cityCode"]) == code]
        if len(queue_rows) != 1:
            raise ValueError(f"pilot queue does not contain exactly one record for {code}")
        identity = queue_rows[0]
        entry = state.get("cities", {}).get(code, {})
        attempt = Path(entry.get("currentDir", ""))
        if not attempt.is_dir() or attempt.name != "attempt-02" or attempt.parent.name != code:
            raise ValueError(f"expected saved attempt-02 for pilot {code}")
        records[code] = {
            "cityCode": code,
            "rank": identity["rank"],
            "cityName": identity["cityName"],
            "countryCode": identity["countryCode"],
            "point": identity["point"],
            "sourceRun": run,
            "sourceStatePath": str(state_path),
            "sourceStateSha256": sha(state_path),
            "sourceQueuePath": str(queue_path),
            "sourceQueueSha256": sha(queue_path),
            "sourcePacketPath": str(REPO / identity["packetRepoRelativePath"]),
            "sourceReviewPath": str(REPO / identity["serviceReviewRepoRelativePath"]),
            "sourceSampleFiles": [
                {"path": str(REPO / item["repoRelativePath"]), "sha256": item.get("sha256")}
                for item in identity.get("sampleFiles", [])
            ],
            "sourceAttemptPath": str(attempt),
            "currentnessFollowUp": PILOT_SOURCE_NOTE,
        }
    return records


def uk_records():
    manifest = load_json(UK_MANIFEST_PATH)
    queue = load_json(UK_QUEUE_PATH)
    if len(manifest["records"]) != 117 or len(manifest["readyUnboundCodes"]) != 97 or len(queue["records"]) != 97:
        raise ValueError("mechanical UK reconciliation count mismatch")
    if sha(UK_QUEUE_PATH) == "":
        raise ValueError("could not hash UK queue")
    wup, wup_path = read_gb_roster()
    if sha(wup_path) != queue.get("wupRosterSha256"):
        raise ValueError("UK scratch queue WUP roster hash differs from the frozen roster")
    records = {}
    for row in queue["records"]:
        code = str(row["cityCode"])
        frozen = wup.get(code)
        if not frozen:
            raise ValueError(f"UK code absent from frozen WUP roster: {code}")
        if any(row.get(k) != frozen.get(k) for k in ("rank", "cityName", "countryCode", "point", "population2025k")):
            raise ValueError(f"UK scratch queue identity differs from frozen WUP roster for {code}")
        a = row["sourceArtifacts"]
        candidate = Path(a["candidatePath"])
        qualification = Path(a["qualificationPath"])
        records[code] = {
            **{k: row[k] for k in ("cityCode", "rank", "cityName", "countryCode", "point", "population2025k")},
            "sourceRun": "HMLR retry status; exact run is read from reconciliation manifest",
            "sourceStatusFile": next(r["latestStatusFile"] for r in manifest["records"] if r["cityCode"] == code),
            "sourceAttemptPath": str(candidate.parent),
            "sourceArtifacts": a,
            "sourceReleaseId": row["releaseId"],
            "sourceSignature": queue.get("sourceSignature"),
            "currentnessFollowUp": CURRENTNESS_NOTE + f" Saved source release: {row['releaseId']}; current binding/catalog state is not established by this offline re-evaluation.",
        }
        q = load_json(qualification)
        if sha(candidate) != a["candidateSha256"] or sha(qualification) != a["qualificationSha256"]:
            raise ValueError(f"UK source candidate or qualification hash changed for {code}")
        cache = qualification.parent / q["cacheFile"]
        metric = qualification.parent / q["geometryReport"]
        if sha(cache) != a["cacheSha256"] or sha(metric) != a["metricReportSha256"]:
            raise ValueError(f"UK source cache or metric hash changed for {code}")
    return records


def copy_attempt(record: dict, destination: Path):
    code = record["cityCode"]
    src = Path(record["sourceAttemptPath"]).resolve()
    candidate_src = src / "candidate.json"
    if not candidate_src.is_file():
        raise FileNotFoundError(candidate_src)
    qsrc = src / "evidence" / "qualification.json"
    if not qsrc.is_file():
        raise FileNotFoundError(qsrc)
    candidate = load_json(candidate_src)
    q = load_json(qsrc)
    # Verify exact record-to-candidate identity before copying any claim.
    exp_point = [float(record["point"][1]), float(record["point"][0])]
    if candidate.get("city", {}).get("code") != code:
        raise ValueError(f"candidate code mismatch for {code}")
    if candidate.get("city", {}).get("name") != record["cityName"]:
        raise ValueError(f"candidate name differs from frozen WUP identity for {code}")
    if candidate.get("city", {}).get("point") != exp_point:
        raise ValueError(f"candidate point differs from frozen WUP identity for {code}")
    if candidate.get("sourceClassification", {}).get("isParcel") is not True:
        raise ValueError(f"positive parcel classification evidence missing for {code}")
    if q.get("sourceId") != candidate.get("descriptor", {}).get("id") or str(q.get("cityCode")) != code:
        raise ValueError(f"qualification source/code mismatch for {code}")
    checks = q.get("checks") or {}
    core = {k: copy.deepcopy(checks.get(k)) for k in REQUIRED}
    if any(not isinstance(core[k], dict) or core[k].get("passed") is not True for k in REQUIRED):
        raise ValueError(f"initial required checks do not all pass for {code}: {core}")
    cache_src = safe_descendant(qsrc.parent, qsrc.parent / q["cacheFile"])
    metric_src = safe_descendant(qsrc.parent, qsrc.parent / q.get("geometryReport", "metric-report.json"))
    cache = load_json(cache_src)
    # Use the policy implementation that the new runner actually uses.
    policy_path = REPO / "scripts/lib/parcel_qualification_policy.py"
    spec = importlib.util.spec_from_file_location("parcel_initial_policy_for_operator", policy_path)
    policy = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = policy
    spec.loader.exec_module(policy)
    if not policy.usable_parcel_cache(cache, candidate["descriptor"]["id"]):
        raise ValueError(f"saved cache is not usable parcel geometry for {code}")
    if q.get("cacheSha256") != sha(cache_src):
        raise ValueError(f"qualification cache hash does not match for {code}")
    metric = load_json(metric_src)
    if metric.get("inputSha256") != sha(cache_src):
        raise ValueError(f"saved metric report is not bound to cached geometry for {code}")
    if metric.get("sourceCrs") != "EPSG:4326" or metric.get("geometryChangedOrRepaired") is not False:
        raise ValueError(f"metric source-geometry provenance fails for {code}")
    if not isinstance(metric.get("featureCount"), int) or metric["featureCount"] != len(cache["features"]) or q.get("featureCount") != len(cache["features"]):
        raise ValueError(f"cache/metric/qualification feature count mismatch for {code}")

    # Only copy candidate + all saved evidence. Do not copy unrelated run logs or mutate source artifacts.
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copy2(candidate_src, destination / "candidate.json")
    ev_dest = destination / "evidence"
    shutil.copytree(qsrc.parent, ev_dest, symlinks=False)
    # Retain any candidate-referenced file that lives next to the original attempt, within its root.
    ref = candidate.get("alignmentEvidence")
    if isinstance(ref, dict) and isinstance(ref.get("file"), str):
        referenced = safe_descendant(src, src / ref["file"])
        if not referenced.is_file():
            raise FileNotFoundError(referenced)
        relative = referenced.relative_to(src)
        target = destination / relative
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(referenced, target)
    qcopy_path = ev_dest / "qualification.json"
    qcopy = load_json(qcopy_path)
    original_flags = copy.deepcopy(qcopy.get("checks", {}))
    original_requests = qcopy.get("requests", [])
    request_timestamps = [
        {k: item[k] for k in ("startedAt", "endedAt", "status") if k in item}
        for item in original_requests if isinstance(item, dict)
    ]
    original_status = qcopy.get("status")
    original_hashes = {
        "candidateSha256": sha(candidate_src),
        "qualificationSha256BeforePolicyUpdate": sha(qsrc),
        "cacheSha256": sha(cache_src),
        "metricReportSha256": sha(metric_src),
    }
    # Preserve old check flags and request/source timestamps verbatim. The only legacy evidence
    # status field changed is this copy's top-level status, plus explicit policy metadata.
    qcopy["status"] = "technical-qualified"
    qcopy["initialPolicyReevaluation"] = {
        "policy": policy.POLICY["id"],
        "reevaluatedAt": utc_now(),
        "originalStatus": original_status,
        "newStatus": "technical-qualified",
        "requiredChecks": {k: core[k] for k in REQUIRED},
        "originalChecksPreserved": True,
        "originalCheckFlags": original_flags,
        "requestTimestampsPreserved": request_timestamps,
        "sourceArtifactHashes": original_hashes,
        "currentnessFollowUp": record["currentnessFollowUp"],
        "offlineOnly": True,
        "networkRequestsMade": 0,
    }
    atomic_json(qcopy_path, qcopy)
    # The evidence copy itself must still match original data except the qualification metadata update.
    if sha(destination / "candidate.json") != original_hashes["candidateSha256"]:
        raise ValueError(f"copied candidate hash mismatch for {code}")
    if sha(ev_dest / Path(qcopy["cacheFile"])) != original_hashes["cacheSha256"]:
        raise ValueError(f"copied cache hash mismatch for {code}")
    if (load_json(qcopy_path).get("checks") != original_flags
            or load_json(qcopy_path).get("requests", []) != original_requests):
        raise ValueError(f"copied check flags or timestamps were not preserved for {code}")
    return {
        "candidate": destination / "candidate.json",
        "qualification": qcopy_path,
        "cache": ev_dest / qcopy["cacheFile"],
        "metric": ev_dest / qcopy.get("geometryReport", "metric-report.json"),
        "originalStatus": original_status,
        "originalHashes": original_hashes,
        "sourceChecks": original_flags,
        "sourceRequestTimestamps": request_timestamps,
    }


def main():
    if BASE.exists():
        raise FileExistsError(f"scratch target already exists; refusing overwrite: {BASE}")
    uk = uk_records()
    pilots = pilot_records()
    records = {**uk, **pilots}
    if len(records) != 101 or len(set(records)) != 101:
        raise ValueError(f"expected exactly 101 unique sources; got {len(records)}")
    BASE.mkdir(parents=True)
    inputs_root = BASE / "inputs"
    attempt_root = BASE / "runner-state" / "cities"
    inputs_root.mkdir()
    # Use source identity provided by copied saved candidate; create honest derived packet and review references.
    frozen_records = []
    source_rows = []
    for code, record in sorted(records.items(), key=lambda kv: (kv[1]["rank"], int(kv[0]))):
        # Pilot source paths come from saved queue; UK source paths are fully hash-bound in reconciliation queue.
        src = Path(record["sourceAttemptPath"])
        candidate_src = src / "candidate.json"
        qsrc = src / "evidence" / "qualification.json"
        q = load_json(qsrc)
        cand = load_json(candidate_src)
        source_artifacts = {
            "candidate": {"path": str(candidate_src), "sha256": sha(candidate_src)},
            "qualification": {"path": str(qsrc), "sha256": sha(qsrc)},
            "cache": {"path": str(qsrc.parent / q["cacheFile"]), "sha256": sha(qsrc.parent / q["cacheFile"])},
            "metric": {"path": str(qsrc.parent / q.get("geometryReport", "metric-report.json")), "sha256": sha(qsrc.parent / q.get("geometryReport", "metric-report.json"))},
        }
        if record.get("sourceArtifacts"):
            required = record["sourceArtifacts"]
            if source_artifacts["candidate"]["sha256"] != required["candidateSha256"] or source_artifacts["qualification"]["sha256"] != required["qualificationSha256"] or source_artifacts["cache"]["sha256"] != required["cacheSha256"] or source_artifacts["metric"]["sha256"] != required["metricReportSha256"]:
                raise ValueError(f"UK manifest hash mismatch for {code}")
        packet = {
            "schemaVersion": 1,
            "kind": "derived-offline-requalification-packet",
            "city": {k: record[k] for k in ("cityCode", "cityName", "countryCode", "point", "rank")},
            "sourceId": cand["descriptor"]["id"],
            "sourceDescriptor": cand["descriptor"],
            "candidateClassification": cand.get("sourceClassification"),
            "sourceArtifacts": source_artifacts,
            "provenance": {
                "reusedSavedAttempt": str(src),
                "sourceRun": record.get("sourceRun"),
                "sourceStatusFile": record.get("sourceStatusFile"),
                "sourceStatePath": record.get("sourceStatePath"),
                "sourceQueuePath": record.get("sourceQueuePath"),
                "sourceReleaseId": record.get("sourceReleaseId"),
            },
            "note": "Derived from saved evidence paths. This packet contains no new source observations.",
        }
        review = {
            "reviewType": "offline initial-policy re-evaluation",
            "policy": "parcel-availability-v1",
            "cityCode": code,
            "sourceId": cand["descriptor"]["id"],
            "decisionBoundary": "Primary qualification only; not an admission or deployment decision.",
            "sourceArtifacts": source_artifacts,
            "currentnessAndSecondPass": record["currentnessFollowUp"],
            "preservedOriginalChecks": q.get("checks", {}),
            "sourceTimestamps": [
                {k: item[k] for k in ("startedAt", "endedAt", "status") if k in item}
                for item in q.get("requests", []) if isinstance(item, dict)
            ],
            "offlineOnly": True,
            "networkRequestsMade": 0,
        }
        input_dir = inputs_root / code
        input_dir.mkdir()
        packet_path = input_dir / "packet.json"
        review_path = input_dir / "review.json"
        atomic_json(packet_path, packet)
        atomic_json(review_path, review)
        dest = attempt_root / code / "attempt-01"
        copied = copy_attempt(record, dest)
        cache_rel = copied["cache"].relative_to(REPO).as_posix()
        packet_rel = packet_path.relative_to(REPO).as_posix()
        review_rel = review_path.relative_to(REPO).as_posix()
        frozen_records.append({
            "cityCode": code,
            "rank": int(record["rank"]),
            "cityName": record["cityName"],
            "countryCode": record["countryCode"],
            "point": record["point"],
            "packetRepoRelativePath": packet_rel,
            "serviceReviewRepoRelativePath": review_rel,
            "sampleFiles": [{"repoRelativePath": cache_rel, "sha256": sha(copied["cache"])}],
            "sourceAnnotations": {
                "policy": "parcel-availability-v1",
                "sourceId": cand["descriptor"]["id"],
                "offlineSavedEvidence": True,
                "sourceArtifacts": source_artifacts,
                "sourceRun": record.get("sourceRun"),
                "sourceStatusFile": record.get("sourceStatusFile"),
                "currentnessFollowUp": record["currentnessFollowUp"],
            },
            "sourceArtifacts": source_artifacts,
        })
        source_rows.append({
            "cityCode": code,
            "rank": record["rank"],
            "cityName": record["cityName"],
            "sourceId": cand["descriptor"]["id"],
            "sourceReleaseId": record.get("sourceReleaseId"),
            "originalAttemptPath": str(src),
            "copiedAttemptPath": str(dest),
            "originalStatus": copied["originalStatus"],
            "initialCoreChecks": {k: bool(copied["sourceChecks"].get(k, {}).get("passed") is True) for k in REQUIRED},
            "oldCheckFlags": copied["sourceChecks"],
            "originalArtifactHashes": copied["originalHashes"],
            "currentnessFollowUp": record["currentnessFollowUp"],
        })
    queue_path = BASE / "frozen-101-queue.json"
    atomic_json(queue_path, {
        "schemaVersion": 1,
        "purpose": "immutable scratch queue for offline initial-policy re-evaluation; no new source reads",
        "policy": "parcel-availability-v1",
        "networkRequestsMade": 0,
        "recordCount": len(frozen_records),
        "records": frozen_records,
    })
    # Load the same queue with the production runner, initialize a new independent state, then
    # pass cached artifacts through the actual external-answer verifier for its independent metric.
    runner_path = REPO / "scripts/run-parcel-qualification.py"
    spec = importlib.util.spec_from_file_location("parcel_initial_policy_runner", runner_path)
    runner_module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runner_module
    spec.loader.exec_module(runner_module)
    state_dir = BASE / "runner-state"
    init_args = runner_module.parse_args([
        "--run", "--queue", str(queue_path), "--repo-root", str(REPO),
        "--source-root", str(REPO), "--state-dir", str(state_dir),
        "--workers", "1", "--llm-workers", "1",
    ])
    initializer = runner_module.Runner(init_args)
    initializer.initialize()
    outputs = []
    for row in frozen_records:
        code = str(row["cityCode"])
        attempt_dir = state_dir / "cities" / code / "attempt-01"
        city_dir = attempt_dir.parent
        evidence_dir = attempt_dir / "evidence"
        evidence_files = [
            (attempt_dir / "candidate.json").relative_to(city_dir).as_posix(),
            *[p.relative_to(city_dir).as_posix() for p in sorted(evidence_dir.rglob("*")) if p.is_file()],
        ]
        answer_path = attempt_dir / "worker-answer.json"
        atomic_json(answer_path, {
            "data": {
                "cityCode": code,
                "status": "technical-qualified",
                "summary": "Saved parcel artifacts pass parcel-availability-v1; source currentness and detailed quality remain explicit second-pass follow-ups.",
                "evidenceFiles": evidence_files,
            },
            "model": "offline-cached-artifact-recheck",
            "usage": {"networkRequests": 0},
        })
        answer_args = runner_module.parse_args([
            "--record-answer", str(attempt_dir), "--queue", str(queue_path),
            "--repo-root", str(REPO), "--source-root", str(REPO),
            "--state-dir", str(state_dir), "--workers", "1", "--llm-workers", "1",
        ])
        result = runner_module.record_answer(answer_args)
        # The runner-authored report independently recomputes metric and records original failed/unrun checks.
        review_path = evidence_dir / "initial-review.json"
        review = load_json(review_path)
        follow_up = review.setdefault("followUp", [])
        note = row["sourceAnnotations"]["currentnessFollowUp"]
        follow_up.append({"check": "sourceCurrentness", "reason": note})
        review["status"] = "follow-up-required"
        review["policyReevaluationProvenance"] = {
            "offlineOnly": True,
            "networkRequestsMade": 0,
            "sourceArtifacts": row["sourceArtifacts"],
            "originalStatus": next(s["originalStatus"] for s in source_rows if s["cityCode"] == code),
        }
        atomic_json(review_path, review)
        # Keep the fresh runner state and exported report synchronized.
        state = load_json(state_dir / "state.json")
        entry = state["cities"][code]
        if result["status"] != "technical-qualified":
            outputs.append({"cityCode": code, "status": result["status"], "summary": entry.get("summary")})
            continue
        entry["initialQualification"] = review
        entry["followUpRequired"] = True
        entry["summary"] = "Passed initial parcel availability policy offline; source currentness and detailed quality require second-pass review."
        state["cities"][code] = entry
        atomic_json(state_dir / "state.json", state)
        outputs.append({
            "cityCode": code,
            "status": result["status"],
            "sourceId": row["sourceAnnotations"]["sourceId"],
            "originalStatus": next(s["originalStatus"] for s in source_rows if s["cityCode"] == code),
            "followUpChecks": review.get("followUp", []),
            "initialReviewPath": str(review_path),
            "qualificationPath": str(attempt_dir / "evidence/qualification.json"),
            "cachePath": str(attempt_dir / "evidence/full-safe.geojson"),
            "independentMetricReportPath": str(attempt_dir / "evidence/independent-metric-report.json"),
        })
    final = runner_module.Runner(init_args)
    final.records, final.queue_hash = runner_module.load_queue(queue_path)
    final.state = load_json(state_dir / "state.json")
    final.state["status"] = "complete-needs-review" if all(o["status"] == "technical-qualified" for o in outputs) else "complete-with-holds"
    final.state["endedAt"] = utc_now()
    final.save()
    result_doc = {
        "schemaVersion": 1,
        "policy": "parcel-availability-v1",
        "networkRequestsMade": 0,
        "queuePath": str(queue_path),
        "queueSha256": sha(queue_path),
        "statePath": str(state_dir / "state.json"),
        "stateSha256": sha(state_dir / "state.json"),
        "recordCount": len(frozen_records),
        "qualifiedCount": sum(o["status"] == "technical-qualified" for o in outputs),
        "heldCount": sum(o["status"] != "technical-qualified" for o in outputs),
        "results": outputs,
        "provenance": source_rows,
    }
    atomic_json(BASE / "offline-requalification-results.json", result_doc)
    print(json.dumps({
        "base": str(BASE),
        "queuePath": str(queue_path),
        "queueSha256": sha(queue_path),
        "statePath": str(state_dir / "state.json"),
        "resultPath": str(BASE / "offline-requalification-results.json"),
        "resultSha256": sha(BASE / "offline-requalification-results.json"),
        "recordCount": len(frozen_records),
        "qualifiedCount": result_doc["qualifiedCount"],
        "heldCount": result_doc["heldCount"],
        "statuses": {status: sum(o["status"] == status for o in outputs) for status in sorted({o["status"] for o in outputs})},
        "codeList": [r["cityCode"] for r in frozen_records],
    }, indent=2))


if __name__ == "__main__":
    main()
