"""Pure tests for matched donor training-pool selection and frozen artifact validation."""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import match_donor_pools as pools


def tile(tile_id, count):
    return {'id': tile_id, 'parcel_count': count, 'density_bin': pools.density_bin(count)}


class MatchDonorPoolsTests(unittest.TestCase):
    def test_shuffled_inputs_keep_same_order_and_prefixes_are_exactly_matched(self):
        distant = {f'd{i}': tile(f'd{i}', count) for i, count in enumerate([5, 5, 15, 30, 50, 50])}
        nearby = {f'n{i}': tile(f'n{i}', count) for i, count in enumerate([5, 5, 15, 30, 50, 50])}
        kwargs = {'seed': 42, 'distant_version': 'd-v1', 'nearby_version': 'n-v1'}
        pairs = pools.match_pairs(distant, nearby, **kwargs)
        shuffled = pools.match_pairs(dict(reversed(list(distant.items()))),
                                     dict(reversed(list(nearby.items()))), **kwargs)
        self.assertEqual(pairs, shuffled)
        for size in range(1, len(pairs) + 1):
            prefix = pairs[:size]
            self.assertEqual([p['parcel_count'] for p in prefix],
                             [distant[p['distant_id']]['parcel_count'] for p in prefix])
            self.assertEqual([p['parcel_count'] for p in prefix],
                             [nearby[p['nearby_id']]['parcel_count'] for p in prefix])
            self.assertEqual(sum(distant[p['distant_id']]['parcel_count'] for p in prefix),
                             sum(nearby[p['nearby_id']]['parcel_count'] for p in prefix))

    def test_unmatched_extreme_count_buckets_are_excluded(self):
        distant = {'d-low': tile('d-low', 5), 'd-high': tile('d-high', 60)}
        nearby = {'n-low': tile('n-low', 5), 'n-mid': tile('n-mid', 15)}
        pairs = pools.match_pairs(distant, nearby)
        self.assertEqual(len(pairs), 1)
        self.assertEqual((pairs[0]['distant_id'], pairs[0]['nearby_id']), ('d-low', 'n-low'))

    def test_truth_count_and_source_id_tampering_fail_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sample = self._sample(root, 'tile_a', 2)
            manifest = {'version': 'fixture', 'training_pool': {'tiles': ['tile_a']},
                        'splits': {'selection': {'tiles': []}, 'final': {'tiles': []}}}
            pools._source_tiles(manifest, root)

            truth_path = root / sample['truth']
            truth = json.loads(truth_path.read_text())
            truth['features'].pop()
            truth_path.write_text(json.dumps(truth))
            sample['sha256']['truth'] = pools.digest_file(truth_path)
            self._write_dataset_receipt(root, sample)
            with self.assertRaisesRegex(ValueError, 'parcel_count'):
                pools._source_tiles(manifest, root)

            sample['parcel_count'] = 1
            sample['source_ids'] = ['wrong']
            truth['features'] = [{'geometry': None, 'properties': {'cestica_id': 'actual'}}]
            truth_path.write_text(json.dumps(truth))
            sample['sha256']['truth'] = pools.digest_file(truth_path)
            self._write_dataset_receipt(root, sample)
            with self.assertRaisesRegex(ValueError, 'source_ids'):
                pools._source_tiles(manifest, root)
            sample['source_ids'] = [None]
            self._write_dataset_receipt(root, sample)
            with self.assertRaisesRegex(ValueError, 'source_ids'):
                pools._source_tiles(manifest, root)

            sample['source_ids'] = ['actual']
            truth['features'][0]['properties']['cestica_id'] = None
            truth_path.write_text(json.dumps(truth))
            sample['sha256']['truth'] = pools.digest_file(truth_path)
            self._write_dataset_receipt(root, sample)
            with self.assertRaisesRegex(ValueError, 'source_ids'):
                pools._source_tiles(manifest, root)

    def test_dataset_artifact_symlink_outside_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / 'dataset'
            root.mkdir()
            sample = self._sample(root, 'tile_a', 2)
            manifest = {'version': 'fixture', 'training_pool': {'tiles': ['tile_a']},
                        'splits': {'selection': {'tiles': []}, 'final': {'tiles': []}}}
            image_path = root / sample['image']
            image_path.unlink()
            outside = parent / 'outside.jpg'
            outside.write_bytes(b'external image')
            image_path.symlink_to(outside)
            sample['sha256']['image'] = pools.digest_file(outside)
            self._write_dataset_receipt(root, sample)
            with self.assertRaisesRegex(ValueError, 'outside dataset root'):
                pools._source_tiles(manifest, root)

    def test_pool_manifest_records_portable_source_manifest_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            bench = Path(tmp)
            source_manifest = bench / 'manifests' / 'donor-v1.json'
            distant = {'d1': {'id': 'd1', 'bbox': [0, 0, 1, 1], 'parcel_count': 5,
                              'density_bin': 'low', 'source_ids': ['a'],
                              'sha256': {'image': 'a' * 64, 'truth': 'b' * 64}}}
            nearby = {'n1': {'id': 'n1', 'bbox': [0, 0, 1, 1], 'parcel_count': 5,
                             'density_bin': 'low', 'source_ids': ['b'],
                             'sha256': {'image': 'c' * 64, 'truth': 'd' * 64}}}
            pair = [{'parcel_count': 5, 'density_bin': 'low', 'distant_id': 'd1', 'nearby_id': 'n1'}]
            payloads = pools.build_outputs(
                distant, nearby, pair, 1, distant_version='d-v1', nearby_version='n-v1',
                distant_manifest_sha='1' * 64, nearby_manifest_sha='2' * 64,
                input_hashes={}, script_sha='3' * 64, seed=1,
                distant_manifest_path=source_manifest, nearby_manifest_path=source_manifest,
                bench_root=bench)
            self.assertEqual(payloads['distant-pool.json']['frozen_manifest']['path'], 'manifests/donor-v1.json')
            self.assertEqual(payloads['nearby-pool.json']['frozen_manifest']['path'], 'manifests/donor-v1.json')

    def test_changed_existing_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            payload = {'pool.json': {'tiles': ['a']}}
            pools.write_outputs(output, payload)
            first_bytes = (output / 'pool.json').read_bytes()
            pools.write_outputs(output, payload)
            self.assertEqual((output / 'pool.json').read_bytes(), first_bytes)
            (output / 'pool.json').write_text('{}\n')
            with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
                pools.write_outputs(output, payload)

    @staticmethod
    def _sample(root, tile_id, count):
        sample = {'id': tile_id, 'split': 'train', 'bbox': [0, 0, 1, 1],
                  'parcel_count': count, 'density_bin': pools.density_bin(count),
                  'source_ids': [f's{i}' for i in range(count)], 'sha256': {}}
        truth = {'type': 'FeatureCollection', 'features': [
            {'geometry': None, 'properties': {'cestica_id': f's{i}'}} for i in range(count)]}
        for key, rel in [('image', f'train/{tile_id}.jpg'), ('input', f'train/{tile_id}.input.json'),
                         ('truth', f'train/{tile_id}.truth.json'),
                         ('osm_input', f'train/{tile_id}.osm-input.json')]:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            data = json.dumps(truth).encode() if key == 'truth' else key.encode()
            path.write_bytes(data)
            sample[key] = rel
            sample['sha256'][key] = hashlib.sha256(data).hexdigest()
        MatchDonorPoolsTests._write_dataset_receipt(root, sample)
        return sample

    @staticmethod
    def _write_dataset_receipt(root, sample):
        (root / 'manifest.json').write_text(json.dumps({'samples': [sample]}))


if __name__ == '__main__':
    unittest.main()
