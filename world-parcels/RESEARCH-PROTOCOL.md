# Research protocol for parcel-source discovery

Shared instructions for city and country probes. See `../world-parcels.md` (Flow B) for the rules; this file is the operational summary.

## Rules

- **Verified** means a real request returned HTTP 200 **and** a nonempty list of parcel-like polygon records for a small area. A landing page, map tile, service description, empty result, auth wall, or error is not verification.
- Query only a tiny area (`resultRecordCount`/`limit`/`count` of 3, a bbox a few hundred metres across). Never download a whole country.
- **Always send browser-like headers** on every request (a current desktop Chrome `User-Agent`, `Accept`, and an `Accept-Language` for the target country); many services return 403/406 or a challenge page to bare curl. Record in the evidence file whether headers changed the result. Also keep a cookie jar (`curl -c/-b`) because some portals redirect on a session cookie, and send the viewer's own origin as `Referer` when a service returns 403 to direct calls.
- **Look inside the official viewer before calling a service credentialed.** Public viewers often embed a public access token and the real layer name in their JavaScript or network calls (Croatia's `oss:DKP_CESTICE` WFS answered 401 to a bare request, then returned parcels with the viewer's public token). Record such a token as a placeholder, never its value, and note who issues it and what its terms are.
- Use the pre-configured proxy; never disable TLS verification. Time out at ~40 s. A timeout or 5xx is `temporarily_unavailable`, never a permanent negative.
- Do not overclaim scope: a city, county, or state source never implies country coverage. Do not assert licence terms you did not read.
- Redact credentials and personal data (owner names, tax IDs) from saved replies. Keep saved replies small (a few features).
- Do **not** edit `registry.json`, `world-parcels.md`, or another agent's files. Write only your assigned output files. The coordinator merges them.
- Use `python3 -m json.tool <file>` to check every JSON file you write.

## City output: `research/<slug>.json`

Slug: lowercase ASCII city name, hyphens (e.g. `hyderabad`). Schema (see `research/los-angeles.json` verified, `research/lagos.json` negative):

```
{ "schemaVersion": 1, "cityId": "queue:<rank>" (use "geonames:<id>" if you found the GeoNames id), "queueRank": <rank>, "name": "...", "country": "...", "countryCode": "XX",
  "centerLatLon": [lat, lon], "checkedAt": "YYYY-MM-DD", "status": <one of below>,
  "verifiedParcelResponse": null | { sourceId, requestUrl, method, httpStatus, contentType, spatialTestAreaLonLat, parcelRecordCount, recordListPath, geometryType, closedRings, idField, responseFile, pagination },
  "source": null | { sourceId, name, operator, scope, endpoint, method, responseFormat, crs, reuseStatus },
  "portalsFound": [{url, observation}], "requests": [{url, method, httpStatus, contentType, assessment}],
  "coverageAssessment": {claimedScope, verifiedOpenScope, countrywideVerified}, "remainingUncertainty": "...", "nextStep": "..." }
```

Status vocabulary: `verified_sample_city_scope`, `verified_sample_county_scope`, `verified_sample_partial_coverage`, `no_verified_sample_candidate_citywide`, `no_verified_sample_candidate_countrywide`, `no_verified_open_endpoint_after_attempts`, `temporarily_unavailable`.

When verified, also save the small raw reply as `research/<slug>-parcel-response.json`.

## Country output: `research/countries/<ISO2>.json`

```
{ "schemaVersion": 1, "countryCode": "XX", "country": "...", "checkedAt": "YYYY-MM-DD",
  "status": "national_online_cadastre_verified_sample" | "national_cadastre_viewer_only" | "national_cadastre_credentialed_or_paid" | "subnational_only" | "no_online_cadastre_found" | "temporarily_unavailable",
  "cadastreAuthority": "...", "portalsFound": [{url, observation}], "requests": [...], "verifiedParcelResponse": null | {...as above, plus "regionSampled"},
  "coverageAssessment": {"claimedScope": "...", "regionsVerified": [...], "nationwideVerified": false},
  "accessModel": "open | registration | paid | viewer-only | unknown", "remainingUncertainty": "...", "nextStep": "..." }
```

`national_online_cadastre_verified_sample` requires an actual nonempty polygon response; note `nationwideVerified: true` only if two geographically distinct regions were sampled from the same source/schema. "State-level" here means the national/central government or a country-wide statutory service (also list any subnational services found, e.g. provinces or cantons).

## Retry pass (2026-09-30)

Second pass over every non-verified country and every unavailable or candidate city, using the rules above. Input: `batches/retry-countries-NN.json` / `batches/retry-cities-NN.json` (each entry names the previous status and its evidence file; read that file first). Output: **do not edit the original evidence file**. Write `research/retry/countries/<ISO2>.json` or `research/retry/cities/<key>.json`:

```
{ "kind": "country|city", "key": "...", "checkedAt": "2026-09-30", "previousStatus": "...", "newStatus": <vocabulary above>,
  "headersUsed": "the exact User-Agent/Accept/Accept-Language sent",
  "changedByHeaders": true|false, "foundViaViewerInspection": true|false,
  "verifiedParcelResponse": null | {...same fields as above, token/keys redacted...},
  "source": null | {...}, "requests": [{url, method, httpStatus, contentType, assessment}],
  "geoBlockSuspected": true|false (say why: region page, 403 only from this network, etc.),
  "notes": "what is new versus the previous record", "nextStep": "..." }
```

For each entry: (1) re-request the previously failing URLs with full browser headers; (2) fetch the official viewer/portal page and inspect its HTML/JS (`<script src>`, inline config, `fetch(`/`XMLHttpRequest`/`wfs`/`FeatureServer`/`MapServer`/`token` strings) for the real service URL, layer name and any public token, then test a bounded query; (3) try 2-3 further candidate hosts for that country (national mapping agency, INSPIRE, data.gov portal, ArcGIS Online orgs). Never save a token value; use `<PUBLIC_TOKEN>`. Save small raw replies (JSON, wrap XML in a JSON string) as `research/retry/<countries|cities>/<key>-parcel-response.json`. Do not attempt to bypass logins, CAPTCHAs or TLS errors, and do not guess credentials. If a service is truly behind registration, say so. Reply with one line per entry: key, previous -> new status, source if any.
