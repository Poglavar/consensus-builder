<!-- Documents the site match, project-level totals and reproducible built-state proposal for Pergošićeva A1–A4. -->

# Pergošićeva A1–A4

Pergošićeva A1–A4 is a completed row of four mixed-use buildings on current k.č. 2859/15, MB 340057, k.o. Stenjevec Jug. [GIP PIONIR's official portfolio](https://pionir.hr/reference/stambeno-poslovni-objekti/) publishes two photographs of the four-building row and gives project totals of 189 apartments, 31 commercial units and 86 garages.

The portfolio entry does not name the investor or define GIP PIONIR's precise contractual role. It also does not allocate the units among A1–A4. Those figures therefore remain totals for the complete site and are not copied into each building.

## Identification

The current parcel at Ulica Ivana Pergošića contains exactly four structures, all recorded by DGU as residential buildings. Their west-to-east arrangement matches the four distinct buildings in Pionir's portfolio photographs:

| Internal position | Current DGU building | Footprint | GDI height | Display floor estimate |
|---|---:|---:|---:|---:|
| western | 13391607 | 532.43 m² | 23.30 m | 8 |
| central-western | 13391608 | 467.88 m² | 21.36 m | 7 |
| central-eastern | 13391609 | 496.16 m² | 21.55 m | 7 |
| eastern | 13391610 | 487.50 m² | 22.37 m | 7 |

All four GDI matches come from the 2008 survey and overlap their DGU footprints by at least 95 %. This proves that the complex existed by 2008, not that 2008 is the exact completion year. The A1–A4 ordering is not established by the available evidence, so the proposal deliberately uses positional names instead of assigning those labels speculatively.

## Canonical proposal

[`proposal.geojson`](proposal.geojson) is proposal `pionir-pergosiceva-a1-a4-observed`, stored locally as row `1096` and deliberately left unapplied. The parcel is DGU id `40368039`, with a native area of 3,236.14 m². In the exported WGS84 geometry:

- the site area is 3,236.03 m²;
- the combined four-building footprint is 1,983.90 m²;
- site coverage is 61.31 %;
- measured-height-equivalent above-ground GBP is 14,663.25 m²;
- measured-height-equivalent `kin` is 4.53.

The last two values use `DGU footprint × GDI height / 3 m`. They are diagnostics for reproducing the observed massing, not GBP from a permit. The editable buildings carry rounded display estimates of eight, seven, seven and seven storeys, while their 3D heights remain the measured GDI values.

Rebuild and store all configured historical observed proposals with:

```sh
PGHOST=localhost node backend/scripts/seed-pionir-observed-proposals.mjs --apply --export
```

The export performs an export/import/export identity check before writing each canonical GeoJSON.

## Circulation status

[`plan.json`](plan.json) records why this reconstruction remains building-only: the sole surface fragment inside the parcel is only 1.6 m long, while the other mapped service line is explicitly a tunnel at layer −1. Neither is a defensible surface-road proposal, and no parking layout is invented.
