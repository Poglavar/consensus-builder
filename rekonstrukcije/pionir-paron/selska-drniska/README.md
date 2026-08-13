<!-- Documents the identification, source roles and reproducible built-state proposal for Selska–Drniška. -->

# Selska–Drniška

Selska–Drniška is a completed complex of three mixed-use buildings on current k.č. 5652/1, MB 339270, k.o. Trešnjevka. [GIP PIONIR's official portfolio](https://pionir.hr/reference/stambeno-poslovni-objekti/) says the project was completed in cooperation with PIBA d.o.o. and consists of exactly three buildings, each with a basement and six above-ground storeys. The ground floor is commercial and 4 m high. The exact contractual roles of GIP PIONIR and PIBA are not stated, so the reconstruction does not relabel either company as the investor.

## Identification

The portfolio name locates the project at Selska cesta and Drniška ulica. Pionir's four published photographs show three repeated, aligned slab buildings along Selska cesta. The current cadastral parcel at that intersection contains exactly the same three-building arrangement:

| Position | Current DGU building | Footprint | GDI height | GDI survey |
|---|---:|---:|---:|---:|
| northern | 14430817 | 232.44 m² | 23.33 m | 2008 |
| middle | 14430818 | 231.97 m² | 23.66 m | 2008 |
| southern | 14430819 | 233.21 m² | 23.75 m | 2008 |

The parcel is DGU id `41279125` and has 1,855.90 m² in the native cadastral geometry. The 2008 GDI survey proves that the buildings were completed no later than 2008; it does not establish their exact construction year.

The DGU import currently contains two `current=true` rows for several identical geometries. [`observed-context.geojson`](observed-context.geojson) collapses those duplicates by `geom_hash`, keeps the newest row, and retains six unique structures: the three principal buildings, two terrace/plinth polygons and one staircase. Only the three above-ground buildings enter the proposal.

## Canonical proposal

[`proposal.geojson`](proposal.geojson) is proposal `pionir-selska-drniska-observed`, stored locally as row `1093` and deliberately left unapplied. It uses current DGU footprints, matched GDI heights and the six above-ground storeys stated by Pionir. The names “northern”, “middle” and “southern” are internal positional labels, not labels recovered from a permit.

Geometry-derived diagnostics are:

- site area: 1,855.90 m² in the native DGU parcel;
- combined principal-building footprint: approximately 697.60 m²;
- site coverage: approximately 37.59 %;
- six-storey GBP proxy: approximately 4,185.59 m²;
- six-storey `kin` proxy: approximately 2.26.

The last two figures are `DGU footprint × six documented above-ground storeys`. They are useful for reproducing the visible massing, but they are not GBP values taken from a permit. The number of apartments and the exact completion date remain unresolved.

Rebuild and store the local proposal with:

```sh
PGHOST=localhost node backend/scripts/seed-selska-drniska-proposal.mjs --apply --export
```

The export performs an export/import/export identity check before writing the canonical GeoJSON.

## Circulation status

[`plan.json`](plan.json) records why this reconstruction remains building-only. The current OSM service road and three parking aisles run across the DGU terrace/plinth geometry shared by the three buildings. That may be a drivable deck in reality, but the available layers do not establish a safe surface formation, so no road or parking proposal is fabricated.
