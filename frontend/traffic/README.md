<!-- Documents the local traffic preview and its reproducible, read-only data export. -->
# Zagreb traffic preview

Open `/traffic/` on the frontend server. This is a separate, buildless Leaflet/canvas page.
For a new local server, run from the repository root:

```sh
npx http-server frontend -a localhost -p 8192 -c-1
```

The playback controls set speed, car count, lane guides and mapped traffic signals with simulated cycles.
Click a car to highlight its current lane and available exits; **Follow a car** keeps it in view.
The place buttons jump to Miramarska × Vukovarska, a two-to-three-lane split on Lučićeva,
the city centre, Trešnjevka or the entire loaded area. `/traffic/?view=split` opens the lane split directly.
Reduced-motion preferences start the animation paused. Hidden tabs stop the animation clock.

## Lane geometry

`geometry.js` builds the physical paths once in projected metres; the car simulation and lane
guides use those same paths. At aligned two-arm nodes, all lanes in a directed cross-section share
a transition zone. Splits, merges and changes in lateral offset borrow space along both adjoining
sections, normally 28 metres and longer for larger shifts. Quintic curves match the lane tangents
at both ends and progress monotonically down the road. Coincident straight endpoints have no
connector loop. Small coordinate mismatches blend over a shorter run, so cars do not briefly
reverse at rounded section endpoints. Actual junction turns keep their exported geometry.

Each end can borrow at most 45% of a section, less at bends or mapped signals. Signal stop positions
remain at their original distance along the road. These are derived driving paths, not surveyed
lane-marking locations. The saved movement IDs and allowed turns remain the source of truth;
geometry does not add a new branch or resolve an unanswered lane.

Cars keep their following gap through a split, including across its shared entrance. Cars on the
same taper can follow each other without waiting for the entire transition to empty; competing
merges yield to traffic already in the transition. Through paths retain the road speed limit.

## Data and limits

`data/central.json.gz` is a derived central-Zagreb preview, bounded by its recorded `bbox`.
The browser decompresses it with `DecompressionStream`; no running topology API or database is
needed to play the exported scene. OSM map tiles still require internet access.

The export uses the shared OSM snapshot, deterministic lane rules, and saved candidate junction
graphs from the existing topology pipeline. It reuses that pipeline's builder, junction curves,
parent-regression checks and OSM restriction validator. Candidates are not promoted or modified.
Its metadata records the OSM timestamp/hash and each selected saved solution's ID, status and date.
Exporter timestamps describe the export, not the age of the OSM evidence.

A complete saved junction replaces a current node atomically only when every directed lane
incidence can be matched uniquely. Lane matching uses source way, direction, ordinal, access and
turn/change rules, because section split IDs vary with viewport extent. A compatible incomplete
answer can also contribute checked saved movements for still-unassigned incoming lanes; existing
movements and the node's unresolved status are retained. This export keeps the same 858 fully saved
junctions and adds 14 checked connections across 3 unresolved junctions. An omitted `centreLane`
flag means false; actual shared centre lanes are excluded from car traffic. Rejected, incompatible
and regressing candidates are excluded. Live manual decisions take precedence. Unsupported
restriction approaches and movements that contradict mapped OSM restrictions are blocked.
Bus/private/destination-only lanes are excluded. Missing movements are never inferred.

The simulation chooses only exported lane connections. Traffic spawns across all cyclic lane
regions, weighted by eligible lane length; routes and lane changes stay within each car's region.
Lane changes cross one adjacent driving lane in the same section/direction, respect `change:lanes`,
and reserve space in both lanes during the manoeuvre. Drivers queue behind each other. Junction
reservations serialize crossings at an OSM node, and a car needs room to clear its reservation and
keep a following gap before entering a lane. The oldest long-waiting approach with room gets
priority for the next crossing, while still obeying its signal. Near a blocked turn, a queued driver
may choose another clear, explicit permitted exit in the same region. Missing exits are never
inferred.

Traffic demand, speeds without a mapped limit, and **signal colors and cycle timings are
illustrative**. Signal locations come from OSM nodes in the same July 28, 2026 snapshot as the road
geometry. Controls attach by exact source-way and section-vertex membership and respect
`traffic_signals:direction` or `direction`; tagged signalised road crossings are included. An OSM
node can represent a whole junction or crossing, not each physical signal pole. The mapped point is
the source location; the simulated colors and cycles are not live traffic, observed signal plans or
a calibrated traffic model.

Some junctions remain unresolved, so normal traffic does not use feeders or dead ends outside cyclic
regions. A manually placed car that reaches a missing exit remains stopped; cars persist until the
user resets the preview or lowers the car count.

The last recorded whole-city survey (2026-09-28) had 57 open junction groups out of 21,806; this
smaller export is not a new citywide coverage survey.

Lane-change semantics: [OSM `change` documentation](https://wiki.openstreetmap.org/wiki/Key:change).
Signal-node semantics: [OSM traffic signals](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtraffic_signals).
Map data: [OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).

## Refresh the snapshot

The existing pipeline currently lives in the `clickable-legacy-streets` checkout. From this
repository's root, with the shared roads API and the local database available:

```sh
node backend/scripts/export-traffic-preview.mjs \
  --topology-root ../consensus-builder-clickable-legacy-streets
```

Optional arguments: `--bbox west,south,east,north`, `--roads-api http://localhost:3001/api`,
`--city zagreb`, `--output frontend/traffic/data/central.json.gz`.
The exporter reads the topology checkout's `backend/.env`; a Docker hostname `db` maps to
`localhost` when run on the host. PostgreSQL sessions are read-only, with bounded statement times.
It creates only the compressed preview artifact, with no model calls or database writes.
Do not copy raw API payloads into the frontend: source metadata may contain local paths.

## Verify

```sh
cd backend
npx vitest run test/traffic-simulation.test.js test/traffic-geometry.test.js test/traffic-snapshot.test.js test/traffic-preview-data.test.js test/traffic-signals.test.js
```

`geometry.js` and `simulation.js` have no DOM, canvas or Leaflet dependencies. Headless tests
exercise split/merge continuity, following gaps, signal positions, movement and the saved-answer merge. The data test also runs traffic over
the exported graph, checking every entry against the source lane's allowed connections and lights.
The signal test checks OSM direction tags, exact way/section matching and incoming-only controls.
Desktop/mobile appearance and canvas animation are checked manually in a headed browser.
