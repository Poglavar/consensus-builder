"""Tests for checkpoint exposure history and RGB-only training augmentation."""
import copy
import unittest

import numpy as np

if __package__ == 'layered':
    from layered.exposure import combine_exposure, validate_exposure, validate_resume
    from layered.train import TileDataset
else:
    from exposure import combine_exposure, validate_exposure, validate_resume
    from train import TileDataset


def sample(tile_id, bbox, *source_ids):
    return {'id': tile_id, 'bbox': list(bbox), 'source_ids': list(source_ids)}


def manifest():
    return {
        'crs': 'EPSG:3765',
        'checkpoint_policy': 'verified-training-exposure',
        'separation': {'cross_split_distance_m': 500},
        'splits': {
            'selection': {'tiles': [sample('selection', [0, 0, 10, 10], 'sel-source')]},
            'final': {'tiles': [sample('final', [2000, 0, 2010, 10], 'final-source')]},
        },
    }


def empty_exposure(crs='EPSG:3765'):
    return {'format': 1, 'crs': crs, 'training': [], 'selection': []}


class ExposureTests(unittest.TestCase):
    def test_valid_fresh_history_is_accepted(self):
        history = combine_exposure(
            'EPSG:3765', [sample('train', [1000, 1000, 1010, 1010], 'train-source')],
            [manifest()['splits']['selection']['tiles'][0]], empty_exposure())
        validate_exposure(history, manifest())
        self.assertEqual(history['training'], [sample('train', [1000, 1000, 1010, 1010], 'train-source')])

    def test_strict_policy_rejects_missing_exposure(self):
        with self.assertRaisesRegex(ValueError, 'lacks verified training exposure'):
            validate_exposure(None, manifest())

    def test_training_exposure_rejects_heldout_id_source_overlap_and_nearby_tile(self):
        cases = [
            sample('selection', [1000, 1000, 1010, 1010], 'other'),
            sample('train', [1000, 1000, 1010, 1010], 'sel-source'),
            sample('train', [509, 0, 519, 10], 'other'),  # 499 m away
        ]
        for exposed in cases:
            with self.subTest(exposed=exposed), self.assertRaises(ValueError):
                validate_exposure({**empty_exposure(), 'training': [exposed]}, manifest())

    def test_exactly_500m_separation_is_allowed(self):
        history = {**empty_exposure(), 'training': [sample('train', [510, 0, 520, 10], 'train-source')]}
        validate_exposure(history, manifest())

    def test_ancestor_history_is_unioned_and_conflicting_metadata_is_refused(self):
        ancestor = {
            'format': 1, 'crs': 'EPSG:3765',
            'training': [sample('old-train', [900, 900, 910, 910], 'old-source')],
            'selection': [sample('old-selection', [1200, 1200, 1210, 1210], 'old-selection-source')],
        }
        combined = combine_exposure('EPSG:3765', [sample('new-train', [1500, 1500, 1510, 1510], 'new-source')],
                                    [sample('new-selection', [1800, 1800, 1810, 1810], 'new-selection-source')],
                                    ancestor)
        self.assertEqual([item['id'] for item in combined['training']], ['new-train', 'old-train'])
        self.assertEqual([item['id'] for item in combined['selection']], ['new-selection', 'old-selection'])
        changed = copy.deepcopy(ancestor)
        changed['training'][0]['bbox'] = [901, 900, 911, 910]
        with self.assertRaisesRegex(ValueError, 'changed exposure metadata'):
            combine_exposure('EPSG:3765', [sample('old-train', [900, 900, 910, 910], 'old-source')],
                             [], changed)

    def test_unknown_ancestor_cannot_gain_verified_history(self):
        self.assertIsNone(combine_exposure('EPSG:3765', [sample('train', [1000, 1000, 1010, 1010], 's')],
                                           [], None))

    def test_ancestor_selection_exposure_cannot_touch_final_split(self):
        history = {**empty_exposure(),
                   'selection': [sample('donor-selection', [2010, 0, 2020, 10], 'donor-selection-source')]}
        with self.assertRaisesRegex(ValueError, 'within 500 m of holdout'):
            validate_exposure(history, manifest())

    def test_coordinate_system_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'different coordinate system'):
            combine_exposure('EPSG:4326', [], [], empty_exposure())
        with self.assertRaisesRegex(ValueError, 'coordinate system'):
            validate_exposure(empty_exposure('EPSG:4326'), manifest())


class ResumeValidationTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            'recipe_hash': 'recipe', 'manifest_sha256': 'manifest', 'dataset_sha256': 'dataset',
            'train_tiles': ['a', 'b'], 'selection_tiles': ['s'], 'exposure': empty_exposure(),
            'args': {'epochs': 10, 'device': 'cpu', 'log_every': 5, 'size': 512, 'lr': 0.001},
        }

    def test_resume_allows_epoch_extension_device_and_log_changes(self):
        current = copy.deepcopy(self.previous)
        current['args'].update(epochs=20, device='mps', log_every=1)
        validate_resume(self.previous, current)

    def test_resume_refuses_manifest_training_ids_and_exposure_changes(self):
        for key, value in (('manifest_sha256', 'other'), ('train_tiles', ['a']),
                           ('exposure', {**empty_exposure(), 'training': [sample('new', [1, 1, 2, 2], 'x')]})):
            current = copy.deepcopy(self.previous)
            current[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, f'changed {key}'):
                validate_resume(self.previous, current)

    def test_resume_refuses_other_training_argument_changes(self):
        current = copy.deepcopy(self.previous)
        current['args']['lr'] = 0.002
        with self.assertRaisesRegex(ValueError, 'changed training arguments'):
            validate_resume(self.previous, current)


class TileDatasetResolutionAugmentationTests(unittest.TestCase):
    def test_resolution_branch_changes_only_rgb_after_shared_augmentation_stream(self):
        yy, xx = np.indices((64, 64))
        checker = ((xx + yy) % 2).astype(np.float16)
        cache = {
            'tile': {
                'image': np.repeat(checker[None], 3, axis=0),
                'osm': np.full((3, 64, 64), 127, dtype=np.uint8),
                'boundary': np.arange(64 * 64, dtype=np.float32).reshape(64, 64) / (64 * 64),
                'interior': np.full((64, 64), 0.25, dtype=np.float32),
                'distance': np.full((64, 64), 0.75, dtype=np.float16),
            },
        }
        common = dict(cache=cache, ids=['tile'], augment=True, osm_dropout=0.5, seed=43,
                      tile_size_m=64)
        clean = TileDataset(**common, resolution_aug_prob=0, resolution_aug_max_gsd=8)
        degraded = TileDataset(**common, resolution_aug_prob=1, resolution_aug_max_gsd=8)
        clean.epoch = degraded.epoch = 3
        clean_x, clean_y = clean[0]
        degraded_x, degraded_y = degraded[0]
        self.assertFalse(np.array_equal(clean_x[:3].numpy(), degraded_x[:3].numpy()))
        np.testing.assert_array_equal(clean_x[3:].numpy(), degraded_x[3:].numpy())
        for key in clean_y:
            torch_clean = clean_y[key].numpy()
            torch_degraded = degraded_y[key].numpy()
            np.testing.assert_array_equal(torch_clean, torch_degraded)


if __name__ == '__main__':
    unittest.main()
