from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
MODULE = REPO / "scripts/lib/parcel_qualification_workspaces.py"
spec = importlib.util.spec_from_file_location("parcel_qualification_workspaces_tested", MODULE)
workspaces = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(workspaces)


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class ParcelQualificationWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name) / "repo"
        self.parent.mkdir()
        run_git(self.parent, "init", "-b", "main")
        run_git(self.parent, "config", "user.email", "workspace-tests@example.test")
        run_git(self.parent, "config", "user.name", "Workspace Test")
        (self.parent / ".gitignore").write_text(".env\n**/.env\nbackend/node_modules/\ntmp/\n")
        (self.parent / "scripts/lib").mkdir(parents=True)
        for rel in ("scripts/run-parcel-adapter-build.py", "scripts/lib/parcel_source_stage.py",
                    "scripts/lib/parcel_discovery_outcomes.py"):
            dst = self.parent / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / rel, dst)
        (self.parent / "backend/parcels").mkdir(parents=True)
        (self.parent / "backend/parcels/adapter.js").write_text("export const baseline = true;\n")
        (self.parent / "backend/parcels/source-catalog.json").write_text('{"sources":[]}\n')
        (self.parent / "backend/test").mkdir(parents=True)
        (self.parent / "backend/test/base.test.cjs").write_text("// tracked test\n")
        (self.parent / "backend/node_modules").mkdir(parents=True)
        (self.parent / "backend/node_modules/package.json").write_text('{"name":"parent-deps"}\n')
        self.cohort = self.parent / "world-parcels/cohort"
        (self.cohort / "samples").mkdir(parents=True)
        self.city_path = self.cohort / "city-1868.json"
        self.review_path = self.cohort / "review-1868.json"
        self.city_path.write_text(json.dumps({"cityCode": "1868", "sampleFiles": ["samples/city.geojson"]}) + "\n")
        self.review_path.write_text(json.dumps({"sampleFiles": ["samples/review.geojson"]}) + "\n")
        (self.cohort / "samples/city.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        (self.cohort / "samples/review.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        self.queue_sample = self.parent / "world-parcels/queue-sample.geojson"
        self.queue_sample.write_text('{"type":"FeatureCollection","features":[]}\n')
        self.receipt_evidence = self.parent / "world-parcels/receipt-evidence.json"
        self.receipt_evidence.write_text('{"source":"reviewed"}\n')
        self.probe_evidence = self.parent / "world-parcels/probe.json"
        probe_bytes = b'{"url":"https://source.example.test","status":200}\n'
        self.probe_evidence.write_bytes(probe_bytes)
        self.city = {"cityCode": "1868", "name": "Test City", "rank": 1, "iso2": "TZ",
                     "point": [-2.0, 32.0], "sampleFiles": [str(self.queue_sample)]}
        self.receipt = {"decision": "candidate", "source": {"sourceId": "test-source",
                          "endpoint": "https://source.example.test/api"},
                        "evidenceFiles": ["world-parcels/receipt-evidence.json"],
                        "coverage": {"scope": "substantial-city", "probes": [{
                            "evidenceFile": "world-parcels/probe.json",
                            "evidenceSha256": hashlib.sha256(probe_bytes).hexdigest()}]}}
        self.packet = {"valid": True, "cityPath": str(self.city_path), "reviewPath": str(self.review_path),
                       "city": {"cityCode": "1868", "sampleFiles": ["samples/city.geojson"]},
                       "review": {"sampleFiles": ["samples/review.geojson"]}, "polygonCount": 0}
        self.state_dir = self.parent / "tmp/qualification-state"
        self.state_dir.mkdir(parents=True)
        run_git(self.parent, "add", ".")
        run_git(self.parent, "commit", "-m", "fixture baseline")

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, slot=1):
        return workspaces.prepare_workspace(self.parent, self.state_dir, slot,
                                            self.city, self.receipt, self.packet)

    def test_two_slots_are_distinct_and_inputs_are_copied_and_remapped(self):
        city_mtime = self.city_path.stat().st_mtime_ns
        receipt_before = json.loads(json.dumps(self.receipt))
        first = self.prepare(1)
        second = self.prepare(2)
        self.assertNotEqual(first["root"], second["root"])
        self.assertNotEqual(run_git(first["root"], "branch", "--show-current"),
                            run_git(second["root"], "branch", "--show-current"))
        self.assertEqual(first["receipt"], receipt_before)
        self.assertIsNot(first["receipt"], self.receipt)
        self.assertEqual(Path(first["packet"]["cityPath"]), first["root"] / self.city_path.relative_to(self.parent))
        self.assertEqual(first["city"]["sampleFiles"][0], str(first["root"] / self.queue_sample.relative_to(self.parent)))
        copied = first["root"] / self.city_path.relative_to(self.parent)
        self.assertEqual(copied.read_bytes(), self.city_path.read_bytes())
        self.assertEqual(copied.stat().st_mtime_ns, city_mtime)
        self.assertEqual((first["root"] / self.probe_evidence.relative_to(self.parent)).read_bytes(),
                         self.probe_evidence.read_bytes())
        self.assertNotEqual(first["stateDir"], second["stateDir"])
        self.assertTrue(first["stateDir"].is_dir())
        self.assertIn("backend/parcels/adapter.js", first["baseBackendAdapters"])
        self.assertTrue(first["metadataPath"].is_file())
        self.assertEqual(first["baseSnapshot"], workspaces._snapshot(first["root"]))

    def test_parent_dirty_overlay_copies_code_but_not_other_untracked_or_env(self):
        (self.parent / "backend/parcels/adapter.js").write_text("export const parentDirty = true;\n")
        (self.parent / "backend/parcels/new-adapter.js").write_text("export const newAdapter = true;\n")
        (self.parent / "backend/test/new.test.cjs").write_text("// parent untracked focused test\n")
        (self.parent / "notes.md").write_text("must not copy\n")
        (self.parent / ".env").write_text("SECRET=do-not-copy\n")
        workspace = self.prepare()
        child = workspace["root"]
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(),
                         "export const parentDirty = true;\n")
        self.assertTrue((child / "backend/parcels/new-adapter.js").is_file())
        self.assertTrue((child / "backend/test/new.test.cjs").is_file())
        self.assertFalse((child / "notes.md").exists())
        self.assertFalse((child / ".env").exists())
        link = child / "backend/node_modules"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), (self.parent / "backend/node_modules").resolve())

    def test_reuse_archives_owned_changes_and_preserves_ignored_state(self):
        workspace = self.prepare()
        child = workspace["root"]
        (child / "backend/parcels/adapter.js").write_text("export const worker = true;\n")
        (child / "backend/test/base.test.cjs").unlink()
        (child / "backend/test/generated.test.cjs").write_text("// worker output\n")
        (child / "tmp/parcel-qualification-jobs" / workspace["runId"] / "worker.log").write_text("private log\n")
        (child / ".env").write_text("PRIVATE=keep\n")
        persisted = json.loads(json.dumps(workspace, default=str))
        for key in ("root", "stateDir", "metadataPath"):
            persisted[key] = Path(persisted[key])
        workspaces.finish_workspace(persisted)

        next_workspace = self.prepare()
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(), "export const baseline = true;\n")
        self.assertTrue((child / "backend/test/base.test.cjs").is_file())
        self.assertFalse((child / "backend/test/generated.test.cjs").exists())
        self.assertEqual((child / "tmp/parcel-qualification-jobs" / workspace["runId"] / "worker.log").read_text(),
                         "private log\n")
        self.assertEqual((child / ".env").read_text(), "PRIVATE=keep\n")
        history = self.state_dir / "qualification-workspaces/history" / workspace["runId"]
        manifest = json.loads((history / "manifest.json").read_text())
        rows = {row["path"]: row for row in manifest["entries"]}
        self.assertEqual(rows["backend/parcels/adapter.js"]["kind"], "file")
        self.assertEqual(rows["backend/test/base.test.cjs"]["kind"], "deleted")
        self.assertEqual(rows["backend/test/generated.test.cjs"]["kind"], "file")
        self.assertTrue(next_workspace["stateDir"].is_dir())

    def test_unexpected_post_finish_drift_refuses_reuse_without_overwriting_it(self):
        workspace = self.prepare()
        workspaces.finish_workspace(workspace)
        path = workspace["root"] / "backend/parcels/adapter.js"
        path.write_text("foreign change\n")
        with self.assertRaisesRegex(RuntimeError, "changed after finish"):
            self.prepare()
        self.assertEqual(path.read_text(), "foreign change\n")

    def test_finish_is_idempotent_after_json_roundtrip_but_rejects_later_drift(self):
        workspace = self.prepare()
        persisted = json.loads(json.dumps(workspace, default=str))
        for key in ("root", "stateDir", "metadataPath"):
            persisted[key] = Path(persisted[key])
        workspaces.finish_workspace(persisted)
        workspaces.finish_workspace(persisted)
        path = workspace["root"] / "backend/parcels/adapter.js"
        path.write_text("drift after finish\n")
        with self.assertRaisesRegex(RuntimeError, "changed after finish"):
            workspaces.finish_workspace(persisted)

    def test_private_input_copy_preserves_parent_overlay_and_seed_mtime(self):
        (self.parent / "backend/parcels/adapter.js").write_text("parent overlay\n")
        workspace = self.prepare()
        child = workspace["root"]
        for rel in ("world-parcels/receipt-evidence.json", "world-parcels/probe.json",
                    "world-parcels/cohort/city-1868.json", "world-parcels/cohort/review-1868.json",
                    "world-parcels/cohort/samples/city.geojson", "world-parcels/cohort/samples/review.geojson",
                    "world-parcels/queue-sample.geojson"):
            self.assertEqual((child / rel).read_bytes(), (self.parent / rel).read_bytes())
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(), "parent overlay\n")


if __name__ == "__main__":
    unittest.main()
