#!/usr/bin/env python3
"""Evaluate an exact-cell polygon contract on unchanged saved region labels from the frozen diagnostic."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from cell_partition import vectorize_cells, verify_cell_partition
from visible_division_study import ANNOTATION_SHA256, checked_file, digest, summarize_rows, write_json
from visible_divisions import score_collection, validate_annotations

HERE = Path(__file__).resolve().parent
PROTOCOL_SHA256 = 'c77269f1b6cbc1ce1d52642c01ddde6b1df22f4a6cfbd6a3112574029cb0e937'
VARIANTS = {'control-120m2': 'cell-120m2', 'no-small-region-merge': 'cell-no-small-region-merge'}


def run_study(source, output):
    annotations_path = HERE / 'annotations/visible-divisions-v1.json'
    protocol_path = HERE / 'annotations/cell-partition-v1.md'
    if digest(annotations_path) != ANNOTATION_SHA256 or digest(protocol_path) != PROTOCOL_SHA256:
        raise ValueError('frozen annotation or cell protocol changed')
    annotations = json.loads(annotations_path.read_text())
    validate_annotations(annotations)
    samples = {s['id']: s for s in annotations['samples']}
    original_path = source / 'report.json'
    original = json.loads(original_path.read_text())
    if (original['schema'] != 'visible-division-study-v1' or original['annotation_sha256'] != ANNOTATION_SHA256
            or original['control_reproduction'] != {'passed': True, 'tile_outputs': 27, 'comparison': 'exact parsed JSON'}):
        raise ValueError('source comparison is not the reproduced frozen study')
    expected = {(seed, tid, variant) for seed in (1, 2, 3) for tid in samples for variant in VARIANTS}
    actual = [(r['seed'], r['sample_id'], r['variant']) for r in original['rows']]
    if set(actual) != expected or len(actual) != len(expected):
        raise ValueError('source needs exactly the 54 frozen seed/image/variant rows')
    rows = []
    for row in original['rows']:
        tid, seed = row['sample_id'], row['seed']
        sample = samples[tid]
        if row['image_sha256'] != sample['image_sha256']:
            raise ValueError('source image binding mismatch')
        label_path = checked_file(source, row['labels'])
        if digest(label_path) != row['labels_sha256']:
            raise ValueError('source labels hash mismatch')
        labels = np.load(label_path, allow_pickle=False)
        if labels.shape != (256, 256):
            raise ValueError('source labels must use the frozen 256 grid')
        variant = VARIANTS[row['variant']]
        collection = vectorize_cells(labels, sample['bbox'], tid)
        name = f'seed-{seed}/{variant}/{tid}.geojson'
        write_json(output / name, collection)
        # Re-read the serialized artifact before verifying or scoring it.
        collection = json.loads((output / name).read_text())
        verification = verify_cell_partition(collection, labels, sample['bbox'])
        score = score_collection(collection, sample)
        score.update(seed=seed, variant=variant, region=sample['region'], polygons=name,
                     polygon_sha256=digest(output / name), labels_sha256=row['labels_sha256'],
                     image_sha256=row['image_sha256'], scoring_status='scored', cell_verification=verification)
        rows.append(score)
        write_json(output / name.replace('.geojson', '.score.json'), score)
        print(f'{datetime.now(timezone.utc).isoformat(timespec="seconds")} {len(rows)}/54 seed {seed} {tid} {variant}: exact cells verified', flush=True)
    report = {'schema': 'visible-cell-partition-study-v1', 'created_at': datetime.now(timezone.utc).isoformat(),
              'annotation_sha256': ANNOTATION_SHA256, 'protocol_sha256': PROTOCOL_SHA256,
              'source_report_sha256': digest(original_path), 'review_status': 'agent-draft',
              'scoring_complete': True, 'cell_verification_complete': True,
              'source_geometry_invalid_outputs': {v: sum(r['variant'] == v and r['scoring_status'] != 'scored'
                                                         for r in original['rows']) for v in VARIANTS},
              'rental_cost_usd': 0, 'inference_runs': 0, 'training_runs': 0,
              'limitations': annotations['limitations'] + ['Exact raster cell edges have 0.6 m staircase detail; no smoothing or runtime integration.'],
              'dependencies': original['dependencies'],
              'source_sha256': {name: digest(HERE / name) for name in
                                ('cell_partition.py', 'visible_partition_study.py', 'visible_divisions.py', 'visible_division_study.py')},
              'summaries': summarize_rows(rows, tuple(VARIANTS.values())), 'rows': rows}
    write_json(output / 'report.json', report)
    print(json.dumps([s for s in report['summaries'] if s['seed'] is None], indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Original comparison output directory')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run_study(args.source, args.output)


if __name__ == '__main__':
    main()
