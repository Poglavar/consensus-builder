#!/usr/bin/env python3
"""Parcel-practice donors. Delineation customs follow legal/survey traditions and climate/soil, so a city
with cadastre is a usable training donor for uncovered cities of the same region. For every researched city
without a verified parcel source this ranks the covered cities most likely to share its practice: same
country first, then same Köppen class, then distance. Reads world-parcels/registry.json, optionally samples
the Beck et al. (2023) Köppen-Geiger GeoTIFF (CC BY 4.0), writes practice-regions.json and prints a summary."""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE.parent / 'registry.json'
# Beck et al. (2018, 2023) class numbering; legend.txt in the download confirms it when passed.
BECK_LEGEND = {1: 'Af', 2: 'Am', 3: 'Aw', 4: 'BWh', 5: 'BWk', 6: 'BSh', 7: 'BSk', 8: 'Csa', 9: 'Csb', 10: 'Csc',
               11: 'Cwa', 12: 'Cwb', 13: 'Cwc', 14: 'Cfa', 15: 'Cfb', 16: 'Cfc', 17: 'Dsa', 18: 'Dsb', 19: 'Dsc',
               20: 'Dsd', 21: 'Dwa', 22: 'Dwb', 23: 'Dwc', 24: 'Dwd', 25: 'Dfa', 26: 'Dfb', 27: 'Dfc', 28: 'Dfd',
               29: 'ET', 30: 'EF'}
GROUPS = {'A': 'tropical', 'B': 'arid', 'C': 'temperate', 'D': 'continental', 'E': 'polar'}
KOPPEN_SOURCE = ('Beck, H.E. et al. (2023) High-resolution (1 km) Köppen-Geiger maps for 1901-2099, '
                 'figshare 10.6084/m9.figshare.21789074, 1991-2020 period, CC BY 4.0')


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def load_legend(path):
    legend = {}
    for line in Path(path).read_text(errors='replace').splitlines():
        match = re.match(r'^\s*(\d+)\s*:\s*([A-Za-z]{2,3})\b', line)
        if match:
            legend[int(match.group(1))] = match.group(2)
    return legend or BECK_LEGEND


def sample_koppen(raster, points):
    """Köppen class per (lat, lon); coastal points falling on ocean take the nearest land class."""
    import rasterio
    classes = []
    with rasterio.open(raster) as dataset:
        band = dataset.read(1)
        for lat, lon in points:
            row, col = dataset.index(lon, lat)
            value = 0
            for radius in (0, 1, 2, 4, 8):
                window = band[max(row - radius, 0):row + radius + 1, max(col - radius, 0):col + radius + 1].ravel()
                land = window[window > 0]
                if land.size:
                    value = int(Counter(land.tolist()).most_common(1)[0][0])
                    break
            classes.append(value)
    return classes


def coverage(city, country_wide, regions):
    """How a city's parcels are covered: its own verified sample, a countrywide source, or a region-wide
    source in a federal country. None means uncovered (including temporarily unavailable sources)."""
    status = city.get('parcelStatus') or ''
    if status.startswith('verified_sample'):
        return 'city_sample'
    if city['countryCode'] in country_wide:
        return 'country_wide'
    region = regions.get((city['countryCode'], city.get('stateCode')))
    if region and region.get('bucket') == 'regionWide':
        return 'region_wide'
    return None


def analyse(registry, koppen_by_city, focus, top):
    country_wide = {entry['countryCode'] for entry in registry.get('countryCoverage', [])
                    if entry.get('status') == 'verified_countrywide'}
    regions = {(entry['countryCode'], region['code']): region
               for entry in registry.get('subnationalCoverage', []) for region in entry.get('regions', [])}
    cities = [city for city in registry['cities'] if city.get('centerLatLon')]
    covered, uncovered = [], []
    for city in cities:
        kind = coverage(city, country_wide, regions)
        record = {
            'cityId': city['cityId'], 'name': city['name'], 'country': city['country'],
            'countryCode': city['countryCode'], 'centerLatLon': city['centerLatLon'],
            'researchOrder': city.get('researchOrder'), 'parcelStatus': city.get('parcelStatus'),
            'koppen': koppen_by_city.get(city['cityId']),
            'coverage': kind,
        }
        record['koppen_group'] = record['koppen'][0] if record['koppen'] else None
        (covered if kind else uncovered).append(record)
    if focus == 'top200':
        targets = [city for city in uncovered if (city.get('researchOrder') or 10 ** 9) <= 200]
    else:
        targets = uncovered
    for target in targets:
        donors = []
        for donor in covered:
            donors.append({
                'cityId': donor['cityId'], 'name': donor['name'], 'countryCode': donor['countryCode'],
                'coverage': donor['coverage'], 'koppen': donor['koppen'],
                'distance_km': round(haversine_km(target['centerLatLon'], donor['centerLatLon'])),
                'same_country': donor['countryCode'] == target['countryCode'],
                'same_koppen': bool(target['koppen']) and donor['koppen'] == target['koppen'],
                'same_koppen_group': bool(target['koppen_group']) and donor['koppen_group'] == target['koppen_group'],
            })
        donors.sort(key=lambda d: (not d['same_country'], not d['same_koppen'], not d['same_koppen_group'],
                                   d['distance_km'], d['name']))
        target['donors'] = donors[:top]
        same_country = [d['distance_km'] for d in donors if d['same_country']]
        same_climate = [d['distance_km'] for d in donors if d['same_koppen']]
        same_group = [d['distance_km'] for d in donors if d['same_koppen_group']]
        target['nearest_same_country_km'] = min(same_country) if same_country else None
        target['nearest_same_koppen_km'] = min(same_climate) if same_climate else None
        target['nearest_same_group_km'] = min(same_group) if same_group else None
        target['tier'] = (
            'A same country' if same_country else
            'B same climate class within 1000 km' if same_climate and min(same_climate) <= 1000 else
            'C same climate class anywhere' if same_climate else
            'D same climate group only' if same_group else
            'E no donor in the climate group')
    summary = {
        'cities_with_coordinates': len(cities), 'covered': len(covered), 'uncovered': len(uncovered),
        'focus': focus, 'targets': len(targets),
        'tiers': dict(sorted(Counter(t['tier'] for t in targets).items())),
        'with_same_country_donor_within_300_km': sum(1 for t in targets if (t['nearest_same_country_km'] or 10 ** 9) <= 300),
        'with_same_koppen_donor_within_1000_km': sum(1 for t in targets if (t['nearest_same_koppen_km'] or 10 ** 9) <= 1000),
        'koppen_groups': {
            GROUPS.get(group, group): {
                'covered_cities': sum(1 for c in covered if c['koppen_group'] == group),
                'uncovered_targets': sum(1 for t in targets if t['koppen_group'] == group),
            } for group in sorted(GROUPS)},
        'koppen_classes_without_any_covered_city': sorted({t['koppen'] for t in targets if t['koppen']} -
                                                           {c['koppen'] for c in covered if c['koppen']}),
    }
    return covered, targets, summary


def print_summary(summary, targets):
    print(f"## Practice-region donors ({summary['focus']}: {summary['targets']} uncovered targets, "
          f"{summary['covered']} covered cities)\n")
    print('| Tier | Targets |\n| --- | ---: |')
    for tier, count in summary['tiers'].items():
        print(f'| {tier} | {count} |')
    print(f"\nSame-country donor within 300 km: {summary['with_same_country_donor_within_300_km']}; "
          f"same Köppen class within 1000 km: {summary['with_same_koppen_donor_within_1000_km']}.\n")
    print('| Köppen group | Covered cities | Uncovered targets |\n| --- | ---: | ---: |')
    for group, counts in summary['koppen_groups'].items():
        print(f"| {group} | {counts['covered_cities']} | {counts['uncovered_targets']} |")
    if summary['koppen_classes_without_any_covered_city']:
        print(f"\nClasses with uncovered targets but no covered city: "
              f"{', '.join(summary['koppen_classes_without_any_covered_city'])}")
    hard = [t for t in targets if t['tier'].startswith(('D', 'E'))]
    if hard:
        print('\nHardest targets (no covered city in the same climate class):')
        for t in sorted(hard, key=lambda t: t.get('researchOrder') or 10 ** 9):
            donor = t['donors'][0] if t['donors'] else None
            where = f"{donor['name']}, {donor['countryCode']} at {donor['distance_km']} km" if donor else 'none'
            print(f"- {t['name']}, {t['countryCode']} ({t['koppen']}): nearest same-group donor {where}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, default=REGISTRY)
    parser.add_argument('--koppen', type=Path, help='Köppen-Geiger GeoTIFF (1991-2020, 0.1 degree is enough)')
    parser.add_argument('--legend', type=Path, help='legend.txt shipped with the Köppen download')
    parser.add_argument('--focus', choices=('top200', 'all'), default='top200')
    parser.add_argument('--top', type=int, default=3, help='donors listed per target')
    parser.add_argument('--output', type=Path, default=HERE / 'practice-regions.json')
    parser.add_argument('--run', action='store_true', help='write the JSON; without it only the summary prints')
    args = parser.parse_args(argv)
    registry = json.loads(args.registry.read_text())
    cities = [city for city in registry['cities'] if city.get('centerLatLon')]
    koppen_by_city = {}
    if args.koppen:
        legend = load_legend(args.legend) if args.legend else BECK_LEGEND
        classes = sample_koppen(args.koppen, [tuple(city['centerLatLon']) for city in cities])
        koppen_by_city = {city['cityId']: legend.get(value) for city, value in zip(cities, classes)}
    covered, targets, summary = analyse(registry, koppen_by_city, args.focus, args.top)
    print_summary(summary, targets)
    if args.run:
        payload = {
            'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'registry_updated_at': registry.get('updatedAt'),
            'koppen': {'source': KOPPEN_SOURCE, 'sampled': bool(args.koppen)},
            'coverage_rule': ('covered = own verified_sample status, or verified_countrywide country, or a '
                              'region-wide source for the city\'s stateCode; everything else is a target'),
            'ranking': 'same country, then same Köppen class, then same Köppen group, then distance',
            'summary': summary, 'covered_cities': covered, 'targets': targets,
        }
        args.output.write_text(json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False) + '\n')
        print(f'\nwritten {args.output}')


if __name__ == '__main__':
    main()
