# Špansko – Stenjevečki odvojak

Historical Pionir development between Ulica Marije Radić and Ulica Antuna Šoljana, south of Špansko C–D and northeast of City Center one West.

## Identification

- Official archived project name: **Špansko – Stenjevečki odvojak**.
- Current and archived project parcel: **k.č. 2976/1, MB 340057, k.o. Stenjevec Jug**.
- Current parcel area: **13,712.6 m²**.
- Seven archived phases and seven current above-ground DGU polygons: **N2, E, N1, F1, F2, N4 and N3**.
- All current footprints have matching GDI 2022 heights of roughly 29.3–30.1 m.

The archive proves the complete official phase-label set, but the surviving pages do not contain a readable site plan that assigns each label to a current footprint. The proposal therefore uses unambiguous positional names and keeps the official labels as project metadata.

## Archived chronology

| Phase | Archived completion / move-in | Source |
|---|---|---|
| N2 | November 2014 | [Pionir archive](https://web.archive.org/web/20140321092231/http://www.pionir.hr/objekt-n2.html) |
| E | 31 December 2015 | [Pionir archive](https://web.archive.org/web/20160127173003/http://pionir.hr/objekt-e.html) |
| N1 | 30 December 2016 | [Pionir archive](https://web.archive.org/web/20160127173003/http://pionir.hr/objekt-n1.html) |
| F1 | 31 July 2017 | [Pionir archive](https://web.archive.org/web/20160812094800/http://pionir.hr/objekt-f1-spansko-stenjevecki.html) |
| F2 | 30 March 2018 | [Pionir archive](https://web.archive.org/web/20180318124812/http://pionir.hr/spansko-stenjecacki-objekt-f2.html) |
| N4 | December 2018 | [Pionir archive](https://web.archive.org/web/20180318124812/http://pionir.hr/pansko-stenjevaki-odvojak-objekt-n4.html) |
| N3 | 31 May 2019 | [Pionir archive](https://web.archive.org/web/20190111195457/http://pionir.hr/spansko-stenjevecki-odvojak-n3.html) |

The final [archived project landing page](https://web.archive.org/web/20190111195457/http://pionir.hr/prodaja-nekretnina/pansko-stenjevaki-odvojak.html) shows the same seven-phase sequence.

## Reproduction

```bash
PGHOST=localhost node backend/scripts/seed-pionir-observed-proposals.mjs --apply --export
```

`proposal.geojson` uses `consensus-builder.reconstruction.v1` and must survive a lossless export/import/export round trip.
