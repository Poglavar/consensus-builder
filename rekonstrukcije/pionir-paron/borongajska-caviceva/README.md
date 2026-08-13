# Borongajska–Čavićeva

Pionir/Paron complex on k.č. 2692/7, MB 335533, k.o. Peščenica. The current parcel is about 67,956 m², but the accepted 2022 location-permit area reconstructed here is 33,741.52 m².

## Reconstructed proposal

[`proposal.geojson`](proposal.geojson) is a dated reconstruction of the **accepted 2022 scheme**, not an assertion that it is the latest complete design. It contains exactly nine above-ground volumes A1, A2, B1–B4 and C1–C3. The site feature is the location-permit area polygon rather than the whole cadastral parcel, preventing one project phase from being compared with theoretical capacity across all 67,956 m².

| Volume | 2022 WFS footprint | Label basis | Published numeric data retained |
|---|---|---|---|
| A1 | `.7188` | direct overlap with named permit `P20240312-1476435-Z01` | 64 apartments, 6 offices, 4,757 m² GBP, Pr+8K |
| A2 | `.7189` | direct overlap with `P20230630-1310132-Z01` | 192 apartments, 12 offices |
| B1 | `.7193` | direct overlap with `P20241001-1609912-Z01` | phase and footprint |
| B2 | `.7194` | direct overlap with `P20250717-1815302-Z01` | 126 apartments, 8,064 m² GBP, Pr+8K |
| B3 | `.7187` | direct overlap with `P20250321-1729062-Z01` | phase and footprint |
| B4 | `.7196` | direct overlap with `P20250428-1757572-Z01` | phase and footprint |
| C1 | `.7191` | signed permit `P20260304-4502783-Z01` plus 97% overlap with the later C1-sized polygon | 177 apartments, 11,874 m² GBP, Pr+8K |
| C2 | `.7192` | inferred from the two remaining C-group footprints in original WFS order | unresolved |
| C3 | `.7197` | inferred from the two remaining C-group footprints in original WFS order | unresolved |

The other two source polygons are deliberately excluded: `.7190` is a small auxiliary/parterre geometry and `.7195` is transformer ZTS 555. The nine footprints total 11,016.11 m², or 32.65% of the accepted permit area. The proposal's 99,145 m² and `kin` 2.94 are explicitly **display-height diagnostics** (nine 3 m levels), not a claimed permit GBP total.

[`observed-context.geojson`](observed-context.geojson) records the current DGU state inside that 2022 area: A1 and A2, the transformer and the shared underground garage. It is context only; current DGU data may lag construction.

The local proposal row is `1089`, proposal id `pionir-borongajska-caviceva-location-permit-2022`, and remains unapplied. Rebuild it with:

```sh
PGHOST=localhost node backend/scripts/seed-borongaj-proposal.mjs --apply --export
```

## Legal/design chronology

The source geometries remain separate because they represent different administrative and design states:

- [`location-permit-2022-full.geojson`](location-permit-2022-full.geojson) — original public ID `A20220613-2838627-V020101`; the complete accepted set of 11 building polygons;
- [`location-permit-2022.geojson`](location-permit-2022.geojson) — migrated ID `P20221230-1037184-Z02`; it preserves the 33,741.52 m² area polygon but only one building polygon;
- [`location-permit-amendment-2024.geojson`](location-permit-amendment-2024.geojson) — case `P20241001-1610904-Z06`; its final act is **Rješenje o obustavi postupka**, so it is evidence only and is not used as an approved proposal state;
- [`location-permit-amendment-2025.geojson`](location-permit-amendment-2025.geojson) — final amendment `P20250825-1836121-Z06`, valid from 5 December 2025; it expands the published area to 67,955.78 m² and exposes 23 polygons that have not yet been reduced to a current mutually compatible set.

The 2022 project is still excluded from the old-vs-new GUP statistics: the later phase permits implement a location permit that became final on 9 June 2022.

Refresh the official geometry snapshots with:

```sh
node backend/scripts/fetch-pionir-edozvola-sources.mjs --project borongajska-caviceva
```

Signed sources: [A1 building permit](https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-a1/gradevinska-dozvola-a1.pdf), [A2 building permit](https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-a2/badel_A2_gradevinska_dozvola_nadzemno.pdf), [B1 building permit](https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-b1/gradevinska-dozvola-nadzemno-b1.pdf), [B3 building permit](https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-b3/Gradevinska_dozvola_B3_nadzemno.pdf), and [C1 building permit](https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-c1/gradevinska_dozvola_nadzemno_c1.pdf).
