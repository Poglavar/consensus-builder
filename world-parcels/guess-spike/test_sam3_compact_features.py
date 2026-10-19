import tempfile
import unittest
from pathlib import Path

import torch
from torch import nn

from sam3_compact_features import (
    FEATURE_BYTES,
    MIN_FREE_BYTES,
    _metadata_paths,
    _source_hash,
    _tensor_metadata,
    _verify_existing,
    atomic_torch_save,
    backbone_to_vision,
    load_vision,
    require_free_space,
    sha256_file,
)


class FakeNeck(nn.Module):
    def __init__(self):
        super().__init__()
        self.input_shape = None
        self.saw_grad = None

    def forward(self, spatial):
        self.input_shape = tuple(spatial.shape)
        self.saw_grad = torch.is_grad_enabled()
        # Deterministic multilevel transform that preserves exact values.
        coarse = spatial[:, :2, ::2, ::2].contiguous()
        fine = spatial[:, :2].contiguous()
        positions = (torch.zeros_like(coarse), torch.zeros_like(fine))
        return (coarse, fine), positions


class CompactFeatureTests(unittest.TestCase):
    def test_raw_backbone_state_regenerates_neck_features_losslessly(self):
        hidden = torch.arange(2 * 16 * 4, dtype=torch.float32).reshape(2, 16, 4)
        neck = FakeNeck()
        result = backbone_to_vision(neck, hidden)

        self.assertEqual(neck.input_shape, (2, 4, 4, 4))
        self.assertFalse(neck.saw_grad)
        self.assertTrue(torch.equal(result.last_hidden_state, hidden))
        self.assertEqual(len(result.fpn_hidden_states), 2)
        expected = hidden.reshape(2, 4, 4, 4).permute(0, 3, 1, 2)[:, :2]
        self.assertTrue(torch.equal(result.fpn_hidden_states[1], expected))
        self.assertTrue(all(not tensor.requires_grad for tensor in result.fpn_hidden_states))

    def test_non_square_sequence_and_non_float32_cache_are_rejected(self):
        neck = FakeNeck()
        with self.assertRaisesRegex(ValueError, "square"):
            backbone_to_vision(neck, torch.zeros(1, 15, 4, dtype=torch.float32))
        with self.assertRaisesRegex(ValueError, "float32"):
            backbone_to_vision(neck, torch.zeros(1, 16, 4, dtype=torch.float16))
        with self.assertRaisesRegex(ValueError, "float32"):
            backbone_to_vision(neck, torch.zeros(1, 16, 4, dtype=torch.int64))

    def test_atomic_cpu_tensor_round_trip_is_bitwise_lossless_and_load_rebuilds_fpn(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            features = root / "features"
            features.mkdir()
            source = torch.randn(1, 16, 4, dtype=torch.float32)
            atomic_torch_save(source, features / "tile_a.pt", root)
            loaded = torch.load(features / "tile_a.pt", weights_only=True)
            self.assertEqual(loaded.device.type, "cpu")
            self.assertEqual(loaded.dtype, torch.float32)
            self.assertTrue(torch.equal(source, loaded))

            neck = FakeNeck()
            vision = load_vision(neck, features, "tile_a", "cpu")
            self.assertTrue(torch.equal(vision.last_hidden_state, source))
            self.assertEqual(neck.input_shape, (1, 4, 4, 4))
            self.assertFalse((features / "tile_a.pt.tmp").exists())

    def test_resume_validates_sidecar_and_feature_content_sha(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset = root / "dataset"
            feature_dir = root / "features"
            dataset.mkdir()
            feature_dir.mkdir()
            image = dataset / "image.bin"
            image.write_bytes(b"source image bytes")
            sample = {"id": "tile_a", "image": "image.bin"}
            source_sha = _source_hash(sample, sha256_file(image))
            expected = {
                "tile_id": "tile_a",
                "image_sha256": sha256_file(image),
                "source_sha256": source_sha,
                "dataset_samples_sha256": "samples-hash",
                "model_revision": "revision",
                "model_weights_sha256": "weights-hash",
                "model_config_sha256": "config-hash",
                "recipe_sha256": "recipe-hash",
            }
            feature_path, metadata_path = _metadata_paths(feature_dir, "tile_a")
            tensor = torch.zeros((1, 5184, 1024), dtype=torch.float32)
            torch.save(tensor, feature_path)
            metadata = {**expected, "feature_sha256": sha256_file(feature_path),
                        "tensor": _tensor_metadata(tensor), "complete": True}
            metadata_path.write_text(__import__("json").dumps(metadata))

            restored, verified = _verify_existing(sample, dataset, feature_dir, expected)
            self.assertTrue(torch.equal(restored, tensor))
            self.assertTrue(verified["complete"])

            feature_path.write_bytes(feature_path.read_bytes() + b"corrupt")
            with self.assertRaisesRegex(ValueError, "content hash"):
                _verify_existing(sample, dataset, feature_dir, expected)

    def test_free_space_guard_requires_one_gibibyte_plus_next_feature_reserve(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(require_free_space(root, free_bytes_fn=lambda _: MIN_FREE_BYTES + FEATURE_BYTES),
                             MIN_FREE_BYTES + FEATURE_BYTES)
            with self.assertRaisesRegex(OSError, "Insufficient free space"):
                require_free_space(root, free_bytes_fn=lambda _: MIN_FREE_BYTES + FEATURE_BYTES - 1)


if __name__ == "__main__":
    unittest.main()
