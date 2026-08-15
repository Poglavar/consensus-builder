<!-- This file records the sources, reconstruction method and limitations for the named Novi Jelkovec neighbourhood plan. -->

# Novi Jelkovec

Named local plan: `/proposals/novi-jelkovec?city=zagreb`

The reconstruction follows the official `DPU stambenog naselja na lokaciji Sopnica - Jelkovec`, adopted in 2003 and amended in 2007, 2016 and 2020. The City classifies the 39.53 ha plan as fully realized and documents 2,722 apartments and 8,166 planned residents. The app name uses today's `Novi Jelkovec`; source metadata retains the legal plan name.

## Contents

- 64 principal built volumes from current DGU building footprints;
- GDI-matched measured height where available, converted to an explicitly approximate floor count at 3 m per floor;
- 11 official green-space polygons (`JP` and `PA`) as ordinary park proposals;
- 5 official public-square polygons (`JT` and `JT1`) as ordinary square proposals;
- 85 current OSM road pieces, totalling 7.36 km, clipped to the official `IS` traffic-system footprint.

The building filter keeps principal residential, mixed-use, public, school, sports, garage, business, religious and kindergarten volumes of at least 80 m². It excludes terraces, stairs, canopies, transformer stations and other auxiliary DGU polygons. This makes the 64 a modelling inventory, not a claim about the legal number of buildings or addresses.

## Sources

- [City plan page and implementation assessment](https://zagreb.hr/izmjene-i-dopune-detaljnog-plana-uredjenja-stamben/168074)
- [Adopted graphic plan](https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/dpu%20sopnica%20jelkovec/s-j_graficki%20dio_I%20%2820210120%29.pdf)
- [City of Zagreb urban-plan open data](https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja)
- local DGU, GDI and OSM snapshots recorded in the exported feature properties

The diagnostic floor-area total in the archive is footprint × estimated storeys, not official GBP.
