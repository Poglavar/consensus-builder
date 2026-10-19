import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

import numpy as np
from PIL import Image
import torch
from torch import nn

from sam3_stream_features import StreamingVision


class FakeProcessor:
    def __call__(self, images, return_tensors="pt"):
        array = np.asarray(images, dtype=np.float32) / 255.0
        pixels = torch.from_numpy(array.copy()).permute(2, 0, 1).unsqueeze(0)
        return {"pixel_values": pixels}


class FakeBackbone(nn.Module):
    def __init__(self):
        super().__init__()
        self.scale = nn.Parameter(torch.tensor(1.0))
        self.calls = 0
        self.grad_modes = []
        self.input_dtypes = []

    def forward(self, pixel_values):
        self.calls += 1
        self.grad_modes.append(torch.is_grad_enabled())
        self.input_dtypes.append(pixel_values.dtype)
        batch, channels, height, width = pixel_values.shape
        values = pixel_values.permute(0, 2, 3, 1).reshape(batch, height * width, channels)
        return SimpleNamespace(last_hidden_state=values * self.scale)


class FakeNeck(nn.Module):
    def __init__(self):
        super().__init__()
        self.scale = nn.Parameter(torch.tensor(2.0))
        self.calls = 0
        self.input_devices = []

    def forward(self, spatial):
        self.calls += 1
        self.input_devices.append(spatial.device.type)
        feature = spatial[:, :2] * self.scale
        position = torch.zeros_like(feature)
        return (feature,), (position,)


class StreamingVisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.samples = []
        for index, tile_id in enumerate(("tile_a", "tile_b", "tile_c")):
            image_path = self.root / f"{tile_id}.png"
            Image.fromarray(np.full((4, 4, 3), index * 50, dtype=np.uint8)).save(image_path)
            self.samples.append({"id": tile_id, "image": image_path.name})
        (self.root / "samples.json").write_text(json.dumps(self.samples))
        self.backbone = FakeBackbone()
        self.neck = FakeNeck()
        self.streaming = StreamingVision(
            self.backbone, self.neck, FakeProcessor(), self.root, device="cpu", max_cached_tiles=2)

    def tearDown(self):
        self.temp.cleanup()

    def test_backbone_is_frozen_cpu_eval_and_neck_is_frozen_eval(self):
        self.assertEqual(next(self.backbone.parameters()).device.type, "cpu")
        self.assertFalse(self.backbone.training)
        self.assertFalse(next(self.backbone.parameters()).requires_grad)
        self.assertFalse(self.neck.training)
        self.assertFalse(next(self.neck.parameters()).requires_grad)

    def test_cache_hits_recompute_neck_without_recomputing_backbone(self):
        first = self.streaming.get_vision("tile_a")
        second = self.streaming("tile_a")
        self.assertTrue(torch.equal(first.last_hidden_state, second.last_hidden_state))
        self.assertTrue(torch.equal(first.fpn_hidden_states[0], second.fpn_hidden_states[0]))
        self.assertEqual(self.backbone.calls, 1)
        self.assertEqual(self.neck.calls, 2)
        self.assertEqual(self.streaming.stats["tiles_computed"], 1)
        self.assertEqual(self.streaming.stats["cache_hits"], 1)
        self.assertEqual(self.streaming.stats["cached_tiles"], 1)
        self.assertFalse(self.backbone.grad_modes[0])

    def test_cpu_hidden_state_lru_is_bounded_and_evicts_least_recently_used(self):
        self.streaming("tile_a")
        self.streaming("tile_b")
        self.streaming("tile_a")  # Make tile_a most recently used.
        self.streaming("tile_c")  # Evicts tile_b.
        self.streaming("tile_b")  # Recomputed after eviction.
        self.assertEqual(self.backbone.calls, 4)
        self.assertEqual(self.streaming.stats["cache_hits"], 1)
        self.assertEqual(self.streaming.stats["cached_tiles"], 2)
        self.assertEqual(set(self.streaming._hidden_states), {"tile_b", "tile_c"})
        self.assertTrue(all(t.device.type == "cpu" for t in self.streaming._hidden_states.values()))
        self.assertEqual(set(self.neck.input_devices), {"cpu"})

    def test_zero_capacity_disables_ram_cache_and_unknown_tiles_fail(self):
        no_cache = StreamingVision(self.backbone, self.neck, FakeProcessor(), self.root,
                                   device="cpu", max_cached_tiles=0)
        no_cache("tile_a")
        no_cache("tile_a")
        self.assertEqual(self.backbone.calls, 2)
        self.assertEqual(no_cache.stats["cached_tiles"], 0)
        with self.assertRaisesRegex(KeyError, "Unknown tile"):
            no_cache("missing")

    def test_backbone_dtype_is_configurable_and_cached_states_are_float32_cpu(self):
        backbone = FakeBackbone()
        neck = FakeNeck()
        streaming = StreamingVision(backbone, neck, FakeProcessor(), self.root,
                                     device="cpu", backbone_device="cpu",
                                     backbone_dtype=torch.float16, max_cached_tiles=1)
        vision = streaming("tile_a")
        self.assertEqual(next(backbone.parameters()).dtype, torch.float16)
        self.assertEqual(backbone.input_dtypes, [torch.float16])
        self.assertEqual(vision.last_hidden_state.dtype, torch.float32)
        self.assertEqual(vision.last_hidden_state.device.type, "cpu")
        self.assertEqual(streaming.stats["backbone_dtype"], "torch.float16")
        self.assertEqual(streaming.stats["backbone_device"], "cpu")
        self.assertEqual(streaming.stats["backbone_parameters"], 1)


if __name__ == "__main__":
    unittest.main()
