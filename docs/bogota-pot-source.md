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
| Layers read | 15 "Tratamiento urbanístico" (5,630 polygons; `TRATAMIENTO`, `TIPOLOGIA`, `ALTURA_MAXIMA`), 22 "Antejardín" (4,191 polygons; `DIMENSION`, `NOTA`) |
| Spatial reference | Web Mercator on the service; requested as `outSR=4326`, GeoJSON |
| Limits | 2,000 features per page; `resultOffset`/`OBJECTID` ordering; `CODIGO_ID` is empty, so `OBJECTID` is the record identity and the record `version` is a hash of geometry and attributes |

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
| blank | Renovación: resulting height (arts. 260, 303–304); Consolidación: Equipamientos-convention polygons whose storeys are in Decreto 253/2026 Anexo 36.1 (not in this layer), or land without a height | `instrument_handoff` |

Storey counts are read only for Consolidación, Conservación and Mejoramiento integral (art. 260).
A configurable record carries constraints in metres for the shared evaluator
(`frontend/js/planning/parcel-assessment.js`, which accepts `m` and `ft`):

| Constraint | Rule | Source |
| --- | --- | --- |
| `storeys` | the map's base storey count | `ALTURA_MAXIMA` |
| `height` | storeys × (3.80 m clear + 0.25 m assumed slab) = 4.05 m per storey | Anexo 5 §1.3/§1.5 (Decreto 466/2024); slab thickness is unregulated and is an assumption recorded in `sourceEvidence.rules` |
| `rearSetback` | Consolidación/Conservación: ≤3 → 3 m, 4–6 → 5, 7–9 → 6, 10–12 → 8, 13–15 → 10, 16–18 → 12, 19–22 → 14, 23–25 → 16, 26–28 → 18, 29+ → 20; Mejoramiento integral: ≤3 → 0, 4–6 → 5, 7–9 → 6, 10–12 → 8 | Anexo 5 §5.4.b, §3.1.b |
| `sideSetback` | `TIPOLOGIA` = `TA` (tipología aislada): max(H/5, 4 m); continuous typology: 0 | Anexo 5 §1.9.b |
| `frontSetback` | the `DIMENSION` of the front-yard polygon with the largest overlap under the lot, Consolidación only | arts. 258, 314; Anexo 5 §1.7 |

The front yard is read per parcel through the provider's `parcelRecords(parcel, records)` hook: the
treatment record keeps its identity and revision, gains the `frontSetback` constraint, and records
the front-yard polygon (`OBJECTID`, dimension, note codes, overlap share, revision, whether it applies)
under `sourceEvidence.antejardin`. Street frontage comes from the shared frontage source (OSM through
Overpass in Bogotá); without it the bound joins every front-edge interpretation.

## What is not computed

These stay evidence (status, reason text, `sourceEvidence`) rather than geometry:

- Renovación and Desarrollo ranges 1–3, 4C, 4D: resulting heights bounded by construction indices.
- Desarrollo 4A/4B storey counts: their 0.10/0.15 occupancy indices cannot be drawn as setbacks.
- The street-wall rule (facade height 2.5·D, then a setback; Anexo 5 §1.11), MI uplifts by lot area
  and road width (art. 338), range uplifts, whole-block doubling (art. 310 par. 2–3), the Decreto
  676/2025 sustainability storeys, height matching with neighbours, basements, the Nivel
  Multifuncional, Aerocivil limits, and TA lots under 11 m of frontage (2 storeys without side yards).
- Equipamientos-convention polygons (Decreto 253/2026 Anexo 36.1) and heritage regimes.
- Side yards start at the second floor; the bound applies them from the ground, so a TA ground floor
  may legally extend further than drawn.

The shared evaluator bounds any simple lot outline of up to 500 vertices: a convex lot by exact
half-planes, a lot with inward corners by subtracting each edge's yard strip (a rectangle of the
yard's depth along the edge, extended by that depth past both ends), with sub-centimetre edges
ignored as digitising duplicates. A lot that several treatment polygons partition gets one envelope
per part (`…~<recordId>`), each the whole lot's bound clipped to that part; a zone under 2 % of
the lot is boundary noise kept as evidence; zones stacked over the same ground stay ambiguous.
In a Chapinero test block (28 lots) 26 bounds are drawn; a 203-lot zoom-19 cell draws 154 in
about 6 s cold and 3 s warm, the rest being overlapping lot identities in the parcel source (19),
lots too small for their yards (24) and sectors without an assigned height (6). A dense zoom-18
view holds 850–950 lots and takes about 8 s cold and 5 s warm, most of it the upstream parcel
read; the envelope request accepts up to 1,000 lots, and the API keeps each area's answer for ten
minutes and shares it between identical requests in flight.

## Checking the source

```sh
cd backend
node --input-type=module -e "
import { loadParcelEnvelopes } from './planning/parcel-envelopes.js';
const r = await loadParcelEnvelopes({ city: 'bogota', source: 'bogota-pot-555', bbox: [-74.05386,4.647365,-74.05226,4.648965] });
console.log(r.items.length, r.unavailable.length, r.items[0]?.title, r.items[0]?.metrics);"
./node_modules/.bin/vitest run test/planning-bogota-pot.test.js --pool=threads --maxWorkers=1
```

Legal texts: Decreto 555/2021 ([Hacienda compilation](https://compilacionjuridica.shd.gov.co/compilacion/docs/d_alcabog_0555_2021.htm)),
Anexo 5 as updated by [Decreto 466/2024](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=170937),
[Decreto 253/2026](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=193583) (Equipamientos heights, 3.50 m antejardín),
[Decreto 676/2025](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=191995) (sustainability storeys),
[Decreto 670/2025](https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=191905) (compilation).
