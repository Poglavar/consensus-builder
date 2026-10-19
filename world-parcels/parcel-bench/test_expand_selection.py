"""Pure tests for deterministic v1-to-v2 selection expansion."""
import copy
import tempfile
import unittest
from pathlib import Path

import expand_selection


STRATA = [
    {'name': 'low', 'min': 0, 'max': 12},
    {'name': 'medium', 'min': 12, 'max': 25},
    {'name': 'high', 'min': 25, 'max': 45},
    {'name': 'dense', 'min': 45, 'max': None},
]
QUOTAS = {'low': 1, 'medium': 1, 'high': 1, 'dense': 1}


def frozen_record(tile_id, bbox, sources, density='medium', count=20):
    return {'id': tile_id, 'bbox': bbox, 'density_bin': density, 'parcel_count': count,
            'source_ids': sorted(sources), 'image': f'old/{tile_id}.jpg', 'truth': f'old/{tile_id}.json',
            'osm_input': f'old/{tile_id}.osm.json', 'truth_sha256': 'a', 'image_sha256': 'b'}


def make_inputs(city='zagreb-v1', include_conflicts=True):
    parent = {
        'version': city,
        'city': {'name': city, 'country_code': 'HR'},
        'crs': 'EPSG:3765',
        'tile_size_m': 153.6,
        'strata': copy.deepcopy(STRATA),
        'scoring': {'iou_threshold': 0.5, 'selection_rule': 'parcel_f1'},
        'separation': {'cross_split_distance_m': 500, 'source_ids_disjoint_across_splits': True},
        'exhausted': {'tiles': ['tile_24_0']},
        'splits': {
            'selection': {'tiles': [frozen_record('tile_100_0', [10000, 0, 10153.6, 153.6], ['old-s'])]},
            'final': {'tiles': [frozen_record('tile_200_0', [20000, 0, 20153.6, 153.6], ['old-f'])]},
        },
        'training_pool': {'tiles': [], 'parcel_instances': 0},
        'frozen_at': 'fixed-parent-time',
    }
    dataset_samples = []
    specs = [(0, 'low', 8), (6, 'low', 9), (12, 'medium', 18), (18, 'high', 32),
             (30, 'dense', 55), (36, 'medium', 20)]
    for origin_x, kind, count in specs:
        shared_ref = f'block-{origin_x}'
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            x, y = origin_x + dx, dy
            tile_id = f'tile_{x}_{y}'
            bbox = [x * expand_selection.TILE_M, y * expand_selection.TILE_M,
                    (x + 1) * expand_selection.TILE_M, (y + 1) * expand_selection.TILE_M]
            dataset_samples.append({
                'id': tile_id, 'city': city, 'split': 'train', 'bbox': bbox,
                'source_ids': [shared_ref], 'parcel_count': count, 'density_bin': kind,
                'image': f'train/{tile_id}.jpg', 'truth': f'train/{tile_id}.json',
                'osm_input': f'train/{tile_id}.osm.json',
                'sha256': {'image': f'image-{tile_id}', 'truth': f'truth-{tile_id}'},
            })
    if include_conflicts:
        # These records are not block candidates. One shares parcel identity with every tile
        # in the x=0 candidate; the other is geographically beside it and must also be purged.
        dataset_samples.extend([
            {'id': 'tile_60_60', 'city': city, 'split': 'train', 'bbox': [60 * 153.6, 60 * 153.6,
             61 * 153.6, 61 * 153.6], 'source_ids': ['block-0'], 'parcel_count': 8,
             'image': 'train/remote.jpg', 'truth': 'train/remote.json', 'osm_input': 'train/remote.osm.json',
             'sha256': {'image': 'remote-image', 'truth': 'remote-truth'}},
            {'id': 'tile_2_0', 'city': city, 'split': 'train', 'bbox': [2 * 153.6, 0, 3 * 153.6, 153.6],
             'source_ids': ['nearby-only'], 'parcel_count': 8, 'image': 'train/near.jpg',
             'truth': 'train/near.json', 'osm_input': 'train/near.osm.json',
             'sha256': {'image': 'near-image', 'truth': 'near-truth'}},
            {'id': 'tile_2_1', 'city': city, 'split': 'train', 'bbox': [2 * 153.6, 153.6, 3 * 153.6, 307.2],
             'source_ids': ['nearby-only'], 'parcel_count': 8, 'image': 'train/near2.jpg',
             'truth': 'train/near2.json', 'osm_input': 'train/near2.osm.json',
             'sha256': {'image': 'near2-image', 'truth': 'near2-truth'}},
        ])
    dataset_samples.append({
        'id': 'tile_24_0', 'city': city, 'split': 'train',
        'bbox': [24 * 153.6, 0, 25 * 153.6, 153.6], 'source_ids': ['exhausted-source'],
        'parcel_count': 8, 'image': 'train/exhausted.jpg', 'truth': 'train/exhausted.json',
        'osm_input': 'train/exhausted.osm.json',
        'sha256': {'image': 'exhausted-image', 'truth': 'exhausted-truth'},
    })
    dataset = {'pool_version': 'hr-pool-v1', 'crs': 'EPSG:3765', 'tile_size_m': 153.6,
               'samples': dataset_samples}
    return parent, dataset


class ExpandSelectionTests(unittest.TestCase):
    def test_expansion_preserves_old_splits_and_adds_requested_block_classes(self):
        parent, dataset = make_inputs(include_conflicts=False)
        original_parent = copy.deepcopy(parent)
        old_selection = copy.deepcopy(parent['splits']['selection']['tiles'])
        old_final = copy.deepcopy(parent['splits']['final']['tiles'])
        expanded = expand_selection.build_manifest(parent, dataset, QUOTAS)

        self.assertEqual(parent, original_parent)
        expanded['splits']['selection']['tiles'][0]['source_ids'].append('mutation-check')
        self.assertEqual(parent, original_parent)
        expanded['splits']['selection']['tiles'][0]['source_ids'].pop()
        self.assertEqual(expanded['version'], 'zagreb-v2')
        self.assertEqual(expanded['city'], parent['city'])
        self.assertEqual(expanded['scoring'], parent['scoring'])
        self.assertEqual(expanded['splits']['selection']['tiles'][:len(old_selection)], old_selection)
        self.assertEqual(expanded['splits']['final']['tiles'], old_final)
        info = expanded['selection_expansion']
        self.assertEqual(info['counts']['added_blocks'], 4)
        self.assertEqual(info['counts']['added_selection_tiles'], 16)
        self.assertEqual({b['density_bin'] for b in info['blocks']}, set(QUOTAS))
        self.assertEqual(expanded['checkpoint_policy'], 'verified-training-exposure')
        self.assertNotIn('frozen_at', expanded)
        self.assertEqual(expanded['selection_expansion']['parent_frozen_at'], 'fixed-parent-time')
        self.assertEqual(expanded['separation'], {'cross_split_distance_m': 500,
                                                  'source_ids_disjoint_across_splits': True})

    def test_chosen_blocks_are_spaced_and_training_is_purged_by_distance_and_source(self):
        parent, dataset = make_inputs()
        expanded = expand_selection.build_manifest(parent, dataset, QUOTAS)
        added = expanded['splits']['selection']['tiles'][1:]
        blocks = expanded['selection_expansion']['blocks']
        by_id = {sample['id']: sample for sample in dataset['samples']}
        block_bounds = []
        block_sources = []
        for block in blocks:
            rows = [by_id[tile_id] for tile_id in block['tile_ids']]
            block_bounds.append(expand_selection.record_bbox(rows))
            block_sources.append(expand_selection.source_set(rows))
        old_records = parent['splits']['selection']['tiles'] + parent['splits']['final']['tiles']
        for bounds in block_bounds:
            self.assertTrue(all(expand_selection.bbox_gap(bounds, old['bbox']) >= 500 - 1e-6
                                for old in old_records))
        for i, bounds in enumerate(block_bounds):
            for j in range(i):
                self.assertGreaterEqual(expand_selection.bbox_gap(bounds, block_bounds[j]), 500 - 1e-6)
                self.assertFalse(block_sources[i] & block_sources[j])

        kept_ids = set(expanded['training_pool']['tiles'])
        heldout = old_records + added
        heldout_sources = set().union(*(set(record['source_ids']) for record in heldout))
        for row in dataset['samples']:
            if row['id'] in kept_ids:
                self.assertTrue(all(expand_selection.bbox_gap(row['bbox'], record['bbox']) >= 500 - 1e-6
                                    for record in heldout))
                self.assertFalse(set(row['source_ids']) & heldout_sources)
        selected_ids = {record['id'] for record in added}
        self.assertFalse(selected_ids & kept_ids)
        # The remote tile shares a parcel id with the selected x=0 block; the x=2 tiles
        # touch that block. Both must be absent from the rebuilt training pool.
        self.assertNotIn('tile_60_60', kept_ids)
        self.assertNotIn('tile_2_0', kept_ids)
        self.assertNotIn('tile_2_1', kept_ids)
        self.assertEqual(expanded['training_pool']['parcel_instances'],
                         sum(row['parcel_count'] for row in dataset['samples'] if row['id'] in kept_ids))
        self.assertNotIn('tile_24_0', kept_ids)
        self.assertEqual(expanded['selection_expansion']['counts']['training_tiles_purged'],
                         expanded['selection_expansion']['counts']['training_tiles_before'] - len(kept_ids))

    def test_exhausted_members_are_never_selected_and_missing_quota_fails(self):
        parent, dataset = make_inputs(include_conflicts=False)
        expanded = expand_selection.build_manifest(parent, dataset, {'low': 0, 'medium': 0, 'high': 0, 'dense': 1})
        selected = {record['id'] for record in expanded['splits']['selection']['tiles']}
        self.assertFalse(selected & set(parent['exhausted']['tiles']))
        with self.assertRaisesRegex(ValueError, 'insufficient separated candidate blocks'):
            expand_selection.build_manifest(parent, dataset, {'low': 10})

    def test_split_style_quotas_need_no_low_candidates(self):
        parent, dataset = make_inputs(city='split-v1', include_conflicts=False)
        expanded = expand_selection.build_manifest(
            parent, dataset, {'medium': 1, 'high': 1, 'dense': 1})
        bins = [b['density_bin'] for b in expanded['selection_expansion']['blocks']]
        self.assertCountEqual(bins, ['medium', 'high', 'dense'])

    def test_same_inputs_are_deterministic_and_conflicting_frozen_write_is_refused(self):
        parent, dataset = make_inputs(include_conflicts=False)
        first = expand_selection.build_manifest(parent, dataset, QUOTAS)
        second = expand_selection.build_manifest(parent, dataset, QUOTAS)
        self.assertEqual(first, second)
        self.assertEqual(first['selection_expansion']['parent_manifest_sha256'],
                         second['selection_expansion']['parent_manifest_sha256'])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'city-v2.json'
            expand_selection.write_frozen(path, first)
            original = path.read_bytes()
            expand_selection.write_frozen(path, second)
            self.assertEqual(path.read_bytes(), original)
            changed = copy.deepcopy(first)
            changed['city']['name'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'not overwritten'):
                expand_selection.write_frozen(path, changed)
            self.assertEqual(path.read_bytes(), original)

    def test_metadata_mismatch_and_selected_tile_without_hashes_are_refused(self):
        parent, dataset = make_inputs(include_conflicts=False)
        wrong_crs = copy.deepcopy(dataset)
        wrong_crs['crs'] = 'EPSG:3857'
        with self.assertRaisesRegex(ValueError, 'crs differ'):
            expand_selection.build_manifest(parent, wrong_crs, QUOTAS)
        wrong_tile_size = copy.deepcopy(dataset)
        wrong_tile_size['tile_size_m'] = 200
        with self.assertRaisesRegex(ValueError, 'tile_size_m differ'):
            expand_selection.build_manifest(parent, wrong_tile_size, QUOTAS)
        no_hashes = copy.deepcopy(dataset)
        for sample in no_hashes['samples']:
            sample.pop('sha256', None)
        with self.assertRaisesRegex(ValueError, 'lacks frozen image/truth hashes'):
            expand_selection.build_manifest(parent, no_hashes, QUOTAS)


if __name__ == '__main__':
    unittest.main()
