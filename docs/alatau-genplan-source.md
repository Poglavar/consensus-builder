<!-- Current contract of the Alatau general plan planning source: data, zone interpretation, limits. -->
# Alatau general plan source (`alatau-genplan-727`)

Permitted massing for Alatau (Almaty region, Kazakhstan) comes from the city's general plan as
corrected by Government Decree No. 727 of 9 September 2025. UGT reads the 6,659 functional zones
from the bundled `alatau-genplan-727.geojson.gz` snapshot of the state urban-planning cadastre. The
registered `alatau-genplan` adapter interprets each zone's attributes in
[`backend/planning/providers/alatau-genplan.js`](../backend/planning/providers/alatau-genplan.js).
The `alatau` city configuration pins it (`planning.sourceIds: ['alatau-genplan-727']`) together with
the parcel source `kz-alatau-pkk` (the national public cadastral map, district view 364).

## Data

| Item | Value |
| --- | --- |
| Service | `https://map.gov4c.kz/ggkgs/ows`, OGC WFS 2.0.0, layer `kz:gpzone` (the public cadastral map's urban-planning cadastre proxy) |
| Plan | Генеральный план г. Алатау, корректировка; Постановление Правительства РК № 727 от 09.09.2025 ([text](https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf), [main drawing](https://primeminister.kz/assets/media/prilozenie-2-rus-727.pdf)). The companion red-line layer `kz:gpreg` carries `number_post` № 727 and `approved_date` 2025-09-09 for the same territory |
| Territory | `admterr_id` 191810000 (KATO code of Alatau). The snapshot includes only this territory and verifies the count and unique zone IDs before publication |
| Size | 6,659 zones, with 507,062 coordinate positions in the snapshot. `implementation` marks 847 existing, 5,702 planned and 110 unrecorded |
| Fields read | `object_id_i32` (record identity and paging order), `functional` (zone use and storey class), `gpzone` (zone group), `implementation` |
| Spatial reference | Longitude, latitude in WGS84 |
| Acquisition | WFS pages ordered by `object_id_i32`. The importer supplements the host's TLS chain with the certificate pinned by the parcel source (`backend/parcels/certificates/`) |
| Detailed plans | `kz:pdpzone`/`kz:pdpreg` hold no Alatau zones (2026-11-12) |

Run `node backend/scripts/build-alatau-genplan-snapshot.mjs --fetch` from the repository root to
refresh both assets together. The importer also accepts a complete WFS GeoJSON file with its match
count. It writes the full-precision compressed snapshot under `backend/planning/data/` and the
simplified map asset under `frontend/data/planning/`.

In 2D below zoom 15, **Zoning source areas** loads the complete simplified plan in one download.
**Fit plan** frames its WGS84 bounds for the current screen. The overview keeps zone IDs and use
colours and reads the exact source record when a zone is inspected. From zoom 15, zoning asks for
one viewport box against the in-memory snapshot index, with further pages for views exceeding
1,000 matches. The provider clips the exact geometry at the viewport bounds and can read full
records by `object_id_i32`. The zoning requests have no parcel grid or live cadastre dependency.
Permitted building envelopes start at zoom 16 and read parcel and street evidence for their separate
calculation. A study or envelope zoning read follows up to 10 pages of 1,000 zones.

A zone marked planned (`implementation` Проектируемые) supplies the boundary for the app's
massing estimate. The source identifies functional areas and their implementation stage. It
supplies no future plot identifiers. For existing or unmarked zones the estimate uses the
cadastral parcels. A designer can use the complete area at any stage as a site and lay out
plots within it. The plan's streets are one road
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

UGT assumes 3.0 m per storey. For example, zone `479341` has the 6–12 storey class. The maximum
of 12 comes from the legend (`direct`), and UGT calculates 36 m (`derived`). For detached houses
the legend gives no number, so the adapter marks its three-storey value as `assumed`. Each height
constraint carries the multiplication, and `sourceEvidence.rules` records the assumption. The
general plan supplies no lot-specific setbacks, coverage or density limits for this calculation.

Under **Buildings and massing → Permitted**, **UGT source configuration** opens the edition's registry
entry with the dataset, adapter, snapshot filename and upstream service. **Published reference** opens
the government's plan text. The selected zoning area's **Source and evidence** shows its original
attributes and the adapter's interpretation.

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
