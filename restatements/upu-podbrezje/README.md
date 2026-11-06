<!-- UPU Podbrežje restated as two plans over shared designs: the whole plan on an empty site, and the part still to be built. Records sources, method and uncertainty. -->

# UPU Podbrežje

The 19.4 ha Podbrežje neighbourhood plan (Log-urbis d.o.o. for the City of Zagreb; adopted SGGZ 8/07, amended SGGZ 12/11, 12 July 2011) restated as designs and two agreements:

| Plan key | Title | Designs | What it is |
|---|---|---:|---|
| `upu-podbrezje` | UPU Podbrežje | 23 | the whole plan on an empty site |
| `upu-podbrezje-preostalo` | UPU Podbrežje – preostali dio plana | 16 | what is still to be built |

The remainder leaves out the four built slabs A3–A6 (phase 1, 608 flats), the two buildings under construction (A11: 288 flats, finishing in the first half of 2027; kindergarten C1: 10 groups, building since November 2024) and the built north and east streets. Every design the two plans share has the same CID in both.

## Members

The kazete (plan plots) are the City's planned-land-use fields. Their labels match the "okvirna površina kazete" tables of the 2007 decision and the 2011 amendments, each within 1.5 %, in west-to-east order. The 2017 phase-2 land sale names the kazete still unbuilt.

| Kazeta | Use | Footprint basis | Height | In the remainder |
|---|---|---|---|---|
| A3–A6 | housing, P+8 | DGU footprint | GDI 2019 | no (built) |
| A11 | housing, P+8 | building permit P20250320-1728612-Z01 | 29.5 m | no (under construction) |
| A1, A2 | housing, P+8 | footprint of the built twin (A3, A4) moved into the equal kazeta | 29.5 m | yes |
| A7–A10 | housing, P+8 | 18.7 m slab placed across where sheet 3.d draws it; runs south from the kazeta's north edge, capped by kisn (A7 2.5, A8 2.7, A9 2.9, A10 2.8) or the kazeta's length | 29.5 m | yes |
| B | mixed, mainly business: podrum + 35 storeys, above the 2nd storey ≤ 25 % of the plot, kisn ≤ 5.0 | 2-storey podium on sheet 3.d's mass; tower at its north end, sized so 35 storeys reach kisn 5.0 (27 × 27 m) | 113.3 m / 9 m | yes |
| C1 | kindergarten, 10 groups | building permit P20230607-1296406-Z01 | 8 m | no (under construction) |
| C2, D, E, F1, F2 | kindergarten (8 groups), primary school (560 pupils), culture centre, pool, sports hall | sheet 3.d's mass, clipped to the kazeta | 8–10 m, 2 storeys | yes |
| G3, G1, G2 | public park, protective greens | the kazeta | – | yes |
| IS | streets | north and east: built, OSM centrelines and profiles; south: axis down the middle of the IS land, 15 m profile with perpendicular parking on the park side | – | south street only |

A slab's above-ground GBP is its footprint × 9, and the designs refuse to exceed kisn × the tabled kazeta area. The plan's closed ground floor (at most 40 %) would lower it.

## Sources

- Odredbe za provođenje: [SGGZ 8/07](https://www1.zagreb.hr/slglasnik.nsf/10288f1421388ff8c1256f2d0049015b/8566af05cca9c283c125758200424e35) and the [2011 amendments](http://www1.zagreb.hr/slglasnik.nsf/10288f1421388ff8c1256f2d0049015b/4ee638b06fc6ba4cc12578cd004b185a).
- [2011 summary for the public](https://web.zagreb.hr/Sjednice/2017/Sjednice_Skupstine_2017.nsf/0/C12581370033D600C125869600382759/$FILE/upu_podbrezje_sazetak_javnost.pdf). Its sheet 3.d (Osnova krajobraznog uređenja naselja) is the only published drawing of the masses. Sheets 3.b and 3.c (building lines) are not online.
- City of Zagreb planned land use ([open data](https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja)), DGU buildings, GDI heights and eDozvola permits, from the local spatial database.
- Status: [ZGH FAQ](https://www.zgh.hr/podbrezje/najcesca-pitanja-faq/4506), [City on A11](https://zagreb.hr/gradonacelnik-tomasevic-obisao-radove-na-zgradi-za/217781), [kindergarten construction](https://www.index.hr/vijesti/clanak/u-zagrebackom-podbrezju-pocela-izgradnja-vrtica-za-oko-200-djece/2616802.aspx), [school competition (D.A.Z)](http://www.d-a-z.hr/hr/aktualna-tema/natjecaj-osnovna-skola-podbrezje,4720.html).

## Uncertainty

- Sheet 3.d is a reduced landscape sheet. The masses are measured on its raster (`data/sheet-3d.json`), and its across scale is fitted to the built slabs (within 1 m). Along the kazete, positions are good to a few metres. Sheet 3.d draws the south row's north edges in one line, while the land-use layer staggers them.
- Each building is a freeform design that takes its footprint as land. The plan's one building plot per kazeta is not drawn as a parcel layout.
- Storeys of the public buildings and the B tower's proportions are choices within the plan's limits, not plan figures.
- The IS-2 strip (land-use object 1518, north-west) is not restated.

## Reproducing

```sh
node restatements/upu-podbrezje/extract-data.mjs --write          # local DB → data/*.geojson (EPSG:3765)
node restatements/upu-podbrezje/build-and-upload.mjs --dry-run    # designs and CIDs
node restatements/upu-podbrezje/build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
node restatements/upu-podbrezje/build-and-upload.mjs --capture --app <app> --api <api>
node restatements/upu-podbrezje/build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply
```
