<!-- Documents the NYC R6A pilot's scope, evidence contract, source snapshot and verification. -->
# NYC R6A envelope pilot

The first rule path covers new attached multifamily **standard residences** on a reviewed rectangular interior zoning lot in Brooklyn Community District 3. Width is at least 18 ft and less than 40 ft, depth is 95–110 ft, and area is at least 1,700 sq ft. These upper size limits are pilot scope choices, not citywide zoning limits.

**Current coverage: the calculator and screening pipeline are implemented; no real lot has yet been admitted as a reviewed envelope.** The 25-lot public audit found 13 lots without mapped conflicts and 12 with map flags. Title, survey, street/block context and site-action evidence remain unresolved. `reviews.js` intentionally contains no reviews.

## Rule calculation

The standard massing uses a full-width street wall on the legal street line, a 30 ft rear yard, a base rising to 65 ft and an upper tier rising to 75 ft. Its upper setback is 15 ft on a narrow street or 10 ft on a street at least 75 ft wide. No side yard is required for this attached-building scenario. The 80% lot-coverage limit remains a separate cap; the rear yard gives a smaller footprint throughout this pilot's dimensional range.

For a **hypothetical reviewed 20 × 100 ft lot on a 60 ft street**, the base footprint is 20 × 70 ft and the upper footprint is 20 × 55 ft. The independent zoning floor-area budget is **3 × 2,000 = 6,000 sq ft**. The containing volume cannot all be filled. The output does not infer floor count or subtract PLUTO building area to claim unused development rights.

This is one standard bulk massing option. It does not maximize over dormers, permitted obstructions, articulation, alternative street-wall locations or affordable/senior scenarios. Geometry uses lot-local feet, with z=0 at the reviewed base plane; it is not a georeferenced mesh. A building proposal is still needed to assess light and air, access, parking, recreation space, building code and other permit requirements. Existing-building alterations and demolition permission are outside this calculation.

Rules were checked against the official text on **2026-10-19**:

| Provision | Rule used or condition screened |
| --- | --- |
| [12-10](https://zoningresolution.planning.nyc.gov/article-i/chapter-2/12-10) | Zoning lot, base plane, and narrow/wide street definitions |
| [23-12](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-12) | Minimum lot area and width for this residence type |
| [23-22](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-22) | Standard R6A residential FAR 3.0 |
| [23-335](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-335) | Side-yard treatment for attached residences |
| [23-342](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-342) | 30 ft rear yard for attached buildings on lots under 40 ft wide |
| [23-344](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-344) | Exclude corner proximity and short-block frontage modifications |
| [23-362](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-362) | 80% standard interior-lot coverage |
| [23-431](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-431) | Full-width street wall on the street line satisfies the ordinary location path |
| [23-432](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-432) | Minimum base 40 ft, maximum base 65 ft, maximum building 75 ft |
| [23-433](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-433) | 10/15 ft upper setback from the chosen street wall |
| [23-436](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-436) | Exclude existing-building, historic and sidewalk-widening modifications |
| [23-443](https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-443) | Exclude transportation frontage, park, limited-height and lower-density-boundary modifications |

The date above is a research date, not an invented effective date. Change `RULE_VERSION` and re-review affected records whenever the implemented rules change.

## Endpoint and evidence gate

`GET /parcel-nyc/:parcelId/envelope` returns `schemaVersion: 2` and one of:

- `outside-scope`: a known condition is outside the first tier.
- `needs-review`: inputs, site evidence or public-map findings remain unresolved.
- `modeled`: the preliminary screen and every required site review pass.

`referenceRules` contains district-level rules, not a parcel entitlement. `result` is null unless the site is modeled. When modeled, it contains the two footprint/height tiers, FAR budget, coverage cap, units and scope. The old `supported`, inferred floor counts, affordable upside, FAR-only fallback and unused-air-rights fields have been removed. No frontend in this branch consumed them.

PLUTO data is fetched live and cached for one hour. All four district fields, both overlays, all three special-district fields, limited heights, historical protection, environmental and flood flags, lot shape and source version are inspected. Missing Boolean values remain unknown. Blank map flags do not establish the absence of restrictions. A >1% difference between reported area and frontage × depth requires review; this is a screening tolerance, not permission to alter legal geometry.

A curated entry in `SITE_REVIEWS` must bind to the exact BBL, `RULE_VERSION` and `inputFingerprint(pluto)`. It supplies `checkedOn`, an explicitly chosen `validThrough`, and surveyed `site.widthFt`, `site.depthFt`, `site.streetWidthFt`. Every key in `REVIEW_REQUIREMENTS` must have `{ status: 'verified', note, sources: ['https://…/specific-record'] }` with an actual checked record. These requirements cover the legal zoning lot and rights, survey, zoning maps, street/corner context, geographic restrictions, district adjacency, site actions and the residential scenario. URLs and notes are provenance, not an automated proof of their contents: admitting a review requires substantive review of those records.

The runtime rejects missing, expired, future-dated, mismatched or incomplete reviews and blocks unresolved public-audit flags. Request parameters cannot supply a review. The dated pilot evidence is shown only when its normalized PLUTO fingerprint still matches. It is not a live GIS clearance. Recheck the rule text, GIS and site records before admitting or renewing a review; PLUTO version matching alone cannot detect a subsequent zoning action.

## Reproduce the public audit

From `backend/`:

```sh
node scripts/audit-nyc-r6a.mjs --run --limit 25 --output zoning/pilot/<new-snapshot-directory>
```

The CLI defaults to help, permits 20–50 audited lots, reads a bounded candidate pool, samples across tax blocks, checkpoints every lot, logs progress/ETA and exits unsuccessfully on any source failure. Rerunning the same directory resumes completed lots only when the source metadata, inputs and rules still match. Changed sources require a new directory. It performs no database writes.

The [saved summary](pilot/2026-10-19/summary.json) and [manifest](pilot/2026-10-19/manifest.json) record the source URLs, original source update timestamps, request timestamps and exact inputs. Each BBL file contains selected raw PLUTO fields, normalized data, MapPLUTO geometry and official DCP intersections for zoning districts, commercial overlays, special districts, limited heights and MIH. Owner names and contact details are not collected.

On 2026-10-19, 1,022 dimension-filtered R6A records in Community District 303 produced 500 preliminary PLUTO candidates. Of the 25 audited across different tax blocks, 13 had no conflict in the five map layers queried. Eleven intersected another zoning district, and one intersected a commercial overlay absent from its PLUTO flags. These are conservative flags: intersection includes boundary contact and small geometry discrepancies, so they do not establish a legally split lot. An empty intersection result also does not establish survey accuracy, absence of unmapped restrictions, or available development rights.

Some candidates without mapped conflicts, for the next evidence review:

| Address | BBL | ZoLa |
| --- | --- | --- |
| 856 Willoughby Avenue | 3015930012 | [Open](https://zola.planning.nyc.gov/l/lot/3/1593/12) |
| 918 DeKalb Avenue | 3016010012 | [Open](https://zola.planning.nyc.gov/l/lot/3/1601/12) |
| 974 DeKalb Avenue | 3016020015 | [Open](https://zola.planning.nyc.gov/l/lot/3/1602/15) |
| 915 Greene Avenue | 3016160058 | [Open](https://zola.planning.nyc.gov/l/lot/3/1616/58) |
| 856 Greene Avenue | 3016200043 | [Open](https://zola.planning.nyc.gov/l/lot/3/1620/43) |

The documentary gap cannot be cleared by an empty index query. [DOF explains](https://www.nyc.gov/site/finance/property/property-recording-property-related-documents.page) that ACRIS online records start in 1966 and that reviewing them is not necessarily a title search. [DOB plans and drawings](https://portal.311.nyc.gov/article/?kanumber=KA-02017) can require a records request. A spot check of the public ACRIS index for 918 DeKalb Avenue returned 18 document links, not a determination of its available rights; those document contents have not been reviewed. No records requests were submitted.

## Verification

Run only the targeted headless unit tests:

```sh
npx vitest run test/zoning-envelope.test.js test/nyc-pilot.test.js test/parcel-nyc.test.js --maxWorkers=1
```

The geometry tests assert numeric footprints, setback thresholds and the separate floor-area budget. The review tests exercise every missing evidence check, invalid dimensions, expired reviews and source drift. The HTTP tests verify that client assertions cannot enable an envelope. The pilot tests reconcile the saved source records and ensure they never become reviewed capacity.

Session verification on 2026-10-19:

- Initial headless unit run: one file, 17 old tests, 10 failures. A test-file write used the wrong working-directory-relative path; the run therefore used old expectations. Three HTTP cases also encountered the sandbox's local-socket restriction. The file path and execution permission were corrected.
- Updated headless unit run: one file, 76 tests passed.
- Final targeted headless unit run: three files, 94 tests passed. No test run was stopped; no full suite was run.
- Two live HTTP checks fetched official PLUTO data and returned the expected matching public audit, unresolved evidence and null result for one unflagged and one flagged lot. The temporary server closed afterward.
- The audit's second execution reused all 25 completed parcel checkpoints; no source failures occurred in either execution.
