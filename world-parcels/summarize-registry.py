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
open('SUMMARY.md', 'w').write('\n'.join(out))
print(cnt.total(), 'cities summarized')
