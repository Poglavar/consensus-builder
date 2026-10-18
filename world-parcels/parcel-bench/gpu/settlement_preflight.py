#!/usr/bin/env python3
"""Verify frozen inputs and exercise both settlement samplers on the rented CUDA worker."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
BENCH = ROOT / 'world-parcels/parcel-bench'
sys.path[:0] = [str(BENCH / 'layered'), str(BENCH / 'gpu'), str(BENCH)]
import torch
from train import TileIndex, RECIPE_FILES, subset_ids
from ledger import recipe_hash
from normalization_preflight import verify_runtime, verify_pretrained
from settlement_sampling import load_definition, draw_indices, exposure_record


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan-sha256', required=True)
    args = parser.parse_args()
    path = BENCH / 'gpu/plans/selection-v5-settlement.json'
    assert digest(path) == args.plan_sha256
    plan = json.loads(path.read_text())
    assert torch.cuda.is_available() and torch.cuda.device_count() == 1
    assert recipe_hash(RECIPE_FILES) == plan['frozen_inputs']['recipe_hash']
    for relative, expected in plan['sources'].items():
        assert digest(BENCH / relative) == expected, relative
    for relative, expected in plan['frozen_inputs']['files'].items():
        assert digest(BENCH / relative) == expected, relative
    dataset = ROOT / 'data/dataset'
    assert digest(dataset / 'manifest.json') == plan['frozen_inputs']['dataset_manifest_sha256']
    samples = json.loads((dataset / 'manifest.json').read_text())['samples']
    assert len(samples) == 3848
    checked = 0
    for sample in samples:
        for kind in ('image', 'truth', 'input', 'osm_input'):
            file = (dataset / sample[kind]).resolve(strict=True)
            assert file.is_relative_to(dataset.resolve()) and file.is_file()
            assert digest(file) == sample['sha256'][kind], (sample['id'], kind)
            checked += 1
    manifest_path = BENCH / 'manifests/settlement-v1/manifest.json'
    index = TileIndex(manifest_path, dataset)
    assert len(index.ids('train')) == 2699 and len(index.ids('selection')) == 46
    runtime = verify_runtime(plan)
    pretrained = verify_pretrained(plan)
    runtime_dir = ROOT / 'runs' / (plan['name'] + '-runtime')
    runtime_dir.mkdir(parents=True, exist_ok=True)
    # Production architecture and input size; only the number of samples is reduced.
    mini = json.loads(manifest_path.read_text())
    selected = mini['splits']['selection']['tiles'][:2]
    mini['splits']['selection']['tiles'] = selected
    mini['selection_groups'] = [dict(name='preflight', tiles=[r['id'] for r in selected], weight=1)]
    mini_path = runtime_dir / 'mini-manifest.json'
    mini_path.write_text(json.dumps(mini))
    train_ids = subset_ids(index.ids('train'), 2, 1)
    proofs = {}
    for arm in ('uniform', 'targeted'):
        original = json.loads((BENCH / f'manifests/settlement-v1/{arm}.json').read_text())
        weights_path = runtime_dir / f'{arm}-weights.json'
        weights_path.write_text(json.dumps({'format': 1, 'weights': {t: original['weights'][t] for t in train_ids}}))
        out = runtime_dir / arm
        command = [sys.executable, str((BENCH / 'layered/train.py').relative_to(ROOT)), '--dataset', str(dataset.relative_to(ROOT)),
                   '--manifest', str(mini_path.relative_to(ROOT)), '--output', str(out.relative_to(ROOT)), '--device', 'cuda',
                   '--epochs', '1', '--eval-every', '1', '--train-tiles', '2', '--seed', '1',
                   '--size', '512', '--recon-size', '256', '--batch', '2', '--workers', '0',
                   '--eval-workers', '2', '--thresholds', '.3', '--interior-seeds', 'off',
                   '--hard-barrier', 'off', '--sampling-weights', str(weights_path.relative_to(ROOT)),
                   '--epoch-samples', '4', '--run']
        subprocess.run(command, check=True)
        # Restore the exact same draw schedule after a checkpoint restart.
        resumed = list(command)
        resumed[resumed.index('--epochs')+1] = '2'
        subprocess.run(resumed + ['--resume'], check=True)
        subprocess.run(command + ['--evaluate-only'], check=True)
        journal = [json.loads(line) for line in (out / 'journal.jsonl').read_text().splitlines()]
        definition = load_definition(weights_path, train_ids)
        samples_seen = [r for r in journal if r['kind'] == 'sampling']
        assert samples_seen == [exposure_record(definition, train_ids,
            draw_indices(definition, train_ids, 4, 1, epoch), epoch, 4) for epoch in range(2)]
        steps = [r for r in journal if r['kind'] == 'step']
        assert len(steps) == 4 and all(math.isfinite(r['loss']) for r in steps)
        summary = json.loads((out / 'selection-eval/summary.json').read_text())
        assert summary['selection_aggregation']['method'] == 'weighted_macro_mean_of_group_pools'
        proofs[arm] = dict(cuda_training=True, resume=True, evaluate=True, optimizer_steps=len(steps),
                           sampling_records_verified=True, selected_config=summary['best_config'])
    result = dict(plan_sha256=args.plan_sha256, runtime=runtime, pretrained=pretrained,
                  frozen_inputs=dict(recipe_hash=plan['frozen_inputs']['recipe_hash'],
                    dataset_manifest_sha256=plan['frozen_inputs']['dataset_manifest_sha256'],
                    dataset_files_verified=checked), cuda_flows=proofs)
    (runtime_dir / 'preflight.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'preflight': 'passed', 'files_verified': checked, 'cuda_flows': proofs}), flush=True)


if __name__ == '__main__':
    main()
