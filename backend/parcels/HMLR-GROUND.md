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

The static release manifest contains archive revisions and conservative bounds.
Small native-ID directory shards route exact IDs to their council archives.
A viewport query first loads intersecting partitions, then loads all partitions
that intersect the **full** candidate parcel envelopes. Higher-priority overlapping
polygons are consequently included even outside the viewport or across a council
boundary. Results keep full parcel footprints; the viewport never clips them.

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

The adapter is deliberately unbound to cities until a complete release manifest
has been built, published and qualified. No national import or publication has
been performed by this change.

```sh
node backend/scripts/build-hmlr-browser-manifest.mjs --run \
  --out tmp/hmlr-browser-metadata --base-url https://YOUR-PUBLIC-HOST/hmlr
```

The destination must be supplied explicitly. This one-time/monthly metadata job
scans all official archives sequentially, checkpoints authority metadata and IDs,
and publishes immutable content-addressed shards plus an atomic latest manifest
only after every archive and its final revision checks pass. Geometry is consumed
and discarded; it is never stored in Postgres or served from a parcel database.
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

After qualification, change the default provider on existing London, Manchester
and Birmingham city IDs rather than adding duplicate city entries. New cities,
such as Newcastle, get separate qualified bindings to the same source. Keep
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
python3 scripts/build-provider-expansion-queue.py \
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
Archive download and local parsing have separate bounded timeouts (180 seconds
and 300 seconds). HMLR probes allow 300 transport requests because one city can
require several council archives and their anonymous-session redirects.

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
task and manifest hashes for the run, and use a new run identity after code changes.

## Existing stored-data exceptions

The historical imported sources in Buenos Aires, Belgrade, Ljubljana, New York
and Colorado retain their existing bindings for now. Several have live alternatives,
but native identities differ in some of them; replacing them without a verified
identity migration would invalidate saved parcel references. They are migration
work, not a precedent for new Postgres imports. Croatian OSS transport also retains
its previous path. New sources must prefer browser execution; any new stored-data
exception needs a demonstrated source limitation and a documented reason.
