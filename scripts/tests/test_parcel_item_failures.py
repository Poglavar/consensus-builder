"""Prove one incomplete city/review cannot prevent processing later cities or ranks."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parents[1] / "run-valhalla-parcel-research.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ItemFailureTests(unittest.TestCase):
    def make_runner(self, root, cities):
        root = root.resolve()
        queue = root / "cohort" / "pending-queue.json"
        queue.parent.mkdir(parents=True)
        queue.write_text("{}")
        args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=queue,
                               job_name="test", codex="codex", max_retries=3, workers=3)
        instance = runner.Runner(args)
        instance.state = runner.new_state("test", str(queue), runner.sha256_file(queue))
        instance._load_queue = lambda _: ({}, cities)
        instance._ensure_root_tasks = lambda *_: None
        return instance, queue

    @staticmethod
    def city(code):
        return {"cityCode": code, "name": f"City {code}", "rank": code, "country": "Example",
                "iso2": "EX", "point": [1, 2], "pop2025k": 10}

    def test_exhausted_city_is_skipped_and_later_city_processed(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [self.city(1), self.city(2)])
            instance._city_entry(self.city(1)).update(status="blocked", attempts=3,
                                                      lastError="missing paired report")
            good = instance._city_entry(self.city(2))
            good.update(status="pending")
            instance._packet = lambda city, _: {"valid": city["cityCode"] == 2 and good["status"] != "pending",
                "errors": ["missing paired report"], "cityPath": queue.parent / "city-2.json"}
            instance._reviewed_city_receipt = lambda city, _packet: {} if city["cityCode"] == 2 and good["status"] == "reviewed-held" else None
            def record(cities, *_):
                self.assertEqual([city["cityCode"] for city in cities], [2])
                good["status"] = "research-complete"
                return [], None, False
            instance._record_city_attempts = record
            instance.run_calls = lambda _: [{}]
            def review(*_args, **_kwargs):
                good["status"] = "reviewed-held"
                return True, {}, False
            instance._complete_review = review
            okay, end = instance._process_queue(queue, once=False)
            self.assertTrue(okay)
            self.assertEqual(end, 2)
            self.assertEqual(instance.state["cities"]["1"]["status"], "failed-skipped")
            self.assertEqual(good["status"], "reviewed-held")
            persisted = runner.json_read(instance.state_path)
            self.assertEqual(persisted["cities"]["1"]["lastError"], "missing paired report")
            self.assertIn("city:1", persisted["failedItems"])
            instance._select_batch([self.city(1), self.city(2)], queue.parent)
            self.assertEqual(len((instance.state_dir / "failed-items.jsonl").read_text().splitlines()), 1)
            self.assertEqual(persisted["completedCount"], 0)

    def test_retry_limit_preserves_failure_and_does_not_mark_complete(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [self.city(1)])
            instance._packet = lambda *_: {"valid": False, "errors": ["bad report"]}
            calls = []
            def run(group):
                calls.extend(group)
                return [{"call": call, "returncode": 0, "systemic": False} for call in group]
            instance.run_calls = run
            pending, _, systemic = instance._record_city_attempts([self.city(1)], queue.parent)
            self.assertEqual(len(calls), 3)
            self.assertEqual(pending, [])
            self.assertFalse(systemic)
            entry = instance.state["cities"]["1"]
            self.assertEqual(entry["status"], "failed-skipped")
            self.assertEqual(entry["attempts"], 3)
            self.assertEqual(instance.state["completedCount"], 0)

    def test_missing_city_review_receipt_does_not_stop_rank_advancement(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [self.city(1)])
            instance._packet = lambda *_: {"valid": True, "cityPath": queue.parent / "city-1.json"}
            instance.run_calls = lambda _: [{"returncode": 0}]
            instance._record_city_attempts = lambda *_: ([], {"returncode": 0}, False)
            instance._complete_review = lambda *_a, **_k: (False, None, False)
            okay, end = instance._process_queue(queue, once=False)
            self.assertTrue(okay)
            self.assertEqual(end, 1)
            self.assertEqual(instance.state["cities"]["1"]["failedPhase"], "review")

    def test_real_codex_service_failure_still_stops(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [self.city(1)])
            instance._packet = lambda *_: {"valid": False, "errors": ["no packet"]}
            def run(group):
                return [{"call": call, "returncode": 1, "systemic": True} for call in group]
            instance.run_calls = run
            okay, end = instance._process_queue(queue, once=False)
            self.assertFalse(okay)
            self.assertIsNone(end)
            self.assertEqual(instance.state["status"], "blocked")
            self.assertNotIn("city:1", instance.state.get("failedItems", {}))

    def test_unresolved_identity_remains_excluded_without_stopping_queue(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [])
            (queue.parent / "identity-review.json").write_text(json.dumps({"cities": [self.city(1)]}))
            instance.run_calls = lambda _: [{}]
            instance._complete_review = lambda *_: (False, None, False)
            self.assertTrue(instance._resolve_identity_holds(queue))
            self.assertEqual(instance.state["identityReviews"]["identity:1"]["status"], "failed-skipped")
            self.assertEqual(len(runner.json_read(queue.parent / "identity-review.json")["cities"]), 1)
            instance.run_calls = lambda _: self.fail("skipped identity was retried on resume")
            self.assertTrue(instance._resolve_identity_holds(queue))

    def test_research_prompt_explicitly_names_pairing_key(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, queue = self.make_runner(Path(raw), [])
            prompt = instance._build_research_prompt(self.city(1), queue.parent, 1)
            self.assertIn('"cityRecord": "city-1-city-1.json"', prompt)
            self.assertIn("reread both named JSON files", prompt)


if __name__ == "__main__":
    unittest.main()
