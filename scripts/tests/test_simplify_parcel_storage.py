"""The one-time cleanup must preserve useful URLs and refuse private files."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "simplify-parcel-storage.py"
spec = importlib.util.spec_from_file_location("simplify_parcel_storage_test", MODULE)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class SimplifyStorageTests(unittest.TestCase):
    def test_city_identity_comes_from_explicit_identity_or_packet_filename(self):
        self.assertEqual(cleanup.code_for({"cityRecord": "city-123-test.json"}, Path("test-service-review.json")), "123")
        self.assertEqual(cleanup.code_for({"cityCode": "456"}, Path("city-123-test.json")), "456")
        self.assertIsNone(cleanup.code_for({"cityName": "123"}, Path("unknown.json")))

    def test_extracted_failed_urls_survive_deletion_of_original_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, knowledge = base / "research", base / "shared"
            source.mkdir()
            (source / "city-123-test.json").write_text(json.dumps({"cityCode": "123", "status": "complete",
                "failedUrls": [{"url": "https://example.test/query", "reason": "access denied"}]}))
            stats = cleanup.extract_tree(source, knowledge, apply=True)
            self.assertEqual(stats["documents"], 1)
            cleanup.retire(source)
            saved = json.loads((knowledge / "world-parcels/cities/123/failed-urls.json").read_text())
            self.assertEqual(saved, [{"url": "https://example.test/query", "reason": "access denied"}])

    def test_credentials_stop_deletion_of_whole_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "research"
            root.mkdir()
            (root / "result.json").write_text('{}')
            (root / ".env").write_text("PRIVATE_TEST_VALUE=dummy")
            with self.assertRaisesRegex(RuntimeError, "rescued"):
                cleanup.retire(root)
            self.assertTrue((root / "result.json").exists())
            self.assertTrue((root / ".env").exists())

    def test_native_cleanup_preserves_interactive_and_unrelated_sessions(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            job = base / "research-job"
            for name, source, cwd in (("task", "exec", str(job)), ("interactive", "cli", str(job)),
                                      ("other", "exec", str(base / "other-project"))):
                (base / (name + ".jsonl")).write_text(json.dumps({"payload": {"cwd": cwd, "source": source}}) + "\n")
            stats = cleanup.retire_native_sessions(base, [job])
            self.assertEqual(stats["files"], 1)
            self.assertFalse((base / "task.jsonl").exists())
            self.assertTrue((base / "interactive.jsonl").exists())
            self.assertTrue((base / "other.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
