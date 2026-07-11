<!-- Investigation and implementation proposal for grade-separated road and rail corridors. -->

# Corridors on levels −1, 0 and +1

## Recommendation

Add a vertical profile to the corridor centreline, while keeping the existing 2D footprint as its horizontal projection. A user chooses `−1`, `0` or `+1` before placing the next point. A segment between points on the same level is flat; a segment between different levels is a ramp. Reject the click when the ramp is shorter than the selected corridor type permits.

This cannot be a visual-only property. The vertical profile must control:

- drawing validation and previews;
- 2D colour/tint and intersection symbols;
- the height of the 3D corridor mesh;
- whether a crossing is a junction or a grade-separated crossing;
- which part of the projected footprint cuts surface parcels.

## What exists today

The current model is deliberately two-dimensional:

- `road-drawing.js` stores centreline points as `{lat, lng}` and incrementally buffers each new edge;
- `proposals/create.js` stores `definition.points`, `segments`, `profile`, `width` and one 2D `polygon`;
- `proposal-manager.js` subtracts that entire polygon from every affected parent parcel;
- `corridor-profile.js` offsets the centreline into 2D cross-section strips and finds junctions in plan;
- `three-mode.js` converts those strip polygons to flat `ShapeGeometry` at one fixed Z value;
- the realistic Cesium view currently renders proposed buildings, but not corridor cross-sections.

Consequently, merely adding `level` to the UI would still cut surface parcels under bridges and above tunnels, create false at-grade junctions, and render the road flat in 3D.

## Proposed data model

Keep the level on every centreline vertex. Preserve `lat` and `lng` for compatibility.

```json
{
  "points": [[
    { "lat": 45.81, "lng": 15.97, "level": 0, "z": 0 },
    { "lat": 45.81, "lng": 15.971, "level": 1, "z": 6 }
  ]],
  "verticalProfile": {
    "version": 1,
    "levelHeightM": 6,
    "gradePreset": "road",
    "surfaceThresholdM": 0.75
  },
  "polygon": { "type": "Polygon", "coordinates": [] }
}
```

- `level` is the user's semantic choice (`−1`, `0`, `+1`).
- `z` is the derived height in metres relative to local ground and makes shared proposals deterministic.
- `levelHeightM` defaults to 6 m. It provides roughly 5 m of useful clearance after allowing for deck thickness; it must remain configurable rather than claiming to certify a structure.
- Old proposals without a vertical profile normalize every point to `level: 0, z: 0`.
- The 2D `polygon` remains the complete horizontal projection for thumbnails, hit testing and spatial-impact discovery. It is no longer automatically identical to the surface parcel cut.

Do not encode Z only as a third GeoJSON coordinate. Too many existing normalization paths reconstruct `{lat, lng}` and would silently discard it; an explicit versioned profile is easier to validate and migrate.

## Drawing interaction

Add a three-button level control to the existing road/track drawing panel:

`−1 Ispod zemlje` · `0 Površina` · `+1 Iznad zemlje`

The active choice applies to the next placed point:

1. A first point starts at the selected level; default is 0.
2. Selecting another level changes the next point's target Z.
3. The preview shows the ramp and its current length and grade.
4. A click below the hard minimum distance is not committed. The preview is red and states, for example, `Za uspon od 6 m treba još 23 m (najveći nagib 8 %).`
5. Undo, seeded editing, draft autosave, copying and sharing preserve `level` and `z`.

Use the existing projected-metre distance functions. For a height change `|Δz|` and maximum grade `g`, the hard minimum horizontal length is `|Δz| / g`.

### Initial presets

| Corridor | Design target | Hard limit | Minimum for one 6 m level |
|---|---:|---:|---:|
| Road | 6% | 8% | 75 m hard; recommend 100 m |
| Conventional railway | 1.25% | 3.5% for a short exceptional ramp | 171 m hard; recommend 480 m |
| Tram/light rail (future subtype) | 6% | 8% | 75 m hard; recommend 100 m |

The hard limits should be configuration, not buried constants. The existing generic `track` tool does not distinguish conventional rail from tram/light rail, so it should initially use the conservative conventional-rail preset and display the preset beside the speed/radius control. A later track-subtype selector can enable the tram preset.

These are planning defaults, not an assertion that a generated design is construction-ready. Croatia's road rules make road class important and call for climbing-lane analysis above 4–5% in relevant cases ([NN 110/2001](https://narodne-novine.nn.hr/clanci/sluzbeni/2001_12_110_1829.html)); comparable DMRB design values are 3–6% desirable and 4–8% relaxed depending on road class ([CD 109](https://www.northwarks.gov.uk/downloads/file/1364/cd-109-revision-1-highway-link-design-web-8-)). Croatian railway rules specify 12.5 mm/m for new mixed/freight lines of international or regional significance ([NN 128/2008](https://narodne-novine.nn.hr/clanci/sluzbeni/full/2008_11_128_3670.html)); the current EU infrastructure TSI is [Regulation 1299/2014](https://eur-lex.europa.eu/eli/reg/2014/1299/oj/eng), with exceptional passenger-line cases reaching 35 mm/m under envelope conditions. This is why the presets must be selectable and visible to the user.

## 2D representation

Keep the lane colours from the cross-section and apply a level overlay per edge:

- level 0: unchanged;
- level +1: amber edge/tint with short bridge-pier ticks;
- level −1: violet-blue tint, lower opacity and a dashed tunnel outline;
- transition: a colour interpolation plus an uphill/downhill arrow and grade label.

The horizontal footprint remains clickable. Render the level overlay in the same high pane as the cross-section so parcel shading cannot cover it. At crossings, draw a junction/crosswalk only when the two sampled Z values differ by less than a small tolerance (proposed: 0.5 m). Otherwise draw a compact bridge or tunnel crossing symbol and do not merge the road surfaces.

## Actual 3D geometry

The current flat `ShapeGeometry` cannot represent a ramp. Add a corridor ribbon-mesh builder that:

1. projects and resamples each centreline edge at a bounded interval;
2. interpolates Z along the edge;
3. computes left/right offset vertices for every cross-section span;
4. joins consecutive pairs as triangles;
5. raises kerbs, symbols, trees, rails and junction markings relative to the local ribbon Z.

This produces one continuous mesh for every cross-section strip. The first implementation can use linear ramps; a subsequent pass should introduce vertical curves at grade changes so vehicles do not encounter an instantaneous pitch change.

In abstract 3D, Z is directly relative to the flat ground plane. In realistic Cesium mode, sample terrain along the resampled centreline and add the proposal's relative Z before building corridor primitives. This is new work because `photoreal-mode.js` currently adds proposed buildings only.

For level −1, render terrain/parcel ground semi-transparent or provide a `Prikaži podzemno` toggle; otherwise a correct tunnel mesh will be invisible by design. Bridges should eventually gain piers and tunnel portals, but those are decorations and should follow the core ribbon implementation.

## Parcel-intersection model

Use two separate footprints:

- `spatialImpactFootprint`: the full 2D projection, used to find affected owners, select the proposal and communicate air/subsurface impact;
- `surfaceImpactFootprint`: only the part that changes the cadastral surface, used by the current `turf.difference` parcel-cutting path.

Recommended first rule:

- level 0 cuts parcels exactly as today;
- ramps and portals cut parcels while their absolute Z is below the configured surface-separation threshold, or when explicitly marked `open-cut`/`embankment`;
- a fully elevated or bored-tunnel section does not cut or split surface parcels;
- all horizontally intersected parents remain listed as affected by the proposal, but only surface-cut parents produce remainder child parcels;
- parcel blocks are split only by continuous level-0 public-road sections, not by an overpass or tunnel.

The continuous road/track should therefore become a proposal-owned corridor asset, not be inferred solely from the existence of a 2D road parcel. Surface pieces may still create road parcels. Elevated and underground pieces remain selectable through corridor hit targets and carry spatial-right records in the proposal.

Later iterations can add explicit footprints for bridge piers, abutments, portals, shafts, cut-and-cover works, easements and construction zones. Those should be separate impact components rather than forcing the full deck or tunnel projection into the surface cadastre.

## Building passages before general elevation support

A useful level-0 subset can ship independently: prepare existing-building footprints when the drawing tool opens, include applied proposed-building footprints, and do not immediately commit a newly clicked road/track edge that overlaps either. Offer `Tunnel through` or `Choose another route`. An accepted edge stores endpoint-based `kind: "building"` tunnel metadata, so reversing a track or continuing a copied corridor does not change its identity. Cities without a supported building-footprint source cannot offer collision-aware passages.

The applied 2D map should show that edge with a purple dashed liner and portal marks. Abstract 3D can show a tunnel liner and portals, but a visually and geometrically correct opening through arbitrary city-model buildings requires a later building-mesh operation. Proposed extruded buildings and imported face meshes need different cutting strategies; tunnel metadata should therefore remain the common source of truth rather than baking the passage into one renderer.

## Implementation order

1. **Schema and pure math:** normalization, grade calculation, minimum-length validation and backwards-compatibility tests.
2. **Drawing UX:** level buttons, coloured preview, rejected short clicks, undo/copy/draft/share round trips.
3. **2D applied rendering:** per-edge level overlays and Z-aware junction classification.
4. **Abstract 3D:** ribbon meshes, elevated decorations and underground visibility toggle.
5. **Surface impact:** derive and persist both footprints; cut only the surface footprint; add mixed-level apply/unapply tests.
6. **Realistic 3D:** terrain sampling and Cesium corridor primitives.
7. **Structural detail:** portals, bridge supports, vertical curves and explicit spatial rights.

## Required regression cases

- An old road proposal behaves exactly as a level-0 proposal.
- A 6 m road ramp rejects 74 m and accepts 75 m at the 8% hard preset.
- Undo, reload, copy and share preserve every vertex level.
- A +1 crossing over a level-0 road creates no junction or crosswalk.
- Two level-0 branches retain the current junction and pedestrian crossings.
- A fully elevated corridor affects owners but creates no remainder parcels and does not split a block.
- A mixed 0/+1/0 corridor cuts only its surface-impact sections and fully restores on unapply.
- Road and track ramps are visibly sloped in abstract 3D; underground segments are inspectable.

## Decisions still needed before implementation

1. Does `track` mean conventional railway by default, or should the subtype selector be part of the first slice?
2. Should ±1 always mean ±6 m, or should level height be editable per proposal?
3. Should a ramp's whole projected footprint be a surface acquisition, or only the part within the separation threshold plus explicit structural footprints?
4. For the MVP, are affected air/subsurface rights proposal metadata only, or should they appear as a new kind of 3D parcel/right in parcel details?
