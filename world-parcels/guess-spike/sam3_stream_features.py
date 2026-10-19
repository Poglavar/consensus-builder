#!/usr/bin/env python3
"""Run a frozen CPU SAM 3 backbone with a bounded in-memory tile cache."""
from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
import time

import torch
from PIL import Image

from sam3_compact_features import backbone_to_vision


class StreamingVision:
    """Compute backbone states on demand and cache only a few raw CPU tensors.

    ``dataset`` may be the dataset directory containing ``samples.json`` or an
    iterable of sample dictionaries. The model runner owns checkpoint and source
    provenance; this class only resolves each sample's image and recomputes its
    neck/FPN output on every call. ``backbone_dtype`` can select a faster reduced
    precision backbone; cached states are widened to float32 for the neck, which
    does not recover precision lost in the reduced precision forward pass.
    """

    def __init__(self, backbone, neck, processor, dataset, device="mps", max_cached_tiles=4,
                 backbone_device="cpu", backbone_dtype=torch.float32):
        if max_cached_tiles < 0:
            raise ValueError("max_cached_tiles must be non-negative")
        self.backbone_device = torch.device(backbone_device)
        self.backbone_dtype = backbone_dtype
        self.backbone = backbone.to(device=self.backbone_device, dtype=backbone_dtype).eval()
        self.neck = neck.to(device).eval()
        self.processor = processor
        self.device = torch.device(device)
        self.max_cached_tiles = max_cached_tiles
        self._hidden_states = OrderedDict()
        self._samples = self._load_samples(dataset)
        self.tiles_computed = 0
        self.cache_hits = 0
        self.backbone_seconds = 0.0
        self.neck_seconds = 0.0

        for parameter in self.backbone.parameters():
            parameter.requires_grad_(False)
        for parameter in self.neck.parameters():
            parameter.requires_grad_(False)

    @staticmethod
    def _load_samples(dataset):
        if isinstance(dataset, (str, Path)):
            root = Path(dataset)
            payload = json.loads((root / "samples.json").read_text())
            samples = payload["samples"] if isinstance(payload, dict) else payload
        else:
            root = None
            samples = list(dataset)
        if not isinstance(samples, list):
            raise ValueError("Dataset samples must be a list")
        indexed = {}
        for sample in samples:
            tile_id, image = sample.get("id"), sample.get("image")
            if not isinstance(tile_id, str) or not tile_id or not isinstance(image, str):
                raise ValueError("Each dataset sample needs a string id and image path")
            if tile_id in indexed:
                raise ValueError(f"Duplicate dataset sample id: {tile_id}")
            indexed[tile_id] = {"image_path": (root / image if root is not None else Path(image))}
        return indexed

    @staticmethod
    def _pixel_values(processor_output):
        if isinstance(processor_output, dict):
            value = processor_output.get("pixel_values")
        else:
            value = getattr(processor_output, "pixel_values", None)
        if not isinstance(value, torch.Tensor):
            raise ValueError("SAM 3 image processor did not return a pixel_values tensor")
        return value

    def _hidden_state(self, tile_id):
        if tile_id in self._hidden_states:
            self.cache_hits += 1
            self._hidden_states.move_to_end(tile_id)
            return self._hidden_states[tile_id]
        if tile_id not in self._samples:
            raise KeyError(f"Unknown tile id: {tile_id}")

        image_path = self._samples[tile_id]["image_path"]
        if not image_path.is_file():
            raise FileNotFoundError(f"Dataset image is missing for {tile_id}: {image_path}")
        with Image.open(image_path) as image:
            processed = self.processor(images=image.convert("RGB"), return_tensors="pt")
        pixel_values = self._pixel_values(processed).to(
            device=self.backbone_device, dtype=self.backbone_dtype)
        started = time.monotonic()
        with torch.no_grad():
            output = self.backbone(pixel_values)
        self.backbone_seconds += time.monotonic() - started
        hidden_states = getattr(output, "last_hidden_state", None)
        if not isinstance(hidden_states, torch.Tensor) or hidden_states.ndim != 3:
            raise ValueError(f"Backbone returned malformed hidden states for {tile_id}")
        if not hidden_states.is_floating_point():
            raise ValueError(f"Backbone hidden states for {tile_id} are not floating point")
        hidden_states = hidden_states.detach().to(device="cpu", dtype=torch.float32).contiguous()
        self.tiles_computed += 1

        if self.max_cached_tiles:
            self._hidden_states[tile_id] = hidden_states
            self._hidden_states.move_to_end(tile_id)
            while len(self._hidden_states) > self.max_cached_tiles:
                self._hidden_states.popitem(last=False)
        return hidden_states

    def get_vision(self, tile_id):
        """Return regenerated SAM 3 vision/FPN outputs for a tile id."""
        hidden_states = self._hidden_state(tile_id)
        started = time.monotonic()
        result = backbone_to_vision(self.neck, hidden_states.to(self.device))
        self.neck_seconds += time.monotonic() - started
        return result

    def __call__(self, tile_id):
        return self.get_vision(tile_id)

    @property
    def stats(self):
        return {
            "tiles_computed": self.tiles_computed,
            "cache_hits": self.cache_hits,
            "cached_tiles": len(self._hidden_states),
            "max_cached_tiles": self.max_cached_tiles,
            "backbone_device": str(self.backbone_device),
            "backbone_dtype": str(self.backbone_dtype),
            "backbone_parameters": sum(parameter.numel() for parameter in self.backbone.parameters()),
            "backbone_seconds": self.backbone_seconds,
            "neck_seconds": self.neck_seconds,
        }
