<!-- Research notes on public Kazakhstan planning-cadastre layers relevant to Alatau. -->
# Kazakhstan government planning-cadastre layers

## What are `gpzone` and `gpreg`?

### Takeaway
`kz:gpzone` is the functional-zoning layer used by the app. `kz:gpreg` is not another set of broad planning zones: its current Alatau records explicitly label themselves `Красные линии` (red lines), the legally defined boundaries between blocks or similar planning units and streets, access roads or squares.

### Cited Findings
- The Kazakhstan Construction Code defines red lines as boundaries separating quarters, microdistricts and other planning elements from streets, drives and squares; they regulate building boundaries. [Construction Code](https://adilet.zan.kz/rus/docs/K2600000253/compare/eng)
- The public `kz:gpreg` WFS schema has plan-decision number/date, administrative territory, name/legend fields and MultiPolygon geometry. A bounded public read for Alatau returned 2,691 matching features, all carrying Decree No. 727, date 2025-09-09 and `name`/`name_usl` = `Красные линии`. [WFS GetCapabilities](https://map.gov4c.kz/ggkgs/ows?service=WFS%26request=GetCapabilities%26version=2.0.0)
- The separate `kz:gpzone` schema carries functional use, existing/planned implementation and general-plan zone group. A current public count for Alatau is 6,659 features. [WFS GetCapabilities](https://map.gov4c.kz/ggkgs/ows?service=WFS%26request=GetCapabilities%26version=2.0.0)
- Kazakhstan's planning rules require a detailed plan to establish red and yellow lines, building-regulation lines and infrastructure reservations; general-plan materials also include a `gp_red_lines_line` map layer. [Planning-project rules](https://old.adilet.zan.kz/rus/docs/V2600038632)

### Inferences
- The WFS publishes red lines as MultiPolygons, although the legal object is a boundary. The first Alatau features are narrow/elongated polygons, consistent with mapped street-corridor or boundary-area representation. Their schema does not say whether each polygon is a carriageway reservation, a buffered boundary, or a block-side area, so the app should not treat their outer edge as a precise setback or road centreline without validating it against the approved drawing.
- They are valuable as a visual and geometric constraint: a proposed block or parcel envelope should be able to show where the plan reserves the public street-side structure. They are not sufficient to calculate a building envelope by themselves: they contain no width, setback, height, FAR, coverage or legal building-line attribute.

### Gaps
- I found no public documentation that specifies the exact geometric convention used by this `gpreg` implementation (line centre, corridor, parcel-side boundary, or polygonized blocks). That must be checked against the Decree 727 GIS source/drawing before automated clipping or street generation.

## What else does the government publish?

### Takeaway
The public map exposes more than functional zones: cadastral parcels, planning records, red lines, selected utility-service areas and a building-footprint layer. Availability is uneven; the service's public layer list is evidence of an endpoint, not proof that every layer has complete or usable Alatau attributes.

### Cited Findings
- The public cadastral-map service describes openly available layers as parcels (including arrests), available plots, land-value zones, cadastral quarters, soil/pasture/agricultural maps, master plans, detailed plans including red lines/functional/protection zones, building records, orthophotos, digital duty plans, satellite-monitoring results and utility-service zones in six named cities. [Public cadastral map service](https://www.gov.kz/services/4009?lang=ru)
- The currently reachable public planning WFS advertises these feature types: `gpzone`, `gpreg`, `pdpzone`, `pdpreg`, `building_blocks`, and utility-supply zones for electricity, faecal sewerage, gas, heat, phone, sewerage and water. [WFS GetCapabilities](https://map.gov4c.kz/ggkgs/ows?service=WFS%26request=GetCapabilities%26version=2.0.0)
- `pdpreg` has decision number/date and detailed-plan name fields; `pdpzone` has functional use, existing/planned state and detailed-plan name. A current public Alatau query returns zero matches for `pdpzone` and `pdpreg`. [WFS GetCapabilities](https://map.gov4c.kz/ggkgs/ows?service=WFS%26request=GetCapabilities%26version=2.0.0)
- `building_blocks` has 2D geometry plus project/fact fields for year, gross/built-up/residential/non-residential areas, volume, parking, storeys and height. A bounded 0.6° × 0.6° request around Alatau returned 30,126 records, but the first ten had almost all descriptive fields null; this is not an exact administrative-Alatau count because the layer lacks an administrative-territory field. [WFS GetCapabilities](https://map.gov4c.kz/ggkgs/ows?service=WFS%26request=GetCapabilities%26version=2.0.0)
- The Ministry reported in March 2026 that 89 master plans and 647 detailed plans had been supplied for partial digital completion in the national urban-planning-cadastre system. [Ministry update](https://www.gov.kz/org/mps/press/news/details/1185067?lang=ru)

### Inferences
- `building_blocks` is a potentially useful official 2D built-footprint source, and some records may contain storeys or height. The sampled Alatau-area records lack those values, so it is not currently evidence of a usable official 3D city model there.
- A zero result in `pdpzone`/`pdpreg` establishes that this public WFS currently exposes no Alatau PDP features. It does not establish that Alatau has no approved detailed plans; unpublished, not-yet-digitised or access-controlled plans remain possible.

### Gaps
- The public service description does not provide a layer-by-layer completeness, update date, licensing statement or Alatau coverage statement. Any operational import should first sample the specific area and retain source date/attributes.
- I did not establish which of the seven utility WFS layers has Alatau coverage or a meaningful service-capacity attribute; their mere presence in capabilities is insufficient for a feasibility conclusion.

## What is integrated now?

### Takeaway
Only `gpzone` is integrated into the app's `alatau-genplan-727` Permitted source. `gpreg`, `pdp*`, utility layers and official building blocks are discovered data, not current inputs to a rule or massing calculation.

### Cited Findings
- The application source specifies `kz:gpzone` as its live general-plan layer and reads its functional zone, zone group and existing/planned fields. [Alatau source contract](../../alatau-genplan-source.md)
- The source contract says it derives residential storey/height limits only from general-plan labels, records the 3.0 m storey height as an assumption, and derives no setbacks, coverage or density limits. [Alatau source contract](../../alatau-genplan-source.md)
- The source contract records that the companion `gpreg` rows are Decree 727 red-line records and that public `pdpzone`/`pdpreg` had no Alatau records at the time of the original integration. [Alatau source contract](../../alatau-genplan-source.md)

### Inferences
- A worthwhile next integration is a read-only `gpreg` layer rendered with the functional zones, followed by a validated red-line constraint adapter if the approved drawing confirms its geometric meaning. It should not be presented as a parcel setback calculation until that validation exists.

### Gaps
- No source currently connects a red-line feature to a specific parcel-study result, and no current interface exposes the government building-block records or utility-service zones.
