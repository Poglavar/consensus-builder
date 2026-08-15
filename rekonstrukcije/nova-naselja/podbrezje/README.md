<!-- This file records the mixed observed/planned reconstruction method and uncertainty for the named Podbrežje plan. -->

# Podbrežje

Named local plan: `/proposals/podbrezje?city=zagreb`

This is intentionally a mixed-state reconstruction of the 19.43 ha `UPU Podbrežje`, adopted in 2007 and amended in 2011. The official programme describes approximately 2,000 apartments, 5,800 residents and 234,280 m² GBP. Four residential slabs are present in the current DGU snapshot; the rest of the neighbourhood remains phased, with A11 under construction in the cited 2026 City update.

## Eleven residential fields

The official detailed land-use layer contains exactly eleven `M1` residential fields. The proposal contains:

- 4 `observed-built-state` features using their DGU footprints and GDI-matched heights;
- 7 orange `plan-derived-envelope` features positioned and oriented within the remaining official `M1` fields.

The seven inferred slabs follow the winning masterplan's comb-like urban form. Their 18.75 m width and 3.5 m end clearance are calibrated to the four built slabs; their indicative P+8 height follows the built blocks and the current A11 programme. These are not future building-permit footprints. The source evidence does not safely map the labels A1–A11 to individual `M1` polygons, so the archive leaves `officialPhaseLabel` unresolved instead of guessing.

The plan also contains one ordinary park proposal for the official `Z1` green space and 23 current OSM road pieces (1.46 km) inside the official `IS` traffic-system footprint. No separate official square code exists in the ingested plan layer, so none is invented.

## Sources

- [City plan page](https://zagreb.hr/izmjene-i-dopune-urbanistickog-plana-ure%C4%91enja-podb/89126)
- [Log-urbis winning development concept](https://www.log-urbis.hr/development-podbrezje)
- [Zagrebački holding project FAQ](https://www.zgh.hr/podbrezje/najcesca-pitanja-faq/4506)
- [City update on A11 construction](https://zagreb.hr/gradonacelnik-tomasevic-obisao-radove-na-zgradi-za/217781)
- [City of Zagreb urban-plan open data](https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja)

The archive's computed coverage, floor-area and `kin` values are diagnostics from modelled footprints and estimated storeys; they are not official or permit GBP.
