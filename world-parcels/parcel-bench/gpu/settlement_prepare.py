#!/usr/bin/env python3
"""Freeze a lower-rise development cohort and sampling policies from existing purged data.
Administrative settlement names are descriptive evidence, not village/suburb labels.
"""
from __future__ import annotations
import argparse
import collections
import copy
import hashlib
import json
import math
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import Point, shape, box

BENCH = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(BENCH / 'layered'), str(BENCH)]
from settlement_features import extract_settlement_features
from exposure import combine_exposure, validate_exposure
from score import load_features
from imagery_study import geographic_blocks

CITIES = ('zagreb-v2', 'split-v2', 'zadar-v1')
RULE = {'minimum_intersecting_buildings': 3, 'maximum_building_coverage': .25,
        'maximum_median_full_building_m2': 350, 'minimum_small_building_fraction': .6,
        'maximum_water_coverage': .1, 'small_building_threshold_m2': 250}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def lower_rise(f):
    return (f['clipped_building_count'] >= RULE['minimum_intersecting_buildings']
            and f['building_coverage_fraction'] <= RULE['maximum_building_coverage']
            and f['median_full_building_area_m2'] <= RULE['maximum_median_full_building_m2']
            and f['small_building_fraction_le_250m2'] >= RULE['minimum_small_building_fraction']
            and f['water_coverage_fraction'] <= RULE['maximum_water_coverage'])


def capped_probabilities(raw, maximum_ratio=5):
    """Limit a tile to five times the uniform probability in its context/region."""
    cap = maximum_ratio / len(raw)
    fixed, remaining = {}, dict(raw)
    while remaining:
        mass = 1 - sum(fixed.values())
        total = sum(remaining.values())
        proposed = {key: mass * value / total for key, value in remaining.items()}
        saturated = [key for key, value in proposed.items() if value > cap]
        if not saturated:
            return dict(fixed, **proposed)
        for key in saturated:
            fixed[key] = cap
            del remaining[key]
    return fixed


def prepare(dataset, context, output):
    samples = {s['id']: s for s in json.loads((dataset / 'manifest.json').read_text())['samples']}
    manifests = {city: json.loads((BENCH / f'manifests/{city}.json').read_text()) for city in CITIES}
    rows, selection, finals, groups = [], [], [], []
    for city, manifest in manifests.items():
        boundaries = [(shape(f['geometry']), f['properties']['na_ime']) for f in
                      json.loads((context / f'{city}-settlements.geojson').read_text())['features']]
        roles = {tile: 'train' for tile in manifest['training_pool']['tiles']}
        roles.update({tile['id']: 'selection' for tile in manifest['splits']['selection']['tiles']})
        for tile_id, role in roles.items():
            sample = samples[tile_id]
            bbox = sample['bbox']
            point = Point((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
            names = [name for geom, name in boundaries if geom.covers(point)]
            if len(names) > 1:
                raise ValueError(f'ambiguous administrative boundary: {tile_id}')
            osm = dataset / (sample.get('osm_input') or f"{sample['split']}/{tile_id}.osm-input.json")
            features = extract_settlement_features(json.loads(osm.read_text()), bbox)
            tile = box(*bbox)
            references, invalid = load_features(json.loads((dataset / sample['truth']).read_text()), tile)
            areas = [geom.area for _, geom, _ in references]
            reference_summary = dict(count=len(references), invalid=invalid,
                interior=sum(geom.distance(tile.boundary) >= 1 for _, geom, _ in references),
                median_clipped_area_m2=statistics.median(areas) if areas else None)
            rows.append(dict(id=tile_id, region=city, role=role, settlement=names[0] if names else None,
                             context='lower-rise-proxy' if lower_rise(features) else 'other',
                             osm_sha256=digest(osm), references=reference_summary, features=features))
        selected = {r['id'] for r in rows if r['region'] == city and r['role'] == 'selection'
                    and r['context'] == 'lower-rise-proxy'}
        records = manifest['splits']['selection']['tiles']
        blocks = [[tile for tile in block if tile in selected] for block in geographic_blocks(records)]
        blocks = [block for block in blocks if block]
        if not blocks:
            raise ValueError(f'no target development blocks: {city}')
        groups.extend(dict(name=f'{city}-block-{i+1}', region=city, tiles=block,
                           weight=1 / (len(CITIES) * len(blocks))) for i, block in enumerate(blocks))
        selection.extend(r for r in records if r['id'] in selected)
        finals.extend(manifest['splits']['final']['tiles'])
    train = [r for r in rows if r['role'] == 'train']
    audit = dict(format=1, purpose='Lower-rise morphology proxy; not confirmed suburbs or villages.',
                 rule=RULE, inputs={city: digest(BENCH / f'manifests/{city}.json') for city in CITIES},
                 dataset_manifest_sha256=digest(dataset / 'manifest.json'),
                 administrative_inputs={city: digest(context / f'{city}-settlements.geojson') for city in CITIES},
                 rows=rows)
    manifest = copy.deepcopy(manifests[CITIES[0]])
    manifest.update(version='lower-rise-dev-v1', frozen_at=datetime.now(timezone.utc).isoformat(),
                    city={'name': 'Three Croatian development regions', 'country_code': 'HR'},
                    selection_groups=groups,
                    training_pool={'tiles': sorted(r['id'] for r in train)},
                    exhausted={'tiles': sorted(set().union(*(set(m.get('exhausted', {}).get('tiles', []))
                                                            for m in manifests.values())))},
                    splits={'selection': {'tiles': selection}, 'final': {'tiles': finals}},
                    purpose='Selection-only existing-data proxy pilot. Original finals are reserved and never scored.')
    for key in ('source_manifest', 'selection_expansion', 'imagery', 'practice_region', 'cadastre'):
        manifest.pop(key, None)
    manifest['sources_by_region'] = {city: {key: m.get(key) for key in
        ('imagery', 'practice_region', 'cadastre', 'source_manifest')} for city, m in manifests.items()}
    manifest['source_manifests'] = audit['inputs']
    manifest['scoring']['selection_rule'] = 'Equal region weight, then equal original geographic-block weight; macro parcel F1.'
    manifest['rules'] = [
        'Development proxy only; original final splits and untouched cities remain reserved and unscored.',
        'All compared models refit from pinned ImageNet initialization on the same purged candidate pool.',
        'No shared parcel source IDs or distance below 500 m between training and any original selection/final tile.',
        'Lower-rise morphology does not establish a suburb, village, building height or regional transfer.',
        'Clipped references remain in primary F1; interior recall is a separate guarded diagnostic.']
    exposure = combine_exposure(manifest['crs'], [samples[r['id']] for r in train],
                                [samples[r['id']] for r in selection],
                                {'format': 1, 'crs': manifest['crs'], 'training': [], 'selection': []})
    validate_exposure(exposure, manifest)
    # Recheck every original selection/final set, including the omitted non-proxy selection tiles.
    for original in manifests.values():
        validate_exposure(exposure, original)
    uniform = {r['id']: 1.0 for r in train}
    # 75% of draws target lower-rise tiles, 25% retain other contexts. Regions and
    # administrative communities receive mass proportional to sqrt(tile count)
    # within each context stratum, avoiding extreme repetition of tiny communities.
    cells = collections.defaultdict(list)
    for r in train:
        cells[(r['context'], r['region'], r['settlement'])].append(r['id'])
    targeted = {}
    for (kind, region, settlement), ids in cells.items():
        regions = {key[1] for key in cells if key[0] == kind}
        communities = [key for key in cells if key[:2] == (kind, region)]
        community_mass = math.sqrt(len(ids)) / sum(math.sqrt(len(cells[key])) for key in communities)
        mass = (.75 if kind == 'lower-rise-proxy' else .25) / len(regions) * community_mass
        targeted.update({tile: mass / len(ids) for tile in ids})
    # Bound tiny-community repetition while retaining each context/region's mass.
    for kind, region in {(key[0], key[1]) for key in cells}:
        ids = [tile for key, values in cells.items() if key[:2] == (kind, region) for tile in values]
        mass = sum(targeted[tile] for tile in ids)
        capped = capped_probabilities({tile: targeted[tile] for tile in ids})
        targeted.update({tile: mass * probability for tile, probability in capped.items()})
    output.mkdir(parents=True, exist_ok=True)
    for name, value in [('context', audit), ('manifest', manifest),
                        ('uniform', {'format': 1, 'weights': uniform}),
                        ('targeted', {'format': 1, 'weights': targeted})]:
        (output / f'{name}.json').write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    summary = dict(training_tiles=len(train), lower_rise_training_tiles=sum(r['context']=='lower-rise-proxy' for r in train),
                   selection_tiles=len(selection), groups=groups,
                   contexts={str(k): v for k,v in collections.Counter((r['region'],r['role'],r['context']) for r in rows).items()})
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--context', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.dataset, args.context, args.output)
