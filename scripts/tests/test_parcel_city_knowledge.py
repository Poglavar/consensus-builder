import json
import tempfile
import unittest
from pathlib import Path

from scripts.lib.parcel_city_knowledge import sync_failed_urls


class ParcelCityKnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.shared = self.root / "shared"
        self.target = self.root / "target"
        (self.shared / "world-parcels/cities/12").mkdir(parents=True)
        (self.target / "world-parcels/cities/12").mkdir(parents=True)
        (self.target / "world-parcels/cities/12/settings.json").write_text('{"keep":true}')

    def tearDown(self):
        self.tmp.cleanup()

    def record(self, code="12", value=None):
        path = self.shared / f"world-parcels/cities/{code}/failed-urls.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value if value is not None else []))
        return path

    def test_copy_refresh_remove_and_preserve_settings(self):
        self.record(value=[{"url": "https://example.invalid/a"}])
        sync_failed_urls(self.shared, self.target)
        out = self.target / "world-parcels/cities/12/failed-urls.json"
        self.assertEqual(json.loads(out.read_text())[0]["url"], "https://example.invalid/a")
        self.assertEqual((out.parent / "settings.json").read_text(), '{"keep":true}')
        self.record(value=[{"url": "https://example.invalid/b"}])
        sync_failed_urls(self.shared, self.target)
        self.assertIn("/b", out.read_text())
        self.record(value=[]).unlink()
        sync_failed_urls(self.shared, self.target)
        self.assertFalse(out.exists())
        self.assertTrue((out.parent / "settings.json").exists())

    def test_foreign_drift_refuses_removal(self):
        self.record(value=[{"url": "https://example.invalid/a"}])
        sync_failed_urls(self.shared, self.target)
        out = self.target / "world-parcels/cities/12/failed-urls.json"
        out.write_text("foreign")
        self.record().unlink()
        with self.assertRaisesRegex(RuntimeError, "foreign changed removal"):
            sync_failed_urls(self.shared, self.target)

    def test_foreign_drift_refuses_update(self):
        self.record(value=[{"url": "https://example.invalid/a"}])
        sync_failed_urls(self.shared, self.target)
        out = self.target / "world-parcels/cities/12/failed-urls.json"
        out.write_text("foreign")
        self.record(value=[{"url": "https://example.invalid/b"}])
        with self.assertRaisesRegex(RuntimeError, "foreign changed update"):
            sync_failed_urls(self.shared, self.target)

    def test_target_parent_symlink_and_marker_code_are_rejected(self):
        escaped = self.root / "escaped"
        escaped.mkdir()
        (self.target / "world-parcels/cities/99").symlink_to(escaped, target_is_directory=True)
        self.record("99", [])
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            sync_failed_urls(self.shared, self.target)
        (self.target / "world-parcels/cities/99").unlink()
        marker = self.target / "tmp/parcel-city-knowledge.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text('{"x":{"sha256":"abc"}}')
        with self.assertRaisesRegex(RuntimeError, "marker entry"):
            sync_failed_urls(self.shared, self.target)

    def test_persistent_canonical_lock_file_is_compatible(self):
        lock = self.shared / "tmp/parcel-city-locks/12.lock"
        lock.parent.mkdir(parents=True)
        self.record(value=[])
        sync_failed_urls(self.shared, self.target)
        self.assertTrue(lock.exists())

    def test_symlink_refused_and_identical_is_skipped(self):
        source = self.record(value=[])
        self.assertEqual(sync_failed_urls(self.shared, self.target)["copied"], ["12"])
        self.assertEqual(sync_failed_urls(self.shared, self.target)["skipped"], ["12"])
        source.unlink()
        source.symlink_to(self.shared / "missing")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            sync_failed_urls(self.shared, self.target)

    def test_same_root_is_noop(self):
        self.assertEqual(sync_failed_urls(self.shared, self.shared), {"copied": [], "updated": [], "removed": [], "skipped": []})


if __name__ == "__main__":
    unittest.main()
