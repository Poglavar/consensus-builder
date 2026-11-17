<!-- Published Alatau alternatives, editable plan files, site evidence and design parameters. -->
# Alatau neighbourhoods

Two alternatives around **43.7984° N, 77.0911° E**, in northern Alatau between the A3 corridor and the reservoir. Both use chamfered perimeter blocks assembled from separately editable buildings and small plots, with a neighbourhood hall, library and workshop/cafe buildings.

| | Courtyard neighbourhood | Garden streets |
| --- | --- | --- |
| Public plan | [Open courtyard neighbourhood](https://urbangametheory.xyz/plans/bafkreifinphs2yuhuqyumeypjsxncgfvrtpv7pyfx4weloe7yer5rntqku) | [Open garden streets](https://urbangametheory.xyz/plans/bafkreieiyv3lfhhatz4nvg7cfyoed3fbshdqoihi27otzsemabsg5bzkc4) |
| Editable file | [courtyards.json](courtyards.json) | [gardens.json](gardens.json) |
| Courtyard blocks | 8 | 6 |
| Individual building plots | 99 | 75 |
| Median building plot | 317 m² | 296 m² |
| Residential storeys | 6–7 | 6 |
| Authored floor area | 165,977 m² | 115,523 m² |
| Authored parks and courtyard gardens | 41,198 m² | 46,241 m² |
| Connected street ground | 62,557 m² | 62,557 m² |

Floor area is the sum of footprint area × storeys, including civic buildings. Green area is the sum of authored park footprints; it excludes street trees and the private strips behind buildings. These quantities share the same measurement method. The garden alternative exchanges two courtyard blocks for public gardens and widens the internal spaces between the remaining blocks.

## Site and sources

The building plots fit within the roughly 40 ha EGKN parcel **03341030011**, source identity `KZ-ALATAU-PKK-03341030011-g7211003`, from `kz-alatau-pkk`. A proposed building plot is its authored land take, including its rear strip; the source cadastral parcel remains the baseline. Roads and parks also extend onto adjoining ground.

The [Alatau general-plan source](../../alatau-genplan-source.md) supplies the surrounding land-use pattern from [Government Decree 727, main provisions](https://primeminister.kz/assets/media/prilozenie-1-rus-727.pdf) and its [main drawing](https://primeminister.kz/assets/media/prilozenie-2-rus-727.pdf). The live state-cadastre response read on 17 November 2026 supplies:

- Residential areas `479341`, `479350` and `479492`, labelled 6–12 storeys. Residential blocks are inside these areas and the cadastral boundary.
- Park reservations `476365`, `476368`, `476370` and `476426`, retained as parks.
- Central area `482149`, whose detailed parameters require a detailed plan. The two freeform pavilions there are authored programme choices.

OSM returned no mapped building footprints on the 40 ha source parcel. Ownership, servicing, terrain, current construction and detailed-plan conditions remain unresolved. The roads show a connected neighbourhood network; an external connection to the existing road system still needs development.

## Building and plot structure

Each perimeter block comprises twelve independent Freeform building records, with joined street fronts, nominal 8 m corner chamfers, 13 m building depth and a shared planted courtyard. The split creates small plots with separate editable heights and uses. The building plots have their own land take; no ownership allocations or land-readjustment agreement are part of these plans.

Residential buildings use 3.2 m per storey, with shops in selected ground floors. The neighbourhood hall has three storeys; the library and workshop/cafe buildings have four. The street network uses one bounded road design, retaining connected junctions and the tree-lined avenues. The wider streets are 18–24 m; internal lanes are 12 m.

The JSON files are `ugt-plan-file/v1` packages containing the exact public plan and all its canonical design members and source references. Import them through the app's plan-file workflow to continue editing. Their contents are also editable through the existing MCP plan/design inspection and editing tools; no additional MCP capability is required.
