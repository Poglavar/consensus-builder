# Kazakhstan and Alatau 3D sources

## Is there an official 3D model for Alatau or Kazakhstan that we can integrate?

### Takeaway
Alatau does not yet have a public, reusable city-scale 3D building model. Its new city-specific digital-twin initiative is still defining a limited pilot. The Almaty Region government does operate a regional digital twin with 2D/3D material, terrain and infrastructure data, but the evidence found describes an internal government system rather than a public download or API.

### Cited Findings
- Alatau City Authority and South Korean partners AST Holdings and ILJOO GnS signed a memorandum for a digital-twin/IoT pilot. The first phase is limited, and the parties were still to choose the pilot area and technical parameters. The report explicitly distinguishes the intended analytical twin from a presentation 3D model. [Kazakhstanskaya Pravda, 15 September 2026](https://kazpravda.kz/n/sozdaetsya-tsifrovoy-dvoynik-alatau/)
- Almaty Region's government describes a digital twin with thematic 2D and 3D maps. It reports 8,967 engineering-infrastructure objects, 10,483 km of network lines and 413,288 point network objects, but does not publish a public data endpoint or licence in the cited release. [Almaty Region government](https://www.gov.kz/org/almobl-social/press/news/details/676515?lang=ru)
- A regional government report says the 2023 regional twin used 2D/3D geospatial data and a later public report describes 33 settlements, 582.1 km² of 3D terrain modelling and 1,919 km of digitised utilities. Neither establishes that there are textured or solid building models, nor that Alatau is covered. [Almaty Region government report](https://www.gov.kz/api/v1/public/assets/2025/1/28/b4dfcbe27a8de3bf6e362db4699b1e2e_original.1614462.pdf); [regional report](https://civilalliance.kz/static/core/adal/en-adalazamat-7-8-2025-site.pdf)
- Astana's Digitalization and Public Services Department lists a city digital-twin project, but its public project page does not expose geometry, a viewer, download or developer API. [Astana government](https://www.gov.kz/org/astana-urgsa?lang=ru)

### Inferences
- The Almaty Region twin is the best official lead for Alatau because the city lies in that region. A direct request to its digital-technologies/architecture teams is required to establish whether Alatau is among its 33 settlements and whether building geometry, terrain or infrastructure data can be shared for a pilot.
- The forthcoming Alatau pilot is an opportunity to propose a data-exchange contract (for example 3D Tiles or CityGML plus clear update and reuse terms), rather than a source that can be integrated today.

### Gaps
- I found no public official 3D Tiles, CityGML, mesh, WFS building-height layer, viewer endpoint, coverage list, licence, or confirmed Alatau building-model dataset for either the regional twin or the Alatau pilot.
- The available government descriptions do not establish the twin's building level of detail, positional accuracy, currency, or whether it includes roofs/textures rather than terrain and utility layers.

## What usable 3D or 2.5D building sources exist now?

### Takeaway
For an immediate, nationwide existing-building backdrop, Cesium OSM Buildings is the simplest true 3D service, though it is OSM-derived and only as complete as its footprints and height tags. Overture is the more suitable downloadable/open data route for footprints with optional heights, floors and roof attributes. 2GIS is a potentially richer commercial building dataset for Kazakh populated areas, but requires arranged access and is not a 3D mesh product.

### Cited Findings
- Cesium OSM Buildings is a global, quarterly updated 3D Tiles layer derived from OpenStreetMap. Its published metadata vary per building, and use requires Cesium ion access plus OpenStreetMap attribution. [Cesium documentation](https://cesium.com/platform/cesium-ion/content/cesium-osm-buildings/)
- Overture's building schema provides footprint geometry and optional height, floor count, base height, roof shape, roof height and materials. These are optional fields, so missing height cannot be treated as a measured height. [Overture schema](https://docs.overturemaps.org/schema/reference/buildings/building/)
- 2GIS Pro's buildings dataset covers Kazakhstan where 2GIS has mapped populated areas. It offers outlines and attributes including floor count, area, use, construction status and construction year; it is refreshed weekly, but full access is by arrangement or on-premise deployment. [2GIS documentation](https://docs.2gis.com/en/pro/data/built-in/buildings)
- Google documents global terrain availability but restricts photorealistic 3D surface data to its daily coverage map. A location check is necessary before relying on it, and its service is a Google Maps Platform product rather than an exportable government dataset. [Google coverage documentation](https://developers.google.com/maps/documentation/javascript/3d/coverage)

### Inferences
- Use Overture or Cesium OSM Buildings for a clearly labelled contextual representation of existing built form, after sampling the actual Alatau area for height coverage. Do not present any inferred/OSM height as an official or permitting measurement.
- 2GIS is worth evaluating if an Alatau commercial agreement can provide coverage; it may supply valuable footprint/floor/use attributes, but its published product description does not promise roof meshes, texture meshes or open redistribution.

### Gaps
- This pass did not establish the proportion of buildings in Alatau carrying usable heights/floors in Overture or Cesium, or whether 2GIS covers the city. Those are small practical sampling checks before adoption.
- No authoritative public source found provides a city-wide textured mesh, LiDAR point cloud, or survey-grade LoD2/LoD3 building model for Alatau.

## What should we pursue for the Alatau presentation and longer-term integration?

### Takeaway
There are three distinct assets to pursue: an immediate open contextual layer; access to the existing regional governmental twin; and an interoperability proposal for the planned Alatau twin. They should not be conflated: only the first is ready for self-service integration, and none substitutes for approved parcel-level rules.

### Cited Findings
- The Alatau initiative is intended to combine city-object data and engineering infrastructure and could later support planning, transport, utilities and environmental management; its initial pilot is deliberately bounded. [Kazakhstanskaya Pravda](https://kazpravda.kz/n/sozdaetsya-tsifrovoy-dvoynik-alatau/)
- The regional government reports substantial digitisation of infrastructure and utilities in its existing twin. [Almaty Region government](https://www.gov.kz/org/almobl-social/press/news/details/676515?lang=ru)
- Cesium OSM Buildings has global 3D Tiles coverage, while Overture makes height and roof-related attributes explicit but optional. [Cesium](https://cesium.com/platform/cesium-ion/content/cesium-osm-buildings/); [Overture](https://docs.overturemaps.org/schema/reference/buildings/building/)

### Inferences
- A practical sequence is: render Overture/Cesium only as a non-authoritative existing-context layer; ask the region for a small Alatau extract and licence; then offer Alatau City Authority a neutral exchange profile for official authoritative layers. At minimum it should identify CRS and vertical datum, object IDs, update time, accuracy/LoD, ownership/reuse rights and whether a building is observed, approved or proposed.
- The strongest pitch is interoperability: Urban Game Theory can make their official parcels, plan zones, red lines, existing stock and proposed designs visible together without claiming that a visual 3D backdrop has regulatory meaning.

### Gaps
- We have not contacted the regional twin operator or Alatau City Authority for data access, so availability, price, restriction and data model remain unknown.
- Any Google, Cesium or 2GIS product requires a separate terms-and-cost review before it could be shipped in the public product.

## Concrete local portals and leads

### Takeaway
There is official evidence that Astana's GIS has a photorealistic 3D-map component, and the national State Urban Planning Cadastre publishes a geoportal. I could not independently load an Astana or Almaty 3D viewer during this pass, so their current public reach, export options and actual mesh coverage are unverified.

### Cited Findings
- **Alatau pilot lead:** Alatau City Authority's official project account describes a first-stage virtual city model for construction monitoring, followed by sensors, transport and utilities. The associated announcement describes planned/pilot work rather than a released public model. [Alatau City Project](https://www.linkedin.com/posts/alatau-city-project_wsce2026-alatauonline-alataucity-activity-7503425944389595137-SpRg)
- **Almaty Region twin lead:** the regional government reports that the twin combines thematic 2D and 3D maps and names KazAeroSpace as the project executor. [Almaty Region government](https://www.gov.kz/org/almobl-enbek/press/news/details/676515?directionId=4419&lang=ru)
- **Astana viewer lead:** Astana's official digitisation page says its geographic-information platform includes 2D planning/cadastre layers and 3D maps for a photorealistic database. An academic description identifies the then-live portal as `gis.esailet.kz`, with a 3D-map navigation item; that URL could not be loaded through the research browser. [Astana government](https://www.gov.kz/org/astana-urgsa/activities/13241); [portal description](https://bultech.enu.kz/index.php/main/issue/download/31/26)
- **National government route:** the State Urban Planning Cadastre's official site links its public geoportal at `gov.ggk.kz` and offers provision of State Urban Planning Cadastre information as a service. The geoportal timed out during this check, so its public 3D capabilities and terms are unknown. [State Urban Planning Cadastre](https://aisggk.kz/)
- **Almaty:** government materials record a 3D city system and map, but the current municipal planning landing page exposes a 2D map, not a confirmed public 3D viewer. [Almaty government planning links](https://dip.link/a.uaig.kz); [municipal 3D-map report](https://ftp.almaty.tv/kz/news/arkhiv/almatintsam-pered-priobreteniem-nedvidgimosti-predlagayut-izuchit-onlayn-kartu-goroda)

### Inferences
- The top three primary leads are Alatau City Authority for the pilot's emerging source contract, Almaty Region's digital-technologies/architecture offices for a limited regional-twin extract, and the State Urban Planning Cadastre for the national geoportal and its per-building 3D-model service claim.

### Gaps
- I could not verify a currently working public 3D viewer or download/API for Astana or Almaty. Historical reports prove that 3D systems were built, not that they remain openly accessible today.
