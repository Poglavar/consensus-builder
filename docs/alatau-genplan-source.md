<!-- Current contract of the Alatau general plan planning source: data, zone interpretation, limits. -->
# Alatau general plan source (`alatau-genplan-727`)

Permitted massing for Alatau (Almaty region, Kazakhstan) comes from the city's general plan as
corrected by Government Decree No. 727 of 9 September 2025. Its functional zones are read live from
the state urban-planning cadastre and interpreted by
[`backend/planning/providers/alatau-genplan.js`](../backend/planning/providers/alatau-genplan.js).
The `alatau` city configuration pins it (`planning.sourceIds: ['alatau-genplan-727']`) together with
the parcel source `kz-alatau-pkk` (the national public cadastral map, district view 364).

## Data

| Item | Value |
| --- | --- |
| Service | `https://map.gov4c.kz/ggkgs/ows`, OGC WFS 2.0.0, layer `kz:gpzone` (the public cadastral map's urban-planning cadastre proxy) |
| Plan | Генеральный план г. Алатау, корректировка; Постановление Правительства РК № 727 от 09.09.2025 ([text](https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf), [main drawing](https://primeminister.kz/assets/media/prilozenie-2-rus-727.pdf)). The companion red-line layer `kz:gpreg` carries `number_post` № 727 and `approved_date` 2025-09-09 for the same territory |
| Territory | `admterr_id` 191810000 (KATO code of Alatau). The layer is national, so a viewport read asks for this territory's zones only (one FES filter: `admterr_id` and a BBOX on `shape`). A neighbour's zone on the Almaty border is therefore never returned, and never counted as an omission that would mark the zoning incomplete |
| Size | 6,659 zones in Alatau on 2026-11-12; `implementation` marks 847 existing, 5,702 planned and 110 unrecorded |
| Fields read | `object_id_i32` (record identity and paging order), `functional` (zone use and storey class), `gpzone` (zone group), `implementation` |
| Spatial reference | EPSG:4326; WFS 2.0 bounds are sent latitude first (`urn:ogc:def:crs:EPSG::4326`) and features return longitude first |
| Transport | The host omits its Sectigo intermediate; the provider supplements it with the certificate the parcel source pins (`backend/parcels/certificates/`) |
| Detailed plans | `kz:pdpzone`/`kz:pdpreg` hold no Alatau zones (2026-11-12) |

The provider reads one viewport page per request (cursor = service row index, ordered by
`object_id_i32`, 15 min in-memory cache) and re-reads a record by an `object_id_i32` filter.
The plan's zones are small, so a block of lots lies under several hundred of them. The source sets
`zoningPageLimit: 1000`, and a study or envelope zoning read follows further pages (up to 10)
instead of failing at the first.

A zone the plan marks planned (`implementation` Проектируемые) is a block of the plan's own
layout, drawn across the field parcels it replaces. It is its own lot (vocabulary: Land basis):
the envelope is derived on the zone's outline, and the cadastral parcels under it get none. A zone
marked existing, or unmarked, regulates the parcels as they stand. The plan's streets are one road
zone surrounding the blocks (18.7 km² on 2026-11-23, over the study limit, so never a lot).
OpenStreetMap holds no planned street, so a block's envelope has no street to face and is the
unoriented bound. A zone with a hole (a block around another zone) is `unsupported-parcel-shape`.

Envelopes are drawn only for lots of 1 km² or less, the study limit. Larger lots (fields, common
in Alatau) are listed as `unsupported-parcel-shape` and do not widen the zoning read.

## Interpretation

| Zone (`functional`) | Status | Constraints |
| --- | --- | --- |
| Усадебная застройка (detached houses with plots) | `allowed` | 3 storeys, assumed: the legend gives no number |
| Малоэтажная застройка (2–3 этажа) | `allowed` | 3 storeys |
| Среднеэтажная застройка (4–5 и 6* этажей) | `allowed` | 5 storeys; the legend's 6* is `metrics.conditional` (18 m on a condition; its footnote is unread) |
| Многоэтажная застройка (6–12 этажей) | `allowed` | 12 storeys |
| Застройка повышенной этажности (выше 12 этажей) | `instrument_handoff` | none: the plan sets no upper limit, the detailed plan (ПДП) does |
| Services, education, health, industry, storage, car services, external transport, sewage works | `instrument_handoff` | none: the ПДП and the design brief (АПЗ) set the parameters |
| Reserve, agricultural, defence and correctional land | `instrument_handoff` | none |
| Green space, parks, water, forest, protected land, roads, railways, cemeteries, burial grounds | `prohibited` | none |
| Any other label | `unrecorded` | none |

Height is storeys × 3.0 m. The plan states storey classes, not heights; 3.0 m floor-to-floor is
an assumption recorded with every height constraint (`sourceEvidence.rules`). No setbacks, coverage
or density limits are derived: the general plan does not set them per lot.

Every zone also carries its `use` (vocabulary: Permitted use): the key and colour group of its
class, the plan's label, and its stage (`existing` or `planned`, from `implementation`). A parcel's
envelope carries the use of the zone it stands in. The map colours zones by group with a legend,
shows them by default when this source is chosen, and names zones and envelopes in the reader's
language; the inspector quotes the plan's wording under the name, in italics, marked as the
source's (the descriptor's `language: 'ru'`). The provider's reasons and the 6* condition carry
codes the app translates (`assessment.reasonCode`, `metrics.conditional.conditionCode`); their
Russian text stays on the record. A Freeform building is checked against the zones under it
(vocabulary: Permitted check).

## Limits

- An existing zone is a general-plan area, not a parcel rule. Lots crossing two such zones without a
  clear majority give `study-multiple-zoning-areas`, as elsewhere.
- The single-parcel study (`/planning/study`, which agents read through `ugt_parcel_context`)
  follows the map: a parcel wholly under planned zones is studied as the plan's block that holds
  most of it (`landBasis: "zone"`, the parcel asked for in `requestedParcel`); a parcel no one block
  holds most of (the 40 ha demo parcel: a third street, the rest ten blocks) gives
  `study-multiple-zoning-areas`. A point with no
  cadastral parcel is refused (`study-parcel-missing`), though the map draws the block there.
- The cadastre returns every lot as a MultiPolygon; a one-part MultiPolygon is studied as its
  Polygon (`assembleParcelStudy`).
- The source is the plan as approved in 2025. ARUP and BCG are preparing a master plan to 2040 under
  the 2026 special-status law; it will replace this plan when approved.
