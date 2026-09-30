#!/usr/bin/env python3
"""Generate SUMMARY.md from registry.json and per-country evidence. Run from world-parcels/."""
import collections, json
r = json.load(open('registry.json'))
src = {s['sourceId']: s for s in r['sources']}
out = ['# World parcel research summary', '',
       f"Generated from `registry.json` (updated {r['updatedAt']}). A city sample proves only a bounded response, never full coverage; "
       "many negatives are network-limited (hosts unreachable from the research environment) and are **not** proof that no source exists.", '']
cities = r['cities']
cnt = collections.Counter(c['parcelStatus'] for c in cities)
out += ['## Top 200 cities by status', '', '| Status | Cities |', '| --- | ---: |']
out += [f'| `{k}` | {v} |' for k, v in cnt.most_common()]
out += ['', '## Cities with a verified parcel sample', '', '| Rank | City | Status | Source | Source scope |', '| ---: | --- | --- | --- | --- |']
for c in cities:
    if c['sourceIds']:
        s = src[c['sourceIds'][0]]
        out.append(f"| {c['researchOrder']} | {c['name']}, {c['countryCode']} | `{c['parcelStatus']}` | {s['name']} | {s['scope']} |")
out += ['', '## Country probes', '',
        'Question: does each country have a country-wide online cadastre? Statuses come from `research/countries/<ISO2>.json`; '
        'the registry normalises labels the evidence did not support (see each entry\'s `mergeNote`). '
        '`countryCoverage` stays empty until a source has an explicit nationwide claim, two distinct verified regions, one schema, and recorded exclusions.', '']
by = collections.defaultdict(list)
for p in r['countryProbes']:
    by[p['status']].append(p['countryCode'])
for k, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
    out += [f'- **`{k}`** ({len(v)}): ' + ', '.join(sorted(v))]
out += ['']
viewer = sorted(p['countryCode'] for p in r['countryProbes'] if p.get('foundViaViewerInspection'))
geo = sorted(p['countryCode'] for p in r['countryProbes'] if p.get('geoBlockSuspected') and p['status'] == 'temporarily_unavailable')
out += ['## Retry pass (2026-09-30)', '',
        'Every non-verified country and every unavailable or candidate city was retried with browser-like headers, a cookie jar and inspection of the official viewer\'s JavaScript (`research/retry/`).',
        f"- Countries where the official viewer's scripts or config were inspected (some yielded a source, most did not): {', '.join(viewer) or 'none'}.",
        f"- Still unavailable with a suspected geo-block or bot challenge (unconfirmed): {', '.join(geo) or 'none'}. Retry these from an in-country network.", '']
eu = sorted(p['countryCode'] for p in r['countryProbes'] if p.get('europeFile') and p['status'] == 'national_online_cadastre_verified_sample')
eu_no = sorted(f"{p['countryCode']} ({p['status']})" for p in r['countryProbes'] if p.get('europeFile') and p['status'] != 'national_online_cadastre_verified_sample')
out += ['## Europe focus pass (2026-09-30)', '',
        'Every European country not yet green was re-probed from the INSPIRE/national catalogues and the official viewer\'s code, two regions each (`research/europe/`).',
        f"- Now passing the two-region test: {', '.join(eu)}.",
        f"- Still not: {', '.join(eu_no)}.", '']
out += ['## Federal countries by region (subnational tier)', '',
        'For federations the unit of coverage is the state, province, canton or Land. `regionWide` = an open layer for the whole region verified by a bounded query; `partial` = only a county/city or unofficial layer found; `gated` = credentialed or viewer-only; `rural registry only` = Brazil\'s SICAR self-declared rural perimeters, which are not the legal cadastre.', '',
        '| Country | Regions | Region-wide open | Partial | Gated | None / unavailable | Rural registry only |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for e in r.get('subnationalCoverage', []):
    out.append(f"| {e['country']} | {e['regionsTotal']} | {e['regionWide']} | {e['partial']} | {e['credentialed'] + e['viewerOnly']} | {e['none'] + e['unavailable']} | {e.get('ruralRegistryOnly', 0)} |")
out += ['']
for e in r.get('subnationalCoverage', []):
    rw = [x['code'] for x in e['regions'] if x['bucket'] == 'regionWide']
    pa = [x['code'] for x in e['regions'] if x['bucket'] == 'partial']
    rest = [f"{x['code']} ({x['bucket']})" for x in e['regions'] if x['bucket'] not in ('regionWide', 'partial')]
    out += [f"- **{e['country']}**: region-wide {', '.join(rw) or 'none'}; partial {', '.join(pa) or 'none'}" + (f"; other {', '.join(rest)}" if rest else '') + '.']
out += ['']
open('SUMMARY.md', 'w').write('\n'.join(out))
print(cnt.total(), 'cities summarized')
