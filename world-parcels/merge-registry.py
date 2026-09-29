#!/usr/bin/env python3
"""Merge per-city and per-country research evidence into registry.json.

Idempotent: cities 1..N already in the registry are kept as-is (except for
documented downgrades); new cities come from research/<slug>.json files that
carry queueRank. Country probes are rebuilt from research/countries/*.json.
Run from world-parcels/.
"""
import glob, json, os

REG = json.load(open('registry.json'))
QUEUE = {c['rank']: c for c in json.load(open('queue-top200.json'))}
SKIP = ('response', 'preview', '-layer-', 'sample')

# City downgrades applied at merge: evidence did not meet the raw-reply rule.
CITY_DOWNGRADES = {
    'research/berlin.json': ('no_verified_sample_candidate_citywide',
        'Evidence was relayed through a summarising tool, not a raw HTTP reply, and only 2 of 3 features were kept; re-fetch directly before counting it.'),
}

def load(f):
    try:
        return json.load(open(f))
    except Exception:
        return None

def slug_files():
    for f in sorted(glob.glob('research/*.json')):
        if any(s in f for s in SKIP):
            continue
        d = load(f)
        if isinstance(d, dict) and 'status' in d:
            yield f, d

sources = {s['sourceId']: s for s in REG['sources']}
cities = {c['researchOrder']: c for c in REG['cities']}

for f, d in slug_files():
    rank = d.get('queueRank')
    if rank is None or rank in cities:
        continue
    q = QUEUE[rank]
    status = d['status']
    note = None
    if f in CITY_DOWNGRADES:
        status, note = CITY_DOWNGRADES[f]
    v = d.get('verifiedParcelResponse') or {}
    s = d.get('source') or {}
    sid = v.get('sourceId') or s.get('sourceId')
    city_id = f"wup2025:{q['cityCode']}"
    sids = []
    if sid and status.startswith('verified'):
        sids = [sid]
        if sid not in sources:
            sources[sid] = {
                'sourceId': sid,
                'name': s.get('name', sid),
                'operator': s.get('operator', 'unconfirmed'),
                'countryCode': q['iso2'],
                'scope': s.get('scope', 'see evidence file'),
                'endpoint': s.get('endpoint') or v.get('requestUrl', '').split('?')[0],
                'method': s.get('method') or v.get('method', 'GET'),
                'responseFormat': s.get('responseFormat') or v.get('geometryType', 'unknown'),
                'crs': s.get('crs', 'see evidence file'),
                'verificationStatus': status,
                'reuseStatus': s.get('reuseStatus', 'terms_unconfirmed'),
                'verifiedCityIds': [],
                'evidenceFile': f,
            }
        if city_id not in sources[sid]['verifiedCityIds']:
            sources[sid]['verifiedCityIds'].append(city_id)
    entry = {
        'cityId': city_id, 'wupCityCode': q['cityCode'], 'name': d.get('name') or q['name'],
        'country': q['country'], 'countryCode': q['iso2'],
        'centerLatLon': [round(q['lat'], 5), round(q['lon'], 5)],
        'citySource': 'https://population.un.org/wup/',
        'researchOrder': rank, 'parcelStatus': status, 'sourceIds': sids, 'researchFile': f,
    }
    if note:
        entry['mergeNote'] = note
    cities[rank] = entry

# Apply downgrades to cities already present (none currently) and drop sources for downgraded cities.
for f, (status, note) in CITY_DOWNGRADES.items():
    for c in cities.values():
        if c['researchFile'] == f:
            c['parcelStatus'], c['mergeNote'], c['sourceIds'] = status, note, []
            for s in sources.values():
                if c['cityId'] in s['verifiedCityIds']:
                    s['verifiedCityIds'].remove(c['cityId'])
sources = {k: v for k, v in sources.items() if v['verifiedCityIds'] or v['sourceId'] in {x['sourceId'] for x in REG['sources']}}

# Country probes. Agent statuses are normalised where evidence is weaker than the label.
OVERRIDES = {
    'BR': ('partial_or_unofficial_sample', 'Polygons are SICAR self-declared rural property perimeters, not the legal cadastre.'),
    'ML': ('partial_or_unofficial_sample', 'Layer extent covers only south-west Mali; nationwide claim overstated.'),
    'ZA': ('partial_or_unofficial_sample', 'Samples come from a third-party Esri copy of Surveyor-General data; provenance and terms unconfirmed.'),
    'UY': ('partial_or_unofficial_sample', 'Bulk DXF linework range-read, no attributes, CRS unconfirmed; not a query service.'),
    'LV': ('partial_or_unofficial_sample', 'One municipality shapefile converted by script; not a raw server reply.'),
    'HU': ('partial_or_unofficial_sample', 'Layer holds only 1,774 features; Budapest and Debrecen returned nothing.'),
    'ID': ('partial_or_unofficial_sample', 'Patchy provincial land-ownership layers; central Bandung box returned empty.'),
    'JP': ('partial_or_unofficial_sample', 'Unofficial Esri Japan layer covering only Tokyo, Aichi and Fukuoka.'),
    'SG': ('partial_or_unofficial_sample', 'Bulk file range-read; no spatial query API.'),
    'LK': ('partial_or_unofficial_sample', 'Parcel fabric extent limited to lon 79.87-81.32, lat 6.7-8.1.'),
    'PT': ('partial_or_unofficial_sample', 'Mainland only; a Porto bbox returned 0.'),
    'DO': ('partial_or_unofficial_sample', 'Historical parcels layer; completeness against the current cadastre unverified.'),
    'BB': ('partial_or_unofficial_sample', 'Layer holds 23,356 parcels against about 124k claimed for the fabric.'),
    'CH': ('partial_or_unofficial_sample', 'Coverage is by canton; a Lausanne point returned nothing.'),
    'GP': ('covered_by_parent_source', 'French overseas territory served by the IGN API Carto source (see FR).'),
    'MQ': ('covered_by_parent_source', 'French overseas territory served by the IGN API Carto source (see FR).'),
    'YT': ('covered_by_parent_source', 'French overseas territory served by the IGN API Carto source (see FR).'),
    'RE': ('covered_by_parent_source', 'French overseas territory served by the IGN API Carto source (see FR).'),
    'GF': ('covered_by_parent_source', 'French overseas territory served by the IGN API Carto source (see FR).'),
}
probes = []
for f in sorted(glob.glob('research/countries/*.json')):
    if any(s in f for s in SKIP + ('unauth',)):
        continue
    d = load(f)
    if not isinstance(d, dict) or 'countryCode' not in d:
        continue
    status = d['status']
    note = None
    if d['countryCode'] in OVERRIDES:
        status, note = OVERRIDES[d['countryCode']]
    p = {'countryCode': d['countryCode'], 'country': d.get('country'), 'reportedStatus': d['status'],
         'status': status, 'accessModel': d.get('accessModel', 'unknown'), 'checkedAt': d.get('checkedAt'),
         'evidenceFile': f}
    if note:
        p['mergeNote'] = note
    probes.append(p)

REG['sources'] = list(sources.values())
REG['cities'] = [cities[k] for k in sorted(cities)]
REG['countryProbes'] = probes
REG['updatedAt'] = '2026-09-29'
json.dump(REG, open('registry.json', 'w'), indent=2, ensure_ascii=False)
open('registry.json', 'a').write('\n')
import collections
print(len(REG['cities']), 'cities', len(REG['sources']), 'sources', len(probes), 'country probes')
print(collections.Counter(c['parcelStatus'] for c in REG['cities']))
print(collections.Counter(p['status'] for p in probes))
