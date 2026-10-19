#!/usr/bin/env python3
"""Build a lossless, compact SAM 3 backbone-feature cache for local training."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

import torch
from PIL import Image
from transformers.models.sam3.modeling_sam3 import Sam3VisionEncoderOutput


FEATURE_SHAPE = (1, 5184, 1024)
FEATURE_BYTES = FEATURE_SHAPE[0] * FEATURE_SHAPE[1] * FEATURE_SHAPE[2] * 4
MIN_FREE_BYTES = 1024 ** 3
DEFAULT_VERIFICATION_TILES = 4
FORMAT_VERSION = 1


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def backbone_to_vision(neck, hidden_states: torch.Tensor) -> Sam3VisionEncoderOutput:
    """Rebuild SAM 3's FPN output from a cached, unmodified backbone sequence."""
    if not isinstance(hidden_states, torch.Tensor) or hidden_states.ndim != 3:
        raise ValueError("Backbone hidden states must be a (batch, sequence, channels) tensor")
    if not hidden_states.is_floating_point() or hidden_states.dtype != torch.float32:
        raise ValueError("Backbone hidden states must be float32 for a lossless cache")
    batch, sequence, channels = hidden_states.shape
    side = int(sequence ** 0.5)
    if side * side != sequence:
        raise ValueError(f"Backbone sequence length must be square, got {sequence}")
    with torch.no_grad():
        spatial = hidden_states.reshape(batch, side, side, channels).permute(0, 3, 1, 2)
        fpn_hidden_states, fpn_position_encoding = neck(spatial)
    return Sam3VisionEncoderOutput(
        last_hidden_state=hidden_states,
        fpn_hidden_states=tuple(fpn_hidden_states),
        fpn_position_encoding=tuple(fpn_position_encoding),
    )


def load_vision(neck, feature_dir: Path, tile_id: str, device) -> Sam3VisionEncoderOutput:
    """Load one verified-format raw hidden-state tensor and regenerate its FPN."""
    path = Path(feature_dir) / f"{tile_id}.pt"
    hidden_states = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(hidden_states, torch.Tensor):
        raise ValueError(f"Feature cache {path} does not contain a tensor")
    if hidden_states.dtype != torch.float32:
        raise ValueError(f"Feature cache {path} is {hidden_states.dtype}, expected float32")
    return backbone_to_vision(neck, hidden_states.to(device))


def require_free_space(directory: Path, reserve_bytes: int = FEATURE_BYTES,
                       free_bytes_fn=None) -> int:
    """Require a 1 GiB safety margin plus space for the next raw feature tensor."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    free = (free_bytes_fn or (lambda path: shutil.disk_usage(path).free))(directory)
    required = MIN_FREE_BYTES + reserve_bytes
    if free < required:
        raise OSError(f"Insufficient free space at {directory}: {free} bytes free; "
                      f"need at least {required} bytes (1 GiB reserve plus next feature)")
    return free


def atomic_torch_save(value, path: Path, directory: Path) -> None:
    path = Path(path)
    require_free_space(directory)
    temporary = path.with_suffix(path.suffix + ".tmp")
    if path.exists() or temporary.exists():
        raise FileExistsError(f"Refusing to overwrite existing feature artifact: {path}")
    try:
        torch.save(value, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json_save(value, path: Path, directory: Path) -> None:
    path = Path(path)
    require_free_space(directory)
    temporary = path.with_suffix(path.suffix + ".tmp")
    if temporary.exists():
        raise FileExistsError(f"Refusing to overwrite existing metadata artifact: {path}")
    try:
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sample_list(path: Path):
    value = json.loads(path.read_text())
    samples = value["samples"] if isinstance(value, dict) else value
    if not isinstance(samples, list) or not samples:
        raise ValueError("Dataset samples.json must contain a non-empty sample list")
    ids = [sample.get("id") for sample in samples]
    if any(not isinstance(tile_id, str) or not tile_id for tile_id in ids):
        raise ValueError("Every dataset sample must have a non-empty string id")
    if len(set(ids)) != len(ids):
        raise ValueError("Dataset sample IDs must be unique")
    if any(not isinstance(sample.get("image"), str) for sample in samples):
        raise ValueError("Every dataset sample must name an image path")
    return samples


def _model_hashes(snapshot: Path):
    files = sorted(path for path in Path(snapshot).rglob("*") if path.is_file())
    weights = [path for path in files if path.suffix in {".safetensors", ".bin"}]
    configs = [path for path in files if path.name.endswith(".json")]
    if not weights:
        raise ValueError(f"No local SAM 3 weight files found in {snapshot}")
    if not configs:
        raise ValueError(f"No local SAM 3 JSON config files found in {snapshot}")

    def aggregate(paths):
        return sha256_json([(path.relative_to(snapshot).as_posix(), sha256_file(path))
                            for path in paths])
    return aggregate(weights), aggregate(configs)


def _source_hash(sample, image_sha256: str) -> str:
    return sha256_json({"sample": sample, "image_sha256": image_sha256})


def _tensor_metadata(tensor):
    return {"shape": list(tensor.shape), "dtype": str(tensor.dtype),
            "bytes": tensor.numel() * tensor.element_size()}


def _max_abs(left: torch.Tensor, right: torch.Tensor) -> float:
    if left.shape != right.shape:
        raise ValueError(f"FPN tensor shape mismatch: {tuple(left.shape)} != {tuple(right.shape)}")
    if left.numel() == 0:
        return 0.0
    return float((left.detach().cpu() - right.detach().cpu()).abs().max())


def _compare_fpn(actual, expected, label):
    if len(actual) != len(expected):
        raise ValueError(f"{label} FPN level count mismatch: {len(actual)} != {len(expected)}")
    levels = []
    for index, (got, want) in enumerate(zip(actual, expected)):
        got_cpu, want_cpu = got.detach().cpu(), want.detach().cpu()
        maximum = _max_abs(got_cpu, want_cpu)
        try:
            torch.testing.assert_close(got_cpu, want_cpu, rtol=1e-5, atol=1e-5)
        except AssertionError as exc:
            raise ValueError(f"{label} FPN level {index} differs (max abs {maximum:g})") from exc
        levels.append({"level": index, "exact_equal": torch.equal(got_cpu, want_cpu),
                       "max_abs_difference": maximum})
    return levels


def _source_snapshot(output: Path, script_path: Path, dependency_path: Path, directory: Path):
    snapshot_dir = output / "source_snapshot"
    hashes = {}
    for source in (script_path, dependency_path):
        content_hash = sha256_file(source)
        name = source.name
        target = snapshot_dir / name
        if target.exists():
            if sha256_file(target) != content_hash:
                raise ValueError(f"Existing source snapshot differs: {target}")
        else:
            require_free_space(directory)
            snapshot_dir.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".tmp")
            try:
                shutil.copyfile(source, temporary)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        hashes[name] = content_hash
    return hashes


def _metadata_paths(feature_dir: Path, tile_id: str):
    return feature_dir / f"{tile_id}.pt", feature_dir / f"{tile_id}.json"


def _verify_existing(sample, dataset: Path, feature_dir: Path, expected: dict):
    feature_path, metadata_path = _metadata_paths(feature_dir, sample["id"])
    if not feature_path.exists() or not metadata_path.exists():
        raise ValueError(f"Incomplete cached feature for {sample['id']}; preserve and inspect the cache")
    metadata = json.loads(metadata_path.read_text())
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"Cached feature metadata mismatch for {sample['id']}: {key}")
    if metadata.get("complete") is not True:
        raise ValueError(f"Cached feature for {sample['id']} is not marked complete")
    actual_hash = sha256_file(feature_path)
    if metadata.get("feature_sha256") != actual_hash:
        raise ValueError(f"Cached feature content hash mismatch for {sample['id']}")
    tensor = torch.load(feature_path, map_location="cpu", weights_only=True)
    if not isinstance(tensor, torch.Tensor) or tensor.dtype != torch.float32:
        raise ValueError(f"Cached feature tensor for {sample['id']} is not float32")
    if tuple(tensor.shape) != FEATURE_SHAPE:
        raise ValueError(f"Cached feature tensor for {sample['id']} has shape {tuple(tensor.shape)}; "
                         f"expected {FEATURE_SHAPE}")
    if metadata.get("tensor") != _tensor_metadata(tensor):
        raise ValueError(f"Cached feature tensor metadata mismatch for {sample['id']}")
    return tensor, metadata


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Build the local feature cache")
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--cache", type=Path, help="Existing local Hugging Face cache")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", choices=["mps", "cpu", "cuda"], default="mps")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--verify-old-features", type=Path,
                        help="Optional directory containing original tile FPN .pt files")
    parser.add_argument("--verification-tiles", type=int, default=DEFAULT_VERIFICATION_TILES)
    parser.add_argument("--max-tiles", type=int,
                        help="Process only the first N tiles; this execution limit is not part of the recipe")
    args = parser.parse_args(argv)
    if args.verification_tiles < 0:
        parser.error("--verification-tiles must be non-negative")
    if args.max_tiles is not None and args.max_tiles < 1:
        parser.error("--max-tiles must be positive")
    if args.run and not all((args.dataset, args.cache, args.output)):
        parser.error("--dataset, --cache and --output are required with --run")
    return args


def main(argv=None):
    args = _parse_args(argv)
    if not args.run:
        _parse_args(["--help"])
        return
    dataset = args.dataset.resolve()
    output = args.output.resolve()
    feature_dir = output / "features"
    samples_path = dataset / "samples.json"
    samples = _sample_list(samples_path)
    samples_sha256 = sha256_file(samples_path)

    from huggingface_hub import snapshot_download
    from transformers import Sam3Model, Sam3Processor
    from sam3_finetune import REVISION

    snapshot = Path(snapshot_download(
        "facebook/sam3", revision=REVISION, cache_dir=str(args.cache),
        local_files_only=True, allow_patterns=["*.json", "*.txt", "*.model", "*.safetensors", "*.bin"],
    ))
    model_weight_sha256, model_config_sha256 = _model_hashes(snapshot)
    script_path = Path(__file__).resolve()
    dependency_path = script_path.with_name("sam3_finetune.py")
    source_snapshot_hashes = {path.name: sha256_file(path)
                              for path in (script_path, dependency_path)}

    recipe = {
        "format_version": FORMAT_VERSION,
        "dataset_samples_sha256": samples_sha256,
        "dataset_sample_count": len(samples),
        "tile_ids": [sample["id"] for sample in samples],
        "model_revision": REVISION,
        "model_weights_sha256": model_weight_sha256,
        "model_config_sha256": model_config_sha256,
        "processor_snapshot_sha256": model_config_sha256,
        "sources_sha256": source_snapshot_hashes,
        "cache_tensor": "float32 backbone last_hidden_state",
        "expected_tensor_shape": list(FEATURE_SHAPE),
        "metered_api_usd": 0,
    }
    recipe_sha256 = sha256_json(recipe)
    manifest_path = output / "manifest.json"
    output.mkdir(parents=True, exist_ok=True)
    feature_dir.mkdir(parents=True, exist_ok=True)
    if manifest_path.exists():
        if not args.resume:
            raise ValueError("Existing feature cache found; use --resume to verify and continue it")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("recipe") != recipe or manifest.get("recipe_sha256") != recipe_sha256:
            raise ValueError("Existing feature cache belongs to a different dataset/model/source recipe")
    else:
        if args.resume:
            raise ValueError("--resume requires an existing manifest.json")
        existing = list(feature_dir.glob("*.pt")) + list(feature_dir.glob("*.json"))
        if existing:
            raise ValueError("Feature files exist without a manifest; refusing to overwrite them")
        manifest = {"format_version": FORMAT_VERSION, "recipe": recipe,
                    "recipe_sha256": recipe_sha256, "completed_tiles": {},
                    "verification_tiles": {}, "created_at": time.time()}
        atomic_json_save(manifest, manifest_path, output)
    _source_snapshot(output, script_path, dependency_path, output)

    torch.set_num_threads(2)
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is unavailable on this machine")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable on this machine")
    model = Sam3Model.from_pretrained(str(snapshot), local_files_only=True).to(args.device).eval()
    processor = Sam3Processor.from_pretrained(str(snapshot), local_files_only=True)
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    neck = model.vision_encoder.neck

    verification_count = len(manifest.get("verification_tiles", {}))
    limit_samples = samples if args.max_tiles is None else samples[:args.max_tiles]
    started = time.monotonic()
    for index, sample in enumerate(limit_samples, 1):
        tile_id = sample["id"]
        image_path = (dataset / sample["image"]).resolve()
        if not image_path.is_file():
            raise FileNotFoundError(f"Dataset image is missing for {tile_id}: {image_path}")
        image_sha256 = sha256_file(image_path)
        source_sha256 = _source_hash(sample, image_sha256)
        expected = {
            "tile_id": tile_id,
            "image_sha256": image_sha256,
            "source_sha256": source_sha256,
            "dataset_samples_sha256": samples_sha256,
            "model_revision": REVISION,
            "model_weights_sha256": model_weight_sha256,
            "model_config_sha256": model_config_sha256,
            "recipe_sha256": recipe_sha256,
        }
        target, sidecar = _metadata_paths(feature_dir, tile_id)
        staging = feature_dir / f"{tile_id}.unverified.pt"
        if staging.exists() or staging.with_suffix(staging.suffix + ".tmp").exists():
            raise ValueError(f"Unverified feature artifact exists for {tile_id}: {staging}; "
                             "preserving it for inspection and refusing to overwrite")
        entry = manifest["completed_tiles"].get(tile_id)
        if target.exists() or sidecar.exists():
            if not args.resume:
                raise ValueError(f"Feature already exists for {tile_id}; use --resume to verify it")
            tensor, metadata = _verify_existing(sample, dataset, feature_dir, expected)
            if not entry or entry.get("feature_sha256") != metadata["feature_sha256"]:
                raise ValueError(f"Manifest does not verify the cached feature for {tile_id}")
            if entry.get("metadata_sha256") != sha256_file(sidecar):
                raise ValueError(f"Manifest does not verify the feature metadata for {tile_id}")
            direct_vision = None
        else:
            image = Image.open(image_path).convert("RGB")
            inputs = processor(images=image, return_tensors="pt").to(args.device)
            with torch.no_grad():
                direct_vision = model.get_vision_features(inputs.pixel_values)
            tensor = direct_vision.last_hidden_state.detach().to(device="cpu", dtype=torch.float32).contiguous()
            if tuple(tensor.shape) != FEATURE_SHAPE:
                raise ValueError(f"SAM 3 returned unexpected backbone feature shape for {tile_id}: "
                                 f"{tuple(tensor.shape)}; expected {FEATURE_SHAPE}")
            if tensor.numel() * tensor.element_size() != FEATURE_BYTES:
                # Keep the space check tied to the actual configured output while retaining
                # the explicit 21 MiB reserve for the next tile.
                expected_next_bytes = tensor.numel() * tensor.element_size()
            else:
                expected_next_bytes = FEATURE_BYTES
            require_free_space(output, reserve_bytes=expected_next_bytes)
            metadata = {
                **expected,
                "tensor": _tensor_metadata(tensor),
                "complete": True,
                "device": args.device,
                "metered_api_usd": 0,
            }

        verify_path = None
        if (args.verify_old_features is not None and verification_count < args.verification_tiles
                and tile_id not in manifest["verification_tiles"]):
            candidate = args.verify_old_features / f"{tile_id}.pt"
            if candidate.is_file():
                verify_path = candidate
        if verify_path is not None:
            if direct_vision is None:
                image = Image.open(image_path).convert("RGB")
                inputs = processor(images=image, return_tensors="pt").to(args.device)
                with torch.no_grad():
                    direct_vision = model.get_vision_features(inputs.pixel_values)
            if not target.exists():
                # Verify the serialized tensor itself. Keep the staging artifact on any
                # failure so a later resume cannot mistake it for a completed cache entry.
                atomic_torch_save(tensor, staging, output)
                saved_tensor = torch.load(staging, map_location="cpu", weights_only=True)
                if not isinstance(saved_tensor, torch.Tensor) or not torch.equal(saved_tensor, tensor):
                    raise ValueError(f"Serialized backbone feature did not round-trip for {tile_id}; "
                                     f"preserving {staging}")
                tensor = saved_tensor
            replayed = backbone_to_vision(neck, tensor.to(args.device))
            old_fpn = torch.load(verify_path, map_location="cpu", weights_only=True)
            if not isinstance(old_fpn, (tuple, list)):
                raise ValueError(f"Old FPN cache {verify_path} is not a tuple/list")
            direct_levels = tuple(direct_vision.fpn_hidden_states)
            replay_levels = tuple(replayed.fpn_hidden_states)
            old_levels = tuple(old_fpn)
            verification = {
                "direct_vs_replayed": _compare_fpn(replay_levels, direct_levels, "Replayed/direct"),
                "direct_vs_old_cache": _compare_fpn(direct_levels, old_levels, "Direct/old-cache"),
                "replayed_vs_old_cache": _compare_fpn(replay_levels, old_levels, "Replayed/old-cache"),
            }
            metadata["fpn_verification"] = verification
            manifest["verification_tiles"][tile_id] = verification
            verification_count += 1
            del replayed, old_fpn

        if not target.exists():
            if staging.exists():
                os.replace(staging, target)
            else:
                atomic_torch_save(tensor, target, output)
        metadata["feature_sha256"] = sha256_file(target)
        atomic_json_save(metadata, sidecar, output)
        manifest["completed_tiles"][tile_id] = {
            "feature_sha256": metadata["feature_sha256"],
            "metadata_sha256": sha256_file(sidecar),
            "complete": True,
        }
        atomic_json_save(manifest, manifest_path, output)
        if direct_vision is not None:
            del direct_vision
        if "inputs" in locals():
            del inputs
        del tensor
        elapsed = time.monotonic() - started
        eta = elapsed / index * (len(limit_samples) - index)
        print(f"Features {index}/{len(limit_samples)} · {tile_id} · ETA {eta:.0f}s", flush=True)


if __name__ == "__main__":
    main()
