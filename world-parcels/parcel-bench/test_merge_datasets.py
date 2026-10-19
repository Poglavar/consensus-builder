#!/usr/bin/env python3
"""Tests for merge_datasets.py on two synthetic city datasets: hard-linked samples, a union pool manifest that names
both frozen manifests, idempotent re-runs and a collision error."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def make_city(root, name, tiles, version):
    dataset = root / name / 'dataset'
    samples = []
    for tile_id, split in tiles:
        folder = dataset / split
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f'{tile_id}.jpg').write_bytes(b'jpg' + tile_id.encode())
        (folder / f'{tile_id}.truth.json').write_text('{"type":"FeatureCollection","features":[]}')
        (folder / f'{tile_id}.input.json').write_text('{}')
        (folder / f'{tile_id}.osm-input.json').write_text('{"buildings":[],"roads":[],"water":[]}')
        samples.append({'id': tile_id, 'split': split, 'bbox': [0, 0, 1, 1], 'parcel_count': 7, 'density_bin': 'low',
                        'image': f'{split}/{tile_id}.jpg', 'truth': f'{split}/{tile_id}.truth.json',
                        'input': f'{split}/{tile_id}.input.json', 'osm_input': f'{split}/{tile_id}.osm-input.json',
                        'sha256': {'image': 'x', 'truth': 'y'}})
    (dataset / 'manifest.json').write_text(json.dumps({'samples': samples}))
    frozen = root / name / f'{version}.json'
    frozen.write_text(json.dumps({'version': version, 'training_pool': {'tiles': [t for t, s in tiles if s == 'train']},
                                  'splits': {'selection': {'tiles': []}, 'final': {'tiles': []}}}))
    return dataset, frozen


class MergeTests(unittest.TestCase):
    def test_merge_links_samples_and_unions_pools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a_dataset, a_frozen = make_city(root, 'a', [('tile_1_1', 'train'), ('tile_1_2', 'validation')], 'a-v1')
            b_dataset, b_frozen = make_city(root, 'b', [('tile_9_9', 'train'), ('tile_9_8', 'test')], 'b-v1')
            out, pool = root / 'merged', root / 'pool.json'
            command = [sys.executable, str(HERE / 'merge_datasets.py'), '--city', f'{a_dataset}:{a_frozen}',
                       '--city', f'{b_dataset}:{b_frozen}', '--version', 'ab-pool', '--output', str(out),
                       '--pool-manifest', str(pool), '--run']
            completed = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
            merged = json.loads((out / 'manifest.json').read_text())
            self.assertEqual(sorted(s['id'] for s in merged['samples']), ['tile_1_1', 'tile_1_2', 'tile_9_8', 'tile_9_9'])
            self.assertEqual((out / 'test' / 'tile_9_8.jpg').read_bytes(), b'jpgtile_9_8')
            manifest = json.loads(pool.read_text())
            self.assertEqual([t['id'] for t in manifest['tiles']], ['tile_1_1', 'tile_9_9'])
            self.assertEqual([m['version'] for m in manifest['frozen_manifests']], ['a-v1', 'b-v1'])
            self.assertEqual(manifest['counts']['by_city'], {'a-v1': 1, 'b-v1': 1})
            completed = subprocess.run(command, capture_output=True, text=True)   # idempotent
            self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
            (a_dataset / 'train' / 'tile_9_9.jpg').write_bytes(b'dup')          # a colliding id in city a
            a_manifest = json.loads((a_dataset / 'manifest.json').read_text())
            a_manifest['samples'].append(dict(a_manifest['samples'][0], id='tile_9_9', image='train/tile_9_9.jpg'))
            (a_dataset / 'manifest.json').write_text(json.dumps(a_manifest))
            completed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn('appears in two cities', completed.stderr)


if __name__ == '__main__':
    unittest.main()
