"""Check immutable packet values, durable review receipts, and bounded review retries."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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

    def test_sample_accepts_canonical_or_legacy_id_and_rejects_source_attribute_sets(self):
        polygon = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
        sample = self.cohort / "sample.geojson"
        for key in ("id", "OBJECTID", "PARCEL_ID"):
            sample.write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {key: "native-1"}, "geometry": polygon}
            ]}))
            self.assertEqual(runner.validate_sample_file(sample)[1], [])
        sample.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"ilId": "1", "ilceId": "2", "adaNo": "3"}, "geometry": polygon}
        ]}))
        errors = runner.validate_sample_file(sample)[1]
        self.assertTrue(any("one canonical/native ID property only" in error for error in errors))
        self.assertTrue(any("non-ID or sensitive attribute" in error for error in errors))

class ResumeAndReceiptTests(unittest.TestCase):
    def test_new_cohort_returns_generated_queue_and_preserves_previous(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            previous = root / "world-parcels/research/previous/pending-queue.json"
            previous.parent.mkdir(parents=True)
            previous.write_text("{}")
            source = root / "wup.gz"
            source.write_bytes(b"frozen-source")
            args = SimpleNamespace(repo_root=root, state_dir=Path("state"),
                                   queue=previous, job_name="test", codex="codex",
                                   source=Path("wup.gz"), timeout_seconds=30)
            instance = runner.Runner(args)
            instance.state = {"queuePath": str(previous)}
            def build(command, **kwargs):
                output = Path(command[command.index("--output") + 1])
                output.mkdir(parents=True)
                (output / "pending-queue.json").write_text('{"cities":[]}')
                return SimpleNamespace(returncode=0, stdout="generated", stderr="")
            with patch.object(runner.subprocess, "run", side_effect=build):
                queue = instance._write_queue_builder(2301, 2400)
            self.assertTrue(queue.is_file())
            self.assertIn("overnight-next-2301-2400-", str(queue))
            self.assertEqual(previous.read_text(), "{}")
            with patch.object(runner.subprocess, "run") as build_again:
                self.assertEqual(instance._write_queue_builder(2301, 2400), queue)
                build_again.assert_not_called()

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
        instance.models = {"review": {"model": "test-review", "effort": "high"}}
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

    def test_reviewer_systemic_flag_does_not_poison_successful_cli_turn(self):
        with tempfile.TemporaryDirectory() as raw:
            instance, tasks = self._review_runner(Path(raw))
            answer = self._review_result(tasks)
            answer["answer"]["systemicFailure"] = True
            success, _answer, systemic = instance._complete_review([], tasks, first_result=answer)
            self.assertTrue(success)
            self.assertFalse(systemic)

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

    def _queue_builder_runner(self, root):
        args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=Path("queue.json"),
                               source=Path("source.csv.gz"), job_name="test", codex="codex",
                               timeout_seconds=60)
        return runner.Runner(args)

    def test_prebuilt_queue_reused_after_date_rollover(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            folder = root / "world-parcels" / "research" / "overnight-next-1301-1400-2026-10-08"
            folder.mkdir(parents=True)
            queue = folder / "pending-queue.json"
            queue.write_text("{}")
            instance = self._queue_builder_runner(root)
            self.assertEqual(instance._write_queue_builder(1301, 1400), queue.resolve())

    def test_ambiguous_prebuilt_cohorts_are_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for date in ("2026-10-08", "2026-10-09"):
                folder = root / "world-parcels" / "research" / f"overnight-next-1301-1400-{date}"
                folder.mkdir(parents=True)
                (folder / "pending-queue.json").write_text("{}")
            instance = self._queue_builder_runner(root)
            with self.assertRaisesRegex(RuntimeError, "multiple prebuilt cohort folders"):
                instance._write_queue_builder(1301, 1400)

    def test_prebuilt_folder_without_queue_is_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            folder = root / "world-parcels" / "research" / "overnight-next-1301-1400-2026-10-08"
            folder.mkdir(parents=True)
            marker = folder / "ranked-population.json"
            marker.write_text("{}")
            instance = self._queue_builder_runner(root)
            with self.assertRaisesRegex(RuntimeError, "without pending queue"):
                instance._write_queue_builder(1301, 1400)
            self.assertTrue(marker.exists())


class FailureClassificationAndPromptTests(unittest.TestCase):
    def test_provider_403_in_tool_output_is_not_codex_systemic_failure(self):
        stdout = json.dumps({"type": "item.completed", "item": {"type": "command_execution", "output": "provider HTTP 403"}})
        self.assertFalse(runner.systemic_codex_failure(1, stdout, "command returned HTTP 403 from provider"))
        self.assertFalse(runner.systemic_codex_failure(1, "shell output: HTTP 429", "process exited 22"))
        failed_command = json.dumps({"type": "item.completed", "item": {"type": "command_execution",
                                                                           "output": "HTTP 403: unauthorized"}})
        self.assertFalse(runner.systemic_codex_failure(1, failed_command, "tool subprocess failed: HTTP 403"))

    def test_codex_usage_and_auth_errors_are_systemic(self):
        usage = json.dumps({"type": "turn.failed", "error": {"codex_error_info": "usage_limit_reached"}})
        auth = json.dumps({"type": "error", "error": {"code": "auth_required", "message": "Please sign in"}})
        self.assertTrue(runner.systemic_codex_failure(1, usage, ""))
        self.assertTrue(runner.systemic_codex_failure(1, auth, ""))
        self.assertTrue(runner.systemic_codex_failure(1, "", "ERROR: usage_limit_reached"))

    def test_artifact_retry_prompt_includes_validation_errors_without_research(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            cohort = root / "cohort"
            cohort.mkdir()
            args = SimpleNamespace(repo_root=root, state_dir=Path("state"), queue=Path("queue.json"),
                                   job_name="test", codex="codex", max_retries=3)
            instance = runner.Runner(args)
            city = {"cityCode": 1, "name": "Test City", "rank": 1, "country": "Example", "iso2": "EX",
                    "point": [1, 2], "pop2025k": 10}
            prompt = instance._build_research_prompt(city, cohort.resolve(), 2, ["sample feature 0 contains non-ID attribute 'ilId'"])
            self.assertIn("sample feature 0 contains non-ID attribute 'ilId'", prompt)
            self.assertIn("Do not repeat web searches, network/API requests, or source investigation", prompt)
            self.assertIn("do not drop, simplify, transform, or reconstruct polygon coordinates", prompt)


class FiniteDiscoveryTests(unittest.TestCase):
    def test_finite_queue_never_generates_a_global_range(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = root / "cohort/pending-queue.json"
            queue.parent.mkdir()
            queue.write_text(json.dumps({"cities": [{"cityCode": 42}]}))
            args = runner.build_parser().parse_args(["--run", "--stop-after-queue", "--discovery-only",
                                                     "--repo-root", str(root), "--queue", str(queue)])
            args.timeout_seconds = 60
            instance = runner.Runner(args)
            instance.models = {"research": {"model": "test-model"}}
            instance.codex_env = {}
            with patch.object(instance, "_resolve_identity_holds", return_value=True), \
                 patch.object(instance, "_process_queue", return_value=(True, 1000)), \
                 patch.object(instance, "_write_queue_builder") as extend:
                self.assertEqual(instance.run(), 0)
            extend.assert_not_called()
            self.assertEqual(instance.state["status"], "complete")

    def test_discovery_mode_excludes_legacy_admission_tasks(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            args = runner.build_parser().parse_args(["--repo-root", str(root), "--discovery-only"])
            instance = runner.Runner(args)
            instance.state = {"queuePath": str(root / "cohort/pending-queue.json")}
            instance._ensure_root_tasks(root / "cohort", [])
            self.assertEqual(instance.state["rootReviewTasks"], {})
            prompt = instance._build_review_prompt([], [])
            self.assertIn("do not edit registry, catalog, runtime", prompt)
            self.assertNotIn("ONLY agent authorized", prompt)

    def test_subscription_environment_strips_shared_key_list_and_forces_login(self):
        with tempfile.TemporaryDirectory() as raw:
            args = runner.build_parser().parse_args(["--repo-root", raw])
            instance = runner.Runner(args)
            with patch.dict(runner.os.environ, {"OPENAI_API_KEY": "fake", "SAFE_SETTING": "kept"}), \
                 patch.object(instance, "_accounting", return_value={"environmentKeys": ["OPENAI_API_KEY"]}):
                environment = instance._subscription_environment()
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertEqual(environment["SAFE_SETTING"], "kept")
            command = instance._command({"model": "test", "effort": "low"}, Path("schema"), Path("answer"))
            self.assertIn('forced_login_method="chatgpt"', command)


if __name__ == "__main__":
    unittest.main()
