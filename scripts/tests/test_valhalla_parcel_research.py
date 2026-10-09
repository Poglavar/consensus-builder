"""Check immutable packet values, durable review receipts, and bounded review retries."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parents[1] / "run-valhalla-parcel-research.py"
SPEC = importlib.util.spec_from_file_location("valhalla_runner", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ValidatePacketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cohort = self.root / "cohort"
        self.cohort.mkdir()
        self.city = {
            "cityCode": 42, "queueRank": 7, "country": "Example", "countryCode": "EX",
            "point": [1.25, 2.5], "population2025": 123450,
            "population2025k": 123.45, "populationUnit": "persons", "status": "complete",
            "registryFound": None,
            "freshResearch": {"queries": [
                {"language": "English", "query": "Example cadastre", "result": "checked",
                 "actualResultUrls": ["https://example.test/en"]},
                {"language": "native", "query": "local cadastre", "result": "checked",
                 "actualResultUrls": ["https://example.test/local"]},
            ]},
        }
        self.review = {"cityRecord": "city-42-example.json", "scopeLimits": {"maxFullPolygonsRetainedInRepository": 3}}
        self.queue_city = {"cityCode": 42, "rank": 7, "country": "Example", "iso2": "EX",
                           "point": [1.25, 2.5], "pop2025k": 123.45}
        self.write_packets()

    def tearDown(self):
        self.temp.cleanup()

    def write_packets(self):
        (self.cohort / "city-42-example.json").write_text(json.dumps(self.city))
        (self.cohort / "example-service-review.json").write_text(json.dumps(self.review))

    def test_valid_canonical_packet_uses_person_count(self):
        result = runner.validate_packet(self.root, self.queue_city, self.cohort)
        self.assertTrue(result["valid"], result["errors"])

    def test_population_binary_rounding_is_tolerated(self):
        self.city["population2025"] = 123450.0000005
        self.write_packets()
        self.assertTrue(runner.validate_packet(self.root, self.queue_city, self.cohort)["valid"])

    def test_rejects_population_thousands_in_place_of_persons(self):
        self.city["population2025"] = None
        self.city["populationUnit"] = "persons"
        self.write_packets()
        result = runner.validate_packet(self.root, self.queue_city, self.cohort)
        self.assertFalse(result["valid"])
        self.assertTrue(any("population persons mismatch" in error for error in result["errors"]))

    def test_rejects_registry_false(self):
        self.city["registryFound"] = False
        self.write_packets()
        result = runner.validate_packet(self.root, self.queue_city, self.cohort)
        self.assertFalse(result["valid"])
        self.assertTrue(any("registryFound=false" in error for error in result["errors"]))


class ResumeAndReceiptTests(unittest.TestCase):
    def test_resume_prefers_persisted_queue(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            state_dir = root / "state"
            state_dir.mkdir()
            persisted_queue = root / "later" / "pending.json"
            persisted_queue.parent.mkdir()
            persisted_queue.write_text("{}")
            (state_dir / "state.json").write_text(json.dumps({"queuePath": str(persisted_queue)}))
            args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=Path("initial.json"),
                                   job_name="test", codex="codex")
            instance = runner.Runner(args)
            self.assertEqual(instance._queue_path(), persisted_queue.resolve())

    def test_review_requires_receipt_and_existing_evidence(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            cohort = root / "world-parcels" / "research" / "cohort"
            evidence = cohort / "packet.json"
            evidence.parent.mkdir(parents=True)
            evidence.write_text("{}")
            args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=Path("unused.json"),
                                   job_name="test", codex="codex")
            instance = runner.Runner(args)
            instance.state = {"queuePath": str(cohort / "pending-queue.json")}
            self.assertIsNone(instance._review_receipt("legacy:25"))
            receipt_path = instance._receipt_path("legacy:25")
            receipt_path.parent.mkdir(parents=True)
            receipt_path.write_text(json.dumps({"taskId": "legacy:25", "decision": "held",
                                                "evidenceFiles": [str(evidence.relative_to(root))],
                                                "checkedAt": "2026-10-09T00:00:00Z"}))
            self.assertIsNotNone(instance._review_receipt("legacy:25"))
            receipt_path.write_text(json.dumps({"taskId": "legacy:25", "decision": "held",
                                                "evidenceFiles": ["missing.json"], "checkedAt": "now"}))
            self.assertIsNone(instance._review_receipt("legacy:25"))

    def _review_runner(self, root):
        queue = root / "world-parcels" / "research" / "cohort" / "pending-queue.json"
        queue.parent.mkdir(parents=True, exist_ok=True)
        queue.write_text("{}")
        args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=queue, job_name="test",
                               codex="codex", max_retries=3)
        instance = runner.Runner(args)
        instance.state = {"queuePath": str(queue), "rootReviewTasks": {}, "cities": {}}
        evidence = queue.parent / "evidence.json"
        evidence.write_text("{}")
        task_ids = ["legacy:25", "legacy:780", "legacy:3976"]
        for task_id in task_ids:
            path = instance._receipt_path(task_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"taskId": task_id, "decision": "held",
                                        "evidenceFiles": [str(evidence.relative_to(root))],
                                        "checkedAt": "2026-10-09T00:00:00Z"}))
            instance.state["rootReviewTasks"][task_id] = {"status": "pending", "attempts": 0}
        return instance, task_ids

    @staticmethod
    def _review_result(task_ids):
        return {"returncode": 0, "systemic": False,
                "answer": {"reviewedIds": task_ids, "heldIds": task_ids,
                           "summary": "reviewed and held", "systemicFailure": False}}

    def test_partial_reviews_accumulate_across_retry(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, tasks = self._review_runner(Path(raw))
            answers = [self._review_result(tasks[1:])]
            calls = []
            def fake_run_calls(call_group):
                calls.extend(call_group)
                return [answers.pop(0)]
            instance.run_calls = fake_run_calls
            success, answer, _ = instance._complete_review([], tasks, first_result=self._review_result([tasks[0]]))
            self.assertTrue(success)
            self.assertEqual(set(answer["reviewedIds"]), set(tasks))
            self.assertEqual(set(answer["heldIds"]), set(tasks))
            self.assertEqual(len(calls), 1)

    def test_review_consumes_third_and_final_attempt(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, tasks = self._review_runner(Path(raw))
            responses = [self._review_result([tasks[1]]), self._review_result([tasks[2]])]
            calls = []
            def fake_run_calls(call_group):
                calls.extend(call_group)
                return [responses.pop(0)]
            instance.run_calls = fake_run_calls
            first = self._review_result([tasks[0]])
            success, answer, _ = instance._complete_review([], tasks, first_result=first)
            self.assertTrue(success)
            self.assertEqual(set(answer["reviewedIds"]), set(tasks))
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
