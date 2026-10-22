<!-- This folder preserves the source-derived geometry, the committed corrections and the reproducible design builder for UPU Borovje – zona jug, and publishes it as designs plus one agreement. The committed GeoJSON and correction files are the canonical reconstruction artifacts. -->

# UPU Borovje – zona jug → consensus-builder designs and agreements

Recreates the real Zagreb city plan **"UPU Borovje – zona jug"** (public
consultation 23.6.–22.7.2026, [experience](https://experience.arcgis.com/experience/bf96116622ca4cdebf37e98c1d04880f/))
as consensus-builder designs and one agreement over them, programmatically.

The city publishes the plan as **georeferenced raster tiles** (ArcGIS hosted, max
LOD 19 ≈ 0.30 m/px) plus a vector cadastral-extent FeatureServer and PDF
provisions. `extract-plan.py` vectorizes the rasters; `borovje-designs.mjs` turns the geometry and the
committed corrections into design records; `build-and-upload.mjs` and `build-urban-blocks.mjs` publish
them through [`backend/scripts/lib/restatement-publish.mjs`](../../backend/scripts/lib/restatement-publish.mjs).

Archive provenance: the tracked extraction files were imported from branch `upu-borovje` at
commit `9828995` on 2026-08-11. Its separate worktree remains intact because that branch has not
been merged into `main`.

## Pipeline

Run these commands from this folder:

```
python3 extract-plan.py --step all      # tiles → data/*.geojson (+ overlay-*.png diagnostics)

node build-and-upload.mjs --dry-run     # the official plan's 22 design objects and CIDs (+ the agreement CID once captured)
node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
node build-and-upload.mjs --capture --app <app> --api <api>                     # → ground/upu-borovje.json
node build-and-upload.mjs --agreement --api <api> [--origin <app>] --app <app> --apply

node build-urban-blocks.mjs --dry-run   # the same for "Borovje – urbani blokovi" → ground/borovje-urbani-blokovi.json
```

Every step builds the designs from the committed files only: `data/*.geojson` through
`plan-topology.mjs` (the ground mesh) and `flat-plan.mjs` (the buildings fitted to their plots) give version
1, and the committed corrections `data/cadastral-snap.json` (version 2) and `data/streets-fit.json`
(version 3) are replayed onto it in order. The published designs are the current version 3; nothing
reads a database or a stored record. `--designs` pins and indexes every design except the three parcel
layouts, which are pinned and travel with the agreement; `--capture` applies the designs in the running
app (agent-browser) and commits the land it derives to `ground/<plan>.json`; `--agreement` publishes
the agreement from that file and refuses a stale one (recapture after any change to the designs).
Rerunning a step publishes nothing new: the same content is the same CID, and progress is
checkpointed in `~/.config/ugt/restatements/<api host>/`.

## What gets extracted (committed in `data/`)

| File | Source | Content |
|---|---|---|
| `parcels.geojson` | FeatureServer (vector) | 178 parcels, KO Žitnjak (335550), with app `parcelId` `HR-335550-<broj>` |
| `buildings.geojson` | sheet 4 raster | 12 building envelopes M1-1…M1-12, named via `kazete-mapping.json`, floors from PP rules |
| `zones.geojson` | sheet 1 raster | 5× Z1 park + 1× R2 recreation, planar-partitioned along drawn boundary lines |
| `streets.geojson` | sheet 2a raster | 6 named road axes (collector + crossings), junction vertices shared |
| `parcelation.geojson` | sheet 1 raster | 20 new-parcel slices (građevne čestice per kazeta, parks, streets) |
| `parcel-fixes.geojson` | local parcel DB | current cadastre where the UPU snapshot is stale (4304 → 4304/1…/6) |

The six GeoJSON files above are committed in this folder as the canonical reconstruction geometry; the
corrections (`cadastral-snap.json`, `street-footprints.json`, `streets-fit.json`) are committed beside
them, keyed by the design keys of `borovje-designs.mjs`.

## What gets created in the app

The official plan, **UPU Borovje – zona jug**, is 22 designs (all dated 23 June 2026, the plan's public
draft) and one agreement over them, in this order:

- **2 street designs** (`ulice`, `ulice-zapad`) — 6 named centerlines extracted from **sheet 2a (Prometni i
  komunikacijski sustav)**, which draws the roads explicitly: the collector is the red-hatched planned-road
  band (centerline smoothed to eleven vertices / ten edges while retaining its broad curve), the IS-1/IS-2
  crossings are clean colored cells (straight PCA axes). Crossing endpoints are junction vertices in the
  collector polyline. Per-class cross-sections: SP 19 m (lanes + cycleway + sidewalks + verges), IS-1 18 m
  shared surface, IS-2 9 m pedestrian. Each street's land is exactly the ground its lanes cut (version 3).
- **3 parcel layouts** (`parcelacija-1`, `-2`, `-3`) — the road network divides the non-road plan into three
  disconnected blocks, so each block is its own layout with its pool and plots, geometry only. Together they
  hold the 17 real plots: one per M1 building area, park or recreation zone; the description of each layout
  names its plots in plot order.
- **11 building designs** (M1-1…M1-11; M1-12 is the existing housing row, kept as-is by the plan, so
  nothing is generated). Heights = floors × 3.5 m per the plan's provedbena pravila: PP-1 P+3, PP-2 P+4,
  PP-3 P+8 (tower), PP-4 P+5. Each is content on its plot (`goal: buildings`, typology `single` for the
  geometry editor): it never takes ground of its own.
- **6 park designs** (5× Z1 + the central R2 recreation zone — modeled as a park until a dedicated
  playground/sports-field structure kind exists), each exactly its plot.

The agreement is a community vote with no lens, money, allocations or deadline; its inputs and outputs are
the land the app derives when it applies the 22 designs (`ground/upu-borovje.json`).

**Borovje – urbani blokovi** (`build-urban-blocks.mjs`, authored by Urban Game Theory on 10 October 2026) is
an alternative on the same eleven building plots: the same street, layout and park designs (the same CIDs,
so they are published once) with an open urban block on each plot instead of the plan's free-standing slab —
a 12 m deep ring along the plot edge with its park-facing middle left out, so the building holds the street
and both ends and its yard opens onto the park; six storeys along Tigrovi and Bonde, five inside. It is 22
designs and its own agreement.

## Extraction notes

- Building envelopes: grey-fill segmentation + Moore boundary trace + RDP;
  near-rectangular shapes snap to min-area rectangles (IoU ≥ 0.88).
- Zones and corridors: **planar partition** — the drawn boundary lines (plus the
  parcel-union obuhvat clip) partition the sheet into cells, classified by hatch
  color measured on the eroded cell interior (hatch bleeds across thin lines).
- Georeference verified against the vector parcels: alignment ≈ 0.3 m.

## Version 1: the plan as drawn

`plan-topology.mjs` takes the plan extent from the union of `parcelation.geojson`, gives the roads their
official IS cells plus their regular-width corridors, folds fragments under 150 m² into the road or the
neighbouring plot, and returns one parcel layout per connected non-road block; it refuses a mesh with a gap,
overlap or area outside the extent, a broken plot or a block without plots. `flat-plan.mjs` fits every
traced building into its plot: only M1-9 (34.8 m², 5.8 %) and M1-11 (25.5 m², 1.1 %) lose an edge, and a
building that would lose more than 10 % or split is refused.

## Version 2: cadastral boundary

The first reconstruction took the plan's outer boundary from the traced sheet, and the trace sits 2.4–3.3 m
outside the drawn boundary line all the way round. Every neighbouring parcel lost a jagged strip to the plan
(48 cadastral parcels were cut, most of them private gardens south of the collector), and the collector's
centre line ran along the southern edge of its band, so its 19 m cross-section took the gardens as well.
The drawn boundary follows parcel lines, so `snap-to-cadastre.mjs` rebuilds the extent from whole parcels:

- a parcel is in when the plan holds its body, out when the plan only holds a strip of it;
- only parcels the plan genuinely divides (the city parcel 1791/69, the old road 4302/4, 1908/1, …) keep a
  cut, along the traced line moved 3 m back onto the drawn one and straightened;
- plots, street land and parks lose the strips; the existing housing row M1-12 keeps its own parcel line;
- the collector is re-centred in its band (plan sheet 2a draws it with its axis down the middle), and the
  crossings that end on it move with it;
- where the band is narrower than the 19 m profile (it pinches to 14.7 m where the boundary steps in around
  the tip of 1914/1), the collector narrows: that 51 m stretch is its own segment, 13.5 m without the verges;
- the compute refuses to write if a street's lanes run onto a parcel its land does not reach. A street takes
  exactly its land polygon (the parcels it binds are derived from that polygon); its lanes are drawn from the
  centre line and profile, so lanes beyond its land are drawn over ground it does not take. Where the
  collector meets the city streets at its ends its lanes run on onto them; that is reported as a join
  (1823/8, Letovanićka ulica) and left as it is.

```
node snap-to-cadastre.mjs --compute     # version 1 (borovje-designs.mjs) + the local cadastre → data/cadastral-snap.json
```

The geometry is computed once in local PostGIS (only `public.parcel` is read) and committed; the cadastre it
was computed on is identical on production for every parcel the plan touches (checked 2026-10-10). It changes
the three layouts, both streets and parks Z1-1 and Z1-5. Result: the extent goes from 73,635 to 69,983 m²,
the street binds 15 parcels instead of 49, and its cross-section leaves the extent by 40 m² instead of
1,160 m², all of it over land the street takes, apart from the 23 m² where its lanes meet Letovanićka ulica
(1823/8).

## Version 3: streets take exactly their lanes

A street is one thing: its land is the ground its lanes cut, as when it is drawn in the app. The
reconstruction had instead prepared each street's land from the plan's road band and drawn the lanes inside
it, narrower in places and wider in others. `fit-streets.mjs` makes both streets take exactly the footprint
the app cuts for their lanes (`corridorSurfaceFootprintForDefinition`, captured from the running app in
Zagreb, since the builder measures in the city's projection). The band the lanes do not use goes to the
plot beside it, so the plots meet the street; where its only neighbour is the plan's edge (between the
collector and the gardens south of it) it is not taken and stays with its city parcel.

```
node fit-streets.mjs --capture --app <app url> [--api <api>]   # version 2 streets → data/street-footprints.json (agent-browser)
node fit-streets.mjs --compute                                 # version 2 + footprints + local cadastre → data/streets-fit.json
```

Result: street land 16,501 → 13,376 m²; eleven plots change (most by a sliver where lanes crossed them; M1-3,
M1-5, M1-6, M1-9 and R2 grow by 110–860 m² to meet the street); 1,525 m² stays with its cadastral parcel. The
collector now also cuts the 23 m² of Letovanićka ulica (1823/8) its lanes run onto. It changes layouts 1
and 2, both streets and parks R2, Z1-2 and Z1-3.

A corrected design is a new design object, so a new CID: the corrections are folded into the published
designs, and the earlier versions exist only as the steps of this builder.
