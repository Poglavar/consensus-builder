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
open('SUMMARY.md', 'w').write('\n'.join(out))
print(cnt.total(), 'cities summarized')
