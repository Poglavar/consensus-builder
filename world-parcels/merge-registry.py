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


# ---- Retry pass (2026-09-30): apply research/retry results ------------------
VERIFIED_OK = (200, 206)
def usable_sample(d):
    import re
    v = d.get('verifiedParcelResponse') or {}
    n = v.get('parcelRecordCount')
    if isinstance(n, str):
        m = re.search(r'\d+', n.replace(',', ''))
        n = int(m.group()) if m else 0
    elif isinstance(n, (list, dict)):
        n = len(n)
    hs = v.get('httpStatus')
    if isinstance(hs, str):
        m = re.match(r'\d+', hs.strip())
        hs = int(m.group()) if m else None
    return hs in VERIFIED_OK and (n or 0) > 0

CITY_RETRY_OVERRIDES = {
    'quito': ('temporarily_unavailable', 'Only unofficial third-party layers returned nothing at the centre and expose owner data; official hosts blocked.'),
}
# Retry files rarely recorded nationwideVerified, so this list is curated from the agent reports:
# each was queried in two or more distinct regions from one official, anonymous service.
REVIEWED_MULTI_REGION = {'BJ', 'BY', 'CY', 'JM', 'JO', 'NC', 'SE', 'XK', 'LT'}
COUNTRY_RETRY_OVERRIDES = {
    'TT': ('partial_or_unofficial_sample', 'Public ArcGIS Online layer; link to the Surveys and Mapping Division is inferred, layer has an owner field (not saved).'),
    'GB': ('partial_or_unofficial_sample', 'England and Wales only, bulk per-authority download of title-extent index polygons; no query API; one authority sampled.'),
    'SE': (None, 'Undocumented viewer-internal lookup by designation, not a bbox service; terms unread; may change without notice.'),
    'TR': (None, 'Undocumented viewer backend, point lookups only; terms unread.'),
}
retry_cities = {}
for f in sorted(glob.glob('research/retry/cities/*.json')):
    if any(x in f for x in SKIP):
        continue
    d = load(f)
    if isinstance(d, dict) and 'newStatus' in d:
        retry_cities[d['key']] = (f, d)
changed_cities = 0
for c in cities.values():
    key = c['researchFile'].split('/')[-1][:-5]
    if key.endswith('.json'):
        key = key[:-5]
    hit = retry_cities.get(key) or retry_cities.get(os.path.basename(c['researchFile'])[:-5])
    if not hit:
        continue
    f, d = hit
    status, note = d['newStatus'], None
    if key in CITY_RETRY_OVERRIDES:
        status, note = CITY_RETRY_OVERRIDES[key]
    if status.startswith('verified') and not usable_sample(d):
        status, note = 'no_verified_sample_candidate_citywide', 'Retry claimed a sample without a usable HTTP 200/206 nonempty response.'
    if status != c['parcelStatus']:
        changed_cities += 1
    c.setdefault('previousResearchFile', c['researchFile'])
    c['retryFile'] = f
    c['parcelStatus'] = status
    if note:
        c['mergeNote'] = note
    if status.startswith('verified'):
        v = d['verifiedParcelResponse']; s_ = d.get('source') or {}
        sid = v.get('sourceId') or s_.get('sourceId')
        c['sourceIds'] = [sid]
        c['researchFile'] = f
        if sid not in sources:
            sources[sid] = {
                'sourceId': sid, 'name': s_.get('name', sid), 'operator': s_.get('operator', 'unconfirmed'),
                'countryCode': c['countryCode'], 'scope': s_.get('scope', 'see evidence file'),
                'endpoint': s_.get('endpoint') or v.get('requestUrl', '').split('?')[0],
                'method': s_.get('method') or v.get('method', 'GET'),
                'responseFormat': s_.get('responseFormat') or v.get('geometryType', 'unknown'),
                'crs': s_.get('crs', 'see evidence file'), 'verificationStatus': status,
                'reuseStatus': s_.get('reuseStatus', 'terms_unconfirmed'), 'verifiedCityIds': [], 'evidenceFile': f,
            }
        if c['cityId'] not in sources[sid]['verifiedCityIds']:
            sources[sid]['verifiedCityIds'].append(c['cityId'])
    else:
        c['sourceIds'] = []

changed_countries = 0
by_code = {p['countryCode']: p for p in probes}
for f in sorted(glob.glob('research/retry/countries/*.json')):
    if any(x in f for x in SKIP):
        continue
    d = load(f)
    if not isinstance(d, dict) or 'newStatus' not in d:
        continue
    code = d['key']
    p = by_code.get(code)
    if not p:
        continue
    status, note = d['newStatus'], None
    if status == 'national_online_cadastre_verified_sample':
        nat = (d.get('coverageAssessment') or {}).get('nationwideVerified')
        if code in REVIEWED_MULTI_REGION:
            nat = True  # reviewed against the agent report: 2+ distinct regions, one official service
        if not usable_sample(d) or nat is not True:
            status, note = 'partial_or_unofficial_sample', 'Retry sample did not establish nationwide coverage (single region, pilot, or partial layer).'
    if code in COUNTRY_RETRY_OVERRIDES:
        st_, note = COUNTRY_RETRY_OVERRIDES[code]
        status = st_ or status
    if status != p['status']:
        changed_countries += 1
    if status.startswith('verified_sample'):
        status, note = 'partial_or_unofficial_sample', (note or 'City-scope verified sample (government sites or partial layer), not a national service.')
    p['previousStatus'] = p['status']
    p['status'] = status
    p['accessModel'] = d.get('accessModel') or p.get('accessModel', 'unknown')
    p['retryFile'] = f
    p['foundViaViewerInspection'] = bool(d.get('foundViaViewerInspection'))
    p['geoBlockSuspected'] = bool(d.get('geoBlockSuspected'))
    if note:
        p['mergeNote'] = note
print('retry applied:', changed_cities, 'city status changes,', changed_countries, 'country status changes')


# ---- Europe focus pass (2026-09-30): research/europe --------------------------
EUROPE_OVERRIDES = {
    # GB: Scotland (RoS view service) and England (HMLR bulk zips) are two different sources/schemas,
    # so the single-service two-region test is not met; nationwideVerified stays false.
    'GB': ('partial_or_unofficial_sample', 'Scotland and England verified from two different sources and schemas; no single national service; NI refused.'),
    # PT: four regions from one mainland service pass the two-region test; islands absent.
    'PT': ('national_online_cadastre_verified_sample', 'Mainland OGC API only: Porto, Coimbra and Braganca boxes returned 0; Azores and Madeira are separate, unreached services.'),
    'GR': (None, 'Bulk regional shapefile download read by HTTP Range, no bbox query; Operating Cadastre areas only.'),
    'SK': (None, 'Bulk INSPIRE GML zips read by HTTP Range; the WFS/ATOM endpoints reset from here.'),
    'HU': ('partial_or_unofficial_sample', 'The Lechner INSPIRE WFS is a Mesterszallas sampling area (about 7x10 km), not a national layer.'),
    'AL': (None, 'WAF flaps; Tirana sample comes from the retry pass, Shkoder from the Europe pass.'),
}
NAMES = {'AD': 'Andorra', 'FO': 'Faroe Islands', 'GG': 'Guernsey', 'IM': 'Isle of Man', 'LI': 'Liechtenstein', 'SM': 'San Marino', 'VA': 'Vatican City'}
for f in sorted(glob.glob('research/europe/*.json')):
    if any(x in f for x in SKIP):
        continue
    d = load(f)
    if not isinstance(d, dict) or 'newStatus' not in d:
        continue
    code = d['countryCode']
    p = by_code.get(code)
    if not p:
        p = {'countryCode': code, 'country': d.get('country') or NAMES.get(code, code), 'reportedStatus': 'not_probed',
             'status': 'not_probed', 'accessModel': 'unknown', 'checkedAt': d.get('checkedAt'), 'evidenceFile': f}
        probes.append(p); by_code[code] = p
    status, note = d['newStatus'], None
    if status == 'national_online_cadastre_verified_sample':
        nat = (d.get('coverageAssessment') or {}).get('nationwideVerified')
        if not usable_sample(d) or nat is not True:
            status, note = 'partial_or_unofficial_sample', 'Europe-pass sample did not establish two regions from one service.'
    if code in EUROPE_OVERRIDES:
        st_, note = EUROPE_OVERRIDES[code]
        status = st_ or status
    p['previousStatus'] = p['status']
    p['status'] = status
    p['accessModel'] = d.get('accessModel') or p.get('accessModel', 'unknown')
    p['europeFile'] = f
    p['regionsSampled'] = d.get('regionsSampled') or []
    if d.get('inspireRecordUrl'):
        p['inspireRecordUrl'] = d['inspireRecordUrl']
    if note:
        p['mergeNote'] = note
    elif 'mergeNote' in p and p['previousStatus'] != status:
        del p['mergeNote']

# ---- Subnational tier: federal countries by region ---------------------------------
def region_bucket(status):
    s = status.lower()
    if s.startswith('verified_region_wide') or s.startswith('verified') and 'partial' not in s and 'previous' not in s or s == 'verified':
        return 'regionWide'
    if 'verified' in s:
        return 'regionWide' if 'previous pass' in s or 'per research' in s else 'partial'
    if 'credential' in s or 'paid' in s or 'contract' in s or 'release' in s:
        return 'credentialed'
    if 'viewer' in s:
        return 'viewerOnly'
    if 'unavailable' in s:
        return 'unavailable'
    return 'none'

subnational = []
def add_country(code, name, regions, note=None):
    counts = collections.Counter(r['bucket'] for r in regions)
    entry = {'countryCode': code, 'country': name, 'regionsTotal': len(regions),
             'regionWide': counts['regionWide'], 'partial': counts['partial'], 'credentialed': counts['credentialed'],
             'viewerOnly': counts['viewerOnly'], 'unavailable': counts['unavailable'], 'none': counts['none'],
             'ruralRegistryOnly': counts['ruralRegistryOnly'],
             'regions': sorted(regions, key=lambda r: r['code'])}
    if note:
        entry['note'] = note
    subnational.append(entry)
    p = by_code.get(code)
    if p:
        p['regionSummary'] = {k: entry[k] for k in ('regionsTotal', 'regionWide', 'partial', 'credentialed', 'viewerOnly', 'unavailable', 'none', 'ruralRegistryOnly')}

import collections
# Brazilian states whose only urban parcels come from a verified municipal layer (see the city entries).
BR_MUNICIPAL_URBAN = {'RJ': 'Rio de Janeiro city lots', 'SP': 'Sao Paulo lotes fiscais', 'PR': 'Curitiba lote cadastral', 'PE': 'Recife lotes'}
SUBNATIONAL_NOTES = {
    'BR': 'No state publishes urban lots except the Federal District; SICAR is the self-declared rural environmental registry, not the legal cadastre, and is counted separately. Municipal urban layers exist for four capitals.',
    'AR': 'Cadastre is provincial (Ley 26.209); several provinces publish only point-query or raster viewers.',
    'MX': 'Cadastre is state and municipal; no state-wide open service was reached from this network, most state hosts reset or block, and the partial samples are municipal or third-party layers.',
}
for code, name in (('US', 'United States'), ('CA', 'Canada'), ('AU', 'Australia'), ('BR', 'Brazil'), ('AR', 'Argentina'), ('MX', 'Mexico')):
    regions = []
    for f in sorted(glob.glob(f'research/subnational/{code}/*.json')):
        if 'response' in f:
            continue
        d = load(f)
        if not isinstance(d, dict) or 'regionCode' not in d:
            continue
        src = d.get('source') or {}
        bucket = region_bucket(d['status'])
        rnote = None
        if code == 'BR' and 'sicar' in ((src.get('endpoint') or '') + (src.get('name') or '')).lower():
            if d['regionCode'] in BR_MUNICIPAL_URBAN:
                bucket, rnote = 'partial', f"Urban lots verified for {BR_MUNICIPAL_URBAN[d['regionCode']]} only; statewide layer is SICAR rural registry."
            else:
                bucket, rnote = 'ruralRegistryOnly', 'SICAR self-declared rural property perimeters only; not the legal cadastre, no urban lots.'
        regions.append({'code': d['regionCode'], 'name': d['regionName'], 'status': d['status'], 'bucket': bucket, **({'mergeNote': rnote} if rnote else {}),
                        'sourceName': src.get('name'), 'endpoint': src.get('endpoint'), 'regionWideClaimed': d.get('regionWideClaimed'),
                        'subregionsVerified': d.get('subregionsVerified') or [], 'reuseStatus': d.get('reuseStatus'), 'evidenceFile': f})
    add_country(code, name, regions, SUBNATIONAL_NOTES.get(code))

de = load('research/europe/DE.json')
if de and de.get('laender'):
    regions = []
    for l in de['laender']:
        st = l['status']
        bucket = 'regionWide' if st.startswith('verified') else region_bucket(st)
        if 'not re-tested' in st and 'TLS' in st:
            bucket = 'unavailable'
        regions.append({'code': l['code'], 'name': l['land'], 'status': st, 'bucket': bucket, 'sourceName': l.get('featureType'),
                        'endpoint': l.get('endpoint'), 'subregionsVerified': l.get('regionsSampled') or [], 'reuseStatus': l.get('licenceNote'), 'evidenceFile': 'research/europe/DE.json'})
    add_country('DE', 'Germany', regions, 'No national service; ALKIS is run by each Land. Berlin needs a fetch from a network that trusts its certificate chain.')

ch_files = [f for f in glob.glob('research/subnational/CH/*.json') if 'response' not in f]
ch = load('research/europe/CH.json')
if ch_files:
    regions = []
    for f in sorted(ch_files):
        d = load(f)
        if not isinstance(d, dict) or 'regionCode' not in d:
            continue
        src = d.get('source') or {}
        regions.append({'code': d['regionCode'], 'name': d['regionName'].split(' (')[0], 'status': d['status'], 'bucket': region_bucket(d['status']),
                        'sourceName': src.get('name') or 'geodienste.ch av_0 WFS (ms:RESF)', 'endpoint': src.get('endpoint') or 'https://geodienste.ch/db/av_0/deu',
                        'subregionsVerified': d.get('subregionsVerified') or [], 'reuseStatus': d.get('reuseStatus'), 'evidenceFile': f})
    for c in ('ZH', 'BE', 'GE', 'SG', 'TG'):
        if not any(r['code'] == c for r in regions):
            regions.append({'code': c, 'name': c, 'status': 'verified_region_wide', 'bucket': 'regionWide', 'sourceName': 'geodienste.ch av_0 WFS (ms:RESF)', 'endpoint': 'https://geodienste.ch/db/av_0/deu', 'subregionsVerified': [c], 'reuseStatus': 'open per geodienste.ch services.json', 'evidenceFile': 'research/europe/CH.json'})
    add_country('CH', 'Switzerland', regions, 'One national WFS (geodienste.ch) aggregates cantonal surveys. Conditions for gated cantons come from the service metadata, not the cantonal terms pages.')
elif ch and ch.get('cantonStatus'):
    cs = ch['cantonStatus']
    opened = [c.split(' ')[0] for c in cs.get('open_free_data_per_services.json', []) if not c.startswith('FL')]
    sampled = set(cs.get('verified_open_by_wfs_sample', []))
    gated = cs.get('release_or_contract_required', {})
    regions = []
    for c in opened:
        regions.append({'code': c, 'name': c, 'status': 'verified_region_wide' if c in sampled else 'open_per_service_list_not_sampled',
                        'bucket': 'regionWide' if c in sampled else 'partial', 'sourceName': 'geodienste.ch av_0 WFS (ms:RESF)',
                        'endpoint': 'https://geodienste.ch/db/av_0/deu', 'subregionsVerified': [c] if c in sampled else [], 'reuseStatus': 'open per geodienste.ch services.json', 'evidenceFile': 'research/europe/CH.json'})
    for c, why in gated.items():
        regions.append({'code': c, 'name': c, 'status': 'credentialed: ' + why, 'bucket': 'credentialed', 'sourceName': 'geodienste.ch av_0 WFS', 'endpoint': 'https://geodienste.ch/db/av_0/deu', 'subregionsVerified': [], 'reuseStatus': why, 'evidenceFile': 'research/europe/CH.json'})
    add_country('CH', 'Switzerland', regions, 'One national WFS (geodienste.ch) aggregates cantonal surveys; 20 cantons open, 6 gated. Unsampled open cantons are listed as partial until queried.')

be = load('research/europe/BE.json')
if be:
    regions = [
        {'code': 'BRU', 'name': 'Brussels', 'status': 'verified_region_wide', 'bucket': 'regionWide', 'sourceName': 'FPS Finance INSPIRE CP MapServer', 'subregionsVerified': ['Brussels'], 'evidenceFile': 'research/europe/BE.json'},
        {'code': 'WAL', 'name': 'Wallonia', 'status': 'verified_region_wide', 'bucket': 'regionWide', 'sourceName': 'FPS Finance INSPIRE CP MapServer', 'subregionsVerified': ['Liege'], 'evidenceFile': 'research/europe/BE.json'},
        {'code': 'VLG', 'name': 'Flanders', 'status': 'verified_region_wide', 'bucket': 'regionWide', 'sourceName': 'Flanders GRB WFS (GRB:ADP) and FPS Finance INSPIRE CP', 'subregionsVerified': ['Antwerp'], 'evidenceFile': 'research/countries/BE.json'},
    ]
    add_country('BE', 'Belgium', regions, 'Federal INSPIRE service covers all three regions; Flanders also has its own GRB WFS.')
REG['subnationalCoverage'] = subnational

# ---- Cities upgraded from subnational evidence ------------------------------------
CITY_FROM_SUBNATIONAL = {'research/montreal.json': 'research/subnational/CA/QC.json'}
for c in cities.values():
    orig = c.get('previousResearchFile') or c['researchFile']
    if orig in CITY_FROM_SUBNATIONAL and not c['sourceIds']:
        f = CITY_FROM_SUBNATIONAL[orig]
        d = load(f)
        if d and usable_sample(d):
            s_ = d['source']; sid = s_['sourceId']
            c.setdefault('previousResearchFile', c['researchFile'])
            c.update({'researchFile': f, 'parcelStatus': 'verified_sample_partial_coverage', 'sourceIds': [sid],
                      'mergeNote': 'Verified through the Quebec province-wide lots layer (subnational pass); the city itself publishes only a bulk assessment file.'})
            if sid not in sources:
                sources[sid] = {'sourceId': sid, 'name': s_['name'], 'operator': s_.get('operator', 'unconfirmed'), 'countryCode': c['countryCode'],
                                'scope': s_.get('scope', ''), 'endpoint': s_.get('endpoint', ''), 'method': s_.get('method', 'GET'),
                                'responseFormat': s_.get('responseFormat', 'ArcGIS JSON'), 'crs': s_.get('crs', ''), 'verificationStatus': 'verified_nonempty_sample',
                                'reuseStatus': d.get('reuseStatus', 'terms_unconfirmed'), 'verifiedCityIds': [], 'evidenceFile': f}
            if c['cityId'] not in sources[sid]['verifiedCityIds']:
                sources[sid]['verifiedCityIds'].append(c['cityId'])

# Country coverage (green countries on the map): every probe that passed the two-region test.
# Reviewed=False: nationwide claim, exclusions and licence are NOT reviewed (user chose this display rule on 2026-09-30).
REG['countryCoverage'] = [
    {'countryCode': p['countryCode'], 'country': p['country'], 'status': 'verified_countrywide',
     'basis': 'two_region_test', 'reviewed': False,
     'evidenceFile': p.get('retryFile') or p['evidenceFile'],
     'caveats': 'Polygons returned in two or more distinct regions from one service. Explicit nationwide claim, exclusions and licence terms are unreviewed.'
                + (' ' + p['mergeNote'] if p.get('mergeNote') else '')}
    for p in probes if p['status'] == 'national_online_cadastre_verified_sample'
]
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
