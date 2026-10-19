# Focused regression tests for HMLR release verification and WUP candidate scoping.
import csv
import copy
import gzip
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "build-hmlr-wup-seed.py"
SPEC = importlib.util.spec_from_file_location("hmlr_seed", SCRIPT)
hmlr_seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hmlr_seed)


def release_manifest(authorities):
    core_authorities = [{"name": item["name"],
                        "endpoint": f"https://use-land-property-data.service.gov.uk/datasets/inspire/download/{item['name']}.zip",
                        "etag": '"pin"', "bytes": 123, "archiveSha256": "c" * 64, "featureCount": 1,
                        "nativeBounds": [1, 2, 3, 4], "bounds": item["bounds"],
                        "scope": {"sha256": "d" * 64, "bytes": 100}} for item in authorities]
    core = {"schemaVersion": 2, "sourceDate": "2026-10-04", "policy": "test-policy",
            "authorities": core_authorities, "idDirectory": {"0001": {"sha256": "a" * 64, "bytes": 10}}}
    release_id = hashlib.sha256(json.dumps(core, separators=(",", ":")).encode()).hexdigest()
    manifest = copy.deepcopy(core)
    manifest["releaseId"] = release_id
    for index, authority in enumerate(manifest["authorities"]):
        authority["scope"]["url"] = f"https://example.test/hmlr/{release_id}/scopes/{index}.{'d' * 64}.json"
    manifest["idDirectory"]["0001"]["url"] = f"https://example.test/hmlr/{release_id}/ids/0001.{'a' * 64}.json"
    return manifest


class HmlrWupSeedTests(unittest.TestCase):
    def test_scope_urls_are_post_hash_but_scope_hash_and_size_are_sealed(self):
        manifest = release_manifest([{"name": "England", "bounds": [-2, 50, 0, 54]}])
        hmlr_seed.verify_manifest(manifest, 1)
        manifest["authorities"][0]["scope"]["url"] = "https://other.test/changed-location.json"
        hmlr_seed.verify_manifest(manifest, 1)
        for field, value in (("sha256", "e" * 64), ("bytes", 101)):
            changed = copy.deepcopy(manifest)
            changed["authorities"][0]["scope"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "release ID does not match"):
                hmlr_seed.verify_manifest(changed, 1)

    def test_rejects_v1_missing_or_malformed_scope_metadata(self):
        manifest = release_manifest([{"name": "England", "bounds": [-2, 50, 0, 54]}])
        old = copy.deepcopy(manifest)
        old["schemaVersion"] = 1
        with self.assertRaisesRegex(ValueError, "schema is invalid"):
            hmlr_seed.verify_manifest(old, 1)
        for scope in (None, {}, {"sha256": "not-a-hash", "bytes": 100},
                      {"sha256": "D" * 64, "bytes": 100}, {"sha256": "d" * 64, "bytes": True},
                      {"sha256": "d" * 64, "bytes": 0}, {"sha256": "d" * 64, "bytes": 16 * 1024 * 1024 + 1}):
            changed = copy.deepcopy(manifest)
            changed["authorities"][0]["scope"] = scope
            with self.subTest(scope=scope), self.assertRaisesRegex(ValueError, "malformed land-scope"):
                hmlr_seed.verify_manifest(changed, 1)

    def test_only_authority_bound_wup_centres_become_explicit_candidates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            authorities = [
                {"name": "England", "bounds": [-2, 50, 0, 54]},
                {"name": "Wales", "bounds": [-5, 51, -2, 54]},
            ]
            manifest = release_manifest(authorities)
            wup = root / "wup.csv.gz"
            rows = [
                ["2025", "1", "100", "52", "-1", "Inside", "United Kingdom", "GB"],
                ["2025", "2", "90", "56", "-4", "Outside", "United Kingdom", "GB"],
                ["2025", "3", "80", "52", "-3", "Wales", "United Kingdom", "GB"],
                ["2024", "4", "999", "52", "-1", "Old edition", "United Kingdom", "GB"],
            ]
            with gzip.open(wup, "wt", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(["Year", "City_Code", "Pop", "PWCent_Latitude", "PWCent_Longitude", "City_Name", "Location", "ISO2_Code"])
                writer.writerows(rows)

            result = hmlr_seed.build_seed(manifest, "b" * 64, wup,
                                          "https://example.test/hmlr", "tmp/manifest.json", authority_count=2)
            provider = result["providers"][0]
            self.assertEqual(provider["candidateCityCodes"], ["1", "3"])
            self.assertEqual(provider["boundCityCodes"], [])
            self.assertEqual(provider["descriptor"]["cityIds"], [])
            self.assertEqual(provider["descriptor"]["snapshotId"], manifest["releaseId"])
            self.assertTrue(provider["descriptor"]["manifestUrl"].endswith(f"/{manifest['releaseId']}/manifest.json"))
            self.assertTrue(result["candidateOnly"])
            self.assertEqual(result["scopeAudit"]["outsideBoundsWupCityCodes"], ["2"])

    def test_rejects_release_id_changed_after_sealing(self):
        with tempfile.TemporaryDirectory() as temp:
            wup = Path(temp) / "wup.csv.gz"
            with gzip.open(wup, "wt", encoding="utf-8") as stream:
                stream.write("Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n")
            manifest = release_manifest([{"name": "England", "bounds": [-2, 50, 0, 54]}])
            manifest["releaseId"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "release ID does not match"):
                hmlr_seed.build_seed(manifest, "b" * 64, wup,
                                     "https://example.test/hmlr", "tmp/manifest.json", authority_count=1)

    def test_manifest_base_url_must_be_explicit_safe_https(self):
        with tempfile.TemporaryDirectory() as temp:
            wup = Path(temp) / "wup.csv.gz"
            with gzip.open(wup, "wt", encoding="utf-8") as stream:
                stream.write("Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n")
            manifest = release_manifest([{"name": "England", "bounds": [-2, 50, 0, 54]}])
            for base in ("http://example.test", "https://user@example.test", "https://example.test?token=x"):
                with self.subTest(base=base), self.assertRaisesRegex(ValueError, "explicit HTTPS"):
                    hmlr_seed.build_seed(manifest, "b" * 64, wup, base, "tmp/manifest.json", authority_count=1)


if __name__ == "__main__":
    unittest.main()
