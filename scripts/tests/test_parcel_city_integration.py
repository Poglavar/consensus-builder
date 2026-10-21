"""A city task owns repair through verified integration and preserves real blockers."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import parcel_city_integration as integration
import parcel_source_stage as stage


class CityIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifact = self.root / "tmp/state/qualification/cities/42/attempt-01"
        (self.artifact / "evidence").mkdir(parents=True)
        (self.artifact / "candidate.json").write_text('{}')
        self.city = {"cityCode": "42", "name": "Test City"}
        self.workspace = {"city": self.city, "receipt": {"source": {"sourceId": "official"}}, "packet": {}}
        self.child = SimpleNamespace(root=self.root, state_dir=self.root / "tmp/state",
                                     args=SimpleNamespace(shared_root=None), stop_requested=False, log=Mock())

    def result(self, status="adapter-ready"):
        return {"status": status, "summary": "source checked", "artifactRoot": str(self.artifact)}

    def test_failed_integration_is_given_back_to_worker_then_reverified(self):
        observed = []
        def implement(*args):
            observed.append(self.child.integration_feedback)
            return self.result()
        with patch.object(stage, "_input_hashes", return_value={}), \
                patch.object(stage, "_artifact_hashes", return_value={}), \
                patch.object(stage, "run_candidate", side_effect=implement) as worker, \
                patch.object(integration, "check_integration", side_effect=[
                    {"passed": False, "error": "browser factory missing: official"},
                    {"passed": True, "app": {"selected": True}}]) as check:
            result = integration.run_city_task(self.child, self.workspace)
        self.assertEqual(worker.call_count, 2)
        self.assertEqual(check.call_count, 2)
        self.assertEqual(observed, [None, "browser factory missing: official"])
        self.assertEqual(result["status"], "adapter-ready")
        self.assertTrue(result["integrationReview"]["app"]["selected"])
        self.assertEqual(result["implementationTurns"], 2)

    def test_source_limitation_is_retained_without_wasting_repair_turns(self):
        with patch.object(stage, "_input_hashes", return_value={}), \
                patch.object(stage, "run_candidate", return_value=self.result("blocked-source")) as worker, \
                patch.object(integration, "check_integration") as check:
            result = integration.run_city_task(self.child, self.workspace)
        self.assertEqual(result["status"], "blocked-source")
        worker.assert_called_once()
        check.assert_not_called()

    def test_repair_budget_stops_with_an_integration_blocker(self):
        with patch.object(stage, "_input_hashes", return_value={}), \
                patch.object(stage, "_artifact_hashes", return_value={}), \
                patch.object(stage, "run_candidate", side_effect=lambda *args: self.result()) as worker, \
                patch.object(integration, "check_integration", return_value={"passed": False, "error": "app cannot select parcels"}):
            result = integration.run_city_task(self.child, self.workspace)
        self.assertEqual(worker.call_count, 3)
        self.assertEqual(result["status"], "integration-blocked")
        self.assertEqual(result["summary"], "app cannot select parcels")

    def test_worker_cannot_redefine_frozen_research_inputs_on_a_repair(self):
        packet = self.root / "city.json"
        packet.write_text('original')
        def implement(*args):
            if packet.read_text() == 'original' and self.child.integration_feedback is None:
                packet.write_text('changed')
                return {**self.result("failed"), "summary": "inputs changed during qualification"}
            self.assertEqual(packet.read_text(), 'original')
            return self.result("blocked-source")
        with patch.object(stage, "_input_hashes", return_value={"packetPath": "city.json"}), \
                patch.object(stage, "run_candidate", side_effect=implement):
            integration.run_city_task(self.child, self.workspace)
        self.assertEqual(packet.read_text(), 'original')

    def test_private_app_check_restores_generated_configuration_but_keeps_evidence(self):
        config = self.root / "frontend/js/city-config.js"
        config.parent.mkdir(parents=True)
        config.write_text('existing cities')
        boot = self.root / "frontend/data/boot-coverage.js"
        boot.parent.mkdir(parents=True)
        boot.write_text('existing boot coverage')
        setting = self.root / "world-parcels/cities/42/settings.json"
        def admit(*args):
            config.write_text('integrated city')
            boot.write_text('integrated boot coverage')
            setting.parent.mkdir(parents=True)
            setting.write_text('{}')
            return {"status": "integrated"}
        with patch.object(integration, "verify_source_artifacts"), \
                patch.object(integration, "admit_candidate", side_effect=admit), \
                patch.object(integration, "rebuild_browser_adapters"), \
                patch.object(integration, "verify_in_app", return_value={"passed": True, "selected": True}) as app:
            result = integration.check_integration(self.root, self.child.state_dir, self.city, {}, self.artifact)
        app.assert_called_once()
        self.assertTrue(result["passed"])
        self.assertEqual(config.read_text(), 'existing cities')
        self.assertEqual(boot.read_text(), 'existing boot coverage')
        self.assertFalse(setting.exists())
        self.assertTrue((self.artifact / "evidence/integration-review.json").is_file())

    def test_app_failure_does_not_leave_a_partially_integrated_city(self):
        config = self.root / "frontend/js/city-config.js"
        config.parent.mkdir(parents=True)
        config.write_text('existing cities')
        def admit(*args):
            config.write_text('partial integration')
            return {"status": "integrated"}
        with patch.object(integration, "verify_source_artifacts"), \
                patch.object(integration, "admit_candidate", side_effect=admit), \
                patch.object(integration, "rebuild_browser_adapters"), \
                patch.object(integration, "verify_in_app", side_effect=RuntimeError("no selectable parcels")):
            result = integration.check_integration(self.root, self.child.state_dir, self.city, {}, self.artifact)
        self.assertFalse(result["passed"])
        self.assertIn("no selectable parcels", result["error"])
        self.assertEqual(config.read_text(), 'existing cities')

    def test_invalid_source_artifacts_stop_before_admission_or_app(self):
        with patch.object(integration, "verify_source_artifacts", side_effect=ValueError("candidate SHA-256 mismatch")), \
                patch.object(integration, "admit_candidate") as admission, \
                patch.object(integration, "verify_in_app") as app:
            result = integration.check_integration(self.root, self.child.state_dir, self.city, {}, self.artifact)
        self.assertFalse(result["passed"])
        self.assertIn("candidate SHA-256 mismatch", result["error"])
        admission.assert_not_called()
        app.assert_not_called()


if __name__ == "__main__":
    unittest.main()
