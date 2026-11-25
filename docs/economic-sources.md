# Economic sources

Economics implements the common [source registration and adapter contract](source-adapters.md).
Its domain-specific rate validation remains at the economic reader boundary.

The frontend selects economic sources just as it selects parcel and building sources. The pure
`frontend/js/economic-sources.js` registry runs in both browsers and Node. An adapter returns rate
observations; `CityMoney` is the consumer facade. Backend services do not infer a provider or currency
from an app city. Currency formatting and exchange conversion are independent concerns.

## Rate contract

Each observation names a metric, amount, currency, unit, basis, valuation date and source. The six
metrics are independent: `land` and `roadLand` use `m2-land`; `sale` and `construction` use `m2-floor`;
`rent` uses `m2-floor-month`, per m² of floor area per month, the way rents are quoted. A rent's basis
is `assumption` or `market`, as a sale price's is. `saleTax` uses `share-of-sale`: the share of a sale
price that is tax (VAT on new housing, 0.16 for 16 %), below 1, on a `statutory` or `assumption`
basis. Sale prices are as quoted, the tax included where the place charges it. A `construction` row
may say `taxIncluded: true`: its amount includes that tax on the building's inputs, as a statistics
office's cost per m² does when it reports what developers paid. A developer selling the floor area
reclaims that tax from the tax on the sale. A construction cost slid, typed in Settings or passed to
`ugt_compare` keeps the tax basis of the rate it replaces.
A residential land appraisal is not a floor-area sale price or a construction cost. A road-land rate
is a modeling input for affected land, not a statement about compensation or the cost of a road.

Bases are `assumption`, `policy-appraisal`, `market`, `construction-cost` and `statutory` (sale tax only). Evidence requires its
own `asOf` date; a fetch date must not stand in for it. Assumptions may have no date. Assessed property
totals are deliberately outside this rate contract: they need source-qualified property identities,
assessment dates, and a distinction between land-only and whole-property value. They must not be
silently renamed market prices or divided by an unrelated area.

Rates are resolved for a location, `at` ([lng, lat]): `CityMoney.ratesFor(city, override, at)` and the
`current…(at)` views. A source published per area returns the observation of the area containing it
(see below); other sources ignore it. Every consumer takes the location of the land it prices with
`EconomicSources.locationOf`, the centre of that land's extent (one point per priced land). Without a
location the per-area sources answer for the city's own area, and the observation's `scope` says so.

Source resolution uses the first usable observation for each metric. Only observations in the
place's explicit currency are usable in that model; no implicit conversion is performed. A browser
override can supply one or several metrics, leaving the remaining configured sources in place.
Missing rates leave dependent amounts unknown, including construction profit; zero is a valid
explicit rate and differs from missing evidence.

## Adapters and frontend selection

- `area-rates` reads an area rate table: a dataset's rates per published area of an area layer (an
  English local authority, `lad`), written by a dataset reader through `scripts/lib/area_rate_table.py`
  (`id`, `name`, `url`, `layer`, `currency`, the dataset's own `asOf`, `rates` naming each metric's unit,
  basis, area-row field and scope note, `areas` by code, optional `cities`). The file registers itself
  as `window.EconomicAreaRates[id]` (node: `CityMoney`'s table list). It gives the rates of the area
  the location lies in (scope `E09000019 · Islington`, then the rate's note). The city's own area (a
  table of the layer naming the city in `cities`, else the area under its map centre) stands in only
  without a location, outside the mapped areas (Wales, Scotland, the sea) or in an area without a rate,
  and the scope says which, e.g. `E09000033 · Westminster (the city's area: no location given)`. A
  configured source may add `scale: { factor, note }` to convert the table's unit to the contract's
  (net to gross); the note is appended to the scope. Any country's per-area statistics (land values,
  rents, development charges) fit this shape; only the dataset reader is specific.
  - `uk-mhclg-land-2023` (`frontend/js/uk-land-rates.js`, `scripts/build-uk-land-rates.py`): MHCLG
    "Land value estimates for policy appraisal 2023", sheet Residential, medium site density at the
    median house price, for every English local authority, dated 1 October 2023, as `land` and
    `roadLand`. Its `cities` name the authority each English city stands for (named like the city,
    else under its map centre). It is a policy-appraisal figure, not a site valuation; `roadLand` uses
    the same residential proxy and retains that provenance. Hammersmith and Fulham's estimate
    (£19,390/m²) is about twice Kensington and Chelsea's (£9,215): the workbook assumes 400
    dwellings/ha as its medium density there against 140; it is the published figure and is used as
    published. Cumberland and the Isles of Scilly have no estimate.
  - `ons-pipr-rent` (`frontend/js/uk-private-rents.js`, `scripts/build-uk-area-rates.py rents`): the
    ONS "Price Index of Private Rents, UK: monthly price statistics" (OGL v3; the 18 November 2026
    edition, October 2026), each English authority's two-bedroom private rent, a weighted geometric
    mean of new and existing tenancies in £ a month per dwelling, ÷ 70 m², the minimum gross internal
    area of a two-bedroom four-person one-storey dwelling in the Nationally Described Space Standard
    (March 2015, Table 1): a `market` rent per m² of dwelling a month (Islington 2,722 → 38.89,
    Birmingham 1,015 → 14.50). A dwelling at the standard's minimum lets for more per m² than a larger
    one, so this leans high. London and Birmingham scale it by their viability studies' net to gross
    (× 0.675, × 0.85), as their sale prices are, to a rent per m² of the building's floor area
    (Islington 26.25, Birmingham 12.33); other English cities keep it per m² of dwelling and the scope
    says so. The ONS publishes no rent for the City of London or the Isles of Scilly; Barnsley's and
    Sheffield's 2024 codes are filed under their May 2023 codes.
- `gla-lpvs-2026` gives London's sale price and construction cost from the GLA London Plan Viability
  Study, Phase 1 (July 2026), by its value band A–F (the GLA's value band map, a postcode-district
  layer). Sale: the band's indicative average blended market value at the mid-point (Tables A.2–F.2,
  new-build sales June 2022–June 2025, £ per m² of dwelling), × 0.675, the midpoint of the 65–70 %
  net-to-gross the study found for schemes under 6 storeys counting the ground floor (Annex 3 ¶7), to
  give a price per m² of the building's floor area: A 18,729, B 11,844, C 8,550, D 6,355, E 5,014,
  F 3,720. Construction: Mace's build-for-sale cost of 4–6 storey flats per m² GIA at Q2 2026 prices
  (Appendix 1; Tables A.6–F.10): A 3,910, B 3,730, C 3,560, D 3,380, E and F 3,200; it excludes
  demolition, externals, fees, finance, CIL/S106 and VAT. The rate contract has no building height or
  typology, so the 4–6 storey figure stands for every building (taller flats cost up to £5,290 in
  band A). The map leaves postcode districts with too few new-build sales unbanded, much of the centre
  among them: a location in Greater London there takes the nearest band (`Value band A, nearest`).
  Outside Greater London, or without a location, it gives the band of the city's centre, and says so.
- Birmingham configures two `rate-table` snapshots from the council's 2024 viability evidence
  (AspinallVerdi): sale 2,509, the median achieved price of new-build flats, August 2021–August 2023,
  £2,952 per m² of dwelling (Residential Market Paper Table 4.4), × 0.85, the assessment's net-to-gross
  for apartments (Whole Plan Viability Assessment Table 5.4); construction 1,638, flats of 3–5 storeys,
  median BCIS rebased to Birmingham (Table 5.16; estate housing 1,260–1,423, 6+ storeys in the core
  2,045). The study's value zones are a ward map in a figure, not published data, so the sale price is
  city-wide.
- The areas of those sources are `frontend/data/uk-economic-areas.js`
  (`scripts/build-uk-economic-areas.mjs`): the 296 English districts (ONS May 2023 BFE, to the extent of
  the realm) and the six value bands, simplified to 30 m on shared borders (250 m on districts' sea and
  Welsh/Scottish edges), shared borders stored once so neighbours leave no gaps. About 560 KB
  (230 KB compressed), loaded by `city-config.js` only for a city an area rate table names (the 112
  English cities) and read in node on first use. A second country's areas need that loader to take
  more than this one file. `EconomicSources.areaAt` finds the area of a point
  synchronously; a point within about 30 m of a border can fall in the neighbour (0.2–0.4 % of a
  London grid against the source polygons).
- `scenario-assumptions` exposes the existing editable floor-area starting points: 4,000 sale,
  2,000 construction and 15 rent a month in local currency (a 4.5 % gross yield on the sale price),
  and no sale tax (0) until a source states one.
  Existing EUR land/road assumptions remain 133/100. These values are model assumptions, not a
  worldwide price dataset.
- `rate-table` accepts a validated local snapshot of independent rates. It is usable worldwide,
  without adding country-specific logic to consumers. Future service adapters should normalize to
  this same observation contract.
- Astana and Alatau configure two `rate-table` snapshots from Kazakhstan's Bureau of National
  Statistics: the October 2026 new-build sale price and monthly rent, and the January–October 2026
  actual construction cost of housing built by companies, per m² of the buildings' total area (it
  excludes land and developer profit). Sale price and rent are published per m² of dwelling area, so
  they are scaled by the city's useful ÷ total area of the housing commissioned in the same period
  (Astana 0.722, Almaty 0.758). The bureau publishes no Alatau series; Alatau uses Almaty city's figures, and each row's
  `scope` says so. Land: Astana takes the median krisha.kz asking price of plots for apartment blocks
  (November 2026); Alatau, whose land is allocated for a fee the city sets and whose apartment-land price is
  unpublished, takes a labelled assumption from the press range for house plots in the neighbouring
  districts. Both take the Tax Code's 16 % VAT on new housing whose construction starts from 2026.

City configuration can supply `economics.sources`, an ordered array of registered IDs and/or
`rate-table` or `area-rates` descriptors. The standard frontend policy selects every built-in area
table that covers the city (names it in `cities`, or has a rate for the area under its centre, in its
currency), followed by scenario assumptions; London and Birmingham configure their sources explicitly. Explicit source lists replace
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

Parcel panels, selection estimates and browser road-acquisition models use `CityMoney` land rates at
each parcel (a road: one rate at the centre of its affected parcels; an agreement's default unit
value: at its input parcels). A parcel's area is the one its record states, else its geometry's
measured area (`ParcelMenuModel.featureArea`, `turf.area`), so a provider without an area field
(HMLR) still has an area and an estimate; `ugt_parcel_context` measures the parcel the same way.
Modeled parcel estimates retain their economic observation. The road model retains it in
`priceBasis`. Parcel and road amount tooltips expose the source and basis. The 3D comparison and
plan statistics use selected sale/construction rates; slider changes remain temporary scenario
assumptions. Every price in the 3D panel, Plan stats (and Compare plans) and Settings → Valuation &
costs shows its source as text under it (`EconomicSourceSettings.renderSource`): the source's name
linked to its document (the observation's `sourceUrl`), its basis and date, and its scope, the place
the rate is for; a price the visitor slides or types reads "Scenario assumption". Switching sources resets the slider inputs even when the currency stays the same. A
slider's standard range is sized for euro-like amounts; an observation widens it to half and twice
its amount where those fall outside, so a tenge price can be slid both ways. A land price with no
source has a range sized by the city's sale price over the 4,000 standard and starts unset; the land
and sale-tax sliders can set a price no source gives.

The 3D panel, Plan stats (with Compare plans) and the MCP comparison count new floor area with one
function, `CityMoney.newBuildMoney` (the vocabulary's "Profit on the new floor area"): value, the
all-in cost (construction, land, the sale tax inside the value less the tax reclaimed on a
tax-inclusive construction cost, the value of the floor area it replaces), profit, annual rent and the
rent's yield on the construction, land and replaced value: a landlord who charges no tax on the rent
and reclaims none. The land is the
plan's land in Plan stats, the parcel or the design's parcels or site in the 3D panel, and the union of
the designs' sites in `ugt_compare`; each takes its rates at that land's location. Compare plans uses
one set of prices for every column, at the first plan's land. A price the visitor slides or types is
kept when another plan's place changes the others. Plan stats and the 3D panel show the all-in cost with a Cost
details disclosure of its parts, and a slider for each price; Plan stats also takes the exact number.
An empty input is no price, and what depends on it reads "—"; without a land price the all-in cost
and profit are unknown, and Plan stats says how to set one. `ugt_compare` gives each alternative's
`money` with the prices and their sources under `prices`, or the caller's `prices` as assumptions;
`ugt_parcel_context` gives the city's rates at the parcel. The 3D panel does not show rent.

The shared sale starting assumption is now 4,000 in both 3D and plan statistics (previously the EUR
plan-statistics dialog used a separate 5,000). Unsupported currencies no longer borrow EUR land
rates. The UK table no longer carries England-median placeholders: a UK city outside England has no UK land
rate. English cities other than London and Birmingham keep the editable sale and construction
assumptions.

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
| Economic unit rates | Per-area tables (UK land appraisal, ONS rents), London viability study, assumptions, local imported rates | No general live market or assessment feed yet |
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
construction indices and development fees are useful economic additions, but an index is not
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
