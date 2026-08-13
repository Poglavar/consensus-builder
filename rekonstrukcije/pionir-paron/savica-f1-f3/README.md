<!-- Documents the evidence, geometry choices and reproducible local proposal for Savica F1–F3. -->

# Savica F1–F3

Savica F1–F3 is a completed mixed residential-office complex on k.č. 2716/8, MB 335649, k.o. Trnje. It consists of two residential above-ground volumes, F1 and F2, an office volume F3, a shared underground garage G and a transformer. The app proposal contains only the three principal above-ground buildings; garage and transformer geometry is retained in [`observed-context.geojson`](observed-context.geojson).

The company roles changed through the record and must not be collapsed into a generic “Pionir investor” label. PARON is named as investor in the F1 design/energy documentation, TEHNIKAGRADNJA is named as investor in later permits and use permits, and GIP PIONIR markets the project and publishes the documents.

## Chronology and sources

| State | Public case / document | What it establishes |
|---|---|---|
| Original location permit, 2018 | UP/I-350-05/17-01/43, summarized on [Pionir's F3 page](https://pionir.hr/prodaja-nekretnina/savica/objekt-f3/) | Original complex basis. |
| Location amendment, final 27 Oct 2021 | `A20211027-2824386-V020101`; [`location-permit-amendment-2021.geojson`](location-permit-amendment-2021.geojson) | Explicitly labels F1, F2, F3 and the transformer, so the present footprints can be named without inference. |
| F1/F2 building permit, final 30 Mar 2022 | `A20220330-2833642-V010101`; [`building-permit-f1-f2-2022.geojson`](building-permit-f1-f2-2022.geojson) | Two residential polygons, each described as containing 70 apartments. |
| Location amendment, final 16 Nov 2023 | `P20230927-1364307-Z06`; [`location-permit-amendment-2023.geojson`](location-permit-amendment-2023.geojson) | Later accepted geometry: three principal above-ground polygons plus transformer on the 6,666.47 m² permit area. |
| F3 building permit, decision 22 Apr 2024 | `P20240131-1445130-Z01`; [`building-permit-f3-2024.geojson`](building-permit-f3-2024.geojson) | Final office-volume footprint. Pionir describes it as P+7 with eight office units. |
| Built state, current DGU snapshot | [`observed-context.geojson`](observed-context.geojson) | Three principal DGU buildings, two underground-garage polygons and one transformer. |

The [F1 use permit](https://pionir.hr/wp-content/dokumentacija_dozvole/savica/Uporabna_dozvola_F1.pdf) confirms 70 apartments, 22 parking spaces in the ground floor and 21 outdoor spaces. Pionir's project description states that F1 and F2 are residential, F3 is office use, and the common underground garage connects all three volumes.

## Canonical proposal

[`proposal.geojson`](proposal.geojson) is the reconstruction proposal `paron-savica-f1-f3-observed`, stored locally as row `1091` and deliberately left unapplied. It uses current DGU built footprints rather than substituting older permit outlines:

| Volume | Programme | Units | DGU building | Above-ground floors | Geometry basis |
|---|---|---:|---:|---:|---|
| F1 | residential | 70 apartments | 13086210 | 8 | current DGU footprint; label matched to the explicitly named 2021 permit polygon |
| F2 | residential | 70 apartments | 13086209 | 8 | current DGU footprint; label matched to the explicitly named 2021 permit polygon |
| F3 | office | 8 offices | 13350652 | 8 (P+7) | current DGU footprint; label and storeys confirmed by published project/permit material |

Geometry-derived diagnostics for the three above-ground footprints are:

- site area: 6,666.48 m² in exported WGS84 geometry;
- combined footprint: 2,704.11 m²;
- site coverage: 40.56%;
- height-equivalent GBP: 21,632.85 m² and `kin` 3.245, using eight 3 m display levels.

The last line is explicitly not permit GBP and 24 m is not a measured height. OSM/Overture reports eight floors for all three buildings, while Pionir directly reports P+7 for F3; the proposal uses 24 m only so the editable volumes have a useful 3D display height.

Rebuild the source snapshots and proposal with:

```sh
node backend/scripts/fetch-pionir-edozvola-sources.mjs --project savica-f1-f3
PGHOST=localhost node backend/scripts/seed-savica-f1-f3-proposal.mjs --apply --export
```

The export path performs an export/import/export identity check before writing the canonical GeoJSON.

## Internal circulation

[`circulation-access-1443564105.geojson`](circulation-access-1443564105.geojson) retains the 37 m surface access segment that clears all above-ground buildings. Its overlap with the documented underground garage slab is allowed and recorded as context; the longer OSM line is excluded because its modelled surface footprint crosses F1 and F2. No sufficiently explicit parking polygon/aisle pair is available, despite the use permit documenting outdoor spaces. [`plan.json`](plan.json) groups the safe road segment with F1–F3 as named local plan `pionir-savica-f1-f3`.
