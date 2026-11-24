# Permitted massing on parcels and plan plots

Permitted combines a parcel boundary with a planning source and its rules. The map, 3D view and named-plan building editor read the same envelope answer. A selected zoning area is a flat surface in the model. Its height limit belongs to the rules. The building envelope and sample building use the volumes calculated from those rules.

Click a visible building to inspect **Permitted massing**. When its government-plan plot is visible at that point, the plot has its own entry below the massing. Either entry can open the full source area as a design site. **Change massing view** opens the Permitted controls in **Buildings and massing**. **Illustration** shows a sample building, **Max envelope** shows the limits and **Both** overlays them. **Layers → Zoning and land use** controls the flat source areas independently.

## Land used for the calculation

In **Buildings and massing → Permitted**, **All** shows the complete massing. **Surviving** shows the portions outside the sites of visible, applied building, street and open-space designs. A site includes its yards and keeps any holes. Switching Proposed off restores the complete permitted massing. A subdivision by itself supplies new plots for the rule calculation.

| Parcel origin | Identity and geometry |
| --- | --- |
| Cadastre | The provider's registered parcel and geometry revision. |
| Government plan | A polygon of a source record that explicitly takes the zoning area as its lot. The answer identifies the edition, record and lot. Ordinary zoning supplies rules over the underlying parcels. |
| Applied design | A live plot, remainder or formed parcel. The answer identifies its geometry revision, producing design and contributing cadastral parcels. Layouts created from a government area also carry the selected source and record. |

Applying a layout replaces its contributing lots in the calculation and in the neighbouring ground used for street widths. Surviving cadastral parts remain available. A layout on a government lot uses its source reference to establish the replacement and any remaining area. Competing parcel identities with unresolved overlap are reported as unavailable. A road or track supplies public frontage and has no building envelope.

## Reading envelopes

`GET /planning/envelopes` accepts `city`, `source`, an optional `scenario`, and a WGS84 `bbox`. Its answer uses the source land in the view. `POST /planning/envelopes` takes the same fields in JSON, a four-number bbox and a `plots` array. An empty array returns the same answer as GET. Both operations are reads.

Each plot supplies `id`, `kind`, Polygon `geometry` and `cadastreParcelIds`. The optional fields are `label`, `producedByProposalId`, `cessionM2` and `planningArea: { source, recordId }`. Kinds are `plot`, `remainder`, `formed`, `part`, `road` and `track`. The area limit is 0.5 km² per view. The request accepts up to 2,000 pieces and 200,000 vertices intersecting the view or its 46 m margin. Problems with a plot request return 422 and `invalid-plan-plots`.

The answer includes named omissions and a `planPlots` summary for an applied layout. User plots carry `source.parcel` and a `sourceEvidence.parcelReference` with `sourceId: "plan"`. The source ID and zoning record still identify the rules. A change or undo invalidates affected envelope cells. Unchanged cells and source zoning keep their existing data.

## Calculations by source

- Alatau and the direct-dimension adapters derive the envelope from the plot and its overlapping source rules.
- Bogotá also measures public frontage, neighbouring lots and public land in the layout for block assembly. [Bogotá POT source](bogota-pot-source.md)
- Zagreb uses its stored GUP results on cadastral land. A new plot can use the shared geometry solver when `ZAGREB_PLOT_SOLVER` is enabled and `ZAGREB_PLOT_SOLVER_URL` points to `/api/build-envelope/solve-geometry`. The service must be available before enabling it. The citywide comparison retains its fixed cadastral sample. [GUP scenario integration](gup-scenario-integration.md)
- New York screens the derived lot against the pilot and its contributing PLUTO records. A proposal outside the pilot receives its screening reasons. A candidate requires review for a modeled result.
- Named-plan `fit_to_permitted` replays the other plan members on their source land and matches the building footprint to its plot. A standalone cadastral fit uses GET. [Editing through MCP](mcp-editing.md)
