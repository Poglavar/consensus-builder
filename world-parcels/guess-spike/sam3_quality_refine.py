#!/usr/bin/env python3
"""Refine cached-feature SAM 3 parcel masks and select cleanup on validation only."""
import argparse
import gc
import hashlib
import json
import random
import shutil
import time
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import Sam3Model
from transformers.modeling_outputs import BaseModelOutputWithPooling
from transformers.models.sam3.modeling_sam3 import Sam3VisionEncoderOutput

from evaluate import rasterize_reference
from sam3_compare import evaluate_masks, evaluate_instances, log
from sam3_finetune import REVISION, PREFIXES, SEED, adaptation, apply_adaptation, save, json_save
from sam3_tiny_fit import score_predictions, select_first_block, sha256_file
from sam3_quality_losses import parcel_quality_loss
from sam3_parcel_postprocess import parcel_masks

HERE = Path(__file__).resolve().parent
CONFIGS = [dict(score_threshold=score, mask_threshold=.5, nms_iou=.7,
                min_area=area, exclusive=True)
           for score in (.15, .3, .5, .7) for area in (16, 64)]
SOURCES = ('sam3_quality_refine.py', 'sam3_quality_losses.py', 'sam3_parcel_postprocess.py',
           'sam3_finetune.py', 'sam3_tiny_fit.py', 'sam3_losses.py', 'sam3_compare.py',
           'evaluate.py', 'guess.py', 'prepare_sam3_dataset.py')


def aggregate(rows):
    predicted = sum(row['instances'] for row in rows)
    matched = sum(row['instance_scores']['matched_instances'] for row in rows)
    reference = sum(row['instance_scores']['reference_instances'] for row in rows)
    return dict(predicted_instances=predicted, matched_instances=matched,
                reference_instances=reference, shape_precision=matched / predicted if predicted else 0,
                shape_recall=matched / reference if reference else 0,
                shape_f1=2 * matched / (predicted + reference) if predicted + reference else 0,
                boundary_f1_mean=float(np.mean([row['boundary_scores']['2']['f1'] for row in rows])),
                coverage_mean=float(np.mean([row['coverage_fraction'] for row in rows])),
                overlap_mean=float(np.mean([row['overlap_fraction'] for row in rows])))


def selection_key(summary):
    """Whole-parcel matching is primary; nearby fragments must not win on line F1."""
    return summary['shape_f1'], summary['boundary_f1_mean']


def measured(masks, sample, dataset):
    truth = json.loads((dataset / sample['truth']).read_text())
    reference, edges, coverage = rasterize_reference(truth['features'], sample['bbox'])
    metrics, _ = evaluate_masks(masks, edges, coverage, (sample['bbox'][2] - sample['bbox'][0]) / 256)
    metrics['instance_scores'] = evaluate_instances(list(masks), reference)
    metrics['tile'] = sample['id']
    return metrics


def prediction_arrays(outputs):
    _, _, scores, probabilities = score_predictions(outputs)
    return probabilities[0].detach().cpu().numpy(), scores[0].detach().cpu().numpy()


def training_masks(sample, dataset):
    """Subpixel legal slivers can be empty on the evaluation grid; omit their loss."""
    truth = json.loads((dataset / sample['truth']).read_text())
    masks, _, _ = rasterize_reference(truth['features'], sample['bbox'])
    visible = [mask for mask in masks if mask.any()]
    array = (np.asarray(visible, dtype=np.float32) if visible else np.zeros((0, 256, 256), np.float32))
    return array, len(masks) - len(visible)


def validation_sweep(arrays, samples, dataset):
    candidates = []
    for config in CONFIGS:
        rows = []
        for sample in samples:
            masks, _, _, diagnostics = parcel_masks(*arrays[sample['id']], **config)
            row = measured(masks, sample, dataset)
            row['cleanup'] = diagnostics
            rows.append(row)
        candidates.append(dict(config=config, summary=aggregate(rows), details=rows))
    return max(candidates, key=lambda row: selection_key(row['summary'])), candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    for name in ('dataset', 'cache', 'features', 'initial', 'output'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--epochs', type=int, default=6)
    parser.add_argument('--learning-rate', type=float, default=3e-5)
    parser.add_argument('--device', choices=('mps', 'cuda', 'cpu'), default='mps')
    parser.add_argument('--train-tiles', type=int, default=0, help='1–4: training-only tiny diagnostic')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    if not all(getattr(args, name) for name in ('dataset', 'cache', 'features', 'initial', 'output')):
        parser.error('Explicit dataset, cache, features, initial and output paths are required')
    if args.epochs < 0 or args.learning_rate <= 0 or not 0 <= args.train_tiles <= 4:
        parser.error('Epochs must be nonnegative, learning rate positive, train tiles from 0 to 4')
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS unavailable; use a local GPU-capable execution environment')
    samples_path = args.dataset / 'samples.json'
    samples = json.loads(samples_path.read_text())
    if isinstance(samples, dict):
        samples = samples['samples']
    if args.train_tiles:
        train = select_first_block(samples, args.train_tiles)
        validation, test, used = train, [], train
    else:
        train = [s for s in samples if s['split'] == 'train']
        validation = [s for s in samples if s['split'] == 'validation']
        test = [s for s in samples if s['split'] == 'test']
        used = samples
        from prepare_sam3_dataset import check_split_leakage
        for sample in samples:
            truth = json.loads((args.dataset / sample['truth']).read_text())
            sample['source_ids'] = [str(f['properties']['cestica_id']) for f in truth['features']]
        check_split_leakage(samples)
    if not train or not validation or (not args.train_tiles and not test):
        raise ValueError('Required geographic groups are empty')
    snapshot = Path(snapshot_download('facebook/sam3', revision=REVISION, cache_dir=args.cache,
                          local_files_only=True, allow_patterns=['*.json', '*.txt', '*.model', '*.safetensors']))
    inputs = {'dataset/samples.json': sha256_file(samples_path),
              'initial.pt': sha256_file(args.initial)}
    for name in ('positions.pt', 'text.pt'):
        inputs['features/' + name] = sha256_file(args.features / name)
    for sample in used:
        for field in ('image', 'truth', 'masks'):
            relative = sample[field]
            inputs['dataset/' + relative] = sha256_file(args.dataset / relative)
        name = sample['id'] + '.pt'
        inputs['features/' + name] = sha256_file(args.features / name)
    for path in sorted(snapshot.glob('*.safetensors')):
        inputs['model/' + path.name] = sha256_file(path)
    empty_training_masks = {s['id']: count for s in train
                            for _, count in [training_masks(s, args.dataset)] if count}
    recipe = dict(inputs_sha256=inputs, source_sha256={name: sha256_file(HERE / name) for name in SOURCES},
                  model_revision=REVISION, trainable_prefixes=list(PREFIXES), prompt='land parcel',
                  epochs=args.epochs, learning_rate=args.learning_rate, seed=SEED,
                  loss_resolution=256, boundary_weight=4, overlap_weight=.5,
                  quality_score_target='detached binary-mask IoU for Hungarian matched targets',
                  target_grid='same 256x256 GeoJSON rasterizer as evaluation; no max pooling',
                  empty_training_masks_excluded=empty_training_masks,
                  cleanup_grid=CONFIGS, selection='whole-parcel micro F1; boundary F1 breaks ties',
                  splits={s: [r['id'] for r in group] for s, group in
                          [('train', train), ('selection', validation), ('test', test)]},
                  mode='training-only diagnostic' if args.train_tiles else 'exploratory geographic comparison',
                  metered_api_usd=0)
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    recipe_path = output / 'recipe.json'
    if recipe_path.exists() and json.loads(recipe_path.read_text()) != recipe:
        raise ValueError('Recipe mismatch: preserve this run and use a new output directory')
    if (output / 'last.pt').exists() and not args.resume:
        raise ValueError('Existing checkpoint: pass --resume')
    json_save(recipe, recipe_path)
    source = output / 'source'
    source.mkdir(exist_ok=True)
    for name in SOURCES:
        shutil.copyfile(HERE / name, source / name)
    model = Sam3Model.from_pretrained(snapshot, local_files_only=True).to(args.device).eval()
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith(PREFIXES))
    model.vision_encoder = None
    model.text_encoder = None
    gc.collect()
    if args.device == 'mps':
        torch.mps.empty_cache()
    apply_adaptation(model, torch.load(args.initial, weights_only=True, map_location='cpu'))
    positions = torch.load(args.features / 'positions.pt', weights_only=True)
    text = torch.load(args.features / 'text.pt', weights_only=True)['land parcel']
    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=args.learning_rate, weight_decay=.01)
    log(f'Quality refinement · {sum(p.numel() for p in parameters):,} trainable parameters · API $0')

    def predict(sample):
        features = torch.load(args.features / (sample['id'] + '.pt'), weights_only=True)
        vision = Sam3VisionEncoderOutput(fpn_hidden_states=tuple(t.to(args.device) for t in features),
                 fpn_position_encoding=tuple(t.to(args.device) for t in positions))
        return model(vision_embeds=vision,
                     text_embeds=BaseModelOutputWithPooling(pooler_output=text['pooler_output'].to(args.device)),
                     attention_mask=text['attention_mask'].to(args.device))

    def infer(group, folder=None):
        arrays = {}
        model.eval()
        for i, sample in enumerate(group, 1):
            with torch.no_grad():
                predictions = predict(sample)
                arrays[sample['id']] = prediction_arrays(predictions)
            if folder is not None:
                folder.mkdir(parents=True, exist_ok=True)
                probability, scores = arrays[sample['id']]
                np.savez_compressed(folder / (sample['id'] + '.npz'), probabilities=probability, scores=scores)
            del predictions
            if args.device == 'mps':
                torch.mps.empty_cache()
            log(f'Infer {i}/{len(group)} · {sample["id"]} · API $0')
        return arrays

    epoch = index = step = 0
    history = []
    selection_history = []
    best = None
    best_epoch = 0
    if args.resume and (output / 'last.pt').exists():
        state = torch.load(output / 'last.pt', weights_only=False, map_location='cpu')
        if state['recipe'] != recipe:
            raise ValueError('Checkpoint recipe mismatch')
        apply_adaptation(model, state['adaptation'])
        optimizer.load_state_dict(state['optimizer'])
        epoch, index, step = state['epoch'], state['index'], state['step']
        history, selection_history = state['history'], state['selection_history']
        best, best_epoch = state['best'], state['best_epoch']
        log(f'Resume: {step} completed updates skipped')
    else:
        initial_arrays = infer(validation, output / 'initial-selection-raw')
        best, sweep = validation_sweep(initial_arrays, validation, args.dataset)
        raw = [measured(probability[scores > .3] > .5, sample, args.dataset)
               for sample in validation for probability, scores in [initial_arrays[sample['id']]]]
        json_save(dict(selected=best, sweep=sweep, raw_summary=aggregate(raw)), output / 'initial-selection.json')
        del initial_arrays
        save(adaptation(model), output / 'best.pt')
        selection_history.append(dict(epoch=0, selected=best))
        log(f'Initial selection · shape F1 {best["summary"]["shape_f1"]:.3f} · {best["config"]}')

    def checkpoint(e, next_index):
        save(dict(recipe=recipe, adaptation=adaptation(model), optimizer=optimizer.state_dict(),
                  epoch=e, index=next_index, step=step, history=history,
                  selection_history=selection_history, best=best, best_epoch=best_epoch), output / 'last.pt')

    started, started_step = time.monotonic(), step
    checkpoint(epoch, index)
    while epoch < args.epochs:
        order = list(train)
        random.Random(SEED + epoch).shuffle(order)
        for current in range(index, len(order)):
            sample = order[current]
            target_masks, _ = training_masks(sample, args.dataset)
            targets = torch.from_numpy(target_masks).to(args.device)
            optimizer.zero_grad(set_to_none=True)
            model.eval()  # Frozen RGB feature cache; deterministic decoder/head refinement.
            tick = time.monotonic()
            predictions = predict(sample)
            loss, pieces = parcel_quality_loss(predictions, targets)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite quality loss')
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(parameters, 1., error_if_nonfinite=True)
            optimizer.step()
            step += 1
            history.append(dict(step=step, epoch=epoch + 1, tile=sample['id'], loss=float(loss.detach().cpu()),
                                components=pieces, gradient_norm=float(gradient.detach().cpu()),
                                duration_seconds=time.monotonic() - tick, metered_api_usd=0))
            del predictions, targets, loss
            if args.device == 'mps':
                torch.mps.empty_cache()
            json_save(history, output / 'training.json')
            if step % 4 == 0 or current + 1 == len(order):
                checkpoint(epoch, current + 1)
            eta = (time.monotonic() - started) / max(step - started_step, 1) * (args.epochs * len(train) - step)
            log(f'Train {step}/{args.epochs * len(train)} · loss {history[-1]["loss"]:.3f} · '
                f'mask IoU {pieces["matched_iou"]:.3f} · ETA {eta:.0f}s · API $0')
        arrays = infer(validation)
        selected, sweep = validation_sweep(arrays, validation, args.dataset)
        del arrays
        json_save(dict(selected=selected, sweep=sweep), output / f'epoch-{epoch + 1}-selection.json')
        selection_history.append(dict(epoch=epoch + 1, selected=selected))
        if selection_key(selected['summary']) > selection_key(best['summary']):
            best, best_epoch = selected, epoch + 1
            save(adaptation(model), output / 'best.pt')
        log(f'Selection epoch {epoch + 1} · shape F1 {selected["summary"]["shape_f1"]:.3f} · best epoch {best_epoch}')
        epoch += 1
        index = 0
        checkpoint(epoch, index)
    apply_adaptation(model, torch.load(output / 'best.pt', weights_only=True, map_location='cpu'))
    final_group = validation if args.train_tiles else test
    arrays = infer(final_group, output / 'final-raw')
    details = []
    raw_details = []
    prediction_dir = output / 'predictions'
    prediction_dir.mkdir(exist_ok=True)
    for sample in final_group:
        probability, scores = arrays[sample['id']]
        masks, kept_scores, queries, diagnostics = parcel_masks(probability, scores, **best['config'])
        np.savez_compressed(prediction_dir / (sample['id'] + '.npz'), masks=masks, scores=kept_scores,
                            query_indices=queries)
        row = measured(masks, sample, args.dataset)
        row['cleanup'] = diagnostics
        details.append(row)
        raw_details.append(measured(probability[scores > .3] > .5, sample, args.dataset))
    result = dict(recipe=recipe, best_epoch=best_epoch, selected=best,
                  selection_history=selection_history, final_summary=aggregate(details), final_details=details,
                  raw_summary=aggregate(raw_details), raw_details=raw_details,
                  evaluation_split='train only' if args.train_tiles else 'previously examined test',
                  trainable_parameters=sum(p.numel() for p in parameters), completed_updates=step,
                  metered_api_usd=0)
    json_save(result, output / 'results.json')
    log(f'Complete · {result["final_summary"]}')


if __name__ == '__main__':
    main()
