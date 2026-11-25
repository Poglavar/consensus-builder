<!-- IFC building import: the built geometry import, and the open plan for storeys, units and uses. -->
# IFC building import

Status: the geometry import is built (below). Storeys, units and uses (the plan after it) are not
started.

## Built: an IFC file as a building model

Upload model (`building-upload.js`) and MCP `ugt_import_model` take an `.ifc` file (IFC2X3, IFC4,
IFC4X3) and turn it into the same self-contained GLB an uploaded glTF model is
(`frontend/js/ifc-model-reader.js`, which both use). From there it is an ordinary uploaded model:
preview, projected footprint, placement editor and the mesh in the model view.

- **Reader:** web-ifc (That Open Company, MPL-2.0), pinned to one version in
  `IfcModelReader.WEB_IFC_VERSION` and `backend/package.json` (a test keeps them equal). The browser
  loads it from jsDelivr on the first IFC file (about 0.25 MB of script and 0.5 MB of WebAssembly,
  compressed); 0.0.78's browser build is broken. Lengths come out in metres whatever the file's unit.
- **What is kept:** the building elements (`IfcBuildingElement`, `IfcBuiltElement` in IFC4X3). The
  envelope (walls, curtain walls, slabs, roofs, windows, plates, members, columns, beams, coverings,
  chimneys, shading devices) is always kept; other elements (doors, stairs, railings, generic objects)
  only inside the envelope's plan, so trees, cars and site furniture around the building are left
  out. Spaces, zones, openings, furniture, building services and the site's terrain are never read.
- **Limits:** the GLB stays within the footprint's 250 000 triangles and the 10 MiB upload. When the
  whole building is over them, whole IFC classes of detail are left out, cheapest first kept, and the
  dialog names them (`leftOut`); when the envelope alone is over them, the import is refused with a
  request to export at a coarser level of detail.
- **Colours:** one material per IFC style colour, blended where it is transparent (glass).
- **Placement:** `IfcMapConversion` to a projected CRS the city-model reader knows (UTM zones and the
  listed national grids), else the site's `RefLatitude`/`RefLongitude` with the model context's
  `TrueNorth`, each subject to the [model file placement](vocabulary.md#model-file-placement) range.
  Revit's site location is usually its template's (Chicago, Boston), which the 1 km range discards.
- **Known limits:** the GLB's lowest point stands on the ground, so a basement lifts the building by
  its depth; one connected building per file.

## Plan: storeys, units and uses

### Why

An uploaded GLB is a mesh. It draws the building, but says nothing about storeys, rooms,
apartments or use, so X-ray has no interior to show and Plan stats counts it by the per-m² rule
(`frontend/js/proposals/plan-units.js`, reason `uploaded-model`). A GLB with a companion
floor-plan file in our own format (`consensus-builder.building-floor-plans.v3`,
[building floor models](building-floor-models.md)) would solve that, but no design tool exports
that format.

IFC (Industry Foundation Classes, the buildingSMART open standard, ISO 16739) is what architectural
tools already export: Revit, ArchiCAD, Vectorworks, Allplan and SketchUp Pro. It carries the
semantics a mesh lacks:

- `IfcBuildingStorey`: the storeys with their elevations.
- `IfcSpace`: rooms and other spaces, with their outlines, areas and names.
- `IfcZone` (or space groupings): apartments and other units made of spaces.
- Classifications and properties (`Pset_SpaceCommon`, occupancy types): the use of a space.
- `IfcWall`, `IfcSlab`, `IfcDoor`, `IfcWindow`, `IfcStair`: the elements X-ray draws.
- `IfcSite` / `IfcMapConversion` (IFC4): the georeference, when the author set one.

### What the import would do

1. **Read** the file in the browser with web-ifc (That Open Company, MPL-2.0, a WASM module of a
   few MB), loaded only when someone imports an IFC file, the way the floor-plan modules load on
   first use (`frontend/js/map-mode-loader.js`).
2. **Place** it: from `IfcMapConversion` when present, otherwise the same placement the GLB
   importer uses (centre, rotation and the model's projected footprint,
   `SingleBuildingGeometry.placeModelFootprint`).
3. **Convert** each storey to a storey of our v3 model: walls and slabs as polygons, openings,
   stairs, and the storey elevation. Repeated storeys share one layout, as in the generator's
   output. A pure module (no DOM, no WASM types) does the conversion from plain extracted data so
   node tests drive it.
4. **Count** units: each apartment zone becomes an apartment on its storey (with its area); spaces
   classified as shops, offices or other work become work units. Plan stats then counts the model
   as it is (`countModel` already reads apartment, shop and office units from a v3 model).
5. **Set the building use** (`frontend/js/building-use.js`) from the spaces' uses by storey, when
   they say; otherwise leave it not stated.
6. **Keep the mesh**: the geometry also yields a GLB for the exterior, so the model view renders the
   real building, and X-ray switches to the floor-plan interior.

The import produces an ordinary Freeform building: footprint, height and storeys from the model,
`floorPlans` and `use` on its properties, and the mesh as its model. Nothing downstream needs to
know the source was IFC.

### How IFC maps onto our records

IFC describes one built object as designed; our records describe changes to an existing city and
who agrees to them. The mapping therefore holds inside a building and stops above it. Our names
stay; IFC names are used only at the import (and any later export) boundary.

| Ours | IFC | Notes |
|---|---|---|
| Plan | `IfcProject` | Loose: a Plan collects separately published Designs, often by different authors, and one Design can be in several Plans. An IFC project is one team's single model. An exported Plan would be one `IfcProject` holding its building Designs. |
| Building Design (Freeform) | `IfcBuilding` under an `IfcSite` | The `IfcSite` is the plot the building stands on, not the Design. A file with several `IfcBuilding`s imports as several buildings. |
| Road, park, parcel-layout, rule, keep-as-is and ownership Designs | none | IFC models objects, not changes. IFC 4.3's `IfcRoad`, `IfcRailway` and `IfcAlignment` describe built infrastructure and are not in this plan. |
| Agreement | none | `IfcApproval`, `IfcPermit` and `IfcActor` record approvals and parties; IFC has nothing for land allocation, compensation or decision rules. |
| Storey of the floor model (level, elevation) | `IfcBuildingStorey` (`Elevation`) | Storeys with the same layout share one reusable layout. |
| Floor layout: walls, slabs, openings, stairs | `IfcWall`, `IfcSlab`, `IfcDoor`, `IfcWindow`, `IfcStair` | Reduced to the floor model's flat polygons and dimensions. |
| Room | `IfcSpace` | Outline, area and name. |
| Apartment or other unit | `IfcZone` (IFC2x3), `IfcSpatialZone` or `IfcZone` (IFC4) grouping `IfcSpace`s | Absent in many exports; see open questions. |
| Building use, by storey | `Pset_BuildingCommon.OccupancyType`, `Pset_SpaceCommon` and `IfcClassificationReference` (Uniclass, OmniClass) | IFC has no fixed list of uses. Known occupancy labels and classification codes map to our six uses; anything else leaves the use not stated. |
| Placement (WGS84 registration) | `IfcMapConversion` and `IfcProjectedCRS` (IFC4) | IFC2x3 files carry only `IfcSite.RefLatitude` / `RefLongitude`, which places but does not orient. |

A whole Plan at city scale maps onto CityGML / CityJSON instead; see [CityGML and CityJSON](citygml.md).

### Open questions

- **Where the floor model is stored.** Floor plans are stored only as shared published documents
  (cadastre-data `buildings.floor_plan`, [building floor models](building-floor-models.md#where-floor-plans-are-stored)),
  joined onto building features on read, and generated layouts are never stored. An authored IFC
  interior is neither: decide between published documents (with a `source = proposal` building
  reference) and the design record itself (size: a v3 model of a large building
  can be hundreds of kB).
- **Files without zones.** Many exports have spaces but no apartment grouping. Grouping spaces
  into apartments by door connectivity to a corridor or stair is possible but is inference, and
  must say so (as the generator's notes do).
- **Fidelity limits.** Curved walls, sloped slabs and split-level storeys need simplification to
  the v3 model's flat polygons; the import should report what it simplified.

### Not in this plan

- Detecting storeys and walls from a bare GLB by slicing the mesh. That gives a real storey count
  and floor area, but not apartments; it is a separate, smaller step if wanted.
- Export back to IFC.
