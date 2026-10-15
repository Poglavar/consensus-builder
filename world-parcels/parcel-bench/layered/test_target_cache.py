"""Verify target-margin data flow and cache reuse using synthetic clipped parcels; no model runs."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from target_config import cache_namespace, target_definition
from train import load_cache


class TargetCacheTests(unittest.TestCase):
    def make_entry(self, directory):
        image, truth = directory / 'image.png', directory / 'truth.json'
        Image.new('RGB', (128, 128), (32, 64, 128)).save(image)
        features = [{'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': [
            [[a, 0], [b, 0], [b, 128], [a, 128], [a, 0]]]}} for a, b in ((0, 64), (64, 128))]
        truth.write_text(json.dumps({'type': 'FeatureCollection', 'features': features}))
        return {'id': 'tile_1_2', 'bbox': [0, 0, 128, 128], 'image': image, 'truth': truth, 'osm': None}

    def test_margin_zero_preserves_boundary_endpoints_and_cache_is_verified_on_reuse(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            entry = self.make_entry(directory)
            arrays, hashes = {}, {}
            for margin in (0, 2):
                definition = target_definition(128, margin_px=margin)
                cache_dir = directory / cache_namespace(definition)
                arrays[margin] = load_cache([entry], 128, 12.0, 1, cache_dir, margin_px=margin)[entry['id']]
                path = cache_dir / f'{entry["id"]}.npz'
                hashes[margin] = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(json.loads(arrays[margin]['target_definition'].item()), definition)
                with patch('train.prepare_tile', side_effect=AssertionError('must reuse verified file')):
                    reused = load_cache([entry], 128, 12.0, 1, cache_dir, margin_px=margin)[entry['id']]
                for key in arrays[margin]:
                    np.testing.assert_array_equal(reused[key], arrays[margin][key])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), hashes[margin])
            self.assertTrue(arrays[0]['boundary'][0].any())
            self.assertTrue(arrays[0]['boundary'][-1].any())
            self.assertFalse(arrays[2]['boundary'][:2].any())
            self.assertFalse(arrays[2]['boundary'][-2:].any())
            np.testing.assert_array_equal(arrays[0]['boundary'][2:-2, 2:-2], arrays[2]['boundary'][2:-2, 2:-2])
            self.assertFalse(np.array_equal(arrays[0]['distance'], arrays[2]['distance']))
            for key in ('image', 'osm', 'interior'):
                np.testing.assert_array_equal(arrays[0][key], arrays[2][key])
            self.assertNotEqual(hashes[0], hashes[2])

    def test_wrong_margin_and_unversioned_cache_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            entry = self.make_entry(directory)
            cache_dir = directory / cache_namespace(target_definition(128, margin_px=2))
            loaded = load_cache([entry], 128, 12.0, 1, cache_dir, margin_px=2)[entry['id']]
            with self.assertRaisesRegex(ValueError, 'cache target definition differs'):
                load_cache([entry], 128, 12.0, 1, cache_dir, margin_px=0)
            loaded.pop('target_definition')
            np.savez_compressed(cache_dir / f'{entry["id"]}.npz', **loaded)
            with self.assertRaisesRegex(ValueError, 'cache target definition differs'):
                load_cache([entry], 128, 12.0, 1, cache_dir, margin_px=2)


if __name__ == '__main__':
    unittest.main()
