<!-- Affordabot pilot architecture, commands, model assumptions and publication boundaries. -->
# Affordabot

A Zagreb rental-housing research pilot. Open `frontend/affordabot.html`, or use the
Affordabot link in the main app’s proposal tools. The backend registers
`GET /affordabot/config` and `POST /affordabot/scan`.

## Run locally

From the backend directory, with its existing `DATABASE_URL` configured:

```sh
node --env-file=.env scripts/affordabot-preview.mjs --port 6205
```

Open `http://localhost:6205/affordabot.html`. The preview serves this checkout’s frontend
and the real research routes on loopback with `Cache-Control: no-store`.
In an ordinary split frontend/API setup, pass the existing local `?backend=...` override.
The main app’s Affordabot link preserves its selected backend. Production uses the
existing API origin.

A bounded CLI run (no arguments prints help):

```sh
node --env-file=.env scripts/affordabot.mjs --scan --output /tmp/affordabot-research.json
node --env-file=.env scripts/affordabot.mjs --scan --config /tmp/housing-scenario.json
```

A config accepts `bbox` (WGS84 west, south, east, north), `minAreaM2`, `maxAreaM2`,
`sampleLimit`, `limit`, `reform`, and `assumptions`. The validation limits are in
`source.js`, `planner.js`, and the shared `affordabot-model.js`. Defaults screen at most
100 parcels and return ten leads. Output is written atomically; any per-site error makes
the run `partial` and gives the CLI a nonzero exit status. One query has a server-side
25-second statement timeout in a read-only transaction; this small bounded job has no
paid model calls and needs no long-running checkpoint. A scheduler can invoke the CLI;
this feature does not install a schedule or enable background jobs.

## Data and interpretation

* Parcels: `public.parcel`, with immutable composed cadastral IDs and source `date_added`.
* Roads: the shared `public.road_parcel_classification` excludes both `road` and
  `likely_road` parcels before generating massing. This preserves the map's classification
  and manual overrides, rather than inferring roads from parcel shape or zoning gaps.
* Buildings: any mapped `public.gdi_building_footprint` intersection over 5 m² excludes a
  site, including buildings straddling a cadastral boundary.
* Planning: the 2025 `public.planned_land_use` (`razina_plana = 'GUP'`) and
  `consensus.urban_rule` / `consensus.urban_rule_variable`. Public-service, green,
  sports, water and infrastructure designations exclude a site if they intersect it by
  more than 1 m². Other planning evidence is sampled at the parcel’s point-on-surface.
* Transit: `zet.stops` from the in-force `zet.gtfs_feeds` row. Distance to the nearest
  mapped stop is straight-line proximity, not a walking route, service-frequency check,
  or access-to-jobs score. Feed ID and fetched timestamp travel with the evidence.

Leads with a known use and usable extracted baseline rank ahead of equivalent unknown
sites. The sample is selected by stable cadastral order within the bounding box. A full sample
is marked capped. It is not a citywide search or a guarantee of the best sites. Missing
ownership, actual use, displacement, heritage, flooding, ecology, contamination,
infrastructure and planning exceptions remain explicit evidence gaps. A missing plan
baseline remains unknown. An extracted non-housing use has a zero housing baseline for
this comparison; this does not establish that no housing could legally be permitted.

Courtyard and compact schematic footprints fit within the source parcel and selected
setbacks. Geometry itself is resized for coverage and gross-floor-area caps. Counts,
map, costs and exported proposal all measure the resulting geometry. Extracted dwelling,
parking and allowed-form limits are carried into the comparison. This does not replace
an architectural daylight, access, fire, circulation, structural or legal assessment.
Proposed alternatives identify the particular extracted limits they exceed.

## Affordability

`frontend/js/affordabot-model.js` is shared by Node and the browser. It computes whole
homes, construction and land capital, parking, soft costs, contingency, grants, fixed-rate
loan amortization, operations, vacancy, utilities, household burden and additional capital
support needed to reach the target. Construction-cost sensitivity gives a scenario range;
it is not a statistical confidence interval. An operating-cost deficit is distinguished
from a capital shortfall. Unknown costs remain null.

Default prices and income figures are illustrative, not observed local quotes. In
particular, a zero land input assumes contributed land without a lease charge and says
nothing about ownership. Taxes, lease charges, developer profit, lifecycle works and
site-specific infrastructure require explicit cost estimates before a result is relied on.
Both building forms use the same construction cost rate; their construction complexity
has not been independently priced. Lower modeled cost does not establish a below-market
offer or a lasting affordability commitment. Delivery and enforceable affordability remain
research requirements.

## Drafts and publication

Saved research packages live in this browser’s localStorage, independently of the main
proposal store. Each includes the exact site, selected massing, finance inputs, evidence,
notes and draft public/authority copy. Export JSON to keep or transfer the package.
Opening a design passes a token-bound package on the same origin into the existing
proposal draft store and building editor. It creates a new local design, with
`ownership: no-change`, and preserves the research evidence through serialization. It
never replaces an existing proposal or asserts owner consent. Local browser drafts are
not public links; a published proposal link must be added to the public post manually.

Public posts and planning briefings are drafts. No X credentials, automated mentions,
reply loop, authority-address inference, paid submission or automatic proposal publication
is wired in. Consult X’s current automation rules before enabling a publisher; automated
mentions require opt-in and AI reply bots require prior written approval. Verify the
competent authority and its current submission channel for each reviewed case.

## UI vocabulary and styling

* **Search panel** — area and proposed planning parameters.
* **Opportunity list** — ranked research leads.
* **Site map** — immutable source parcel, selected massing and nearby stop.
* **Building comparison** — extracted-rule and proposed-rule alternatives.
* **Affordability assumptions** — editable cost and household inputs.
* **Evidence checklist** — unresolved site and delivery questions.
* **Research draft** — saved/exported package and entry to the main proposal editor.

The theme and semantic `action`, `field`, `card`, `notice`, `badge`, `metric`, and table
components live in `frontend/css/affordabot.css`. The map reads its ground/building colors
from CSS variables. English, Spanish, Serbian and Croatian use the existing i18n service.

## Focused checks

```sh
npx vitest run test/affordabot-model.test.js test/affordabot-planner.test.js test/affordabot-route.test.js test/affordabot-handoff.test.js --maxWorkers=1
```

The headless browser checks are `e2e/tests/affordabot.spec.ts`; run that file specifically.

### Pilot verification history

All runs were scoped, headless and completed; no full suites were run or stopped.

| Run | Scope | Result |
| --- | --- | --- |
| Unit 1 | Four Affordabot files, 24 tests | Passed |
| Browser 1 | Two Affordabot specs | One passed; mobile width failed |
| Browser 2 | Same two specs | One passed; nested grid still overflowed |
| Browser 3 | One mobile spec with layout diagnostics | Failed; located the remaining nested grid constraint |
| Browser 4 | One mobile spec | Layout and handoff passed; page-error guard caught missing ignored map config |
| Browser 5 | Both specs after supplying the worktree’s map config | Passed |
| Unit 2 | Four Affordabot files plus namespace and identity guards, 32 tests | Passed |
| Browser 6 | Both specs, including exported-artifact read-back | Passed |
| Unit 3 | Planner file after evidence-ranking adjustment, 10 tests | Passed |

A real bounded CLI run and the live review desk each returned eight research leads from
100 parcels with no processing failures. Desktop and 375-pixel mobile screens were
inspected in a dedicated headed Chrome. Tests also verify that an edited zero land cost
and a deliberately unknown land cost survive export and draft recovery correctly.

### Street-parcel regression

The initial eight-lead sample included seven parcels already classified as roads by the
shared road materialized view. The scanner now reads that classification and the planner
excludes road and likely-road inputs before generating any housing geometry. Ordinary
unclassified plots remain eligible; road proximity alone is not an exclusion. The focused
planner regression was confirmed red on the previous implementation before the fix.

Street-fix validation: the planner file first ran 16 headless unit tests with five expected
regression failures; after the fix, the planner and API files passed all 21 headless unit
tests. No runs were stopped and no full suites were run. A new live scan excluded 25
classified road parcels from the 100-parcel sample and returned one lead with zero
processing failures. The restarted preview was checked in a dedicated headed Chrome;
all seven former street leads disappeared and the remaining parcel was inspected on the map.
