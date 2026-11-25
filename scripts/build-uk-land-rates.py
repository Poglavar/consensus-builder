#!/usr/bin/env python3
"""Build frontend/js/uk-land-rates.js, an area rate table (scripts/lib/area_rate_table.py): a sterling land rate
per m² for every English local authority.

Source: MHCLG "Land value estimates for policy appraisal 2023" (published March 2026), sheet
"Residential", medium site density at the median house price, in £/ha, per English local authority.
A plan or parcel takes the rate of the authority it lies in (js/economic-sources.js finds it in
data/uk-economic-areas.js, built by scripts/build-uk-economic-areas.mjs). Where the location is not
given or lies in no English authority, a city's own authority stands in, and the observation says so:
the authority of its administrative extent (`extent` in data/city-configs.js) holding its centre
(js/economic-sources.js cityArea). These are generic appraisal figures, not market values.

Rerunnable: the spreadsheet is cached in --cache.

Usage: python3 scripts/build-uk-land-rates.py --write [--cache DIR]
       python3 scripts/build-uk-land-rates.py --dry-run     (print the table, write nothing)
"""
import argparse
import datetime
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'frontend', 'js', 'uk-land-rates.js')
XLSX_URL = 'https://assets.publishing.service.gov.uk/media/69b2d95f912f3f96bf687b1c/Land_value_estimates_for_policy_appraisal_2023.xlsx'
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--write', action='store_true', help=f'write {os.path.relpath(OUTPUT, ROOT)}')
    parser.add_argument('--dry-run', action='store_true', help='print the table only')
    parser.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.cache', 'consensus-builder', 'uk-land-rates'),
                        help='download cache directory (outside the repo)')
    args = parser.parse_args()
    if not (args.write or args.dry_run):
        parser.print_help()
        return 0

    os.makedirs(args.cache, exist_ok=True)
    rates = authority_rates(fetch(XLSX_URL, os.path.join(args.cache, 'land-value-estimates-2023.xlsx')))
    log(f'{len(rates)} English authorities')

    if not args.write:
        return 0
    sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
    from area_rate_table import write_area_rate_table
    write_area_rate_table(OUTPUT, {
        'id': 'uk-mhclg-land-2023', 'name': 'MHCLG residential policy appraisal 2023', 'url': XLSX_URL, 'licence': 'OGL v3',
        'sheet': SHEET, 'column': 'medium density, median house price',
        'layer': 'lad', 'currency': 'GBP', 'asOf': '2023-10-01',
        # The residential appraisal stands for road land too, with that provenance.
        'rates': [{'metric': metric, 'unit': 'm2-land', 'basis': 'policy-appraisal', 'field': 'perSqm'} for metric in ('land', 'roadLand')],
        'areas': {code: {'name': rate['name'], 'perSqm': round(rate['perHectare'] / 10000)} for code, rate in rates.items()}
    }, 'A sterling land rate per m² for every English local authority:\nMHCLG "Land value estimates for policy appraisal 2023", residential, medium site density at the median\n'
       'house price. A city\'s own authority is its extent\'s (data/city-configs.js). Appraisal\nfigures, not market values. '
       'An area rate table (scripts/lib/area_rate_table.py), read by js/economic-sources.js.', 'scripts/build-uk-land-rates.py')
    log(f'wrote {os.path.relpath(OUTPUT, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
