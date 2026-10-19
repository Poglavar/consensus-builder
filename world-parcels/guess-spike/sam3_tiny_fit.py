#!/usr/bin/env python3
"""Overfit a tiny contiguous parcel training block to diagnose SAM 3 training."""
import argparse
import gc
import hashlib
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import Sam3Model
from transformers.models.sam3.modeling_sam3 import Sam3VisionEncoderOutput
from transformers.modeling_outputs import BaseModelOutputWithPooling
from huggingface_hub import snapshot_download

from evaluate import rasterize_reference, boundary, score_boundaries
from sam3_compare import evaluate_masks, evaluate_instances, overlay, log
from sam3_finetune import (REVISION, PREFIXES, SEED, adaptation, apply_adaptation,
                           save, json_save)
from sam3_losses import parcel_loss

THRESHOLDS = (0.05, 0.1, 0.3, 0.5)
EVALUATE_EVERY = 40
CHECKPOINT_EVERY = 20
MAX_TRAIN_TILES = 4


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def select_first_block(samples, count=MAX_TRAIN_TILES):
    """Return the first contiguous 2x2 training block, optionally its prefix."""
    if not 1 <= count <= MAX_TRAIN_TILES:
        raise ValueError(f'--train-tiles must be from 1 to {MAX_TRAIN_TILES}')
    train = [sample for sample in samples if sample['split'] == 'train']
    by_grid = {}
    for sample in train:
        parts = sample['id'].removeprefix('tile_').split('_')
        if len(parts) != 2:
            raise ValueError(f"Unexpected tile id: {sample['id']}")
        by_grid[(int(parts[0]), int(parts[1]))] = sample
    blocks = []
    for (x, y), sample in by_grid.items():
        keys = [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
        if all(key in by_grid for key in keys):
            block = [by_grid[key] for key in keys]
            # Tile indices must correspond to touching projected bounds.
            bounds = [s['bbox'] for s in block]
            width = bounds[0][2] - bounds[0][0]
            height = bounds[0][3] - bounds[0][1]
            if (all(abs((b[0] - bounds[0][0]) - dx * width) < 1e-3 and
                    abs((b[1] - bounds[0][1]) - dy * height) < 1e-3
                    for b, (dx, dy) in zip(bounds, [(0, 0), (1, 0), (0, 1), (1, 1)]))):
                blocks.append((min(train.index(item) for item in block), block))
    if not blocks:
        raise ValueError('No complete geographically contiguous 2x2 block exists in the training split')
    _, chosen = min(blocks, key=lambda item: item[0])
    return chosen[:count]


def score_predictions(outputs, target_size=(256, 256)):
    """Return raw query scores and masks using HF SAM 3 postprocessing semantics."""
    query_scores = outputs.pred_logits.sigmoid()
    presence = (outputs.presence_logits.sigmoid() if outputs.presence_logits is not None
                else torch.ones((query_scores.shape[0], 1), device=query_scores.device,
                                dtype=query_scores.dtype))
    scores = query_scores * presence
    masks = outputs.pred_masks.sigmoid()
    if tuple(masks.shape[-2:]) != tuple(target_size):
        masks = torch.nn.functional.interpolate(masks, size=target_size, mode='bilinear',
                                                align_corners=False)
    return query_scores, presence, scores, masks


def score_distribution(values):
    values = np.asarray(values, dtype=np.float64).reshape(-1)
    if not len(values):
        return {'count': 0, 'min': None, 'p50': None, 'p90': None, 'p99': None, 'max': None}
    quantiles = np.quantile(values, [0, .5, .9, .99, 1])
    return {'count': int(len(values)), 'min': round(float(quantiles[0]), 6),
            'p50': round(float(quantiles[1]), 6), 'p90': round(float(quantiles[2]), 6),
            'p99': round(float(quantiles[3]), 6), 'max': round(float(quantiles[4]), 6)}


def threshold_diagnostics(outputs, target_size=(256, 256), mask_threshold=.5):
    """Summarize query, image-presence and final scores plus score-threshold counts."""
    query, presence, scores, mask_probabilities = score_predictions(outputs, target_size)
    mask_sizes = (mask_probabilities > mask_threshold).flatten(2).sum(-1)[0]
    final = scores[0]
    return {
        'query_score_distribution': score_distribution(query[0].detach().cpu().numpy()),
        'image_presence_probability': round(float(presence[0, 0].detach().cpu()), 6),
        'post_presence_score_distribution': score_distribution(final.detach().cpu().numpy()),
        'mask_probability_distribution': score_distribution(mask_probabilities[0].detach().cpu().numpy()),
        'threshold_sweep': {
            str(threshold): {
                'kept_queries': int((final > threshold).sum().item()),
                'nonempty_masks': int(((final > threshold) & (mask_sizes > 0)).sum().item()),
            } for threshold in THRESHOLDS
        },
    }


def provenance(dataset, feature_dir, samples_path, selected, model_dir):
    files = [samples_path, feature_dir / 'positions.pt', feature_dir / 'text.pt']
    for sample in selected:
        files += [dataset / sample['masks'], dataset / sample['truth'],
                  dataset / sample['image'], feature_dir / f"{sample['id']}.pt"]
    return {
        'samples_sha256': sha256_file(samples_path),
        'selected_inputs_sha256': {str(path.relative_to(dataset.parent)): sha256_file(path)
                                   for path in files},
        'model_revision': REVISION,
        'model_weights_sha256': sha256_file(model_dir / 'model.safetensors'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--dataset', type=Path)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--features', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--device', choices=['mps', 'cuda', 'cpu'], default='mps')
    parser.add_argument('--steps', type=int, default=240)
    parser.add_argument('--learning-rate', type=float, default=1e-4)
    parser.add_argument('--train-tiles', type=int, default=4)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    if not all([args.dataset, args.cache, args.features, args.output]):
        parser.error('--dataset, --cache, --features and --output are required with --run')
    if args.steps < 1 or args.learning_rate <= 0:
        parser.error('--steps and --learning-rate must be positive')
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    random.seed(SEED)
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS unavailable; run with local GPU access or explicitly choose another device')
    samples_path = args.dataset / 'samples.json'
    samples = json.loads(samples_path.read_text())
    if isinstance(samples, dict):
        samples = samples['samples']
    selected = select_first_block(samples, args.train_tiles)
    for sample in selected:
        for relative in (sample['masks'], sample['truth'], sample['image']):
            if not (args.dataset / relative).is_file():
                raise FileNotFoundError(args.dataset / relative)
        feature = args.features / f"{sample['id']}.pt"
        if not feature.is_file():
            raise FileNotFoundError(f'Missing cached frozen feature: {feature}')
    for filename in ('positions.pt', 'text.pt'):
        if not (args.features / filename).is_file():
            raise FileNotFoundError(args.features / filename)

    snapshot = snapshot_download('facebook/sam3', revision=REVISION, cache_dir=args.cache,
        local_files_only=True, allow_patterns=['*.json', '*.txt', '*.model', '*.safetensors'])
    model_dir = Path(snapshot)
    input_provenance = provenance(args.dataset, args.features, samples_path, selected, model_dir)
    source_hashes = {name: sha256_file(Path(__file__).with_name(name)) for name in
                     ('sam3_tiny_fit.py', 'sam3_finetune.py', 'sam3_losses.py',
                      'prepare_sam3_dataset.py', 'sam3_compare.py', 'evaluate.py')}
    recipe = {
        **input_provenance, 'source_sha256': source_hashes,
        'selected_tiles': [s['id'] for s in selected], 'steps': args.steps,
        'learning_rate': args.learning_rate, 'trainable_prefixes': list(PREFIXES),
        'prompt': 'land parcel', 'score_threshold_sweep': list(THRESHOLDS),
        'mask_threshold': .5, 'loss_resolution': 128, 'seed': SEED,
        'mode': 'training-subset overfit diagnostic; not a generalization evaluation',
        'metered_api_usd': 0,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    recipe_path = args.output / 'recipe.json'
    last_path = args.output / 'last.pt'
    if recipe_path.exists() and json.loads(recipe_path.read_text()) != recipe:
        raise ValueError('Existing output belongs to another recipe or changed input/code provenance')
    if last_path.exists() and not args.resume:
        raise ValueError('Use --resume to continue this existing experiment')
    json_save(recipe, recipe_path)

    model = Sam3Model.from_pretrained(snapshot, local_files_only=True).to(args.device).eval()
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith(PREFIXES))
    parameter_count = sum(p.numel() for p in model.parameters() if p.requires_grad)
    model.vision_encoder = None
    model.text_encoder = None
    gc.collect()
    if args.device == 'mps':
        torch.mps.empty_cache()

    positions = torch.load(args.features / 'positions.pt', weights_only=True)
    text_cache = torch.load(args.features / 'text.pt', weights_only=True)
    features = {s['id']: torch.load(args.features / f"{s['id']}.pt", weights_only=True)
                for s in selected}
    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=args.learning_rate, weight_decay=.01)

    def predict(sample):
        vision = Sam3VisionEncoderOutput(
            fpn_hidden_states=tuple(t.to(args.device) for t in features[sample['id']]),
            fpn_position_encoding=tuple(t.to(args.device) for t in positions))
        text = BaseModelOutputWithPooling(
            pooler_output=text_cache['land parcel']['pooler_output'].to(args.device))
        return model(vision_embeds=vision, text_embeds=text,
                     attention_mask=text_cache['land parcel']['attention_mask'].to(args.device))

    history = []
    step = 0
    best_f1 = -1.0
    best_step = 0
    if args.resume and last_path.exists():
        state = torch.load(last_path, weights_only=False, map_location='cpu')
        if state['recipe'] != recipe:
            raise ValueError('Checkpoint recipe/input provenance mismatch')
        apply_adaptation(model, state['adaptation'])
        optimizer.load_state_dict(state['optimizer'])
        step, history, best_f1, best_step = (state['step'], state['history'],
                                              state['best_train_f1'], state['best_step'])
        log(f'Resuming tiny fit after {step}/{args.steps} updates')

    def checkpoint():
        save({'recipe': recipe, 'adaptation': adaptation(model), 'optimizer': optimizer.state_dict(),
              'step': step, 'history': history, 'best_train_f1': best_f1,
              'best_step': best_step}, last_path)

    def evaluate_training(label):
        nonlocal best_f1, best_step
        rows = []
        model.eval()
        for sample in selected:
            with torch.no_grad():
                outputs = predict(sample)
                diagnostics = threshold_diagnostics(outputs)
                query, presence, scores, mask_probabilities = score_predictions(outputs)
                truth_json = json.loads((args.dataset / sample['truth']).read_text())
                reference, truth_edges, coverage = rasterize_reference(
                    truth_json['features'], sample['bbox'])
                target_instances = np.load(args.dataset / sample['masks'])['masks'].astype(bool)
                target_edges = np.zeros(target_instances.shape[-2:], dtype=bool)
                target_coverage = np.zeros_like(target_edges)
                for target_mask in target_instances:
                    target_edges |= boundary(target_mask.astype(np.uint8))
                    target_coverage |= target_mask
                tile_width = sample['bbox'][2] - sample['bbox'][0]
                metres_per_pixel = tile_width / 256
                threshold_rows = {}
                preview_folder = args.output / 'evaluations' / f'{step:04d}' / sample['id']
                preview_folder.mkdir(parents=True, exist_ok=True)
                rgb = np.asarray(Image.open(args.dataset / sample['image']).convert('RGB'))
                truth_file = preview_folder / 'truth.png'
                overlay(rgb, boundary(coverage.astype(np.uint8)), truth_edges).save(truth_file)
                for threshold in THRESHOLDS:
                    keep = scores[0] > threshold
                    masks = (mask_probabilities[0, keep] > .5).cpu().numpy().astype(bool)
                    metrics, pred_edges = evaluate_masks(masks, truth_edges, coverage,
                                                         metres_per_pixel)
                    metrics['instance_scores'] = evaluate_instances(list(masks), reference)
                    metrics['boundary_scores'] = {str(t): score_boundaries(
                        pred_edges, truth_edges, t / metres_per_pixel) for t in (1, 2, 5)}
                    target_metrics, target_pred_edges = evaluate_masks(
                        masks, target_edges, target_coverage, metres_per_pixel)
                    target_metrics['instance_scores'] = evaluate_instances(list(masks),
                                                                            list(target_instances))
                    target_metrics['boundary_scores'] = {str(t): score_boundaries(
                        target_pred_edges, target_edges, t / metres_per_pixel) for t in (1, 2, 5)}
                    metrics['against_training_mask_targets'] = target_metrics
                    metrics.update(tile=sample['id'], threshold=threshold, step=step)
                    threshold_rows[str(threshold)] = metrics
                    prediction_path = preview_folder / f'prediction-threshold-{threshold}.png'
                    overlay(rgb, pred_edges, truth_edges).save(prediction_path)
                    masks_path = preview_folder / f'masks-threshold-{threshold}.npz'
                    np.savez_compressed(masks_path, masks=masks,
                                        scores=scores[0, keep].detach().cpu().numpy(),
                                        raw_query_scores=query[0, keep].detach().cpu().numpy(),
                                        image_presence=presence[0].detach().cpu().numpy())
                rows.append({'tile': sample['id'], 'scores': diagnostics,
                             'metrics_by_threshold': threshold_rows,
                             'truth_preview': str(truth_file.relative_to(args.output))})
            del outputs
        summary = {}
        for threshold in THRESHOLDS:
            key = str(threshold)
            summary[key] = {
                'mean_boundary_f1_at_2m': round(float(np.mean([
                    r['metrics_by_threshold'][key]['boundary_scores']['2']['f1'] for r in rows])), 4),
                'mean_training_mask_boundary_f1_at_2m': round(float(np.mean([
                    r['metrics_by_threshold'][key]['against_training_mask_targets']
                     ['boundary_scores']['2']['f1'] for r in rows])), 4),
                'matched_instances': sum(r['metrics_by_threshold'][key]['instance_scores']['matched_instances']
                                         for r in rows),
                'reference_instances': sum(r['metrics_by_threshold'][key]['instance_scores']['reference_instances']
                                           for r in rows),
            }
        result = {'step': step, 'scope': 'training tiles only; diagnostic, not generalization',
                  'tiles': rows, 'summary_by_threshold': summary}
        path = args.output / f'evaluation-{step:04d}.json'
        json_save(result, path)
        candidate = summary['0.3']['mean_boundary_f1_at_2m']
        if candidate > best_f1:
            best_f1, best_step = candidate, step
            save(adaptation(model), args.output / 'best-train.pt')
        log(f'Train-only evaluation {step}/{args.steps}: F1@2m, score .3 = {candidate:.4f}')
        return result

    if step == 0:
        evaluate_training('initial')
    started = time.monotonic()
    while step < args.steps:
        update_started = time.monotonic()
        sample = selected[step % len(selected)]
        targets = torch.from_numpy(np.load(args.dataset / sample['masks'])['masks']).float().to(args.device)
        model.eval()
        optimizer.zero_grad(set_to_none=True)
        outputs = predict(sample)
        if targets.shape[0] > outputs.pred_logits.shape[1]:
            raise ValueError(f"{sample['id']} has {targets.shape[0]} parcels but SAM 3 has only "
                             f'{outputs.pred_logits.shape[1]} detector queries')
        loss, components = parcel_loss(outputs, targets, resolution=128)
        if not torch.isfinite(loss):
            raise RuntimeError(f'Nonfinite loss at update {step + 1}')
        loss.backward()
        gradient = torch.nn.utils.clip_grad_norm_(parameters, 1., error_if_nonfinite=True)
        optimizer.step()
        step += 1
        history.append({'step': step, 'tile': sample['id'], 'loss': float(loss.detach().cpu()),
                        'components': components,
                        'gradient_norm': float(gradient.detach().cpu()),
                        'duration_seconds': round(time.monotonic() - update_started, 3),
                        'metered_api_usd': 0})
        del outputs, targets, loss
        if args.device == 'mps':
            torch.mps.empty_cache()
        json_save(history, args.output / 'training.json')
        if step % CHECKPOINT_EVERY == 0 or step == args.steps:
            checkpoint()
        if step % EVALUATE_EVERY == 0 or step == args.steps:
            evaluate_training('periodic')
            checkpoint()
        if step % 10 == 0:
            log(f'Update {step}/{args.steps}; loss {history[-1]["loss"]:.4f}; '
                f'elapsed {time.monotonic() - started:.0f}s')
    result = {'recipe': recipe, 'trainable_parameters': parameter_count,
              'initial_checkpoint': 'fresh pretrained SAM 3 decoder/scoring/mask heads',
              'best_train_only_f1_at_2m_threshold_0_3': best_f1, 'best_step': best_step,
              'training_updates': step, 'scope': 'overfit diagnostic only; no validation/test claims'}
    json_save(result, args.output / 'results.json')
    checkpoint()
    log(f'Completed training-subset diagnostic: {result}')


if __name__ == '__main__':
    main()
