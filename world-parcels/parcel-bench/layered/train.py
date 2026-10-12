#!/usr/bin/env python3
"""Train and evaluate the layered parcel model v0 on a frozen ParcelBench manifest. Inputs: RGB tile plus
OSM building/road/water channels (dropped at random in training so the model tolerates missing OSM).
Outputs: boundary, interior and distance-to-boundary maps. Evaluation reconstructs parcels deterministically
(OSM seeds and barriers plus the learned boundary cost), scores them with parcel-bench/score.py and selects
the checkpoint and reconstruction settings by parcel F1 on the selection split only. Checkpoints every
epoch, resumes with --resume, journals every step; the final split is scored only with --evaluate-only."""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from multiprocessing import get_context
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import score  # noqa: E402
from ledger import recipe_hash  # noqa: E402
from model import ParcelNet  # noqa: E402
from reconstruct import RECON_DEFAULTS, reconstruct  # noqa: E402
from targets import load_image, osm_channels, tile_targets  # noqa: E402

DEFAULT_MANIFEST = HERE.parent / 'manifests' / 'zagreb-v1.json'
RECIPE_FILES = [HERE / 'train.py', HERE / 'model.py', HERE / 'targets.py', HERE / 'reconstruct.py',
                HERE.parent.parent / 'guess-spike' / 'guess.py']


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}", flush=True)


def read_json(path):
    return json.loads(Path(path).read_text())


class TileIndex:
    """Resolves every tile id of the frozen manifest to its image, truth and OSM files in the dataset.
    Training tiles take OSM from the sidecar `train/<id>.osm-input.json` written by export_osm_inputs.py.
    A pool manifest (export_pool.py) may replace the frozen manifest's training pool; the held-out splits never move."""

    def __init__(self, manifest_path, dataset, pool_path=None):
        self.manifest = read_json(manifest_path)
        self.dataset = Path(dataset)
        samples = {sample['id']: sample for sample in read_json(self.dataset / 'manifest.json')['samples']}
        self.tiles = {}
        for split_name in ('selection', 'final'):
            for record in self.manifest['splits'][split_name]['tiles']:
                self.tiles[record['id']] = self.entry(record['id'], samples[record['id']], record['bbox'], split_name)
        pool = read_json(pool_path) if pool_path else None
        built_for = ([m['version'] for m in pool.get('frozen_manifests', [])] or [pool.get('frozen_manifest', {}).get('version')]) if pool else []
        if pool and self.manifest['version'] not in built_for:
            raise ValueError(f"pool {pool.get('version')} was built for {built_for}, not {self.manifest['version']}")
        pool_ids = [tile['id'] for tile in pool['tiles']] if pool else self.manifest['training_pool']['tiles']
        self.pool_name = pool['version'] if pool else f"{self.manifest['version']}:training_pool"
        for tile_id in pool_ids:
            if tile_id in self.tiles:
                raise ValueError(f'{tile_id} is a held-out tile and cannot be in the training pool')
            sample = samples[tile_id]
            self.tiles[tile_id] = self.entry(tile_id, sample, sample['bbox'], 'train')
        self.scoring = self.manifest['scoring']

    def entry(self, tile_id, sample, bbox, split):
        osm = self.dataset / (sample.get('osm_input') or f"{sample['split']}/{tile_id}.osm-input.json")
        return {'id': tile_id, 'split': split, 'bbox': [float(v) for v in bbox], 'image': self.dataset / sample['image'],
                'truth': self.dataset / sample['truth'], 'osm': osm if osm.exists() else None}

    def ids(self, split):
        return [tile_id for tile_id, entry in self.tiles.items() if entry['split'] == split]


def subset_ids(ids, count, seed):
    """Seeded random subset of the training pool, nested: the first `count` of one permutation, so a bigger
    subset with the same seed contains the smaller ones, as a learning curve needs. count 0 = all."""
    order = sorted(ids)
    random.Random(seed).shuffle(order)
    return order[:count] if count else order


def prepare_tile(entry, size, cap_m, dilate_px):
    image = load_image(entry['image'], size)
    targets = tile_targets(read_json(entry['truth']), entry['bbox'], size, dilate_px=dilate_px, cap_m=cap_m)
    osm_input = read_json(entry['osm']) if entry['osm'] else None
    osm = osm_channels(osm_input, entry['bbox'], size) if osm_input else np.zeros((3, size, size), np.float32)
    return {'image': image.astype(np.float16), 'osm': osm.astype(np.uint8), 'boundary': targets['boundary'],
            'interior': targets['interior'], 'distance': targets['distance'].astype(np.float16),
            'osm_present': np.array(osm_input is not None)}


def load_cache(entries, size, cap_m, dilate_px, cache_dir):
    """Per-tile arrays, computed once per (size, cap, dilation) and kept on disk so restarts are quick."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = {}
    for entry in entries:
        path = cache_dir / f"{entry['id']}.npz"
        if not path.exists():
            # Written under a temporary name and renamed, so concurrent runs sharing the cache never read a torn file.
            temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp.npz')
            np.savez_compressed(temporary, **prepare_tile(entry, size, cap_m, dilate_px))
            os.replace(temporary, path)
        with np.load(path) as arrays:
            cache[entry['id']] = {key: arrays[key] for key in arrays.files}
    return cache


class TileDataset(Dataset):
    def __init__(self, cache, ids, *, augment, osm_dropout, seed):
        self.cache, self.ids, self.augment, self.osm_dropout, self.seed, self.epoch = cache, list(ids), augment, osm_dropout, seed, 0

    def __len__(self):
        return len(self.ids)

    def __getitem__(self, index):
        data = self.cache[self.ids[index]]
        image = data['image'].astype(np.float32)
        osm = data['osm'].astype(np.float32)
        boundary = data['boundary'].astype(np.float32)[None]
        interior = data['interior'].astype(np.float32)[None]
        distance = data['distance'].astype(np.float32)[None]
        if self.augment:
            rng = np.random.default_rng([self.seed, self.epoch, index])
            k = int(rng.integers(4))
            flip = bool(rng.random() < 0.5)
            arrays = [image, osm, boundary, interior, distance]
            arrays = [np.rot90(array, k, axes=(1, 2)) for array in arrays]
            if flip:
                arrays = [array[:, :, ::-1] for array in arrays]
            image, osm, boundary, interior, distance = arrays
            if self.osm_dropout and rng.random() < self.osm_dropout:
                osm = np.zeros_like(osm)
        x = np.ascontiguousarray(np.concatenate([image, osm]))
        y = {'boundary': np.ascontiguousarray(boundary), 'interior': np.ascontiguousarray(interior),
             'distance': np.ascontiguousarray(distance)}
        return torch.from_numpy(x), {key: torch.from_numpy(value) for key, value in y.items()}


def loss_terms(outputs, targets, pos_weight):
    boundary_logit, boundary = outputs['boundary'], targets['boundary']
    bce = F.binary_cross_entropy_with_logits(boundary_logit, boundary, pos_weight=pos_weight)
    probability = torch.sigmoid(boundary_logit)
    dice = 1 - (2 * (probability * boundary).sum() + 1) / (probability.sum() + boundary.sum() + 1)
    interior = F.binary_cross_entropy_with_logits(outputs['interior'], targets['interior'])
    distance = (torch.sigmoid(outputs['distance']) - targets['distance']).abs().mean()
    total = bce + dice + 0.5 * interior + distance
    return total, {'boundary_bce': bce.item(), 'boundary_dice': dice.item(), 'interior': interior.item(),
                   'distance': distance.item()}


def config_key(config):
    return f"t{config['threshold']:g}-seeds{int(config['interior_seeds'])}-hard{int(config['hard_barrier'])}"


def reconstruct_and_score(job):
    """Worker: downsample the probability maps to the reconstruction grid, build parcels, score the tile."""
    tile_id, bbox, boundary, interior, distance, osm_input, truth, config, scoring, recon_size = job
    if boundary.shape[0] != recon_size:
        boundary = cv2.resize(boundary, (recon_size, recon_size), interpolation=cv2.INTER_AREA)
        interior = cv2.resize(interior, (recon_size, recon_size), interpolation=cv2.INTER_AREA)
        distance = cv2.resize(distance, (recon_size, recon_size), interpolation=cv2.INTER_AREA)
    collection, _ = reconstruct(boundary, interior, osm_input or {'buildings': [], 'roads': [], 'water': []}, bbox,
                                distance_prob=distance, threshold=config['threshold'], interior_seeds=config['interior_seeds'],
                                hard_barrier=config['hard_barrier'], tile_id=tile_id)
    result = score.score_tile(collection, truth, bbox, tolerance_m=scoring['tolerance_m'],
                              iou_threshold=scoring['iou_threshold'], edge_margin_m=scoring['edge_margin_m'],
                              tile_id=tile_id)
    return config_key(config), tile_id, result, collection


def predict(model, cache, tile_id, device, blank_osm=False):
    data = cache[tile_id]
    osm = np.zeros(data['osm'].shape, np.float32) if blank_osm else data['osm'].astype(np.float32)
    x = np.concatenate([data['image'].astype(np.float32), osm])[None]
    with torch.no_grad():
        outputs = model(torch.from_numpy(x).to(device))
    return {name: torch.sigmoid(outputs[name])[0, 0].float().cpu().numpy() for name in ('boundary', 'interior', 'distance')}


def evaluate(model, index, cache, ids, configs, device, *, recon_size, workers, out_dir=None, osm_mode='full'):
    """Predict every tile once, reconstruct and score under every config, pool per config, pick the best.
    Writes GeoJSON, per-tile scores and pooled.json for the best config when out_dir is given.
    osm_mode 'model-blank' zeroes the model's OSM input channels; 'none' also withholds OSM seeds and barriers
    from reconstruction, the no-OSM city case."""
    model.eval()
    pixel = {'tp': 0, 'fp': 0, 'fn': 0, 'distance_abs': 0.0, 'pixels': 0}
    probabilities, jobs = {}, []
    for tile_id in ids:
        entry = index.tiles[tile_id]
        probabilities[tile_id] = predict(model, cache, tile_id, device, blank_osm=osm_mode != 'full')
        predicted = probabilities[tile_id]['boundary'] > 0.5
        target = cache[tile_id]['boundary'].astype(bool)
        pixel['tp'] += int((predicted & target).sum()); pixel['fp'] += int((predicted & ~target).sum())
        pixel['fn'] += int((~predicted & target).sum())
        pixel['distance_abs'] += float(np.abs(probabilities[tile_id]['distance'] - cache[tile_id]['distance'].astype(np.float32)).sum())
        pixel['pixels'] += int(target.size)
        osm_input = read_json(entry['osm']) if entry['osm'] and osm_mode != 'none' else None
        truth = read_json(entry['truth'])
        for config in configs:
            jobs.append((tile_id, entry['bbox'], probabilities[tile_id]['boundary'], probabilities[tile_id]['interior'],
                         probabilities[tile_id]['distance'], osm_input, truth, config, index.scoring, recon_size))
    if workers > 0:
        with get_context('spawn').Pool(workers) as pool:
            outcomes = list(pool.imap_unordered(reconstruct_and_score, jobs, chunksize=2))
    else:
        outcomes = [reconstruct_and_score(job) for job in jobs]
    by_config = {}
    for key, tile_id, result, collection in outcomes:
        by_config.setdefault(key, {})[tile_id] = (result, collection)
    pooled = {key: score.pool([by_config[key][tile_id][0] for tile_id in ids]) for key in by_config}
    ranking = sorted(pooled, key=lambda key: (-(pooled[key]['metrics']['parcel_f1'] or 0),
                                              -(pooled[key]['metrics']['area_weighted_recall'] or 0), key))
    best = ranking[0]
    precision = pixel['tp'] / max(pixel['tp'] + pixel['fp'], 1)
    recall = pixel['tp'] / max(pixel['tp'] + pixel['fn'], 1)
    summary = {
        'best_config': best, 'configs': {key: pooled[key]['metrics'] for key in pooled}, 'osm_mode': osm_mode,
        'pixel': {'boundary_precision': precision, 'boundary_recall': recall,
                  'boundary_f1': 2 * precision * recall / max(precision + recall, 1e-9),
                  'distance_mae': pixel['distance_abs'] / max(pixel['pixels'], 1)},
    }
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for tile_id in ids:
            result, collection = by_config[best][tile_id]
            (out_dir / f'{tile_id}.geojson').write_text(json.dumps(collection))
            (out_dir / f'{tile_id}.score.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
            np.savez_compressed(out_dir / f'{tile_id}.probabilities.npz', **probabilities[tile_id])
        (out_dir / 'pooled.json').write_text(json.dumps(dict(pooled[best], config=best), indent=2, sort_keys=True) + '\n')
        (out_dir / 'summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
    model.train()
    return summary


def build_configs(thresholds, interior_seeds_options, hard_options):
    return [{'threshold': t, 'interior_seeds': s, 'hard_barrier': h}
            for t in thresholds for s in interior_seeds_options for h in hard_options]


def make_scheduler(optimizer, total_steps, warmup):
    def factor(step):
        if step < warmup:
            return (step + 1) / warmup
        progress = (step - warmup) / max(total_steps - warmup, 1)
        return 0.5 * (1 + math.cos(math.pi * min(progress, 1.0)))
    return torch.optim.lr_scheduler.LambdaLR(optimizer, factor)


def pick_device(name):
    if name == 'auto':
        name = 'cuda' if torch.cuda.is_available() else ('mps' if torch.backends.mps.is_available() else 'cpu')
    return torch.device(name)


def train(args):
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = pick_device(args.device)
    index = TileIndex(args.manifest, args.dataset, args.pool)
    subset_seed = args.subset_seed if args.subset_seed is not None else args.seed
    train_ids = subset_ids(index.ids('train'), args.train_tiles, subset_seed)
    selection_ids = index.ids('selection')[:args.selection_tiles] if args.selection_tiles else index.ids('selection')
    cache_dir = out.parent / 'cache' / f's{args.size}-cap{args.cap_m:g}-d{args.dilate_px}'
    t0 = time.time()
    cache = load_cache([index.tiles[t] for t in train_ids + selection_ids], args.size, args.cap_m, args.dilate_px, cache_dir)
    with_osm = sum(bool(cache[t]['osm_present']) for t in train_ids)
    log(f"cache ready in {time.time() - t0:.0f}s: {len(train_ids)} training tiles ({with_osm} with OSM), "
        f"{len(selection_ids)} selection tiles, size {args.size}, device {device}")
    positives = sum(int(cache[t]['boundary'].sum()) for t in train_ids)
    total = sum(int(cache[t]['boundary'].size) for t in train_ids)
    pos_weight = torch.tensor(min(max((total - positives) / max(positives, 1), 1.0), 20.0), device=device)
    recipe = {'args': {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
              'recipe_hash': recipe_hash(RECIPE_FILES), 'manifest_version': index.manifest['version'],
              'pool': index.pool_name, 'n_train': len(train_ids), 'subset_seed': subset_seed, 'reconstruction': RECON_DEFAULTS,
              'pos_weight': float(pos_weight), 'train_tiles': train_ids, 'selection_tiles': selection_ids}
    (out / 'recipe.json').write_text(json.dumps(recipe, indent=2, sort_keys=True) + '\n')

    model = ParcelNet(args.encoder, in_chans=6, pretrained=not args.no_pretrained).to(device)
    optimizer = torch.optim.AdamW(model.parameter_groups(args.lr, args.encoder_lr_scale), weight_decay=1e-4)
    dataset = TileDataset(cache, train_ids, augment=True, osm_dropout=args.osm_dropout, seed=args.seed)
    steps_per_epoch = min(math.ceil(len(dataset) / args.batch), args.max_steps or 10 ** 9)
    scheduler = make_scheduler(optimizer, steps_per_epoch * args.epochs, warmup=min(50, steps_per_epoch))
    use_amp = device.type == 'cuda'
    amp_dtype = torch.bfloat16 if use_amp and torch.cuda.is_bf16_supported() else torch.float16
    scaler = torch.amp.GradScaler('cuda', enabled=use_amp and amp_dtype == torch.float16)
    configs = build_configs(args.thresholds, [True, False] if args.interior_seeds == 'both' else [args.interior_seeds == 'on'],
                            [False, True] if args.hard_barrier == 'both' else [args.hard_barrier == 'on'])
    start_epoch, best = 0, {'parcel_f1': -1.0}
    journal = (out / 'journal.jsonl').open('a')
    if args.resume and (out / 'last.pt').exists():
        state = torch.load(out / 'last.pt', map_location=device, weights_only=False)
        model.load_state_dict(state['model']); optimizer.load_state_dict(state['optimizer'])
        scheduler.load_state_dict(state['scheduler']); scaler.load_state_dict(state['scaler'])
        start_epoch, best = state['epoch'] + 1, state['best']
        log(f"resumed from epoch {state['epoch']} (best selection parcel F1 {best['parcel_f1']:.3f})")
    global_step = start_epoch * steps_per_epoch
    for epoch in range(start_epoch, args.epochs):
        dataset.epoch = epoch
        loader = DataLoader(dataset, batch_size=args.batch, shuffle=True, num_workers=args.workers, drop_last=False)
        model.train()
        epoch_start, running = time.time(), []
        for step, (x, y) in enumerate(loader):
            if args.max_steps and step >= args.max_steps:
                break
            x = x.to(device, non_blocking=True)
            y = {key: value.to(device, non_blocking=True) for key, value in y.items()}
            with torch.autocast(device_type='cuda', dtype=amp_dtype, enabled=use_amp):
                outputs = model(x)
                loss, terms = loss_terms(outputs, y, pos_weight)
            optimizer.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            scaler.step(optimizer); scaler.update(); scheduler.step()
            global_step += 1
            running.append(float(loss))
            journal.write(json.dumps({'kind': 'step', 'epoch': epoch, 'step': global_step, 'loss': float(loss), **terms,
                                      'lr': scheduler.get_last_lr()[-1]}) + '\n')
            if step % args.log_every == 0 or step == steps_per_epoch - 1:
                rate = (step + 1) * args.batch / max(time.time() - epoch_start, 1e-6)
                eta = (steps_per_epoch - step - 1) * args.batch / max(rate, 1e-6)
                log(f"epoch {epoch + 1}/{args.epochs} step {step + 1}/{steps_per_epoch} loss {np.mean(running[-args.log_every:]):.4f} "
                    f"(bce {terms['boundary_bce']:.3f} dice {terms['boundary_dice']:.3f} int {terms['interior']:.3f} "
                    f"dist {terms['distance']:.3f}) {rate:.1f} tiles/s ETA {eta:.0f}s")
        journal.flush()
        state = {'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'scheduler': scheduler.state_dict(),
                 'scaler': scaler.state_dict(), 'epoch': epoch, 'best': best, 'encoder': args.encoder, 'in_chans': 6,
                 'size': args.size, 'recon_size': args.recon_size}
        torch.save(state, out / 'last.pt')
        if (epoch + 1) % args.eval_every == 0 or epoch + 1 == args.epochs:
            t1 = time.time()
            summary = evaluate(model, index, cache, selection_ids, configs, device, recon_size=args.recon_size,
                               workers=args.eval_workers)
            chosen = summary['configs'][summary['best_config']]
            journal.write(json.dumps({'kind': 'eval', 'epoch': epoch, 'split': 'selection', **summary}) + '\n'); journal.flush()
            log(f"selection after epoch {epoch + 1}: best config {summary['best_config']} parcel F1 "
                f"{chosen['parcel_f1']:.3f} precision {chosen['precision'] or 0:.3f} recall {chosen['recall']:.3f} "
                f"area-weighted recall {chosen['area_weighted_recall']:.3f} boundary F1 {chosen['boundary_f1'] or 0:.3f}; "
                f"pixel boundary F1 {summary['pixel']['boundary_f1']:.3f}; eval {time.time() - t1:.0f}s")
            if (chosen['parcel_f1'] or 0) > best['parcel_f1']:
                best = {'parcel_f1': chosen['parcel_f1'], 'epoch': epoch, 'config': summary['best_config'],
                        'metrics': chosen, 'pixel': summary['pixel']}
                state['best'] = best
                torch.save(state, out / 'best.pt')
                (out / 'results.json').write_text(json.dumps({'best': best, 'recipe_hash': recipe['recipe_hash'],
                                                              'manifest_version': index.manifest['version'],
                                                              'pool': index.pool_name, 'n_train': len(train_ids),
                                                              'seed': args.seed, 'subset_seed': subset_seed},
                                                             indent=2, sort_keys=True) + '\n')
                log(f"new best checkpoint saved (epoch {epoch + 1}, parcel F1 {best['parcel_f1']:.3f})")
    journal.close()
    log(f"done; best selection parcel F1 {best['parcel_f1']:.3f} at epoch {best.get('epoch', -1) + 1} with {best.get('config')}")
    log(f"final split: python {HERE / 'train.py'} --evaluate-only --output {out} --dataset {args.dataset} --split final --run")


def degrade_image(image, metres_per_px, gsd_m):
    """Simulate coarser imagery: box-downsample the (3, size, size) tile to gsd_m per pixel and resize it back."""
    size = image.shape[1]
    coarse = max(8, int(round(size * metres_per_px / gsd_m)))
    rgb = np.ascontiguousarray(image.transpose(1, 2, 0))
    small = cv2.resize(rgb, (coarse, coarse), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (size, size), interpolation=cv2.INTER_LINEAR).transpose(2, 0, 1)


def evaluate_only(args):
    device = pick_device(args.device)
    index = TileIndex(args.manifest, args.dataset, args.pool)
    checkpoint = args.checkpoint or args.output / 'best.pt'
    state = torch.load(checkpoint, map_location=device, weights_only=False)
    results = read_json(args.output / 'results.json')
    config = results['best']['config']
    ids = index.ids(args.split)[:args.selection_tiles] if args.selection_tiles else index.ids(args.split)
    cache_dir = args.output.parent / 'cache' / f"s{state['size']}-cap{args.cap_m:g}-d{args.dilate_px}"
    cache = load_cache([index.tiles[t] for t in ids], state['size'], args.cap_m, args.dilate_px, cache_dir)
    if args.degrade_gsd:
        # In memory only, so the shared tile cache stays the real imagery.
        for tile_id in ids:
            bbox = index.tiles[tile_id]['bbox']
            metres_per_px = (bbox[2] - bbox[0]) / state['size']
            cache[tile_id] = dict(cache[tile_id], image=degrade_image(cache[tile_id]['image'].astype(np.float32),
                                                                       metres_per_px, args.degrade_gsd).astype(np.float16))
    model = ParcelNet(state['encoder'], in_chans=state['in_chans'], pretrained=False).to(device)
    model.load_state_dict(state['model'])
    match = re.fullmatch(r't([0-9.]+)-seeds([01])-hard([01])', config)
    configs = [{'threshold': float(match.group(1)), 'interior_seeds': match.group(2) == '1',
                'hard_barrier': match.group(3) == '1'}]
    if args.osm_mode == 'none':
        configs = [dict(config, interior_seeds=True) for config in configs]   # without OSM buildings, interiors are the only seeds
    suffix = ('' if args.osm_mode == 'full' else f'-osm-{args.osm_mode}') + (f'-gsd{args.degrade_gsd:g}' if args.degrade_gsd else '')
    out_dir = args.output / f'{args.split}-eval{suffix}'
    summary = evaluate(model, index, cache, ids, configs, device, recon_size=state['recon_size'],
                       workers=args.eval_workers, out_dir=out_dir, osm_mode=args.osm_mode)
    metrics = summary['configs'][summary['best_config']]
    log(f"{args.split} (osm {args.osm_mode}{f', imagery degraded to {args.degrade_gsd:g} m' if args.degrade_gsd else ''}): "
        f"{len(ids)} tiles, config {summary['best_config']}, parcel F1 {metrics['parcel_f1']:.3f} precision "
        f"{metrics['precision'] or 0:.3f} recall {metrics['recall']:.3f} area-weighted recall {metrics['area_weighted_recall']:.3f} "
        f"boundary F1 {metrics['boundary_f1'] or 0:.3f}; outputs in {out_dir}")
    log(f"ledger: python {HERE.parent / 'ledger.py'} add --benchmark {index.manifest['version']} --split {args.split} "
        f"--method layered-v0-{state['encoder']} --metrics {out_dir / 'pooled.json'} --recipe-hash {results['recipe_hash']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--dataset', type=Path, required=True, help='exported dataset dir with images, truth and OSM')
    parser.add_argument('--output', type=Path, required=True, help='run directory (checkpoints, journal, results)')
    parser.add_argument('--encoder', default='convnext_tiny')
    parser.add_argument('--no-pretrained', action='store_true')
    parser.add_argument('--size', type=int, default=512, help='model input/target grid')
    parser.add_argument('--recon-size', type=int, default=256, help='reconstruction grid (the baseline uses 256)')
    parser.add_argument('--cap-m', type=float, default=12.0, help='distance target cap in metres')
    parser.add_argument('--dilate-px', type=int, default=1)
    parser.add_argument('--batch', type=int, default=6)
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--lr', type=float, default=3e-4)
    parser.add_argument('--encoder-lr-scale', type=float, default=0.3)
    parser.add_argument('--osm-dropout', type=float, default=0.2)
    parser.add_argument('--device', default='auto')
    parser.add_argument('--workers', type=int, default=4, help='DataLoader workers (0 on macOS)')
    parser.add_argument('--eval-workers', type=int, default=8, help='reconstruction processes (0 = in-process)')
    parser.add_argument('--eval-every', type=int, default=1)
    parser.add_argument('--log-every', type=int, default=10)
    parser.add_argument('--thresholds', type=lambda s: tuple(float(v) for v in s.split(',')), default=(0.3, 0.5, 0.7))
    parser.add_argument('--interior-seeds', choices=('on', 'off', 'both'), default='both')
    parser.add_argument('--hard-barrier', choices=('on', 'off', 'both'), default='off')
    parser.add_argument('--train-tiles', type=int, default=0, help='seeded nested random subset of the pool (0 = all)')
    parser.add_argument('--pool', type=Path, help='pool manifest from export_pool.py replacing the frozen training pool')
    parser.add_argument('--subset-seed', type=int, help='seed of the --train-tiles subset (default: --seed)')
    parser.add_argument('--degrade-gsd', type=float, default=0.0,
                        help='evaluate-only: box-downsample the imagery to this ground sample distance (m) and back, a resolution control')
    parser.add_argument('--osm-mode', choices=('full', 'model-blank', 'none'), default='full',
                        help='evaluate-only: zero the OSM input channels (model-blank) or also withhold OSM seeds and barriers (none)')
    parser.add_argument('--selection-tiles', type=int, default=0, help='limit (0 = all)')
    parser.add_argument('--max-steps', type=int, default=0, help='steps per epoch limit (0 = all)')
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--smoke', action='store_true', help='tiny CPU run: resnet18, 128 px, 2 tiles, 2 steps')
    parser.add_argument('--evaluate-only', action='store_true', help='score a split with the selected checkpoint/config')
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--split', choices=('selection', 'final'), default='selection')
    parser.add_argument('--run', action='store_true', help='required; without it only the plan prints')
    args = parser.parse_args(argv)
    if args.smoke:
        args.encoder, args.size, args.recon_size, args.batch = 'resnet18', 128, 64, 2
        if args.epochs == 20:
            args.epochs = 1
        args.train_tiles, args.selection_tiles, args.max_steps, args.workers, args.eval_workers = 2, 2, 2, 0, 0
        args.thresholds, args.device, args.log_every = (0.5,), 'cpu', 1
    if not args.run:
        print('dry run; pass --run. Plan:', json.dumps({k: str(v) for k, v in vars(args).items()}, indent=1))
        return
    if args.evaluate_only:
        evaluate_only(args)
    else:
        train(args)


if __name__ == '__main__':
    main()
