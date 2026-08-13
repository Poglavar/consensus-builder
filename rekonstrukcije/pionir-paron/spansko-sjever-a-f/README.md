# Špansko-Sjever A–F

Reconstruction of the six above-ground volumes A–F on current k.č. 2795/3, MB 340057, k.o. Stenjevec Jug (23,451.14 m² in the local current cadastre). The permit records use k.o. Stenjevec, MB 335592.

- [`location-permit-amendment-2022.geojson`](location-permit-amendment-2022.geojson) archives the six official eDozvola polygons from case `P20221230-1168647-Z06`, class `UP/I-350-05/22-001/121`, final on 16 August 2022.
- `building-{a..f}-amendment-*.geojson` archives named individual acts used to map the otherwise anonymous location-permit polygons to A–F.
- [`observed-context.geojson`](observed-context.geojson) contains the current parcel, six above-ground DGU buildings, three underground-garage polygons, and the transformer.
- [`proposal.geojson`](proposal.geojson) is the canonical six-building app proposal. It survives a lossless export/import/export round trip and is also stored locally as unapplied proposal row 1087.

The location-permit properties total 896 apartments and eight offices. This is a dated design state, not asserted as the final as-built total. For example, the later signed amendment for F reduced it from 148 to 141 apartments and from eight to four offices. The proposal uses the permit footprints; all six also match the current above-ground DGU buildings spatially.

F is documented as `P+7+Uk`; the exact storey notation for A–E still needs confirmation from their signed phase permits. A–C have useful matched GDI heights, while D–F use a temporary 27 m display height because the GDI observation predates completion or mismatches the later footprint. Consequently the height-equivalent 65,582 m² and kin 2.797 are display diagnostics, not quoted permit GBP.

Refresh the official source snapshots and rebuild locally with:

```sh
cd backend
node scripts/fetch-pionir-edozvola-sources.mjs --project spansko-sjever-a-f
PGHOST=localhost node scripts/seed-spansko-sjever-proposal.mjs --apply --export
```
