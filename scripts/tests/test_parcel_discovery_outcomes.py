"""Discovery rejects exhausted searches and hands only evidenced coverage to adapters."""
import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS / "lib"))
import parcel_discovery_outcomes as outcomes

SPEC = importlib.util.spec_from_file_location("discovery_runner_test", SCRIPTS / "run-valhalla-parcel-research.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def receipt_for(root, decision="candidate"):
    probes = []
    for i in range(3):
        path = root / f"probe-{i}.json"
        path.write_text(json.dumps({"request": f"https://example.test/parcels?area={i}", "ids": [i * 2, i * 2 + 1]}))
        probes.append({"bbox": [i, 0, i + .1, .1], "featureCount": 10, "geometryType": "Polygon",
                       "sampleIds": [str(i * 2), str(i * 2 + 1)], "evidenceFile": path.name,
                       "evidenceSha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return {"schemaVersion": 2, "taskId": "city:42", "decision": decision,
            "reason": "A systematic municipal cadastre with observed polygons across the city.",
            "checkedAt": runner.utc_now(), "evidenceFiles": [p["evidenceFile"] for p in probes],
            "searchCoverage": {level: {"status": "checked", "reason": "Inspected current public portal.",
                                      "evidenceUrls": ["https://example.test/" + level]} for level in outcomes.SEARCH_LEVELS},
            "source": {"sourceId": "example-cadastre", "endpoint": "https://example.test/parcels",
                       "purpose": "cadastral-parcels", "purposeEvidenceUrls": ["https://example.test/metadata"]},
            "coverage": {"scope": "citywide", "basis": "Municipal cadastre metadata names the city.",
                         "evidenceUrls": ["https://example.test/metadata"], "distributedAcrossCity": True,
                         "distributionBasis": "West, centre and east districts.", "probes": probes},
            "nextAction": "Configure WFS source and qualify ID/paging/geometry/CRS contracts."}


class DiscoveryOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.receipt = receipt_for(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_distributed_cadastral_candidate_passes(self):
        self.assertEqual(outcomes.validate_receipt(self.root, self.receipt), [])

    def test_property_offering_and_single_sample_cannot_be_candidates(self):
        self.receipt["source"]["purpose"] = "property-sale"
        self.receipt["coverage"]["scope"] = "isolated"
        self.receipt["coverage"]["probes"] = self.receipt["coverage"]["probes"][:1]
        errors = outcomes.validate_receipt(self.root, self.receipt)
        self.assertTrue(any("cadastral" in e for e in errors))
        self.assertTrue(any("isolated" in e for e in errors))
        self.assertTrue(any("three" in e for e in errors))

    def test_same_area_or_repeated_feature_ids_do_not_establish_coverage(self):
        for probe in self.receipt["coverage"]["probes"]:
            probe["bbox"] = [0, 0, .1, .1]
            probe["sampleIds"] = ["one", "two"]
        errors = outcomes.validate_receipt(self.root, self.receipt)
        self.assertTrue(any("non-overlapping" in e for e in errors))
        self.assertTrue(any("multiple parcels" in e for e in errors))

    def test_malformed_ids_urls_and_unlisted_probe_are_rejected(self):
        self.receipt["coverage"]["probes"][0]["sampleIds"] = "many-ids"
        self.receipt["source"]["purposeEvidenceUrls"] = ["not a URL"]
        self.receipt["evidenceFiles"] = []
        errors = outcomes.validate_receipt(self.root, self.receipt)
        self.assertTrue(any("sample IDs" in e for e in errors))
        self.assertTrue(any("cadastral" in e for e in errors))
        self.assertTrue(any("included" in e for e in errors))

    def test_changed_probe_bytes_invalidate_handoff(self):
        (self.root / "probe-1.json").write_text("changed")
        self.assertIn("coverage probe evidence hash differs", outcomes.validate_receipt(self.root, self.receipt))

    def test_rejected_search_is_terminal_without_future_qualification_action(self):
        self.receipt.update(decision="rejected", rejectionReason="Only land-sale adverts after all recorded searches.", nextAction=None)
        self.receipt.pop("source")
        self.receipt.pop("coverage")
        self.assertEqual(outcomes.validate_receipt(self.root, self.receipt), [])
        self.receipt["nextAction"] = "Qualify later"
        self.assertTrue(outcomes.validate_receipt(self.root, self.receipt))

    def test_blocked_requires_a_concrete_source_and_action(self):
        self.receipt.update(decision="blocked", blocker="Known cadastral WFS temporarily returns 503.", nextAction="Retry the saved WFS layer query after the outage.")
        self.receipt.pop("coverage")
        self.assertEqual(outcomes.validate_receipt(self.root, self.receipt), [])
        self.receipt["source"] = None
        self.assertTrue(outcomes.validate_receipt(self.root, self.receipt))

    def test_search_cannot_skip_municipal_national_or_web(self):
        for level in ("municipal", "national", "web"):
            rec = copy.deepcopy(self.receipt)
            rec["searchCoverage"][level] = {"status": "not-applicable", "reason": "Skipped"}
            self.assertTrue(outcomes.validate_receipt(self.root, rec), level)

    def test_existing_app_identity_uses_canonical_wup_demographic_mapping(self):
        catalog = self.root / "backend/parcels/source-catalog.json"
        demographics = self.root / "world-parcels/report/city-demographics.json"
        catalog.parent.mkdir(parents=True)
        demographics.parent.mkdir(parents=True)
        catalog.write_text(json.dumps({"sources": [{"id": "example-cadastre", "endpoint": "https://example.test/parcels", "cityIds": ["example"]}]}))
        demographics.write_text(json.dumps({"cities": [{"wupCityCode": 42, "appCityIds": ["example"]}]}))
        receipt = {**self.receipt, "decision": "already-supported", "appCityIds": ["example"]}
        bindings = [{"id": "example", "sourceId": "example-cadastre"}]
        self.assertEqual(outcomes.supported_binding_errors(self.root, receipt, bindings, "42"), [])
        self.assertTrue(outcomes.supported_binding_errors(self.root, receipt, bindings, "43"))
        bindings[0]["wupCityCode"] = 43
        self.assertTrue(outcomes.supported_binding_errors(self.root, receipt, bindings, "42"))
        bindings[0].update(wupCityCode=42, sourceId="different-source")
        self.assertTrue(outcomes.supported_binding_errors(self.root, receipt, bindings, "42"))

    def test_counts_do_not_call_old_held_reviews_candidates(self):
        state = {"cities": {"1": {"status": "reviewed-held"},
                            "2": {"status": "reviewed-rejected", "discoveryDecision": "rejected"},
                            "3": {"status": "reviewed-candidate", "discoveryDecision": "candidate", "qualification": {"status": "integrated"}},
                            "4": {"status": "reviewed-blocked", "discoveryDecision": "blocked"}}}
        result = outcomes.counts(state)
        self.assertEqual((result["reviewed"], result["candidate"], result["unclassified"], result["rejected"], result["blocked"]), (4, 1, 1, 1, 1))
        self.assertEqual(result["qualification"], {"integrated": 1})


class DiscoveryPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cohort = self.root / "cohort"
        self.cohort.mkdir()
        self.args = runner.build_parser().parse_args(["--repo-root", str(self.root), "--queue", "cohort/queue.json", "--state-dir", "state", "--with-adapters"])
        self.instance = runner.Runner(self.args)
        self.instance.models = {"review": {"model": "test", "effort": "low"}}
        self.snapshot = patch.object(self.instance, "_candidate_workspace_snapshot", return_value={})
        self.snapshot.start()
        self.addCleanup(self.snapshot.stop)
        self.instance.state = {"queuePath": str(self.cohort / "queue.json"), "cities": {}, "rootReviewTasks": {}}
        self.city = {"cityCode": 42, "name": "Example", "rank": 1, "country": "Example", "iso2": "EX", "point": [1, 2], "pop2025k": 10}
        for file in ("city.json", "review.json"):
            (self.cohort / file).write_text("{}")
        self.packet = {"valid": True, "cityPath": self.cohort / "city.json", "reviewPath": self.cohort / "review.json"}
        self.receipt = receipt_for(self.root)
        self.receipt["evidenceFiles"] += ["cohort/city.json", "cohort/review.json"]
        self.path = self.instance._receipt_path("city:42")
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps(self.receipt))

    def tearDown(self):
        self.temp.cleanup()

    def accept(self, decision):
        self.receipt["decision"] = decision
        if decision == "rejected":
            self.receipt.update(rejectionReason="Exhausted documented routes.", nextAction=None)
        self.path.write_text(json.dumps(self.receipt))
        answer = {"returncode": 0, "answer": {"reviewedIds": ["city:42"], "heldIds": [], "summary": "Reviewed", "systemicFailure": False}}
        with patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._complete_review([self.city], [], first_result=answer)[0])

    def test_new_rejection_is_counted_and_never_calls_adapter(self):
        self.accept("rejected")
        self.assertEqual(self.instance.state["cities"]["42"]["status"], "reviewed-rejected")
        build = Mock()
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock(return_value=(True, "current"))), "parcel_source_admission": SimpleNamespace(admit_candidate=Mock())}):
            self.assertFalse(self.instance._advance_candidate([self.city], self.cohort))
        build.assert_not_called()

    def test_candidate_automatically_builds_then_integrates(self):
        self.accept("candidate")
        build = Mock(return_value={"status": "adapter-ready", "summary": "Nine gates passed", "artifactRoot": "state/qualification/42"})
        admit = Mock(return_value={"status": "integrated", "summary": "Configured in worktree"})
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock(return_value=(True, "current"))), "parcel_source_admission": SimpleNamespace(admit_candidate=admit)}), patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
            self.assertFalse(self.instance._advance_candidate([self.city], self.cohort))
        self.assertEqual(build.call_count, 1)
        self.assertEqual(admit.call_count, 1)
        self.assertEqual(self.instance.state["cities"]["42"]["qualification"]["status"], "integrated")

    def test_resume_rechecks_saved_stage_before_reusing_integration(self):
        self.accept("candidate")
        self.instance._city_entry(self.city)["qualification"] = {"status": "integrated", "receiptSha256": runner.sha256_file(self.path)}
        check = Mock(return_value=(False, "adapter bytes changed"))
        build, admit = Mock(return_value={"status": "blocked-source", "summary": "fresh source check"}), Mock()
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=check), "parcel_source_admission": SimpleNamespace(admit_candidate=admit)}), patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
        build.assert_called_once()
        admit.assert_not_called()
        self.assertEqual(self.instance._city_entry(self.city)["qualification"]["status"], "blocked-source")
        self.assertEqual(self.instance._city_entry(self.city)["qualificationHistory"][0]["invalidationReason"], "adapter bytes changed")

    def test_changed_review_reopens_previous_source_verdict(self):
        self.accept("candidate")
        self.instance._city_entry(self.city)["qualification"] = {"status": "blocked-source", "receiptSha256": "old"}
        build = Mock(return_value={"status": "blocked-source", "summary": "new source verdict"})
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock()), "parcel_source_admission": SimpleNamespace(admit_candidate=Mock())}), patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
        build.assert_called_once()
        self.assertEqual(len(self.instance._city_entry(self.city)["qualificationHistory"]), 1)

    def test_source_failure_never_calls_admission(self):
        self.accept("candidate")
        build = Mock(return_value={"status": "blocked-source", "summary": "Bounded service reads time out"})
        admit = Mock()
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock(return_value=(True, "current"))), "parcel_source_admission": SimpleNamespace(admit_candidate=admit)}), patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
        admit.assert_not_called()

    def test_shutdown_with_no_worker_result_preserves_unreviewed_city(self):
        def interrupted(_calls):
            self.instance.stop_requested = True
            return []
        with patch.object(self.instance, "run_calls", side_effect=interrupted) as calls:
            success, answer, _systemic = self.instance._complete_review([self.city], [])
        self.assertFalse(success)
        self.assertIsNone(answer)
        self.assertEqual(calls.call_count, 1)
        self.assertNotIn("discoveryDecision", self.instance._city_entry(self.city))

    def test_failed_city_with_unchanged_workspace_does_not_block_next_candidate(self):
        self.accept("candidate")
        build = Mock(return_value={"status": "failed", "summary": "Worker could not establish source evidence"})
        with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock()), "parcel_source_admission": SimpleNamespace(admit_candidate=Mock())}), patch.object(self.instance, "_packet", return_value=self.packet):
            self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
            self.assertNotIn("adapterStageBlocked", self.instance.state)
            # A distinct candidate still starts, while the failed one remains recorded.
            second = {**self.city, "cityCode": 43}
            self.instance._city_entry(second)["discoveryDecision"] = "candidate"
            self.instance._receipt_path("city:43").write_text(json.dumps(self.receipt))
            with patch.object(self.instance, "_reviewed_city_receipt", return_value=self.receipt):
                self.assertTrue(self.instance._advance_candidate([self.city, second], self.cohort))
        self.assertEqual(build.call_count, 2)
        self.assertTrue(self.instance._has_failures())

    def test_failed_city_with_changed_or_unknown_workspace_pauses_mutations(self):
        for after in ({"backend/parcels/source.js": "changed"}, None):
            with self.subTest(after=after):
                self.instance.state.pop("adapterStageBlocked", None)
                self.instance._city_entry(self.city).pop("qualification", None)
                self.accept("candidate")
                build = Mock(side_effect=RuntimeError("worker crashed"))
                with patch.dict(sys.modules, {"parcel_source_stage": SimpleNamespace(run_candidate=build, revalidate_stage=Mock()), "parcel_source_admission": SimpleNamespace(admit_candidate=Mock())}), patch.object(self.instance, "_packet", return_value=self.packet), patch.object(self.instance, "_candidate_workspace_snapshot", side_effect=[{}, after]):
                    self.assertTrue(self.instance._advance_candidate([self.city], self.cohort))
                    self.assertFalse(self.instance._advance_candidate([self.city], self.cohort))
                self.assertEqual(self.instance.state["adapterStageBlocked"]["cityCode"], "42")

    def test_failed_reclassification_does_not_retry_old_held_forever(self):
        self.instance._city_entry(self.city).update(status="reviewed-held", attempts=1)
        self.path.write_text(json.dumps({"decision": "held"}))
        with patch.object(self.instance, "_packet", return_value=self.packet):
            self.instance._skip_unreviewed([self.city], [], "review attempts exhausted")
        self.assertEqual(self.instance._city_entry(self.city)["status"], "failed-skipped")

    def test_old_held_receipt_is_reclassified_without_repeating_valid_research(self):
        self.path.write_text(json.dumps({"taskId": "city:42", "decision": "held", "evidenceFiles": ["cohort/city.json", "cohort/review.json"], "checkedAt": runner.utc_now()}))
        self.instance._city_entry(self.city).update(status="reviewed-held", attempts=1)
        with patch.object(self.instance, "_packet", return_value=self.packet):
            research, review = self.instance._select_batch([self.city], self.cohort)
        self.assertEqual(research, [])
        self.assertEqual([r["cityCode"] for r in review], [42])
        self.instance._review_call(review, [])
        self.assertEqual(len(list((self.path.parent / "history").glob("city_42-*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
