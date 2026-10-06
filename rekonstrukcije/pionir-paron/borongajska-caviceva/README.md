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

## Published floor-plan corpus

This ongoing project was selected for the available complete floor insets in its apartment catalogues. The reconstruction covers **54 floors across six buildings**, including A1, and retains 648 apartment references; these are recovered references, not an inventory of every unit drawn on the plans or a count of units for sale.

[`floor-plan-sources.json`](floor-plan-sources.json) records the original catalogue URLs, pages, reviewed crops and SHA-256 digests, retrieved on 6 October 2026. Identical vector insets reuse one layout while each floor keeps its own source. The extracted neutral CAD strokes preserve rooms, stairs, doors and fixtures; apartment highlights, sheet annotations and gardens outside the building frame are excluded. B3 has drawing north to the right; the other four have north up. The subsequent [source search](../floor-source-inventory.json) incorporated A1 ground and levels 1–8; A2/C2/C3 remain unresolved. The linked C1 ground-floor A-1 PDF returns 404; its listing reference is retained, and the verified A-2 PDF supplies that floor's linework.

Registration uses a uniform scale and rotation centred on each 2022 permit footprint, preserving the drawing's proportions. The stored outline-fit residual is **not** surveyed positional accuracy. These later sales drawings can differ from the 2022 permit geometry. Floor elevations remain estimated at 3 m intervals (ground at relative z=0), as in the existing massing. X-ray displays these limitations beside the floor count.

X-ray builds **volumetric floors** from `floorPlans` v2: extruded CAD wall regions, slabs with stairwell holes, door leaves and frames, lintels, glazed windows, balcony rails, stair treads and landings. Source URLs, PDF checksums and extracted-vector digests retain the evidence; the runtime stores only the architectural model. The **Cut above** selector hides upper floors while keeping every retained floor at its actual model elevation. Identical layouts share mesh buffers, batched by material; switching X-ray off restores the normal building display.

The CAD insets establish plan positions and wall thicknesses. They do not establish construction sections, sill heights or window specifications: A1 ground uses an estimated 3.7 m floor-to-floor height (3.5 m wall plus 0.2 m slab); other modeled levels use 2.8 m, with slab thickness (0.2 m), door heads (2.1 m), glazed opening heads (2.3 m), window sills (0.85 m), stair rise and railing details as authoring estimates. Exterior swing symbols are classified as glazed doors or windows by width and position. Closed narrow wall outlines are separated from furniture and swing arcs. Ground-floor entrance stairs differ from typical upper floors; B4's two runs have reviewed axes in the manifest because the PDF omits direction arrows. The model is a source-based architectural visualization, not an as-built or construction-ready model.

On reopening a shared proposal, freshly fetched floor models update only its derived display features when source identity and footprint still match. The authored proposal, apply state and changed footprints remain untouched.

From the repository root, with PyMuPDF and Shapely 2.x installed in the selected Python environment:

```sh
python3 backend/scripts/reconstruct-borongaj-floors.py --cache-dir /tmp/borongaj-floor-cache --fetch
python3 backend/scripts/reconstruct-borongaj-floors.py --cache-dir /tmp/borongaj-floor-cache --write
PGHOST=localhost node --env-file=backend/.env backend/scripts/import-building-floor-plans.mjs --archive rekonstrukcije/pionir-paron/borongajska-caviceva/proposal.geojson
PGHOST=localhost node --env-file=backend/.env backend/scripts/import-building-floor-plans.mjs --archive rekonstrukcije/pionir-paron/borongajska-caviceva/proposal.geojson --apply
```

The importer defaults to a dry run and writes the source-neutral PostgreSQL floor-model registry, after checking source identities and unchanged proposal footprints. Use `--init-schema` for the first local import; production deployment applies the schema before loading the API. It reads each saved model back before committing and removes duplicate inline copies from the proposal. Re-running it is a no-op. The normal project seed preserves the archive's authoring evidence. The [registry contract](../../../docs/building-floor-models.md) describes native-building imports and production flags.

The current archive covers 54 floors across six buildings, including A1. Unavailable levels remain absent rather than cloned; elevations are estimated display proxies. The generator preserves source URLs, checksums and native building identity.

In the 3D building-rendering controls, **X-ray** replaces available building proxies with solid interiors at their registered location and elevation. **Cut above** hides upper floors to expose the rooms. Buildings without models retain their selected exterior display mode. Built/Planned visibility and proposal isolation also apply to the interiors. Turning X-ray off disposes the floor meshes and restores their exterior proxies.

Extraction checks run with `python3 backend/test/pionir-floor-architecture.test.py` in that environment. The backend Vitest tests cover registration, prism dimensions, slab holes, openings, stairs, shared render buffers, cutaway, refresh and narrow import behavior.
