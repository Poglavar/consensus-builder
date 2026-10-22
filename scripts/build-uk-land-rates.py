#!/usr/bin/env python3
"""Build frontend/js/uk-land-rates.js: a sterling land rate per m² for every UK city in city-config.js.

Source: MHCLG "Land value estimates for policy appraisal 2023" (published March 2026), sheet
"Residential", medium site density at the median house price, in £/ha, per English local authority.
Each city takes the rate of the local authority of the same name (Manchester is Manchester City
Council, whose parcels it loads, though its map centre lies just inside Salford), else of the one its
map centre falls in (ONS Local Authority Districts, May 2023 boundaries, point query). A city outside England, or in an authority with no
reported value, takes the median of all English authorities and says so (basis "england-median").
These are generic appraisal figures, not market values; the app shows them as a modeled estimate.

Rerunnable: the spreadsheet is cached in --cache, each ONS lookup in --cache/ons-points.json, so a
rerun after a failure asks only for the cities it does not have yet.

Usage: python3 scripts/build-uk-land-rates.py --write [--cache DIR]
       python3 scripts/build-uk-land-rates.py --dry-run     (print the table, write nothing)
"""
import argparse
import datetime
import json
import os
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CITY_CONFIG = os.path.join(ROOT, 'frontend', 'js', 'city-config.js')
OUTPUT = os.path.join(ROOT, 'frontend', 'js', 'uk-land-rates.js')
XLSX_URL = 'https://assets.publishing.service.gov.uk/media/69b2d95f912f3f96bf687b1c/Land_value_estimates_for_policy_appraisal_2023.xlsx'
ONS_QUERY = ('https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/'
             'Local_Authority_Districts_May_2023_UK_BGC_V2/FeatureServer/0/query')
SHEET = 'Residential'
# Columns of the Residential sheet: B region, C LA code, D LA name; O = medium density, median price.
CODE_COL, NAME_COL, RATE_COL = 2, 3, 14


def log(message):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    log(f'downloading {url}')
    with urllib.request.urlopen(url, timeout=60) as response, open(path + '.part', 'wb') as out:
        out.write(response.read())
    os.replace(path + '.part', path)
    return path


def authority_rates(xlsx_path):
    import openpyxl  # imported here so --help works without it
    sheet = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)[SHEET]
    rates = {}
    for row in sheet.iter_rows(values_only=True):
        code = str(row[CODE_COL] or '').strip()
        value = row[RATE_COL] if len(row) > RATE_COL else None
        if re.fullmatch(r'E0\d{7}', code) and isinstance(value, (int, float)) and value > 0:
            rates[code] = {'name': str(row[NAME_COL]).strip(), 'perHectare': value}
    if len(rates) < 250:
        raise SystemExit(f'Only {len(rates)} authorities read from sheet {SHEET!r}; the layout changed.')
    return rates


def uk_cities():
    source = open(CITY_CONFIG, encoding='utf-8').read()
    pattern = re.compile(r"\n        [a-z0-9_]+: \{\n            id: '([^']+)'[^\n]*\n            label: translateCityText\('[^']+', '([^']+)'\),\n"
                         r"            currency: \{ locale: '[^']+', code: 'GBP' \},(.*?)\n        \}", re.S)
    cities = []
    for match in pattern.finditer(source):
        centre = re.search(r'defaultCenter: \[(-?[\d.]+), (-?[\d.]+)\]', match.group(3))
        if not centre:
            raise SystemExit(f'No defaultCenter for {match.group(1)}')
        cities.append({'id': match.group(1), 'label': match.group(2), 'lat': float(centre.group(1)), 'lng': float(centre.group(2))})
    return cities


def ons_authority(lat, lng):
    params = urllib.parse.urlencode({
        'geometry': json.dumps({'x': lng, 'y': lat, 'spatialReference': {'wkid': 4326}}),
        'geometryType': 'esriGeometryPoint', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects',
        'outFields': 'LAD23CD,LAD23NM', 'returnGeometry': 'false', 'f': 'json'})
    with urllib.request.urlopen(f'{ONS_QUERY}?{params}', timeout=60) as response:
        body = json.load(response)
    if 'error' in body:
        raise RuntimeError(body['error'])
    features = body.get('features') or []
    return features[0]['attributes'] if features else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--write', action='store_true', help=f'write {os.path.relpath(OUTPUT, ROOT)}')
    parser.add_argument('--dry-run', action='store_true', help='print the table only')
    parser.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.cache', 'consensus-builder', 'uk-land-rates'),
                        help='download and lookup cache directory (outside the repo)')
    args = parser.parse_args()
    if not (args.write or args.dry_run):
        parser.print_help()
        return 0

    os.makedirs(args.cache, exist_ok=True)
    rates = authority_rates(fetch(XLSX_URL, os.path.join(args.cache, 'land-value-estimates-2023.xlsx')))
    england_median = statistics.median(r['perHectare'] for r in rates.values())
    log(f'{len(rates)} English authorities; median {england_median:,.0f} £/ha')

    points_path = os.path.join(args.cache, 'ons-points.json')
    points = json.load(open(points_path)) if os.path.exists(points_path) else {}
    cities = uk_cities()
    log(f'{len(cities)} UK cities in city-config.js; {sum(1 for c in cities if c["id"] in points)} already looked up')
    table = {}
    for index, city in enumerate(cities, 1):
        if city['id'] not in points:
            points[city['id']] = ons_authority(city['lat'], city['lng'])
            json.dump(points, open(points_path, 'w'), indent=1)
            time.sleep(0.2)
        authority = points[city['id']] or {}
        code = authority.get('LAD23CD')
        named = [c for c, r in rates.items() if r['name'].lower() == city['label'].split(',')[0].strip().lower()]
        if len(named) == 1:
            code = named[0]
        rate = rates.get(code)
        entry = ({'authority': code, 'authorityName': rate['name'], 'perSqm': round(rate['perHectare'] / 10000), 'basis': 'authority'}
                 if rate else
                 {'authority': code, 'authorityName': authority.get('LAD23NM'), 'perSqm': round(england_median / 10000), 'basis': 'england-median'})
        table[city['id']] = entry
        log(f"{index}/{len(cities)} {city['label']}: {entry['authorityName']} ({code}) {entry['perSqm']} £/m² [{entry['basis']}]")

    fallbacks = sum(1 for e in table.values() if e['basis'] == 'england-median')
    log(f'{len(table) - fallbacks} cities from their authority, {fallbacks} on the England median')
    if not args.write:
        return 0
    header = ('// GENERATED by scripts/build-uk-land-rates.py; do not edit. A sterling land rate per m² for each UK city:\n'
              '// MHCLG "Land value estimates for policy appraisal 2023", residential, medium site density at the\n'
              '// median house price, of the local authority named like the city, else the one its centre falls in;\n'
              '// basis "england-median" where that authority has no English figure. Appraisal figures, not market\n'
              '// values. Read by js/city-money.js.\n')
    body = json.dumps({'source': XLSX_URL, 'sheet': SHEET, 'column': 'medium density, median house price',
                       'englandMedianPerSqm': round(england_median / 10000), 'cities': table}, indent=2, ensure_ascii=False)
    with open(OUTPUT, 'w', encoding='utf-8') as out:
        out.write(header + '(function (root, data) {\n'
                  "    if (typeof module === 'object' && module.exports) module.exports = data;\n"
                  '    if (root) root.UkLandRates = data;\n'
                  "})(typeof window !== 'undefined' ? window : null, " + body + ');\n')
    log(f'wrote {os.path.relpath(OUTPUT, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
