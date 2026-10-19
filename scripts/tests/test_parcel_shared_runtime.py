from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "lib/parcel_shared_runtime.py"
spec = importlib.util.spec_from_file_location("parcel_shared_runtime_tested", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(runtime)


class SharedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.shared, self.source, self.target = base / "shared", base / "source", base / "target"
        for root in (self.shared, self.source, self.target):
            root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, root: Path, relative: str, value: str):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        return path

    def publish(self, expected=None):
        return runtime.publish_runtime(self.shared, self.source, expected_generation=expected)

    def test_cross_job_new_code_adapter_and_evidence_propagate(self):
        self.write(self.source, "scripts/pipeline.py", "v1\n")
        self.write(self.source, "backend/parcels/new-adapter.js", "adapter\n")
        self.write(self.source, "world-parcels/registry.json", '{"ok":true}\n')
        self.write(self.source, "world-parcels/research/city/evidence.json", '{"active":true}\n')
        manifest = self.publish()
        result = runtime.sync_runtime(self.shared, self.target)
        self.assertEqual(result["generation"], manifest["generation"])
        self.assertEqual((self.target / "scripts/pipeline.py").read_text(), "v1\n")
        self.assertEqual((self.target / "backend/parcels/new-adapter.js").read_text(), "adapter\n")
        self.assertTrue((self.target / "world-parcels/registry.json").is_file())
        self.assertFalse((self.target / "world-parcels/research/city/evidence.json").exists())
        repeat = runtime.sync_runtime(self.shared, self.target)
        self.assertEqual(repeat["written"], [])
        self.assertTrue(repeat["fastPath"])

    def test_local_change_fails_closed(self):
        self.write(self.source, "scripts/pipeline.py", "released\n")
        first = self.publish()
        runtime.sync_runtime(self.shared, self.target)
        self.write(self.target, "scripts/pipeline.py", "local edit\n")
        self.write(self.source, "scripts/pipeline.py", "next\n")
        self.publish(first["generation"])
        with self.assertRaisesRegex(runtime.RuntimeConflict, "locally changed"):
            runtime.sync_runtime(self.shared, self.target)
        self.assertEqual((self.target / "scripts/pipeline.py").read_text(), "local edit\n")

    def test_late_publisher_fails_generation_compare_and_swap(self):
        self.write(self.source, "scripts/a.py", "one\n")
        first = self.publish()
        self.write(self.source, "scripts/a.py", "two\n")
        second = self.publish(first["generation"])
        self.write(self.source, "scripts/a.py", "late\n")
        with self.assertRaises(runtime.StaleGeneration):
            self.publish(first["generation"])
        self.assertEqual(runtime.current_runtime(self.shared)["generation"], second["generation"])

    def test_removes_only_unchanged_managed_files(self):
        self.write(self.source, "frontend/managed.js", "managed\n")
        self.write(self.source, "frontend/keep.js", "keep\n")
        first = self.publish()
        runtime.sync_runtime(self.shared, self.target)
        (self.source / "frontend/managed.js").unlink()
        second = self.publish(first["generation"])
        result = runtime.sync_runtime(self.shared, self.target)
        self.assertEqual(result["generation"], second["generation"])
        self.assertFalse((self.target / "frontend/managed.js").exists())
        self.assertTrue((self.target / "frontend/keep.js").exists())
        self.write(self.target, "frontend/keep.js", "local\n")
        (self.source / "frontend/keep.js").unlink()
        self.publish(second["generation"])
        with self.assertRaisesRegex(runtime.RuntimeConflict, "blocks removal"):
            runtime.sync_runtime(self.shared, self.target)
        self.assertEqual((self.target / "frontend/keep.js").read_text(), "local\n")

    def test_bootstrap_conflict_requires_adopt_and_archives_prior_file(self):
        self.write(self.source, "scripts/pipeline.py", "canonical\n")
        self.publish()
        self.write(self.target, "scripts/pipeline.py", "prior\n")
        with self.assertRaisesRegex(runtime.RuntimeConflict, "bootstrap would overwrite"):
            runtime.sync_runtime(self.shared, self.target)
        result = runtime.sync_runtime(self.shared, self.target, adopt=True)
        backup = self.target / result["backupPath"] / "scripts/pipeline.py"
        self.assertEqual(backup.read_text(), "prior\n")
        self.assertEqual((self.target / "scripts/pipeline.py").read_text(), "canonical\n")
        with self.assertRaisesRegex(runtime.RuntimeConflict, "initial bootstrap"):
            runtime.sync_runtime(self.shared, self.target, adopt=True)

    def test_secrets_symlinks_and_foreign_files_remain_untouched(self):
        self.write(self.source, "scripts/run.py", "safe\n")
        self.write(self.source, "frontend/.env", "SECRET=source\n")
        external = self.write(self.source, "outside.txt", "outside\n")
        (self.source / "frontend/linked").symlink_to(external)
        self.write(self.source, "backend/test/service-account.json", "private\n")
        self.write(self.target, "frontend/.env", "SECRET=target\n")
        self.write(self.target, "frontend/foreign.txt", "foreign\n")
        manifest = self.publish()
        self.assertNotIn("frontend/.env", manifest["files"])
        self.assertNotIn("frontend/linked", manifest["files"])
        self.assertNotIn("backend/test/service-account.json", manifest["files"])
        runtime.sync_runtime(self.shared, self.target)
        self.assertEqual((self.target / "frontend/.env").read_text(), "SECRET=target\n")
        self.assertEqual((self.target / "frontend/foreign.txt").read_text(), "foreign\n")

    def test_target_symlink_is_never_followed(self):
        self.write(self.source, "frontend/managed.js", "released\n")
        self.publish()
        outside = self.write(self.target, "outside.js", "outside\n")
        (self.target / "frontend").mkdir()
        (self.target / "frontend/managed.js").symlink_to(outside)
        with self.assertRaisesRegex(runtime.RuntimeConflict, "not a regular file"):
            runtime.sync_runtime(self.shared, self.target, adopt=True)
        self.assertEqual(outside.read_text(), "outside\n")

    def test_runtime_lock_is_reentrant(self):
        with runtime.runtime_lock(self.shared):
            with runtime.runtime_lock(self.shared):
                self.write(self.source, "scripts/a.py", "a\n")
                self.publish()

    def test_marker_disables_fast_path_and_rollback_restores_snapshot(self):
        self.write(self.source, "scripts/a.py", "released\n")
        manifest = self.publish()
        runtime.sync_runtime(self.shared, self.target)
        before = runtime.runtime_paths(self.target)
        self.write(self.target, "tmp/parcel-shared-runtime/write-in-progress.json", "{}\n")
        self.write(self.target, "scripts/a.py", "transaction edit\n")
        self.write(self.target, "backend/parcels/new.js", "new\n")
        with self.assertRaisesRegex(runtime.RuntimeConflict, "locally changed"):
            runtime.sync_runtime(self.shared, self.target)
        result = runtime.restore_runtime(self.shared, self.target, manifest, before)
        self.assertIn("scripts/a.py", result["restored"])
        self.assertIn("backend/parcels/new.js", result["removed"])
        self.assertEqual((self.target / "scripts/a.py").read_text(), "released\n")


if __name__ == "__main__":
    unittest.main()
