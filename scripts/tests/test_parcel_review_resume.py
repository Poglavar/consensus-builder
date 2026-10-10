"""Check resume reuses real current review evidence and never invents completed reviews."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parents[1] / "run-valhalla-parcel-research.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ReviewResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cohort = self.root / "cohort"
        self.cohort.mkdir()
        self.queue = self.cohort / "pending-queue.json"
        self.queue.write_text("{}")
        args = SimpleNamespace(repo_root=self.root, state_dir=Path("state"), queue=self.queue,
                               job_name="test", codex="codex", max_retries=3, workers=3)
        self.instance = runner.Runner(args)
        self.instance.state = runner.new_state("test", str(self.queue), runner.sha256_file(self.queue))
        self.city = {"cityCode": 42, "rank": 7, "country": "Example", "iso2": "EX",
                     "point": [1.25, 2.5], "pop2025k": 123.45}
        self.city_path = self.cohort / "city-42-example.json"
        self.review_path = self.cohort / "example-service-review.json"
        self.city_path.write_text(json.dumps({
            "cityCode": 42, "queueRank": 7, "country": "Example", "countryCode": "EX",
            "point": [1.25, 2.5], "population2025": 123450, "populationUnit": "persons",
            "status": "complete", "freshResearch": {"queries": [
                {"language": "English", "query": "parcel", "result": "checked", "actualResultUrls": ["https://example.test/en"]},
                {"language": "native", "query": "cadastre", "result": "checked", "actualResultUrls": ["https://example.test/local"]}]}}))
        self.review_path.write_text(json.dumps({"cityRecord": self.city_path.name}))
        self.receipt = {"taskId": "city:42", "decision": "held", "checkedAt": "2026-10-09T00:00:00Z",
                        "evidenceFiles": [str(path.relative_to(self.root)) for path in (self.city_path, self.review_path)]}
        self.receipt_path = self.instance._receipt_path("city:42")
        self.receipt_path.parent.mkdir()
        self.receipt_path.write_text(json.dumps(self.receipt))
        for path in (self.city_path, self.review_path):
            os.utime(path, (1791417500, 1791417500))  # before the receipt's checkedAt
        self.entry = self.instance._city_entry(self.city)
        self.entry.update(status="reviewed-held", reviewedAt=self.receipt["checkedAt"], receiptPath=str(self.receipt_path))
        self.instance.state["heldCount"] = 1

    def tearDown(self):
        self.temp.cleanup()

    def test_resume_does_not_create_duplicate_packet_task(self):
        self.instance._ensure_root_tasks(self.cohort, [self.city])
        self.assertNotIn("packet:42", self.instance.state["rootReviewTasks"])
        self.assertEqual(self.instance._select_batch([self.city], self.cohort), ([], []))

    def test_existing_duplicate_reuses_receipt_and_preserves_genuine_tasks(self):
        tasks = self.instance.state["rootReviewTasks"]
        tasks["packet:42"] = {"status": "pending", "attempts": 0}
        tasks["root:genuine-followthrough"] = {"status": "pending", "attempts": 0}
        self.instance._ensure_root_tasks(self.cohort, [self.city])
        self.assertEqual(tasks["packet:42"]["status"], "done")
        self.assertEqual(tasks["packet:42"]["satisfiedBy"], "city:42")
        self.assertEqual(tasks["packet:42"]["receiptPath"], str(self.receipt_path))
        self.assertEqual(tasks["root:genuine-followthrough"]["status"], "pending")
        self.instance._ensure_root_tasks(self.cohort, [self.city])
        self.assertEqual(self.instance.state["heldCount"], 1)

    def test_missing_receipt_requires_review_despite_state_flag(self):
        self.receipt_path.unlink()
        research, review = self.instance._select_batch([self.city], self.cohort)
        self.assertEqual(research, [])
        self.assertEqual([item["cityCode"] for item in review], [42])

    def test_receipt_for_other_evidence_cannot_retire_duplicate(self):
        unrelated = self.cohort / "other.json"
        unrelated.write_text("{}")
        self.receipt["evidenceFiles"] = [str(unrelated.relative_to(self.root))]
        self.receipt_path.write_text(json.dumps(self.receipt))
        tasks = self.instance.state["rootReviewTasks"]
        tasks["packet:42"] = {"status": "pending"}
        self.instance._ensure_root_tasks(self.cohort, [self.city])
        self.assertEqual(tasks["packet:42"]["status"], "pending")

    def test_changed_packet_requires_new_review(self):
        checked = runner.datetime.fromisoformat(self.receipt["checkedAt"].replace("Z", "+00:00")).timestamp()
        os.utime(self.city_path, (checked + 10, checked + 10))
        self.assertIsNone(self.instance._reviewed_city_receipt(self.city, self.instance._packet(self.city, self.cohort)))
        self.assertEqual(len(self.instance._select_batch([self.city], self.cohort)[1]), 1)

    def test_unreviewed_complete_packet_uses_one_city_review_queue(self):
        self.entry["status"] = "pending"
        self.instance._ensure_root_tasks(self.cohort, [self.city])
        self.assertNotIn("packet:42", self.instance.state["rootReviewTasks"])
        self.assertEqual(len(self.instance._select_batch([self.city], self.cohort)[1]), 1)

    def test_reviewed_range_finishes_without_calling_llm(self):
        self.instance.state["rootReviewTasks"] = {task_id: {"status": "done"} for task_id, _ in runner.ROOT_REVIEW_TASKS}
        self.instance.state["rootReviewTasks"]["packet:42"] = {"status": "pending"}
        self.instance._load_queue = lambda _: ({}, [self.city])
        self.instance.run_calls = lambda _: self.fail("completed packet unnecessarily called the LLM")
        self.assertEqual(self.instance._process_queue(self.queue, once=False), (True, 7))


if __name__ == "__main__":
    unittest.main()
