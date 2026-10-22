# Browser parcel execution and HMLR ground

The map executes the same complete-source adapters in a module Web Worker. It
queries providers directly, then uses `/parcel-provider-relay/:sourceId` when
browser transport is blocked. The relay passes bounded bytes and required HTTP
metadata; it does not parse or import parcels. Credential, cookie and certificate
requirements are handled in transport. An HTTP denial remains a provider failure.

`npm --prefix backend run build:parcels:browser` generates the checked-in static
worker assets, including content-addressed lazy chunks. The worker URL carries the
frontend script version. Rebuild these assets whenever an adapter or catalogue
changes; the headless bundle test detects stale output.

## England and Wales

`gb-hmlr-browser-v1` downloads the relevant official council ZIP archives. They
contain GML in EPSG:27700. ZIPs are SHA-256/ETag/length verified and cached locally;
GML is parsed incrementally into IndexedDB. A complete validated partition is
required before any query uses it. The UI remains responsive because parsing,
projection and GEOS WebAssembly overlays run in the worker.

Public EPSG:27700-to-geographic conversion uses the official Ordnance Survey
OSTN15 NTv2 grid, verified by SHA-256 before loading. The grid is fetched lazily
as a separate static asset; it is not embedded in the worker bundle. Missing,
corrupt or out-of-grid resources fail the read. No approximate Helmert output
or fitted map offset is used. The OS's 40 published control points are tested
in both directions, and `coordinateOperation` identifies the grid on derived
ground features. ETRS89 coordinates are used as WGS84 ensemble coordinates;
an observation epoch and absolute survey accuracy are not inferred.

The immutable routing release's scope cells and feature-store index boxes retain
their published Helmert-based coordinate frame. `hmlr-routing-projection.js`
converts public queries into that frame through OSGB36 using the known transforms.
It serves only archive routing and index lookup. Candidate predicates and output
geometry use OSTN15, so a routing box is never treated as proof of containment
in the public viewport. Native ZIP bytes, IDs, release hashes and routing metadata
remain usable without fitting a translation or rewriting archived parcel input.

The static release manifest pins archive revisions, land-to-ZIP coverage scopes,
and small native-ID directory shards. Each scope is built from **every polygon
actually contained in that ZIP**, including parcels crossing council borders.
Administrative boundaries and a council's enclosing rectangle do not establish
which archives contain land at a query location.

The adapter first reads the small coverage scopes, then downloads only ZIPs whose
scopes intersect the viewport. A parcel becomes a candidate only when its policy
input polygon (repaired, 1 mm-snapped, projected) meets the query rectangle; an
enclosing rectangle that merely overlaps the view does not qualify, because derived
ground is always a subset of that input. Overlap context comes from the ZIPs whose
scopes share a cell with the cells the candidates' **full** polygons occupy, built
by the same scope policy. Any polygon touching a candidate lies in such a shared
cell, so higher-priority overlapping polygons are still included outside the
viewport or across a council boundary, while a long parcel's rectangle cannot pull
in a neighbouring ZIP. Results keep full parcel footprints; the viewport never
clips them.

No clock bounds a council load as a whole. The map's load deadline, the worker client's
request limit and the adapter's own download and parsing budgets are all limits on
silence: every progress report (bytes received, parcels indexed) restarts them, so a
350,000-parcel council imports for as long as it takes, and only a load that reports
nothing for the limit is abandoned. Birmingham (46.6 MB, 347,719 parcels) measured
about 30 s of download and 205 s of indexing on a loaded laptop in 2026-10; its default
view then also needs neighbouring Sandwell.

## Tile store (first path)

The map first reads a published tile release from the `uk-cadastre` Cloudflare R2 bucket,
served at `https://uk-cadastre.urbangametheory.xyz/<releaseId>/` (CORS open for GET,
`Cache-Control: immutable`). A release holds the raw INSPIRE input polygons of every
pinned council archive, cut into 1 km EPSG:27700 tiles: each parcel is in every tile its
native bounding box touches, in integer millimetres with per-ring deltas (`hmlr-tile-format.js`;
the few rows finer than a millimetre stay raw, so decoding reproduces the parsed coordinates
exactly). A view loads only its tiles, plus the tiles its candidates' padded boxes reach for
overlap context, and resolves them with the same GEOS engine, so derived ground, IDs and
provenance equal the per-council path. `manifest.json` lists hash-pinned 10 km index shards
(tile hashes, sizes and row counts) and ID shards (native ID to tile range); every file is
SHA-256 verified. The tile release must name the same routing release (`sourceRelease`) as
the source's `snapshotId`, and must not be partial.

The per-council import below stays the fallback. Any tile-store failure other than the
caller's own cancellation (unreachable, an HTTP error, a hash mismatch, more than 400 tiles
for one query) answers that query from the council archives and reports a `source-fallback`
progress event; after a store failure the import serves queries for 5 minutes before the
store is tried again.

Build, assemble and upload a release from the current routing manifest (about 3 GB of tiles
for England and Wales; the cut is restartable per council and can run as several shards):

```sh
node backend/scripts/build-hmlr-tiles.mjs --run --manifest <routing manifest URL> --out tmp/hmlr-tiles --shard 0/3   # and 1/3, 2/3
node backend/scripts/build-hmlr-tiles.mjs --assemble --manifest <routing manifest URL> --out tmp/hmlr-tiles
rclone copy tmp/hmlr-tiles/release/<releaseId> r2-uk-cadastre:uk-cadastre/<releaseId> --transfers 64 \
    --header-upload "Cache-Control: public, max-age=31536000, immutable"
```

Then set `tileManifestUrl` on `gb-hmlr-browser-v1` to the release's `manifest.json` and rebuild
the worker assets. A new routing release needs a new tile release before the catalog moves.
The polygons are republished under the Open Government Licence with HM Land Registry's and
Ordnance Survey's attribution statements (`attribution` on the source).

Time to parcels on the ground is the metric. The councils a view needs download
smallest first and two at a time; only indexing is serial, in download order. The
OSTN15 grid asset downloads alongside the release metadata and archives rather
than before them. While a council indexes, every 10,000 parsed parcels (and at the
end) the parcels under a waiting view go to the map as a preview (`source-preview`
progress, drawn by `frontend/js/parcels/preview-layer.js` in its own pane, dashed,
not interactive). A preview is a raw title polygon in public coordinates, never
resolved ground; the resolved parcels replace it when the view's load settles.

The map requests 0.001-degree grid cells, but HMLR cities fetch the cells a view
needs in aligned 5x5 blocks: one adapter query per block, answered to each cell by
parcel extent (`frontend/js/parcels/fetch.js`, `CELL_BLOCK_SIDE_BY_SOURCE`). Per cell,
every query re-read and re-resolved the same overlap context; a warm Oxford view
took 11.3 s in 105 queries and 3.1 s in 8 blocks, with the same 857 parcels. Blocks
cover only requested cells, never fixed tiles, so a block cannot pull in a council
ZIP the view does not need. Other sources stay per cell until measured.

Grid cells and council loads are shared and cancellable. A newer whole-view fetch
supersedes the previous one: cells only the older view wanted are cancelled (queued
ones are never sent), and cells both views want keep loading. In the worker, a
council load stops only when no query wants it: a running download or parse that no
newer query claims within two seconds is aborted, and a queued load nobody wants is
skipped. A cancelled load leaves no ready partition and no cached ZIP. Callers that
pass no signal (proposal footprints, block searches, Node qualification) are never
cancelled.

Scopes conservatively union occupied 0.0005-degree cells (about 35 by 56 metres
at Oxford). Polygon interiors, holes, disconnected components, slivers and edge
touches determine occupied cells. Long native edges also contribute the convex
hull of projected 250 m samples, covering vertices inserted by geometry repair
before projection. Small numerical padding covers the 1 mm normalization grid.
Cell rounding can include nearby land at a boundary; it cannot exclude a parcel
merely because that parcel crosses a council border. This compact routing data
contains no parcel IDs or individual parcel geometries.

Each scope carries the archive hash, full feature count and coverage policy.
Its own SHA-256 and byte count are pinned in the v2 manifest's canonical release
hash. Missing, mismatched or incomplete scopes fail the query; the adapter never
falls back to downloading ZIPs based on broad council rectangles. Exact-ID reads
continue to use the native-ID directory, then use scopes for their full overlap
context.

The reproducible policy repairs polygonal input, ranks by original repaired metric
area descending and numeric INSPIREID ascending, snaps input to a 1 mm grid, then
projects complete inputs before overlay. Each parcel loses the union of all
higher-priority inputs. This gives the same result regardless of query order;
fully covered parcels are explicitly suppressed. Derived IDs use
`GB-HMLR-BROWSER-v1-<INSPIREID>` and include source and geometry provenance.
These are indicative registered-freehold index derivatives, not legal boundaries.

GEOS 3.13.0 is pinned through `geos-wasm` 3.1.1 (LGPL-3.0); generated assets preserve
library notices. The policy version pins geometry semantics as well as IDs.

## Routing metadata publication

City bindings require a complete, published and qualified release manifest.
The 2026-10-12 city admission originally bound 20 qualified England/Wales cities to
release `44a56028732ae4895442909dfcb048e34dffd1f0b2714f4d0f50901d7544cd90`
under `/data/hmlr/` on the production origin. Its frozen qualification evidence
and manifest hash remain historical records; later city qualification results
stay separate until their next admission.

The current v2 routing release is
`af29bc44f39eefffff610c64df4d14dfe40f64ef94ec9ca4e7e7b0c353af2263`.
An independent audit verified all 318 archive pins, 24,453,254 source records and
5,022 ID directory shards against the original release. Only coverage metadata
and archive selection changed; the geometry policy, source identities and city
admissions remain the same. The
[routing validation record](../../world-parcels/research/hmlr-routing-validation-2026-10-12.json)
records those checks and exact full-feature comparisons for central Oxford and
two council-boundary queries. The central view returns the same 406 features
while downloading one complete 6.6 MB ZIP instead of three totalling 40.5 MB;
boundary queries still include neighbouring ZIPs when required.

```sh
node backend/scripts/build-hmlr-browser-manifest.mjs --run \
  --out tmp/hmlr-browser-metadata --base-url https://YOUR-PUBLIC-HOST/hmlr
```

The destination must be supplied explicitly. This one-time/monthly metadata job
scans all official archives sequentially, checkpoints authority metadata, coverage
scopes and IDs, and publishes immutable content-addressed shards plus an atomic latest manifest
only after every archive and its final revision checks pass. The complete scan
builds reusable routing metadata; map views fetch the resulting scopes instead
of repeating that scan. Geometry is consumed and discarded; it is never stored
in Postgres or served from a parcel database.
The metadata destination needs normal static HTTPS hosting with CORS when it is
on a different origin. Configure `manifestUrl` on the source before qualification.
When publishing under the frontend's `/data/hmlr/`, deployment preserves that
directory. Its nginx location must use `try_files $uri =404` so a missing shard
returns a real error instead of the app's HTML fallback. Publish only the release
directories and final manifest; checkpoints and staging files stay private.

## Shared provider, separate cities

England/Wales cities share this source, but each admitted city retains its own
app ID, centre and explicit UN WUP city code. The globe ranks those cities by
their settlement populations and reveals smaller labels at deeper zoom; source
IDs do not group labels or choose the city destination.

Authority manifest bounds narrow the population-ranked candidate queue. They
are conservative parcel envelopes, not administrative boundaries or proof that
a city is supported. Each candidate needs a real parcel probe and the normal
independent qualification gates before its app binding is enabled. ISO2 `GB`
alone must never select England/Wales membership or establish UK-wide coverage.

London, Manchester and Birmingham retain their existing app city IDs and use
this shared provider by default. Newly admitted cities, including Oxford and
Newcastle, have separate qualified bindings to the same source. Keep
historical source identities resolvable for saved proposals: a native INSPIREID
match does not prove equivalent geometry under the derived overlap policy, so
saved references cannot be silently changed to the new prefix. UK country
coverage remains partial while Scotland and Northern Ireland are unresolved.
Retired descriptors use `defaultForCity: false` and `historicalForIds: true` to
keep exact-ID reads in their original namespace without remaining city defaults;
unqualified sources do not receive that historical grant.

Generate the screened city seed and the globally population-ranked reuse queue
from a sealed manifest and the same WUP input used by discovery:

```sh
python3 scripts/build-hmlr-wup-seed.py \
  --manifest tmp/hmlr-browser-metadata/manifest.json \
  --expected-manifest-sha256 VERIFIED_MANIFEST_SHA256 \
  --manifest-base-url https://YOUR-PUBLIC-HOST/data/hmlr \
  --manifest-evidence-path tmp/hmlr-browser-metadata/manifest.json \
  --wup tmp/WUP2025.csv.gz --output tmp/hmlr-city-seed.json
python3 scripts/build-provider-expansion-queue.py --no-catalog \
  --source tmp/WUP2025.csv.gz --seeds tmp/hmlr-city-seed.json \
  --output tmp/hmlr-city-queue.json
```

`candidateCityCodes` and `boundCityCodes` are numeric WUP identities on the seed,
not app-city slugs in `descriptor.cityIds`. Once a city is admitted, add its exact
WUP population record to the demographics snapshot if absent, and retain that
code in its city configuration. Provider upgrades require new-provider checks
even when an earlier city discovery receipt exists; they do not repeat web search.

An isolated pre-publication qualification may use exact-URL, hash-checked local
manifest and shard reads while still fetching archives over official HTTPS. Such
evidence proves the adapter and pinned archive release, not public metadata
hosting. Before enabling browser cities, separately verify the deployed metadata,
worker assets and headed city view through their actual public routes.

Node qualification uses temporary disk-backed authority geometry and compact
in-memory bounds/offsets, shared across adapters for the same immutable release.
This mirrors the browser's IndexedDB reuse; it does not import geometry into
Postgres or change the browser storage path. Concurrent loads of one authority
coalesce, and incomplete partitions are cleared before they can be reused.
Archive download and local parsing have separate silence limits (60 seconds each
without a byte or a parcel). HMLR probes allow 300 transport requests because one
city can require several council archives and their anonymous-session redirects.

An isolated runner must include the canonical shared `site-binding.js` module
used by `source-binding.js`, and preflight both geometry and parcel-act binding
as well as the metric script's Python dependencies before starting city jobs.
Preflight Node dependencies with the qualifier's backend-relative resolver
(`createRequire` anchored at `backend/package.json`). An isolated driver that
resolves packages from the source-tree root can link its root `node_modules` to
`backend/node_modules`; this is driver setup, not a parcel-data requirement.

The repaired five-city validation runs serially with Node
`--max-old-space-size=3072`, systemd `MemoryHigh=4G`, `MemoryMax=5G`, and
`LimitAS=infinity`. Do not impose a small address-space limit: the GML decoder's
WebAssembly runtime reserves substantially more virtual memory than its resident
memory use. These settings bound resident memory while allowing that reservation.
Keep per-city failures recorded and continue to the next city; pin the adapter,
task and manifest hashes for the run, and use a new run identity after adapter or
qualification-rule changes.

For a larger city queue, `scripts/lib/parcel-qualification-pool.mjs` supplies an
asynchronous city pool and a separate limit for the heavy qualification stage.
On the 8 GB research host, use two cities in progress with one qualification
process at a time: the serial run reached about 2.45 GiB for one city. Both city
workers share the service's 4 GiB memory-high and 5 GiB memory-max limits. Downloads
and probes can overlap qualification without starting two full audits together.
Keep one coordinator writing the run status, exclusive run ownership, and separate
logs for each city attempt. Reuse verified completed results on resume; retain an
interrupted attempt before starting a new one. A concurrency change can retain the
run identity when task and adapter hashes match, with the coordinator change
recorded separately in the run's execution history.

## Existing stored-data exceptions

The historical imported sources in Buenos Aires, Belgrade, Ljubljana, New York
and Colorado retain their existing bindings for now. Several have live alternatives,
but native identities differ in some of them; replacing them without a verified
identity migration would invalidate saved parcel references. They are migration
work, not a precedent for new Postgres imports. Croatian OSS transport also retains
its previous path. New sources must prefer browser execution; any new stored-data
exception needs a demonstrated source limitation and a documented reason.
