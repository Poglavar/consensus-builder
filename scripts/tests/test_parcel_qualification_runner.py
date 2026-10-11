#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import tempfile
import unittest
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
