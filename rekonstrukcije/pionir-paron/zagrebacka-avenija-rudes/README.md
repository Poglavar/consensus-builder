# Zagrebačka avenija–Rudeš

Planned Pionir/Paron redevelopment of k.č. 799/1, MB 335614, k.o. Rudeš. The current parcel is 17,980.61 m² and still contains 21 older DGU yard/industrial objects.

## Permit chronology

| Date | Case | Meaning | Archived geometry |
|---|---|---|---|
| 17 Mar 2022 request; final 29 Mar 2023 | `P20221230-1130193-Z01`, `UP/I-361-03/22-001/468` | Earlier building permit with point labels F1, F2, F3, G1 and G2 | [`building-permit-2022.geojson`](building-permit-2022.geojson) |
| 13 May 2025 request; final 19 Dec 2025 | `P20250513-1768397-Z06`, `UP/I-350-05/25-01/000390` | Accepted amendment of the location permit: seven above-ground polygons plus one shared underground polygon | [`location-permit-amendment-2025.geojson`](location-permit-amendment-2025.geojson) |
| 24 Dec 2025 request | `P20251224-1934214-Z11`, `UP/I-361-03/25-01/002748` | Building-permit amendment request for a mixed residential-commercial building/garage; still *Obrada predmeta* in the archived snapshot | [`building-permit-amendment-request-2025.geojson`](building-permit-amendment-request-2025.geojson) |

The last published polygon is about 4,031 m² and materially overlaps parts of multiple above-ground polygons in the accepted location-permit amendment. It may represent a consolidated or superseding phase. Therefore the two designs are deliberately **not** merged.

## Reconstructed proposal

[`proposal.geojson`](proposal.geojson) preserves only the seven-volume location-permit state that became final on 19 December 2025. It is an editable, dated alternative; the pending 24 December request remains source evidence outside the proposal.

The seven published above-ground footprints total 6,043.10 m², or 33.61% of the 17,980.05 m² permit area. The shared 11,051.05 m² underground polygon is recorded in metadata but is not rendered as an eighth building. The WFS does not publish official phase labels, storeys, apartments or GBP, so the proposal uses neutral local labels V1–V7 and a 27 m **display proxy**. Its 54,388 m² height-equivalent GBP and `kin` 3.02 are diagnostics for 3D editing, not permit values.

The local proposal row is `1090`, proposal id `paron-zagrebacka-avenija-rudes-location-permit-2025`, and remains unapplied. Rebuild it with:

```sh
PGHOST=localhost node backend/scripts/seed-rudes-zagrebacka-avenija-proposal.mjs --apply --export
```

[`existing-context.geojson`](existing-context.geojson) contains the current parcel and 21 DGU objects slated as demolition context. The source GeoJSON files can be refreshed with:

```sh
cd backend
node scripts/fetch-pionir-edozvola-sources.mjs --project zagrebacka-avenija-rudes
```

Sources: [Baustela article](https://baustela.hr/nekretnine/vijesti/76275/nove-zgrade-na-zagrebackoj-zili-kucavici-jos-jedno-pionirovo-naselje-ovog-puta-na-zapadu-grada/vijest), national public eDozvola WFS, and the [2016 City GUP consultation table](https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/GUP%20ZAGREBA_KP%20lipanj%202016/izvjesca_preth_jr_pjr/ponovna%20javna%20rasprava/03_IZID%20GUP%20GZ_PJR2016_gospodarstvenici%20tablica.pdf).
