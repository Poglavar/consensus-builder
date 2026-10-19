"""Pure tests for deterministic resolution augmentation."""
import unittest

import numpy as np

if __package__ == 'layered':
    from layered.imagery import augment_resolution
else:
    from imagery import augment_resolution


class ResolutionAugmentationTests(unittest.TestCase):
    def setUp(self):
        yy, xx = np.indices((64, 64))
        checker = ((xx + yy) % 2).astype(np.float32)
        self.image = np.repeat(checker[None, ...], 3, axis=0)
        self.bbox = (0, 0, 64, 64)

    @staticmethod
    def high_frequency_energy(image):
        return float(np.mean(np.diff(image, axis=1) ** 2) + np.mean(np.diff(image, axis=2) ** 2))

    def test_same_seed_and_epoch_repeat_but_next_epoch_changes_resolution(self):
        kwargs = dict(seed=17, index=4, probability=1, max_gsd_m=4)
        first = augment_resolution(self.image, self.bbox, epoch=3, **kwargs)
        repeated = augment_resolution(self.image, self.bbox, epoch=3, **kwargs)
        next_epoch = augment_resolution(self.image, self.bbox, epoch=4, **kwargs)
        np.testing.assert_array_equal(first, repeated)
        self.assertFalse(np.array_equal(first, next_epoch))

    def test_zero_probability_returns_original_even_when_resolution_can_be_coarsened(self):
        result = augment_resolution(self.image, self.bbox, seed=1, epoch=1, index=0,
                                    probability=0, max_gsd_m=8)
        self.assertIs(result, self.image)

    def test_chosen_branch_reduces_high_frequency_energy_without_shape_or_bounds_drift(self):
        original = self.image.copy()
        # A horizontal flip has a negative stride; training rotations can produce such views too.
        rotated_view = self.image[:, :, ::-1]
        result = augment_resolution(rotated_view, self.bbox, seed=2, epoch=1, index=7,
                                    probability=1, max_gsd_m=8)
        self.assertEqual(result.shape, rotated_view.shape)
        self.assertTrue(np.isfinite(result).all())
        self.assertGreaterEqual(float(result.min()), 0)
        self.assertLessEqual(float(result.max()), 1)
        self.assertLess(self.high_frequency_energy(result), self.high_frequency_energy(rotated_view))
        np.testing.assert_array_equal(self.image, original)

    def test_native_or_finer_maximum_is_a_noop(self):
        result = augment_resolution(self.image, self.bbox, seed=1, epoch=1, index=0,
                                    probability=1, max_gsd_m=1)
        self.assertIs(result, self.image)

    def test_invalid_probability_and_maximum_gsd_are_rejected(self):
        base = dict(seed=1, epoch=1, index=0)
        for probability in (-0.1, 1.1, float('nan'), float('inf')):
            with self.subTest(probability=probability), self.assertRaises(ValueError):
                augment_resolution(self.image, self.bbox, probability=probability,
                                   max_gsd_m=2, **base)
        for max_gsd_m in (0, -1, float('nan'), float('inf')):
            with self.subTest(max_gsd_m=max_gsd_m), self.assertRaises(ValueError):
                augment_resolution(self.image, self.bbox, probability=1,
                                   max_gsd_m=max_gsd_m, **base)


if __name__ == '__main__':
    unittest.main()
