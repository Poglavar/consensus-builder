"""Bounded source-uniqueness checks for opt-in discovery runs."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
HELPER_SPEC = importlib.util.spec_from_file_location("parcel_source_novelty", ROOT / "scripts/lib/parcel_source_novelty.py")
novelty = importlib.util.module_from_spec(HELPER_SPEC)
HELPER_SPEC.loader.exec_module(novelty)
RUNNER_SPEC = importlib.util.spec_from_file_location("valhalla_novelty_runner", ROOT / "scripts/run-valhalla-parcel-research.py")
runner_module = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(runner_module)


class SourceNoveltyTests(unittest.TestCase):
    def test_endpoint_identity_ignores_query_fragment_and_trailing_slash(self):
        self.assertEqual(novelty.normalized_endpoint("HTTPS://Maps.Example.test:443/arcgis/rest/?token=old#layer"),
                         novelty.normalized_endpoint("https://maps.example.test/arcgis/rest"))

    def test_known_id_and_same_service_endpoint_are_excluded(self):
        snapshot = {"sources": [{"id": "known-1", "endpoint": "https://maps.example.test/service?layer=1"}]}
        self.assertIn("source ID", novelty.novelty_error(
            {"sourceId": "known-1", "endpoint": "https://other.example.test/new"}, snapshot, None))
        self.assertIn("endpoint", novelty.novelty_error(
            {"sourceId": "new-id", "endpoint": "https://maps.example.test/service?layer=9"}, snapshot, None))
        self.assertIn("endpoint", novelty.novelty_error(
            {"sourceId": "new-id", "endpoint": "https://live.example.test/parcel"}, None,
            {"sources": [{"id": "live", "endpoint": "https://live.example.test/parcel/"}]}))

    def test_protocol_upgrade_does_not_make_a_known_service_new(self):
        snapshot = {"sources": [{"id": "known-http", "endpoint": "http://maps.example.test/arcgis/MapServer/0"}]}
        error = novelty.novelty_error(
            {"sourceId": "new-https", "endpoint": "https://maps.example.test/arcgis/MapServer/0"}, snapshot, None)
        self.assertIn("endpoint", error)

    def test_distinct_service_on_shared_host_is_allowed_unless_host_is_explicitly_excluded(self):
        candidate = {"sourceId": "new", "endpoint": "https://services.example.test/other/layer/0"}
        snapshot = {"sources": [{"id": "old", "endpoint": "https://services.example.test/known/layer/0"}]}
        self.assertIsNone(novelty.novelty_error(candidate, snapshot, None))
        snapshot["knownProviderHosts"] = ["example.test"]
        self.assertIn("known provider host", novelty.novelty_error(candidate, snapshot, None))


class RunnerNoveltyReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queue = self.root / "research" / "pending-queue.json"
        self.queue.parent.mkdir(parents=True)
        self.queue.write_text("{}")
        self.evidence = self.root / "research" / "packet.json"
        self.evidence.write_text("{}")
        args = SimpleNamespace(repo_root=self.root, state_dir=Path("state"), queue=self.queue,
                               job_name="novelty-test", codex="codex", with_adapters=True,
                               discovery_only=False, new_sources_only=True, max_retries=3, learning_file=[])
        self.runner = runner_module.Runner(args)
        self.runner.state = {"queuePath": str(self.queue)}
        self.runner.known_sources_doc = {"sources": [{"id": "base-source", "endpoint": "https://base.example.test/parcel"}]}
        self.catalog_path = self.root / "backend/parcels/source-catalog.json"
        self.catalog_path.parent.mkdir(parents=True)
        self.write_catalog([])

    def tearDown(self):
        self.temp.cleanup()

    def write_catalog(self, sources):
        self.catalog_path.write_text(json.dumps({"sources": sources}))

    def write_receipt(self, decision, source):
        receipt = {"taskId": "city:42", "decision": decision, "source": source,
                   "evidenceFiles": [str(self.evidence.relative_to(self.root))],
                   "checkedAt": "2026-10-19T00:00:00Z", "reason": "checked"}
        path = self.runner._receipt_path("city:42")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(receipt))
        return path

    def read_receipt(self, decision, source):
        self.write_receipt(decision, source)
        with patch.object(runner_module.discovery_outcomes, "validate_receipt", return_value=[]):
            return self.runner._review_receipt("city:42")

    def test_known_snapshot_candidate_is_rejected_but_blocked_and_rejected_records_are_valid(self):
        known = {"sourceId": "base-source", "endpoint": "https://base.example.test/parcel"}
        self.assertIsNone(self.read_receipt("candidate", known))
        self.assertIn("source ID", self.runner.receipt_errors["city:42"][0])
        self.assertIsNotNone(self.read_receipt("blocked", known))
        self.assertIsNotNone(self.read_receipt("rejected", known))

    def test_already_supported_duplicate_is_validated_by_binding_policy_not_novelty_gate(self):
        known = {"sourceId": "base-source", "endpoint": "https://base.example.test/parcel"}
        self.write_receipt("already-supported", known)
        with patch.object(runner_module.discovery_outcomes, "validate_receipt", return_value=[]), \
                patch.object(runner_module.discovery_outcomes, "supported_binding_errors", return_value=[]), \
                patch("parcel_source_admission._existing_bindings", return_value=[]):
            self.assertIsNotNone(self.runner._review_receipt("city:42"))

    def test_resumed_own_integrated_candidate_stays_valid_for_its_exact_city_and_source(self):
        source = {"sourceId": "new-source", "endpoint": "https://new.example.test/parcels"}
        self.write_catalog([{"id": "new-source", "endpoint": source["endpoint"], "cityIds": ["city_42"]}])
        with patch("parcel_source_admission._existing_bindings", return_value=[
                {"id": "city_42", "wupCityCode": 42, "sourceId": "new-source"}]), \
                patch.object(runner_module.discovery_outcomes, "validate_receipt", return_value=[]):
            self.assertIsNotNone(self.read_receipt("candidate", source))

    def test_same_source_bound_to_another_city_is_still_rejected(self):
        source = {"sourceId": "new-source", "endpoint": "https://new.example.test/parcels"}
        self.write_catalog([{"id": "new-source", "endpoint": source["endpoint"], "cityIds": ["city_99"]}])
        with patch("parcel_source_admission._existing_bindings", return_value=[
                {"id": "city_99", "wupCityCode": 99, "sourceId": "new-source"}]), \
                patch.object(runner_module.discovery_outcomes, "validate_receipt", return_value=[]):
            self.assertIsNone(self.read_receipt("candidate", source))
        self.assertIn("already known", self.runner.receipt_errors["city:42"][0])

    def test_research_and_review_prompts_carry_the_new_source_rule(self):
        cohort = self.root / "research"
        city = {"cityCode": 42, "name": "Example", "rank": 1, "country": "Example",
                "iso2": "EX", "point": [1.0, 2.0], "pop2025k": 1.0}
        research = self.runner._build_research_prompt(city, cohort.resolve(), 1)
        review = self.runner._build_review_prompt([city], [])
        for prompt in (research, review):
            self.assertIn("NEW-SOURCE-ONLY POLICY", prompt)
            self.assertIn("municipal/local registry", prompt)
            self.assertIn("local-language web sources", prompt)
            self.assertIn("completed rejection", prompt)

    def test_frozen_snapshot_hash_is_persisted_and_resume_refuses_snapshot_change(self):
        snapshot_path = self.root / "research" / "known-sources.json"
        snapshot_path.write_text(json.dumps({"sources": [{"id": "base", "endpoint": "https://base.test/service"}]}))
        self.runner.args.known_sources = Path("research/known-sources.json")
        self.runner._configure_source_novelty(self.queue)
        first_hash = self.runner.known_sources_sha256
        self.runner.load_state(self.queue)
        self.assertEqual(self.runner.state["researchPolicy"]["knownSourcesSha256"], first_hash)
        snapshot_path.write_text(json.dumps({"sources": [{"id": "changed", "endpoint": "https://changed.test/service"}]}))

        resumed = runner_module.Runner(self.runner.args)
        resumed._configure_source_novelty(self.queue)
        with self.assertRaisesRegex(RuntimeError, "snapshot changed"):
            resumed.load_state(self.queue)


if __name__ == "__main__":
    unittest.main()
