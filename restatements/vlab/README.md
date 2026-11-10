<!-- The vLAB vision for the land inside the railway embankment between Cibona and the Westin (Zagreb), restated from its author's published 3D model as Consensus Builder designs with one agreement. -->

# vLAB – transformacija prostora između Cibone i Westina (2026)

A restatement of a **published proposal**: *vLAB* by Ivan Gavran Vlahović (architect, www.igv.hr), presented in 2026 as an interactive viewer at [vlab.igv.hr](https://vlab.igv.hr/). The proposal grew out of the author's 2013 diploma project *Aleph* (Faculty of Architecture, Zagreb) and his 2016 *Commerce Changes Cities* competition entry. It is not an adopted plan. The designs show the proposal as the author models it; nothing here assesses whether it complies with the GUP or the railway plans.

## The proposal

Most of the 1862 railway embankment along Jukićeva ulica is removed, and the land it encloses behind the Nikola Tesla Technical Museum opens to the city. The author's six interventions:

| Intervention (author's name) | What the author states | Restated as |
|---|---|---|
| Nasip (embankment) | The tracks stay on a 250 m viaduct (the cheaper option, after the Branimirova viaduct), or a later lowered line with a station | Not a design; see *Not restated* |
| Park i trg (park and square) | A park and a square on the 1.93 ha site; the transformation zone is 4.4 ha | `park-1`, `park-2`, `trg-1`, `trg-2` |
| vLAB building | A Zagreb Fair outpost: auditoriums, galleries, retail, F&B, wellness, offices and an institutional tenant on levels −2…+6, with 374 parking spaces underground | `zgrada-vlab` |
| Neboder (tower) | 66 m, three stepped volumes (1535 m² × 18 m × 4 floors, 697 m² × 12 m × 3, 377 m² × 36 m × 10), about 12,000 m², about 50 flats | `toranj` |
| Prolaz (passage) | A 30 m passage under the museum where Halls A and B meet, as in Bauer and Haberle's 1935 design | `prolaz` |
| Plaza muzeja (museum plaza) | The fenced plaza in front of the museum returned to the city | `plaza-muzeja` |
| Veza Cibona (Cibona link) | A pedestrian bridge with a ramp over about 5 m of height difference and one intersection, to the Cibona terrace | `veza-cibona` |

## Sources

The viewer loads its data from public files. `extract-model.mjs --fetch` downloads them into the gitignored `cache/` and records each file's URL, size and SHA-256 in `data/sources.json`. `--extract` refuses a cached file whose hash differs from that record.

| File | What it is |
|---|---|
| `ASSETS/site.glb` | The site model, a SketchUp glTF export with named components: `shell` (the vLAB building), `tower`, `int_park`, `int_prolaz`, `int_plaza`, `int_veza`, `bg_rail_*` (the embankment) and about 50 landmarks (`kul_inn_tech_muzej`, `smj_inn_westin` and others) |
| `ASSETS/building.glb` | The vLAB building by level (`lvl_m2` … `lvl_p6`), with floor slabs and programme meshes |
| `ASSETS/vlab_config.json` | Component categories and the six interventions |
| `CONTENT/vlab_content_42(_en).json` | The texts, with the quantities quoted above (exported 19 April 2026, the designs' date) |

The model files and texts are the author's work (© 2026 Ivan Vlahović). The designs restate their geometry and numbers: footprints, heights, floor counts and uses. They do not copy the meshes. Republishing the models themselves, for example as a design's uploaded glTF, needs the author's permission.

## Placing the model

The model is in metres in a local frame, with glTF −z north. `extract-model.mjs` matches the bounding-box centre of eight landmark components to the centre of the same OpenStreetMap building (`data/landmarks.json`, read 2026-11-10). It then fits a similarity in HTRS96/TM (EPSG:3765). The fit gives scale 0.995, rotation 100°, and 7.6 m RMS over the eight points (`data/georeference.json`). The residual comes from comparing bounding-box centres with OSM centres, not from distortion. As a check, the tower's three placed footprints add up to the author's 1535 / 697 / 377 m² within 1 %, and the museum's placed footprint lies on the GDI museum.

From the placed model:

- **Buildings.** The horizontal roof faces of `shell` and `tower` are banded by height. Each band is its own part, less every higher band, so parts never stack: vLAB 32 / 28.5 / 19.5 / 6.5 m on 6040 m², tower 65.5 / 29 / 17.5 m on 1522 m². Heights are taken over the site's ground slab at model 28.0 m. The vLAB storey counts are the floor slabs of `building.glb` under each roof.
- **Spaces.** `int_park` and `int_plaza` are filled on a 25 cm grid and simplified to 0.3 m, because their terraced meshes are thousands of sliver triangles that break an exact union.
- **Lines.** The passage is the mean across its drawn arrow along the arrow's axis. The Cibona link is the centreline chained through its ribbon.
- **Site and kept buildings.** `--site` reads the site parcels from the local cadastre: k.č. 6804/1, 6804/9 and 823/1, k.o. Centar, 20,017 m² against the author's 1.93 ha. It reads them at the API's own precision, because the square rides their edges. It also reads the GDI footprints that the model keeps (the museum and FKIT, Savska 16) into `data/kept-buildings.geojson`.

## Designs and agreement

`vlab-designs.mjs` builds the designs from the committed data only, with the app's own constructors (`backend/agents/mcp-geometry.js`, the generators the MCP drafts with). Designs claim ground in order, and each takes only ground no earlier design took. A building or corridor that would lose more than 1 m² is refused. A space is cut to what is left and kept 0.5 m clear of the kept buildings. The app applies a park or square as one connected area, so each connected piece of one is its own design.

| Design | Kind | Ground |
|---|---|---|
| vLAB – zgrada | Freeform building, 4 stepped parts, public use, large-panel glass facade, footprint-only land take | 6040 m² |
| vLAB – toranj | Freeform building, 3 stepped parts: office 4 floors, housing 7 and 17 floors; medium-panel glass facade | 1522 m² |
| vLAB – prolaz kroz Tehnički muzej | 4 m footway; the edge inside the museum is a building tunnel, so the museum stands | 239 m² |
| vLAB – pješački most prema Ciboni | 4 m footway over Tratinska ulica: level 0 at the ramp foot, +1 on the bridge and the Cibona terrace | 285 m² |
| vLAB – park (1/2), (2/2) | Park, 16 trees shared by area (the author's ground-floor render shows about sixteen) | 5141 m² |
| vLAB – plaza Tehničkog muzeja | Square | 2976 m² |
| vLAB – trg (1/2), (2/2) | Square: the rest of the site outside the building, the tower and the park | 9194 m² |

Each building's parts state one `buildingId`, so they share one [building hue](../../docs/vocabulary.md#building-hue). Both buildings state their facade (`properties.facade`): the author's renders show them glazed. It shows when the viewer turns Facades on with the Mixed style.

The squares and the vLAB building's land take clear the existing buildings inside the embankment that the model does not keep, as the author's model does.

The agreement is a community vote over the nine designs, *vLAB – transformacija prostora između Cibone i Westina*: 20 input parcels and 48 output pieces (`ground/vlab.json`). It is published only to a local API so far.

## The author's model (local only)

`build-author-model.mjs` publishes a variant, *vLAB – transformacija prostora između Cibone i Westina (autorov model)*. In it the vLAB building is the author's own `building.glb`, with the interiors of all nine storeys (−2 to +6), standing on the same 6040 m² footprint as a [georeferenced model](../../docs/vocabulary.md#georeferenced-building-model). X-ray opens it storey by storey (a [model section](../../docs/vocabulary.md#model-section)). The other eight designs are the same as in the plan above.

`prepare-model.mjs --build` rewrites the model so the app takes it:

- no vertex normals (flat shading) and only each mesh's own vertices, 4.6 MB against the 10 MB upload limit;
- the landmark fit's scale;
- the ground at model 28.2 m, above the basement's tops and below the ground-floor slab;
- the ground-floor slab only under the building, because the author's slab also paves the whole site where the park and the squares are;
- without the author's programme zones (`lvl_*_prog_*`), coloured boxes filling each zone whose sides lie in the walls' planes and z-fight with them.

`--upload` posts it to an API's `/models` and reads it back. The model, its placement, the upload record and this variant's ground file all stay in the gitignored `cache/`. The model is the author's work: it is uploaded only to a local API, and publishing this variant needs his permission.

```sh
cd backend
node ../restatements/vlab/prepare-model.mjs --build
node ../restatements/vlab/prepare-model.mjs --upload --api <local api> --apply
node ../restatements/vlab/build-author-model.mjs --designs --api <local api> --apply   # then --capture and --agreement as above
```

## Not restated

- **The embankment and the railway.** Consensus Builder already draws existing heavy rail as a viaduct in 3D and does not model the embankment. Removing it therefore shows as the land the park and the building take from the railway parcel (k.č. 6801). A track design over the existing line would draw the railway twice. The lowered-line scenario and its station have no alignment in the source.
- **Underground levels.** The parking (−2: 281 spaces, −1: 93) and the auditoriums on −1 are only in the description, because designs carry above-ground massing.
- **The access road and roundabout** at the building's west end appear in the author's renders but not as a model component.
- **The interior programme** of the vLAB building by floor. The texts give it (galleries 3,080 m², retail 6,880 m², offices 2 × 2,930 m², …), but a Freeform building carries a use per part, not per floor.

## Running it

Run from `backend/`: the road designs' construction frames resolve `proj4` from the working directory.

```sh
cd backend
node ../restatements/vlab/extract-model.mjs --fetch        # vlab.igv.hr → cache/ + data/sources.json
node ../restatements/vlab/extract-model.mjs --extract      # cache/ → data/model.geojson + data/georeference.json
node ../restatements/vlab/extract-model.mjs --site         # local cadastre + GDI → data/site.geojson, data/kept-buildings.geojson
node ../restatements/vlab/build-and-upload.mjs --dry-run
node ../restatements/vlab/build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
node ../restatements/vlab/build-and-upload.mjs --capture --app <app> --api <api>
node ../restatements/vlab/build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply
```

Tests: `backend/test/vlab-designs.test.js`.
