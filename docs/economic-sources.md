# Economic sources

Economics implements the common [source registration and adapter contract](source-adapters.md).
Its domain-specific rate validation remains at the economic reader boundary.

The frontend selects economic sources just as it selects parcel and building sources. The pure
`frontend/js/economic-sources.js` registry runs in both browsers and Node. An adapter returns rate
observations; `CityMoney` is the consumer facade. Backend services do not infer a provider or currency
from an app city. Currency formatting and exchange conversion are independent concerns.

## Rate contract

Each observation names a metric, amount, currency, unit, basis, valuation date and source. The four
metrics are independent: `land` and `roadLand` use `m2-land`; `sale` and `construction` use `m2-floor`.
A residential land appraisal is not a floor-area sale price or a construction cost. A road-land rate
is a modeling input for affected land, not a statement about compensation or the cost of a road.

Bases are `assumption`, `policy-appraisal`, `market`, and `construction-cost`. Evidence requires its
own `asOf` date; a fetch date must not stand in for it. Assumptions may have no date. Assessed property
totals are deliberately outside this rate contract: they need source-qualified property identities,
assessment dates, and a distinction between land-only and whole-property value. They must not be
silently renamed market prices or divided by an unrelated area.

Source resolution uses the first usable observation for each metric. Only observations in the
place's explicit currency are usable in that model; no implicit conversion is performed. A browser
override can supply one or several metrics, leaving the remaining configured sources in place.
Missing rates leave dependent amounts unknown, including construction profit; zero is a valid
explicit rate and differs from missing evidence.

## Adapters and frontend selection

- `uk-mhclg-2023` adapts the existing generated UK table. It exposes the English authority's
  residential policy-appraisal rate, dated 1 October 2023, with the source workbook and authority.
  City-wide application is an illustrative authority-rate assumption, not a site-specific valuation.
  `roadLand` uses the same residential proxy and retains that provenance.
- `scenario-assumptions` exposes the existing editable floor-area starting points: 4,000 sale and
  2,000 construction in local currency. Existing EUR land/road assumptions remain 133/100. These
  values are model assumptions, not a worldwide price dataset.
- `rate-table` accepts a validated local snapshot of independent rates. It is usable worldwide,
  without adding country-specific logic to consumers. Future service adapters should normalize to
  this same observation contract.

City configuration can supply `economics.sources`, an ordered array of registered IDs and/or
`rate-table` descriptors. The standard frontend policy selects the UK adapter only where the table
has an actual authority observation, followed by scenario assumptions. Explicit source lists replace
that policy; include `scenario-assumptions` explicitly if wanted. No backend city routing is added.

Settings → **Valuation & costs** displays effective rates and provenance. Visitors can enter local
assumptions or import a rate-table JSON snapshot. Overrides are stored per app city in this browser;
reset restores configured sources. Importing a table is not a subscription to a live remote feed.

```json
{
  "version": 1,
  "id": "local-evidence-2026",
  "name": "Local residential evidence",
  "adapter": "rate-table",
  "url": "https://example.org/economic-evidence",
  "rates": [
    { "metric": "land", "unit": "m2-land", "amount": 750,
      "currency": "GBP", "basis": "market", "asOf": "2026-06-30" },
    { "metric": "sale", "unit": "m2-floor", "amount": 4200,
      "currency": "GBP", "basis": "market", "asOf": "2026-06-30" },
    { "metric": "construction", "unit": "m2-floor", "amount": 2300,
      "currency": "GBP", "basis": "construction-cost", "asOf": "2026-06-30" }
  ]
}
```

## Consumers and intentional changes

Parcel panels, selection estimates and browser road-acquisition models use `CityMoney` land rates.
Modeled parcel estimates retain their economic observation. The road model retains it in
`priceBasis`. Parcel and road amount tooltips expose the source and basis. The 3D comparison and
plan statistics use selected sale/construction rates; slider changes remain temporary scenario
assumptions. Switching sources resets the slider inputs even when the currency stays the same.

The shared sale starting assumption is now 4,000 in both 3D and plan statistics (previously the EUR
plan-statistics dialog used a separate 5,000). Unsupported currencies no longer borrow EUR land
rates. The old generated England-median placeholders are not used as local observations for other
UK jurisdictions or unknown cities. Rebuilding the generated table alone does not change this rule.

The server corridor-statistics endpoint's explicit-source contract is documented in its route:
it takes the supported parcel source and a selected economic rate descriptor, never a fixed EUR
rate. Its current geometry query still supports only the named Croatian database resource.

Agent portfolio wealth remains a separate illustrative USD/ETH model in `financials.js`, with a
fixed USD/m² rate and estimated USD/ETH conversion. It does not become an appraisal by sharing the
word “value”. Moving it to local land rates also requires an explicit currency-conversion source.
Authored cash offers and agreement allocations are not rewritten by a source preference.

## Source families audited

| Family | Current adapter/selection support | Remaining gap |
| --- | --- | --- |
| Cadastral parcels | Catalogue, many service/snapshot adapters, visitor URL override | Provider qualification and coverage |
| Existing buildings | Survey, OSM, Overture and custom sources; visitor override | Quality/height evidence varies |
| Planning rules and permitted envelopes | Provider registry and source selector | Adding an arbitrary service requires configuration/adapter work |
| Parcel ownership/rights | Registry tied to declared parcel-provider identity | No independent visitor source chooser |
| Basemaps/imagery | Standard maps, custom XYZ/WMS, local suggestions | No general elevation-source contract |
| Economic unit rates | UK appraisal, assumptions, local imported rates | No general live market or assessment feed yet |
| Roads/paths | Shared OSM reader and backend transport | No general road-dataset registry/visitor override |
| Terrain/elevation | Specific terrain/profile providers | Fixed provider/datum contracts, no general selector |
| Trees, water and green areas | Overture trees, OpenFreeMap water and landcover | Provider choices fixed |
| Building details/interiors for x-ray | Published floor models and explicit evidence namespaces; recorded plans and generated suggestions remain distinct | No general visitor source selector/import for arbitrary detail providers |
| Transit alignments | Configured GeoJSON track sources used for station snapping and 3D | No general visitor source chooser |
| Search/geocoding | Shared Photon usage | Provider fixed |

Useful next boundaries are a roads provider contract, elevation with vertical datum/coverage,
source-qualified assessed-property observations, exchange-rate evidence, and the remaining portfolio
model. The existing GeoJSON/WFS/ArcGIS/XYZ machinery makes local zoning/land-use, flood/protection
overlays, address points, tree inventories and utility/network context comparatively approachable;
each still needs its own meaning and coverage contract, not only a URL field. Transaction comparables,
rents, construction indices and development fees are useful economic additions, but an index is not
an absolute unit cost and a whole-property sale is not a land-only sale.

## Place defaults and visitor preferences

`frontend/data/city-configs.js` is the per-city registry (the browser loads it split into
`data/city-index.js` and `data/cities/<id>.js`; regenerate the browser files with `node scripts/build-city-files.mjs --run`). It currently combines place identity, source
choices, availability constraints and display defaults. User customization should be a validated
override over place defaults, not an editor for that entire object.

Useful visitor choices include source selection for the families above; local economic assumptions;
recorded-only versus generated x-ray interiors; inferred storey-height assumptions where measurements
are missing; remembered map/layer/view defaults; and language/number-format preferences. The app
already has several of these controls, but their persistence and availability are not uniform.
Existing source records and authored geometry must retain their identities when preferences change.

For building details, keep the footprint/height provider separate from the floor/interior evidence
provider. Existing `floorModels.namespace` selects a backend evidence collection. A visitor should
see a provider's name, coverage and evidence status rather than edit that namespace. X-ray already
distinguishes recorded floor plans, generated layouts and approximate registration; a future source
selector must preserve those qualifications and bind details to source-qualified building identities.

Keep dataset CRS, parcel ID prefixes, query grid sizes, backend routing, evidence namespaces,
coverage, legal authority and attribution in validated provider/application configuration. Currency
is the unit of the evidence: a display-currency preference requires an explicit exchange-rate source,
not merely changing a currency label. Feature availability should follow supported capabilities;
an arbitrary UI override must not claim an unsupported source or operation is available.
