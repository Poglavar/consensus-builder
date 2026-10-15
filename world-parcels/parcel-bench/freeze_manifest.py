#!/usr/bin/env python3
"""Freeze a ParcelBench city manifest from an exported spike dataset manifest: fixed selection and final
tiles with their density strata and reference hashes, the training pool, the exhausted spike tiles, and
provenance. The first use is zagreb-v1 from the expanded SAM 3 dataset. Refuses to overwrite a frozen
manifest unless --force, because a benchmark that moves is not a benchmark."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parent / 'guess-spike' / 'output' / 'parcel-expanded-check' / 'dataset' / 'manifest.json'
SMOKE_TILES = ('tile_2971_33018', 'tile_2980_33040')
RIGHTS = ('Croatian public-sector data (City of Zagreb CDOF 2022; state DOF likewise), paid by the taxpayer and free for '
          'research use including model training; verified by the project owner on 2026-10-12')
LEGAL = 'civil law; Austro-Hungarian (Franciscan) cadastre lineage, DKP via OSS WFS'
CITIES = {
    'zagreb': {'slug': 'zagreb', 'name': 'Zagreb', 'country_code': 'HR', 'geonames_id': 3186886, 'legal_tradition': LEGAL,
               'imagery_rights': RIGHTS},
    'split': {'slug': 'split', 'name': 'Split', 'country_code': 'HR', 'geonames_id': 3190261, 'legal_tradition': LEGAL,
              'imagery_rights': RIGHTS},
    'zadar': {'slug': 'zadar', 'name': 'Zadar', 'country_code': 'HR', 'legal_tradition': LEGAL,
              'imagery_rights': RIGHTS},
    'sibenik': {'slug': 'sibenik', 'name': 'Šibenik', 'country_code': 'HR', 'legal_tradition': LEGAL,
                'imagery_rights': RIGHTS},
}
RULES = (
    'selection tiles choose checkpoints, thresholds and cleanup; final tiles are scored once per milestone '
    'and every final score is recorded in the ledger with its recipe hash',
    'training uses only the training pool; no tile within 500 m of a selection or final tile, and no parcel '
    'source id shared with them',
    'exhausted tiles were inspected repeatedly during the 2026-10 SAM 3 spike and are diagnostic only',
    'every number comes from parcel-bench/score.py with the parameters recorded here',
    'interior metrics (unclipped references) are the headline for tiles this small; clipped parcels stay in '
    'the counts so recall is never inflated by dropping them',
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tile_record(sample, block):
    return {
        'id': sample['id'], 'bbox': sample['bbox'], 'density_bin': block.get('density_bin'),
        'parcel_count': sample.get('parcel_count'), 'source_ids': sorted(sample.get('source_ids', [])),
        'image': sample['image'], 'truth': sample['truth'], 'osm_input': sample.get('osm_input'),
        'truth_sha256': (sample.get('sha256') or {}).get('truth'),
        'image_sha256': (sample.get('sha256') or {}).get('image'),
    }


def freeze(source: Path, city: dict, koppen_class: str | None):
    manifest = json.loads(source.read_text())
    block_of = {tile: block for block in manifest['geographic_blocks'] for tile in block['tiles']}
    by_split = {'train': [], 'validation': [], 'test': []}
    for sample in manifest['samples']:
        by_split[sample['split']].append(tile_record(sample, block_of.get(sample['id'], {})))
    for records in by_split.values():
        records.sort(key=lambda record: record['id'])
    smoke = SMOKE_TILES if city['slug'] == 'zagreb' else ()
    exhausted = sorted(set(manifest['exclusions'].get('prior_tile_ids', [])) | set(smoke))
    try:
        source_path = str(source.resolve().relative_to(HERE.parent.resolve()))
    except ValueError:
        source_path = str(source)
    return {
        'benchmark': 'parcelbench', 'version': f"{city['slug']}-v1",
        'frozen_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'city': {k: v for k, v in city.items() if k != 'slug'},
        'practice_region': {
            'country': city['country_code'], 'koppen': koppen_class,
            'legal_tradition': city.get('legal_tradition'),
            'note': 'delineation practice follows the legal/survey tradition and climate/soil of the region, '
                    'so donors for uncovered cities are chosen by country, then climate class, then distance',
        },
        'crs': manifest['crs'], 'tile_size_m': manifest['tile_size_m'],
        'imagery': {'source': manifest['provenance'].get('imagery'), 'year': manifest.get('imagery_date'),
                    'rights': city.get('imagery_rights')},
        'cadastre': {'source': manifest['provenance'].get('cadastre'), 'snapshot': manifest.get('source_snapshot'),
                     'clip_rule': manifest['provenance'].get('cadastral_clip'), 'warning': manifest.get('warning')},
        'strata': manifest.get('stratification', {}).get('bins'),
        'scoring': {'tolerance_m': 2.0, 'iou_threshold': 0.5, 'edge_margin_m': 1.0,
                    'headline': ['parcel_f1', 'area_weighted_recall', 'boundary_f1', 'precision'],
                    'selection_rule': 'parcel_f1 on the selection split, ties by area_weighted_recall'},
        'splits': {
            'selection': {'tiles': by_split['validation']},
            'final': {'tiles': by_split['test']},
        },
        'training_pool': {'tiles': [record['id'] for record in by_split['train']],
                          'parcel_instances': sum(record['parcel_count'] or 0 for record in by_split['train'])},
        'exhausted': {'tiles': exhausted, 'reason': RULES[2]},
        'separation': {'cross_split_distance_m': manifest['exclusions'].get('cross_split_distance_m'),
                       'source_ids_disjoint_across_splits': manifest['exclusions'].get('source_ids_disjoint_across_splits')},
        'source_manifest': {'path': source_path, 'sha256': sha256(source), 'exported_at': manifest.get('exported_at')},
        'rules': list(RULES),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE, help='spike dataset manifest.json')
    parser.add_argument('--output', type=Path, default=HERE / 'manifests' / 'zagreb-v1.json')
    parser.add_argument('--city', default='zagreb', choices=sorted(CITIES), help='which city block to freeze')
    parser.add_argument('--koppen-class', help='Köppen-Geiger class of the city, e.g. Cfa')
    parser.add_argument('--force', action='store_true', help='overwrite an existing frozen manifest')
    parser.add_argument('--run', action='store_true', help='actually write; without it, print what would be frozen')
    args = parser.parse_args(argv)
    city = dict(CITIES[args.city])
    if args.city != 'zagreb' and args.output == HERE / 'manifests' / 'zagreb-v1.json':
        args.output = HERE / 'manifests' / f"{city['slug']}-v1.json"
    frozen = freeze(args.source, city, args.koppen_class)
    summary = {split: len(frozen['splits'][split]['tiles']) for split in frozen['splits']}
    summary['training_pool'] = len(frozen['training_pool']['tiles'])
    summary['exhausted'] = len(frozen['exhausted']['tiles'])
    if not args.run:
        print('dry run; pass --run to write', json.dumps(summary))
        return
    if args.output.exists() and not args.force:
        raise SystemExit(f'{args.output} exists; a frozen manifest is not rewritten without --force')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(frozen, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'written': str(args.output), **summary}))


if __name__ == '__main__':
    main()
