<!-- Plan for CityGML and CityJSON beside our own formats: imports wherever they are used to exchange what we import, exports as an extra option, and how our records map onto CityGML and LADM. -->
# CityGML and CityJSON (plan)

Status: the city-model building source is built for Vienna (`wien-lod2`); the other imports and the exports are not started.

CityGML (OGC) is the open standard for 3D city models: buildings and their storeys, rooms and
units, roads and rail, vegetation, water, land use, terrain and city furniture, each with
geometry at a level of detail (LOD) and attributes. CityJSON is its JSON encoding, made for the
web and for tools. Cadastral and mapping agencies publish city models in it, among them the
Netherlands (3D BAG), the German states (LoD2 buildings), Vienna, Helsinki and New York.

Our internal model stays as it is, and so do our own file formats: they fit our records exactly,
and CityGML, close as it is, is an odd fit for some of them. CityGML and CityJSON are converted at
the import and export boundaries only:

1. Our own formats (`ugt-plan-file/v1`, design, road, parcel-layout and agreement downloads) keep
   being exported and imported.
2. CityGML and CityJSON are imported wherever they are what the world uses to exchange the objects
   we import.
3. CityGML and CityJSON are exported as an additional option beside our files, never instead of them.

Three things are outside CityGML: parcels and ownership (LADM, ISO 19152), planning rules (only
loosely in INSPIRE planned land use) and agreements (no standard).

## Where each applies

| Our import or export | CityGML / CityJSON | Why |
|---|---|---|
| City building sources (`backend/buildings/`) | Import: CityGML sheets (built: Vienna); CityJSON tiles (3D BAG), German state LoD2 (CityGML), NYC's 3D model (CityGML) | How cities publish their 3D buildings. |
| A person's building source URL (Data sources) | Import: a CityJSON / CityJSONSeq or CityGML URL, beside ArcGIS, WFS, OGC API and GeoJSON | The same files, chosen by the person. |
| Building model upload (`building-upload.js`, MCP `ugt_import_model`) | Import: a CityGML or CityJSON building beside GLB/glTF, with its storeys and units when present | GIS tools and city portals hand out single buildings this way. |
| Footprint import in the building editors (Freeform, Row, Block) | Import: CityGML / CityJSON buildings as footprints with heights | Same files, when only the outline is wanted. |
| Plan file import and download | Import and export: CityJSON beside `ugt-plan-file/v1` | Opens in QGIS, FME, ninja and cjio. |
| Design download | Export: CityJSON for building, park, square, lake and road designs | Same, one design at a time. |
| Roads (OSM document, OpenDRIVE) | Export only: road surfaces in the plan or design CityJSON | Roads are exchanged as OSM and OpenDRIVE, rarely as CityGML. |
| Parcels, parcel layouts, ownership, agreements | None | Parcels travel as cadastral GML/GeoJSON (LADM concepts), not CityGML; agreements have no standard. |
| Parks, land use, terrain, trees as imports | None for now | Little exchanged as CityGML; revisit when a source needs it. |

Order: a CityJSON tile source (3D BAG), then building upload and footprint import from one shared
reader, then the CityJSON plan and design export, then CityJSON plan import, then the person's URL
sources and the remaining city sources. CityGML XML and CityJSON share one reader output (the
`citygml.js` building shape), so each import point reads both.

## 1. CityJSON plan and design files

Export a Plan, or one Design, as one CityJSON 2.0 file, as an option beside `ugt-plan-file/v1`
([portable plan files](portable-plan-files.md)); import reads it back without loss.

- The physical content of each Design becomes standard city objects (mapping below), so QGIS, FME,
  ninja and cjio open the file as it is.
- A CityJSON Extension (`+ugt…` types and attributes, with its schema published beside the
  [plan-file schema](../frontend/schemas/)) carries what the standard lacks: the Plan record and
  its CID, each Design record and CID with its kind, the city objects it owns, the parcel layouts
  and the rule designs. Import rebuilds the Design records from the extension and checks their
  CIDs, as `PlanFileUI.commitImport` does today.
- CityJSON's core has no versioning, so the before/after relationship stays in our records: a
  Design names what it replaces, and the file holds the proposed state.
- Agreements stay in our own JSON. Plan files carry no agreements today.
- `metadata.referenceSystem` is the Plan's projected CRS, or a local transverse Mercator at the
  Plan's anchor ([projections](projections.md)) when the city has no standard one.

## 2. CityGML and CityJSON as a building source

A building source for cities that publish their city model as CityGML sheets:

- `backend/buildings/citygml.js` parses CityGML 1.0/2.0 buildings (parts merged into their
  building) into roof, wall and ground surfaces, falling back to the geometry's polygons when a
  building has no semantic surfaces (LOD1). `buildingRecord` projects them into the 3D view's mesh
  records and takes the ground surfaces as the footprint.
- `backend/buildings/citygml-source.js` maps a request's box onto the city's sheet grid, fetches
  the zipped sheets it needs (at most 16, kept in memory, 64 sheets), and answers `near` with the
  surfaces and `footprints` / `footprintsUnder` with the footprints. A sheet the city does not
  publish (404) is empty; any other failure is an error; a box needing more sheets is `partial`.
- A city is a small config: CRS, height datum offset, sheet grid and URL, attribution.
  `wien-lod2` (`backend/buildings/wien-lod2.js`) reads Vienna's generalised roof model (LOD2.1):
  500 m sheets in EPSG:31256, heights above Wiener Null (+156.68 m to the Adriatic datum),
  CC BY 4.0. Vienna lists it before OpenStreetMap.
- A first request costs 2–5 s per sheet (download and parse); a LOD2 building is about 25 kB of
  faces, so a 120 m radius in the old town is about 100 buildings and 2.5 MB.
- Still open: the `function` / `usage` codes mapped to our [building uses](vocabulary.md#building-use);
  storeys and units, where a source has them, as the building's floor model
  (`backend/buildings/floor-models.js`); CityJSON sources (3D BAG, tiled) and one German state's LoD2
  buildings; storing parsed sheets instead of reading them live when a source is slow or large.

## How our records map

| Ours | CityGML / CityJSON | Notes |
|---|---|---|
| Plan | the file: `metadata`, plus a `CityObjectGroup` per Design | Plan record and CID in the extension. |
| Building Design (Freeform, rule-made) | `Building`, `BuildingPart` | LoD1 from footprint and height; the model's mesh as LoD2/LoD3 when the design has one. |
| Storey | `BuildingStorey` (CityJSON 2.0), `Storey` (CityGML 3.0) | From the floor model; elevation and level as attributes. |
| Room | `BuildingRoom` | |
| Apartment, shop or office unit | `BuildingUnit` | `function` gives the unit kind. |
| Walls, slabs, stairs | `BuildingConstructiveElement`, `BuildingInstallation` | |
| Doors, windows | `Door`, `Window` (semantic surfaces) | |
| Building use | `function`, `usage` | Our six uses, with the source code list named in the extension. |
| Road, rail, station | `Road`, `Railway`, `TransportSquare` | Traffic and auxiliary traffic areas as semantic surfaces; our OSM-form lane list stays in the extension. |
| Park, square | `PlantCover`, `TransportSquare`, `LandUse` | |
| Lake | `WaterBody` | |
| Trees, street furniture | `SolitaryVegetationObject`, `CityFurniture` | |
| Terrain | `TINRelief` | Only when exporting a terrain patch is wanted. |
| Parcel layout, plots | none | LADM `LA_SpatialUnit` is the counterpart; plots go in the extension. |
| Urban rule, permitted envelope | none | INSPIRE planned land use has zones with maximum height and floor area ratio, in 2D; ours stay in the extension. |
| Agreement, ownership rights, parties | none | LADM parties and rights (`LA_Party`, `LA_RRR`) are the conceptual counterpart; agreements stay in our JSON. |

LADM (Land Administration Domain Model, ISO 19152-1:2024) is the standard for parcels, the rights
on them and the parties holding them. Its spatial-plan part is in development. We follow its
concepts where they fit (a parcel is a spatial unit; an owner is a party holding a right) but
do not adopt an encoding until a source or a consumer needs one.

## Inside the app

GeoJSON features and Three.js stay the working model. CityJSON is converted at the file and
source boundary, by one pure module (no DOM, no Three.js) that node tests drive in both
directions.

## Open questions

- **Mesh to boundary surfaces.** An uploaded GLB is triangles without semantics. Exporting it as
  LoD2/LoD3 needs at least a ground, wall and roof classification by face normal; say so in the
  file's metadata when it is inferred.
- **One file or one per Design.** A Plan file is one CityJSON; a single Design download is a
  one-member Plan, as now.
- **Coordinate precision.** CityJSON stores integer vertices with a `transform`; pick a scale that
  keeps millimetres, which the [geometry tolerances](geometry-tolerances.md) grid needs.
