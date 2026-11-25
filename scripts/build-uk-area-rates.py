#!/usr/bin/env python3
"""Build English area rate tables (scripts/lib/area_rate_table.py), one subcommand each:

  rents  frontend/js/uk-private-rents.js from the ONS "Price Index of Private Rents, UK: monthly price
         statistics" (OGL v3): each English authority's two-bedroom private rent in the latest month (a
         weighted geometric mean of new and existing tenancies, £ a month per dwelling) ÷ 70 m², the
         minimum gross internal area of a two-bedroom four-person one-storey dwelling in the Nationally
         Described Space Standard (Table 1). A per-m² rent of a dwelling at the space standard's minimum:
         larger flats let for less per m².
  levy   frontend/js/uk-building-safety-levy.js from planning.data.gov.uk's building-safety-levy-rate
         dataset (OGL v3; The Building Safety Levy (England) Regulations 2025, SI 2025/1236, Schedule 3):
         each authority's levy per m² of new residential floorspace on previously developed land, and on
         other land.
  bands  frontend/js/uk-gla-value-bands.js from the GLA London Plan Viability Study, Phase 1 (July 2026),
         per value band A-F (the `lpvsBand` layer of data/uk-economic-areas.js), transcribed from the PDF
         below: the sale price per m² of the building's floor area (the band's indicative average blended
         market value at the mid-point, £ per m² of dwelling, Tables A.2-F.2, × 0.675, the midpoint of the
         65-70 % net to gross for schemes under 6 storeys, Annex 3 ¶7) and Mace's build-for-sale cost of
         4-6 storey flats per m² GIA at Q2 2026 prices (Appendix 1). The band map leaves postcode districts
         with too few sales unbanded inside Greater London: a location there takes the nearest band.

Downloads are cached in --cache (outside the repo) and read as data only.

Usage: python3 -I scripts/build-uk-area-rates.py rents|levy|bands --write [--cache DIR]
       python3 -I scripts/build-uk-area-rates.py rents|levy|bands --dry-run   (print, write nothing)
"""
import argparse
import csv
import datetime
import math
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
from area_rate_table import write_area_rate_table  # noqa: E402

PIPR_URL = ('https://www.ons.gov.uk/file?uri=/economy/inflationandpriceindices/datasets/'
            'priceindexofprivaterentsukmonthlypricestatistics/18november2026/priceindexofprivaterentsukmonthlypricestatistics10.xlsx')
PIPR_PAGE = 'https://www.ons.gov.uk/economy/inflationandpriceindices/datasets/priceindexofprivaterentsukmonthlypricestatistics'
NDSS_TWO_BED_M2 = 70  # NDSS (March 2015) Table 1: 2b4p, one storey
BSL_URL = 'https://files.planning.data.gov.uk/dataset/building-safety-levy-rate.csv'
ENGLISH_DISTRICT = re.compile(r'E0[6-9]\d{6}')
# The area layer has the May 2023 districts; the ONS has since recoded Barnsley and Sheffield (2024 boundary
# changes of a few streets), so their rents are filed under the 2023 codes.
RECODED = {'E08000038': 'E08000016', 'E08000039': 'E08000019'}
LPVS_URL = ('https://data.london.gov.uk/download/e6j99/7n9/'
            'LONDON%20PLAN%20VIABILITY%20STUDY%20-%20PHASE%201%20REPORT%20-%20JULY%202026.pdf')
LPVS_NET_TO_GROSS = 0.675
# Band: (dwelling sale £/m², its table; construction £/m² GIA, its table), transcribed from the study.
LPVS_BANDS = {'A': (27746, 'A.2', 3910, 'A.6'), 'B': (17546, 'B.2', 3730, 'B.9'), 'C': (12666, 'C.2', 3560, 'C.9'),
              'D': (9415, 'D.2', 3380, 'D.10'), 'E': (7428, 'E.2', 3200, 'E.10'), 'F': (5511, 'F.2', 3200, 'F.10')}
# Greater London: the 33 London boroughs, E09000001 (City of London) to E09000033 (Westminster).
GREATER_LONDON = [f'E09{n:06d}' for n in range(1, 34)]


def log(message):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    log(f'downloading {url}')
    with urllib.request.urlopen(url, timeout=120) as response, open(path + '.part', 'wb') as out:
        out.write(response.read())
    os.replace(path + '.part', path)
    return path


def rents(cache):
    import openpyxl  # imported here so --help works without it
    sheet = openpyxl.load_workbook(fetch(PIPR_URL, os.path.join(cache, 'pipr.xlsx')), read_only=True)['Table 1']
    rows = sheet.iter_rows(values_only=True)
    header = next(row for row in rows if row and row[0] == 'Time period')
    col = {name: header.index(name) for name in ('Time period', 'Area code', 'Area name', 'Rental price two bed')}
    data = [row for row in rows if row and isinstance(row[col['Time period']], datetime.datetime)]
    latest = max(row[col['Time period']] for row in data)
    areas = {}
    for row in data:
        code, rent = str(row[col['Area code']]), row[col['Rental price two bed']]
        code = RECODED.get(code, code)
        if row[col['Time period']] == latest and ENGLISH_DISTRICT.fullmatch(code) and isinstance(rent, (int, float)) and rent > 0:
            areas[code] = {'name': str(row[col['Area name']]).strip(), 'perM2': round(rent / NDSS_TWO_BED_M2, 2), 'twoBed': rent}
    if len(areas) < 250:
        raise SystemExit(f'Only {len(areas)} English authorities with a two-bed rent in {latest:%Y-%m}; the layout changed.')
    log(f'{len(areas)} English authorities, {latest:%B %Y}')
    return {
        'id': 'ons-pipr-rent', 'name': 'ONS Price Index of Private Rents', 'url': PIPR_PAGE, 'licence': 'OGL v3',
        'layer': 'lad', 'currency': 'GBP', 'asOf': latest.strftime('%Y-%m-01'),
        'rates': [{'metric': 'rent', 'unit': 'm2-floor-month', 'basis': 'market', 'field': 'perM2',
                   'note': f'two-bed rent {{twoBed}} a month, {latest:%B %Y} ÷ {NDSS_TWO_BED_M2} m² '
                           '(space standard 2b4p minimum), per m² of dwelling'}],
        'areas': areas
    }, ('Each English local authority\'s private rent per m² of dwelling a month:\n'
        'ONS Price Index of Private Rents, two-bedroom rent ÷ 70 m² (NDSS 2b4p). Read by js/economic-sources.js.')


def levy(cache):
    path = fetch(BSL_URL, os.path.join(cache, 'bsl.csv'))
    areas, documents, starts = {}, set(), set()
    with open(path, encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            code = row['local-authority-district']
            if row['end-date'] or not ENGLISH_DISTRICT.fullmatch(code):
                continue
            areas[code] = {'name': row['name'].strip(), 'previouslyDeveloped': float(row['previously-developed-land-rate']),
                           'other': float(row['non-previously-developed-land-rate'])}
            documents.add(row['document-url'])
            starts.add(row['start-date'])
    if len(areas) < 250 or len(documents) != 1 or len(starts) != 1:
        raise SystemExit(f'{len(areas)} authorities, documents {documents}, start dates {starts}: the layout changed.')
    log(f'{len(areas)} English authorities from {starts}')
    return {
        'id': 'uk-building-safety-levy', 'name': 'Building Safety Levy (SI 2025/1236)', 'url': documents.pop(), 'licence': 'OGL v3',
        'layer': 'lad', 'currency': 'GBP', 'asOf': starts.pop(),
        # The model does not know whether a site is previously developed; it takes that (lower) rate and says so.
        'rates': [{'metric': 'devCharge', 'unit': 'm2-floor', 'basis': 'statutory', 'field': 'previouslyDeveloped',
                   'landCategory': 'previously-developed',
                   'note': 'previously developed land; {other} on other land (Schedule 3), new residential floor area'}],
        'areas': areas
    }, ('Each English local authority\'s Building Safety Levy per m² of new residential\n'
        'floorspace (SI 2025/1236 Schedule 3, planning.data.gov.uk). Read by js/economic-sources.js.')


def bands(cache):
    del cache  # transcribed from the study's PDF: nothing to download
    areas = {band: {'name': f'Value band {band}', 'sale': math.floor(dwelling * LPVS_NET_TO_GROSS + 0.5), 'dwellingSale': dwelling,
                    'saleTable': sale_table, 'construction': cost, 'costTable': cost_table}
             for band, (dwelling, sale_table, cost, cost_table) in LPVS_BANDS.items()}
    return {
        'id': 'gla-lpvs-2026', 'name': 'GLA London Plan Viability Study 2026', 'url': LPVS_URL, 'licence': 'OGL v2',
        'layer': 'lpvsBand', 'currency': 'GBP', 'asOf': '2025-06-30', 'label': '{name}',
        'nearestWithin': {'layer': 'lad', 'name': 'Greater London', 'areas': GREATER_LONDON},
        'rates': [{'metric': 'sale', 'unit': 'm2-floor', 'basis': 'market', 'field': 'sale',
                   'note': f'new builds {{dwellingSale}} per m² of dwelling (Table {{saleTable}}) × {LPVS_NET_TO_GROSS} net to gross'},
                  {'metric': 'construction', 'unit': 'm2-floor', 'basis': 'construction-cost', 'field': 'construction',
                   'asOf': '2026-06-08',
                   'note': '4-6 storey flats for sale, per m² GIA, Q2 2026 (Table {costTable}); no externals, fees or VAT'}],
        'areas': areas
    }, ('London\'s sale price and construction cost per value band of the GLA London Plan Viability Study,\n'
        'Phase 1 (July 2026). Read by js/economic-sources.js.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('table', nargs='?', choices=['rents', 'levy', 'bands'])
    parser.add_argument('--write', action='store_true', help='write the table into frontend/js/')
    parser.add_argument('--dry-run', action='store_true', help='print the table only')
    parser.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.cache', 'consensus-builder', 'uk-area-rates'),
                        help='download cache directory (outside the repo)')
    args = parser.parse_args()
    if not args.table or not (args.write or args.dry_run):
        parser.print_help()
        return 0
    os.makedirs(args.cache, exist_ok=True)
    table, comment = {'rents': rents, 'levy': levy, 'bands': bands}[args.table](args.cache)
    output = os.path.join(ROOT, 'frontend', 'js', {'rents': 'uk-private-rents.js', 'levy': 'uk-building-safety-levy.js',
                                                    'bands': 'uk-gla-value-bands.js'}[args.table])
    for code in ('E09000019', 'E08000025', 'C'):
        log(f'{code}: {table["areas"].get(code)}')
    if args.write:
        write_area_rate_table(output, table, comment, 'scripts/build-uk-area-rates.py')
        log(f'wrote {os.path.relpath(output, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
