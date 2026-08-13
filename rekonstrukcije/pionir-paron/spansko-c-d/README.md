# Špansko C–D

Historical Pionir development between Ulica Vilima Korajca and Ulica Antuna Šoljana, immediately east of the current Špansko-sjever site.

## Identification

- Pionir's archived sales pages call the two phases **Špansko – Objekt C** and **Špansko – Objekt D**.
- Both archived pages describe the project on the then newly formed k.č. 2811/1, k.o. Stenjevec. Today's cadastre splits the relevant built site into k.č. 2811/1 and 2811/3, MB 340057, k.o. Stenjevec Jug.
- Current parcel-union area: **20,725.4 m²**.
- The current DGU layer has five above-ground polygons. Buildings 795 and 796 share a boundary and are the same physical L-shaped structure, so the proposal contains **four physical footprints**.
- [Večernji list](https://www.vecernji.hr/zagreb/parking-spansko-automat-zagreb-1200726) reports **756 apartments in four buildings** for this compound.

The current north/south parcel split is later than the archived description. Until an archival situation plan is recovered, C and D are retained as the official project-label set but are not assigned to individual current footprints.

## Geometry and height basis

| Current parcel | DGU ids / building numbers | Proposal treatment | Height basis |
|---|---|---|---|
| 2811/3 | 13391660 / 795 + 13391842 / 796 | merged into one physical footprint | OSM/Overture way `w224229831`: 7 floors, represented as 21 m |
| 2811/3 | 13391843 / 794 | one footprint | matched GDI 2022 height, 29.8 m |
| 2811/1 | 13391661 / 798 | one footprint | matched GDI 2008 height, 30.6 m |
| 2811/1 | 13391844 / 799 | one footprint | matched GDI 2008 height, 32.8 m |

The 2008 GDI object under buildings 795/796 is only 1.4 m high and evidently records an unfinished or ground-level state. Overture carries the current OpenStreetMap seven-floor tag and overlaps 97.3% of the merged DGU footprint, so it is used only for that building.

## Sources

- [Pionir archive: Objekt C](https://web.archive.org/web/20111116184239/http://pionir.hr/prodaja-nekretnina-spansko-objekt-c.html) — five entrances; described as occupiable by the archived snapshot.
- [Pionir archive: Objekt D](https://web.archive.org/web/20111116184239/http://pionir.hr/prodaja-nekretnina-spansko-objekt-d.html) — six entrances; described as occupiable by the archived snapshot.
- [Večernji list: four buildings and 756 apartments](https://www.vecernji.hr/zagreb/parking-spansko-automat-zagreb-1200726).
- [Večernji list: Korajca/Šoljana compound](https://www.vecernji.hr/zagreb/pobuna-u-spanskom-bolji-zivot-u-kvartu-trazimo-na-ulici-1296091).

## Reproduction

```bash
PGHOST=localhost node backend/scripts/seed-pionir-observed-proposals.mjs --apply --export
```

`proposal.geojson` uses `consensus-builder.reconstruction.v1` and must survive a lossless export/import/export round trip.
