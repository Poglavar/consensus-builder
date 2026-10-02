#!/usr/bin/env python3
"""Run cached SAM 3 on fixed imagery samples, then evaluate against separate cadastre."""
import argparse
import hashlib
import html
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from evaluate import boundary, rasterize_reference, score_boundaries
from guess import GRID


PROMPTS = [('land parcel', 'parcel'), ('residential plot', 'parcel'),
           ('agricultural field', 'parcel'), ('building', 'control')]


def log(message):
    print(f'[{datetime.now(timezone.utc).isoformat(timespec="seconds")}] {message}', flush=True)


def shrink_masks(masks):
    return [np.asarray(Image.fromarray(np.uint8(mask) * 255).resize(
        (GRID, GRID), Image.Resampling.NEAREST)) > 0 for mask in masks]


def evaluate_masks(masks, truth_edges, truth_coverage, metres_per_pixel):
    """Union instance edges without letting later overlapping masks erase earlier edges."""
    predicted_edges = np.zeros_like(truth_edges)
    coverage = np.zeros_like(truth_coverage)
    multiplicity = np.zeros(truth_edges.shape, np.uint16)
    for mask in masks:
        predicted_edges |= boundary(mask.astype(np.uint8))
        coverage |= mask
        multiplicity += mask
    metrics = {
        'instances': len(masks),
        'coverage_fraction': round(float(coverage.mean()), 4),
        'overlap_fraction': round(float((multiplicity > 1).mean()), 4),
        'reference_coverage_fraction': round(float(truth_coverage.mean()), 4),
        'boundary_scores': {str(tolerance): score_boundaries(
            predicted_edges, truth_edges, tolerance / metres_per_pixel)
            for tolerance in (1, 2, 5)},
    }
    return metrics, predicted_edges


def evaluate_instances(masks, reference_masks):
    """One-to-one shape matching on tile-clipped masks, separate from boundary proximity."""
    from scipy.optimize import linear_sum_assignment
    ious = np.zeros((len(masks), len(reference_masks)))
    for i, prediction in enumerate(masks):
        for j, reference in enumerate(reference_masks):
            union = np.count_nonzero(prediction | reference)
            ious[i, j] = np.count_nonzero(prediction & reference) / union if union else 0
    matched = 0
    if ious.size:
        rows, cols = linear_sum_assignment(ious >= 0.5, maximize=True)
        matched = int((ious[rows, cols] >= 0.5).sum())
    return {
        'iou_threshold': 0.5, 'reference_instances': len(reference_masks),
        'matched_instances': matched,
        'precision': round(matched / len(masks), 3) if len(masks) else 0,
        'recall': round(matched / len(reference_masks), 3) if len(reference_masks) else 0,
        'mean_best_reference_iou': round(float(ious.max(axis=0).mean()), 3) if ious.size else 0,
    }


def overlay(rgb, edges, truth_edges=None):
    image = Image.fromarray(rgb).convert('RGBA')
    layer = np.zeros((*edges.shape, 4), np.uint8)
    if truth_edges is not None:
        layer[truth_edges] = (255, 60, 190, 255)
    layer[edges] = (0, 240, 255, 255)
    image.alpha_composite(Image.fromarray(layer).resize(image.size, Image.Resampling.NEAREST))
    return image.convert('RGB')


def make_comparison(rgb, baseline_edges, sam_edges, truth_edges, output, title):
    cards = []
    for label, edges, reference in [
        ('Imagery', np.zeros_like(truth_edges), None),
        ('Earlier building-distance baseline', baseline_edges, None),
        ('SAM 3 (cyan) + cadastre (pink)', sam_edges, truth_edges),
        ('Cadastral reference', np.zeros_like(truth_edges), truth_edges),
    ]:
        picture = overlay(rgb, edges, reference).resize((512, 512))
        card = Image.new('RGB', (512, 550), (18, 23, 30))
        card.paste(picture, (0, 38))
        ImageDraw.Draw(card).text((12, 12), label, fill='white')
        cards.append(card)
    canvas = Image.new('RGB', (1024, 1140), (18, 23, 30))
    ImageDraw.Draw(canvas).text((12, 12), title, fill='white')
    for i, card in enumerate(cards):
        canvas.paste(card, ((i % 2) * 512, 40 + (i // 2) * 550))
    canvas.save(output)


def export_masks(masks, scores, bbox, destination, prompt):
    """Export independent raw instance polygons, preserving their possible overlaps."""
    from rasterio.features import shapes
    from rasterio.transform import from_bounds
    from shapely.geometry import shape, mapping
    features = []
    for index, (mask, confidence) in enumerate(zip(masks, scores)):
        transform = from_bounds(*bbox, mask.shape[1], mask.shape[0])
        for geometry, _ in shapes(mask.astype(np.uint8), mask=mask, transform=transform):
            polygon = shape(geometry)
            if polygon.is_empty or not polygon.is_valid:
                raise ValueError(f'Invalid raw instance polygon {index}')
            features.append({'type': 'Feature', 'geometry': mapping(polygon), 'properties': {
                'estimated': True, 'model': 'facebook/sam3', 'prompt': prompt,
                'instance': index, 'model_score': float(confidence),
                'parcel_confidence': 'uncalibrated',
            }})
    destination.write_text(json.dumps({'type': 'FeatureCollection',
        'crs': {'type': 'name', 'properties': {'name': 'EPSG:3765'}}, 'features': features}))


def write_report(results, destination, identity):
    rows, pictures = [], []
    for result in results:
        score = result['boundary_scores']['2']
        rows.append('<tr>' + ''.join(f'<td>{html.escape(str(value))}</td>' for value in [
            result['tile'], result['prompt'], result['role'], result['instances'],
            f"{result['coverage_fraction']:.1%}", score['precision'], score['recall'], score['f1'],
            result['baseline']['f1'],
            f"{result['instance_scores']['matched_instances']}/{result['instance_scores']['reference_instances']}",
        ]) + '</tr>')
        pictures.append(f'<section><h2>{html.escape(result["tile"])} · '
                        f'{html.escape(result["prompt"])}</h2>'
                        f'<a href="{result["preview"]}"><img src="{result["preview"]}" '
                        'alt="Imagery, baseline, SAM 3 and cadastral comparison"></a></section>')
    document = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAM 3 parcel comparison</title><style>
body{background:#12171e;color:#e7edf5;font:16px system-ui;margin:24px auto;padding:0 16px;max-width:1200px}
p{line-height:1.6;max-width:900px}a{color:#65deec}img{width:100%;max-width:1024px;height:auto}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:10px;text-align:left;border-bottom:1px solid #394454}
.table{overflow-x:auto}section{margin-top:40px}code{overflow-wrap:anywhere}
</style><h1>SAM 3: Zagreb parcel comparison</h1>
<p>Two fixed 153.6 × 153.6 m Zagreb samples. The unchanged model sees only RGB imagery and a text prompt.
Cadastre is opened separately for evaluation. No cadastral points or boxes are supplied to the model.</p>
<p>Boundary scores use the same 256 × 256 evaluation grid as the earlier baseline, a 2 m tolerance,
and exclude the outer 1.8 m strip. Shape matches require one-to-one mask IoU ≥ 0.5 on tile-clipped parcels.
Coverage and overlaps are reported separately: finding a few correct edges
does not establish a complete parcel network. Building is a runtime control, not a parcel method.
Model scores are not calibrated parcel confidence. These two previously explored samples are a smoke test,
not an independent geographical benchmark.</p>
<p>Local cached inference; metered API cost: $0. Timing on this busy machine is not a performance benchmark.</p>
'''
    document += '<p>Model revision: <code>' + html.escape(identity) + '</code></p>'
    document += '<div class="table"><table><thead><tr>' + ''.join(
        f'<th>{x}</th>' for x in ['Tile', 'Prompt', 'Role', 'Masks', 'Coverage',
                                'Precision', 'Recall', 'F1', 'Earlier baseline F1', 'Shape matches'])
    document += '</tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>'
    document += ''.join(pictures) + '</html>'
    destination.write_text(document)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Run the small local inference experiment')
    parser.add_argument('--samples', type=Path, required=True, help='Existing spike output directory')
    parser.add_argument('--imagery', type=Path, required=True, help='Existing CDOF GeoTIFF cache')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, help='Explicit checkpoint cache directory')
    parser.add_argument('--download', action='store_true', help='Download missing weights once')
    parser.add_argument('--auth-env', type=Path, help='Existing credential file, never logged')
    parser.add_argument('--revision', help='Pin the Hugging Face model revision')
    parser.add_argument('--evaluate-only', action='store_true', help='Reevaluate completed raw masks without loading the model')
    parser.add_argument('--tiles', nargs='+', default=['2971_33018', '2980_33040'])
    parser.add_argument('--device', choices=['mps', 'cuda', 'cpu'], default='mps')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    import torch
    from transformers import Sam3Model, Sam3Processor
    from huggingface_hub import snapshot_download
    torch.set_num_threads(2)
    if not args.evaluate_only and args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS unavailable; run with local GPU access or explicitly choose another device')
    token = None
    if args.download and args.auth_env:
        from dotenv import dotenv_values
        values = dotenv_values(args.auth_env)
        token = values.get('HF_TOKEN') or values.get('HF_API_KEY')
        if not token:
            raise RuntimeError('No configured Hugging Face credential in supplied file')
    log('Preparing checkpoint; downloading missing files' if args.download else 'Using offline checkpoint cache')
    snapshot = snapshot_download('facebook/sam3', local_files_only=not args.download,
        cache_dir=args.cache, revision=args.revision, token=token,
        allow_patterns=['*.json', '*.txt', '*.safetensors', '*.model'])
    identity = Path(snapshot).name
    model = processor = None
    if not args.evaluate_only:
        log(f'Loading cached SAM 3 revision {identity} on {args.device}; no download or API call')
        model = Sam3Model.from_pretrained(snapshot, local_files_only=True).to(args.device).eval()
        processor = Sam3Processor.from_pretrained(snapshot, local_files_only=True)
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    total = len(args.tiles) * len(PROMPTS)
    done = 0
    started = time.monotonic()
    for tile in args.tiles:
        sample = args.samples / f'tile_{tile}'
        data = json.loads((sample / 'input.json').read_text())
        bbox = data['tile']['bbox']
        imagery = args.imagery / f'tile_{tile}.tif'
        image = Image.open(imagery).convert('RGB')
        rgb = np.asarray(image)
        image_hash = hashlib.sha256(imagery.read_bytes()).hexdigest()
        arrays = dict(np.load(sample / 'masks.npz'))
        # Reference is never passed to the model or used to select prompts/thresholds.
        reference = json.loads((sample / 'truth.json').read_text())
        reference_masks, truth_edges, truth_coverage = rasterize_reference(reference['features'], bbox)
        baseline = score_boundaries(boundary(arrays['baseline']), truth_edges, 2 / ((bbox[2]-bbox[0])/GRID))
        for prompt, role in PROMPTS:
            slug = prompt.replace(' ', '-')
            target = args.output / f'{tile}_{slug}'
            target.mkdir(exist_ok=True)
            raw_file = target / 'instances.npz'
            metadata_file = target / 'inference.json'
            expected = {'image_sha256': image_hash, 'model_revision': identity,
                        'prompt': prompt, 'threshold': 0.3, 'mask_threshold': 0.5}
            if raw_file.exists() and metadata_file.exists() and all(
                    json.loads(metadata_file.read_text()).get(k) == v for k, v in expected.items()):
                raw = np.load(raw_file)
                masks, scores = raw['masks'], raw['scores']
                metadata = json.loads(metadata_file.read_text())
                log(f'Skipping completed artifact {tile}: {prompt}')
            else:
                if args.evaluate_only:
                    raise RuntimeError(f'No matching completed inference for {tile}: {prompt}')
                log(f'{done+1}/{total} · {tile} · prompt "{prompt}"')
                t0 = time.monotonic()
                inputs = processor(images=image, text=prompt, return_tensors='pt').to(args.device)
                with torch.inference_mode():
                    outputs = model(**inputs)
                result = processor.post_process_instance_segmentation(
                    outputs, threshold=0.3, mask_threshold=0.5,
                    target_sizes=inputs['original_sizes'].tolist())[0]
                masks = result['masks'].detach().cpu().numpy().astype(bool)
                scores = result['scores'].detach().cpu().numpy()
                metadata = {**expected, 'device': args.device, 'elapsed_seconds': time.monotonic()-t0,
                            'created_at': datetime.now(timezone.utc).isoformat(),
                            'metered_api_usd': 0, 'cadastral_input_to_model': False}
                np.savez_compressed(raw_file, masks=masks, scores=scores)
                metadata_file.write_text(json.dumps(metadata, indent=2))
                del inputs, outputs, result
                if args.device == 'mps':
                    torch.mps.empty_cache()
            small_masks = shrink_masks(masks)
            metrics, predicted_edges = evaluate_masks(small_masks, truth_edges,
                truth_coverage, (bbox[2]-bbox[0])/GRID)
            metrics['instance_scores'] = evaluate_instances(small_masks, reference_masks)
            export_masks(masks, scores, bbox, target / 'instances.geojson', prompt)
            make_comparison(rgb, boundary(arrays['baseline']), predicted_edges,
                            truth_edges, target / 'comparison.png', f'{tile} · {prompt}')
            metrics.update({'tile': tile, 'prompt': prompt, 'role': role, 'baseline': baseline,
                'inference': metadata, 'preview': f'{target.name}/comparison.png'})
            (target / 'metrics.json').write_text(json.dumps(metrics, indent=2))
            results.append(metrics)
            (args.output / 'results.json').write_text(json.dumps(results, indent=2))
            write_report(results, args.output / 'index.html', identity)
            done += 1
            eta = (time.monotonic()-started) / done * (total-done)
            log(f'{done}/{total} complete · {len(masks)} masks · F1@2m={metrics["boundary_scores"]["2"]["f1"]} · ETA {eta:.0f}s')
    log(f'Complete: {args.output / "index.html"}')


if __name__ == '__main__':
    main()
