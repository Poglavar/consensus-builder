<!-- Open plan, not started: importing IFC building models so X-ray and Plan stats read real storeys, units and uses. -->
# IFC building import (plan)

Status: not started. Kept here until someone asks for it.

## Why

An uploaded GLB is a mesh. It draws the building, but says nothing about storeys, rooms,
apartments or use, so X-ray has no interior to show and Plan stats counts it by the per-m² rule
(`frontend/js/proposals/plan-units.js`, reason `uploaded-model`). A GLB with a companion
floor-plan file in our own format (`consensus-builder.building-floor-plans.v2`,
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
3. **Convert** each storey to a floor of our v2 model: walls and slabs as polygons, openings,
   stairs, and the storey elevation. Repeated storeys share one layout, as in the generator's
   output. A pure module (no DOM, no WASM types) does the conversion from plain extracted data so
   node tests drive it.
4. **Count** units: each apartment zone becomes an apartment on its storey (with its area); spaces
   classified as shops, offices or other work become work units. Plan stats then counts the model
   as it is (`countModel` already reads apartments and shop units from a v2 model).
5. **Set the building use** (`frontend/js/building-use.js`) from the spaces' uses by storey, when
   they say; otherwise leave it not stated.
6. **Keep the mesh**: the geometry also yields a GLB for the exterior, so the model view renders the
   real building, and X-ray switches to the floor-plan interior.

The import produces an ordinary Freeform building: footprint, height and storeys from the model,
`floorPlans` and `use` on its properties, and the mesh as its model. Nothing downstream needs to
know the source was IFC.

## Open questions

- **Where the floor model is stored.** Today registered models live in
  `consensus.building_floor_model` and are joined onto building features on read, and generated
  layouts are never stored. An authored IFC interior is neither: decide between the registry
  (with `source = proposal`) and the design record itself (size: a v2 model of a large building
  can be hundreds of kB).
- **Files without zones.** Many exports have spaces but no apartment grouping. Grouping spaces
  into apartments by door connectivity to a corridor or stair is possible but is inference, and
  must say so (as the generator's notes do).
- **Fidelity limits.** Curved walls, sloped slabs and split-level storeys need simplification to
  the v2 model's flat polygons; the import should report what it simplified.
- **MCP parity.** `ugt_import_model` accepts GLB/glTF today; it would take IFC the same way,
  through the same conversion module.

## Not in this plan

- Detecting storeys and walls from a bare GLB by slicing the mesh. That gives a real floor count
  and floor area, but not apartments; it is a separate, smaller step if wanted.
- Export back to IFC.
