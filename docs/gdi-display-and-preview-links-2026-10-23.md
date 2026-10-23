# GDI display and verified local preview links

Built now defaults to Off. The GDI/reference survey picker also starts with no surveys selected.
Explicitly enabling GDI turns the shared Built display on in its transparent state. Existing
explicit saved or URL display choices remain respected.

Ordinary survey footprints use a 14% lavender fill and a contrasting slate border. Colors, fill
and stroke opacity and border width are palette tokens in `css/tokens.css`. Solid mode no longer
forces these reference fills to opacity 1. The 3D renderer's separate gray building materials are
unchanged; the opaque purple shapes were the GDI footprint overlay, whose label mentions the 3D
survey model.

The earlier plain local link was incomplete: port 8098 served this checkout but the development
API default pointed at port 3000, where no API was listening. The corrected link explicitly uses
`backend=https://api.urbangametheory.xyz`. It retains the person's saved city; no city switch is
required. Repo instructions now require checking the resolved backend and real data/capabilities
for the intended flow before sharing a preview.

Live read-only verification in the browser confirmed New York, the production API base, 120
parcels in the test area, and 19 buildings from `nyc-arcgis` for a nearby-building query. No request
in that navigation targeted the dead local API. A separate capability check confirmed that the
production NYC provider currently answers `supported: false` for `/buildings/under`. Thus NYC
parcels and 3D data are available through the production-backed link. The missing capability is now
fixed in this checkout and verified against its running local API; production still requires a
deploy. See [the all-city stock audit](building-stock-all-cities-2026-10-23.md). The production-backed
link does not prove the new review flow works on the deployed API.

Verification:

- Headless unit: 57 cases in `planning-representations.test.js` and
  `frontend-map-performance.test.js`, all passed; no full suite and no stopped run.
- Headless Playwright: one new display case initially failed because the fixture supplied WGS84
  to a survey endpoint declaring EPSG:3765. Corrected it using the existing survey fixture helper;
  the case passed. It passed again after moving opacity and line-width settings into palette
  tokens. Each run used one worker, no retries, and no run was stopped.
- Dedicated background headed Chrome verified real GDI data: 23 visible survey footprints,
  computed fill `rgb(196, 181, 253)`, border `rgb(71, 85, 105)`, and fill opacity `0.14` even in
  Solid mode. The browser returned to New York for the final connection/default check and closed.

The scoped checkpoint excludes `css/planning-views.css` and `MEMORY.md`, which also contain
concurrent Atlas-study removal edits. Their tested working-tree changes remain intact. No push
or production deploy was requested or performed.
