import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "lib" / "parcel_source_admission.py"
SPEC = importlib.util.spec_from_file_location("parcel_source_admission", MODULE)
admission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admission)


class AdmissionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.artifacts = self.state / "qualification" / "cities" / "1" / "attempt-01"
        (self.artifacts / "evidence").mkdir(parents=True)
        candidate = {
            "city": {"code": "1", "name": "Testville", "point": [2.0, 1.0]},
            "descriptor": {"id": "test-source", "name": "Test Parcel Layer", "adapter": "arcgis", "endpoint": "https://maps.example.test/arcgis/0",
                           "idPrefix": "TEST-", "countryCode": "ZZ"},
            "sampleIds": ["TEST-1"], "absentId": "TEST-999", "metricEpsg": 32631,
        }
        candidate_bytes = (json.dumps(candidate) + "\n").encode()
        (self.artifacts / "candidate.json").write_bytes(candidate_bytes)
        checks = {gate: {"passed": True} for gate in admission.GATES}
        qualification = {"status": "technical-qualified", "cityCode": "1", "cityName": "Testville",
                         "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(), "checks": checks}
        for name in admission.REQUIRED:
            path = self.artifacts / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if name == "candidate.json":
                continue
            path.write_text(json.dumps(qualification) + "\n" if name == "evidence/qualification.json" else "{}\n")
        self.city = {"cityCode": "1", "name": "Testville", "iso2": "ZZ", "point": [1.0, 2.0], "rank": 1}
        self.receipt = {"schemaVersion": 2, "taskId": "city:1", "decision": "candidate",
                        "reason": "systematic public parcel source", "searchCoverage": {},
                        "source": {"sourceId": "test-source", "endpoint": "https://maps.example.test/arcgis/0"},
                        "coverage": {}, "evidenceFiles": []}
        self.runner = SimpleNamespace(root=self.root, state_dir=self.state, stop_requested=False)

    def tearDown(self):
        self.tmp.cleanup()

    def _set_valid_country(self):
        candidate = json.loads((self.artifacts / "candidate.json").read_text())
        candidate["city"]["countryCode"] = "US"
        candidate["city"]["currency"] = {"locale": "en-US", "code": "USD"}
        candidate["descriptor"]["countryCode"] = "US"
        candidate_bytes = (json.dumps(candidate) + "\n").encode()
        (self.artifacts / "candidate.json").write_bytes(candidate_bytes)
        qualification = json.loads((self.artifacts / "evidence/qualification.json").read_text())
        qualification["candidateSha256"] = hashlib.sha256(candidate_bytes).hexdigest()
        (self.artifacts / "evidence/qualification.json").write_text(json.dumps(qualification) + "\n")
        self.city["iso2"] = "US"

    def _run_admission_flow(self, *, omit_city_from_reports=False):
        self._set_valid_country()
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            if "vitest.mjs" in " ".join(command) and "list" in command:
                return SimpleNamespace(returncode=0, stdout=json.dumps([
                    {"file": str((self.root / relative).resolve())} for relative in admission.RELEASE_TESTS
                ]), stderr="")
            if "admit-qualified-cities.mjs" not in " ".join(command):
                self.fail(f"unexpected subprocess: {command}")
            if "--apply" not in command:
                return SimpleNamespace(returncode=0,
                                       stdout="[time] plan: 1 cities to admit, 0 to switch source, 0 refused\n",
                                       stderr="")
            release = command[command.index("--release") + 1]
            (self.root / "backend/parcels").mkdir(parents=True, exist_ok=True)
            (self.root / "backend/parcels/source-catalog.json").write_text(json.dumps({"sources": [
                {"id": "test-source", "cityIds": ["testville"]}]}))
            (self.root / "frontend/js").mkdir(parents=True, exist_ok=True)
            (self.root / "frontend/js/city-config.js").write_text("// configured")
            (self.root / "world-parcels").mkdir(parents=True, exist_ok=True)
            (self.root / "world-parcels/registry.json").write_text(json.dumps({"cities": [], "sources": []}))
            manifest = {"cities": [{"cityCode": "1", "sourceId": "test-source", "appCityId": "testville",
                                    "candidate": {"qualificationRecordedSha256": json.loads(
                                        (self.artifacts / "evidence/qualification.json").read_text())["candidateSha256"]}}]}
            manifest_path = self.root / f"world-parcels/research/qualification-admission-{release}.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps(manifest))
            evidence_path = self.root / f"world-parcels/research/qualification-{release}/1"
            evidence_path.mkdir(parents=True, exist_ok=True)
            for name in ("candidate.json", "qualification.json", "metric-report.json", "independent-metric-audit.json",
                         "alignment-report.json", "independent-alignment-report.json", "alignment-evidence.json",
                         "alignment-metadata.json", "alignment-native.json"):
                (evidence_path / name).write_text("{}\n")
            return SimpleNamespace(returncode=0, stdout="applied\n", stderr="")

        def fake_checked(command, _root, label, timeout=180):
            calls.append(command)
            if label == "qualification-outcomes export":
                return "exported"
            if label == "world coverage report build":
                cities = [] if omit_city_from_reports else [{"id": "testville", "sourceId": "test-source"}]
                path = self.root / "frontend/data/world-coverage.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"liveCities": cities}))
                return "built"
            if label == "parcel coverage report build":
                cities = [] if omit_city_from_reports else [{"wupCityCode": 1, "appCityIds": ["testville"],
                                                             "sourceIds": ["test-source"]}]
                path = self.root / "frontend/data/parcel-coverage-report.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"cities": cities}))
                return "built"
            if label == "headless admission release checks":
                return "556 tests passed"
            self.fail(f"unexpected checked command: {label} {command}")

        return calls, fake_run, fake_checked

    @patch.object(admission.parcel_discovery_outcomes, "validate_receipt", return_value=[])
    @patch.object(admission.subprocess, "run")
    def test_missing_country_currency_stops_before_admission_apply(self, run, _receipt_check):
        def fake_run(command, **_kwargs):
            if command[:3] == ["node", "--input-type=module", "-e"]:
                return SimpleNamespace(returncode=0, stdout="[]", stderr="")
            if command[0] == "python3":
                return SimpleNamespace(returncode=0, stdout="{}", stderr="")
            if "admit-qualified-cities.mjs" in " ".join(command):
                return SimpleNamespace(returncode=0,
                                       stdout="[time] plan: 0 cities to admit, 0 to switch source, 1 refused\n"
                                              "[time] refused 1 Testville: no verified currency configuration for ZZ\n",
                                       stderr="")
            self.fail(f"unexpected subprocess: {command}")

        run.side_effect = fake_run
        result = admission.admit_candidate(self.runner, self.city, self.receipt,
                                           {"status": "adapter-ready", "artifactRoot": str(self.artifacts)})
        self.assertEqual(result["status"], "integration-blocked")
        self.assertIn("preflight", result["summary"])
        self.assertFalse(any("--apply" in call.args[0] for call in run.call_args_list))
        self.assertFalse((self.root / "backend").exists())
        self.assertFalse((self.root / "frontend").exists())

    @patch.object(admission.parcel_discovery_outcomes, "validate_receipt", return_value=[])
    @patch.object(admission.subprocess, "run")
    def test_source_endpoint_mismatch_blocks_before_subprocess(self, run, _receipt_check):
        self.receipt["source"]["endpoint"] = "https://different.example.test/arcgis/0"
        result = admission.admit_candidate(self.runner, self.city, self.receipt,
                                           {"status": "adapter-ready", "artifactRoot": str(self.artifacts)})
        self.assertEqual(result["status"], "integration-blocked")
        self.assertIn("endpoint", result["summary"])
        run.assert_not_called()

    def test_successful_apply_and_report_readback_returns_integrated(self):
        calls, fake_run, fake_checked = self._run_admission_flow()
        with patch.object(admission.parcel_discovery_outcomes, "validate_receipt", return_value=[]), \
                patch.object(admission, "_existing_bindings", side_effect=[[], [
                    {"id": "testville", "wupCityCode": 1, "sourceId": "test-source"}]]), \
                patch.object(admission, "_verify_published_evidence", return_value=None), \
                patch.object(admission, "_run", side_effect=fake_run), \
                patch.object(admission, "_run_checked", side_effect=fake_checked), \
                patch.object(admission, "export_settings") as settings_export:
            result = admission.admit_candidate(self.runner, self.city, self.receipt,
                                               {"status": "adapter-ready", "artifactRoot": str(self.artifacts)})
        self.assertEqual(result["status"], "integrated")
        self.assertIn("headless release checks passed", result["summary"])
        self.assertTrue(result["manifestFile"].startswith("world-parcels/research/qualification-admission-"))
        self.assertIn(result["manifestFile"], result["changedFiles"])
        self.assertIn("frontend/data/world-coverage.json", result["changedFiles"])
        self.assertIn("frontend/data/parcel-coverage-report.json", result["changedFiles"])
        self.assertTrue(any("qualification-" in path and path.endswith("/alignment-native.json")
                            for path in result["changedFiles"]))
        self.assertTrue(any("vitest.mjs" in " ".join(command) and "backend/test/qualified-city-release.test.js" in command
                            for command in calls))
        release_commands = [command for command in calls if "vitest.mjs" in " ".join(command)]
        self.assertEqual(len(release_commands), 2)
        for command in release_commands:
            self.assertIn("**/tmp/**", command)
            self.assertIn("**/node_modules/**", command)
            self.assertEqual([path for path in admission.RELEASE_TESTS if path in command],
                             list(admission.RELEASE_TESTS))
        self.assertEqual(sum("--apply" in command for command in calls), 1)

    def test_release_scope_rejects_archived_or_missing_test_files(self):
        expected = [{"file": str((self.root / relative).resolve())} for relative in admission.RELEASE_TESTS]
        archived = self.root / "tmp/qualification-workspaces/history/files/backend/test/qualified-city-release.test.js"
        for rows in (expected + [{"file": str(archived)}], expected[:-1]):
            with self.subTest(count=len(rows)), patch.object(
                    admission, "_run", return_value=SimpleNamespace(
                        returncode=0, stdout=json.dumps(rows), stderr="")):
                with self.assertRaisesRegex(RuntimeError, "exact seven files"):
                    admission._verify_release_test_scope(self.root)

    def test_applied_admission_with_city_omitted_from_reports_is_failed(self):
        calls, fake_run, fake_checked = self._run_admission_flow(omit_city_from_reports=True)
        with patch.object(admission.parcel_discovery_outcomes, "validate_receipt", return_value=[]), \
                patch.object(admission, "_existing_bindings", side_effect=[[], [
                    {"id": "testville", "wupCityCode": 1, "sourceId": "test-source"}]]), \
                patch.object(admission, "_verify_published_evidence", return_value=None), \
                patch.object(admission, "_run", side_effect=fake_run), \
                patch.object(admission, "_run_checked", side_effect=fake_checked), \
                patch.object(admission, "export_settings") as settings_export:
            result = admission.admit_candidate(self.runner, self.city, self.receipt,
                                               {"status": "adapter-ready", "artifactRoot": str(self.artifacts)})
        self.assertEqual(result["status"], "failed")
        self.assertIn("coverage reports do not contain", result["summary"])
        self.assertTrue(result["manifestFile"])
        self.assertTrue(any(path.endswith("/candidate.json") for path in result["changedFiles"]))
        self.assertTrue(any("--apply" in command for command in calls))

    def test_existing_binding_with_corrupt_qualification_cache_is_not_integrated(self):
        catalog = self.root / "backend/parcels/source-catalog.json"
        catalog.parent.mkdir(parents=True)
        catalog.write_text(json.dumps({"sources": [{"id": "test-source", "cityIds": ["testville"]}]}))
        (self.artifacts / "evidence/full-safe.geojson").write_text("corrupted cache")
        with patch.object(admission.parcel_discovery_outcomes, "validate_receipt", return_value=[]), \
                patch.object(admission, "_existing_bindings", return_value=[{
                    "id": "testville", "wupCityCode": 1, "sourceId": "test-source"}]), \
                patch.object(admission, "_run", return_value=SimpleNamespace(
                    returncode=1,
                    stdout=json.dumps({"ok": False, "reason": "cache bytes differ from the qualification record"}),
                    stderr="")) as run:
            result = admission.admit_candidate(self.runner, self.city, self.receipt,
                                               {"status": "adapter-ready", "artifactRoot": str(self.artifacts)})
        self.assertEqual(result["status"], "integration-blocked")
        self.assertIn("cache bytes differ", result["summary"])
        run.assert_called_once()

    def test_existing_integration_prefers_matching_source_binding(self):
        (self.root / "backend/parcels").mkdir(parents=True)
        (self.root / "backend/parcels/source-catalog.json").write_text(
            json.dumps({"sources": [{"id": "test-source", "cityIds": ["testville"]}]})
        )
        (self.root / "world-parcels").mkdir(exist_ok=True)
        (self.root / "world-parcels/registry.json").write_text(json.dumps({
            "cities": [{"wupCityCode": 1, "appCityId": "testville", "sourceIds": ["test-source"]}],
            "sources": [{"sourceId": "test-source", "liveIntegration": {"status": "enabled", "cityIds": ["testville"]}}],
        }))
        (self.root / "frontend/data").mkdir(parents=True)
        (self.root / "frontend/data/parcel-coverage-report.json").write_text(json.dumps({
            "cities": [{"wupCityCode": 1, "appCityIds": ["testville"], "sourceIds": ["test-source"]}]
        }))
        (self.root / "frontend/data/world-coverage.json").write_text(json.dumps({
            "liveCities": [{"id": "testville", "sourceId": "test-source"}]
        }))
        with patch.object(admission, "_verify_published_evidence", return_value=None) as verify:
            result = admission._existing_integration(
                self.root, "1", "Testville", "test-source", self.artifacts, {}, [
                    {"id": "legacy_testville", "wupCityCode": 1, "sourceId": "other-source"},
                    {"id": "testville", "wupCityCode": 1, "sourceId": "test-source"},
                ])
        self.assertEqual(result["status"], "integrated")
        verify.assert_called_once_with(self.root, self.artifacts, "test-source")


if __name__ == "__main__":
    unittest.main()
