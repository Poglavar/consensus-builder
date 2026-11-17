# Global 3D building sources

## Which sources give Alatau actual 3D buildings?

### Takeaway
The strongest open candidate is GlobalBuildingAtlas (GBA): it publishes a global, individual-building LoD1 model with predicted heights, which includes Kazakhstan by its stated global coverage. It is an extruded footprint, not a surveyed or textured model, and its LoD1/height parts are CC BY-NC 4.0, so it cannot be adopted for a commercial product without resolving the licence. Overture and Microsoft improve footprint coverage but do not establish usable measured heights for Alatau.

### Cited Findings
- GBA publishes global individual-building polygons, 3 m height maps and LoD1 models; its publication reports 2.68 billion LoD1 instances, over 97 % height completeness, and continent-level height RMSEs of 1.5–8.9 m. Heights are machine predictions from PlanetScope satellite imagery, so this is a plausible existing-context layer rather than survey-grade evidence for a permit or engineering decision. — [GBA publication](https://essd.copernicus.org/articles/17/6647/2025/essd-17-6647-2025.html)
- GBA's authors' repository says all countries and territories are intended to be included, provides WFS and downloadable data, and warns that its ML-derived heights can be wrong or buildings missing. The public WFS returned HTTP 403 during this review, so a point-level Alatau sample could not be read from it. The peer-reviewed data paper identifies this repository and its TUM dataset record as the primary code and data references. — [authors' GBA repository](https://github.com/zhu-xlab/GlobalBuildingAtlas), [data paper](https://essd.copernicus.org/articles/17/6647/2025/essd-17-6647-2025.html)
- The LoD1 models and height maps are CC BY-NC 4.0; only the ODbLPolygon component is ODbL. GBA explicitly warns that combining the parts can create licence implications. — [authors' GBA repository licence notice](https://github.com/zhu-xlab/GlobalBuildingAtlas)
- Google’s current country table lists Kazakhstan with no availability for the separate Maps 3D JavaScript/Android/iOS product. This table does not itself establish Photorealistic 3D Tiles coverage. Google directs Tile users to its Map Tiles coverage information, and the only conclusive check for Alatau is an exact-point tileset request with a valid project and session token. — [Google country table](https://developers.google.com/maps/coverage), [Photorealistic Tiles documentation](https://developers.google.com/maps/documentation/tile/3d-tiles-overview)

### Inferences
- A limited, clearly labelled GBA experiment could give Alatau an immediate 2.5D existing-building context where its predicted shapes and heights look credible, but it would neither replace parcel data nor support rule evaluation.
- We should not call any GBA extrusion an official 3D city model. Its height error range is too broad for that statement, and the dataset does not carry roof form, facade texture or building use.

### Gaps
- A successful read of GBA’s current WFS/download slice at the Alatau test coordinates is still needed to prove its actual local feature count and visual quality.
- The CC BY-NC terms preclude using GBA as an ordinary product source until the intended UGT use is assessed against its non-commercial restriction.

## What do Overture and Microsoft add?

### Takeaway
Microsoft confirms open footprint coverage at the northern Alatau test area, but its published height-coverage map has no matching tile there. Overture publishes global building and building-part data, including height and floor fields when upstream sources have them, but it is an ODbL derived database and does not guarantee a height for any particular Alatau building.

### Cited Findings
- A bounded spatial read of Microsoft’s published coverage indexes found a footprint tile covering 76.9921875–77.16796875 E and 43.7075935–43.8345268 N, with 4,683 buildings; this contains the northern Alatau test location near 77.091, 43.798. The corresponding published height-coverage index returned no tile for that point. Microsoft describes the data as satellite-derived footprints whose source-imagery vintage varies, and publishes separate coverage maps for footprints and height estimates. — [Microsoft dataset documentation](https://github.com/microsoft/GlobalMLBuildingFootprints/blob/main/README.md), [footprint coverage map](https://minedbuildings.z5.web.core.windows.net/global-buildings/buildings-coverage.geojson), [height coverage map](https://minedbuildings.z5.web.core.windows.net/global-buildings/buildings-with-height-coverage.geojson)
- Microsoft licenses Global ML Building Footprints under CDLA Permissive 2.0. — [Microsoft dataset documentation](https://github.com/microsoft/GlobalMLBuildingFootprints/blob/main/README.md)
- Overture’s Buildings theme states global coverage, releases monthly GeoParquet data through S3/Azure, and provides `height`, `min_height`, `num_floors` and building-part geometry only when available. Its documentation explicitly describes 3D visualization as extrusion by those attributes. — [Overture Buildings guide](https://docs.overturemaps.org/guides/buildings/), [schema](https://docs.overturemaps.org/schema/v1.18.0/reference/buildings/building/)
- Overture’s Buildings theme is licensed under ODbL and combines OSM, Microsoft, Google Open Buildings and other sources. — [Overture attribution and licensing](https://docs.overturemaps.org/attribution/)
- This repository deliberately retired its `overture-tiles` building source in favour of OSM. The retained source is OSM, whose absent building heights are estimated rather than treated as measured. — [project memory](../../../../MEMORY.md)

### Inferences
- Microsoft is useful as a footprint-completeness audit or Overture may already use it, but neither produces a new Alatau 3D source with heights on its own.
- An Overture Alatau extraction is worth a small sample query before replacing the current OSM source: it may add footprints, `building_part` geometry and sporadic values, but it must preserve ODbL attribution and cannot be presumed to improve heights.

### Gaps
- No bounded Overture extract was run in this review, so Alatau’s actual counts for buildings, building parts, and non-null heights/floors are unverified.

## Recommended order for Alatau

### Takeaway
Use the existing OSM layer as the default. Evaluate GBA only as a separate opt-in, clearly described LoD1 context source after resolving its CC BY-NC terms; then compare it visually and numerically against OSM/Microsoft at the intended pilot sites. Test Google only as a read-only visual backdrop, since current published country availability does not establish 3D Maps support in Kazakhstan.

### Cited Findings
- GBA is the only source reviewed here that explicitly offers a global LoD1 model plus per-building predicted heights. — [GBA publication](https://essd.copernicus.org/articles/17/6647/2025/essd-17-6647-2025.html)
- Overture supports an incremental extraction workflow: its official guide says cloud access can transfer only the bounding-box data requested. — [Overture data access](https://docs.overturemaps.org/getting-data/)
- Google describes Photorealistic 3D Tiles as a textured mesh streamed through its Map Tiles API, rather than an exportable semantic building dataset. — [Google Map Tiles overview](https://developers.google.com/maps/documentation/tile/overview)

### Inferences
- For the Alatau pitch, a GBA LoD1 overlay may make a lightly built site legible, but the more valuable model remains the proposal and the government planning/cadastral layers. Existing-building geometry should be visually separate from proposal geometry.

### Gaps
- A short pilot should establish GBA’s Alatau download path, local appearance and licensing fit before any implementation decision.
