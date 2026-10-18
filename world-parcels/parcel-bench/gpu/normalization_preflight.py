#!/usr/bin/env python3
"""CUDA-only input/runtime preflight for the frozen selection-v4 RGB normalization plan.

Run from the remote project root (containing world-parcels/parcel-bench and data/dataset).
The check verifies frozen inputs, the pinned runtime and pretrained model, then records a
production 512 px cache proof showing RGB-only normalization at the encoder boundary.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np


ROOT = Path.cwd()
BENCH = ROOT / 'world-parcels' / 'parcel-bench'
LAYERED = BENCH / 'layered'
GPU = BENCH / 'gpu'
sys.path.insert(0, str(LAYERED))
sys.path.insert(0, str(BENCH))

import train  # noqa: E402
from ledger import recipe_hash  # noqa: E402
from rgb_normalization import definition as normalization_definition  # noqa: E402
from target_config import cache_namespace, target_definition  # noqa: E402


EXPECTED_NORMALIZATION = {
    'format': 1, 'mode': 'pretrained', 'mean': [.485, .456, .406],
    'std': [.229, .224, .225], 'pretrained_model': 'timm/convnext_tiny.in12k_ft_in1k',
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def package_version(name: str):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def verify_runtime(plan: dict):
    expected = plan['runtime']['critical_packages']
    actual = {name: package_version(name) for name in expected}
    mismatches = {name: {'expected': version, 'actual': actual[name]}
                  for name, version in expected.items() if actual[name] != version}
    require(not mismatches, f'critical package version mismatch: {mismatches}')
    return {'critical_packages': actual,
            'reference_environment': plan['runtime']['reference_environment']}


def verify_pretrained(plan: dict):
    import torch
    from huggingface_hub import snapshot_download

    runtime = plan['runtime']
    require(torch.cuda.is_available(), 'CUDA is required; this preflight must run on the rented GPU')
    require(torch.cuda.device_count() == 1,
            f'expected exactly one rented CUDA device, found {torch.cuda.device_count()}')
    device_name = torch.cuda.get_device_name(0)
    require('4090' in device_name, f'expected rented RTX 4090, found {device_name}')
    repo, revision, filename = (runtime['pretrained_repository'], runtime['pretrained_revision'],
                                runtime['pretrained_file'])
    # This preflight is intentionally offline: the pinned snapshot must already be staged.
    snapshot = Path(snapshot_download(repo_id=repo, revision=revision,
                                      allow_patterns=[filename], local_files_only=True))
    require(snapshot.name == revision, f'Hugging Face resolved {repo} to {snapshot.name}, expected {revision}')
    path = snapshot / filename
    require(path.is_file(), f'pinned pretrained file is absent from the local cache: {path}')
    digest = sha256(path)
    require(digest == runtime['pretrained_file_sha256'],
            f'pretrained file sha256 mismatch: expected {runtime["pretrained_file_sha256"]}, got {digest}')
    refs = snapshot.parent.parent / 'refs'
    refs.mkdir(parents=True, exist_ok=True)
    (refs / 'main').write_text(revision)
    child_code = r'''import json, torch
from model import ParcelNet
cfg = {'format': 1, 'mode': 'pretrained', 'mean': [.485,.456,.406],
       'std': [.229,.224,.225], 'pretrained_model': 'timm/convnext_tiny.in12k_ft_in1k'}
model = ParcelNet('convnext_tiny', in_chans=6, pretrained=True, rgb_normalization=cfg).to('cuda').eval()
with torch.inference_mode():
    output = model(torch.zeros((1, 6, 512, 512), device='cuda'))
    assert set(output) == {'boundary', 'interior', 'distance'}
    assert all(tuple(value.shape) == (1, 1, 512, 512) for value in output.values())
    assert all(torch.isfinite(value).all().item() for value in output.values())
    torch.cuda.synchronize()
print(json.dumps({'outputs': sorted(output), 'inference_shape': [1, 6, 512, 512]}))'''
    child_environment = dict(os.environ)
    child_environment.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    child_environment['PYTHONPATH'] = os.pathsep.join(
        [str(LAYERED), child_environment.get('PYTHONPATH', '')])
    completed = subprocess.run([sys.executable, '-c', child_code], cwd=ROOT,
                               env=child_environment, check=True, capture_output=True, text=True,
                               timeout=900)
    inference = json.loads(completed.stdout.strip().splitlines()[-1])
    return {'repo': repo, 'revision': revision, 'file': filename, 'sha256': digest,
            'cuda_device': device_name, 'local_files_only': True,
            'hf_hub_offline_inference': inference}


def verify_frozen_inputs(plan: dict):
    frozen = plan['frozen_inputs']
    dataset = ROOT / 'data' / 'dataset'
    manifest_path = dataset / 'manifest.json'
    require(manifest_path.is_file(), f'missing dataset manifest: {manifest_path}')
    manifest_sha = sha256(manifest_path)
    require(manifest_sha == frozen['dataset_manifest_sha256'],
            f'dataset manifest sha256 mismatch: {manifest_sha}')
    samples = json.loads(manifest_path.read_text())['samples']
    require(len(samples) == 3103, f'expected 3103 samples, found {len(samples)}')
    sample_ids = [sample.get('id') for sample in samples]
    require(None not in sample_ids and len(set(sample_ids)) == len(sample_ids),
            'dataset sample ids must be present and unique')
    dataset_root = dataset.resolve(strict=True)
    checked_files = 0
    for number, sample in enumerate(samples, 1):
        hashes = sample.get('sha256') or {}
        for key in ('image', 'truth', 'input', 'osm_input'):
            rel = sample.get(key)
            require(rel, f"{sample.get('id')}: missing dataset file key {key}")
            path = (dataset / rel).resolve(strict=True)
            try:
                path.relative_to(dataset_root)
            except ValueError as error:
                raise RuntimeError(f"{sample.get('id')}: {key} resolves outside dataset root") from error
            require(path.is_file(), f"{sample.get('id')}: missing {key} file")
            expected = hashes.get(key)
            require(expected and sha256(path) == expected,
                    f"{sample.get('id')}: {key} sha256 mismatch")
            checked_files += 1
        if number % 250 == 0:
            print(f'verified {number}/{len(samples)} sample records ({checked_files} files)', flush=True)

    indexes, manifests = {}, {}
    for name in ('zagreb-v2', 'split-v2'):
        path = BENCH / 'manifests' / f'{name}.json'
        require(path.is_file(), f'missing manifest: {path}')
        digest = sha256(path)
        require(digest == frozen['manifests'][name], f'{name} manifest sha256 mismatch: {digest}')
        manifests[name] = {'path': str(path.relative_to(ROOT)), 'sha256': digest}
        indexes[name] = train.TileIndex(path, dataset)
    zagreb, split = indexes['zagreb-v2'], indexes['split-v2']
    train_ids = zagreb.ids('train')
    zagreb_selection, split_selection = zagreb.ids('selection'), split.ids('selection')
    require(len(train_ids) == frozen['eligible_training_tiles'] == 1623,
            f'expected 1623 eligible Zagreb training tiles, found {len(train_ids)}')
    expected_selection = frozen['selection_tiles_per_city']
    require(len(zagreb_selection) == len(split_selection) == expected_selection == 48,
            f'expected 48 selection tiles each; Zagreb={len(zagreb_selection)}, Split={len(split_selection)}')
    exposure = zagreb.exposure(train_ids, zagreb_selection)
    train.validate_exposure(exposure, zagreb.manifest)
    actual_recipe = recipe_hash(train.RECIPE_FILES)
    require(actual_recipe == frozen['recipe_hash'],
            f'training recipe hash mismatch: expected {frozen["recipe_hash"]}, got {actual_recipe}')
    for relative, expected in plan['sources'].items():
        require(sha256(BENCH / relative) == expected,
                f'frozen source SHA256 mismatch: {relative}')
    return dataset, indexes, {
        'dataset': str(dataset.relative_to(ROOT)), 'dataset_manifest_sha256': manifest_sha,
        'samples': len(samples), 'verified_dataset_files': checked_files, 'manifests': manifests,
        'zagreb_training_tiles': len(train_ids), 'zagreb_selection_tiles': len(zagreb_selection),
        'split_selection_tiles': len(split_selection),
        'exposure_sha256': hashlib.sha256(json.dumps(
            exposure, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        'recipe_hash': actual_recipe,
    }


def normalization_cache_proof(dataset: Path, index: train.TileIndex, plan: dict,
                              proof_dir: Path) -> dict:
    import torch
    from model import ParcelNet

    target = target_definition(512, cap_m=12.0, dilate_px=1, margin_px=2)
    require(plan['target_definition'] == target, 'plan target definition differs from margin-2 cache proof')
    namespace = cache_namespace(target)
    cache_dir = ROOT / 'runs' / 'selection-v4-normalization' / 'cache' / namespace
    ids = index.ids('train') + index.ids('selection')
    cache = train.load_cache([index.tiles[tile_id] for tile_id in ids], 512, 12.0, 1,
                             cache_dir, margin_px=2)
    selected = next((tile_id for tile_id in ids if index.tiles[tile_id]['osm'] is not None), None)
    require(selected is not None, 'no production cache tile with OSM is available for the encoder proof')
    entry, arrays = index.tiles[selected], cache[selected]
    cache_path = cache_dir / f'{selected}.npz'
    with np.load(cache_path) as stored:
        stored_arrays = {key: stored[key].copy() for key in stored.files}
    stored_target = json.loads(str(stored_arrays['target_definition'].item()))
    require(stored_target == target, f'{selected}: production cache target definition is not margin 2')
    for key in ('image', 'osm', 'boundary', 'interior', 'distance'):
        require(np.array_equal(arrays[key], stored_arrays[key]),
                f'{selected}: loader output differs from persisted cache for {key}')

    normalization = normalization_definition('pretrained', 'convnext_tiny')
    require(normalization == EXPECTED_NORMALIZATION,
            f'timm pretrained normalization differs from plan: {normalization}')
    require(plan['rgb_normalization'] == normalization,
            'plan RGB normalization differs from the actual timm pretrained configuration')
    raw = np.concatenate([arrays['image'].astype(np.float32),
                          arrays['osm'].astype(np.float32)], axis=0)
    raw_tensor = torch.from_numpy(raw[None]).to('cuda')
    mean = torch.tensor(normalization['mean'], dtype=raw_tensor.dtype, device='cuda')[None, :, None, None]
    std = torch.tensor(normalization['std'], dtype=raw_tensor.dtype, device='cuda')[None, :, None, None]
    expected_rgb = (raw_tensor[:, :3] - mean) / std

    torch.manual_seed(241018)
    raw_model = ParcelNet('convnext_tiny', in_chans=6, pretrained=True).to('cuda').eval()
    torch.manual_seed(241018)
    normalized_model = ParcelNet('convnext_tiny', in_chans=6, pretrained=True,
                                 rgb_normalization=normalization).to('cuda').eval()
    raw_parameters = dict(raw_model.named_parameters())
    normalized_parameters = dict(normalized_model.named_parameters())
    require(raw_parameters.keys() == normalized_parameters.keys(),
            'normalized and raw models have different learned parameter names')
    parameters_identical = all(torch.equal(raw_parameters[name], normalized_parameters[name])
                               for name in raw_parameters)
    require(parameters_identical, 'raw and normalized models did not initialize identical parameters')

    observed_raw, observed_normalized = {}, {}

    def capture(destination):
        def hook(_module, inputs):
            destination['input'] = inputs[0].detach().clone()
        return hook

    raw_hook = raw_model.encoder.register_forward_pre_hook(capture(observed_raw))
    norm_hook = normalized_model.encoder.register_forward_pre_hook(capture(observed_normalized))
    with torch.inference_mode():
        raw_out = raw_model(raw_tensor)
        normalized_out = normalized_model(raw_tensor)
        torch.cuda.synchronize()
    raw_hook.remove()
    norm_hook.remove()
    raw_seen, normalized_seen = observed_raw['input'], observed_normalized['input']
    max_error = float((normalized_seen[:, :3] - expected_rgb).abs().max().item())
    rgb_matches = torch.allclose(normalized_seen[:, :3], expected_rgb, rtol=1e-6, atol=1e-6)
    osm_unchanged = torch.equal(normalized_seen[:, 3:], raw_tensor[:, 3:])
    cache_unchanged = all(np.array_equal(arrays[key], stored_arrays[key])
                          for key in ('image', 'osm', 'boundary', 'interior', 'distance'))
    cache_unchanged = cache_unchanged and np.array_equal(raw_tensor[0, :3].cpu().numpy(), arrays['image'])
    default_is_raw = torch.equal(raw_seen, raw_tensor)
    finite = all(torch.isfinite(value).all().item()
                 for output in (raw_out, normalized_out) for value in output.values())
    require(rgb_matches and osm_unchanged and cache_unchanged and default_is_raw and finite,
            'encoder/cache normalization proof failed')

    proof_dir.mkdir(parents=True, exist_ok=True)
    npz_path = proof_dir / 'rgb-normalization-cache-proof.npz'
    np.savez_compressed(npz_path,
                        raw_rgb=arrays['image'], osm=arrays['osm'],
                        boundary=arrays['boundary'], interior=arrays['interior'],
                        distance=arrays['distance'], target_definition=np.array(
                            json.dumps(target, sort_keys=True)),
                        normalized_rgb=normalized_seen[0, :3].cpu().numpy(),
                        encoder_osm=normalized_seen[0, 3:].cpu().numpy())
    sample = index.samples[selected]
    source_keys = {'image': 'image', 'truth': 'truth', 'osm': 'osm_input'}
    source_hashes = {name: sha256(entry[name]) for name in source_keys}
    for name, key in source_keys.items():
        require(source_hashes[name] == sample['sha256'][key],
                f'{selected}: {name} source hash differs from frozen dataset manifest')
    return {
        'tile_id': selected,
        'cache': {'sha256': sha256(cache_path), 'namespace': namespace,
                  'target_definition': stored_target},
        'rgb_normalization': normalization,
        'rgb_matches_transform': bool(rgb_matches),
        'osm_unchanged': bool(osm_unchanged),
        'cache_unchanged': bool(cache_unchanged),
        'initial_parameters_identical': bool(parameters_identical),
        'default_model_receives_raw_input': bool(default_is_raw),
        'finite_inference': bool(finite),
        'max_rgb_transform_absolute_error': max_error,
        'cache_arrays': {
            key: hashlib.sha256(np.ascontiguousarray(arrays[key]).tobytes()).hexdigest()
            for key in ('image', 'osm', 'boundary', 'interior', 'distance')},
        'source': {name: {'path': str(entry[name].relative_to(dataset)), 'sha256': source_hashes[name]}
                   for name in source_keys},
        'proof_npz': str(npz_path.relative_to(ROOT)),
        'proof_npz_sha256': sha256(npz_path),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=GPU / 'plans' / 'selection-v4-normalization.json')
    parser.add_argument('--plan-sha256')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    plan_path = args.plan if args.plan.is_absolute() else ROOT / args.plan
    require(plan_path.is_file(), f'missing normalization plan: {plan_path}')
    plan_digest = sha256(plan_path)
    if args.run:
        require(args.plan_sha256, '--plan-sha256 is required with --run')
        require(plan_digest == args.plan_sha256,
                f'plan sha256 mismatch: expected {args.plan_sha256}, got {plan_digest}')
    plan = json.loads(plan_path.read_text())
    require(plan.get('name') == 'selection-v4-normalization',
            f'unexpected plan name: {plan.get("name")}')
    require(plan.get('rgb_normalization') == EXPECTED_NORMALIZATION,
            'plan does not freeze the expected pretrained RGB normalization')
    require(plan.get('target_definition') == target_definition(512, cap_m=12.0,
                                                               dilate_px=1, margin_px=2),
            'plan target definition differs from margin-2 baseline')
    if not args.run:
        print(json.dumps({'status': 'dry-run', 'plan': str(plan_path.relative_to(ROOT)),
                          'plan_sha256': plan_digest, 'name': plan['name']}, sort_keys=True))
        return
    dataset, indexes, frozen = verify_frozen_inputs(plan)
    runtime = verify_runtime(plan)
    pretrained = verify_pretrained(plan)
    proof_dir = ROOT / 'runs' / 'selection-v4-normalization-runtime'
    proof = normalization_cache_proof(dataset, indexes['zagreb-v2'], plan, proof_dir)
    payload = {'plan': str(plan_path.relative_to(ROOT)), 'plan_sha256': plan_digest,
               'frozen_inputs': frozen, 'runtime': runtime, 'pretrained': pretrained,
               'production_512_rgb_normalization_proof': proof}
    proof_path = proof_dir / 'preflight.json'
    proof_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'status': 'ok', 'proof': str(proof_path.relative_to(ROOT)),
                      'tile_id': proof['tile_id'], 'recipe_hash': frozen['recipe_hash']}, sort_keys=True))


if __name__ == '__main__':
    main()
