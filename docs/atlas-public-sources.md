# Public Atlas sources

Verified 2026-10-26. Public editions come from the [Mercatus state and regional Atlas downloads](https://www.mercatus.org/state-and-regional-zoning-atlas-datasets). They expose source districts and rule observations. They are distinct from Land Use Labs' composed Slices product.

## Registration and loading

`frontend/data/planning-sources.json` owns the provider definitions. Each city selects its source through `planning.sourceIds` in `frontend/js/city-config.js` and pins the parcel provider in `parcelSourceId`. Backend source listing is consumer-neutral; bounds do not automatically enable a source for a city. The former `PLANNING_ATLAS_SOURCES` environment variable and inferred city parcel fallback are no longer the configuration contract.

The shared `atlas-url` adapter accepts Slices GeoJSON by default. `product: "districts"` accepts public district GeoJSON or an archive profile with an exact GeoJSON member and, when needed, an exact CSV/XLSX rule member, worksheet names and join columns. The discovery schema in `frontend/js/source-contracts.js` describes these inputs.

The process shares loads by URL, edition, product and archive profile. Source IDs and parcel-provider choices remain per-city. A failed load remains unavailable and may be retried; it does not become an empty successful result. A new edition requires its own source ID/edition. There is no periodic refresh or additional database cache.

Public HTTPS transport retains DNS/redirect checks and rejects credentials. Its limit is 192 MiB and 180 seconds. Archive geography is read incrementally, up to 768 MiB expanded, 32 MiB per feature and 50,000 features; retained selected geography is capped at 128 MiB. Massachusetts uses an explicit jurisdiction subset, so its 636 MB statewide member is never materialized as one JSON string/object. Workbook reads select named sheets and bound XML bytes, nesting, strings, columns, rows and cells. These are source-read bounds, not a citywide envelope rebuild.

## Enabled city coverage

| Public edition | Configured cities | Verified import |
| --- | --- | --- |
| Dallas–Fort Worth 2024 | Arlington (Texas), Lindberg | Arlington member: 18 district features with rules and explicit units. |
| Northern Virginia 2023 | Arlington (Virginia), Dale City, Manassas Park, Sugarland Run | 563 records, including 42 without map geometry; native district fields. |
| Hampton Roads 2024 | Norfolk | 471 geometry features; 445 unique exact table joins and 26 unmatched. All 91 Norfolk features join. |
| New Hampshire 2023 | Concord | 1,724 features with native worksheet headings. Four-family and five-plus-family fields are not silently combined into the app's four-or-more category. |
| Hawaii 2023 | Honolulu | 35 selected geometry features; 30 unique joins and 5 unmatched. |
| Montana 2023 | Helena, South Central (Billings area) | 535 features; 427 unique joins, 93 ambiguous and 15 unmatched. |
| Middle Tennessee 2023 | Nashville | 88 selected geometry features; 86 unique joins and 2 unmatched. |
| Massachusetts 2023 | Worcester, Fall River, Lowell, Lawrence, Lynn | 85 retained district records across these five jurisdictions. |

These are source-enabled locations, not claims that every parcel has a drawable envelope. Literal height availability varies by housing type; overlays, conflicting observations, missing dimensions and the existing parcel-shape limits remain explicit gaps. No height is inferred from a story count or an encoded height bucket.

The public Massachusetts file has no matching Boston or Springfield districts. The Colorado download endpoint returned HTTP 403 to the backend during verification; Denver, Boulder and Greeley are not enabled from that unverified archive. The Long Island public CSV alone supplies no district geometry. Existing NYC pilot behavior is unchanged.

## Table and identity details

- Joins use exact strings after case/whitespace normalization, with all collisions retained as ambiguous. A matched rule row never erases geometry-side overlay, extinct or treatment evidence. Conflicts exclude the affected configuration; raw observations remain inspectable.
- Honolulu's rule name includes its own abbreviated-code prefix. The profile removes only that exact prefix before matching. Five residential map names remain unmatched. The selected Honolulu CSV row with an appended repeated header is trimmed only when the complete trailing header matches; its original cells and the transformation remain in the evidence. Malformed records for other islands are outside this profile.
- Nashville selects `NashvilleDavidson`. Its repeated Jurisdiction/County columns have explicitly named secondary columns, including blank secondary cells on overlays. No first-wins or coalescing rule decides their meaning.
- Montana's duplicate full names remain ambiguous. Five polygons with no district name stay unidentified observations, with no inferred constraints.
- Native record IDs are retained, including signed IDs. Records without native IDs use a deterministic identity incorporating the original feature ordinal within the immutable edition. Null geography stays inspectable by record ID and is not drawn.
- Literal numeric fields retain `literal` evidence and source units/field names. Expressions, alternative/contextual value kinds, unknown units and spreadsheet formulas do not supply numbers. Original district properties, joined geometry properties and table cells remain available in source evidence.
- Workbook number formats distinguish date serials from literal dimensions. Date cells retain their raw value, number format and date system as typed observations; shared formulas with an empty formula body also remain formulas. A date-corrupted district abbreviation uses its intact full name for display rather than a numeric code. The full report extraction found 28 date cells in Montana and 116 in Tennessee.
- Raw base/overlay geography is not composed into Slices. Existing envelope assembly withholds parcels overlapping multiple source areas. Explicit overlay districts cannot become standalone base-district envelopes.
- Parcel coverage calculations discard only whole MultiPolygon components whose bounding boxes miss the full parcel. Original coordinates, source records and references remain intact. This avoids a citywide polygon difference for each parcel; the Texas RS-7.2 source has 2,460 disconnected components, of which only two meet the tested cell.

## Verification and MCP parity

The new pure-module headless unit tests cover numeric semantics, exact/ambiguous joins, raw evidence, selected jurisdictions, workbook bounds, signed/unidentified records, overlapping overlays, geometry/table conflicts, regional load sharing and the 17 city-to-source/parcel registrations. Existing Atlas, parcel-study, parcel-envelope, CSV and MCP-read tests are also targeted checks.

Headless unit run record (none stopped; no full suite was run):

| Scope | Result |
| --- | --- |
| Initial audit: Atlas, Atlas URLs, parcel envelopes, parcel study, source runtime, frontend city integrations (6 files) | 95/96 passed. Existing frontend city test expects Overture although the current default is OSM. |
| First implementation check: public Atlas, Atlas, Atlas URLs, parcel envelopes, parcel study (5 files) | 92/93 passed. A new exact floating-point assertion was corrected to use a tolerance. |
| Expanded check: the preceding 5 plus source contracts, source domain registries and CSV parcel reader (8 files) | 123/124 passed. Existing catalogue guard fails because `parcels/supermap-map` has no published contract; the unchanged HEAD contract has the same omission. |
| Reviewed implementation: public Atlas, Atlas, Atlas URLs, parcel envelopes, parcel study, CSV parcel reader, MCP reads (7 files) | 120/120 passed. |
| Final input-validation follow-up: public Atlas and Atlas URLs (2 files) | 50/50 passed. |
| Calculation follow-up: parcel study, parcel envelopes, public Atlas (3 files) | 59/59 passed, including unchanged coverage, holes and original source identity across disconnected components. |
| Spreadsheet-date follow-up: public Atlas (1 file) | 15/15 passed, including built-in/custom date formats, literal unit formats and retained raw date evidence. |
| Date identity and shared-formula follow-up: public Atlas (1 file) | 15/15 passed, including full-name fallback for a date-corrupted abbreviation and rejection of a shared formula's cached number as a literal. |

There is no new human authoring operation or authored record format. The site and MCP use the same planning source registry and `/planning/envelopes` / `/planning/study` calculations. `ugt_parcel_context` accepts explicit `planningSourceIds`; permitted-building drafting accepts `planningSource`. The source discovery schema was updated with the archive inputs. A live check through the existing MCP read client verifies discovery, envelopes and parcel-study evidence against the same local API used by the browser.

Headed browser verification uses public Virginia parcels and Atlas districts at Arlington: 20 envelopes in the tested viewport, the same identities available in 2D and 3D, and enabled Permitted controls. The smaller live API cell returned 8 envelopes and 12 unsupported parcel shapes. This evidence is bounded to those viewports; broader source coverage is verified by parsing each public edition and checking district intersections at the configured city locations.

An initial live city sweep was stopped after the Texas district calculation stalled. After narrowing calculation components, Texas returned 4 envelopes at Arlington and 11 at Lindberg. A sequential follow-up also returned 5 at Arlington, Virginia and 2 at Concord; Dale City and South Central returned overlapping-district exclusions, and Helena returned unsupported parcel shapes. Manassas Park, Sugarland Run, Norfolk and Honolulu returned source-read failures. This sweep was stopped under very high host load before Nashville and the five Massachusetts locations were reached; it is not a successful 17-city live check. No full browser suite was run.

The final Arlington preview was rechecked after the workbook fix: the bounded API cell returned 8 envelopes and 12 unsupported parcel shapes, and the headed browser displayed 20 envelopes at the intended center and zoom. The frontend and API listeners belonged to this checkout, and the browser resolved the explicitly supplied backend and city. Offline checks of the actual Montana and Tennessee archives retained 535 and 88 geometry features respectively, with the same exact-join counts as above. The selected Montana worksheet preserved 24 date values; two additional Tennessee worksheets preserved 66 and 16 date values without turning them into dimensions.

## Rule coverage report

The [rule coverage report](https://chatgpt.com/space/page_eee63970ac9c8191bf0c4e702ca99287) measures the full public editions, separately from the 17 city source profiles. The [aggregate data](atlas-rule-coverage.json) records source URLs and archive SHA-256 hashes, cohort definitions, field-status counts, within-record combinations and numeric-value summaries. The two `atlas-*-coverage-chart.html` fragments contain the report's plotted aggregates.

The corpus contains 9,582 source rule records, grouped into 9,529 region/jurisdiction/district identities. Differing records sharing an identity remain distinct. It uses CSV rule tables for Texas, both Virginia editions, New Hampshire and Hawaii; XLSX rule worksheets for Montana and Tennessee; and GeoJSON properties for Massachusetts. It excludes blank/non-rule/unidentified rows, two malformed repeated-header-tail rows, 121 rows from byte-identical duplicate Texas CSV members and one Hawaii row with surplus nonempty cells. Spreadsheet dates and formulas stay outside literal numeric counts.

Among 5,536 eligible one-family records, 3,523 have all three numeric setbacks and 2,900 also have a positive numeric height. Among 2,594 eligible four-or-more-family records, the corresponding counts are 1,083 and 886. New Hampshire's distinct four-family and five-plus-family categories remain separate. These are rule-field availability figures, not parcel, land-area or current-ordinance coverage.

Aggregate status sums and regional totals were reconciled. The Page text and both embeds were read back; both chart fragments were visually checked in a headed browser at 736 px and 360 px widths. The authenticated browser redirected the Page URL to its home view, so the native Page layout remains unverified. No authoring behavior changed, and the date evidence remains available through the same site/MCP read paths; no new MCP edit operation is needed.

The independent [standards research](zoning-standards-research.md) compares LADM, INSPIRE, XPlanung, STOP/TPOD and other relevant models. It does not introduce a replacement core schema in this change.

## Street-facing setbacks follow-up

The previous viewport display chose a front edge from a hash of the parcel identity plus the shuffle counter. It never consulted streets, and its maximum envelope combined every supported edge orientation. A real Arlington browser check reproduced edge changes on shuffle.

Viewport envelopes now reuse the existing `site-plots` frontage scorer and the registered `osm-frontage` reader. One lookup covers the complete source parcels plus a 35 m margin; the existing scorer considers nearby, outward-facing street segments within 30 m and approximately parallel to an edge. Its selected edge is used for every housing configuration and their combined maximum envelope. Front, side and rear setbacks are offsets from the original parcel boundary, not distances from a road centreline. Street evidence and candidate edges remain in `sourceEvidence.frontage`; the selected index remains in `sourceEvidence.frontEdge`.

The client renders those server-derived volumes and shuffles housing types only. Missing, partial, truncated or failed street reads retain an explicitly unoriented outer bound with no claimed front edge. This is a frontage inference, not a complete corner-lot or multi-frontage rule evaluator. If the selected street-facing orientation is unsupported, the parcel is withheld instead of switching to an unrelated edge.

Headless unit run record for this follow-up (none stopped; no full suite):

| Scope | Result |
| --- | --- |
| Parcel envelopes (1 file) | 29/29 passed, including road-dependent orientation, offsets from lot lines, unchanged source vertices, one bounded street read, unresolved street evidence and shuffle invariance. |
| MCP drafts, public Atlas and site plots (3 files) | 47/48 passed. The untouched park-agreement draft test fails at `mcp-drafts.test.js:33` because `agreement.agreement.designs` is absent; it does not request planning envelopes. Public Atlas and frontage scorer tests passed. |
| Frontage compass follow-up: parcel envelopes (1 file) | 30/30 passed. The edge's outward normal, independent of uneven vertex spacing and ring winding, supplies its compass label. |

No authoring operation or authored schema changed. Existing MCP permitted-building drafting reads `/planning/envelopes`, so the same server calculation supplies its maximum envelope. A live request through `createMcpReadTools` returned the same eight street-oriented Arlington envelopes as the bounded API check; no new MCP operation was needed.

The headed browser reproduced the old rotating frontage, then verified fixed frontage across all 19 displayed envelopes after a real shuffle. The same source items and street-oriented volumes were visible in 2D and 3D. One previously displayed parcel is now withheld because the street-facing orientation is unsupported; the full viewport reports 34 unsupported parcel shapes and six multiple-zone exclusions. The selected parcel's inspector names North Quincy Street, and the final one-family preview explicitly resolves the local backend and Arlington city. The frontend/API listener directories and frontend `no-store` response were checked. Translated descriptions and the literal-number evidence label were checked as parsed JSON and in the headed browser.

Orientation does not resolve unparsed values. In the inspected Arlington R-10 one-family record, the adapter can currently apply the recorded 25 ft rear setback and 35 ft height. Its front setback, side setback and minimum lot area remain expressions that this increment does not parse. Consequently, the displayed geometry is still a partial envelope even with a correctly inferred front.
