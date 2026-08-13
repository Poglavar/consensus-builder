# Selska–Baštijanova–Vitezićeva

Pionir's phased residential development on the former military site in Pongračevo, west of Selska cesta, north of Ulica Ivana Rabara and east of Vitezićeva ulica.

## Which barracks?

This was not the Kerestinec barracks. Local historical sources identify the site as **Logor Krste Frankopana**, later the JNA logistics barracks commonly called **kasarna „27. juli“**. The City subsequently built the Baštijanova–Selska–Vitezićeva road and utility network; the internal streets are therefore not merely private drives belonging to the housing parcels.

## Extent

- Eight current parcels in MB 339270, k.o. Trešnjevka: **2682/89, /91, /93, /95, /97, /99, /102 and /104**.
- Current parcel-union area: **25,205.7 m²**.
- Official Pionir phase labels: **S, S1–S12** — thirteen labels in total.
- Current proposal geometry: **eleven DGU footprints**. S4–S5 and S6–S7 are each represented by one connected legal DGU polygon; the other phase pairs occupy two current footprints.

Nearby schools, the church, business buildings and the older mixed-use buildings on parcels 2682/54 and 2682/56 are deliberately excluded: Pionir's archived pages do not include them in the S–S12 residential sequence.

## Phase-to-parcel mapping

| Official phase | Current parcel | Current DGU footprint(s) | Archived date evidence |
|---|---|---|---|
| S4–S5 | 2682/95 | 13399596 / 6873 | documented in Pionir's offer by March 2011; exact completion unresolved |
| S6–S7 | 2682/97 | 13399569 / 6874 | documented in Pionir's offer by March 2011; exact completion unresolved |
| S11–S12 | 2682/102 | 13499600 / 6876 and 13499599 / 6877 | one entrance occupiable and the other due 31 December 2013 |
| S9–S10 | 2682/104 | 13499587 / 6879 and 13499598 / 6878 | 31 January and 30 June 2015 by entrance |
| S8 | 2682/99 | 13499621 / 6875 | 31 October 2015 |
| S2–S3 | 2682/93 | 13499570 / 6871 and 13499597 / 6872 | 30 June and 30 September 2016 |
| S1 | 2682/91 | 13499584 / 7036 | 30 September 2017 |
| S | 2682/89 | 13499564 / 7052 | completed in 2018; archived as occupiable by 2019 |

Where two footprints share one archived parcel, the proposal retains the pair of possible official labels rather than guessing which is which.

## Primary project sources

- [S4–S5](https://web.archive.org/web/20110325060405/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s4-s5.html) and [S6–S7](https://web.archive.org/web/20110325060405/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s6-s7.html).
- [S11–S12](https://web.archive.org/web/20130403061240/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s11-s12.html).
- [S9–S10](https://web.archive.org/web/20141022183448/http://www.pionir.hr/objekti-s9-s10.html) and [S8](https://web.archive.org/web/20150803100004/http://www.pionir.hr/objekt-s8-v2.html).
- [S3](https://web.archive.org/web/20150803100004/http://www.pionir.hr/selska-s3.html), [S2](https://web.archive.org/web/20151213093458/http://www.pionir.hr/selska-s2.html), [S1](https://web.archive.org/web/20160617104904/http://www.pionir.hr/selska-s1.html) and [S](https://web.archive.org/web/20190101000000/http://www.pionir.hr/selska-s.html).
- [Floricon reference chronology](https://www.floricon.hr/reference/) independently dates S11–S12 (2013), S8/S9–S10 (2015), S2–S3 (2016), S1 (2017) and S (2018).

## Historical and infrastructure sources

- [Mapiranje Trešnjevke: Pongračevo](https://mapiranjetresnjevke.com/kvartovi/pongracevo/) and [walk through Ciglenica](https://mapiranjetresnjevke.com/grad-koji-nestaje/setnja-ciglane/).
- [City of Zagreb: construction of the Baštijanova–Selska–Vitezićeva road](https://zagreb.hr/en/bastijanova-selska-viteziceva-izgradnja-prometnice/7887).
- [City of Zagreb: landscape works inside the residential block](https://zagreb.hr/krajobrazno-uredjenje-unutar-stambenog-bloka-selsk/18071).

## Reproduction

```bash
PGHOST=localhost node backend/scripts/seed-pionir-observed-proposals.mjs --apply --export
```

`proposal.geojson` uses `consensus-builder.reconstruction.v1` and must survive a lossless export/import/export round trip.
