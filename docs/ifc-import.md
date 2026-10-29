<!-- Open plan, not started: importing IFC building models so X-ray and Plan stats read real storeys, units and uses. -->
# IFC building import (plan)

Status: not started. Kept here until someone asks for it.

## Why

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

## What the import would do

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

## How IFC maps onto our records

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

## Open questions

- **Where the floor model is stored.** Today registered models live in
  `consensus.building_floor_model` and are joined onto building features on read, and generated
  layouts are never stored. An authored IFC interior is neither: decide between the registry
  (with `source = proposal`) and the design record itself (size: a v3 model of a large building
  can be hundreds of kB).
- **Files without zones.** Many exports have spaces but no apartment grouping. Grouping spaces
  into apartments by door connectivity to a corridor or stair is possible but is inference, and
  must say so (as the generator's notes do).
- **Fidelity limits.** Curved walls, sloped slabs and split-level storeys need simplification to
  the v3 model's flat polygons; the import should report what it simplified.
- **MCP parity.** `ugt_import_model` accepts GLB/glTF today; it would take IFC the same way,
  through the same conversion module.

## Not in this plan

- Detecting storeys and walls from a bare GLB by slicing the mesh. That gives a real storey count
  and floor area, but not apartments; it is a separate, smaller step if wanted.
- Export back to IFC.
