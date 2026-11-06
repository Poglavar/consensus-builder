<!-- The 1971 detailed urban plan of the Travno housing estate (DUP Travno), read off the City of Zagreb's scanned sheet and restated as Consensus Builder designs with one agreement. -->

# DUP Travno (1971)

A restatement of a **published historical plan**: *Detaljni urbanistički plan stambenog naselja „Travno“ u Južnom Zagrebu*, adopted in SGGZ 11/72 (in force from 27 June 1972; amended UP 6/74, 8/77; no recorded repeal). The restated sheet is *Plan visina izgradnje, broja i strukture stanova*, 1:1000, dated 7 September 1971 (ing. arh. Miroslav Kollenz, ing. arh. Jesenka Kollenz, prof. Dragan Boltar). The designs show the plan as drawn. They do not show what was built, and nothing here establishes that the plan was implemented as drawn.

## Sources

The City of Zagreb geoportal (`geoportal.zagreb.hr`, map theme `Karta?tk=6`, catalog *Prostorni planovi → PUP/DUP*) publishes 76 pre-1990s implementation plans (PUP/DUP, the predecessors of today's UPU) in three forms:

| Form | What it is | Endpoint (through the geoportal's own proxy, `handlers/WMS/WMSHandler.ashx?tip=…&h=…`) |
|---|---|---|
| Sheet raster | One georeferenced greyscale scan per plan, mosaicked from several sheets, served by GeoServer as WMS in EPSG:3765; legible text at 0.2 m/px | layer `DUP_Travno` (catalog type 143); the proxy hash is issued by `handlers/Catalog/Catalog.ashx?tk=6` |
| Boundaries + register | Vector polygon per plan with name, sheet type, year, SGGZ acts, validity dates and the PDF name | WFS `GetFeature` on layer `PUP_DUP_status` (catalog id 1806); the same through `handlers/WFS/WFS.ashx` (Identify) |
| PDF | The whole uncropped sheet as one embedded JPEG (4252 × 2264 px, ~0.29 m/px), including the title block, stamps and both tables | `https://geoportal.zagreb.hr/Temp/<naziv_pdf>`, e.g. `Temp/DUP_Travno.pdf` |

The sheets are raster only. There are no vector buildings, zones or roads. The PDF holds the same scan at a lower resolution than the WMS, plus the legend tables the WMS mosaic crops away.

## Reading the sheet

`extract-plan.py` reads the plan's boundary and register entry (`data/obuhvat.geojson`) and the sheet's WMS tiles at 0.2 m/px. It then extracts the buildings into `data/buildings.geojson` (EPSG:3765).

- **Tone is height.** This sheet is a *plan of heights*. A double median filter removes the drawing's lines, hatching and text and leaves the tinted building masses. Dark and mid tones carry the labelled height of a tower or slab. The light tone is ground-floor mass, the same tone as the buildings labelled `P, 4 m`. Built heights in the GDI 3D model agree: the light-tone areas next to slabs measure 3–9 m and the slabs 26–29 m. Mamutica is the exception. Its mid tones are low podium (8–12 m built), so only its dark core takes 66 m (`toneHigh` in its claim).
- **Claims.** `data/claims.json` holds one box per building, read by hand off the sheet, with the building's label and, for housing, its flats from the sheet's table *Pregled broja i površina stanova po stambenim blokovima*. The extractor takes the masses inside each box; boxes are processed in order and never share a pixel.
- **Labels.** `P–20, 64 m` is P+20 (21 storeys; the table counts 20 flat floors per tower). `PRIZ. + 8 KATOVA, 28 m` is P+8. `P+I` is two storeys. The function of public buildings is not on this sheet, so they are named by position and label only.
- **Check.** The transcribed table adds up to the sheet's own totals: 3,830 flats and 291,400 m² of net flat area (`backend/test/dup-travno-designs.test.js`). The towers' modelled gross area is 0.78 × net. In the slabs and Mamutica the ratio is 0.31–0.48, because their net area excludes corridors, ground floors and podiums.

| Block | Label | Flats | Net flat area |
|---|---|---:|---:|
| 1a–1i (9 towers) | P–20, 64 m | 160 each | 9,360 m² each |
| 2 | P+8, 28 m | 272 | 27,584 m² |
| 3a, 3b | P+8, 28 m | 264 each | 24,984 m² each |
| 4 | P+8, 28 m | 110 | 10,028 m² |
| 5 | P+8, 28 m | 198 | 19,392 m² |
| 6 (Mamutica) | P+20, 66 m | 1,282 | 100,188 m² |

The sheet's second table gives 8,610–12,440 residents, about 10,525 on average.

## Plan and built state

The sheet's georeference matches today's DGU footprints to 2–6 m. The offset is not one systematic shift. Towers 1a–1d and 1f sit about 2 m off their built parcels, and the slabs differ in shape, so the drawn geometry is kept as drawn. In outline, the nine towers, slabs 2, 3a, 3b, 4, 5 and Mamutica were built. The three twin-round 14 m buildings, the north-west group and the south-west winged complex have no built counterpart. The central and east complexes and the three ground-floor pavilions stand as buildings of other shapes (DGU footprints, November 2026).

## Designs and agreement

`travno-designs.mjs` builds the designs from the committed data only. Every building is a freeform building (`goal: 'single'`, no authored site) whose footprint is its own land, which is how the plan's era parcelled Travno: a tower's cadastral parcel is the tower. A freeform building replaces the parcels it binds, so buildings that bind a common parcel must be one design. `record-bindings.mjs` records each building's binding with the design index's own `computeBinding` (tolerance 0, local cadastre) in `data/bindings.json`. The large estate parcels are touched by most footprints, so the plan comes out as six designs, one of them holding twelve blocks and eight public buildings. Published as one community-vote agreement, *DUP Travno (1971)*: 76 input parcels, 80 output pieces (`ground/dup-travno.json`).

The sheet's dashed lines are the plan's own building plots (*crtkana linija … predstavlja limes građevinskih odnosno katastarskih čestica*). Tracing them as a parcel layout would let each block be its own design on its own plot; that is not done yet. Streets, parking and green space are not restated: the sheet shows them only as linework and the streets were built.

```sh
python3 -I restatements/dup-travno/extract-plan.py --all          # boundary, sheet tiles (cached, gitignored), buildings
node restatements/dup-travno/record-bindings.mjs --compute         # local cadastre → data/bindings.json
node restatements/dup-travno/build-and-upload.mjs --dry-run
node restatements/dup-travno/build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
node restatements/dup-travno/build-and-upload.mjs --capture --app <app> --api <api>
node restatements/dup-travno/build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply
```

`extract-plan.py` also writes `data/overlay.png` (the claims and the extracted parts drawn on the sheet), for review.
