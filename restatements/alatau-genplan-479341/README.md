<!-- One district of Alatau's general plan (Decree No. 727, 2025) restated as a block layout, a road in its street ground and parks, with the zone snapshot it is built from. -->

# Alatau general plan (2025) · district around block 479341

A restatement of a **published plan** for one district: the general plan of Alatau (Almaty region,
Kazakhstan) as corrected by Decree of the Government of the Republic of Kazakhstan No. 727 of
9 September 2025. The plan is not built here: the ground is open fields and large registered
parcels. The designs show the plan's layout; they do not establish that it will be built as drawn.

## Sources

| Item | Value |
| --- | --- |
| Plan | Генеральный план г. Алатау, корректировка; Постановление Правительства РК № 727 от 09.09.2025 ([main provisions](https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf), [main drawing](https://primeminister.kz/assets/media/prilozenie-2-rus-727.pdf)) |
| Zones | The plan's functional zones in the state urban-planning cadastre, `https://map.gov4c.kz/ggkgs/ows`, WFS layer `kz:gpzone`, read through the app's planning source `alatau-genplan-727` ([source contract](../../docs/alatau-genplan-source.md)) |
| Read | 23 November 2026, through the local API (`GET /planning/representations` and `GET /planning/record`) |
| Parcels | `kz-alatau-pkk`, the national public cadastral map (EGKN PKK) |

There is no detailed plan (ПДП) for this area: `kz:pdpzone` holds no Alatau zones.

## The district

The block containing 43.7979° N, 77.0891° E (zone **479341**) and the eight blocks around it in
the plan's street grid, which runs at 31.15° to east–west. The district reaches to the centrelines
of the streets that bound the 3×3. The north-west block, **479343**, spans two grid columns with
no street between them, so it is taken whole and the district steps out one column west at that
row. The outline is 491,653 m² (`data/district.geojson`, which records each centreline and the
blocks it lies between).

| Zone | Use (plan) | m² in the district |
| --- | --- | ---: |
| 479336, 479340, 479341, 479343, 479346, 479350, 479492 | Multi-storey housing (6–12 floors) | 268,527 |
| 482147, 482149 | High-rise housing (over 12 floors) | 46,204 |
| 476365, 476370 | Parks and squares | 14,549 |
| 480457, 480511, 480585, 480588, 480589, 480595 | Public and protective greenery | 16,687 |
| 480997 | Roads (the street ground) | 144,431 |

Every zone is marked planned (`implementation` Проектируемые), so each is its own lot
(`landBasis: 'zone'`, [vocabulary: Land basis](../../docs/vocabulary.md)). Two zones cross the
outline and only their part inside is used: green strip 480511 (its southern half; the other
half is across the north street) and the road zone 480997, one 18.7 km² polygon around every
block of the city. The 3×3 holds no education, health or services zone. A 1,254 m² square inside
the green ring 480457 carries no zone; it is left as it is.

`data/zones.geojson` holds the 18 zones (each whole, as the record read returns it, except the
road zone, kept as read in the area around the district), with the source's record version and
fields. `fetch-zones.mjs` re-reads them and recomputes the outline.

## Designs

`district-designs.mjs` builds ten designs from the committed data, all for city `alatau`, by the
decree as author:

1. **Block layout** (parcel layout): 18 plots, each a zone polygon (the nine blocks, the eight
   green and park zones, the street ground), tiling the district less the unzoned square. The plan
   lays the land out anew over the fields, so the layout is the plan's land readjustment. Plots
   are geometry; their names (use and zone id, in English) travel in the description, in plot order.
2. **Streets**: one bounded road placed in the street plot ([road in a parcel](../../docs/road-in-parcel.md)),
   drafted by the app's intent builder with automatic lanes per street width. The district edge cuts
   the boundary streets at their centrelines, so those are half streets.
3. **Eight parks**, one per green or parks zone, on its plot, from the same builder with its
   default planting (no trees or furniture).

No buildings and no urban rules: the general plan states use and a storey class only, and those
rules stay with the source layer, whose Permitted massing already draws on these blocks.

Each design's `authoredAt` is the decree's date, 2025-09-09, one millisecond apart in the order
above. The app applies a plan's designs in creation order and breaks ties by local id, which a
plan-file import draws at random, so equal times would apply parks or the road before the layout.

## Files and commands

```sh
node restatements/alatau-genplan-479341/fetch-zones.mjs --api http://localhost:4691   # re-read the zones, rewrite data/
node restatements/alatau-genplan-479341/write-plan-file.mjs                           # alatau-genplan-479341.ugt.json
node restatements/alatau-genplan-479341/build-and-upload.mjs --dry-run                # design objects and CIDs
```

`alatau-genplan-479341.ugt.json` is a portable plan file: import it through Lists → Plans → Import
plan file. Published on 23 November 2026 to `api.urbangametheory.xyz`: the 10 designs and one
community-vote agreement, `bafkreihmrwm7zsys3gf7pxu7o6ruli2jpoqmkjjqww5gisyogllnp6wnka` (plan
`bafkreib3k72tqlwjkmfpopsgwfh772swnygptms7iosjqix5fnade6yzxa`), whose land is
`ground/alatau-genplan-479341.json`: 4 input parcels, 31 outputs (plots 314,731 m², streets
144,432 m², parks 31,236 m²). `backend/test/alatau-genplan-479341-designs.test.js`
checks the zone list, the design counts, that every plot comes from a zone, that the plots tile the
district, and that the plan file holds the builder's CIDs.

## Uncertainty and limits

- The zones are the cadastre's digitisation of the plan, read in November 2026; the decree's drawing
  was not compared with them line by line.
- The district outline is ours: street centrelines midway between facing blocks, measured in the
  grid frame. The plan draws no district.
- The plan sets no lanes. The road's cross-sections are the app's automatic ones for each street's
  width; the plan's streets are 29–32 m, and the avenue on the east side 60 m (half inside).
- About 181,000 m² of the district lies outside the parcel register (open ground); the layout binds
  four registered parcels (03341030011, 03055235003, 03055225492, 03055225453) and that open ground.
- The two parks on green strips 480511 and 480589 lie wholly on open ground, so they bind no parcel.
