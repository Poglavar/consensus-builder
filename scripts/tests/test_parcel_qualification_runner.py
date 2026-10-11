#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "run-parcel-qualification.py"
spec = importlib.util.spec_from_file_location("parcel_runner", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def queue_records(count=64):
    return [
        {
            "cityCode": str(10000 + i), "rank": i + 1, "cityName": f"City {i}",
            "countryCode": "XX", "point": [1.0, 2.0],
            "packetRepoRelativePath": f"tmp/parcel-qualification/inputs/{i}.json",
            "serviceReviewRepoRelativePath": f"tmp/parcel-qualification/reviews/{i}.json",
            "sampleFiles": [], "sourceAnnotations": {},
        }
        for i in range(count)
    ]


def write_valid_artifacts(root: Path, code="10000"):
    (root / "evidence").mkdir(parents=True)
    candidate = {"city": {"code": code}, "descriptor": {"id": "fixture"}}
    candidate_bytes = json.dumps(candidate, separators=(",", ":")).encode()
    (root / "candidate.json").write_bytes(candidate_bytes)
    metric_input = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": None, "properties": {}}]}
    input_bytes = json.dumps(metric_input, separators=(",", ":")).encode()
    (root / "evidence" / "full-safe.geojson").write_bytes(input_bytes)
    input_hash = hashlib.sha256(input_bytes).hexdigest()
    metric = {
        "inputSha256": input_hash, "geometryPass": True, "featureCount": 1,
        "validFeatureCount": 1, "sourceCrs": "EPSG:4326", "metricCrs": "EPSG:32631",
        "geometryChangedOrRepaired": False,
        "invalidCount": 0, "duplicateIdCount": 0, "conflictingSameIdGeometryCount": 0,
        "exactGeometryDuplicateCount": 0, "overlapPairCount": 0, "operationErrorCount": 0,
    }
    metric_bytes = json.dumps(metric, separators=(",", ":")).encode()
    (root / "evidence" / "metric-report.json").write_bytes(metric_bytes)
    checks = {name: {"passed": True, "evidence": "fixture evidence"} for name in runner.REQUIRED_CHECKS}
    qualification = {
        "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(),
        "checks": checks, "cacheFile": "full-safe.geojson", "cacheSha256": input_hash,
        "geometryReport": "metric-report.json", "status":"technical-qualified", "cityCode":code,"featureCount":1,
    }
    (root / "evidence" / "qualification.json").write_text(json.dumps(qualification), encoding="utf-8")


class QualificationRunnerTests(unittest.TestCase):
    def test_direct_worker_does_not_invoke_llm(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            request = root / "worker-request.json"
            request.write_text(json.dumps({"phase": "direct"}))
            with patch.object(runner, "_direct_worker_main", return_value=0) as direct, \
                    patch.object(runner, "_llm_worker_main", side_effect=AssertionError("LLM must not run")):
                self.assertEqual(runner._worker_main(request, root / "answer.json"), 0)
            direct.assert_called_once()

    def test_direct_subprocess_failure_routes_to_exception_work_without_losing_city(self):
        with tempfile.TemporaryDirectory() as temp:
            attempt = Path(temp) / "attempt-01"
            attempt.mkdir()
            request, answer = attempt / "worker-request.json", attempt / "worker-answer.json"
            request.write_text(json.dumps({"phase": "direct", "cityCode": "10000"}))
            with patch.object(runner, "_direct_worker_main", side_effect=TimeoutError):
                self.assertEqual(runner._worker_main(request, answer), 0)
            output = json.loads(answer.read_text())
            self.assertEqual(output["data"]["status"], "needs-llm")
            self.assertEqual(output["data"]["cityCode"], "10000")
            self.assertTrue((attempt / "direct-error.json").is_file())

    def test_successful_subprocess_exit_without_verified_artifacts_never_qualifies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt = root / "attempt-01"
            attempt.mkdir()
            request, answer = attempt / "worker-request.json", attempt / "worker-answer.json"
            request.write_text(json.dumps({"phase": "direct", "cityCode": "10000", "repoRoot": str(root)}))
            with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                self.assertEqual(runner._direct_worker_main(request, answer), 0)
            self.assertEqual(json.loads(answer.read_text())["data"]["status"], "needs-llm")

    def test_failed_direct_check_queues_llm_and_retains_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.json"
            queue.write_text(json.dumps(queue_records(1)))
            args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root),
                                   state_dir="state", workers=3, llm_workers=1, max_retries=2)
            job = runner.Runner(args)
            job.initialize()
            city = job.records[0]
            attempt = job.city_dir(city["cityCode"]) / "attempt-01"
            attempt.mkdir(parents=True)
            (attempt / "direct.log").write_text("Exact-ID gate did not pass")
            answer = attempt / "worker-answer.json"
            answer.write_text(json.dumps({"executionMode": "direct", "data": {
                "cityCode": city["cityCode"], "status": "needs-llm", "summary": "Exact-ID gate needs investigation",
                "evidenceFiles": ["attempt-01/direct.log"]}}))
            entry = job.state["cities"][city["cityCode"]]
            entry.update(status="running", phase="direct", attempts=1, phaseAttempts=1)
            item = {"city": city, "cityDir": attempt.parent, "attemptDir": attempt, "answerPath": answer,
                    "attempt": 1, "phase": "direct", "process": SimpleNamespace(pid=7)}
            job._finish_item(item)
            self.assertEqual(entry["status"], "pending")
            self.assertEqual(entry["phase"], "llm")
            self.assertEqual(entry["phaseAttempts"], 0)
            self.assertEqual(entry["directAttemptDir"], str(attempt))
            self.assertTrue((attempt / "direct.log").exists())
            item["phase"] = "llm"
            with self.assertRaisesRegex(ValueError, "allowed status"):
                job._verify_worker_answer(item)

    def test_continuous_pool_replaces_fast_direct_worker_while_llm_is_busy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.json"
            queue.write_text(json.dumps(queue_records(5)))
            args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root),
                                   state_dir="state", workers=2, llm_workers=1, max_retries=2, once=False,
                                   max_turn_minutes=45)
            ticks = [0]
            job = runner.Runner(args, clock=lambda: ticks[0], sleep=lambda _seconds: ticks.__setitem__(0, ticks[0]+1))
            job.initialize()
            job.state["cities"]["10000"]["phase"] = "llm"
            started, finished = [], []
            def start(city):
                code = city["cityCode"]
                entry = job.state["cities"][code]
                phase = entry.get("phase", "direct")
                end = ticks[0] + (5 if phase == "llm" else 1)
                process = SimpleNamespace(pid=int(code), returncode=0, poll=lambda: 0 if ticks[0] >= end else None)
                attempt = job.city_dir(code) / "attempt-01"
                item = {"city": city, "phase": phase, "process": process, "cityDir": attempt.parent,
                        "attemptDir": attempt, "started": ticks[0], "resourceHeld": False,
                        "timedOut": False, "termAt": None}
                entry.update(status="running", pid=process.pid)
                job.active[process.pid] = item
                started.append((code,ticks[0]))
                return item
            def finish(item, error=None):
                self.assertIsNone(error)
                code = item["city"]["cityCode"]
                job.state["cities"][code]["status"] = "held"
                job.active.pop(item["process"].pid)
                finished.append((code,ticks[0]))
            job._start, job._finish_item = start, finish
            job.run_batch()
            self.assertEqual(len(started), 5)
            self.assertLess(dict(started)["10003"], dict(finished)["10000"])
            self.assertLess(dict(started)["10004"], dict(finished)["10000"])
            self.assertFalse(job.active)

    def test_metric_and_nested_check_schema_are_independently_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            self.assertTrue(runner.verify_technical_artifacts(root, "10000")[0])
            qpath = root / "evidence" / "qualification.json"
            q = json.loads(qpath.read_text())
            q["checks"]["classification"]["passed"] = False
            qpath.write_text(json.dumps(q))
            self.assertFalse(runner.verify_technical_artifacts(root, "10000")[0])

    def test_missing_metric_blocker_count_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            cache = root / "evidence" / "metric-report.json"
            metric = json.loads(cache.read_text())
            metric.pop("operationErrorCount")
            cache.write_text(json.dumps(metric))
            qpath = root / "evidence" / "qualification.json"
            q = json.loads(qpath.read_text())
            metric_bytes = cache.read_bytes()
            q["metricCacheSha256"] = hashlib.sha256(metric_bytes).hexdigest()
            qpath.write_text(json.dumps(q))
            self.assertFalse(runner.verify_technical_artifacts(root, "10000")[0])

    def test_full_safe_cache_changed_after_metric_audit_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            cache = root / "evidence" / "full-safe.geojson"
            cache.write_text('{"type":"FeatureCollection","features":[]}')
            self.assertFalse(runner.verify_technical_artifacts(root, "10000")[0])

    def test_interrupted_running_city_resumes_without_skipping_other_cities(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue_path = root / "queue.json"
            queue_path.write_text(json.dumps(queue_records(2)))
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), queue=str(queue_path),
                                   state_dir="state", workers=1, max_turn_minutes=1, max_retries=2, once=True)
            first = runner.Runner(args)
            first.initialize()
            first.state["cities"]["10000"].update(status="running",attempts=1)
            first.save()
            second = runner.Runner(args)
            second.initialize()
            self.assertEqual(second.state["cities"]["10000"]["status"], "pending")
            self.assertEqual(second.state["cities"]["10001"]["status"], "pending")

    def test_resume_rejects_queue_mutation_and_rechecks_claimed_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue_path = root / "queue.json"
            queue_path.write_text(json.dumps(queue_records()))
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), queue=str(queue_path),
                                   state_dir="state", workers=1, max_turn_minutes=1, max_retries=2,
                                   once=True)
            first = runner.Runner(args)
            first.initialize()
            city_dir = first.city_dir("10000")
            first.state["cities"]["10000"].update(status="technical-qualified", currentDir=str(city_dir),
                                                        summary="claimed", evidenceFiles=[])
            first.save()
            second = runner.Runner(args)
            second.initialize()
            self.assertEqual(second.state["cities"]["10000"]["status"], "pending")
            changed = queue_records()
            changed[0]["cityName"] = "Changed after freeze"
            queue_path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError, "queue SHA-256 changed"):
                runner.Runner(args).initialize()


if __name__ == "__main__":
    unittest.main(verbosity=2)
