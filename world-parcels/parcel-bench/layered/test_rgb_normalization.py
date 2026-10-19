"""Check RGB-only preprocessing at the encoder and protect checkpoint/evaluation consistency."""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import ParcelNet
from rgb_normalization import definition, recorded, validate_definition
from train import predict


class RecordingEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.feature_info = SimpleNamespace(channels=lambda: [6])
        self.seen = []

    def forward(self, value):
        self.seen.append(value.detach().clone())
        return [value]


class NormalizationTests(unittest.TestCase):
    def setUp(self):
        self.settings = definition('pretrained', 'convnext_tiny.in12k_ft_in1k')

    def model(self, settings=None):
        with patch('model.timm.create_model', side_effect=lambda *a, **k: RecordingEncoder()):
            return ParcelNet(pretrained=False, rgb_normalization=settings)

    def test_pinned_pretrained_configuration_is_used(self):
        self.assertEqual(self.settings['pretrained_model'], 'timm/convnext_tiny.in12k_ft_in1k')
        self.assertEqual(self.settings['mean'], [.485, .456, .406])
        self.assertEqual(self.settings['std'], [.229, .224, .225])

    def test_training_and_prediction_normalize_rgb_once_and_preserve_osm_and_cache(self):
        model = self.model(self.settings)
        rgb = np.broadcast_to(np.array(self.settings['mean'], dtype=np.float32)[:, None, None]
                              + np.array(self.settings['std'], dtype=np.float32)[:, None, None], (3, 8, 8)).copy()
        osm = np.zeros((3, 8, 8), dtype=np.uint8)
        osm[0, ::2] = 1
        osm[2, :, ::2] = 1
        cache = {'tile': {'image': rgb, 'osm': osm}}
        before_rgb, before_osm = rgb.copy(), osm.copy()
        batch = torch.from_numpy(np.concatenate([rgb, osm.astype(np.float32)])[None])
        model.train()
        model(batch)
        model.eval()
        predict(model, cache, 'tile', torch.device('cpu'))
        predict(model, cache, 'tile', torch.device('cpu'), blank_osm=True)
        for observed in model.encoder.seen:
            torch.testing.assert_close(observed[:, :3], torch.ones(1, 3, 8, 8))
        torch.testing.assert_close(model.encoder.seen[0], model.encoder.seen[1], rtol=0, atol=0)
        torch.testing.assert_close(model.encoder.seen[0][:, 3:], batch[:, 3:], rtol=0, atol=0)
        self.assertEqual(torch.count_nonzero(model.encoder.seen[2][:, 3:]).item(), 0)
        np.testing.assert_array_equal(cache['tile']['image'], before_rgb)
        np.testing.assert_array_equal(cache['tile']['osm'], before_osm)

    def test_raw_default_and_parameter_initialization_remain_unchanged(self):
        torch.manual_seed(3)
        raw = self.model()
        torch.manual_seed(3)
        normalized = self.model(self.settings)
        self.assertEqual(set(raw.state_dict()), set(normalized.state_dict()))
        for key, value in raw.state_dict().items():
            torch.testing.assert_close(value, normalized.state_dict()[key], rtol=0, atol=0)
        batch = torch.rand(2, 6, 8, 8)
        raw.eval()(batch)
        torch.testing.assert_close(raw.encoder.seen[0], batch, rtol=0, atol=0)

    def test_recorded_metadata_survives_evaluation_without_consulting_current_defaults(self):
        recipe = {'args': {'rgb_normalization': 'pretrained'}, 'rgb_normalization': self.settings}
        state = {'rgb_normalization': self.settings}
        results = {'rgb_normalization': self.settings}
        self.assertEqual(recorded(state, recipe, results=results), self.settings)
        with self.assertRaisesRegex(ValueError, 'override'):
            recorded(state, recipe, results=results, override='none')
        changed = copy.deepcopy(results)
        changed['rgb_normalization']['mean'][0] += .01
        with self.assertRaisesRegex(ValueError, 'differ'):
            recorded(state, recipe, results=changed)

    def test_historical_raw_checkpoints_are_distinct_from_missing_new_metadata(self):
        self.assertEqual(recorded({}, {'args': {}}, results={}), definition('none'))
        with self.assertRaisesRegex(ValueError, 'differ'):
            recorded({}, {'args': {'rgb_normalization': 'pretrained'}}, results={})
        with self.assertRaisesRegex(ValueError, 'differ'):
            recorded({'rgb_normalization': self.settings}, {'args': {}}, results={})

    def test_invalid_statistics_are_rejected_before_inference(self):
        for field, values in [('std', [0, 1, 1]), ('std', [1, -1, 1]), ('mean', [float('nan'), 0, 0]),
                              ('mean', [True, 0, 0]), ('mean', [0, 0])]:
            with self.subTest(field=field, values=values), self.assertRaises(ValueError):
                validate_definition({**self.settings, field: values})


if __name__ == '__main__':
    unittest.main()
