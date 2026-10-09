<!-- Explains the live parcel gateway contract, source identity, and Toronto pilot evidence. -->

## October 9 release checkpoint

This checkpoint includes 57 newly qualified city entries, bringing the app catalogue to 187 entries and 159 executable providers. Research totals are 851 completed investigations, 849 root-reviewed integrations and 97 reviewed public-geometry findings, plus two geometry findings awaiting root review. Earlier sections retain their historical cohort counts and release status. The public `release.json` identifies the deployed revision; pending qualifications are excluded from runtime admission.

# Loading parcel sources

The source evidence is saved in `registry.json` and `research/`: endpoints, operators, scope,
sample requests and responses, native identifiers, paging observations and uncertainties.
The globe's `source` tier means a verified sample exists; it does not enable a runtime provider.

## Continuing population-ranked research — 8–9 October 2026

The [ranked roster](research/overnight-cities-2026-10-08/ranked-top1000.json) contains the largest 1,000 settlements in the UN WUP 2025 bulk data. Its population-weighted coordinates locate settlements; they do not define municipal boundaries. The [provenance](research/overnight-cities-2026-10-08/provenance.json) records the download, population units and ranking. All 305 previously attempted settlements, including unsuccessful attempts, were excluded before this run. The [skip ledger](research/overnight-cities-2026-10-08/skip-ledger.json) also includes new attempts as work proceeds; the [reviewed outcomes](research/overnight-cities-2026-10-08/reviewed-outcomes.json) distinguish reviewed results from ongoing investigations.

The initial pass is complete: 695 newly reviewed settlements and 305 prior-attempt skips. It verified 81 city polygon samples and enabled 49 local app entries. Research continues through a separate [rank 1001–1100 roster](research/overnight-followon-2026-10-09/ranked-population.json), preserving the same source hash and population order. Four prior attempts are excluded there, leaving 96 eligible cities; the [follow-on progress](research/overnight-followon-2026-10-09/progress.json) records new work.

All 96 eligible follow-on cities are now reviewed and integrated into the local evidence reports. Fourteen have verified public parcel geometry; seven passed runtime qualification: Leipzig, Joinville, Utrecht, Bukit Mertajam, Juiz de Fora, Málaga and Bakersfield. Across both overnight cohorts, this is **791 new investigations, 95 cities with public geometry and 56 new local runtime entries**, alongside 309 prior-attempt skips. The local catalogue contains **186 configured city entries and 158 executable providers**. The [qualification check](research/overnight-followon-2026-10-09/headless-catalog186-followon96.json) records 115 passing headless tests; generated reports have no warnings. The [headed browser checks](research/overnight-followon-2026-10-09/followon-headed-browser-check.json) confirm rendered parcels and pointer-selected native Details for Joinville, Utrecht, Bukit Mertajam, Juiz de Fora, Málaga and Bakersfield, without page errors; the dedicated browser was closed. Leipzig has its separate earlier browser record. These additions remain uncommitted and undeployed.

Málaga uses the complete published municipal cartographic GeoJSON snapshot with safe `ID_PARCELA` identity. Two independent downloads reproduce the pinned compressed-representation revision and decoded body; all 145 bounded grid/footprint polygons pass [runtime checks](research/overnight-followon-2026-10-09/malaga-snapshot-root-acceptance.json) and an independent clean metric audit. Bakersfield preserves native `APN_ID` strings and projects bounds into EPSG:2229 before count/object-ID manifests; its [qualification](research/overnight-followon-2026-10-09/bakersfield-native-bounds-requalification-acceptance.json) verifies 119 grid identities and an independently audited 761-polygon wider envelope. Neither result establishes citywide completeness.

Wrocław remains held for a reproducible self-intersection in an unmodified native parcel. Leicester and Edinburgh have public index polygons but overlapping ground extents; Edinburgh's publisher explicitly permits stacked and overlapping polygons in its index model. The current exclusive ground-parcel runtime does not represent that model. Homel now has one valid nearby public WFS polygon, with no exact locator hit; its published reader route still needs complete runtime qualification. These are public-geometry findings with technical holds, rather than claims that parcel data is absent. Research continues in the separate [rank 1101–1200 cohort](research/overnight-next-2026-10-09/ranked-population.json).

The [next-cohort progress](research/overnight-next-2026-10-09/progress.json) now records 60 completed city investigations and 58 root-reviewed local integrations, excluding five confirmed prior attempts. Poznań passed 73 real public requests over thirteen cells, fresh exact reads of all 51 native IDs, explicit absence, footprint lookup and complete one-parcel proposal binding. Its [independent metric audit](research/overnight-next-2026-10-09/poznan-root-quality.json) found no invalidity, duplicates or overlaps above 0.01 m²; the strict reader preserves native EPSG:2177 northing/easting axis order and requests only ID_DZIALKI and MSGEOMETRY. The local catalogue now has 187 city entries and 159 providers. [Headed verification](research/overnight-next-2026-10-09/poznan-headed-browser-check.json) rendered 66 parcels and opened the matching point-containing native ID from a pointer click, with no page errors; the dedicated browser was closed. The [headless checks](research/overnight-next-2026-10-09/headless-catalog187-next43.json) passed 151 tests. Portsmouth also has public HMLR index polygons; its [independent native audit](research/overnight-next-2026-10-09/portsmouth-root-quality.json) confirms 29 overlapping pairs among 112 full polygons, so the exclusive-ground runtime remains held. Provo and Orlando have public point-containing samples and are undergoing runtime qualification. Across reviewed overnight cohorts, 849 cities are reviewed, 97 have verified public geometry and 57 new city entries are enabled locally; two additional geometry findings await review. Additions remain uncommitted and undeployed.

Philadelphia is enabled in the local worktree with the official Department of Records active ground-parcel layer. Its [acceptance](research/overnight-cities-2026-10-08/philadelphia-dor-acceptance.json) checks thirteen cells, forced pagination, all 500 observed identities, explicit absence, footprint lookup and proposal binding. The [geometry review](research/overnight-cities-2026-10-08/philadelphia-dor-overlap-review.json) documents five narrow boundary slivers; all 500 geometries are valid and distinct, with no repair. A [headed browser check](research/overnight-cities-2026-10-08/philadelphia-browser-check.json) loaded parcels and opened a pointer-selected parcel's details without page errors. The dedicated browser was closed.

Las Vegas, Macao and San Diego are also enabled locally. Las Vegas verifies 90 distinct Clark County assessor polygons; its [effective acceptance](research/overnight-cities-2026-10-08/las-vegas-effective-acceptance.json) preserves intermittent HTTP 500 failures and successful retries. Macao verifies 28 polygons from the official DSCC Cad_lote layer at an explicit in-Macao reference; the unchanged Macau–Zhuhai settlement locator is in Zhuhai, whose map-property lookup requires sign-in. Its [acceptance](research/overnight-cities-2026-10-08/macau-dscc-acceptance.json) makes no Zhuhai coverage claim. San Diego verifies 129 SanGIS unstacked reference polygons, using native PARCELID identity independently of its representative APN; the [effective acceptance](research/overnight-cities-2026-10-08/san-diego-sangis-effective-acceptance.json) retains provider deadlines. Independent metric audits found no invalid polygons, duplicate geometries or sampled overlaps above 0.01 m² in these three sets. Headed app checks loaded 134, 33 and 205 parcels respectively and opened details from real pointer clicks without page errors; all owned browsers were closed.

Six further sources are enabled locally after complete paging, fresh exact-ID reads, absence, footprint and binding checks, followed by independent metric GEOS audits. Each audit found all sampled geometries valid and distinct, with no overlaps above 0.01 m² or operation errors. Their scope remains bounded:

| City | Qualified source and evidence |
| --- | --- |
| São Gonçalo | 90 municipal cadastral references; [acceptance](research/overnight-cities-2026-10-08/sao-goncalo-public-cadastre-acceptance.json). |
| Hamburg | 67 native `flstkennz` references through the official simplified ALKIS WFS; [acceptance](research/overnight-cities-2026-10-08/hamburg-alkis-acceptance.json). Exact spatial intersection avoids accepting features outside transformed query envelopes. The earlier flattened curved-GML sample was invalidated and replaced with faithful provider geometry. |
| San Antonio | 115 BCAD parcel references from the public GBRA January 2022 archive; [acceptance](research/overnight-cities-2026-10-08/san-antonio-acceptance.json). Publisher identity is verified; the archive date remains visible. Current SARA transport failures are retained separately. |
| Dallas | 115 tax-parcel references using the published `GIS_ACCT` string; [acceptance](research/overnight-cities-2026-10-08/dallas-taxparcels-acceptance.json). Empty county metadata on one record is preserved rather than synthesized or excluded. |
| Oakland | 203 native `APN_1` references with complete object-ID manifests; [acceptance](research/overnight-cities-2026-10-08/oakland-acceptance.json). An initial 204-reference offset run is superseded and its overstatement of fresh-ID counts corrected. |
| Seattle | 106 native `PIN` references from the City of Seattle-hosted King County parcel layer; [acceptance](research/overnight-cities-2026-10-08/seattle-parcels-acceptance.json). The publisher's spatial extent extends beyond municipal limits. |

Headed checks loaded 112, 123, 219, 217, 366 and 215 parcels respectively, then opened Details from real pointer selections. Oakland's initial viewport timeout and subsequent successful load remain recorded. All owned browsers were closed.

Three more entries are enabled locally:

| City | Qualified source and evidence |
| --- | --- |
| Mesa | 23 native APN references from the City GIS-hosted parcel layer; [acceptance](research/overnight-cities-2026-10-08/mesa-parcels-acceptance.json). The unchanged WUP locator returns no parcel; the app starts at the tested reference about 1.1 km north. |
| Fort Lauderdale | 46 ground tax-parcel rows with the publisher's `RECORDTYPE=Parcel` filter enforced on every query; [acceptance](research/overnight-cities-2026-10-08/fort-lauderdale-acceptance.json). `OBJECTID` supplies row identity; the non-unique `PARCELID` remains a label. Redundant Condo Unit geometry is excluded by this documented source scope. |
| Valencia, Spain | 180 native cadastral references through the shared DGC provider; [acceptance](research/overnight-cities-2026-10-08/valencia-spain-acceptance.json). Actual GML members match both declared collection counts, and a bounded feature cap rejects truncation. The provider has no offset paging. A strict parser recognizes its explicit missing-reference message only when the echoed reference and requested zone match; other exceptions remain unavailable. |

Independent metric audits found all three sampled sets valid and distinct, with no overlaps above 0.01 m² or operation errors. Headed checks loaded 27, 160 and 295 parcels respectively and opened the correct Details panel from real pointer selections. Fort Lauderdale's initial failed load and successful retry remain recorded. Valencia initially failed on simultaneous reads; six concurrent queries reproduced four connection resets, while the same six queries passed with one active request. The shared Spanish provider now uses the existing per-provider request limiter with one slot. Its [browser record](research/overnight-cities-2026-10-08/valencia-spain-browser-check.json) preserves both failures and the successful fresh load. All owned browsers were closed.

Klipgat and Tembisa are enabled locally after independent native-source review. [Klipgat’s acceptance](research/overnight-cities-2026-10-08/klipgat-csg-acceptance.json) verifies 201 Chief Surveyor-General Erven references. The service rejects its advertised GeoJSON output; an explicit native Esri JSON mode preserves every straight ring and component, and rejects native curves, unsupported dimensions and ambiguous holes. [Tembisa’s acceptance](research/overnight-cities-2026-10-08/tembisa-parcels-acceptance.json) verifies 231 Ekurhuleni stand references. Its largest stand retains eight disjoint components with matching native administrative identifiers, without size exclusion or repair. All sampled geometries are valid and distinct, with no sampled overlap above 0.01 m². Headed checks loaded 562 Klipgat parcels in the repository (385 in the latest viewport) and 366 Tembisa parcels, and opened the matching Details panels without page errors. Map menus compute area from geometry; the Details panel shows N/A where source area metadata is absent. Both browsers were closed.

Vitória is enabled at an explicit central-city reference; its unchanged WUP point returned no parcel. Its [acceptance](research/overnight-cities-2026-10-08/vitoria-lotes-root-acceptance.json) verifies 127 valid, distinct municipal Lote references and all fresh composite identities. Four small native boundary-sliver pairs total 0.37279 m²; [fresh native-coordinate reads](research/overnight-cities-2026-10-08/vitoria-native-overlap-review.json) reproduce them, with overlap-part inscribed diameters up to 0.01331 m. These documented slivers are accepted for bounded reference use, consistent with Philadelphia, while preserving all coordinates. The [headed check](research/overnight-cities-2026-10-08/vitoria-browser-check.json) preserves an initial one-cell timeout and a failed immediate cooldown retry. Six targeted queries passed both unrestricted and with two active requests, so the original timeout cause is unestablished. The source now uses the existing two-request limiter; a fresh headed load returned 199 parcels and opened the correct Details panel without page errors. The browser was closed.

Sendai has a verified static sample, with one polygon containing its exact WUP point. The official 2026-07-13 CC BY archive was retrieved and only SHP/SHX/PRJ selectively extracted; DBF header/schema definitions were inspected without reading or joining record values. All three original native geometries pass [root GEOS checks](research/overnight-cities-2026-10-08/sendai-native-geometry-quality.json), with no duplicates or positive-area overlaps. SHP record numbers identify this archive snapshot only. A live viewport/exact-ID/footprint contract has not been qualified, so no executable source is enabled. The tax-reference and accuracy notices remain informational.

Ciudad Juárez is enabled locally with publisher-declared GlobalIDs. The repeated `clavetxt` label is retained as a label: its value `0` matched 23,424 rows during exact-ID qualification, so that identity descriptor was rejected without excluding those parcels. The [effective acceptance](research/overnight-cities-2026-10-08/juarez-globalid-effective-acceptance.json) verifies 203 distinct geometries, complete paging and fresh GlobalID reads. A malformed absence sentinel returned HTTP 400 and remains recorded; a valid synthetic UUID establishes empty-response semantics. GEOS found all sampled geometries valid, without duplicate geometry or overlaps above 0.01 m². The [headed check](research/overnight-cities-2026-10-08/juarez-browser-check.json) loaded 345 parcels and opened the matching Details panel without page errors. The browser was closed.

Calgary is enabled with the City’s safe-field assessed registered-parcel geometries, separately from the paid Ownership Parcel Fabric. Its [acceptance](research/overnight-cities-2026-10-08/calgary-root-protocol-acceptance.json) verifies 181 valid distinct features, complete forced paging, fresh CPID reads, explicit absence, footprint and binding. The original Socrata pagination logging false negative remains preserved; a corrected fresh logger passes. The exact WUP point has no intersecting feature, while nearby geometry is verified. The annual dataset replacement and CPID continuity remain documented limits. Its [headed check](research/overnight-cities-2026-10-08/calgary-browser-check.json) preserves the initial stale-preview 404 and fresh 263-parcel load with a matching Details panel and no page errors. The browser was closed.

Rosario is enabled for municipal cadastral Section 9 through a public CSV containing full embedded GeoJSON and safe cadastral code fields. Its [acceptance](research/overnight-cities-2026-10-08/rosario-section9-protocol-acceptance.json) pins the 15,854-row revision and strong ETag, verifies 826 bounded geometries, and reproduces every bounded native ID after a separate complete download. This static source has no server paging. All audited geometries are valid and distinct, with no sampled overlaps or operation errors. The [headed check](research/overnight-cities-2026-10-08/rosario-browser-check.json) loaded 1,094 parcels and opened matching Details without page errors. The browser was closed.

Auckland and Minneapolis are enabled locally. [Auckland](research/overnight-cities-2026-10-08/auckland-linz-root-acceptance.json) verifies 184 current primary parcels with the existing shared LINZ runtime profile; its 47 checks include forced three-row paging, fresh native IDs, absence, footprint and binding. Wellington retains its runtime settings. [Minneapolis](research/overnight-cities-2026-10-08/minneapolis-hennepin-root-acceptance.json) verifies ten Hennepin County assessment parcels in 35 expanded views; the exact WUP locator has no intersecting parcel, while nearby coverage is usable. The fresh acceptance uses a self-contained native projection rather than the research harness’s registered EPSG alias. Separate Saint Paul/Ramsey coverage remains intact. Independent metric audits found both sets valid and distinct, without sampled overlaps or operation errors. Headed checks loaded [177 Auckland parcels](research/overnight-cities-2026-10-08/auckland-browser-check.json) and [eight Minneapolis parcels](research/overnight-cities-2026-10-08/minneapolis-browser-check.json), opened matching Details and recorded no page errors. Both browsers were closed.

Tuen Mun is enabled through a separate Lands Department CSDI Lot provider; the existing Hong Kong Lot Index provider is unchanged. Its [acceptance](research/overnight-cities-2026-10-08/tuen-mun-csdi-root-acceptance.json) verifies thirteen aligned cells and four pans, all 127 fresh native LotCSUID identities, forced three-row object-ID batches, explicit absence, footprint lookup and actual proposal binding. Its [metric audit](research/overnight-cities-2026-10-08/tuen-mun-csdi-root-quality.json) found no invalid polygons, duplicate geometry or sampled overlaps. The layer represents granted/sold lots rather than a complete fabric. Offset and multi-ID IN failures remain recorded; the descriptor uses manifests and individual equality reads. The [headed check](research/overnight-cities-2026-10-08/tuenmun-browser-check.json) loaded 123 parcels and opened matching Details from a real pointer click without page errors. The browser was closed.

Düsseldorf, Marseille, Lille, Stuttgart and Frankfurt are enabled locally after thirteen-cell adapter qualifications. Their respective [acceptances](research/overnight-cities-2026-10-08/dusseldorf-nrw-root-acceptance.json), [Marseille](research/overnight-cities-2026-10-08/marseille-ign-root-acceptance.json), [Lille](research/overnight-cities-2026-10-08/lille-ign-root-acceptance.json), [Stuttgart](research/overnight-cities-2026-10-08/stuttgart-lgl-root-acceptance.json) and [Frankfurt](research/overnight-cities-2026-10-08/frankfurt-wfs-root-acceptance.json) verify 162, 331, 281, 78 and 191 distinct cadastral references, complete pagination, every fresh native ID, explicit absence, footprint lookup and source binding. All five metric audits found valid, distinct geometry without sampled overlaps above 0.01 m². Lille's unchanged metropolitan locator lies in Marcq-en-Barœul, a separate commune; the nationwide IGN layer verifies that nearby ground without claiming Lille municipal-only coverage. Frankfurt's service returns native EPSG:25832 GeoJSON and rejects its advertised sorting, so its reader checks complete counts and monotonic native object-ID pages before accepting FSK cadastral identities. Headed checks loaded 325, 630, 436, 109 and 333 parcels respectively and opened the matching Details panels from pointer selections without page errors. Every owned browser was closed.

St Petersburg, Florida and Detroit are enabled locally. The Pinellas County [ground-class acceptance](research/overnight-cities-2026-10-08/pinellas-root-ground-native-acceptance.json) uses the publisher’s `Land Polygon` class and preserves qualified parcel IDs; its [native edge review](research/overnight-cities-2026-10-08/pinellas-root-native-edge-review.json) reproduces two narrow boundary slivers approximately 3.5 mm wide without repair. [Detroit](research/overnight-cities-2026-10-08/detroit-root-acceptance.json) verifies 200 valid distinct current assessor polygons, preserving native dots, hyphens and combined-lot suffixes. Headed checks loaded [61 Pinellas parcels](research/overnight-cities-2026-10-08/pinellas-browser-check.json) and [309 Detroit parcels](research/overnight-cities-2026-10-08/detroit-browser-check.json), opened matching Details and found no page errors. The browsers were closed.

Evaton and Bonn reuse existing providers. [Evaton](research/overnight-cities-2026-10-08/evaton-csg-root-acceptance.json) verifies 46 valid distinct Chief Surveyor-General Erven references. Its [native review](research/overnight-cities-2026-10-08/evaton-root-native-edge-review.json) preserves a 0.0131 m² boundary sliver under one millimetre wide. [Bonn](research/overnight-cities-2026-10-08/bonn-nrw-root-acceptance.json) verifies 79 valid distinct NRW ALKIS references without sampled overlaps. Headed checks loaded 71 and 146 parcels and opened matching Details without page errors. Bonn’s initial handled HTTP502 and later successful fresh load remain in its [browser record](research/overnight-cities-2026-10-08/bonn-browser-check.json); the failure cause is unestablished.

George Town, Thessaloniki and Bilbao are enabled locally. Their [George Town acceptance](research/overnight-cities-2026-10-08/georgetown-forestry-root-acceptance.json), [Thessaloniki acceptance](research/overnight-cities-2026-10-08/thessaloniki-root-acceptance.json) and [Bilbao acceptance](research/overnight-cities-2026-10-08/bilbao-bizkaia-root-acceptance.json) verify 143, 368 and 79 valid distinct cadastral references in thirteen bounded cells each, with fresh native identities, completeness, absence, footprint and binding checks. All three metric audits found no sampled overlaps or operation errors. George Town preserves variable-length UPI strings and the JUPEM 2020 reference date; the government Forestry server’s missing TLS intermediate is supplied from the official GlobalSign CA with certificate and hostname verification enabled. Thessaloniki preserves Greek characters in municipal KAEK strings. Bilbao uses its separate Bizkaia foral provider and municipality/polygon/parcel tuple; [fresh native-coordinate review](research/overnight-cities-2026-10-08/bilbao-root-native-identity-review.json) matches the official WFS sample. Headed checks loaded 233, 579 and 118 parcels, opened matching Details and recorded no page errors. The browsers were closed.

[Milwaukee](research/overnight-cities-2026-10-08/milwaukee-county-root-acceptance.json) verifies 146 valid distinct county cadastral-reference polygons with fresh public `Map_ID` identities, complete paging, explicit absence, footprint and binding. Its metric audit found no sampled overlaps or operation errors. The source explicitly labels `Map_ID` as GIS Polygon ID; null `Parcel_Key` values do not prevent reference-map identity. [All three earlier nearby samples](research/overnight-cities-2026-10-08/milwaukee-root-sample-native-id-review.json) match the fresh complete geometry unchanged. The exact settlement locator has no intersecting parcel. The [headed check](research/overnight-cities-2026-10-08/milwaukee-browser-check.json) loaded 254 parcels, opened the matching native Details panel from a pointer click and found no page errors. The browser was closed.

Ten further entries are enabled locally after complete bounded retrieval, fresh native-ID geometry reads, absence, footprint and binding checks. Independent metric audits found all sampled geometries valid and distinct, with no sampled overlaps above 0.01 m² or operation errors:

| City | Qualified source and evidence |
| --- | --- |
| Kraków | 56 municipal EGiB references, preserving native `id_dzialki` slashes; [acceptance](research/overnight-cities-2026-10-08/krakow-msip-root-acceptance.json). |
| Fresno | 106 county assessor references with native lowercase `apn`; [acceptance](research/overnight-cities-2026-10-08/fresno-county-root-acceptance.json). |
| Winnipeg | 32 assessment-map `gisid` references, collapsing only identical repeated assessment geometry; [acceptance](research/overnight-cities-2026-10-08/winnipeg-assessment-root-acceptance.json). The identifiers refer to GIS ground, not assessment accounts. |
| Sha Tin | Three Lands Department CSDI native `LotID` references; [acceptance](research/overnight-cities-2026-10-08/sha-tin-csdi-root-acceptance.json). Native multipart lots retain one identity and all components. Sparse pagination is tested with single-row pages. |
| Okara | 58 public PULSE source `OBJECTID` references; [acceptance](research/overnight-cities-2026-10-08/okara-public-runtime-root-acceptance.json). The anonymous reader flow is runtime-only, with no token values in evidence or catalog. Zero-valued land-record labels are not promoted into legal keys. |
| Kitwe | 31 Zambia NSDI native GIS lot references, with `UPID` retained as a label; [acceptance](research/overnight-cities-2026-10-08/kitwe-zilmis-oid-root-acceptance.json). |
| Wuppertal | Seven shared NRW ALKIS references; [acceptance](research/overnight-cities-2026-10-08/wuppertal-nrw-root-acceptance.json). The original native key matches; negligible WFS/OGC coordinate-transform differences are disclosed. |
| Palermo | 390 Sicilia SITR references using the full six-field native tuple, preserving literal fixed-width spaces; [acceptance](research/overnight-cities-2026-10-08/palermo-sitr-single-id-root-acceptance.json). Failed larger exact-ID batches are retained separately; all fresh IDs pass as individual GET reads. |
| Toulouse | 85 shared IGN/DGFiP native `idu` references; [acceptance](research/overnight-cities-2026-10-08/toulouse-ign-root-acceptance.json). The two original nearby polygons match unchanged. |
| Bordeaux | 110 shared IGN/DGFiP native `idu` references; [acceptance](research/overnight-cities-2026-10-08/bordeaux-ign-root-acceptance.json). The original large park parcel contains the settlement locator and matches unchanged. |

Headed checks loaded these sources and opened matching native Details panels from actual pointer selections, with no uncaught page errors. The browsers were closed. Kitwe’s first wider viewport failed on deadlines: six client calls shared two provider slots, so four queued calls finished after the existing 15-second client deadline. Its [bounded concurrency review](research/overnight-cities-2026-10-08/kitwe-root-concurrency-review.json) shows all six source responses unchanged and under that deadline with six slots. Only that source budget changed. A fresh [wider headed check](research/overnight-cities-2026-10-08/kitwe-wide-browser-check.json) loaded 46 parcels without a timeout warning; all 46 pass an additional metric topology audit. Earlier failures remain recorded.

[Łódź](research/overnight-cities-2026-10-08/lodz-intersects-batched-root-acceptance.json) and [Dresden](research/overnight-cities-2026-10-08/dresden-saxony-gml-root-acceptance.json) are enabled locally through fixed publisher GML3.2 profiles. Exact projected spatial intersection is identical for hit counts and pages; forced pagination, fresh native IDs in eight-key batches, explicit absence, footprint and binding pass. Łódź verifies 89 distinct polygons; Dresden verifies 11 grid polygons plus 27 distinct polygons across the complete grid/footprint sample. Independent metric audits found no invalidity, duplicate geometry or sampled overlaps, with no repairs or omitted parts. Łódź’s initial BBOX count mismatch and overlong exact-ID URL failure remain preserved. The [manual headed check](research/overnight-cities-2026-10-08/lodz-dresden-manual-browser-review.json) loaded 162 and 13 parcels and opened matching Details from pointer clicks without browser errors. The browser was closed.

The local configuration now has **180 city entries / 154 executable providers**, including 50 additions from this continuing run; these additions are not yet deployed. The dated [179-entry catalog check](research/overnight-cities-2026-10-08/final-headless-179.json) passed 457 tests in 25 files after rebuilding coverage. It covers source wiring, parcel adapters/readers and full-catalog gateway initialization. Subsequent research-only registry updates require a fresh generated-coverage rebuild; earlier checks remain preserved as dated snapshots.

The follow-on cohort currently has 32 root-reviewed and integrated cities, with three verified geometry samples and one local enablement. [Leipzig](research/overnight-followon-2026-10-09/leipzig-saxony-gml-root-acceptance.json) reuses the Saxony provider and qualifies 180 full native parcels across thirteen bounded cells, forced paging, fresh exact IDs, absence, footprint and binding. Independent metric audits of the grid/footprint set and 308 parcels observed in the app found no invalidity, duplicates, sampled overlaps or operation errors. The [manual headed check](research/overnight-followon-2026-10-09/leipzig-manual-browser-review.json) loaded 308 parcels and opened the original WUP-point parcel’s matching Details panel from a real pointer click without page errors; the browser was closed. The follow-up [catalog/report check](research/overnight-followon-2026-10-09/headless-catalog180-followon32.json) passed 115 tests in seven files after rebuilding both generated coverage reports.

[Sheffield’s public HMLR archive](research/overnight-followon-2026-10-09/sheffield-hmlr-root-review.json) was retrieved using its source-issued anonymous cookies. Its 172,021-row GML contains a full native polygon at the unchanged settlement locator, but the surrounding 554-polygon audit found three duplicate geometry pairs and 80 positive-area overlap pairs, including material conflicts. It remains disabled. [Kendal’s public municipal land-asset map](research/overnight-followon-2026-10-09/kendal-assets-root-review.json) provides partial government ground; native open paths, invalid polygons and material overlaps remain unresolved. Three valid nearby asset polygons are retained without clearing those source failures. Unknown local registry custody remains distinct from unverified anonymous geometry access.

Nottingham’s native freehold-index source has reproducible self-intersections and material overlaps; Morelia has missing cadastral keys and stacked unit footprints. Seville’s later fresh-ID batches disagree or receive HTTP 403, so its bounded geometry does not clear complete runtime retrieval. Ribeirão Preto passes protocol checks for 729 rows, but its [native duplicate review](research/overnight-cities-2026-10-08/ribeirao-root-native-duplicate-review.json) confirms distinct GIS rows with identical ground footprints. Pereira passes protocol checks for 917 terrain references, but three material containment overlaps persist in [fresh native coordinates](research/overnight-cities-2026-10-08/pereira-root-native-overlap-review.json), including rows whose lifecycle end values are all null. These sources remain held without repair or selective exclusion. Salta’s [244-polygon qualification](research/overnight-cities-2026-10-08/salta-city-507-acceptance.json) passes protocol and topology through a normally verified curl transport; actual Node TLS rejects unsafe legacy renegotiation, so executable runtime access remains held. Source age and title semantics are disclosed separately from these technical holds.

Baltimore remains held after a wider headed load exposed a native-coordinate count/ID-manifest disagreement (61 versus 60), reproduced sequentially; its earlier 202-parcel bounded acceptance remains preserved. Natal’s sampled municipal snapshot contains duplicate geometry and material overlaps. Sargodha’s public-viewer polygons are verified, but a full-footprint count/manifest check failed; no anonymous-reader token is retained. Leeds’s larger official archive exceeds the existing reader’s bounded capacity, and a native-coordinate sample contains a 185.58 m² overlap. All remain recorded without repair or selective exclusion.

Almaty remains held: national and municipal feeds reproduce material overlaps in their native coordinates, and the inspected lifecycle fields supply no documented safe exclusion. Bursa remains held because a fresh native parcel response reproduces a self-intersection. Goiânia has a verified full polygon but its public viewer protocol has not yet passed complete retrieval and exact-identity qualification. Porto Alegre has material overlaps and duplicate geometry; Cirebon has missing/conflicting native identities; Gaziantep has a point sample without qualified area enumeration. Independent audits reproduce 22 invalid geometries among Córdoba's 440 source polygons, three material overlap pairs and five overlay errors, and one self-intersection among Gwangju's 54 polygons. Both remain held without repair or selective exclusions. Antalya remains held locally after one point response failed containment; the shared Istanbul provider remains enabled. A public dev-labelled hostname, source date, legal identifier or map notice alone is not an eligibility gate. Other outcomes preserve city-specific registry evidence separately from public geometry availability.

Glasgow's three retained source polygons are valid but substantially overlap; its public INSPIRE title archive remains held for identity/snapshot and ground semantics, as recorded in the [root geometry review](research/overnight-cities-2026-10-08/glasgow-root-geometry-review.json). Konya remains held after [actual point-adapter checks](research/overnight-cities-2026-10-08/konya-root-point-followthrough-acceptance.json) returned seven distinct features, including a reproducible ring self-intersection, alongside nearby transport failures. Point access itself is not a hold reason. Bucaramanga's [complete-parts acceptance](research/overnight-cities-2026-10-08/bucaramanga-root-complete-parts-acceptance.json) passes all checks for 258 cadastral codes assembled from 259 native rows, but its [metric review](research/overnight-cities-2026-10-08/bucaramanga-root-complete-parts-quality.json) retains a 0.334 m² triangular boundary conflict about 0.93 by 0.72 metres, rather than a thin numerical sliver. No parcel was excluded or repaired.

Gaza's embedded public map snapshot has one ambiguous native ring representation and ten invalid polygons among the remaining 1,186; identity replacement and runtime reads remain unqualified. Mendoza's Guaymallén layer passes protocol checks but includes unresolved material overlaps up to 268.254 m². Nara's static archive contains repeated native land keys across its full corpus, and its snapshot identity/reader contract remains unqualified. Aracaju's [actual WFS qualification](research/overnight-cities-2026-10-08/aracaju-root-acceptance.json) fails on repeated fiscal-lot keys with distinct native geometries; the valid successful subset does not clear those failures. Katowice's [coordinate review](research/overnight-cities-2026-10-08/katowice-root-coordinate-review.json) reproduces native EPSG:2177 coordinates falsely labelled EPSG:4326 by both REST formats. These sources remain held without repair or selective exclusion. Singapore's Sembawang sample comes from a public revisioned national snapshot; its transient download locator and full runtime snapshot contract remain unqualified.

This continuing research and its new local integrations are uncommitted and undeployed. The initial worktree release and subsequent Vienna correction are live at commit `0943514f`, with 130 configured cities and 115 providers. New sources require successful protocol and geometry review before local enablement. No parcel database import is performed; repository examples retain at most three safe full polygons per city.

## Remaining world capitals — 8 October 2026

The [completed batch](research/world-capitals-2026-10-08/index.json) checks **69 previously unchecked capitals and associated seats**. The [roster](research/world-capitals-2026-10-08/roster.json) contains 225 seats: 156 had earlier city-specific evidence, including failed attempts; all 69 remaining entries now have dated research. Scope covers all 193 UN members and the two observer states, separate government/royal/transitional seats, and a labelled supplementary group. Overseas dependencies and ordinary provincial capitals are excluded. Inclusion and source jurisdiction do not express political recognition or boundary claims.

The batch establishes city-level registry/land-mapping activity in **32 cities**, leaves it unestablished in **37**, verifies public polygon samples in **20**, and enables **10 app entries**. The generated catalogue now contains **130 configured cities / 115 executable providers**. The new evidence does not establish countrywide completeness.

| Enabled city | Verified scope and limits |
| --- | --- |
| Vienna | 51 cadastral references in 13 initial cells, extended to 315 references in a wider viewport and adjacent pans. The BEV adapter reconstructs complete parcels from maximum-resolution vector tiles, checks matching cuts at tile seams, and uses API rectangles as locators. Generalized display coordinates are not legally binding survey coordinates. |
| Cetinje | 283 valid source-row references across 13 cells with no sampled overlaps. Podgorica remains held on the same publisher; a Cetinje pass does not clear its separate defects. |
| San Marino | 221 complete FOG_MAP land-parcel references in 13 cells. Published land-class filters exclude roads, water and cartographic objects; all parts are retained. |
| The Hague | 139 current PDOK cadastral references in 13 cells, using the existing Amsterdam/Rotterdam provider and namespace. |
| Wellington | 174 current primary-parcel references in 13 cells. Final catalogue identity also passed a fresh exact lookup and binding check. |
| Beirut | 89 parcel PID references from the publisher's 2019-survey basemap. The earlier district-boundary candidate was rejected. Two unchanged boundary slivers are under 0.31 m² and 4.3 cm wide. |
| Thimphu — Taba | 112 valid public municipal plot polygons in 13 cells, all inside the published Thromde boundary. Legal registration, lifecycle, vintage and planning status are undocumented. The earlier national cadastral sample lies outside the city and is explicitly superseded. |
| Bandar Seri Begawan | 357 valid source-row references in 13 cells. Nine narrow overlaps remain unchanged; the largest native overlap is 26.87 m², 0.02151% of the smaller parcel, with maximum inscribed diameter 0.297 m. |
| Jerusalem | 123 source-row references in 13 cells. Govmap OBJECTID supplies identity because PARCEL_ID is nonunique. A 40-ID exact lookup took 85 seconds; transient timeouts and successful retries remain recorded. |
| East Jerusalem | Separate 13-cell check, six grid rows and ten rows in the grid/footprint union audit, all valid without sampled overlaps. Uses the same Govmap source namespace, while the explicit city record preserves its own roster jurisdiction. |

Govmap browser ID requests use the tested three-ID size, so each gateway request retains the existing 15-second deadline; the entire multi-batch operation can still take longer.

All enabled sources passed actual adapter checks for complete viewport retrieval, forced pagination where applicable, fresh exact-ID geometry hashes, explicit absence, footprint lookup and source binding. Vienna instead exercises complete cross-tile reconstruction. Independent GEOS audits retain provider geometry without repair. These bounded samples do not establish citywide coverage, legal title or survey accuracy.

**Nine geometry candidates remain held:** Andorra la Vella, Bratislava, Skopje, Podgorica, Chișinău, Ramallah, North Nicosia, Malé/Hulhumalé and Paramaribo. Their city records retain self-intersections, duplicates or material overlaps and any native-coordinate follow-up. **La Paz remains on retrieval hold:** its initial polygon sample succeeded, but all thirteen subsequent adapter cells and the absence probe returned HTTP 502. The other 49 cities have no verified public polygon response in this pass. A failed public search is not evidence that a registry does not exist.

The [sample-retention record](research/world-capitals-2026-10-08/sample-retention.json) limits repository examples to three safe polygons per city; surplus historical geometry is represented by hashes and audit metadata. Owner and contact attributes are excluded. Missing legal parcel identifiers and reuse notices are not eligibility gates. No database import was performed.

[Headless verification](research/world-capitals-2026-10-08/final-headless-tests.json) passed 237 scoped tests in 11 files; 32 overlapping report/integration tests passed again after the final evidence update. Two additional history-metadata checks still fail on gaps confirmed unchanged from the preceding commit. [Manual headed-browser checks](research/world-capitals-2026-10-08/browser-check.json) loaded and selected real parcels in all ten entries, opened their details, verified the report's Vienna and East Jerusalem rows, and recorded no uncaught page errors. The dedicated browser was closed. This batch was committed, pushed and deployed on 2026-10-08 at release commit `30c2256c`.

The post-deployment [Vienna follow-up](research/world-capitals-2026-10-08/bev-fix-check.json) reproduces three locator-envelope mismatches and the previously failing wider viewport. The corrected adapter accepts generalized outlines within the locator, while rejecting unmatched tile cuts or geometry outside it. All 315 reference rereads match the viewport shapes; the [independent GEOS audit](research/world-capitals-2026-10-08/bev-fix-quality.json) finds no invalid shapes, duplicates or overlaps. The [primary-source review](research/world-capitals-2026-10-08/bev-contract-review.json) documents BEV's z16 precision and display-coordinate limits. The [follow-up verification](research/world-capitals-2026-10-08/bev-fix-verification.json) passes 86 relevant headless tests and a manual headed-browser load, mouse selection and Details check; its dedicated browser was closed.

## Remaining African capitals — 8 October 2026

The [completed batch](research/africa-capitals-2026-10-08/index.json) investigates **43 previously unchecked capitals and associated seats**. The [roster](research/africa-capitals-2026-10-08/roster.json) separates 23 previously checked entries from this pass: 63 national-capital/associated-seat entries across 54 African UN members, plus a separately labelled three-city disputed/de facto supplement. Research locators are chosen points, not official city boundaries. All records retain executed English and local-language searches and distinguish city registry activity from public geometry.

This pass records registry/cadastral evidence in **35 cities**, leaves presence unestablished in **eight**, verifies polygon samples in **five**, and enables **three** app entries. With concurrent additions from other work preserved, the generated catalogue contains **120 app entries / 107 executable providers**. No countrywide coverage is inferred from this batch.

| City | Result and tested scope |
| --- | --- |
| Gaborone | Enabled: 76 source-row references in 13 cells; all valid, no duplicate geometry or positive-area overlap. Repeated `LotId` values require the tested `LotId` + `OBJECTID_1` composite; it is not an official title identity. Tiny source fragments remain unchanged. |
| Bloemfontein | Enabled: public Mangaung `Cadastre_2025`, 53 `SG_CODE` references in 17 cells; all valid, no duplicates or overlaps. Municipal publisher metadata is identified; upstream lineage, current legal registration and citywide completeness remain unverified. |
| Pretoria | Enabled: official Tshwane `Registered` subset, 93 LIS references in 13 cells. All valid; seven boundary slivers remain below 2.26 m² and 0.34% of the smaller parcel. Other status values are excluded; original-survey semantics and wider coverage remain unverified. |
| Porto-Novo | Verified geometry, held from runtime: protocol and exact rereads pass for 2,126 NUPs in 17 cells, but nine polygons self-intersect and one overlap covers 98.91% of the smaller parcel. Fresh reads reproduce the defects; the schema has no lifecycle field to resolve them. Cotonou's existing runtime configuration is unchanged. |
| Victoria | Verified geometry, held from runtime: 496 parcel references in 13 cells pass protocol and exact rereads. Excluding ended records still leaves an older polygon almost partitioned by two newer polygons, all with open-ended validity. No documented parent/subdivision or category rule supplies a safe exclusion. |

The [Gaborone acceptance](research/africa-capitals-2026-10-08/gaborone-composite-complete-audit.json), [Bloemfontein acceptance](research/africa-capitals-2026-10-08/bloemfontein-adapter-acceptance-initial.json), and [Pretoria acceptance](research/africa-capitals-2026-10-08/pretoria-equality-acceptance.json) exercise complete paging, fresh exact reads, absence, footprint queries and source binding. Independent projected GEOS audits retain source geometry without repair. [Porto-Novo follow-up](research/africa-capitals-2026-10-08/porto-novo-overlap-followup.json) and [Victoria follow-up](research/africa-capitals-2026-10-08/victoria-overlap-review.json) explain the quality holds; missing native IDs are not a rejection criterion.

Tshwane rejects `IN` and combined native-key/status predicates, including ordinary POST requests. Its configured single-equality mode resolves one native key to a complete object-ID manifest, then fetches those object IDs with the normal status filter and validates every returned row. A missing or out-of-scope row fails explicitly. A published GeoTrust intermediate completes the server's omitted chain while preserving certificate and hostname verification. Victoria qualification uses a typed ArcGIS date predicate with matching epoch validation; it does not silently accept ended or omitted lifecycle values. The [headless verification](research/africa-capitals-2026-10-08/final-headless-tests.json) records 233 passing tests.

## Athens and coverage reconciliation — 8 October 2026

Athens now uses the official active-cadastre ArcGIS layer with native `KAEK` identifiers.
The [source check](research/athens-live-2026-10-08.json) verified complete pagination for
27 parcels in a small central area and exact native-ID retrieval. Headed Chrome loaded
3,107 parcels and opened a selected lot's details. Wider geographic completeness remains
unconfirmed. This addition brings the catalogue to 115 app entries and 102 providers.

[Tbilisi](research/tbilisi-msda-2026-10-08.json) and
[Istanbul](research/istanbul-live-2026-10-08.json) now have runtime adapters for parcel
lookup on click and by exact native ID, bringing the catalogue to 117 app entries and
104 providers. Tbilisi also displays the official NAPR cadastral map. Istanbul follows
the TKGM viewer's selected-parcel behavior over the basemap. The repository retains
the returned polygons without marking any viewport cell complete. Area queries fail
explicitly; operations requiring complete intersecting cadastre remain unavailable.
The globe describes this point-lookup mode separately from loading parcels on pan.

The [coverage audit](research/coverage-audit-2026-10-08.json) records the evidence gaps
behind the Croatia/Serbia errors and corrects New Zealand and Singapore to full country
coverage using official scope statements. It leaves 44 older multi-region records
pending national-scope review; positive samples alone do not establish completeness.

## Fourth India and Africa batch — 8 October 2026

The [fourth ten-city pass](research/india-africa-batch4-2026-10-08/index.json) checked five Indian and five African cities. **No additional source qualified for live display.** The catalogue remains at **114 app entries / 101 executable providers**. This pass updates research and the coverage report; it adds no runtime provider or database parcel import and remains uncommitted and undeployed.

| City | Recorded result |
| --- | --- |
| Jaipur | The official Urban GIS viewer advertises Settlement Department khasra and JDA plot layers. Its anonymous map bootstrap succeeds, but the actual layer hosts time out before TLS from two networks. |
| Varanasi | UP BhuNaksha now returns village extents, parcel codes and bounding boxes near the city, and a public WMS renders plot boundaries. The discovered full-shape routes return HTTP 401; a raster or bounding box is not a verified vector parcel. |
| Indore | The official municipal GIS times out from two networks. An independent public demo publishes colony/layout shapes, but deliberately rotates and shifts them into a private coordinate frame without a geographic transform. |
| Nagpur | Official city-survey/property-map services are documented. The Maharashtra viewer times out from both checked networks; an indexed rural Jamtha report does not establish urban parcel coverage. |
| Kalyan-Dombivli | KDMC advertises city-survey and property polygon layers. Actual requests return the same ArcGIS Web Adaptor failure from two networks. The WUP centre's relationship to KDMC and neighbouring Ulhasnagar also needs resolution. |
| Onitsha | Anambra land-administration services are documented; no anonymous Onitsha parcel geometry was verified. |
| Yaoundé | A public ArcGIS Urban candidate contains only 32 tiny polygons in a 36.8 × 36.2 m cluster about 11.1 km from the WUP centre. Their undocumented origin and implausible parcel scale prevent qualification. |
| Kampala | KCCA confirms cadastral information exists, but its verified anonymous app configuration lists only boundaries, divisions, buildings, parishes and villages. |
| Kano | KANGIS documents land registration and map services, but no anonymous parcel layer was verified. The tested ArcGIS service requires a token. |
| Casablanca | ANCFCC confirms local cadastral services. Its plan-ordering workflow and AUC sign-in do not provide an anonymous parcel feed; the public forestry-layer lead is not urban cadastral data. |

The [Jaipur service diagnostic](research/india-africa-batch4-2026-10-08/jaipur-urban-gis-diagnostic.json), [Indore coordinate assessment](research/india-africa-batch4-2026-10-08/indore-municipal-diagnostic.json), [Varanasi sample record](research/india-africa-batch4-2026-10-08/india-varanasi-10447-map-sample.json) and [Yaoundé geometry audit](research/india-africa-batch4-2026-10-08/africa-west-yaounde7-parcels-all32-geometry.json) retain the evidence. Missing native identifiers were not a rejection criterion: usable, georeferenced boundaries may use source-scoped geometry references. Registry presence, public viewing, geometric plausibility and runtime access remain separate findings.

## Central Asian republic capitals — 8 October 2026

The [five-capital check](research/central-asia-capitals-2026-10-08/index.json) qualifies **Astana — Esil district** locally. The catalogue now contains **114 app entries / 101 executable providers**. Bishkek has verified public parcel data but remains unconfigured for geometry quality; Dushanbe, Tashkent and Ashgabat have documented official registry or portal evidence without a verified public geometry response in this pass.

Astana's official national EGKN public cadastral map requires the viewer's district selector and native coordinate system. The accepted provider reads `egkn:u_view`, `district_id:254`, in **EPSG:32642**, then transforms complete shapes to WGS84. The native cadastral number is `kad_nomer`; `gid` is transport ordering. Generated GeoServer feature IDs change between otherwise identical requests and are never parcel identity. Earlier zero-feature `ru_view` queries without the required district and WGS84-coordinate probes remain recorded as inconclusive, superseded requests.

The live adapter verified **154 native identities in nine cells**, complete forced three-record paging across 65 pages, all fresh exact lookups with matching geometry, explicit absence and both source-binding paths. All 154 sampled polygons are valid. Five measured overlaps are retained unchanged: the two largest are **0.451 m² and 0.382 m²**, with minimum oriented widths of about **9.8 mm and 12.1 mm**; the other three are below 0.007 m². These explicit source-precision cases do not introduce a global repair or tolerance. The [native-coordinate geometry audit](research/central-asia-capitals-2026-10-08/astana-national-u-view-3x3-requests.json) and [adapter acceptance](research/central-asia-capitals-2026-10-08/astana-acceptance.json) retain the checks.

An unchunked 80-key FES request returned HTTP 414. Exact reads now split into at most 20 keys per upstream filter under one 15-second deadline and response-byte budget; caller batches of 80 and 74 passed. A source-scoped published Sectigo intermediate completes the omitted server certificate chain, preserving ordinary TLS and hostname verification. The shared verified-HTTPS helper now exposes a bounded standard response stream as well as JSON, so the actual runtime transport exercises the adapter's tighter byte limits.

The first full browser viewport exposed a provider BBOX overfetch: one genuine parcel was 0.883 m outside the requested projected envelope. Its fresh exact-ID geometry matched. The adapter now validates and counts every returned row before locally excluding envelope misses; it does not move boundaries or relax pagination checks. After the fix, the headed browser loaded **25 cells / 386 retained parcels**, selected cadastral number `21320072529`, and panned to **40 cells / 483 retained parcels**. All 40 final gateway requests returned HTTP 200, without source warnings or page errors. The [browser record](research/central-asia-capitals-2026-10-08/browser-check.json) retains the initial failure and successful retest.

| Capital | Recorded result |
| --- | --- |
| Astana | Enabled for the public provider's Esil district view. Partial city coverage; ownership and boundary update dates unestablished. |
| Bishkek | Official public WFS returns native `PROPCODE` and parcel geometry. Published `NAZNACHENI=земельный участок` filters out overlapping premises. In nine cells, 111 parcel polygons include three invalid geometries and 12 positive-area overlap pairs; candidate adapter/tests exist but are not wired into the runtime. |
| Dushanbe | Public portal and Dushanbe polygon-layer metadata verified with a request-scoped certificate exception. Actual feature/count reads fail with ArcGIS 400 from two networks; the newer cadastral service times out. No polygon retrieved or runtime adapter enabled. |
| Tashkent | Official sources describe the public NGIS parcel/real-estate geoportal; HTTP and HTTPS requests timed out. |
| Ashgabat | Official law documents the cadastre and cadastral maps; no anonymous parcel-feature service was found in the checked public sources. |

The [Dushanbe service diagnostic](research/central-asia-capitals-2026-10-08/dushanbe-service-diagnostic.json) supersedes the earlier certificate-only blocker. The public map references `OLD_DATA/OLD_DATA/FeatureServer/6`, a parcel polygon layer with `Cadastral_code`, `OBJECTID` and a declared extent about 29 by 29 km around Dushanbe in EPSG:32642. Count, spatial and object-ID queries fail despite reachable metadata; a map export contains zero visible pixels. The newer `CADASTR/CADASTR_NEW/FeatureServer/1` times out even after 80 seconds on a second network. This supports a provider-side data-service failure, whose exact internal cause is unexposed. Layer extent and schema do not verify actual coverage, identifier values, boundary quality or update dates. HTTPS validation remains the default; a narrowly scoped exception for this source is authorized if data access recovers.

These are city-source findings, not claims that the other countries lack cadastres. None of the new live sources imports parcel geometry into the database; continuation changes remain uncommitted and undeployed.

## Third India and Africa batch, plus Nairobi — 8 October 2026

The [third batch](research/india-africa-batch3-2026-10-08/index.json) checked Kolkata, Mumbai, Surat, Lucknow, Kanpur, Cairo, Kinshasa, Alexandria, Khartoum and Addis Ababa. **Surat** qualifies locally. The additional **Nairobi** follow-up also qualifies under the user's geometry-reference policy. This regional step brought the catalogue to **113 app entries / 100 executable providers**, before the Astana addition above; changes in this continuation remain uncommitted and undeployed.

Surat uses Gujarat TPVD's final SMC planning plots, with partial scheme coverage and no claim of current title or ownership. Nine aligned cells returned **231 native references**, all reread with matching geometry. Footprint and both source-binding paths passed. A pair of adjacent plots has a **0.239 m² overlap, about 9 mm wide**: the original strict overlap failure and separate precision-sliver assessment are retained, and the source geometry is unchanged. See the [acceptance record](research/india-africa-batch3-2026-10-08/surat-acceptance.json) and [overlap diagnosis](research/india-africa-batch3-2026-10-08/surat-overlap-diagnostic.json).

Nairobi streams anonymous public outlines from the commercial Nairobi Maps publisher. Government lineage, source registry numbers, ownership and update dates remain unverified or unavailable. **Missing published IDs are not a display gate.** The source namespace and canonical polygon coordinates produce a versioned SHA-256 application identity; encoding normalizes ring start, orientation, component order and consecutive duplicate vertices at 1e-7-degree precision. It does not union plots or repair boundaries. The identity carries a deterministic spatial locator so a fresh process can re-read the outline and verify its complete hash. A changed boundary creates a new reference rather than inheriting the old identity.

Nine Nairobi cells contained **1,066 distinct outlines**. Every application identity resolved from a fresh source instance with identical canonical geometry; explicit absence, footprints and source binding also passed. All 1,068 rings were closed, a separate Turf check found no self-intersections, and the sampled pairwise check found no positive overlaps above 0.01 m². This supports the sampled local geometry, not citywide cadastral completeness or legal boundary status. The [quality audit](research/india-africa-batch3-2026-10-08/nairobi-quality-audit.json) and [acceptance](research/india-africa-batch3-2026-10-08/nairobi-acceptance.json) retain the provider responses and limits. Its FAQ describes **25 preview areas per day**, not 25 requests; quotas and incomplete responses remain errors.

Headed-browser checks confirmed source attribution, parcel selection and new-cell panning: Surat grew from **9 cells / 231 retained parcels** to **12 / 433**; Nairobi from **25 / 2,184** to **28 / 2,342**. Nairobi's menu and details show the short `G1-…` application reference and its boundary-change explanation, including at 390 px width. The report renders all 171 regional targets and all five Central Asian capitals, with unavailable population matches left blank. Across these additions, **619 distinct headless tests in 25 files passed**; [final verification](research/india-africa-batch3-2026-10-08/final-verification.json) and [browser checks](research/india-africa-batch3-2026-10-08/browser-check.json) preserve the evidence.

The other nine batch targets have documented technical/access or discovery limits: unavailable official mapping routes in Kolkata and Mumbai; no target-city parcel response from Uttar Pradesh's public selectors; official map production or ordering routes in Cairo and Alexandria; an unavailable Sudanese geoportal; an Addis registration/OTP workflow; and incomplete public geoportal links in Kinshasa. None of these outcomes establishes that the city lacks a cadastre. Earlier evidence is retained and no parcel geometry was imported into the database.

## Next ten India and Africa cities — 8 October 2026

The [next-ten batch](research/india-africa-next10-2026-10-08/index.json) investigated five Indian and five African cities and qualified **Ahmedabad** locally. The catalogue now has **111 app entries / 98 executable providers**; **14 of the 171 regional cohort cities** have configured entries. These changes remain uncommitted and undeployed.

Ahmedabad uses Gujarat TPVD's published **final AMC town-planning plots**, with partial coverage and no claim of current title or ownership. The publisher's `search` reference combines village, scheme and final-plot labels; `gid` and WFS feature IDs are transport fields. Nine aligned 0.005-degree cells yielded **132 native references**, all reread with matching geometry. Explicit absence, footprint reads, complete source binding and the sampled overlap check passed. Six simultaneous cold cells completed in 1.86 seconds; this is a completion check, not a performance benchmark.

The WFS adapter now combines fixed attributes and spatial bounds in one CQL filter and rejects any returned record outside the configured scope. The provider misreports the total on its last partial offset page; that failed probe is retained. Its descriptor requests up to 1,000 records and rejects larger reported totals, preserving strict completeness checks. A source-scoped trusted certificate intermediate completes the server's omitted chain; TLS verification remains enabled.

Headed-browser inspection loaded nine cells with 132 retained features, selected `Sarangpur 18 10`, and panned to twelve complete cells with 221 retained features. All twelve gateway requests returned HTTP 200, with no source warning or uncaught page error. **214 headless tests in 13 files passed.** The [browser evidence](research/india-africa-next10-2026-10-08/browser-check.json) and [native acceptance](research/india-africa-next10-2026-10-08/ahmedabad-acceptance.json) record the separate checks.

| Other targets | Result |
| --- | --- |
| Ghatkesar | Official Annojiguda survey geometry: 37 nonblank survey numbers across nine cells. Held because fresh exact native-ID reads timed out and the older provider supports ESRI JSON/AMF only. Three blank-ID road/village boundaries remain an explicit omitted-subset candidate. |
| Nairobi | Initially held for missing published IDs. The geometry-reference follow-up above now enables the anonymous commercial outlines; government source lineage remains unverified. |
| Bengaluru, Chennai, Hyderabad | Bengaluru's mapping routes timed out; Chennai's reachable GIS returned administrative layers; Hyderabad's target response was an aggregate GHMC polygon. No target parcel/native-ID pair was verified. |
| Lagos, Dakar | Lagos returned large duplicate outlines with null lot fields. Dakar's reachable products were topographic or administrative request routes. Neither yielded a verified parcel source. |
| Dar es Salaam, Antananarivo | The Dar candidate lies about 29 km from the saved point; Antananarivo's PLOF candidate has no IDs and returned no target-centre features. Neither establishes target parcel coverage. |

Earlier failed requests and assessments are preserved. No negative outcome implies citywide absence, and no parcel geometry was imported.

## India and Africa follow-up — 8 October 2026

The follow-up qualifies **three more app entries**, bringing the local catalogue to **110 entries / 97 executable providers**. These continuation changes are uncommitted and undeployed. The [follow-up index](research/india-africa-followup-2026-10-08/index.json) distinguishes the earlier released build from this continuation. The report retains all 171 regional cohort cities and adds one separately identified village; no parcel geometry was imported.

| Entry | Source and verified scope |
| --- | --- |
| Mboloko | Council for Geoscience mirror of North West cadastral erven; 588 native `PRCL_KEY` identities. Surveyed/approved records are included; sampled records carry `DATE_STAMP` 2017-10-13. Current registration and citywide completeness are unestablished. |
| Kochi — Thiruvankulam | Published village 070211, in Thrippunithura Municipality; 229 native parcel UUIDs. Historical Kochi urban-agglomeration association, with village coverage stated. |
| Iravipuram (Kollam) | Published village 020301; 162 native parcel UUIDs. A separate local entry: the WUP Kollam point is 54.47 km away and its settlement crosswalk remains unresolved. No WUP population or enabled status is transferred. |

The three enabled entries passed **27 aligned viewport cells and 979 fresh exact native-ID reads**, explicit absence, footprint reads and complete source binding. Additional nine-cell audits passed for Kozhikode (280 IDs) and Thiruvananthapuram (456 IDs), but both failed expanded browser checks twice and remain research-only. The existing Venjaramoodu provider also passed its default 0.005-degree cell, fresh ID and binding regression. Kerala descriptors now select explicit published villages; the adapter limits fresh exact lookups to 16 concurrent requests, shared across calls. A failed lookup rejects the entire query and stops queued work. Concurrent session expiry cannot discard a newer session. Deadlines and response limits are unchanged.

Observed cold 80-ID batches for the enabled Kerala villages completed within 12.153 seconds. Host load is recorded; these are completion checks, not an isolated performance benchmark. Iravipuram's initial pan failed during a source cooldown; a fresh load and pan passed. Kozhikode's expanded loads retained 15 then 23 of 25 cells; Thiruvananthapuram retained 27 of 30 after panning, then only 12 of 25 on a fresh load. The saved metadata does not establish the relative contributions of upstream delays and request queueing. An earlier Mboloko profile exceeded 15 seconds before fresh complete checks passed. All failures remain in evidence. Empty, incomplete or failed queries remain errors.

Final verification passed **252 headless tests in 18 files**. Headed-browser inspection confirmed rendered parcel selection, source attribution and new-cell panning for all three enabled entries. The [browser record](research/india-africa-followup-2026-10-08/browser-check.json) preserves the accepted checks and held candidates separately.

Mansa now has verified public geometry, but the wider app grid exposed two disjoint lots with the same `MAN/350` identifier and different survey references. It remains held. New Delhi's 224 repeated `propertyid` groups are all disjoint with matching references, refining the earlier conflicting-geometry assessment; production connectivity and publisher-facing identity remain unresolved. Bihar has three fresh selector/point checks without verified parcel geometry, with 20 conditional targets explicitly unqueried. Abidjan's observed API returns 502. One shared Angola layer's extent excludes eight target centers; these are extent checks, not eight new geometry queries.

## India and Africa candidate integration — 8 October 2026

The first released integration added four app cities, reaching **107 city entries / 94 executable providers** at that stage. The [integration index](research/india-africa-integration-2026-10-08/index.json) records all seven candidates, including failed requests and alternate sources. No parcel geometry was imported.

| City | Outcome and scope |
| --- | --- |
| Johannesburg | Official municipal registered stands; complete disjoint `SG_ID` groups. Western WUP entry area verified; update year unestablished. |
| Cosmo City | Same municipal source; complete native groups around the WUP center. |
| Ennerdale | Municipal source passed. The GISCOE mirror remains held because repeated native IDs have overlapping boundaries. |
| Accra | Partial Accra Metro property app on Berry ICT's host. Complete publisher `parcelid` footprint groups, not claimed statutory cadastral identity; official authority unconfirmed. |
| Mboloko | The first-pass GISCOE route remains held for slow/incomplete native-ID reads. The later CGS source is qualified separately in the follow-up above. |
| New Delhi | Initially held for repeated-ID geometry. The later component audit above establishes disjoint parts; connectivity and publisher-facing identity remain unresolved. |
| Pune | Current official map routes time out or redirect-loop; historical WKT samples do not establish current runtime access. |

Acceptance covered **45 viewport cells and 2,064 exact native identities**, with forced small-page reads for the ArcGIS cities, explicit absence, footprint queries and complete proposal binding. Johannesburg's request profile also passed six simultaneous app-sized cells within the unchanged 15-second browser deadline. Earlier smaller-page timeouts are retained.

Accra's ordinary public POST selects only PID and parcel code. Two independent complete reads returned 12,586 rows representing 12,582 native PID groups in 3.58 MB. All four repeated PID groups have disjoint geometry and matching codes. The snapshot adapter now supports fixed form POSTs and uses the same checked component assembly as ArcGIS, before building its spatial index. Overlaps and inconsistent references fail the whole load. Runtime caps are 8 MiB and 20,000 rows; the existing five-minute memory cache and deadlines are unchanged. Its displayed entry lies within the partial dataset; the WUP center is outside the observed extent. Source terms remain informational.

Verification passed **259 headless tests in 17 files** and headed-browser parcel selection and panning in all four new cities. The [browser record](research/india-africa-integration-2026-10-08/browser-check.json) includes loaded-cell and retained-parcel counts; the regional report shows all 171 target cities and the current enabled source links.

## Same-country expansion: 101 configured cities

The October 7, 2026 pass compared the original 200-city research cohort with the 29 countries
already represented in the app. It found 50 unconfigured same-country candidates, investigated
nine, and enabled four. The app now has **101 configured cities and 91 executable providers**;
38 cities from the original cohort are configured. The other 46 same-country candidates remain
in the saved inventory; this pass did not repeat every one of their searches.

| City | Provider and native identity | Scope |
| --- | --- | --- |
| Houston | Harris County HCAD, `HCAD_NUM` account number | Identified Harris County parcels; Houston's other counties excluded |
| Curitiba | IPPUC municipal cadastral lots, `gtm_ind_fiscal` | Lots with nonblank fiscal identifiers |
| Recife | Municipal lot layer, `DSQFL` district/sector/block/face/lot code | Complete components of identified Recife lots |
| Durban | eThekwini municipal parcel layer, `GlobalID`; displayed number `PROPERTYID` | Central Durban verified; municipal source, not national coverage |

All four reuse the ArcGIS adapter. Houston and Recife now fetch every component for each native
key before publishing a parcel; matching administrative references and the disjoint-parts check
reject ambiguous groups. Identical duplicate rows remain harmless. Curitiba uses explicit record-ID
manifests to avoid the provider's broken offset paging, excluding null, empty and single-space
fiscal placeholders. Record IDs remain transport tokens, never cadastral identity.

Durban's server omits its Sectigo intermediate certificate. The source-scoped HTTPS transport
adds the published Sectigo Public Server Authentication CA DV R36 intermediate to the ordinary
trusted roots, with hostname and certificate verification enabled. The bundled intermediate
expires March 21, 2036. Geometry pages contain at most 25 records. Initial transient timeouts
are recorded; the final complete acceptance run required no retries.

Acceptance covered 72 viewport cells and **5,383 native parcel IDs**, all reread with unchanged
geometry, plus independent provider counts, forced small pages, footprint reads and complete
source binding. No parcel geometry was imported into the database. Chicago, Rio de Janeiro,
Medellín, Cali and Johannesburg retain documented technical holds and fresh follow-up leads.

The [batch index](research/same-country-expansion-2026-10-07/index.json) links the complete
candidate inventory, native-language searches, failed attempts, source scope and acceptance
evidence. Earlier research files and their historical assessments remain intact.

Executable providers are declared in `backend/parcels/source-catalog.json`, packaged with the
backend. The first provider is Toronto's municipal Property Boundary layer; it reads the
City's ArcGIS service directly and does not import parcel rows into our database. Bogotá also
streams through this gateway, using the explicitly selected December 2021 CAR mirror of
IDECA/UAECD lots.

## Integration policy

Terms, licences and reuse restrictions never block integration. They are retained as source
information for users, who choose the data they use. Source attribution and terms links remain
visible, and the source-details notice explains the provider and conditions without requiring
acceptance before loading parcels. This policy applies to every city and country.

Runtime eligibility depends on geometry, reproducible source-scoped identity and complete bounded/ID reads.
Prefer published native identifiers. Where a high-quality outline source omits them, explicitly
labelled application references may use a versioned canonical-geometry hash. The source namespace
and canonicalization version are part of the hash; ring start, orientation and component order
must not change it. An actual boundary change creates a new reference. Such references identify
geometry versions, not official registry records, ownership or continuing legal parcels.
Authentication requirements, broken requests and ambiguous parcel identity remain technical
blockers. Existing failed attempts and earlier licence-based assessments are historical evidence;
the registry's current `liveIntegration` state follows this technical-only policy. Older batch
notes below describe the decisions at the time; their licence-based holds are superseded.

Live adapters proxy upstream requests without importing new parcel tables. The browser retains
immutable ground in memory for the session. Existing imported providers and proposal provenance
are separate from this live-source policy; the notice does not promise that all app data is transient.

## Runtime contract

City configuration selects a source ID. `GET /parcel-sources` lists executable descriptors.
The gateway exposes three provider-independent reads:

| Read | Request |
| --- | --- |
| Viewport cell | `GET /parcel-sources/:sourceId?bbox=west,south,east,north` |
| Saved parcel references | `GET /parcel-sources/:sourceId?ids=canonicalId,...` |
| Proposal footprint | `POST /parcel-sources/:sourceId/under` with `{ "geometry": GeoJSON, "srid": 4326 }` |

Adapters return complete WGS84 Polygon/MultiPolygon FeatureCollections with stable canonical
`properties.parcelId` and `sourceId`. `sourceParcelId` is the native published key, or explicitly
null for geometry-derived references. Those references additionally expose `parcelIdentityKind`,
`sourceGeometryHash` and a short `geometryDisplayId`, while leaving `parcelNumber` null. Provider fields live under
`sourceProperties`; app consumers do not depend on their names. ID responses explicitly list
`absentIds`. Pagination is completed before a cell is published, including a further read when
a full GeoJSON page omits ArcGIS's transfer-limit flag. Limits, timeout, malformed
geometry, repeated pages and upstream errors fail the request; failures never become missing
parcels or loaded cells.

The existing cadastral repository deduplicates in-flight cell reads, retains immutable parcels
for the session and progressively integrates successful cells into the live fabric. Its callers
keep using bounds, IDs and footprints. New ArcGIS and WFS cities need descriptors and city configuration;
OGC API Features and provider-specific proxy protocols can add adapters behind this gateway.
Existing imported providers remain supported at the transport boundary.

Server proposal binding uses the same executable provider, fetches authoritative parcels and
applies the shared site-binding rule. It does not trust browser-supplied source geometry or
silently fall back to a different country's database. Geometry-less parcel acts resolve IDs
against the provider too. The provider's metric CRS is used for footprint construction and
containment checks.

## Identity and source changes

Keep canonical IDs stable when changing an endpoint or adapter for the same authoritative
dataset. Toronto uses `CA-ON-TORONTO-<PARCELID>`, never ArcGIS `OBJECTID`, whose role is only
ordering pagination. A different authoritative dataset needs an explicit identity mapping or
rebinding; changing the provider must not silently transfer saved consent to unrelated land.
Conflicting geometry for an already-retained ID is a source conflict, so a session cannot
quietly move the ground under applied proposals.

Proposal result geometry contains no retained derived parcel lists. The root
`cadastreParcelIds` remains the authored selection for provenance and consent; proposal output
geometry and live fabric are separate from that declaration.

## Toronto verification and scope

The live service was checked on 2026-10-02. A downtown sample returned four parcels, each
resolved again by its canonical ID. The browser initially loaded 81 parcels; a pan into a
second cell retained 212, and a revisit used the repository cache. An actual streamed parcel
received a complete server binding from `server:ca-on-toronto-property-boundary`.

The globe uses a conservative 15 km entry radius around downtown. This is an entry area,
not a claim that the sample proves all municipal coverage. Surrounding municipalities require
their own providers. Ownership and building data are not supplied by this parcel layer.
Source attribution and a licence link are shown on the map. Original evidence and its
uncertainties remain in `research/toronto.json`; the City's service and Open Data pages are
linked by the executable descriptor.

## Bogotá verification and scope

The current UAECD endpoint timed out from both the laptop and development server on 2026-10-02.
The user selected CAR's reachable mirror, whose layer explicitly identifies IDECA version
12.21 (December 2021). The globe popup and map attribution display this date. There is no
automatic failover between datasets. The current official catalogue also offers an August 2026
snapshot, recorded as a candidate for later investigation.

Bogotá's `LotCodigo` is a 12-character string. Canonical IDs keep all leading zeroes:
`CO-BOGOTA-006106001009`. Provider field case, string SQL literals and projection from the
mirror's native EPSG:9377 to WGS84 stay inside the adapter. Proposal city membership reads
the source prefix from city config, so each new live city needs no proposal-storage branch.

The mirror sends an incomplete/mismatched TLS chain. Its provider-scoped HTTPS transport
adds the GeoTrust intermediate from DigiCert to the normal roots; hostname and certificate
verification remain enabled. The bundled intermediate expires in July 2030; replacing the
provider endpoint or its certificate configuration is a catalogue/transport change.

A bounded live sample returned three lots with complete pagination and resolved all three
again by exact ID. The headed browser loaded 1,159 lots, retained 2,568 after panning and
reused cached cells on return. An uncached footprint read and server binding of an actual
streamed lot completed successfully. Evidence, certificate provenance, source scope and the
bounded raw response are saved in `research/bogota-live-2021-mirror.json` and
`research/bogota-car-2021-response.json`. No Bogotá parcel table was imported.

The conservative 12 km globe entry area does not establish full district coverage. This source
contains historical lots, which can contain several properties; it supplies no ownership or
building data. Neighbouring municipalities such as Soacha need their own sources.

## Los Angeles, Miami-Dade and Washington, D.C.

These three providers use the same ArcGIS gateway and viewport-cell streaming, with no parcel
imports. Their native projections, string queries and pagination stay inside the adapter; city
config selects the provider and local metric CRS. Each map links its authority and data terms.

Los Angeles uses the County Assessor's 10-character `AIN`. Its county GIS terms permit copying,
distributing, adapting and commercial/personal use, and give a recommended citation. A bounded
query paged ten parcels and resolved all ten by ID. The headed browser loaded 627 parcels,
retained 1,141 after panning, reused cells on return, and obtained a complete server binding.
County scope excludes adjacent counties; this does not establish separate condominium title
boundaries or a legal survey. Evidence is in `research/los-angeles-live.json` and its response file.

Miami-Dade uses the original County Property Appraiser service. Its 13-character `FOLIO` is a
**display number, not a row identifier**: the downtown sample contained spatially separate
polygons sharing one folio, and a full-layer query found 5,124 blank folios. Canonical IDs preserve
the exact brace-wrapped `GLOBALID`. All 596,304 queried rows had non-null GlobalIDs and a grouped
query returned no duplicate GlobalIDs; this is observed evidence, not an enforced constraint.
A bounded adapter query returned 68 polygons and resolved three by exact ID. The browser loaded
258 parcels, retained 322 after panning, reused cells on return, and obtained a complete binding.
The official public item supplies an accuracy/reliance disclaimer; no named open-data licence is
claimed. Broward and Palm Beach counties require separate sources. Details and the canonical
sample are in `research/miami-live.json` and `research/miami-live-response.json`.

Washington uses DCGIS **tax lots**, which are assessment polygons rather than surveyed/record
lots. `SSL` preserves its internal spaces for display but is not unique: `1223    0815` labels two
different polygons. Canonical IDs use `GLOBALID`; total and distinct counts both returned 30,867.
The layer's published licence is CC BY 4.0. Seven polygons completed the bounded viewport query;
three resolved by exact ID. The browser loaded 188 parcels, retained 369 after panning, reused
cells on return, and obtained a complete binding. The conservative central entry radius is 2 km;
Virginia and Maryland require separate sources. Evidence is in `research/washington-dc-live.json`
and its response file.

The adapter's optional `parcelNumberField` separates display labels from durable parcel identity.
Duplicate labels therefore retain every polygon; conflicting geometry under one stable ID still
fails closed. Headless tests exercise this distinction, GUID punctuation through the HTTP gateway,
paging, source-specific binding, saved-proposal membership and globe/deep-link routing.

Chicago remains research-only. The saved Clerk extract is dated 2021; newer official service
candidates timed out during this check and their identities/reuse terms remain unverified.
`research/chicago-live-candidates.json` records the next endpoints to investigate.

## Paris, Melbourne and Cape Town

Paris uses IGN/DGFiP Parcellaire Express PCI through the official Géoplateforme WFS 2.0
endpoint. The adapter fixes longitude/latitude order with `CRS:84`, sorts by `idu`, and requires
consistent numeric match/return counts before publishing a complete cell. It reconstructs pages
at the fixed endpoint rather than following supplied links. Exact IDs use CQL; the API Carto
candidate ignored an `idu` parameter and was not selected. Canonical IDs are
`FR-PCI-<idu>`; four-character parcel numbers remain display labels. Eight parcels paged in three
requests and all eight resolved again. A second bounded Lyon check returned and resolved 61
parcels, but only Paris is configured as a globe entry. The source covers vectorised French
cadastre, with possible gaps and alignment limitations. Map attribution links IGN/DGFiP,
source updates and Licence Ouverte 2.0. The browser loaded 393 parcels, retained 720 after a pan,
reused cells on return, and obtained complete footprint and server-binding results. Evidence is
saved in `research/paris-live-wfs.json` and `research/paris-live-response.json`.

Melbourne selects **Vicmap Parcel**, rather than the previously researched Vicmap Property
polygons. Native string `parcel_pfi` is the identity and `parcel_spi` is the display label,
including its backslash separators. A statewide snapshot counted 4,306,490 rows and the same
number of distinct non-null PFIs; another GUID-like field, `parcel_id`, was not unique. The
source item explicitly supplies CC BY 4.0. Both `parcel_status` and `parv_status` must be `A`
(Approved); `P` (Proposed) is excluded, including from exact-ID reads. Returned records are
checked against that filter too. This is the official approval code, not an inferred registration
date: many approved rows have no registration date. Crown and government-road categories are
retained. The ground source also keeps only `parv_z_level` G (unrestricted ground) and S
(ground surface affected by strata). Above/below-ground A*/B* strata overlap surface parcels
in the checked CBD sample and are excluded from this 2D ground source. Two forced three-row-page checks timed out; normal service pages, exact lookup,
footprint and binding succeeded. The final CBD surface-level query returned 2,337 approved parcels over two normal pages,
and three resolved again by ID. The final browser check loaded 10,658 parcels and retained
19,454 after a pan, with cached reads on return and complete authoritative binding.
Evidence is in `research/melbourne-live.json`; its response file explicitly
contains three examples rather than pretending to be a complete viewport.

Cape Town's `SG26_CODE` is a 26-character cadastral identity and `PRTY_NMBR` is a display label.
The service repeats parcels across address records: one tested 66-row group has identical
geometry and becomes one canonical parcel. Distinct geometry under the same ID fails closed.
ArcGIS transfer-limit flags can appear under collection `properties`; the adapter now reads
that location as well as the top level. Ten parcels completed four forced pages and all ten
resolved again. Two broader queries returned 1,368 and 2,139 canonical parcels without identity
conflicts. The browser loaded 703 parcels, retained 1,068 after a pan, reused cells on return,
and received complete footprint and binding results. The official public item links open-data
terms whose target returned 404 during verification; the descriptor records that uncertainty
and claims no named CC licence. Map attribution links the City's dataset metadata. Evidence is
in `research/cape-town-live.json` and `research/cape-town-live-response.json`.

These entries use bounded city radii; France, Australia and South Africa are not marked as
fully live countries. Melbourne and Cape Town use southern-hemisphere metric projections.
No parcel table was imported and no proposal was saved during verification.

Singapore's official weekly cadastral GeoJSON download is a candidate for a refreshed spatially
indexed snapshot adapter; no documented bbox geometry endpoint was verified. Sydney's SIX
service has an automated-retrieval restriction, while another current official service required
a token and listed no licence. Both remain research-only, with current findings saved in
`research/singapore-live-assessment.json` and `research/sydney-live-assessment.json`.

## Amsterdam and the next-source assessments

Amsterdam uses the current Kadaster / PDOK **Kadastrale Kaart OGC API Features** collection.
The new adapter translates GeoJSON, CQL2 text and opaque cursor pages into the same canonical
WGS84 contract used downstream. It fixes both bbox and output to CRS84 and rebuilds every request
at the configured collection. A next link must retain the collection, origin and every query
parameter; only its cursor is accepted. PDOK omits `numberMatched`, so completion follows the
validated terminal page, with unique upstream feature IDs and a bounded feature limit. A supplied
match count must still be numeric and consistent. Truncated, repeated or conflicting responses
remain failures rather than empty/complete cells.

Canonical identity is `NL-BRK-<identificatie_lokaal_id>`, qualified by the returned
`NL.IMKAD.KadastraalObject` namespace. Numeric `perceelnummer` is only the display label. Only
current valid (`G`) records are ground. Three parcels completed two forced cursor pages and all
three resolved through two exact-ID pages. The national dataset is updated daily and is licensed
CC BY 4.0; its map boundaries are indicative and not suitable for cadastral survey measurements.
Only a bounded Amsterdam entry is enabled on the globe. No Dutch parcel table was imported.
The browser rendered 1,760 parcels, retained 2,449 after a pan, reused cached cells on return,
and obtained complete footprint and authoritative binding results. The actual globe button
opened Amsterdam with the correct source. Evidence is in `research/amsterdam-live.json` and
`research/amsterdam-live-response.json`.

Cali's official `catastro:cat_bas_terrenos` WFS is technically usable: 118 parcels completed
three forced pages, with all 118 resolving by their 30-digit NPN. Its exact geometry reuse terms
remain unresolved, however: IDESC's published terms prohibit commercial exploitation, while a
related historical CSV's CC BY-SA licence does not establish a licence for the WFS geometries.
It stays research-only. Current evidence and the bounded canonical response are saved in
`research/cali-live-assessment.json` and `research/cali-live-response.json`.

Houston stays research-only because Harris County account keys do not identify unique geometry:
1,550,492 rows include two missing accounts and seven duplicated non-null account groups; four
have different polygons. The active-account flag does not resolve those conflicts and no GlobalID
is supplied. `research/houston-live-assessment.json` records the identity issue without exposing
owner data. Medellín's current and alternate official metadata services returned malformed JSON
or HTTP 500; its availability finding is saved in `research/medellin-live-assessment.json`.

Antwerp uses the official **Flemish GRB ADP OGC API** alternative. Its normal 1,000-row pages
completed 2,769 distinct parcels over three requests. The adapter validates that each `startIndex`
link advances by exactly the rows returned and preserves the collection and original query.
GeoServer reports `totalFeatures: unknown` and may omit links on a short terminal page; the adapter
accepts that documented terminal shape but rejects full uncounted pages without continuation.
Repeated feature IDs, changed query parameters and conflicting entity geometry fail closed.
Forced 20/30-row pages and sorted WFS requests timed out; those paths are not used at runtime.

Canonical IDs use `BE-GRB-ADP-<OIDN>`: the official GRB specification defines OIDN as the permanent
object identity. `UIDN` changes with the object's recorded version; `CAPAKEY` is retained separately
as its cadastral association and display label. ADP is a graphic cadastral depiction adjusted to
terrain, rather than a legal survey boundary. The Flemish Model Licence for Free Reuse allows
commercial/noncommercial reuse with the required Digitaal Vlaanderen attribution, linked on the map.
The bounded Antwerp globe entry does not enable Brussels, Wallonia or the whole country.
The browser rendered 1,592 parcels, retained 2,228 after a pan, reused cached cells on return,
and obtained complete footprint and authoritative binding results. Current source/version,
protocol and licence evidence are in `research/antwerp-live.json` and its response file.

## Source attempt history, Essen and San Francisco

`registry.json` retains research verification separately from runtime eligibility. Each source assessed for live
integration has `integrationAttempts`: verification date, exact endpoint, operation, outcome,
HTTP status where available, reason and a checked-in evidence file. `liveIntegration` records
its current enabled, held or superseded state. Failed paths remain alongside successful ones;
a timeout is neither an empty parcel response nor proof that no data exists.

Essen uses Geobasis NRW's current simplified ALKIS OGC API, replacing the old WFS adapter
candidate that offered no GeoJSON. The collection reports data through 2026-08-31; individual
`aktualit` values describe feature versions. `flstkennz` is the documented named ID serialized
as GeoJSON feature.id; all 20 characters, including underscore placeholders, remain intact.
Counted offset pages and exact native-ID lookups are verified. Unsupported sort parameters
returned HTTP 400 and are omitted. DL-DE Zero 2.0 permits reuse. Only bounded Essen is enabled,
not all Germany. Its browser rendered 714 parcels and retained 950 after a pan.

San Francisco uses a new fixed Socrata adapter for DataSF's Parcels – Active and Retired.
Only active Public Works recorded-map rows are ground. `blklot` uniquely identifies assessment
rows; the documented `mapblklot` groups condominium records sharing a 2D footprint. Every row's
geometry is checked before coincident rows collapse; conflicting geometry fails the whole read.
Selecting only `blklot=mapblklot` would omit one valid ground group and was rejected.
Intersection predicates include boundary-crossing parcels. Ordered row paging is bracketed by
matching counts and publication revisions; a changed source remains retryable, never complete.
The bounded sample produced 48 canonical groups and all resolved by native ID. The PDDL 1.0
source needs no parcel import. The browser rendered 685 parcels and retained 802 after a pan.
Both cities reused cached cells on return, produced complete footprint and binding results,
and opened through their actual globe buttons without uncaught browser errors.

Montréal remains held: a bounded lot and exact lookup succeeded, but forced page continuation
timed out and geometry reuse rights remain unresolved. The source-linked history and evidence
record each of these outcomes rather than disabling it without an explanation.

## Three continuation batches

The per-source outcomes for the original pair and three further batches are linked in
`research/source-batches-2026-10-03.json`. Research availability is kept separate from eligibility
to stream complete, reusable ground. All failed paths remain dated in `registry.json`.

Berlin's earlier connection/identity hold is resolved: default TLS now succeeds and the current
WFS returns the documented native `fsko` cadastral key, with `uuid` as the separate object ID.
Seventeen parcels completed six forced bbox pages and six exact-ID pages. DL-DE Zero 2.0
permits reuse. The browser rendered 154 parcels, retained 343 after a pan, reused cached cells,
and verified complete footprint/binding and the actual globe button. The enabled entry covers
Berlin, not surrounding Brandenburg. Evidence is in `research/berlin-live.json`.

Curitiba remains held. Current fiscal keys are unique where non-null, but two forced paging
strategies repeated provider rows; the adapter refused to mark either read complete. The exact
GIS layer's reuse rights remain unresolved. Rio's CC BY 4.0 licence is clear, but its physical
lot map is derived from the 2013 flight and last edited in 2022. The display lot code repeats;
the only unique field is an explicitly system-maintained OID with no durable parcel identity
contract. A forced 50-row polygon page also timed out. Neither source was enabled.

Hong Kong's documented bbox wrapper returns GML and rejects percent-encoded commas. Its response
references a public WFS 1.1 endpoint that supports GeoJSON in CRS84 and exact numeric `lotid`
queries. Six private lots completed two bbox and two exact-ID pages. The adapter handles this
explicit protocol using stable numeric `totalFeatures`, `maxFeatures` and sorted `startIndex`
pages. Unknown or changed counts, repeated transport IDs and conflicting entity geometry fail.
Every request to this fixed endpoint is serialized and starts at least one second after the
previous request; its upstream timeout starts after that wait. Bbox width and height are bounded
to 750×600 metres as well as a bounded area. The map uses the official Lands Department logo,
Government/CSDI copyright attribution and zoom 19 or closer. This entry includes private lots;
GLA and STT ground use separate collections. Source jurisdiction is preserved in globe metadata
even when a coarse country outline omits Hong Kong. Its browser retained 299 native parcels,
then 696 after a pan, reused cached cells and produced complete footprint/binding results. The
required official logo was visible, and the actual globe button opened the right source with
no uncaught browser errors. Evidence is in `research/hong-kong-live.json`.

Italy's current bounded WFS query returns HTTP 403; CC BY 4.0 is established, but GML retrieval
and completeness remain unverified. Tel Aviv's direct query returned HTTP 571 municipal
maintenance HTML, while source-specific reuse rights remain unresolved. Amman's bounded query
still returns parcel polygons, but reuse rights and durable-key completeness are unresolved.
Sri Lanka's current parcel layer requires a token, and earlier coverage excluded core Colombo.
Cotonou's current minimal WFS query returns native keys, but public consultation and service
access defaults do not establish unrestricted geometry reuse. These sources remain held with
current direct-request evidence; web-reader access failures are distinguished from provider
responses. No parcel database import or proposal write was used for this continuation.

## Shared-source city batch after release 0a084d6b

Lyon, Rotterdam and Cologne reuse the existing IGN/DGFiP, Kadaster/PDOK and Geobasis NRW
providers. Fresh three-row-page checks completed 9, 7 and 45 parcels respectively, with every
native ID resolving again. Each city has a bounded 8 km globe entry, the provider's attribution
and the same native identity namespace as its other cities. No parcel table was imported.
Evidence is in `research/lyon-live.json`, `research/rotterdam-live.json` and
`research/cologne-live.json`, with complete bounded response/ID-round-trip files alongside.

Executable catalogue schema version 2 uses `cityIds` rather than a single `cityId`. One provider
can serve several configured cities; its endpoint, adapter, canonical prefix and metric projection
remain provider facts. City-specific footprints select that provider for authoritative binding.
Configured entry names are not cadastral municipality facts; an unknown cadastral municipality
remains null in the canonical feature.

A shared prefix cannot name a city. Deep links now inspect exact geometry through the cadastral
repository's `locateIds` method, then choose the nearest configured city using that source.
`locateIds` retains immutable facts and complete absence evidence in the requested city's cache,
without publishing to the active live fabric or seeding a mutation. Normal `ensureIds` subsequently
publishes those facts as usual. Failed, absent, mismatched or timed-out lookups cannot select the
first city by accident. The existing Croatian countrywide routing retains its established behavior.

Four new-country candidates remain held, with attempts and failures attached to their registry
sources. Luanda returns polygons and exact brace-wrapped GlobalIDs, but reuse terms and the
layer's cadastral authority are unresolved; the unbraced query returned an ArcGIS error inside
HTTP 200. Lima has a new official SEDAPAL-hosted candidate, recorded separately from the
third-party copy: geometry and exact lookup work, but reuse terms and GlobalID uniqueness are
unconfirmed, and the unbounded count returned 403. Bamako's NINACAD string lookup works, but
reuse terms remain unconfirmed and only 6 of 74 bounded rows were freshly paged. Santo Domingo
serves historical polygons; unsorted paging repeated the first page at offset 9, while sorting
returned 13 unique rows. Published RI terms restrict reuse/modification, and the transport FID's
continuity is undocumented. These are holds, not claims that parcel data is absent.

The batch manifest is `research/shared-city-batch-2026-10-03.json`. Registry histories now preserve
92 dated attempts across 38 sources. The prior checkpoint is deployed; this continuation is local
until the next requested release.


## Technical-only reassessment — 2026-10-03

Bamako, Lima and Luanda now have executable live providers. Bamako uses SPRDF/NINACAD
`ninacad` keys (74 complete bounded rows and all 74 exact reads). Cali initially passed the
118-row sample, but the full viewport grid exposed two NPNs with distinct geometries. Exact
queries reproduce both conflicts and `id_predio` repeats too. Cali remains held for ambiguous
native identity, with all successful and failed checks saved; its terms never block integration.

Lima uses the SEDAPAL-hosted mapped-lot layer and its brace-wrapped `GLOBALID` keys. All 80
sample polygons resolved again by exact ID. This utility layer is not established as the legal
property cadastre. Luanda uses the GGPEN-published `Luanda_AGT_Oficial_2_gdb` property polygons;
its legal-register authority is likewise unverified and recorded as a scope notice.

Luanda's ordinary spatial geometry query still timed out at the existing 15-second deadline.
The ArcGIS adapter now supports a configured ID-first bounds path: count the bounded records,
check the complete object-ID list against that count, and fetch exact object-ID batches without
a spatial predicate or offset sorting. All 16 sample polygons and stable native GUID rereads
matched. Object IDs are paging tokens; canonical IDs retain `GlobalID_1`. Its SQL queries wrap
GUID literals in braces without changing the canonical bare GUID. Missing, extra, repeated,
truncated or conflicting records fail the read rather than publish incomplete ground.

Settings → Information → Parcel source information opens a manual source notice. It shows
publisher, scope, actual conditions and a source link, including unavailable metadata honestly.
It has no acceptance gate and is independent of streaming and proposal binding. Evidence files
for this reassessment contain metadata and request results, not parcel polygon collections.

Long ArcGIS queries use form-encoded POST rather than GET to avoid intermediary URL-length
limits. Luanda's two failed long GET batches and an 80-GUID lookup all succeeded as POST.
The final browser check rendered its parcels, retained 2,012 after panning, reused cached cells
on return and obtained complete footprint, binding and 80-ID reads. Lima retained 2,037 after
panning and passed the same footprint/binding flow. Choosing Lima on the global map selected
the provider and streamed parcels without opening the notice. Bamako rendered 181 parcels;
its panned area returned complete reads with no additional mapped parcels.

## Five-city batch — 2026-10-03

Sydney, São Paulo, Birmingham, Lusaka and Osaka bring the original positive-probe cohort
from 17 to 22 integrated cities, with 39 of its 61 cities remaining. The app now has 33
configured city entries across 21 countries and territories. The cohort accounting and
source-linked success/failure files are saved in `research/next-five-live-batch-2026-10-03.json`.
Integration counts do not imply complete municipal or national cadastral coverage.

Sydney proxies NSW Spatial Services lot polygons using native `cadid`; display `lotidstring`
and transport `objectid` remain separate. São Paulo uses the official GeoSampa WFS
`geoportal:lote_cidadao` and native `cd_identificador`, preserving the former capped bulk
candidate as research history. Both passed complete initial/panned viewport checks and all
observed exact-ID round trips, including the configured 500-row page size.

Birmingham uses the dated October 22, 2021 Geodom mirror of HMLR title-index polygons.
The fixed source scope excludes the explicit “No LR Title Detected” placeholder and SQL
NULLs; an upstream response that ignores the exclusion is rejected locally. All 898 observed
registered-title IDs resolved. This partial title-index extract is not full physical-parcel
coverage; the original unfiltered failures remain recorded.

Lusaka uses an unofficial ArcGIS Online Mtendere East sample containing only 28 polygons.
All 28 native GlobalIDs resolved, and its mapped cluster passed the viewport grid. The default
view shows that cluster; the 12 km globe entry routes city selection and does not promise data
throughout that area. Publisher, authority and source conditions remain explicitly unverified.

Osaka uses the published 2026 public-coordinate sheets for Chuo ward, with a reversible native
identity composed from municipality code, map name and sheet-local ID. The snapshot adapter
reads the fixed HTTPS file into a five-minute memory index and returns bounded viewport,
exact-ID and footprint responses through the existing gateway. Its ETag and 2,487-feature
count are pinned; changed revisions, truncation, projected coordinates, repeated native keys
and invalid geometry fail closed. Every one of the 2,487 IDs resolved, with no geometry
conflicts. There is no new parcel-table import or on-disk polygon copy.

All five passed headed app checks for viewport loading, pan/return caching, exact identity,
footprint reads and authoritative proposal binding. Failed probes for Indonesian cities,
Amman, Japan's older query service, Recife, South Africa, Guayaquil and Kuala Lumpur are
retained as metadata-only source-linked attempts. Earlier reuse-related holds are historical;
current integration policy uses technical blockers and informational source notices.

## Tokyo and Nagoya — 2026-10-03 continuation

Tokyo Chiyoda (236 polygons) and Nagoya Chikusa (284) join the existing Osaka Chuo package
through one `jp-moj-geospatial-2026` provider. Existing Osaka IDs remain unchanged: all three
use published municipality code, map-sheet name and sheet ID in `JP-MOJ-2026-`. Verified
resource extents select bounds queries; the municipality component selects exact-ID resources.
Each resource has its own ETag/count pin, namespace check and full polygon-extent validation.
Selected-resource failures abort the query; unavailable unrelated resources are not fetched.
Unknown municipality IDs are absent from these explicitly limited packages, not proof of
countrywide cadastral absence. Cache entries stay in memory for five minutes. Tokyo binding
uses EPSG:32654; Osaka and Nagoya use EPSG:32653 without splitting provider identity.

The actual combined adapter passed 54 viewport/pan cells and all 3,007 exact native-ID reads
with no geometry conflicts. Nagoya Naka, Higashi and Nakamura packages repeated the three-part
native key; these failed attempts remain recorded rather than inventing replacement keys.
CC BY catalogue metadata and conversion warnings remain source information: only public-coordinate
sheets are converted and some source geometries may be misplaced. Coverage is partial for
these named wards and is not complete for Tokyo, Nagoya, Osaka or Japan. This continuation
stays local until the next requested release. Evidence: `research/japan-2026-live.json`, the
per-city metadata files and `research/nagoya-2026-source-attempts.json`.

## Cotonou — 2026-10-03 continuation

The ANDF e-Foncier provider streams Cotonou samples using the published `nup` string
identifier in `BJ-ANDF-`; local parcel labels remain separate. Forced 25-row viewport
paging and a 0.004-degree pan passed all 18 cells; all 2,374 native IDs resolved exactly
without geometry conflicts. A genuine exact parcel footprint returned seven complete
intersecting records. The service is official but this verification does not establish
complete Cotonou or national Benin coverage. ANDF consultation/duplication conditions
and personal/confidential-information exceptions are informational source notices;
GeoServer Fees NONE / AccessConstraints NONE are defaults, not a reuse licence.
Evidence: `research/cotonou-live.json`; earlier holds remain unchanged in their dated
research and attempt history. New Delhi duplicate native keys and Fortaleza DNS failures
are separately appended from `research/batch-six-root-source-attempts.json`.


## Dortmund — 2026-10-03 continuation

Dortmund reuses the existing Geobasis NRW ALKIS OGC API source. The published
`flstkennz` GeoJSON feature ID remains the stable NRW-wide identity in `DE-NRW-`;
parcel labels and row/version fields do not replace it. A 3×3 grid and a 0.004° pan
at 0.0025° cell width completed 18/18 cells. All 1,105 observed IDs passed 14
exact-read batches of up to 80, with no absent IDs, conflicting geometries or
cross-cell conflicts. The `/under` route returned 18 complete features. All 33
provider requests returned HTTP 200; none timed out (maximum 514 ms).

This verifies the tested Dortmund entry area within the NRW regional source; it does
not establish complete NRW or Germany coverage. Dortmund was a user-authorized follow-on outside the original 61-city candidate
cohort. Four cities integrated from that cohort bring it to 26/61, leaving 35;
Dortmund is additional. After this addition, the app has 38 configured cities,
24 parcel sources, 30 source-city memberships and 22 countries. These totals describe
the current app, not progress against the original cohort. Evidence:
`research/dortmund-live-2026-10-03.json`.

## Five-city continuation accounting — 2026-10-03

This batch adds Tokyo, Nagoya, Montreal, Cotonou and Dortmund. Four belong to the
original 61 positive city probes: 26 are now integrated and 35 remain. Dortmund
is an additional verified city through the existing NRW regional provider. The app
has 38 configured city entries across 22 countries and territories, backed by 24
executable providers and 30 provider-city memberships; eight entries use older adapters.
See `research/batch-six-live-cities-2026-10-03.json` for the explicit cohort mapping.

All five passed complete viewport and exact-native-ID checks plus manual headed-browser
rendering, pan/cache, footprint lookup and proposal binding. The broad headless run
passed 1,632 checks with four database-dependent checks skipped; its stale Tokyo
source-only expectation was corrected and the focused 31-check suite passed. The
final post-Dortmund subset passed 199 checks across 13 files. Sources and their
successes/failures are recorded; no parcel database imports were made.

Cook County/Chicago remains held after seven PIN10 groups identified different baseparcel
polygons; documented baseparcel filtering does not resolve those conflicts. Recife's
alternate SEQIMOVEL field has missing or conflicting values in 13 of 18 cells.
New Delhi's full snapshot repeats native IDs across distinct polygons. Fortaleza's
hosts failed DNS resolution from the authorized network route; Singapore still lacks
a verified bounded vector/exact-key service. These are technical holds with source
conditions kept informational, and prior attempts remain in the registry history.

## Native-language retry and five-city batch (2026-10-04)

The original 200-city cohort had 60 verified candidates. The previously quoted 61
also included the extra Zagreb record. Shenzhen subsequently brought the original
cohort to 61; this batch verifies Barcelona. The count audit also repairs Berlin’s stale city record
using its already-saved live verification. There are now 63 verified original-cohort
cities: 32 are configured in the app and 31 remain to integrate. The app now has 44 city
entries and 34 executable provider descriptors overall. These totals distinguish
original-cohort cities from additional cities and multiple cities sharing a provider.

All 139 original-cohort cities unresolved at the start of this batch received an
executed native-language search. Exact query, language/script, source links and
assessment are saved per city under `research/native-language-2026-10-04/`, indexed
by `index.json`. Historical evidence did not preserve query languages, so a consistent
native-language pass cannot be claimed for those earlier searches. New leads such as
Mexico City, Quito, Maputo, Belo Horizonte, Kyiv and several Asian cadastral viewers
remain discovery evidence until actual vectors, native identity and completeness pass.

| City | Executable source | Verified scope |
| --- | --- | --- |
| London | `gb-hmlr-city-of-london` / `gml-snapshot` | City of London Corporation authority; excludes other London boroughs |
| Manchester | `gb-hmlr-manchester` / `gml-snapshot` | Manchester City Council authority; excludes other Greater Manchester authorities |
| Madrid | `es-dgc-inspire-cp-wfs` / `catastro-wfs` | Bounded official DGC parcel windows |
| Barcelona | Same DGC WFS | Bounded official DGC parcel windows; promoted from an earlier unsuccessful search |
| Savar | `bd-dlrs-dhamsona-bds-sheet-001` / `dlrs-sheet` | Only 108 draft-survey plots in Dhamsona BDS sheet 001 |

HMLR's anonymous official downloads require a publisher-scoped session and allowlisted
S3 redirect. A complete authority ZIP is checked for bounded size and CRC, then parsed
incrementally with namespace-aware Saxes and proj4. The complete native index lives
only in memory for five minutes; a failed refresh drops availability rather than
serving stale geometry as current. Distinct authority prefixes avoid routing a London
or Manchester parcel into Birmingham's broader legacy prefix. OSGB36 transformation
uses an approximately five-metre Helmert approximation, without OSTN15. These are
registered-title index polygons, not definitive legal boundaries. Manchester's archive
contains 120,989 polygons; the combined UK standalone proof peaked at about 712 MiB
with the default heap. Production process headroom must be checked before deployment;
this batch has not been deployed. See the recorded memory experiments in `gb-runtime.json`.

Spain's WFS returns GML, with projected UTM30/31 windows. It ignores startIndex and can
report misleading numberReturned when count truncates a reply, so the adapter omits
count, startIndex and hits, and requires actual members to equal numberMatched. Exact
reads use native 14-character cadastral references. Positive viewport identities are
reused for at most 60 seconds in a bounded memory cache; unknown or expired identities
require GetParcel. Absence is never inferred from an HTTP200 exception report. Parallel
exact probes produced ECONNRESET; sequential probes passed 160 Madrid exact IDs before
the sustained test returned HTTP403. Subsequent laptop requests remained blocked. Both
failures are retained, and existing source-status UI and cooldown handling expose them.
Earlier small direct exact tests passed all five Madrid and eleven Barcelona references.
The reduced-traffic adapter passes gateway and binding fixtures; fresh live acceptance
from this network remains affected by the recorded block.

DLRS serves a small complete sheet through a fixed anonymous POST. Native Dag_No is
scoped by survey, office, mouza and sheet; FID and the repeated Id field are not identity.
The verified 108-member sheet is transiently cached, with count, geometry and uniqueness
checks. A changed member count requires a coverage recheck and fails unavailable.
Other Bangladesh candidates remain held for technical reasons: the Dhaka sheet has a
zero placeholder, and the Chattogram candidate has duplicate plot IDs and lies near
Anwara outside the city proper. This does not claim those cities lack parcel data.

The new GML and DLRS adapters are fixed-publisher adapters. Custom-URL discovery still
supports the generic formats listed in `frontend/parcel-source-formats.html`; arbitrary
GML archives or DLRS POST endpoints are not automatically accepted as custom sources.
All five cities use the same canonical WGS84 viewport, exact-ID and footprint contract,
including proposal binding without querying a parcel table. No ZIP, GML or parcel geometry
is imported into the database or committed as batch evidence. Source conditions remain
informational. Evidence: `research/batch-seven-live-cities-2026-10-04.json` and its linked
publisher records. The full serial headless suite passed 7,290 tests, with six skipped.

## U.S. capital research and five-city batch (2026-10-06)

All 50 state capitals plus Washington, D.C. have fresh, capital-scoped research in
`research/us-capitals-2026-10-06/`, with `index.json` separating data discovery from
runtime readiness. Forty have observed capital-area polygon samples; 38 have initial
native identity proof or full acceptance, while Harrisburg and Olympia still need
identity work. Eleven have documented map/service/download leads without an obtained
capital polygon sample. Timeouts, TLS/DNS failures, denied requests, zero samples,
misprojected samples and unfetched archive leads remain in the per-source attempt history.
A different format is adapter work, never evidence that parcel data does not exist.
Cole County's official `CC_Parcels.zip` remains an alternative download lead for
Jefferson City; its contents have not yet been inspected.

| New city | Publisher/native identity | Retained IDs exact-resolved |
| --- | --- | ---: |
| Montgomery | City GIS / PID; padded ParcelNo is display only | 375 |
| Juneau | City and Borough GIS / complete tax_id geometry groups | 689 |
| Phoenix | Maricopa County Assessor / APN including letter suffixes | 733 |
| Little Rock | Arkansas GIS Office / parcelid restricted to Pulaski County | 420 |
| Sacramento | County active parcel base / full 14-character PARCEL_NUMBER | 837 |

Every source passed 18 grid cells, completeness checks, forced small transport pages,
exact reads of every retained native identity with matching geometry, footprint reads
and authoritative proposal binding. Evidence is metadata and aggregates only in
`research/us-capitals-live-batch-2026-10-06.json`. Initial failures remain linked there:
Montgomery repeated a terminal offset page, Sacramento's shortened APN10 collided,
and Juneau required complete geometry components plus numerical normalization.

The ArcGIS adapter now explicitly supports native-key count/OID manifests for servers
without paging. Source-controlled `nativeGeometryMode: parts` expands every observed
native key to all its components before publishing a canonical union, so viewport and
exact reads agree even when the view touches only one component. This requires complete
OID manifests for both paths; ordinary sources still reject conflicting geometry for
one identity. Juneau normalizes components to nine decimal degrees before union and
excludes UNASSIGNED/blank placeholders. Each group represents the municipal tax_id,
not independently identified legal lots. Invalid or incomplete components fail unavailable.
Juneau has a shared two-query limit across viewport/exact/footprint calls; queued calls
respect the existing provider cooldown. Automatic custom-URL discovery does not infer
this specialized grouping policy from arbitrary duplicate native keys.

A headed-browser check loaded 402 Juneau groups across nine grid cells with no source
warning, opened a parcel action menu, then panned and retained 529 groups across twelve
cells without a warning or page error. Earlier uncapped parallel requests had timed out;
those failures are recorded alongside the successful retry. All five keep the shared
canonical contract, source-health UI and source attribution; buildings default to OSM.
No parcel table import is required, and existing imported cities retain their DB defaults.

Configured U.S. cities now represent eight states (AK, AL, AR, AZ, CA, CO, FL, NY), plus
D.C.; this is not statewide completeness. Seven of 51 capitals are configured, leaving
44 to integrate: 31 have initial native sample proof, two need identity adapter work,
and eleven need further access/format investigation. Overall there are 49 app cities
and 39 executable provider descriptors. The original 200-city cohort is unchanged at
32 configured of 63 verified candidates.

The full serial headless suite passed 7,402 tests with six skipped; its only failure was
the new evidence filenames violating the established lowercase path convention. After
normalizing those filenames, all 78 focused adapter, concurrency, capital-binding,
research-history and generated-coverage tests passed, including the final precision checks.

## Ten more U.S. capitals (2026-10-06)

Hartford, Dover, Atlanta, Honolulu, Boise, Springfield, Baton Rouge, Augusta,
Annapolis and Boston are configured live parcel cities. Each passed 18 initial and
shifted grid cells, forced small-page completeness, exact reads of every retained
native key with matching geometry, footprint reads and complete source binding.
The 180 cell checks exact-resolved 5,997 identities. Metadata, aggregates and retained
failures are linked from `research/us-capitals-batch-two-live-2026-10-06.json`.
No parcel geometry or ownership data was imported into parcel tables or committed as
this batch's research evidence.

| City | Native identity and source scope | Exact-resolved IDs |
| --- | --- | ---: |
| Hartford | Connecticut 2025 Parcel_ID; fixed Hartford filter and complete identified groups | 158 |
| Dover | Delaware FirstMap PIN; fixed Kent County filter | 441 |
| Atlanta | Fulton County ParcelID; letters and internal spaces preserved, DeKalb excluded | 246 |
| Honolulu | Hawaii compilation tmk; fixed Honolulu County filter | 484 |
| Boise | Idaho/Ada County PARCEL_ID; fixed Ada County filter and complete groups | 345 |
| Springfield | City parcel/zoning view; complete 11-digit assessor PIN groups | 999 |
| Baton Rouge | EBRGIS ASSESSMENT_NUM; complete assessor-account footprints | 1,018 |
| Augusta | Maine GeoLibrary MAP_BK_LOT; fixed Augusta town filter | 432 |
| Annapolis | City GIS PIN; publisher describes a development version | 1,010 |
| Boston | Current city FeatureServer LOC_ID groups; FEE polygons only, MAP_PAR_ID display | 864 |

Hartford, Boise, Springfield, Baton Rouge and Boston use the existing explicit
complete-parts policy and shared two-query limit. Every observed native key is expanded
to all matching source components before ground is published. These source-defined groups
do not assert that each component is a separate legal lot. Source notices state group
and coverage restrictions. Hartford's single-space placeholder and Baton Rouge's all-zero
placeholder are excluded; other missing or invalid keys still fail unavailable. Atlanta's
letters and internal double spaces are preserved. Augusta's map/lot strings, including
spaces, remain scoped by municipality.

Boston uses the current official FeatureServer instead of historical Parcels09.
Its corresponding MapServer returned count 33 against 34 unique OIDs for one bounded
query; the FeatureServer returned 34/34 and passed all acceptance checks. Count equality
was retained. LOC_ID is the MassGIS locational polygon identifier; MAP_PAR_ID is the
assessor-map display reference. Water, rights of way and TAX-only polygons are outside
the configured FEE source.

Technical investigations remain source-linked: Tallahassee queries and the advertised
ZIP returned 403 or timed out; Topeka failed ordinary TLS certificate verification;
Frankfort's repeated MAPNUM/PARCEL_ID maps to different parcel labels without a proven
replacement identity or current-ground rule. Lansing's old source was Lansing, Kansas.
The actual Ingham viewer proxy reset and its backing service required a token; a public
2025 Ingham layer is a new metadata lead requiring publisher and capital verification.
Des Moines has a dated 2017 university-mirror parcel sample, with publisher provenance
and full runtime acceptance pending alongside the official Polk County atlas lead.
None of these outcomes establishes absence of data. Source conditions are informational.

Indianapolis and Saint Paul passed additional reserve checks and remain unconfigured
for the next batch. Indianapolis exact-resolved 988 county-supplied local_id feature
identities, with county_id 49 fixed and state_parcel_id display text; its initial conflicting
state_parcel_id attempt is retained. Saint Paul exact-resolved 926 Ramsey County ParcelID
values. Proposed descriptors are saved in their acceptance files.

Totals: 17 of 51 capitals configured (16 state capitals plus D.C.), 34 remaining;
18 represented states plus D.C., 21 U.S. app cities, 59 app cities overall and 49 executable
provider descriptors. These are configured city providers, not statewide completeness.
The original 200-city cohort remains 32 configured of 63 verified candidates.

All 259 focused headless tests passed across 19 files, covering gateway/binding,
multipart expansion from a one-component viewport, routing, source health, projections,
translations, research history and generated coverage. A dedicated headed Boston browser
loaded 452 retained parcels in nine cells, opened an action menu through a pointer click,
then streamed to 844 retained parcels across fifteen cells without source warnings or
page errors. The browser was closed after verification.


## U.S. capitals: third live batch (2026-10-06)

Indianapolis, Des Moines, Lansing, Saint Paul, Jefferson City, Helena, Lincoln,
Concord, Trenton and Santa Fe are configured through live adapters. All ten passed
18 initial/shifted grid cells, forced small-page completeness, exact reads of every
retained native key with matching geometry, footprint reads and complete authoritative
binding: 180 cells and 8,604 exact-resolved identities. Final app namespaces are covered
by gateway, binding and deep-link tests. Metadata, aggregate diagnostics and failed
attempts are linked from `research/us-capitals-batch-three-live-2026-10-06.json` and
source registry history. No parcel geometry or ownership data was imported or saved as
research payloads.

| City | Native identity and configured scope | Exact-resolved IDs |
| --- | --- | ---: |
| Indianapolis | IndianaMap local_id; fixed Marion County county_id 49, state_parcel_id display | 988 |
| Des Moines | Iowa HSEM university mirror, 2017; county-qualified STATEPARID groups | 441 |
| Lansing | Ingham County 2025 PARCELNUM; Eaton/Clinton areas outside this feed | 369 |
| Saint Paul | Ramsey County ParcelID | 926 |
| Jefferson City | Official hosted City/Cole County base map PID | 377 |
| Helena | Montana cadastral PARCELID; unidentified NULL-key rows excluded | 839 |
| Lincoln | City/Lancaster County hosted TaxParcels PARCELID | 799 |
| Concord | NH GRANIT/NHDES nh_gis_id; fixed town and explicit ambiguous-key exclusion | 373 |
| Trenton | NJOGIS composite PAMS_PIN | 2,716 |
| Santa Fe | Santa Fe County parcel_number through City GIS | 776 |

Des Moines explicitly states the mirror's 2017 date. Duplicate rows with the same
STATEPARID also share UNPARCELID and PARCELNUMB; complete source groups are assembled
with the established parts policy, OID manifests on both reads, nine-decimal precision
and a shared two-query limit. This presents assessment parcel groups without claiming
each component is an independently identified legal lot. Lansing's public publisher
was verified as the Ingham County Drain Office, publishing Equalization assessment data.
It uses OID manifests without geometry grouping.

Helena's server includes rows with NULL PARCELID. The shared attribute contract now
supports explicit `attributeNotNull`, validates allowed published fields, applies the
same IS NOT NULL scope to viewport/exact/footprint queries and rejects responses that
ignore that scope. Other invalid identities still fail unavailable. Its app metric
projection is WGS84 UTM zone 12. Concord's observed nonunique key 07046-0 spans five
disjoint rows with null U_ID/DisplayId. Publisher semantics do not establish a single
multipart parcel; the key is excluded from the identified-parcel scope, with the initial
conflict and diagnosis preserved. Arbitrary duplicates are not inferred to be parts.

Tallahassee still returns access-denied HTML, Topeka fails trusted TLS, and Frankfort's
native-key collision remains unresolved. Jackson's CMPDD endpoint fails Node chain
verification (including system CA mode), although plain curl with normal TLS succeeds.
Carson City polygons are available through Nevada's public service, but the same scoped
bbox returns count 5 versus six manifest objects and geometry rows. These technical
failures are saved; none establishes absence of parcel data. TLS verification and
completeness checks stay enforced. Source conditions remain informational.

Albany passed 18 cells and 767 exact native IDs. Its proposed descriptor is saved in
`research/us-capitals-batch-three-albany-reserve-2026-10-06.json` for the next batch;
its source contains 2024 tax data published May 2026. Lincoln precedes Albany in the
saved queue and fills this batch's tenth slot.

Totals: 27/51 capitals configured (26 state capitals plus D.C.), 24 remaining;
28 represented U.S. states plus D.C., 31 U.S. app cities, 69 app cities overall and
59 executable provider descriptors. The research cohort now has 45 capital polygon
samples, 42 with native sample proof, and six published leads without an obtained
capital polygon sample. City providers do not imply statewide completeness. The
original 200-city cohort remains 32 configured of 63 verified candidates.

All 382 focused headless tests passed across 20 files. A dedicated headed Des Moines
browser loaded 231 parcels across nine cells, opened an action menu with a pointer
click, then streamed to 395 retained parcels across fifteen cells. The dated source
notice was visible; the settled pan had no source warnings or page errors. The browser
was closed after verification.


## U.S. capitals: fourth live batch (2026-10-06)

Albany, Raleigh, Bismarck, Columbus, Salem, Nashville, Austin, Salt Lake City,
Montpelier and Richmond are configured through live adapters. Every city passed
18 initial and shifted grid cells, independent count agreement under forced small
pages or complete object-ID manifests, exact retrieval of every retained native ID
with matching geometry, footprint reads and complete authoritative binding. This
batch covered 180 cells and exact-resolved 8,805 native identities. Metadata, aggregate
diagnostics and every failed attempt are retained in
`research/us-capitals-batch-four-live-2026-10-06.json` and source-linked registry history.
No geometry was imported into parcel tables or saved in research payloads.

| City | Native identity and configured source scope | Exact-resolved IDs |
| --- | --- | ---: |
| Albany | NYS SWIS_SBL_ID; fixed Albany County, live service declares 2024 data published May 2026 | 767 |
| Raleigh | NC OneMap parno; fixed Wake County FIPS 37183 and county namespace | 732 |
| Bismarck | ND GIS Hub GISID; fixed Burleigh County and county namespace | 508 |
| Columbus | Franklin County Auditor PARCELID; WebMercator FeatureServer with complete OID manifests | 1,556 |
| Salem | Marion County TAXLOT; West Salem in Polk County excluded | 460 |
| Nashville | Metro Nashville/Davidson County APN | 2,119 |
| Austin | Official City TCAD layer PID_10; Travis County scope | 444 |
| Salt Lake City | Utah compilation PARCEL_ID; fixed County=SaltLake | 1,154 |
| Montpelier | VCGI SPAN assessment accounts; complete account geometry and identified shapes only | 581 |
| Richmond | VGIN's safe-integer VGIN_QPID, independent of transport OBJECTID | 484 |

Albany's live MapServer explicitly describes 2024 assessment data. The official
file-geodatabase metadata describes primarily 2025 data, also published May 2026;
the endpoint-specific notice preserves the distinction. This is recorded in
`research/us-capitals-batch-four-albany-metadata-2026-10-06.json`.

Columbus's original MapServer returned count 22 against 21 manifest objects for one
bbox. Its FeatureServer and WebMercator offset reads repeated or omitted OIDs. The
WebMercator FeatureServer returned consistent independent counts/manifests, and
existing object-ID modes passed all viewport, exact and binding checks. Pagination
failures are retained; neither counts nor identity checks were weakened.

Vermont's official VCGI documents define SPAN as the School Property Account Number
and describe one Grand List assessment record that may contain multiple mapped lots.
The first scoped forced-page cell had 13 source rows representing 11 SPAN accounts;
the repeated sampled account had three identical geometries. Across a bounded
18-cell envelope, all 643 identified rows shared parcel/Grand List year 2025, type
PARCEL and MATCH status, with no mixed years among 21 repeated groups. The explicit
assessment-account descriptor expands every native account to all rows through both
OID manifests, normalizes geometry to nine decimal degrees and uses a shared
two-query limit. It exact-resolved 581 complete accounts. NULL SPAN shapes sampled
as exempt road/rail/water have no replacement identity and are consistently excluded
with `attributeNotNull`. The footer states 2025 assessment accounts, possible multiple
lots and unidentified-shape exclusions. Legal-lot identity is not inferred from SPAN.
Official semantics and aggregate evidence are linked in
`research/us-capitals-batch-four-reserve-vt-groups-2026-10-06.json`.

Oklahoma City's county endpoint returned no polygons in 18 cells; two official city
mirror queries returned HTML on bounded retries. Harrisburg's fixed Dauphin DEP subset
and official January 2024 city snapshot both conflicted on native keys. Providence's
PlatLot conflicts, and its municipal alternative timed out with ordinary TLS. Columbia's
vendor-hosted layer technically passed 14 TMS identities, but contains only 456 polygons;
publisher lineage and municipal-assets versus broader cadastral scope remain unclear.
Pierre's current District III feed returned 404/canceled item metadata; an older trail
project mirror lacks confirmed parcel lineage. These remain technical/source-scope
investigations, distinct from absent data. Source terms are informational.

An initial Raleigh temporary descriptor used a research explanation as an ID regex;
it incorrectly rejected valid keys. Its local validation failure is explicitly labelled
and retained alongside the corrected passing descriptor. Incorrect case fields and
case-sensitive scope corrections are recorded separately from provider failures.

Charleston passed 18 cells and 766 exact native IDs, with a complete proposed descriptor
saved in `research/us-capitals-batch-four-reserves-2026-10-06.json` for the next batch.
Its live service declares Tax Year 2023, retained in the reserve notice.

Totals: 37/51 capitals configured (36 state capitals plus D.C.), 14 remaining;
37 represented U.S. states plus D.C., 41 U.S. app cities, 79 app cities overall and
69 executable providers. Research has 47 capital polygon samples, 43 with native sample
proof, and four leads without an obtained capital polygon sample. These are city-provider
counts, not statewide completeness. The original 200-city cohort remains 32 configured
of 63 verified candidates.

All 402 focused headless tests passed across 21 files, including configured gateway,
source-only binding, numeric native identity, exact/viewport group agreement, county
filters, projections, deep links, membership, translations, history and generated
coverage. A dedicated headed Montpelier browser loaded 265 assessment parcels across
nine cells, opened a parcel menu with a pointer click, then retained 1,153 parcels across
50 cells after selection/view changes and a pan. The settled map had no source warning
or page error. Its source notice was checked and the browser was closed after use.


## U.S. capitals: final remaining batch (2026-10-06)

All 14 remaining jurisdictions were processed. Eleven sources passed and are now
configured; Frankfort, Oklahoma City and Pierre retain specific technical holds.
Research is complete for the 51-jurisdiction cohort; integration is 48/51, not 51/51.
No source conditions blocked integration and no parcel geometry was imported.

Strict live acceptance covered 198 viewport cells and 6,067 exact native identities,
including forced small-page reads against independent counts, stable geometry after
panning, footprint queries and complete authoritative source binding. Final aggregate
proof is `research/us-capitals-batch-five-live-2026-10-06.json`; original failed reads,
metadata, scope and identity diagnoses remain linked from each source in registry history.

| Capital | Native identity and source scope | Exact native IDs |
| --- | --- | ---: |
| Carson City | PIN; State compilation · source date January 2026 | 837 |
| Charleston | CleanParcelID; Tax Year 2023 · assessment mapping | 766 |
| Cheyenne | statepidn; Laramie County assessment parcels · unidentified shapes excluded | 733 |
| Columbia | tms; Partial source: 456 polygons · update year not established | 14 |
| Harrisburg | PID; September 2026 · complete native PID parcel groups | 846 |
| Jackson | PARNO; MDEQ Hinds County compilation · update year not established | 307 |
| Madison | PARCELID; V12 2026 compilation · Dane County | 546 |
| Olympia | PARCEL_NO; Active assessor-property footprints · may include multiple lots | 342 |
| Providence | CAMA_LINK; 2011–2018 canopy-study mirror · identified CAMA-link groups | 463 |
| Tallahassee | TAXID; November 2025 parcel-based mirror | 933 |
| Topeka | PIN; Shawnee County assessment parcels | 280 |

Carson City exposes a provider reprojection bug: the same WGS84 envelope returned
count 61 versus 62 distinct OIDs. Four-corner native NAD83 UTM 11 envelope queries
reconciled the manifests. ArcGIS now optionally accepts `boundsSrid` and
`boundsProjection`, projects every viewport corner locally, and still returns WGS84
geometry with native parcel identities. Strict counts remain required. This descriptor
passed all 837 exact identities; no OID was promoted to parcel identity.

Cheyenne's planning overlays had null geometry in both JSON and GeoJSON. Its real county
basemap MapServer disagreed on counts/manifests; the FeatureServer sibling reconciled
those reads. Assessment scope excludes null account numbers, including an unidentified
railroad placeholder. Olympia uses the documented 11-digit assessor-property number,
complete source components and active `STATUS_IND=A`; these are property footprints
and may span multiple legal lots. Madison consistently scopes county-local PARCELID to
Dane County. Harrisburg retains complete components of publisher-defined unique PID
parcel groups from the September 18, 2026 official snapshot.

Providence's blank PROPID grouped unrelated polygons across the city. Its numeric
CAMA_LINK is used instead, with RIGIS parcel-to-CAMA linkage semantics; equivalence to a
separate municipal numeric PropertyID catalogue is explicitly not asserted. Null/blank
links are excluded consistently across viewport, exact and binding reads. The official
canopy-study mirror is dated 2011–2018, item modified February 2025, and current cadastral
currency is not inferred from that modification. Complete identified native-link groups
passed. Columbia's publisher metadata confirms Richland/Lexington tax-assessment parcel
lineage, but the source contains only 456 polygons. The map footer and descriptor clearly
state partial coverage and unestablished update year.

Jackson's CMPDD endpoints send an incomplete certificate chain. A public Go Daddy
intermediate was verified against Node's normal roots and hostname, without disabling
TLS. Once reachable, both city and 2024 county overlays conflicted on dpin geometry.
The official MDEQ Hinds County source passed with PARNO and ordinary verified HTTPS;
no new runtime certificate is required. The existing source-scoped HTTPS transport now
preserves POST method/form bodies for long ArcGIS requests and exposes Retry-After.
Topeka uses genuine county PIN, after repeated local PARCELNUM suffixes failed.
Tallahassee uses the official November 2025 parcel-based land-use mirror. Charleston
retains the explicit Tax Year 2023 service label.

| Held capital | Remaining technical blocker |
| --- | --- |
| Frankfort | Native parcel/map identifiers conflict across ground/labels; usable current native identity remains unresolved. Municipal map alternatives lack cadastral layers; a same-name hosted mirror was in Illinois. |
| Oklahoma City | The original hosted layer covers a small patch and has no parcels in the sampled center. Correct city feeds return Incapsula HTML access blocks. |
| Pierre | District III feed is canceled/404; officially linked Beacon GIS returns 403. Older project mirror parcel lineage is unverified. |

These holds are recorded as integration work, not evidence that parcel data does not
exist. Source terms remain informational. No pending/unprocessed capital entries remain.
Totals: 48/51 capitals configured, 47 states plus D.C. represented, 52 U.S. app cities,
90 app cities overall and 80 executable providers. Research has 49 obtained capital
polygon samples with native sample proof and two leads without an obtained sample.
The original 200-city cohort remains 32 configured of 63 verified candidates.

All 446 focused headless checks passed across 25 files, covering the final gateways,
source-only binding, projection, complete groups, fixed scope, identity routing, source
failures, translations, history and generated coverage. Independent PROJ values check
four-corner projection within metre-scale datum differences; the live gate verifies
counts and exact geometry using the configured transform.

A dedicated headed browser verified Jackson loading 251 parcels across nine cells,
a pointer click opening its parcel menu, and a pan increasing retained coverage to
281 parcels across 12 cells. Carson City then loaded 302 parcels across nine cells
through the native-projection adapter, with rendered outlines and the January 2026
source notice checked visually. Both views had no source alerts or page errors.
The task-owned browser was closed after inspection.

## Gulf and Jordan — 6 October 2026

English and Arabic discovery and technical attempts are indexed in
[the Gulf research ledger](research/gulf-2026-10-06/index.json). Three city entries
were added, bringing the configured total to **93 cities / 83 provider descriptors**.
No parcel geometry was imported into the database.

| City/country | Runtime result | Source and scope |
| --- | --- | --- |
| Doha, Qatar | Enabled | Official CGIS `CadastrePlots`, native `PIN`; `ENDDATE IS NULL` excludes 73 ended records. 254,337 current rows and distinct PINs nationally; 18 Doha cells and 316 exact lookups passed. |
| Dubai, UAE | Enabled | Official DDA public Development Information System plot layer, native `PLOT_NUMBER`. Dubai Marina acceptance: 18 cells, 63 native IDs, forced paging, exact lookup, footprint and binding. Other emirates are separate sources. |
| Amman, Jordan | Enabled, identified subset | Official DLS `DLS_KEY` parcel-key scope excludes null/single-space keys. Reads complete native parcel components through OID manifests. 18 cells, 895 exact keys and binding passed. Unidentified plots are outside the advertised scope. |
| Kuwait | Technical hold | Official Municipality survey DGN parcel layer and viewer reset connections. GeoHub's 152 download archives contain no cadastral parcel dataset. Neither result proves that parcel data is absent. |
| Oman | Partial Muscat enabled after follow-up | Mutrah now works through a compound native identity and complete disjoint parcel parts; see the resolution below. The broader PAIN-based exports retain conflicting boundaries. |
| Saudi Arabia | Technical hold | Balady U Maps loads; anonymous parcel-promising ArcGIS folders return JSON 499 Token Required. Municipal alternatives timed out. |

Dubai uses the `dda-public-plots` adapter: it reads the same anonymous session
provided by the public viewer, keeps it in memory for at most one minute, and
renews once on ArcGIS 498/499. Its endpoint is fixed; sessions never enter the
catalogue, browser responses, research evidence or logs. HTTP 403 and 429 retain
normal source-health handling. No account credentials are required.

The federal UAE staging parcel schema returned **zero rows**. Al Ain's reachable
estimated-value plot export has ambiguous native keys and lifecycle, so it remains
a recorded candidate. Ajman's public embedded map contains permits/park statistics,
not parcel polygons. Terms and licences remain informational for every source;
the holds above concern actual access or cadastral identity.

Validation: **290 focused headless tests passed in 18 files**. A dedicated headed
Chrome inspection showed 84 initial Doha parcels (142 after panning), 45 Dubai
parcels and 569 Amman parcels. Doha and Amman parcel clicks opened their action
menus; all three views had no source warnings or page errors. Evidence is in
[the browser check](research/gulf-2026-10-06/browser-check.json).


## Oman conflict resolution — 6 October 2026

Muscat now uses the official municipal Mutrah parcel service through the live ArcGIS
adapter, bringing the configured total to **94 cities / 84 provider descriptors**.
The enabled scope has **12,185 native plot groups across 12,212 component rows**.
The map attribution and source information identify this as partial Mutrah coverage;
6,534 rows without a new plot number are outside this scope. No parcel table or
geometry snapshot was imported.

`PLOTUID` identifies old plots and can survive subdivision. The source's `NEWPLOTNO`
separates their new plots. All 22 repeated non-null combinations were independently
queried: their component geometries were disjoint, and the new housing-area and
phase references agreed. The adapter now supports typed compound native keys,
using the existing reversible component codec, and reads every component of each
observed key before publishing a parcel. Exact reads use the same native tuple;
transport `OBJECTID` values never become parcel identity.

Viewport queries use four-corner projection to the source's **EPSG:32640**; the
Web Mercator variant disagreed on count and ID manifests. Downstream consumers
receive the existing canonical WGS84 contract. For this source, component assembly
rejects changed administrative references and overlaps above one square centimetre.
That tiny allowance addresses a measured reprojection sliver; it does not permit
competing boundary versions. Nine-digit normalization makes repeated geometry
assembly stable across viewport and exact reads.

The older EnglishWebsite PAIN export remains held separately: its dates are null,
its status is constant, and even the measured-area subset has 13 pairs of overlapping
competing boundaries. The camping basemap also lacks a proven unique native key.
These failures, token-gated alternatives and the successful resolution remain in
[the Oman investigation ledger](research/oman-resolution-2026-10-06/index.json).

Validation: **331 headless tests passed in 18 files**. The final live gate passed
18 viewport cells, forced pagination, all 189 observed native IDs, footprint reads
and complete proposal binding. A headed browser loaded 76 parcels, opened a parcel's
action menu with a pointer click, and streamed to 189 retained parcels after panning.
The completed view had no source warning or uncaught page error. See
[the acceptance record](research/oman-resolution-2026-10-06/mutrah-acceptance.json)
and [the browser check](research/oman-resolution-2026-10-06/browser-check.json).

## U.S. capitals: the last three resolved (2026-10-07)

Frankfort, Oklahoma City and Pierre now have configured live adapters. The cohort is
**51/51 jurisdictions: all 50 state capitals plus Washington, D.C.** This counts capital
entry coverage, not complete current parcel coverage of every city or state. The app
now has 97 configured city entries and 87 executable provider descriptors, including
the Gulf and Oman additions already in this worktree.

The new [retry ledger](research/us-capitals-retry-2026-10-07/index.json) links the executed
English searches, publisher evidence, current source descriptors, earlier failures and
live acceptance. No parcel geometry was imported into the database or retained in the
research records; source conditions remain informational.

| Capital | Resolution and source scope | Exact native identities |
| --- | --- | ---: |
| Frankfort | Franklin County PVA's `PARCEL_ID` plus `PARCEL` distinguishes native split components. Complete disjoint groups must agree on `MAP`. Blank components excluded; mixed record years do not establish current boundary dates. | 654 |
| Oklahoma City | Newly discovered Oklahoma County Assessor public ArcGIS layer. Complete `accountno` groups must agree on `pin` and `propertyid`. Covers the county portion of the city; 632 rows without account identity excluded. | 610 |
| Pierre | Public ISG Missouri River Long Distance Trail project mirror labelled **2023**. Complete identified `PARCEL_ID` groups must agree on `RECORD_`. Third-party source; upstream supplier and updates after 2023 remain unverified. | 349 |

All three use the existing canonical ArcGIS path: viewport, exact-ID, footprint and
proposal-binding reads return the same complete native parcel groups. Transport OIDs
remain paging identifiers. Each group rejects material overlap and inconsistent
references; the integration does not select arbitrary source types, years or versions.
Frankfort's single-key and incomplete-group failures and Oklahoma's first single-row
account attempt remain recorded beside the working descriptors.

Pierre's blank and zero identifiers grouped unrelated shapes. The 674 zero-key rows
all have a blank `RECORD_`; treating zero as unassigned is an explicit inference and
exclusion, not a publisher-defined status. Excluding those unidentified records lets
real parcel groups pass without weakening overlap checks. The shared fixed filter
now permits an empty-string exclusion consistently in geometry, count, manifest and
exact queries, and still rejects invalid positive empty filters. The dated third-party
scope is visible in Pierre's map attribution and source notice.

The original OKC city endpoint still returns Incapsula HTML, and Hughes County's
Beacon viewer returns HTTP403, including ordinary requests from the configured dev
runtime. Those failures remain distinct from the now-working alternate sources.
Oklahoma research also verified a tiny polygon sample from the OGI statewide WFS
(February 2026 snapshot); it is recorded as an alternate candidate, with its catalogue
access-mode discrepancy, without claiming statewide adapter acceptance.

Live acceptance passed **54 viewport cells and all 1,613 retained native identities**,
including forced three-row paging against independent counts, stable geometry across
views and exact rereads, footprint queries and complete proposal binding. All **344
focused headless checks across 16 files** passed, including other U.S. gateways,
composite/complete-part semantics, blank exclusions, OGC/Socrata filters, source-only
binding, generated coverage and Gulf regressions. Headed Chrome checks verified all
three cities loading, opening parcel menus by pointer click and streaming after pans;
source notices were visible and the settled views had no source alerts or page errors.

[El Paso](research/overnight-cities-2026-10-08/el-paso-manifest-root-acceptance.json) and [West Palm Beach](research/overnight-cities-2026-10-08/west-palm-beach-county-ground-acceptance.json) are enabled locally. They qualify 79 and 114 valid distinct public parcel reference polygons in thirteen bounded cells, with complete native count/OID manifests, forced small pages, fresh identity reads, explicit absence, footprint and binding. Metric audits found no sampled overlap or operation errors. El Paso serves EPCAD county-source geometry through the City GIS, and its native manifest includes a parcel omitted by the earlier offset reader. West Palm Beach serves county ground around the unchanged WUP settlement locator, which is outside the separate municipal parcel layer extent; no incorporated-city coverage claim is made. GIS OIDs identify reference geometry, not statutory property records. Headed checks loaded 110 and 203 parcels and opened matching native Details without page errors. The dedicated browser was closed.
