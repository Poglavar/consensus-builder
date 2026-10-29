<!-- Current contract of the Bogotá POT planning source: data, rule interpretation, limits. -->
# Bogotá POT source (`bogota-pot-555`)

Permitted massing for Bogotá comes from the official cartography of the Plan de Ordenamiento
Territorial, Decreto Distrital 555 de 2021 ("Bogotá Reverdece"), read live from its public ArcGIS
Online copy and interpreted by [`backend/planning/providers/bogota-pot.js`](../backend/planning/providers/bogota-pot.js)
and the pure rule module [`bogota-pot-rules.js`](../backend/planning/providers/bogota-pot-rules.js).
The city configuration pins it (`planning.sourceIds: ['bogota-pot-555']`) with the Bogotá lot source
`co-bogota-uaecd-lote` for parcel studies and viewport envelopes.

## Data

| Item | Value |
| --- | --- |
| Service | `https://services7.arcgis.com/lsxbLWF2l19Rmhqj/arcgis/rest/services/POT_Bogota_Decreto_555_2021/FeatureServer` |
| Item | [arcgis.com item `ee7fed3b93dd4d52b8d00bcc81ce0ea0`](https://www.arcgis.com/home/item.html?id=ee7fed3b93dd4d52b8d00bcc81ce0ea0), "Cartografía oficial del POT de Bogotá, Decreto 555 de 2021" |
| Publisher of the copy | Infraestructura de Datos Espaciales de Cundinamarca (IDEC), ArcGIS Online org `lsxbLWF2l19Rmhqj`; licence CC BY 4.0 (item `licenseInfo`) |
| Issuer | Secretaría Distrital de Planeación de Bogotá (SDP); `ACTO_ADMINISTRATIVO` "Decreto 555 de 29 de diciembre de 2021", `FECHA_CAPTURA` 2021-12-29 |
| Layers read | 15 "Tratamiento urbanístico" (5,630 polygons; `TRATAMIENTO`, `TIPOLOGIA`, `ALTURA_MAXIMA`), 22 "Antejardín" (4,191 polygons; `DIMENSION`, `NOTA`), 14 "Área de actividad" (1,143 polygons; `CODIGO_AREA_ACTIVIDAD`), read under a lot for the sustainability configuration |
| Spatial reference | Web Mercator on the service; requested as `outSR=4326`, GeoJSON |
| Limits | 2,000 features per page; `resultOffset`/`OBJECTID` ordering; `CODIGO_ID` is empty, so `OBJECTID` is the record identity and the record `version` is a hash of geometry and attributes |
| Equipamiento storeys | [`bogota-pot-equipamientos.json`](../backend/planning/providers/bogota-pot-equipamientos.json): Decreto 253/2026 Anexo 36.1 (596 rows, 559 with storeys) keyed by the treatment layer's `OBJECTID`. The annex numbers its polygons 1–596 in the order of the layer's blank-height Consolidación polygons by `OBJECTID`; the annex's lot codes (sector, barrio, two-digit manzana and lot) widen to the UAECD lot numbers under those polygons, which is how the order was verified. Rebuild with `scripts/build-bogota-equipamientos.mjs` from the annex PDF's `pdftotext -layout` output |

SDP's own servers (`sinu.sdp.gov.co`, `serviciosgis.catastrobogota.gov.co`, `datosabiertos.bogota.gov.co`)
do not answer from outside Colombia (TCP timeouts from Europe and the United States, 2026-10-29). The
IDEC copy carries the same layer schema as SINUPOT's "Edificabilidad → Tratamiento urbanístico" and
"Dimensionamiento de antejardines" layers. Two university copies of the same geodatabase exist on
ArcGIS Online; they are not used.

The provider reads live per viewport: one treatment query and one front-yard query for the requested
bounds (15 min in-memory cache, bounded), then `record` by `OBJECTID`. A viewport listing clips areas
to the view for display; studies and envelopes always read the full polygon.

## Interpretation

`ALTURA_MAXIMA` is text. The rule module reads it as:

| Value | Reading | Record status |
| --- | --- | --- |
| `5` | 5 storeys | `allowed` (configurable) |
| `3-5` | base 3 storeys; 5 only with enough frontage (art. 310) | `allowed`, uplift kept as evidence |
| `3 B-urb` | 3 storeys, urban-edge cap (art. 338) | `allowed` |
| `Rg 1` … `Rg 4D` | Desarrollo buildability range (art. 281): indices, resulting height | `unsupported_calculation` |
| `PEMP`, `BIC NAL`, `CHB`, `UNE`, `E4` | another instrument or regime | `instrument_handoff` |
| blank, Renovación | resulting height (arts. 260, 303–304): solved per lot in the envelope view, see below | `unsupported_calculation` on the polygon, `allowed` on the lot |
| blank, Consolidación | an equipamiento polygon: storeys from Decreto 253/2026 Anexo 36.1 by `OBJECTID` (559 polygons), or "N/A" there (37: infrastructure, green space, other instruments); land outside the annex has no height | `allowed` / `instrument_handoff` |

Storey counts are read directly for Consolidación, Conservación and Mejoramiento integral (art. 260).
A configurable record carries constraints in metres for the shared evaluator
(`frontend/js/planning/parcel-assessment.js`, which accepts `m` and `ft`). A yard that starts above
the ground carries `fromHeightM`; the envelope assembly (`backend/planning/parcel-envelopes.js`,
`tieredBound`) then draws the configuration as a stack of tiers, one per level a yard starts at.

| Constraint | Rule | Source |
| --- | --- | --- |
| `storeys` | the map's base storey count, or the annex's for an equipamiento | `ALTURA_MAXIMA`, Anexo 36.1 |
| `height` | storeys × (3.80 m clear + 0.25 m assumed slab) = 4.05 m per storey; an equipamiento storey is 4.60 m | Anexo 5 §1.3/§1.5 (Decreto 466/2024); slab thickness is unregulated and is an assumption recorded in `sourceEvidence.rules` |
| `rearSetback` | Consolidación/Conservación by storeys: ≤3 → 3 m, 4–6 → 5, 7–9 → 6, 10–12 → 8, 13–15 → 10, 16–18 → 12, 19–22 → 14, 23–25 → 16, 26–28 → 18, 29+ → 20; Mejoramiento integral: ≤3 → 0, 4–6 → 5, 7–9 → 6, 10–12 → 8; Renovación by height: ≤12 m → 4, ≤18 → 5, ≤27 → 6, ≤36 → 8, ≤45 → 10, ≤54 → 12, ≤66 → 14, ≤75 → 16, ≤84 → 18, taller → 20 | Anexo 5 §5.4.b, §3.1.b, §4.2.b |
| `sideSetback` | `TIPOLOGIA` = `TA` (tipología aislada): max(H/5, 4 m) from the second floor (`fromHeightM` 4.05), H counted above that level; Renovación: the same from 11.40 m, read as the third storey's top (12.15 m); continuous typology: 0 | Anexo 5 §1.9.b |
| `frontSetback` | the `DIMENSION` of the front-yard polygon with the largest overlap under the lot, Consolidación only; an equipamiento lot at least 3.50 m | arts. 258, 314; Anexo 5 §1.7; Decreto 253/2026 art. 249.8 |
| `frontSetback` with `fromHeightM` | the street wall: with D = street width + the lot's front yard (D ≤ 30 m), the facade rises to A = 2.5·D (Consolidación, Renovación); above A the front setback is the front yard plus max(4 m, (H − A)/5) | Anexo 5 §1.11 |

The per-lot readings come through the provider's `parcelRecords(parcel, records, context)` hook: the
treatment record keeps its identity and revision and gains the lot's constraints. The front yard is
the front-yard polygon with the largest overlap (`sourceEvidence.antejardin`); the street width is
measured by the envelope load (`backend/planning/street-width.js`: rays from the lot's front edge,
across the street, to the first other lot within 40 m; the parcel read extends 45 m beyond the view
so lots at its edge find theirs) and recorded under `sourceEvidence.streetWidth` and
`sourceEvidence.streetWall`. Street frontage comes from the shared frontage source (OSM through
Overpass in Bogotá); without it the bound joins every front-edge interpretation and no street
wall applies.

**Renovación.** The resulting height is solved per lot (`solveRenovacion`): for each storey count
the lot's floors, each bounded by the rear yard of that height, the side yards above the third
storey and the street wall, are measured, and the count holding the most floor area within the
single-lot construction index of 5.0 (arts. 303–304) is the height. Yards deepen with height, so a
storey past some count removes more floor than it adds; the search stops after three such
storeys, or three over the index. The result is recorded under `sourceEvidence.resultante` (index,
floor area, limit). A single-parcel study has no street width or measure, so there the polygon's
reading stands.

**Sustainability storeys (Decreto 676/2025).** The source has two scenarios: `general` (the map)
and `sustainable`, the storeys a Consolidación project earns by adopting every ecourbanismo
measure: +2 on lots of 300–800 m², +3 from 800 m², never above 12 storeys, in a Proximidad or
Estructurante activity area (layer 14 under the lot), not on polygons with a storey range or an
equipamiento. It is a second configuration with a `condition`, so the map shows the general one
unless the sustainable one is pinned; the outer bound includes both, and the tiers only the
sustainable storeys reach carry their condition, so the Planned figures, the inspector's height
and an agent's fit to the permitted envelope count the general storeys and state the extra ones
apart. "Outside purely residential sectors" cannot be read from the cartography and is part of
the stated condition.

## What is not computed

These stay evidence (status, reason text, `sourceEvidence`) rather than geometry:

- Desarrollo ranges 1–3, 4C, 4D: resulting heights bounded by construction indices over the net
  developable area of an urbanisation, which single lots do not have.
- Desarrollo 4A/4B storey counts: their 0.10/0.15 occupancy indices cannot be drawn as setbacks.
- Renovación's block-scale indices (6.0 with a corner and cession, 7.0 for a whole block), MI
  uplifts by lot area and road width (art. 338), range uplifts, whole-block doubling (art. 310
  par. 2–3), height matching with neighbours, basements, the Nivel Multifuncional, Aerocivil
  limits, TA lots under 11 m of frontage (2 storeys without side yards), and the Decreto 582/2023
  side-yard relaxations.
- Equipamiento polygons the annex marks "N/A", and heritage regimes.
- A storey whose top crosses a yard's start takes the yard for its whole height (the bound is
  conservative there).

The shared evaluator bounds any simple lot outline of up to 500 vertices: a convex lot by exact
half-planes, a lot with inward corners by subtracting each edge's yard strip (a rectangle of the
yard's depth along the edge, extended by that depth past both ends), with sub-centimetre edges
ignored as digitising duplicates. A lot that several treatment polygons partition gets one envelope
per part (`…~<recordId>`), each the whole lot's bound clipped to that part; a zone under 2 % of
the lot is boundary noise kept as evidence; zones stacked over the same ground stay ambiguous.
A 143-lot Renovación cell on Avenida Caracas draws 132 bounds in about 4 s cold and 1.6 s warm
(the rest: Desarrollo and instrument polygons, one lot the clipper refuses); the Renovación
search re-derives each concave lot with mostly the same yards, so the evaluator keeps each lot's
partial yard clippings. The envelope request accepts up to 1,000 lots, and the API keeps each
area's answer for ten minutes and shares it between identical requests in flight.

## Checking the source

```sh
cd backend
node --input-type=module -e "
import { loadParcelEnvelopes } from './planning/parcel-envelopes.js';
const r = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox: [-74.05386,4.647365,-74.05226,4.648965] });
console.log(r.items.length, r.unavailable.length, r.items[0]?.title, r.items[0]?.metrics);"
./node_modules/.bin/vitest run test/planning-bogota-pot.test.js --pool=threads --maxWorkers=1
# Equipamiento storeys, after a new annex or a re-published treatment layer:
pdftotext -layout anexo-36-1.pdf anexo-36-1.txt
node scripts/build-bogota-equipamientos.mjs --annex anexo-36-1.txt --out planning/providers/bogota-pot-equipamientos.json
```

Legal texts: Decreto 555/2021 ([Hacienda compilation](https://compilacionjuridica.shd.gov.co/compilacion/docs/d_alcabog_0555_2021.htm)),
Anexo 5 as updated by [Decreto 466/2024](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=170937),
[Decreto 253/2026](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=193583) (Equipamientos heights, 3.50 m antejardín),
[Decreto 676/2025](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=191995) (sustainability storeys),
[Decreto 670/2025](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=191905) (compilation).
