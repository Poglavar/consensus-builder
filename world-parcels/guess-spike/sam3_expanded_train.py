#!/usr/bin/env python3
"""Test more varied parcel training data against the previous adapter on fresh geography."""
import argparse
import gc
import json
import random
import shutil
import time
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import Sam3Model, Sam3Processor
from transformers import __version__ as TRANSFORMERS_VERSION
from transformers.modeling_outputs import BaseModelOutputWithPooling

from prepare_sam3_dataset import bbox_gap, check_split_leakage
from sam3_finetune import REVISION, PREFIXES, adaptation, apply_adaptation, save, json_save
from sam3_losses import parcel_loss
from sam3_tiny_fit import sha256_file
from sam3_compare import log
from sam3_quality_refine import (CONFIGS, aggregate, measured, prediction_arrays,
                                selection_key, validation_sweep)
from sam3_parcel_postprocess import parcel_masks
from sam3_compact_features import load_vision, _model_hashes
from sam3_stream_features import StreamingVision

HERE = Path(__file__).resolve().parent
SEED = 20261003
SOURCES = ('sam3_expanded_train.py', 'sam3_compact_features.py', 'sam3_stream_features.py', 'prepare_sam3_expanded.py',
           'prepare_sam3_dataset.py', 'sam3_losses.py', 'sam3_quality_refine.py',
           'sam3_parcel_postprocess.py', 'sam3_tiny_fit.py', 'sam3_finetune.py',
           'sam3_compare.py', 'evaluate.py', 'guess.py')


def fresh_split_check(samples, prior):
    """Previously examined imagery/parcel identities cannot enter the new holdouts."""
    check_split_leakage(samples)
    old_ids = {s['id'] for s in prior}
    old_sources = {str(i) for s in prior for i in s['source_ids']}
    old_examined_sources = {str(i) for s in prior if s['split'] != 'train' for i in s['source_ids']}
    for sample in samples:
        source_ids = set(map(str, sample['source_ids']))
        if sample['split'] != 'train':
            if sample['id'] in old_ids or source_ids & old_sources:
                raise ValueError('Previously seen parcel identity in fresh holdout')
            if any(bbox_gap(sample['bbox'], old['bbox']) < 500 for old in prior):
                raise ValueError('Fresh holdout is within 500 m of previously examined imagery')
        elif source_ids & old_examined_sources:
            raise ValueError('Previously examined validation/test parcel identity enters training')
        elif sample['id'] not in old_ids and any(bbox_gap(sample['bbox'], old['bbox']) < 500 for old in prior):
            raise ValueError('New training imagery is within 500 m of previously examined imagery')


def ensure_space(path, extra_bytes=0):
    if shutil.disk_usage(path).free < 1024**3 + extra_bytes:
        raise RuntimeError('Insufficient disk space: preserve the 1 GiB reserve; no artifacts were deleted')


def write_npz(path, **arrays):
    temporary = path.with_suffix('.npz.tmp')
    with temporary.open('wb') as stream:
        np.savez_compressed(stream, **arrays)
    temporary.replace(path)


def osm_masks(sample, dataset, output):
    """Reuse the earlier OSM nearest-building baseline without training or labels."""
    from scipy.ndimage import distance_transform_edt
    from guess import draw_polygon, draw_roads, draw_water
    data = json.loads((dataset / sample['osm_input']).read_text())
    seeds = np.zeros((256, 256), np.int32)
    for number, feature in enumerate(data['buildings'], 1):
        draw_polygon(seeds, feature['geometry'], sample['bbox'], number)
    labels = np.zeros_like(seeds)
    if seeds.any():
        nearest = distance_transform_edt(seeds == 0, return_indices=True)[1]
        labels = seeds[nearest[0], nearest[1]]
        barrier = (draw_roads(data['roads'], sample['bbox']) |
                   draw_water(data.get('water', []), sample['bbox'])) & (seeds == 0)
        labels[barrier] = 0
    masks = np.asarray([labels == number for number in np.unique(labels) if number], dtype=bool)
    if not len(masks):
        masks = np.zeros((0, 256, 256), bool)
    write_npz(output / (sample['id'] + '.npz'), masks=masks, labels=labels)
    return masks


def read_samples(root):
    samples = json.loads((root / 'samples.json').read_text())
    if isinstance(samples, dict):
        samples = samples['samples']
    for sample in samples:
        truth = json.loads((root / sample['truth']).read_text())
        sample['source_ids'] = [str(f['properties']['cestica_id']) for f in truth['features']]
    return samples


def combine_sweeps(sweeps):
    """Pool per-tile counts for each cleanup config without retaining probabilities."""
    candidates = [dict(config=config, details=[]) for config in CONFIGS]
    for sweep in sweeps:
        if [item['config'] for item in sweep] != list(CONFIGS):
            raise ValueError('Validation cleanup configuration order changed')
        for candidate, item in zip(candidates, sweep):
            candidate['details'].extend(item['details'])
    for candidate in candidates:
        candidate['summary'] = aggregate(candidate['details'])
    return max(candidates, key=lambda row: selection_key(row['summary'])), candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    for name in ('dataset', 'prior-dataset', 'cache', 'features', 'initial', 'output'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--epochs', type=int, default=4)
    parser.add_argument('--learning-rate', type=float, default=1e-4)
    parser.add_argument('--device', choices=('mps', 'cuda', 'cpu'), default='mps')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--stream', action='store_true', help='CPU frozen backbone with a four-tile RAM cache; no disk feature cache')
    parser.add_argument('--backbone-device', choices=('cpu', 'mps', 'cuda'), default='cpu')
    parser.add_argument('--backbone-dtype', choices=('float32', 'float16'), default='float32')
    parser.add_argument('--smoke', action='store_true', help='four training tiles only; no holdout evaluation')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    if not all(getattr(args, n) for n in ('dataset', 'prior_dataset', 'cache', 'initial', 'output')) or (not args.stream and not args.features):
        parser.error('Explicit dataset, prior dataset, cache, initial and output are required; supply features or --stream')
    if args.epochs < 0 or args.learning_rate <= 0:
        parser.error('Epochs must be nonnegative and learning rate positive')
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS is unavailable in this execution environment')
    samples, prior = read_samples(args.dataset), read_samples(args.prior_dataset)
    fresh_split_check(samples, prior)
    splits = {s: [r for r in samples if r['split'] == s] for s in ('train', 'validation', 'test')}
    if not all(splits.values()) or len(splits['train']) <= 32:
        raise ValueError('A larger training set and nonempty fresh holdouts are required')
    if args.smoke:
        from sam3_tiny_fit import select_first_block
        train = select_first_block(samples, 4)
        validation, test, used = train, [], train
    else:
        train, validation, test, used = splits['train'], splits['validation'], splits['test'], samples
    snapshot = Path(snapshot_download('facebook/sam3', revision=REVISION, cache_dir=args.cache,
                          local_files_only=True, allow_patterns=['*.json', '*.txt', '*.model', '*.safetensors']))
    inputs = {'dataset/samples.json': sha256_file(args.dataset / 'samples.json'),
              'dataset/manifest.json': sha256_file(args.dataset / 'manifest.json'),
              'prior/samples.json': sha256_file(args.prior_dataset / 'samples.json'),
              'initial.pt': sha256_file(args.initial)}
    model_weights_hash, model_config_hash = _model_hashes(snapshot)
    if not args.stream:
        cache_manifest_path = args.features.parent / 'manifest.json'
        cache_recipe = json.loads(cache_manifest_path.read_text())['recipe']
        if (cache_recipe['dataset_samples_sha256'] != inputs['dataset/samples.json']
                or cache_recipe['model_revision'] != REVISION
                or cache_recipe['model_weights_sha256'] != model_weights_hash
                or cache_recipe['model_config_sha256'] != model_config_hash):
            raise ValueError('Compact cache dataset/model recipe mismatch')
        inputs['features/manifest.json'] = sha256_file(cache_manifest_path)
    for sample in used:
        for field in ('image', 'truth', 'masks', 'osm_input'):
            if field in sample:
                inputs['dataset/' + sample[field]] = sha256_file(args.dataset / sample[field])
        if args.stream:
            continue
        feature = args.features / (sample['id'] + '.pt')
        sidecar = json.loads(feature.with_suffix('.json').read_text())
        digest = sha256_file(feature)
        if sidecar.get('feature_sha256') != digest:
            raise ValueError('Compact feature hash mismatch: ' + sample['id'])
        if (sidecar.get('complete') is not True or sidecar.get('model_revision') != REVISION
                or sidecar.get('model_weights_sha256') != model_weights_hash
                or sidecar.get('model_config_sha256') != model_config_hash
                or sidecar.get('image_sha256') != inputs['dataset/' + sample['image']]
                or sidecar.get('tensor', {}).get('dtype') != 'torch.float32'
                or sidecar.get('tensor', {}).get('shape') != [1, 5184, 1024]):
            raise ValueError('Compact feature provenance mismatch: ' + sample['id'])
        inputs['features/' + feature.name] = digest
        inputs['features/' + feature.with_suffix('.json').name] = sha256_file(feature.with_suffix('.json'))
    for path in sorted(snapshot.glob('*.safetensors')):
        inputs['model/' + path.name] = sha256_file(path)
    recipe = dict(inputs_sha256=inputs, source_sha256={name: sha256_file(HERE / name) for name in SOURCES},
                  model_revision=REVISION, trainable_prefixes=list(PREFIXES), prompt='land parcel',
                  seed=SEED, epochs=args.epochs, learning_rate=args.learning_rate,
                  loss='original Hungarian mask/box, query focal and presence objective', loss_resolution=128,
                  target_masks='original exported 256x256 max-pooled cadastral masks',
                  feature_cache=(f'{args.backbone_device} {args.backbone_dtype} backbone; four-tile float32 RAM cache; frozen neck on head device'
                                 if args.stream else 'lossless float32 backbone hidden states; frozen neck regenerated per tile'),
                  cleanup_grid=CONFIGS, selection='validation whole-parcel micro F1; boundary F1 breaks ties',
                  splits={s: [r['id'] for r in group] for s, group in
                          [('train', train), ('validation', validation), ('test', test)]},
                  mode='four-training-tile smoke' if args.smoke else 'fresh geographic holdout',
                  device=args.device, vision_device=args.backbone_device if args.stream else args.device,
                  backbone_dtype=args.backbone_dtype if args.stream else 'float32',
                  torch_version=str(torch.__version__), transformers_version=TRANSFORMERS_VERSION,
                  text_device='cpu' if args.stream else args.device,
                  trainable_dtype='float32', metered_api_usd=0)
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    ensure_space(output)
    if (output / 'recipe.json').exists() and json.loads((output / 'recipe.json').read_text()) != recipe:
        raise ValueError('Recipe mismatch: preserve this run and choose a new output directory')
    if (output / 'last.pt').exists() and not args.resume:
        raise ValueError('Existing checkpoint: pass --resume')
    json_save(recipe, output / 'recipe.json')
    source = output / 'source'
    source.mkdir(exist_ok=True)
    for name in SOURCES:
        shutil.copyfile(HERE / name, source / name)
    model = Sam3Model.from_pretrained(snapshot, local_files_only=True).eval()
    if not args.stream:
        model.to(args.device)
    processor = Sam3Processor.from_pretrained(snapshot, local_files_only=True)
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith(PREFIXES))
    with torch.no_grad():
        text_inputs = processor(text='land parcel', return_tensors='pt').to('cpu' if args.stream else args.device)
        text = model.get_text_features(text_inputs.input_ids, text_inputs.attention_mask)
        text_embeds = BaseModelOutputWithPooling(pooler_output=text.pooler_output.to(args.device))
    attention_mask = text_inputs.attention_mask.to(args.device)
    neck = model.vision_encoder.neck
    backbone = model.vision_encoder.backbone if args.stream else None
    model.vision_encoder = None
    model.text_encoder = None
    if args.stream:
        model.to(args.device)
        neck.to(args.device)
        streamer = StreamingVision(backbone, neck, processor, args.dataset, device=args.device,
                                   backbone_device=args.backbone_device,
                                   backbone_dtype=getattr(torch, args.backbone_dtype))
    gc.collect()
    if args.device == 'mps':
        torch.mps.empty_cache()
    initial = torch.load(args.initial, weights_only=True, map_location='cpu')
    apply_adaptation(model, initial)
    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=args.learning_rate, weight_decay=.01)
    log(f'Expanded training · {len(train)} training tiles · {len(validation)} selection tiles · API $0')

    def predict(sample):
        vision = streamer(sample['id']) if args.stream else load_vision(neck, args.features, sample['id'], args.device)
        return model(vision_embeds=vision, text_embeds=text_embeds, attention_mask=attention_mask)

    def select_validation(group):
        sweeps = []
        for i, sample in enumerate(group, 1):
            with torch.no_grad():
                predictions = predict(sample)
                arrays = {sample['id']: prediction_arrays(predictions)}
            del predictions
            _, sweep = validation_sweep(arrays, [sample], args.dataset)
            sweeps.append(sweep)
            del arrays
            if args.device == 'mps':
                torch.mps.empty_cache()
            log(f'Validation scoring {i}/{len(group)} · {sample["id"]} · API $0')
        return combine_sweeps(sweeps)

    epoch = index = step = 0
    history, selection_history = [], []
    best_epoch = 0
    if args.resume and (output / 'last.pt').exists():
        state = torch.load(output / 'last.pt', weights_only=False, map_location='cpu')
        if state['recipe'] != recipe:
            raise ValueError('Checkpoint recipe mismatch')
        apply_adaptation(model, state['adaptation'])
        optimizer.load_state_dict(state['optimizer'])
        epoch, index, step = state['epoch'], state['index'], state['step']
        history, selection_history = state['history'], state['selection_history']
        best, best_epoch, baseline = state['best'], state['best_epoch'], state['baseline']
        log(f'Resume: {step} completed updates skipped')
    else:
        baseline, sweep = select_validation(validation)
        best = baseline
        json_save(dict(selected=baseline, sweep=sweep), output / 'baseline-selection.json')
        save(initial, output / 'best.pt')
        selection_history.append(dict(epoch=0, selected=best))

    def checkpoint(e, next_index):
        ensure_space(output, 200_000_000)
        save(dict(recipe=recipe, adaptation=adaptation(model), optimizer=optimizer.state_dict(),
                  epoch=e, index=next_index, step=step, history=history, selection_history=selection_history,
                  best=best, best_epoch=best_epoch, baseline=baseline), output / 'last.pt')

    checkpoint(epoch, index)
    started, started_step = time.monotonic(), step
    while epoch < args.epochs:
        order = list(train)
        random.Random(SEED + epoch).shuffle(order)
        for current in range(index, len(order)):
            sample = order[current]
            targets = torch.from_numpy(np.load(args.dataset / sample['masks'])['masks']).float().to(args.device)
            optimizer.zero_grad(set_to_none=True)
            tick = time.monotonic()
            predictions = predict(sample)
            loss, pieces = parcel_loss(predictions, targets, resolution=128)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite training loss')
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
            log(f'Train {step}/{args.epochs * len(train)} · loss {history[-1]["loss"]:.3f} · ETA {eta:.0f}s · API $0')
        selected, sweep = select_validation(validation)
        json_save(dict(selected=selected, sweep=sweep), output / f'epoch-{epoch + 1}-selection.json')
        selection_history.append(dict(epoch=epoch + 1, selected=selected))
        if selection_key(selected['summary']) > selection_key(best['summary']):
            best, best_epoch = selected, epoch + 1
            save(adaptation(model), output / 'best.pt')
        log(f'Selection epoch {epoch + 1} · shape F1 {selected["summary"]["shape_f1"]:.3f} · best epoch {best_epoch}')
        epoch += 1
        index = 0
        checkpoint(epoch, index)
    methods = {}
    final_group = train if args.smoke else test
    if not args.smoke:
        folder = output / 'predictions' / 'OSM'
        folder.mkdir(parents=True, exist_ok=True)
        rows = [measured(osm_masks(sample, args.dataset, folder), sample, args.dataset) for sample in test]
        methods['OSM'] = dict(summary=aggregate(rows), details=rows)
    trained = torch.load(output / 'best.pt', weights_only=True, map_location='cpu')
    for prefix, weights, selected in [('previous', initial, baseline), ('expanded', trained, best)]:
        apply_adaptation(model, weights)
        raw_rows, cleaned_rows = [], []
        raw_dir, clean_dir = output / 'predictions' / (prefix + '-raw'), output / 'predictions' / (prefix + '-cleaned')
        raw_dir.mkdir(parents=True, exist_ok=True)
        clean_dir.mkdir(parents=True, exist_ok=True)
        for i, sample in enumerate(final_group, 1):
            with torch.no_grad():
                predictions = predict(sample)
                probability, scores = prediction_arrays(predictions)
            raw = probability[scores > .3] > .5
            cleaned, clean_scores, query_ids, diagnostics = parcel_masks(probability, scores, **selected['config'])
            write_npz(raw_dir / (sample['id'] + '.npz'), masks=raw, scores=scores[scores > .3])
            write_npz(clean_dir / (sample['id'] + '.npz'), masks=cleaned, scores=clean_scores, query_indices=query_ids)
            raw_rows.append(measured(raw, sample, args.dataset))
            row = measured(cleaned, sample, args.dataset)
            row['cleanup'] = diagnostics
            cleaned_rows.append(row)
            del predictions, probability
            if args.device == 'mps':
                torch.mps.empty_cache()
            log(f'{prefix} final inference {i}/{len(final_group)} · {sample["id"]} · API $0')
        methods[prefix + '-raw'] = dict(summary=aggregate(raw_rows), details=raw_rows)
        methods[prefix + '-cleaned'] = dict(summary=aggregate(cleaned_rows), details=cleaned_rows)
    result = dict(recipe=recipe, best_epoch=best_epoch, selected=best, baseline_selected=baseline,
                  selection_history=selection_history, methods=methods, completed_updates=step,
                  evaluation_split='train only' if args.smoke else 'fresh test',
                  trainable_parameters=sum(p.numel() for p in parameters), metered_api_usd=0,
                  maximum_adapter_delta=max((trained[k] - initial[k]).abs().max().item() for k in trained))
    if args.stream:
        result['streaming_features'] = streamer.stats
    json_save(result, output / 'results.json')
    log(f'Complete · { {k: v["summary"] for k, v in methods.items()} }')


if __name__ == '__main__':
    main()
